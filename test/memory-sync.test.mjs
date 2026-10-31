import {ensureShortTermMapping} from '../lib/memory-sync.js';
import {ensureVisibleSync,updateSyncConfig} from '../lib/memory-sync-policy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/db.js';
import {createRepo} from '../lib/repo.js';
import {createSettings} from '../lib/settings.js';
import {createMemoryService} from '../lib/memory.js';
function setup(t, turn, archiveSession=null) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-sync-'));const db=openDatabase(path.join(dir,'yu.db'));const repo=createRepo(db),settings=createSettings(db);
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 repo.memory.createBlock({slug:'short',name:'短期',content:'旧事实'});
 settings.set('prompt.core','核心原文');repo.memories.create({kind:'fact',text:'长期原文'});
 ensureVisibleSync({db,repo,settings});updateSyncConfig({db,repo,settings},{firstSessionEnabled:true});
 const archived=[];let active=0,maxActive=0;const inputs=[];
 const host={disposeSession:async()=>{},runTurn:async opts=>{inputs.push(opts);active++;maxActive=Math.max(maxActive,active);try{return await turn(opts,repo);}finally{active--;}}};
 const ctx={get:key=>key==='workspaceRegistry'?{archiveSession:archiveSession??(async id=>archived.push(id))}:null};
 const service=createMemoryService({ctx,repo,settings,agentHost:host,models:{effectiveSelection:()=>({ready:true})},archiveService:{},paths:null});
 return {db,repo,settings,service,inputs,archived,maxActive:()=>maxActive};
}
const complete=(text='更新事实',extra={})=>({assistantText:text,modelFinishReason:'stop',turnEnd:{kind:'completed'},...extra});
const phaseReply=opts=>complete(opts.input.includes('## 当前阶段\n长期引用')?'无新增事实':'更新事实');
test('published memory survives an active-session archive error and later cleanup failure',async t=>{
 let fail=true;const s=setup(t,phaseReply,async()=>{if(fail)throw Error('the session is active (subagent)');});source(s);
 const first=await s.service.requireSync({trigger:'new-session'});
 assert.equal(first.status,'published');assert.equal(first.warnings[0].stage,'archive');
 const version=s.repo.memory.revision();assert.equal(s.repo.memory.pendingSyncConversations().length,1);
 const second=await s.service.requireSync({trigger:'new-session'});
 assert.equal(second.status,'noop');assert.equal(second.warnings[0].stage,'prior-cleanup');assert.equal(s.repo.memory.revision(),version);
 source(s,'下一条新的用户材料');
 const third=await s.service.requireSync({trigger:'new-session'});
 assert.equal(third.status,'published');assert.equal(third.warnings[0].stage,'prior-cleanup');assert.notEqual(s.repo.memory.revision(),version);
 const afterThird=s.repo.memory.revision();
 assert.deepEqual(s.repo.memory.syncMessages(),[]);
 const fourth=await s.service.requireSync({trigger:'manual',memoryPolicy:{longTermEnabled:false}});assert.equal(fourth.status,'noop',JSON.stringify(fourth));assert.equal(s.repo.memory.revision(),afterThird);
 fail=false;await s.service.requireSync({trigger:'manual'});assert.equal(s.repo.memory.pendingSyncConversations().length,0);
});
test('disabled personal library is excluded from maintenance input while short-term sync remains usable',async t=>{
 const s=setup(t,async opts=>{assert.doesNotMatch(opts.input,/长期原文/);return complete('短期继续同步');});
 s.repo.memoryLibraries={personalEnabled:()=>false,canAutoWrite:()=>false};source(s);
 const result=await s.service.requireSync({trigger:'new-session'});assert.equal(result.status,'published');assert.equal(s.inputs.length,1);assert.equal(s.repo.memory.blockBySlug('short').content,'短期继续同步');
});
test('policy changes during model work preserve memory and both cursors at commit',async t=>{
 for(const flag of ['enabled','autoWrite']){
  let enabled=true,autoWrite=true;
  const s=setup(t,async opts=>{if(opts.input.includes('## 当前阶段\n长期引用')){if(flag==='enabled')enabled=false;else autoWrite=false;return complete('- [S1] 我长期喜欢清淡的饮食');}return complete('不应发布');});
  s.repo.memoryLibraries={personalEnabled:()=>enabled,canAutoWrite:()=>enabled&&autoWrite};source(s);
  const before=s.repo.memory.revision();const result=await s.service.requireSync({trigger:'scheduled'});assert.equal(result.status,'failed');assert.equal(s.repo.memory.revision(),before);assert.deepEqual(s.repo.memory.syncCursor(),{});assert.deepEqual(s.repo.memory.longCursor(),{});
 }
});
function source(s,text='我长期喜欢清淡的饮食'){const c=s.repo.conversations.create({title:'来源'});s.repo.messages.add({conversationId:c.id,role:'user',text});return c;}
test('new-session saves plain body, one request, goal is sole system instruction and sources remain for long growth',async t=>{
 const s=setup(t,async opts=>{assert.equal(opts.holder.system[0].text,s.repo.tasks.list().find(t=>t.kind==='maintenance').goal);assert.doesNotMatch(opts.input,/当前核心记忆|核心原文/);return complete('完整的短期正文（不要求任何闭括号）');});const c=source(s);
 const result=await s.service.requireSync({trigger:'new-session'});assert.equal(result.status,'published');assert.equal(s.inputs.length,1);assert.equal(s.repo.memory.blockBySlug('short').content,'完整的短期正文（不要求任何闭括号）');assert.equal(s.repo.memory.syncMessages().length,0);assert.equal(s.repo.memory.longMessages().length,1);assert.equal(s.repo.messages.list(c.id)[0].text,'我长期喜欢清淡的饮食');assert.equal(s.archived.length,1);
});
test('failed old structure, empty, limit, timeout, unknown finish and model errors preserve both ledgers',async t=>{
 for(const summary of [complete('{"note":"old","style":"","blocks":{"short":"old"}}'),complete('{"style":"","blocks":{"a":"完整值","b":"完整值"}'),complete(''),complete('正文',{modelFinishReason:'length'}),complete('正文',{timedOut:true}),complete('正文',{modelFinishReason:null}),complete('正文',{errors:[{}]}),complete('代码',{turnEnd:{kind:'error'}})]){
  const s=setup(t,async()=>summary);source(s);const before=s.repo.memory.revision();assert.equal((await s.service.requireSync({trigger:'scheduled'})).status,'failed');assert.equal(s.repo.memory.revision(),before);assert.equal(s.repo.memory.blockBySlug('short').content,'旧事实');assert.deepEqual(s.repo.memory.syncCursor(),{});assert.deepEqual(s.repo.memory.longCursor(),{});assert.equal(s.archived.length,0);
 }
});
test('nightly second phase adds exact user quotes, deduplicates and no-source nightly avoids second request',async t=>{
 const s=setup(t,async opts=>{assert.doesNotMatch(opts.input,/当前核心记忆|核心原文/);return complete(opts.input.includes('## 当前阶段\n长期引用')?'- [S1] 我长期喜欢清淡的饮食':'更新事实');});source(s);
 const result=await s.service.requireSync({trigger:'scheduled'});assert.equal(result.status,'published');assert.equal(result.phaseCalls,2);assert.equal(result.longTerm.added,1);const saved=s.repo.memories.list({search:'清淡'})[0];assert.equal(saved.meta.evidence.quote,saved.text);assert.ok(saved.meta.evidence.conversationId);
 source(s);assert.equal((await s.service.requireSync({trigger:'scheduled'})).longTerm.deduplicated,1);
 const empty=await s.service.requireSync({trigger:'scheduled'});assert.equal(empty.phaseCalls,1);assert.equal(empty.longTerm.sources,0);
});
test('second phase invalid sources, paraphrase, empty and uncertainty roll back short phase too',async t=>{
 for(const reply of ['- [S9] 我长期喜欢清淡的饮食','- [S1] 我长期喜欢浓郁的饮食','随便写的长期事实','','- [S1] 也许我长期喜欢清淡的饮食']){
  const s=setup(t,async opts=>complete(opts.input.includes('## 当前阶段\n长期引用')?reply:'新的短期正文'));source(s);const before=s.repo.memory.revision();assert.equal((await s.service.requireSync({trigger:'scheduled'})).status,'failed');assert.equal(s.repo.memory.revision(),before);assert.equal(s.repo.memory.blockBySlug('short').content,'旧事实');assert.deepEqual(s.repo.memory.syncCursor(),{});assert.deepEqual(s.repo.memory.longCursor(),{});
 }
});
test('disabled long growth retains source backlog and only explicit no-fact response consumes reviewed sources',async t=>{
 const s=setup(t,async opts=>phaseReply(opts));source(s);assert.equal((await s.service.requireSync({memoryPolicy:{longTermEnabled:false}})).phaseCalls,1);assert.equal(s.repo.memory.longMessages().length,1);
 const result=await s.service.requireSync({trigger:'scheduled'});assert.equal(result.status,'published');assert.equal(result.phaseCalls,2);assert.equal(s.repo.memory.longMessages().length,0);
});
test('bounded long items and database failure roll back all writes and cursors',async t=>{
 const s=setup(t,async opts=>complete(opts.input.includes('## 当前阶段\n长期引用')?'- [S1] 我一直喜欢清淡的饮食\n- [S2] 我一直喜欢安静的音乐':'新事实'));source(s,'我一直喜欢清淡的饮食');source(s,'我一直喜欢安静的音乐');
 assert.equal((await s.service.requireSync({memoryPolicy:{longTermMaxItems:1}})).status,'failed');const before=s.repo.memory.revision();const create=s.repo.memories.create;let n=0;s.repo.memories.create=x=>{if(++n===2)throw Error('forced write failure');return create(x);};assert.equal((await s.service.requireSync()).status,'failed');assert.equal(s.repo.memory.revision(),before);assert.equal(s.repo.memories.list().length,1);assert.deepEqual(s.repo.memory.syncCursor(),{});assert.deepEqual(s.repo.memory.longCursor(),{});
});
test('concurrent sync serializes and preserves later arrivals for next snapshot',async t=>{
 let release;const gate=new Promise(r=>release=r);let n=0;const s=setup(t,async opts=>{if(++n===1)await gate;return phaseReply(opts);});const c=source(s,'边界前');const a=s.service.requireSync({memoryPolicy:{longTermEnabled:false}});await new Promise(r=>setImmediate(r));s.repo.messages.add({conversationId:c.id,role:'user',text:'边界后'});const b=s.service.requireSync({memoryPolicy:{longTermEnabled:false}});release();assert.equal((await a).status,'published');assert.equal((await b).status,'published');assert.equal(s.maxActive(),1);assert.match(s.inputs[1].input,/边界后/);assert.doesNotMatch(s.inputs[1].input,/边界前/);
});
test('multiple old blocks require explicit target and never broadcast body',async t=>{
 const s=setup(t,async()=>complete());s.repo.memory.createBlock({slug:'second',name:'第二',content:'保持第二'});source(s);assert.equal((await s.service.requireSync()).status,'failed');assert.equal(s.inputs.length,0);assert.equal((await s.service.requireSync({memoryPolicy:{shortTermSlug:'short',longTermEnabled:false}})).status,'published');assert.equal(s.repo.memory.blockBySlug('second').content,'保持第二');
});
test('linked external sources keep exact session provenance and forgotten items never resurrect',async t=>{
 const s=setup(t,async opts=>complete(opts.input.includes('## 当前阶段\n长期引用')?'- [S1] 我长期喜欢清淡的饮食':'更新事实'));const old=s.repo.memories.create({text:'我长期喜欢清淡的饮食'});s.repo.memories.setStatus(old.id,'forgotten');s.repo.dshLinks={memorySnapshot:async cursor=>cursor.external?[]:[{key:'external',through:2,title:'外部',events:[{type:'user/message',seq:2,data:{content:[{type:'text',text:old.text}]}}]}]};
 const result=await s.service.requireSync({trigger:'scheduled'});assert.equal(result.status,'published');assert.equal(result.longTerm.deduplicated,1);assert.equal(s.repo.memories.byId(old.id).status,'forgotten');assert.equal(s.repo.memory.longCursor().external,2);
});
test('rc5 runtime context and hook messages cannot support long-term user claims',async t=>{
 const s=setup(t,phaseReply);s.repo.dshLinks={memorySnapshot:async()=>[{key:'native',through:3,title:'源',events:['runtime-context','yu-context','hook','user'].map((kind,seq)=>({type:'user/message',seq,data:{source:{kind},content:[{type:'text',text:kind==='user'?'我喜欢音乐':'SYNTHETIC_CONTEXT'}]}}))}]};
 const result=await s.service.requireSync({trigger:'scheduled'});assert.equal(result.status,'published');assert.equal(result.longTerm.sources,1);const longInput=s.inputs.find(o=>o.input.includes('## 当前阶段\n长期引用')).input;assert.doesNotMatch(longInput,/SYNTHETIC_CONTEXT/);assert.match(longInput,/我喜欢音乐/);
});
import {initializeCompanionDefaults} from '../lib/companion-defaults.js';
import {readSections} from '../lib/sections.js';
import {projectMemoryTargets,memoryFileHashes} from '../lib/memory-files.js';
import {readInjection} from '../lib/injection-files.js';
test('existing three file injections and empty block database upgrade without losing the sole short-term source',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-sync-upgrade-'));const db=openDatabase(path.join(dir,'yu.db'));t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});const repo=createRepo(db),settings=createSettings(db);settings.dataDir=dir;
 fs.mkdirSync(path.join(dir,'injections'));fs.writeFileSync(path.join(dir,'injections/core.md'),'FILE CORE');fs.writeFileSync(path.join(dir,'injections/custom-short.md'),'USER SOLE SHORT');
 settings.set('prompt.sections',JSON.stringify([{id:'core',kind:'core',order:100,title:'核心',enabled:true,source:{path:'injections/core.md',format:'utf8'}},{id:'sec_user_short',kind:'custom',order:700,title:'短期记忆',heading:'最近的事',channel:'history',scope:'session',enabled:true,source:{path:'injections/custom-short.md',format:'utf8'}},{id:'retrieved',kind:'retrieved',order:710,title:'长期记忆',enabled:true}]));
 const paths={dataDir:dir,memoryFileForSlug:slug=>readSections(settings).sections.find(s=>s.legacyMemorySlug===slug)?.source?.path};repo.memory.configureProjection(targets=>projectMemoryTargets(repo,paths,targets),slugs=>memoryFileHashes(repo,paths,slugs));
 ensureShortTermMapping({repo,settings});initializeCompanionDefaults({db,repo,settings,paths});ensureVisibleSync({db,repo,settings});updateSyncConfig({db,repo,settings},{firstSessionEnabled:true});ensureShortTermMapping({repo,settings});
 assert.equal(repo.memory.blocks().length,1);assert.equal(repo.memory.blocks()[0].content,'USER SOLE SHORT');const short=readSections(settings).sections.find(s=>s.id==='sec_user_short');assert.equal(short.source.path,'injections/custom-short.md');assert.equal(short.heading,'最近的事');
 const service=createMemoryService({ctx:{get:()=>({archiveSession:async()=>{}})},repo,settings,paths,models:{effectiveSelection:()=>({ready:true})},agentHost:{disposeSession:async()=>{},runTurn:async opts=>{assert.match(opts.input,/USER SOLE SHORT/);assert.doesNotMatch(opts.input,/FILE CORE|当前核心记忆/);return {assistantText:'UPDATED SOLE SHORT',modelFinishReason:'stop',turnEnd:{kind:'completed'}};}},archiveService:{}});
 const result=await service.requireSync({trigger:'new-session'});assert.equal(result.status,'published',JSON.stringify(result));assert.equal(repo.memory.blocks()[0].content,'UPDATED SOLE SHORT');assert.equal(readInjection(settings,short).text,'UPDATED SOLE SHORT');assert.equal(readSections(settings).sections.length,3);
});

