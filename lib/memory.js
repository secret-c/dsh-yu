import {visibleSyncExecutor,readSyncConfig,firstSessionSyncEnabled} from './memory-sync-policy.js';
import { createMemorySync } from './memory-sync.js';
import { now, truncate, parseJson, estimateTokens } from './util.js';
import { summarizeEvents } from './agent-host.js';
import { lintMemoryCandidate, readMemoryRules } from './memory-rules.js';

/**
 * Memory, style and their maintenance.
 *
 * The authoritative store is Yu's database: one published `memory_versions` row
 * holds the complete `{style, blocks}` snapshot. The model may only propose that
 * shape; everything else (which archives were absorbed, the ledger, project
 * progress) is read-only for it.
 *
 * Publishing is one transaction: version row + block table + absorption ledger.
 * A failure leaves the previous version and the archives pending, so a retry
 * absorbs them exactly once.
 */

export const MEMORY_BLOCK_DEFAULTS = [
  { slug: 'recent', name: '近期经历', category: 'recent', orderIndex: 10, content: '' },
  { slug: 'people', name: '人物与关系', category: 'people', orderIndex: 20, content: '' },
  { slug: 'ongoing', name: '进行中的事', category: 'ongoing', orderIndex: 30, content: '' },
  { slug: 'thoughts', name: '想法', category: 'thoughts', orderIndex: 40, content: '' },
  { slug: 'state', name: '当前状态', category: 'state', orderIndex: 50, content: '' },
];

export const REQUIRED_BLOCKS = MEMORY_BLOCK_DEFAULTS.map((b) => b.slug);

const MAX_BLOCK_CHARS = 4000;
// Style is injected into every single turn, so its cost is paid on every message
// and its length is felt as "how many rules do I have to check before speaking".
// 800 characters is a paragraph of guidance; 4000 was a compliance checklist.
const MAX_STYLE_CHARS = 800;

const MAINTENANCE_INSTRUCTIONS = `你是 Yu 的记忆维护器。你的唯一输出是一个 JSON 对象，不要输出任何其它文字、不要使用 Markdown 代码块。

JSON 结构：
{"style": "<说话方式增量修正>", "blocks": {"recent": "<近期经历>", "people": "<人物与关系>", "ongoing": "<进行中的事>", "thoughts": "<想法>", "state": "<当前状态>"}, "memories": [{"kind": "fact|person|event|preference|plan", "subject": "<主体，可空>", "text": "<一句陈述>", "tags": ["<标签>"]}], "note": "<一句话说明本次改了什么>"}

两层记忆，分工不同：
- blocks 是**短期记忆**，每次对话都会整篇发给模型，所以要短、要是概括。
- memories 是**长期记忆库**，一条一个事实，会一直累积并按相似度自动去重合并，所以宁可多写几条、每条写窄一点。

memories 的写法：
1. 每条只讲一件事，用现在时陈述，6–120 字，不要分段、不要列表符号。
2. kind 只能取 fact（事实）/ person（人物）/ event（发生过的事）/ preference（稳定偏好）/ plan（打算做的事）。
3. subject 写这条记忆是关于谁或什么的（人名、项目名、事物名），便于按主体聚合。
4. 已经被长期记忆库记录过的事实可以再给一次：系统会按相似度合并并累加权重，不会产生重复条目。
5. 没有新的长期事实时，给空数组 []，这是正确输出。

硬性规则：
1. blocks 必须且只能包含 recent / people / ongoing / thoughts / state 五个键，值都是字符串。可以清空内容，但不得删除键或新增键。
2. style 已经不再注入提示词，保持原样输出，不要改写它。
3. 禁止写入真实姓名、手机号、住址、账号、密码、身份证等敏感信息；用「某位朋友」这类指代替代。
4. 必须区分来源：人物原话用「」引用；工具得到的事实直接陈述；你自己的推测要写明「我推测」；小说等虚构内容必须标注「（小说）」。
5. 阅读进度以项目状态为权威，记忆里只写摘要，不要用章节号当成进度事实。
6. 每个块不超过 2000 字，style 不超过 800 字，memories 一次最多 8 条。总输出不超过 12000 字。
7. 只整合给定材料，不要编造没有依据的内容。
8. blocks 是**当下的概括**，不是流水账。新材料补进去；过时、重复、不再重要的事删掉；
   块与块之间重复的内容合并。判断标准：他现在还关心这件事吗？三个月后这一行还有用吗？
   不要因为「怕丢」就整段保留。
9. 短是优点：每个块尽量压在 300 字以内。宁可少写一件事，不要写成日志。

记忆不是日志。以下内容一律不要写，写了会被系统丢弃：
- 「本轮」「上一轮」「这轮」这类对自己运行轮次的叙述，以及对上一次回复的复盘与自评。
- arc_ / run_ / conv_ 等内部 id、ISO 时间戳、revision / lastRunId / notes 数这类运行状态。
- 「回复还是……」「第五次原样回来」「输入为空，没有新输入」这类过程描述。

每条记忆应该是一个**关于人、事或状态的事实**，用现在时陈述，不带评价。判断标准：三个月后读这一行，
它还应回答「ta 是谁 / 发生过什么 / 现在什么情况」。不能的话就不要写。

新材料全是过程、没有可用事实时：blocks 原样返回输入里的「当前五类记忆」，style 原样返回「当前 style」，
memories 返回 []，note 写「本轮无新增事实」。这是正确输出，不是失败。
没有新事实、但现有块里有明显过时或重复的内容时，可以顺手删短，这也是正确输出。`;

