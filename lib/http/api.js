import {readSyncConfig,updateSyncConfig} from '../memory-sync-policy.js';
import { sanitizeDiagnostic } from '../diagnostic-redaction.js';
import { createResourceDependencies } from '../resource-dependencies.js';
import { readDefinitions, syncTriggerDefinitions } from '../trigger-definitions.js';
import { migrateInjectionFiles, readInjection, saveInjectionFiles, injectionHash } from '../injection-files.js';
import { randomUUID } from 'node:crypto';
import { previewContext, sectionEffect } from '../context-preview.js';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, openSse } from './router.js';
import { compileContext, formatDate } from '../context-compiler.js';
import { dayKey, addDays, startOfDay, zonedParts, truncate, now, humanDuration, parseJson } from '../util.js';
import { normalizeContextConfig } from '../repo.js';
import {
  readSections,
  normalizeSections,
  defaultSections,
  sectionName,
  turnSectionChoices,
  CHANNEL_LABELS,
  SYSTEM_BAND,
  wireOrder,
} from '../sections.js';
import { readMemoryRules } from '../memory-rules.js';
import { blockPath, relativeBlockPath, RELATIVE_DIR, previewFileImport, validateFileImport } from '../memory-files.js';
import { maskChannel, maskConfig } from '../channels/manager.js';
import { scanForInstalls, runningInstalls, inspectDir, launchersIn, launchInstall, waitForHttp, launcherLogTail, ensureQq, stopInstall } from '../channels/locator.js';

/**
 * The HTTP API.
 *
 * Handlers stay thin: they validate shape, call exactly one service, and return
 * data. Everything that decides behaviour lives in `lib/` so the same operations
 * are available to tasks, channels and tests.
 */
