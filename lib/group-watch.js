/**
 * Group attention: when a room full of people is talking, does Yu look?
 *
 * The old shape was one trigger per message, which is both expensive (a model call
 * per line in a busy room) and wrong in spirit: a group is not a conversation with
 * her. This module keeps the cheap part cheap and makes the expensive part
 * deliberate:
 *
 *   1. every message is appended to a buffer (`repo.groupBuffer`) — no model;
 *   2. a local policy decides `answer` / `peek` / `ignore` from that buffer;
 *   3. only `answer` and `peek` build a window and start one run;
 *   4. memory maintenance drains the whole buffer, then the rows are deleted.
 *
 * The policy is pure and takes its signals as arguments, so the tests can state
 * "in a flood, look but do not talk" without a database or a clock.
 */

/** Reasons a decision can carry; the console shows them verbatim. */
export const GROUP_ACTIONS = ['answer', 'peek', 'ignore'];

/**
 * Peak vs valley pricing.
 *
 * DeepSeek charges less off-peak, so talking should cost less attention in peak
 * hours, not the same all day. `valleyWindows` is a list of `HH:MM-HH:MM` (may
 * wrap past midnight); anything outside them is peak.
 */
export function inValleyWindow(minutesOfDay, windows) {
  for (const raw of windows ?? []) {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
    if (!match) continue;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    const now = minutesOfDay;
    if (start === end) continue;
    if (start < end) {
      if (now >= start && now < end) return true;
    } else if (now >= start || now < end) {
      // Wraps midnight, e.g. 00:30-08:30 written as 22:00-06:00.
      return true;
    }
  }
  return false;
}

/** Which hour band we are in, for the decision record. */
export function priceBand(minutesOfDay, windows) {
  return inValleyWindow(minutesOfDay, windows) ? 'valley' : 'peak';
}

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does this text contain one of the watched words?
 *
 * Matching is case-insensitive for latin words and ignores surrounding
 * punctuation, so "小雨！" and "小雨" both hit. Chinese has no word boundaries to
 * rely on, so a plain substring match is the honest rule.
 */
