import crypto from 'node:crypto';
import { now, maskSecret } from '../util.js';

/**
 * QQ official bot adapter (QQ 机器人开放平台).
 *
 * Implemented over Webhook, because that is the mode a self-hosted deployment
 * can verify end to end without a public gateway socket: credentials → access
 * token → Ed25519 webhook validation → event → reply. The WebSocket gateway mode
 * is *not* implemented and the UI says so rather than implying it exists.
 *
 * Ed25519 key handling: the platform issues a bot secret used as the signing
 * seed. A 64-character hex secret is decoded directly; any other length is
 * hashed to 32 bytes, and that derivation is reported by `selfTest()` so an
 * operator can see which path was taken.
 */

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';

export function deriveSigningKey(secret) {
  const raw = String(secret ?? '').trim();
  if (!raw) return { key: null, derivation: 'empty' };
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return { key: seedToPrivateKey(Buffer.from(raw, 'hex')), derivation: 'hex-seed' };
  }
  const digest = crypto.createHash('sha256').update(raw).digest();
  return { key: seedToPrivateKey(digest), derivation: 'sha256-of-secret' };
}

function seedToPrivateKey(seed) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

export function publicKeyOf(privateKey) {
  return crypto.createPublicKey(privateKey);
}

export function signEd25519(privateKey, message) {
  return crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
}

/**
 * Verify an Ed25519 signature. Accepts a KeyObject, a PEM string, or raw SPKI
 * DER bytes; a raw DER buffer has to be turned into a KeyObject first, because
 * `crypto.verify` cannot decode it on its own.
 */
