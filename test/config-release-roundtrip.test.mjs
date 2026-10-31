import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {apply} from '../index.js';
import {createFakeHost} from './fake-harness.mjs';
import {createChannelManager} from '../lib/channels/manager.js';

async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-release-roundtrip-'));
  let app;
  const start=async()=>{
    const host=createFakeHost({reply:'%%'}),get=host.ctx.get;
    host.ctx.get=key=>key==='sessionController'?{async list(){return {items:[{sessionId:'fixture-source',title:'Fixture source'}]};},async *follow(){yield {type:'snapshot',cursor:-1};},async page(){return {records:[],hasMore:false};},async prompt(){return {accepted:true};}}:key==='remoteAccess'?{allows:()=>true}:get(key);
    app=apply(host.ctx,{port:0,dataDir:dir,exposeViaDshWeb:false});await app.ready;app.scheduler.stop();return app;
  };
  await start();
  t.after(async()=>{await app.stop();fs.rmSync(dir,{recursive:true,force:true});});
  return {get app(){return app;},restart:async()=>{await app.stop();return start();}};
}
async function managed(app) {
  const selection={mode:'managed',channelId:app.repo.channels.list()[0].id,privatePeerId:'111',groupPeerIds:['222']};
  const p=await app.onboarding.preview(selection);
  return app.onboarding.apply({...selection,previewToken:p.previewToken});
}
let managerSequence=0;
async function inbound(app) {
  const channel=app.repo.channels.list()[0];
  const manager=createChannelManager({repo:app.repo,settings:app.settings,runner:app.runner});
  let seq=0;const batch=++managerSequence;
  const send=async(kind,peerId,text)=>{
    const result=await manager.handleInbound(channel,{eventId:'fixture-'+batch+'-'+(++seq),channelId:channel.id,kind,accountId:'fixture-bot',senderId:peerId,senderName:'Fixture',peerId,text});
    if(result.runId)assert.equal((await app.runner.waitForRun(result.runId)).status,'succeeded');
    return result;
  };
  assert.equal((await send('qq_private','999','unselected peer')).matched,false);
  assert.equal((await send('qq_group','999','Yu unselected group')).matched,false);
  assert.equal((await send('qq_private','111','selected private')).matched,true);
  assert.equal((await send('qq_group','222','Yu selected group')).matched,true);
  await manager.stop();
}
test('release: configured export clear apply preserves selection policies and actually routes only chosen QQ peers',async t=>{
  const s=await fixture(t);await managed(s.app);
  s.app.memoryLibraries.update('personal',{retrieval:false,autoWrite:false});
  const context=s.app.repo.contexts.list()[0];
  s.app.repo.contexts.saveVersion(context.id,{config:{...context.config,databaseSearch:{...context.config.databaseSearch,libraryIds:[]}}});
  const doc=s.app.configFile.exportText();
  s.app.configFile.clear({confirm:true});
  const preview=s.app.configFile.preview({text:doc.text});assert.equal(preview.ok,true,JSON.stringify(preview.problems));
  s.app.configFile.apply({text:doc.text,confirm:true});
  assert.equal(s.app.onboarding.read().status,'ready');
  assert.deepEqual(s.app.repo.contexts.list()[0].config.databaseSearch.libraryIds,[]);
  assert.equal(s.app.memoryLibraries.list()[0].retrieval,false);
  assert.equal(s.app.memoryLibraries.list()[0].autoWrite,false);
  const ids=new Set(s.app.repo.channels.list().map(c=>c.id));
  assert.ok(s.app.repo.tasks.list().flatMap(t=>t.triggers).filter(t=>t.enabled&&t.spec.channelId).every(t=>ids.has(t.spec.channelId)));
  await inbound(s.app);
  await s.restart();
  assert.equal(s.app.onboarding.read().status,'ready');
  assert.equal(s.app.memoryLibraries.list()[0].autoWrite,false);
  await inbound(s.app);
});
test('release: fresh independent installation imports named bindings with different local channel identities',async t=>{
  const source=await fixture(t),destination=await fixture(t);await managed(source.app);
  const doc=source.app.configFile.exportText();
  assert.notEqual(source.app.repo.channels.list()[0].id,destination.app.repo.channels.list()[0].id);
  const preview=destination.app.configFile.preview({text:doc.text});assert.equal(preview.ok,true,JSON.stringify(preview.problems));
  destination.app.configFile.apply({text:doc.text,confirm:true});
  await inbound(destination.app);
});
test('release: an exported cleared instance is valid and preserves arbitrary project channelId data',async t=>{
  const s=await fixture(t);s.app.configFile.clear({confirm:true});
  const blank=s.app.configFile.exportText();
  assert.equal(s.app.configFile.preview({text:blank.text}).ok,true);
  assert.equal(s.app.configFile.apply({text:blank.text,confirm:true}).ok,true);
  const text=JSON.stringify({projects:[{id:'fixture-project',name:'Fixture',state:{channelId:'unrelated-business-value'}}]});
  assert.equal(s.app.configFile.preview({text}).ok,true);
  s.app.configFile.apply({text,confirm:true});
  assert.equal(s.app.repo.projects.get('fixture-project').state.channelId,'unrelated-business-value');
});
test('release: importing shared setup requires fresh history confirmation and does not reactivate linked work',async t=>{
  const source=await fixture(t),destination=await fixture(t);
  const selection={mode:'shared',channelId:source.app.repo.channels.list()[0].id,sessionId:'fixture-source',privatePeerId:'111',groupPeerIds:['222'],authorizeHistory:true};
  const p=await source.app.onboarding.preview(selection);
  await source.app.onboarding.apply({...selection,previewToken:p.previewToken});
  const doc=source.app.configFile.exportText();
  const preview=destination.app.configFile.preview({text:doc.text});assert.equal(preview.ok,true,JSON.stringify(preview.problems));
  destination.app.configFile.apply({text:doc.text,confirm:true});
  assert.equal(destination.app.onboarding.read().status,'needs-confirmation');
  assert.equal(destination.app.onboarding.read().selection.authorizeHistory,false);
  assert.ok(destination.app.repo.tasks.list().every(task=>!task.enabled));
  assert.ok(destination.app.dshLinks.getLinks().every(link=>!link.enabled&&link.needsRelink));
  await destination.restart();
  assert.equal(destination.app.onboarding.read().status,'needs-confirmation');
  assert.ok(destination.app.repo.tasks.list().every(task=>!task.enabled));
});
test('release: failure writing initialization rolls back configuration and library metadata together',async t=>{
  const s=await fixture(t);await managed(s.app);
  const doc=s.app.configFile.exportText().config;
  doc.settings['web.instanceLabel']='must-roll-back';doc.libraryPolicies={personal:{enabled:false,retrieval:false,autoWrite:false}};
  const before={label:s.app.settings.get('web.instanceLabel'),policies:s.app.db.getMeta('memory.libraries.policies'),setup:s.app.db.getMeta('onboarding.v1')};
  const original=s.app.db.setMeta;
  s.app.db.setMeta=function(key,value){if(key==='onboarding.v1')throw new Error('fixture initialization persistence failure');return original.call(this,key,value);};
  try{assert.throws(()=>s.app.configFile.apply({text:JSON.stringify(doc),confirm:true}),/fixture initialization persistence failure/);}finally{s.app.db.setMeta=original;}
  assert.equal(s.app.settings.get('web.instanceLabel'),before.label);
  assert.equal(s.app.db.getMeta('memory.libraries.policies'),before.policies);
  assert.equal(s.app.db.getMeta('onboarding.v1'),before.setup);
});