export function matchesKeyword(text, keywords) {
  const hay = String(text ?? '').toLowerCase();
  if (!hay) return null;
  for (const raw of keywords ?? []) {
    const word = String(raw ?? '').trim().toLowerCase();
    if (!word) continue;
    if (/^[a-z0-9 _-]+$/.test(word)) {
      if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`).test(hay)) return { word };
    } else if (hay.includes(word)) {
      return { word };
    }
  }
  return null;
}

/**
 * Decide whether to look at the room.
 *
 * Inputs are the facts the caller already has from the buffer, so this function
 * is deterministic and testable:
 *
 * @param {object} input
 * @param {string} input.text            the message just received
 * @param {boolean} input.mentioned      the bot was @-ed or named directly
 * @param {number} input.recentCount     messages in this room inside `floodWindowMs`
 * @param {number} input.floodThreshold  count at or above which the room is "flooding"
 * @param {Array<{senderId:string}>} input.recentSenders  last senders, newest first
 * @param {Array<string>} input.followedIds  senders worth following
 * @param {number} input.streak          how many in a row the same followed sender has
 * @param {number} input.streakThreshold how many in a row counts as "talking a lot"
 * @param {Array<string>} input.keywords watched words
 * @param {number} input.keywordProbability base chance to answer on a keyword hit (0..1)
 * @param {number} input.bandMultiplier  peak/valley multiplier for that chance
 * @param {number} input.random           a uniform random draw in [0,1)
 * @param {boolean} input.quiet          the room is inside a silence window
 * @param {number|null} input.msSinceLastLook  how long ago she last looked (null: never)
 * @param {number} input.minLookIntervalMs     quiet period between ambient looks
 * @returns {{action:'answer'|'peek'|'ignore', reason:string, keyword:string|null, probability:number|null}}
 */
export function decideGroupAttention(input) {
  const {
    text = '',
    mentioned = false,
    recentCount = 0,
    floodThreshold = 12,
    recentSenders = [],
    followedIds = [],
    streakThreshold = 3,
    keywords = [],
    keywordProbability = 0.35,
    bandMultiplier = 1,
    random = 0.5,
    quiet = false,
    msSinceLastLook = null,
    minLookIntervalMs = 0,
  } = input ?? {};

  if (quiet) return { action: 'ignore', reason: 'quiet-hours', keyword: null, probability: null };

  // Being called is not probabilistic: if a person says your name, you turn your
  // head. Whether you *speak* is a different question, decided below.
  if (mentioned) return { action: 'answer', reason: 'mentioned', keyword: null, probability: 1 };

  const hit = matchesKeyword(text, keywords);
  if (hit) {
    const probability = Math.max(0, Math.min(1, Number(keywordProbability) * Number(bandMultiplier || 1)));
    if (random < probability) {
      return { action: 'answer', reason: 'keyword', keyword: hit.word, probability };
    }
    // Missed the roll: still worth a glance in a busy room, but do not speak.
    return { action: 'peek', reason: 'keyword-skipped', keyword: hit.word, probability };
  }

  const flooding = recentCount >= Math.max(2, floodThreshold);
  const followed = new Set((followedIds ?? []).map(String));
  const newestSender = String(recentSenders[0]?.senderId ?? '');
  const streak = followed.has(newestSender) ? senderStreak(recentSenders, newestSender) : 0;
  const chattering = streak >= Math.max(2, streakThreshold);

  // A room that never stops talking must not turn "look once in a while" into
  // "one model call per line". The cooldown only gates the ambient reasons; being
  // named or hitting a keyword is a deliberate call and always gets through.
  const coolingDown =
    msSinceLastLook !== null && msSinceLastLook !== undefined && msSinceLastLook < Math.max(0, minLookIntervalMs || 0);
  if (flooding || chattering) {
    if (coolingDown) return { action: 'ignore', reason: 'cooldown', keyword: null, probability: null };
    return flooding
      ? { action: 'peek', reason: 'flood', keyword: null, probability: null }
      : { action: 'peek', reason: 'followed-streak', keyword: null, probability: null };
  }

  return { action: 'ignore', reason: 'ambient', keyword: null, probability: null };
}

/** How many messages in a row the newest sender has, counting back. */
export function senderStreak(recentSenders, senderId) {
  let count = 0;
  for (const sender of recentSenders ?? []) {
    if (String(sender?.senderId ?? '') !== String(senderId ?? '')) break;
    count += 1;
  }
  return count;
}

/**
 * Render a window of buffered messages for the model.
 *
 * Timestamps are relative ("2 分钟前") rather than absolute clock times: she is
 * reading a moment, not a log, and an ISO stamp in a prompt is exactly the kind of
 * machinery that made her memory read like a report.
 */
export function renderTranscript(messages, { at = Date.now(), maxChars = 6000, ownerIds = null } = {}) {
  const owners = ownerIds instanceof Set ? ownerIds : new Set((ownerIds ?? []).map(String));
  const lines = [];
  let used = 0;
  for (const message of messages) {
    const raw = message.senderName || message.senderId || '某人';
    // In a room the owner is just another nickname: without a marker she would
    // have to guess who she is talking to from what was said.
    const name = owners.has(String(message.senderId ?? '')) ? `${raw}（主人）` : raw;
    const age = Math.max(0, Math.round((at - message.at) / 1000));
    const when = age < 60 ? `${age} 秒前` : age < 3600 ? `${Math.round(age / 60)} 分钟前` : `${Math.round(age / 3600)} 小时前`;
    const line = `[${when}] ${name}：${message.text}`;
    if (used + line.length > maxChars) break;
    used += line.length + 1;
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Turn one model reply into the messages to send. The rules live here, not in the
 * prompt — the model is never told how to format a group message.
 *
 *   1. A reply that is only `%%` means "nothing to say": send nothing.
 *   2. `%%` alone on a line is an old formatting habit, not content: it cuts the
 *      reply there, and only the first part is sent.
 *   3. One look sends one message. Multi-paragraph replies are sent as one text;
 *      they are not fanned out into separate bubbles.
 *   4. A sentence already said in this reply is dropped, and a part left with
 *      nothing new is skipped. A weak model tends to restate its first sentence
 *      in every part, and the room would see the same line three times.
 */
export const REPLY_RULES = Object.freeze({
  maxMessages: 1,
  silenceMarker: '%%',
  dedupeSentences: true,
});

export function splitReplies(text, { maxMessages = REPLY_RULES.maxMessages } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return [];
  if (/^%+$/.test(body)) return [];
  const parts = body
    .split(/^\s*%%\s*$/m)
    .map((part) => part.trim())
    .filter((part) => part && !/^%+$/.test(part));
  const chosen = parts.length ? parts : [body];

  const limit = Math.max(1, maxMessages);
  const seen = new Set();
  const kept = [];
  for (const part of chosen) {
    const fresh = [];
    for (const sentence of splitSentences(part)) {
      const key = normalizeSentence(sentence);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fresh.push(sentence);
    }
    const line = fresh.join('').trim();
    if (line && !/^%+$/.test(line)) kept.push(line);
    if (kept.length >= limit) break;
  }
  // Everything was a repeat of the first sentence: one copy is still a reply.
  return kept.length ? kept : [parts[0] ?? body].slice(0, 1);
}

/** Sentences without their separators; used only for comparing, never for output. */
function splitSentences(text) {
  return String(text)
    .split(/(?<=[。！？!?…~～])\s*|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalizeSentence(sentence) {
  return String(sentence)
    .replace(/[\s，。！？、；：,.!?;:~～…—\-"'“”‘’（）()【】\[\]]+/g, '')
    .toLowerCase();
}

/**
 * The input handed to the model when she looks at a room.
 *
 * Two lines and the transcript: where she is and why she looked. No formatting
 * rules, no "don't repeat yourself", no "say nothing if…" — every one of those
 * was a line the model could echo back, and a weak model writes worse the more
 * instructions it is juggling. She answers in one message, the way a person
 * drops one line into a group.
 */
export function groupInput({ transcript, mode, reason, keyword, roomLabel, initial = false }) {
  const label = roomLabel || '群聊';
  // "你扫了一眼" framed the whole batch as something to read and comment on —
  // a digest to summarise. She is in the room; the header should say so.
  const why = keyword ? `有人提到「${keyword}」` : mode === 'answer' ? '有人在叫你' : '你也在群里';
  return [`群聊「${label}」· ${why}`, '', transcript].join('\n');
}
