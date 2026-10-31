import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {apply} from '../index.js';import {createFakeHost} from './fake-harness.mjs';
async function boot(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-onboard-'));let bad=false;
 const events=[{seq:0,type:'user/message',data:{content:[{type:'text',text:'我一直喜欢安静的音乐'}]}}];
 const controller={async list(){return {items:[{sessionId:'source',title:'源会话'}]}},async *follow(){yield {type:'snapshot',cursor:events.length-1}},async page(){return {records:events.map(event=>({type:'event',event})),hasMore:false}},async prompt(){return {accepted:true}}};
 const host=createFakeHost({maintenanceReply:input=>bad?'':input.includes('## 当前阶段\n长期引用')?(input.includes('我一直喜欢安静的音乐')?'- [S1] 我一直喜欢安静的音乐':'无新增事实'):'喜欢安静的音乐'});
 const get=host.ctx.get;host.ctx.get=k=>k==='sessionController'?controller:k==='remoteAccess'?{allows:()=>true}:get(k);
 const app=apply(host.ctx,{port:0,dataDir:dir,exposeViaDshWeb:false});await app.ready;app.scheduler.stop();
 t.after(async()=>{await app.stop();fs.rmSync(dir,{recursive:true,force:true});});
 const channel=app.repo.channels.list()[0];
 const selection={mode:'shared',sessionId:'source',channelId:channel.id,privatePeerId:'111',groupPeerIds:['222','333'],authorizeHistory:true};
 const configure=async(s=selection)=>{const p=await app.onboarding.preview(s);return app.onboarding.apply({...s,previewToken:p.previewToken});};
 return {app,host,configure,selection,setBad:v=>bad=v};
}
test('shared: seven stable roles, full historical build, failure/retry gate, repeat and managed switch',async t=>{
 const s=await boot(t),{app}=s;assert.equal(app.repo.tasks.list().length,7);
 const custom=app.repo.tasks.create({name:'早安',goal:'我的自定义任务',enabled:false});
 const state=await s.configure();assert.equal(state.status,'pending');assert.notEqual(state.taskIds.morning,custom.id);
 assert.equal(app.repo.tasks.get(custom.id).goal,'我的自定义任务');
 assert.throws(()=>app.runner.enqueue(app.repo.tasks.get(state.taskIds.morning)),/首次/);
 s.setBad(true);app.onboarding.build();await app.onboarding.wait();assert.equal(app.onboarding.read().status,'failed');assert.deepEqual(app.repo.memory.syncCursor(),{});
 s.setBad(false);app.onboarding.build();await app.onboarding.wait();assert.equal(app.onboarding.read().status,'ready');assert.ok(app.repo.memories.list({search:'安静的音乐'}).length);
 const oldLink=app.dshLinks.getLinks()[0];const again=await s.configure();assert.equal(again.status,'ready');assert.equal(app.dshLinks.getLinks()[0].memoryGeneration,oldLink.memoryGeneration);
 const count=app.repo.triggers.listAll().length;await s.configure();assert.equal(app.repo.triggers.listAll().length,count);
 const changed=await s.configure({...s.selection,mode:'managed'});assert.equal(changed.status,'ready');assert.equal(app.dshLinks.getLinks()[0].enabled,false);
 for(const [role,id] of Object.entries(changed.taskIds)){const task=app.repo.tasks.get(id);assert.equal(task.executionTarget.mode,'yu');if(role!=='maintenance')assert.equal(task.archivePolicy.conversation,'on-success');}
});
test('managed: business session succeeds, memory maintained and archived; stale preview rejected',async t=>{
 const s=await boot(t),{app}=s;const selection={...s.selection,mode:'managed'};
 const p=await app.onboarding.preview(selection);app.repo.tasks.update(app.repo.tasks.list()[0].id,{description:'变化'});await assert.rejects(app.onboarding.apply({...selection,previewToken:p.previewToken}),/预览/);
 const state=await s.configure(selection);const task=app.repo.tasks.get(state.taskIds.morning);const {run}=app.runner.enqueue(task);const result=await app.runner.waitForRun(run.id);assert.equal(result.status,'succeeded');assert.ok(app.repo.conversations.get(result.conversationId).archivedAt);assert.equal(app.repo.conversations.get(result.conversationId).sessionId,null);assert.ok(s.host.calls.some(c=>c.sessionId.startsWith('yu-maint-')));
});
test('clear during build cannot publish, reactivate or restore old onboarding state',async t=>{
 const s=await boot(t),{app}=s;await s.configure();app.onboarding.build();app.repo.clearConfiguration();await app.onboarding.wait();assert.equal(app.onboarding.read().status,'unconfigured');assert.equal(app.repo.tasks.list().length,0);assert.equal(app.repo.memory.versions({limit:20}).filter(v=>v.source==='maintenance').length,0);
});
test('atomic rollback and concurrent confirmation leave one configuration and no lost existing native delivery',async t=>{
 const s=await boot(t),{app}=s;const original=app.repo.tasks.update;app.repo.tasks.update=()=>{throw new Error('forced configuration failure');};
 await assert.rejects(s.configure(),/forced/);app.repo.tasks.update=original;assert.equal(app.dshLinks.getLinks().length,0);assert.equal(app.onboarding.read().status,'unconfigured');
 const p=await app.onboarding.preview(s.selection);const results=await Promise.allSettled([app.onboarding.apply({...s.selection,previewToken:p.previewToken}),app.onboarding.apply({...s.selection,previewToken:p.previewToken})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(app.dshLinks.getLinks().length,1);
});
test('disabled personal growth fails initial build; explicit reconfiguration after clear restores only seven roles',async t=>{
 const s=await boot(t),{app}=s;await s.configure();app.memoryLibraries.update('personal',{autoWrite:false});app.onboarding.build();await app.onboarding.wait();assert.equal(app.onboarding.read().status,'failed');assert.match(app.onboarding.read().error,/个人长期记忆/);
 app.repo.clearConfiguration();assert.equal(app.repo.tasks.list().length,0);
 const ch=app.repo.channels.create({name:'用户重新选择的QQ',type:'onebot',enabled:false});await s.configure({...s.selection,mode:'managed',channelId:ch.id});assert.equal(app.repo.tasks.list().length,7);assert.equal(app.onboarding.read().status,'ready');
});
