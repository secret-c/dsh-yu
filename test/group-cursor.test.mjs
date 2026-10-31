import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost } from './fake-harness.mjs';
import { apply } from '../index.js';

/**
 * The group bridge is a stack, not a window.
 *
 * A look consumes the messages that arrived since the previous look; the ones
 * before it are already in the room's session history. Re-sending the same
 * window on every look made her repeat herself and paid for the same tokens
 * again, so the cursor is the contract this test pins down.
 */

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-cursor-'));
  const host = createFakeHost();
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
  return { app, host, dataDir, repo: app.repo };
}

const say = (repo, text, at, senderName = '甲') =>
  repo.groupBuffer.add({ channelId: 'ch1', peerId: 'g1', senderId: '1', senderName, text, at });

test('a look reads only what arrived after the previous look', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo } = state;

  say(repo, '第一句', 1_000);
  say(repo, '第二句', 2_000);
  // First look in a room has no history to stand on: it gets the tail.
  const first = repo.groupBuffer.window({ channelId: 'ch1', peerId: 'g1', limit: 30 });
  assert.deepEqual(
    first.map((message) => message.text),
    ['第一句', '第二句'],
  );
  repo.groupBuffer.setCursor('ch1', 'g1', { lastAt: first.at(-1).at, lastLookAt: 5_000 });

  say(repo, '第三句', 3_000);
  const next = repo.groupBuffer.windowAfter({ channelId: 'ch1', peerId: 'g1', sinceAt: repo.groupBuffer.cursor('ch1', 'g1').lastAt, limit: 30 });
  assert.deepEqual(
    next.map((message) => message.text),
    ['第三句'],
    'only the new line, not the two already in the session',
  );
});

test('when a look falls behind, it takes the newest lines and skips the backlog', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo } = state;

  for (let index = 1; index <= 6; index += 1) say(repo, `第${index}句`, index * 1_000);
  const capped = repo.groupBuffer.windowAfter({ channelId: 'ch1', peerId: 'g1', sinceAt: 0, limit: 3 });
  assert.deepEqual(
    capped.map((message) => message.text),
    ['第4句', '第5句', '第6句'],
    'the newest three, still oldest-first',
  );
});

test('the cursor only moves forward, so an out-of-order write cannot replay a room', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo } = state;

  say(repo, '甲', 1_000);
  say(repo, '乙', 2_000);
  repo.groupBuffer.setCursor('ch1', 'g1', { lastAt: 2_000, lastLookAt: 10_000 });
  repo.groupBuffer.setCursor('ch1', 'g1', { lastAt: 500, lastLookAt: 9_000 });

  const cursor = repo.groupBuffer.cursor('ch1', 'g1');
  assert.equal(cursor.lastAt, 2_000);
  assert.equal(cursor.lastLookAt, 10_000);
});

test('rooms keep separate cursors', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo } = state;

  repo.groupBuffer.add({ channelId: 'ch1', peerId: 'g1', senderId: '1', senderName: '甲', text: '一群', at: 1_000 });
  repo.groupBuffer.add({ channelId: 'ch1', peerId: 'g2', senderId: '2', senderName: '乙', text: '二群', at: 1_000 });
  repo.groupBuffer.setCursor('ch1', 'g1', { lastAt: 1_000, lastLookAt: 1_000 });
  assert.equal(repo.groupBuffer.cursor('ch1', 'g2'), null);
  assert.deepEqual(
    repo.groupBuffer.windowAfter({ channelId: 'ch1', peerId: 'g2', sinceAt: 0, limit: 10 }).map((m) => m.text),
    ['二群'],
  );
});
