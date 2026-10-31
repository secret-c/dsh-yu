import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {apply} from '../index.js';
import {createFakeHost} from './fake-harness.mjs';
import {compileContext} from '../lib/context-compiler.js';
import {unifiedContextConfig,migrateContextPolicies} from '../lib/context-policy.js';
import {createNativeMemoryHook} from '../lib/native-memory-hook.js';

test('legacy selectors become bindings while explicit empty and inherited defaults stay distinct',()=>{
 const sections=[{id:'core',kind:'core',enabled:true,order:100},{id:'sec_a',kind:'custom',enabled:true,legacyMemorySlug:'a',order:500},{id:'sec_b',kind:'custom',enabled:true,legacyMemorySlug:'b',order:501}];
 assert.equal(unifiedContextConfig({},sections).injection,null);
 assert.deepEqual(unifiedContextConfig({injection:[],memory:{mode:'select',slugs:['a']},turnSections:['yu:core']},sections).injection,[]);
 assert.deepEqual(unifiedContextConfig({memory:{mode:'select',slugs:['a']},turnSections:['yu:core']},sections).injection,[{id:'core',order:100,scope:'turn'},{id:'sec_a',order:500}]);
 assert.deepEqual(unifiedContextConfig({memory:{mode:'none'}},sections).injection,[{id:'core',order:100}]);
});

test('fixed context instructions refresh independently of goals, retired project frames never return, migration preserves prose',async t=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-context-policy-')),host=createFakeHost();
 const app=apply(host.ctx,{port:0,dataDir,exposeViaDshWeb:false});await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
 t.after(async()=>{await app.stop();fs.rmSync(dataDir,{recursive:true,force:true});});
 const context=app.repo.contexts.create({name:'policy fixture',config:{injection:[],fixedInstructions:'FIXED_A',style:{mode:'custom',custom:'STYLE_TEXT'}}});
 const task=app.repo.tasks.create({name:'task',kind:'custom',goal:'GOAL_TEXT',contextId:context.id,conversationMode:'reuse'});
 const run=async()=>{const queued=app.runner.enqueue(app.repo.tasks.get(task.id));const result=await app.runner.waitForRun(queued.run.id);assert.equal(result.status,'succeeded');return host.calls.at(-1).system;};
 let system=await run();for(const text of ['FIXED_A','GOAL_TEXT','STYLE_TEXT'])assert.equal(system.split(text).length-1,1);
 app.repo.contexts.saveVersion(context.id,{config:{...context.config,fixedInstructions:'FIXED_B'}});
 system=await run();assert.match(system,/FIXED_B/);assert.doesNotMatch(system,/FIXED_A/);assert.equal(system.split('GOAL_TEXT').length-1,1);
 const compiled=compileContext({repo:app.repo,settings:app.settings,models:app.models,contextConfig:{injection:[],fixedInstructions:'CURRENT',projectProgress:{enabled:true,projectId:'missing'}},frozenSections:[{name:'yu:project',text:'OLD_PROJECT'},{name:'yu:task-rules',text:'OLD_FIXED'},{name:'yu:context-instructions',text:'OLD_CONTEXT'}]});
 assert.doesNotMatch(compiled.renderedSystem,/OLD_PROJECT|OLD_FIXED|OLD_CONTEXT/);assert.match(compiled.renderedSystem,/CURRENT/);assert.equal(compiled.project,null);
 const version=context.currentVersion;
 const old={...context.config,memory:{mode:'none'},projectProgress:{enabled:true,projectId:'reading-main'},turnSections:['yu:project']};
 app.db.run('UPDATE context_versions SET config=? WHERE context_id=? AND version=?',JSON.stringify(old),context.id,app.repo.contexts.get(context.id).currentVersion);
 assert.equal(migrateContextPolicies(app),1);const migrated=app.repo.contexts.get(context.id);assert.ok(migrated.currentVersion>version);assert.equal(migrated.config.fixedInstructions,'FIXED_A');assert.equal(migrated.config.style.custom,'STYLE_TEXT');assert.deepEqual(migrated.config.injection,[]);assert.equal(migrated.config.projectProgress.enabled,false);assert.equal(migrateContextPolicies(app),0);
});

test('native empty first profile notices added, changed and removed fixed instructions without rotating host history',async()=>{
 const handlers={};let instructions='';let requests=0;
 const link={id:'l',sessionId:'native',hostId:'local',enabled:true};
 const hook=createNativeMemoryHook({ctx:{get:()=>({context:()=>()=>{}}),on:(name,fn)=>{handlers[name]=fn;return()=>{};}},dshLinks:{hostId:'local',getLinks:()=>[link],assertMemoryAccess(){}},memoryService:{requireSync:async()=>({status:'noop'})},buildSections:()=>instructions?[{name:'yu:context-instructions',text:instructions,scope:'turn',channel:'system'}]:[]});
 const agent={id:'native',history:['host user history']};
 const request=async()=>{requests++;return handlers['system-prompt/assemble']({}, {agent},()=>({contexts:[{name:'host',text:'HOST_PROMPT'}]}));};
 assert.equal((await request()).contexts[1].text,'');instructions='A';assert.equal((await request()).contexts[1].text,'A');instructions='B';assert.equal((await request()).contexts[1].text,'B');instructions='';assert.equal((await request()).contexts[1].text,'');assert.deepEqual(agent.history,['host user history']);assert.equal(requests,4);hook.stop();
});
