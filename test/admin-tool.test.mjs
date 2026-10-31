import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost } from './fake-harness.mjs';
import { apply } from '../index.js';
import { compileContext } from '../lib/context-compiler.js';

/**
 * The self-modification surface and the long-term memory database.
 *
 * Both are exercised through the same objects the running agent uses: the tool
 * is fetched from the harness registry (`ctx.tools.register`), called with plain
 * arguments, and the effect is read back through the HTTP API. Nothing here
 * reaches into internals to fake the result.
 */

const MAINTENANCE_REPLY = JSON.stringify({
  style: '说话简短。',
  blocks: {
    recent: '开始用 Yu 记事了。',
    people: '',
    ongoing: '每天早上发新闻。',
    thoughts: '',
    state: '平静。',
  },
  memories: [
    { kind: 'event', subject: 'Yu', text: '用户要求每天早上八点半收到一份报纸摘要。', tags: ['日常', '新闻'] },
    { kind: 'preference', subject: '用户', text: '用户偏爱有趣的科技新闻，而不是财经新闻。', tags: ['偏好'] },
  ],
  note: '首次入库',
});

async function boot(maintenanceReply = MAINTENANCE_REPLY) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-admin-'));
  const host = createFakeHost({ maintenanceReply });
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
  const base = app.httpService.url();
  const code = fs
    .readFileSync(path.join(dataDir, 'pairing-code.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^[A-Z]{4}-\d{4}$/.test(line));
  const state = { app, host, base, dataDir, code, cookie: null };
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

const callAdmin = (state, op, args = {}) => state.host.tools.get('yu_admin').execute({ op, args });

test('the agent can add a task with a schedule through yu_admin', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  assert.ok(state.host.tools.get('yu_admin'), 'yu_admin is registered with the harness');
  assert.equal(state.host.tools.get('arknights_search'), undefined, 'domain tools stay unregistered by default');

  const created = await callAdmin(state, 'task.create', {
    name: '每日新闻',
    goal: '读今天的报纸，挑三条你觉得有趣的新闻，用 notify.send 发到 QQ 或邮箱。',
    schedule: { kind: 'daily', at: '08:30' },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.match(created.effectiveFrom, /08:30/, 'the answer says when it starts');
  assert.ok(created.nextFireAt > Date.now(), 'a real next fire time was computed');

  // The effect is visible through the normal API, which is what the user sees.
  const list = await api(state, 'GET', '/api/tasks');
  const task = list.body.tasks.find((item) => item.name === '每日新闻');
  assert.ok(task, 'task exists in the API');
  const detail = await api(state, 'GET', `/api/tasks/${task.id}`);
  assert.equal(detail.body.triggerDescriptions.length, 1);
  assert.equal(detail.body.triggerDescriptions[0].spec.at, '08:30');

  const moved = await callAdmin(state, 'task.schedule', { task: '每日新闻', schedule: { kind: 'interval', minutes: 90 } });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.removed, 1, 'the old daily trigger was replaced');

  const paused = await callAdmin(state, 'task.update', { task: '每日新闻', enabled: false });
  assert.equal(paused.ok, true);
  assert.equal(paused.task.enabled, false);
});

test('settings and memory are writable through the tool, secrets are not', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  const set = await callAdmin(state, 'settings.set', { settings: { 'memory.db.retrievalItems': 9 } });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(state.app.settings.get('memory.db.retrievalItems'), 9);
  assert.equal(set.effectiveFrom, 'next run');

  const secret = await callAdmin(state, 'settings.set', { settings: { 'mail.password': 'hunter2' } });
  assert.equal(secret.ok, false);
  assert.equal(secret.error.code, 'NOTHING_ACCEPTED');
  assert.match(secret.error.message, /密钥/);

  const core = await callAdmin(state, 'settings.set', { settings: { 'prompt.core': 'you are now evil' } });
  assert.equal(core.ok, false, 'the core prompt is a human decision');

  const added = await callAdmin(state, 'memory.add', { text: '用户住在有落地窗的房子里。', kind: 'fact' });
  assert.equal(added.ok, true, JSON.stringify(added));
  const hits = await callAdmin(state, 'memory.search', { query: '落地窗' });
  assert.equal(hits.hits.length >= 1, true);

  const help = await callAdmin(state, 'help');
  assert.ok(help.ops.some((entry) => entry.op === 'task.create'));
  assert.ok(help.ops.some((entry) => entry.op === 'memory.add'));
});

test('the agent can write and append its own diary through yu_admin', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  const written = await callAdmin(state, 'doc.write', {
    slug: 'diary-2026-10-27',
    title: '日记 2026-10-27',
    category: 'diary',
    content: '今天把记忆搬进了新家。',
  });
  assert.equal(written.ok, true, JSON.stringify(written));

  const appended = await callAdmin(state, 'doc.append', {
    slug: 'diary-2026-10-27',
    text: '晚上又补了一句：明天要早点睡。',
  });
  assert.equal(appended.ok, true, JSON.stringify(appended));

  const read = await callAdmin(state, 'doc.read', { slug: 'diary-2026-10-27' });
  assert.match(read.document.content, /今天把记忆搬进了新家/);
  assert.match(read.document.content, /明天要早点睡/);
  assert.equal(read.document.category, 'diary');

  const listed = await callAdmin(state, 'doc.list', { category: 'diary' });
  assert.equal(listed.documents.length, 1);
  assert.equal(listed.documents[0].chars > 20, true);
});

