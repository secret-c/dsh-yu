import { requestDelivery } from './delivery-route.js';
import { persistJournal } from './journal-output.js';
import { resolveResourcePolicy } from './resource-policy.js';
import { now, truncate, dayKey } from './util.js';
import { compileContext, formatDate, wrapMaterials } from './context-compiler.js';
import { registryTurnNames } from './sections.js';
import { summarizeEvents, classifyTurn } from './agent-host.js';
import { ReadingError } from './reading.js';
import { syncFromFiles } from './memory-files.js';
import { sanitizeDiagnostic } from './diagnostic-redaction.js';
import { commitRetrievalDelivery, recentDialogueReplay } from './context-delivery.js';
import { rolloverReason, isOwnerMainChat, ownerIds, dailyJournalSources, parseJournalCursor } from './session-rollover.js';
import { JOURNAL_GOAL } from './maintenance-text.js';

/** Statuses a run never leaves — the ones a waiter can be answered from. */
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);
const isTerminalRunStatus = (status) => TERMINAL_RUN_STATUSES.has(String(status ?? ''));

/**
 * Tools a guest (anyone who is not the owner, writing in private) must not have.
 *
 * `yu_admin` is the whole self-modification surface — tasks, schedules, settings,
 * memory, documents, notifications — and the shell/editor tools would let a
 * stranger run commands on the host. Reads stay: answering a question about the
 * system is harmless, rewriting it is not. Names are denied defensively: a tool
 * that this preset does not mount simply matches nothing.
 */
const GUEST_DENIED_TOOLS = [
  'yu_admin',
  'bash',
  'pwsh',
  'terminal',
  'shell',
  'write',
  'edit',
  'str_replace_editor',
  'subagent',
  'workflow',
  'todo_write',
];

export function guestToolPolicy(policy) {
  const base = policy ?? { mode: 'all', allow: [], deny: [] };
  const deny = [...new Set([...(base.deny ?? []), ...GUEST_DENIED_TOOLS])];
  const allow = Array.isArray(base.allow) && base.allow.length ? base.allow.filter((name) => !deny.includes(name)) : [];
  return { ...base, mode: base.mode==='allow' || allow.length ? 'allow' : 'deny', allow, deny };
}

/**
 * Run orchestration.
 *
 * One conversation is always serial (a second input queues), independent
 * conversations may run up to `runtime.maxParallelRuns` at a time, and every
 * run has three independent completion facts — business, archive, memory — so a
 * crash in the middle can resume the remaining bookkeeping without repeating
 * what already happened.
 */
