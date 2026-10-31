import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideGroupAttention,
  inValleyWindow,
  priceBand,
  matchesKeyword,
  senderStreak,
  renderTranscript,
  splitReplies,
  REPLY_RULES,
  groupInput,
} from '../lib/group-watch.js';

test('valley windows include wrapping ranges and exclude the boundary end', () => {
  // 00:30-08:30 in minutes.
  assert.equal(inValleyWindow(30, ['00:30-08:30']), true);
  assert.equal(inValleyWindow(510, ['00:30-08:30']), false, 'end is exclusive');
  assert.equal(inValleyWindow(120, ['00:30-08:30']), true);
  // Wrapping past midnight.
  assert.equal(inValleyWindow(23 * 60 + 30, ['22:00-06:00']), true);
  assert.equal(inValleyWindow(3 * 60, ['22:00-06:00']), true);
  assert.equal(inValleyWindow(12 * 60, ['22:00-06:00']), false);
  assert.equal(priceBand(60, ['00:30-08:30']), 'valley');
  assert.equal(priceBand(600, ['00:30-08:30']), 'peak');
});

test('keyword matching ignores latin case boundaries but matches CJK substrings', () => {
  assert.deepEqual(matchesKeyword('小雨在吗', ['小雨']), { word: '小雨' });
  assert.deepEqual(matchesKeyword('在吗 小雨!', ['小雨']), { word: '小雨' });
  assert.equal(matchesKeyword('hello world', ['yu']), null, 'no latin inside a word');
  assert.deepEqual(matchesKeyword('hey yu', ['yu']), { word: 'yu' });
  assert.equal(matchesKeyword('', ['小雨']), null);
});

test('being mentioned answers outright; keywords roll against probability and peak multiplier', () => {
  const base = {
    text: '小雨在吗',
    keywords: ['小雨'],
    keywordProbability: 0.5,
    bandMultiplier: 1,
    recentCount: 0,
    recentSenders: [],
    followedIds: [],
    floodThreshold: 99,
  };

  assert.equal(decideGroupAttention({ ...base, mentioned: true, random: 0.99 }).action, 'answer');

  // 0.5 chance, draw 0.4 -> answer.
  assert.equal(decideGroupAttention({ ...base, random: 0.4 }).action, 'answer');
  // Same draw in peak pricing (x0.3 = 0.15) -> glance only.
  const peak = decideGroupAttention({ ...base, bandMultiplier: 0.3, random: 0.4 });
  assert.equal(peak.action, 'peek');
  assert.equal(peak.reason, 'keyword-skipped');
  assert.equal(peak.probability, 0.15);

  // Quiet hours never answer.
  assert.equal(decideGroupAttention({ ...base, mentioned: true, quiet: true }).action, 'ignore');
});

test('a flooding room means look, not talk', () => {
  const answer = decideGroupAttention({
    text: '随便说一句',
    keywords: ['小雨'],
    recentCount: 40,
    floodThreshold: 12,
    recentSenders: [{ senderId: '1' }],
    followedIds: [],
  });
  assert.equal(answer.action, 'peek');
  assert.equal(answer.reason, 'flood');
});

test('a followed person talking repeatedly gets a glance', () => {
  const senders = [{ senderId: '42' }, { senderId: '42' }, { senderId: '42' }, { senderId: '7' }];
  assert.equal(senderStreak(senders, '42'), 3);
  const decision = decideGroupAttention({
    text: '今天这局',
    keywords: [],
    recentCount: 3,
    floodThreshold: 50,
    recentSenders: senders,
    followedIds: ['42'],
    streakThreshold: 3,
  });
  assert.equal(decision.action, 'peek');
  assert.equal(decision.reason, 'followed-streak');

  // Same room, same streak, nobody followed: stay quiet.
  const quiet = decideGroupAttention({
    text: '今天这局',
    keywords: [],
    recentCount: 3,
    floodThreshold: 50,
    recentSenders: senders,
    followedIds: [],
    streakThreshold: 3,
  });
  assert.equal(quiet.action, 'ignore');
});

