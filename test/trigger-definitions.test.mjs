import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import {createFakeHost} from './fake-harness.mjs';
import {nextFireFor} from '../lib/scheduler.js';
import {normalizeTriggerInput} from '../lib/repo.js';
import {syncTriggerDefinitions} from '../lib/trigger-definitions.js';
import {buildConfig,planConfig} from '../lib/config-file.js';

test('Poisson exponential wait, cooldown, activity window and roll validation',()=>{
 const spec={kind:'random',cadence:'poisson',minutes:60,cooldownMinutes:1};
 const at=Date.UTC(2026,9,30,0);
 assert.equal(nextFireFor({type:'schedule',spec},{fromMs:at,random:()=>1-Math.exp(-1)}),at+3600000);
 assert.equal(nextFireFor({type:'schedule',spec},{fromMs:at,random:()=>0}),at+60000);
 const next=nextFireFor({type:'schedule',spec:{...spec,hours:[9,18]}},{fromMs:at,random:()=>0,timeZone:'Asia/Shanghai'});
 assert.equal(next,Date.UTC(2026,9,30,1));
 assert.throws(()=>normalizeTriggerInput({type:'schedule',spec:{kind:'roll',minutes:60,sides:6,target:7}}));
 assert.throws(()=>normalizeTriggerInput({type:'schedule',spec:{...spec,hours:[23,8]}}));
});

test('definition references sync all tasks, preserve per-task slots and flags, config roundtrip',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-def-'));const app=apply(createFakeHost().ctx,{port:0,dataDir:dir,exposeViaDshWeb:false});await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
 t.after(async()=>{await app.stop();fs.rmSync(dir,{recursive:true,force:true});});app.scheduler.stop();
 const {repo,settings}=app;
 settings.set('triggers.library',JSON.stringify([...JSON.parse(settings.get('triggers.library')), {id:'autonomy',label:'自主',type:'schedule',enabled:true,spec:{kind:'random',cadence:'poisson',minutes:180}}]));
 const a=repo.tasks.create({name:'a',kind:'custom'});const b=repo.tasks.create({name:'b',kind:'custom'});
 const make=task=>repo.triggers.create(task.id,{type:'schedule',spec:{kind:'random',cadence:'poisson',minutes:180,definitionId:'autonomy',localEnabled:true}});
 const ta=make(a),tb=make(b);app.scheduler.refreshAll();
 const first=repo.triggers.get(ta.id).nextFireAt;assert.ok(first);assert.ok(repo.triggers.get(tb.id).nextFireAt);
 app.scheduler.refreshAll();assert.equal(repo.triggers.get(ta.id).nextFireAt,first,'refresh/restart retains sampled slot');
 let library=JSON.parse(settings.get('triggers.library'));library.find(d=>d.id==='autonomy').spec.minutes=240;settings.set('triggers.library',JSON.stringify(library));app.scheduler.refreshAll();
 assert.equal(repo.triggers.get(ta.id).spec.minutes,240);assert.equal(repo.triggers.get(tb.id).spec.minutes,240);
 library.find(d=>d.id==='autonomy').enabled=false;settings.set('triggers.library',JSON.stringify(library));app.scheduler.refreshAll();assert.equal(repo.triggers.get(ta.id).enabled,false);
 library.find(d=>d.id==='autonomy').enabled=true;settings.set('triggers.library',JSON.stringify(library));app.scheduler.refreshAll();assert.equal(repo.triggers.get(ta.id).enabled,true);
 const doc=buildConfig({repo,settings});assert.equal(planConfig({repo,settings,config:doc}).problems.length,0);
 doc.settings['triggers.library']='[]';assert.equal(planConfig({repo,settings,config:doc}).problems.length,0,'merge empty library preserves existing definitions');
 doc.tasks.find(t=>t.name==='a').triggers[0].spec.definitionId='genuinely_missing';assert.ok(planConfig({repo,settings,config:doc}).problems.some(p=>p.includes('genuinely_missing')));
});

test('roll failure consumes one persisted slot and never retries on next tick',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-roll-'));const app=apply(createFakeHost().ctx,{port:0,dataDir:dir,exposeViaDshWeb:false});await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
 t.after(async()=>{await app.stop();fs.rmSync(dir,{recursive:true,force:true});});app.scheduler.stop();
 const task=app.repo.tasks.create({name:'roll',kind:'custom'});const trigger=app.repo.triggers.create(task.id,{type:'schedule',spec:{kind:'roll',cadence:'interval',minutes:60,sides:1000000,target:1}});
 app.repo.triggers.setSchedule(trigger.id,{nextFireAt:Date.now()-1});const original=Math.random;Math.random=()=>0.9;
 try{await app.scheduler.tick();const consumed=app.repo.triggers.get(trigger.id);assert.ok(consumed.nextFireAt>Date.now());assert.ok(consumed.lastFiredAt);assert.equal(app.repo.runs.countSince(trigger.id,0),0);await app.scheduler.tick();assert.equal(app.repo.triggers.get(trigger.id).nextFireAt,consumed.nextFireAt);}finally{Math.random=original;}
});

