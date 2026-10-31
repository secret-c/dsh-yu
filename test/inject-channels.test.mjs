import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost,enableLegacyRules } from './fake-harness.mjs';
import { apply } from '../index.js';
import { normalizeSections, wireOrder, SYSTEM_BAND } from '../lib/sections.js';

/**
 * Channel contract: `system` sections reach the system prompt under their own
 * name and order; `history` sections ride in the user turn instead. The old
 * eight-slot bucketing silently moved rules and custom sections to the end, so
 * these tests pin the two properties that failure violated: the registered
 * order equals the visible order, and a channel choice actually moves the text.
 */

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-channel-'));
  const host = createFakeHost();
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}}); enableLegacyRules(app);
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

async function chat(state, text, conversationId = null) {
  const response = await fetch(`${state.base}api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: state.base.replace(/\/$/, ''),
      ...(state.cookie ? { cookie: state.cookie } : {}),
    },
    body: JSON.stringify({ text, ...(conversationId ? { conversationId } : {}) }),
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const done = raw.split('\n\n').find((block) => block.startsWith('event: done'));
  assert.ok(done, 'the turn finished');
  const data = done.split('\n').find((line) => line.startsWith('data: '));
  const parsed = JSON.parse(data.slice(6));
  assert.equal(parsed.status, 'succeeded', JSON.stringify(parsed));
  return parsed;
}

test('legacy sections migrate to the new channels by kind', () => {
  const { sections, problems } = normalizeSections([
    { id: 'core', order: 100 },
    { id: 'rules', order: 110, scope: 'session' },
    { id: 'memory', order: 500, scope: 'session' },
    { id: 'retrieved', order: 700, scope: 'session' },
    { id: 'sec_extra01', title: '补一段', order: 200, body: '内容' },
  ]);
  assert.deepEqual(problems, []);
  assert.equal(sections.find((s) => s.id === 'core').channel, 'system');
  assert.equal(sections.find((s) => s.id === 'rules').channel, 'system');
  assert.equal(sections.find((s) => s.id === 'memory').channel, 'history');
  assert.equal(sections.find((s) => s.id === 'retrieved').channel, 'history');
  // A frozen retrieval searched with the session's first sentence for its whole
  // life; the migration fixes that by making it per-turn.
  assert.equal(sections.find((s) => s.id === 'retrieved').scope, 'turn');
  assert.equal(sections.find((s) => s.id === 'memory').scope, 'session');
  assert.equal(sections.find((s) => s.id === 'sec_extra01').channel, 'system');

  // An explicit channel is never overridden by the migration defaults.
  const explicit = normalizeSections([{ id: 'memory', order: 500, channel: 'system', scope: 'session' }]);
  assert.equal(explicit.sections[0].channel, 'system');
});

test('the visible order maps into the band DSH leaves for plugins', () => {
  assert.equal(wireOrder(0), SYSTEM_BAND.min);
  assert.equal(wireOrder(1000), SYSTEM_BAND.max);
  assert.ok(wireOrder(110) < wireOrder(500), 'later order stays later after the mapping');
  for (const reserved of [0, 500, 600, 800, 900, 1000]) {
    for (const order of [0, 100, 110, 500, 700, 1000]) {
      assert.notEqual(wireOrder(order), reserved, `order ${order} collides with reserved ${reserved}`);
    }
  }
});

test('a system section registers under its own name and visible order', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  const inject = await api(state, 'GET', '/api/inject');
  const sections = inject.body.sections.map((section) => ({
    id: section.id,
    title: section.title,
    heading: section.heading,
    order: section.order,
    enabled: section.enabled,
    channel: section.channel,
    scope: section.scope,
  }));
  await api(state, 'POST', '/api/inject/sections', { sections });

  await chat(state, '第一句');
  const sessionId = [...state.host.registeredSections.keys()].pop();
  const registered = state.host.registeredSections.get(sessionId) ?? [];
  const names = registered.map((section) => section.name);
  assert.deepEqual(names, ['yu:core', 'yu:rules'], 'only the system channel registers sections');

  const core = registered.find((section) => section.name === 'yu:core');
  const rules = registered.find((section) => section.name === 'yu:rules');
  assert.equal(core.order, wireOrder(100));
  assert.equal(rules.order, wireOrder(110));
  assert.ok(core.order < rules.order, 'the role card sits after the core, not at the end');
  assert.ok(rules.order < 500, 'every Yu section stays before the plan policy slot');
});

test('moving a section to the history channel takes it out of the system prompt', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  await api(state, 'PATCH', '/api/settings', { settings: { 'prompt.rules': '角色卡正文 RULES-MARK' } });
  const inject = await api(state, 'GET', '/api/inject');
  const sections = inject.body.sections.map((section) =>
    section.kind === 'rules'
      ? { ...section, channel: 'history', scope: 'session' }
      : { id: section.id, order: section.order, enabled: section.enabled, channel: section.channel, scope: section.scope },
  );
  const saved = await api(state, 'POST', '/api/inject/sections', { sections });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  await chat(state, '第一句');
  const call = state.host.calls.filter(call=>!call.sessionId.startsWith('yu-maint-'))[0];
  assert.doesNotMatch(call.system, /RULES-MARK/, 'the history channel never reaches the system prompt');
  assert.match(call.text, /RULES-MARK/, 'it rides in the user turn instead');
  assert.match(call.text, /背景材料/, 'history material is framed as material, not as the request');

  const sessionId = [...state.host.registeredSections.keys()].pop();
  assert.deepEqual((state.host.registeredSections.get(sessionId) ?? []).map((s) => s.name), ['yu:core']);
});

test('the transcript keeps what the person typed, not the injected materials', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  await api(state, 'PATCH', '/api/memory/blocks/recent', { content: '记忆标记 MEMORY-MARK' });
  const done = await chat(state, '我真正说的话');
  const messages = state.app.repo.messages.list(done.conversationId, { limit: 10 });
  const user = messages.find((message) => message.role === 'user');
  assert.equal(user.text, '我真正说的话', 'memory must not leak into the stored user message');
  assert.equal(user.meta.delivered?.sessionMaterials, 'delivered');
});

test('the preview names the same system blocks the run registers', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  const preview = await api(state, 'POST', '/api/inject/preview', { input: '预览用输入' });
  const blocks = preview.body.compiled.systemBlocks;
  assert.ok(blocks.length > 0);
  assert.deepEqual(blocks.map((block) => block.name), ['yu:core', 'yu:rules']);
  assert.equal(blocks[0].wireOrder, wireOrder(100));

  await chat(state, '第一句');
  const sessionId = [...state.host.registeredSections.keys()].pop();
  const registered = state.host.registeredSections.get(sessionId) ?? [];
  assert.deepEqual(
    registered.map((section) => `${section.name}@${section.order}`),
    blocks.map((block) => `${block.name}@${block.wireOrder}`),
    'preview order and registered order are the same list',
  );
});

test('the history channel does not re-deliver session material every turn', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  await api(state, 'PATCH', '/api/memory/blocks/recent', { content: '会话材料 ONCE-MARK' });
  const first = await chat(state, '第一句');
  await chat(state, '第二句', first.conversationId);

  const texts = state.host.calls.filter(call=>!call.sessionId.startsWith('yu-maint-')).map((call) => call.text);
  assert.match(texts[0], /ONCE-MARK/);
  assert.doesNotMatch(texts[1], /ONCE-MARK/, 'session material is delivered exactly once');
});

test('two contributions with one name merge instead of overwriting', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  // Both of these land in `yu:task-rules`: the task's goal and the context
  // profile's fixed instructions. Registration is keyed by name, so without a
  // merge one of them would silently disappear.
  const contexts = await api(state, 'GET', '/api/contexts');
  const context = contexts.body.contexts[0];
  await api(state, 'PATCH', `/api/contexts/${context.id}`, {
    config: { ...context.config, fixedInstructions: '固定说明 FIXED-MARK' },
  });

  const created = await api(state, 'POST', '/api/tasks', {
    name: '合并测试',
    kind: 'chat',
    goal: '目标 GOAL-MARK',
    inputTemplate: '请执行',
    conversationMode: 'reuse',
    contextId: context.id,
    archivePolicy: { mode: 'on-complete', minChars: 0, keepToolOutputs: true },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskId = created.body.task.id;
  const started = await api(state, 'POST', `/api/tasks/${taskId}/run`, {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const runId = started.body.run.id;

  let run = null;
  for (let i = 0; i < 100; i += 1) {
    const detail = await api(state, 'GET', `/api/runs/${runId}`);
    run = detail.body.run;
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(run.status, 'succeeded', JSON.stringify(run));

  const call = state.host.calls.filter(call=>!call.sessionId.startsWith('yu-maint-')).find((entry) => entry.text.includes('请执行'));
  assert.ok(call, 'the task agent received its prompt');
  assert.match(call.system, /GOAL-MARK/, 'the task goal is present');
  assert.match(call.system, /FIXED-MARK/, 'the profile fixed instructions are present too');
});
