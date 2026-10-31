import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { createFakeHost } from './fake-harness.mjs';
import { deadline } from '../lib/lifecycle.js';
import { createHttpService } from '../lib/http/server.js';

test('stop cancels queued runs, rejects new chat and shares its promise', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-lifecycle-'));
  const host = createFakeHost();
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
  const chat = await app.runner.chat({ text: 'queued' });
  const stopping = app.stop();
  assert.equal(app.stop(), stopping);
  await assert.rejects(app.runner.chat({ text: 'late' }), /stopped/);
  assert.equal((await chat.done).status, 'canceled');
  await stopping;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('both HTTP entrances drain handlers independently of response completion', async () => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  let route;
  const service = createHttpService({
    distRoot: '.', router: { handle: async () => false },
  });
  service.registerRoute('exact', '/work', async (_req, res) => {
    res.end('accepted'); entered(); await blocked;
  });
  service.exposeOnHarness({ get: () => ({ register: (r) => { route = r; return () => {}; } }) });
  const response = () => ({ headersSent: false, writeHead() {}, end() {} });
  const pending = route.handler({ url: '/yu/work' }, response());
  await started;
  service.stopAccepting();
  let drained = false;
  const drain = service.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  let status;
  await service.handleRequest({ url: '/work' }, { writeHead(code) { status = code; }, end() {} });
  assert.equal(status, 503);
  release(); await pending; await drain; await service.close();
});

test('deadline rejects without claiming cancellation or consuming late completion', async () => {
  let release;
  let committed = false;
  const pending = new Promise((resolve) => { release = resolve; }).then(() => { committed = true; });
  await assert.rejects(deadline(pending, 5, 'drain'), { code: 'STOP_TIMEOUT' });
  assert.equal(committed, false);
  release(); await pending;
  assert.equal(committed, true);
});

test('shutdown waits for an abort-ignoring accepted writer before closing the DB', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-writer-'));
  const app = apply(createFakeHost().ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  app.runner.setSystemHandlers({ maintenance: async () => { entered(); await blocked; return { status: 'noop' }; } });
  const task = app.repo.tasks.list().find((row) => row.kind === 'maintenance');
  const { run } = app.runner.enqueue(task);
  await started;
  const stopping = app.stop();
  await Promise.resolve();
  assert.equal(app.db.open, true);
  release(); await stopping;
  assert.equal(app.db.open, false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
