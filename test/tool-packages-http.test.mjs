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

test('HTTP tool packages install multiple named adapters, call actual pipeline and reject old handles after unload/restart/clear',async(t)=>{
 const s=await boot();t.after(async()=>{await s.app.stop();fs.rmSync(s.dataDir,{recursive:true});});
 const tools=s.host.ctx.get('tools');
 assert(!tools.schemas().some(d=>['tomimi','yu_document_read','yu_document_search'].includes(d.name)));
 const manifest={id:'math_one',name:'First calculator',version:'1',adapter:'calculator',config:{}};
 assert.equal((await api(s,'POST','/api/tool-packages',{manifest})).status,200);
 assert.equal((await api(s,'POST','/api/tool-packages',{manifest:{...manifest,id:'math_two',name:'Second calculator'}})).status,200);
 assert.equal((await api(s,'POST','/api/tool-packages',{manifest:{...manifest,id:'docs',adapter:'documents'}})).status,200);
 const listing=await tools.execute({name:'yu_tool_packages',arguments:{}});assert.equal(listing.isError,false);assert(listing.value.packages.find(p=>p.id==='math_two').operations.some(o=>o.name==='package_math_two_calculate'));
 const call={packageId:'math_one',operation:'package_math_one_calculate',arguments:{operator:'multiply',a:6,b:7}};
 assert.equal((await tools.execute({name:'yu_tool_call',arguments:call})).value.value,42);
 assert.equal((await api(s,'POST','/api/tool-packages/call',call)).body.value,42);
 const old=s.app.toolPackages.handle(call.packageId,call.operation);
 assert.equal((await api(s,'PATCH','/api/tool-packages/math_one',{enabled:false})).status,200);
 await assert.rejects(()=>old(call.arguments));assert.equal((await tools.execute({name:'yu_tool_call',arguments:call})).isError,true);
 assert.equal((await api(s,'PATCH','/api/tool-packages/math_one',{enabled:true})).status,200);await assert.rejects(()=>old(call.arguments));
 const current=s.app.toolPackages.handle(call.packageId,call.operation);
 assert.equal((await api(s,'POST','/api/tool-packages',{manifest:{...manifest,id:'bad',adapter:'tomimi',config:{path:path.join(s.dataDir,'missing')}}})).status,400);
 assert.equal((await current(call.arguments)).value,42); // failed install leaves existing handles alive
 assert.equal((await api(s,'DELETE','/api/tool-packages/math_one')).status,200);await assert.rejects(()=>current(call.arguments));
 s.app.toolPackages.install(manifest);await assert.rejects(()=>current(call.arguments));s.app.toolPackages.uninstall('math_one');
 const exported=JSON.parse(s.app.configFile.exportText().text);assert(JSON.parse(exported.settings['tools.packages']).some(p=>p.id==='math_two'));
 const invalid=structuredClone(exported);invalid.settings['tools.packages']=JSON.stringify([{...manifest,config:{token:'secret'}}]);
 assert.equal(s.app.configFile.preview({text:JSON.stringify(invalid)}).ok,false);assert.throws(()=>s.app.configFile.apply({text:JSON.stringify(invalid),confirm:true}));
 await s.app.stop();s.host=createFakeHost();s.app=apply(s.host.ctx,{port:0,dataDir:s.dataDir,exposeViaDshWeb:false});await s.app.ready;
  for(const task of s.app.repo.tasks.list().filter(t=>t.kind==='maintenance')) s.app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:s.app.repo.memory.blocks()[0]?.slug}});
 assert(!s.app.toolPackages.list().some(p=>p.id==='math_one'));assert(s.app.toolPackages.list().some(p=>p.id==='math_two'&&p.active));
 s.app.configFile.clear({confirm:true});assert.deepEqual(s.app.toolPackages.list(),[]);
 await s.app.stop();s.host=createFakeHost();s.app=apply(s.host.ctx,{port:0,dataDir:s.dataDir,exposeViaDshWeb:false});await s.app.ready;
  for(const task of s.app.repo.tasks.list().filter(t=>t.kind==='maintenance')) s.app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:s.app.repo.memory.blocks()[0]?.slug}});assert.deepEqual(s.app.toolPackages.list(),[]);
});

test('legacy migration preserves disabled intent once and failed startup package does not block independent lifecycle',async()=>{
 const values={'tools.packages':'[]','tools.documentsEnabled':false,'tools.tomimiEnabled':true,'tools.exposure':'admin','tools.tomimiDataDir':'/nonexistent'};
 const settings={get:k=>values[k],set:(k,v)=>values[k]=v};const manager=createToolPackages({settings,repo:{},paths:{dataDir:'/nonexistent'}});let marked=false;
 manager.migrateLegacy({alreadyMigrated:false,markMigrated:()=>marked=true});assert(marked);assert(manager.list().every(p=>!p.enabled));
 manager.migrateLegacy({alreadyMigrated:true,markMigrated:()=>assert.fail()});assert.equal(manager.list().length,2);
 values['tools.packages']=JSON.stringify([{id:'broken',name:'Unavailable',version:'1',adapter:'tomimi',config:{path:'/nonexistent'},enabled:true}]);manager.start();assert(manager.list()[0].diagnostic);
 const math={id:'math',name:'Math',version:'1',adapter:'calculator',config:{}};manager.install(math);const old=manager.handle('math','package_math_calculate');
 manager.install({...math,id:'other'});assert.equal((await old({operator:'add',a:2,b:3})).value,5);
 manager.uninstall('broken');assert.equal((await old({operator:'add',a:2,b:3})).value,5);manager.dispose();await assert.rejects(()=>old({operator:'add',a:2,b:3}));
});

