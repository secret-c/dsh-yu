import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {apply} from '../index.js';
import {createFakeHost} from './fake-harness.mjs';
async function boot(t,options){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-conversation-review-'));const host=createFakeHost(options);const app=apply(host.ctx,{port:0,dataDir,exposeViaDshWeb:false});await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});t.after(async()=>{await app.stop();fs.rmSync(dataDir,{recursive:true,force:true});});return {app,host};}
async function run(app,task,options={}){const {run}=app.runner.enqueue(task,options);return app.runner.waitForRun(run.id);}
test('legacy conversations continue following the configured daily rotation',async t=>{const {app}=await boot(t);app.settings.set('runtime.sessionRotation','daily');const first=await app.runner.chat({text:'first'});assert.equal((await first.done).status,'succeeded');const before=app.repo.conversations.get(first.conversation.id);app.repo.conversations.update(before.id,{meta:{...before.meta,sessionDay:'2000-01-01'}});const second=await app.runner.chat({conversationId:before.id,text:'second'});assert.equal((await second.done).status,'succeeded');assert.notEqual(app.repo.conversations.get(before.id).sessionId,before.sessionId);});
test('archived fixed target cannot silently accept another task run',async t=>{const {app}=await boot(t);const task=app.repo.tasks.create({name:'fixed',goal:'fixed-goal',kind:'custom',conversationMode:'reuse'});assert.equal((await run(app,task)).status,'succeeded');const bound=app.repo.tasks.get(task.id);app.repo.conversations.archive(bound.conversationId,0);assert.throws(()=>app.runner.enqueue(bound),/归档|重新选择/);});
test('task A, task B and chat sharing a session use only the current task goal',async t=>{const {app,host}=await boot(t);const a=app.repo.tasks.create({name:'a',goal:'ONLY_GOAL_A',kind:'custom',conversationMode:'reuse'});assert.equal((await run(app,a)).status,'succeeded');const target=app.repo.tasks.get(a.id).conversationId;const b=app.repo.tasks.create({name:'b',goal:'ONLY_GOAL_B',kind:'custom',conversationMode:'reuse',conversationId:target});assert.equal((await run(app,b)).status,'succeeded');assert.match(host.calls.at(-1).system,/ONLY_GOAL_B/);assert.doesNotMatch(host.calls.at(-1).system,/ONLY_GOAL_A/);const chat=await app.runner.chat({conversationId:target,text:'chat'});assert.equal((await chat.done).status,'succeeded');assert.doesNotMatch(host.calls.at(-1).system,/ONLY_GOAL_[AB]/);});
test('turn success archives a private temporary session but preserves all history',async t=>{const {app,host}=await boot(t);const archived=[];const original=host.ctx.get;host.ctx.get=key=>key==='workspaceRegistry'?{archiveSession:async id=>archived.push(id)}:original(key);const task=app.repo.tasks.create({name:'temp',kind:'custom',goal:'temporary',conversationMode:'new',archivePolicy:{conversation:'on-success'}});const result=await run(app,task);assert.equal(result.status,'succeeded');const conversation=app.repo.conversations.get(result.conversationId);assert.ok(conversation.archivedAt);assert.deepEqual(archived.filter(id=>!id.startsWith('yu-maint-')),[result.sessionId]);assert.equal(conversation.sessionId,null);assert.equal(conversation.meta.previousSessionId,result.sessionId);assert.ok(host.sessions.get(result.sessionId)._events.some(e=>e.type==='user/message'));assert.ok(app.repo.messages.list(conversation.id).length>0);app.repo.conversations.reopen(conversation.id);const restored=await app.runner.chat({conversationId:conversation.id,text:'restore archived temporary'});assert.equal((await restored.done).status,'succeeded');assert.notEqual(app.repo.conversations.get(conversation.id).sessionId,result.sessionId);assert.ok(host.sessions.get(result.sessionId)._events.some(e=>e.type==='user/message'));});

test('continuity honors opt-in, routed output cap, no-op, durable IDs and repeated failure cooldown',async t=>{
 const {app}=await boot(t);const slot=await app.agentHost.ensureAgent({sessionId:'review_continuity',route:{provider:'fake',model:'fake-model',maxTokens:3000},policy:{mode:'all'},holder:{system:[],problems:[]}});
 let calls=0;let pressure=30000;let outcome=null;
 const original=slot.ctxForAgent.get;slot.ctxForAgent.get=key=>key==='tokenMeter'?{measure:()=>({baseline:{kind:'estimated'},totalTokens:pressure})}:key==='compaction'?{compactNow:async()=>{calls++;if(outcome instanceof Error)throw outcome;return outcome;}}:original(key);
 const invoke=(config={},previous=null)=>app.agentHost.maintainContinuity('review_continuity',config,previous,AbortSignal.timeout(5000));
 assert.equal((await invoke()).status,'disabled');assert.equal(calls,0);
 pressure=1000;const below=await invoke({enabled:true});assert.equal(below.status,'below-threshold');assert.equal(below.thresholdTokens,25600);assert.equal(calls,0);
 pressure=30000;assert.equal((await invoke({enabled:true})).status,'no-span');
 outcome={compactionId:'cp',startSeq:3,summarySeq:4,endSeq:6};const compacted=await invoke({enabled:true});assert.equal(compacted.status,'compacted');assert.equal(compacted.compactionId,'cp');
 outcome=Object.assign(new Error('fail safely'),{code:'summary'});const failed=await invoke({enabled:true});assert.equal(failed.status,'failed');const count=calls;const cooldown=await invoke({enabled:true},failed);assert.equal(cooldown.status,'cooldown');assert.equal((await invoke({enabled:true},cooldown)).status,'cooldown');assert.equal(calls,count);
 slot.route.maxTokens=32000;assert.equal((await invoke({enabled:true})).status,'unavailable');assert.equal(calls,count);
 slot.route.maxTokens=10000;const reserved=await invoke({enabled:true});assert.equal(reserved.thresholdTokens,22000);
});

test('turning the active temporary task into a fixed binding keeps its session open',async t=>{
 let bind=()=>{};const {app}=await boot(t,{reply:()=>{bind();return 'ok';}});
 const task=app.repo.tasks.create({name:'temp to fixed',conversationMode:'new',archivePolicy:{conversation:'on-success'}});
 bind=()=>{const target=app.repo.conversations.list().find(c=>c.meta.ownerTaskId===task.id);app.repo.tasks.update(task.id,{conversationMode:'reuse',conversationId:target.id,archivePolicy:{conversation:'keep'}});};
 const finished=await run(app,task);assert.equal(finished.status,'succeeded');assert.equal(app.repo.conversations.get(finished.conversationId).archivedAt,null);assert.equal(app.repo.tasks.get(task.id).conversationId,finished.conversationId);
});

for(const failArchive of [false,true])test(`async archive closing guard rejects late bindings and releases after ${failArchive?'failure':'success'}`,async t=>{
 const {app,host}=await boot(t);let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const get=host.ctx.get;host.ctx.get=key=>key==='workspaceRegistry'?{archiveSession:async id=>{if(id.startsWith('yu-maint-'))return;entered();await gate;if(failArchive)throw Error('fixture registry failure');}}:get(key);
 const task=app.repo.tasks.create({name:'deferred temp',conversationMode:'new',archivePolicy:{conversation:'on-success'}});
 const other=app.repo.tasks.create({name:'existing task',conversationMode:'reuse'});
 const pending=app.runner.enqueue(task);await started;const target=pending.conversation.id;
 assert.throws(()=>app.repo.tasks.create({name:'late fixed',conversationMode:'reuse',conversationId:target}),/关闭|归档|closing/i);
 assert.throws(()=>app.repo.tasks.update(other.id,{conversationId:target}),/关闭|归档|closing/i);
 assert.throws(()=>app.repo.tasks.setConversationId(other.id,target),/关闭|归档|closing/i);
 await assert.rejects(app.runner.chat({conversationId:target,text:'late chat'}),/关闭|归档|closing/i);
 release();assert.equal((await app.runner.waitForRun(pending.run.id)).status,'succeeded');
 if(failArchive){assert.equal(app.repo.conversations.get(target).archivedAt,null);assert.equal(app.repo.tasks.update(other.id,{conversationId:target}).conversationId,target);}
 else{app.repo.conversations.reopen(target);assert.equal(app.repo.tasks.update(other.id,{conversationId:target}).conversationId,target);}
});
