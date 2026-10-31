import { resolveResourcePolicy } from './resource-policy.js';
import { unifiedContextConfig } from './context-policy.js';
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens, zonedParts, now, truncate, parseJson } from './util.js';
import { searchMemories, KIND_LABELS } from './memories.js';
import { readSections, sectionName, wireOrder } from './sections.js';
import { readInjection, renderInjection } from './injection-files.js';

/**
 * Turns a context profile into the exact materials a run will present:
 * prompt sections in a fixed order, interpolation variables, a tool policy,
 * and a token/budget estimate.
 *
 * The three things the UI must never blur, and this module keeps separate:
 *   1. config   — what the profile says should be assembled;
 *   2. preview  — the materials as they would render right now;
 *   3. actual   — what one run really sent (see `agent-host.js`, which records
 *                 the DSH request header and the session's system message).
 */

const ORDER = {
  core: 100,
  rules: 110,
  selfModel: 120,
  selfModify: 150,
  taskRules: 200,
  files: 300,
  style: 400,
  memory: 500,
  project: 600,
  retrieved: 700,
  reference: 800,
};

export const SECTION_ORDER = ORDER;

/** Read one prompt file according to its source declaration. */
export function readPromptFile(spec, { cwd } = {}) {
  const declared = String(spec.path ?? '').trim();
  const base = spec.base === 'cwd' && cwd ? cwd : null;
  const resolved = base && !path.isAbsolute(declared) ? path.resolve(base, declared) : path.resolve(declared);
  const result = {
    path: declared,
    resolvedPath: resolved,
    purpose: spec.purpose ?? '',
    order: spec.order ?? 0,
    refresh: spec.refresh ?? 'run',
    range: spec.range ?? 'full',
    lines: spec.lines ?? 0,
    status: 'ok',
    text: '',
    chars: 0,
    missing: spec.missing ?? 'error',
  };
  if (!declared) {
    result.status = 'undeclared';
    return result;
  }
  let raw;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      result.status = 'not-a-file';
      return result;
    }
    if (stat.size > 2 * 1024 * 1024) {
      result.status = 'too-large';
      result.text = '';
      return result;
    }
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    result.status = error.code === 'ENOENT' ? 'missing' : 'unreadable';
    result.error = error.message;
    return result;
  }
  let text = raw;
  if (result.range !== 'full' && result.lines > 0) {
    const lines = raw.split(/\r?\n/);
    text = result.range === 'head' ? lines.slice(0, result.lines).join('\n') : lines.slice(-result.lines).join('\n');
  }
  result.text = text;
  result.chars = text.length;
  return result;
}

/**
 * Very small deterministic retrieval over Yu's own archives. No embeddings and
 * no hidden index: a keyword overlap score over archived material, capped and
 * labelled with its provenance so the model can cite it.
 */
