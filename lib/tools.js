import { now, truncate } from './util.js';

/**
 * The tool catalogue.
 *
 * Everything here comes from a real source: `ctx.tools.schemas()` is the tool
 * set an agent can actually call right now; `tool_calls` is the call log Yu
 * recorded; overlays are Yu's own documentation edits and are labelled as such,
 * so "说明修改" never masquerades as "行为修改".
 */

/**
 * Read-only classification for the trial-run affordance.
 *
 * Deliberately conservative: an unlisted tool is treated as having side effects,
 * so the UI never offers a one-click "try it" for something that writes.
 */
const READ_ONLY = new Set([
  'yu_database_sources',
  'yu_database_query',
  'yu_tool_packages',
  'yu_tool_call',
  'yu_document_search',
  'yu_document_read',
  'read',
  'glob',
  'grep',
  'ls',
  'glob_search',
  'grep_search',
  'web_search',
  'web_fetch',
  'todo_write',
  'session_reference',
  'arknights_search',
  'arknights_skill',
  'arknights_skills',
  'arknights_lookup',
  'tomimi',
  'yu_project_status',
]);

const SIDE_EFFECT_PATTERN =
  /(^|_)(write|edit|create|delete|remove|move|rename|bash|pwsh|shell|spawn|run|exec|kill|stop|subagent|workflow|job|terminal|upload|install|publish|commit|send|mail|post|put|patch|mcp)/i;

export function isReadOnlyTool(name) {
  const n = String(name ?? '');
  if (READ_ONLY.has(n)) return true;
  if (SIDE_EFFECT_PATTERN.test(n)) return false;
  return false; // unknown tools are not offered for trial runs
}

