import { createOneBotAdapter } from './onebot.js';
import { createQqOfficialAdapter } from './qq-official.js';
import { collectImageUrls } from './media.js';
import { now, truncate, zonedParts } from '../util.js';
import {
  decideGroupAttention,
  senderStreak,
  renderTranscript,
  splitReplies,
  groupInput,
  inValleyWindow,
} from '../group-watch.js';

/**
 * The first line of a private message: who wrote it, and whether it is him.
 *
 * The model cannot tell "宝宝晚安" from a stranger apart from one written by the
 * owner, and guessing wrong is the whole bug this exists to prevent. Stating it
 * in the input (rather than only in metadata the model never sees) is also what
 * makes the conversation honest in the console: every stored message says who it
 * came from.
 */
export function privateIdentityLine({ senderName, senderId, senderIsOwner }) {
  const who = String(senderName || senderId || '某人');
  const role = senderIsOwner ? '主人' : '不是主人，是别人';
  return `【QQ 私聊｜${who}（QQ ${senderId ?? '未知'}）｜${role}】`;
}

/**
 * Channel manager.
 *
 * Owns adapter lifecycles (idempotent start/stop), routes one inbound platform
 * event to at most one task, claims it in the durable dedupe ledger before any
 * work happens, and sends a reply only for a run that actually produced text.
 *
 * External delivery is never re-sent automatically: an unknown outcome is
 * recorded as unknown and surfaced, because a duplicate message to a real person
 * is worse than a missing one.
 */
