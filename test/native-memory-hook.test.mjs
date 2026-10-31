import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeMemoryHook } from '../lib/native-memory-hook.js';

test('stop disposes a Cordis inject Fork and the assembly listener',()=>{
  let forkDisposed=0,listenerDisposed=0,contextDisposed=0;
  const ctx={get:()=>({context:()=>()=>{contextDisposed++;}}),on:()=>()=>{listenerDisposed++;},inject(_,callback){const cleanup=callback(this);return {dispose(){forkDisposed++;cleanup();}};}};
  const hook=createNativeMemoryHook({ctx,dshLinks:{getLinks:()=>[]},memoryService:{},buildSections(){}});
  hook.stop();assert.equal(forkDisposed,1);assert.equal(listenerDisposed,2);assert.equal(contextDisposed,1);
});

function fixture() {
  let listener, calls=0, builds=0, failure=false, allowed=true;
  const links=[];
  const hook=createNativeMemoryHook({ctx:{get:()=>({context:()=>()=>{}}),on(name,fn){if(name==='system-prompt/assemble')listener=fn;return()=>{};}},dshLinks:{hostId:'local',getLinks:()=>links,assertMemoryAccess(){if(!allowed)throw Error('denied');}},memoryService:{async requireSync(){calls++;return failure?{status:'failed',error:'blocked'}:{status:'published'};}},buildSections(){builds++;return [{name:'yu:native-memory',text:`snapshot-${builds}`}];}});
  const assemble=agent=>listener({sections:[{name:'host',text:'keep'}]}, {agent}, ()=>({sections:[{name:'host',text:'keep'}]}));
  return {links,hook,assemble,get calls(){return calls;},set failure(v){failure=v;},set allowed(v){allowed=v;}};
}
test('native assembly manages explicit local links only, freezes per agent/generation, retries failure',async()=>{
  const f=fixture(),agent={id:'native'};
  assert.equal((await f.assemble(agent)).sections.length,1);
  f.links.push({id:'link',sessionId:'native',hostId:'remote',enabled:true});
  await f.assemble(agent);assert.equal(f.calls,0);
  f.links[0].hostId='local';f.failure=true;
  await assert.rejects(f.assemble(agent),/blocked/);assert.equal(f.calls,1);
  f.failure=false;
  const [a,b]=await Promise.all([f.assemble(agent),f.assemble(agent)]);
  assert.equal(f.calls,2);assert.deepEqual(a,b);assert.equal(a.sections[0].text,'keep');
  assert.deepEqual(await f.assemble(agent),a);assert.equal(f.calls,2);
  f.links[0].memoryGeneration='new';assert.notDeepEqual(await f.assemble(agent),a);assert.equal(f.calls,3);
  await f.assemble({id:'native'});assert.equal(f.calls,4);
  f.allowed=false;await assert.rejects(f.assemble(agent),/denied/);
  f.links[0].sessionId='yu-maint-123';await f.assemble({id:'yu-maint-123'});assert.equal(f.calls,4);
});
test('Cordis next receives no arguments and an existing Yu snapshot is replaced once',async()=>{
  let listener;
  createNativeMemoryHook({ctx:{get:()=>({context:()=>()=>{}}),on(_,fn){listener=fn;}},dshLinks:{hostId:'local',getLinks:()=>[{id:'l',sessionId:'native',hostId:'local',enabled:true}],assertMemoryAccess(){}},memoryService:{requireSync:async()=>({status:'published'})},buildSections:()=>[{name:'yu:memory',text:'fresh'}]});
  const result=await listener({sections:[]},{agent:{id:'native'}},(...args)=>{assert.equal(args.length,0);return {sections:[{name:'host',text:'keep'}],contexts:[{name:'yu:native-memory',text:'old'}]};});
  assert.deepEqual(result.sections,[{name:'host',text:'keep'}]);assert.deepEqual(result.contexts,[{name:'yu:native-memory',text:'fresh',interpolate:false}]);
});
test('revoking a link during sync prevents its prompt from proceeding',async()=>{
  let listener,finish;
  const link={id:'link',sessionId:'native',hostId:'local',enabled:true};
  createNativeMemoryHook({ctx:{get:()=>({context:()=>()=>{}}),on(_,fn){listener=fn;}},dshLinks:{hostId:'local',getLinks:()=>[link],assertMemoryAccess(){}},memoryService:{requireSync:()=>new Promise(resolve=>{finish=resolve;})},buildSections:()=>[{name:'yu:memory',text:'fresh'}]});
  const pending=listener({sections:[]},{agent:{id:'native'}},()=>({sections:[]}));
  link.enabled=false;finish({status:'published'});
  await assert.rejects(pending,/关联已改变/);
});
test('empty selection is legal; native history remains user material and turn content refreshes',async()=>{
 const callbacks={};let revision=0;const link={id:'l',sessionId:'s',hostId:'local',enabled:true};
 const hook=createNativeMemoryHook({ctx:{get:()=>({context:()=>()=>{}}),on:(n,f)=>{callbacks[n]=f;return()=>{};}},dshLinks:{hostId:'local',getLinks:()=>[link],assertMemoryAccess(){}},memoryService:{requireSync:async()=>({status:'noop'})},buildSections:()=>revision===0?[]:[{name:'history',channel:'history',scope:'turn',text:'material-'+revision}]});
 const agent={id:'s'};let assembled=await callbacks['system-prompt/assemble']({}, {agent},()=>({}));assert.equal(assembled.contexts[0].text,'');
 revision=1;link.memoryGeneration='changed';assembled=await callbacks['system-prompt/assemble']({}, {agent},()=>({}));assert.equal(assembled.contexts[0].text,'');
 let step=await callbacks['agent/pre-step']({agent},()=>({kind:'enter',messages:[]}));assert.equal(step.messages[0].role,'user');assert.match(step.messages[0].content[0].text,/material-1/);
 revision=2;await callbacks['system-prompt/assemble']({}, {agent},()=>({}));step=await callbacks['agent/pre-step']({agent},()=>({kind:'enter',messages:[]}));assert.match(step.messages[0].content[0].text,/material-2/);hook.stop();
});
