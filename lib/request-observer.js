import { now, truncate, estimateTokens } from './util.js';

/**
 * Observation of real model requests.
 *
 * Yu asks the harness for the assembled prompt (that is the *preview*), but the
 * only trustworthy answer to "what was actually sent" is the request the
 * runtime dispatched. `llm/stream` is a waterfall around every streaming model
 * call, so a pass-through listener here observes provider, model, message and
 * tool counts, and — most importantly — the real failure chain when a request
 * dies, which the durable `turn/end` event does not carry.
 *
 * This is observation only: the request is read, never rewritten, and the
 * chunks flow through untouched.
 */

const MAX_RECORDS = 60;

/** Flatten an error's `cause` chain into one readable line. */
export function describeError(error, depth = 0) {
  if (!error || depth > 5) return null;
  const name = error.name ?? 'Error';
  const code = error.code ? ` [${error.code}]` : '';
  const status = error.status ? ` (HTTP ${error.status})` : '';
  const message = String(error.message ?? error).slice(0, 400);
  const cause = error.cause ? describeError(error.cause, depth + 1) : null;
  return {
    name,
    code: error.code ?? null,
    status: error.status ?? null,
    message: `${name}${code}${status}: ${message}`,
    cause,
    chain: [message, ...(cause ? [cause.chain ?? cause.message] : [])].flat().join(' <- '),
  };
}

export function createRequestObserver({ ctx, log }) {
  const records = [];
  let disposer = null;

  const push = (record) => {
    records.push(record);
    if (records.length > MAX_RECORDS) records.shift();
  };
  const summarizeOptions = (options) => {
    const messages = Array.isArray(options?.messages) ? options.messages : [];
    const systemChars = String(options?.system ?? '').length;
    const toolCount = Array.isArray(options?.tools) ? options.tools.length : 0;
    return {
      provider: options?.provider ?? null,
      model: options?.model ?? null,
      reasoningEffort: options?.reasoningEffort ?? null,
      purpose: options?.purpose ?? null,
      sessionId: options?.sessionId ? String(options.sessionId) : null,
      messages: messages.length,
      roles: messages.map((m) => m?.role).filter(Boolean),
      toolCount,
      systemChars,
      maxTokens: options?.maxTokens ?? null,
      estimatedInputTokens: estimateTokens(String(options?.system ?? '')) + estimateTokens(JSON.stringify(messages)),
      // Shape only: enough to spot a request member that is not a Message.
      messageShapes: messages.slice(0, 8).map((m) => ({
        role: m?.role ?? null,
        keys: Object.keys(m ?? {}),
        contentType: Array.isArray(m?.content) ? `array(${m.content.length})` : typeof m?.content,
      })),
    };
  };

  const describeOptions = summarizeOptions;

  return {
    attach() {
      if (disposer) return;
      try {
        disposer = ctx.on('llm/stream', (options, next) => {
          const startedAt = now();
          const base = summarizeOptions(options);
          return (async function* observed() {
            let failure = null;
            let finish = null;
            const chunkTypes = [];
            let textChars = 0;
            try {
              for await (const chunk of next()) {
                if (chunk?.type === 'finish') finish = chunk.reason ?? null;
                else if (chunk?.type === 'text-delta') textChars += String(chunk.text ?? '').length;
                if (chunk?.type && chunkTypes.length < 12 && chunkTypes[chunkTypes.length - 1] !== chunk.type) {
                  chunkTypes.push(chunk.type);
                }
                yield chunk;
              }
            } catch (error) {
              failure = describeError(error);
              throw error;
            } finally {
              const finishFailed = finish?.kind === 'error';
              const finishFailure = finishFailed ? (finish.failure ?? null) : null;
              const record = {
                ...base,
                startedAt,
                durationMs: now() - startedAt,
                ok: !failure && !finishFailed,
                error: failure ?? (finishFailed ? describeError({ message: finishFailure?.message ?? '[unstructured error finish]', code: finishFailure?.code ?? 'UNKNOWN' }) : null),
                finish: finish?.kind ?? null,
                finishError: finishFailed ? { code: finishFailure?.code ?? null, message: finishFailure?.message ?? null, status: finishFailure?.status ?? null } : null,
                chunkTypes,
                textChars,
                requestId: String(options?.sessionId ?? '') || null,
                // The frozen request is retained so a failure can be replayed for
                // its real cause; the loop's own signal is replaced on replay.
                options,
              };
              push(record);
              if (failure) {
                log?.warn(
                  `model request failed: ${base.provider}/${base.model} — ${truncate(failure.chain, 500)}`,
                );
              } else {
                log?.debug(`model request ok: ${base.provider}/${base.model} in ${record.durationMs}ms`);
              }
            }
          })();
        });
      } catch (error) {
        log?.warn(`could not observe llm/stream: ${error.message}`);
      }
    },
    detach() {
      try {
        disposer?.();
      } catch {
        /* ignore */
      }
      disposer = null;
    },
    recent: (limit = 20) =>
      records.slice(-limit).reverse().map(({ options, ...rest }) => rest),
    failures: () =>
      records
        .filter((r) => !r.ok)
        .slice(-10)
        .reverse()
        .map(({ options, ...rest }) => rest),
    total: () => records.length,
    /**
     * Replay the most recent failed request (or the newest request) to obtain
     * the adapter's original error, which the durable turn/end event flattens
     * away. The stored request is read-only by contract; a fresh timeout signal
     * replaces the loop's expired one.
     */
    async replay({ index = null, timeoutMs = 45_000 } = {}) {
      const candidates = index === null ? records.filter((r) => !r.ok) : [records[index]].filter(Boolean);
      const record = candidates[candidates.length - 1];
      if (!record) return { ok: false, code: 'NOTHING_TO_REPLAY', message: '没有可重放的请求记录' };
      const llm = ctx.get('llm');
      if (!llm?.stream) return { ok: false, code: 'NO_LLM_SERVICE', message: 'ctx.llm.stream 不可用' };
      const startedAt = now();
      const chunks = [];
      let finish = null;
      try {
        const stream = llm.stream({
          ...record.options,
          signal: AbortSignal.timeout(timeoutMs),
        });
        for await (const chunk of stream) {
          chunks.push(chunk);
          if (chunk?.type === 'finish') finish = chunk.reason ?? null;
        }
      } catch (error) {
        return {
          ok: false,
          replayed: describeOptions(record.options),
          error: describeError(error),
          durationMs: now() - startedAt,
        };
      }
      return {
        ok: finish?.kind !== 'error',
        replayed: describeOptions(record.options),
        finish,
        chunks: chunks.length,
        durationMs: now() - startedAt,
      };
    },
  };
}
