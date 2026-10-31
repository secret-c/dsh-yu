import { filterResources, assertResourceCall } from './resource-policy.js';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { now, truncate, parseJson } from './util.js';

/**
 * The DeepSeek Harness adapter.
 *
 * Everything version-sensitive about the harness lives here and nowhere else:
 * how an agent is created or resumed, how materials are injected, how a turn is
 * observed, and how it is stopped. The rest of Yu talks to this façade only, so
 * a harness change is a change to one file plus a capability probe.
 *
 * We deliberately import no `@deepseek-ai/*` module: a plugin installed into a
 * profile resolves harness packages from the harness installation, and coupling
 * to their internal shapes would break on any bump. Services only.
 */

const MAX_LIVE_AGENTS = 12;

export class AgentHostError extends Error {
  constructor(message, code = 'AGENT_HOST', details = {}) {
    super(message);
    this.name = 'AgentHostError';
    this.code = code;
    this.details = details;
  }
}

function messageText(message) {
  if (!message) return '';
  if (Array.isArray(message.content)) {
    // Strictly the text block: a reasoning block also carries `.text`, and
    // concatenating both would publish the model's thinking as its reply.
    return message.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  }
  return typeof message.text === 'string' ? message.text : '';
}

function messageReasoning(message) {
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export function createAgentHost({ ctx, log, settings, models, toolOverlayProvider = null }) {
  /** sessionId -> { handle, route, policyKey, lastUsedAt, ctxForAgent, holder } */
  const live = new Map();
  /** sessionId -> Set<(frame) => void> */
  const streamSubscribers = new Map();
  let streamDisposer = null;
  let disposed = false;
  /**
   * Tool names seen in the last agent setup. The self model cannot read an agent
   * context before one exists, and claiming "I only have two tools" while the
   * agent actually has bash and read_image made Yu deny abilities she had.
   */
  let lastToolNames = [];

  const agentsService = () => ctx.get('agents');

  const attach = () => {
    if (streamDisposer) return;
    try {
      streamDisposer = ctx.on('agent/assistant-stream', (payload) => {
        const sessionId = payload?.agent?.id;
        if (!sessionId) return;
        const subs = streamSubscribers.get(sessionId);
        if (!subs || !subs.size) return;
        for (const fn of subs) {
          try {
            fn(payload.frame);
          } catch (error) {
            log?.debug(`stream subscriber threw: ${error.message}`);
          }
        }
      });
    } catch (error) {
      log?.warn(`could not subscribe to agent streams: ${error.message}`);
    }
  };

  const detach = () => {
    try {
      streamDisposer?.();
    } catch {
      /* ignore */
    }
    streamDisposer = null;
  };

  const subscribeStream = (sessionId, fn) => {
    let set = streamSubscribers.get(sessionId);
    if (!set) {
      set = new Set();
      streamSubscribers.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) streamSubscribers.delete(sessionId);
    };
  };

  const sessionSeq = (sessionId) => {
    try {
      const session = ctx.get('sessions')?.get?.(sessionId);
      return session ? Number(session.seq) : 0;
    } catch {
      return 0;
    }
  };

  const readEvents = (sessionId, fromSeq = 0) => {
    try {
      const session = ctx.get('sessions')?.get?.(sessionId);
      if (!session) return [];
      const events = session.snapshotEvents(fromSeq, session.seq);
      return Array.isArray(events) ? events : [];
    } catch (error) {
      log?.warn(`reading session ${sessionId} failed: ${error.message}`);
      return [];
    }
  };

  /** Read a persisted session log even when no agent is live. */
  const readPersistedEvents = async (sessionId) => {
    const persistence = ctx.get('sessionPersistence');
    if (!persistence?.open) return { events: [], error: 'sessionPersistence unavailable' };
    try {
      const handle = await persistence.open(sessionId, 'read');
      try {
        const result = await handle.read(0);
        return { events: result?.events ?? [], error: null };
      } finally {
        await handle.close?.();
      }
    } catch (error) {
      return { events: [], error: error.message };
    }
  };

  /**
   * Keep the agent's registered system sections in sync with this run's
   * materials.
   *
   * Registration is per name and order, exactly as the console lists them: there
   * is no fixed set of buckets any more, so a section cannot silently move to a
   * different position. The text is a closure over the slot so a live agent can
   * see new text without being re-registered; the *set* and the *order* only
   * change when the session's frame changes, which is once per session.
   */
  const syncSections = (slot) => {
    const systemPrompt = slot.ctxForAgent?.get?.('systemPrompt') ?? ctx.get('systemPrompt');
    if (!systemPrompt?.section) {
      slot.holder?.problems?.push('systemPrompt.section unavailable: materials cannot be injected');
      return;
    }
    slot.sectionDisposers ??= new Map();
    const wanted = new Map((slot.holder?.system ?? []).map((section) => [section.name, section]));
    for (const [name, entry] of [...slot.sectionDisposers]) {
      if (wanted.has(name)) continue;
      try {
        entry.disposer?.();
      } catch {
        /* ignore */
      }
      slot.sectionDisposers.delete(name);
    }
    for (const [name, section] of wanted) {
      const existing = slot.sectionDisposers.get(name);
      if (existing && existing.order === section.wireOrder) continue;
      if (existing) {
        try {
          existing.disposer?.();
        } catch {
          /* ignore */
        }
        slot.sectionDisposers.delete(name);
      }
      try {
        const disposer = systemPrompt.section({
          interpolate: false,
          name,
          order: section.wireOrder,
          text: () => (slot.holder?.system ?? []).find((entry) => entry.name === name)?.text ?? '',
        });
        slot.sectionDisposers.set(name, { disposer, order: section.wireOrder });
      } catch (error) {
        slot.holder?.problems?.push(`section ${name}: ${error.message}`);
      }
    }
  };

  const buildSetup = (slot) => (agentCtx, agent) => {
    // Keep the agent handle: `agentCtx.agent` is inject-gated and throws when a
    // restricted policy asks for the schema scope.
    slot.agent = agent;
    // Sections are registered by `syncSections` once the holder is attached: the
    // setup callback runs before the first turn's materials exist, and a section
    // registered here would freeze the empty text for the life of the agent.
    if (slot.route.reasoningEffort) {
      // Recorded for diagnostics; the loop reads effort from agentOptions.
      slot.holder.effort = slot.route.reasoningEffort;
    }
    // A custom model-facing description is a real behaviour change: it shadows
    // the global definition for this agent only.
    const overlays = toolOverlayProvider?.() ?? [];
    const tools = agentCtx.get?.('tools') ?? ctx.get('tools');
    for (const overlay of overlays) {
      if (!overlay?.description || !tools?.register) continue;
      try {
        const existing = tools.get?.(overlay.name, agent);
        if (!existing) continue;
        const disposer = tools.register({ ...existing, description: overlay.description, name: overlay.name });
        (slot.disposers ??= []).push(disposer);
      } catch (error) {
        slot.holder.problems.push(`tool overlay ${overlay.name}: ${error.message}`);
      }
    }
    // Scoped definitions capture the verified task policy, including hand-written IDs.
    for (const [key, catalog, call, idKey, resultKey] of [
      ['packages','yu_tool_packages','yu_tool_call','packageId','packages'],
      ['sources','yu_database_sources','yu_database_query','sourceId','sources'],
    ]) {
      const selection = slot.resourcePolicy?.resourceGrants?.[key] ?? slot.resourcePolicy?.[key];
      if (selection == null) continue;
      if (!tools?.get || !tools?.register) throw new AgentHostError('resource scoping unavailable','TOOL_POLICY_UNENFORCED');
      for (const name of [catalog,call]) {
        const definition = tools.get(name,agent);
        if (!definition) continue;
        const execute = definition.execute;
        const disposer = tools.register({...definition,name,execute:async(args,...rest)=>{
          if (name === call) assertResourceCall(selection,args?.[idKey],args?.operation);
          const value = await execute(args,...rest);
          return name === catalog ? {...value,[resultKey]:filterResources(value[resultKey] ?? [],selection)} : value;
        }});
        if(typeof disposer !== 'function')throw new AgentHostError('resource scope lease unavailable','TOOL_POLICY_UNENFORCED');
        (slot.disposers ??= []).push(disposer);
      }
    }
    return undefined;
  };

  /**
   * Restrict the visible tools, tolerating names the runtime refuses to name.
   *
   * `tools.restrict()` only accepts names from its *restrictable* catalog; a
   * scoped tool such as `subagent` is visible to the agent but cannot be named in
   * a restriction. Failing the whole run over that would be worse than leaving it
   * out — the rest of the policy still applies, and the omission is recorded.
   */
  const restrictTools = (slot, tools, filter) => {
    try {
      return tools.restrict(filter);
    } catch (error) {
      const match = /names unknown global tool[^"]*((?:"[^"]+"(?:, )?)+);/.exec(String(error?.message ?? ''));
      if (!match) throw error;
      const unknown = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
      const next = { ...filter };
      if (next.allow) next.allow = next.allow.filter((name) => !unknown.includes(name));
      if (next.deny) next.deny = next.deny.filter((name) => !unknown.includes(name));
      slot.holder?.problems?.push(
        `tool restriction cannot name ${unknown.join(', ')}; the rest of the policy still applies`,
      );
      log?.warn(`tool restriction skipped unreservable name(s): ${unknown.join(', ')}`);
      if (!next.allow && !next.deny) throw error;
      return tools.restrict(next);
    }
  };

  const applyToolPolicy = (slot, policy) => {
    const policyKey = JSON.stringify(policy ?? {});
    if (slot.policyKey === policyKey) return;
    const tools = slot.ctxForAgent?.get?.('tools') ?? ctx.get('tools');
    const resourceRestricted = policy?.packages != null || policy?.sources != null;
    const restricted = policy && (policy.mode !== 'all' || policy.deny?.length || resourceRestricted);
    if (!restricted) {
      slot.policyKey = policyKey;
      slot.policyState = { requested: policy, verified: true, restrictionRequired: false };
      return;
    }
    try {
      if (typeof tools?.restrict !== 'function' || typeof tools?.schemas !== 'function') {
        throw new Error('runtime cannot enforce or enumerate tool restrictions');
      }
      const names = tools.schemas(scopeOf(slot)).map((schema) => schema.name).filter(Boolean);
      if (!names.length) throw new Error('restricted tool catalog is empty; cannot verify policy');
      const denied = new Set(policy.deny ?? []);
      if(resourceRestricted) denied.add('yu_admin');
      if(resourceRestricted) for(const name of names) if(/^(yu_document_|arknights_|source_|package_|subagent|workflow)/.test(name) || ['tomimi','send_message','interrupt_agent'].includes(name))denied.add(name);
      const visible = names.filter((name) => policy.mode !== 'none' &&
        (policy.mode !== 'allow' || (policy.allow ?? []).includes(name)) && !denied.has(name));
      const blocked = names.filter((name) => !visible.includes(name));
      let disposer;
      if (policy.mode === 'none') {
        // An empty allow list needs no names at all, so it works even when a
        // scoped tool cannot be named in a deny list.
        disposer = restrictTools(slot, tools, { allow: [] });
      } else if (blocked.length) {
        disposer = restrictTools(slot, tools, { deny: blocked });
      }
      if (disposer !== undefined) {
        if (typeof disposer !== 'function') throw new Error('runtime did not return a restriction lease');
        slot.toolDisposer = disposer;
      }
      slot.policyState = { requested: policy, visibleTools: visible, verified: true, restrictionRequired: true };
      slot.policyKey = policyKey;
    } catch (error) {
      slot.policyKey = null;
      throw new AgentHostError('tool restriction failed: ' + error.message, 'TOOL_POLICY_UNENFORCED');
    }
  };

  /**
   * The agent object for a slot.
   *
   * Read from the setup callback's argument, never from `ctxForAgent.agent`:
   * that property is inject-gated and throws "cannot get property agent without
   * inject" when a restricted policy (maintenance, guests) asks for it.
   */
  const scopeOf = (slot) => slot.agent ?? undefined;

  const routeKey = (route) =>
    `${route.provider ?? ''}|${route.model ?? ''}|${route.reasoningEffort ?? ''}|${route.maxTokens ?? ''}`;

  const evictIfNeeded = async () => {
    while (live.size > MAX_LIVE_AGENTS) {
      let oldest = null;
      for (const [id, slot] of live) {
        if (!oldest || slot.lastUsedAt < oldest[1].lastUsedAt) oldest = [id, slot];
      }
      if (!oldest) break;
      await disposeSlot(oldest[0], 'evicted');
    }
  };

  const disposeSlot = async (sessionId, reason) => {
    const slot = live.get(sessionId);
    if (!slot) return;

    // Keep restrictions until the live handle has released its lease.
    // Disposers belong to the slot, not to a run: the holder is replaced on every
    // reuse, so a per-run array would orphan the registrations made at setup.
    for (const d of slot.disposers ?? []) {
      try {
        d?.();
      } catch {
        /* ignore */
      }
    }
    for (const entry of slot.sectionDisposers?.values() ?? []) {
      try {
        entry.disposer?.();
      } catch {
        /* ignore */
      }
    }
    slot.sectionDisposers?.clear();
    for (const d of slot.holder?.disposers ?? []) {
      try {
        d?.();
      } catch {
        /* ignore */
      }
    }
    try {
      await slot.handle.dispose();
      slot.toolDisposer?.();
      slot.toolDisposer = null;
      live.delete(sessionId);
    } catch (error) {
      slot.disposeFailed = true;
      log?.warn(`disposing agent ${sessionId} (${reason}) failed: ${error.message}`);
      throw error;
    }
  };

  /**
   * Ensure a live agent for this conversation, reusing the physical session and
   * only replacing the live agent when the route cannot be changed in place.
   */
  const ensureAgent = async ({ sessionId, resume = false, route, meta = {}, policy, holder }) => {
    if (disposed) throw new AgentHostError('agent host has been disposed', 'DISPOSED');
    const agents = agentsService();
    if (!agents?.create) throw new AgentHostError('ctx.agents.create is unavailable', 'NO_AGENTS_SERVICE');

    const desired = routeKey(route);
    const existing = live.get(sessionId);
    if (existing && !existing.disposeFailed && existing.routeKey === desired && existing.policyKey === JSON.stringify(policy ?? {})) {
      existing.lastUsedAt = now();
      existing.holder = holder;
      // A reused agent keeps its registrations; only the text changes. Syncing is
      // still required when the frame's section set or order changed.
      try {
        syncSections(existing);
      } catch (error) {
        existing.holder?.problems?.push(`sections: ${error.message}`);
      }
      if (policy) applyToolPolicy(existing, policy);
      return existing;
    }
    if (existing) {
      log?.info(`route changed for ${sessionId}; replacing the live agent on the same session`);
      await disposeSlot(sessionId, 'route-or-policy-changed');
      resume = true;
    }

    const agentOptions = {
      ...(route.provider ? { provider: route.provider } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}),
    };

    const slot = {
      handle: null,
      route,
      routeKey: desired,
      policyKey: null,
      lastUsedAt: now(),
      ctxForAgent: null,
      toolDisposer: null,
      holder,
      resourcePolicy: policy,
    };

    // A preset is a composition, not a label: `agents.create` does not mount one
    // by itself, so without this step the agent only sees tools registered on the
    // root context (Yu's own `yu_admin`) and no filesystem, shell or web tools at
    // all. Same two calls DSH's own session controller makes.
    const presets = ctx.get('agentPresets');
    let presetId = null;
    if (presets?.resolve && typeof presets.mount === 'function') {
      const wanted = meta.agentPreset ?? null;
      try {
        presetId = (await presets.resolve(wanted)).id;
      } catch (error) {
        // A configured preset can be missing on this install — a bundle entry that
        // did not resolve because the harness packages live inside an archive.
        // Falling back keeps her usable instead of failing every run.
        holder.problems.push(`agent preset ${wanted ?? '(default)'}: ${error.message}`);
        try {
          presetId = (await presets.resolve('minimal')).id;
          holder.problems.push(`falling back to preset ${presetId}`);
        } catch {
          presetId = null;
        }
      }
    }

    const setup = async (agentCtx, agent) => {
      slot.ctxForAgent = agentCtx;
      if (presetId && presets?.mount) {
        try {
          await presets.mount(agentCtx, presetId);
        } catch (error) {
          holder.problems.push(`mounting agent preset ${presetId}: ${error.message}`);
        }
      }
      try {
        const toolsService = agentCtx.get?.('tools');
        // `schemas` is scoped: the same call the tool policy uses.
        const schemas = toolsService?.schemas?.(agent) ?? toolsService?.schemas?.() ?? [];
        const names = schemas.map((schema) => schema?.name).filter(Boolean);
        if (names.length) lastToolNames = names;
      } catch (error) {
        log?.debug(`listing tools for the self model failed: ${error.message}`);
      }
      try {
        return buildSetup(slot)(agentCtx, agent);
      } catch (error) {
        if (slot.resourcePolicy?.resourceGrants || slot.resourcePolicy?.packages != null || slot.resourcePolicy?.sources != null) throw new AgentHostError(error.message,'TOOL_POLICY_UNENFORCED');
        holder.problems.push(`setup failed: ${error.message}`);
        return undefined;
      }
    };

    let handle;
    if (resume) {
      if (!agents.resume) throw new AgentHostError('ctx.agents.resume is unavailable', 'NO_RESUME');
      handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup,
      });
    } else {
      handle = await agents.create({
        sessionId,
        agentOptions,
        meta: {
          ...(meta.cwd ? { cwd: meta.cwd } : {}),
          ...(presetId || meta.agentPreset ? { agentPreset: presetId ?? meta.agentPreset } : {}),
        },
        setup,
      });
    }

    slot.handle = handle;
    live.set(sessionId, slot);
    // The setup callback runs before this point, so `slot.ctxForAgent` is known
    // and the first run's materials are already attached to the holder.
    try {
      syncSections(slot);
    } catch (error) {
      slot.holder?.problems?.push(`sections: ${error.message}`);
    }
    try {
      applyToolPolicy(slot, policy);
    } catch (error) {
      await disposeSlot(sessionId, 'policy-failed');
      throw error;
    }
    await evictIfNeeded();
    return slot;
  };

  /**
   * Submit one prompt to a conversation's agent and wait for quiescence.
   * Returns the durable facts of the turn — not presentation data.
   */
  const runTurn = async ({
    sessionId,
    resume = false,
    route,
    meta = {},
    policy,
    holder,
    input,
    timeoutMs = 15 * 60_000,
    stopSignal,
    onFrame = null,
    onPolicy = null,
  }) => {
    const slot = await ensureAgent({ sessionId, resume, route, meta, policy, holder });
    onPolicy?.(slot.policyState);
    const agent = slot.handle.agent;
    const fromSeq = sessionSeq(sessionId);
    const unsubscribe = onFrame ? subscribeStream(sessionId, onFrame) : null;
    const startedAt = now();
    let timedOut = false;
    let timer = null;
    let stopWatcher = null;

    const idle = (async () => {
      // The inbox message is persisted verbatim into the session log, so it has to
      // be plain JSON data. A reactive wrapper or a class instance surfaces later
      // as `agent/inbox/spliced carries non-JSON-serializable data`, which fails a
      // run that had nothing else wrong with it. Round-tripping here is cheap and
      // makes that failure impossible from our side.
      const message = JSON.parse(
        JSON.stringify({
          // The message object *is* the durable `user/message` payload, and the
          // session validator requires an `id` on it. Without one the session was
          // written but could never be read back: every resume failed with
          // "lacks an identified message" and Yu silently opened a new session per
          // message.
          id: `msg_${randomUUID()}`,
          // `role` is required: the loop forwards the message into the derived
          // request as-is, and a member without a role makes the provider adapter
          // fail the whole batch.
          role: 'user',
          content: [{ type: 'text', text: String(input ?? '') }],
          source: { kind: 'user' },
        }),
      );
      agent.followup(message);
      await agent.whenIdle();
    })();

    const guard = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          agent.cancel?.({ kind: 'user' });
        } catch (error) {
          log?.warn(`cancel after timeout failed: ${error.message}`);
        }
        resolve();
      }, Math.max(5_000, timeoutMs));
      timer.unref?.();
      if (stopSignal) {
        const onAbort = () => {
          try {
            agent.cancel?.({ kind: 'user' });
          } catch (error) {
            log?.warn(`cancel on stop request failed: ${error.message}`);
          }
        };
        if (stopSignal.aborted) onAbort();
        else {
          stopSignal.addEventListener('abort', onAbort, { once: true });
          stopWatcher = () => stopSignal.removeEventListener('abort', onAbort);
        }
      }
    });

    try {
      await Promise.race([idle, guard]);
    } finally {
      if (timer) clearTimeout(timer);
      stopWatcher?.();
      unsubscribe?.();
    }

    // The turn's durable record is authoritative; the stream was presentation.
    const events = readEvents(sessionId, fromSeq);
    const summary = summarizeEvents(events);
    summary.startedAt = startedAt;
    summary.finishedAt = now();
    summary.durationMs = summary.finishedAt - startedAt;
    summary.timedOut = timedOut;
    summary.sessionId = sessionId;
    summary.fromSeq = fromSeq;
    summary.toSeq = sessionSeq(sessionId);
    summary.route = { ...route };
    slot.lastUsedAt = now();
    return summary;
  };

  const cancel = (sessionId) => {
    const slot = live.get(sessionId);
    if (!slot) return false;
    const agent = slot.handle.agent;
    if (agent.status !== 'running') return false;
    try {
      agent.cancel({ kind: 'user' });
      return true;
    } catch (error) {
      log?.warn(`cancel failed: ${error.message}`);
      return false;
    }
  };

  const status = (sessionId) => {
    const slot = live.get(sessionId);
    if (!slot) return { live: false, status: 'offline' };
    return { live: true, status: slot.handle.agent.status, routeKey: slot.routeKey };
  };

  const aliveCount = () => live.size;

  const disposeSession = (sessionId) => disposeSlot(sessionId, 'explicit');

  // Only called at a completed Yu turn boundary under its conversation lock.
  // The host owns checkpoint persistence and summary validation; Yu never
  // rewrites session logs or treats the summary as a new user instruction.
  const maintainContinuity = async (sessionId, config = {}, previous = null, signal) => {
    const state = { at: now(), sessionId, status: 'unavailable', reason: null };
    if (config.enabled !== true) return { ...state, status: 'disabled' };
    if (previous?.sessionId === sessionId && previous?.failedAt && state.at - previous.failedAt < 300_000) return { ...previous, status: 'cooldown' };
    const slot = live.get(sessionId);
    try {
      const compaction = slot?.ctxForAgent?.get?.('compaction');
      const meter = slot?.ctxForAgent?.get?.('tokenMeter');
      if (!compaction?.compactNow || !meter?.measure) return { ...state, reason: '宿主缺少摘要压缩或上下文计量能力' };
      const agent = slot.handle.agent;
      const route = slot.route;
      const info = await models.resolve(route.provider, route.model, signal);
      const window = Number(info?.contextWindow);
      if (!(window > 0)) return { ...state, reason: '当前模型容量未知，未自动压缩；请检查宿主模型元数据' };
      const ratio = Number(config.thresholdRatio ?? 0.8);
      const measurement = meter.measure(agent.session);
      const pressure = Number(measurement.totalTokens);
      if (!Number.isFinite(pressure) || !measurement.baseline || measurement.baseline.kind === 'none') return { ...state, reason: '上下文计量尚无可靠基线，未自动压缩' };
      state.pressureTokens = pressure;
      const outputReserve = Number(route.maxTokens || info.defaultMaxTokens || 0);
      if (!Number.isFinite(ratio) || !(window > outputReserve)) return { ...state, reason: '模型输出预算未给上下文留下空间，请检查模型容量与输出上限' };
      state.thresholdTokens = Math.floor(Math.min(window * Math.max(0.5, Math.min(0.9, ratio)), window - outputReserve));
      if (pressure < state.thresholdTokens) return { ...state, status: 'below-threshold' };
      if (signal?.aborted) return { ...state, status: 'failed', failedAt: now(), reason: '运行已取消，保留原会话' };
      const result = await compaction.compactNow(agent, signal);
      if (!result) return { ...state, status: 'no-span', reason: '宿主未找到可安全压缩的历史，保留原会话' };
      return { ...state, status: 'compacted', compactionId: result.compactionId, startSeq: result.startSeq, summarySeq: result.summarySeq, endSeq: result.endSeq };
    } catch (error) {
      return { ...state, status: 'failed', failedAt: now(), reason: `${error.code ?? 'COMPACTION'}: ${error.message}` };
    }
  };

  const disposeAll = async () => {
    disposed = true;
    detach();
    const ids = [...live.keys()];
    const results = await Promise.allSettled(ids.map((id) => disposeSlot(id, 'unload')));
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'one or more agents could not be disposed');
    streamSubscribers.clear();
  };

  return {
    attach,
    detach,
    ensureAgent,
    runTurn,
    cancel,
    status,
    aliveCount,
    disposeAll,
    disposeSession,
    maintainContinuity,
    /** Tools the last created agent actually had, for the self model. */
    toolNames: () => lastToolNames,
    policyState: (sessionId) => live.get(sessionId)?.policyState ?? null,
    readEvents,
    readPersistedEvents,
    subscribeStream,
    summarizeEvents,
  };
}