export function registerApi(router, app) {
  const {
    repo,
    settings,
    configFile,
    models,
    runner,
    agentHost,
    archiveService,
    memoryService,
    readingService,
    toolService,
    channelManager,
    alertService,
    mail,
    auth,
    httpService,
    capabilities,
    harness,
    paths,    log,
    version,
  } = app;

  const dependencies=createResourceDependencies(app);
  router.get('/api/onboarding',async()=>app.onboarding.read());
  for(const action of ['preview','apply','build'])router.post('/api/onboarding/'+action,async({body})=>{try{return await app.onboarding[action](body??{});}catch(error){throw new HttpError(400,'ONBOARDING_INVALID',error.message);}});
  router.get('/api/resources',async()=>dependencies.graph());
  router.get('/api/resources/:kind/:id/impact',async({params})=>sanitizeDiagnostic(dependencies.impact(params.kind,params.id),settings.spec.filter(s=>s.secret).map(s=>settings.get(s.key))));
  router.post('/api/resources/:kind/:id/change',async({params,body})=>{try{const result=dependencies.change(params.kind,params.id,body??{});app.scheduler.refreshAll();return result;}catch(error){throw new HttpError(error.status??400,error.code??'RESOURCE_INVALID',error.message);}});
  router.get('/api/memory/sync-config',async()=>readSyncConfig({db:{getMeta:key=>repo.syncMeta(key)},repo}));
  router.patch('/api/memory/sync-config',async({body})=>{
    const result=updateSyncConfig({db:{getMeta:key=>repo.syncMeta(key)},repo,settings},body??{});
    app.scheduler.refreshAll();return result;
  });
  const tz = () => settings.get('runtime.timezone');
  const adminUrl = () => settings.get('web.publicUrl') || httpService.url() || `http://127.0.0.1:${app.config.port}/`;

  // ------------------------------------------------------------- public
  router.get(
    '/api/health',
    async () => ({
      ok: true,
      service: 'yu',
      version,
      /** Console build identity: a page reloads itself when this changes. */
      build: httpService.buildId?.() ?? null,
      startedAt: app.startedAt,
      uptimeMs: now() - app.startedAt,
      harness: { version: harness.version, supported: app.compat.supported, source: harness.source },
      pairingPending: auth.pairingPending(),
    }),
    { public: true },
  );

  router.get(
    '/api/session',
    async ({ req }) => {
      const device = auth.deviceFromRequest(req);
      return {
        paired: Boolean(device),
        pairingPending: auth.pairingPending(),
        device: device ? { id: device.deviceId ?? device.id, label: device.label, expiresAt: device.expiresAt } : null,
        env: {
          version,
          harness: { version: harness.version, supported: app.compat.supported, reason: app.compat.reason },
          dataDir: paths.dataDir,
          dataRootSource: paths.source,
          adminUrl: adminUrl(),
          // A name the user gives this install, so two Yu's on one machine are
          // distinguishable in a glance instead of by port number.
          instanceLabel: settings.get('web.instanceLabel') || '',
          timezone: tz(),
          platform: process.platform,
          node: process.versions.node,
        },
      };
    },
    { public: true },
  );

  router.post(
    '/api/pair',
    async ({ req, res, body }) => {
      const code = body?.code;
      const result = auth.pair(req, res, code);
      return { ok: true, ...result };
    },
    { public: true },
  );

  router.post('/api/unpair', async ({ res }) => {
    auth.clearDeviceCookie(res);
    return { ok: true };
  }, { public: false });

  /**
   * Pairing bootstrap.
   *
   * The code is shown only to requests that arrive over loopback: that is the
   * machine the console belongs to, and a local process could already read the
   * 0600 code file or the database itself. A non-loopback caller gets no code and
   * cannot mint one, which is what keeps the pair window closed once Yu is
   * exposed beyond this machine.
   *
   * It also mints on demand for loopback callers even when devices exist, so a
   * lost browser cookie is recoverable from the settings page instead of needing
   * a command-line script.
   */
  router.get(
    '/api/pairing',
    async ({ req }) => {
      const devices = auth.activeDevices();
      const loopback = auth.isLoopback(req);
      const visible = loopback && settings.get('web.showPairingCode');
      let code = auth.pendingCode();
      let mintedNow = false;
      if (!code && visible) {
        auth.refreshPairCode('on-demand');
        code = auth.pendingCode();
        mintedNow = true;
      }
      const canShow = visible && Boolean(code);
      return {
        pairedDevices: devices,
        pendingCode: Boolean(code),
        showCode: canShow,
        code: canShow ? code : null,
        mintedNow,
        loopback,
        codeCreatedAt: auth.pendingCodeCreatedAt(),
        codeWrittenTo: paths.pairingCode,
        canMint: visible,
        hint: canShow
          ? '配对码已生成；点「用这个码登录」即可，10 分钟内有效。'
          : devices === 0
            ? '登录页不显示配对码：请读取数据根里的 pairing-code.txt。'
            : '当前请求不是从本机回环地址发起，Yu 不会在这里显示配对码。若你有已登录的设备，请在「设置 · 设备」生成新码。',
      };
    },
    { public: true },
  );

  router.post(
    '/api/pairing/code',
    async ({ req }) => {
      if (!auth.isLoopback(req)) {
        throw new HttpError(403, 'LOOPBACK_ONLY', '只有从本机回环地址发起的请求可以生成配对码');
      }
      const code = auth.refreshPairCode('on-demand');
      return { ok: true, code, codeWrittenTo: paths.pairingCode, codeLength: code.length };
    },
    { public: true },
  );

  // -------------------------------------------------------- environment
  router.get('/api/environment', async () => ({
    version,
    startedAt: app.startedAt,
    harness,
    compat: app.compat,
    capabilities: capabilities().list,
    degraded: capabilities().degraded,
    dataDir: paths.dataDir,
    dataRoot: {
      path: paths.dataDir,
      source: paths.source,
      bootstrap: paths.bootstrap,
      pointerFile: paths.pointerFile,
      logFile: log.logFile?.() ?? null,
    },
    database: { path: paths.db, schemaVersion: app.db.schemaVersion },
    urls: { admin: httpService.url(), harness: app.harnessUrl ?? null, publicUrl: settings.get('web.publicUrl') || null },
    harnessRoute: httpService.harnessState(),
    timezone: tz(),
    platform: { os: process.platform, arch: process.arch, node: process.versions.node, electron: process.versions.electron ?? null },
    runtime: runner.stats(),
    liveAgents: agentHost.aliveCount(),
  }));

  router.get('/api/diagnostics', async () => ({
    log: log.recent(200),
    capabilities: capabilities(),
    runner: runner.stats(),
    agentHost: { alive: agentHost.aliveCount() },
    channels: channelManager.status().map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      enabled: c.enabled,
      status: c.status,
      health: c.health,
      lastError: c.lastError,
    })),
    audit: repo.audit.list(50),
    knowledge: toolService.knowledgeStatus(),
    harness,
    clientModule: (() => {      // Whether the harness registered this package's browser module. Reading it
      // here is the only way to confirm the Settings page is in the boot graph
      // without holding the harness web token.
      try {
        const modules = app.ctx.get?.('clientModules');
        if (!modules?.clientPath) return { available: false, reason: 'ctx.clientModules.clientPath unavailable' };
        const modulePath = modules.clientPath('@yu/companion');
        const graph = modules.graph?.();
        const entry = (graph?.entries ?? []).find((row) => row.id === '@yu/companion') ?? null;
        // Compare the composed artifact with the file on disk: a page still
        // serving an old bundle is otherwise invisible from here.
        let onDisk = null;
        try {
          const stat = fs.statSync(modulePath);
          onDisk = { mtimeMs: stat.mtimeMs, size: stat.size };
        } catch {
          onDisk = null;
        }
        return {
          available: true,
          registered: Boolean(modulePath),
          path: modulePath ?? null,
          graphRev: graph?.rev ?? null,
          graphEntries: (graph?.entries ?? []).length,
          graphHasYu: Boolean(entry),
          rev: entry?.rev ?? null,
          onDisk,
          fresh: Boolean(entry && onDisk && String(entry.rev ?? '').length > 0),
        };
      } catch (error) {
        return { available: false, reason: error.message };
      }
    })(),
    requests: app.requestObserver.recent(20),
    requestFailures: app.requestObserver.failures(),
  }));

  /**
   * Replay the newest failed model request to recover the adapter's original
   * error. Purely diagnostic: the replay is a fresh request with a fresh
   * timeout signal, and it is recorded as a probe in the audit log.
   */
  router.post('/api/diagnostics/replay', async ({ body }) => {
    const result = await app.requestObserver.replay({ index: body?.index ?? null });
    repo.audit.log('diagnostics.replay', 'model-request', { ok: result.ok, code: result.error?.code ?? null }, 'user');
    return result;
  });

  // ----------------------------------------------------------- overview
  router.get('/api/overview', async ({ query }) => {
    const date = query.date || dayKey(now(), tz());
    const start = startOfDay(date, tz());
    const end = startOfDay(addDays(date, 1), tz());
    const runs = repo.runs.list({ from: start, to: end, limit: 300 });
    const active = repo.runs.active();
    const tasks = repo.tasks.list();
    const conversations = repo.conversations.list({ limit: 12 });
    const pending = [];

    for (const task of tasks) {
      if (!task.enabled) continue;
      const hasTrigger = task.triggers.some((t) => t.enabled);
      if (!hasTrigger) {
        pending.push({
          kind: 'task-without-trigger',
          severity: 'info',
          title: `「${task.name}」没有可用的触发`,
          detail: '它只能手动运行。',
          action: { label: '去任务页', href: `/tasks/${task.id}` },
        });
      }
      if (task.kind === 'reading' && task.projectId) {
        const status = readingService.status(task.projectId);
        if (!status?.sourcePath) {
          pending.push({
            kind: 'reading-no-source',
            severity: 'warn',
            title: `「${task.name}」还没有选择小说文件`,
            detail: '没有文件时阅读任务会被拒绝执行，不会消耗模型。',
            action: { label: '选择小说', href: `/tasks/${task.id}` },
          });
        } else if (status.error?.code === 'SOURCE_CHANGED') {
          pending.push({
            kind: 'reading-source-changed',
            severity: 'warn',
            title: `「${task.name}」的小说文件内容已变化`,
            detail: status.error.message,
            action: { label: '检查进度', href: `/tasks/${task.id}` },
          });
        }
      }
    }
    for (const channel of channelManager.status()) {
      if (channel.enabled && ['offline', 'auth-failed', 'error', 'misconfigured'].includes(channel.status)) {
        pending.push({
          kind: 'channel-unhealthy',
          severity: channel.status === 'auth-failed' ? 'error' : 'warn',
          title: `接入「${channel.name}」状态：${channel.status}`,
          detail: channel.lastError ?? channel.health?.detail ?? '',
          action: { label: '去接入页', href: '/channels' },
        });
      }
    }
    const pendingMemory = repo.archives.pending(100).length;
    if (pendingMemory > 0) {
      pending.push({
        kind: 'memory-pending',
        severity: 'info',
        title: `有 ${pendingMemory} 份归档等待记忆吸收`,
        detail: '可手动触发一次维护，或等待夜间自动维护。',
        action: { label: '去记忆页', href: '/memory' },
      });
    }
    if (!settings.get('model.provider') && !models.defaultSelection()) {
      pending.push({
        kind: 'model-unconfigured',
        severity: 'error',
        title: '没有可用的模型路由',
        detail: '管理台仍可使用，但对话与任务无法执行。请在设置中配置 provider/model。',
        action: { label: '去设置', href: '/settings' },
      });
    }

    const timeline = buildTimeline({ runs, tasks, date, tz: tz() });

    return {
      date,
      timezone: tz(),
      now: now(),
      stats: {
        tasksEnabled: tasks.filter((t) => t.enabled).length,
        tasksTotal: tasks.length,
        runsToday: runs.length,
        succeeded: runs.filter((r) => r.status === 'succeeded').length,
        failed: runs.filter((r) => ['failed', 'interrupted'].includes(r.status)).length,
        active: active.length,
        queued: runner.stats().queued,
        pendingMemory,
      },
      active: active.map((run) => decorateRun(run, tasks)),
      recent: runs.slice(0, 8).map((run) => decorateRun(run, tasks)),
      conversations,
      pending,
      timeline,
      // Everything that listens rather than fires at a time: a message trigger and
      // a group-watch trigger are the same idea ("she is watching this"), so both
      // belong on this list. A group trigger also reports how much room chatter is
      // currently buffered, which is the number that explains why she did or did
      // not look.
      watch: tasks
        .filter((t) => t.enabled)
        .flatMap((t) =>
          t.triggers
            .filter((tr) => tr.enabled && (tr.type === 'message' || tr.type === 'group-watch'))
            .map((tr) => {
              const buffer = tr.type === 'group-watch' ? groupBufferStats(tr) : null;
              return {
                taskId: t.id,
                taskName: t.name,
                kind: tr.type === 'group-watch' ? 'group' : 'message',
                label: app.scheduler.describe(tr),
                lastFiredAt: tr.lastFiredAt,
                buffered: buffer?.pending ?? null,
                lastMessageAt: buffer?.newestAt ?? null,
              };
            }),
        ),
      nextUpcoming: tasks
        .filter((t) => t.enabled)
        .flatMap((t) =>
          t.triggers
            .filter((tr) => tr.type === 'schedule' && tr.enabled && tr.nextFireAt)
            .map((tr) => ({ taskId: t.id, taskName: t.name, at: tr.nextFireAt, label: app.scheduler.describe(tr) })),
        )
        .sort((a, b) => a.at - b.at)
        .slice(0, 6),
    };
  });

  /** What the group buffer currently holds for a `group-watch` trigger's room. */
  function groupBufferStats(trigger) {
    const spec = trigger.spec ?? {};
    try {
      return repo.groupBuffer.stats({ channelId: spec.channelId ?? null, peerId: spec.peerId ?? null });
    } catch (error) {
      return null;
    }
  }

  function decorateRun(run, tasks) {
    const task = run.taskId ? tasks.find((t) => t.id === run.taskId) : null;
    return {
      ...run,
      taskName: task?.name ?? (run.triggerReason === '网页对话' ? '网页对话' : '（已删除任务）'),
      taskKind: task?.kind ?? 'chat',
      durationMs: run.startedAt ? (run.finishedAt ?? now()) - run.startedAt : null,
    };
  }

  /**
   * Timeline data as positions on a 0–24h axis in the user's zone.
   *
   * Flat lists with a minute offset, not hour buckets: the console draws one
   * horizontal line and places each event at its instant, so bucketing here would
   * only lose resolution the client cannot recover.
   */
  function buildTimeline({ runs, tasks, date, tz: zone }) {
    const minutesOf = (ms) => {
      const parts = zonedParts(ms, zone);
      return parts.hour * 60 + parts.minute;
    };
    const planned = [];
    const listening = [];
    for (const task of tasks) {
      // Disabled tasks stay on the axis, faded: "what today would look like" is
      // useful precisely when something is turned off and nothing fires.
      if (task.kind === 'alert' && task.executionTarget?.mode!=='dsh-session') {
        listening.push({ taskId: task.id, taskName: task.name, label: '健康监测', enabled: task.enabled });
      }
      for (const trigger of task.triggers) {
        const spec = trigger.spec ?? {};
        const active = task.enabled && trigger.enabled;
        if (trigger.type === 'schedule') {
          if (spec.kind === 'daily' || spec.kind === 'weekly') {
            const [hh, mm] = String(spec.at ?? '00:00').split(':').map(Number);
            if (Number.isInteger(hh)) {
              planned.push({
                triggerId: trigger.id,
                taskId: task.id,
                taskName: task.name,
                kind: task.kind,
                at: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
                minutes: hh * 60 + (Number.isInteger(mm) ? mm : 0),
                nextFireAt: trigger.nextFireAt,
                label: app.scheduler.describe(trigger),
                enabled: task.enabled,
                triggerEnabled: trigger.enabled,
              });
            }
          } else {
            listening.push({
              taskId: task.id,
              taskName: task.name,
              label: spec.kind === 'cron' ? 'cron' : '按间隔',
              enabled: active,
            });
          }
        }
        if (trigger.type === 'message') {
          listening.push({ taskId: task.id, taskName: task.name, label: '消息监听', enabled: active });
        }
        if (trigger.type === 'group-watch') {
          listening.push({ taskId: task.id, taskName: task.name, label: '群聊监听', enabled: active });
        }
      }
    }
    const actual = [];
    for (const run of runs) {
      if (!run.queuedAt) continue;
      const startMinutes = minutesOf(run.queuedAt);
      const endEpoch = run.finishedAt ?? (run.status === 'running' || run.status === 'stopping' ? now() : run.queuedAt);
      let endMinutes = minutesOf(endEpoch);
      // An event that crosses local midnight is clamped to the day it started in;
      // drawing into the next day would misplace it on this axis.
      if (endMinutes < startMinutes) endMinutes = 24 * 60;
      actual.push({
        runId: run.id,
        taskId: run.taskId,
        taskName: run.taskId ? (tasks.find((t) => t.id === run.taskId)?.name ?? '任务') : '网页对话',
        taskKind: run.taskId ? (tasks.find((t) => t.id === run.taskId)?.kind ?? 'chat') : 'chat',
        status: run.status,
        start: run.queuedAt,
        end: endEpoch,
        startMinutes,
        endMinutes: Math.max(startMinutes + 1, endMinutes),
        durationMs: run.startedAt ? endEpoch - run.startedAt : null,
        triggerReason: run.triggerReason,
      });
    }
    planned.sort((a, b) => a.minutes - b.minutes);
    actual.sort((a, b) => a.startMinutes - b.startMinutes);
    const today = dayKey(now(), zone);
    return {
      date,
      timezone: zone,
      planned,
      actual,
      listening,
      isToday: date === today,
      nowMinutes: date === today ? minutesOf(now()) : null,
    };
  }

  // -------------------------------------------------------------- tasks
  router.get('/api/tasks', async () => {
    const tasks = repo.tasks.list();
    const allRuns = repo.runs.list({ limit: 400 });
    return {
      tasks: tasks.map((task) => {
        const taskRuns = allRuns.filter((r) => r.taskId === task.id);
        const last = taskRuns[0] ?? null;
        return {
          ...task,
          triggerDescriptions: task.triggers.map((tr) => ({
            id: tr.id,
            type: tr.type,
            enabled: tr.enabled,
            description: app.scheduler.describe(tr),
            spec: tr.spec ?? {},
            misfirePolicy: tr.misfirePolicy ?? 'skip',
            nextFireAt: tr.nextFireAt,
            lastFiredAt: tr.lastFiredAt,
          })),
          lastRun: last
            ? { id: last.id, status: last.status, at: last.queuedAt, finishedAt: last.finishedAt, errorCode: last.errorCode }
            : null,
          runCount: taskRuns.length,
          nextFireAt:
            task.triggers
              .filter((tr) => tr.enabled && tr.nextFireAt)
              .map((tr) => tr.nextFireAt)
              .sort((a, b) => a - b)[0] ?? null,
        };
      }),
      kinds: repo.constants.TASK_KINDS,
      conversationModes: repo.constants.CONV_MODES,
      templates: taskTemplates(),
    };
  });

  function taskTemplates() {
    return [
      {id:'scheduled',name:'定时任务',kind:'custom',description:'每天、每周或按间隔执行；结果保存在任务会话。',goal:'按计划完成指定任务，记录结果。',conversationMode:'reuse',triggers:[{type:'schedule',spec:{kind:'daily',at:'20:00',timezone:'Asia/Shanghai'}}]},
      {id:'chat-bridge',name:'聊天桥',kind:'chat',description:'从选定接入接收私聊消息，按对象保持会话并可回复来源。',goal:'根据收到的消息自然回复。',conversationMode:'per-peer',triggers:[{type:'message',spec:{peerKind:'private',match:'any',replyMode:'reply'}}]},
      {id:'random-activity',name:'随机活动',kind:'activity',description:'在活动窗口内按随机等待或固定节奏执行，可设置 Roll 点。',goal:'做一件小而具体的事，在会话中记下结果。',conversationMode:'new',triggers:[{type:'schedule',spec:{kind:'random',cadence:'poisson',minutes:180,cooldownMinutes:1,hours:[8,23],timezone:'Asia/Shanghai'}}]},
      {id:'group-response',name:'群聊响应',kind:'chat',description:'只在指定群按 @我、关键词、命令或全部消息条件响应。',goal:'针对群里的触发消息简短回复。',conversationMode:'per-peer',triggers:[{type:'message',spec:{peerKind:'group',match:'mention',replyMode:'reply'}}]},
    ];
  }

  const messageSpec = value => {
    const spec={...value};
    if(!spec.channelId){const channels=repo.channels.list().filter(c=>c.enabled&&['onebot','napcat','snowluma'].includes(c.type));if(channels.length===1)spec.channelId=channels[0].id;}
    if(!spec.channelId||!['onebot','napcat','snowluma','qq-official'].includes(repo.channels.get(spec.channelId)?.type))throw new HttpError(400,'CHANNEL_REQUIRED','请选择已启用的消息连接');
    spec.requirePeer=spec.requirePeer!==false;
    if(spec.requirePeer&&!String(spec.peerId??'').trim())throw new HttpError(400,'PEER_REQUIRED','请选择允许触发的聊天对象；收到的新消息会出现在列表中');
    if(!['private','group'].includes(spec.peerKind))throw new HttpError(400,'PEER_KIND_REQUIRED','请明确选择私聊或群聊');
    return spec;
  };
  router.post('/api/tasks', async ({ body }) => {
    const input = {...body,triggers:body?.triggers?.map(t=>t.type==='message'?{...t,spec:messageSpec(t.spec)}:t)};
    let task;
    try {
      repo.transaction(() => {
        if (input.templateId && !taskTemplates().some(t => t.id === input.templateId)) throw new HttpError(400,'TEMPLATE_INVALID','任务模板不存在');
        if (input.contextId && !repo.contexts.get(input.contextId)) throw new HttpError(400,'CONTEXT_INVALID','所选上下文不存在，请重新选择');
        if (['chat-bridge','group-response'].includes(input.templateId)) {
          const rule = input.triggers?.[0];
          if (rule?.type !== 'message' || !rule.spec?.channelId || !repo.channels.get(rule.spec.channelId)) throw new HttpError(400,'CHANNEL_REQUIRED','请选择已配置的接入；可先到接入页面添加');
          if (input.templateId === 'group-response' && (rule.spec.peerKind !== 'group' || !String(rule.spec.peerId ?? '').trim())) throw new HttpError(400,'GROUP_REQUIRED','群聊响应须填写目标群号');
        }
        task = repo.tasks.create(input);
        for (const trigger of input.triggers ?? []) {
          if (trigger?.type === 'message' && ['prefix','contains'].includes(trigger.spec?.match) && !String(trigger.spec?.value??'').trim()) throw new HttpError(400,'MATCH_REQUIRED','匹配文字不能为空');
          if (!trigger?.type) throw new HttpError(400,'TRIGGER_INVALID','触发规则缺少类型');
          if (trigger.definitionId) {
            const def = readDefinitions(settings).find(d => d.id === trigger.definitionId);
            if (!def) throw new HttpError(400,'TRIGGER_INVALID','所选共享触发规则不存在');
            repo.triggers.create(task.id,{...def,spec:{...def.spec,definitionId:def.id,localEnabled:trigger.enabled !== false}});
          } else repo.triggers.create(task.id,trigger);
        }
        if (task.kind === 'reading' && input.projectId && !repo.projects.get(input.projectId)) repo.projects.upsert({id:input.projectId,name:task.name,kind:'reading',state:{}});
        syncTriggerDefinitions({repo,settings});
        repo.audit.log('task.create',task.id,{name:task.name});
      });
    } catch (error) { settings.reload(); throw error; }
    app.scheduler.refreshAll();
    return {task:repo.tasks.get(task.id)};
  });

  router.get('/api/tasks/:id', async ({ params }) => {
    const task = repo.tasks.get(params.id);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    const runs = repo.runs.list({ taskId: task.id, limit: 60 });
    const reading = task.projectId ? readingService.status(task.projectId) : null;
    return {
      task,
      context:task.contextId?repo.contexts.get(task.contextId):repo.contexts.list()[0]??null,
      runs: runs.map((run) => decorateRun(run, [task])),
      reading,
      memoryDefaultOutputSlug:(()=>{const mapped=readSections(settings).sections.filter(s=>s.enabled&&s.legacyMemorySlug&&s.source?.path);return mapped.length===1?mapped[0].legacyMemorySlug:repo.memory.blocks().length===1?repo.memory.blocks()[0].slug:null;})(),
      memoryOutputs:task.kind==='maintenance'?repo.memory.blocks().map(b=>({slug:b.slug,name:b.name,path:paths.memoryFileForSlug?.(b.slug)??relativeBlockPath(b.slug)})):[],
      triggerDescriptions: task.triggers.map((tr) => ({
        ...tr,
        description: app.scheduler.describe(tr),
            spec: tr.spec ?? {},
            misfirePolicy: tr.misfirePolicy ?? 'skip',
      })),
    };
  });

  router.patch('/api/tasks/:id', async ({ params, body }) => {
    if (body?.archivePolicy && body.archivePolicy.conversation === undefined) {
      body.archivePolicy = { ...body.archivePolicy, conversation: repo.tasks.get(params.id)?.archivePolicy?.conversation ?? 'keep' };
    }
    const task = repo.tasks.update(params.id, body ?? {});
    app.scheduler.refreshAll();
    repo.audit.log('task.update', task.id, { fields: Object.keys(body ?? {}) });
    return { task: repo.tasks.get(task.id) };
  });

  // One commit boundary for named creation, binding and shared continuity.
  // This route deliberately accepts no task goal or other unsaved editor fields.
  router.patch('/api/tasks/:id/conversation', async ({ params, body }) => {
    const current = repo.tasks.get(params.id);
    if (!current) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    if (!['existing', 'fixed', 'per-peer', 'new'].includes(body?.mode) ||
        typeof body?.continuity !== 'boolean' || !['keep', 'on-success'].includes(body?.archive)) {
      throw new HttpError(400, 'CONVERSATION_CONFIG', '请选择有效的会话方式和关闭策略');
    }
    if (body.mode !== 'new' && body.archive !== 'keep') throw new HttpError(400, 'CONVERSATION_CONFIG', '仅每次新建会话可成功后归档');
    return repo.transaction(() => {
      let conversation = null;
      if (body.mode === 'fixed') {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) throw new HttpError(400, 'CONVERSATION_TITLE', '请填写不超过200字的会话名称');
        conversation = repo.conversations.create({ title: body.title.trim(), kind: 'task', contextId: current.contextId, meta: { ownerTaskId: current.id } });
      } else if (body.mode === 'existing') {
        conversation = typeof body.conversationId === 'string' ? repo.conversations.get(body.conversationId) : null;
        if (!conversation || conversation.archivedAt) throw new HttpError(400, 'CONVERSATION_UNAVAILABLE', '会话不存在或已归档，请重新选择');
      }
      const task = repo.tasks.update(current.id, {
        conversationMode: conversation ? 'reuse' : body.mode,
        conversationId: conversation?.id ?? null,
        archivePolicy: { ...current.archivePolicy, conversation: body.archive },
      });
      if (conversation) repo.conversations.update(conversation.id, { meta: { ...conversation.meta, continuity: { enabled: body.continuity, thresholdRatio: conversation.meta?.continuity?.thresholdRatio ?? 0.8 } } });
      return { task };
    });
  });

  router.delete('/api/tasks/:id', async ({ params }) => {
    const task = repo.tasks.softDelete(params.id);
    app.scheduler.refreshAll();
    repo.audit.log('task.remove', params.id, {});
    return { task };
  });

  router.post('/api/tasks/:id/enable', async ({ params, body }) => {
    const task = repo.tasks.setEnabled(params.id, body?.enabled !== false);
    app.scheduler.refreshAll();
    return { task: repo.tasks.get(task.id) };
  });

  router.post('/api/tasks/:id/duplicate', async ({ params }) => {
    const source = repo.tasks.get(params.id);
    if (!source) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    const copy = repo.tasks.create({
      ...source,
      name: `${source.name} 副本`,
      enabled: false,
      conversationId: null,
    });
    for (const trigger of source.triggers) {
      repo.triggers.create(copy.id, {
        type: trigger.type,
        label: trigger.label,
        spec: trigger.spec,
        enabled: false,
        misfirePolicy: trigger.misfirePolicy,
      });
    }
    app.scheduler.refreshAll();
    repo.audit.log('task.duplicate', copy.id, { from: source.id });
    return { task: repo.tasks.get(copy.id) };
  });

  router.post('/api/tasks/:id/run', async ({ params, body }) => {
    const task = repo.tasks.get(params.id);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    if (task.kind === 'alert') {
      const preview = await alertService.preview();
      return { skipped: true, reason: '通知类任务直接执行，不调用模型', alert: preview };
    }
    const { run, conversation } = runner.enqueue(task, {
      reason: body?.reason ?? '手动运行',
      input: body?.input ?? '',
      source: 'manual',
    });
    repo.audit.log('task.run', task.id, { runId: run.id });
    return { run, conversation };
  });

  router.get('/api/trigger-definitions', async () => ({ definitions: readDefinitions(settings).map(d => ({...d, description: app.scheduler.describe(d), bindings: repo.triggers.listAll().filter(t => t.spec?.definitionId === d.id).length })) }));
  router.post('/api/trigger-definitions', async ({body}) => {
    if(body?.type==='message'&&['prefix','contains'].includes(body.spec?.match)&&!String(body.spec?.value??'').trim()) throw new HttpError(400,'MATCH_REQUIRED','匹配文字不能为空');
    const rows = readDefinitions(settings);
    const id = body?.id || randomUUID();
    if (rows.some(d => d.id === id)) throw new HttpError(409,'DUPLICATE','ID已存在');
    settings.set('triggers.library',JSON.stringify([...rows,{...body,id}]));
    return {definition:readDefinitions(settings).find(d=>d.id===id)};
  });
  router.patch('/api/trigger-definitions/:id', async ({params,body}) => {
    const rows=readDefinitions(settings);
    if (!rows.some(d=>d.id===params.id)) throw new HttpError(404,'NOT_FOUND','定义不存在');
    const candidate={...rows.find(d=>d.id===params.id),...body};
    if(body?.spec&&candidate.type==='message'&&['prefix','contains'].includes(candidate.spec?.match)&&!String(candidate.spec?.value??'').trim()) throw new HttpError(400,'MATCH_REQUIRED','匹配文字不能为空');
    settings.set('triggers.library',JSON.stringify(rows.map(d=>d.id===params.id?{...d,...body,id:d.id}:d)));
    syncTriggerDefinitions({repo,settings}); app.scheduler.refreshAll();
    return {ok:true};
  });
  router.delete('/api/trigger-definitions/:id', async ({params}) => {
    const bindings=repo.triggers.listAll().filter(t=>t.spec?.definitionId===params.id);
    if (bindings.length) throw new HttpError(409,'IN_USE','请先在任务中移除所有引用，再删除定义');
    settings.set('triggers.library',JSON.stringify(readDefinitions(settings).filter(d=>d.id!==params.id)));
    return {ok:true};
  });

  router.post('/api/tasks/:id/triggers', async ({ params, body }) => {
    const task = repo.tasks.get(params.id);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    let input = body ?? {};
    if (body?.definitionId) {
      const definition = readDefinitions(settings).find(d => d.id === body.definitionId);
      if (!definition) throw new HttpError(404,'NOT_FOUND','触发器定义不存在');
      if (repo.triggers.listForTask(task.id).some(t=>t.spec?.definitionId===definition.id)) throw new HttpError(409,'DUPLICATE','该任务已使用此触发器');
      input = {...definition, spec:{...definition.spec,definitionId:definition.id,localEnabled:true}};
    }
    if(input.type==='message')input={...input,spec:messageSpec(input.spec)};
    const trigger = repo.triggers.create(task.id, input);
    if(body?.activateTask===true)repo.tasks.setEnabled(task.id,true);
    if (!input.spec?.definitionId) syncTriggerDefinitions({repo,settings});
    app.scheduler.refresh(trigger.id);
    return { trigger: repo.triggers.get(trigger.id), description: app.scheduler.describe(repo.triggers.get(trigger.id)) };
  });

  router.patch('/api/tasks/:taskId/triggers/:id',async({params,body})=>{
    syncTriggerDefinitions({repo,settings});
    const current=repo.triggers.get(params.id);
    if(!current||current.taskId!==params.taskId)throw new HttpError(404,'NOT_FOUND','触发绑定不存在');
    const {activateTask,...patch}=body??{};
    repo.transaction(()=>{
      if(patch.spec||patch.type||patch.label){
        // Editing from a task makes an independent rule, so shared consumers stay unchanged.
        let spec={...current.spec,...patch.spec};delete spec.definitionId;delete spec.localEnabled;if((patch.type??current.type)==='message')spec=messageSpec(spec);
        repo.triggers.update(current.id,{...patch,spec});
      } else repo.triggers.update(current.id,{...patch,spec:{...current.spec,localEnabled:patch.enabled??current.spec.localEnabled}});
      if(activateTask===true)repo.tasks.setEnabled(params.taskId,true);
      syncTriggerDefinitions({repo,settings});
    });
    app.scheduler.refreshAll();
    const trigger=repo.triggers.get(current.id);
    return {trigger,task:repo.tasks.get(params.taskId),description:app.scheduler.describe(trigger)};
  });
  router.patch('/api/triggers/:id', async ({ params, body }) => {
    syncTriggerDefinitions({repo,settings});
    const current = repo.triggers.get(params.id);
    if (current?.spec?.definitionId && Object.keys(body ?? {}).some(k => k !== 'enabled')) throw new HttpError(409,'SHARED_DEFINITION','请在触发器页编辑共享规则；任务只管理本地启用状态');
    const patch = current?.spec?.definitionId ? {...body, spec:{...current.spec,localEnabled:body.enabled}} : body ?? {};
    const trigger = repo.triggers.update(params.id, patch);
    syncTriggerDefinitions({repo,settings});
    app.scheduler.refresh(trigger.id);
    const fresh = repo.triggers.get(trigger.id);
    return { trigger: fresh, description: app.scheduler.describe(fresh) };
  });

  router.delete('/api/triggers/:id', async ({ params }) => {
    const trigger = repo.triggers.get(params.id);
    if (!trigger) throw new HttpError(404, 'TRIGGER_NOT_FOUND', '触发绑定不存在');
    repo.triggers.remove(params.id);
    repo.audit.log('trigger.remove', params.id, { taskId: trigger.taskId });
    return { ok: true, note: '触发已移除，历史运行记录保留' };
  });

  /**
   * The generic trigger: an HTTP request is the signal.
   *
   * Public on purpose — the token in the path is the credential, so a script, a
   * phone shortcut or another machine can fire the task without a device cookie.
   * The body is the run's input: what the caller writes is what the task is told,
   * which makes "trigger = signal + text" true for anything that can POST.
   */
  router.post('/api/hooks/:token', async ({ params, body }) => {
    const trigger = repo.triggers.findByToken(params.token);
    if (!trigger) throw new HttpError(404, 'HOOK_NOT_FOUND', '没有这个触发口令');
    if (!trigger.enabled) throw new HttpError(409, 'HOOK_DISABLED', '这个触发器已停用');
    const task = repo.tasks.get(trigger.taskId);
    if (!task || task.deletedAt || !task.enabled) {
      throw new HttpError(409, 'HOOK_TASK_DISABLED', '触发器还在，但任务已停用');
    }
    const maxPerHour = Number(trigger.spec?.maxPerHour ?? 0);
    if (maxPerHour > 0 && repo.runs.countSince(trigger.id, now() - 3_600_000) >= maxPerHour) {
      throw new HttpError(429, 'HOOK_RATE_LIMITED', `这个触发每小时最多 ${maxPerHour} 次`);
    }
    const text =
      typeof body === 'string'
        ? body.trim()
        : String(body?.text ?? body?.input ?? body?.message ?? '').trim();
    const { run, conversation } = runner.enqueue(task, {
      triggerId: trigger.id,
      reason: '外部触发',
      input: text,
      source: 'webhook',
      meta: { webhook: { from: body?.from ?? null } },
    });
    repo.audit.log('trigger.webhook', trigger.id, { task: task.name, chars: text.length }, 'hook');
    return { ok: true, runId: run.id, conversationId: conversation?.id??null, effectiveFrom: 'now' };
  }, { public: true });

  /**
   * Every trigger in one list.
   *
   * Triggers belong to a task, but "what makes Yu act?" is a question about the
   * whole install: a schedule on a forgotten task, a webhook nobody remembers,
   * a group watcher that has been quiet for days. The task page can only answer
   * per task, so the console gets this flat view with the owning task attached.
   */
  router.get('/api/triggers', async () => {
    const tasks = repo.tasks.list({ includeDeleted: true });
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const triggers = repo.triggers.listAll().map((trigger) => {
      const task = byId.get(trigger.taskId) ?? null;
      return {
        ...trigger,
        taskName: task?.name ?? '（任务已删除）',
        taskKind: task?.kind ?? null,
        taskEnabled: task ? task.enabled && !task.deletedAt : false,
        taskDeleted: Boolean(task?.deletedAt),
        description: app.scheduler.describe(trigger),
      };
    });
    const counts = {};
    for (const trigger of triggers) counts[trigger.type] = (counts[trigger.type] ?? 0) + 1;
    return {
      triggers,
      counts,
      enabled: triggers.filter((trigger) => trigger.enabled).length,
      types: repo.constants.TRIGGER_TYPES,
    };
  });

  // --------------------------------------------------------------- runs
  router.get('/api/runs', async ({ query }) => {
    const tasks = repo.tasks.list({ includeDeleted: true });
    let runs;
    if (query.date) {
      runs = repo.runs.forDate(query.date, tz());
    } else {
      runs = repo.runs.list({ taskId: query.taskId ?? null, status: query.status ?? null, limit: Number(query.limit ?? 100) });
    }
    return { runs: runs.map((run) => decorateRun(run, tasks)) };
  });

  router.get('/api/runs/:id', async ({ params }) => {
    const run = repo.runs.get(params.id);
    if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', '运行记录不存在');
    const task = run.taskId ? repo.tasks.get(run.taskId) : null;
    const conversation = run.conversationId ? repo.conversations.get(run.conversationId) : null;
    const snapshot = run.contextSnapshotId ? repo.contexts.snapshotById(run.contextSnapshotId) : null;
    const archive = repo.archives.list({ limit: 200 }).find((a) => a.runId === run.id) ?? null;
    const messages = run.conversationId ? repo.messages.list(run.conversationId, { limit: 50 }) : [];
    return sanitizeDiagnostic({
      run: decorateRun(run, task ? [task] : []),
      task,
      conversation,
      steps: repo.runs.steps(run.id),
      snapshot,
      archive,
      messages: messages.filter((m) => !m.runId || m.runId === run.id),
      toolCalls: repo.tools.callsForRun(run.id),
      diagnostics: {historicalSnapshot:Boolean(snapshot),trigger:run.meta?.trigger ?? null,businessCommitted:run.businessDone ?? null,archiveCommitted:run.archiveDone ?? null},
      actual: snapshot
        ? {
            sections: (snapshot.resolved.sections ?? []).map((s) => ({ name: s.name, tokens: s.tokens, chars: s.text?.length ?? 0 })),
            route: snapshot.resolved.route,
            budget: snapshot.resolved.budget,
            toolPolicy: snapshot.resolved.toolPolicy,
            resources: {packages:snapshot.resolved.toolPolicy?.resourceGrants?.packages ?? snapshot.resolved.toolPolicy?.packages ?? null,sources:snapshot.resolved.toolPolicy?.resourceGrants?.sources ?? snapshot.resolved.toolPolicy?.sources ?? null},
            toolEnforcement:snapshot.resolved.toolEnforcement ?? null,
            promptFiles: snapshot.resolved.promptFiles,
            retrieved: snapshot.resolved.retrieved,
            renderedInput: snapshot.resolved.renderedInput,
          }
        : null,
    },settings.spec.filter(s=>s.secret).map(s=>settings.get(s.key)));
  });

  router.post('/api/runs/:id/stop', async ({ params }) => {
    const result = runner.stop(params.id);
    if (!result.ok) throw new HttpError(409, 'STOP_REJECTED', result.error);
    return result;
  });

  router.post('/api/runs/:id/rearchive', async ({ params }) => {
    const run = repo.runs.get(params.id);
    if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', '运行记录不存在');
    const conversation = run.conversationId ? repo.conversations.get(run.conversationId) : null;
    const summary = {
      assistantText: run.outputText,
      toolCalls: [],
      usage: run.usage,
      sessionId: run.sessionId,
      fromSeq: 0,
      toSeq: 0,
    };
    const task = run.taskId ? repo.tasks.get(run.taskId) : null;
    const archive = archiveService.archiveRun({ run, task, conversation, summary, compiled: null, events: [], fromSeq: 0, toSeq: 0 });
    repo.runs.update(run.id, { archiveDone: true });
    return { archive };
  });

  // ------------------------------------------------------- conversations
  router.get('/api/conversations', async ({ query }) => ({
    conversations: repo.conversations.list({
      kind: query.kind ?? null,
      status: query.status ?? null,
      search: query.search ?? '',
      limit: Number(query.limit ?? 100),
    }),
  }));

  router.get('/api/conversations/:id', async ({ params, query }) => {
    const conversation = repo.conversations.get(params.id);
    if (!conversation) throw new HttpError(404, 'CONVERSATION_NOT_FOUND', '对话不存在');
    const messages = repo.messages.list(params.id, { limit: Number(query.limit ?? 200) });
    const runs = repo.runs.byConversation(params.id, 20);
    const snapshot = conversation.contextSnapshotId
      ? repo.contexts.snapshotById(conversation.contextSnapshotId)
      : repo.contexts.latestSnapshotFor(params.id);
    return {
      conversation,
      messages,
      runs,
      snapshot: snapshot
        ? {
            id: snapshot.id,
            createdAt: snapshot.createdAt,
            route: snapshot.resolved.route,
            sections: (snapshot.resolved.sections ?? []).map((s) => ({ name: s.name, tokens: s.tokens })),
            budget: snapshot.resolved.budget,
          }
        : null,
      agent: agentHost.status(conversation.sessionId ?? ''),
    };
  });

  /**
   * Start a fresh physical session for this conversation, now.
   *
   * The context frame (rules, style, short-term memory, retrieval) is compiled
   * when a session is created, so a memory or settings edit is invisible until
   * the session rotates. Waiting for the daily rotation is the wrong answer when
   * the person just changed something and wants to see it take effect: this
   * closes the old session, clears the frame pointer, and the next message opens
   * a new one compiled from the current state.
   */
  router.post('/api/conversations/:id/new-session', async ({ params }) => {
    const conversation = repo.conversations.get(params.id);
    if (!conversation) throw new HttpError(404, 'CONVERSATION_NOT_FOUND', '对话不存在');
    const previous = conversation.sessionId;
    requireIdleConversation(conversation.id);
    if (previous) {
      try {
        await agentHost.disposeSession(previous);
      } catch (error) {
        log?.warn(`disposing session ${previous} for a manual rotation failed: ${error.message}`);
      }
    }
    const meta = { ...conversation.meta };
    delete meta.contextFrame;
    delete meta.sessionDay;
    if (previous) meta.previousSessionId = previous;
    const updated = repo.conversations.update(conversation.id, { sessionId: null, meta });
    log?.info(`manual session rotation for ${conversation.id}: ${previous ?? 'none'} → next message`);
    return {
      conversation: updated,
      previousSessionId: previous,
      effectiveFrom: '下一条消息（会用当前的记忆与设置重新拼一次上下文）',
    };
  });

  // PATCH changes list visibility only; POST archive performs session/tail/absorb finalization.
  function requireIdleConversation(id) {
    const busy = [...runner.activeRuns(), ...runner.queuedRuns()].some((runId) => repo.runs.get(runId)?.conversationId === id);
    if (busy) throw new HttpError(409, 'CONVERSATION_BUSY', '请等待当前会话的执行和排队消息完成后再归档或重置');
  }
  router.patch('/api/conversations/:id', async ({ params, body }) => {
    const conversation = repo.conversations.get(params.id);
    if (!conversation) throw new HttpError(404, 'CONVERSATION_NOT_FOUND', '对话不存在');
    if (body?.continuity !== undefined) {
      const config = body.continuity;
      if (!config || typeof config !== 'object' || Array.isArray(config) ||
          (config.enabled !== undefined && typeof config.enabled !== 'boolean') ||
          (config.thresholdRatio !== undefined && (!Number.isFinite(config.thresholdRatio) || config.thresholdRatio < 0.5 || config.thresholdRatio > 0.9))) {
        throw new HttpError(400, 'CONTINUITY_CONFIG', '摘要接续需要 enabled 布尔值和 0.5–0.9 的阈值');
      }
      const latest = repo.conversations.get(params.id);
      repo.conversations.update(params.id, { meta: { ...latest.meta, continuity: { enabled: config.enabled ?? (latest.meta?.continuity?.enabled === true), thresholdRatio: config.thresholdRatio ?? latest.meta?.continuity?.thresholdRatio ?? 0.8 } } });
    }
    if (body?.contextId) repo.conversations.setContext(params.id, body.contextId);
    if (body?.status === 'archived') {
      requireIdleConversation(params.id);
      return { conversation: repo.conversations.archive(params.id, body.archiveCursorSeq ?? 0) };
    }
    if (body?.status === 'idle') return { conversation: repo.conversations.reopen(params.id) };
    return { conversation: repo.conversations.get(params.id) };
  });

  // -------------------------------------------------- conversation archive
  //
  // POST archive preserves history, archives the tail, closes the DSH session,
  // and queues memory absorption. PATCH status above only changes list state.
  router.post('/api/conversations/:id/archive', async ({ params, body }) => {
    const conversation = repo.conversations.get(params.id);
    if (!conversation) throw new HttpError(404, 'CONVERSATION_NOT_FOUND', '对话不存在');
    requireIdleConversation(params.id);
    // Order matters: fold the un-archived tail into an archive first, then close
    // the session, then ask for one memory pass that will see everything.
    const tail = archiveService.archiveConversationTail({ conversation });
    const dsh = await closeConversationSession(conversation);
    repo.conversations.archive(params.id, body?.archiveCursorSeq ?? conversation.archiveCursorSeq ?? 0);
    const absorb = queueMemoryAbsorb('归档后吸收记忆');
    repo.audit.log('conversation.archive', params.id, { title: conversation.title, dsh, tail, absorb }, 'user');
    return {
      conversation: repo.conversations.get(params.id),
      dshSession: dsh,
      tail,
      absorb,
      effectiveFrom: 'immediately',
      note: `已归档：${
        tail.created ? `${tail.messages} 条没归档的消息补进归档；` : ''
      }DSH 物理会话已关闭，下一次消息会开新会话；${
        absorb.queued ? '记忆吸收已排队，跑完这段对话就进长期记忆。' : `记忆吸收没有排队（${absorb.reason}）。`
      }`,
    };
  });

  /**
   * Close the physical DSH session behind a conversation.
   *
   * Two bookkeeping systems, one truth: archiving only in Yu's database left the
   * DSH session resumable (and, once archived from the console, every step on it
   * is rejected as `blocked`). The conversation therefore drops its session id and
   * context frame, and the session is archived through the registry.
   */
  async function closeConversationSession(conversation) {
    const sessionId = conversation?.sessionId ?? null;
    if (!sessionId) return { ok: false, reason: 'no-session' };
    const result = await app.sessionArchive.archive(sessionId);
    if (!result.ok) throw new HttpError(503, 'SESSION_ARCHIVE_FAILED', `宿主未能关闭会话，保留原状态：${result.reason}`);
    const meta = { ...(conversation.meta ?? {}), contextFrame: null, sessionDay: null, previousSessionId: sessionId };
    repo.conversations.update(conversation.id, { sessionId: null, meta });
    return result;
  }

  /**
   * One memory pass, if there is anything to absorb and none is already running.
   *
   * Archiving a conversation is exactly the moment its content should stop being
   * "pending": the archives exist, the session is closed, and the next scheduled
   * run is hours away. Queuing the maintenance task here (rather than absorbing
   * inside the HTTP request) keeps the response fast and the pass cancellable.
   */
  function queueMemoryAbsorb() {
    return {queued:false,reason:'归档材料已保留，等待任务页启用的新会话或夜间同步规则'};
  }

  router.post('/api/conversations/:id/restore', async ({ params }) => {
    const conversation = repo.conversations.get(params.id);
    if (!conversation) throw new HttpError(404, 'CONVERSATION_NOT_FOUND', '对话不存在');
    const restored = repo.conversations.reopen(params.id);
    repo.audit.log('conversation.restore', params.id, { title: conversation.title }, 'user');
    return { conversation: restored, effectiveFrom: 'immediately', note: '已恢复到进行中列表。' };
  });

  /** Bulk archive: the console offers "归档 N 天前的会话" as one action. */
  router.post('/api/conversations/archive', async ({ body }) => {
    const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
    const archived = body?.archived !== false;
    const done = [];
    const missing = [];
    const archives = [];
    for (const id of ids.slice(0, 200)) {
      const conversation = repo.conversations.get(id);
      if (!conversation) {
        missing.push(id);
        continue;
      }
      if (archived) {
        requireIdleConversation(id);
        archives.push({ id, ...archiveService.archiveConversationTail({ conversation }) });
        await closeConversationSession(conversation);
        done.push(repo.conversations.archive(id, conversation.archiveCursorSeq ?? 0));
      } else {
        done.push(repo.conversations.reopen(id));
      }
    }
    const absorb = archived && done.length ? queueMemoryAbsorb('批量归档后吸收记忆') : null;
    repo.audit.log(
      'conversation.archiveBulk',
      `${done.length}`,
      { archived, missing: missing.length, tails: archives.filter((item) => item.created).length, absorb },
      'user',
    );
    return {
      archived,
      changed: done.length,
      missing,
      conversations: done,
      tails: archives,
      absorb,
      note: archived
        ? `已归档 ${done.length} 个：${
            archives.filter((item) => item.created).length
          } 个对话补了没归档的尾巴；${absorb?.queued ? '记忆吸收已排队。' : `记忆吸收没有排队（${absorb?.reason ?? '—'}）。`}`
        : `已恢复 ${done.length} 个。`,
    };
  });

  const chatHandler = async ({ req, res, body, params }) => {
    const text = String(body?.text ?? '').trim();
    if (!text) throw new HttpError(400, 'EMPTY_MESSAGE', '消息不能为空');
    if (text.length > 20000) throw new HttpError(400, 'MESSAGE_TOO_LONG', '消息过长（上限 20000 字）');
    // The conversation may arrive in the path (`/api/conversations/:id/messages`)
    // or in the body (`/api/chat`). Reading only the body made the path form open a
    // brand new conversation — and therefore a brand new DSH session — per message.
    const conversationId = params?.id ?? body?.conversationId ?? null;
    const sse = openSse(res);
    try {
      const { conversation, run } = await runner.chat({
        conversationId,
        text,
        onDelta: (event) => {
          if (event.type === 'delta') sse.event('delta', { kind: event.kind, text: event.text });
          else if (event.type === 'message') {
            sse.event('message', { role: event.role, text: event.text, usage: event.usage, turnEnd: event.turnEnd });
          } else if (event.type === 'error') sse.event('error', { code: event.code, message: event.message });
        },
      });
      sse.event('accepted', { conversationId: conversation.id, runId: run.id });
      const final = await runner.waitForRun(run.id);
      sse.event('done', {
        runId: final.id,
        status: final.status,
        errorCode: final.errorCode,
        errorMessage: final.errorMessage,
        conversationId: final.conversationId,
      });
    } catch (error) {
      sse.event('error', { code: error.code ?? 'CHAT_FAILED', message: error.message });
    } finally {
      sse.close();
    }
  };
  router.post('/api/chat', chatHandler);
  router.post('/api/conversations/:id/messages', chatHandler);

  // ----------------------------------------------------------- contexts
  router.get('/api/contexts', async () => ({ contexts: repo.contexts.list() }));

  router.get('/api/contexts/options', async () => ({
    tools: toolService.catalog().items.map((t) => ({ name: t.name, description: t.description, owner: t.source.owner })),
    models: await models.catalog(),
    presets: await app.listPresets(),
    defaultContextConfig: normalizeContextConfig({}),
    sectionOrder: app.sectionOrder,
    // Labels come from the live registry, so renaming or adding an injectable
    // section changes this picker too instead of leaving a stale hard-coded list.
    sections: turnSectionChoices(settings),
  }));

  router.post('/api/contexts', async ({ body }) => ({
    context: repo.contexts.create({
      name: body?.name ?? '新上下文',
      description: body?.description ?? '',
      config: body?.config ?? {},
    }),
  }));

  router.get('/api/contexts/:id', async ({ params, query }) => {
    const context = repo.contexts.get(params.id, { version: query.version ? Number(query.version) : null });
    if (!context) throw new HttpError(404, 'CONTEXT_NOT_FOUND', '上下文方案不存在');
    return {
      context,
      usage: repo.tasks.list().filter((t) => t.contextId === params.id).map((t) => ({ id: t.id, name: t.name })),
    };
  });

  router.patch('/api/contexts/:id', async ({ params, body }) => {
    if (body?.name !== undefined || body?.description !== undefined) {
      repo.contexts.rename(params.id, {
        name: body?.name ?? repo.contexts.get(params.id)?.name,
        description: body?.description ?? repo.contexts.get(params.id)?.description ?? '',
      });
    }
    if (body?.config) {
      const context = repo.contexts.saveVersion(params.id, {
        config: body.config,
        note: body.note ?? 'edited in the console',
        expectedVersion: body.expectedVersion ?? null,
      });
      repo.audit.log('context.save', params.id, { version: context.currentVersion });
      return { context, effectiveFrom: 'next run' };
    }
    return { context: repo.contexts.get(params.id), effectiveFrom: 'next run' };
  });

  router.post('/api/contexts/:id/versions', async ({ params, body }) => {
    const context = repo.contexts.saveVersion(params.id, {
      config: body?.config ?? {},
      note: body?.note ?? '',
      expectedVersion: body?.expectedVersion ?? null,
    });
    return { context, effectiveFrom: 'next run' };
  });

  router.post('/api/contexts/:id/duplicate', async ({ params, body }) => ({
    context: repo.contexts.duplicate(params.id, body?.name),
  }));

  router.delete('/api/contexts/:id', async ({ params }) => dependencies.change('context',params.id));

  router.post('/api/contexts/:id/preview', async ({ params, body }) => {
    const context = repo.contexts.get(params.id);
    if (!context) throw new HttpError(404, 'CONTEXT_NOT_FOUND', '上下文方案不存在');
    const preview = previewContext(app, context, body ?? {});
    const compiled = preview.compiled;
    let harnessSections = [];
    try {
      const systemPrompt = app.ctx.get?.('systemPrompt');
      if (systemPrompt?.assemble) {
        const assembly = await systemPrompt.assemble({});
        harnessSections = (assembly.sections ?? []).map((s) => ({
          name: s.name,
          chars: String(s.text ?? '').length,
          preview: truncate(String(s.text ?? ''), 400),
        }));
      }
    } catch (error) {
      harnessSections = [{ name: '（无法读取 harness 基础提示词）', chars: 0, preview: error.message }];
    }
    return {
      mode: 'preview',
      previewMode: preview.mode,
      source: preview.source,
      compiled,
      harnessSections,
      notes: [
        'token 为估算值：插件无法读取真实分词器。',
        '预览反映“现在保存的配置”会形成的内容；实际运行会再固定一份快照。',
        'DSH 自身的基础提示词与其工具定义不在此处展开，运行时由 harness 追加。',
      ],
    };
  });

  // ------------------------------------------------------------- memory
  /**
   * Legacy imports stamp each block with `<!-- source: <path> sha256:<hash>
   * imported:<iso> -->`. Surfacing that marker is what tells a migrator apart from
   * something Yu wrote itself — otherwise a former file looks like a live edit.
   */
  function blockProvenance(content) {
    const matches = [...String(content ?? '').matchAll(/<!--\s*source:\s*(.+?)\s+sha256:([0-9a-f]+)(?:\s+imported:([0-9T:.Z-]+))?\s*-->/g)];
    if (matches.length === 0) return null;
    const first = matches[0];
    return {
      kind: 'migration',
      path: first[1],
      sha256: first[2],
      importedAt: first[3] ? Date.parse(first[3]) : null,
      count: matches.length,
    };
  }

  router.get('/api/memory', async () => {
    // The text files are the authority for block content: an edit made in an
    // editor must show up here, not the copy that was published last night.
    let fileSync = null;
    try {
      fileSync = app.memoryFiles?.sync?.() ?? null;
    } catch (error) {
      log.warn(`reading short-term memory files failed: ${error.message}`);
    }
    const blocks = repo.memory.blocks().map((block) => {
      const source = blockProvenance(block.content);
      const length = String(block.content ?? '').length;
      return {
        ...block,
        filePath: blockPath(paths, block.slug),
        // The stable form: relative to the data root, which is a setting the user
        // can move. The absolute path is a convenience for this machine only.
        fileRelative: relativeBlockPath(block.slug),
        charCount: length,
        source,
        // The compiled prompt caps a block at 6000 chars and the whole memory at
        // 14000, so a big migrated block is partly invisible to the model.
        truncatedInPrompt: length > 6000,
      };
    });
    const style = repo.style.current();
    const versions = repo.memory.versions({ limit: 20 });
    const pending = repo.archives.pending(50);
    const ruleGroups = settings.groupedPublic()?.memory ?? [];
    return {
      blocks,
      revision: repo.memory.revision(),
      projection: repo.memory.projectionState(),
      render: repo.memory.render(blocks),
      /**
       * Where the text lives on disk, and what is actually in that directory. The
       * console shows this so "memory is a file I can edit" is checkable rather
       * than a claim.
       */
      files: {
        dir: app.memoryFiles?.dir ?? null,
        relativeDir: RELATIVE_DIR,
        root: paths.dataDir,
        sync: fileSync,
        items: (() => {
          const dir = app.memoryFiles?.dir;
          if (!dir) return [];
          try {
            return fs
              .readdirSync(dir)
              .filter((name) => name.endsWith('.md'))
              .map((name) => {
                const full = path.join(dir, name);
                const stat = fs.statSync(full);
                return {
                  name,
                  path: full,
                  relative: `${RELATIVE_DIR}/${name}`,
                  bytes: stat.size,
                  mtime: Math.round(stat.mtimeMs),
                };
              })
              .sort((a, b) => a.name.localeCompare(b.name));
          } catch {
            return [];
          }
        })(),
      },
      style,
      styleVersions: repo.style.versions(10),
      versions,
      pendingArchives: pending.map((a) => ({
        id: a.id,
        at: a.createdAt,
        taskId: a.taskId,
        excerpt: truncate(a.material?.reply ?? a.material?.input ?? '', 180),
      })),
      maintenance: repo.memory.maintenanceLog(30),
      categories: repo.constants.MEMORY_CATEGORIES,
      /** Iteration rules: what is enforced right now, and how to edit it. */
      rules: {
        effective: readMemoryRules(settings),
        spec: (Array.isArray(ruleGroups) ? ruleGroups : []).filter((setting) =>
          String(setting.key).startsWith('memory.rules.'),
        ),
      },
      /** Version steps with per-block sizes: the shape of how memory evolved. */
      evolution: versions
        .slice()
        .sort((a, b) => a.version - b.version)
        .map((version) => ({
          version: version.version,
          at: version.publishedAt || version.createdAt,
          source: version.source,
          note: version.note,
          chars: Object.fromEntries((version.blocks ?? []).map((block) => [block.slug, String(block.content ?? '').length])),
        })),
    };
  });

  /** Read the short-term memory directory back into the database, on demand. */
  router.get('/api/memory/files/preview', async () => previewFileImport(repo, paths));

  router.post('/api/memory/files/sync', async ({ body }) => {
    validateFileImport(repo, paths, body ?? {});
    const report = app.memoryFiles?.sync?.() ?? null;
    return { report, revision: repo.memory.revision(), projection: repo.memory.projectionState(), effectiveFrom: 'next run' };
  });

  router.post('/api/memory/blocks', async ({ body }) => {
    const block = repo.memory.createBlock(body ?? {});
    return { block, revision: repo.memory.revision(), projection: repo.memory.projectionState() };
  });

  router.patch('/api/memory/blocks/:slug', async ({ params, body }) => {
    const block = repo.memory.updateBlock(params.slug, body ?? {});
    return { block, revision: repo.memory.revision(), projection: repo.memory.projectionState() };
  });

  router.delete('/api/memory/blocks/:slug', async ({ params }) => {
    const ok = repo.memory.deleteBlock(params.slug);
    return { ok, projection: repo.memory.projectionState() };
  });

  router.post('/api/memory/blocks/reorder', async ({ body }) => ({
    blocks: repo.memory.reorder(Array.isArray(body?.slugs) ? body.slugs : []),
  }));

  /**
   * Clean already-stored memory with the current rules. Preview unless
   * `dryRun: false`, because publishing rewrites every block in one version.
   */
  router.post('/api/memory/sanitize', async ({ body }) =>
    memoryService.sanitize({ dryRun: body?.dryRun !== false, includeEmpty: body?.includeEmpty === true }),
  );

  router.get('/api/memory/versions', async ({ query }) => ({ versions: repo.memory.versions({ limit: Number(query.limit ?? 50) }) }));

  router.get('/api/memory/versions/:id', async ({ params }) => {
    const version = repo.memory.versionById(params.id);
    if (!version) throw new HttpError(404, 'VERSION_NOT_FOUND', '记忆版本不存在');
    return { version };
  });

  router.post('/api/memory/versions/:id/restore', async ({ params }) => {
    const version = repo.memory.restoreVersion(params.id);
    const projection = repo.memory.repairProjection();
    return { version, projection, revision: repo.memory.revision(), effectiveFrom: 'next run' };
  });

  router.post('/api/memory/publish', async ({ body }) => {
    const blocks = Array.isArray(body?.blocks) ? body.blocks : repo.memory.blocks();
    const style = body?.style ?? repo.style.current()?.content ?? '';
    const version = repo.memory.publish({
      blocks,
      style,
      note: body?.note ?? 'manual publish from the console',
      source: 'manual',
      expectedRevision: body?.expectedRevision ?? null,
    });
    // The published text is what the files must say from now on.
    const projection = repo.memory.repairProjection();
    app.scheduler.refreshAll();
    return { version, projection, revision: repo.memory.revision(), effectiveFrom: 'next run' };
  });

  router.post('/api/memory/maintenance/preview', async () => memoryService.previewSync());

  router.post('/api/memory/maintenance/run', async ({ body }) => {
    const result = await memoryService.requireSync({ trigger: body?.trigger ?? 'manual' });
    return { ...result, effectiveFrom: result.status === 'published' ? 'next run' : null };
  });

  router.get('/api/memory/maintenance/log', async () => ({ log: repo.memory.maintenanceLog(50) }));

  // ------------------------------------------------- long-term memory (DB)
  //
  // The console's second memory layer. Everything here reads or edits
  // `memories`, never the blocks: the blocks are the injected summary, this is
  // the durable database behind it.
  router.get('/api/memory-libraries', async () => ({libraries:app.memoryLibraries.list(),contexts:app.memoryLibraries.contexts()}));
  for(const [route,method] of [['preview','preview'],['import','importFile']]) router.post('/api/memory-libraries/'+route,async ({body})=>{
    try{return await app.memoryLibraries[method](body?.path);}catch(error){throw new HttpError(400,'LIBRARY_IMPORT_FAILED',error.message);}
  });
  router.post('/api/memory-libraries/search',async ({body})=>{
    try{return {hits:app.memoryLibraries.search(body??{})};}catch(error){throw new HttpError(400,'LIBRARY_SEARCH_FAILED',error.message);}
  });
  router.patch('/api/memory-libraries/:id',async ({params,body})=>{
    try{return app.memoryLibraries.update(params.id,body??{});}catch(error){throw new HttpError(400,'LIBRARY_UPDATE_FAILED',error.message);}
  });
  router.delete('/api/memory-libraries/:id',async ({params})=>{
    try{return app.memoryLibraries.remove(params.id);}catch(error){throw new HttpError(400,'LIBRARY_REMOVE_FAILED',error.message);}
  });
  router.post('/api/memory-libraries/batches/:id/undo',async ({params})=>{
    try{return app.memoryLibraries.undo(params.id);}catch(error){throw new HttpError(400,'LIBRARY_UNDO_FAILED',error.message);}
  });
  router.get('/api/memory/db', async ({ query }) => {
    const items = repo.memories.list({
      status: query.status ?? 'active',
      kind: query.kind ?? null,
      subject: query.subject ?? null,
      search: query.search ?? '',
      limit: Number(query.limit ?? 200),
      offset: Number(query.offset ?? 0),
      order: query.order ?? 'recent',
    });
    return {
      items,
      stats: app.memoryStore.stats(),
      retrievals: repo.memories.retrievals(12),
      kinds: app.memoryStore.kindLabels,
      note: '长期记忆按条存储、按相似度合并；短期记忆（五块）是它每次迭代后的摘要。',
    };
  });

  router.get('/api/memory/db/graph', async ({ query }) => {
    const graph = app.memoryStore.graph({
      limit: Number(query.limit ?? 240),
      search: query.search ?? '',
      kind: query.kind ?? null,
    });
    return { ...graph, kinds: app.memoryStore.kindLabels };
  });

  router.post('/api/memory/db/search', async ({ body }) => {
    const query = String(body?.query ?? '').trim();
    const hits = app.memoryStore.search({ query, limit: Number(body?.limit ?? 8) });
    return {
      query,
      terms: app.memoryStore.tokenize(query),
      hits,
      note: hits.length ? '这就是一次真实检索的结果，会原样进入提示词的「长期记忆」小节。' : '没有命中：检索只看字面重合，不做语义猜测。',
    };
  });

  router.post('/api/memory/db', async ({ body }) => {
    const item = repo.memories.create({
      kind: body?.kind ?? 'fact',
      subject: body?.subject ?? '',
      text: body?.text,
      tags: body?.tags ?? [],
      weight: body?.weight ?? 1,
      source: 'manual',
    });
    repo.audit.log('memory.db.create', item.id, { kind: item.kind }, 'user');
    return { item, effectiveFrom: 'next retrieval' };
  });

  router.post('/api/memory/db/import', async ({ body }) => {
    // Default: the five canonical blocks. The migrated `owner` / `people-index`
    // blocks are long reference text, not one-statement rows; importing them
    // would fill the graph with fragments, so they must be asked for explicitly.
    const defaultSlugs = ['recent', 'people', 'ongoing', 'thoughts', 'state'];
    const slugs = Array.isArray(body?.slugs) ? body.slugs.map(String) : defaultSlugs;
    const result = app.memoryStore.importBlocks({ slugs });
    repo.audit.log('memory.db.import', `${result.created}`, { slugs, merged: result.merged }, 'user');
    return {
      ...result,
      effectiveFrom: 'next retrieval',
      note: '把现有短期记忆拆成一条一条，导入长期记忆库。短期记忆块本身不变。',
    };
  });

  router.patch('/api/memory/db/:id', async ({ params, body }) => {
    const current = repo.memories.byId(params.id);
    if (!current) throw new HttpError(404, 'MEMORY_NOT_FOUND', '这条记忆不存在');
    let item = current;
    if (body?.status && body.status !== current.status) item = repo.memories.setStatus(params.id, body.status);
    if (body?.text !== undefined || body?.subject !== undefined || body?.kind !== undefined) {
      app.db.run(
        'UPDATE memories SET text = ?, subject = ?, kind = ? WHERE id = ?',
        String(body.text ?? item.text),
        String(body.subject ?? item.subject),
        String(body.kind ?? item.kind),
        params.id,
      );
      item = repo.memories.byId(params.id);
    }
    repo.audit.log('memory.db.update', params.id, { patch: body ?? {} }, 'user');
    return { item, effectiveFrom: 'next retrieval' };
  });

  router.delete('/api/memory/db/:id', async ({ params }) => {
    const item = repo.memories.setStatus(params.id, 'forgotten');
    if (!item) throw new HttpError(404, 'MEMORY_NOT_FOUND', '这条记忆不存在');
    repo.audit.log('memory.db.forget', params.id, {}, 'user');
    return { ok: true, item, note: '已从长期记忆库移出（保留行，可恢复）；短期记忆块不受影响。' };
  });

  // --------------------------------------------------- memory: documents
  //
  // The third shape of memory: long text Yu wrote about itself (diary,
  // self-portrait, glossary). The list deliberately omits `content`; one
  // document is fetched when it is opened.
  const DOCUMENT_CATEGORIES = [
    { id: 'self', label: '自我认知' },
    { id: 'todo', label: '待办' },
    { id: 'proposal', label: '提案' },
    { id: 'group', label: '群档案' },
    { id: 'diary', label: '日记' },
    { id: 'freetime', label: '自由活动' },
    { id: 'note', label: '笔记' },
    { id: 'prts', label: '游戏笔记' },
    { id: 'video', label: '视频笔记' },
    { id: 'hot', label: '热点' },
    { id: 'misc', label: '其他' },
  ];

  router.get('/api/memory/docs', async ({ query }) => ({
    documents: repo.documents.list({ category: query.category ?? null, search: query.search ?? '' }),
    stats: repo.documents.stats(),
    categories: DOCUMENT_CATEGORIES,
    note: '这些是 Yu 自己写的长文本：不注入提示词，按需打开。列表只带标题与字数，正文在打开时读取。',
  }));

  router.get('/api/memory/docs/:slug', async ({ params }) => {
    const document = repo.documents.get(params.slug);
    if (!document) throw new HttpError(404, 'DOCUMENT_NOT_FOUND', '文档不存在');
    return { document };
  });

  router.patch('/api/memory/docs/:slug', async ({ params, body }) => {
    const document = repo.documents.update(params.slug, {
      title: body?.title,
      category: body?.category,
      content: body?.content,
    });
    repo.audit.log('document.update', params.slug, { chars: document.chars }, 'user');
    return { document, effectiveFrom: 'immediately', note: '已保存到数据库；这些文档不自动注入提示词。' };
  });

  router.post('/api/memory/docs', async ({ body }) => {
    const title = String(body?.title ?? '').trim();
    if (!title) throw new HttpError(400, 'TITLE_REQUIRED', '需要 title');
    const slug =
      String(body?.slug ?? '').trim() ||
      `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const document = repo.documents.upsert({
      slug,
      title,
      category: body?.category ?? 'note',
      content: body?.content ?? '',
      source: 'manual',
      orderIndex: Number(body?.orderIndex ?? 0),
      overwriteContent: true,
    });
    repo.audit.log('document.create', slug, { chars: document.chars }, 'user');
    return { document, effectiveFrom: 'immediately' };
  });

  router.delete('/api/memory/docs/:slug', async ({ params }) => {
    const ok = repo.documents.remove(params.slug);
    if (!ok) throw new HttpError(404, 'DOCUMENT_NOT_FOUND', '文档不存在');
    repo.audit.log('document.delete', params.slug, {}, 'user');
    return { ok: true, note: '已从文档库删除；导入脚本可以再把它加回来。' };
  });

  router.get('/api/style', async () => ({ current: repo.style.current(), versions: repo.style.versions(20) }));

  router.post('/api/style', async ({ body }) => ({
    version: repo.style.publish({ content: body?.content ?? '', note: body?.note ?? '', source: 'manual' }),
    effectiveFrom: 'next run',
  }));

  router.post('/api/style/:id/restore', async ({ params }) => ({ version: repo.style.restore(params.id) }));

  // ----------------------------------------------------------- projects
  router.get('/api/projects', async () => ({ projects: repo.projects.list(), savedProgress: repo.projects.savedProgress() }));

  router.get('/api/projects/:id', async ({ params }) => {
    const project = repo.projects.get(params.id);
    if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', '项目不存在');
    return { project, reading: project.kind === 'reading' ? readingService.status(params.id) : null };
  });

  router.patch('/api/projects/:id', async ({ params, body }) => {
    const project = repo.projects.get(params.id);
    if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (body?.sourcePath !== undefined) {
      const updated = readingService.setSource(params.id, body.sourcePath);
      return { project: updated, reading: readingService.status(params.id), effectiveFrom: 'next run' };
    }
    if (body?.progress !== undefined) {
      const updated = readingService.setProgress(params.id, body.progress);
      return { project: updated, reading: readingService.status(params.id) };
    }
    const updated = repo.projects.upsert({
      id: params.id,
      name: body?.name ?? project.name,
      kind: project.kind,
      state: { ...project.state, ...(body?.state ?? {}) },
    });
    return { project: updated };
  });

  // -------------------------------------------------------------- tools
  /**
   * The group message buffer, as the console sees it.
   *
   * This is the honest view of "what has she overheard": rooms, counts, the last
   * few messages, and when memory last drained the queue. Decisions themselves are
   * recorded per event in `channel_events`, not here.
   */
  router.get('/api/group/buffer', async ({ query }) => {
    const channelId = query.channelId ?? null;
    const peerId = query.peerId ?? null;
    const rooms = repo.groupBuffer.rooms();
    const selected = {
      channelId: channelId ?? rooms[0]?.channelId ?? '',
      peerId: peerId ?? rooms[0]?.peerId ?? '',
    };
    return {
      stats: repo.groupBuffer.stats({ channelId, peerId }),
      total: repo.groupBuffer.stats(),
      rooms,
      recent: repo.groupBuffer
        .window({ channelId: selected.channelId, peerId: selected.peerId, limit: 30 })
        .filter(Boolean),
      /**
       * The policies that consume this buffer. They live on triggers, so the
       * readout lists them instead of a global settings block that no longer
       * exists — one room can have a completely different trigger from another.
       */
      triggers: repo.triggers
        .listAll()
        .filter((trigger) => trigger.type === 'group-watch')
        .map((trigger) => ({
          id: trigger.id,
          taskId: trigger.taskId,
          label: trigger.label,
          enabled: trigger.enabled,
          description: app.scheduler.describe(trigger),
          spec: trigger.spec ?? {},
        })),
    };
  });

  router.post('/api/group/buffer/clear', async ({ body }) => ({
    cleared: repo.groupBuffer.clear({ channelId: body?.channelId ?? null, peerId: body?.peerId ?? null }),
  }));

  router.get('/api/tools', async () => ({ ...toolService.catalog(), knowledge: toolService.knowledgeStatus() }));
  router.get('/api/tomimi/status', async () => app.tomimi.status());
  router.get('/api/tool-packages',async()=>({packages:app.toolPackages.list(),adapters:app.toolPackages.adapters}));
  router.post('/api/tool-packages',async({body})=>{
    try {
      let manifest=body?.manifest;
      if(body?.manifestPath){const file=path.resolve(body.manifestPath);manifest=JSON.parse(fs.readFileSync(file,'utf8'));if(manifest.config?.path&&!path.isAbsolute(manifest.config.path))manifest.config.path=path.resolve(path.dirname(file),manifest.config.path);}
      return {packages:app.toolPackages.install(manifest)};
    }catch(error){throw new HttpError(error.status??400,'PACKAGE_INVALID',error.message);}
  });
  router.patch('/api/tool-packages/:id',async({params,body})=>{try{return {packages:body?.enabled===false?dependencies.change('packages',params.id,{action:'disable'}):app.toolPackages.setEnabled(params.id,body?.enabled)};}catch(error){throw new HttpError(error.status??400,'PACKAGE_INVALID',error.message);}});
  router.delete('/api/tool-packages/:id',async({params})=>{try{return {packages:dependencies.change('packages',params.id),filesRetained:true};}catch(error){throw new HttpError(error.status??400,'PACKAGE_INVALID',error.message);}});
  router.post('/api/tool-packages/call',async({body})=>{try{return await app.toolPackages.execute(body??{});}catch(error){throw new HttpError(400,'PACKAGE_CALL_FAILED',error.message);}});

  /**
   * The knowledge corpus, searchable from the console.
   *
   * This is not the memory database. Long-term memory is Yu's own facts about
   * people and days (`memories`); Arknights operator/skill data lives in a
   * separate read-only SQLite corpus. Exposing its search here makes the
   * distinction visible and lets a person check the corpus without switching
   * `tools.exposure` on.
   */
  router.get('/api/database-sources', async () => ({sources:app.databaseSources.list()}));
  router.post('/api/database-sources', async ({body}) => {
    try {
      let manifest=body?.manifest;
      if(body?.manifestPath) manifest=JSON.parse(fs.readFileSync(path.resolve(body.manifestPath),'utf8'));
      if(!manifest) throw new Error('需要 manifest 或 manifestPath');
      if(body?.manifestPath && manifest.config?.path && !path.isAbsolute(manifest.config.path)) manifest.config.path=path.resolve(path.dirname(path.resolve(body.manifestPath)),manifest.config.path);
      return {sources:app.databaseSources.install(manifest)};
    } catch(error){throw new HttpError(error.status??400,'SOURCE_INVALID',error.message);}
  });
  router.patch('/api/database-sources/:id',async ({params,body})=>{
    try{return {sources:body?.enabled===false?dependencies.change('sources',params.id,{action:'disable'}):app.databaseSources.setEnabled(params.id,body?.enabled)};}catch(error){throw new HttpError(error.status??400,'SOURCE_INVALID',error.message);}
  });
  router.delete('/api/database-sources/:id',async ({params})=>{
    try{return {sources:dependencies.change('sources',params.id),filesRetained:true};}catch(error){throw new HttpError(error.status??400,'SOURCE_INVALID',error.message);}
  });
  router.post('/api/database-sources/query',async ({body})=>{
    try{return await app.databaseSources.execute(body ?? {});}catch(error){throw new HttpError(400,'SOURCE_QUERY_FAILED',error.message);}
  });

  router.get('/api/tools/admin', async () => {
    const exposure = settings.get('tools.exposure');
    const catalog = app.adminTool?.catalog ?? {};
    return {
      exposure,
      registered: Boolean(app.adminTool),
      ops: Object.entries(catalog).map(([op, meta]) => ({ op, summary: meta.summary, args: meta.args })),
      note:
        exposure === 'none'
          ? '当前设置为不注册任何工具：Yu 不能用工具改自己，仍然可以通过这个管理台修改。'
          : '这些都是通过 yu_admin 真实可执行的 op；页面上改不出来、只有工具能做的事以这里为准。',
    };
  });

  router.get('/api/tools/:name', async ({ params }) => {
    const tool = toolService.get(params.name);
    if (!tool) throw new HttpError(404, 'TOOL_NOT_FOUND', '工具不在当前目录中');
    return { tool, calls: toolService.recentCalls(params.name, 20) };
  });

  router.patch('/api/tools/:name', async ({ params, body }) => {
    const result = toolService.updateOverlay(params.name, {
      enabled: body?.enabled,
      description: body?.description,
      example: body?.example,
      config: body?.config,
    });
    return {
      ...result,
      note:
        body?.description !== undefined
          ? '说明修改只影响管理台展示；要让模型看到新说明，请使用“对模型生效”（会为该 Agent 注册遮蔽定义）。'
          : undefined,
    };
  });

  router.post('/api/tools/:name/try', async ({ params, body }) => toolService.tryRun(params.name, body?.arguments ?? {}));

  // ----------------------------------------------------------- channels
  router.get('/api/channels/peers',async()=>({peers:repo.channels.peers()}));
  router.get('/api/channels', async () => ({
    channels: channelManager.status(),
    types: [
      { id: 'onebot', label: '通用 OneBot v11', transport: 'reverse-ws' },
      { id: 'napcat', label: 'NapCat / OneBot v11', transport: 'reverse-ws' },
      { id: 'snowluma', label: 'SnowLuma / OneBot v11', transport: 'reverse-ws' },
      { id: 'qq-official', label: 'QQ 官方机器人', transport: 'webhook' },
      { id: 'web', label: '内置网页聊天', transport: 'built-in' },
    ],
    adminBase: adminUrl(),
  }));

  router.post('/api/channels/:id/setup-token', async ({params}) => {
    const channel=repo.channels.get(params.id);
    if(!channel || !['onebot','snowluma','napcat'].includes(channel.type)) throw new HttpError(404,'CHANNEL_NOT_FOUND','OneBot连接不存在');
    if(!channel.config?.token) throw new HttpError(409,'TOKEN_MISSING','请先在配置中生成并保存访问口令');
    return {token:channel.config.token};
  });

  router.post('/api/channels', async ({ body }) => {
    const channel = repo.channels.create({
      name: body?.name ?? '新连接',
      type: body?.type ?? 'napcat',
      config: body?.config ?? {},
      enabled: body?.enabled === true,
    });
    channelManager.sync();
    repo.audit.log('channel.create', channel.id, { type: channel.type });
    return { channel: maskChannel(repo.channels.get(channel.id)) };
  });

  /**
   * Merge a config patch into the stored one.
   *
   * The browser only ever receives masked configs (`token__set` instead of
   * `token`), so echoing the whole object back must not erase credentials. An
   * explicit empty string still clears a field — that is the only way to forget
   * a secret, and it has to be deliberate.
   */
  const mergeChannelConfig = (current, patch) => {
    if (!patch || typeof patch !== 'object') return current ?? {};
    const merged = { ...(current ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (key.endsWith('__set')) continue;
      if (value === undefined) continue;
      merged[key] = value;
    }
    return merged;
  };

  router.patch('/api/channels/:id', async ({ params, body }) => {
    const current = repo.channels.get(params.id);
    if (!current) throw new HttpError(404, 'CHANNEL_NOT_FOUND', '连接不存在');
    // Switching the implementation keeps an existing enabled state only when the
    // caller explicitly asks for it; otherwise the connection is stopped first.
    const typeChanged = body?.type && body.type !== current.type;
    const next = repo.channels.update(params.id, {
      name: body?.name ?? current.name,
      config: mergeChannelConfig(current.config, body?.config),
      enabled: body?.enabled ?? (typeChanged ? false : current.enabled),
      status: typeChanged ? 'disabled' : current.status,
      lastError: typeChanged ? null : current.lastError,
      connectedAt: current.connectedAt,
    });
    channelManager.sync();
    repo.audit.log('channel.update', params.id, { typeChanged });
    return { channel: maskChannel(repo.channels.get(next.id)) };
  });

  router.delete('/api/channels/:id', async ({ params }) => {
    const channel = repo.channels.get(params.id);
    if (channel?.enabled) {
      repo.channels.update(params.id, { ...channel, enabled: false, status: 'disabled' });
      channelManager.sync();
    }
    const ok = repo.channels.remove(params.id);
    return { ok };
  });

  router.post('/api/channels/test', async ({ body }) => channelManager.testConfig({ type: body?.type, config: body?.config ?? {} }));

  router.post('/api/channels/:id/test', async ({ params }) => {
    const channel = repo.channels.get(params.id);
    if (!channel) throw new HttpError(404, 'CHANNEL_NOT_FOUND', '连接不存在');
    const adapter = channelManager.adapterFor(params.id);
    if (!adapter) {
      return {
        ok: false,
        note: '连接当前未启用；以下是对已保存配置的静态检查。',
        ...(await channelManager.testConfig({ type: channel.type, config: channel.config })),
      };
    }
    const result = await adapter.test();
    return { ...result, selfTest: adapter.selfTest?.() ?? null };
  });

  router.post('/api/channels/:id/enable', async ({ params, body }) => {
    const channel = repo.channels.get(params.id);
    if (!channel) throw new HttpError(404, 'CHANNEL_NOT_FOUND', '连接不存在');
    repo.channels.update(params.id, { ...channel, enabled: body?.enabled !== false, status: body?.enabled === false ? 'disabled' : 'connecting' });
    channelManager.sync();
    app.alerts.resetChannel?.(params.id);
    return { channel: maskChannel(repo.channels.get(params.id)) };
  });

  // ------------------------------------------------- channels: console & QR
  /**
   * Console addresses per channel type. A bot framework keeps two faces: a Web UI
   * for login (the only place a QR comes from) and the OneBot HTTP API Yu talks to.
   */
  const CONSOLE_DEFAULTS = {
    napcat: { consoleUrl: 'http://127.0.0.1:6099', httpBase: 'http://127.0.0.1:3000' },
    snowluma: { consoleUrl: 'http://127.0.0.1:5099', httpBase: '' },
    'qq-official': { consoleUrl: 'https://q.qq.com/qqbot/', httpBase: '' },
  };

  const channelOr404 = (id) => {
    const channel = repo.channels.get(id);
    if (!channel) throw new HttpError(404, 'CHANNEL_NOT_FOUND', '连接不存在');
    return channel;
  };

  const consoleUrlOf = (channel) => {
    const configured = String(channel.config?.consoleUrl ?? '').trim();
    const fallback = CONSOLE_DEFAULTS[channel.type]?.consoleUrl ?? '';
    return (configured || fallback).replace(/\/+$/, '');
  };

  const httpBaseOf = (channel) => {
    const configured = String(channel.config?.httpBase ?? '').trim();
    const fallback = CONSOLE_DEFAULTS[channel.type]?.httpBase ?? '';
    return (configured || fallback).replace(/\/+$/, '');
  };

  /**
   * Where is this program installed?
   *
   * Reads the configured folder first, then a bounded scan of the usual places,
   * then the process list — in that order, because the first is instant and the
   * last is the most likely to be stale.
   */
  const locateFor = async (channel) => {
    const configured = String(channel.config?.installDir ?? '').trim();
    if (configured && fs.existsSync(configured)) {
      const info = inspectDir(configured);
      return { dir: configured, type: channel.type, found: info.found, launchers: info.launchers, sources: info.sources, via: 'config' };
    }
    const wanted = channel.type === 'snowluma' ? 'snowluma' : 'napcat';
    const scan = scanForInstalls();
    const hit = scan.hits.find((candidate) => candidate.type === wanted) ?? scan.hits[0] ?? null;
    if (hit) return { ...hit, via: 'scan' };
    const running = await runningInstalls();
    const proc = running.hits.find((candidate) => /napcat|snowluma/i.test(candidate.name ?? '')) ?? null;
    if (proc) {
      const info = inspectDir(proc.dir);
      return {
        dir: proc.dir,
        type: /snowluma/i.test(proc.name ?? '') ? 'snowluma' : 'napcat',
        found: info.found,
        launchers: info.launchers,
        sources: info.sources,
        via: 'process',
        pid: proc.pid,
      };
    }
    return null;
  };

  async function reachable(url, timeoutMs = 1200) {
    if (!url) return false;
    try {
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      // Any HTTP answer means something is listening; the status is not the point.
      return response.status < 500 || response.status >= 400;
    } catch {
      return false;
    }
  }

  async function napcatCall(base, token, action) {
    const response = await fetch(`${base}/api/QQLogin/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(
        401,
        'WEBUI_TOKEN_REQUIRED',
        'NapCat 控制台要求 token：把 napcat/config/webui.json 里的 token 填进「控制台 token」，或点「从安装目录读取」。',
      );
    }
    if (!response.ok) throw new HttpError(502, 'CONSOLE_ERROR', `NapCat 返回 HTTP ${response.status}`);
    return response.json().catch(() => ({}));
  }

  /** Console login for a locally installed bot framework, when it publishes one. */
  const consoleLogin = (channel) => {
    const dir = String(channel.config?.installDir ?? '').trim();
    if (!dir) return null;
    const read = (name) => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        return '';
      }
    };
    const note = read('private/login.txt');
    const fromFile = {
      username: note.match(/Username:\s*(\S+)/i)?.[1] ?? null,
      password: note.match(/Initial password:\s*(\S+)/i)?.[1] ?? null,
    };
    // SnowLuma regenerates the initial password on every boot until it is changed,
    // so the newest log line wins over the install note.
    const logs = `${read('private/stdout.log')}\n${read('private/stderr.log')}`;
    const latest = [...logs.matchAll(/initial credentials:\s*user=(\S+)\s+password=(\S+)/g)].at(-1);
    if (!latest && !fromFile.password) return null;
    return {
      username: latest?.[1] ?? fromFile.username ?? 'admin',
      password: latest?.[2] ?? fromFile.password,
      source: latest ? '最近一次启动日志' : '安装说明文件',
      note: '没改过初始密码前，每次启动都会换一个；登录后请立刻改密码。',
    };
  };

  router.get('/api/channels/:id/console', async ({ params }) => {
    const channel = channelOr404(params.id);
    const consoleUrl = consoleUrlOf(channel);
    const httpBase = httpBaseOf(channel);
    // When the process lives on another machine, that machine's bridge is the
    // only honest source of status: probing 127.0.0.1 here would always say "down".
    const bridgeUrl = String(channel.config?.bridgeUrl ?? '').trim();
    let bridgeStatus = null;
    if (bridgeUrl) {
      try {
        const response = await fetch(new URL('/status', bridgeUrl), { signal: AbortSignal.timeout(4000) });
        bridgeStatus = (await response.json())?.snowluma ?? null;
      } catch {
        bridgeStatus = null;
      }
    }
    return {
      type: channel.type,
      consoleUrl,
      httpBase,
      consoleUp: bridgeStatus ? Boolean(bridgeStatus.consoleUp) : await reachable(consoleUrl),
      bridgeStatus,
      remote: Boolean(bridgeUrl),
      onebotUp: await reachable(httpBase ? `${httpBase}/get_status` : null),
      supportsQr: channel.type === 'napcat',
      login: consoleLogin(channel),
      qrSupportedReason:
        channel.type === 'snowluma'
          ? 'SnowLuma 控制台用密码登录，Yu 不持有密码，只提供快捷入口。'
          : channel.type === 'qq-official'
            ? 'QQ 官方机器人用平台后台扫码/配置，不在本机。'
            : null,
    };
  });

  /** Read a local install directory and prefill the connection fields. */
  router.post('/api/channels/:id/discover', async ({ params, body }) => {
    const channel = channelOr404(params.id);
    const requested = String(body?.installDir ?? '').trim();
    let located = requested ? { dir: requested, via: 'input' } : await locateFor(channel);
    if (!located) {
      throw new HttpError(
        400,
        'INSTALL_NOT_FOUND',
        '没有自动找到安装目录。点「查找安装位置」看搜索范围，或直接把 NapCat / SnowLuma 的文件夹填进来。',
      );
    }
    const dir = located.dir;
    if (!fs.existsSync(dir)) throw new HttpError(400, 'INSTALL_DIR_MISSING', `目录不存在：${dir}`);

    const info = inspectDir(dir);
    const found = { ...info.found, installDir: dir };
    if (Object.keys(info.found).length === 0) {
      const launchers = info.launchers;
      throw new HttpError(
        400,
        'NOTHING_FOUND',
        `在 ${dir} 下没有找到 config/webui.json 或 config/onebot11.json。` +
          (launchers.length ? `目录里有启动程序：${launchers.map((item) => path.basename(item)).join('、')}` : ''),
      );
    }
    const updated = repo.channels.update(channel.id, {
      ...channel,
      config: { ...channel.config, ...found },
    });
    repo.audit.log('channel.discover', channel.id, { dir, keys: Object.keys(info.found), via: located.via });
    return {
      channel: maskChannel(updated),
      found: maskConfig(found),
      sources: info.sources,
      dir,
      via: located.via,
      launchers: info.launchers,
    };
  });

  /** Discovery-only: where are these programs, and are they running? */
  let installCache = null;
  router.get('/api/channels/installs', async ({ query }) => {
    const stale = !installCache || Date.now() - installCache.at > 60_000;
    if (stale || query.refresh === '1') {
      const scan = scanForInstalls();
      const running = await runningInstalls();
      installCache = {
        at: Date.now(),
        value: {
          ...scan,
          hits: scan.hits.map((hit) => ({ ...hit, found: maskConfig(hit.found) })),
          running: { ...running, hits: running.hits.map((hit) => ({ pid: hit.pid, name: hit.name, dir: hit.dir })) },
        },
      };
    }
    return {
      ...installCache.value,
      cached: !stale,
      note: installCache.value.hits.length
        ? '找到的目录可以直接点「使用这个目录」，也可以点「启动」让 Yu 在后台拉起它。'
        : '常见位置没有找到。你可以在渠道里直接填安装目录，或者先手动启动一次，Yu 会从进程里认出它。',
    };
  });

  /**
   * Start the program and wait for its console.
   *
   * This is the "I don't know where it is and I don't want a terminal" path:
   * locate → launch hidden → poll the console port → fill in the token from the
   * install's own config. What it will not do is pretend: if the program is not
   * on disk it says so instead of installing anything.
   */
  router.post('/api/channels/:id/launch', async ({ params, body }) => {
    const launchChannel = channelOr404(params.id);
    // A channel whose process lives on another machine (Windows, while Yu is in
    // WSL) is started by that machine's bridge; Yu never pretends to own it.
    const bridgeUrl = String(launchChannel.config?.bridgeUrl ?? '').trim();
    if (bridgeUrl) {
      try {
        const response = await fetch(new URL('/start', bridgeUrl), { method: 'POST', signal: AbortSignal.timeout(90_000) });
        const payload = await response.json();
        return { ok: payload.ok !== false, via: 'bridge', bridge: bridgeUrl, ...payload };
      } catch (error) {
        return { ok: false, via: 'bridge', bridge: bridgeUrl, reason: 'BRIDGE_UNREACHABLE', message: error.message };
      }
    }
    const channel = channelOr404(params.id);
    const consoleUrl = consoleUrlOf(channel);
    if (channel.type === 'qq-official') {
      return {
        ok: false,
        mode: 'external',
        consoleUrl,
        note: 'QQ 官方机器人没有本机进程要启动；扫码与配置都在 q.qq.com 后台完成。',
      };
    }
    // QQ comes first even when the console is already up: the usual stuck state
    // is "SnowLuma is running, its console says there is no QQ to inject into".
    const qq = channel.type === 'qq-official' ? null : ensureQq({ log });
    // SnowLuma is launched by its own script with `SNOWLUMA_HOOK_AUTOLOAD=0`, so it
    // never sees an independently started QQ. "Launch" here means: stop it if it is
    // running, then start it again with the hook allowed, which is the only way to
    // change the environment of a process that is already up.
    const hookEnv =
      channel.type === 'snowluma' ? { SNOWLUMA_HOOK_AUTOLOAD: '1', SNOWLUMA_HOOK_AUTOLOAD_ALL: '1' } : null;
    let restarted = false;
    if (hookEnv && (await reachable(consoleUrl))) {
      const earlyDir = String(channel.config?.installDir ?? '') || (await locateFor(channel))?.dir || '';
      const stopped = stopInstall(earlyDir, { log });
      if (stopped.ok) {
        restarted = true;
        // Wait for the port to actually close; the stop script returns before the
        // listener is gone, and a lingering socket would look like "already up".
        for (let i = 0; i < 20; i += 1) {
          if (!(await reachable(consoleUrl))) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
    const alreadyUp = await reachable(consoleUrl);
    if (alreadyUp) {
      return {
        ok: true,
        launched: false,
        already: true,
        qq,
        consoleUrl,
        consoleUp: true,
        note: qq?.started
          ? '控制台本来就在运行；这次把 QQ 一起拉起来了，回到控制台点「刷新」再加载。'
          : '控制台已经在运行，直接扫码即可。',
      };
    }

    const located = body?.installDir
      ? { dir: String(body.installDir), via: 'input', launchers: launchersIn(String(body.installDir)), found: {} }
      : await locateFor(channel);
    if (!located) {
      throw new HttpError(
        404,
        'INSTALL_NOT_FOUND',
        '没有找到 NapCat / SnowLuma 的安装目录。可以点「查找安装位置」，或手动填目录后重试。',
      );
    }
    const started = launchInstall(located.dir, { log, env: hookEnv });
    if (!started.ok) {
      throw new HttpError(
        409,
        started.reason ?? 'LAUNCH_FAILED',
        started.note ?? started.error ?? '启动失败',
        started,
      );
    }

    const waited = await waitForHttp(consoleUrl, { timeoutMs: 45_000 });
    // Fill the token/address from the install as soon as the console is up, so
    // the QR request works without the operator opening a file.
    let discovered = null;
    try {
      const info = inspectDir(located.dir);
      if (Object.keys(info.found).length) {
        discovered = { ...info.found, installDir: located.dir };
        repo.channels.update(channel.id, { ...repo.channels.get(channel.id), config: { ...channel.config, ...discovered } });
      }
    } catch (error) {
      log?.debug(`post-launch discovery failed: ${error.message}`);
    }
    repo.audit.log('channel.launch', channel.id, {
      dir: located.dir,
      pid: started.pid,
      consoleUp: waited.ok,
    });
    return {
      ok: waited.ok,
      launched: true,
      qq,
      hookEnv,
      pid: started.pid,
      command: path.basename(started.command),
      dir: located.dir,
      via: located.via,
      restarted,
      consoleUrl,
      consoleUp: waited.ok,
      waitedMs: waited.waitedMs,
      discovered: discovered ? Object.keys(discovered) : [],
      logTail: waited.ok ? null : launcherLogTail(started.logFile),
      note: waited.ok
        ? '已启动并等到控制台。接下来用下面的二维码登录。'
        : `已启动，但 ${Math.round(waited.waitedMs / 1000)} 秒内控制台没有响应。第一次启动可能要更久，稍后点「刷新」；也可能它监听的不是 ${consoleUrl}。`,
      error: waited.ok ? null : waited.reason,
    };
  });

  /**
   * Fetch the QQ login QR from the bot's own Web UI.
   *
   * Only NapCat exposes this over HTTP (bearer token). The image is proxied
   * through Yu so the browser never needs the console token, and so a console on
   * another port does not become a CORS problem.
   */
  router.get('/api/channels/:id/qr', async ({ params }) => {
    const channel = channelOr404(params.id);
    if (channel.type !== 'napcat') {
      throw new HttpError(
        400,
        'QR_UNSUPPORTED',
        CONSOLE_DEFAULTS[channel.type]?.consoleUrl
          ? '这个渠道不能从 Yu 取二维码，请用控制台登录。'
          : '这个渠道类型不支持二维码登录。',
      );
    }
    const base = consoleUrlOf(channel);
    if (!base) throw new HttpError(400, 'NO_CONSOLE_URL', '没有配置控制台地址');
    const token = String(channel.config?.webuiToken ?? '');
    try {
      const payload = await napcatCall(base, token, 'GetQQLoginQrcode');
      const raw = payload?.data?.qrcode ?? payload?.qrcode ?? '';
      if (!raw) {
        return {
          ok: false,
          reason: 'NapCat 没有返回二维码：通常表示已经登录，或需要先在控制台里手动刷新一次。',
          consoleUrl: base,
        };
      }
      const image = String(raw).startsWith('data:') ? String(raw) : `data:image/png;base64,${raw}`;
      let status = null;
      try {
        const statusPayload = await napcatCall(base, token, 'CheckLoginStatus');
        status = statusPayload?.data ?? null;
      } catch {
        status = null;
      }
      return { ok: true, image, status, consoleUrl: base, fetchedAt: now() };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        503,
        'CONSOLE_UNREACHABLE',
        `连不上 NapCat 控制台 ${base}（${error.message}）。先启动 NapCat，再刷新二维码。`,
      );
    }
  });

  router.post('/api/channels/:id/qr/refresh', async ({ params }) => {
    const channel = channelOr404(params.id);
    if (channel.type !== 'napcat') throw new HttpError(400, 'QR_UNSUPPORTED', '这个渠道不支持二维码登录');
    const base = consoleUrlOf(channel);
    const token = String(channel.config?.webuiToken ?? '');
    try {
      await napcatCall(base, token, 'RefreshQRcode');
      return { ok: true };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'CONSOLE_UNREACHABLE', `连不上 NapCat 控制台 ${base}（${error.message}）`);
    }
  });

  // ------------------------------------------------------------- alerts
  router.get('/api/alerts', async () => ({
    states: repo.alerts.list(),
    channels: channelManager.status().map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      enabled: c.enabled,
      category: alertService.categoryOf((c.health ?? {}).state),
      health: c.health ?? null,
    })),
    mailReady: settings.get('mail.enabled'),
    config: {
      thresholdMinutes: settings.get('alert.qqFailureMinutes'),
      cooldownMinutes: settings.get('alert.cooldownMinutes'),
      notifyRecovery: settings.get('alert.notifyRecovery'),
      suppressionUntil: settings.get('alert.maintenanceUntil'),
    },
  }));

  router.post('/api/alerts/preview', async () => alertService.preview());

  router.post('/api/alerts/simulate', async ({ body }) =>
    alertService.simulate({ samples: body?.samples, baseAt: body?.baseAt, config: body?.config }),
  );

  router.post('/api/alerts/suppress', async ({ body }) => {
    const until = Number(body?.until ?? 0);
    settings.set('alert.maintenanceUntil', until);
    return { until, note: until ? '抑制期间的异常不会发送邮件' : '已取消抑制' };
  });

  // -------------------------------------------------------------- inject
  /**
   * The injectable sections and their current text.
   *
   * The page edits one ordered list: built-ins keep their text in settings, a
   * custom section carries its own body. `name` is the technical id a frozen
   * frame uses; `title` is what people see and (by default) what gets injected
   * as the heading.
   *
   * `channel` is the part that decides where the text is read by the model:
   * `system` becomes part of the system prompt, `history` rides in the user
   * turn (once per session or on every message, per `scope`). `wireOrder` is the
   * order the system channel actually registers with the harness, so the console
   * can show the position instead of only the abstract number.
   */
  router.get('/api/inject', async () => {
    const registry = readSections(settings);
    const sections = registry.sections.map((section) => ({
      ...section,
      name: sectionName(section),
      wireOrder: section.channel === 'system' ? wireOrder(section.order) : null,
      channelLabel: CHANNEL_LABELS[section.channel] ?? section.channel,
      ...(section.source ? {file:readInjection(settings,section),fileHash:injectionHash(readInjection(settings,section).text)} : {}),
      body:
        section.source ? readInjection(settings,section).text : section.kind === 'core'
          ? settings.get('prompt.core')
          : section.kind === 'rules'
            ? settings.get('prompt.rules')
            : section.kind === 'custom'
              ? section.body ?? ''
              : '',
    }));
    return {
      sections,
      problems: registry.problems,
      defaults: defaultSections(),
      channels: [
        {
          id: 'system',
          label: CHANNEL_LABELS.system,
          hint: '写进系统提示词，和 DSH 的身份段同一条消息；会话开头定格，模型读作「我是谁、我的规矩」。',
        },
        {
          id: 'history',
          label: CHANNEL_LABELS.history,
          hint: '拼在用户这句话前面，模型读作「这一轮我拿到的材料」；不进系统提示词，也不占它的缓存。',
        },
      ],
      orderBand: SYSTEM_BAND,
      retrieval: {
        enabled: settings.get('memory.db.retrievalEnabled'),
        items: settings.get('memory.db.retrievalItems'),
      },
      runtime: {
        contextMode: settings.get('runtime.contextMode'),
        sessionRotation: settings.get('runtime.sessionRotation'),
      },
      note: '保存后从下一个会话生效；会话页「换新会话」可以立刻生效。系统提示词按会话定格，历史材料按每段自己的时机投递。',
    };
  });

  router.post('/api/inject/sections', async ({ body }) => {
    const prior=new Map(readSections(settings).sections.map(s=>[s.id,s]));
    const incoming=Array.isArray(body?.sections)?body.sections.map(s=>{
      const old=prior.get(s.id);if(!old || Object.hasOwn(s,'source'))return s;
      return {...s,source:old.source,maxChars:s.maxChars ?? old.maxChars,template:s.template ?? old.template,legacyMemorySlug:s.legacyMemorySlug ?? old.legacyMemorySlug};
    }):body?.sections;
    const { sections, problems } = normalizeSections(incoming);
    if (problems.length) throw new HttpError(400, 'SECTIONS_INVALID', problems.join('；'));
    for(const old of prior.values()) if((!sections.some(s=>s.id===old.id) || (old.enabled && sections.some(s=>s.id===old.id&&!s.enabled))) && dependencies.impact('injection',old.id).bindings.some(b=>b.relation!=='global-inherited'))throw new HttpError(409,'RESOURCE_IN_USE','注入仍被引用，请通过资源依赖流程替换或解除绑定');
    const patch = { 'prompt.sections': JSON.stringify(sections) };
    if (body?.texts && typeof body.texts === 'object') {
      for (const key of ['prompt.core', 'prompt.rules']) {
        if (typeof body.texts[key] === 'string') patch[key] = body.texts[key];
      }
    }
    if (body?.retrieval && typeof body.retrieval === 'object') {
      patch['memory.db.retrievalEnabled'] = Boolean(body.retrieval.enabled);
      patch['memory.db.retrievalItems'] = Math.max(0, Math.min(20, Number(body.retrieval.items) || 0));
    }
    // Content edits are explicit and compare against the exact file read by
    // the editor. Merely changing order or path never overwrites a file.
    saveInjectionFiles({repo,settings,sections,contents:body?.fileTexts,hashes:body?.fileHashes,apply:()=>{
    settings.setMany(patch, 'user');
    migrateInjectionFiles({repo,settings});
    }});
    repo.audit.log('inject.sections', 'prompt.sections', {
      sections: sections.map((section) => `${section.id}:${section.channel}:${section.title}`),
    });
    return {
      sections,
      ...sectionEffect(settings, {}, sections.map(sectionName)),
    };
  });

  router.post('/api/inject/preview', async ({ body }) => {
    const contexts = repo.contexts.list();
    const context =
      contexts.find((item) => item.id === body?.contextId) ?? contexts[0] ?? null;
    const preview = previewContext(app, context, body ?? {});
    const compiled = preview.compiled;
    return {
      context: context ? { id: context.id, name: context.name } : null,
      previewMode: preview.mode,
      source: preview.source,
      note: '只读模拟所选来源；不调用模型、不导入外部文件、不写检索账本。实际运行还会读取时间、检索及任务输入。',
      compiled: {
        injectionSelection: compiled.injectionSelection,
        sections: compiled.sections,
        systemBlocks: compiled.systemBlocks,
        history: compiled.history,
        renderedSystem: compiled.renderedSystem,
        renderedInput: compiled.renderedInput,
        budget: compiled.budget,
        warnings: compiled.warnings,
        problems: compiled.problems,
      },
    };
  });

  // ------------------------------------------------------------ settings
  router.get('/api/settings', async () => ({
    groups: settings.groupedPublic(),
    models: await models.catalog(),
    effectiveSelection: models.effectiveSelection({}),
  }));

  router.patch('/api/settings', async ({ body }) => {
    if(['memory.autoAbsorb','memory.autoMaintenanceDaily','memory.maintenanceAt'].some(key=>Object.hasOwn(body?.settings??{},key)))throw new HttpError(400,'TASK_RULES_REQUIRED','请在任务页的记忆同步规则中修改启停和时间');
    if(['tools.knowledgeDbPath','tools.arknightsEnabled','tools.tomimiEnabled','tools.documentsEnabled','tools.tomimiDataDir'].some(key=>Object.hasOwn(body?.settings??{},key)))throw new HttpError(400,'SOURCE_MANAGER_REQUIRED','旧数据库设置已迁移，请在工具页管理数据源或通过配置JSON导入旧配置');
    if(['tools.databaseSources','tools.packages'].some(key=>Object.hasOwn(body?.settings ?? {},key))) throw new HttpError(400,'SOURCE_MANAGER_REQUIRED','请通过工具/数据源管理或配置导入修改清单');
    const changes = settings.setMany(body?.settings ?? {}, 'user');
    if (changes.some(c=>c.key==='triggers.library')) app.scheduler.refreshAll();
    // The nightly maintenance time lives in a task trigger, which the console
    // shows on the task page: change the setting, the trigger follows.
    const touchesMaintenance = changes.some((change) =>
      ['memory.maintenanceAt', 'memory.autoMaintenanceDaily'].includes(change.key),
    );
    let maintenance = null;
    if (touchesMaintenance) {
      try {
        maintenance = app.syncMaintenanceSchedule?.() ?? null;
      } catch (error) {
        log.warn(`re-pointing the maintenance schedule failed: ${error.message}`);
      }
    }
    // Tool registration happens at plugin start. Saving the exposure value is
    // not enough: the registry only changes after a restart, so the response
    // must say so instead of the generic "next run".
    const needsRestart = changes.some((change) => ['tools.exposure','tools.documentsEnabled','tools.arknightsEnabled','tools.tomimiEnabled','tools.knowledgeDbPath','tools.tomimiDataDir'].includes(change.key));
    return {
      changes,
      maintenance,
      effectiveFrom: needsRestart ? 'restart' : 'next run',
      note: needsRestart
        ? '工具注册范围在插件重启后生效；端口与数据目录同样需要重启。'
        : '端口与数据目录需要重启插件后生效。',
    };
  });

  router.get('/api/models', async () => models.catalog());

  /**
   * Send one minimal, real request to a route. The settings page uses this to
   * distinguish "configured" from "actually works" — a distinction the whole
   * delivery is built around.
   */
  router.post('/api/models/test', async ({ body }) => {
    const route = models.effectiveSelection({
      provider: body?.provider ?? undefined,
      model: body?.model ?? undefined,
      reasoningEffort: body?.reasoningEffort ?? undefined,
    });
    if (!route.provider || !route.model) {
      throw new HttpError(409, 'MODEL_UNRESOLVED', route.problems.join('；') || '没有可用的模型路由');
    }
    const result = await models.probe({
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      prompt: body?.prompt ?? undefined,
      shape: body?.shape === 'loop' ? 'loop' : 'minimal',
      sessionId: body?.sessionId ?? null,
      tools: body?.shape === 'loop' ? toolService.catalog().items.map((item) => ({
        name: item.name,
        description: item.description,
        parameters: item.parameters,
      })) : null,
    });
    repo.audit.log('model.probe', `${route.provider}/${route.model}`, { ok: result.ok, code: result.code }, 'user');
    return { route, result, effectiveFrom: 'no change (probe only)' };
  });

  // ------------------------------------------------------- config document
  /**
   * The whole configuration as one editable JSON document.
   *
   * GET never carries secrets. A caller who explicitly wants the SMTP password
   * in the export must POST for it, which is a visible action rather than
   * something that lands in browser history by accident.
   */
  router.get('/api/config', async () => {
    const exported = configFile.exportText();
    const file = configFile.readFile();
    return {
      text: exported.text,
      bytes: exported.bytes,
      filePath: configFile.filePath,
      file: { exists: file.exists, bytes: file.bytes, path: file.path, error: file.error ?? null },
      secretsIncluded: false,
      note: '这是当前数据库导出的配置文档；未包含凭据。',
    };
  });

  router.post('/api/config/export', async ({ body }) => {
    const includeSecrets = body?.includeSecrets === true;
    const exported = configFile.exportText({ includeSecrets });
    return {
      text: exported.text,
      bytes: exported.bytes,
      filePath: configFile.filePath,
      secretsIncluded: includeSecrets,
      note: includeSecrets ? '包含凭据：请当作密码保管。' : '未包含凭据。',
    };
  });

  router.post('/api/config/preview', async ({ body }) => configFile.preview({ text: body?.text }));

  router.post('/api/config/apply', async ({ body }) =>
    configFile.apply({ text: body?.text, confirm: body?.confirm === true }),
  );

  router.post('/api/config/clear', async ({ body }) => configFile.clear({ confirm: body?.confirm === true }));

  router.get('/api/config/file', async () => configFile.readFile());

  router.post('/api/config/file', async ({ body }) => configFile.writeFile({ text: body?.text }));

  router.post('/api/mail/preview', async ({ body }) =>
    mail.preview({ subject: body?.subject ?? 'Yu 邮件预览', body: body?.body ?? '（正文）', to: body?.to ?? null }),
  );

  router.post('/api/mail/test', async ({ body }) => {
    if (body?.confirm !== true) {
      throw new HttpError(400, 'CONFIRM_REQUIRED', '真实发送需要显式确认（confirm: true）');
    }
    return mail.sendTest({ subject: body?.subject, body: body?.body, to: body?.to ?? null });
  });

  router.get('/api/devices', async () => ({ devices: repo.devices.list(), current: null }));

  /**
   * Add another device. The caller is already authenticated on an existing
   * device, so returning the code here is safe and is the only way to pair a
   * second browser without revoking the first.
   */
  router.post('/api/devices/pairing-code', async ({ req }) => {
    auth.refreshPairCode('add-device');
    const code = auth.pendingCode();
    repo.audit.log('auth.pairCode', 'add-device', { requestedBy: req.socket?.remoteAddress ?? '' }, 'user');
    return {
      code,
      codeWrittenTo: paths.pairingCode,
      expiresInMs: 10 * 60_000,
      note: '一次性配对码，10 分钟内有效；在另一台设备的登录页输入即可。',
    };
  });

  router.delete('/api/devices/:id', async ({ params }) => ({ ok: repo.devices.revoke(params.id) }));

  // ------------------------------------------------------------ backups
  router.get('/api/backups', async () => ({ backups: app.backups.list() }));

  router.post('/api/backups', async ({ body }) => ({ backup: await app.backups.create(body?.label ?? 'manual') }));

  router.post('/api/backups/:name/restore', async ({ params }) => {
    const result = await app.backups.restore(params.name);
    return { ...result, note: '数据库文件已替换；请重启插件让新数据库生效。' };
  });

  // ---------------------------------------------------------- migration
  router.get('/api/migration/preview', async ({ query }) => app.migration.preview(query.path));

  router.post('/api/migration/import', async ({ body }) => app.migration.import(body ?? {}));
}
