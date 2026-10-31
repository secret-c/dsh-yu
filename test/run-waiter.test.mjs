import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost } from './fake-harness.mjs';
import { apply } from '../index.js';

/**
 * `waitForRun` must answer for a run that already finished.
 *
 * `/api/chat` enqueues a run and then awaits this waiter to emit `done` on the
 * SSE stream. If the run settles before the waiter is registered, a waiter that
 * only listens for the *next* transition is never resolved: the browser never
 * gets `done` and the request hangs until the client gives up. This pins the
 * "late waiter" case, which is what a fast turn produces.
 */

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-waiter-'));
  const host = createFakeHost();
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
  return { app, dataDir };
}

const withTimeout = (promise, ms = 800) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);

test('a waiter registered after the run finished still resolves', async (t) => {
  const { app, dataDir } = await boot();
  t.after(async () => {
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const conversation = app.repo.conversations.create({ title: '等待者测试', kind: 'web' });
  const run = app.repo.runs.create({
    taskId: null,
    triggerId: null,
    triggerReason: '测试',
    conversationId: conversation.id,
    inputText: '你好',
    meta: {},
  });
  // Terminal before anybody starts waiting — the exact race the fix covers.
  app.repo.runs.update(run.id, { status: 'succeeded', finishedAt: Date.now() });

  const resolved = await withTimeout(app.runner.waitForRun(run.id));
  assert.notEqual(resolved, 'timeout', 'waitForRun must not hang on an already-finished run');
  assert.equal(resolved.id, run.id);
  assert.equal(resolved.status, 'succeeded');
});