export function createChannelManager({
  repo,
  settings,
  runner,
  log,
  media = null,
  exposeRoute,
  exposeUpgrade,
  getAdminBaseUrl,
}) {
  const adapters = new Map(); // channelId -> adapter
  const adapterConfigs = new Map();
  let started = false;
  let accepting = true;
  const inFlight = new Set();

  /**
   * QQ numbers that count as the owner in a private chat.
   *
   * One number by default, several allowed: the same person may write from a
   * second account. An empty list means nobody is the owner — every private
   * message is then treated as a stranger's, which is the safe direction to fail.
   */
  const ownerIdSet = () => {
    const raw = String(settings.get('channel.ownerIds') ?? '');
    return new Set(
      raw
        .split(/[,\s，、]+/)
        .map((part) => part.trim())
        .filter(Boolean),
    );
  };

  const makeAdapter = (channel) => {
    const common = {
      channel,
      log,
      exposeRoute,
      exposeUpgrade,
      onEvent: (event) => handleInbound(channel, event),
      onStatusChange: (channelId, patch) => {
        if (!accepting) return;
        try {
          repo.channels.setRuntime(channelId, patch);
        } catch (error) {
          log?.debug(`recording channel status failed: ${error.message}`);
        }
      },
    };
    if (channel.type === 'onebot' || channel.type === 'napcat' || channel.type === 'snowluma') {
      return createOneBotAdapter(common);
    }
    if (channel.type === 'qq-official') {
      return createQqOfficialAdapter(common);
    }
    return null;
  };

  /**
   * Does the current local hour fall inside the trigger's window?
   * `[start, end)` with `end < start` wrapping past midnight; no window means
   * "always". The switch exists so a task can be cheap and chatty at night and
   * strict during the expensive part of the day.
   */
  const insideHours = (hours, timezone) => {
    if (!Array.isArray(hours) || hours.length !== 2) return true;
    const [start, end] = hours;
    const { hour } = zonedParts(now(), timezone);
    if (start === end) return true;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  };

  const matchTask = (event, explicitGroup = false) => {
    const timezone = settings.get('runtime.timezone') ?? 'Asia/Shanghai';
    const candidates = [];
    for (const task of repo.tasks.list()) {
      if (!task.enabled) continue;
      for (const trigger of task.triggers) {
        if (!trigger.enabled || trigger.type !== 'message') continue;
        const spec = trigger.spec ?? {};
        if (explicitGroup && spec.peerKind !== 'group') continue;
        if (!insideHours(spec.hours, timezone)) continue;
        if (spec.maxPerHour > 0 && repo.runs.countSince(trigger.id, now() - 3_600_000) >= spec.maxPerHour) {
          log?.debug(`trigger ${trigger.id} hit its hourly cap (${spec.maxPerHour})`);
          continue;
        }
        const eligible = repo.channels.list().filter(c=>c.enabled && ['onebot','napcat','snowluma'].includes(c.type));
        const channelId = spec.channelId || (eligible.length === 1 ? eligible[0].id : '');
        if (!channelId || channelId !== event.channelId) continue;
        if (spec.requirePeer && !spec.peerId) continue;
        if (spec.peerId && String(spec.peerId) !== String(event.peerId ?? '')) continue;
        const peerKind = spec.peerKind ?? 'any';
        if (peerKind !== 'any') {
          const isGroup = event.kind === 'qq_group';
          if (peerKind === 'group' && !isGroup) continue;
          if (peerKind === 'private' && isGroup) continue;
        }
        const text = event.text ?? '';
        let score = 0;
        switch (spec.match) {
          case 'mention':
            if (event.mentioned !== true) continue;
            score = 35;
            break;
          case 'prefix':
            if (!spec.value || !text.startsWith(spec.value)) continue;
            score = 30;
            break;
          case 'contains':
            if (!spec.value || !text.includes(spec.value)) continue;
            score = 20;
            break;
          case 'commands':
            if (!text.startsWith('/') && !text.startsWith('／')) continue;
            score = 25;
            break;
          default:
            score = 10;
        }
        if (spec.channelId) score += 5;
        if (spec.peerId) score += 8;
        if (peerKind !== 'any') score += 3;
        candidates.push({ task, trigger, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.task.createdAt - b.task.createdAt);
    return candidates[0] ?? null;
  };

  const deliver = async (channel, adapter, event, text) => {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return { ok: false, status: 'empty', error: 'run produced no text' };
    try {
      if (channel.type === 'qq-official') {
        return await adapter.answer(event, trimmed);
      }
      const isGroup = event.kind === 'qq_group';
      const params = isGroup
        ? { group_id: Number(event.peerId), message: [{ type: 'text', data: { text: trimmed } }] }
        : { user_id: Number(event.peerId), message: [{ type: 'text', data: { text: trimmed } }] };
      const result = await adapter.call(isGroup ? 'send_group_msg' : 'send_private_msg', params, { timeoutMs: 20_000 });
      if (result?.status === 'failed' || result?.retcode) {
        return { ok: false, status: 'failed', error: JSON.stringify(result).slice(0, 500) };
      }
      return { ok: true, status: 'sent', messageId: result?.data?.message_id ?? null };
    } catch (error) {
      return {
        ok: false,
        status: error.code === 'UNKNOWN_RESULT' ? 'unknown' : 'failed',
        error: error.message,
        note:
          error.code === 'UNKNOWN_RESULT'
            ? '发送结果未知：Yu 不会自动重发，请人工确认平台是否已收到。'
            : undefined,
      };
    }
  };

  /**
   * Buffer one group message, then ask each group-watch trigger whether the room
   * deserves a look.
   *
   * Nothing here calls a model: appending is one insert, and every decision is
   * local arithmetic over the buffer plus the trigger's own policy. That is what
   * keeps a noisy room cheap, and why the policy belongs to the trigger: a second
   * room can answer twice as eagerly without touching this code.
   */
  const watchGroup = (channel, event, direct = false) => {
    const at = now();
    repo.groupBuffer.add({
      channelId: channel.id,
      peerId: event.peerId,
      senderId: event.senderId,
      senderName: event.senderName,
      text: event.text,
      messageId: event.eventId,
      at,
    });

    const candidates = [];
    for (const task of repo.tasks.list()) {
      if (!task.enabled || task.deletedAt) continue;
      for (const trigger of task.triggers ?? []) {
        if (!trigger.enabled || trigger.type !== 'group-watch') continue;
        const spec = trigger.spec ?? {};
        if (spec.channelId && spec.channelId !== channel.id) continue;
        if (spec.peerId && spec.peerId !== event.peerId) continue;
        candidates.push({ task, trigger, spec });
      }
    }
    if (!candidates.length) {
      // No policy is watching this room, but the buffer still grows. Prune with the
      // default window so switching a trigger off cannot turn into disk creep.
      try {
        repo.groupBuffer.prune({ keepHours: 24 });
      } catch (error) {
        log?.debug(`pruning the group buffer failed: ${error.message}`);
      }
      return null;
    }

    const tz = settings.get('runtime.timezone');
    const sentAt = zonedParts(at, tz);
    const minutes = sentAt.hour * 60 + sentAt.minute;
    const recentSenders = repo.groupBuffer.recentSenders(channel.id, event.peerId, 8);
    const mentioned = event.mentioned === true;
    const cursor = repo.groupBuffer.cursor(channel.id, event.peerId);
    const msSinceLastLook = cursor?.lastLookAt ? Math.max(0, at - cursor.lastLookAt) : null;

    let best = null;
    const directBatches = [];
    for (const candidate of candidates) {
      const spec = candidate.spec;
      if (spec.policy === 'keyword-or-count') {
        const batch = repo.groupBuffer.glance(candidate.trigger.id, channel.id, event.peerId,
          {text:event.text,senderId:event.senderId,senderName:event.senderName,at}, {...spec,direct,defer:Boolean(best?.batch)});
        if (direct) directBatches.push({...candidate,batch});
        if (!batch.fire) continue;
        // Reserve once, synchronously, before any asynchronous work. Each binding
        // owns its own pending batch; equal timestamps do not lose messages.
        const decision = {action:'peek',reason:batch.keyword?'keyword':'message-count',keyword:batch.keyword??null};
        best = {...candidate,decision,rank:3,batch};
        continue;
      }
      if (direct) continue;
      const valley = inValleyWindow(minutes, spec.valleyWindows ?? []);
      const decision = decideGroupAttention({
        text: event.text,
        mentioned,
        recentCount: repo.groupBuffer.countSince(channel.id, event.peerId, at - (spec.floodWindowSec ?? 90) * 1000),
        floodThreshold: spec.floodThreshold ?? 12,
        recentSenders,
        followedIds: spec.followedIds ?? [],
        streakThreshold: spec.streakThreshold ?? 3,
        keywords: spec.keywords ?? [],
        keywordProbability: spec.keywordProbability ?? 0.35,
        bandMultiplier: valley ? 1 : (spec.peakMultiplier ?? 0.3),
        random: Math.random(),
        quiet: false,
        msSinceLastLook,
        minLookIntervalMs: (spec.minLookIntervalSec ?? 120) * 1000,
      });
      const rank = decision.action === 'answer' ? 2 : decision.action === 'peek' ? 1 : 0;
      if (!best || rank > best.rank) best = { ...candidate, decision, rank };
    }

    // Housekeeping rides on traffic: a room that nothing consumes still cannot
    // grow without bound.
    try {
      repo.groupBuffer.prune({ keepHours: Math.max(...candidates.map((c) => c.spec.keepHours ?? 72)) || 72 });
    } catch (error) {
      log?.debug(`pruning the group buffer failed: ${error.message}`);
    }

    return direct ? {directBatches} : best;
  };

  /** Send the split replies one by one, in order, like a person typing. */
  const deliverMany = async (channel, adapter, event, texts, { delayMs = 900 } = {}) => {
    const delay = Math.max(0, Number(delayMs) || 0);
    const results = [];
    for (let index = 0; index < texts.length; index += 1) {
      if (index > 0 && delay) await new Promise((resolve) => setTimeout(resolve, delay));
      results.push(await deliver(channel, adapter, event, texts[index]));
    }
    return {
      ok: results.some((result) => result.ok),
      status: results.every((result) => result.ok) ? 'sent' : results.map((r) => r.status).join('+'),
      count: results.length,
      results,
    };
  };

  const handleInbound = (channel, event) => {
    if (!accepting) return Promise.resolve({ matched: false, skipped: true, reason: 'stopping' });
    const snapshot = Object.freeze({...event});
    repo.channels.observePeer(snapshot);
    const pending = handleInboundAccepted(channel, snapshot);
    inFlight.add(pending);
    return pending.finally(() => inFlight.delete(pending));
  };

  const handleInboundAccepted = async (channel, event) => {
    const dedupeKey = { channelId: channel.id, accountId: event.accountId ?? '', eventId: event.eventId };
    const claimed = repo.channels.claimEvent({ ...dedupeKey, detail: { kind: event.kind, peerId: event.peerId } });
    if (!claimed) {
      log?.info(`duplicate ${channel.type} event ${event.eventId} ignored`);
      return { deduped: true };
    }
    repo.channels.setRuntime(channel.id, { status: 'connected', lastEventAt: now() });

    const isGroup = event.kind === 'qq_group';
    if (isGroup && event.accountId && String(event.senderId) === String(event.accountId)) return {matched:false,skipped:true,reason:'self-message'};
    // A private chat is either the owner or somebody else, and that difference
    // decides tone and authority. The text alone cannot say which — "宝宝晚安"
    // reads the same from anyone — so the identity is stated in the input and
    // carried in meta for the tool policy.
    const ownerIds = ownerIdSet();
    const senderIsOwner = ownerIds.has(String(event.senderId ?? ''));
    const authority = isGroup ? 'group' : senderIsOwner ? 'owner' : 'guest';
    if (!isGroup && !senderIsOwner && !settings.get('channel.guestReply')) {
      repo.channels.markEvent(dedupeKey.channelId, dedupeKey.accountId, dedupeKey.eventId, 'skipped', {
        reason: 'stranger private message, replies are off',
      });
      log?.info(`private message from ${event.senderId} ignored: strangers are not answered`);
      return { matched: false, skipped: true, reason: 'guest-replies-off' };
    }
    // Group rooms are watched, not answered line by line. A group message is
    // buffered always, and only a `group-watch` trigger that decides "look" (or
    // "answer") starts a run — through that trigger's own task.
    let watch = null;
    // Explicit group message bindings are immediate responses; legacy observers
    // still buffer and decide when no immediate rule matches.
    const direct = isGroup ? matchTask(event, true) : null;
    if (isGroup && String(event.text ?? '').trim()) {
      watch = watchGroup(channel, event, Boolean(direct));
      if (!direct && (!watch || watch.decision.action === 'ignore')) {
        repo.channels.markEvent(dedupeKey.channelId, dedupeKey.accountId, dedupeKey.eventId, 'buffered', {
          reason: watch?.decision?.reason ?? 'no group-watch trigger',
        });
        return { matched: false, buffered: true, decision: watch?.decision ?? null };
      }
    }

    const match = direct || (watch ? { task: watch.task, trigger: watch.trigger } : matchTask(event));
    if (!match) {
      repo.channels.markEvent(dedupeKey.channelId, dedupeKey.accountId, dedupeKey.eventId, 'no-task');
      return { matched: false, decision: watch?.decision ?? null };
    }
    const groupDecision = direct ? null : watch?.decision ?? null;

    const adapter = adapters.get(channel.id);
    // Pictures arrive as URLs; they are saved to disk before the run so the agent
    // can open them, and the input says exactly where each one went. A group look
    // is the exception: its input is rebuilt from the room's transcript further
    // down, so downloading this one message here would be thrown away — the look
    // fetches every image in its own window instead.
    let input = event.text ?? '';
    // Who is speaking, stated rather than inferred. Without this line every
    // private message looked like it came from him: a stranger saying "宝宝晚安"
    // got answered as if he had said it.
    if (!isGroup) {
      input = `${privateIdentityLine({
        senderName: event.senderName || event.peerLabel,
        senderId: event.senderId ?? event.peerId,
        senderIsOwner,
      })}\n${input}`;
    }
    if (!groupDecision && media && Array.isArray(event.images) && event.images.length) {
      try {
        const saved = await media.ingest({ channel, event, images: event.images });
        log?.info(`images saved: ${saved.length}`);
        const note = media.describe(saved);
        if (note) input = `${input}\n${note}`.trim();
      } catch (error) {
        log?.warn(`saving channel images failed: ${error.message}`);
        input = `${input}\n[图片无法读取: ${error.message}]`.trim();
      }
    }

    // A group look sends what is *new* since the last look, not the same window
    // again: the earlier lines are already in this room's session history, and
    // re-sending them made her answer the same thing twice while paying for the
    // same tokens on every run. The very first look in a room has no history to
    // stand on, so it gets the tail of the buffer as its introduction.
    let windowIds = [];
    let cursorAt = null;
    if (groupDecision) {
      const limit = Number(watch?.spec?.windowMessages) || 30;
      const seen = repo.groupBuffer.cursor(channel.id, event.peerId);
      let windowMessages = watch.batch ? watch.batch.messages : seen?.lastAt
        ? repo.groupBuffer.windowAfter({ channelId: channel.id, peerId: event.peerId, sinceAt: seen.lastAt, limit })
        : repo.groupBuffer.window({ channelId: channel.id, peerId: event.peerId, limit });
      if (!windowMessages.length) {
        // Same-millisecond arrival: fall back to this one line rather than sending
        // an empty transcript.
        windowMessages = [
          {
            id: event.eventId,
            channelId: channel.id,
          channelType: channel.type,
            peerId: event.peerId,
            senderId: event.senderId,
            senderName: event.senderName,
            text: event.text,
            at: now(),
          },
        ];
      }
      windowIds = windowMessages.map((message) => message.id).filter(id=>typeof id==='string'&&id.length>0);
      cursorAt = windowMessages[windowMessages.length - 1]?.at ?? now();
      input = groupInput({
        transcript: renderTranscript(watch.batch ? windowMessages.map(message=>({...message,text:truncate(message.text,200)})) : windowMessages, { at: now(), ownerIds, maxChars:watch.batch?60000:6000 }),
        mode: groupDecision.action,
        reason: groupDecision.reason,
        keyword: groupDecision.keyword,
        roomLabel: event.peerLabel,
        initial: !seen?.lastAt,
      });
      if (watch.batch) input += '\n\n这是本群自上次查看后的新消息。自行决定是否接话；不想回复时只输出 %% 。需要回复时只写一条准备发回本群的话，不总结聊天记录。';
      // Pictures in the window are only URLs in the buffered text. Save them now
      // and append the absolute paths, or she is handed "[图片:https://…]" and
      // reasonably answers that she has no way to look at it.
      if (media && !watch.batch) {
        const urls = collectImageUrls(
          windowMessages.map((message) => message.text),
          { limit: 4 },
        );
        if (urls.length) {
          try {
            const saved = await media.ingest({
              channel,
              event: { eventId: `${event.eventId ?? 'look'}-look`, at: now() },
              images: urls.map((url) => ({ url })),
            });
            const note = media.describe(saved);
            if (note) input = `${input}\n\n${note}`;
            log?.info(`group look saved ${saved.filter((item) => item.path).length}/${urls.length} image(s)`);
          } catch (error) {
            log?.warn(`saving group images failed: ${error.message}`);
          }
        }
      }
    }

    let enqueued;
    try {
      enqueued = runner.enqueue(match.task, {
        triggerId: match.trigger.id,
        reason: groupDecision
          ? `群聊观察：${groupDecision.reason}${groupDecision.keyword ? `（${groupDecision.keyword}）` : ''}`
          : `${channel.type === 'qq-official' ? 'QQ 官方' : 'OneBot'} ${event.kind === 'qq_group' ? '群聊' : '私聊'}消息`,
        input,
        meta: {
          channelId: channel.id,
          peerId: event.peerId,
          peerLabel: event.peerLabel,
          kind: event.kind,
          senderId: event.senderId,
          senderName: event.senderName,
          authority,
          senderIsOwner,
          eventId: event.eventId,
          groupDecision: groupDecision ?? null,
          replyMode: match.trigger.spec?.replyMode ?? 'reply',
        },
        source: 'message',
      });
    } catch (error) {
      if (watch?.batch) repo.groupBuffer.restoreGlance(watch.trigger.id, channel.id, event.peerId, watch.batch,watch.spec.windowMessages);
      for (const candidate of watch?.directBatches ?? []) repo.groupBuffer.restoreGlance(candidate.trigger.id,channel.id,event.peerId,candidate.batch,candidate.spec.windowMessages);
      repo.channels.markEvent(dedupeKey.channelId, dedupeKey.accountId, dedupeKey.eventId, 'failed', {
        error: error.message,
      });
      return { matched: true, error: error.message };
    }

    // Only move the cursor once a run actually exists: if enqueueing failed, the
    // next look must still see these lines.
    if (groupDecision) {
      try {
        repo.groupBuffer.setCursor(channel.id, event.peerId, { lastAt: cursorAt ?? now(), lastLookAt: now() });
      } catch (error) {
        log?.warn(`advancing the group cursor failed: ${error.message}`);
      }
    }

    repo.channels.markEvent(dedupeKey.channelId, dedupeKey.accountId, dedupeKey.eventId, 'running', {
      runId: enqueued.run.id,
      decision: groupDecision ?? null,
    });

    if (enqueued.delivery) {
      const final = await repo.dshLinks.waitForDelivery(enqueued.delivery.id);
      repo.channels.markEvent(dedupeKey.channelId,dedupeKey.accountId,dedupeKey.eventId,final.status,{runId:enqueued.delivery.id,delivery:final.delivery??null});
      return {matched:true,runId:enqueued.delivery.id,delivery:final.delivery,status:final.status};
    }
    if (match.trigger.spec?.replyMode === 'record') {
      const final = await runner.waitForRun(enqueued.run.id).catch(() => null);
      repo.channels.markEvent(dedupeKey.channelId, dedupeKey.accountId, dedupeKey.eventId, final?.status === 'failed' ? 'failed' : 'processed', {
        runId: enqueued.run.id, delivery: {status:'record-only',count:0},
      });
      return { matched: true, runId: enqueued.run.id, reply: 'record-only' };
    }
    if (!adapter) return { matched: true, runId: enqueued.run.id, reply: 'no-adapter' };

    const finalRun = await runner.waitForRun(enqueued.run.id).catch(() => null);
    const text = finalRun?.status && finalRun.status !== 'succeeded' ? '' : finalRun?.outputText ?? '';
    // The formatting policy lives in `splitReplies` (one message, stray `%%` cuts,
    // repeated sentences dropped) — the prompt says nothing about it.
    const replies = groupDecision
      ? splitReplies(text)
      : [String(text ?? '').trim()].filter(Boolean);
    const delivery =
      replies.length > 0
        ? await deliverMany(channel, adapter, event, replies)
        : { ok: false, status: 'empty', count: 0 };
    if (replies.length > 0) repo.groupBuffer.markAnswered(windowIds);
    repo.channels.markEvent(dedupeKey.channelId, dedupeKey.accountId, dedupeKey.eventId, 'processed', {
      runId: enqueued.run.id,
      decision: groupDecision ?? null,
      delivery: { status: delivery.status, error: delivery.error ?? null, count: delivery.count ?? 0 },
    });
    if (!delivery.ok) {
      log?.warn(`reply delivery for ${channel.name} ended as ${delivery.status}: ${delivery.error ?? 'no reply'}`);
    }
    return { matched: true, runId: enqueued.run.id, delivery, decision: groupDecision };
  };

  const sync = () => {
    const channels = repo.channels.list();
    const seen = new Set();
    for (const channel of channels) {
      seen.add(channel.id);
      const existing = adapters.get(channel.id);
      const shouldRun = channel.enabled;
      if (!shouldRun) {
        if (existing) {
          try {
            existing.stop();
          } catch (error) {
            log?.warn(`stopping channel ${channel.name} failed: ${error.message}`);
          }
          adapters.delete(channel.id);
          adapterConfigs.delete(channel.id);
        }
        continue;
      }
      if (existing) {
        // Config changed: a type swap requires a fresh adapter.
        const existingType = existing.type;
        if (existingType !== channel.type || adapterConfigs.get(channel.id) !== JSON.stringify(channel.config)) {
          try {
            existing.stop();
          } catch {
            /* ignore */
          }
          adapters.delete(channel.id);
        }
      }
      if (!adapters.has(channel.id)) {
        const adapter = makeAdapter(channel);
        if (adapter) {
          try {
            adapter.start();
            adapters.set(channel.id, adapter);
            adapterConfigs.set(channel.id, JSON.stringify(channel.config));
            log?.info(`channel ${channel.name} (${channel.type}) started`);
          } catch (error) {
            log?.error(`starting channel ${channel.name} failed: ${error.message}`);
            repo.channels.setRuntime(channel.id, { status: 'error', lastError: error.message });
          }
        }
      }
    }
    for (const [id, adapter] of adapters) {
      if (!seen.has(id)) {
        try {
          adapter.stop();
        } catch {
          /* ignore */
        }
        adapters.delete(id);
        adapterConfigs.delete(id);
      }
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      accepting = true;
      sync();
    },
    stop() {
      accepting = false;
      started = false;
      for (const [, adapter] of adapters) {
        try {
          adapter.stop();
        } catch (error) {
          log?.warn(`stopping adapter failed: ${error.message}`);
        }
      }
      adapters.clear();
      adapterConfigs.clear();
      return Promise.allSettled([...inFlight]);
    },
    sync,
    adapters,
    /** One inbound platform event, end to end. Exposed so tests can drive it. */
    handleInbound,
    status() {
      return repo.channels.list().map((channel) => {
        const adapter = adapters.get(channel.id);
        const runtime = adapter ? adapter.status() : null;
        return {
          ...channel,
          config: maskConfig(channel.config),
          runtime,
          health: adapter ? adapter.health() : { state: channel.enabled ? 'stopped' : 'disabled', detail: '' },
        };
      });
    },
    /** Test a draft config without saving it (page-level "连接测试"). */
    async testConfig({ type, config }) {
      if (type === 'qq-official') {
        const probe = createQqOfficialAdapter({
          channel: { id: 'draft', type, config, enabled: false, name: 'draft' },
          log,
          exposeRoute: () => () => {},
          exposeUpgrade: () => () => {},
          onEvent: async () => {},
        });
        const result = await probe.test();
        return { ...result, selfTest: probe.selfTest(), realNetwork: Boolean(result.ok) };
      }
      if (type === 'onebot' || type === 'napcat' || type === 'snowluma') {
        const checks = [
          {
            name: '访问令牌',
            ok: Boolean(String(config?.token ?? '')),
            detail: config?.token ? '已填写' : '缺少 OneBot 访问令牌',
          },
          {
            name: 'QQ 号',
            ok: !config?.selfId || /^\d{1,20}$/.test(String(config.selfId)),
            detail: String(config?.selfId ?? '') || '缺少 selfId（机器人 QQ 号）',
          },
          {
            name: '反向 WebSocket 地址',
            ok: true,
            detail: `ws://127.0.0.1:<Yu 端口>/onebot/<连接 id>`,
          },
          {
            name: 'HTTP API（可选）',
            ok: true,
            detail: config?.httpBase ? String(config.httpBase) : '未配置；配置后可用于 get_status 真实验证',
          },
        ];
        if (config?.httpBase) {
          // SnowLuma gives the OneBot HTTP server its own access token, separate
          // from the one the reverse-WS client presents to Yu. Probing with the WS
          // token is a guaranteed 401, so use `httpToken` when it is set.
          const probeToken = String(config.httpToken ?? '') || String(config.token ?? '');
          try {
            const response = await fetch(`${String(config.httpBase).replace(/\/+$/, '')}/get_status`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(probeToken ? { authorization: `Bearer ${probeToken}` } : {}),
              },
              body: '{}',
              signal: AbortSignal.timeout(8000),
            });
            const payload = await response.json().catch(() => null);
            checks.push({
              name: 'get_status',
              ok: response.ok,
              detail: truncate(JSON.stringify(payload?.data ?? payload ?? {}), 300),
            });
          } catch (error) {
            checks.push({ name: 'get_status', ok: false, detail: error.message });
          }
        }
        return {
          ok: checks.every((c) => c.ok !== false),
          checks,
          note: 'OneBot v11反向 WS 模式需要在兼容客户端中把地址指向 Yu，连接测试不能代替对端配置。',
        };
      }
      return { ok: false, checks: [], error: `未知渠道类型 ${type}` };
    },
    /**
     * Proactive send with no inbound event behind it: Yu says something first.
     * It uses the same `send_*_msg` primitive as a reply, so a channel that
     * cannot deliver a reply cannot claim to deliver this either.
     */
    async send({ channelId, peerId, peerKind = 'private', text }) {
      const channel = repo.channels.get(channelId);
      if (!channel) return { ok: false, status: 'unknown-channel', error: '渠道不存在' };
      if (!channel.enabled) return {ok:false,status:'disabled',error:'渠道已停用'};
      const body = String(text ?? '').trim();
      if (!body) return { ok: false, status: 'empty', error: '内容为空' };
      const adapter = adapters.get(channel.id);
      if (!adapter) return { ok: false, status: 'not-connected', error: '渠道未连接：先在接入页启用并登录' };
      if (channel.type === 'qq-official') {
        return { ok: false, status: 'unsupported', error: 'QQ 官方机器人只能被动回复，不能主动发消息' };
      }
      const isGroup = peerKind === 'group';
      try {
        const params = isGroup
          ? { group_id: Number(peerId), message: [{ type: 'text', data: { text: body } }] }
          : { user_id: Number(peerId), message: [{ type: 'text', data: { text: body } }] };
        const result = await adapter.call(isGroup ? 'send_group_msg' : 'send_private_msg', params, {
          timeoutMs: 20_000,
        });
        if (result?.status === 'failed' || result?.retcode) {
          return { ok: false, status: 'failed', error: JSON.stringify(result).slice(0, 500) };
        }
        return { ok: true, status: 'sent', messageId: result?.data?.message_id ?? null };
      } catch (error) {
        return { ok: false, status: error.code === 'UNKNOWN_RESULT' ? 'unknown' : 'failed', error: error.message };
      }
    },
    adapterFor: (channelId) => adapters.get(channelId) ?? null,
    adminBaseUrl: getAdminBaseUrl,
  };
}

export function maskConfig(config) {
  const out = { ...(config ?? {}) };
  for (const key of ['token', 'webuiToken', 'clientSecret', 'botSecret', 'httpToken', 'password']) {
    if (out[key]) out[`${key}__set`] = true;
    if (out[key]) delete out[key];
  }
  return out;
}

/** A channel as the browser may see it: config secrets replaced by `__set` flags. */
export function maskChannel(channel) {
  if (!channel) return channel;
  return { ...channel, config: maskConfig(channel.config) };
}
