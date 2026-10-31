import test from 'node:test';
import {applyConfig,planConfig} from '../lib/config-file.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost,enableLegacyRules } from './fake-harness.mjs';
import { apply } from '../index.js';
import { normalizeSections, defaultSections, sectionName } from '../lib/sections.js';

/**
 * The injectable context is a registry now. These tests cover the contract the
 * page depends on: order, titles, custom bodies, turn scope, and that the
 * compiler actually renders what the registry says.
 */

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-inject-'));
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


test('file registry task overrides, empty selection, external edits, diagnostics and portable roundtrip', async t=>{
 const state=await boot();t.after(async()=>{await state.app.stop();fs.rmSync(state.dataDir,{recursive:true,force:true});});
 const registry=(await api(state,'GET','/api/inject')).body;
 assert.ok(registry.sections.filter(s=>s.kind!=='retrieved').every(s=>s.source?.path));
 const resource=registry.sections.find(s=>s.legacyMemorySlug==='recent');assert.ok(resource);
 const file=path.join(state.dataDir,resource.source.path);
 fs.writeFileSync(file,'EXTERNAL-FILE-TRUTH');
 const task=state.app.repo.tasks.create({name:'pick-files',kind:'chat',injection:[{id:resource.id,maxChars:8,template:'FILE={{content}}',scope:'turn'}]});
 assert.equal(state.app.repo.tasks.get(task.id).injection[0].id,resource.id);
 let preview=(await api(state,'POST','/api/inject/preview',{taskId:task.id,input:'hello'})).body.compiled;
 assert.equal(preview.injectionSelection.source,'task');
 assert.deepEqual(preview.injectionSelection.ids,[resource.id]);assert.match(preview.history.turn,/FILE=EXTERNAL/);assert.doesNotMatch(preview.renderedSystem,/角色卡/);
 state.app.repo.tasks.update(task.id,{injection:[]});
 preview=(await api(state,'POST','/api/inject/preview',{taskId:task.id,input:'hello'})).body.compiled;
 assert.deepEqual(preview.injectionSelection.ids,[]);assert.equal(preview.sections.filter(s=>s.sectionId).length,0);
 state.app.repo.tasks.update(task.id,{injection:[{id:resource.id}]});fs.unlinkSync(file);
 preview=(await api(state,'POST','/api/inject/preview',{taskId:task.id,input:'hello'})).body.compiled;
 assert.ok(preview.problems.some(p=>p.code==='INJECTION_FILE'));assert.doesNotMatch(preview.renderedInput,/EXTERNAL/);
 fs.writeFileSync(file,'RESTORED-SOURCE');
 const exported=state.app.configFile.exportText().config;assert.equal(exported.inject.contents[resource.id],'RESTORED-SOURCE');assert.deepEqual(exported.tasks.find(x=>x.name==='pick-files').injection,[{id:resource.id,order:0}]);
 const altered=registry.sections.find(s=>s.id==='rules');const target=path.join(state.dataDir,altered.source.path);fs.writeFileSync(target,'CONCURRENT-EDIT');
 const stale=await api(state,'POST','/api/inject/sections',{sections:registry.sections,fileTexts:{rules:'STALE'},fileHashes:{rules:altered.fileHash}});assert.equal(stale.status,409);assert.equal(fs.readFileSync(target,'utf8'),'CONCURRENT-EDIT');
});

test('config validates injection references and rolls files and database back together',async t=>{
 const state=await boot();t.after(async()=>{await state.app.stop();fs.rmSync(state.dataDir,{recursive:true,force:true});});
 const {repo,settings}=state.app;
 const original=state.app.configFile.exportText().config;
 const bad=structuredClone(original);bad.tasks.push({name:'invalid-binding',kind:'chat',injection:[{id:'sec_missing'}]});
 assert.ok(planConfig({repo,settings,config:bad}).problems.some(p=>p.includes('sec_missing')));
 const a={id:'sec_atomic_a',kind:'custom',title:'A',heading:'',order:10,channel:'system',scope:'turn',source:{path:'atomic/a.md',format:'utf8'}};
 const b={...a,id:'sec_atomic_b',source:{path:'blocked/b.md',format:'utf8'}};
 fs.mkdirSync(path.join(state.dataDir,'atomic'));fs.writeFileSync(path.join(state.dataDir,'atomic/a.md'),'BEFORE');fs.writeFileSync(path.join(state.dataDir,'blocked'),'PARENT-IS-FILE');
 const badFiles={...original,inject:{sections:[...original.inject.sections,a,b],contents:{...original.inject.contents,sec_atomic_a:'AFTER',sec_atomic_b:'FAIL'}},tasks:[...original.tasks,{name:'transaction-leak',kind:'chat'}]};
 assert.throws(()=>applyConfig({repo,settings,config:badFiles}));assert.equal(repo.tasks.list().some(t=>t.name==='transaction-leak'),false);assert.equal(fs.readFileSync(path.join(state.dataDir,'atomic/a.md'),'utf8'),'BEFORE');
 const replace={format:'yu-config',version:1,mode:'replace',inject:{sections:[]}};
 applyConfig({repo,settings,config:replace});assert.equal(repo.tasks.list().length,0);assert.deepEqual(JSON.parse(settings.get('prompt.sections')),[]);assert.equal(fs.readFileSync(path.join(state.dataDir,'atomic/a.md'),'utf8'),'BEFORE');
});

test('portable snapshot takes external files over stale memory rows across clean roots',async t=>{
 const a=await boot(),b=await boot();t.after(async()=>{await a.app.stop();await b.app.stop();for(const x of [a,b])fs.rmSync(x.dataDir,{recursive:true,force:true});});
 a.app.repo.memory.updateBlock('recent',{content:'OLDER-DB'});fs.writeFileSync(path.join(a.dataDir,'memory/short-term/recent.md'),'LATEST-FILE-ONLY');
 const exported=a.app.configFile.exportText();assert.equal(exported.config.memory.blocks.find(x=>x.slug==='recent').content,'LATEST-FILE-ONLY');
 const result=b.app.configFile.apply({text:exported.text,confirm:true});assert.deepEqual(result.warnings,[]);assert.equal(b.app.repo.memory.projectionState().pending,false);
 b.app.memoryFiles.sync();assert.equal(b.app.repo.memory.projectionState().pending,false);assert.equal(b.app.repo.memory.blockBySlug('recent').content,'LATEST-FILE-ONLY');
});
