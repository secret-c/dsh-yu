import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost } from './fake-harness.mjs';
import { apply as createApp } from '../index.js';

/**
 * The config document: export → edit → validate → apply, and apply twice
 * without duplicating tasks, bumping context versions or rotating webhook URLs.
 */

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-config-'));
  const host = createFakeHost();
  const app = createApp(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
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

test('the document exports the whole configuration without secrets', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  const exported = await api(state, 'GET', '/api/config');
  assert.equal(exported.status, 200);
  assert.match(exported.body.text, /"format": "yu-config"/);
  const doc = JSON.parse(exported.body.text);
  assert.equal(doc.format, 'yu-config');
  assert.equal(doc.version, 1);
  assert.ok(doc.settings['prompt.core'].length > 0);
  assert.equal(doc.settings['prompt.sections'], undefined, 'the registry lives in inject.sections');
  assert.equal(doc.settings['mail.password'], undefined);
  assert.equal(doc.secrets, undefined);
  assert.ok(doc.inject.sections.length >= 4);
  assert.ok(doc.tasks.length >= 1);
  assert.ok(doc.contexts.length >= 1);
  assert.ok(doc.memory.blocks.length >= 5);
  assert.equal(exported.body.secretsIncluded, false);
});

test('edit, validate and apply: settings, sections, blocks, tasks and triggers', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo, settings } = state.app;

  const task = repo.tasks.create({ name: '构建通知', goal: '整理一句', kind: 'chat' });
  repo.triggers.create(task.id, { type: 'webhook', label: '构建', spec: { maxPerHour: 5 }, enabled: true });
  const tokenBefore = repo.triggers.listForTask(task.id).find((trigger) => trigger.type === 'webhook').spec.token;

  const exported = await api(state, 'GET', '/api/config');
  const doc = JSON.parse(exported.body.text);
  doc.settings['web.instanceLabel'] = '迁移副本';
  doc.inject.sections[0].title = '根';
  doc.memory.blocks[0].content = '配置导入的正文';
  doc.tasks.push({
    name: '配置导入的任务',
    kind: 'chat',
    goal: '说一句话',
    conversationMode: 'reuse',
    context: '通用对话',
    triggers: [{ type: 'schedule', label: '每天 09:00', spec: { kind: 'daily', at: '09:00' }, enabled: true }],
  });
  const text = JSON.stringify(doc, null, 2);

  const preview = await api(state, 'POST', '/api/config/preview', { text });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body.problems));
  assert.equal(preview.body.summary.settings.length, 1);
  assert.equal(preview.body.summary.tasks.create.length, 1);
  assert.equal(preview.body.summary.sections.replace, undefined, 'the preview does not echo the body');

  const applied = await api(state, 'POST', '/api/config/apply', { text, confirm: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.settings, 1);
  assert.ok(applied.body.tasks >= 1);

  assert.equal(settings.get('web.instanceLabel'), '迁移副本');
  assert.equal(settings.get('prompt.sections').includes('"title":"根"'), true);
  assert.equal(repo.memory.blockBySlug('recent').content, '配置导入的正文');

  const imported = repo.tasks.list().find((item) => item.name === '配置导入的任务');
  assert.ok(imported, 'the new task exists');
  assert.equal(imported.triggers[0].spec.at, '09:00');
  assert.equal(imported.contextId, repo.contexts.list().find((context) => context.name === '通用对话').id);

  // The short-term block is mirrored to a text file: an import must not leave
  // the database and the disk disagreeing.
  const blockFile = path.join(state.dataDir, 'memory', 'short-term', 'recent.md');
  assert.equal(fs.existsSync(blockFile), true);
  assert.match(fs.readFileSync(blockFile, 'utf8'), /配置导入的正文/);

  // The export omitted the webhook token; applying must not rotate the URL.
  const tokenAfterFirst = repo.triggers.listForTask(task.id).find((trigger) => trigger.type === 'webhook').spec.token;
  assert.equal(tokenAfterFirst, tokenBefore);

  // Second apply is a merge, not a duplicate generator.
  const context = repo.contexts.list().find((item) => item.name === '通用对话');
  const versionsBefore = repo.contexts.versions(context.id).length;
  const taskCountBefore = repo.tasks.list().length;
  const second = await api(state, 'POST', '/api/config/apply', { text, confirm: true });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(repo.tasks.list().length, taskCountBefore, 'tasks are matched by name');
  assert.equal(second.body.tasks, 0, 'an unchanged task is not rewritten');
  assert.equal(second.body.triggers, 0, 'an unchanged trigger is not rewritten');
  assert.equal(second.body.blocks, 0, 'an unchanged block is not rewritten');
  assert.equal(repo.contexts.versions(context.id).length, versionsBefore, 'an unchanged context gets no new version');
  const tokenAfterSecond = repo.triggers.listForTask(task.id).find((trigger) => trigger.type === 'webhook').spec.token;
  assert.equal(tokenAfterSecond, tokenBefore);

  const file = path.join(state.dataDir, 'yu.config.json');
  assert.equal(fs.existsSync(file), true, 'apply writes the document into the data root');
});