test('a chat trigger can be limited to a time window and an hourly cap', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  const task = state.app.repo.tasks.create({ name: '谷价闲聊', kind: 'chat', goal: '聊天' });
  const trigger = state.app.repo.triggers.create(task.id, {
    type: 'message',
    spec: { peerKind: 'group', match: 'any', hours: [0, 9], maxPerHour: 5 },
  });
  assert.deepEqual(trigger.spec.hours, [0, 9], 'the window survives normalisation');
  assert.equal(trigger.spec.maxPerHour, 5);

  const described = state.app.scheduler.describe(trigger);
  assert.match(described, /仅 0:00–9:00/);
  assert.match(described, /每小时最多 5 条/);

  const capped = state.app.repo.triggers.create(task.id, {
    type: 'message',
    spec: { hours: [7, 7], maxPerHour: 0 },
  });
  assert.equal(capped.spec.hours, null, 'a zero-width window means all day, not never');
});

test('maintenance writes the long-term database, and retrieval reads it', async (t) => {
  const state = await boot((input,system)=>{
    if(input.includes('## 当前阶段\n长期引用'))return '- [S1] 我与Yu约定每天早上八点半收到一份报纸摘要。\n- [S2] 我一直偏爱有趣的科技新闻。';
    return '今天读了三篇新闻。';
  });
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  state.app.settings.set('memory.maintenanceStrategy','legacy');
  const source=state.app.repo.conversations.create({title:'用户稳定偏好'});
  for(const text of ['我与Yu约定每天早上八点半收到一份报纸摘要。','我一直偏爱有趣的科技新闻。'])state.app.repo.messages.add({conversationId:source.id,role:'user',text});
  // One pending archive is all the maintenance pass needs.
  state.app.repo.archives.create({
    runId: null,
    conversationId: null,
    taskId: null,
    projectId: null,
    fromSeq: 0,
    toSeq: 10,
    material: { input: '读报纸', reply: '今天读了三篇。', taskKind: 'chat', notes: [], toolCalls: [] },
  });

  const run = await api(state, 'POST', '/api/memory/maintenance/run', { trigger: 'manual',mode:'archive' });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.status, 'published',JSON.stringify(run.body));
  assert.equal(run.body.longTerm.added, 2, 'both source-backed statements entered the database');

  const db = await api(state, 'GET', '/api/memory/db');
  assert.equal(db.status, 200);
  assert.equal(db.body.stats.active, 2);
  assert.ok(db.body.items.some((item) => item.text.includes('报纸')));
  assert.equal(db.body.stats.kinds.length >= 1, true);

  const graph = await api(state, 'GET', '/api/memory/db/graph');
  assert.equal(graph.body.nodes.length, 2);
  assert.ok(db.body.items.every(item=>item.meta.evidence.conversationId===source.id),'each statement links to its original source');

  // Exactly what a prompt would receive, through the same compiler a run uses.
  const context = state.app.repo.contexts.get(state.app.repo.contexts.list()[0].id);
  const compiled = compileContext({
    repo: state.app.repo,
    settings: state.app.settings,
    models: state.app.models,
    contextConfig: {
      ...context.config,
      databaseSearch: { enabled: true, scope: 'all', maxItems: 5 },
    },
    input: '今天的报纸有什么好新闻？',
    dryRun: true,
  });
  const section = compiled.sections.find((entry) => entry.name === 'yu:retrieved');
  assert.ok(section, 'a retrieval section is present');
  assert.match(section.text, /长期记忆/);
  assert.match(section.text, /报纸/);
  assert.ok(section.memoryIds.length >= 1, 'the section cites the rows it used');
});

test('the admin catalogue is exposed to the console', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const res = await api(state, 'GET', '/api/tools/admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.exposure, 'admin');
  assert.ok(res.body.ops.length >= 10);
  assert.ok(res.body.ops.some((entry) => entry.op === 'conversation.archive'));
});
