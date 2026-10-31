import {guestToolPolicy} from '../lib/runner.js';
import {sanitizeDiagnostic} from '../lib/diagnostic-redaction.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {apply} from '../index.js';
import {createFakeHost} from './fake-harness.mjs';
import {createAgentHost} from '../lib/agent-host.js';
import {resolveResourcePolicy} from '../lib/resource-policy.js';
import {createResourceDependencies} from '../lib/resource-dependencies.js';

test('guest scopes stay closed and diagnostic values are redacted without losing token counts',()=>{
 const policy=guestToolPolicy({mode:'all',packages:[],sources:[],resourceGrants:{packages:[],sources:[]}});
 assert.deepEqual(policy.packages,[]);assert.deepEqual(policy.resourceGrants.sources,[]);
 const value=sanitizeDiagnostic({tokens:42,totalTokens:120,arguments:{token:'super-secret',apiKey:'key-secret'},error:'Authorization: Bearer super-secret; password=word-secret',output:'super-secret key-secret'});
 assert.equal(value.tokens,42);assert.equal(value.totalTokens,120);
 assert(!JSON.stringify(value).includes('super-secret'));assert(!JSON.stringify(value).includes('key-secret'));assert(!JSON.stringify(value).includes('word-secret'));
});

test('resource inheritance distinguishes null, explicit empty and operation lists',()=>{
 const parent={packages:[{id:'a',operations:['package_a_calculate']}],sources:[]};
 assert.deepEqual(resolveResourcePolicy({packages:null},parent),parent);
 assert.deepEqual(resolveResourcePolicy({packages:[]},parent),{packages:[],sources:[]});
});

test('two scoped agents filter catalog and deny manually entered foreign instance or operation',async()=>{
 const host=createFakeHost(), original=host.ctx.get('agents').create, scoped=new Map();
 const global=new Map([
  ['yu_tool_packages',{name:'yu_tool_packages',execute:async()=>({packages:['a','b'].map(id=>({id,operations:[{name:`package_${id}_calculate`}]}))})}],
  ['yu_tool_call',{name:'yu_tool_call',execute:async()=>({value:42})}],
  ['yu_database_sources',{name:'yu_database_sources',execute:async()=>({sources:['a','b'].map(id=>({id,operations:[{name:`source_${id}_query`}]}))})}],
  ['yu_database_query',{name:'yu_database_query',execute:async()=>({rows:[{value:42}]})}],
  ['yu_document_read',{name:'yu_document_read',execute:async()=>({secret:true})}],
 ]);
 host.ctx.get('agents').create=async args=>{
  const setup=args.setup;
  args.setup=(ctx,agent)=>{
   const local=new Map(global), old=ctx.get;
   const tools={get:n=>local.get(n),register:d=>{const prior=local.get(d.name);local.set(d.name,d);return()=>local.set(d.name,prior);},schemas:()=>[...local.values()],restrict:f=>{scoped.get(agent.id).filter=f;return()=>{};}};
   scoped.set(agent.id,{tools});ctx.get=k=>k==='tools'?tools:old(k);return setup(ctx,agent);
  };return original(args);
 };
 const adapter=createAgentHost({ctx:host.ctx,settings:{get:()=>null}});
 for(const id of ['a','b']){
  await adapter.ensureAgent({sessionId:id,route:{},holder:{system:[],problems:[]},policy:{mode:'all',packages:[{id,operations:[`package_${id}_calculate`]}],sources:[{id,operations:[`source_${id}_query`]}]}});
  const tools=scoped.get(id).tools;
  assert.deepEqual((await tools.get('yu_tool_packages').execute({})).packages.map(p=>p.id),[id]);
  assert.deepEqual((await tools.get('yu_database_sources').execute({})).sources.map(p=>p.id),[id]);
  assert.equal((await tools.get('yu_tool_call').execute({packageId:id,operation:`package_${id}_calculate`})).value,42);
  await assert.rejects(tools.get('yu_tool_call').execute({packageId:id==='a'?'b':'a',operation:'package_b_calculate'}),{code:'RESOURCE_FORBIDDEN'});
  await assert.rejects(tools.get('yu_database_query').execute({sourceId:id,operation:'source_b_query_other'}),{code:'RESOURCE_FORBIDDEN'});
  assert(scoped.get(id).filter.deny.includes('yu_document_read'));
 }
 await adapter.disposeAll();
});