test('secrets and webhook tokens only leave the instance when explicitly requested', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo, settings } = state.app;
  settings.set('mail.password', 'hunter2');
  settings.set('mail.host', 'smtp.example.com');
  const task = repo.tasks.create({ name: '带令牌的任务', goal: '', kind: 'chat' });
  const trigger = repo.triggers.create(task.id, { type: 'webhook', label: '脚本', spec: {} });

  const plain = JSON.parse((await api(state, 'GET', '/api/config')).body.text);
  assert.equal(plain.secrets, undefined);
  assert.equal(plain.settings['mail.password'], undefined);
  const plainTask = plain.tasks.find((item) => item.name === '带令牌的任务');
  assert.equal(plainTask.triggers[0].spec.token, undefined, 'a token is a credential');

  const withSecrets = await api(state, 'POST', '/api/config/export', { includeSecrets: true });
  const doc = JSON.parse(withSecrets.body.text);
  assert.equal(withSecrets.body.secretsIncluded, true);
  assert.equal(doc.secrets['mail.password'], 'hunter2');
  assert.equal(doc.tasks.find((item) => item.name === '带令牌的任务').triggers[0].spec.token, trigger.spec.token);
});

test('an invalid document is refused before writing anything', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const exported = await api(state, 'GET', '/api/config');
  const doc = JSON.parse(exported.body.text);
  doc.settings['runtime.maxParallelRuns'] = 999;
  const preview = await api(state, 'POST', '/api/config/preview', {
    text: JSON.stringify(doc),
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.ok, false);
  assert.match(preview.body.problems.join(' '), /maxParallelRuns/);
  const applied = await api(state, 'POST', '/api/config/apply', {
    text: JSON.stringify(doc),
    confirm: true,
  });
  assert.equal(applied.status, 400);
});

test('configuration covers channels and tools, clears credentials and preserves business assets', async (t) => {
  const state = await boot();
  t.after(async () => { await state.app.stop(); fs.rmSync(state.dataDir,{recursive:true,force:true}); });
  const {repo,settings} = state.app;
  const persona = settings.get('prompt.core');
  settings.set('prompt.core','custom reset me');
  repo.projects.upsert({id:'saved-book',name:'book',state:{progress:12}});
  const conv=repo.conversations.create({title:'preserve me'});
  repo.messages.add({conversationId:conv.id,role:'user',text:'business data'});
  const archive=repo.archives.create({conversationId:conv.id,material:{text:'archive data'}});
  const blocks = repo.memory.blocks();
  const channel = repo.channels.create({name:'config test',type:'web',config:{token:'private-token'},enabled:false});
  settings.set('mail.password','smtp-private');
  const doc = JSON.parse((await api(state,'GET','/api/config')).body.text);
  assert.equal(doc.channels.find(c=>c.name==='config test').config.token,undefined);
  doc.channels.find(c=>c.name==='config test').config.token = '';
  doc.secrets = {'mail.password':null};
  doc.tools.overlays = [{name:'yu_admin',enabled:false,description:null,example:null,config:{test:true}}];
  let result = await api(state,'POST','/api/config/apply',{text:JSON.stringify(doc),confirm:true});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(repo.channels.get(channel.id).config.token,'');
  assert.equal(settings.get('mail.password'),'');
  assert.equal(repo.tools.overlay('yu_admin').enabled,false);
  result = await api(state,'POST','/api/config/clear',{confirm:true});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(repo.channels.list().length,0);
  assert.equal(repo.tools.overlays().length,0);
  assert.equal(repo.tasks.list().length,0);
  assert.equal(repo.contexts.list().length,0);
  assert.equal(settings.get('prompt.core'),persona);
  assert.deepEqual(repo.memory.blocks(),blocks);
  assert.equal(repo.messages.count(conv.id),1);
  assert.ok(repo.archives.get(archive.id));
  assert.equal(repo.projects.list().length,0);
  const restored=await api(state,'POST','/api/config/apply',{text:JSON.stringify({projects:[{id:'saved-book',name:'restored'}]}),confirm:true});
  assert.equal(restored.status,200);
  assert.equal(repo.projects.get('saved-book').state.progress,12);
  assert.equal((await api(state,'GET','/api/config')).status,200,'device remains authenticated');
});

