/**
 * Model catalog and effective route resolution.
 *
 * Yu never stores its own API keys: it reuses the DeepSeek Harness provider
 * connections. A task or context profile may override provider/model/effort
 * *locally*, without touching the harness default selection — which is why the
 * settings page shows "follow the DSH default" as a first-class option.
 */
export function createModelService(ctx, settings, log) {
  const modelCache = new Map(); // provider -> { at, models }
  const infoCache = new Map(); // `${provider}\u0000${model}` -> { at, info }
  const TTL = 60_000;

  const providers = () => {
    try {
      const list = ctx.get('llm')?.listProviders?.() ?? [];
      return list.map((p) => ({ id: p.id, name: p.name ?? p.id }));
    } catch (error) {
      log?.warn(`listing providers failed: ${error.message}`);
      return [];
    }
  };

  const models = async (provider) => {
    const key = String(provider ?? '');
    if (!key) return [];
    const hit = modelCache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.models;
    try {
      const list = await ctx.get('llm')?.listModels?.(key);
      const models = (list ?? []).map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        description: m.description ?? '',
        inputModalities: m.inputModalities ?? ['text'],
      }));
      modelCache.set(key, { at: Date.now(), models });
      return models;
    } catch (error) {
      log?.warn(`listing models for ${key} failed: ${error.message}`);
      return [];
    }
  };

  const resolve = async (provider, model, signal) => {
    if (!provider || !model) return null;
    const key = `${provider}\u0000${model}`;
    const hit = infoCache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.info;
    try {
      const info = await ctx.get('llm')?.resolveModelInfo?.(provider, model, signal);
      if (!info) return null;
      const normalized = {
        provider: info.provider ?? provider,
        id: info.id ?? model,
        name: info.name ?? model,
        contextWindow: info.context?.contextWindow ?? null,
        defaultMaxTokens: info.defaultMaxTokens ?? null,
        reasoning: info.reasoning
          ? {
              defaultEffort: info.reasoning.defaultEffort ?? null,
              efforts: (info.reasoning.efforts ?? []).map((e) => ({
                id: e.id,
                name: e.name ?? e.id,
                description: e.description ?? '',
              })),
            }
          : null,
        systemPromptUpdate: info.systemPromptUpdate ?? null,
        toolUpdate: info.toolUpdate ?? null,
      };
      infoCache.set(key, { at: Date.now(), info: normalized });
      return normalized;
    } catch (error) {
      log?.warn(`resolving ${provider}/${model} failed: ${error.message}`);
      return null;
    }
  };

  const defaultSelection = () => {
    try {
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
      if (!sel) return null;
      return {
        provider: sel.provider ?? null,
        model: sel.model ?? null,
        reasoningEffort: sel.reasoningEffort ?? null,
        source: 'dsh-default',
      };
    } catch {
      return null;
    }
  };

  /**
   * Resolve the route a run will actually use.
   * Precedence: context override → task override → Yu setting → DSH default.
   * Returns `{ provider, model, reasoningEffort, maxTokens, source, problems }`
   * where `problems` names every missing piece instead of guessing.
   */
  const effectiveSelection = (overrides = {}) => {
    const problems = [];
    const dsh = defaultSelection();
    const s = {
      provider: settings.get('model.provider'),
      model: settings.get('model.model'),
      reasoningEffort: settings.get('model.reasoningEffort'),
      maxTokens: settings.get('model.maxTokens'),
    };

    const pickStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

    let provider = pickStr(overrides.provider) ?? pickStr(s.provider) ?? pickStr(dsh?.provider);
    let model = pickStr(overrides.model) ?? pickStr(s.model) ?? pickStr(dsh?.model);
    let reasoningEffort =
      pickStr(overrides.reasoningEffort) ?? pickStr(s.reasoningEffort) ?? pickStr(dsh?.reasoningEffort);
    let source = pickStr(overrides.provider) || pickStr(overrides.model) ? 'override' : 'settings';

    if (!pickStr(overrides.provider) && !pickStr(overrides.model) && !pickStr(s.provider) && !pickStr(s.model)) {
      source = dsh ? 'dsh-default' : 'unresolved';
    }

    if (!provider) problems.push('no provider route is configured');
    if (!model) problems.push('no model is selected');
    if (provider && !providers().some((p) => p.id === provider)) {
      problems.push(`provider "${provider}" has no registered adapter`);
    }

    const maxTokensOverride = Number(overrides.maxTokens ?? 0);
    const maxTokens = maxTokensOverride > 0 ? maxTokensOverride : s.maxTokens > 0 ? s.maxTokens : undefined;

    return {
      provider: provider ?? null,
      model: model ?? null,
      reasoningEffort: reasoningEffort ?? null,
      maxTokens: maxTokens ?? null,
      source,
      problems,
      ready: problems.length === 0,
    };
  };

  const catalog = async () => {
    const list = providers();
    const out = [];
    for (const p of list) {
      const items = await models(p.id);
      out.push({ ...p, models: items });
    }
    const dsh = defaultSelection();
    return { providers: out, defaultSelection: dsh };
  };

  const effortOptions = async (provider, model) => {
    const info = await resolve(provider, model);
    if (!info?.reasoning) return [];
    return info.reasoning.efforts;
  };

  /**
   * One really-sent, minimal request. This is the only honest way to answer
   * "does this route work": the assembled prompt in a preview is not evidence.
   * A hand-built call also keeps the adapter's original error (with its cause)
   * instead of the flattened `LlmFailure` a loop run reports.
   */
  const probe = async ({
    provider,
    model,
    reasoningEffort,
    prompt = 'Reply with the single word: ok',
    timeoutMs = 45_000,
    shape = 'minimal',
    sessionId = null,
    tools = null,
  }) => {
    const llm = ctx.get('llm');
    if (!llm?.stream) {
      return { ok: false, code: 'NO_LLM_SERVICE', message: 'ctx.llm.stream 不可用' };
    }
    const startedAt = Date.now();
    const chunks = [];
    let text = '';
    let finish = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const messages =
        shape === 'loop'
          ? [
              { role: 'system', content: [{ type: 'text', text: 'You are a helpful assistant. Answer briefly.' }] },
              { role: 'user', content: [{ type: 'text', text: prompt }] },
            ]
          : [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
      const stream = llm.stream({
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        messages,
        ...(shape === 'loop' && Array.isArray(tools) && tools.length
          ? { tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }
          : {}),
        ...(sessionId ? { sessionId } : {}),
        maxTokens: 64,
        signal: shape === 'loop' ? controller.signal : AbortSignal.timeout(timeoutMs),
      });
      for await (const chunk of stream) {
        chunks.push(chunk);
        if (chunk?.type === 'text-delta') text += chunk.text;
        if (chunk?.type === 'finish') finish = chunk.reason ?? null;
      }
    } catch (error) {
      const chain = [];
      let cursor = error;
      for (let depth = 0; cursor && depth < 5; depth++) {
        chain.push(`${cursor.name ?? 'Error'}${cursor.code ? ` [${cursor.code}]` : ''}: ${cursor.message}`);
        cursor = cursor.cause;
      }
      return {
        ok: false,
        code: error.code ?? 'PROBE_FAILED',
        message: error.message,
        chain,
        detail: error.cause ? String(error.cause.stack ?? error.cause).slice(0, 1200) : null,
        chunks: chunks.length,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
    const failed = finish?.kind === 'error';
    return {
      ok: !failed && Boolean(text.trim()),
      code: failed ? (finish.error?.code ?? 'MODEL_ERROR') : text.trim() ? 'OK' : 'EMPTY_RESPONSE',
      message: failed ? (finish.error?.message ?? '模型请求失败') : text.trim() ? null : '模型没有返回文本',
      reply: text.trim().slice(0, 300),
      finish: finish ?? null,
      chunks: chunks.length,
      durationMs: Date.now() - startedAt,
    };
  };

  return {
    providers,
    models,
    resolve,
    catalog,
    defaultSelection,
    effectiveSelection,
    effortOptions,
    probe,
    invalidate() {
      modelCache.clear();
      infoCache.clear();
    },
  };
}