/**
 * Decide what a turn's terminal frame means for the run.
 *
 * A model request that ended in `error` produced no reply: the run must fail and
 * must not commit business state. Only `completed` (and a truncating
 * `max-tokens`) count as a usable answer.
 */
export function classifyTurn(summary) {
  const kind = summary?.turnEnd?.kind ?? null;
  switch (kind) {
    case 'completed':
      return { ok: true, status: 'succeeded', reason: null, failure: null };
    case 'max-tokens':
      return { ok: true, status: 'succeeded', reason: 'MAX_TOKENS', failure: null };
    case 'error':
      return {
        ok: false,
        status: 'failed',
        reason: summary.turnEnd?.error?.code ?? 'MODEL_ERROR',
        failure: summary.turnEnd?.error?.message ?? '模型请求失败',
      };
    case 'aborted':
      return {
        ok: false,
        status: 'canceled',
        reason: 'ABORTED',
        failure: '模型请求被取消',
      };
    case 'interrupted':
      return { ok: false, status: 'interrupted', reason: 'INTERRUPTED', failure: '回合被中断' };
    case 'blocked':
      return { ok: false, status: 'failed', reason: 'BLOCKED', failure: '回合在发送请求前被拒绝' };
    case 'forked':
      return { ok: true, status: 'succeeded', reason: 'FORKED', failure: null };
    case null:
      return { ok: false, status: 'failed', reason: 'NO_TURN_END', failure: '回合没有正常结束（可能超时）' };
    default:
      return { ok: false, status: 'failed', reason: String(kind).toUpperCase(), failure: `回合结束原因：${kind}` };
  }
}

