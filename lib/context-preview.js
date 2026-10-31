import { compileContext } from './context-compiler.js';
import { normalizeContextConfig } from './repo.js';
import { registryTurnNames, normalizeSections } from './sections.js';

/** Read-only compilation. Sources are explicit; historical snapshots are never recomputed. */
export function previewContext(app, context, body = {}) {
  const { repo, settings, models, paths } = app;
  const mode = body.mode ?? 'fresh';
  if (!['fresh', 'draft', 'frame', 'snapshot'].includes(mode)) throw new Error('unknown preview mode');
  if (mode === 'snapshot') {
    const snapshot = repo.contexts.snapshotById(body.snapshotId);
    if (!snapshot) throw new Error('snapshot not found');
    return { mode, compiled: snapshot.resolved, source: { snapshotId: snapshot.id, historical: true } };
  }
  const config = mode === 'draft' && body.config ? normalizeContextConfig(body.config) : context?.config ?? {};
  const task = body.taskId ? repo.tasks.get(body.taskId) : null;
  if (body.taskId && !task) throw new Error('task not found');
  const conversation = mode === 'frame' ? repo.conversations.get(body.conversationId) : null;
  const ref = conversation?.meta?.contextFrame;
  const frame = mode === 'frame' && ref?.sessionId === conversation?.sessionId && settings.get('runtime.contextMode') !== 'turn'
    ? repo.contexts.snapshotById(ref.snapshotId) : null;
  if (mode === 'frame' && !conversation) throw new Error('conversation not found');
  const overrides = {};
  if (mode === 'draft') {
    if (body.sections) {
      const normalized = normalizeSections(body.sections);
      if (normalized.problems.length) throw new Error(normalized.problems.join('; '));
      overrides['prompt.sections'] = JSON.stringify(normalized.sections);
    }
    for (const key of ['prompt.core', 'prompt.rules']) if (typeof body.texts?.[key] === 'string') overrides[key] = body.texts[key];
  }
  const previewSettings = { ...settings, get: (key) => Object.hasOwn(overrides, key) ? overrides[key] : settings.get(key) };
  if(mode==='draft')previewSettings.injectionDraftTexts = {...body.fileTexts,...Object.fromEntries(['core','rules'].filter(id=>typeof body.texts?.['prompt.'+id]==='string').map(id=>[id,body.texts['prompt.'+id]]))};
  const turnSections = [...new Set([...(config.turnSections ?? []), ...registryTurnNames(previewSettings)])];
  const frozenSections = frame?.resolved?.sections ?? null;
  const compiled = compileContext({ repo, settings: previewSettings, models, contextConfig: config, task, conversation,
    input: String(body.input ?? '（示例输入）'), cwd: config.cwd || paths.dataDir, dryRun: true,
    selfModel: app.buildSelfModel?.() ?? null, turnSections, frozenSections,
    skipRetrieval: Boolean(frozenSections) && !turnSections.includes('yu:retrieved'),
  });
  return { mode, compiled, source: { contextId: context?.id ?? null, contextVersion: context?.currentVersion ?? null,
    taskId: task?.id ?? null, conversationId: conversation?.id ?? null, frozenFrom: frame?.id ?? null,
    draft: mode === 'draft', fileSync: false,
  } };
}

export function sectionEffect(settings, contextConfig = {}, names = []) {
  const turn = new Set([...(contextConfig.turnSections ?? []), ...registryTurnNames(settings)]);
  const perTurn = settings.get('runtime.contextMode') === 'turn';
  return {
    effectiveFrom: perTurn || names.some((name) => turn.has(name)) ? 'next turn / next session' : 'next session',
    note: '系统提示词按会话定格，新会话才更新；历史材料按各自的时机投递（会话一次或每轮）。',
    sections: names.map((name) => ({ name, readAt: perTurn || turn.has(name) ? 'each turn' : 'session creation', restart: false })),
  };
}