export function validateMaintenanceCandidate(candidate, requiredBlocks = REQUIRED_BLOCKS) {
  const problems = [];
  if (!candidate || typeof candidate !== 'object') {
    problems.push('模型输出不是 JSON 对象');
    return { problems, ok: false };
  }
  const blocks = candidate.blocks;
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) {
    problems.push('缺少 blocks 对象');
  } else {
    for (const key of requiredBlocks) {
      if (typeof blocks[key] !== 'string') problems.push(`blocks.${key} 必须是字符串`);
      else if (blocks[key].length > MAX_BLOCK_CHARS) problems.push(`blocks.${key} 超过 ${MAX_BLOCK_CHARS} 字`);
    }
    for (const key of Object.keys(blocks)) {
      if (!requiredBlocks.includes(key)) problems.push(`blocks 出现未知键 ${key}`);
    }
  }
  if (typeof candidate.style !== 'string') problems.push('style 必须是字符串');
  else if (candidate.style.length > MAX_STYLE_CHARS) problems.push(`style 超过 ${MAX_STYLE_CHARS} 字`);
  if (candidate.note !== undefined && typeof candidate.note !== 'string') problems.push('note 必须是字符串');

  // Long-term items are optional: an older prompt or a model that only rewrites
  // blocks is still a valid pass. When present, reject the shape early so a
  // malformed array cannot silently produce an empty database write.
  if (candidate.memories !== undefined) {
    if (!Array.isArray(candidate.memories)) problems.push('memories 必须是数组');
    else if (candidate.memories.length > 12) problems.push('memories 一次最多 12 条');
    else {
      candidate.memories.forEach((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          problems.push(`memories[${index}] 必须是对象`);
          return;
        }
        if (typeof item.text !== 'string' || !item.text.trim()) problems.push(`memories[${index}].text 必须是非空字符串`);
        if (item.kind !== undefined && !['fact', 'person', 'event', 'preference', 'plan'].includes(item.kind)) {
          problems.push(`memories[${index}].kind 不在允许范围内`);
        }
      });
    }
  }

  const sensitive = /(?:1[3-9]\d{9})|(?:\d{17}[\dXx])|(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/;
  if (blocks && typeof blocks === 'object') {
    for (const [key, value] of Object.entries(blocks)) {
      if (typeof value === 'string' && sensitive.test(value)) {
        problems.push(`blocks.${key} 疑似包含手机号/身份证/邮箱，已拒绝发布`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

export function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { value: null, error: '模型没有输出内容' };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], raw];
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = parseJson(candidate.trim(), null);
    if (parsed && typeof parsed === 'object') return { value: parsed, error: null };
  }
  return { value: null, error: '模型输出无法解析为 JSON' };
}

export function createMemoryService({ ctx, repo, settings, log, agentHost, models, archiveService, memoryStore = null, paths = null }) {
  let queue = Promise.resolve();
  const policy = () => {
    const strategy = settings.get('memory.maintenanceStrategy') ?? 'legacy';
    const slugs = strategy === 'legacy' ? REQUIRED_BLOCKS : parseJson(settings.get('memory.managedSlugs') ?? '[]', []);
    return { strategy, slugs };
  };
  const instructions = () => {
    const { strategy, slugs } = policy();
    const base = settings.get('memory.maintenancePrompt') || (strategy === 'legacy' ? MAINTENANCE_INSTRUCTIONS : '整理给定材料中有依据的事实，按指定块更新概括，保留仍然有效的信息。区分事实与推测，不写运行过程或敏感个人信息。');
    return base + '\n\n输出契约（必须遵守）：仅输出JSON对象。style保持输入原样。blocks必须且只能包含以下键：' + JSON.stringify(slugs) + '，各值为字符串（最多4000字）。memories为可选长期事实数组，kind取fact/person/event/preference/plan，text为非空陈述，最多12条；note为字符串。未指定块不受维护影响。';
  };

  /**
   * A publish rewrites every block, so the text files must be rewritten with it —
   * otherwise the next run's file sync would load last night's text back over the
   * memory the maintenance pass just produced.
   */
  const syncFilesAfterPublish = () => {
    if (!paths) return;
    try {
      repo.memory.repairProjection();
    } catch (error) {
      log?.warn(`writing short-term memory files failed: ${error.message}`);
    }
  };

  const serialize = (fn) => {
    const next = queue.then(fn, fn);
    // Keep the chain alive even when a maintenance attempt fails.
    queue = next.catch(() => {});
    return next;
  };

  const pendingArchives = (limit = null) =>
    repo.archives.pending(limit ?? settings.get('memory.maxPendingArchives'));

  /**
   * The group buffer, as one block of text for a maintenance pass.
   *
   * A group is watched all day and nobody is asking her anything, so the buffer is
   * not a conversation: it is a room log she read once. It goes into the same
   * absorption prompt as the archives, and the rows are deleted once the pass has
   * published — after that the facts live in long-term memory, not in a queue.
   */
  const takeGroupBuffer = ({ maxChars = 8000 } = {}) => {
    try {
      const rows = repo.groupBuffer?.pending?.({ limit: 400 }) ?? [];
      const chosen = [];
      let used = 0;
      for (const row of rows) {
        const name = row.senderName || row.senderId || '某人';
        const when = new Date(row.at).toISOString().slice(5, 16).replace('T', ' ');
        const line = `[${when}] ${name}：${row.text}`;
        if (used + line.length > maxChars) break;
        used += line.length + 1;
        chosen.push({ row, line });
      }
      return { text: chosen.map((item) => item.line).join('\n'), rows: chosen.map((item) => item.row) };
    } catch (error) {
      log?.warn(`reading the group buffer failed: ${error.message}`);
      return { text: '', rows: [] };
    }
  };

  const buildMaintenanceMaterials = (archives, { groupTranscript = '' } = {}) => {
    const styleVersion = repo.style.current();
    const blocks = repo.memory.blocks();
    const current = {
      style: styleVersion?.content ?? settings.get('prompt.styleFallback') ?? '',
      blocks: Object.fromEntries(blocks.map((b) => [b.slug, b.content])),
    };
    const summary = archives.map((a) => archiveService.summarizeForMaintenance(a));
    const materialText = summary
      .map(
        (s, i) =>
          `### 材料 ${i + 1}（归档 ${s.id}，${new Date(s.at).toISOString()}，类型 ${s.taskKind}）\n` +
          `输入：${s.input || '（空）'}\n` +
          `回复：${s.reply || '（空）'}\n` +
          (s.notes.length ? `笔记：${s.notes.join(' / ')}\n` : '') +
          (s.tools.length ? `工具：${s.tools.map((t) => `${t.name}${t.ok ? '' : '（失败）'}`).join('、')}\n` : ''),
      )
      .join('\n');
    const userText = [
      '## 当前 style',
      current.style || '（空）',
      '',
      '## 当前受维护的记忆块',
      ...policy().slugs.map((k) => `### ${k}\n${current.blocks[k] || '（空）'}`),
      '',
      '## 待吸收的新材料',
      materialText || (groupTranscript ? '（没有归档；只有群聊缓存）' : '（无）'),
      // Group cache is a different kind of material: nobody was talking to her, so
      // it goes in as a room log she read once, not as a conversation.
      ...(groupTranscript
        ? ['', '## 这段时间群里在聊什么（只进缓存，没有逐条回复）', groupTranscript]
        : []),
      '',
      '请按输出契约返回更新后的 JSON。',
    ].join('\n');
    return { current, summary, materialText, userText, styleVersion, blocks };
  };

  /**
   * PreviewSync: task goal and available message summary, without calling a model.
   * This is a plan; its estimate covers only the displayed materials.
   */
  const previewSync = () => {
    const cfg=readSyncConfig({db:{getMeta:key=>repo.syncMeta?.(key)},repo});
    const blocks=repo.memory.blocks(),rows=repo.memory.syncMessages(repo.memory.syncCursor());
    const system=cfg.task?.goal??'';
    const user=rows.map(row=>row.role+'：'+row.text).join('\n\n');
    return {mode:'preview',format:'text',previewKind:'plan',estimateScope:'displayed materials only',strategy:policy().strategy,managedSlugs:blocks.map(b=>b.slug),pendingCount:rows.length,groupPending:0,pending:[],system,user,estimatedTokens:estimateTokens(system)+estimateTokens(user),absorbedArchiveIds:[],outputSlug:cfg.task?.memoryPolicy?.shortTermSlug??null,stages:['短期正文',...(cfg.task?.memoryPolicy?.longTermEnabled?['长期引用（有资料时）']:[])]};
  };

  const preview = () => {
    const archives = pendingArchives();
    const group = takeGroupBuffer();
    const materials = buildMaintenanceMaterials(archives, { groupTranscript: group.text });
    const system = instructions();
    return {
      mode: 'preview',
      strategy: policy().strategy,
      managedSlugs: policy().slugs,
      pendingCount: archives.length,
      groupPending: group.rows.length,
      pending: archives.map((a) => ({
        id: a.id,
        at: a.createdAt,
        taskId: a.taskId,
        excerpt: truncate(a.material?.reply ?? '', 200),
      })),
      system,
      user: materials.userText,
      estimatedTokens: estimateTokens(system) + estimateTokens(materials.userText),
      absorbedArchiveIds: archives.map((a) => a.id),
    };
  };

  const absorb = async ({ trigger = 'manual', runId = null } = {}) => {
    const { strategy, slugs } = policy();
    if (strategy === 'disabled') return {status:'skipped', absorbed:0, reason:'maintenance disabled'};
    const missing = slugs.filter(slug => !repo.memory.blocks().some(b=>b.slug===slug));
    if (strategy === 'custom' && missing.length) return {status:'failed',absorbed:0,preserved:true,error:'维护块不存在：'+missing.join(', ')};
    const archives = pendingArchives();
    const group = takeGroupBuffer();
    if (!archives.length && !group.rows.length) {
      const entryId = repo.memory.logMaintenance({
        status: 'noop',
        trigger,
        runId,
        absorbed: 0,
        detail: { reason: 'no pending archives' },
      });
      return { status: 'noop', absorbed: 0, logId: entryId };
    }
    // `auto` is the per-run absorption the setting controls. A scheduled task and
    // a manual run are explicit requests, so they absorb even when the automatic
    // pass is off — otherwise turning batching on would make the nightly task
    // skip forever, which is the opposite of what batching means.
    if (!settings.get('memory.autoAbsorb') && trigger === 'auto') {
      const entryId = repo.memory.logMaintenance({
        status: 'skipped',
        trigger,
        runId,
        absorbed: 0,
        detail: { reason: 'autoAbsorb disabled' },
      });
      return { status: 'skipped', absorbed: 0, logId: entryId };
    }

    // Re-check absorption inside the single-writer critical section.
    const fresh = archives.filter((a) => !repo.archives.alreadyAbsorbed(a.id) && a.absorbedAt === null);
    if (!fresh.length && !group.rows.length) {
      return { status: 'noop', absorbed: 0, reason: 'archives already absorbed' };
    }

    const baseRevision = repo.memory.revision();
    const materials = buildMaintenanceMaterials(fresh, { groupTranscript: group.text });
    const route = models.effectiveSelection({});
    if (!route.ready) {
      repo.memory.logMaintenance({
        status: 'failed',
        trigger,
        runId,
        absorbed: 0,
        error: route.problems.join('; '),
        detail: { stage: 'route' },
      });
      return { status: 'failed', error: route.problems.join('; '), absorbed: 0 };
    }

    const sessionId = `yu-maint-${Date.now().toString(36)}`;
    // The maintenance agent gets exactly one system section: its instructions.
    // Registration is by name and order now, so it cannot collide with anything
    // the conversation path injects.
    const holder = {
      system: [{ name: 'yu:maintenance', order: 0, wireOrder: 0.5, text: instructions() }],
      sections: [],
      problems: [],
    };

    let reply = '';
    let failure = null;
    try {
      const summary = await agentHost.runTurn({
        sessionId,
        resume: false,
        route,
        // Same home as a normal run: a maintenance session under `_no-cwd` is a
        // transcript the web console cannot open.
        meta: paths ? { cwd: paths.dataDir } : {},
        policy: { mode: 'none', allow: [], deny: [] },
        holder,
        input: materials.userText,
        timeoutMs: 5 * 60_000,
      });
      reply = summary.assistantText;
      if (!reply.trim()) failure = '维护模型没有返回内容';
      if (!failure && summary.turnEnd && summary.turnEnd.kind !== 'completed') {
        failure = `维护回合异常结束：${summary.turnEnd.kind}`;
      }
    } catch (error) {
      failure = `维护请求失败：${error.message}`;
    } finally {
      // The maintenance session is disposable; nothing should keep it live.
      await agentHost.disposeSession?.(sessionId);
    }

    if (failure) {
      repo.memory.logMaintenance({
        status: 'failed',
        trigger,
        runId,
        absorbed: 0,
        error: failure,
        detail: { stage: 'model', archives: fresh.map((a) => a.id) },
      });
      return { status: 'failed', error: failure, absorbed: 0, preserved: true };
    }

    const { value: candidate, error: parseError } = extractJsonObject(reply);
    if (parseError) {
      repo.memory.logMaintenance({
        status: 'failed',
        trigger,
        runId,
        absorbed: 0,
        error: parseError,
        detail: { stage: 'parse', reply: truncate(reply, 2000) },
      });
      return { status: 'failed', error: parseError, absorbed: 0, preserved: true };
    }

    const validation = validateMaintenanceCandidate(candidate, slugs);
    if (!validation.ok) {
      repo.memory.logMaintenance({
        status: 'failed',
        trigger,
        runId,
        absorbed: 0,
        error: validation.problems.join('; '),
        detail: { stage: 'validate', candidate: truncate(JSON.stringify(candidate), 2000) },
      });
      return { status: 'failed', error: validation.problems.join('; '), absorbed: 0, preserved: true, problems: validation.problems };
    }

    // Iteration rules run between validation and publishing: the model proposes,
    // the rules decide what may actually enter a block, and the ledger records
    // every removal so a later reader can see why memory reads the way it does.
    const previous = Object.fromEntries(materials.blocks.map((block) => [block.slug, block.content]));
    const linted = settings.get('memory.rules.enabled') === false ? { blocks: candidate.blocks, style: candidate.style, report: {stats:{processLinesDropped:0,duplicatesDropped:0}, disabled:true} } : lintMemoryCandidate({
      candidate,
      previous,
      previousStyle: String(materials.current?.style ?? ''),
      rules: readMemoryRules(settings),
    });
    linted.report.at = now();

    // If the rules left memory exactly as it was, publishing a new version would
    // only add noise (and re-absorb archives that taught nothing). Say so instead.
    const styleChanged = String(linted.style ?? '') !== String(materials.current?.style ?? '');
    const blocksChanged = slugs.some(
      (slug) => String(linted.blocks[slug] ?? '') !== String(previous[slug] ?? ''),
    );
    if (!styleChanged && !blocksChanged && !(candidate.memories?.length)) {
      const entryId = repo.memory.logMaintenance({
        status: 'noop',
        trigger,
        runId,
        absorbed: 0,
        detail: { reason: 'rules produced no change', rules: linted.report, archives: fresh.map((a) => a.id) },
      });
      log?.info('memory maintenance produced no change after rules; nothing published');
      return { status: 'noop', absorbed: 0, logId: entryId, reason: 'rules produced no change', rules: linted.report };
    }

    const blocks = materials.blocks.map(block => slugs.includes(block.slug) ? {...block, content: String(linted.blocks[block.slug] ?? '')} : block);
    // The optional legacy preset can recreate its standard blocks; custom never invents blocks.
    if(strategy === 'legacy') for(const meta of MEMORY_BLOCK_DEFAULTS) {
      if(!blocks.some(b=>b.slug===meta.slug)) blocks.push({...meta,enabled:true,content:String(linted.blocks[meta.slug]??'')});
    }

    const published = repo.memory.publish({
      expectedRevision: baseRevision,
      blocks,
      style: String(linted.style ?? ''),
      note: String(candidate.note ?? `absorb ${fresh.length} archive(s)`).slice(0, 500),
      source: trigger === 'manual' ? 'manual' : 'maintenance',
      absorbedArchiveIds: fresh.map((a) => a.id),
    });
    syncFilesAfterPublish();

    // The long-term database is fed from the same proposal, after the version is
    // durable: a merge failure must not roll back a published short-term memory.
    // Failures are recorded, never thrown into the run.
    let merged = null;
    if (memoryStore) {
      try {
        merged = memoryStore.merge(candidate.memories ?? [], {
          archiveId: fresh.length === 1 ? fresh[0].id : null,
          at: now(),
          source: 'maintenance',
        });
      } catch (error) {
        log?.warn(`long-term memory merge failed: ${error.message}`);
        merged = { created: 0, merged: 0, rejected: 0, ids: [], problems: [error.message], failed: true };
      }
    }

    // The group log has served its purpose once this version is durable: the
    // facts are in memory now, so the queue can let go of them. Only rows that
    // were actually read are marked, so a cap does not silently drop a backlog.
    if (group.rows.length) {
      try {
        repo.groupBuffer.markConsumed({ before: group.rows[group.rows.length - 1].at });
        const removed = repo.groupBuffer.consumeAll();
        log?.info(`group buffer consumed after publish: ${removed} message(s)`);
      } catch (error) {
        log?.warn(`clearing the consumed group buffer failed: ${error.message}`);
      }
    }

    const logId = repo.memory.logMaintenance({
      status: 'published',
      trigger,
      runId,
      versionId: published.id,
      absorbed: fresh.length,
      detail: {
        archives: fresh.map((a) => a.id),
        groupMessages: group.rows.length,
        note: candidate.note ?? '',
        rules: linted.report,
        memories: merged ? { created: merged.created, merged: merged.merged, rejected: merged.rejected } : null,
      },
    });

    log?.info(
      `memory v${published.version} published, absorbed ${fresh.length} archive(s)` +
        `${group.rows.length ? ` + ${group.rows.length} group message(s)` : ''}, ` +
        `rules dropped ${linted.report.stats.processLinesDropped + linted.report.stats.duplicatesDropped} line(s), ` +
        `long-term +${merged?.created ?? 0}/${merged?.merged ?? 0}`,
    );
    return {
      status: 'published',
      version: published,
      absorbed: fresh.length,
      groupMessages: group.rows.length,
      logId,
      rules: linted.report,
      memories: merged,
    };
  };

  /**
   * Re-run the rules over memory that is already stored.
   *
   * The rules only see a candidate, and a model that copies the previous block
   * verbatim carries old pollution forward forever. This is the explicit way to
   * clean history: preview by default, publish only when asked.
   */
  const sanitize = ({ dryRun = true, includeEmpty = false } = {}) => {
    const baseRevision = repo.memory.revision();
    const blocks = repo.memory.blocks();
    const current = Object.fromEntries(blocks.map((block) => [block.slug, block.content]));
    const style = repo.style.current()?.content ?? '';
    const result = lintMemoryCandidate({
      candidate: {
        blocks: Object.fromEntries(policy().slugs.map((slug) => [slug, current[slug] ?? ''])),
        style,
      },
      previous: {},
      previousStyle: '',
      rules: readMemoryRules(settings),
    });

    // Cleaning must never silently delete a block. When everything in it matched
    // the process rules there is no factual remainder to keep, and whether that
    // "insight" was worth keeping is a human judgement, not a regex.
    const changes = [];
    const needsReview = [];
    for (const slug of policy().slugs) {
      const before = current[slug] ?? '';
      let after = result.blocks[slug] ?? '';
      if (!after && before) {
        if (!includeEmpty) {
          needsReview.push({ slug, before, chars: before.length });
          after = before;
        }
      }
      if (before !== after) changes.push({ slug, before, after, emptied: !after });
    }
    const styleChanged = style !== result.style;

    if (dryRun || (changes.length === 0 && !styleChanged)) {
      return { dryRun, changes, styleChanged, needsReview, published: null, report: result.report };
    }

    const nextBlocks = blocks.map((block) =>
      policy().slugs.includes(block.slug) ? { ...block, content: result.blocks[block.slug] ?? block.content } : block,
    );
    for (const row of changes) {
      const target = nextBlocks.find((block) => block.slug === row.slug);
      if (target) target.content = row.after;
    }
    const published = repo.memory.publish({
      blocks: nextBlocks,
      expectedRevision: baseRevision,
      style: result.style,
      note: `规则清理：${changes.length} 块`,
      source: 'manual',
      absorbedArchiveIds: [],
    });
    syncFilesAfterPublish();
    repo.memory.logMaintenance({
      status: 'published',
      trigger: 'sanitize',
      runId: null,
      versionId: published.id,
      absorbed: 0,
      detail: { mode: 'sanitize', rules: result.report, changed: changes.map((row) => row.slug), needsReview },
    });
    log?.info(`memory sanitized into v${published.version} (${changes.length} block(s))`);
    return { dryRun: false, changes, styleChanged, needsReview, published, report: result.report };
  };

  return {
    firstSessionSyncEnabled: () => firstSessionSyncEnabled({db:{getMeta:key=>repo.syncMeta?.(key)},repo}),
    requireSync: visibleSyncExecutor({db:{getMeta:key=>repo.syncMeta?.(key)},repo,serialize,execute: options => createMemorySync({ ctx, repo, settings, log, agentHost, models, paths, policy, instructions, syncFilesAfterPublish })(options)}),
    pendingArchives,
    preview,
    previewSync,
    sanitize,
    requireAbsorb: (options) => serialize(() => absorb(options)),
    /** Seed the five canonical blocks the first time Yu runs. */
    ensureSeeded() {
      if (repo.memory.blocks().length) return false;
      for (const block of MEMORY_BLOCK_DEFAULTS) {
        repo.memory.createBlock({
          slug: block.slug,
          name: block.name,
          category: block.category,
          content: block.content,
          orderIndex: block.orderIndex,
        });
      }
      return true;
    },
    exportMarkdown() {
      const blocks = repo.memory.blocks();
      const style = repo.style.current();
      return [
        '# Yu 记忆导出',
        '',
        `> 导出时间：${new Date(now()).toISOString()}；权威来源为 Yu 数据库，本文件为派生产物。`,
        '',
        '## style',
        '',
        style?.content ?? '（空）',
        '',
        ...blocks.map((b) => `## ${b.name}（${b.slug}）\n\n${b.content || '（空）'}\n`),
      ].join('\n');
    },
  };
}

export { summarizeEvents };