/**
 * Fold one turn's durable events into what the archive and the UI need.
 * Explicitly tolerant: an unknown event type is ignored, never fatal.
 */
export function summarizeEvents(events) {
  const out = {
    assistantText: '',
    reasoning: '',
    toolCalls: [],
    usage: {},
    turnEnd: null,
    steps: 0,
    parts: [],
    errors: [],
    userText: '',
  };
  const pendingCalls = new Map();
  for (const event of events ?? []) {
    switch (event.type) {
      case 'user/message': {
        const text = messageText(event.data);
        if (text) out.userText += (out.userText ? '\n' : '') + text;
        break;
      }
      case 'assistant/message': {
        // Keep the durable provider finish reason for conservative format repair.
        // A completed host turn alone does not rule out a token-limit response.
        out.modelFinishReason = null;
        for (const frame of event.data?.stream ?? []) {
          if (frame.type === 'chunk' && frame.chunk?.type === 'finish') out.modelFinishReason = frame.chunk.reason?.kind ?? null;
        }
        const text = messageText(event.data?.message);
        if (text.trim()) {
          out.assistantText += (out.assistantText ? '\n\n' : '') + text.trim();
          out.parts.push({ kind: 'text', text, seq: Number(event.seq) });
        }
        const reasoning = messageReasoning(event.data?.message);
        if (reasoning) out.reasoning += reasoning;
        if (event.data?.usage) out.usage = { ...out.usage, ...event.data.usage };
        if (event.data?.interrupted) out.errors.push({ code: 'INTERRUPTED', message: '回复被中断' });
        break;
      }
      case 'step/start':
        out.steps += 1;
        break;
      case 'tool/call': {
        const call = {
          callId: event.data?.callId,
          name: event.data?.name,
          arguments: parseJson(event.data?.arguments, event.data?.arguments) ?? {},
          seq: Number(event.seq),
          at: Number(event.time),
        };
        pendingCalls.set(call.callId, call);
        out.toolCalls.push(call);
        break;
      }
      case 'tool/result': {
        const call = pendingCalls.get(event.data?.message?.toolCallId);
        const target = call ?? out.toolCalls[out.toolCalls.length - 1];
        if (target) {
          target.resultText = messageText(event.data?.message);
          target.isError = Boolean(event.data?.message?.isError);
          if (event.data?.error) target.error = event.data.error;
        }
        break;
      }
      case 'turn/end':
        out.turnEnd = event.data?.reason ?? null;
        break;
      default:
        break;
    }
  }
  out.assistantText = out.assistantText.trim();
  out.userText = out.userText.trim();
  return out;
}
