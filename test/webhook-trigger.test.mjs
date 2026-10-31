import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost } from './fake-harness.mjs';
import { apply } from '../index.js';

/**
 * The generic trigger: an HTTP POST is the signal, the body is the text.
 *
 * The point of the type is that Yu does not need to know what produced the
 * signal — a shell script, a scheduled task on the host, another machine. The
 * token in the URL is the whole credential, so the route is public.
 */

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-hook-'));
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

/** `state.base` already ends with a slash. */
const hookUrl = (state, token) => `${state.base}api/hooks/${token}`;

const post = (state, token, text) =>
  fetch(hookUrl(state, token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });

test('a webhook trigger gets a token and fires the task with the body as input', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo } = state.app;

  const task = repo.tasks.create({ name: '构建通知', goal: '把收到的内容整理一句', kind: 'chat' });
  const created = await api(state, 'POST', `/api/tasks/${task.id}/triggers`, {
    type: 'webhook',
    spec: { maxPerHour: 5 },
    enabled: true,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const trigger = created.body.trigger;
  assert.match(trigger.spec.token, /^[A-Za-z0-9_-]{16,80}$/, 'the server generates the token');
  assert.match(created.body.description, /POST \/api\/hooks\//);

  // No cookie: the token is the credential.
  const fired = await post(state, trigger.spec.token, 'Windows 那边的构建过了');
  assert.equal(fired.status, 200);
  const payload = await fired.json();
  assert.match(payload.runId, /^run_/);

  const run = repo.runs.get(payload.runId);
  assert.equal(run.triggerId, trigger.id);
  assert.equal(run.inputText, 'Windows 那边的构建过了');
  assert.equal(run.triggerReason, '外部触发');
});

test('the global trigger list carries the owning task and the hook token', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo } = state.app;

  const task = repo.tasks.create({ name: '全局触发列表', goal: '一句话', kind: 'chat' });
  const created = await api(state, 'POST', `/api/tasks/${task.id}/triggers`, {
    type: 'webhook',
    label: '构建',
    spec: { maxPerHour: 3 },
  });
  const list = await api(state, 'GET', '/api/triggers');
  assert.equal(list.status, 200);
  const row = list.body.triggers.find((trigger) => trigger.id === created.body.trigger.id);
  assert.ok(row);
  assert.equal(row.taskName, '全局触发列表');
  assert.equal(row.taskEnabled, true);
  assert.match(row.description, /POST \/api\/hooks\//);
  assert.match(row.spec.token, /^[A-Za-z0-9_-]{16,80}$/);
  assert.equal(list.body.counts.webhook, 1);
});

test('a wrong token is a miss, a disabled task is refused, and the hourly cap holds', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo } = state.app;

  const task = repo.tasks.create({ name: '限额', goal: '一句话', kind: 'chat' });
  const created = await api(state, 'POST', `/api/tasks/${task.id}/triggers`, {
    type: 'webhook',
    spec: { maxPerHour: 1 },
  });
  const token = created.body.trigger.spec.token;

  const miss = await fetch(hookUrl(state, 'not-a-real-token-at-all'), { method: 'POST' });
  assert.equal(miss.status, 404);

  const first = await post(state, token, '第一次');
  assert.equal(first.status, 200);

  const second = await post(state, token, '第二次');
  assert.equal(second.status, 429, 'maxPerHour=1 blocks the second call in the same hour');

  repo.tasks.setEnabled(task.id, false);
  const third = await post(state, token, '停用后');
  assert.equal(third.status, 409);
});
