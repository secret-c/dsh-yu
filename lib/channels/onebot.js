import { now, safeEqual, maskSecret, parseJson } from '../util.js';
import { acceptWebSocket } from '../net/ws.js';

/**
 * OneBot v11 adapter, shared by NapCat and SnowLuma.
 *
 * Transport: the client dials *us* (reverse WebSocket) on Yu's own listener, at
 * `/onebot/<channelId>`, authenticated with a Bearer token and optionally
 * `x-self-id`. Every inbound event is claimed in a durable dedupe ledger before
 * it can produce a run, so a redelivery after a reconnect is a no-op.
 *
 * An optional HTTP API base is supported for `get_status` verification when the
 * client exposes one; it is never used to fabricate a connection state.
 */
export function createOneBotAdapter({ channel, log, exposeUpgrade, onEvent, onStatusChange }) {
  const config = channel.config ?? {};
  const state = {
    socket: null,
    connectedAt: null,
    lastEventAt: null,
    status: channel.enabled ? 'listening' : 'disabled',
    lastError: null,
    selfId: String(config.selfId ?? ''),
    disposeUpgrade: null,
    pending: new Map(),
    echoSeq: 0,
  };

  const path = `/onebot/${channel.id}`;
  const token = String(config.token ?? '');
  const httpBase = String(config.httpBase ?? '').replace(/\/+$/, '');
  const httpToken = String(config.httpToken ?? '') || token;

  const setStatus = (status, error = null) => {
    state.status = status;
    state.lastError = error;
    onStatusChange?.(channel.id, {
      status,
      lastError: error,
      connectedAt: state.connectedAt,
      lastEventAt: state.lastEventAt,
    });
  };

  const authorize = (req) => {
    const header = String(req.headers.authorization ?? '');
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('access_token');
    const presented = header.startsWith('Bearer ') ? header.slice(7) : query ?? '';
    if (!token) {
      return { ok: false, reason: '未设置 OneBot 访问令牌（token）；出于安全考虑拒绝未认证连接' };
    }
    if (!safeEqual(presented, token)) return { ok: false, reason: 'OneBot 令牌不匹配' };
    if (state.selfId) {
      const declared = String(req.headers['x-self-id'] ?? '');
      if (declared && declared !== state.selfId) {
        return { ok: false, reason: `x-self-id ${declared} 与配置的 QQ 号 ${state.selfId} 不一致` };
      }
    }
    return { ok: true };
  };

  const settle = (echo, value) => {
    const pending = state.pending.get(echo);
    if (!pending) return;
    state.pending.delete(echo);
    clearTimeout(pending.timer);
    pending.resolve(value);
  };

  const callOverSocket = (action, params, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (!state.socket || state.socket.closed) {
        reject(Object.assign(new Error('OneBot 连接未建立'), { code: 'NOT_CONNECTED' }));
        return;
      }
      const echo = `yu-${++state.echoSeq}`;
      const timer = setTimeout(() => {
        state.pending.delete(echo);
        reject(Object.assign(new Error(`OneBot 动作 ${action} 超时，结果未知`), { code: 'UNKNOWN_RESULT' }));
      }, timeoutMs);
      timer.unref?.();
      state.pending.set(echo, { resolve, reject, timer });
      const sent = state.socket.send(JSON.stringify({ action, params, echo }));
      if (!sent) {
        state.pending.delete(echo);
        clearTimeout(timer);
        reject(Object.assign(new Error('OneBot 发送失败'), { code: 'SEND_FAILED' }));
      }
    });

  const call = async (action, params = {}, { timeoutMs = 15_000 } = {}) => {
    if (state.socket && !state.socket.closed) return callOverSocket(action, params, timeoutMs);
    if (httpBase) {
      const response = await fetch(`${httpBase}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(httpToken ? { authorization: `Bearer ${httpToken}` } : {}),
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`OneBot HTTP ${response.status}`);
      return response.json();
    }
    throw Object.assign(new Error('OneBot 连接未建立，且没有配置 HTTP API 地址'), { code: 'NOT_CONNECTED' });
  };

  const handleMessage = async (event) => {
    const selfId = String(event.self_id ?? state.selfId);
    if (String(event.user_id) === selfId) return; // never answer ourselves
    if (event.post_type !== 'message') return;
    if (!['private', 'group'].includes(event.message_type)) return;
    const peerId =
      event.message_type === 'group' ? String(event.group_id ?? '') : String(event.user_id ?? '');
    if (!peerId) return;
    const messageId = String(event.message_id ?? '');
    if (!/^-?\d+$/.test(messageId)) return;
    const eventId = `${event.message_type}:${peerId}:${messageId}`;
    const text = normalizeText(event.message, selfId);
    // Pictures are carried as URLs; the manager downloads them so a run can
    // actually open the file instead of reading "[图片:http://…]".
    const images = Array.isArray(event.message)
      ? event.message
          .filter((segment) => segment?.type === 'image')
          .map((segment) => ({
            url: String(segment?.data?.url ?? ''),
            file: String(segment?.data?.file ?? ''),
            summary: String(segment?.data?.summary ?? ''),
          }))
      : [];
    if (Array.isArray(event.message) && event.message.some((segment) => segment?.type === 'image')) {
      log?.info(`image segments seen: ${images.length} (url=${images.filter((i) => i.url).length})`);
    }
    const senderName = String(event.sender?.card || event.sender?.nickname || '');
    state.lastEventAt = now();
    await onEvent({
      channelId: channel.id,
      channelType: channel.type,
      accountId: selfId,
      eventId,
      kind: event.message_type === 'group' ? 'qq_group' : 'qq_private',
      peerId,
      peerLabel:
        event.message_type === 'group'
          ? String(event.group_name ?? event.sender?.group_name ?? peerId)
          : senderName || peerId,
      senderId: String(event.user_id ?? ''),
      senderName,
      text,
      mentioned: Array.isArray(event.message) && event.message.some(segment => segment?.type === 'at' && String(segment.data?.qq ?? '') === selfId),
      images,
      at: Number(event.time) * 1000 || now(),
      raw: { message_type: event.message_type, post_type: event.post_type, self_id: selfId },
    });
  };

  const handleUpgrade = (req, socket, head) => {
    const requestPath = (req.url ?? '').split('?')[0];
    if (requestPath !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const auth = authorize(req);
    if (!auth.ok) {
      log?.warn(`rejected OneBot connection for ${channel.name}: ${auth.reason}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      setStatus('auth-failed', auth.reason);
      return;
    }
    const connection = acceptWebSocket(req, socket, head, { log });
    if (!connection) return;
    if (state.socket) {
      log?.info(`replacing existing OneBot connection for ${channel.name}`);
      state.socket.close(1000, 'replaced by a newer connection');
    }
    state.socket = connection;
    state.connectedAt = now();
    setStatus('connected');
    log?.info(`OneBot client connected for ${channel.name} from ${connection.remote}`);

    connection.on('message', (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        log?.debug('OneBot sent non-JSON payload');
        return;
      }
      if (payload.echo !== undefined) {
        settle(payload.echo, payload);
        return;
      }
      if (payload.post_type === 'message') {
        void handleMessage(payload).catch((error) => log?.warn(`OneBot message handling failed: ${error.message}`));
        return;
      }
      if (payload.post_type === 'meta_event' && payload.meta_event_type === 'lifecycle') {
        log?.info(`OneBot lifecycle ${payload.sub_type} for ${channel.name}`);
      }
    });
    connection.on('close', () => {
      if (state.socket === connection) {
        state.socket = null;
        state.connectedAt = null;
        setStatus(channel.enabled ? 'listening' : 'disabled');
      }
    });
  };

  const status = () => ({
    channelId: channel.id,
    type: channel.type,
    status: state.status,
    connected: Boolean(state.socket && !state.socket.closed),
    connectedAt: state.connectedAt,
    lastEventAt: state.lastEventAt,
    lastError: state.lastError,
    endpoint: { transport: 'reverse-ws', path, port: null },
    selfId: state.selfId || null,
    tokenSet: Boolean(token),
    httpApi: httpBase || null,
  });

  const health = () => {
    if (!channel.enabled) return { state: 'disabled', detail: '已主动停用，不告警' };
    if (state.status === 'auth-failed') return { state: 'auth-failed', detail: state.lastError ?? '认证失败' };
    if (state.socket && !state.socket.closed) return { state: 'ok', detail: 'OneBot 已连接' };
    return { state: 'offline', detail: '等待 OneBot 客户端连接' };
  };

  return {
    id: channel.id,
    type: channel.type,
    path,
    start() {
      if (!token) {
        setStatus('misconfigured', '缺少 OneBot 访问令牌');
        log?.warn(`channel ${channel.name} has no OneBot token; connections will be refused`);
      }
      state.disposeUpgrade = exposeUpgrade(path, handleUpgrade);
      if (channel.enabled && token) setStatus(state.status === 'connected' ? 'connected' : 'listening');
    },
    stop() {
      try {
        state.disposeUpgrade?.();
      } catch {
        /* ignore */
      }
      state.disposeUpgrade = null;
      for (const [, pending] of state.pending) {
        clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error('channel stopped'), { code: 'STOPPED' }));
      }
      state.pending.clear();
      try {
        state.socket?.close(1000, 'channel stopped');
      } catch {
        /* ignore */
      }
      state.socket = null;
      state.connectedAt = null;
      setStatus('disabled');
    },
    status,
    health,
    call,
    /** Real verification: ask the client, do not assume. */
    async test() {
      const checks = [];
      checks.push({
        name: '配置',
        ok: Boolean(token),
        detail: token ? `令牌已设置（${maskSecret(token)}）` : '缺少 OneBot 访问令牌',
      });
      checks.push({
        name: '反向 WS 地址',
        ok: true,
        detail: `ws://127.0.0.1:<Yu 端口>${path}`,
        note: '需要把该地址填进 NapCat / SnowLuma 的 WebSocket 客户端配置',
      });
      let online = null;
      try {
        const result = await call('get_status', {}, { timeoutMs: 8000 });
        online = result?.data?.online ?? result?.data?.good ?? null;
        checks.push({ name: 'OneBot get_status', ok: true, detail: JSON.stringify(result?.data ?? result) });
      } catch (error) {
        checks.push({ name: 'OneBot get_status', ok: false, detail: `${error.code ?? ''} ${error.message}`.trim() });
      }
      return {
        ok: checks.every((c) => c.ok !== false) && online !== false,
        checks,
        online,
        connected: Boolean(state.socket && !state.socket.closed),
        status: state.status,
      };
    },
    handleUpgrade,
  };
}