export function retrieveFromArchives(repo, { query, projectId, scope, maxItems }) {
  const limit = Math.max(0, Math.min(50, Number(maxItems) || 0));
  if (!limit || !query) return [];
  const terms = String(query)
    .toLowerCase()
    .split(/[\s,，。、;；:：!！?？"“”'‘’()（）\[\]【】]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 12);
  if (!terms.length) return [];
  const rows = repo.archives.list({ limit: 200, projectId: scope === 'project' ? projectId : null });
  const scored = [];
  for (const archive of rows) {
    const hay = [
      archive.material?.reply ?? '',
      archive.material?.input ?? '',
      ...(archive.material?.notes ?? []).map((n) => (typeof n === 'string' ? n : n?.text ?? '')),
      ...(archive.material?.toolCalls ?? []).map((t) => `${t.name} ${JSON.stringify(t.arguments ?? {})}`),
    ]
      .join('\n')
      .toLowerCase();
    let score = 0;
    for (const term of terms) {
      let index = hay.indexOf(term);
      let hits = 0;
      while (index >= 0 && hits < 5) {
        hits++;
        index = hay.indexOf(term, index + term.length);
      }
      score += hits;
    }
    if (score > 0) {
      scored.push({
        score,
        id: archive.id,
        at: archive.createdAt,
        excerpt: truncate(archive.material?.reply ?? archive.material?.input ?? '', 700),
        source: archive.material?.source ?? 'archive',
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, limit)
    .map(({ id, at, excerpt, source, score }) => ({ archiveId: id, at, excerpt, source, score }));
}

/**
 * Render memory blocks for injection.
 *
 * A single block can be large (a migrated people index is tens of kilobytes),
 * and injecting it whole would consume most of every request. The cap is part of
 * the contract, not a nicety: truncated content is marked so the model knows it
 * is reading an excerpt.
 */
export function renderMemoryBlocks(blocks, { includeSlugs = null, maxCharsPerBlock = 6000, maxTotalChars = 14000, blockOptions = {} } = {}) {
  const selected = includeSlugs ? blocks.filter((b) => includeSlugs.includes(b.slug)) : blocks;
  const rendered = [];
  let total = 0;
  for (const block of selected) {
    if (block.enabled === false) continue;
    const body = String(block.content ?? '').trim();
    if (!body) continue;
    const options = Object.hasOwn(blockOptions,block.slug) ? blockOptions[block.slug] : {};
    const cap = options.maxChars ?? maxCharsPerBlock;
    if(cap === 0) continue;
    const perBlock = body.length > cap ? `${body.slice(0, cap)}\n…（本节已截断，原文 ${body.length} 字）` : body;
    const text = String(options.template ?? '### {{name}}\n\n{{content}}').replace(/{{(name|slug|content)}}/g, (_,key)=>String(key==='content'?perBlock:block[key]??''));
    if (total + text.length > maxTotalChars) {
      rendered.push(`### ${block.name}\n\n（本节因总长度上限未注入，原文 ${body.length} 字）`);
      break;
    }
    total += text.length;
    rendered.push(text);
  }
  return rendered.join('\n\n');
}

const CJK_NAMES = {
  recent: '近期经历',
  people: '人物与关系',
  ongoing: '进行中的事',
  thoughts: '想法',
  state: '当前状态',
  custom: '自定义',
};

/**
 * Assemble the materials for one run.
 * Every field is derived from stored state plus the filesystem at this instant,
 * so calling it twice with the same inputs yields the same result; that property
 * is what makes "preview" meaningful.
 */
export function compileContext({
  repo,
  settings,
  models,
  contextConfig,
  task = null,
  conversation = null,
  input = '',
  runId = null,
  cwd = null,
  dryRun = true,
  selfModel = null,
  // Sections carried over from the session's first run, by name. Everything is
  // session-scoped unless the profile lists it in `turnSections`.
  frozenSections = null,
  turnSections = null,
  skipRetrieval = false,
}) {
  const problems = [];
  const warnings = [];
  const tz = settings.get('runtime.timezone');
  const originalConfig = task?.injection != null ? {...contextConfig,injection:task.injection} : contextConfig ?? {};

  // The injectable sections are a registry now, not four hard-coded pushes:
  // a person can rename, reorder, disable, add and delete them (see sections.js).
  // Built-ins still read their text from the place that owns it, so the yu_admin
  // tool keeps editing the same values it always did.
  const registry = readSections(settings);
  const config = unifiedContextConfig(originalConfig,registry.sections);
  if(originalConfig.projectProgress?.enabled) warnings.push({code:'PROJECT_INJECTION_RETIRED',message:'项目状态自动注入已停用；项目资料保留，可通过工具读取。'});
  for (const problem of registry.problems) warnings.push({ code: 'SECTIONS', message: problem });
  let enabledSections = registry.sections.filter((section) => section.enabled);
  if(Array.isArray(config.injection)) {
    enabledSections = config.injection.map(binding => {
      const item = typeof binding === 'string' ? {id:binding} : binding;
      const source = registry.sections.find(s => s.id === item.id);
      if(!source) {problems.push({code:'INJECTION_MISSING',message:`注入资源不存在：${item.id}`});return null;}
      return source.enabled ? {...source,...item} : null;
    }).filter(Boolean);
  } else {
    enabledSections = enabledSections.filter(section => !section.legacyMemorySlug ||
      (config.memory?.mode !== 'none' && (config.memory?.mode !== 'select' || config.memory.slugs?.includes(section.legacyMemorySlug))));
  }
  const sectionById = new Map(registry.sections.map((section) => [section.id, section]));
  const memorySection = sectionById.get('memory');
  const retrievalSection = enabledSections.find(section=>section.id==='retrieved') ?? {enabled:false};
  const headingOf = (section) => (section?.heading ? `## ${section.heading}\n\n` : '');

  // ---- route ---------------------------------------------------------
  const selection = models.effectiveSelection({
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
  });
  for (const p of selection.problems) problems.push({ code: 'MODEL', message: p });

  // ---- style ---------------------------------------------------------
  const styleVersion = repo.style.current();
  let styleText = '';
  let styleSource = 'none';
  if (config.style?.mode === 'custom') {
    styleText = String(config.style.custom ?? '');
    styleSource = 'inline';
  } else if (config.style?.mode === 'global') {
    if (styleVersion?.content?.trim()) {
      styleText = styleVersion.content;
      styleSource = `style v${styleVersion.version}`;
    } else {
      const fallback = settings.get('prompt.styleFallback');
      styleText = fallback?.trim() ?? '';
      styleSource = fallback?.trim() ? 'settings fallback' : 'none';
    }
  }

  // ---- memory --------------------------------------------------------
  const memoryVersion = repo.memory.latestVersion();
  const allBlocks = repo.memory.blocks();
  let memoryText = '';
  let memorySource = 'none';
  if (memorySection?.enabled === false) {
    memorySource = 'section disabled';
  } else if (memorySection && config.memory?.mode === 'global') {
    memoryText = renderMemoryBlocks(allBlocks, {blockOptions: parseJson(settings.get('memory.injection') ?? '{}', {})});
    memorySource = allBlocks.length ? 'live blocks (published view)' : 'none';
  } else if (memorySection && config.memory?.mode === 'select') {
    memoryText = renderMemoryBlocks(allBlocks, { includeSlugs: config.memory.slugs ?? [], blockOptions: parseJson(settings.get('memory.injection') ?? '{}', {}) });
    memorySource = `selected ${config.memory.slugs?.length ?? 0} block(s)`;
  } else if (config.memory?.mode === 'none') {
    memorySource = 'profile opted out';
  }

  // ---- prompt files --------------------------------------------------
  const fileResults = (config.promptFiles ?? [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((spec) => readPromptFile(spec, { cwd: config.cwd || cwd }));
  for (const file of fileResults) {
    if (file.status === 'missing' && file.missing === 'error') {
      problems.push({ code: 'PROMPT_FILE_MISSING', message: `提示词文件不存在：${file.path}` });
    } else if (file.status !== 'ok') {
      warnings.push({ code: 'PROMPT_FILE', message: `提示词文件 ${file.path}：${file.status}` });
    }
  }

  // ---- project progress ---------------------------------------------
  let project = null;

  // ---- retrieval -----------------------------------------------------
  // Long-term memory first: the database of atomic statements, not raw archive
  // text. An archive is a whole run; a memory row is one fact with a date and a
  // kind, which is both cheaper to inject and more precise to cite.
  // A profile that says nothing about retrieval inherits the global switches, so
  // the long-term database is actually used out of the box instead of staying a
  // page you can look at.
  const searchConfig =
    config.databaseSearch ??
    (settings.get('memory.db.retrievalEnabled')
      ? { enabled: true, maxItems: Number(settings.get('memory.db.retrievalItems')) || 0, scope: 'all' }
      : { enabled: false, maxItems: 0, scope: 'all' });
  const retrieveLimit = Math.max(0, Math.min(30, Number(searchConfig.maxItems) || 0));
  const retrievalActive = retrievalSection?.enabled !== false && searchConfig.enabled;
  const retrieved =
    !skipRetrieval && retrievalActive
      ? (repo.memoryLibraries ? repo.memoryLibraries.search({query:input,limit:retrieveLimit,libraryIds:searchConfig.libraryIds ?? ['personal']}) : searchMemories(repo, {
          query: input,
          limit: retrieveLimit,
          searchPool: settings.get('memory.db.searchPool'),
        }))
      : [];
  if (retrievalActive && retrieveLimit > 0 && retrieved.length === 0) {
    warnings.push({ code: 'RETRIEVAL_EMPTY', message: '长期记忆库没有命中相关条目' });
  }
  // Only a real run writes the ledger; previews must not look like history.
  if (retrieved.length && runId && !dryRun) {
    try {
      repo.memories.recordRetrieval({
        query: input,
        conversationId: conversation?.id ?? null,
        runId,
        memoryIds: retrieved.map((memory) => memory.id),
        meta: { count: retrieved.length, scope: searchConfig.scope ?? null },
      });
    } catch (error) {
      warnings.push({ code: 'RETRIEVAL_LEDGER', message: `检索账本写入失败：${error.message}` });
    }
  }

  // ---- sections ------------------------------------------------------
  // The order here is the registry's order, not a fixed ladder. Task goal,
  // prompt files, the project snapshot and a profile's extra sections are still
  // anchored at their historical slots; a registry section placed between them
  // lands where its `order` says.
  //
  // `channel` decides *where* the text is delivered (system prompt vs. the user
  // turn); `scope` decides *how often* it is re-read (session vs. every turn).
  // Sections that are not from the registry default to the system channel.
  const sections = [];
  const push = (name, order, text, meta = {}) => {
    const body = String(text ?? '').trim();
    if (!body) return;
    sections.push({
      name,
      order,
      text: body,
      channel: 'system',
      scope: 'session',
      ...meta,
    });
  };

  for (const entry of enabledSections) {
    if (entry.source) {
      const frozen = frozenSections?.find(s=>s.name === sectionName(entry));
      const explicitSession = Array.isArray(config.injection) && config.injection.some(b=>b.id===entry.id&&b.scope==='session');
      const live = settings.get('runtime.contextMode') === 'turn' || entry.scope === 'turn' || (!explicitSession && turnSections?.includes(sectionName(entry)));
      const draftText = settings.injectionDraftTexts?.[entry.id];
      const file = frozen && !live ? {status:'ok',text:'',path:entry.source.path} : typeof draftText === 'string' ? {status:'ok',text:draftText,path:entry.source.path} : readInjection(settings,entry);
      if(file.status !== 'ok') {
        problems.push({code:'INJECTION_FILE',message:`注入文件 ${entry.source.path}：${file.status}`});
      } else if(file.text.trim()) {
        const text = renderInjection(entry,file.text);
        if(text.trim())push(sectionName(entry),entry.order,`${headingOf(entry)}${text}`,{
          kind:entry.kind,sectionId:entry.id,title:entry.title,channel:entry.channel,scope:entry.scope,
          source:{...entry.source,resolvedPath:file.path},
        });
      }
    } else if (entry.kind === 'core') {
      const core = String(settings.get('prompt.core') ?? '').trim();
      if (core) {
        push(sectionName(entry), entry.order, `${headingOf(entry)}${core}`, {
          kind: 'core',
          readOnly: true,
          sectionId: entry.id,
          title: entry.title,
          channel: entry.channel,
          scope: entry.scope,
        });
      }
    } else if (entry.kind === 'rules') {
      // The persona details live outside the core on purpose: this section is one
      // she may rewrite herself through `yu_admin settings.set`.
      const rules = String(settings.get('prompt.rules') ?? '').trim();
      if (rules) {
        push(sectionName(entry), entry.order, `${headingOf(entry)}${rules}`, {
          kind: 'rules',
          sectionId: entry.id,
          title: entry.title,
          channel: entry.channel,
          scope: entry.scope,
        });
      }
    } else if (entry.kind === 'memory') {
      if (memoryText.trim()) {
        push(sectionName(entry), entry.order, `${headingOf(entry)}${memoryText}`, {
          kind: 'memory',
          sectionId: entry.id,
          title: entry.title,
          channel: entry.channel,
          scope: entry.scope,
        });
      }
    } else if (entry.kind === 'retrieved') {
      if (retrieved.length) {
        const text = retrieved
          .map((memory, i) => {
            const who = memory.subject ? `（${memory.subject}）` : '';
            return `[${i + 1}] ${memory.libraryName ? `【${memory.libraryName} / ${memory.id}】 ` : ''}${memory.lastSeenAt ? formatDate(memory.lastSeenAt, tz) : ''} ${KIND_LABELS[memory.kind] ?? memory.kind}${who}：${memory.text}${memory.source ? `（来源：${memory.source}）` : ''}`;
          })
          .join('\n');
        push(sectionName(entry), entry.order, `${headingOf(entry)}${renderInjection(entry,text)}`, {
          kind: 'retrieved',
          sectionId: entry.id,
          title: entry.title,
          channel: entry.channel,
          scope: entry.scope,
          memoryIds: retrieved.map((memory) => memory.id),
        });
      }
    } else if (entry.kind === 'custom') {
      const body = String(entry.body ?? '').trim();
      if (body) {
        push(sectionName(entry), entry.order, `${headingOf(entry)}${body}`, {
          kind: 'custom',
          sectionId: entry.id,
          title: entry.title,
          channel: entry.channel,
          scope: entry.scope,
        });
      }
    }
  }

  if (task?.goal) push('yu:task-rules', ORDER.taskRules, `## 任务目标\n\n${task.goal}`, { kind: 'task' });
  if (config.fixedInstructions) {
    push('yu:context-instructions', ORDER.taskRules + 1, `## 固定上下文说明\n\n${config.fixedInstructions}`, {
      kind: 'profile', scope:'turn',
    });
  }
  if(config.style?.mode === 'custom' && styleText.trim()) push('yu:context-style', ORDER.style, styleText, {kind:'profile',scope:'turn'});
  for (const file of fileResults) {
    if (file.status !== 'ok' || !file.text.trim()) continue;
    push(`yu:file:${path.basename(file.path)}`, ORDER.files + (file.order ?? 0), file.text, {
      kind: 'file',
      path: file.path,
      purpose: file.purpose,
    });
  }
  for (const extra of config.extraSections ?? []) {
    push(`yu:extra:${extra.name}`, extra.order ?? ORDER.reference, extra.text, { kind: 'extra' });
  }

  // Sections from the session's first run replace the freshly compiled ones, so
  // the prompt is byte-identical for the whole conversation. `turnSections` is the
  // escape hatch: those names are kept live instead, for material that genuinely
  // changes per message (a clock, a scene line, a retrieval that must follow the
  // current sentence). Empty by default — one conversation, one frame.
  const turnNames = new Set([
    'yu:task-rules',
    'yu:context-instructions',
    'yu:context-style',
    ...(turnSections ?? []).map(String),
    // The registry can mark a section per-turn on its own; a profile's list adds
    // to that rather than replacing it.
    ...enabledSections.filter((section) => section.scope === 'turn').map(sectionName),
  ]);
  if (Array.isArray(frozenSections)) {
    for(const entry of enabledSections)if(entry.scope==='session'&&Array.isArray(config.injection)&&config.injection.some(b=>b.id===entry.id&&b.scope==='session'))turnNames.delete(sectionName(entry));
    const live = sections.filter((section) => turnNames.has(section.name));
    const kept = frozenSections
      .filter((section) => section.name !== 'yu:project' && !turnNames.has(section.name))
      .map((section) => ({ ...section, frozen: true }));
    sections.length = 0;
    sections.push(...kept, ...live);
  }
  for (const section of sections) {
    section.scope = turnNames.has(section.name) ? 'turn' : 'session';
  }
  sections.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Registration is by name, so two contributions sharing one name (a task goal
  // plus a profile's fixed instructions, or two prompt files with the same
  // basename) would silently overwrite each other. Merge them in place, keeping
  // the first position and channel.
  const byName = new Map();
  for (const section of sections) {
    const existing = byName.get(section.name);
    if (!existing) {
      byName.set(section.name, section);
      continue;
    }
    existing.text = `${existing.text}\n\n${section.text}`;
  }
  if (byName.size !== sections.length) {
    sections.length = 0;
    sections.push(...byName.values());
    sections.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  // ---- delivery channels ---------------------------------------------
  // The system prompt is exactly the `system` channel — nothing else may leak
  // into it, or "what the preview shows" stops being "what the model reads".
  // `history` sections travel with the user turn instead: a session-scoped one
  // is delivered on the first run of a session, a turn-scoped one on every run.
  const systemSections = sections.filter((section) => section.channel !== 'history');
  const historySections = sections.filter((section) => section.channel === 'history');
  const historySession = historySections.filter((section) => section.scope !== 'turn');
  const historyTurn = historySections.filter((section) => section.scope === 'turn');

  const renderedSystem = systemSections.map((section) => section.text).join('\n\n');
  const systemBlocks = systemSections.map((section) => ({
    name: section.name,
    order: section.order,
    wireOrder: wireOrder(section.order),
    text: section.text,
  }));
  const history = {
    session: historySession.map((section) => section.text).join('\n\n'),
    turn: historyTurn.map((section) => section.text).join('\n\n'),
    sessionSections: historySession.map((section) => ({
      name: section.name,
      title: section.title ?? section.name,
      order: section.order,
      tokens: estimateTokens(section.text),
    })),
    turnSections: historyTurn.map((section) => ({
      name: section.name,
      title: section.title ?? section.name,
      order: section.order,
      tokens: estimateTokens(section.text),
    })),
  };

  // ---- input ---------------------------------------------------------
  const template = task?.inputTemplate || config.inputTemplate || '{{input}}';
  const renderedInput = renderInputTemplate(template, {
    input,
    taskName: task?.name,
    at: now(),
    timeZone: tz,
  });

  // ---- budget --------------------------------------------------------
  const systemTokens = estimateTokens(renderedSystem);
  const historyTokens = estimateTokens(history.session) + estimateTokens(history.turn);
  const inputTokens = estimateTokens(renderedInput);
  const contextWindow = config.history?.contextBudget > 0 ? config.history.contextBudget : null;
  const modelInfoWindow = selection.provider && selection.model ? null : null;
  const overLimit =
    contextWindow !== null && systemTokens + historyTokens + inputTokens > contextWindow * 0.85
      ? config.history.overLimit
      : null;
  if (overLimit === 'fail') {
    problems.push({ code: 'CONTEXT_OVER_LIMIT', message: '上下文预算超限且策略为“拒绝执行”' });
  } else if (overLimit) {
    warnings.push({ code: 'CONTEXT_NEAR_LIMIT', message: '上下文接近预算上限，将按策略处理' });
  }

  const toolPolicy = {...normalizeToolPolicy(task?.toolPolicy, config.tools), ...resolveResourcePolicy(task?.toolPolicy, config.tools)};

  return {
    injectionSelection: {source:task?.injection != null ? 'task' : Array.isArray(config.injection) ? 'context' : 'defaults',ids:enabledSections.map(s=>s.id)},
    runId,
    conversationId: conversation?.id ?? null,
    contextId: conversation?.contextId ?? null,
    route: selection,
    style: { text: styleText, source: styleSource, version: styleVersion?.version ?? null },
    memory: {
      text: memoryText,
      source: memorySource,
      version: memoryVersion?.version ?? null,
      blockSlugs: allBlocks.filter((b) => b.enabled).map((b) => b.slug),
    },
    project: project ? { id: project.id, name: project.name, state: project.state } : null,
    promptFiles: fileResults.map((f) => ({
      path: f.path,
      resolvedPath: f.resolvedPath,
      purpose: f.purpose,
      order: f.order,
      refresh: f.refresh,
      range: f.range,
      lines: f.lines,
      status: f.status,
      chars: f.chars,
      missing: f.missing,
    })),
    retrieved,
    sections: sections.map((s) => ({ ...s, tokens: estimateTokens(s.text) })),
    systemBlocks,
    history,
    renderedSystem,
    renderedInput,
    // Kept so a later run in the same session can re-render only the message
    // against a frozen frame instead of compiling the whole context again.
    inputTemplate: template,
    toolPolicy,
    budget: {
      systemTokens,
      historyTokens,
      inputTokens,
      totalTokens: systemTokens + historyTokens + inputTokens,
      contextWindow,
      overLimit,
      // Stated explicitly everywhere it surfaces: a plugin cannot see the
      // provider tokenizer, this is an estimate.
      estimate: true,
      modelContextWindow: modelInfoWindow,
    },
    problems,
    warnings,
    assembledAt: now(),
    timezone: tz,
  };
}

function normalizeToolPolicy(taskPolicy, contextTools) {
  const ctxTools = contextTools ?? { mode: 'all', allow: [], deny: [] };
  const deny = new Set([...(ctxTools.deny ?? []), ...(taskPolicy?.deny ?? [])]);
  let allow = null;
  if (taskPolicy?.mode === 'allow') allow = taskPolicy.allow;
  else if (ctxTools.mode === 'allow') allow = ctxTools.allow;
  if (allow) {
    const kept = allow.filter((n) => !deny.has(n));
    for (const d of deny) if (!kept.includes(d)) kept.push(d);
    return { mode: 'allow', allow: allow.filter((n) => !deny.has(n)), deny: [...deny] };
  }
  return { mode: deny.size ? 'deny' : 'all', allow: [], deny: [...deny] };
}

export function formatDate(ms, timeZone) {  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Fill the input template for one message.
 *
 * The context frame is compiled once per session and reused, but the message
 * obviously is not: this is what turns the frozen template into this run's input
 * (`{{input}}` is the message; the date/time placeholders are for scheduled
 * tasks that bake a date into their prompt).
 */
export function renderInputTemplate(template, { input = '', taskName = '', at = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  return String(template ?? '{{input}}')
    .replaceAll('{{input}}', input ?? '')
    .replaceAll('{{task}}', taskName ?? '')
    .replaceAll('{{date}}', formatDate(at, timeZone))
    .replaceAll('{{time}}', formatTime(at, timeZone))
    .replaceAll('{{timezone}}', timeZone);
}

export function formatTime(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * The marker that tells the model the text above it is material, not a request.
 *
 * History-channel sections become part of the user turn, which is also where the
 * person's actual message lives. Without this boundary the model happily answers
 * the memory instead of the sentence — the failure mode that makes "prepend the
 * context to the message" unusable in practice.
 */
export const MATERIAL_HEADER = '【背景材料，不是新的请求。不要回应材料本身，回应他最后那句话。】';
export const MATERIAL_FOOTER = '【背景材料结束】';

/** Join and frame history-channel text; returns '' when there is nothing. */
export function wrapMaterials(parts) {
  const body = (Array.isArray(parts) ? parts : [parts])
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
  if (!body) return '';
  return `${MATERIAL_HEADER}\n\n${body}\n\n${MATERIAL_FOOTER}`;
}

export { CJK_NAMES };
