import {ensureVisibleSync} from './lib/memory-sync-policy.js';
import {createOnboarding} from './lib/onboarding.js';
import {compileContext} from './lib/context-compiler.js';
import {migrateContextPolicies} from './lib/context-policy.js';
import {initializeCompanionDefaults} from './lib/companion-defaults.js';
import {createNativeMemoryHook} from './lib/native-memory-hook.js';
import {ensureShortTermMapping} from './lib/memory-sync.js';
import { createDshLinks, registerDshLinksApi } from './lib/dsh-links.js';
import { deadline } from './lib/lifecycle.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePaths, ensureDirs } from './lib/paths.js';
import { createLogger } from './lib/log.js';
import { createFileSink } from './lib/log-file.js';
import { openDatabase } from './lib/db.js';
import { createRepo } from './lib/repo.js';
import { createSettings } from './lib/settings.js';
import { migrateInjectionFiles,writeInjection } from './lib/injection-files.js';
import { readSections } from './lib/sections.js';
import { createConfigService } from './lib/config-file.js';
import { createModelService } from './lib/models.js';
import { detectHarness, probeCapabilities, versionSupported, SUPPORTED_DSH } from './lib/capabilities.js';
import { summarizeEvents, createAgentHost } from './lib/agent-host.js';
import { createArchiveService } from './lib/archive.js';
import { createMemoryService } from './lib/memory.js';
import { createMemoryStore } from './lib/memories.js';
import { createMemoryLibraries } from './lib/memory-libraries.js';
import { syncFromFiles, memoryDir, memoryFileHashes, projectMemoryTargets } from './lib/memory-files.js';
import { createReadingService } from './lib/reading.js';
import { createSessionMirror } from './lib/session-mirror.js';
import { createDataRootService } from './lib/data-root.js';
import { createDatabaseSources } from './lib/database-sources.js';
import { createToolPackages } from './lib/tool-packages.js';
import { createTomimiService } from './lib/tomimi.js';
import { createToolService } from './lib/tools.js';
import { createAdminTool } from './lib/tools-admin.js';
import { createRunner } from './lib/runner.js';
import { createScheduler } from './lib/scheduler.js';
import { createMailService } from './lib/notify/mail.js';
import { createChannelManager } from './lib/channels/manager.js';
import { createChannelMedia } from './lib/channels/media.js';
import { createAlertService } from './lib/alerts.js';
import { createBackupService } from './lib/backups.js';
import { createMigrationService } from './lib/migration.js';
import { createRequestObserver } from './lib/request-observer.js';
import { createRouter } from './lib/http/router.js';
import { createAuth } from './lib/http/auth.js';
import { createHttpService } from './lib/http/server.js';
import { registerApi } from './lib/http/api.js';
import { registerSystemApi } from './lib/http/api-system.js';
import { SECTION_ORDER } from './lib/context-compiler.js';
import { now } from './lib/util.js';

export const VERSION = '1.0.0';
export const name = '@yu/companion';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Yu's composition root.
 *
 * Construction is synchronous so HTTP routes exist the instant the plugin is
 * applied; `start()` then opens the listener, seeds defaults, recovers
 * interrupted runs and starts the scheduler. `stop()` unwinds in reverse: timers,
 * channels, HTTP, live agents, then storage.
 */
