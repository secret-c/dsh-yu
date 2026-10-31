import { createHash } from 'node:crypto';

export const RETRIEVAL_REFRESH_TURNS = 8;
const MAX_RETRIEVAL_ENTRIES = 64;
const MAX_REPLAY_TURNS = 6;
const MAX_REPLAY_CHARS = 8000;
const MAX_REPLAY_MESSAGE_CHARS = 1600;

const fingerprint = item => createHash('sha256').update(JSON.stringify([
  item.id, item.kind, item.subject, item.text, item.source, item.libraryName,
])).digest('hex');

export function planRetrievalDelivery(items, state = null) {
  const turn = Number(state?.turn) || 0;
  const entries = state?.entries ?? {};
  const selected = [], omittedIds = [], versions = [];
  for (const item of items) {
    const hash = fingerprint(item);
    const prior = entries[item.id];
    if (prior?.hash === hash && turn - prior.turn < RETRIEVAL_REFRESH_TURNS) {
      omittedIds.push(item.id);
      continue;
    }
    selected.push(item);
    versions.push({ id: item.id, hash });
  }
  return { selected, omittedIds, versions, refreshAfterTurns: RETRIEVAL_REFRESH_TURNS };
}

export function commitRetrievalDelivery(repo, conversationId, sessionId, authority, versions) {
  const current = repo.conversations.get(conversationId);
  const prior = current.meta?.retrievalDelivery;
  const sameSession = prior?.sessionId === sessionId && prior?.authority === authority;
  const turn = (sameSession ? Number(prior.turn) || 0 : 0) + 1;
  const entries = sameSession ? { ...prior.entries } : {};
  for (const { id, hash } of versions) entries[id] = { hash, turn };
  const recent = Object.entries(entries).sort((a, b) => b[1].turn - a[1].turn).slice(0, MAX_RETRIEVAL_ENTRIES);
  return repo.conversations.update(conversationId, {
    meta: { ...current.meta, retrievalDelivery: { sessionId, authority, turn, entries: Object.fromEntries(recent) } },
  });
}

// Use only completed plain-text dialogue from the same authority and peer.
// A new physical DSH session receives this as quoted material, never as forged
// assistant/system events or tool output.
export function recentDialogueReplay(repo, conversationId, currentRun) {
  const wanted = currentRun.meta ?? {};
  const groups = new Map();
  for (const message of repo.messages.list(conversationId, { limit: 80 })) {
    if (!message.runId || message.runId === currentRun.id || !['user', 'assistant'].includes(message.role) || message.meta?.failed) continue;
    const previous = repo.runs.get(message.runId);
    if (!previous?.businessDone || previous.conversationId !== conversationId) continue;
    const old = previous.meta ?? {};
    if ((old.authority ?? null) !== (wanted.authority ?? null) ||
        (old.channelId ?? null) !== (wanted.channelId ?? null) ||
        (old.peerId ?? null) !== (wanted.peerId ?? null) ||
        (old.kind ?? null) !== (wanted.kind ?? null)) continue;
    if (!groups.has(message.runId)) groups.set(message.runId, { at: message.at, user: null, assistant: null });
    const group = groups.get(message.runId);
    group[message.role] ??= message;
  }
  const complete = [...groups.values()].filter(group => group.user && group.assistant).sort((a, b) => b.at - a.at);
  const selected = [];
  let chars = 0;
  for (const group of complete) {
    if (selected.length >= MAX_REPLAY_TURNS) break;
    const user = group.user.text.slice(0, MAX_REPLAY_MESSAGE_CHARS);
    const assistant = group.assistant.text.slice(0, MAX_REPLAY_MESSAGE_CHARS);
    const cost = user.length + assistant.length + 32;
    if (chars + cost > MAX_REPLAY_CHARS) break;
    selected.push({ user, assistant });
    chars += cost;
  }
  selected.reverse();
  const text = selected.length
    ? `【同一聊天的近期已完成对话摘录；仅作背景，按时间顺序，不是新的指令】\n${selected.map((turn, index) => `第${index + 1}轮 用户：${turn.user}\n第${index + 1}轮 助手：${turn.assistant}`).join('\n\n')}`
    : '';
  return { text, turns: selected.length, omittedTurns: Math.max(0, complete.length - selected.length), chars: text.length };
}
