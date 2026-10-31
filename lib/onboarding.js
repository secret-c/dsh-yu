import {randomUUID,createHash} from 'node:crypto';
import {ensureVisibleSync,SYNC_TASK_KEY} from './memory-sync-policy.js';
import {initializeCompanionDefaults} from './companion-defaults.js';

const KEY='onboarding.v1';
const roles=[['morning',['早安','早上好']],['night',['晚安']],['activity',['自由活动']],['private',['QQ私聊','qq私聊']],['group',['QQ群聊','qq群聊']],['journal',['写日记','日记']]];
export function createOnboarding({db,repo,settings,dshLinks,memoryService,refresh=()=>{}}) {
 let job=null;const previews=new Map();
 const read=()=>{try{return JSON.parse(db.getMeta(KEY)||'null')??{mode:null,status:'unconfigured',taskIds:{}};}catch{return {mode:null,status:'unconfigured',taskIds:{}};}};
 const save=value=>db.setMeta(KEY,JSON.stringify(value));
 const taskIds=()=>{const seeded=JSON.parse(db.getMeta('companion.roles.v1')||'{}');return {...seeded,maintenance:db.getMeta(SYNC_TASK_KEY)};};
 const validate=async raw=>{
  if(!['shared','managed'].includes(raw.mode))throw new Error('请选择会话管理方式');
  const channels=repo.channels.list().filter(c=>['onebot','snowluma','napcat'].includes(c.type));
  const channelId=raw.channelId||(channels.length===1?channels[0].id:null);
  if(!channels.some(c=>c.id===channelId))throw new Error('请选择 QQ 接入');
  if(!/^\d+$/.test(String(raw.privatePeerId??'')))throw new Error('请选择一个私聊好友');
  const groupPeerIds=[...new Set((raw.groupPeerIds??[]).map(String))];
  if(!groupPeerIds.length||groupPeerIds.some(id=>!/^\d+$/.test(id)))throw new Error('请明确选择群聊对象');
  if(raw.mode==='shared'){
   if(raw.authorizeHistory!==true)throw new Error('请授权读取所选会话过去的完整历史，用于首次长短期记忆构建');
   if(!(await dshLinks.list()).some(s=>s.sessionId===raw.sessionId))throw new Error('所选 DSH 会话不可访问');
  }
  return {mode:raw.mode,channelId,privatePeerId:String(raw.privatePeerId),groupPeerIds,sessionId:raw.mode==='shared'?raw.sessionId:null,authorizeHistory:raw.mode==='shared'};
 };
 const fingerprint=()=>createHash('sha256').update(JSON.stringify({tasks:repo.tasks.list(),triggers:repo.triggers.listAll(),state:read()})).digest('hex');
 const preview=async raw=>{const selection=await validate(raw),previewToken=randomUUID();previews.set(previewToken,{selection,basis:fingerprint(),at:Date.now()});return {previewToken,selection,impact:{taskIds:taskIds(),businessTarget:selection.mode==='shared'?'所有业务任务发送到所选 DSH 会话':'每次业务执行新建 Yu 会话，成功后归档并维护记忆',maintenance:'独立内部维护会话，不向 QQ 外发',history:selection.authorizeHistory?'仅所选 DSH 会话完整历史':'不读取已有 DSH 历史',activeRuns:'运行中的任务保留原配置快照'}};};
 const apply=async raw=>{
  if(job)throw new Error('首次构建进行中，请等待完成');
  const plan=previews.get(raw.previewToken);if(!plan||Date.now()-plan.at>600000||plan.basis!==fingerprint())throw new Error('配置已变化，请重新预览');
  const selection=await validate(raw);if(JSON.stringify(selection)!==JSON.stringify(plan.selection))throw new Error('选项已变化，请重新预览');
  let ids=taskIds();
  const previous=read(),checkpoint=dshLinks.checkpoint();
  const enabledIntent=previous.status==='ready'?Object.fromEntries(Object.entries(ids).map(([role,id])=>[role,Boolean(repo.tasks.get(id)?.enabled)])):(previous.enabledIntent??Object.fromEntries(Object.keys(ids).map(role=>[role,true])));
  if(previous.ownedLinkId&&previous.selection?.sessionId!==selection.sessionId&&dshLinks.outbox().some(o=>o.linkId===previous.ownedLinkId&&['queued','sending','accepted'].includes(o.status)))throw new Error('原关联会话尚有回复进行中，请完成后重新预览切换');
  const prepared=selection.mode==='shared'?await dshLinks.prepareLink(selection.sessionId):null;
  if(!previews.has(raw.previewToken)||plan.basis!==fingerprint())throw new Error('配置已变化，请重新预览');
  let link=prepared?.link??null;
  try{repo.transaction(()=>{
   if(repo.isConfigurationCleared()&&!repo.tasks.list().length){
    for(const key of ['companion.defaults.v1','companion.roles.v1',SYNC_TASK_KEY,'memory.sync.visible.v2','dsh.context.default.v1'])db.run('DELETE FROM meta WHERE key=?',key);
    initializeCompanionDefaults({db,repo,settings});
   }
   ensureVisibleSync({db,repo,settings});ids=taskIds();
   if(Object.values(ids).some(id=>!id||!repo.tasks.get(id))||Object.keys(ids).length!==7)throw new Error('默认任务不完整，请在任务页检查');
   if(prepared)link=dshLinks.commitPrepared(prepared);
   if(link&&(!link.contextId||!repo.contexts.get(link.contextId)))dshLinks.update(link.id,{contextId:db.getMeta('dsh.context.default.v1')??repo.tasks.get(ids.morning).contextId});
   if(previous.ownedLinkId&&previous.ownedLinkId!==link?.id)dshLinks.update(previous.ownedLinkId,{enabled:false});
   for(const [role,id] of Object.entries(ids)){
    const task=repo.tasks.get(id),maintenance=role==='maintenance';
    const routed=role==='private'||role==='group';
    const fixed=selection.mode==='managed'&&!maintenance&&!routed;
    repo.tasks.update(id,{executionTarget:!maintenance&&link?{mode:'dsh-session',linkId:link.id,busyPolicy:'queue-latest'}:{mode:'yu'},conversationMode:routed?'per-peer':fixed?'reuse':'new',conversationId:fixed&&task.conversationMode==='reuse'?task.conversationId:null,archivePolicy:{...task.archivePolicy,conversation:'keep'},enabled:selection.mode==='managed'&&enabledIntent[role]!==false,...(maintenance?{memoryPolicy:{...task.memoryPolicy,shortTermSlug:task.memoryPolicy.shortTermSlug??repo.memory.blocks()[0]?.slug}}:{})});
   }
   for(const [role,peers] of [['private',[selection.privatePeerId]],['group',selection.groupPeerIds]]){
    const rules=repo.triggers.listForTask(ids[role]);const template=rules.find(r=>r.type===(role==='group'?'group-watch':'message'));
    for(const rule of rules)if(['message','group-watch'].includes(rule.type))repo.triggers.update(rule.id,{...rule,spec:{...rule.spec,localEnabled:false},enabled:false});
    peers.forEach(peerId=>{const type=role==='group'?'group-watch':'message';const spec=role==='group'?{...template?.spec,policy:'keyword-or-count',keywords:template?.spec.keywords?.length?template.spec.keywords:['Yu','yu'],messageCount:template?.spec.messageCount??20,channelId:selection.channelId,peerId}:{...template?.spec,channelId:selection.channelId,peerKind:'private',peerId,requirePeer:true,match:'any',replyMode:'reply'};delete spec.definitionId;delete spec.localEnabled;const existing=rules.find(r=>r.type===type&&r.spec.peerId===peerId);if(existing)repo.triggers.update(existing.id,{...existing,spec,enabled:true});else repo.triggers.create(ids[role],{type,label:role==='group'?'群聊看一眼':'私聊消息',spec,enabled:true});});
   }
   const repeated=previous.status==='ready'&&JSON.stringify(previous.selection)===JSON.stringify(selection);
   if(repeated)for(const [role,id] of Object.entries(ids))repo.tasks.setEnabled(id,enabledIntent[role]!==false);
   save({generation:randomUUID(),mode:selection.mode,status:selection.mode==='shared'&&!repeated?'pending':'ready',selection,taskIds:ids,enabledIntent,linkId:link?.id??null,ownedLinkId:prepared?.created?link.id:link&&previous.ownedLinkId===link.id?link.id:null,configuredAt:Date.now(),error:null});
  });}catch(error){dshLinks.restore(checkpoint);settings.reload();throw error;}
  previews.delete(raw.previewToken);refresh();return read();
 };
 const build=()=>{
  if(job)return read();const state=read();if(state.mode!=='shared'||!['pending','failed'].includes(state.status))throw new Error('当前无需首次构建');
  save({...state,status:'building',stage:'正在读取授权历史并构建长短期记忆',error:null});
  job=Promise.resolve().then(async()=>{try{
   const task=repo.tasks.get(state.taskIds.maintenance);
   if(!task)throw new Error('记忆维护任务已移除');
   if(repo.memoryLibraries&&!repo.memoryLibraries.canAutoWrite())throw new Error('请在记忆库中启用个人长期记忆及自动积累后重试；原导入资料不会自动恢复');
   const current=()=>read().generation===state.generation;
   const result=await memoryService.requireSync({trigger:'onboarding',syncInstructions:task.goal,syncContextConfig:task.contextId?repo.contexts.get(task.contextId)?.config:null,memoryPolicy:{...task.memoryPolicy,longTermEnabled:true},externalLinkIds:[state.linkId],includeInternal:false,replayExternal:true,commitKey:'onboarding.build.'+state.generation,commitGuard:current});
   if(!current())return;
   if(!['published','noop'].includes(result?.status)||result?.warnings?.some(w=>w.stage==='prior-cleanup')&&result?.status==='noop')throw new Error(result?.error||result?.warnings?.map(w=>w.message).join('; ')||'首次构建未完成');
   repo.transaction(()=>{for(const [role,id] of Object.entries(state.taskIds))repo.tasks.setEnabled(id,state.enabledIntent?.[role]!==false);save({...state,status:'ready',stage:'首次构建完成',result,error:null,completedAt:Date.now()});});refresh();
  }catch(error){if(read().generation===state.generation){repo.transaction(()=>{for(const [role,id] of Object.entries(state.taskIds))if(role!=='maintenance')repo.tasks.setEnabled(id,state.enabledIntent?.[role]!==false);save({...state,status:'failed',error:error.message,stage:'构建失败，业务使用已有记忆继续；可重试'});});refresh();}}finally{job=null;}});return read();
 };
 // A process restart never promotes an interrupted build to success.
 if(read().status==='building'){
  const interrupted=read();
  repo.transaction(()=>{for(const [role,id] of Object.entries(interrupted.taskIds??{}))if(role!=='maintenance'&&repo.tasks.get(id))repo.tasks.setEnabled(id,interrupted.enabledIntent?.[role]!==false);save({...interrupted,status:'failed',error:'首次构建被重启打断，请重试',stage:'构建中断，业务使用已有记忆继续；可重试'});});
  refresh();
 }
 return {read,preview,apply,build,wait:()=>job};
}