export function apply(ctx, rawConfig = {}) {
  const config = {
    port: Number.isFinite(Number(rawConfig.port)) ? Number(rawConfig.port) : 58800,
    host: String(rawConfig.host ?? '127.0.0.1'),
    dataDir: String(rawConfig.dataDir ?? ''),
    exposeViaDshWeb: rawConfig.exposeViaDshWeb !== false,
    timezone: String(rawConfig.timezone ?? 'Asia/Shanghai'),
  };

  const paths = resolvePaths(config);
  ensureDirs(paths);
  const fileSink = createFileSink({ dir: paths.logs });
  const log = createLogger(null, { level: rawConfig.logLevel ?? 'info', fileSink });

  const harness = detectHarness();
  const compat = versionSupported(harness.version);
  log.info(
    `Yu ${VERSION} starting — harness ${harness.version ?? 'unknown'} (supported ${SUPPORTED_DSH})` +
      (compat.supported ? '' : `; ${compat.reason}`),
  );
  log.info(`data root ${paths.dataDir} (source: ${paths.source}, bootstrap: ${paths.bootstrap})`);
  if (paths.source === 'fallback') {
    log.warn('the configured data root was unusable; running on the platform default instead');
  }

  const db = openDatabase(paths.db, log);
  const repo = createRepo(db, log);
  repo.memory.configureProjection((targets) => projectMemoryTargets(repo, paths, targets), (slugs) => memoryFileHashes(repo, paths, slugs));
  const dataRoot = createDataRootService({ db, paths, log });
  const settings = createSettings(db, log);
  repo.fileSourceOfTruth = Boolean(db.getMeta('injection.files.v1'));
  paths.memoryFileForSlug = slug => readSections(settings).sections.find(s=>s.legacyMemorySlug===slug)?.source?.path;
  Object.defineProperty(settings, 'dataDir', {get:() => paths.dataDir,enumerable:true});
  settings.onSet = (key,value) => {
    if(settings.suppressFileWrites)return;
    if(key==='prompt.core'||key==='prompt.rules') {
      const section = readSections(settings).sections.find(s=>s.id===key.slice(7));
      if(section?.source)writeInjection(settings,section,value);
    }
  };
  if (!settings.get('model.provider') && rawConfig.timezone && !db.getMeta('tz.seeded')) {
    db.setMeta('tz.seeded', '1');
  }
  const models = createModelService(ctx, settings, log);
  const requestObserver = createRequestObserver({ ctx, log });

  // Capabilities are probed on demand, never once at construction: the loader may
  // activate this plugin before `tools`, `webServer`, or `sessionPersistence`
  // exist, and a snapshot from that moment would permanently under-report and
  // skip the registrations that depend on them.
  let capabilitiesCache = null;
  const capabilities = () => {
    if (!capabilitiesCache) {
      capabilitiesCache = probeCapabilities(ctx);
      if (capabilitiesCache.degraded.length) {
        log.warn(
          `missing harness capabilities: ${capabilitiesCache.degraded.map((c) => `${c.id} (${c.feature})`).join(', ')}`,
        );
      }
    }
    return capabilitiesCache;
  };
  const invalidateCapabilities = () => {
    capabilitiesCache = null;
  };

  const agentHost = createAgentHost({
    ctx,
    log,
    settings,
    models,
    // Overlay descriptions become model-facing only when the operator opts in
    // with `behavior: true` on the tool row.
    toolOverlayProvider: () =>
      repo.tools
        .overlays()
        .filter((o) => o.enabled && o.config?.behavior === true && o.description),
  });
  const dshLinks = createDshLinks({ctx,db,repo,deliverOutput:target=>channelManager.send(target)});
  repo.dshLinks=dshLinks;
  const readingService = createReadingService({ repo, settings, log });
  const archiveService = createArchiveService({ repo, settings, paths, log });
  const sessionMirror = createSessionMirror({ paths, log, agentHost });
  const memoryStore = createMemoryStore({ repo, settings, log });
  const memoryService = createMemoryService({
    ctx,
    repo,
    settings,
    log,
    agentHost,
    models,
    archiveService,
    memoryStore,
    paths,
  });
  const nativeMemoryHook = createNativeMemoryHook({ctx,dshLinks,memoryService,log,buildSections:async (context,link)=>{
    const profile=repo.contexts.get(link.contextId);
    if(!profile)throw new Error('关联会话的上下文方案不存在，请重新选择');
    const input=summarizeEvents(await dshLinks.contextEvents(link.id)).userText;
    const compiled=compileContext({repo,settings,models:{effectiveSelection:()=>({ready:true,problems:[]})},contextConfig:profile.config,turnSections:profile.config.turnSections,input,dryRun:true});
    if(compiled.problems.length)throw new Error(compiled.problems.map(p=>p.message).join('; '));
    return compiled.sections;
  }});
  const databaseSources = createDatabaseSources({settings});
  databaseSources.migrateLegacy({alreadyMigrated:Boolean(db.getMeta('database.sources.v1')),markMigrated:()=>db.setMeta('database.sources.v1','1')});
  try { databaseSources.start(); } catch(error) { log.warn(`数据库来源启动失败：${error.message}`); }
  const memoryLibraries = createMemoryLibraries({db,repo,settings,databaseSources});
  repo.memoryLibraries = memoryLibraries;
  const tomimi = createTomimiService({ settings, paths, log });
  // Don't advertise a calculator whose data is absent; the Tools page still
  // shows the status and how to mount the corpus.
  const toolPackages = createToolPackages({settings,repo,paths,log});
  toolPackages.migrateLegacy({alreadyMigrated:Boolean(db.getMeta('tools.packages.v1')) || repo.isConfigurationCleared(),markMigrated:()=>db.setMeta('tools.packages.v1','1')});
  toolPackages.start();
  repo.resourceCatalogProvider=()=>({packages:toolPackages.list().map(r=>({...r,operations:r.active?r.operations:undefined})),sources:databaseSources.list().map(r=>({...r,operations:r.active?r.operations:undefined}))});
  const toolService = createToolService({
    ctx,
    repo,
    settings,
    log,
    databaseSources,
    toolPackages,
  });

  /**
   * A live description of the harness she is running inside.
   *
   * The alternative — writing this into `prompt.core` — goes stale the first time
   * a channel is added or a tool is turned off, and a model that believes a
   * stale tool list either calls something that is gone or never tries something
   * that exists. So it is assembled from the same objects this process uses, per
   * run, and cached briefly because it is read on every turn.
   */
  /**
   * The "framework description" section is gone.
   *
   * It listed the tool count, channel states, task counts and how to change Yu.
   * The tool catalogue already travels with every request, the counts drift mid
   * session, and the yu_admin how-to is in that tool's own description. Keeping
   * the builder as a null keeps the wiring simple for the one caller that still
   * asks for it (the context preview).
   */
  const buildSelfModel = () => null;

  const runner = createRunner({
    ctx,
    repo,
    settings,
    models,
    agentHost,
    archiveService,
    memoryService,
    readingService,
    sessionMirror,
    log,
    paths,
    selfModel: buildSelfModel,
    resourceCatalogProvider:repo.resourceCatalogProvider,
    deliverOutput: target => channelManager.send(target),
  });

  const scheduler = createScheduler({
    repo,
    settings,
    runner,
    log,
    onError: (error) => log.error(`scheduler error: ${error.message}`),
  });

  // Constructed after the scheduler so "apply this document" can put imported
  // triggers on the schedule immediately instead of waiting for a restart.
  const configFile = createConfigService({
    db,
    repo,
    settings,
    paths,
    log,
    refreshSchedules: () => scheduler.refreshAll(),
    syncChannels: () => channelManager?.sync(),
    syncMaintenance: () => ensureMaintenanceSchedule(),
    syncSources: () => {databaseSources.sync();toolPackages.sync();},
    validateSources: rows => databaseSources.validate(rows),
    validatePackages: rows => toolPackages.validate(rows),
    writeMemoryFiles: () => repo.memory.repairProjection(),
  });

  /**
   * Keep the 记忆维护 task on the configured nightly schedule.
   *
   * The task *is* the feature: Yu's own scheduler fires it like any other task,
   * the task page shows when it will run next, and the run history records what
   * each pass absorbed. Changing the time re-points the same trigger instead of
   * growing a second mechanism that the console cannot see.
   */
  const ensureMaintenanceSchedule = () => {
    const {task,scheduleTrigger}=ensureVisibleSync({db,repo,settings});
    if(task && !task.memoryPolicy.shortTermSlug && repo.memory.blockBySlug('recent'))repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:'recent'}});
    if(scheduleTrigger)scheduler.refresh(scheduleTrigger.id);
    return {taskId:task?.id,triggerId:scheduleTrigger?.id,at:scheduleTrigger?.spec.at,enabled:Boolean(task?.enabled&&scheduleTrigger?.enabled)};
  };

  const mail = createMailService({ settings, log });
  const media = createChannelMedia({ paths, log });
  let channelManager = null;
  const alerts = createAlertService({
    repo,
    settings,
    channels: { status: () => channelManager?.status() ?? [] },
    mail,
    log,
    getAdminBaseUrl: () => settings.get('web.publicUrl') || httpService.url(),
  });

  const auth = createAuth({ repo, settings, paths, log });
  const router = createRouter({ log });
  const httpService = createHttpService({
    log,
    router,
    auth,
    distRoot: path.join(here, 'dist', 'web'),
    // While the data root is being switched there is no safe write target: every
    // authenticated request is refused with a machine-readable reason instead of
    // landing half in the old database and half in the new one.
    guard: async (_request, { method, pathname }) => {
      if (!dataRoot.isSwitching() || pathname.startsWith('/api/data-root')) return;
      if (method === 'GET' || method === 'HEAD') return;
      const error = new Error('数据根正在切换，请几秒后重试');
      error.status = 503;
      error.code = 'SWITCHING';
      throw error;
    },
  });

  channelManager = createChannelManager({
    repo,
    settings,
    runner,
    log,
    media,
    exposeRoute: (kind, routePath, handler, options) => httpService.registerRoute(kind, routePath, handler, options),
    exposeUpgrade: (routePath, handler) => httpService.registerUpgrade(routePath, handler),
    getAdminBaseUrl: () => settings.get('web.publicUrl') || httpService.url(),
  });

  const backups = createBackupService({ db, paths, log, version: VERSION });
  const onboarding = createOnboarding({db,repo,settings,dshLinks,memoryService,refresh:()=>scheduler.refreshAll()});
  const migration = createMigrationService({ repo, paths, settings, log, version: VERSION });
  runner.setSystemHandlers({
    alert: () => alerts.evaluate(),
    // A maintenance task is a scheduled job with a run record, not a prompt: it
    // absorbs pending archives into memory and reports the counts.
    maintenance: async ({ task, run }) => {
      const result = await memoryService.requireSync({ trigger: run?.triggerId ? 'scheduled' : 'manual', runId:run?.id, memoryPolicy:task?.memoryPolicy, syncInstructions:task?.goal, syncContextConfig:task?.contextId?repo.contexts.get(task.contextId)?.config:null });
      if(result?.status==='failed')throw Object.assign(new Error(result.error||'记忆同步失败'),{code:'MEMORY_SYNC_FAILED'});
      repo.audit.log('memory.maintenance', task?.id ?? null, { status: result?.status ?? null }, 'runner');
      return result;
    },
    // So is a backup: no model, just a snapshot and a line in the run history.
    backup: async ({ task }) => {
      const backup = await backups.create('scheduled');
      // The backup slot is also the housekeeping slot: retention runs once a day,
      // right after there is a fresh snapshot to fall back on.
      let pruned = null;
      try {
        pruned = repo.retention.prune({});
      } catch (error) {
        log.warn(`retention sweep failed: ${error.message}`);
      }
      repo.audit.log('db.backup', task?.id ?? null, { name: backup?.name ?? null, pruned }, 'runner');
      return { backup, pruned };
    },
  });

  /**
   * The live half of "move the data folder".
   *
   * Quiescing the writers is what makes the snapshot trustworthy; resuming them
   * afterwards is what makes the move invisible. `rebase` is the small, explicit
   * list of services that captured a path string at construction — everything
   * else reads `paths.*` at call time and follows the mutation for free.
   */
  const dataRootHooks = dataRoot.attach({
    quiesce: async () => {
      scheduler.stop();
      await dshLinks.stop();
      await channelManager.stop();
      alerts.stopMonitoring();
    },
    resume: async () => {
      scheduler.start();
      dshLinks.start();
      channelManager.start();
      alerts.startMonitoring();
    },
    rebase: (next, previous) => {
      fileSink.rebase(next.logs);
      sessionMirror.rebase(next);
      backups.rebase(next);
      log.info(`data root rebased: ${previous?.dataDir ?? '?'} -> ${next.dataDir}`);
    },
    activeRuns: () => runner.stats().active,
  });

  /**
   * DSH-level session archive.
   *
   * Yu keeps its own conversations, but a conversation that is "archived" only in
   * Yu's database could still be resumed by the harness — and a DSH session that
   * was archived from the console would reject every new step with `blocked`,
   * which is what "the reply never came back" looked like. These two calls are the
   * bridge between the two bookkeeping systems: archive closes the session for
   * real, unarchive reopens it.
   */
  const sessionArchive = {
    async archive(sessionId) {
      if (!sessionId) return { ok: false, reason: 'no-session' };
      const registry = ctx.get?.('workspaceRegistry');
      if (!registry?.archiveSession) return { ok: false, reason: 'registry-unavailable' };
      try {
        await agentHost.disposeSession(sessionId);
      } catch (error) {
        log.warn(`disposing ${sessionId} before archiving failed: ${error.message}`);
      }
      try {
        // stopActivity: a run still attached to the session is stopped rather than
        // refusing the archive — the conversation is being closed on purpose.
        await registry.archiveSession(sessionId, { stopActivity: true });
        return { ok: true };
      } catch (error) {
        log.warn(`archiving DSH session ${sessionId} failed: ${error.message}`);
        return { ok: false, reason: error.message };
      }
    },
    async unarchive(sessionId) {
      if (!sessionId) return { ok: false, reason: 'no-session' };
      const registry = ctx.get?.('workspaceRegistry');
      if (!registry?.unarchiveSession) return { ok: false, reason: 'registry-unavailable' };
      try {
        await registry.unarchiveSession(sessionId);
        return { ok: true };
      } catch (error) {
        log.warn(`unarchiving DSH session ${sessionId} failed: ${error.message}`);
        return { ok: false, reason: error.message };
      }
    },
    archivedIds() {
      const registry = ctx.get?.('workspaceRegistry');
      return registry?.archivedSessionIds ?? [];
    },
  };

  const app = {
    ctx,
    config,
    db,
    repo,
    settings,
    configFile,
    models,
    capabilities,
    invalidateCapabilities,
    agentHost,
    dshLinks,
    sessionArchive,
    archiveService,
    memoryService,
    memoryStore,
    memoryLibraries,
    onboarding,
    readingService,
    sessionMirror,
    dataRoot,
    toolService,
    databaseSources,
    tomimi,
    toolPackages,
    adminTool: null,
    runner,
    scheduler,
    channelManager,
    alerts,
    alertService: alerts,
    mail,
    auth,
    httpService,
    backups,
    migration,
    requestObserver,
    paths,
    log,
    harness,
    compat,
    version: VERSION,
    startedAt: now(),
    harnessUrl: null,
    sectionOrder: SECTION_ORDER,
    // The same generator the runner uses, exposed so a context *preview* shows
    // the section a real run would send.
    buildSelfModel,
    /**
     * Short-term memory is a set of text files; these are the only two verbs the
     * console needs: read the files back into the database, or write them out.
     */
    memoryFiles: {
      dir: memoryDir(paths),
      sync: () => syncFromFiles(repo, paths, log),
      writeAll: () => repo.memory.repairProjection(),
    },
    /** Re-point the 记忆维护 task's daily trigger after the setting changes. */
    syncMaintenanceSchedule: ensureMaintenanceSchedule,
    async listPresets() {
      try {
        const presets = await ctx.get('agentPresets')?.list?.();
        return (presets ?? []).map((p) => ({ id: p.id ?? p.name ?? String(p), name: p.name ?? p.id ?? String(p) }));
      } catch (error) {
        log.debug(`listing agent presets failed: ${error.message}`);
        return [];
      }
    },
  };

  registerApi(router, app);
  registerDshLinksApi(router,dshLinks);
  registerSystemApi(router, app);

  let started = false;

  /**
   * Bind the parts that need harness services.
   *
   * `ctx.inject` runs the callback when the dependency exists and disposes its
   * return value when it goes away — the loader order is not ours, and a direct
   * `ctx.get()` at plugin construction can legitimately be `undefined`. The
   * polling fallback keeps the same semantics on a runtime without `inject`.
   */
  const injectWhenAvailable = (deps, callback) => {
    if (typeof ctx.inject === 'function') return ctx.inject(deps, callback);
    let disposed = false;
    let timer = null;
    let dispose = null;
    const attempt = () => {
      if (disposed) return;
      const ready = deps.every((name) => ctx.get(name) != null);
      if (!ready) {
        timer = setTimeout(attempt, 500);
        timer.unref?.();
        return;
      }
      try {
        dispose = callback(ctx);
      } catch (error) {
        log.error(`deferred hook for ${deps.join(', ')} failed: ${error.message}`);
      }
    };
    attempt();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    };
  };

  const mountHarnessHooks = () => {
    injectWhenAvailable(['tools'], (scoped) => {
      try {
        // Built here, not at construction: the self-modification surface needs
        // the scheduler, runner, channels and memory store to exist first.
        app.adminTool = createAdminTool({
          repo,
          settings,
          scheduler,
          runner,
          memoryService,
          memoryStore,
          channelManager,
          mail,
          dataRoot,
          models,
          log,
        });
        const registration = toolService.registerYuTools(scoped, { adminDefinition: app.adminTool.definition });
        invalidateCapabilities();
        log.info(`registered ${registration.registered} Yu tool(s) (exposure: ${registration.exposure})`);
      } catch (error) {
        log.error(`registering Yu tools failed: ${error.message}`);
      }
      return () => {
        invalidateCapabilities();
      };
    });

    if (!config.exposeViaDshWeb) return;
    injectWhenAvailable(['webServer'], (scoped) => {
      const exposed = httpService.exposeOnHarness(scoped);
      app.harnessUrl = exposed.url ?? null;
      invalidateCapabilities();
      if (exposed.exposed) log.info(`also reachable at ${exposed.url}`);
      else log.warn(`not exposed on the harness origin: ${exposed.reason}`);
      return () => {
        app.harnessUrl = null;
        httpService.releaseHarness();
        invalidateCapabilities();
      };
    });
  };

  app.start = async () => {
    if (started) return app;
    started = true;
    const firstInstall=!db.getMeta('companion.defaults.v1')&&!repo.isConfigurationCleared();
    agentHost.attach();
    requestObserver.attach();

    // Seed the defaults a fresh install needs to be usable at all.
    if(readSections(settings).sections.some(s=>s.source && (s.title==='短期记忆'||s.kind==='memory'))) ensureShortTermMapping({repo,settings});
    const seeded = seedDefaults({ db, repo, settings, log, config });
    if (seeded.created) log.info(`seeded ${seeded.created} default record(s)`);

    ensureShortTermMapping({repo,settings});
    // Short-term memory lives in plain text files; the database keeps the
    // metadata and the history. First boot writes the files, later boots read
    // whatever a human edited into them.
    const memoryFiles = syncFromFiles(repo, paths, log);
    migrateInjectionFiles({repo,settings});
    migrateContextPolicies({repo,settings});
    db.setMeta('injection.files.v1','1');
    repo.fileSourceOfTruth = true;
    ensureShortTermMapping({repo,settings});
    initializeCompanionDefaults({db,repo,settings,paths});
    if (memoryFiles.created || memoryFiles.loaded) {
      log.info(`short-term memory files: ${memoryFiles.created} created, ${memoryFiles.loaded} loaded from disk`);
    }

    // The nightly archive pass is a task with a daily trigger, kept in step with
    // the settings the console exposes.
    const maintenance = ensureMaintenanceSchedule() ?? {enabled:false,taskId:"none"};
    if(firstInstall&&maintenance.taskId&&maintenance.taskId!=='none')repo.tasks.setEnabled(maintenance.taskId,false);
    log.info(
      maintenance.enabled
        ? `memory maintenance scheduled daily at ${maintenance.at} (task ${maintenance.taskId})`
        : `memory maintenance task ${maintenance.taskId} is off (memory.autoMaintenanceDaily=false)`,
    );

    // Register Yu's own tools and the /yu mount through deferred injection: the
    // loader can activate this plugin before `tools` and `webServer` exist, and a
    // direct call at that moment silently registers nothing.
    mountHarnessHooks();

    // The group preset travels with this bundle (cordis.patch.yml). If the loader
    // could not resolve the harness packages from this plugin's directory, the
    // preset is absent and group chat would silently fall back to a tool face it
    // was not supposed to have — say so instead of leaving it to discovery.
    try {
      const roster = (await ctx.get('agentPresets')?.list?.()) ?? [];
      if (roster.length && !roster.some((preset) => preset.id === 'yu-group')) {
        log.warn(
          'agent preset yu-group is not registered — the bundle entry could not resolve ' +
            '`@deepseek-ai/dsh-agent-preset` from this plugin directory. Run ' +
            '`node scripts/link-harness-modules.mjs` inside the plugin folder and restart.',
        );
      }
    } catch (error) {
      log.debug(`checking the agent preset roster failed: ${error.message}`);
    }

    const boot = runner.recoverOnBoot();
    if (boot.interrupted.length || boot.requeued.length) {
      log.warn(
        `recovery: ${boot.interrupted.length} interrupted, ${boot.requeued.length} requeued, ${boot.canceled.length} canceled`,
      );
    }

    const pairing = auth.bootstrap();
    if (pairing.pairingRequired) {
      log.warn(`pairing required. Code written to ${pairing.codeWrittenTo}`);
    }

    try {
      const address = await httpService.listen({ port: config.port, host: config.host });
      if (config.port !== 0 && address.port !== config.port) {
        log.warn(`port ${config.port} was unavailable; listening on ${address.port} instead`);
      }
    } catch (error) {
      log.error(`cannot bind ${config.host}:${config.port} — ${error.message}; falling back to an ephemeral port`);
      try {
        await httpService.listen({ port: 0, host: config.host });
      } catch (fallbackError) {
        log.error(`ephemeral bind also failed: ${fallbackError.message}`);
      }
    }

    if (config.exposeViaDshWeb) {
      // The route itself is registered by the `webServer` injection below.
      log.debug('harness exposure is handled by the deferred webServer injection');
    }

    scheduler.start();
    dshLinks.start();
    channelManager.start();
    alerts.startMonitoring();
    log.info(`Yu ready — admin ${httpService.url() ?? '(no listener)'}`);
    return app;
  };

  let stopPromise = null;
  app.stop = () => {
    if (stopPromise) return stopPromise;
    httpService.stopAccepting();
    const runnerDrain = runner.stopAll();
    stopPromise = (async () => {
      log.info('Yu stopping');
      alerts.stopMonitoring();
      requestObserver.detach();
      nativeMemoryHook.stop();
      scheduler.stop();
      const linksDrain=dshLinks.stop();
      const channelsDrain = channelManager.stop();
      const draining = Promise.all([runnerDrain, channelsDrain, linksDrain, httpService.drain()]);
      try {
        await deadline(draining, 5000, 'draining accepted work');
      } catch (error) {
        if (error.code !== 'STOP_TIMEOUT') throw error;
        await deadline(agentHost.disposeAll(), 5000, 'disposing agents');
        await deadline(draining, 5000, 'finishing accepted work');
      }
      await deadline(agentHost.disposeAll(), 5000, 'disposing agents');
      await deadline(httpService.close(), 5000, 'closing HTTP');
      await deadline(Promise.resolve(ctx.get('sessionPersistence')?.flush?.()), 5000, 'flushing sessions');
      log.info('Yu stopped');
      log.flush();
      databaseSources.dispose();
      toolPackages.dispose();
      db.close();
      started = false;
      log.close();
    })();
    return stopPromise;
  };

  app.ready = app.start().catch((error) => {
    log.error(`Yu failed to start: ${error.stack ?? error.message}`);
  });

  // Return the stop promise: Cordis awaits an effect's disposer, and that await is
  // what keeps a reload from starting the new instance while the old one still
  // holds the session write leases. Fire-and-forget here is why "already owned"
  // showed up after almost every reload.
  ctx.effect(() => () => app.stop());

  return app;
}