test('dependency protection, atomic replace/detach, import validation and historical snapshot',async(t)=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-resources-')),host=createFakeHost();
 const app=apply(host.ctx,{port:0,dataDir,exposeViaDshWeb:false});await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
 t.after(async()=>{await app.stop();fs.rmSync(dataDir,{recursive:true,force:true});});
 const manifest=id=>({id,name:id,adapter:'calculator',version:'1',config:{}});
 app.toolPackages.install(manifest('a'));app.toolPackages.install(manifest('b'));
 const grants=id=>[{id,operations:[`package_${id}_calculate`]}];
 const context=app.repo.contexts.create({name:'scoped',config:{tools:{packages:grants('a'),sources:[]}}});
 const task=app.repo.tasks.create({name:'bound',contextId:context.id,toolPolicy:{packages:grants('a'),sources:[]}});
 const graph=createResourceDependencies(app);
 const definitions=JSON.parse(app.settings.get('triggers.library')||'[]');
 app.settings.set('triggers.library',JSON.stringify([...definitions,{id:'rule_a',type:'schedule',label:'A',spec:{kind:'interval',minutes:5}},{id:'rule_b',type:'schedule',label:'B',spec:{kind:'interval',minutes:7}}]));
 const trigger=app.repo.triggers.create(task.id,{type:'schedule',label:'A',spec:{kind:'interval',minutes:5,definitionId:'rule_a'}});
 app.repo.triggers.setSchedule(trigger.id,{nextFireAt:Date.now()+60000,lastFiredAt:12345});
 assert.throws(()=>graph.change('trigger','rule_a'),{code:'RESOURCE_IN_USE'});
 graph.change('trigger','rule_a',{resolution:'replace',replacementId:'rule_b'});
 assert.equal(app.repo.triggers.get(trigger.id).spec.definitionId,'rule_b');
 assert.equal(app.repo.triggers.get(trigger.id).spec.minutes,7);
 assert.equal(app.repo.triggers.get(trigger.id).nextFireAt,null);assert.equal(app.repo.triggers.get(trigger.id).lastFiredAt,12345);
 const hooks=JSON.parse(app.settings.get('triggers.library'));
 app.settings.set('triggers.library',JSON.stringify([...hooks,{id:'hook_a',type:'webhook',label:'HA',spec:{}},{id:'hook_b',type:'webhook',label:'HB',spec:{}}]));
 const hook=app.repo.triggers.create(task.id,{type:'webhook',spec:{definitionId:'hook_a'}});
 graph.change('trigger','hook_a',{resolution:'replace',replacementId:'hook_b'});
 assert.equal(app.repo.triggers.get(hook.id).spec.token,hook.spec.token);
 assert.equal(app.repo.triggers.get(hook.id).id,hook.id);


 assert(graph.impact('packages','a').bindings.some(b=>b.relation==='global-inherited'));
 assert(graph.impact('packages','a').bindings.filter(b=>b.relation==='binding').length>=2);
 assert.throws(()=>graph.change('packages','a'),{code:'RESOURCE_IN_USE'});
 assert.throws(()=>graph.change('packages','a',{resolution:'replace',replacementId:'missing'}));
 assert.equal(app.repo.tasks.get(task.id).toolPolicy.packages[0].id,'a');
 const audit=app.repo.audit.log;
 app.repo.audit.log=(...args)=>{if(args[0]==='resource.change')throw new Error('transaction fault');return audit(...args);};
 assert.throws(()=>graph.change('packages','a',{resolution:'replace',replacementId:'b'}),/transaction fault/);
 app.repo.audit.log=audit;
 assert.equal(app.repo.tasks.get(task.id).toolPolicy.packages[0].id,'a');
 assert.equal((await app.toolPackages.execute({packageId:'a',operation:'package_a_calculate',arguments:{operator:'add',a:2,b:3}})).value,5);
 graph.change('packages','a',{resolution:'replace',replacementId:'b'});

 assert.deepEqual(app.repo.tasks.get(task.id).toolPolicy.packages,grants('b'));
 assert.deepEqual(app.repo.contexts.get(context.id).config.tools.packages,grants('b'));
 assert(!app.toolPackages.list().some(r=>r.id==='a'));
 const exported=JSON.parse(app.configFile.exportText().text);
 const invalid=structuredClone(exported);invalid.tasks.find(t=>t.name==='bound').toolPolicy.packages=grants('absent');
 assert.equal(app.configFile.preview({text:JSON.stringify(invalid)}).ok,false);
 assert.throws(()=>app.configFile.apply({text:JSON.stringify(invalid),confirm:true}));
 assert.deepEqual(app.repo.tasks.get(task.id).toolPolicy.packages,grants('b'));
 assert.throws(()=>app.repo.tasks.update(task.id,{toolPolicy:{packages:[{id:'b',operations:['package_b_missing']}]}}));
 const queued=app.runner.enqueue(app.repo.tasks.get(task.id),{input:'snapshot test'});
 const finished=await app.runner.waitForRun(queued.run.id);
 const snapshot=app.repo.contexts.snapshotById(app.repo.runs.get(queued.run.id).contextSnapshotId);
 assert(snapshot,'real runner must persist its authorization snapshot');
 assert.deepEqual(snapshot.resolved.toolPolicy.resourceGrants.packages,grants('b'));
 app.toolPackages.install(manifest('new_instance'));
 assert.deepEqual(app.repo.contexts.snapshotById(snapshot.id).resolved.toolPolicy.resourceGrants.packages,grants('b'));
 graph.change('packages','b',{action:'disable',resolution:'detach'});
 assert.deepEqual(app.repo.contexts.snapshotById(snapshot.id).resolved.toolPolicy.resourceGrants.packages,grants('b'));

 assert.deepEqual(app.repo.tasks.get(task.id).toolPolicy.packages,[]);
 assert.deepEqual(app.repo.contexts.get(context.id).config.tools.packages,[]);
});