test('configuration rejects malformed, duplicate and unknown input before mutation', async (t) => {
 const state = await boot();
 t.after(async()=>{await state.app.stop();fs.rmSync(state.dataDir,{recursive:true,force:true});});
 for (const doc of [
  {settings:{'not.real':true}}, {unknown:true}, {tasks:[{name:'bad',triggers:{}}]},
  {memory:{blocks:[{slug:'Case'},{slug:'case'}]}},
  {tasks:[{name:'dup',triggers:[{type:'manual',label:'x'},{type:'manual',label:'x'}]}]},
 ]) {
  doc.settings = {...doc.settings,'web.instanceLabel':'should not commit'};
  const result = await api(state,'POST','/api/config/apply',{text:JSON.stringify(doc),confirm:true});
  assert.equal(result.status,400,JSON.stringify(result.body));
  assert.notEqual(state.app.settings.get('web.instanceLabel'),'should not commit');
 }
});

test('database failure rolls back entire config document and settings cache', async (t) => {
 const state=await boot();
 t.after(async()=>{await state.app.stop();fs.rmSync(state.dataDir,{recursive:true,force:true});});
 const before=state.app.settings.get('web.instanceLabel');
 const original=state.app.repo.tools.setOverlay;
 state.app.repo.tools.setOverlay=()=>{throw new Error('injected write failure');};
 const doc={settings:{'web.instanceLabel':'rollback'},channels:[{name:'rollback',type:'web'}],tools:{overlays:[{name:'yu_admin'}]}};
 const result=await api(state,'POST','/api/config/apply',{text:JSON.stringify(doc),confirm:true});
 state.app.repo.tools.setOverlay=original;
 assert.equal(result.status,500);
 assert.equal(state.app.settings.get('web.instanceLabel'),before);
 assert.equal(state.app.repo.channels.list().some(c=>c.name==='rollback'),false);
});

test('clear survives restart without recreating configuration and retains long memory', async (t) => {
 const state=await boot(); let next;
 t.after(async()=>{await next?.stop();await state.app.stop();fs.rmSync(state.dataDir,{recursive:true,force:true});});
 const memory=state.app.repo.memories.create({text:'retained long term business data'});
 await api(state,'POST','/api/config/clear',{confirm:true});
 await state.app.stop();
 next=createApp(createFakeHost().ctx,{port:0,dataDir:state.dataDir,exposeViaDshWeb:false}); await next.ready;
  for(const task of next.repo.tasks.list().filter(t=>t.kind==='maintenance')) next.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:next.repo.memory.blocks()[0]?.slug}});
 assert.equal(next.repo.tasks.list().length,0);assert.equal(next.repo.contexts.list().length,0);assert.equal(next.repo.projects.list().length,0);
 assert.ok(next.repo.memories.byId(memory.id));
});

test('committed configuration reports runtime sync failures without returning a false failure', async (t) => {
 const state=await boot();t.after(async()=>{await state.app.stop();fs.rmSync(state.dataDir,{recursive:true,force:true});});
 const {createConfigService}=await import('../lib/config-file.js');
 const fail=()=>{throw new Error('injected sync failure');};
 const service=createConfigService({repo:state.app.repo,settings:state.app.settings,paths:{dataDir:state.dataDir},syncChannels:fail,refreshSchedules:fail,syncMaintenance:fail,writeMemoryFiles:fail});
 const result=service.apply({text:JSON.stringify({settings:{'web.instanceLabel':'committed'}}),confirm:true});
 assert.equal(result.ok,true);assert.equal(result.warnings.length,4);assert.equal(state.app.settings.get('web.instanceLabel'),'committed');
 const cleared=service.clear({confirm:true});assert.equal(cleared.ok,true);assert.equal(cleared.warnings.length,2);
});

test('channel sync stops an adapter when stored credentials change', async (t) => {
 const state=await boot();t.after(async()=>{await state.app.stop();fs.rmSync(state.dataDir,{recursive:true,force:true});});
 const channel=state.app.repo.channels.create({name:'local credential test',type:'napcat',config:{transport:'reverse-ws',token:'old'},enabled:true});
 state.app.channelManager.sync();
 const first=state.app.channelManager.adapterFor(channel.id);assert.ok(first);
 state.app.repo.channels.update(channel.id,{config:{...channel.config,token:'new'}});
 state.app.channelManager.sync();assert.notEqual(state.app.channelManager.adapterFor(channel.id),first);
 state.app.configFile.clear({confirm:true});assert.equal(state.app.channelManager.adapterFor(channel.id),null);
});
