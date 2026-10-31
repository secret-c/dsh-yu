import { now } from './util.js';

/**
 * Yu's self-modification surface.
 *
 * One tool, not a catalogue. The operator asked for the framework to stay and
 * for domain tools (knowledge bases, database readers) not to be added: this is
 * the framework's single occupant, and it exists because "Yu is DSH's character
 * and memory" only means something if the running agent can change Yu —
 * add a task, move a schedule, write a durable memory, send a message.
 *
 * Design rules:
 *  - every operation is explicit and listed in `help`, so a model can discover
 *    the surface without guessing;
 *  - destructive or irreversible things (delete task, forget memory) are
 *    reported back with what was actually changed;
 *  - secrets are never readable and never writable through it;
 *  - the answer always says when the change takes effect (`effectiveFrom`).
 */

const SECRET_KEYS = new Set();

const PROTECTED_SETTINGS = new Set(['prompt.core', 'triggers.library', 'tools.packages', 'tools.databaseSources']);

const SCHEDULE_HINT = '{"kind":"daily","at":"20:00"} 或 {"kind":"interval","minutes":180} 或 {"kind":"cron","expression":"0 9 * * 1-5"}';

export function createAdminTool({
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
}) {
  const CATALOG = {
    help: { args: {}, summary: '列出所有 op 与参数（无副作用）。' },
    'task.list': { args: {}, summary: '列出所有任务：id、名称、类型、是否启用、触发时间。' },
    'task.create': {
      args: { name: '任务名（必填）', goal: '每次运行要做的事（必填）', kind: 'chat|reading|journal|activity|maintenance|alert|custom' },
      summary: `新建一个任务，可同时给一条时间规则 schedule=${SCHEDULE_HINT}。`,
    },
    'task.update': { args: { task: '任务名或 id', goal: '新目标', name: '改名', enabled: 'true/false' }, summary: '修改任务的目标 / 名称 / 启用状态。' },
    'task.delete': { args: { task: '任务名或 id' }, summary: '软删除任务（历史运行记录保留）。' },
    'task.run': { args: { task: '任务名或 id', input: '可选输入文本' }, summary: '立即手动运行一次（会消耗模型调用）。' },
    'task.schedule': { args: { task: '任务名或 id', schedule: SCHEDULE_HINT }, summary: '替换该任务的时间触发（旧的时间触发被移除）。' },
    'settings.get': { args: { keys: '可选，字符串数组；省略则返回全部非敏感项' }, summary: '读取 Yu 的设置。' },
    'settings.set': { args: { settings: '键值对象，例如 {"memory.db.retrievalItems":8}' }, summary: '修改 Yu 的设置（密钥与核心提示词不可改）。' },
    'memory.add': { args: { text: '一句事实（必填）', kind: 'fact|person|event|preference|plan', subject: '关于谁/什么' }, summary: '写一条长期记忆，立即入库。' },
    'memory.search': { args: { query: '检索词（必填）', limit: '条数，默认 6' }, summary: '按字面检索长期记忆，看到的就是提示词会拿到的内容。' },
    'memory.maintain': { args: {}, summary: '立即把待吸收归档整理进记忆（会消耗一次模型调用）。' },
    'doc.list': {
      args: { category: 'self|todo|proposal|group|diary|freetime|note|prts|video|misc' },
      summary: '列出文档库（标题、分类、字数），不返回正文。',
    },
    'doc.read': { args: { slug: '文档 slug（必填）' }, summary: '读一篇文档的正文。' },
    'doc.write': {
      args: { slug: '文档 slug，不存在则新建', title: '标题（新建必填）', category: '分类', content: '完整正文' },
      summary: '整篇写入一篇文档；日记、自由活动、笔记、自我认知都走这里。',
    },
    'doc.append': {
      args: { slug: '文档 slug，不存在则新建', title: '标题（新建必填）', category: '分类', text: '要追加的段落' },
      summary: '在文档末尾追加一段（自动补空行），适合日记和自由活动的流水记录。',
    },
    'channel.list': { args: {}, summary: '列出渠道、连接状态与控制台地址。' },
    'notify.send': { args: { to: 'qq|mail（必填）', text: '正文（必填）', peerId: 'QQ 号或群号', peerKind: 'private|group', subject: '邮件主题', channelId: '渠道 id，省略则取第一个已连接的' }, summary: '主动发一条消息（QQ 需要渠道已连接）。' },
    'conversation.list': { args: { archived: 'true 只看归档，false 只看活跃，省略全部', limit: '条数' }, summary: '列出会话及其归档、记忆状态。' },
    'conversation.archive': { args: { conversation: '会话 id 或标题', archived: 'true 归档 / false 恢复' }, summary: '归档或恢复一个会话。' },
    'data.info': { args: {}, summary: '数据根位置、占用、迁移状态。' },
  };

  const ok = (value) => ({ ok: true, ...value });
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  const effective = (when, extra = {}) => ({ effectiveFrom: when, ...extra });

  const describeTask = (task) => {
    const triggers = repo.triggers.listForTask(task.id);
    return {
      id: task.id,
      name: task.name,
      kind: task.kind,
      enabled: task.enabled,
      goal: task.goal,
      triggers: triggers.map((trigger) => ({
        id: trigger.id,
        type: trigger.type,
        enabled: trigger.enabled,
        when: scheduler.describe(trigger),
      })),
    };
  };

  const resolveTask = (token) => {
    const key = String(token ?? '').trim();
    if (!key) return { error: fail('TASK_REQUIRED', '需要 task：任务名或 id') };
    const direct = repo.tasks.get(key);
    if (direct) return { task: direct };
    const all = repo.tasks.list();
    const exact = all.find((task) => task.name === key);
    if (exact) return { task: exact };
    const partial = all.filter((task) => task.name.includes(key) || key.includes(task.name));
    if (partial.length === 1) return { task: partial[0] };
    if (partial.length > 1) {
      return { error: fail('TASK_AMBIGUOUS', `「${key}」匹配到多个任务：${partial.map((task) => task.name).join('、')}`) };
    }
    return { error: fail('TASK_NOT_FOUND', `找不到任务「${key}」；可用 task.list 查看`) };
  };

  const normalizeSchedule = (spec) => {
    if (!spec) return null;
    if (typeof spec === 'string') {
      const text = spec.trim();
      if (/^\d{1,2}:\d{2}$/.test(text)) return { kind: 'daily', at: text };
      const every = text.match(/^(?:every\s*)?(\d+)\s*(?:m|min|分钟)$/i);
      if (every) return { kind: 'interval', minutes: Number(every[1]) };
      return null;
    }
    if (typeof spec !== 'object') return null;
    if (spec.kind === 'daily' && /^\d{1,2}:\d{2}$/.test(String(spec.at ?? ''))) {
      return { kind: 'daily', at: String(spec.at) };
    }
    if (spec.kind === 'interval' && Number(spec.minutes) >= 1) {
      return { kind: 'interval', minutes: Math.round(Number(spec.minutes)) };
    }
    if (spec.kind === 'cron' && typeof spec.expression === 'string') {
      return { kind: 'cron', expression: spec.expression.trim() };
    }
    return null;
  };

  const settingSpec = (key) => {
    for (const group of Object.values(settings.groupedPublic())) {
      const spec = group.find((entry) => entry.key === key);
      if (spec) return spec;
    }
    return null;
  };

  const ops = {
    help: () =>
      ok({
        ops: Object.entries(CATALOG).map(([op, meta]) => ({ op, summary: meta.summary, args: meta.args })),
        note: '这是 Yu 唯一的自修改入口；描述里写了什么，这里就有什么。',
      }),

    'task.list': () => {
      const tasks = repo.tasks.list().map(describeTask);
      return ok({ tasks, count: tasks.length });
    },

    'task.create': (args) => {
      const name = String(args.name ?? '').trim();
      if (!name) return fail('NAME_REQUIRED', '需要 name');
      if (repo.tasks.list().some((task) => task.name === name)) {
        return fail('DUPLICATE', `已经有同名任务「${name}」；改名或先 task.update`);
      }
      const contextId = repo.contexts.list()[0]?.id ?? null;
      const task = repo.tasks.create({
        name,
        kind: args.kind ?? 'custom',
        description: String(args.description ?? args.goal ?? '').slice(0, 500),
        goal: String(args.goal ?? '').slice(0, 4000),
        contextId: args.contextId ?? contextId,
        conversationMode: args.conversationMode ?? 'reuse',
        enabled: args.enabled !== false,
      });
      let trigger = null;
      if (args.schedule) {
        const spec = normalizeSchedule(args.schedule);
        if (!spec) {
          return fail('SCHEDULE_INVALID', `schedule 看不懂：${JSON.stringify(args.schedule)}。可用 ${SCHEDULE_HINT}`);
        }
        trigger = repo.triggers.create(task.id, { type: 'schedule', spec, enabled: true, label: '' });
        scheduler.refresh(trigger.id);
        trigger = repo.triggers.get(trigger.id);
      }
      repo.audit.log('task.create', task.id, { name, schedule: args.schedule ?? null }, 'agent');
      return ok(
        effective(trigger ? scheduler.describe(trigger) : '不会自动运行（没有时间触发）', {
          task: describeTask(repo.tasks.get(task.id)),
          nextFireAt: trigger?.nextFireAt ?? null,
        }),
      );
    },

    'task.update': (args) => {
      const found = resolveTask(args.task);
      if (found.error) return found.error;
      const patch = {};
      if (args.name !== undefined) patch.name = String(args.name);
      if (args.goal !== undefined) patch.goal = String(args.goal);
      if (args.description !== undefined) patch.description = String(args.description);
      if (args.enabled !== undefined) patch.enabled = args.enabled !== false;
      if (!Object.keys(patch).length) return fail('NOTHING_TO_CHANGE', '没有给出要修改的字段');
      const task = repo.tasks.update(found.task.id, patch);
      repo.audit.log('task.update', task.id, patch, 'agent');
      return ok(effective('next run', { task: describeTask(task) }));
    },

    'task.delete': (args) => {
      const found = resolveTask(args.task);
      if (found.error) return found.error;
      repo.tasks.softDelete(found.task.id);
      repo.audit.log('task.delete', found.task.id, { name: found.task.name }, 'agent');
      return ok(effective('immediately', { deleted: found.task.name, note: '历史运行与归档保留' }));
    },

    'task.run': async (args) => {
      const found = resolveTask(args.task);
      if (found.error) return found.error;
      const { run } = runner.enqueue(found.task, {
        reason: 'agent',
        input: String(args.input ?? ''),
        source: 'manual',
      });
      repo.audit.log('task.run', found.task.id, { runId: run.id, by: 'agent' }, 'agent');
      return ok(effective('running now', { runId: run.id, task: found.task.name }));
    },

    'task.schedule': (args) => {
      const found = resolveTask(args.task);
      if (found.error) return found.error;
      const spec = normalizeSchedule(args.schedule);
      if (!spec) return fail('SCHEDULE_INVALID', `schedule 看不懂：${JSON.stringify(args.schedule)}。可用 ${SCHEDULE_HINT}`);
      const previous = repo.triggers.listForTask(found.task.id).filter((trigger) => trigger.type === 'schedule');
      for (const trigger of previous) repo.triggers.remove(trigger.id);
      const trigger = repo.triggers.create(found.task.id, { type: 'schedule', spec, enabled: true });
      scheduler.refresh(trigger.id);
      const fresh = repo.triggers.get(trigger.id);
      repo.audit.log('task.schedule', found.task.id, { spec, removed: previous.length }, 'agent');
      return ok(effective(scheduler.describe(fresh), { trigger: fresh, nextFireAt: fresh.nextFireAt, removed: previous.length }));
    },

    'settings.get': (args) => {
      const keys = Array.isArray(args.keys) ? args.keys.map(String) : null;
      const groups = settings.groupedPublic();
      const items = [];
      for (const list of Object.values(groups)) {
        for (const spec of list) {
          if (keys && !keys.includes(spec.key)) continue;
          items.push({ key: spec.key, value: spec.secret ? (spec.isSet ? '（已设置，不回显）' : '') : spec.value });
        }
      }
      return ok({ settings: items });
    },

    'settings.set': (args) => {
      const patch = args.settings && typeof args.settings === 'object' ? args.settings : null;
      if (!patch) return fail('SETTINGS_REQUIRED', '需要 settings 对象，例如 {"memory.db.retrievalItems": 8}');
      const refused = [];
      const accepted = {};
      for (const [key, value] of Object.entries(patch)) {
        const spec = settingSpec(key);
        if (!spec) {
          refused.push(`${key}: 不是已知设置项`);
          continue;
        }
        if (spec.secret || spec.type === 'secret') {
          refused.push(`${key}: 密钥只能由人在设置页填写`);
          continue;
        }
        if (PROTECTED_SETTINGS.has(key)) {
          refused.push(`${key}: 核心提示词只能由人修改`);
          continue;
        }
        accepted[key] = value;
      }
      if (!Object.keys(accepted).length) return fail('NOTHING_ACCEPTED', refused.join('；') || '没有可修改的项');
      const changes = settings.setMany(accepted, 'agent');
      repo.audit.log('settings.set', Object.keys(accepted).join(','), { accepted, refused }, 'agent');
      return ok(effective('next run', { changes, refused }));
    },

    'memory.add': (args) => {
      const text = String(args.text ?? '').trim();
      if (!text) return fail('TEXT_REQUIRED', '需要 text');
      const result = memoryStore.merge([{ kind: args.kind ?? 'fact', subject: args.subject ?? '', text }], {
        source: 'agent',
      });
      return ok(effective('immediately', result));
    },

    'memory.search': (args) => {
      const query = String(args.query ?? '').trim();
      if (!query) return fail('QUERY_REQUIRED', '需要 query');
      const hits = memoryStore.search({ query, limit: Number(args.limit ?? 6) });
      return ok({ query, hits, note: hits.length ? '检索结果与提示词里的长期记忆同源' : '没有命中' });
    },

    'memory.maintain': async () => {
      const result = await memoryService.requireSync({ trigger: 'agent' });
      return ok({ result, effectiveFrom: result.status === 'published' ? 'next run' : 'nothing changed' });
    },

    'doc.list': (args) => {
      const documents = repo.documents.list({ category: args.category ?? null }).map((doc) => ({
        slug: doc.slug,
        title: doc.title,
        category: doc.category,
        chars: doc.chars,
        updatedAt: doc.updatedAt,
      }));
      return ok({ documents, count: documents.length });
    },

    'doc.read': (args) => {
      const slug = String(args.slug ?? '').trim();
      if (!slug) return fail('SLUG_REQUIRED', '需要 slug；先用 doc.list 看有哪些');
      const document = repo.documents.get(slug);
      if (!document) return fail('DOCUMENT_NOT_FOUND', `没有 ${slug} 这篇文档`);
      return ok({ document });
    },

    'doc.write': (args) => {
      const slug = String(args.slug ?? '').trim();
      if (!slug) return fail('SLUG_REQUIRED', '需要 slug');
      const content = String(args.content ?? '');
      if (!content.trim()) return fail('CONTENT_REQUIRED', '需要 content；清空整篇请用 doc.write 后另说');
      const existed = Boolean(repo.documents.get(slug));
      const document = repo.documents.upsert({
        slug,
        title: String(args.title ?? slug),
        category: args.category ?? 'note',
        content,
        source: 'agent',
        overwriteContent: true,
      });
      repo.audit.log('document.write', slug, { chars: document.chars, by: 'agent' }, 'agent');
      return ok(effective('immediately', { document: { slug: document.slug, title: document.title, chars: document.chars }, created: !existed }));
    },

    'doc.append': (args) => {
      const slug = String(args.slug ?? '').trim();
      if (!slug) return fail('SLUG_REQUIRED', '需要 slug');
      const text = String(args.text ?? '').trim();
      if (!text) return fail('TEXT_REQUIRED', '需要 text');
      const existing = repo.documents.get(slug);
      const content = existing?.content ? `${existing.content.replace(/\s+$/, '')}\n\n${text}\n` : `${text}\n`;
      const document = repo.documents.upsert({
        slug,
        title: String(args.title ?? existing?.title ?? slug),
        category: args.category ?? existing?.category ?? 'note',
        content,
        source: 'agent',
        overwriteContent: true,
      });
      repo.audit.log('document.append', slug, { chars: document.chars, by: 'agent' }, 'agent');
      return ok(effective('immediately', { document: { slug: document.slug, title: document.title, chars: document.chars }, appended: text.length }));
    },

    'channel.list': () => {
      const channels = channelManager.status().map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        enabled: channel.enabled,
        status: channel.status,
        health: channel.health,
      }));
      return ok({ channels });
    },

    'notify.send': async (args) => {
      const to = String(args.to ?? '').trim();
      const text = String(args.text ?? '').trim();
      if (!to) return fail('TO_REQUIRED', '需要 to：qq 或 mail');
      if (!text) return fail('TEXT_REQUIRED', '需要 text');
      if (to === 'mail') {
        const result = await mail.send({ subject: String(args.subject ?? 'Yu 的消息'), body: text });
        repo.audit.log('notify.mail', result?.ok ? 'sent' : 'failed', { ok: result?.ok ?? null }, 'agent');
        return ok({ to: 'mail', result });
      }
      if (to === 'qq') {
        const channelId =
          String(args.channelId ?? '') ||
          channelManager.status().find((channel) => channel.enabled && channel.type !== 'qq-official')?.id ||
          '';
        if (!channelId) return fail('NO_CHANNEL', '没有已启用的 QQ 渠道');
        const result = await channelManager.send({
          channelId,
          peerId: args.peerId ?? '',
          peerKind: args.peerKind ?? 'private',
          text,
        });
        repo.audit.log('notify.qq', result.ok ? 'sent' : 'failed', { channelId, status: result.status }, 'agent');
        return ok({ to: 'qq', channelId, result });
      }
      return fail('TO_INVALID', 'to 只能是 qq 或 mail');
    },

    'conversation.list': (args) => {
      const archived = args.archived === undefined ? undefined : args.archived === true || args.archived === 'true';
      const conversations = repo.conversations
        .list({ limit: Number(args.limit ?? 50) })
        .filter((conversation) => (archived === undefined ? true : Boolean(conversation.archivedAt) === archived));
      return ok({
        conversations: conversations.map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          kind: conversation.kind,
          status: conversation.status,
          archivedAt: conversation.archivedAt,
          updatedAt: conversation.updatedAt,
        })),
      });
    },

    'conversation.archive': (args) => {
      const key = String(args.conversation ?? '').trim();
      if (!key) return fail('CONVERSATION_REQUIRED', '需要 conversation：会话 id 或标题');
      const all = repo.conversations.list({ limit: 500 });
      const conversation =
        repo.conversations.get(key) ?? all.find((item) => item.title === key) ?? all.find((item) => item.title.includes(key));
      if (!conversation) return fail('CONVERSATION_NOT_FOUND', `找不到会话「${key}」`);
      const wantArchived = args.archived !== false && args.archived !== 'false';
      const updated = wantArchived
        ? repo.conversations.archive(conversation.id, conversation.archiveCursorSeq ?? 0)
        : repo.conversations.reopen(conversation.id);
      repo.audit.log('conversation.archive', conversation.id, { archived: wantArchived }, 'agent');
      return ok(effective('immediately', { conversation: { id: updated.id, title: updated.title, status: updated.status } }));
    },

    'data.info': () => {
      const status = dataRoot.status();
      return ok({
        dataDir: status.dataDir,
        source: status.source,
        totalBytes: status.totalBytes,
        freeBytes: status.freeBytes,
        schemaVersion: status.db.schemaVersion,
        switching: status.switching,
        note: status.note,
      });
    },
  };

  const definition = {
    name: 'yu_admin',
    description:
      '修改 Yu 自己：任务、时间计划、设置、长期记忆、渠道与通知、会话归档。' +
      '这是 Yu 唯一的自修改入口，也是唯一会改动 Yu 数据的工具。' +
      '做任何修改前先用 op="help" 或 task.list / settings.get 看清现状；' +
      '回答用户时要说明改动何时生效（effectiveFrom）。' +
      `常用：task.create 建任务并给 schedule=${SCHEDULE_HINT}；settings.set 改设置；memory.add 记一条长期记忆。`,
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: Object.keys(CATALOG),
          description: '要执行的操作',
        },
        args: {
          type: 'object',
          description: '该操作需要的参数（见 op="help"）',
          additionalProperties: true,
        },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args) => {
      const op = String(args?.op ?? '').trim();
      const handler = ops[op];
      if (!handler) {
        return fail('UNKNOWN_OP', `没有 ${op} 这个操作；可用：${Object.keys(CATALOG).join(', ')}`);
      }
      try {
        if((op==='memory.add'||op==='memory.search'||op.startsWith('doc.')) && repo.memoryLibraries?.personalEnabled()===false) return fail('LIBRARY_DISABLED','个人长期记忆库已停用');
        const startedAt = now();
        const result = await handler(args?.args ?? {});
        return { ...result, op, at: startedAt };
      } catch (error) {
        log?.warn(`yu_admin ${op} failed: ${error.message}`);
        return fail(error.code ?? 'ADMIN_FAILED', error.message);
      }
    },
  };

  return { definition, catalog: CATALOG, secretKeys: SECRET_KEYS };
}
