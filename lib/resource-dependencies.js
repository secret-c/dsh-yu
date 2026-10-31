import {sanitizeDiagnostic} from './diagnostic-redaction.js';
import {readSections} from './sections.js';
import {readDefinitions,syncTriggerDefinitions} from './trigger-definitions.js';

export function createResourceDependencies({repo,settings,toolPackages,databaseSources}) {
  const graph = () => {
    const nodes=[], edges=[];
    const add=(kind,row)=>nodes.push({key:`${kind}:${row.id}`,kind,id:row.id,name:row.name ?? row.title ?? row.label ?? row.id});
    const edge=(from,to,relation='binding')=>edges.push({from,to,relation});
    const contexts=repo.contexts.list(), tasks=repo.tasks.list();
    const catalog={packages:toolPackages.list(),sources:databaseSources.list()};
    const globalGrants=key=>catalog[key].map(r=>({id:r.id,operations:r.operations.map(o=>o.name)}));
    const injections=readSections(settings).sections;
    const globals=injections.filter(s=>s.enabled).map(s=>({id:s.id}));
    for(const [kind,rows] of [['context',contexts],['task',tasks],['injection',readSections(settings).sections],['trigger',readDefinitions(settings)],['packages',toolPackages.list()],['sources',databaseSources.list()]]) for(const row of rows)add(kind,row);
    const bindings=(from,policy,injection)=>{
      for(const key of ['packages','sources'])for(const grant of policy?.[key] ?? [])edge(from,`${key}:${grant.id}`);
      for(const item of injection ?? [])edge(from,`injection:${item.id}`);
    };
    for(const c of contexts){
      bindings(`context:${c.id}`,c.config.tools,c.config.injection);
      for(const key of ['packages','sources'])if(c.config.tools?.[key]==null)for(const grant of globalGrants(key))edge(`context:${c.id}`,`${key}:${grant.id}`,'global-inherited');
      if(c.config.injection==null)for(const grant of globals)edge(`context:${c.id}`,`injection:${grant.id}`,'global-inherited');
    }
    for(const link of repo.dshLinks?.getLinks()??[])if(!link.unlinked){add('dsh-link',{id:link.id,name:link.title});if(link.contextId)edge('dsh-link:'+link.id,'context:'+link.contextId);}
    for(const t of tasks){
      const effectiveContextId=t.contextId ?? contexts[0]?.id;
      if(effectiveContextId)edge(`task:${t.id}`,`context:${effectiveContextId}`,t.contextId?'binding':'inherited');
      bindings(`task:${t.id}`,t.toolPolicy,t.injection);
      for(const trigger of t.triggers ?? [])if(trigger.spec?.definitionId)edge(`task:${t.id}`,`trigger:${trigger.spec.definitionId}`);
      const c=contexts.find(c=>c.id===effectiveContextId);
      for(const key of ['packages','sources'])if(t.toolPolicy?.[key]==null)for(const grant of c?.config?.tools?.[key] ?? globalGrants(key))edge(`task:${t.id}`,`${key}:${grant.id}`,c?.config?.tools?.[key]==null?'global-inherited':'inherited');
      if(t.injection==null)for(const binding of c?.config?.injection ?? globals)edge(`task:${t.id}`,`injection:${binding.id}`,c?.config?.injection==null?'global-inherited':'inherited');
    }
    return {nodes,edges};
  };
  const impact=(kind,id)=>{
    const g=graph(),key=`${kind}:${id}`;
    const bindings=g.edges.filter(e=>e.to===key).map(e=>({...e,user:g.nodes.find(n=>n.key===e.from)}));
    const recentCalls=repo.tools.recentCalls(null,200).filter(c=>kind==='packages'?c.arguments?.packageId===id:kind==='sources'?c.arguments?.sourceId===id:false);
    const activeRuns=repo.runs.list({limit:100}).filter(r=>['running','stopping'].includes(r.status)).filter(r=>{
      const snapshot=r.contextSnapshotId?repo.contexts.snapshotById(r.contextSnapshotId):null;
      const resolved=snapshot?.resolved;
      if(['packages','sources'].includes(kind))return (resolved?.toolPolicy?.resourceGrants?.[kind] ?? resolved?.toolPolicy?.[kind] ?? []).some(g=>g.id===id);
      if(kind==='context')return snapshot?.contextId===id;
      if(kind==='injection')return resolved?.injectionSelection?.ids?.includes(id);
      return r.meta?.trigger?.definitionId===id;
    });
    return sanitizeDiagnostic({kind,id,bindings,recentCalls,activeRuns,notice:'绑定是配置引用；最近调用仅为观测。全局继承范围随全局启停变化，不构成固定绑定；运行中停用遵循现有实例取消语义；资料文件保留。'},(settings.spec??[]).filter(s=>s.secret).map(s=>settings.get(s.key)));
  };
  const change=(kind,id,{action='delete',resolution='protect',replacementId=null}={})=>{
    if(!['packages','sources','context','injection','trigger'].includes(kind))throw new Error('未知资源类型');
    const before=impact(kind,id);
    if(!['delete','disable'].includes(action) || (action==='disable' && !['packages','sources'].includes(kind)))throw new Error('该资源不支持此动作');
    if(before.bindings.some(b=>b.relation!=='global-inherited') && resolution==='protect')throw Object.assign(new Error('资源仍被引用；请先选择替换或解除绑定'),{status:409,code:'RESOURCE_IN_USE',impact:before});
    if(!['protect','detach','replace'].includes(resolution))throw new Error('未知依赖处理方式');
    const g=graph();
    if(resolution==='replace' && (!replacementId || replacementId===id || !g.nodes.some(n=>n.key===`${kind}:${replacementId}`)))throw new Error('替代资源不存在');
    if(!g.nodes.some(n=>n.key===`${kind}:${id}`))throw new Error('资源不存在');
    const replaceList=(list)=>{const next=list?.flatMap(row=>row.id!==id?[row]:resolution==='replace'?[{...row,id:replacementId,...(row.operations?{operations:row.operations.map(op=>op.replace(`package_${id}_`,`package_${replacementId}_`).replace(`source_${id}_`,`source_${replacementId}_`))}:{})}]:[]);const merged=new Map();for(const row of next ?? []){const prior=merged.get(row.id);merged.set(row.id,prior?.operations?{...prior,operations:[...new Set([...prior.operations,...(row.operations??[])])]}:row);}return next==null?next:[...merged.values()];};
    let runtimeChanged=false;
    try{return repo.transaction(()=>{
      for(const c of repo.contexts.list()){
        const config=structuredClone(c.config);let changed=false;
        if(['packages','sources'].includes(kind) && ((config.tools?.[kind]==null && resolution!=='protect') || config.tools?.[kind]?.some(r=>r.id===id))){const manager=kind==='packages'?toolPackages:databaseSources;const grants=config.tools?.[kind] ?? manager.list().map(r=>({id:r.id,operations:r.operations.map(o=>o.name)}));config.tools={...config.tools,[kind]:replaceList(grants)};changed=true;}
        if(kind==='injection' && ((config.injection==null && resolution!=='protect') || config.injection?.some(r=>r.id===id))){config.injection=replaceList(config.injection ?? readSections(settings).sections.filter(s=>s.enabled).map(s=>({id:s.id})));changed=true;}
        if(changed)repo.contexts.saveVersion(c.id,{config,note:'资源依赖调整'});
      }
      for(const t of repo.tasks.list()){
        const patch={};
        if(kind==='context' && (t.contextId ?? repo.contexts.list()[0]?.id)===id){if(resolution!=='replace')throw new Error('上下文引用必须替换为另一方案');patch.contextId=replacementId;}
        if(['packages','sources'].includes(kind) && t.toolPolicy?.[kind]?.some(r=>r.id===id))patch.toolPolicy={...t.toolPolicy,[kind]:replaceList(t.toolPolicy[kind])};
        if(kind==='injection' && t.injection?.some(r=>r.id===id))patch.injection=replaceList(t.injection);
        if(Object.keys(patch).length)repo.tasks.update(t.id,patch);
        if(kind==='trigger')for(const tr of t.triggers ?? [])if(tr.spec?.definitionId===id){if(resolution==='replace')repo.triggers.update(tr.id,{spec:{...tr.spec,definitionId:replacementId}});else repo.triggers.remove(tr.id);}
      }
      if(kind==='context')for(const link of repo.dshLinks?.getLinks()??[])if(link.contextId===id&&!link.unlinked){if(resolution!=='replace')throw new Error('关联上下文必须替换为另一方案');repo.dshLinks.update(link.id,{contextId:replacementId});}
      if(['packages','sources'].includes(kind))runtimeChanged=true;
      if(kind==='packages') action==='disable'?toolPackages.setEnabled(id,false):toolPackages.uninstall(id);
      if(kind==='sources') action==='disable'?databaseSources.setEnabled(id,false):databaseSources.uninstall(id);
      if(kind==='context')repo.contexts.remove(id);
      if(kind==='injection')settings.set('prompt.sections',JSON.stringify(readSections(settings).sections.filter(s=>s.id!==id)));
      if(kind==='trigger'){settings.set('triggers.library',JSON.stringify(readDefinitions(settings).filter(s=>s.id!==id)));syncTriggerDefinitions({repo,settings});}
      repo.audit.log('resource.change',`${kind}:${id}`,{action,resolution,replacementId});
      return {ok:true,filesRetained:true,impact:before};
    });}catch(error){settings.reload();if(runtimeChanged){toolPackages.start();databaseSources.start();}throw error;}
  };
  return {graph,impact,change};
}