test('admin API independently creates and edits definitions, binds once, rejects in-use delete',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-def-api-'));const app=apply(createFakeHost().ctx,{port:0,dataDir:dir,exposeViaDshWeb:false});await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
 t.after(async()=>{await app.stop();fs.rmSync(dir,{recursive:true,force:true});});
 const base=app.httpService.url();const origin=base.replace(/\/$/,'');let cookie='';
 const request=async(method,url,body)=>{const r=await fetch(base+url,{method,headers:{origin,'content-type':'application/json',cookie},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};};
 const code=fs.readFileSync(path.join(dir,'pairing-code.txt'),'utf8').match(/[A-Z]{4}-[0-9]{4}/)[0];assert.equal((await request('POST','api/pair',{code})).status,200);
 const d=await request('POST','api/trigger-definitions',{label:'自主',type:'schedule',spec:{kind:'random',minutes:180}});assert.equal(d.status,200);
 const id=d.data.definition.id;const task=app.repo.tasks.create({name:'api-task',kind:'custom'});
 const created=await request('POST','api/tasks/'+task.id+'/triggers',{type:'schedule',label:'new legacy form',spec:{kind:'interval',minutes:25}});assert.equal(created.status,200);assert.ok(created.data.trigger.spec.definitionId);assert.ok(JSON.parse(app.settings.get('triggers.library')).some(d=>d.id===created.data.trigger.spec.definitionId));
 const old=app.repo.triggers.create(task.id,{type:'schedule',label:'old',spec:{kind:'interval',minutes:30}});
 assert.equal((await request('PATCH','api/triggers/'+old.id,{spec:{kind:'interval',minutes:40}})).status,409);assert.ok(app.repo.triggers.get(old.id).spec.definitionId);
 const bind=await request('POST','api/tasks/'+task.id+'/triggers',{definitionId:id});assert.equal(bind.status,200);const bindingId=bind.data.trigger.id;
 assert.equal((await request('POST','api/tasks/'+task.id+'/triggers',{definitionId:id})).status,409);
 assert.equal((await request('PATCH','api/trigger-definitions/'+id,{spec:{kind:'roll',cadence:'poisson',minutes:90,sides:20,target:5}})).status,200);
 assert.equal(app.repo.triggers.get(bindingId).spec.sides,20);
 assert.equal((await request('PATCH','api/triggers/'+bindingId,{spec:{kind:'daily',at:'12:00'}})).status,409);
 assert.equal((await request('DELETE','api/trigger-definitions/'+id)).status,409);
 assert.equal((await request('DELETE','api/triggers/'+bindingId)).status,200);
 assert.equal((await request('DELETE','api/trigger-definitions/'+id)).status,200);
});

test('legacy migration preserves schedule, credentials, flags and is idempotent',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-legacy-'));const app=apply(createFakeHost().ctx,{port:0,dataDir:dir,exposeViaDshWeb:false});await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
 t.after(async()=>{await app.stop();fs.rmSync(dir,{recursive:true,force:true});});app.scheduler.stop();
 const initialCount=JSON.parse(app.settings.get('triggers.library')).length;
 const task=app.repo.tasks.create({name:'legacy',kind:'custom'});
 const a=app.repo.triggers.create(task.id,{type:'schedule',label:'same',spec:{kind:'interval',minutes:120}});
 const b=app.repo.triggers.create(task.id,{type:'schedule',label:'same',enabled:false,spec:{kind:'interval',minutes:120}});
 const hook=app.repo.triggers.create(task.id,{type:'webhook',label:'hook',spec:{maxPerHour:5}});
 const token=hook.spec.token, slot=Date.now()+1234567;app.repo.triggers.setSchedule(a.id,{nextFireAt:slot,lastFiredAt:123});
 app.scheduler.refreshAll();const migrated=app.repo.triggers.get(a.id), disabled=app.repo.triggers.get(b.id), web=app.repo.triggers.get(hook.id);
 assert.equal(migrated.nextFireAt,slot);assert.equal(migrated.lastFiredAt,123);assert.equal(disabled.enabled,false);assert.equal(disabled.spec.localEnabled,false);assert.equal(web.spec.token,token);
 assert.notEqual(migrated.spec.definitionId,disabled.spec.definitionId);
 const library=JSON.parse(app.settings.get('triggers.library'));assert.equal(library.length,initialCount+3);assert.equal(library.find(x=>x.id===web.spec.definitionId).spec.token,undefined);
 app.scheduler.refreshAll();assert.equal(app.settings.get('triggers.library'),JSON.stringify(library));assert.equal(app.repo.triggers.get(a.id).nextFireAt,slot);
 app.repo.triggers.remove(a.id);app.scheduler.refreshAll();assert.equal(app.repo.triggers.get(a.id),null);assert.equal(JSON.parse(app.settings.get('triggers.library')).length,library.length);
});


test('missing definition disables binding and clears its scheduled slot',()=>{
 const binding={id:'bad',type:'schedule',enabled:true,spec:{definitionId:'missing',localEnabled:true},nextFireAt:100};
 const repo={triggers:{listAll:()=>[binding],update:(_id,patch)=>Object.assign(binding,patch),setSchedule:(_id,patch)=>Object.assign(binding,patch)}};
 syncTriggerDefinitions({repo,settings:{get:()=> '[]'}});assert.equal(binding.enabled,false);assert.equal(binding.nextFireAt,null);
});