export function createRunner({
  ctx,
  repo,
  settings,
  models,
  agentHost,
  archiveService,
  memoryService,
  readingService,
  sessionMirror = null,
  log,
  paths,
  selfModel = null,
  resourceCatalogProvider = null,
  deliverOutput = null,
}) {
  const queue = [];
  const active = new Map(); // runId -> { abort, conversationId }
  const byConversation = new Map();
  const runListeners = new Map(); // runId -> Set<(evt) => void>
  const runWaiters = new Map(); // runId -> { resolve }
  const systemHandlers = {}; // kind -> async () => summary
  const journalLocks = new Map(); // Shanghai day -> pending journal writer
  let archiveServiceReady = null;
  const lockJournalDay = async day => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const previous = journalLocks.get(day);
    journalLocks.set(day, gate);
    if (previous) await previous;
    return () => { if (journalLocks.get(day) === gate) journalLocks.delete(day); release(); };
  };
  let pumping = false;
  let stopped = false;

  const recordMemoryWarning=(run,stage,result,error=null)=>{
    const warning=sanitizeDiagnostic({stage,code:result?.warnings?.[0]?.code??error?.code??'MEMORY_SYNC_FAILED',message:String(error?.message??result?.error??result?.warnings?.map(w=>w.message).join('; ')??'记忆维护未完成').slice(0,500),taskId:run.taskId,runId:run.id,maintenanceRunId:result?.maintenanceRunId??null,conversationId:result?.conversationId??null,sessionId:result?.conversationId?repo.conversations.get(result.conversationId)?.sessionId??null:null,at:now(),published:result?.status==='published'||Boolean(result?.warnings?.some(w=>w.published)),retained:result?.status!=='published'||Boolean(result?.warnings?.some(w=>w.retained))});
    const current=repo.runs.get(run.id);
    repo.runs.update(run.id,{meta:{...current.meta,memoryWarnings:[...(current.meta?.memoryWarnings??[]),warning]}});
    repo.runs.addStep(run.id,'note','记忆维护告警',JSON.stringify(warning));
    log?.warn(`run ${run.id} memory ${stage}: ${warning.code}: ${warning.message}`);
    return warning;
  };

  const emit = (runId, event) => {
    const set = runListeners.get(runId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch (error) {
        log?.debug(`run listener threw: ${error.message}`);
      }
    }
  };

  const subscribeRun = (runId, fn) => {
    let set = runListeners.get(runId);
    if (!set) {
      set = new Set();
      runListeners.set(runId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) runListeners.delete(runId);
    };
  };

  /**
   * Resolve when the run reaches a terminal state.
   *
   * A waiter registered after the run already finished must still resolve: the
   * chat handler awaits this a second time to emit `done`, and a fast turn can
   * settle in between. A listener-only waiter would then hang the SSE stream
   * forever, so the current state is checked before and after registering.
   */
  const waitForRun = (runId) => {
    const settled = repo.runs.get(runId);
    if (settled && isTerminalRunStatus(settled.status)) return Promise.resolve(settled);
    return new Promise((resolve) => {
      runWaiters.set(runId, { resolve });
      const after = repo.runs.get(runId);
      if (after && isTerminalRunStatus(after.status)) {
        runWaiters.delete(runId);
        resolve(after);
      }
    });
  };

  const settleWaiters = (runId, run) => {
    const waiter = runWaiters.get(runId);
    if (waiter) {
      runWaiters.delete(runId);
      waiter.resolve(run);
    }
  };

  // ---------------------------------------------------------- boot seeding
  const ensureDefaultContext = () => {
    const existing = repo.contexts.list();
    if (existing.length) return existing[0];
    return repo.contexts.create({
      name: '通用对话',
      description: '默认上下文方案：沿用 DSH 默认模型，注入 core / style / 五类记忆。',
      // `standard` is the preset that brings the filesystem, shell and image
      // tools; an agent without a preset only sees Yu's own two tools.
      config: { agentPreset: 'standard' },
      note: 'seeded',
    });
  };

  const defaultTimezone = () => settings.get('runtime.timezone');

  /** Keep a plaintext copy of this session's events inside the data root. */
  const mirrorSession = (sessionId) => {
    if (!sessionMirror || !sessionId) return;
    try {
      sessionMirror.mirror(sessionId);
    } catch (error) {
      log?.debug(`session mirror failed for ${sessionId}: ${error.message}`);
    }
  };

  // ------------------------------------------------------- conversation
  const resolveConversation = (task, { conversationId = null, meta = {} } = {}) => {
    if (conversationId) {
      const found = repo.conversations.get(conversationId);
      if (!found || found.archivedAt) throw new Error('所选会话不存在或已归档，请重新选择');
      repo.conversations.assertBindable(found.id);
      return found;
    }
    const contextId = task?.contextId ?? null;
    if (task && task.conversationMode === 'per-peer' && meta.channelId && meta.peerId) {
      const authority = meta.authority ?? 'task';
      const found = repo.conversations.findRouted({
        channelId: meta.channelId,
        peerId: meta.peerId,
        kind: meta.kind ?? 'qq_private',
        taskId: task.id,
        authority,
      });
      if (found && !found.archivedAt) { repo.conversations.assertBindable(found.id); return found; }
      return repo.conversations.create({
        title: meta.peerLabel || `${meta.peerId}`,
        kind: meta.kind ?? 'qq_private',
        channelId: meta.channelId,
        peerId: meta.peerId,
        peerLabel: meta.peerLabel ?? '',
        contextId,
        meta: { routeTaskId: task.id, routeAuthority: authority },
      });
    }
    if (task && task.conversationMode === 'reuse' && task.conversationId) {
      const found = repo.conversations.get(task.conversationId);
      if (!found || found.archivedAt) throw new Error('固定会话不存在或已归档，请重新选择或新建固定会话');
      repo.conversations.assertBindable(found.id);
      return found;
    }
    const created = repo.conversations.create({
      title: task ? `${task.name} · ${formatDate(now(), defaultTimezone())}` : '网页对话',
      kind: task ? 'task' : 'web',
      contextId,
      projectId: task?.projectId ?? null,
      meta: task ? { ownerTaskId: task.id } : {},
    });
    if (task && task.conversationMode === 'reuse') {
      repo.tasks.setConversationId(task.id, created.id);
    }
    return created;
  };

  // -------------------------------------------------------------- enqueue
  const enqueue = (task, opts = {}) => {
    if (stopped) throw new Error('runner is stopped');
    const setup=JSON.parse(repo.syncMeta('onboarding.v1')||'null');
    if(setup&&['pending','building'].includes(setup.status)&&Object.values(setup.taskIds??{}).includes(task?.id))throw new Error('首次记忆构建尚未完成');
    if(task?.executionTarget?.mode==='dsh-session') {
      const delivery=repo.dshLinks.dispatch(task,opts);
      if(opts.triggerId)repo.triggers.touchFired(opts.triggerId,now());
      return {run:{id:delivery.id,status:delivery.status,meta:{executionMode:'dsh-delivery'}},conversation:null,delivery};
    }
    const conversation = resolveConversation(task, { conversationId: opts.conversationId, meta: opts.meta });
    const run = repo.runs.create({
      taskId: task?.id ?? null,
      triggerId: opts.triggerId ?? null,
      triggerReason: opts.reason ?? '手动运行',
      conversationId: conversation.id,
      inputText: opts.input ?? '',
      meta: { ...(opts.meta ?? {}), taskSnapshot:task, trigger: opts.trigger ?? null, source: opts.source ?? 'manual', boundExplicitly: Boolean(opts.conversationId), deliveryTarget: requestDelivery(task, opts) },
    });
    if(setup?.status==='failed'&&Object.values(setup.taskIds??{}).includes(task?.id))recordMemoryWarning(run,'onboarding',{status:'failed',error:setup.error??'首次记忆构建失败'});
    if (rolloverReason(conversation, now(), defaultTimezone(), settings.get('runtime.sessionRotation')))
      enqueueRollover(conversation.id);
    queue.push(run.id);
    if (opts.triggerId) {
      try {
        repo.triggers.touchFired(opts.triggerId, now());
      } catch (error) {
        log?.debug(`recording trigger fire time failed: ${error.message}`);
      }
    }
    setImmediate(() => void pump());
    return { run, conversation };
  };

  const pump = () => {
    if (pumping || stopped) return;
    pumping = true;
    try {
      const maxParallel = Math.max(1, settings.get('runtime.maxParallelRuns'));
      for (;;) {
        if (active.size >= maxParallel) break;
        const index = queue.findIndex((runId) => {
          const run = repo.runs.get(runId);
          if (!run || run.status !== 'queued') return false;
          if (!run.conversationId) return true;
          return !byConversation.has(run.conversationId);
        });
        if (index < 0) break;
        const runId = queue.splice(index, 1)[0];
        const run = repo.runs.get(runId);
        if (!run) continue;
        const abort = new AbortController();
        active.set(runId, { abort, conversationId: run.conversationId });
        if (run.conversationId) byConversation.set(run.conversationId, runId);
        const promise = execute(runId, abort.signal)
          .catch((error) => {
            log?.error(`run ${runId} crashed: ${error.stack ?? error.message}`);
          })
          .finally(() => {
            active.delete(runId);
            if (run.conversationId) byConversation.delete(run.conversationId);
            setImmediate(() => void pump());
          });
        active.get(runId).promise = promise;
      }
    } finally {
      pumping = false;
    }
  };

  // -------------------------------------------------------------- execute
  const failRun = (run, conversation, error, { phase = 'execute', code = null } = {}) => {
    const finished = repo.runs.update(run.id, {
      status: repo.runs.get(run.id)?.businessDone ? 'interrupted' : error?.code === 'CANCELED' ? 'canceled' : 'failed',
      phase,
      finishedAt: now(),
      errorCode: code ?? error?.code ?? 'RUN_FAILED',
      errorMessage: truncate(error?.message ?? String(error), 2000),
    });
    repo.runs.addStep(run.id, 'error', error?.code ?? 'RUN_FAILED', error?.message ?? String(error));
    if (conversation) repo.conversations.touch(conversation.id, 'idle');
    emit(run.id, { type: 'error', code: finished.errorCode, message: finished.errorMessage });
    emit(run.id, { type: 'done', run: finished });
    settleWaiters(run.id, finished);
    return finished;
  };

  const lifecycleEligible = conversation => {
    if (!conversation?.sessionId || conversation.meta?.maintenance || conversation.sessionId.startsWith('yu-maint-')) return false;
    if (conversation.kind === 'task') {
      const owner = repo.tasks.get(conversation.meta?.ownerTaskId ?? conversation.meta?.routeTaskId);
      return Boolean(owner && owner.kind !== 'maintenance');
    }
    return ['qq_private', 'qq_group', 'web', 'reading'].includes(conversation.kind);
  };
  const archiveServiceAvailable = () => Boolean(ctx.get?.('workspaceRegistry')?.archiveSession);
  const hostSessionMissing = (error, sessionId) => error?.code === 'SESSION_NOT_FOUND' ||
    String(error?.message ?? '').includes(`cannot archive session '${sessionId}': live sessions and session persistence hold no such session`);

  const enqueueRollover = (conversationId, reason = null) => {
    const conversation = repo.conversations.get(conversationId);
    if (!lifecycleEligible(conversation) || !archiveServiceAvailable()) return null;
    const why = reason ?? rolloverReason(conversation, now(), defaultTimezone(), settings.get('runtime.sessionRotation'));
    if (!why || !conversation?.sessionId || conversation.meta?.rolloverRetryAfter > now()) return null;
    const exists = repo.raw.get(`SELECT id FROM runs WHERE conversation_id = ?
      AND status IN ('queued','running','stopping') AND json_extract(meta, '$.internalRollover') = 1
      AND json_extract(meta, '$.rolloverSessionId') = ? LIMIT 1`, conversation.id, conversation.sessionId);
    if (exists) return repo.runs.get(exists.id);
    const run = repo.runs.create({ taskId: null, conversationId: conversation.id,
      triggerReason: why === 'day-end' ? '上海时间跨日收尾' : '上下文容量收尾',
      meta: { internalRollover: true, rolloverSessionId: conversation.sessionId,
        rolloverDay: conversation.meta?.sessionDay ?? dayKey(now(), defaultTimezone()),
        source: 'internal-rollover', reason: why, deliveryTarget: { mode: 'conversation' } } });
    queue.unshift(run.id);
    setImmediate(() => void pump());
    return run;
  };

  const rolloverDue = () => {
    // The scheduler's first tick can run before DSH has registered session
    // services. Do not start a closeout that cannot safely archive its session.
    const ready = archiveServiceAvailable();
    if (ready !== archiveServiceReady) {
      log?.[ready ? 'info' : 'warn'](ready
        ? 'DSH session archive service ready; queued daily closeouts may resume'
        : 'DSH session archive service unavailable; daily closeouts deferred without changing session bindings');
      archiveServiceReady = ready;
    }
    if (!ready) return 0;
    let queued = 0;
    for (const row of repo.raw.all(`SELECT id FROM conversations WHERE archived_at IS NULL AND session_id IS NOT NULL`)) {
      if (!lifecycleEligible(repo.conversations.get(row.id))) continue;
      if (enqueueRollover(row.id)) queued++;
    }
    return queued;
  };

  const trustedOwnerChat = conversation => {
    if (isOwnerMainChat(conversation, settings)) return true;
    if (conversation?.kind !== 'qq_private' || !ownerIds(settings).has(String(conversation.peerId ?? '')) ||
        conversation.meta?.routeAuthority || conversation.meta?.sessionDelivery) return false;
    const authority = conversation.contextSnapshotId ?
      repo.contexts.snapshotById(conversation.contextSnapshotId)?.resolved?.authority : null;
    return authority === 'owner' && !repo.raw.get(`SELECT id FROM runs WHERE conversation_id = ?
      AND session_id = ? AND json_extract(meta, '$.authority') IS NOT 'owner' LIMIT 1`,
      conversation.id, conversation.sessionId);
  };

  const finishRollover = async (run, signal) => {
    let conversation = repo.conversations.get(run.conversationId);
    const sessionId = run.meta?.rolloverSessionId;
    if (!conversation || !sessionId || conversation.sessionId !== sessionId) return { status: 'already-finished' };
    if (!lifecycleEligible(conversation)) {
      repo.runs.addStep(run.id, 'note', '跳过非业务会话收尾', '维护专用或归属未知的会话保留原绑定，由所属流程处理');
      return { status: 'skipped' };
    }
    if (!archiveServiceAvailable()) {
      const latest = repo.conversations.get(conversation.id);
      repo.conversations.update(conversation.id, { meta: { ...latest.meta, rolloverRetryAfter: now() + 60_000 } });
      repo.runs.addStep(run.id, 'note', '等待宿主归档服务', '服务尚未就绪；原会话与记忆游标保持不变，稍后重试');
      return { status: 'pending' };
    }
    const day = run.meta.rolloverDay;
    const stepTimeoutMs = Math.min(120_000, Number(settings.get('runtime.maxRunMinutes') ?? 20) * 60_000);
    const ownerChat = trustedOwnerChat(conversation);
    const diaryTask = repo.tasks.list().find(task => task.kind === 'journal' && task.enabled);
    let diaryHostId = null;
    if (run.meta.reason === 'day-end' && diaryTask) {
      const key = `journal.host.${day}`;
      diaryHostId = repo.syncMeta(key);
      if (!diaryHostId) {
        const candidates = repo.conversations.list({ limit: 500 })
          .filter(item => item.sessionId && item.meta?.sessionDay === day && trustedOwnerChat(item));
        const fallback = repo.conversations.get(diaryTask.conversationId);
        diaryHostId = candidates[0]?.id ?? (fallback?.sessionId && fallback.meta?.sessionDay === day ? fallback.id : null);
        if (diaryHostId) repo.setSyncMeta(key, diaryHostId);
      }
    }
    const writeDiary = diaryHostId === conversation.id;
    const state = conversation.meta?.rollover?.sessionId === sessionId ? conversation.meta.rollover :
      { sessionId, day, reason: run.meta.reason, diaryDone: false, archiveDone: false, memoryDone: false };
    const save = patch => {
      const latest = repo.conversations.get(conversation.id);
      Object.assign(state, patch);
      conversation = repo.conversations.update(conversation.id, { meta: { ...latest.meta, rollover: { ...state } } });
    };
    save({ at: now() });
    // Only the owner's private chat may host the internal diary turn. It stays
    // in the old DSH transcript but has no QQ delivery or Yu user message.
    if (writeDiary && diaryTask && !state.diaryDone) {
      const releaseJournalDay = await lockJournalDay(day);
      try {
        const sourceCursor = parseJournalCursor(repo.syncMeta(`journal.cursor.${day}`));
        const sources = dailyJournalSources(repo, day, defaultTimezone(), sourceCursor);
        const existing = repo.documents.list({ category: 'diary' }).find(document => document.title.includes(day));
        if (sources.included || !existing) {
          const frameId = conversation.meta?.contextFrame?.snapshotId;
          const frame = frameId ? repo.contexts.snapshotById(frameId)?.resolved : null;
          if (!frame?.route) throw new Error('旧会话缺少可恢复的上下文快照');
          const prompt = `${diaryTask.goal || JOURNAL_GOAL}\n\n请为 ${day} 写${existing ? '遗漏部分的续记，避免重复已有日记' : '当日日记'}。下列同主人任务记录仅作事实来源，含运行编号；没有依据不要编造。此内部请求不向 QQ 发送。\n\n${sources.text || '当天没有其他可用任务摘录，请依据本会话已有对话。'}`;
          const summary = await agentHost.runTurn({ sessionId, resume: true, route: frame.route,
            policy: frame.toolPolicy, holder: { system: frame.systemBlocks ?? [], sections: frame.sections ?? [], problems: [] },
            meta: { cwd: frame.cwd || paths.dataDir }, input: prompt, timeoutMs: stepTimeoutMs, stopSignal: signal });
          const verdict = classifyTurn(summary);
          if (!verdict.ok) throw new Error(`日记回合未完成：${verdict.failure ?? verdict.reason}`);
          run = repo.runs.update(run.id, { meta: { ...repo.runs.get(run.id).meta, journalSourceCursor: sources.cursor } });
          const document = persistJournal({ repo, run, text: summary.assistantText });
          repo.runs.addStep(run.id, 'note', '旧会话日记已保存', `${document.slug}；日记任务 ${diaryTask.id}；来源 ${sources.included} 条运行，截断 ${sources.truncated}`);
        } else repo.runs.addStep(run.id, 'note', '日记无需续记', `${day} 已有日记，计划日记之后无新增成功运行`);
        if (sources.truncated) {
          const latest = repo.conversations.get(conversation.id);
          repo.conversations.update(conversation.id, { meta: { ...latest.meta, rolloverRetryAfter: now() + 60_000 } });
          repo.runs.addStep(run.id, 'note', '日记待续页', `已保存本页；${day} 尚有来源，稍后继续同一旧会话`);
          return { status: 'pending' };
        }
        save({ diaryDone: true });
      } catch (error) {
        recordMemoryWarning(run, 'rollover-journal', { status: 'failed', error: error.message },
          { code: error.code ?? 'JOURNAL_FAILED', message: error.message });
        save({ diaryWarning: sanitizeDiagnostic({ code: error.code ?? 'JOURNAL_FAILED', message: error.message }) });
        const latest = repo.conversations.get(conversation.id);
        repo.conversations.update(conversation.id, { meta: { ...latest.meta, rolloverRetryAfter: now() + 300_000 } });
        return { status: 'pending' };
      } finally {
        releaseJournalDay();
      }
    }
    if (ownerChat && !diaryTask && run.meta.reason === 'day-end' && !state.diaryDone) {
      repo.runs.addStep(run.id, 'note', '日记任务已停用', '保留用户启停设置，本次不生成日记');
      save({ diaryDone: true });
    }
    if (!state.archiveDone) {
      if (ownerChat || conversation.kind === 'task' || conversation.kind === 'reading') {
        const tail = archiveService.archiveConversationTail({ conversation, allowedAuthority: ownerChat ? 'owner' : null });
        repo.runs.addStep(run.id, 'note', '旧会话来源已补齐', JSON.stringify(tail));
      }
      save({ archiveDone: true });
    }
    if (!state.memoryDone && (ownerChat || conversation.kind === 'task' || conversation.kind === 'reading')) {
      try {
        const timeout = AbortSignal.timeout(stepTimeoutMs);
        const result = await memoryService.requireSync({ trigger: 'session-end', runId: run.id,
          stopSignal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (result?.status === 'failed' || result?.warnings?.length) recordMemoryWarning(run, 'rollover-memory', result);
        save({ memoryDone: true, memoryStatus: result?.status ?? 'unknown' });
      } catch (error) {
        recordMemoryWarning(run, 'rollover-memory', null, error);
        save({ memoryDone: true, memoryStatus: 'failed' });
      }
    }
    const registry = ctx.get?.('workspaceRegistry');
    if (!registry?.archiveSession) throw Object.assign(new Error('宿主不支持安全归档，保留旧会话'), { code: 'SESSION_ARCHIVE_UNAVAILABLE' });
    await agentHost.disposeSession(sessionId);
    let missing = false;
    try {
      await registry.archiveSession(sessionId, { stopActivity: false });
    } catch (error) {
      if (!state.archiveDone || !hostSessionMissing(error, sessionId)) throw error;
      missing = true;
      repo.runs.addStep(run.id, 'note', '宿主旧会话确实缺失', `旧会话 ${sessionId} 在宿主运行态和持久化中均不存在；本地来源已保留，下轮重建`);
    }
    const latest = repo.conversations.get(conversation.id);
    conversation = repo.conversations.update(conversation.id, { sessionId: null,
      meta: { ...latest.meta, rollover: null, rolloverDue: null, rolloverRetryAfter: null,
        previousSessionId: sessionId, lastRollover: { sessionId, status: missing ? 'host-session-missing' : 'archived', at: now(), day },
        contextFrame: null, sessionDay: null,
        sessionDelivery: null, retrievalDelivery: null } });
    if (!missing) repo.runs.addStep(run.id, 'note', '旧物理会话已归档', sessionId);
    return { status: missing ? 'host-session-missing' : 'archived', conversation };
  };

  const execute = async (runId, signal) => {
    let run = repo.runs.get(runId);
    if (!run || run.status !== 'queued') return;
    const task = run.meta?.taskSnapshot ?? (run.taskId ? repo.tasks.get(run.taskId) : null);
    let conversation = run.conversationId ? repo.conversations.get(run.conversationId) : null;
    let releaseJournalDay = null;

    run = repo.runs.update(run.id, { status: 'running', phase: 'context', startedAt: now() });
    if (conversation) repo.conversations.touch(conversation.id, 'running');
    repo.runs.addStep(run.id, 'lifecycle', '开始执行', run.triggerReason);
    emit(run.id, { type: 'status', status: 'running', run });

    try {
      if (run.meta?.internalRollover) {
        try {
          const result = await finishRollover(run, signal);
          const finished = repo.runs.update(run.id, { status: 'succeeded', phase: 'done',
            finishedAt: now(), businessDone: true, archiveDone: result.status === 'archived',
            outputText: result.status === 'archived' ? '旧物理会话已安全归档；下轮创建新会话' :
              result.status === 'pending' ? '旧会话日记仍有待处理来源；保留会话并稍后续记' :
                result.status === 'skipped' ? '非业务会话不由每日轮换处理；保留原会话' :
                  result.status === 'host-session-missing' ? '宿主确认旧物理会话不存在；本地来源已保留，下轮重建会话' : '旧会话已由先前运行收尾' });
          repo.conversations.touch(conversation.id, 'idle');
          emit(run.id, { type: 'done', run: finished });
          settleWaiters(run.id, finished);
        } catch (error) {
          const latest = repo.conversations.get(conversation.id);
          repo.conversations.update(conversation.id, { meta: { ...latest.meta, rolloverRetryAfter: now() + 300_000 } });
          failRun(run, conversation, error, { phase: 'rollover', code: error.code ?? 'ROLLOVER_PENDING' });
        }
        return;
      }
      // ---- 0. fixed notifications run without a model -----------------
      if (task?.kind === 'alert' && systemHandlers.alert) {
        const result = await systemHandlers.alert({ run, task });
        const lines = (result?.results ?? []).map(
          (item) =>
            `${item.channelName}：${item.category}${item.action ? ` → ${item.action.kind}` : '（未触发）'}${
              item.delivery?.ok ? '，邮件已发送' : item.delivery?.reason ? `，邮件未发送：${item.delivery.reason}` : ''
            }`,
        );
        const text = lines.length ? `健康检查完成：\n${lines.join('\n')}` : '所有连接健康，未触发提醒。';
        repo.messages.add({ conversationId: conversation.id, runId: run.id, role: 'assistant', text });
        const finished = repo.runs.update(run.id, {
          status: 'succeeded',
          phase: 'done',
          finishedAt: now(),
          outputText: text,
          businessDone: true,
          archiveDone: false,
          memoryDone: false,
        });
        repo.runs.addStep(run.id, 'note', '固定通知直接执行', '未调用模型');
        repo.conversations.touch(conversation.id, 'idle');
        emit(run.id, { type: 'message', role: 'assistant', text });
        emit(run.id, { type: 'done', run: finished });
        settleWaiters(run.id, finished);
        return;
      }

      // ---- 0b. memory maintenance runs without a model prompt --------
      // This is a normal Yu task (kind `maintenance`), scheduled by the same
      // trigger engine as everything else, so the task page shows when it will
      // run next and the run history shows what it absorbed.
      if (task?.kind === 'maintenance' && systemHandlers.maintenance) {
        const result = await systemHandlers.maintenance({ run, task });
        const status = result?.status ?? 'noop';
        const groupPart = result?.groupMessages ? ` + ${result.groupMessages} 条群聊缓存` : '';
        const longPart = result?.longTerm ? (result.longTerm.enabled ? `长期新增 ${result.longTerm.added} 条、去重 ${result.longTerm.deduplicated} 条。` : '本次长期整理关闭。') : '';
        const text =
          status === 'published'
            ? `记忆维护完成：吸收 ${result.absorbed ?? 0} 条归档${groupPart}，发布 v${result.version?.version ?? '?'}。${longPart}`
            : status === 'skipped'
              ? `记忆维护跳过：${result.reason ?? '没有待吸收的归档'}。`
              : '记忆维护完成：没有需要写入的变化。';
        repo.messages.add({ conversationId: conversation.id, runId: run.id, role: 'assistant', text });
        repo.runs.addStep(run.id, 'note', '记忆维护', text);
        const finished = repo.runs.update(run.id, {
          status: 'succeeded',
          phase: 'done',
          finishedAt: now(),
          outputText: text,
          businessDone: true,
          archiveDone: false,
          memoryDone: status === 'published',
        });
        repo.conversations.touch(conversation.id, 'idle');
        emit(run.id, { type: 'message', role: 'assistant', text });
        emit(run.id, { type: 'done', run: finished });
        settleWaiters(run.id, finished);
        return;
      }

      // ---- 0c. database backup runs without a model prompt -----------
      if (task?.kind === 'backup' && systemHandlers.backup) {
        const result = await systemHandlers.backup({ run, task });
        const text = `数据库备份：${result?.backup?.name ?? '（无文件名）'}${
          result?.backup?.bytes ? `，${Math.round(result.backup.bytes / 1024)} KB` : ''
        }`;
        repo.messages.add({ conversationId: conversation.id, runId: run.id, role: 'assistant', text });
        repo.runs.addStep(run.id, 'note', '数据库备份', text);
        const finished = repo.runs.update(run.id, {
          status: 'succeeded',
          phase: 'done',
          finishedAt: now(),
          outputText: text,
          businessDone: true,
          archiveDone: false,
          memoryDone: false,
        });
        repo.conversations.touch(conversation.id, 'idle');
        emit(run.id, { type: 'message', role: 'assistant', text });
        emit(run.id, { type: 'done', run: finished });
        settleWaiters(run.id, finished);
        return;
      }

      // ---- 1. input preparation -------------------------------------
      let rawInput = run.inputText ?? '';
      let reading = null;
      let journalSources = null;
      if (task?.kind === 'reading' && task.projectId) {
        try {
          reading = readingService.prepare(task.projectId, { task });
        } catch (error) {
          throw error;
        }
        if (reading.finished) {
          const text = `《${reading.project.name}》已读完全部 ${reading.total} 章，暂无新的章节可读。`;
          repo.messages.add({ conversationId: conversation.id, runId: run.id, role: 'assistant', text });
          const finished = repo.runs.update(run.id, {
            status: 'succeeded',
            phase: 'done',
            finishedAt: now(),
            outputText: text,
            businessDone: true,
          });
          repo.conversations.touch(conversation.id, 'idle');
          emit(run.id, { type: 'done', run: finished });
          settleWaiters(run.id, finished);
          return;
        }
        rawInput = reading.input;
      }
      if (task?.kind === 'journal') {
        const journalDay = dayKey(run.meta?.trigger?.scheduledFor ?? run.queuedAt, defaultTimezone());
        releaseJournalDay = await lockJournalDay(journalDay);
        const cursor = parseJournalCursor(repo.syncMeta(`journal.cursor.${journalDay}`));
        journalSources = dailyJournalSources(repo, journalDay, defaultTimezone(), cursor);
        const existing = repo.documents.list({ category: 'diary' }).find(document => document.title.includes(journalDay));
        if (existing && !journalSources.included && !journalSources.truncated) {
          run = repo.runs.update(run.id, { status: 'succeeded', phase: 'done', finishedAt: now(),
            businessDone: true, outputText: '当日已有日记，暂无新增可写材料',
            meta: { ...run.meta, documentSlug: existing.slug } });
          repo.runs.addStep(run.id, 'note', '日记无需续记', `${journalDay} 的新资料为零，保留原文档`);
          repo.conversations.touch(conversation.id, 'idle');
          emit(run.id, { type: 'done', run });
          settleWaiters(run.id, run);
          return;
        }
      }

      // ---- 2. context assembly --------------------------------------
      // Short-term memory content lives in text files; pick up an edit made since
      // the last run before the compiler reads the blocks.
      try {
        syncFromFiles(repo, paths, log);
      } catch (error) {
        log?.warn(`syncing short-term memory files before this run failed: ${error.message}`);
      }
      const contextRecord = task?.contextId ? repo.contexts.get(task.contextId) : repo.contexts.get(ensureDefaultContext().id);
      if (task?.contextId && !contextRecord) {
        throw Object.assign(new Error(`上下文方案 ${task.contextId} 不存在`), { code: 'CONTEXT_NOT_FOUND' });
      }
      const contextConfig = contextRecord?.config ?? {};
      const authority = run.meta?.authority ?? (task ? 'task' : 'owner');

      // The daily scheduler finalizes the old session before changing its id.
      // A business turn never clears the binding merely because the date moved.
      const today = dayKey(now(), defaultTimezone());
      let sessionId = conversation.sessionId;
      log?.info(
        `session rotation check: rule=${settings.get('runtime.sessionRotation')} ` +
          `sessionDay=${conversation.meta?.sessionDay ?? 'none'} today=${today} session=${sessionId ?? 'none'}`,
      );
      const oldFrame = conversation.meta?.contextFrame;
      const priorAuthority = conversation.meta?.sessionDelivery?.authority ??
        (oldFrame?.snapshotId ? repo.contexts.snapshotById(oldFrame.snapshotId)?.resolved?.authority : null);
      if (sessionId && priorAuthority && priorAuthority !== authority) {
        repo.runs.addStep(run.id, 'note', '权限变化，换新会话', '原物理会话的权限框架与本轮不同，重新建立独立上下文');
        conversation = repo.conversations.update(conversation.id, {
          sessionId: null,
          meta: { ...conversation.meta, previousSessionId: sessionId, contextFrame: null },
        });
        sessionId = null;
      }
      let resume = Boolean(sessionId);
      // Captured before the retry ladder can flip `resume`: a new physical
      // session is the one chance to deliver the session-scoped history
      // materials (short-term memory) into the conversation.
      const firstRunOfSession = !resume ||
        conversation.meta?.contextFrame?.sessionId !== sessionId ||
        conversation.meta?.sessionDelivery?.sessionId !== sessionId;
      if (!sessionId) {
        sessionId = `yu-${conversation.id}-${Date.now().toString(36)}`;
        conversation = repo.conversations.update(conversation.id, {
          sessionId,
          meta: { ...conversation.meta, sessionDay: today },
        });
      }

      if (conversation.meta?.memorySyncSession !== sessionId && memoryService.requireSync && memoryService.firstSessionSyncEnabled?.() !== false && !conversation.meta?.maintenance) {
        repo.runs.addStep(run.id, 'note', '同步记忆', '等待独立维护会话完成后注入');
        try {
          const synced = await memoryService.requireSync({ trigger: 'new-session', runId: run.id, stopSignal: signal });
          if (!['published','noop'].includes(synced.status)||synced.warnings?.length)recordMemoryWarning(run,'new-session',synced);
        } catch(error) {
          if(signal?.aborted)throw error;
          recordMemoryWarning(run,'new-session',null,error);
        }
        conversation = repo.conversations.update(conversation.id, {meta:{...conversation.meta,memorySyncSession:sessionId}});
      }

      // ---- 2b. context frame, compiled once per physical session ------
      // The system prompt travels with every request, so the whole frame is
      // compiled once when the session is created and replayed verbatim until it
      // rotates. That is what makes the prompt byte-identical inside one
      // conversation — and why editing anything (persona, memory, an injected
      // section) takes effect at the next session, not mid-chat.
      //
      // Two escape hatches keep a selected section live: the section registry
      // marks one `scope: turn`, or a context profile lists its name in
      // `turnSections`. Both feed the same list below.
      const frameRef = conversation.meta?.contextFrame ?? null;
      const frame =
        settings.get('runtime.contextMode') !== 'turn' && frameRef && frameRef.sessionId === sessionId
          ? repo.contexts.snapshotById(frameRef.snapshotId)
          : null;
      const hasFrame = Boolean(frame?.resolved?.sections);
      // Everything is session-scoped by default: one conversation, one frame, from
      // start to finish. The registry's `turn` sections and the profile's
      // `turnSections` are the per-turn hook; either one keeps a section live.
      const profileTurnSections = Array.isArray(contextConfig.turnSections) ? contextConfig.turnSections : [];
      const turnSections = [...new Set([...profileTurnSections, ...registryTurnNames(settings)])];
      const frozenSections = hasFrame ? frame.resolved.sections ?? [] : null;

      let compiled = compileContext({
        repo,
        settings,
        models,
        contextConfig,
        task,
        conversation,
        input: rawInput,
        runId: run.id,
        cwd: contextConfig.cwd || paths.dataDir,
        dryRun: false,
        // Live description of the harness she is running inside.
        selfModel: typeof selfModel === 'function' ? selfModel() : null,
        frozenSections,
        turnSections,
        skipRetrieval: hasFrame && !turnSections.includes('yu:retrieved'),
        retrievalDelivery: conversation.meta?.retrievalDelivery?.sessionId === sessionId &&
          conversation.meta.retrievalDelivery.authority === authority ? conversation.meta.retrievalDelivery : null,
        recordRetrieval: false,
      });

      if (hasFrame) {
        repo.runs.addStep(
          run.id,
          'note',
          '上下文：沿用会话开头那一份',
          `${frameRef.snapshotId}，建于 ${new Date(frameRef.at).toLocaleString('zh-CN', {
            timeZone: settings.get('runtime.timezone'),
            hour12: false,
          })}；${turnSections.length ? `${turnSections.join('、')} 这几段每轮重读` : '整份逐字沿用，不重读'}`,
        );
      } else {
        repo.runs.addStep(run.id, 'note', '上下文：本次会话第一次拼', '规则、记忆、检索都在这一轮读出，之后整段对话沿用这一份');
      }

      const blocking = compiled.problems.filter((p) =>
        ['MODEL', 'CONTEXT_OVER_LIMIT', 'PROMPT_FILE_MISSING'].includes(p.code),
      );
      if (blocking.length) {
        throw Object.assign(new Error(blocking.map((p) => p.message).join('; ')), { code: blocking[0].code });
      }

      // Authority is decided by the channel (owner / guest / group), not by the
      // model guessing from wording. A guest keeps the conversation but loses the
      // tools that would let them rewrite Yu's tasks, memory or settings.
      const inheritedResources=resolveResourcePolicy(task?.toolPolicy, contextConfig.tools);
      const catalog=resourceCatalogProvider?.();
      const resourceGrants=catalog?Object.fromEntries(['packages','sources'].map(key=>[key,inheritedResources[key] ?? catalog[key].filter(r=>r.active).map(r=>({id:r.id,operations:r.operations.map(o=>o.name)}))])):null;
      const effectivePolicy = {...compiled.toolPolicy, ...inheritedResources,...(resourceGrants?{resourceGrants}:{})};
      const toolPolicy = authority === 'guest' ? guestToolPolicy(effectivePolicy) : effectivePolicy;

      let snapshotId = repo.contexts.snapshot({
        runId: run.id,
        conversationId: conversation.id,
        contextId: contextRecord.id,
        contextVersion: contextRecord.currentVersion,
        resolved: {
          ...compiled,
          toolPolicy,
          toolEnforcement: { requested: toolPolicy, verified: false },
          authority,
          frozenFrom: hasFrame ? frameRef.snapshotId : null,
          reading: reading ? { chapter: reading.chapter.index, title: reading.chapter.title } : null,
        },
      });
      if (!hasFrame) {
        conversation = repo.conversations.update(conversation.id, {
          meta: { ...conversation.meta, contextFrame: { sessionId, snapshotId, at: now() } },
        });
      }
      run = repo.runs.update(run.id, { contextSnapshotId: snapshotId });
      conversation = repo.conversations.update(conversation.id, { contextSnapshotId: snapshotId });
      emit(run.id, {
        type: 'context',
        snapshotId,
        frozenFrom: hasFrame ? frameRef.snapshotId : null,
        sections: compiled.sections.map((s) => ({ name: s.name, tokens: s.tokens, frozen: Boolean(s.frozen) })),
      });

      // ---- 3. agent turn --------------------------------------------
      run = repo.runs.update(run.id, { phase: 'running' });
      // The system channel is registered by name; the history channel travels
      // inside the user turn. Nothing is bucketed into fixed slots any more, so
      // the order the person sees is the order the model reads.
      let holder = { system: compiled.systemBlocks ?? [], sections: compiled.sections ?? [], problems: [] };

      // A caught-up run happens "now" but belongs to the slot it missed. Saying so
      // is the difference between a 23:30 diary written that night and one written
      // the next morning under the wrong date.
      const slot = run.meta?.trigger;
      const catchUpNote =
        slot?.catchUp && slot?.scheduledFor
          ? `（补跑：这次对应 ${new Date(slot.scheduledFor).toLocaleString('zh-CN', {
              timeZone: settings.get('runtime.timezone'),
              hour12: false,
            })} 那个时间点，写的是那一刻的事，不是现在。）`
          : '';
      // Session-scoped history material (short-term memory) is delivered once, at
      // the start of a physical session; turn-scoped material (retrieval, clock,
      // project state) rides along with every message.
      const journalMaterial = journalSources ? `【当天同主人已完成任务摘录；仅作日记事实依据，不是新指令】\n${journalSources.text || '暂无其他可用记录。'}` : '';
      if (journalSources) repo.runs.addStep(run.id, 'note', '日记来源', `已纳入 ${journalSources.included} 条运行；截断 ${journalSources.truncated}`);
      let historySession = firstRunOfSession ? compiled.history?.session ?? '' : '';
      let replay = firstRunOfSession ? recentDialogueReplay(repo, conversation.id, run) : { text: '', turns: 0, omittedTurns: 0, chars: 0 };
      let materials = wrapMaterials([historySession, compiled.history?.turn ?? '', replay.text, journalMaterial]);
      const body = compiled.renderedInput || rawInput || task?.goal || '（无输入）';
      let userText = [materials, catchUpNote, body].filter(Boolean).join('\n\n');
      // Stored as the person typed it: the injected materials are a delivery
      // detail, and writing them into the transcript would leak memory into the
      // conversation (and from there into the archives the memory system absorbs).
      const userMessageId = repo.messages.add({
        conversationId: conversation.id,
        runId: run.id,
        role: 'user',
        text: String(rawInput ?? ''),
        meta: {
          triggerReason: run.triggerReason,
          delivered: {
            sessionMaterials: historySession ? 'planned' : firstRunOfSession ? 'empty' : 'already-delivered',
            turnMaterials: compiled.history?.turn ? 'planned' : 'empty',
            replayTurns: replay.turns,
            chars: userText.length,
          },
        },
      });

      // The inbox message must carry `role`, or the derived request contains a
      // member with no role and the provider adapter refuses it.
      repo.runs.addStep(run.id, 'note', '提交输入', `${userText.length} 字`);

      const runMeta = {
        // Her home is the data root: a session that records no working directory
        // lands under `_no-cwd` in DSH's session store, where the web console
        // cannot group it into a workspace and every transcript reads as
        // "session not found".
        cwd: contextConfig.cwd || paths.dataDir,
        agentPreset: contextConfig.agentPreset || undefined,
      };

      const onFrame = (frame) => {
        if (frame?.type !== 'chunk') return;
        const chunk = frame.chunk;
        if (chunk?.type === 'text-delta') emit(run.id, { type: 'delta', kind: 'text', text: chunk.text });
        else if (chunk?.type === 'reasoning-delta') emit(run.id, { type: 'delta', kind: 'reasoning', text: chunk.text });
        else if (chunk?.type === 'tool-call-delta' && chunk.name) {
          emit(run.id, { type: 'tool', name: chunk.name });
        }
      };

      let summary;
      const deadline = Math.min(task?.maxRuntimeMs ?? 900_000, settings.get('runtime.maxRunMinutes') * 60_000 * 4);
      const startTurn = (sid, resuming) =>
        agentHost.runTurn({
          sessionId: sid,
          resume: resuming,
          route: compiled.route,
          meta: runMeta,
          policy: toolPolicy,
          onPolicy: (state) => repo.contexts.recordToolEnforcement(snapshotId, state),
          holder,
          input: userText,
          timeoutMs: deadline,
          stopSignal: signal,
          onFrame,
        });
      const newSession = () => {
        const previousSessionId = sessionId;
        const freshId = `yu-${conversation.id}-${Date.now().toString(36)}`;
        // A rebuilt session inside the same run keeps the frame it started with;
        // the reference moves with it so the next run reuses instead of
        // recompiling and drifting mid-conversation.
        const meta = { ...conversation.meta };
        if (meta.contextFrame) meta.contextFrame = { ...meta.contextFrame, sessionId: freshId };
        // A sync attempt already covered this turn. A retry that replaces the
        // physical session must not schedule the same maintenance next turn.
        if (meta.memorySyncSession === previousSessionId) meta.memorySyncSession = freshId;
        conversation = repo.conversations.update(conversation.id, { sessionId: freshId, status: 'running', meta });
        sessionId = freshId;
        // The previous request was built for a different physical transcript.
        // Re-plan both memory lanes and the bounded dialogue excerpt for this
        // empty session; the current user message itself is never replayed.
        compiled = compileContext({
          repo, settings, models, contextConfig, task, conversation, input: rawInput,
          runId: run.id, cwd: contextConfig.cwd || paths.dataDir, dryRun: false,
          selfModel: typeof selfModel === 'function' ? selfModel() : null,
          frozenSections, turnSections,
          skipRetrieval: hasFrame && !turnSections.includes('yu:retrieved'),
          retrievalDelivery: null, recordRetrieval: false,
        });
        const retryBlocking = compiled.problems.filter(problem =>
          ['MODEL', 'CONTEXT_OVER_LIMIT', 'PROMPT_FILE_MISSING'].includes(problem.code));
        if (retryBlocking.length) throw Object.assign(
          new Error(retryBlocking.map(problem => problem.message).join('; ')),
          { code: retryBlocking[0].code },
        );
        holder = { system: compiled.systemBlocks ?? [], sections: compiled.sections ?? [], problems: [] };
        historySession = compiled.history?.session ?? '';
        replay = recentDialogueReplay(repo, conversation.id, run);
        materials = wrapMaterials([historySession, compiled.history?.turn ?? '', replay.text, journalMaterial]);
        userText = [materials, catchUpNote, compiled.renderedInput || rawInput || task?.goal || '（无输入）'].filter(Boolean).join('\n\n');
        snapshotId = repo.contexts.snapshot({
          runId: run.id, conversationId: conversation.id, contextId: contextRecord.id,
          contextVersion: contextRecord.currentVersion,
          resolved: { ...compiled, toolPolicy, toolEnforcement: { requested: toolPolicy, verified: false },
            authority, frozenFrom: hasFrame ? frameRef.snapshotId : null,
            reading: reading ? { chapter: reading.chapter.index, title: reading.chapter.title } : null },
        });
        conversation = repo.conversations.update(conversation.id, {
          contextSnapshotId: snapshotId,
          meta: { ...conversation.meta, contextFrame: { sessionId: freshId, snapshotId, at: now() } },
        });
        run = repo.runs.update(run.id, { contextSnapshotId: snapshotId });
        repo.messages.updateMeta(userMessageId, {
          triggerReason: run.triggerReason,
          delivered: { sessionMaterials: historySession ? 'planned' : 'empty',
            turnMaterials: compiled.history?.turn ? 'planned' : 'empty',
            replayTurns: replay.turns, chars: userText.length },
        });
        repo.runs.addStep(run.id, 'note', '重建会话补发材料', `近期对话 ${replay.turns} 轮、短期 ${historySession.length} 字、长期候选 ${compiled.retrievalDelivery?.selectedIds.length ?? 0} 条；总输入 ${userText.length} 字`);
        return freshId;
      };

      // Retry ladder, in the order a real failure needs it:
      //   transport / serialization → transient: wait, then try again (a poisoned
      //                               session is dropped first);
      //   "already owned"           → wait for the previous holder to let go,
      //                               keeping the transcript instead of churning;
      //   stale/unreadable session  → rebuild once, keeping the conversation.
      const waits = [2_000, 5_000, 10_000];
      let attempts = 0;
      let transientRetries = 0;
      let ownedRetries = 0;
      for (;;) {
        attempts += 1;
        if (attempts > 8) throw Object.assign(new Error('同一轮重试太多次，停止'), { code: 'RETRY_EXHAUSTED' });
        try {
          summary = await startTurn(sessionId, resume);
          break;
        } catch (error) {
          const message = String(error?.message ?? '');
          const owned = /already owned|active write handle/i.test(message);
          const resumable = /not found|no such|NOT_FOUND|unknown session|failed validation|lacks an identified|could not be (read|resumed)|corrupt/i.test(message);
          const transient = /transport failed|non-JSON-serializable|ECONNRESET|socket hang up|fetch failed|EPIPE/i.test(message);

          if (transient && transientRetries < 2) {
            const wait = waits[transientRetries] ?? 10_000;
            transientRetries += 1;
            log?.warn(`transient turn failure on ${sessionId}: ${message}; retry in ${wait / 1000}s`);
            repo.runs.addStep(run.id, 'note', '暂时性失败，重试', `${message}（${wait / 1000} 秒后第 ${transientRetries} 次）`);
            await new Promise((resolve) => setTimeout(resolve, wait));
            if (/non-JSON-serializable/i.test(message)) {
              // The half-written session is the poisoned part: drop the live slot
              // and continue the conversation on a clean transcript.
              try {
                await agentHost.disposeSession(sessionId);
              } catch (disposeError) {
                log?.warn(`disposing ${sessionId} after a bad event failed: ${disposeError.message}`);
              }
              newSession();
              resume = false;
            }
            continue;
          }

          if (owned) {
            const budget = resume ? Math.min(3, waits.length) : 1;
            if (ownedRetries < budget) {
              const wait = resume ? waits[ownedRetries] ?? 10_000 : 2_000;
              ownedRetries += 1;
              log?.warn(`session ${sessionId} is owned: ${message}`);
              repo.runs.addStep(run.id, 'note', '会话被占用', `另一个持有者还没放手，${wait / 1000} 秒后重试（第 ${ownedRetries} 次）`);
              await new Promise((resolve) => setTimeout(resolve, wait));
              continue;
            }
            log?.warn(`session ${sessionId} still owned after retries; preserving binding`);
            repo.runs.addStep(run.id, 'error', '会话仍被占用', `保留原会话，稍后可重试：${message}`);
            throw Object.assign(new Error('会话仍被其他活动占用，已保留原会话；请稍后重试'), { code: 'SESSION_BUSY' });
          }

          if (resume && resumable) {
            log?.warn(`session ${sessionId} could not be resumed (${message}); rebuilding`);
            repo.runs.addStep(run.id, 'note', '会话重建', `原会话不可用，已开启新物理会话：${message}`);
            newSession();
            resume = false;
            continue;
          }

          throw error;
        }
      }

      if (holder.problems.length) {
        for (const problem of holder.problems) repo.runs.addStep(run.id, 'note', '上下文注册告警', problem);
      }

      // A dropped end frame does not prove the old transcript is unusable.
      // Keep its binding so the next run can resume rather than silently losing
      // context. Only a definite BLOCKED archived session gets rebuilt.
      let verdict = classifyTurn(summary);
      if (!verdict.ok && verdict.reason === 'BLOCKED' && !summary.timedOut && !signal.aborted) {
        log?.warn(`turn on ${sessionId} ended as ${verdict.reason}; retrying once on a new session`);
        repo.runs.addStep(
          run.id,
          'note',
          '回合没发出去，换新会话重试一次',
          `${verdict.reason}（${Math.round(summary.durationMs / 1000)} 秒）`,
        );
        try {
          await agentHost.disposeSession(sessionId);
        } catch (disposeError) {
          log?.warn(`disposing ${sessionId} before retry failed: ${disposeError.message}`);
        }
        newSession();
        summary = await startTurn(sessionId, false);
        verdict = classifyTurn(summary);
      }

      mirrorSession(sessionId);
      for (const call of summary.toolCalls ?? []) {
        repo.tools.recordCall({
          name: call.name ?? 'unknown',
          runId: run.id,
          sessionId,
          args: call.arguments,
          result: call.resultText ?? null,
          error: call.isError ? (call.error?.message ?? 'tool error') : null,
          ok: !call.isError,
        });
      }
      if (!verdict.ok) {
        run = repo.runs.update(run.id, { meta: { ...repo.runs.get(run.id).meta,
          contextDelivery: { status: 'unconfirmed', sessionId, replayTurns: replay.turns,
            sessionMaterialsChars: historySession.length,
            retrievalSelectedIds: compiled.retrievalDelivery?.selectedIds ?? [],
            retrievalOmittedIds: compiled.retrievalDelivery?.omittedIds ?? [] } } });
        repo.messages.updateMeta(userMessageId, { triggerReason: run.triggerReason,
          delivered: { status: 'unconfirmed', sessionMaterials: historySession ? 'unconfirmed' : 'empty',
            turnMaterials: compiled.history?.turn ? 'unconfirmed' : 'empty', replayTurns: replay.turns, chars: userText.length } });
        mirrorSession(sessionId);
        const note = summary.assistantText
          ? `${summary.assistantText}\n\n（本次运行未完成：${verdict.failure}）`
          : `（本次运行没有产出回复：${verdict.failure}）`;
        repo.messages.add({
          conversationId: conversation.id,
          runId: run.id,
          role: 'assistant',
          text: note,
          blocks: summary.parts ?? [],
          meta: { usage: summary.usage ?? {}, turnEnd: summary.turnEnd ?? null, failed: true },
        });
        const finished = repo.runs.update(run.id, {
          status: verdict.status === 'canceled' ? 'canceled' : verdict.status === 'interrupted' ? 'interrupted' : 'failed',
          phase: 'done',
          sessionId,
          finishedAt: now(),
          outputText: summary.assistantText ?? '',
          usage: summary.usage ?? {},
          businessDone: false,
          archiveDone: false,
          memoryDone: false,
          errorCode: verdict.reason,
          errorMessage: verdict.failure,
        });
        repo.runs.addStep(run.id, 'error', verdict.reason, verdict.failure);
        repo.conversations.touch(conversation.id, 'idle');
        emit(run.id, { type: 'error', code: verdict.reason, message: verdict.failure });
        emit(run.id, { type: 'done', run: finished });
        settleWaiters(run.id, finished);
        return;
      }

      // ---- 4. business commit ---------------------------------------
      try {
        conversation = commitRetrievalDelivery(repo, conversation.id, sessionId, authority, compiled.retrievalDelivery?.versions ?? []);
        if (compiled.retrievalDelivery?.selectedIds?.length) repo.memories.recordRetrieval({
          query: rawInput, conversationId: conversation.id, runId: run.id,
          memoryIds: compiled.retrievalDelivery.selectedIds,
          meta: { count: compiled.retrievalDelivery.selectedIds.length, scope: 'delivered' },
        });
      } catch (error) {
        log?.warn(`recording context delivery for ${run.id} failed: ${error.message}`);
        repo.runs.addStep(run.id, 'note', '上下文记录告警', error.message);
      }
      // A frame can be persisted before the model accepts a turn. Only a
      // completed turn proves that this physical transcript has its session
      // material; after a failed first turn the next run must send it again.
      conversation = repo.conversations.update(conversation.id, {
        meta: { ...repo.conversations.get(conversation.id).meta,
          sessionDelivery: { sessionId, authority, runId: run.id, at: now() } },
      });
      run = repo.runs.update(run.id, { meta: { ...repo.runs.get(run.id).meta,
        contextDelivery: { status: 'sent', sessionId, replayTurns: replay.turns,
          replayOmittedTurns: replay.omittedTurns, sessionMaterialsChars: historySession.length,
          retrievalSelectedIds: compiled.retrievalDelivery?.selectedIds ?? [],
          retrievalOmittedIds: compiled.retrievalDelivery?.omittedIds ?? [],
          refreshAfterTurns: compiled.retrievalDelivery?.refreshAfterTurns ?? null } } });
      repo.messages.updateMeta(userMessageId, { triggerReason: run.triggerReason,
        delivered: { status: 'sent', sessionMaterials: historySession ? 'delivered' : 'empty',
          turnMaterials: compiled.history?.turn ? 'delivered' : 'empty', replayTurns: replay.turns, chars: userText.length } });
      repo.runs.addStep(run.id, 'note', '上下文实际交付', `近期对话 ${replay.turns} 轮、短期 ${historySession.length} 字、长期 ${compiled.retrievalDelivery?.selectedIds.length ?? 0} 条；省略已交付 ${compiled.retrievalDelivery?.omittedIds.length ?? 0} 条`);
      const replyText = summary.assistantText || '（模型没有返回文本）';
      repo.messages.add({
        conversationId: conversation.id,
        runId: run.id,
        role: 'assistant',
        text: replyText,
        blocks: summary.parts ?? [],
        meta: { usage: summary.usage ?? {}, turnEnd: summary.turnEnd ?? null, timedOut: summary.timedOut },
      });

      let businessNote = null;
      if (task?.kind === 'journal') {
        try {
          run = repo.runs.update(run.id, { meta: { ...repo.runs.get(run.id).meta, journalSourceCursor: journalSources.cursor } });
          const document = persistJournal({ repo, run, text: summary.assistantText });
          run = repo.runs.update(run.id, { meta: { ...run.meta, documentSlug: document.slug } });
          repo.runs.addStep(run.id, 'note', '日记文档已保存', document.slug);
        } catch (error) {
          businessNote = error;
          repo.runs.addStep(run.id, 'error', '日记文档未保存', error.message);
        }
      }
      if (reading) {
        try {
          readingService.commit({
            projectId: task.projectId,
            runId: run.id,
            chapter: reading.chapter,
            note: replyText,
            sourceSha: reading.sourceSha,
            expectedRevision: reading.state.revision,
          });
          repo.runs.addStep(run.id, 'note', '阅读进度已推进', `第 ${reading.progress + 1} / ${reading.total} 章`);
        } catch (error) {
          businessNote = error;
          repo.runs.addStep(run.id, 'error', '阅读进度未推进', `${error.code ?? ''} ${error.message}`);
        }
      }

      run = repo.runs.update(run.id, {
        phase: 'archive',
        sessionId,
        outputText: replyText,
        usage: summary.usage ?? {},
        businessDone: !businessNote,
        errorCode: businessNote ? businessNote.code : null,
        errorMessage: businessNote ? businessNote.message : null,
      });
      emit(run.id, {
        type: 'message',
        role: 'assistant',
        text: replyText,
        usage: summary.usage ?? {},
        turnEnd: summary.turnEnd ?? null,
        timedOut: summary.timedOut ?? false,
      });

      // ---- 5. archive -----------------------------------------------
      // A guest's chat is still a conversation she answers, but it must not flow
      // into his memory: a stranger's "晚安" is not a fact about him.
      const archivePolicy = task?.archivePolicy ?? { mode: 'on-complete', minChars: 40, keepToolOutputs: true };
      const shouldArchive =
        authority !== 'guest' &&
        (archivePolicy.mode === 'always' ||
          (archivePolicy.mode === 'on-complete' && replyText.trim().length >= (archivePolicy.minChars ?? 0)));
      let archive = null;
      if (shouldArchive) {
        archive = archiveService.archiveRun({
          run,
          task,
          conversation,
          summary,
          compiled,
          events: agentHost.readEvents(sessionId, summary.fromSeq ?? 0),
          fromSeq: summary.fromSeq ?? 0,
          toSeq: summary.toSeq ?? 0,
        });
        run = repo.runs.update(run.id, { phase: 'memory', archiveDone: true });
        repo.runs.addStep(run.id, 'note', '已归档', archive.id);
        emit(run.id, { type: 'archive', archiveId: archive.id });
      } else {
        run = repo.runs.update(run.id, { phase: 'memory' });
      }

      // Archived material is consumed by the visible session/nightly sync rules.
      repo.runs.update(run.id, { memoryDone: false });

      const finalStatus = businessNote ? 'failed' : 'succeeded';
      if(!businessNote && task?.archivePolicy?.conversation==='on-success') {
        try {
          const synced=await memoryService.requireSync({trigger:'session-end',runId:run.id,stopSignal:signal});
          if(synced?.status==='failed'||synced?.warnings?.length)recordMemoryWarning(run,'session-end',synced);
          repo.runs.update(run.id,{memoryDone:synced?.status==='published'});
        } catch(error) {
          if(signal?.aborted)throw error;
          recordMemoryWarning(run,'session-end',null,error);
        }
      }
      // Maintenance runs while this conversation is still locked; the next
      // queued turn cannot race the checkpoint or close the session underneath it.
      if (!businessNote && task?.archivePolicy?.conversation === 'on-success') {
        let releaseClosing = null;
        try {
          releaseClosing = repo.conversations.beginClosing(conversation.id);
          conversation = repo.conversations.get(conversation.id);
          const shared = run.meta?.boundExplicitly || task.conversationMode !== 'new' || conversation.meta?.ownerTaskId !== task.id ||
            repo.tasks.list().some((other) => other.conversationMode === 'reuse' && other.conversationId === conversation.id) ||
            queue.some((id) => repo.runs.get(id)?.conversationId === conversation.id);
          if (shared) throw new Error('会话已共享，保留会话，未自动关闭');
          archiveService.archiveConversationTail({ conversation });
          const registry = ctx.get?.('workspaceRegistry');
          if (!registry?.archiveSession) throw new Error('宿主不支持关闭会话，保留原状态');
          await agentHost.disposeSession(sessionId);
          await registry.archiveSession(sessionId, { stopActivity: false });
          const latest = repo.conversations.get(conversation.id);
          repo.conversations.update(conversation.id, { sessionId: null, meta: { ...latest.meta, contextFrame: null, sessionDay: null, previousSessionId: sessionId } });
          conversation = repo.conversations.archive(conversation.id, summary.toSeq ?? 0);
          repo.runs.addStep(run.id, 'note', '临时会话已自动关闭', conversation.id);
        } catch (error) {
          repo.runs.addStep(run.id, 'error', '自动关闭未完成', error.message);
        } finally {
          releaseClosing?.();
        }
      } else if (!businessNote && agentHost.maintainContinuity) {
        const current = repo.conversations.get(conversation.id);
        const state = await agentHost.maintainContinuity(sessionId, current.meta?.continuity ?? {}, current.meta?.continuityState, signal);
        const latest = repo.conversations.get(conversation.id);
        conversation = repo.conversations.update(conversation.id, { meta: { ...latest.meta, continuityState: state } });
        repo.runs.addStep(run.id, 'note', '上下文摘要接续', JSON.stringify(state));
      }
      if (!businessNote && agentHost.measureSessionPressure && task?.kind !== 'maintenance') {
        const ratio = Number(settings.get('runtime.sessionPressureRatio') ?? 0.7);
        const pressure = await agentHost.measureSessionPressure(sessionId, ratio, signal);
        repo.runs.addStep(run.id, 'note', '会话容量检查', JSON.stringify(pressure));
        if (pressure.status === 'due') {
          const latest = repo.conversations.get(conversation.id);
          conversation = repo.conversations.update(conversation.id, { meta: { ...latest.meta,
            rolloverDue: { sessionId, reason: 'pressure', pressureTokens: pressure.pressureTokens,
              thresholdTokens: pressure.thresholdTokens, at: now() } } });
        }
      }
      if (finalStatus === 'succeeded' && run.meta?.source !== 'message' && run.meta?.deliveryTarget?.mode === 'onebot') {
        const delivery = await deliverOutput?.({...run.meta.deliveryTarget,text:replyText});
        run = repo.runs.update(run.id,{meta:{...run.meta,delivery:delivery??{status:'unavailable'}}});
      }
      const finished = repo.runs.update(run.id, {
        status: finalStatus,
        phase: 'done',
        finishedAt: now(),
      });
      if (!conversation.archivedAt) repo.conversations.touch(conversation.id, 'idle');
      emit(run.id, { type: 'done', run: finished });
      settleWaiters(run.id, finished);
      if (conversation.meta?.rolloverDue?.sessionId === sessionId) enqueueRollover(conversation.id, 'pressure');
    } catch (error) {
      if (error instanceof ReadingError || error?.name === 'ReadingError') {
        const finished = failRun(run, conversation, error, { code: error.code });
        return finished;
      }
      if (signal?.aborted) {
        const canceled = Object.assign(new Error('运行已被停止'), { code: 'CANCELED' });
        failRun(run, conversation, canceled, { code: 'CANCELED' });
        return;
      }
      failRun(run, conversation, error);
    } finally {
      releaseJournalDay?.();
    }
  };

  // ----------------------------------------------------------------- stop
  const stop = (runId) => {
    const run = repo.runs.get(runId);
    if (!run) return { ok: false, error: 'run not found' };
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(run.status)) {
      return { ok: false, error: `run already finished (${run.status})` };
    }
    if(run.meta?.memorySyncWait){
      const queued=run.status==='queued';
      repo.runs.update(runId,{status:queued?'canceled':'stopping',phase:queued?'done':run.phase,stopRequestedAt:now(),...(queued?{finishedAt:now(),errorCode:'CANCELED_BEFORE_START',errorMessage:'同步在开始前被停止'}:{})});
      return {ok:true,status:queued?'canceled':'stopping'};
    }
    const queuedIndex = queue.indexOf(runId);
    if (queuedIndex >= 0) {
      queue.splice(queuedIndex, 1);
      const canceled = repo.runs.update(runId, {
        status: 'canceled',
        phase: 'done',
        finishedAt: now(),
        stopRequestedAt: now(),
        errorCode: 'CANCELED_BEFORE_START',
        errorMessage: '运行在开始前被停止，没有产生任何副作用',
      });
      repo.runs.addStep(runId, 'lifecycle', '已停止（未开始）', '排队中被取消');
      emit(runId, { type: 'done', run: canceled });
      settleWaiters(runId, canceled);
      return { ok: true, status: 'canceled' };
    }
    const slot = active.get(runId);
    if (!slot) return { ok: false, error: 'run is not active' };
    repo.runs.update(runId, { status: 'stopping', stopRequestedAt: now() });
    repo.runs.addStep(runId, 'lifecycle', '收到停止请求', '正在取消当前模型请求');
    emit(runId, { type: 'status', status: 'stopping' });
    slot.abort.abort();
    return { ok: true, status: 'stopping' };
  };

  // ---------------------------------------------------------------- chat
  const chat = async ({ conversationId = null, text, source = 'web', onDelta = null }) => {
    if (conversationId) {
      const target = repo.conversations.get(conversationId);
      if (!target || target.archivedAt) throw new Error('所选会话不存在或已归档，请先恢复或重新选择');
      repo.conversations.assertBindable(target.id);
    }
    if (stopped) throw new Error('runner is stopped');
    let conversation = conversationId ? repo.conversations.get(conversationId) : null;
    if (!conversation) {
      conversation = repo.conversations.create({
        title: truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), 40) || '网页对话',
        kind: 'web',
      });
    }
    const run = repo.runs.create({
      taskId: null,
      triggerId: null,
      triggerReason: '网页对话',
      conversationId: conversation.id,
      inputText: text,
      meta: { source },
    });
    if (rolloverReason(conversation, now(), defaultTimezone(), settings.get('runtime.sessionRotation')))
      enqueueRollover(conversation.id);
    queue.push(run.id);
    const done = waitForRun(run.id);
    const unsubscribe = onDelta
      ? subscribeRun(run.id, (event) => {
          if (event.type === 'delta') onDelta(event);
          else if (event.type === 'message') onDelta(event);
          else if (event.type === 'error') onDelta(event);
          else if (event.type === 'done') onDelta(event);
        })
      : null;
    setImmediate(() => void pump());
    return { conversation, run, done, unsubscribe };
  };

  // -------------------------------------------------------------- recover
  const recoverOnBoot = () => {
    const report = { interrupted: [], requeued: [], canceled: [] };
    for (const run of repo.runs.unfinished()) {
      if (run.status === 'queued') {
        const task = run.taskId ? repo.tasks.get(run.taskId) : null;
        if (run.taskId && (!task || !task.enabled)) {
          repo.runs.update(run.id, {
            status: 'canceled',
            phase: 'done',
            finishedAt: now(),
            errorCode: 'CANCELED_TASK_DISABLED',
            errorMessage: '重启时任务已停用，排队运行被取消（未执行）',
          });
          report.canceled.push(run.id);
          continue;
        }
        if (report.requeued.length >= 5) {
          repo.runs.update(run.id, {
            status: 'canceled',
            phase: 'done',
            finishedAt: now(),
            errorCode: 'CANCELED_QUEUE_LIMIT',
            errorMessage: '重启后排队运行超过上限，本条未重新排队',
          });
          report.canceled.push(run.id);
          continue;
        }
        queue.push(run.id);
        report.requeued.push(run.id);
        continue;
      }
      // running / stopping / interrupted: never re-execute.
      const hadBusiness = run.businessDone;
      repo.runs.update(run.id, {
        status: 'interrupted',
        phase: 'done',
        finishedAt: run.finishedAt ?? now(),
        errorCode: hadBusiness ? 'BUSINESS_COMMITTED_EXECUTION_INTERRUPTED' : 'EXECUTION_INTERRUPTED',
        errorMessage: hadBusiness
          ? '进程中断：业务结果已提交，归档或记忆收尾未完成。可在任务详情中重新归档。'
          : '进程中断：该运行没有提交业务结果，未产生副作用；不会自动重跑。',
      });
      repo.runs.addStep(run.id, 'lifecycle', '进程中断', '重启恢复：标记为中断，不自动重跑');
      report.interrupted.push(run.id);
    }
    for (const conversation of repo.conversations.list({ status: 'running', limit: 500 })) {
      repo.conversations.update(conversation.id, { status: 'idle' });
    }
    // Conversations that predate daily rotation have a session but no day stamp.
    // Stamp them with today rather than rotating immediately: the session they
    // have is still the one this morning's messages went into.
    const today = dayKey(now(), defaultTimezone());
    for (const conversation of repo.conversations.list({ limit: 1000 })) {
      if (!lifecycleEligible(conversation)) continue;
      if (conversation.meta?.sessionDay) continue;
      repo.conversations.update(conversation.id, {
        meta: { ...conversation.meta, sessionDay: today },
      });
      report.stamped = (report.stamped ?? 0) + 1;
    }
    if (report.requeued.length) setImmediate(() => void pump());
    return report;
  };

  let stopPromise = null;
  const stopAll = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    for (const runId of [...queue]) stop(runId);
    for (const [runId, slot] of active) {
      slot.abort.abort();
      log?.info(`stopping run ${runId} on unload`);
    }
    stopPromise = Promise.all([...active.values()].map((slot) => slot.promise));
    return stopPromise;
  };

  return {
    enqueue,
    enqueueRollover,
    rolloverDue,
    chat,
    stop,
    stopAll,
    recoverOnBoot,
    subscribeRun,
    waitForRun,
    setSystemHandlers: (handlers) => Object.assign(systemHandlers, handlers),
    ensureDefaultContext,
    activeRuns: () => [...active.keys()],
    queuedRuns: () => [...queue],
    stats: () => ({
      active: active.size,
      queued: queue.length,
      maxParallel: settings.get('runtime.maxParallelRuns'),
      conversations: new Set([...active.values()].map((v) => v.conversationId)).size,
    }),
    relocateQueued: () => queue.length,
  };
}
