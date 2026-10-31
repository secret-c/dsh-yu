import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createFakeHost} from './fake-harness.mjs';
import {apply} from '../index.js';
import {createToolPackages} from '../lib/tool-packages.js';
async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-inject-'));
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



import { readDefinitions } from '../lib/trigger-definitions.js';
import { normalizeTriggerInput } from '../lib/repo.js';
import {nextFireFor} from '../lib/scheduler.js';
test('four task templates create reusable definitions atomically and preserve existing state',async t=>{
 const s=await boot();t.after(async()=>{await s.app.stop();fs.rmSync(s.dataDir,{recursive:true});});s.app.scheduler.stop();
 const templates=(await api(s,'GET','/api/tasks')).body.templates;
 assert.deepEqual(templates.map(t=>t.id),['scheduled','chat-bridge','random-activity','group-response']);
 const channel=s.app.repo.channels.create({name:'Fixture',type:'napcat',enabled:false,config:{}});
 for(const template of templates){const triggers=structuredClone(template.triggers);if(triggers[0].type==='message')Object.assign(triggers[0].spec,{channelId:channel.id,peerId:'123456',replyMode:'record'});
 const r=await api(s,'POST','/api/tasks',{...template,templateId:template.id,name:'fixture-'+template.id,enabled:false,triggers});assert.equal(r.status,200,JSON.stringify(r.body));const task=s.app.repo.tasks.get(r.body.task.id);assert.equal(task.enabled,false);assert.ok(task.triggers[0].spec.definitionId);assert.equal(readDefinitions(s.app.settings).find(d=>d.id===task.triggers[0].spec.definitionId).type,triggers[0].type);}
 const legacy=[...readDefinitions(s.app.settings),{id:'legacy_string_days',type:'schedule',spec:{kind:'weekly',at:'20:00',days:['1','7']},enabled:false},{id:'legacy_empty_match',type:'message',spec:{match:'contains',value:''},enabled:false}];s.app.settings.set('triggers.library',JSON.stringify(legacy));assert.ok(readDefinitions(s.app.settings).some(d=>d.id==='legacy_empty_match'));
 assert.equal((await api(s,'POST','/api/trigger-definitions',{label:'invalid',type:'message',spec:{match:'contains',value:''}})).status,400);
 assert.equal((await api(s,'PATCH','/api/trigger-definitions/legacy_empty_match',{label:'legacy label'})).status,200);
 assert.equal((await api(s,'PATCH','/api/trigger-definitions/legacy_empty_match',{spec:{match:'contains',value:''}})).status,400);
 const count=s.app.repo.tasks.list().length;const definitions=s.app.settings.get('triggers.library');const original=s.app.repo.audit.log;
 s.app.repo.audit.log=(type,...args)=>{if(type==='task.create')throw new Error('transaction failure');return original(type,...args);};
 const failed=await api(s,'POST','/api/tasks',{name:'rollback',triggers:[{type:'schedule',spec:{kind:'daily',at:'19:00'}}]});s.app.repo.audit.log=original;
 assert.equal(failed.status,500);assert.equal(s.app.repo.tasks.list().length,count);assert.equal(s.app.settings.get('triggers.library'),definitions,'cache and rows roll back together');
 const invalid=await api(s,'POST','/api/tasks',{name:'bad',triggers:[{type:'schedule',spec:{kind:'daily',at:'19:00'}},{type:'schedule',spec:{kind:'daily',at:'bad'}}]});assert.equal(invalid.status,400);assert.equal(s.app.repo.tasks.list().length,count);assert.equal(s.app.settings.get('triggers.library'),definitions);
});
test('rule timezone and extension fields survive normalization and control scheduling',()=>{
 const rule=normalizeTriggerInput({type:'schedule',spec:{kind:'daily',at:'20:00',timezone:'UTC',future:{a:1}}});assert.deepEqual(rule.spec.future,{a:1});assert.equal(nextFireFor(rule,{fromMs:Date.parse('2026-10-31T12:00:00Z'),timeZone:'Asia/Shanghai'}),Date.parse('2026-10-31T20:00:00Z'));
 assert.doesNotThrow(()=>normalizeTriggerInput({type:'schedule',spec:{kind:'weekly',at:'20:00',days:['1','7']}}));assert.throws(()=>normalizeTriggerInput({type:'schedule',spec:{kind:'weekly',at:'20:00',days:[1,9]}}));assert.doesNotThrow(()=>normalizeTriggerInput({type:'message',spec:{match:'contains',value:''}}));
});
