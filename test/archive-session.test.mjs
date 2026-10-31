import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost } from './fake-harness.mjs';
import { apply } from '../index.js';

/**
 * Archiving is one action across two bookkeeping systems.
 *
 * Yu owns conversations; the harness owns physical sessions. Archiving only the
 * first leaves the second resumable — and once a session is archived in the
 * harness, every step on it is refused (`blocked`), which is the "reply never
 * came back" failure. These tests pin the bridge: the session id is dropped and
 * the conversation is skipped when a peer's next message is routed.
 */

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-archive-'));
  const host = createFakeHost();
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
  const base = app.httpService.url();
  const code = fs
    .readFileSync(path.join(dataDir, 'pairing-code.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^[A-Z]{4}-\d{4}$/.test(line));
  const state = { app, host, base, dataDir, cookie: null };
  await api(state, 'POST', '/api/pair', { code });
  return state;
}

async function api(state, method, url, body) {
  const response = await fetch(`${state.base}${url.replace(/^\//, '')}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: state.base.replace(/\/$/, ''),
      ...(state.cookie ? { cookie: state.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) state.cookie = setCookie.split(';')[0];
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('archiving drops the session id so the next message cannot resume it', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo } = state.app;

  const conversation = repo.conversations.create({ title: '私聊', kind: 'qq_private', channelId: 'ch1', peerId: 'p1' });
  repo.conversations.update(conversation.id, {
    sessionId: 'yu-conv-test-1',
    meta: { sessionDay: '2026-10-28', contextFrame: { sessionId: 'yu-conv-test-1', snapshotId: 'snap_x', at: 1 } },
  });

  const archived = await api(state, 'POST', `/api/conversations/${conversation.id}/archive`, {});
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  const after = repo.conversations.get(conversation.id);
  assert.equal(after.sessionId, null, 'the physical session reference is cleared');
  assert.equal(after.archivedAt !== null, true);
  assert.equal(after.meta.previousSessionId, 'yu-conv-test-1');
  assert.equal(after.meta.contextFrame, null, 'the frozen frame goes with it');
  assert.ok(state.host.archivedSessions.has('yu-conv-test-1'));
  assert.deepEqual(state.host.archiveCalls.at(-1), { sessionId: 'yu-conv-test-1', stopActivity: true });
  await assert.rejects(state.app.runner.chat({ conversationId: conversation.id, text: 'blocked until restored' }), /归档|重新选择/);
  const restored = await api(state, 'POST', `/api/conversations/${conversation.id}/restore`, {});
  assert.equal(restored.status, 200);
  const resumed = await state.app.runner.chat({ conversationId: conversation.id, text: 'continue after restore' });
  assert.equal((await resumed.done).status, 'succeeded');
  assert.notEqual(repo.conversations.get(conversation.id).sessionId, 'yu-conv-test-1');
  assert.ok(state.host.archivedSessions.has('yu-conv-test-1'), 'restoring Yu preserves the old physical archive');
});

test('archiving preserves pending material without a hidden model request', async (t) => {
  const state = await boot();
  // This archive integration explicitly opts into the optional nightly maintenance.
  await api(state, 'PATCH', '/api/memory/sync-config', { enabled:true, nightlyEnabled:true });
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo } = state.app;

  const conversation = repo.conversations.create({ title: '短回复对话', kind: 'qq_private', channelId: 'ch1', peerId: 'p2' });
  // Two messages that never produced an archive row (a short reply is below the
  // archive threshold, so this is the normal case, not an edge case).
  repo.messages.add({ conversationId: conversation.id, role: 'user', text: '今天去吃了拉面' });
  repo.messages.add({ conversationId: conversation.id, role: 'assistant', text: '记下了' });

  const archived = await api(state, 'POST', `/api/conversations/${conversation.id}/archive`, {});
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.tail.created, true, 'a tail archive was created');
  assert.equal(archived.body.tail.messages, 2);
  assert.equal(archived.body.absorb.queued, false, 'visible rules decide when to run');

  const archive = repo.archives.get(archived.body.tail.archiveId);
  assert.equal(archive.conversationId, conversation.id);
  assert.equal(archive.material.source, 'conversation-tail');
  assert.match(archive.material.input, /拉面/);
  assert.match(archive.material.reply, /记下了/);
});

test('archiving a conversation with nothing pending does not queue a pass for nothing', async (t) => {
  const state = await boot();
  // This archive integration explicitly opts into the optional nightly maintenance.
  await api(state, 'PATCH', '/api/memory/sync-config', { enabled:true, nightlyEnabled:true });
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo } = state.app;

  const conversation = repo.conversations.create({ title: '空对话', kind: 'web' });
  const archived = await api(state, 'POST', `/api/conversations/${conversation.id}/archive`, {});
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.tail.created, false);
  assert.equal(archived.body.absorb.queued, false);
  assert.match(String(archived.body.absorb.reason), /等待任务页/);
});

test('an archived conversation is not the route for a peer any more', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo } = state.app;

  const conversation = repo.conversations.create({ title: '群', kind: 'qq_group', channelId: 'ch1', peerId: 'g1' });
  assert.equal(repo.conversations.findRouted({ channelId: 'ch1', peerId: 'g1', kind: 'qq_group' }).id, conversation.id);

  repo.conversations.archive(conversation.id, 0);
  assert.equal(
    repo.conversations.findRouted({ channelId: 'ch1', peerId: 'g1', kind: 'qq_group' }),
    null,
    'a new message must open a new conversation',
  );
  assert.equal(
    repo.conversations.findRouted({ channelId: 'ch1', peerId: 'g1', kind: 'qq_group', includeArchived: true }).id,
    conversation.id,
    'the history is still reachable when asked for explicitly',
  );
});

test('PATCH archive hides a conversation while retaining its session and frame', async (t) => {
  const state = await boot();
  t.after(async () => { await state.app.stop(); fs.rmSync(state.dataDir, { recursive: true, force: true }); });
  const conversation = state.app.repo.conversations.create({ title: 'list archive', kind: 'web' });
  const frame = { sessionId: 'kept-session', snapshotId: 'kept-snapshot' };
  state.app.repo.conversations.update(conversation.id, { sessionId: 'kept-session', meta: { contextFrame: frame } });
  const hidden = await api(state, 'PATCH', '/api/conversations/' + conversation.id, { status: 'archived' });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.conversation.sessionId, 'kept-session');
  assert.deepEqual(hidden.body.conversation.meta.contextFrame, frame);
  const restored = await api(state, 'PATCH', '/api/conversations/' + conversation.id, { status: 'idle' });
  assert.equal(restored.body.conversation.sessionId, 'kept-session');
});

test('registry archive and unarchive preserve physical history', async (t) => {
  const state = await boot();
  t.after(async () => { await state.app.stop(); fs.rmSync(state.dataDir, { recursive: true, force: true }); });
  const first = await state.app.runner.chat({ text: 'preserve this physical history' });
  assert.equal((await first.done).status, 'succeeded');
  const conversation = state.app.repo.conversations.get(first.conversation.id);
  const before = state.host.sessions.get(conversation.sessionId)._events.slice();
  assert.deepEqual(await state.app.sessionArchive.archive(conversation.sessionId), { ok: true });
  assert.ok(state.app.sessionArchive.archivedIds().includes(conversation.sessionId));
  assert.deepEqual(state.host.sessions.get(conversation.sessionId)._events, before);
  assert.deepEqual(await state.app.sessionArchive.unarchive(conversation.sessionId), { ok: true });
  assert.ok(!state.app.sessionArchive.archivedIds().includes(conversation.sessionId));
  assert.deepEqual(state.host.sessions.get(conversation.sessionId)._events, before);
});
