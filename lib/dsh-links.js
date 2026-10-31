import {splitReplies} from './group-watch.js';
import {persistJournal} from './journal-output.js';
import { requestDelivery } from './delivery-route.js';
import { randomUUID } from 'node:crypto';

const CONFIG_KEY='dsh.links.config.v1', STATE_KEY='dsh.links.state.v1';
const safeError=e=>`宿主操作失败（${(['ACCESS_DENIED','SESSION_ARCHIVED','SESSION_UNAVAILABLE','HOST_UNSUPPORTED','HOST_PROTOCOL','HISTORY_GAP','session/writer-held','session/agent-busy','session/not-found','session/archived'].includes(e.code)?e.code:'HOST_ERROR')}）；请在 DSH 检查权限、归档状态或写入占用`;
const copy=x=>JSON.parse(JSON.stringify(x));
const error=(message,code='INVALID',status=400)=>Object.assign(new Error(message),{code,status});
const textOf=m=>(m?.content??[]).filter(p=>p.type==='text').map(p=>p.text??'').join('\n');
export function createDshLinks({ctx,db,repo,hostId,deliverOutput=null}) {
  // This is a local Host binding, not an identity inferred from session titles.
  const installationId=db.getMeta('dsh.host.binding.v1')??randomUUID();db.setMeta('dsh.host.binding.v1',installationId);
  hostId ??= installationId;
  let config=JSON.parse(db.getMeta(CONFIG_KEY)||'{"links":[],"rules":[]}');
  let state=JSON.parse(db.getMeta(STATE_KEY)||'{"links":{},"outbox":[],"records":[]}');
  let timer, ticking=false, stopped=false, activeTick=null, readLifetime=new AbortController();
  let savedConfig=db.getMeta(CONFIG_KEY),savedState=db.getMeta(STATE_KEY);
  const save=()=>{const nextConfig=JSON.stringify(config),nextState=JSON.stringify(state);if(nextConfig!==savedConfig){db.setMeta(CONFIG_KEY,nextConfig);savedConfig=nextConfig;}if(nextState!==savedState){db.setMeta(STATE_KEY,nextState);savedState=nextState;}};
  for(const item of state.outbox) if(['sending','reply-sending','accepted','completed'].includes(item.status)) {item.status='uncertain';item.error='进程中断，宿主是否接收未知；为避免重复不会自动重发';}
  // Cordis rc5 ctx.get is the public optional lookup without inject requirements.
  // Re-read each operation so revoked or removed services cannot leave stale access.
  const controller=()=>{const c=ctx.get?.('sessionController');if(!c?.list||!c?.page||!c?.follow||!c?.prompt)throw error('当前 DSH 缺少会话公共接口','HOST_UNSUPPORTED',503);return c;};
  const access=()=>{const registry=ctx.get?.('workspaceRegistry');const remote=ctx.get?.('remoteAccess');if(!Array.isArray(registry?.archivedSessionIds)||typeof remote?.allows!=='function')throw error('当前 DSH 缺少会话权限或归档接口，无法安全关联','HOST_UNSUPPORTED',503);return {registry,remote};};
  const authorized=id=>{const {registry,remote}=access();if(registry.archivedSessionIds.includes(id))throw error('会话已归档','SESSION_ARCHIVED',409);if(remote.allows({kind:'session',id})!==true)throw error('会话访问权限已撤销','ACCESS_DENIED',403);};
  const current=l=>!stopped&&config.links.includes(l)&&l.enabled&&l.hostId===hostId;
  const signal=(read=true)=>read?AbortSignal.any([readLifetime.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  const record=r=>{state.records.unshift({id:randomUUID(),at:Date.now(),...r});state.records.length=Math.min(state.records.length,500);};
  const local=id=>state.links[id]??=( {cursor:-1,status:'paused',preview:[],pendingAssistant:[],selfChain:false});
  const find=id=>{const l=config.links.find(l=>l.id===id);if(!l)throw error('关联不存在','NOT_FOUND',404);return l;};
  const list=async()=>{
    const {registry,remote}=access();
    const result=await controller().list({},signal());
    return (result.items??[]).filter(s=>!s.sessionId?.startsWith('yu-maint-')&&s.origin!=='subagent'&&!registry.archivedSessionIds.includes(s.sessionId)&&remote.allows({kind:'session',id:s.sessionId})===true).map(s=>({...s,title:s.projections?.values?.sessionTitle?.title??s.projections?.values?.title??s.title??'',lastPromptTime:s.updatedAt}));
  };
  // Stop after the opening snapshot: returning before the next next() also avoids cold Agent promotion.
  const boundary=async id=>{authorized(id);const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),15000);const it=controller().follow({address:{kind:'session',sessionId:id},maxMessages:1},AbortSignal.any([abort.signal,readLifetime.signal]));try{const {value}=await it.next();if(value?.type!=='snapshot')throw error('宿主未提供历史边界','HOST_PROTOCOL',503);return value;}finally{abort.abort();clearTimeout(timeout);await it.return?.();}};
  const eventsSince=async(id,cursor,cut,guard=()=>true)=>{
    let before,events=[];
    for(;;){if(!guard())throw error('监听已停止','LISTENER_STOPPED',409);authorized(id);const page=await controller().page({address:{kind:'session',sessionId:id},throughSeq:cut,maxMessages:100,...(before===undefined?{}:{beforeSeq:before})},signal());const batch=(page.records??[]).filter(r=>r.type==='event').map(r=>r.event);if(!batch.length)break;events.push(...batch.filter(e=>e.seq>cursor));const min=Math.min(...batch.map(e=>e.seq));if(!page.hasMore||min<=cursor+1)break;if(before!==undefined&&min>=before)throw error('宿主分页游标未前进','HISTORY_GAP',503);before=min;}
    events.sort((a,b)=>a.seq-b.seq);
    if(cut<cursor||events.some((e,i)=>e.seq!==cursor+i+1)||(cut>cursor&&events.at(-1)?.seq!==cut))throw error('历史游标出现缺口，请重新关联','HISTORY_GAP',503);
    return events;
  };
  const getLinks=()=>config.links.map(l=>({...l,contextId:l.contextId??db.getMeta('dsh.context.default.v1'),...local(l.id),preview:copy(local(l.id).preview)}));
  const cancel=id=>{for(const o of state.outbox)if(o.linkId===id&&['queued','sending','accepted','completed'].includes(o.status)){o.status=o.status==='sending'?'uncertain':'canceled';o.error='关联停止或解除';delete o.text;delete o.outputText;}const s=local(id);s.activeRequestId=null;s.openTurn=null;s.foreignUser=false;s.pendingAssistant=[];s.selfChain=false;};
  const dispatch=(task,opts={})=>{
    const target=task.executionTarget;if(target?.mode!=='dsh-session')throw error('不是 DSH 投递任务');
    const l=find(target.linkId);if(!l.enabled||l.hostId!==hostId)throw error('目标关联已停止或需要重新关联','LINK_DISABLED',409);
    const input=String(opts.input??'');const body=[task.goal,String(task.inputTemplate||'{{input}}').replaceAll('{{input}}',input)].filter(Boolean).join('\n\n');if(!body.trim())throw error('投递文本为空');
    const id=opts.deliveryKey??randomUUID();const existing=state.outbox.find(o=>o.id===id);if(existing)return existing;
    const item={id,requestId:`yu:${id}`,linkId:l.id,linkGeneration:l.memoryGeneration,taskId:task.id,taskKind:task.kind,trigger:opts.trigger??null,source:opts.source??'task',groupDecision:opts.meta?.groupDecision??null,replyRoute:opts.meta?.replyMode==='record'?{mode:'conversation'}:requestDelivery(task,opts),deadlineAt:Date.now()+Math.max(1000,Math.min(task.maxRuntimeMs??900000,900000)),busyPolicy:target.busyPolicy??'skip',text:`[Yu ${opts.source==='message'?(opts.meta?.kind==='qq_group'?'群聊消息':'私聊消息'):'任务投递'} · ${task.name}]\n${body}`,status:'queued',createdAt:Date.now()};
    if(item.source!=='message'&&item.busyPolicy==='queue-latest')for(const older of state.outbox)if(older.linkId===item.linkId&&older.source===item.source&&older.taskId===item.taskId&&older.status==='queued'){older.status='superseded';delete older.text;}
    state.outbox.push(item);save();setImmediate(()=>void tick().catch(()=>{}));return copy(item);
  };
  const matchMessage=(l,s,message)=>{
    const self=message.self||s.selfChain;
    s.preview.push({role:message.role,text:message.text.slice(0,12000),chars:message.text.length,truncated:message.text.length>12000,seq:message.seq});s.preview=s.preview.slice(-6);
    if(self){record({linkId:l.id,source:'yu',eventSeq:message.seq,role:message.role,chars:message.text.length,status:'skipped',reason:'Yu 投递及其因果回复不反触发'});return;}
    const rules=config.rules.filter(r=>r.enabled&&r.linkId===l.id);
    for(const r of rules){const matches=(r.role==='both'||r.role===message.role)&&(!r.keyword||message.text.includes(r.keyword));const task=repo.tasks.get(r.taskId);const reason=!matches?'消息类型或关键词未匹配':!task?.enabled?'任务不存在或已停用':'规则匹配';record({linkId:l.id,source:'dsh',eventSeq:message.seq,role:message.role,chars:message.text.length,targetId:task?.executionTarget?.linkId,status:matches&&task?.enabled?'matched':'skipped',reason});if(matches&&task?.enabled){try{dispatch(task,{input:message.text,source:'dsh-rule',deliveryKey:`rule:${r.id}:${l.id}:${message.seq}`});}catch(e){record({linkId:l.id,source:'dsh-rule',status:'failed',reason:'投递未建立',error:safeError(e)});}}}
  };
  const ingest=(l,events)=>{const s=local(l.id);for(const e of events){if(e.seq<=s.cursor)continue;
    if(e.type==='turn/start'){s.pendingAssistant=[];s.openTurn=e.data?.turn;s.activeRequestId=null;s.foreignUser=false;s.selfChain=false;}
    if(e.type==='user/message'&&(!e.data?.source?.kind||e.data.source.kind==='user')){const request=state.outbox.find(o=>o.linkId===l.id&&o.linkGeneration===l.memoryGeneration&&o.requestId===e.data?.source?.rpcId);if(request){if(s.activeRequestId&&s.activeRequestId!==request.id)s.foreignUser=true;s.activeRequestId=request.id;request.turn=s.openTurn;}else if(e.data?.source?.kind!=='runtime-context'){s.foreignUser=true;const interrupted=state.outbox.find(o=>o.id===s.activeRequestId);if(interrupted&&interrupted.status==='accepted')interrupted.status='failed';s.activeRequestId=null;}const self=Boolean(request);s.selfChain=s.selfChain||self;matchMessage(l,s,{role:'user',text:textOf(e.data),seq:e.seq,self});}
    if(e.type==='assistant/message' && e.data?.turn===s.openTurn) {const text=textOf(e.data?.message);if(text)s.pendingAssistant.push({text,seq:e.seq,self:s.selfChain});}
    if(e.type==='turn/end'){const request=state.outbox.find(o=>o.id===s.activeRequestId&&o.linkId===l.id);if(request&&['accepted','sending'].includes(request.status)){request.status=!s.foreignUser&&e.data?.turn===s.openTurn&&e.data?.reason?.kind==='completed'?'completed':'failed';request.outputText=e.data?.reason?.kind==='completed'?(s.pendingAssistant.at(-1)?.text??''):'';request.completedSeq=e.seq;}s.activeRequestId=null;if(e.data?.reason?.kind==='completed'&&s.pendingAssistant.length){const last=s.pendingAssistant.at(-1);matchMessage(l,s,{role:'assistant',text:last.text,seq:last.seq,self:s.selfChain||last.self});}else if(s.pendingAssistant.length)record({linkId:l.id,source:'dsh',status:'skipped',reason:'AI 轮次未正常完成',eventSeq:e.seq});s.pendingAssistant=[];s.selfChain=false;}
    s.cursor=e.seq;s.lastProcessedAt=Date.now();
  }};
  const tickWork=async()=>{if(ticking||stopped)return;ticking=true;try{
    for(const l of config.links.filter(l=>l.enabled)){
      const s=local(l.id);if(l.hostId!==hostId){s.status='needs-relink';cancel(l.id);continue;}
      try{authorized(l.sessionId);const available=(await list()).find(r=>r.sessionId===l.sessionId);if(!current(l))continue;if(!available)throw error('会话不可访问','SESSION_UNAVAILABLE',409);const snap=await boundary(l.sessionId);if(!current(l))continue;if(s.resumeFromNow){s.cursor=snap.cursor;s.pendingAssistant=[];s.selfChain=false;delete s.resumeFromNow;}const events=await eventsSince(l.sessionId,s.cursor,snap.cursor,()=>current(l));if(!current(l))continue;authorized(l.sessionId);ingest(l,events);s.status='listening';s.error=null;}catch(e){if(!current(l))continue;s.status='unavailable';s.error=safeError(e);cancel(l.id);}
      save();
    }
    for(const o of state.outbox)if(['queued','accepted'].includes(o.status)&&Date.now()>o.deadlineAt){o.status='timeout';delete o.text;}
    for(const o of state.outbox.filter(o=>o.status==='queued')){
      const l=config.links.find(l=>l.id===o.linkId);if(!l?.enabled||l.hostId!==hostId){o.status='canceled';continue;}if(local(l.id).status!=='listening')continue;
      try{const rows=await list();const row=rows.find(r=>r.sessionId===l.sessionId);if(!row)throw error('会话已删除、归档或不可访问','SESSION_UNAVAILABLE',409);
        if(row.running || state.outbox.some(p=>p!==o&&p.linkId===o.linkId&&['sending','accepted'].includes(p.status))){if(o.busyPolicy==='skip' && o.source!=='message'){o.status='skipped';delete o.text;record({linkId:l.id,source:o.source,targetId:l.id,status:'skipped',reason:'宿主会话忙'});}else{for(const older of state.outbox)if(o.source!=='message'&&older.source===o.source&&older.taskId===o.taskId&&older.linkId===l.id&&older.status==='queued'&&older!==o&&older.createdAt<o.createdAt)older.status='superseded';}continue;}
        // Persist intent before the non-transactional Host call. Never retry an ambiguous send.
        if(!current(l)||o.status!=='queued')continue;authorized(l.sessionId);
        o.status='sending';local(l.id).selfChain=true;save();
        const accepted=await controller().prompt({sessionId:l.sessionId,requestId:o.requestId,content:[{type:'text',text:o.text}]},signal(false));if(o.status==='sending')o.status=accepted?.accepted?'accepted':'uncertain';delete o.text;
        record({linkId:l.id,source:o.source,targetId:l.id,status:o.status,reason:'宿主投递',deliveryId:o.id});
      }catch(e){o.status=o.status==='sending'?'uncertain':'failed';o.error=safeError(e);record({linkId:l.id,source:o.source,targetId:l.id,status:o.status,reason:'宿主投递失败；不自动重试',error:o.error});}
      save();
    }
    for(const o of state.outbox.filter(o=>o.status==='completed')) {
      if(o.taskKind==='journal'&&!o.documentSlug){
        try{o.documentSlug=persistJournal({repo,run:{id:o.id,queuedAt:o.createdAt,meta:{trigger:o.trigger}},text:o.outputText}).slug;save();}
        catch(e){o.status='failed';o.error=e.message;save();continue;}
      }
      if(o.replyRoute?.mode!=='onebot'){o.status='recorded';delete o.outputText;continue;}
      const l=config.links.find(l=>l.id===o.linkId);
      if(!l||!current(l)||o.linkGeneration!==l.memoryGeneration){o.status='canceled';delete o.outputText;continue;}
      if(o.groupDecision) o.outputText=splitReplies(o.outputText).join('');
      if(!o.outputText?.trim()){o.status='empty';delete o.outputText;continue;}
      o.status='reply-sending';save();
      try { authorized(l.sessionId);o.delivery=await deliverOutput?.({...copy(o.replyRoute),text:o.outputText})??{ok:false,status:'unavailable'};o.status=o.delivery.ok?'replied':o.delivery.status==='unknown'?'uncertain':'reply-failed'; }
      catch(e){o.status='reply-failed';o.error=safeError(e);}
      delete o.outputText;save();
    }
  }finally{ticking=false;save();}};
  const tick=()=>{if(stopped)return Promise.resolve();if(activeTick)return activeTick;activeTick=tickWork().finally(()=>{activeTick=null;});return activeTick;};
  const api={hostId,list,getLinks,dispatch,tick,
    checkpoint:()=>copy({config,state}),
    restore(checkpoint){config=copy(checkpoint.config);state=copy(checkpoint.state);savedConfig=db.getMeta(CONFIG_KEY);savedState=db.getMeta(STATE_KEY);},
    async prepareLink(sessionId){
      const row=(await list()).find(s=>s.sessionId===sessionId);if(!row)throw error('会话不可访问');
      const existing=config.links.find(l=>l.sessionId===sessionId&&l.hostId===hostId&&!l.unlinked&&l.enabled&&!local(l.id).needsRelink);
      if(existing)return {link:copy(existing),created:false};
      const snap=await boundary(sessionId);
      return {created:true,cursor:snap.cursor,link:{id:randomUUID(),hostId,sessionId,title:row.title||'DSH 会话',enabled:true,memoryGeneration:randomUUID()}};
    },
    commitPrepared(prepared){if(!prepared.created)return copy(prepared.link);const l=copy(prepared.link);config.links.push(l);state.links[l.id]={cursor:prepared.cursor,status:'listening',preview:[],pendingAssistant:[],selfChain:false};save();return copy(l);},
    async waitForDelivery(id) {
      for(;;){const o=state.outbox.find(o=>o.id===id);if(!o)return {id,status:'missing'};
        if(stopped)return {id,status:'canceled'};
        if(!['queued','sending','accepted','completed','reply-sending'].includes(o.status))return copy(o);
        if(Date.now()>(o.deadlineAt??o.createdAt+900000)){o.status='timeout';delete o.text;save();return copy(o);}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    },
    async contextEvents(id){const l=find(id);authorized(l.sessionId);const snap=await boundary(l.sessionId);const page=await controller().page({address:{kind:'session',sessionId:l.sessionId},throughSeq:snap.cursor,maxMessages:50},signal());authorized(l.sessionId);return (page.records??[]).filter(r=>r.type==='event').map(r=>r.event);},
    assertMemoryAccess(linkId,sessionId){const l=find(linkId);if(!current(l)||l.sessionId!==sessionId||local(linkId).needsRelink)throw error('会话关联不可用','LINK_DISABLED',409);authorized(sessionId);return true;},
    async memorySnapshot(cursors={},linkIds=null) {
      const output=[];
      for(const l of config.links.filter(l=>(!linkIds||linkIds.includes(l.id))&&!l.sessionId?.startsWith('yu-maint-')&&l.enabled&&!l.unlinked&&l.hostId===hostId&&!local(l.id).needsRelink)) {
        const snap=await boundary(l.sessionId);
        const key=`dsh:${l.hostId}:${l.sessionId}`;
        const events=await eventsSince(l.sessionId,cursors[key]??-1,snap.cursor,()=>config.links.includes(l)&&l.enabled&&!l.unlinked);
        authorized(l.sessionId);
        output.push({key,title:l.title,through:snap.cursor,events});
      }
      return output;
    },
    async link(sessionId){const row=(await list()).find(s=>s.sessionId===sessionId);if(!row)throw error('会话不在当前宿主可访问列表');const existing=config.links.find(l=>l.sessionId===sessionId&&l.hostId===hostId);if(existing){const snap=await boundary(sessionId);cancel(existing.id);existing.enabled=true;existing.memoryGeneration=randomUUID();delete existing.unlinked;state.links[existing.id]={cursor:snap.cursor,status:'listening',preview:[],pendingAssistant:[],selfChain:false};save();return {...existing,...local(existing.id)};}const snap=await boundary(sessionId);const l={id:randomUUID(),hostId,sessionId,title:row.title||row.cwd||'未命名 DSH 会话',enabled:true,memoryGeneration:randomUUID()};config.links.push(l);state.links[l.id]={cursor:snap.cursor,status:'listening',preview:[],pendingAssistant:[],selfChain:false};save();return {...l,...local(l.id)};},
    update(id,patch){const l=find(id);if(Object.hasOwn(patch,'contextId')){if(!repo.contexts.get(patch.contextId))throw error('上下文方案不存在');l.contextId=patch.contextId;l.memoryGeneration=randomUUID();}if(patch.enabled===true&&local(id).needsRelink)throw error('请通过关联会话入口重新选择，以建立新的监听边界','RELINK_REQUIRED',409);if(patch.enabled===true&&!l.enabled){local(id).resumeFromNow=true;l.memoryGeneration=randomUUID();}if(typeof patch.enabled==='boolean')l.enabled=patch.enabled;if(!l.enabled){cancel(id);local(id).status=local(id).needsRelink?'needs-relink':'paused';}save();return {...l,...local(id)};},
    unlink(id){const l=find(id);const affectedTasks=(repo.tasks.list?.()??[]).filter(t=>t.executionTarget?.mode==='dsh-session'&&t.executionTarget.linkId===id);const affectedRules=config.rules.filter(r=>r.linkId===id);const commit=()=>{cancel(id);l.enabled=false;l.unlinked=true;for(const r of affectedRules)r.enabled=false;for(const task of affectedTasks)repo.tasks.setEnabled(task.id,false);state.links[id]={cursor:-1,needsRelink:true,status:'needs-relink',preview:[],pendingAssistant:[],selfChain:false};save();};if(repo.transaction)repo.transaction(commit);else commit();return {ok:true,affectedTasks:affectedTasks.length,affectedRules:affectedRules.length};},
    rules:()=>copy(config.rules),
    rule(input,id=randomUUID()){find(input.linkId);if(!['user','assistant','both'].includes(input.role))throw error('规则消息类型无效');if(repo.tasks.get(input.taskId)?.executionTarget?.mode!=='dsh-session')throw error('规则需要选择发送到关联 DSH 会话的任务');const r={id,name:String(input.name??'消息规则').slice(0,120),linkId:input.linkId,role:input.role,keyword:String(input.keyword??'').slice(0,2000),taskId:input.taskId,enabled:input.enabled!==false};config.rules=config.rules.filter(r=>r.id!==id);config.rules.push(r);save();return r;},
    removeRule(id){config.rules=config.rules.filter(r=>r.id!==id);save();return {ok:true};},
    records:()=>copy(state.records),outbox:()=>copy(state.outbox).map(({text,outputText,...o})=>o),
    exportConfig:()=>copy({...config,rules:config.rules.map(r=>({...r,taskName:repo.tasks.get(r.taskId)?.name??null}))}),
    validateConfig(value){if(!value||!Array.isArray(value.links)||!Array.isArray(value.rules))throw error('DSH 关联配置格式无效');for(const l of value.links)if(!l.id||!l.hostId||!l.sessionId)throw error('DSH 关联缺少宿主或会话标识');for(const r of value.rules)if(!value.links.some(l=>l.id===r.linkId)||!['user','assistant','both'].includes(r.role))throw error('DSH 规则引用无效');return copy(value);},
    importConfig(value){const next=api.validateConfig(value);for(const l of config.links)cancel(l.id);config={links:next.links.map(l=>({...l,enabled:false})),rules:next.rules.map(r=>({...r,taskId:r.taskName?(repo.tasks.list?.()??[]).find(t=>t.name===r.taskName)?.id??r.taskId:r.taskId}))};for(const l of config.links){state.links[l.id]={cursor:-1,needsRelink:true,status:'needs-relink',preview:[],pendingAssistant:[],selfChain:false};}save();},
    clear(){for(const l of config.links)cancel(l.id);config={links:[],rules:[]};save();},
    start(){if(timer)clearInterval(timer);stopped=false;if(readLifetime.signal.aborted)readLifetime=new AbortController();timer=setInterval(()=>void tick().catch(()=>{}),2000);timer.unref?.();void tick().catch(()=>{});},
    async stop(){stopped=true;clearInterval(timer);readLifetime.abort();if(activeTick)await activeTick;save();}
  };save();return api;
}
export function registerDshLinksApi(router,service){
  router.get('/api/dsh/sessions',async()=>({sessions:await service.list(),hostId:service.hostId}));
  router.get('/api/dsh/links',async()=>({links:service.getLinks(),hostId:service.hostId}));
  router.post('/api/dsh/links',async({body})=>({link:await service.link(body?.sessionId)}));
  router.patch('/api/dsh/links/:id',async({params,body})=>({link:service.update(params.id,body??{})}));
  router.delete('/api/dsh/links/:id',async({params})=>service.unlink(params.id));
  router.get('/api/dsh/rules',async()=>({rules:service.rules()}));
  router.post('/api/dsh/rules',async({body})=>({rule:service.rule(body??{})}));
  router.patch('/api/dsh/rules/:id',async({params,body})=>({rule:service.rule({...service.rules().find(r=>r.id===params.id),...body},params.id)}));
  router.delete('/api/dsh/rules/:id',async({params})=>service.removeRule(params.id));
  router.get('/api/dsh/records',async()=>({records:service.records(),outbox:service.outbox()}));
}
