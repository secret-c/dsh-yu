import {readSections} from './sections.js';
import {readInjection} from './injection-files.js';
import {syncFromFiles,memoryFileHashes} from './memory-files.js';
import { randomUUID } from 'node:crypto';
import { summarizeEvents } from './agent-host.js';
import { validateMaintenanceCandidate } from './memory.js';
import {normalizeMemoryPolicy} from './repo.js';
import {normalizeMemoryText,looksLikeProcess} from './memories.js';
import {readMaintenanceBody,readLongTermLines} from './maintenance-text.js';

// Called only inside memory service's single-writer queue. No runner recursion.
export function createMemorySync({ ctx, repo, settings, log, agentHost, models, paths, policy, instructions, syncFilesAfterPublish }) {
  const archive = async (conversation, sessionId) => {
    await agentHost.disposeSession?.(sessionId);
    const registry = ctx.get?.('workspaceRegistry');
    if (!registry?.archiveSession) throw new Error('宿主不支持归档维护对话');
    await registry.archiveSession(sessionId, { stopActivity: false });
    repo.conversations.archive(conversation.id, 0);
  };
  return async ({ trigger='manual', runId=null, stopSignal, syncInstructions='', syncContextConfig=null, memoryPolicy=null, externalLinkIds=null, includeInternal=true, replayExternal=false, commitKey=null, commitGuard=()=>true }={}) => {
    let conversation, sessionId;
    try {
      // Committed maintenance sessions left open by a previous archive failure
      // are closed before another model request. They never enter the input set.
      if(paths && repo.memory.repairProjection().pending) throw new Error('短期记忆文件待修复，暂不开始会话');
      for (const old of repo.memory.pendingSyncConversations()) await archive(old,old.sessionId);
      if(!commitGuard())throw new Error('初始化配置已清空或更改，取消旧构建');
      if(commitKey&&repo.raw.getMeta(commitKey))return JSON.parse(repo.raw.getMeta(commitKey));
      const cursor=repo.memory.syncCursor();
      const rows=includeInternal?repo.memory.syncMessages(cursor):[];
      const external=await repo.dshLinks?.memorySnapshot?.(replayExternal?{}:cursor,externalLinkIds) ?? [];
      const growth=normalizeMemoryPolicy(memoryPolicy);
      const grow=trigger!=='new-session' && growth.longTermEnabled && (repo.memoryLibraries?.canAutoWrite() ?? true);
      const longCursor=repo.memory.longCursor();
      const longRows=grow&&includeInternal?repo.memory.longMessages():[];
      const longExternal=grow?(await repo.dshLinks?.memorySnapshot?.(replayExternal?{}:longCursor,externalLinkIds) ?? []):[];
      const longNext={...longCursor};
      const sources=longRows.map(row=>({id:row.id,conversationId:row.conversation_id,title:row.title,text:row.text}));
      for(const row of longRows)longNext[row.conversation_id]=row.cursor;
      for(const item of longExternal) {
        longNext[item.key]=item.through;
        for(const event of item.events) {
          // rc5 stores runtime/hook context as synthetic user events as well.
          // Only actual human messages can support a long-term user claim.
          if(event.type!=='user/message'||(event.data?.source?.kind&&event.data.source.kind!=='user'))continue;
          const text=summarizeEvents([event]).userText;
          if(text) sources.push({id:`${item.key}:${event.seq}`,sessionKey:item.key,eventSeq:event.seq,title:item.title,text});
        }
      }
      const includedRuns=new Set(rows.filter(r=>r.role==='assistant').map(r=>r.run_id).filter(Boolean));
      const archiveIds=repo.archives.pending(10000).filter(a=>includedRuns.has(a.runId)).map(a=>a.id);
      const next={...cursor};
      const texts=[];
      for(const row of rows) {
        next[row.conversation_id]=row.cursor;
        texts.push(`【${row.title}】${row.role}：${row.text}`);
      }
      for(const item of external) {
        const summary=summarizeEvents(item.events);
        if(summary.userText || summary.assistantText) texts.push(`【关联会话 ${item.title}】\n输入：${summary.userText}\n回复：${summary.assistantText}`);
        next[item.key]=item.through;
      }
      if(!texts.length && !sources.length && trigger!=='scheduled' && trigger!=='new-session') {repo.memory.logMaintenance({status:'noop',trigger,runId,absorbed:0,detail:{reason:'no unconsumed messages'}});return {status:'noop'};}
      if(stopSignal?.aborted) throw new Error('记忆同步已取消');
      const route=models.effectiveSelection(syncContextConfig??{});
      if(!route.ready) throw new Error(route.problems?.join('; ') || '请先配置模型');
      if(paths) syncFromFiles(repo,paths,log);
      const baseRevision=repo.memory.revision();
      const blocks=repo.memory.blocks();
      const fileBasis=paths?memoryFileHashes(repo,paths,blocks.map(b=>b.slug)):null;
      const configured=policy();
      // Explicit sync is independent of legacy archive-autoAbsorb/disabled flags.
      const allowed=configured.strategy==='custom' ? configured.slugs : blocks.map(b=>b.slug);
      const mapped=readSections(settings).sections.filter(s=>s.enabled && s.legacyMemorySlug && s.source?.path).map(s=>s.legacyMemorySlug).filter(slug=>allowed.includes(slug));
      const selected=growth.shortTermSlug || (mapped.length===1?mapped[0]:allowed.length===1?allowed[0]:null);
      if(!selected || !allowed.includes(selected) || !blocks.some(b=>b.slug===selected)) throw new Error('请在维护任务中选择唯一短期输出文件；已有记忆不会改变');
      const slugs=[selected];
      const style=repo.style.current()?.content ?? '';
      const long=[];
      const personalEnabled=repo.memoryLibraries?.personalEnabled() ?? true;
      if(personalEnabled&&repo.memories?.list) for(let offset=0;;offset+=2000) {const batch=repo.memories.list({status:null,limit:2000,offset});long.push(...batch);if(batch.length<2000)break;}
      if(!texts.length && !sources.length && !blocks.find(b=>b.slug===selected).content.trim() && !long.some(item=>item.status==='active')) {
        repo.memory.logMaintenance({status:'noop',trigger,runId,absorbed:0,detail:{reason:'no material',outputSlug:selected}});
        return {status:'noop',reason:'没有待整理资料，使用已有记忆',phaseCalls:0,outputSlug:selected};
      }
      const input=[`## 当前核心记忆\n${coreMemoryText(settings)}`,`## 当前短期记忆\n${blocks.map(b=>'### '+b.slug+'\n'+b.content).join('\n\n')}`,`## 当前长期记忆\n${long.filter(item=>item.status==='active').map(item=>item.text).join('\n')}`,`## 上次成功同步后新增的关联会话内容\n${texts.join('\n\n') || '（无新增内容）'}`].join('\n\n');
      if(!String(syncInstructions).trim()) throw new Error('请先在维护任务目标中填写正文整理要求');
      // No hidden model instructions: both phases use the task's visible goal.
      sessionId=`yu-maint-${randomUUID()}`;
      conversation=repo.conversations.create({title:'记忆同步',kind:'task',sessionId,meta:{maintenance:true,trigger,sourceRunId:runId}});
      let phaseCalls=0;
      const phase=async (stage,material)=>{
        if(personalEnabled && repo.memoryLibraries?.personalEnabled()===false)throw new Error('维护期间停用了长期库；原记忆和游标保留，请重试');
        const body=`## 当前阶段\n${stage}\n\n${material}`;
        if(body.length>180000) throw new Error('待同步材料超过180000字；原记忆和游标保留');
        repo.messages.add({conversationId:conversation.id,role:'user',text:body});
        const summary=await agentHost.runTurn({sessionId,resume:phaseCalls++>0,route,meta:paths?{cwd:paths.dataDir}:{},policy:{mode:'none',allow:[],deny:[]},holder:{system:[{name:'yu:maintenance',order:0,wireOrder:0.5,text:syncInstructions}],sections:[],problems:[]},input:body,timeoutMs:300000,stopSignal});
        repo.messages.add({conversationId:conversation.id,role:'assistant',text:summary.assistantText||'',meta:{stage,modelFinishReason:summary.modelFinishReason??null}});
        return readMaintenanceBody(summary,stopSignal);
      };
      const shortText=await phase('短期正文',`## 输出目标\n${selected}\n\n${input}`);
      const checked=validateMaintenanceCandidate({style,blocks:{[selected]:shortText}},slugs);
      if(!checked.ok)throw new Error(checked.problems.join('; '));
      let proposals=[];
      if(grow && sources.length) {
        const sourceMaterial=sources.map((source,index)=>`[S${index+1}]\n${source.text}`).join('\n\n');
        const reply=await phase('长期引用',`## 条目上限\n${growth.longTermMaxItems}\n\n## 已有长期记忆（只读）\n${long.filter(item=>item.status==='active').map(item=>item.text).join('\n')}\n\n## 用户原文来源\n${sourceMaterial}`);
        proposals=readLongTermLines(reply,sources,growth.longTermMaxItems);
      }
      let added=0,deduplicated=0;
      const published=repo.transaction(()=>{
        if(!commitGuard())throw new Error('初始化配置已清空或更改，取消旧构建');
        if(grow && repo.memoryLibraries && !repo.memoryLibraries.canAutoWrite())throw new Error('维护期间关闭了长期自动积累；原记忆和游标保留，请重试');
        if(paths && JSON.stringify(memoryFileHashes(repo,paths,blocks.map(b=>b.slug)))!==JSON.stringify(fileBasis)) throw new Error('短期记忆文件在维护期间被修改，请重试；未推进游标');
        const result=repo.memory.publish({expectedRevision:baseRevision,blocks:blocks.map(b=>slugs.includes(b.slug)?{...b,content:shortText}:b),style,note:'正文同步关联会话',source:'maintenance',absorbedArchiveIds:archiveIds});
        for(const item of proposals) {
          if(long.some(old=>normalizeMemoryText(old.text)===normalizeMemoryText(item.text))){deduplicated++;continue;}
          const stored=repo.memories.create({kind:item.kind??'fact',text:item.text,source:'maintenance',meta:{evidence:{...item.source,quote:item.quote},runId,conversationId:conversation.id,claimType:'user-statement'}});
          long.push(stored);added++;
        }
        if(grow)repo.memory.commitLongCursor(longNext,longRows);
        repo.memory.commitSyncCursor(next,rows);
        repo.conversations.update(conversation.id,{meta:{...conversation.meta,syncCommitted:true,versionId:result.id}});
        if(commitKey)repo.raw.setMeta(commitKey,JSON.stringify({status:'published',version:result,conversationId:conversation.id,phaseCalls,outputSlug:selected,longTerm:{enabled:grow,added,deduplicated,sources:sources.length}}));
        return result;
      });
      syncFilesAfterPublish();
      if(paths && repo.memory.projectionState().pending) throw new Error('记忆版本已提交，文件待修复；重试仅修复和归档，不重复消费');
      // A failure here preserves the committed cursor and retries only archiving.
      await archive(conversation,sessionId);
      repo.memory.logMaintenance({status:'published',trigger,runId,versionId:published.id,absorbed:archiveIds.length,detail:{conversationId:conversation.id,linkedSessions:external.length,phaseCalls,outputSlug:selected}});
      return {status:'published',version:published,conversationId:conversation.id,phaseCalls,outputSlug:selected,longTerm:{enabled:grow,added,deduplicated,sources:sources.length}};
    } catch(error) {
      try { if(sessionId) await agentHost.disposeSession?.(sessionId); } catch {}
      log?.warn(`memory sync failed: ${error.message}`);
      repo.memory.logMaintenance({status:'failed',trigger,runId,error:error.message,absorbed:0,detail:{conversationId:conversation?.id,preserved:true}});
      return {status:'failed',error:error.message,preserved:true,conversationId:conversation?.id??null};
    }
  };
}

export function coreMemoryText(settings) {
 return readSections(settings).sections.filter(s=>s.kind==='core'||s.kind==='rules').map(s=>s.source ? readInjection(settings,s).text : settings.get('prompt.'+s.id)||'').join('\n\n');
}
// Associate an existing short-term document with the versioned memory store;
// preserve its id, source path, text, channel and all custom formatting.
export function ensureShortTermMapping({repo,settings}) {
 const {sections}=readSections(settings);
 const existing=sections.find(s=>s.legacyMemorySlug);
 if(existing || repo.memory.blocks().length) return false;
 const short=sections.find(s=>s.title==='短期记忆' || s.kind==='memory');
 if(!short) return false;
 const file=short.source ? readInjection(settings,short) : {status:'ok',text:''};
 if(file.status!=='ok') throw new Error('短期记忆文件无法读取，保留原配置');
 repo.transaction(()=>{
  repo.memory.createBlock({slug:'short-term',name:'短期记忆',content:file.text,orderIndex:10});
  settings.set('prompt.sections',JSON.stringify(sections.map(s=>s.id===short.id?{...s,legacyMemorySlug:'short-term'}:s)));
 });
 return true;
}