/**
 * A fresh install must be usable: a context profile, the five memory blocks, a
 * reading project, and the default tasks the product promises. Nothing here
 * calls a model.
 */
function seedDefaults({ db, repo, settings, log, config }) {
  if (repo.isConfigurationCleared()) return {created:0};
  let created = 0;
  const existingContexts = repo.contexts.list();
  const context =
    existingContexts[0] ??
    (() => {
      created += 1;
      return repo.contexts.create({
        name: '通用对话',
        description: '默认上下文：沿用 DSH 默认模型，注入 core / style / 五类记忆，允许全部工具。',
        config: {},
        note: 'seeded',
      });
    })();

  const readingContext =
    repo.contexts.list().find((c) => c.name === '小说阅读') ??
    (() => {
      created += 1;
      return repo.contexts.create({
        name: '小说阅读',
        description: '阅读任务专用：附带阅读笔记要求，通过工具读取项目资料与进度。',
        config: {
          fixedInstructions:
            '你在做阅读笔记。只依据给出的章节原文写作，不要续写、不要代替小说人物说话。' +
            '笔记分三段：发生了什么、人物的变化、一个值得继续追踪的问题。\n\n' +
            '进度由系统在你完成之后自动推进；你没有写入进度的工具，也不需要写入。' +
            '不要评论进度、不要说明你缺什么工具、不要提议保存文件——直接写笔记。' +
            '虚构内容要如实当作小说来写，不要当成真实人物经历。',
          history: { mode: 'lastN', maxTurns: 6, compaction: 'on', contextBudget: 0, overLimit: 'trim' },
          inputTemplate: '{{input}}',
        },
        note: 'seeded',
      });
    })();

  if (!repo.memory.blocks().length && !db.getMeta('memory.blocks.initialized')) {
    for (const block of [
      { slug: 'recent', name: '近期经历', category: 'recent', orderIndex: 10 },
      { slug: 'people', name: '人物与关系', category: 'people', orderIndex: 20 },
      { slug: 'ongoing', name: '进行中的事', category: 'ongoing', orderIndex: 30 },
      { slug: 'thoughts', name: '想法', category: 'thoughts', orderIndex: 40 },
      { slug: 'state', name: '当前状态', category: 'state', orderIndex: 50 },
    ]) {
      repo.memory.createBlock({ ...block, content: '' });
      created += 1;
    }
  }

  db.setMeta('memory.blocks.initialized','1');

  if (!repo.projects.get('reading-main')) {
    repo.projects.upsert({
      id: 'reading-main',
      name: '每日阅读',
      kind: 'reading',
      state: { revision: 0, progress: 0, source: null, notes: [], finished: false },
    });
    created += 1;
  }
  if (!repo.projects.get('journal-main')) {
    repo.projects.upsert({ id: 'journal-main', name: '日记', kind: 'journal', state: { revision: 0, entries: [] } });
    created += 1;
  }

  initializeCompanionDefaults({db,repo,settings});
  if (!repo.tasks.list().length) {
    const reading = repo.tasks.create({
      name: '每日阅读',
      kind: 'reading',
      description: '每天 20:00 读一章小说，写笔记并推进项目进度。',
      goal: '阅读下一章，写有具体依据的笔记：发生了什么、人物变化、一个值得继续追踪的问题。',
      contextId: readingContext.id,
      conversationMode: 'reuse',
      projectId: 'reading-main',
      inputTemplate: '{{input}}',
      archivePolicy: { mode: 'on-complete', minChars: 60, keepToolOutputs: true },
    });
    repo.triggers.create(reading.id, {
      type: 'schedule',
      label: '每天 20:00',
      spec: { kind: 'daily', at: '20:00' },
      enabled: true,
      misfirePolicy: 'skip',
    });
    created += 2;

    const maintenance = repo.tasks.create({
      name: '记忆维护',
      kind: 'maintenance',
      description: '按选定策略整理待吸收归档；自定义模式仅更新指定块。',
      goal: '整理待吸收的材料。',
      contextId: context.id,
      conversationMode: 'new',
    });
    repo.triggers.create(maintenance.id, {
      type: 'schedule',
      label: '每天 03:30',
      spec: { kind: 'daily', at: '03:30' },
      enabled: true,
      misfirePolicy: 'skip',
    });
    created += 2;

    const qqPrivate = repo.tasks.create({
      name: 'QQ 私聊对话',
      kind: 'chat',
      description: '收到 QQ 私聊消息时回复。连接未启用时不会触发。',
      contextId: context.id,
      conversationMode: 'per-peer',
      archivePolicy: { mode: 'on-complete', minChars: 20, keepToolOutputs: true },
    });
    repo.triggers.create(qqPrivate.id, {
      type: 'message',
      label: '任意私聊消息',
      spec: { peerKind: 'private', match: 'any', channelId: '' },
    });
    created += 2;

    const qqGroup = repo.tasks.create({
      name: 'QQ 群聊对话',
      kind: 'chat',
      description: '在群里被 @ 或消息命中时回复。默认需要连接启用。',
      contextId: context.id,
      conversationMode: 'per-peer',
      archivePolicy: { mode: 'on-complete', minChars: 20, keepToolOutputs: true },
    });
    repo.triggers.create(qqGroup.id, {
      // Group chat is a watched room, not a mail box: the trigger carries the
      // attention policy (words, odds, peak pricing, flood) and the buffer feeds
      // it. `message` triggers on a group would answer every line.
      type: 'group-watch',
      label: '群聊观察',
      spec: {
        peerId: '',
        keywords: ['助手'],
        keywordProbability: 0.35,
        peakMultiplier: 0.3,
        valleyWindows: ['00:30-08:30'],
        floodWindowSec: 90,
        floodThreshold: 12,
        followedIds: [],
        streakThreshold: 3,
        windowMessages: 30,
        maxReplies: 3,
        replyDelayMs: 900,
        keepHours: 72,
      },
    });
    created += 2;

    for (const template of [
      {
        name: '自由活动',
        kind: 'activity',
        description: '每隔一段时间做一件自己想做的事，并留下简短记录。',
        goal: '你想做点什么？给自己找一件小而具体的事，做完用几句话记下来。不要编造。',
        spec: { kind: 'interval', minutes: 180 },
        enabled: false,
      },
      {
        name: '日记',
        kind: 'journal',
        description: '每天睡前写一段今天的日记。',
        goal: '写今天的日记：发生了什么、我怎么想、明天想做什么。不要编造。',
        spec: { kind: 'daily', at: '23:30' },
        enabled: false,
      },
    ]) {
      const task = repo.tasks.create({
        name: template.name,
        kind: template.kind,
        description: template.description,
        goal: template.goal,
        contextId: context.id,
        conversationMode: 'reuse',
        enabled: template.enabled,
      });
      repo.triggers.create(task.id, { type: 'schedule', spec: template.spec, enabled: template.enabled });
      created += 2;
    }

    const alertTask = repo.tasks.create({
      name: 'QQ 异常邮件提醒',
      kind: 'alert',
      description: 'QQ 连接或登录持续失效后发邮件；主动停用不告警，支持冷却与抑制。',
      goal: '检查连接健康状态并按阈值发送提醒。',
      contextId: context.id,
      conversationMode: 'new',
    });
    repo.triggers.create(alertTask.id, {
      type: 'system',
      label: '连接健康监测',
      spec: { kind: 'qq-health' },
    });
    created += 2;

    // A fresh install is a *configured* install, not a running one. Everything
    // above is written exactly as the previous Yu had it, then switched off: the
    // operator reads the list and turns on what they want, and nothing has
    // already started talking to a real chat platform or spending tokens.
    for (const task of repo.tasks.list()) {
      for (const trigger of task.triggers ?? []) {
        try {
          repo.triggers.update(trigger.id, { enabled: false });
        } catch {
          /* a trigger type that cannot be patched is left alone */
        }
      }
      try {
        repo.tasks.setEnabled(task.id, false);
      } catch {
        /* ignore */
      }
    }
  }

  // Channels start empty and disabled: connecting a real account is a decision
  // the operator makes, never a side effect of installing.
  if (!repo.channels.list().length) {
    for (const channel of [
      { name: 'NapCat', type: 'napcat', config: { token: '', selfId: '', httpBase: '' } },
      { name: 'SnowLuma', type: 'snowluma', config: { token: '', selfId: '', httpBase: '' } },
      { name: 'QQ 官方机器人', type: 'qq-official', config: { appId: '', clientSecret: '', botSecret: '' } },
    ]) {
      repo.channels.create({ ...channel, enabled: false });
      created += 1;
    }
  }

  return { created, contextId: context.id };
}
