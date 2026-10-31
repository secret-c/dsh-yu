import test from 'node:test';
import assert from 'node:assert/strict';
import { planRetrievalDelivery, commitRetrievalDelivery, recentDialogueReplay } from '../lib/context-delivery.js';

const memory = (id, text) => ({ id, text, kind: 'fact', subject: '', source: 'fixture' });

test('retrieval delivery skips unchanged content, accepts new and changed content, and refreshes after eight turns', () => {
  const first = planRetrievalDelivery([memory('a', '旧事实')]);
  assert.deepEqual(first.selected.map(item => item.id), ['a']);
  const state = { sessionId: 'one', turn: 1, entries: { a: { hash: first.versions[0].hash, turn: 1 } } };
  const second = planRetrievalDelivery([memory('a', '旧事实'), memory('b', '新事实')], state);
  assert.deepEqual(second.selected.map(item => item.id), ['b']);
  assert.deepEqual(second.omittedIds, ['a']);
  assert.deepEqual(planRetrievalDelivery([memory('a', '修订事实')], state).selected.map(item => item.id), ['a']);
  assert.deepEqual(planRetrievalDelivery([memory('a', '旧事实')], { ...state, turn: 9 }).selected.map(item => item.id), ['a']);
});

test('delivery ledger merges latest metadata and resets across physical sessions', () => {
  const rows = new Map([['chat', { id: 'chat', meta: { peer: 'A', contextFrame: { sessionId: 'one' } } }]]);
  const repo = { conversations: { get: id => rows.get(id), update: (id, patch) => { const row = { ...rows.get(id), ...patch }; rows.set(id, row); return row; } } };
  const version = planRetrievalDelivery([memory('a', '事实')]).versions;
  commitRetrievalDelivery(repo, 'chat', 'one', 'owner', version);
  rows.get('chat').meta.note = 'concurrent edit';
  commitRetrievalDelivery(repo, 'chat', 'one', 'owner', []);
  assert.equal(rows.get('chat').meta.note, 'concurrent edit');
  assert.equal(rows.get('chat').meta.retrievalDelivery.turn, 2);
  commitRetrievalDelivery(repo, 'chat', 'two', 'owner', []);
  assert.deepEqual(rows.get('chat').meta.retrievalDelivery, { sessionId: 'two', authority: 'owner', turn: 1, entries: {} });
  commitRetrievalDelivery(repo, 'chat', 'two', 'guest', []);
  assert.deepEqual(rows.get('chat').meta.retrievalDelivery, { sessionId: 'two', authority: 'guest', turn: 1, entries: {} });
});

test('replay keeps ordered completed dialogue from only the same peer and authority', () => {
  const runs = new Map([
    ['old', { id: 'old', conversationId: 'chat', businessDone: true, meta: { peerId: 'A', channelId: 'qq', authority: 'owner', kind: 'qq_private' } }],
    ['other', { id: 'other', conversationId: 'chat', businessDone: true, meta: { peerId: 'B', channelId: 'qq', authority: 'guest', kind: 'qq_private' } }],
    ['failed', { id: 'failed', conversationId: 'chat', businessDone: false, meta: { peerId: 'A', channelId: 'qq', authority: 'owner', kind: 'qq_private' } }],
  ]);
  const messages = [
    { runId: 'old', role: 'user', text: '用户第一句', at: 1, meta: {} },
    { runId: 'old', role: 'assistant', text: '助手第一句', at: 2, meta: {} },
    { runId: 'other', role: 'user', text: '别的对象', at: 3, meta: {} },
    { runId: 'other', role: 'assistant', text: '别的答复', at: 4, meta: {} },
    { runId: 'failed', role: 'user', text: '失败输入', at: 5, meta: {} },
    { runId: 'current', role: 'user', text: '当前输入', at: 6, meta: {} },
  ];
  const repo = { messages: { list: () => messages }, runs: { get: id => runs.get(id) } };
  const replay = recentDialogueReplay(repo, 'chat', { id: 'current', meta: { peerId: 'A', channelId: 'qq', authority: 'owner', kind: 'qq_private' } });
  assert.equal(replay.turns, 1);
  assert.match(replay.text, /用户第一句[\s\S]*助手第一句/);
  assert.doesNotMatch(replay.text, /别的对象|失败输入|当前输入/);
});
