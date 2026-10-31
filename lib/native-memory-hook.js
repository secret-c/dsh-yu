import {randomUUID} from 'node:crypto';
import {wrapMaterials} from './context-compiler.js';
// Native DSH prompt assembly is awaited by the agent loop. A polling listener
// cannot provide this barrier. Only explicitly linked, local sessions enter it.
export function createNativeMemoryHook({ ctx, dshLinks, memoryService, buildSections }) {
  const states = new WeakMap();
  let stopped = false;
  let completed = 0;
  const contextName = 'yu:native-memory';
  let contextReady = false;
  const fail = message => Object.assign(new Error(message), { code: 'YU_MEMORY_SYNC_REQUIRED' });
  const linkFor = id => dshLinks.getLinks().find(link => link.sessionId === id && link.enabled && !link.unlinked && !link.needsRelink && link.hostId === dshLinks.hostId);
  const snapshotText = context => {
    const agent = context?.agent;
    if (!agent || agent.id?.startsWith('yu-maint-') || stopped) return '';
    const link = linkFor(agent.id), state = states.get(agent);
    if (!link || state?.generation !== `${link.id}:${link.memoryGeneration ?? ''}`) return '';
    dshLinks.assertMemoryAccess(link.id, agent.id);
    return (state.sections ?? []).filter(section=>section.channel!=='history').map(section => section.text).filter(Boolean).join('\n\n');
  };
  const registerContext = scoped => {
    const prompt = scoped.get?.('systemPrompt');
    if (!prompt?.context) return;
    // Complete system prompts and optional-context suppression must not erase
    // managed memory. Runtime context refreshes read the SAME frozen snapshot.
    const dispose = prompt.context({ name: contextName, order: 450, required: true, interpolate: false, text: snapshotText });
    contextReady = true;
    return () => { contextReady = false; dispose?.(); };
  };
  const disposeContext = ctx.inject ? ctx.inject(['systemPrompt'], registerContext) : registerContext(ctx);
  const listener = async (assembly, context, next) => {
    const agent = context?.agent;
    if (stopped || !agent || agent.id?.startsWith('yu-maint-')) return next();
    const link = linkFor(agent.id);
    if (!link) return next();
    if (!contextReady) throw fail('宿主不支持必要记忆上下文，无法安全开始会话');
    const generation = `${link.id}:${link.memoryGeneration ?? ''}`;
    dshLinks.assertMemoryAccess(link.id, agent.id);
    let state = states.get(agent);
    if (!state || state.generation !== generation) {
      state = { generation };
      states.set(agent, state);
    }
    // Concurrent previews/turns share one preparation; failures never latch.
    if (!state.sections) {
      state.pending ??= (async () => {
        const result = await memoryService.requireSync({ trigger: 'new-session', stopSignal: context.signal });
        if (!['published', 'noop'].includes(result?.status)) throw fail(result?.error || '记忆同步未完成，请重试');
        context.signal?.throwIfAborted();
        const sections = await buildSections(context,link);
        if (!Array.isArray(sections) || sections.some(section => typeof section.name !== 'string' || typeof section.text !== 'string')) throw fail('记忆注入内容无效');
        return structuredClone(sections);
      })();
      try {
        const sections = await state.pending;
        if (!state.sections) completed++;
        state.sections = sections;
      } finally {
        state.pending = null;
      }
    }
    // Session-scoped materials remain frozen; per-turn sections re-read the profile.
    {
      const fresh=await buildSections(context,link);
      const live = fresh.filter(s=>s.scope==='turn');
      const liveNames = new Set(live.map(s=>s.name));
      state.sections=[...state.sections.filter(s=>s.scope!=='turn' && s.name !== 'yu:project' && !liveNames.has(s.name) && !['yu:task-rules','yu:context-instructions','yu:context-style'].includes(s.name)),...live].sort((a,b)=>(a.order??0)-(b.order??0));
    }
    // Access and generation may change while maintenance is awaiting the model.
    if (stopped) throw fail('记忆同步服务已停止');
    const current = linkFor(agent.id);
    if (!current || `${current.id}:${current.memoryGeneration ?? ''}` !== generation) throw fail('会话关联已改变，请重试');
    dshLinks.assertMemoryAccess(link.id, agent.id);
    context.signal?.throwIfAborted();
    // Cordis next() takes no replacement arguments; transform its result.
    const downstream = await next();
    const finalLink = linkFor(agent.id);
    if (stopped || !finalLink || `${finalLink.id}:${finalLink.memoryGeneration ?? ''}` !== generation) throw fail('会话关联已改变，请重试');
    dshLinks.assertMemoryAccess(link.id, agent.id);
    context.signal?.throwIfAborted();
    return { ...downstream, contexts: [...(downstream.contexts ?? []).filter(entry => entry.name !== contextName), { name: contextName, text: snapshotText(context), interpolate: false }] };
  };
  const disposeHistory = ctx.on('agent/pre-step',async (context,next)=>{
    const decision=await next();
    if(decision.kind==='reject'||stopped)return decision;
    const agent=context.agent,link=agent&&linkFor(agent.id),state=agent&&states.get(agent);
    if(!link||!state)return decision;
    const parts=(state.sections??[]).filter(s=>s.channel==='history' && (s.scope==='turn'||!state.historyDelivered));
    const text=wrapMaterials(parts.map(s=>s.text));
    if(!text)return decision;
    state.historyDelivered=true;
    const message=Object.freeze({id:'msg_'+randomUUID(),role:'user',source:{kind:'yu-context',form:'material'},content:[{type:'text',text}]});
    return {...decision,messages:[message,...(decision.messages??[])]};
  });
  const dispose = ctx.on('system-prompt/assemble', listener);
  return { stop() { stopped = true; dispose?.(); disposeHistory?.(); if (typeof disposeContext === 'function') disposeContext(); else disposeContext?.dispose?.(); }, status: () => ({ stopped, completed }) };
}