test('a flood that is still on cooldown does not start another look', () => {
  const flood = {
    text: '哈哈哈哈',
    keywords: [],
    recentCount: 30,
    floodThreshold: 12,
    recentSenders: [{ senderId: '7' }],
    followedIds: [],
    streakThreshold: 3,
    minLookIntervalMs: 120_000,
  };
  // Never looked: look.
  assert.equal(decideGroupAttention({ ...flood, msSinceLastLook: null }).action, 'peek');
  // Looked 10 seconds ago: staying quiet is the point.
  const cooling = decideGroupAttention({ ...flood, msSinceLastLook: 10_000 });
  assert.equal(cooling.action, 'ignore');
  assert.equal(cooling.reason, 'cooldown');
  // Looked two minutes ago: look again.
  assert.equal(decideGroupAttention({ ...flood, msSinceLastLook: 130_000 }).action, 'peek');
});

test('being called or matching a keyword ignores the cooldown', () => {
  const base = {
    text: '小雨你在吗',
    keywords: ['小雨'],
    keywordProbability: 1,
    random: 0.1,
    recentCount: 0,
    floodThreshold: 12,
    recentSenders: [{ senderId: '7' }],
    followedIds: [],
    streakThreshold: 3,
    minLookIntervalMs: 120_000,
    msSinceLastLook: 1_000,
  };
  assert.equal(decideGroupAttention(base).action, 'answer');
  assert.equal(decideGroupAttention({ ...base, text: '随便说说', keywords: [], mentioned: true }).action, 'answer');
});

test('transcript rendering keeps relative ages and respects the character cap', () => {
  const at = 1_700_000_000_000;
  const text = renderTranscript(
    [
      { senderName: '甲', text: '第一句', at: at - 30_000 },
      { senderName: '乙', text: '第二句', at: at - 5 * 60_000 },
    ],
    { at },
  );
  assert.match(text, /甲：第一句/);
  assert.match(text, /30 秒前/);
  assert.match(text, /5 分钟前/);

  const capped = renderTranscript(
    [
      { senderName: '甲', text: 'x'.repeat(80), at },
      { senderName: '乙', text: 'y'.repeat(80), at },
    ],
    { at, maxChars: 100 },
  );
  assert.equal(capped.split('\n').length, 1);
});

test('one look sends one message; a stray %% only cuts the reply short', () => {
  assert.deepEqual(splitReplies('一句话'), ['一句话']);
  // The default policy is a single bubble: anything after a separator is dropped.
  assert.deepEqual(splitReplies('第一\n%%\n第二'), ['第一']);
  assert.deepEqual(splitReplies('%%'), []);
  assert.deepEqual(splitReplies('', {}), []);
  // The cap is a parameter, so the same function can still split when asked to.
  assert.deepEqual(splitReplies('第一\n%%\n第二', { maxMessages: 2 }), ['第一', '第二']);
  assert.deepEqual(splitReplies('第一\n%%\n第二\n%%\n第三\n%%\n第四', { maxMessages: 2 }), ['第一', '第二']);
  assert.equal(REPLY_RULES.maxMessages, 1, 'the default is part of the contract');
});

test('a reply that restates itself is cut down to what it actually said', () => {
  const stuck = '那句是我说的。\n%%\n你自己翻回去看。那句是我说的。\n%%\n翻回去看就有。那句是我说的。';
  assert.deepEqual(splitReplies(stuck, { maxMessages: 3 }), ['那句是我说的。', '你自己翻回去看。', '翻回去看就有。']);
  // A part made entirely of already-said sentences disappears.
  assert.deepEqual(splitReplies('好。\n%%\n好。', { maxMessages: 3 }), ['好。']);
});

test('the group input is a scene line and the transcript, nothing else', () => {
  const peek = groupInput({ transcript: '甲：在吗', mode: 'peek', reason: 'flood', keyword: null, roomLabel: '群' });
  assert.equal(peek, '群聊「群」· 你也在群里\n\n甲：在吗');
  assert.doesNotMatch(peek, /%%/, 'no formatting rules to echo back');

  const answer = groupInput({ transcript: '甲：小雨', mode: 'answer', reason: 'keyword', keyword: '小雨', roomLabel: '群' });
  assert.equal(answer, '群聊「群」· 有人提到「小雨」\n\n甲：小雨');
  assert.doesNotMatch(answer, /不要复述|不要总结|回一句/, 'no instruction lines at all');
});