export function createToolService({ ctx, repo, settings, log, databaseSources, toolPackages, extraTools = [], documentTools = [] }) {
  let lastSchemas = [];
  let lastSchemasAt = 0;

  const globalSchemas = () => {
    try {
      const tools = ctx.get('tools');
      if (!tools?.schemas) return [];
      // The global view alone under-reports: most harness tools are registered
      // inside an agent preset scope, so a live Yu agent's view is merged in.
      const merged = new Map();
      for (const schema of tools.schemas() ?? []) merged.set(schema.name, schema);
      for (const agent of ctx.get('agents')?.list?.() ?? []) {
        try {
          for (const schema of tools.schemas(agent) ?? []) merged.set(schema.name, schema);
        } catch {
          /* one agent's scope may be closing; ignore it */
        }
      }
      lastSchemas = [...merged.values()];
      lastSchemasAt = now();
      return lastSchemas;
    } catch (error) {
      log?.warn(`reading tool schemas failed: ${error.message}`);
      return lastSchemas;
    }
  };

  const yuSource = (name) =>
    name?.startsWith('yu_tool_') || name?.startsWith('yu_database_') || name?.startsWith('arknights_') || name === 'yu_project_status' || name?.startsWith('yu_document_')
      ? { owner: 'yu', entry: 'lib/tools-knowledge.js', editable: true }
      : { owner: 'dsh', entry: '@deepseek-ai/dsh-tool-*', editable: false };

  const usageInContexts = (name) => {
    const out = [];
    for (const contextRecord of repo.contexts.list()) {
      const tools = contextRecord.config?.tools ?? { mode: 'all' };
      if (tools.mode === 'allow') {
        if ((tools.allow ?? []).includes(name)) out.push({ contextId: contextRecord.id, name: contextRecord.name, mode: 'allow 命中' });
      } else if (!(tools.deny ?? []).includes(name)) {
        out.push({ contextId: contextRecord.id, name: contextRecord.name, mode: '未限制' });
      }
    }
    for (const task of repo.tasks.list()) {
      const policy = task.toolPolicy ?? { mode: 'all' };
      if (policy.mode === 'allow' && (policy.allow ?? []).includes(name)) {
        out.push({ taskId: task.id, name: task.name, mode: '任务允许' });
      }
      if (policy.mode !== 'allow' && (policy.deny ?? []).includes(name)) {
        out.push({ taskId: task.id, name: task.name, mode: '任务禁止' });
      }
    }
    return out;
  };

  const catalog = () => {
    const schemas = globalSchemas();
    const overlays = new Map(repo.tools.overlays().map((o) => [o.name, o]));
    const calls = repo.tools.recentCalls(null, 200);
    const byName = new Map();
    for (const call of calls) {
      if (!byName.has(call.name)) byName.set(call.name, []);
      byName.get(call.name).push(call);
    }
    const items = schemas.map((schema) => {
      const overlay = overlays.get(schema.name) ?? null;
      const recent = (byName.get(schema.name) ?? []).slice(0, 5);
      const source = yuSource(schema.name);
      return {
        name: schema.name,
        description: schema.description,
        modelDescription: overlay?.description ?? schema.description,
        descriptionOverridden: Boolean(overlay?.description && overlay.description !== schema.description),
        example: overlay?.example ?? null,
        parameters: schema.parameters ?? {},
        enabled: overlay?.enabled ?? true,
        readOnly: isReadOnlyTool(schema.name),
        source,
        usage: usageInContexts(schema.name),
        recentCalls: recent,
        lastCallAt: recent[0]?.at ?? null,
        lastCallOk: recent[0] ? recent[0].ok : null,
        callCount: (byName.get(schema.name) ?? []).length,
      };
    });
    // Overlays for tools that have since disappeared must not vanish silently.
    const missing = [...overlays.values()].filter((o) => !schemas.some((s) => s.name === o.name));
    return {
      items,
      total: items.length,
      observedAt: lastSchemasAt,
      missingOverlays: missing.map((o) => ({ name: o.name, updatedAt: o.updatedAt })),
    };
  };

  const get = (name) => catalog().items.find((item) => item.name === name) ?? null;

  const updateOverlay = (name, patch) => {
    const tool = get(name);
    const overlay = repo.tools.setOverlay(name, patch);
    repo.audit.log('tool.overlay', name, { patch, known: Boolean(tool) });
    return { overlay, tool: get(name) };
  };

  /**
   * Trial run. Only read-only tools are allowed, the call is recorded like a
   * real one, and the result is returned verbatim so the page can show exactly
   * what a model would have received.
   */
  const tryRun = async (name, args, { actor = 'user' } = {}) => {
    if (!settings.get('tools.trialRunEnabled')) {
      throw Object.assign(new Error('试运行已在设置中关闭'), { status: 409, code: 'TRIAL_DISABLED' });
    }
    const tool = get(name);
    if (!tool) throw Object.assign(new Error(`工具 ${name} 不在当前可用目录中`), { status: 404, code: 'TOOL_NOT_FOUND' });
    if (!tool.readOnly) {
      throw Object.assign(new Error(`工具 ${name} 不是只读工具，已拒绝试运行`), {
        status: 409,
        code: 'TOOL_NOT_READ_ONLY',
      });
    }
    const tools = ctx.get('tools');
    if (!tools?.execute) {
      throw Object.assign(new Error('ctx.tools.execute 不可用，无法试运行'), { status: 503, code: 'NO_TOOL_PIPELINE' });
    }
    const callId = `yu_trial_${Date.now().toString(36)}`;
    const startedAt = now();
    const result = await tools.execute({
      callId,
      name,
      arguments: args ?? {},
      signal: AbortSignal.timeout(30_000),
    });
    const durationMs = now() - startedAt;
    const ok = !result.isError;
    const value = ok ? result.value : (result.error ?? null);
    repo.tools.recordCall({
      name,
      args: args ?? {},
      result: ok ? truncate(JSON.stringify(value), 8000) : null,
      error: ok ? null : JSON.stringify(result.error ?? {}),
      ok,
      durationMs,
    });
    repo.audit.log('tool.tryRun', name, { ok, durationMs, actor }, actor);
    return {
      name,
      ok,
      durationMs,
      arguments: args ?? {},
      value,
      content: (result.content ?? []).map((block) =>
        block?.type === 'text' ? { type: 'text', text: truncate(block.text, 8000) } : { type: block?.type ?? 'unknown' },
      ),
      error: ok ? null : (result.error ?? null),
      observedAt: now(),
    };
  };

  const recentCalls = (name = null, limit = 30) => repo.tools.recentCalls(name, limit);

  /**
   * Register Yu's own tools through the harness pipeline.
   *
   * Exposure is a setting, not a build flag:
   *   none  — register nothing at all;
   *   admin — register only `yu_admin`, the self-modification surface;
   *   all   — also register the knowledge-corpus tools (opt-in; a domain tool
   *           that merely wraps a database is usually worse than letting the
   *           agent read the database directly).
   *
   * `scopeCtx` is the injected context that owns them, so unloading it removes the
   * tools rather than leaving them registered against a dead plugin.
   */
  const registerYuTools = (scopeCtx = ctx, { adminDefinition = null } = {}) => {
    const disposers = [];
    const exposure = String(settings.get('tools.exposure') ?? 'admin');
    if (exposure === 'none') {
      log?.info('tool exposure is none; Yu registers no tools');
      return { registered: 0, disposers, skipped: 'EXPOSURE_NONE', exposure };
    }
    const tools = scopeCtx.get?.('tools') ?? ctx.get('tools');
    if (!tools?.register) {
      log?.warn('ctx.tools.register is unavailable; Yu tools were not registered');
      return { registered: 0, disposers, skipped: 'NO_TOOL_REGISTRY', exposure };
    }
    for(const definition of databaseSources?.definitions ?? []) disposers.push(tools.register(definition));
    for(const definition of toolPackages?.definitions ?? []) disposers.push(tools.register(definition));
    if (adminDefinition) {
      try {
        disposers.push(tools.register(adminDefinition));
      } catch (error) {
        log?.error(`registering yu_admin failed: ${error.message}`);
      }
    }
    if (settings.get('tools.documentsEnabled') !== false) for(const definition of documentTools) {
      try { disposers.push(tools.register(definition)); } catch(error) { log?.error(error.message); }
    }
    if (exposure === 'all') {
      for (const definition of [...extraTools]) {
        try {
          disposers.push(tools.register(definition));
        } catch (error) {
          log?.error(`registering tool ${definition.name} failed: ${error.message}`);
        }
      }
    }
    return {
      registered: disposers.length,
      disposers,
      exposure,
      knowledge: null,
      extra: [...(settings.get('tools.documentsEnabled') !== false ? documentTools : []), ...(exposure === 'all' ? [...extraTools] : [])].map(definition=>definition.name),
    };
  };

  const knowledgeStatus = () => ({ok:false,note:'请通过数据库来源管理安装数据源'});

  return { catalog, get, updateOverlay, tryRun, recentCalls, registerYuTools, knowledgeStatus, isReadOnlyTool };
}
