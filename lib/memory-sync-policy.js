import {MAINTENANCE_TEXT_GOAL,JOURNAL_GOAL} from './maintenance-text.js';
import {readDefinitions} from './trigger-definitions.js';
import {readSections} from './sections.js';
export const SYNC_TASK_KEY='memory.sync.task.v2';
export function ensureVisibleSync({db,repo,settings}) {
 let task=repo.tasks.get(db.getMeta(SYNC_TASK_KEY));
 if(!db.getMeta('memory.sync.visible.v2')) {
  task ??= repo.tasks.list().find(t=>t.kind==='maintenance' && ['记忆维护','记忆同步'].includes(t.name) && ['整理待吸收的材料。','同步关联会话，更新短期记忆'].some(goal=>t.goal===goal || (t.goal.startsWith(goal+'\n') && t.goal.includes('【正文维护】'))));
  task ??= repo.tasks.create({name:'记忆维护',kind:'maintenance',description:'新会话开始前仅同步短期记忆；夜间/手动按任务策略提取长期用户自述。',goal:'整理有依据的记忆，保留仍然有效的信息。',conversationMode:'new',enabled:true,note:'system:memory-sync:v2'});
  if(!repo.triggers.listForTask(task.id).some(t=>t.type==='schedule'))repo.triggers.create(task.id,{type:'schedule',label:'夜间记忆同步',spec:{kind:'daily',at:String(settings.get('memory.maintenanceAt')||'03:30')},enabled:settings.get('memory.autoMaintenanceDaily')!==false,misfirePolicy:'run-once'});
  if(!repo.triggers.listForTask(task.id).some(t=>t.spec?.event==='new-session'))repo.triggers.create(task.id,{type:'manual',label:'新会话开始前（等待完成）',spec:{event:'new-session'},enabled:false});
  db.setMeta(SYNC_TASK_KEY,task.id);db.setMeta('memory.sync.visible.v2','1');
 }
 if(task && !db.getMeta('memory.sync.unified.v3'))repo.transaction(()=>{
  for(const old of repo.tasks.list()) {
   const rules=repo.triggers.listForTask(old.id),r=rules[0];
   const definition=r?.spec?.definitionId?readDefinitions(settings).find(d=>d.id===r.spec.definitionId):null;
   if(r?.spec?.definitionId && (!definition || definition.spec?.kind!=='daily' || definition.spec?.at!=='03:30'))continue;
   if(old.id===task.id || old.kind!=='maintenance' || old.name!=='记忆维护' || old.description!=='每日在独立维护对话同步关联会话增量，更新短期记忆。' || old.goal!=='' || old.contextId || old.projectId || old.conversationId || old.conversationMode!=='new' || old.createdAt!==old.updatedAt || rules.length!==1 || r.type!=='schedule' || r.spec?.kind!=='daily' || r.spec?.at!=='03:30' || r.misfirePolicy!=='run-once' || r.createdAt!==old.createdAt || r.lastFiredAt)continue;
   repo.tasks.softDelete(old.id);
   repo.audit.log('memory.unify-default',old.id,{canonicalTaskId:task.id,preservedRunHistory:true},'system');
  }
  if(task.name==='记忆同步' && task.goal==='读取三类记忆与关联会话增量，仅更新短期记忆。' && task.description==='新会话开始前等待同步；夜间独立同步。关闭规则后使用已有记忆。创建空任务不会调用模型。')task=repo.tasks.update(task.id,{name:'记忆维护',goal:'整理有依据的记忆，保留仍然有效的信息。',description:'新会话开始前仅同步短期记忆；夜间/手动按任务策略提取长期用户自述。'});
  db.setMeta('memory.sync.unified.v3','1');
 });
 if(task && !db.getMeta('memory.sync.prompt-task.v1'))repo.transaction(()=>{
  const oldPrompt=String(settings.get('memory.maintenancePrompt')||'').trim();
  const defaults=['整理有依据的记忆，保留仍然有效的信息。','读取三类记忆与关联会话增量，仅更新短期记忆。','整理待吸收的材料。',''];
  if(oldPrompt && defaults.some(goal=>task.goal===goal || (goal && task.goal.startsWith(goal+'\n')))) {
   task=repo.tasks.update(task.id,{goal:[task.goal,'历史维护要求：'+oldPrompt].filter(Boolean).join('\n\n')});
   repo.audit.log('memory.migrate-prompt',task.id,{legacyKey:'memory.maintenancePrompt'},'system');
  } else if(oldPrompt)repo.audit.log('memory.preserve-custom-goal',task.id,{legacyPromptPreservedInSettings:true},'system');
  db.setMeta('memory.sync.prompt-task.v1','1');
 });
 for(const current of repo.tasks.list({withTriggers:false}).filter(t=>['maintenance','journal'].includes(t.kind))) {
  const key='memory.text-goal.v1.'+current.id;
  if(!db.getMeta(key))repo.transaction(()=>{
   const extra=current.kind==='journal'?JOURNAL_GOAL:MAINTENANCE_TEXT_GOAL;
   if(!current.goal.includes(current.kind==='journal'?'【日记正文】':'【正文维护】'))repo.tasks.update(current.id,{goal:[current.goal,...(current.kind==='maintenance'?[current.memoryPolicy.longTermInstructions]:[]),extra].filter(Boolean).join('\n\n')});
   db.setMeta(key,'1');
  });
 }
 if(!db.getMeta('dsh.context.default.v1')) {
  const context=repo.contexts.create({name:'关联 DSH 会话',description:'用于关联会话的 Yu 记忆注入；模型、工具与原有历史沿用 DSH。',config:{injection:readSections(settings).sections.filter(s=>s.enabled && (s.legacyMemorySlug || ['core','rules','memory','retrieved'].includes(s.kind))).map(s=>({id:s.id,order:s.order,channel:'system',scope:'session'}))}});
  db.setMeta('dsh.context.default.v1',context.id);
 }
 return readSyncConfig({db,repo});
}
export function readSyncConfig({db,repo}) {
 const task=repo.tasks.get(db.getMeta(SYNC_TASK_KEY));
 const triggers=task?repo.triggers.listForTask(task.id):[];
 return {task,firstSessionTrigger:triggers.find(t=>t.spec?.event==='new-session')??null,scheduleTrigger:triggers.find(t=>t.type==='schedule')??null,history:task?repo.runs.list({taskId:task.id,limit:30}):[]};
}
export function firstSessionSyncEnabled({db,repo}) {
 const task=repo.tasks.get(db.getMeta(SYNC_TASK_KEY));
 return Boolean(task?.enabled && repo.triggers.listForTask(task.id).some(trigger=>trigger.spec?.event==='new-session'&&trigger.enabled));
}
export function updateSyncConfig({db,repo,settings},patch) {
 if(patch.at!==undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.at))throw new Error('夜间同步时间须为 HH:MM');
 const current=readSyncConfig({db,repo});
 if(!current.task)throw new Error('记忆同步任务已移除，请在任务页创建维护任务');
 repo.transaction(()=>{
 const updateRule=(trigger,enabled,at)=>{
  let spec={...trigger.spec};
  if(spec.definitionId&&settings){
   const definitions=readDefinitions(settings);const original=definitions.find(d=>d.id===spec.definitionId);
   if(original&&(at!==undefined||(enabled===true&&!original.enabled))){
    const shared=repo.triggers.listAll().filter(t=>t.spec?.definitionId===spec.definitionId).length>1;
    const id=shared?'memory_'+trigger.id:spec.definitionId;
    const definition={...original,id,enabled:enabled===true?true:original.enabled,spec:{...original.spec,...(at===undefined?{}:{at})}};
    settings.set('triggers.library',JSON.stringify(shared?[...definitions,definition]:definitions.map(d=>d.id===id?definition:d)));
    spec.definitionId=id;
   }
   if(enabled!==undefined)spec.localEnabled=enabled;
  }
  if(at!==undefined)spec.at=at;
  repo.triggers.update(trigger.id,{...trigger,enabled:enabled??trigger.enabled,spec});
 };
 if(typeof patch.enabled==='boolean')repo.tasks.setEnabled(current.task.id,patch.enabled);
 if(typeof patch.firstSessionEnabled==='boolean'&&current.firstSessionTrigger)updateRule(current.firstSessionTrigger,patch.firstSessionEnabled);
 if(current.scheduleTrigger&&(patch.at!==undefined||typeof patch.nightlyEnabled==='boolean'))updateRule(current.scheduleTrigger,patch.nightlyEnabled,patch.at);
 });
 return readSyncConfig({db,repo});
}
export function visibleSyncExecutor({db,repo,serialize,execute}) {
 return options=>{
  const first=options?.trigger==='new-session';
  const cfg=readSyncConfig({db,repo});
  if(first&&(!cfg.task?.enabled||!cfg.firstSessionTrigger?.enabled))return Promise.resolve({status:'noop',reason:'新会话同步规则已关闭，使用已有记忆'});
 if(!first)return serialize(()=>execute({syncInstructions:cfg.task?.goal,memoryPolicy:cfg.task?.memoryPolicy,syncContextConfig:cfg.task?.contextId?repo.contexts.get(cfg.task.contextId)?.config:null,...options}));
  const run=repo.runs.create({taskId:cfg.task.id,triggerId:cfg.firstSessionTrigger.id,triggerReason:'新会话开始前（等待完成）',status:'queued',meta:{memorySyncWait:true,sourceRunId:options?.runId??null}});
  repo.runs.addStep(run.id,'note','等待记忆同步','新会话开始前等待；未创建业务模型请求');
  return serialize(async()=>{
   const queued=repo.runs.get(run.id);
   if(queued.status==='canceled'||queued.stopRequestedAt)return {status:'noop',reason:'同步已取消'};
   const latest=readSyncConfig({db,repo});
   if(!latest.task?.enabled||!latest.firstSessionTrigger?.enabled){repo.runs.update(run.id,{status:'canceled',phase:'done',finishedAt:Date.now(),outputText:'规则已关闭，使用已有记忆'});return {status:'noop',reason:'规则已关闭'};}
   repo.runs.update(run.id,{status:'running',phase:'running',startedAt:Date.now()});
   const cancel=new AbortController();
   const timer=setInterval(()=>{const current=repo.runs.get(run.id);if(current?.stopRequestedAt||current?.status==='canceled')cancel.abort(new Error('记忆同步已取消'));},50);
   try {
    const result=await execute({...options,stopSignal:options?.stopSignal?AbortSignal.any([options.stopSignal,cancel.signal]):cancel.signal,runId:run.id,memoryPolicy:cfg.task.memoryPolicy,syncInstructions:cfg.task.goal,syncContextConfig:cfg.task.contextId?repo.contexts.get(cfg.task.contextId)?.config:null});
    const failed=result?.status==='failed',cleanup=Boolean(result?.warnings?.length);
    repo.runs.update(run.id,{status:cancel.signal.aborted?'canceled':failed?'failed':'succeeded',phase:'done',finishedAt:Date.now(),conversationId:result?.conversationId??null,sessionId:result?.conversationId?repo.conversations.get(result.conversationId)?.sessionId:null,businessDone:!failed,memoryDone:result?.status==='published',errorCode:failed?'MEMORY_SYNC_FAILED':cleanup?'MEMORY_CLEANUP_PENDING':null,errorMessage:result?.error??result?.warnings?.map(w=>w.message).join('; ')??null,outputText:result?.error??(result?.status==='published'?(cleanup?'记忆已提交；清理待完成':'记忆同步完成'):'无需更新'),meta:{...run.meta,result}});
    if(cleanup)repo.runs.addStep(run.id,'note','记忆清理待完成',JSON.stringify(result.warnings));
    return {...result,maintenanceRunId:run.id};
   }catch(error){repo.runs.update(run.id,{status:'failed',phase:'done',finishedAt:Date.now(),errorCode:'MEMORY_SYNC_FAILED',errorMessage:error.message});throw error;}finally{clearInterval(timer);}
  });
 };
}
