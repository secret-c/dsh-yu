import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost } from './fake-harness.mjs';
import { apply } from '../index.js';

/**
 * End-to-end smoke test against the mock harness.
 *
 * This exercises Yu's own logic only: context assembly, queueing, streaming,
 * archive, memory publication, scheduling maths, the alert state machine and the
 * API surface. Evidence produced here is labelled "mock" in the delivery report;
 * the real-model and real-DSH evidence is recorded separately.
 */

async function boot({ reply, maintenanceReply } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-test-'));
  const host = createFakeHost({ reply, maintenanceReply });
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
  const base = app.httpService.url();
  assert.ok(base, 'http listener should be up');
  const pairingFile = path.join(dataDir, 'pairing-code.txt');
  const code = fs.readFileSync(pairingFile, 'utf8').split('\n').map((l) => l.trim()).find((l) => /^[A-Z]{4}-\d{4}$/.test(l));
  return { app, host, base, dataDir, code };
}

async function api(state, method, url, body, extraHeaders = {}) {
  const response = await fetch(`${state.base}${url.replace(/^\//, '')}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: state.base.replace(/\/$/, ''),
      ...(state.cookie ? { cookie: state.cookie } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) state.cookie = setCookie.split(';')[0];
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

test('Yu boots, pairs, and serves the API', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
  });

  const health = await api(state, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const unauth = await api(state, 'GET', '/api/tasks');
  assert.equal(unauth.status, 401);

  const pair = await api(state, 'POST', '/api/pair', { code: state.code });
  assert.equal(pair.status, 200, JSON.stringify(pair.body));
  assert.ok(state.cookie, 'pairing should set the device cookie');

  const again = await api(state, 'POST', '/api/pair', { code: state.code });
  assert.equal(again.status, 409, 'the pairing code is single-use');

  const session = await api(state, 'GET', '/api/session');
  assert.equal(session.body.paired, true);

  const tasks = await api(state, 'GET', '/api/tasks');
  assert.equal(tasks.status, 200);
  assert.ok(tasks.body.tasks.length >= 4, 'seeded tasks are present');
  assert.equal(tasks.body.tasks.length,7,'frozen companion roles only');
  const morning=tasks.body.tasks.find(task=>task.name==='早安');
  assert.ok(morning);assert.equal(morning.enabled,false);
  assert.match(morning.triggerDescriptions[0].description,/08:00/);

  const memory = await api(state, 'GET', '/api/memory');
  assert.equal(memory.body.blocks.length, 5);
  assert.deepEqual(
    memory.body.blocks.map((b) => b.slug),
    ['recent', 'people', 'ongoing', 'thoughts', 'state'],
  );

  const contexts = await api(state, 'GET', '/api/contexts');
  assert.ok(contexts.body.contexts.length >= 2);
  const preview = await api(state, 'POST', `/api/contexts/${contexts.body.contexts[0].id}/preview`, {
    input: '测试输入',
  });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.compiled.sections.length > 0);
  assert.equal(preview.body.compiled.budget.estimate, true);
});

test('web chat streams a real turn and persists it', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
  });
  await api(state, 'POST', '/api/pair', { code: state.code });

  const response = await fetch(`${state.base}api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: state.cookie, origin: state.base.replace(/\/$/, '') },
    body: JSON.stringify({ text: '你好，Yu' }),
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.match(raw, /event: accepted/);
  assert.match(raw, /event: delta/);
  assert.match(raw, /event: done/);
  assert.match(raw, /已收到你的消息/);

  const conversations = await api(state, 'GET', '/api/conversations');
  assert.equal(conversations.body.conversations.filter(c=>!c.meta?.maintenance).length, 1);
  const conversationId = conversations.body.conversations.find(c=>!c.meta?.maintenance).id;
  const detail = await api(state, 'GET', `/api/conversations/${conversationId}`);
  const roles = detail.body.messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant']);
  assert.match(detail.body.messages[1].text, /已收到你的消息/);
  assert.ok(detail.body.snapshot, 'the run snapshot is recorded');
});

