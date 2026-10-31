import {syncTriggerDefinitions} from '../lib/trigger-definitions.js';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openDatabase} from '../lib/db.js';import {createRepo} from '../lib/repo.js';import {createSettings} from '../lib/settings.js';import {ensureVisibleSync,readSyncConfig,updateSyncConfig,visibleSyncExecutor} from '../lib/memory-sync-policy.js';
test('unification only retires exact untouched default and preserves run history and custom tasks',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-unify-'));const db=openDatabase(path.join(dir,'db'));t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});const repo=createRepo(db),settings=createSettings(db),deps={db,repo,settings};
 const canonical=ensureVisibleSync(deps).task;
 const old=repo.tasks.create({name:'记忆维护',kind:'maintenance',goal:'',description:'每日在独立维护对话同步关联会话增量，更新短期记忆。',conversationMode:'new'});
 db.run('UPDATE tasks SET goal=? WHERE id=?','',old.id);
 const rule=repo.triggers.create(old.id,{type:'schedule',spec:{kind:'daily',at:'03:30'},misfirePolicy:'run-once'});db.run('UPDATE triggers SET created_at=? WHERE id=?',old.createdAt,rule.id);
 const history=repo.runs.create({taskId:old.id,status:'succeeded'});
 const custom=repo.tasks.create({...old,name:'记忆维护',goal:'用户自定义事实规则'});repo.triggers.create(custom.id,{type:'schedule',spec:{kind:'daily',at:'03:30'}});
 db.setMeta('memory.sync.unified.v3','');ensureVisibleSync(deps);ensureVisibleSync(deps);
 assert.ok(repo.tasks.get(old.id).deletedAt);assert.equal(repo.runs.get(history.id).taskId,old.id);assert.equal(repo.tasks.get(custom.id).deletedAt,null);assert.equal(readSyncConfig(deps).task.id,canonical.id);
});
test('task long-term policy persists and validates limits',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-policy-'));const file=path.join(dir,'db');let db=openDatabase(file);t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});let repo=createRepo(db);
 const task=repo.tasks.create({name:'维护',kind:'maintenance',memoryPolicy:{longTermEnabled:false,longTermMaxItems:3,longTermInstructions:'仅保存明确约定。'}});
 db.close();db=openDatabase(file);repo=createRepo(db);assert.deepEqual(repo.tasks.get(task.id).memoryPolicy,{longTermEnabled:false,longTermMaxItems:3,longTermInstructions:'仅保存明确约定。'});assert.throws(()=>repo.tasks.update(task.id,{memoryPolicy:{longTermMaxItems:13}}));
});
test('legacy prompt migrates once to default task goal without overwriting custom goal',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-prompt-'));const db=openDatabase(path.join(dir,'db'));t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});const repo=createRepo(db),settings=createSettings(db),deps={db,repo,settings};
 settings.set('memory.maintenancePrompt','只保留明确约定');const first=ensureVisibleSync(deps).task;assert.match(first.goal,/只保留明确约定/);ensureVisibleSync(deps);assert.equal(repo.tasks.get(first.id).goal,first.goal);
 repo.tasks.update(first.id,{goal:'用户自定义目标'});db.setMeta('memory.sync.prompt-task.v1','');ensureVisibleSync(deps);assert.equal(repo.tasks.get(first.id).goal,'用户自定义目标');assert.equal(settings.get('memory.maintenancePrompt'),'只保留明确约定');assert.ok(!settings.groupedPublic().memory.some(s=>s.key==='memory.maintenancePrompt'));assert.ok(!settings.groupedPublic().memory.find(s=>s.key==='memory.maintenanceStrategy').help.includes('关闭全部'));
});
test('visible rule configuration survives upgrades and controls execution and task history',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-visible-'));const db=openDatabase(path.join(dir,'db'));t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});const repo=createRepo(db),settings=createSettings(db);const deps={db,repo,settings};
 const config=ensureVisibleSync(deps);syncTriggerDefinitions(deps);let calls=0;const run=visibleSyncExecutor({...deps,serialize:fn=>fn(),execute:async()=>{calls++;return {status:'published'};}});
 assert.equal(config.firstSessionTrigger.enabled,false);
 assert.equal((await run({trigger:'new-session'})).status,'noop');assert.equal(calls,0);
 updateSyncConfig(deps,{firstSessionEnabled:true});ensureVisibleSync(deps);assert.equal(readSyncConfig(deps).firstSessionTrigger.enabled,true);
 await run({trigger:'new-session'});assert.equal(calls,1);assert.equal(readSyncConfig(deps).history[0].taskId,config.task.id);assert.equal(readSyncConfig(deps).history[0].triggerId,config.firstSessionTrigger.id);
 updateSyncConfig(deps,{firstSessionEnabled:false,nightlyEnabled:false,at:'04:17'});syncTriggerDefinitions(deps);ensureVisibleSync(deps);assert.equal(readSyncConfig(deps).firstSessionTrigger.enabled,false);assert.equal(readSyncConfig(deps).scheduleTrigger.spec.at,'04:17');assert.equal((await run({trigger:'new-session'})).status,'noop');assert.equal(calls,1);
 assert.equal((await run({trigger:'manual'})).status,'published');assert.equal((await run({trigger:'scheduled'})).status,'published');assert.equal(calls,3);
 updateSyncConfig(deps,{firstSessionEnabled:true});const broken=visibleSyncExecutor({...deps,serialize:fn=>fn(),execute:async()=>({status:'failed',error:'fixture failure'})});await broken({trigger:'new-session'});assert.equal(readSyncConfig(deps).history[0].status,'failed');assert.equal(readSyncConfig(deps).history[0].errorMessage,'fixture failure');
});