/** Flatten OneBot message segments into prompt-safe text. */
export function normalizeText(message, selfId = '') {
  if (typeof message === 'string') return message.trim();
  if (!Array.isArray(message)) return '';
  const parts = [];
  let atMe = false;
  for (const segment of message) {
    if (!segment || typeof segment !== 'object') continue;
    const type = segment.type;
    const data = segment.data ?? {};
    if (type === 'text') parts.push(String(data.text ?? ''));
    else if (type === 'at') {
      const qq = String(data.qq ?? '');
      if (qq === 'all') parts.push('@全体成员');
      else {
        if (qq && qq === selfId) atMe = true;
        parts.push(`@${data.name || qq}`);
      }
    } else if (type === 'reply') parts.push(`[回复:${data.id ?? ''}]`);
    else if (type === 'image') parts.push(`[图片:${data.url || data.file || ''}]`);
    else if (type === 'face') parts.push(`[表情${data.id ?? ''}]`);
    else if (type === 'record') parts.push('[语音]');
    else if (type === 'json') {
      const card = parseJson(data.data, null);
      const title = card?.prompt ?? card?.meta?.detail_1?.title ?? '';
      parts.push(`[卡片:${title}]`);
    } else if (type === 'file') parts.push(`[文件:${data.name ?? ''}]`);
    else parts.push(`[${type}]`);
  }
  const text = parts.join('').trim();
  return atMe ? `[@我] ${text}` : text;
}