test('a task run archives its material and memory absorbs it once', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
  });
  await api(state, 'POST', '/api/pair', { code: state.code });
  // Batching is the default (one night-time pass absorbs the day); this test
  // covers the other mode on purpose.
  const enabled = await api(state, 'PATCH', '/api/settings', { settings: { 'memory.maintenanceStrategy':'legacy' } });
  assert.equal(enabled.status, 200);

  const created = await api(state, 'POST', '/api/tasks', {
    name: '测试任务',
    kind: 'chat',
    goal: '说一句问候',
    inputTemplate: '请说一句问候',
    conversationMode: 'reuse',
    archivePolicy: { mode: 'on-complete', minChars: 0, keepToolOutputs: true },
  });
  assert.equal(created.status, 200);
  const taskId = created.body.task.id;

  const runResponse = await api(state, 'POST', `/api/tasks/${taskId}/run`, {});
  assert.equal(runResponse.status, 200);
  const runId = runResponse.body.run.id;

  // Wait for the run to reach a terminal state.
  let run = null;
  for (let i = 0; i < 100; i++) {
    const detail = await api(state, 'GET', `/api/runs/${runId}`);
    run = detail.body.run;
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  assert.equal(run.businessDone, true);
  assert.equal(run.archiveDone, true);
  assert.ok(run.outputText.length > 0);

  // The materials really reached the model-facing assembly.
  const call = state.host.calls.find((c) => c.text.includes('请说一句问候'));
  assert.ok(call, 'the task agent received its prompt');
  assert.match(call.system, /你是小雨/, 'the persona core was injected');
  assert.match(call.system, /任务目标/, 'the task rules section was injected');

  const archives = state.app.repo.archives.list({ limit: 10 });
  assert.equal(archives.length, 1);
  assert.match(archives[0].material.reply, /已收到你的消息/);
  assert.ok(fs.existsSync(archives[0].path), 'the markdown projection exists');

  // Only an explicit visible maintenance action consumes the archived material.
  assert.ok(state.app.repo.archives.pending(10).length>0);
  const firstSync=await api(state,'POST','/api/memory/maintenance/run',{});
  assert.equal(firstSync.body.status,'published');
  const pendingBefore = await api(state, 'POST', '/api/memory/maintenance/preview', {});
  assert.equal(pendingBefore.body.pendingCount, 0, 'the run absorbed its own archive');

  const versions = await api(state, 'GET', '/api/memory/versions');
  assert.ok(versions.body.versions.length >= 1, 'a memory version was published');
  assert.equal(versions.body.versions[0].source, 'maintenance');

  const blocks = await api(state, 'GET', '/api/memory');
  const recent = blocks.body.blocks.find((b) => b.slug === 'recent');
  assert.equal(typeof recent.content,'string');
  assert.equal(state.app.repo.memory.syncMessages().length,0,'all source messages are durably consumed');
  const style = blocks.body.style;
  assert.equal(style?.content ?? '', '', 'sync preserves style');

  // A second maintenance call must not re-absorb the same archive.
  const second = await api(state, 'POST', '/api/memory/maintenance/run', {});
  assert.equal(second.body.status, 'noop');
  const archived = state.app.repo.archives.list({ limit: 10 });
  assert.equal(archived.length, 1);
  assert.ok(archived[0].absorbedAt !== null, 'the archive is marked absorbed');
  const log = await api(state, 'GET', '/api/memory/maintenance/log');
  assert.equal(log.body.log[0].status, 'noop');
  assert.ok(log.body.log.some((entry) => entry.status === 'published' && entry.absorbed === 1));
});

test('alert state machine de-duplicates and respects suppression', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
  });
  await api(state, 'POST', '/api/pair', { code: state.code });

  const sim = await api(state, 'POST', '/api/alerts/simulate', {});
  assert.equal(sim.status, 200);
  const actions = sim.body.actions;
  assert.ok(actions.length >= 1, 'a sustained failure produces an alert');
  const alertAction = actions.find((a) => a.action.kind === 'alert');
  assert.ok(alertAction, 'an alert action exists');
  assert.match(alertAction.action.reason, /账号离线/);
  // The repeated sample inside the cooldown window must not alert again.
  const repeated = actions.filter((a) => a.action.kind === 'alert' && a.category === 'offline');
  assert.equal(repeated.length, 1);
  // Manual disable must not alert.
  assert.equal(actions.some((a) => a.category === 'disabled' && a.action), false);
  // Recovery notice after the alert.
  assert.ok(actions.some((a) => a.action.kind === 'recovery'));

  const preview = await api(state, 'POST', '/api/alerts/preview', {});
  assert.equal(preview.status, 200);
  assert.match(preview.body.note, /没有发送邮件/);
});

test('context versioning is append-only and detects conflicts', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
  });
  await api(state, 'POST', '/api/pair', { code: state.code });

  const contexts = await api(state, 'GET', '/api/contexts');
  const contextId = contexts.body.contexts[0].id;
  const current = await api(state, 'GET', `/api/contexts/${contextId}`);

  const saved = await api(state, 'PATCH', `/api/contexts/${contextId}`, {
    config: { fixedInstructions: '新规则' },
    expectedVersion: current.body.context.currentVersion,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.context.currentVersion, current.body.context.currentVersion + 1);

  const conflict = await api(state, 'PATCH', `/api/contexts/${contextId}`, {
    config: { fixedInstructions: '并发修改' },
    expectedVersion: current.body.context.currentVersion,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'VERSION_CONFLICT');
});

test('backups can be created and listed', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
  });
  await api(state, 'POST', '/api/pair', { code: state.code });

  const created = await api(state, 'POST', '/api/backups', { label: 'test' });
  assert.equal(created.status, 200);
  assert.ok(created.body.backup.sha256);
  const list = await api(state, 'GET', '/api/backups');
  assert.equal(list.body.backups.length, 1);
  assert.equal(list.body.backups[0].manifest.schemaVersion, state.app.db.schemaVersion);
});