export function verifyEd25519(publicKey, message, signatureHex) {
  try {
    let key = publicKey;
    if (Buffer.isBuffer(publicKey)) {
      key = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
    } else if (typeof publicKey === 'string') {
      key = crypto.createPublicKey(publicKey);
    }
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

export function createQqOfficialAdapter({ channel, log, exposeRoute, exposeUpgrade, onEvent, onStatusChange }) {
  const config = channel.config ?? {};
  const appId = String(config.appId ?? '');
  const clientSecret = String(config.clientSecret ?? '');
  const botSecret = String(config.botSecret ?? '') || clientSecret;
  const webhookPath = `/qq/${channel.id}`;
  const state = {
    status: channel.enabled ? 'starting' : 'disabled',
    lastError: null,
    connectedAt: null,
    lastEventAt: null,
    token: null,
    tokenExpiresAt: 0,
    disposeRoute: null,
    disposeUpgrade: null,
    lastEventIds: new Set(),
  };

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

  const fetchToken = async () => {
    if (!appId || !clientSecret) {
      throw Object.assign(new Error('缺少 AppID 或服务端凭据（AppSecret）'), { code: 'NO_CREDENTIALS' });
    }
    if (state.token && Date.now() < state.tokenExpiresAt - 60_000) return state.token;
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.access_token) {
      throw Object.assign(
        new Error(`获取 access_token 失败：HTTP ${response.status} ${payload?.message ?? ''}`.trim()),
        { code: 'TOKEN_FAILED', status: response.status, payload },
      );
    }
    state.token = payload.access_token;
    const ttl = Number(payload.expires_in ?? 7200);
    state.tokenExpiresAt = Date.now() + ttl * 1000;
    return state.token;
  };

  const apiCall = async (method, endpoint, body) => {
    const token = await fetchToken();
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers: {
        authorization: `QQBot ${token}`,
        'x-union-appid': appId,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw Object.assign(new Error(`QQ 开放平台返回 HTTP ${response.status}`), {
        code: 'API_FAILED',
        status: response.status,
        payload,
      });
    }
    return payload;
  };

  const answer = async (event, text) => {
    const content = String(text ?? '').slice(0, 1800);
    if (!content.trim()) return { ok: false, error: 'empty reply' };
    const endpoint =
      event.kind === 'qq_group'
        ? `/v2/groups/${event.peerId}/messages`
        : `/v2/users/${event.peerId}/messages`;
    const body = { content, msg_type: 0, msg_id: event.messageId, msg_seq: Math.floor(Math.random() * 1000) };
    try {
      const result = await apiCall('POST', endpoint, body);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message, code: error.code ?? 'API_FAILED', detail: error.payload ?? null };
    }
  };

  const handleWebhook = async (req, res, rawBody) => {
    const signature = String(req.headers['x-signature-ed25519'] ?? '');
    const timestamp = String(req.headers['x-signature-timestamp'] ?? '');
    let payload;
    try {
      payload = JSON.parse(rawBody || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }

    // Validation handshake (op 13) — reply with an Ed25519 signature.
    if (payload.op === 13 && payload.d?.plain_token) {
      const { key, derivation } = deriveSigningKey(botSecret);
      if (!key) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bot secret not configured' }));
        return;
      }
      const message = `${payload.d.event_ts}${payload.d.plain_token}`;
      const signature2 = signEd25519(key, message);
      log?.info(`QQ webhook validation answered (key derivation: ${derivation})`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ plain_token: payload.d.plain_token, signature: signature2 }));
      return;
    }

    // Request signature verification for every other callback.
    if (botSecret) {
      const { key } = deriveSigningKey(botSecret);
      const publicKey = publicKeyOf(key);
      const ok = signature && timestamp && verifyEd25519(publicKey, `${timestamp}${rawBody}`, signature);
      if (!ok) {
        log?.warn(`QQ webhook signature rejected for ${channel.name}`);
        setStatus('auth-failed', 'Webhook 签名校验失败');
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'signature mismatch' }));
        return;
      }
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ op: 12 }));

    const type = payload.t;
    if (payload.op !== 0 || !type) return;
    const d = payload.d ?? {};
    const isGroup = type === 'GROUP_AT_MESSAGE_CREATE' || type === 'GROUP_MESSAGE_CREATE';
    const isC2c = type === 'C2C_MESSAGE_CREATE';
    if (!isGroup && !isC2c) return;
    const peerId = String(isGroup ? d.group_openid ?? '' : d.author?.user_openid ?? '');
    if (!peerId) return;
    const messageId = String(d.id ?? '');
    const eventId = `${type}:${peerId}:${messageId}`;
    if (state.lastEventIds.has(eventId)) return;
    state.lastEventIds.add(eventId);
    if (state.lastEventIds.size > 2000) state.lastEventIds.clear();

    const text = String(d.content ?? '').trim();
    state.lastEventAt = now();
    state.connectedAt = state.connectedAt ?? now();
    setStatus('connected');
    await onEvent({
      channelId: channel.id,
      channelType: channel.type,
      accountId: appId,
      eventId,
      kind: isGroup ? 'qq_group' : 'qq_official',
      peerId,
      peerLabel: isGroup ? `群 ${peerId.slice(0, 8)}` : d.author?.username ?? peerId.slice(0, 8),
      senderId: String(d.author?.member_openid ?? d.author?.user_openid ?? ''),
      senderName: d.author?.username ?? '',
      text,
      mentioned: type === 'GROUP_AT_MESSAGE_CREATE',
      at: Date.parse(d.timestamp ?? '') || now(),
      messageId,
      reply: (replyText) => answer({ kind: isGroup ? 'qq_group' : 'qq_official', peerId, messageId }, replyText),
      raw: { type, op: payload.op },
    });
  };

  return {
    id: channel.id,
    type: channel.type,
    webhookPath,
    start() {
      if (!appId || !clientSecret) {
        setStatus('misconfigured', '缺少 AppID 或服务端凭据');
      } else if (channel.enabled) {
        setStatus('listening');
        void fetchToken()
          .then(() => setStatus(state.status === 'listening' ? 'listening' : state.status))
          .catch((error) => setStatus('error', error.message));
      }
      state.disposeRoute = exposeRoute('exact', webhookPath, handleWebhook, { rawBody: true });
    },
    stop() {
      try {
        state.disposeRoute?.();
      } catch {
        /* ignore */
      }
      state.disposeRoute = null;
      state.token = null;
      state.tokenExpiresAt = 0;
      setStatus('disabled');
    },
    status() {
      return {
        channelId: channel.id,
        type: channel.type,
        status: state.status,
        connected: Boolean(state.token),
        connectedAt: state.connectedAt,
        lastEventAt: state.lastEventAt,
        lastError: state.lastError,
        endpoint: { transport: 'webhook', path: webhookPath, apiBase: API_BASE },
        appId: appId || null,
        secretSet: Boolean(clientSecret),
        tokenCached: Boolean(state.token && Date.now() < state.tokenExpiresAt),
      };
    },
    health() {
      if (!channel.enabled) return { state: 'disabled', detail: '已主动停用，不告警' };
      if (state.status === 'misconfigured') return { state: 'permission', detail: '凭据缺失，无法连接' };
      if (state.status === 'auth-failed') return { state: 'auth-failed', detail: state.lastError ?? '签名校验失败' };
      if (state.status === 'error') return { state: 'offline', detail: state.lastError ?? '连接异常' };
      return { state: 'ok', detail: 'Webhook 就绪' };
    },
    answer,
    async test() {
      const checks = [];
      checks.push({ name: 'AppID', ok: Boolean(appId), detail: appId || '未配置' });
      checks.push({
        name: '服务端凭据',
        ok: Boolean(clientSecret),
        detail: clientSecret ? `已配置（${maskSecret(clientSecret)}）` : '未配置',
      });
      if (!appId || !clientSecret) {
        return { ok: false, checks, error: '缺少凭据，尚未进行真实网络验证' };
      }
      try {
        await fetchToken();
        checks.push({ name: 'access_token 获取', ok: true, detail: '已获取并缓存' });
        return { ok: true, checks };
      } catch (error) {
        checks.push({ name: 'access_token 获取', ok: false, detail: error.message });
        return { ok: false, checks, error: error.message };
      }
    },
    /** Offline protocol self-test: proves signing/verification without credentials. */
    selfTest() {
      const generated = crypto.generateKeyPairSync('ed25519');
      const seed = crypto.randomBytes(32);
      const key = seedToPrivateKey(seed);
      const publicKey = publicKeyOf(key);
      const message = '1700000000plain-token-value';
      const signature = signEd25519(key, message);
      const verified = verifyEd25519(publicKey, message, signature);
      const tampered = verifyEd25519(publicKey, `${message}x`, signature);
      const { derivation } = deriveSigningKey(botSecret || 'placeholder');
      return {
        ok: verified && !tampered,
        checks: [
          { name: 'Ed25519 签名/验签', ok: verified },
          { name: '篡改检测', ok: !tampered },
          { name: '生成密钥对可用', ok: Boolean(generated.publicKey) },
        ],
        keyDerivation: derivation,
        note: '这是本地协议自检，不涉及腾讯开放平台网络请求。',
      };
    },
  };
}
