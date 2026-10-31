import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { createFakeHost } from './fake-harness.mjs';

async function boot(t, options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-binding-'));
  const host = createFakeHost(options);
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
  t.after(async () => { await app.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { app, host };
}
async function run(app, task) {
  const result = app.runner.enqueue(task);
  return app.runner.waitForRun(result.run.id);
}

test('editing a binding during a run affects only the next run', async t => {
  let edit = () => {};
  const { app } = await boot(t, { reply: () => { edit(); return 'ok'; } });
  const a = app.repo.conversations.create({ title: 'a' });
  const b = app.repo.conversations.create({ title: 'b' });
  const task = app.repo.tasks.create({ name: 'bound', conversationMode: 'reuse', conversationId: a.id });
  edit = () => app.repo.tasks.update(task.id, { conversationId: b.id });
  const first = await run(app, task);
  assert.equal(first.status, 'succeeded');
  assert.equal(first.conversationId, a.id);
  assert.equal(app.repo.messages.list(b.id).length, 0);
  edit = () => {};
  const second = await run(app, app.repo.tasks.get(task.id));
  assert.equal(second.conversationId, b.id);
  assert.equal(app.repo.messages.list(a.id).length, 2);
});

test('temporary archive failure preserves session pointer and all messages', async t => {
  const { app, host } = await boot(t);
  const original = host.ctx.get;
  host.ctx.get = key => key === 'workspaceRegistry' ? { archiveSession: async id => { if(!id.startsWith('yu-maint-'))throw new Error('archive failure'); } } : original(key);
  const task = app.repo.tasks.create({ name: 'temp', conversationMode: 'new', archivePolicy: { conversation: 'on-success' } });
  const finished = await run(app, task);
  assert.equal(finished.status, 'succeeded');
  const conversation = app.repo.conversations.get(finished.conversationId);
  assert.equal(conversation.archivedAt, null);
  assert.equal(conversation.sessionId, finished.sessionId);
  assert.equal(app.repo.messages.list(conversation.id).length, 2);
  assert.ok(host.sessions.has(finished.sessionId));
});

test('a new task session bound by another task is kept open', async t => {
  let share = () => {};
  const { app } = await boot(t, { reply: () => { share(); return 'ok'; } });
  const task = app.repo.tasks.create({ name: 'temp', conversationMode: 'new', archivePolicy: { conversation: 'on-success' } });
  share = () => {
    const conversation = app.repo.conversations.list().find(c => c.meta.ownerTaskId === task.id);
    app.repo.tasks.create({ name: 'other', conversationMode: 'reuse', conversationId: conversation.id });
  };
  const finished = await run(app, task);
  assert.equal(finished.status, 'succeeded');
  assert.equal(app.repo.conversations.get(finished.conversationId).archivedAt, null);
});

test('binding and independent archive policy survive JSON and explicit clearing', async t => {
  const { app } = await boot(t);
  const conversation = app.repo.conversations.create({ title: 'existing' });
  const task = app.repo.tasks.create({ name: 'fixed', conversationMode: 'reuse', conversationId: conversation.id, archivePolicy: { mode: 'off', conversation: 'keep' } });
  const roundtrip = JSON.parse(JSON.stringify(task));
  assert.equal(app.repo.tasks.update(task.id, roundtrip).conversationId, conversation.id);
  const cleared = app.repo.tasks.update(task.id, { conversationId: null });
  assert.equal(cleared.conversationId, null);
  assert.equal(cleared.archivePolicy.mode, 'off');
  assert.equal(cleared.archivePolicy.conversation, 'keep');
  assert.throws(() => app.repo.tasks.update(task.id, { archivePolicy: { conversation: 'on-success' } }), /临时任务/);
  app.repo.tasks.update(task.id, { conversationId: conversation.id });
  const exported = app.configFile.exportText().config;
  const row = exported.tasks.find(item => item.name === task.name);
  assert.equal(row.conversationId, conversation.id);
  assert.equal(app.configFile.apply({ text: JSON.stringify(exported), confirm: true }).ok, true);
  assert.equal(app.repo.tasks.get(task.id).conversationId, conversation.id);
  delete row.conversationId;
  app.configFile.apply({ text: JSON.stringify(exported), confirm: true });
  assert.equal(app.repo.tasks.get(task.id).conversationId, conversation.id, 'legacy JSON omission preserves binding');
  row.conversationId = null;
  app.configFile.apply({ text: JSON.stringify(exported), confirm: true });
  assert.equal(app.repo.tasks.get(task.id).conversationId, null, 'explicit JSON null clears binding');
  const originalName = app.repo.tasks.get(task.id).name;
  exported.settings['runtime.maxParallelRuns'] = 7;
  row.conversationId = 'missing-conversation';
  assert.equal(app.configFile.preview({ text: JSON.stringify(exported) }).ok, false);
  assert.throws(() => app.configFile.apply({ text: JSON.stringify(exported), confirm: true }), /会话不存在或已归档/);
  assert.notEqual(app.settings.get('runtime.maxParallelRuns'), 7, 'invalid references must not partially apply settings');
  assert.equal(app.repo.tasks.get(task.id).name, originalName);
  app.repo.conversations.archive(conversation.id, 0);
  row.conversationId = conversation.id;
  assert.throws(() => app.configFile.apply({ text: JSON.stringify(exported), confirm: true }), /会话不存在或已归档/);
  assert.equal(app.repo.tasks.get(task.id).conversationId, null);
});

test('configuration clear keeps continuity checkpoint and conversation history', async t => {
  const { app } = await boot(t);
  const meta = { continuity: { enabled: true, thresholdRatio: 0.75 }, continuityState: { status: 'compacted', compactionId: 'checkpoint-source', summarySeq: 12 } };
  const conversation = app.repo.conversations.create({ title: 'long-lived', sessionId: 'persisted-session', meta });
  app.repo.messages.add({ conversationId: conversation.id, role: 'user', text: 'retained' });
  app.configFile.clear({ confirm: true });
  const preserved = app.repo.conversations.get(conversation.id);
  assert.equal(preserved.sessionId, 'persisted-session');
  assert.deepEqual(preserved.meta, meta);
  assert.equal(app.repo.messages.list(conversation.id)[0].text, 'retained');
});
