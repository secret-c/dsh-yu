import { normalizeDeliveryTarget } from './delivery-route.js';
import {MAINTENANCE_TEXT_GOAL,JOURNAL_GOAL} from './maintenance-text.js';
import { defaultSections } from './sections.js';
import { unifiedContextConfig } from './context-policy.js';
import { normalizeResourceSelection, validateResourceReferences } from './resource-policy.js';
import { createHash } from 'node:crypto';
import {
  id as newId,
  now,
  parseJson,
  stringifyJson,
  asInt,
  asBool,
  deepFreeze,
  token as newToken,
  zonedToInstant,
} from './util.js';

const TASK_KINDS = ['chat', 'reading', 'journal', 'activity', 'maintenance', 'backup', 'alert', 'custom'];
const CONV_MODES = ['new', 'reuse', 'per-peer'];
const RUN_STATUSES = ['queued', 'running', 'stopping', 'succeeded', 'failed', 'canceled', 'interrupted'];
const TRIGGER_TYPES = ['manual', 'schedule', 'message', 'group-watch', 'webhook', 'system'];
const MEMORY_CATEGORIES = ['recent', 'people', 'ongoing', 'thoughts', 'state', 'custom'];
// Long-term memory items: a statement about a fact, a person, an event, a
// standing preference, or an intention. Deliberately few — a closed set the
// model can pick from keeps the database browsable.
const MEMORY_KINDS = ['fact', 'person', 'event', 'preference', 'plan'];
const MEMORY_STATUSES = ['active', 'forgotten', 'merged'];
// Document categories: closed set so the console can group and filter reliably.
const DOCUMENT_CATEGORIES = ['self', 'todo', 'proposal', 'group', 'diary', 'freetime', 'note', 'prts', 'video', 'hot', 'misc'];
const TOOL_MODES = ['all', 'allow'];
const ARCHIVE_MODES = ['off', 'on-complete', 'always'];
const HISTORY_MODES = ['full', 'lastN', 'none'];

export class RepoError extends Error {
  constructor(message, code = 'INVALID', status = 400) {
    super(message);
    this.name = 'RepoError';
    this.code = code;
    this.status = status;
  }
}

const requireString = (value, field, { max = 4000, allowEmpty = true } = {}) => {
  const s = String(value ?? '').trim();
  if (!allowEmpty && !s) throw new RepoError(`${field} is required`, 'REQUIRED');
  if (s.length > max) throw new RepoError(`${field} is too long (max ${max})`, 'TOO_LONG');
  return s;
};

const optionalString = (value, field, max = 4000) => {
  if (value === null || value === undefined) return '';
  return requireString(value, field, { max });
};

const enumValue = (value, allowed, field, fallback) => {
  const s = String(value ?? '');
  if (!s) return fallback;
  if (!allowed.includes(s)) throw new RepoError(`${field} must be one of ${allowed.join(', ')}`, 'ENUM');
  return s;
};

// ---------------------------------------------------------------- mappers

function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    enabled: asBool(row.enabled, true),
    contextId: row.context_id ?? null,
    conversationMode: row.conversation_mode,
    conversationId: row.conversation_id ?? null,
    goal: row.goal,
    memoryPolicy: normalizeMemoryPolicy(parseJson(row.memory_policy, null)),
    inputTemplate: row.input_template,
    executionTarget: parseJson(row.execution_target, {mode:'yu'}),
    deliveryTarget: normalizeDeliveryTarget(parseJson(row.delivery_target,null)),
    toolPolicy: parseJson(row.tool_policy, {}) ?? {},
    injection: parseJson(row.injection, null),
    archivePolicy: parseJson(row.archive_policy, {}) ?? {},
    projectId: row.project_id ?? null,
    maxRuntimeMs: asInt(row.max_runtime_ms, 900000),
    createdAt: asInt(row.created_at),
    updatedAt: asInt(row.updated_at),
    deletedAt: row.deleted_at ? asInt(row.deleted_at) : null,
  };
}

function mapTrigger(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    label: row.label,
    spec: parseJson(row.spec, {}) ?? {},
    enabled: asBool(row.enabled, true),
    nextFireAt: row.next_fire_at === null ? null : asInt(row.next_fire_at),
    lastFiredAt: row.last_fired_at === null ? null : asInt(row.last_fired_at),
    misfirePolicy: row.misfire_policy,
    createdAt: asInt(row.created_at),
    updatedAt: asInt(row.updated_at),
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id ?? null,
    triggerId: row.trigger_id ?? null,
    triggerReason: row.trigger_reason,
    conversationId: row.conversation_id ?? null,
    sessionId: row.session_id ?? null,
    status: row.status,
    phase: row.phase,
    queuedAt: asInt(row.queued_at),
    startedAt: row.started_at === null ? null : asInt(row.started_at),
    finishedAt: row.finished_at === null ? null : asInt(row.finished_at),
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    businessDone: asBool(row.business_done, false),
    archiveDone: asBool(row.archive_done, false),
    memoryDone: asBool(row.memory_done, false),
    stopRequestedAt: row.stop_requested_at === null ? null : asInt(row.stop_requested_at),
    contextSnapshotId: row.context_snapshot_id ?? null,
    inputText: row.input_text,
    outputText: row.output_text,
    usage: parseJson(row.usage, {}) ?? {},
    meta: parseJson(row.meta, {}) ?? {},
  };
}

function mapConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    channelId: row.channel_id ?? null,
    peerId: row.peer_id ?? null,
    peerLabel: row.peer_label,
    projectId: row.project_id ?? null,
    contextId: row.context_id ?? null,
    sessionId: row.session_id ?? null,
    contextSnapshotId: row.context_snapshot_id ?? null,
    status: row.status,
    archiveCursorSeq: asInt(row.archive_cursor_seq, 0),
    createdAt: asInt(row.created_at),
    updatedAt: asInt(row.updated_at),
    archivedAt: row.archived_at === null ? null : asInt(row.archived_at),
    meta: parseJson(row.meta, {}) ?? {},
  };
}

function mapGroupMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    channelId: row.channel_id,
    peerId: row.peer_id,
    senderId: row.sender_id ?? null,
    senderName: row.sender_name ?? '',
    text: row.text,
    messageId: row.message_id ?? null,
    at: asInt(row.at),
    answeredAt: row.answered_at === null ? null : asInt(row.answered_at),
    consumedAt: row.consumed_at === null ? null : asInt(row.consumed_at),
  };
}

function mapContext(row, versionRow) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    currentVersion: asInt(row.current_version, 1),
    createdAt: asInt(row.created_at),
    updatedAt: asInt(row.updated_at),
    config: versionRow ? parseJson(versionRow.config, {}) ?? {} : undefined,
  };
}

function mapMemoryBlock(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category,
    orderIndex: asInt(row.order_index, 0),
    enabled: asBool(row.enabled, true),
    content: row.content,
    updatedAt: asInt(row.updated_at),
    createdAt: asInt(row.created_at),
  };
}

function mapChannel(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: parseJson(row.config, {}) ?? {},
    enabled: asBool(row.enabled, false),
    status: row.status,
    lastError: row.last_error ?? null,
    lastEventAt: row.last_event_at === null ? null : asInt(row.last_event_at),
    connectedAt: row.connected_at === null ? null : asInt(row.connected_at),
    createdAt: asInt(row.created_at),
    updatedAt: asInt(row.updated_at),
  };
}

// -------------------------------------------------------------- defaults

export function defaultContextConfig() {
  return {
    agentPreset: '',
    cwd: '',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxTokens: 0,
    tools: { mode: 'all', allow: [], deny: [] },
    fixedInstructions: '',
    promptFiles: [],
    style: { mode: 'global', custom: '' },
    memory: { mode: 'global', slugs: null },
    databaseSearch: { enabled: true, scope: 'project', maxItems: 6 },
    projectProgress: { enabled: false, projectId: '' },
    history: { mode: 'lastN', maxTurns: 20, compaction: 'on', contextBudget: 0, overLimit: 'compact' },
    inputTemplate: '{{input}}',
    // Names of sections that are re-read on every message. Everything else is
    // compiled once when the session is created and replayed unchanged. Empty is
    // the default: a conversation should have one frame from start to finish.
    turnSections: [],
    extraSections: [],
  };
}

export function normalizeContextConfig(input) {
  const base = defaultContextConfig();
  const src = input ?? {};
  const tools = { ...base.tools, ...(src.tools ?? {}) };
  const history = { ...base.history, ...(src.history ?? {}) };
  const promptFiles = Array.isArray(src.promptFiles) ? src.promptFiles : [];

  return {
    agentPreset: optionalString(src.agentPreset, 'agentPreset', 200),
    cwd: optionalString(src.cwd, 'cwd', 600),
    provider: optionalString(src.provider, 'provider', 120),
    model: optionalString(src.model, 'model', 200),
    reasoningEffort: optionalString(src.reasoningEffort, 'reasoningEffort', 60),
    maxTokens: Math.max(0, Math.min(1_000_000, asInt(src.maxTokens, 0))),
    tools: {
      mode: enumValue(tools.mode, TOOL_MODES, 'tools.mode', 'all'),
      allow: Array.isArray(tools.allow) ? tools.allow.map((x) => String(x)).slice(0, 200) : [],
      packages: normalizeResourceSelection(tools.packages),
      sources: normalizeResourceSelection(tools.sources),
      deny: Array.isArray(tools.deny) ? tools.deny.map((x) => String(x)).slice(0, 200) : [],
    },
    fixedInstructions: optionalString(src.fixedInstructions, 'fixedInstructions', 20000),
    injection: src.injection == null ? null : (() => {
      if(!Array.isArray(src.injection) || src.injection.length > 200) throw new RepoError('injection须为数组或null','INVALID');
      const seen = new Set();
      return src.injection.map((item,index) => {
        const row = typeof item === 'string' ? {id:item} : item;
        const id = requireString(row?.id,'injection.id',{max:200});
        if(seen.has(id))throw new RepoError('重复注入资源：'+id,'INVALID');
        seen.add(id);
        const out = {id,order:row.order ?? index * 10};
        if(!Number.isFinite(out.order) || out.order < 0 || out.order > 1000)throw new RepoError('injection.order范围0至1000','INVALID');
        if(row.maxChars !== undefined) {
          if(!Number.isInteger(row.maxChars)||row.maxChars<0||row.maxChars>400000)throw new RepoError('injection.maxChars范围0至400000','INVALID');
          out.maxChars=row.maxChars;
        }
        if(row.channel!==undefined)out.channel=enumValue(row.channel,['system','history'],'injection.channel','history');
        if(row.scope!==undefined)out.scope=enumValue(row.scope,['session','turn'],'injection.scope','session');
        if(row.template!==undefined)out.template=optionalString(row.template,'injection.template',2000);
        return out;
      });
    })(),
    promptFiles: promptFiles.slice(0, 40).map((f, index) => ({
      path: optionalString(f?.path, 'promptFiles.path', 600),
      purpose: optionalString(f?.purpose, 'promptFiles.purpose', 200),
      order: asInt(f?.order, (index + 1) * 10),
      refresh: enumValue(f?.refresh, ['run', 'session'], 'promptFiles.refresh', 'run'),
      range: enumValue(f?.range, ['full', 'head', 'tail'], 'promptFiles.range', 'full'),
      lines: Math.max(0, asInt(f?.lines, 0)),
      missing: enumValue(f?.missing, ['skip', 'error'], 'promptFiles.missing', 'error'),
    })),
    style: {
      mode: enumValue(src.style?.mode, ['global', 'none', 'custom'], 'style.mode', 'global'),
      custom: optionalString(src.style?.custom, 'style.custom', 20000),
    },
    memory: {
      mode: enumValue(src.memory?.mode, ['global', 'none', 'select'], 'memory.mode', 'global'),
      slugs: Array.isArray(src.memory?.slugs) ? src.memory.slugs.map(String).slice(0, 40) : null,
    },
    databaseSearch: {
      enabled: asBool(src.databaseSearch?.enabled, true),
      ...(Array.isArray(src.databaseSearch?.libraryIds) ? {libraryIds:[...new Set(src.databaseSearch.libraryIds.map(String))].slice(0,100)} : {}),
      scope: enumValue(src.databaseSearch?.scope, ['project', 'all'], 'databaseSearch.scope', 'project'),
      maxItems: Math.max(0, Math.min(50, asInt(src.databaseSearch?.maxItems, 6))),
    },
    projectProgress: {
      enabled: asBool(src.projectProgress?.enabled, false),
      projectId: optionalString(src.projectProgress?.projectId, 'projectProgress.projectId', 120),
    },
    history: {
      mode: enumValue(history.mode, HISTORY_MODES, 'history.mode', 'lastN'),
      maxTurns: Math.max(1, Math.min(200, asInt(history.maxTurns, 20))),
      compaction: enumValue(history.compaction, ['on', 'off'], 'history.compaction', 'on'),
      contextBudget: Math.max(0, asInt(history.contextBudget, 0)),
      overLimit: enumValue(history.overLimit, ['trim', 'compact', 'fail'], 'history.overLimit', 'compact'),
    },
    inputTemplate: optionalString(src.inputTemplate, 'inputTemplate', 20000) || base.inputTemplate,
    turnSections: (Array.isArray(src.turnSections) ? src.turnSections : [])
      .map((name) => String(name ?? '').trim())
      .filter(Boolean)
      .slice(0, 40),
    extraSections: (Array.isArray(src.extraSections) ? src.extraSections : []).slice(0, 20).map((s, i) => ({
      name: optionalString(s?.name, 'extraSections.name', 120) || `extra-${i + 1}`,
      text: optionalString(s?.text, 'extraSections.text', 20000),
      order: asInt(s?.order, 500 + i * 10),
    })),
  };
}

export function normalizeExecutionTarget(target = {}) {
  const mode = enumValue(target?.mode, ['yu','dsh-session'], 'executionTarget.mode', 'yu');
  return mode === 'yu' ? {mode} : {mode,linkId:requireString(target.linkId,'executionTarget.linkId',{max:120,allowEmpty:false}),busyPolicy:enumValue(target.busyPolicy,['skip','queue-latest'],'busyPolicy','skip')};
}

export const DEFAULT_LONG_TERM_INSTRUCTIONS = '仅提取用户明确表达、长期有效的事实、稳定偏好、人物关系和约定。每条引用用户原文作为证据；不把助手回复、模型猜测、临时情绪、虚构设定或一次性请求当成事实。无可靠新事实时输出：无新增事实。不得覆盖已有核心或长期条目。';
export function normalizeMemoryPolicy(value) {
  const src = value ?? {};
  if(typeof src !== 'object' || Array.isArray(src)) throw new RepoError('memoryPolicy须为对象');
  if(src.longTermEnabled !== undefined && typeof src.longTermEnabled !== 'boolean') throw new RepoError('longTermEnabled须为布尔值');
  const max = src.longTermMaxItems ?? 8;
  if(!Number.isInteger(max) || max < 1 || max > 12) throw new RepoError('longTermMaxItems范围1至12');
  return {...(src.shortTermSlug?{shortTermSlug:optionalString(src.shortTermSlug,'shortTermSlug',120)}:{}),longTermEnabled:src.longTermEnabled ?? true,longTermMaxItems:max,longTermInstructions:optionalString(src.longTermInstructions ?? DEFAULT_LONG_TERM_INSTRUCTIONS,'longTermInstructions',8000)};
}
export function normalizeTaskInput(input, existing = null) {
  const src = input ?? existing ?? {};
  const toolPolicy = { mode: 'all', allow: [], deny: [], ...(src.toolPolicy ?? {}) };
  const archivePolicy = { mode: 'on-complete', minChars: 40, keepToolOutputs: true, ...(src.archivePolicy ?? {}) };
  const conversationArchive = enumValue(archivePolicy.conversation, ['keep', 'on-success'], 'archivePolicy.conversation', 'keep');
  if (conversationArchive === 'on-success' && src.conversationMode !== 'new') throw new RepoError('自动关闭会话仅适用于每次新建的临时任务', 'CONVERSATION_POLICY');
  return {
    executionTarget: normalizeExecutionTarget(src.executionTarget),
    deliveryTarget: normalizeDeliveryTarget(src.deliveryTarget),
    memoryPolicy: normalizeMemoryPolicy(src.memoryPolicy),
    name: requireString(src.name, 'name', { max: 200, allowEmpty: false }),
    injection: normalizeContextConfig({injection:src.injection}).injection,
    kind: enumValue(src.kind, TASK_KINDS, 'kind', 'chat'),
    description: optionalString(src.description, 'description', 4000),
    enabled: asBool(src.enabled, true),
    contextId: src.contextId ? requireString(src.contextId, 'contextId', { max: 120 }) : null,
    conversationMode: enumValue(src.conversationMode, CONV_MODES, 'conversationMode', 'reuse'),
    conversationId: src.conversationId ? requireString(src.conversationId, 'conversationId', { max: 120 }) : null,
    goal: optionalString(src.goal, 'goal', 20000),
    inputTemplate: optionalString(src.inputTemplate, 'inputTemplate', 20000),
    toolPolicy: {
      mode: enumValue(toolPolicy.mode, TOOL_MODES, 'toolPolicy.mode', 'all'),
      allow: Array.isArray(toolPolicy.allow) ? toolPolicy.allow.map(String).slice(0, 200) : [],
      packages: normalizeResourceSelection(toolPolicy.packages),
      sources: normalizeResourceSelection(toolPolicy.sources),
      deny: Array.isArray(toolPolicy.deny) ? toolPolicy.deny.map(String).slice(0, 200) : [],
    },
    archivePolicy: {
      conversation: conversationArchive,
      mode: enumValue(archivePolicy.mode, ARCHIVE_MODES, 'archivePolicy.mode', 'on-complete'),
      minChars: Math.max(0, asInt(archivePolicy.minChars, 40)),
      keepToolOutputs: asBool(archivePolicy.keepToolOutputs, true),
    },
    projectId: src.projectId ? requireString(src.projectId, 'projectId', { max: 120 }) : null,
    maxRuntimeMs: Math.max(60_000, Math.min(6 * 3600_000, asInt(src.maxRuntimeMs, 900_000))),
  };
}

export function normalizeTriggerInput(input) {
  const result = normalizeTriggerInternal(input);
  // Extension fields survive form edits and configuration export/import.
  result.spec = {...(input?.spec ?? {}), ...result.spec};
  if (input?.spec?.definitionId) result.spec.definitionId = requireString(input.spec.definitionId, 'definitionId', { max: 120 });
  if (typeof input?.spec?.localEnabled === 'boolean') result.spec.localEnabled = input.spec.localEnabled;
  return result;
}

function normalizeTriggerInternal(input) {
  const src = input ?? {};
  const type = enumValue(src.type, TRIGGER_TYPES, 'type', 'manual');
  const spec = src.spec ?? {};
  if(spec.event !== undefined && (type !== 'manual' || spec.event !== 'new-session'))throw new RepoError('event仅支持manual规则的new-session','INVALID');
  if (type === 'schedule') {
    if (spec.timezone) { try { new Intl.DateTimeFormat('en', {timeZone: spec.timezone}).format(); } catch { throw new RepoError('时区 timezone 须为有效 IANA 时区，例如 Asia/Shanghai', 'INVALID'); } }
    const kind = enumValue(spec.kind, ['daily', 'weekly', 'interval', 'cron', 'random', 'roll'], 'spec.kind', 'daily');
    if (kind === 'daily') {
      const at = requireString(spec.at, 'spec.at', { max: 5, allowEmpty: false });
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new RepoError('spec.at must be HH:MM', 'INVALID');
    }
    if (kind === 'weekly') {
      const at = requireString(spec.at, 'spec.at', { max: 5, allowEmpty: false });
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new RepoError('spec.at must be HH:MM', 'INVALID');
      if (!Array.isArray(spec.days) || !spec.days.length || !spec.days.every(d => Number.isInteger(Number(d)) && Number(d) >= 1 && Number(d) <= 7)) throw new RepoError('星期 spec.days 须为1至7的整数，至少选择一天', 'INVALID');
    }
    if (kind === 'interval') {
      const minutes = Number(spec.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new RepoError('间隔 spec.minutes 须为1至10080的整数分钟', 'INVALID');
    }
    if (kind === 'random' || kind === 'roll') {
      if (!Number.isFinite(Number(spec.minutes)) || Number(spec.minutes) < 1 || Number(spec.minutes) > 10080) throw new RepoError('平均等待/周期须为1..10080分钟', 'INVALID');
      if (!Number.isFinite(Number(spec.cooldownMinutes ?? 1)) || Number(spec.cooldownMinutes ?? 1) < 1 || Number(spec.cooldownMinutes ?? 1) > Number(spec.minutes)) throw new RepoError('最小冷却须为1..平均等待分钟数', 'INVALID');
      if (spec.hours != null && (!Array.isArray(spec.hours) || spec.hours.length !== 2 || !spec.hours.every(Number.isInteger) || spec.hours[0] < 0 || spec.hours[1] > 24 || spec.hours[0] >= spec.hours[1])) throw new RepoError('活动窗口须为[start,end]，0≤start<end≤24', 'INVALID');
      if (!['poisson', 'interval'].includes(spec.cadence ?? 'poisson')) throw new RepoError('节奏须为poisson或interval', 'INVALID');
      if (kind === 'roll' && (!Number.isInteger(spec.sides) || spec.sides < 2 || spec.sides > 1000000 || !Number.isInteger(spec.target) || spec.target < 1 || spec.target > spec.sides)) throw new RepoError('骰子面数2..1000000，命中点须为1..面数', 'INVALID');
    }
    if (kind === 'cron') {
      const expr = requireString(spec.expr, 'spec.expr', { max: 120, allowEmpty: false });
      if (expr.trim().split(/\s+/).length !== 5) throw new RepoError('spec.expr must be a 5-field cron', 'INVALID');
    }
    return {
      type,
      label: optionalString(src.label, 'label', 200),
      spec: { kind, at: spec.at ?? null, days: spec.days ?? null, minutes: spec.minutes ?? null, expr: spec.expr ?? null, cadence: spec.cadence ?? 'poisson', cooldownMinutes: spec.cooldownMinutes ?? 1, hours: spec.hours ?? null, sides: spec.sides ?? 6, target: spec.target ?? 1 },
      enabled: asBool(src.enabled, true),
      // A daily or weekly slot is a "one per day" promise: if the machine was off
      // when it came due, run it once on return. Interval and cron triggers fire
      // again soon enough that back-filling would only add noise.
      misfirePolicy: enumValue(
        kind === 'random' || kind === 'roll' ? 'skip' : src.misfirePolicy,
        ['skip', 'run-once'],
        'misfirePolicy',
        kind === 'daily' || kind === 'weekly' ? 'run-once' : 'skip',
      ),
    };
  }
  /**
   * Group watching is a trigger, not a global mode.
   *
   * One task owns one room: the words that count as calling her, the chance those
   * words are answered at, the peak/valley pricing that scales that chance, and the
   * two signals that make her look without being called. Keeping the policy on the
   * trigger means a second room can have a completely different one — and that the
   * console edits it where every other schedule lives.
   */
  if (type === 'group-watch') {
    if (spec.policy === 'keyword-or-count' && (!spec.channelId || !spec.peerId)) throw new RepoError('群聊看一眼须指定接入和群号', 'INVALID');
    const clamp = (value, lo, hi, fallback) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.max(lo, Math.min(hi, number));
    };
    const words = (value, max) =>
      (Array.isArray(value) ? value : String(value ?? '').split(','))
        .map((item) => String(item ?? '').trim())
        .filter(Boolean)
        .slice(0, max);
    const windows = words(spec.valleyWindows, 6).filter((item) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(item));
    return {
      type,
      label: optionalString(src.label, 'label', 200),
      spec: {
        policy: spec.policy === 'keyword-or-count' ? 'keyword-or-count' : 'legacy',
        messageCount: Math.round(clamp(spec.messageCount, 2, 200, 20)),
        channelId: spec.channelId ? String(spec.channelId).slice(0, 80) : '',
        peerId: spec.peerId ? String(spec.peerId).slice(0, 80) : '',
        keywords: words(spec.keywords, 20),
        keywordProbability: clamp(spec.keywordProbability, 0, 1, 0.35),
        peakMultiplier: clamp(spec.peakMultiplier, 0, 1, 0.3),
        valleyWindows: windows.length ? windows : ['00:30-08:30'],
        floodWindowSec: Math.round(clamp(spec.floodWindowSec, 10, 3600, 90)),
        floodThreshold: Math.round(clamp(spec.floodThreshold, 2, 200, 12)),
        followedIds: words(spec.followedIds, 100),
        streakThreshold: Math.round(clamp(spec.streakThreshold, 2, 50, 3)),
        windowMessages: Math.round(clamp(spec.windowMessages, 3, 200, 30)),
        keepHours: Math.round(clamp(spec.keepHours, 1, 720, 72)),
      },
      enabled: asBool(src.enabled, true),
      misfirePolicy: 'skip',
    };
  }
  /**
   * A hook is the generic door.
   *
   * Anything that can send an HTTP request — a shell script, a Windows scheduled
   * task, another program, a phone shortcut — fires this task by POSTing to its
   * token URL. The body becomes the run's input verbatim, so the caller decides
   * what the task is told, and the trigger only carries the permission to say it.
   */
  if (type === 'webhook') {
    const provided = String(spec.token ?? '').trim();
    const token = provided || newToken();
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(token)) {
      throw new RepoError('spec.token must be 16-80 url-safe characters', 'INVALID');
    }
    return {
      type,
      label: optionalString(src.label, 'label', 200),
      spec: {
        token,
        // A ceiling per trigger, counted from the run log: a runaway script cannot
        // turn into a runaway bill.
        maxPerHour: Math.max(0, Math.min(1000, asInt(spec.maxPerHour, 60))),
        note: optionalString(spec.note, 'spec.note', 200),
      },
      enabled: asBool(src.enabled, true),
      misfirePolicy: 'skip',
    };
  }
  if (type === 'message') {    // Optional gate on when this task may answer at all. `hours` is a local-time
    // window [start, end); end < start wraps past midnight, equal means all day.
    // `maxPerHour` is a hard ceiling per trigger, counted from the run log so a
    // restart cannot reset it.
    let hours = null;
    if (Array.isArray(spec.hours) && spec.hours.length === 2) {
      const start = asInt(spec.hours[0], -1);
      const end = asInt(spec.hours[1], -1);
      if (start < 0 || start > 23 || end < 0 || end > 23) throw new RepoError('spec.hours must be two hours 0..23', 'INVALID');
      if (start !== end) hours = [start, end];
    }
    return {
      type,
      label: optionalString(src.label, 'label', 200),
      spec: {
        channelId: spec.channelId ? String(spec.channelId) : '',
        peerId: optionalString(spec.peerId, 'spec.peerId', 120),
        requirePeer: spec.requirePeer === true,
        replyMode: enumValue(spec.replyMode, ['reply', 'record'], 'spec.replyMode', 'reply'),
        peerKind: enumValue(spec.peerKind, ['any', 'private', 'group'], 'spec.peerKind', 'any'),
        match: enumValue(spec.match, ['any', 'prefix', 'contains', 'commands', 'mention'], 'spec.match', 'any'),
        value: optionalString(spec.value, 'spec.value', 300),
        hours,
        maxPerHour: Math.max(0, Math.min(240, asInt(spec.maxPerHour, 0))),
      },
      enabled: asBool(src.enabled, true),
      misfirePolicy: 'skip',
    };
  }
  return {
    type,
    label: optionalString(src.label, 'label', 200),
    spec: spec && typeof spec === 'object' ? spec : {},
    enabled: asBool(src.enabled, true),
    misfirePolicy: enumValue(src.misfirePolicy, ['skip', 'run-once'], 'misfirePolicy', 'skip'),
  };
}

function mapMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    text: row.text,
    tags: parseJson(row.tags, []) ?? [],
    weight: Number(row.weight ?? 1),
    hits: asInt(row.hits, 1),
    status: row.status,
    firstSeenAt: asInt(row.first_seen_at),
    lastSeenAt: asInt(row.last_seen_at),
    source: row.source,
    sourceArchiveId: row.source_archive_id ?? null,
    mergedInto: row.merged_into ?? null,
    meta: parseJson(row.meta, {}) ?? {},
  };
}

function mapDocument(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    content: row.content,
    chars: asInt(row.chars, 0),
    source: row.source,
    orderIndex: asInt(row.order_index, 0),
    createdAt: asInt(row.created_at),
    updatedAt: asInt(row.updated_at),
  };
}

export function createRepo(db, log) {
  const closingConversations = new Set();
  const checkExecutionTarget = task => {
    if(task?.executionTarget?.mode!=='dsh-session'||!task.enabled)return;
    const link=repo.dshLinks?.getLinks().find(l=>l.id===task.executionTarget.linkId);
    if(!link||!link.enabled||link.needsRelink||link.hostId!==repo.dshLinks.hostId)throw new RepoError('DSH 目标未关联或已停止，请重新选择关联会话后再启用任务','DSH_RELINK_REQUIRED',409);
  };
  const assertConversationBindable = (id) => {
    if (id && closingConversations.has(id)) throw new RepoError('会话正在关闭，暂不可绑定或发送消息，请稍后重试', 'CONVERSATION_CLOSING', 409);
  };
  const checkInjection = bindings => {
    const raw=parseJson(db.get('SELECT value FROM settings WHERE key=?','prompt.sections')?.value,null);
    const ids=new Set((raw?parseJson(raw,[]):defaultSections()).map(s=>s.id));
    for(const row of bindings ?? [])if(!ids.has(row.id))throw new RepoError('注入引用不存在：'+row.id);
  };
  const normalizeProfile = input => {
    const raw=parseJson(db.get('SELECT value FROM settings WHERE key=?','prompt.sections')?.value,null);
    const sections=raw?parseJson(raw,[]):defaultSections();
    const config=unifiedContextConfig(input ?? {},sections);
    if(!sections.some(s=>s.kind==='memory'&&!s.source))config.memory={mode:'global',slugs:null};
    return normalizeContextConfig(config);
  };
  const checkResources = policy => {
    const read = key => parseJson(parseJson(db.get('SELECT value FROM settings WHERE key=?',key)?.value,'[]'),[]);
    validateResourceReferences(policy,read('tools.packages'),read('tools.databaseSources'));
  };
  const repo = { syncMeta: key => db.getMeta(key), setSyncMeta: (key, value) => db.setMeta(key, value), isConfigurationCleared: () => db.getMeta('config.cleared') === '1', transaction: (fn) => db.tx(fn), clearConfiguration() {
    db.setMeta('config.cleared','1');
    db.setMeta('onboarding.v1',JSON.stringify({mode:null,status:'unconfigured',taskIds:{}}));
    db.run("UPDATE tasks SET deleted_at=?, enabled=0", now());
    db.run("DELETE FROM triggers");
    db.run('DELETE FROM group_glances');
    db.run("UPDATE contexts SET deleted_at=?", now());
    db.run("DELETE FROM tool_overlays");
    db.run("DELETE FROM channels");
    const saved = repo.projects.savedProgress();
    for (const project of repo.projects.list()) saved[project.id] = project.state;
    db.setMeta('projects.savedProgress', stringifyJson(saved));
    db.run("DELETE FROM projects");
  } };
  // Escape hatch for the few places that need a statement the repositories do
  // not expose (e.g. stamping an archive path inside the same service).
  repo.raw = db;

  // ------------------------------------------------------------- devices
  repo.devices = {
    create({ tokenHash, label, userAgent, days }) {
      const at = now();
      const row = {
        id: newId('dev'),
        token_hash: tokenHash,
        label: label || 'Browser',
        user_agent: userAgent || '',
        created_at: at,
        last_seen_at: at,
        expires_at: at + days * 86400_000,
        revoked_at: null,
      };
      db.run(
        'INSERT INTO devices (id, token_hash, label, user_agent, created_at, last_seen_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,NULL)',
        row.id,
        row.token_hash,
        row.label,
        row.user_agent,
        row.created_at,
        row.last_seen_at,
        row.expires_at,
      );
      return row;
    },
    byTokenHash(tokenHash) {
      const row = db.get('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL', tokenHash);
      if (!row) return null;
      if (asInt(row.expires_at) < now()) return null;
      return {
        id: row.id,
        label: row.label,
        createdAt: asInt(row.created_at),
        lastSeenAt: asInt(row.last_seen_at),
        expiresAt: asInt(row.expires_at),
      };
    },
    touch(deviceId, expiresAt) {
      db.run('UPDATE devices SET last_seen_at = ?, expires_at = ? WHERE id = ?', now(), expiresAt, deviceId);
    },
    list() {
      return db.all('SELECT * FROM devices ORDER BY created_at DESC').map((row) => ({
        id: row.id,
        label: row.label,
        userAgent: row.user_agent,
        createdAt: asInt(row.created_at),
        lastSeenAt: asInt(row.last_seen_at),
        expiresAt: asInt(row.expires_at),
        revokedAt: row.revoked_at ? asInt(row.revoked_at) : null,
      }));
    },
    revoke(deviceId) {
      const res = db.run('UPDATE devices SET revoked_at = ? WHERE id = ?', now(), deviceId);
      return res.changes > 0;
    },
    countActive() {
      const row = db.get(
        'SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL AND expires_at > ?',
        now(),
      );
      return asInt(row?.n, 0);
    },
  };

  // --------------------------------------------------------------- tasks
  repo.tasks = {
    list({ includeDeleted = false, withTriggers = true } = {}) {
      const rows = db.all(
        `SELECT * FROM tasks ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY created_at ASC`,
      );
      const tasks = rows.map(mapTask);
      if (!withTriggers) return tasks;
      const triggers = repo.triggers.listAll();
      for (const task of tasks) task.triggers = triggers.filter((t) => t.taskId === task.id);
      return tasks;
    },
    get(taskId) {
      const task = mapTask(db.get('SELECT * FROM tasks WHERE id = ?', taskId));
      if (!task) return null;
      task.triggers = repo.triggers.listAll().filter((t) => t.taskId === task.id);
      return task;
    },
    getRaw(taskId) {
      return mapTask(db.get('SELECT * FROM tasks WHERE id = ?', taskId));
    },
    create(input) {
      const data = normalizeTaskInput(input);
      if(data.kind==='maintenance' && !(data.description==='每日在独立维护对话同步关联会话增量，更新短期记忆。' && !data.goal) && !data.goal.includes('【正文维护】'))data.goal=[data.goal,data.memoryPolicy.longTermInstructions,MAINTENANCE_TEXT_GOAL].filter(Boolean).join('\n\n');
      if(data.kind==='journal' && !data.goal.includes('【日记正文】'))data.goal=[data.goal,JOURNAL_GOAL].filter(Boolean).join('\n\n');
      checkExecutionTarget(data);
      if(data.executionTarget.mode==='yu'){if (data.conversationMode === 'reuse') assertConversationBindable(data.conversationId);checkResources(data.toolPolicy);checkInjection(data.injection);}
      const at = now();
      const taskId = newId('task');
      db.run(
        `INSERT INTO tasks (id,name,kind,description,enabled,context_id,conversation_mode,conversation_id,goal,
          input_template,tool_policy,archive_policy,project_id,max_runtime_ms,created_at,updated_at,injection,execution_target,deleted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
        taskId,
        data.name,
        data.kind,
        data.description,
        data.enabled ? 1 : 0,
        data.contextId,
        data.conversationMode,
        data.conversationId,
        data.goal,
        data.inputTemplate,
        stringifyJson(data.toolPolicy),
        stringifyJson(data.archivePolicy),
        data.projectId,
        data.maxRuntimeMs,
        at,
        at,
        stringifyJson(data.injection),
        stringifyJson(data.executionTarget),
      );
      db.run('UPDATE tasks SET memory_policy=?, delivery_target=? WHERE id=?',stringifyJson(data.memoryPolicy),stringifyJson(data.deliveryTarget),taskId);
      return repo.tasks.get(taskId);
    },
    update(taskId, input) {
      const current = repo.tasks.getRaw(taskId);
      if (!current) throw new RepoError('task not found', 'NOT_FOUND', 404);
      const merged = normalizeTaskInput({ ...current, ...input }, current);
      checkExecutionTarget(merged);
      if(merged.executionTarget.mode==='yu'){if (merged.conversationMode === 'reuse') assertConversationBindable(merged.conversationId);checkResources(merged.toolPolicy);checkInjection(merged.injection);}
      db.run(
        `UPDATE tasks SET name=?,kind=?,description=?,enabled=?,context_id=?,conversation_mode=?,conversation_id=?,
          goal=?,input_template=?,tool_policy=?,archive_policy=?,project_id=?,max_runtime_ms=?,updated_at=?,injection=?,execution_target=?
         WHERE id=?`,
        merged.name,
        merged.kind,
        merged.description,
        merged.enabled ? 1 : 0,
        merged.contextId,
        merged.conversationMode,
        merged.conversationId,
        merged.goal,
        merged.inputTemplate,
        stringifyJson(merged.toolPolicy),
        stringifyJson(merged.archivePolicy),
        merged.projectId,
        merged.maxRuntimeMs,
        now(),
        stringifyJson(merged.injection),
        stringifyJson(merged.executionTarget),
        taskId,
      );
      db.run('UPDATE tasks SET memory_policy=?, delivery_target=? WHERE id=?',stringifyJson(merged.memoryPolicy),stringifyJson(merged.deliveryTarget),taskId);
      return repo.tasks.get(taskId);
    },
    softDelete(taskId) {
      const at = now();
      // Triggers are removed with the task, history is preserved on purpose.
      db.tx(() => {
        db.run('UPDATE tasks SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?', at, at, taskId);
        db.run('DELETE FROM group_glances WHERE binding_id IN (SELECT id FROM triggers WHERE task_id=?)',taskId);
        db.run('DELETE FROM triggers WHERE task_id = ?', taskId);
      });
      return repo.tasks.get(taskId);
    },
    setEnabled(taskId, enabled) {
      const task=repo.tasks.getRaw(taskId);if(!task)throw new RepoError('task not found','NOT_FOUND',404);checkExecutionTarget({...task,enabled});
      db.run('UPDATE tasks SET enabled = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, now(), taskId);
      return repo.tasks.get(taskId);
    },
    setConversationId(taskId, conversationId) {
      assertConversationBindable(conversationId);
      db.run('UPDATE tasks SET conversation_id = ?, updated_at = ? WHERE id = ?', conversationId, now(), taskId);
    },
  };

  // ------------------------------------------------------------ triggers
  repo.triggers = {
    listAll() {
      return db.all('SELECT * FROM triggers ORDER BY created_at ASC').map(mapTrigger);
    },
    listForTask(taskId) {
      return db.all('SELECT * FROM triggers WHERE task_id = ? ORDER BY created_at ASC', taskId).map(mapTrigger);
    },
    get(triggerId) {
      return mapTrigger(db.get('SELECT * FROM triggers WHERE id = ?', triggerId));
    },
    /**
     * Resolve a hook URL back to its trigger. The token is the only credential a
     * caller has, so the lookup is by token alone.
     */
    findByToken(tokenValue) {
      if (!tokenValue) return null;
      return mapTrigger(
        db.get(
          "SELECT * FROM triggers WHERE type = 'webhook' AND deleted_at IS NULL AND json_extract(spec, '$.token') = ?",
          String(tokenValue),
        ),
      );
    },
    create(taskId, input) {
      const data = normalizeTriggerInput(input);
      const at = now();
      const triggerId = newId('trg');
      db.run(
        `INSERT INTO triggers (id,task_id,type,label,spec,enabled,next_fire_at,last_fired_at,misfire_policy,created_at,updated_at,deleted_at)
         VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?,NULL)`,
        triggerId,
        taskId,
        data.type,
        data.label,
        stringifyJson(data.spec),
        data.enabled ? 1 : 0,
        data.misfirePolicy,
        at,
        at,
      );
      return repo.triggers.get(triggerId);
    },
    // Attaching metadata must not invalidate an already sampled schedule.
    attachDefinition(triggerId, definitionId) {
      const current = repo.triggers.get(triggerId);
      if (!current || current.spec?.definitionId) throw new RepoError('trigger cannot be migrated', 'CONFLICT', 409);
      const spec = {...current.spec, definitionId, localEnabled:current.enabled};
      db.run('UPDATE triggers SET spec=?,updated_at=? WHERE id=?', stringifyJson(spec), now(), triggerId);
    },
    update(triggerId, input) {
      const current = repo.triggers.get(triggerId);
      if (!current) throw new RepoError('trigger not found', 'NOT_FOUND', 404);
      const merged = { ...current, ...input };
      // A webhook's URL is a credential the person may already have pasted into a
      // script: editing the trigger must not silently rotate it. Merge the spec so
      // the token survives unless the caller explicitly sends a new one.
      if (current.type === 'webhook' && input?.spec && input.spec.token === undefined) {
        merged.spec = { ...(current.spec ?? {}), ...(input.spec ?? {}) };
      }
      const data = normalizeTriggerInput(merged);
      db.run(
        'UPDATE triggers SET type=?,label=?,spec=?,enabled=?,misfire_policy=?,updated_at=? WHERE id=?',
        data.type,
        data.label,
        stringifyJson(data.spec),
        data.enabled ? 1 : 0,
        data.misfirePolicy,
        now(),
        triggerId,
      );
      if (current.type !== data.type || JSON.stringify(current.spec) !== JSON.stringify(data.spec) || current.enabled !== data.enabled) repo.triggers.setSchedule(triggerId,{nextFireAt:null});
      if (current.type === 'group-watch' && (JSON.stringify(current.spec) !== JSON.stringify(data.spec) || current.enabled !== data.enabled)) db.run('DELETE FROM group_glances WHERE binding_id=?',triggerId);
      return repo.triggers.get(triggerId);
    },
    remove(triggerId) {
      db.run('DELETE FROM group_glances WHERE binding_id=?',triggerId);
      const res = db.run('DELETE FROM triggers WHERE id = ?', triggerId);
      return res.changes > 0;
    },
    setSchedule(triggerId, { nextFireAt, lastFiredAt }) {
      db.run(
        'UPDATE triggers SET next_fire_at = ?, last_fired_at = COALESCE(?, last_fired_at), updated_at = ? WHERE id = ?',
        nextFireAt ?? null,
        lastFiredAt ?? null,
        now(),
        triggerId,
      );
    },
    /**
     * Record that a non-scheduled trigger just fired.
     *
     * Scheduled triggers get `last_fired_at` from the scheduler when it computes
     * the next slot; message and group triggers have no slot, so without this the
     * console shows "最近触发 从未" for a channel that has been live for days.
     */
    touchFired(triggerId, atMs = now()) {
      if (!triggerId) return false;
      return (
        db.run('UPDATE triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?', atMs, now(), triggerId).changes > 0
      );
    },
    due(atMs) {
      return db
        .all(
          `SELECT t.* FROM triggers t JOIN tasks k ON k.id = t.task_id
           WHERE t.enabled = 1 AND t.deleted_at IS NULL AND k.deleted_at IS NULL AND k.enabled = 1
             AND t.next_fire_at IS NOT NULL AND t.next_fire_at <= ?
           ORDER BY t.next_fire_at ASC`,
          atMs,
        )
        .map(mapTrigger);
    },
    listScheduled() {
      // `next_fire_at` may still be NULL on a fresh install: the scheduler's
      // first pass is what computes it, so it must not filter those rows out.
      return db
        .all(
          `SELECT t.* FROM triggers t JOIN tasks k ON k.id = t.task_id
           WHERE t.enabled = 1 AND t.deleted_at IS NULL AND k.deleted_at IS NULL
             AND t.type = 'schedule'
           ORDER BY t.next_fire_at ASC`,
        )
        .map(mapTrigger);
    },
  };

  // ---------------------------------------------------------------- runs
  repo.runs = {
    /** How many runs one trigger produced since a timestamp (throttle support). */
    countSince(triggerId, since) {
      const row = db.get('SELECT COUNT(*) AS n FROM runs WHERE trigger_id = ? AND queued_at >= ?', triggerId, since);
      return asInt(row?.n, 0);
    },
    create({ taskId, triggerId, triggerReason, conversationId, inputText, status = 'queued', meta = {} }) {
      const runId = newId('run');
      db.run(
        `INSERT INTO runs (id,task_id,trigger_id,trigger_reason,conversation_id,session_id,status,phase,queued_at,
          started_at,finished_at,error_code,error_message,business_done,archive_done,memory_done,stop_requested_at,
          context_snapshot_id,input_text,output_text,usage,meta)
         VALUES (?,?,?,?,?,NULL,?,?,?,NULL,NULL,NULL,NULL,0,0,0,NULL,NULL,?, '', '{}', ?)`,
        runId,
        taskId ?? null,
        triggerId ?? null,
        triggerReason ?? '',
        conversationId ?? null,
        status,
        status,
        now(),
        inputText ?? '',
        stringifyJson(meta),
      );
      return repo.runs.get(runId);
    },
    get(runId) {
      return mapRun(db.get('SELECT * FROM runs WHERE id = ?', runId));
    },
    update(runId, patch) {
      const current = repo.runs.get(runId);
      if (!current) throw new RepoError('run not found', 'NOT_FOUND', 404);
      const next = { ...current, ...patch };
      db.run(
        `UPDATE runs SET task_id=?,trigger_id=?,trigger_reason=?,conversation_id=?,session_id=?,status=?,phase=?,
          queued_at=?,started_at=?,finished_at=?,error_code=?,error_message=?,business_done=?,archive_done=?,
          memory_done=?,stop_requested_at=?,context_snapshot_id=?,input_text=?,output_text=?,usage=?,meta=?
         WHERE id=?`,
        next.taskId ?? null,
        next.triggerId ?? null,
        next.triggerReason ?? '',
        next.conversationId ?? null,
        next.sessionId ?? null,
        next.status,
        next.phase,
        next.queuedAt,
        next.startedAt ?? null,
        next.finishedAt ?? null,
        next.errorCode ?? null,
        next.errorMessage ?? null,
        next.businessDone ? 1 : 0,
        next.archiveDone ? 1 : 0,
        next.memoryDone ? 1 : 0,
        next.stopRequestedAt ?? null,
        next.contextSnapshotId ?? null,
        next.inputText ?? '',
        next.outputText ?? '',
        stringifyJson(next.usage ?? {}),
        stringifyJson(next.meta ?? {}),
        runId,
      );
      return repo.runs.get(runId);
    },
    list({ from, to, taskId, status, limit = 200 } = {}) {
      const where = [];
      const params = [];
      if (from) {
        where.push('queued_at >= ?');
        params.push(from);
      }
      if (to) {
        where.push('queued_at < ?');
        params.push(to);
      }
      if (taskId) {
        where.push('task_id = ?');
        params.push(taskId);
      }
      if (status) {
        where.push('status = ?');
        params.push(status);
      }
      const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY queued_at DESC LIMIT ?`;
      return db.all(sql, ...params, Math.max(1, Math.min(1000, limit))).map(mapRun);
    },
    listJournalSources({ from, to, cursor = { at: 0, id: '' }, limit = 31 }) {
      return db.all(`SELECT r.* FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
        WHERE r.queued_at >= ? AND r.queued_at < ? AND r.status = 'succeeded'
          AND r.business_done = 1 AND r.finished_at IS NOT NULL
          AND (r.finished_at > ? OR (r.finished_at = ? AND
            (r.id > ? OR (r.id = ? AND ? > 0))))
          AND json_extract(r.meta, '$.internalRollover') IS NOT 1
          AND json_extract(r.meta, '$.authority') IS NOT 'guest'
          AND json_extract(r.meta, '$.kind') IS NOT 'qq_group'
          AND (t.kind IS NULL OR t.kind NOT IN ('maintenance','journal'))
          AND (json_extract(r.meta, '$.source') IS NOT 'message' OR json_extract(r.meta, '$.authority') = 'owner')
        ORDER BY r.finished_at ASC, r.id ASC LIMIT ?`,
        from, to, cursor.at, cursor.at, cursor.id, cursor.id, cursor.offset,
        Math.max(1, Math.min(1000, limit))).map(mapRun);
    },
    active() {
      return db
        .all("SELECT * FROM runs WHERE status IN ('queued','running','stopping') ORDER BY queued_at ASC")
        .map(mapRun);
    },
    unfinished() {
      return db
        .all("SELECT * FROM runs WHERE status IN ('queued','running','stopping','interrupted') ORDER BY queued_at ASC")
        .map(mapRun);
    },
    byConversation(conversationId, limit = 50) {
      return db
        .all('SELECT * FROM runs WHERE conversation_id = ? ORDER BY queued_at DESC LIMIT ?', conversationId, limit)
        .map(mapRun);
    },
    addStep(runId, kind, title, detail = '') {
      db.run(
        'INSERT INTO run_steps (id, run_id, at, kind, title, detail) VALUES (?,?,?,?,?,?)',
        newId('stp'),
        runId,
        now(),
        kind,
        String(title).slice(0, 300),
        String(detail ?? '').slice(0, 20000),
      );
    },
    steps(runId) {
      return db.all('SELECT * FROM run_steps WHERE run_id = ? ORDER BY at ASC, id ASC', runId).map((row) => ({
        id: row.id,
        at: asInt(row.at),
        kind: row.kind,
        title: row.title,
        detail: row.detail,
      }));
    },
    countByStatus() {
      const out = {};
      for (const row of db.all('SELECT status, COUNT(*) AS n FROM runs GROUP BY status')) {
        out[row.status] = asInt(row.n, 0);
      }
      return out;
    },
    forDate(day, timezone) {
      const start = startOfZonedDay(day, timezone);
      const end = startOfZonedDay(addOneDay(day), timezone);
      return repo.runs.list({ from: start, to: end });
    },
  };

  // ------------------------------------------------------------ contexts
  repo.contexts = {
    list({ includeDeleted = false } = {}) {
      const rows = db.all(
        `SELECT * FROM contexts ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY created_at ASC`,
      );
      return rows.map((row) => {
        const versionRow = db.get(
          'SELECT * FROM context_versions WHERE context_id = ? AND version = ?',
          row.id,
          row.current_version,
        );
        const ctxObj = mapContext(row, versionRow);
        ctxObj.usage = db.get(
          'SELECT COUNT(*) AS n FROM tasks WHERE context_id = ? AND deleted_at IS NULL',
          row.id,
        )?.n;
        return ctxObj;
      });
    },
    get(contextId, { version = null } = {}) {
      const row = db.get('SELECT * FROM contexts WHERE id = ?', contextId);
      if (!row) return null;
      const v = version ?? asInt(row.current_version, 1);
      const versionRow = db.get('SELECT * FROM context_versions WHERE context_id = ? AND version = ?', contextId, v);
      if (!versionRow) return null;
      const ctxObj = mapContext(row, versionRow);
      ctxObj.usage = asInt(
        db.get('SELECT COUNT(*) AS n FROM tasks WHERE context_id = ? AND deleted_at IS NULL', contextId)?.n,
        0,
      );
      ctxObj.versions = repo.contexts.versions(contextId);
      return ctxObj;
    },
    versions(contextId) {
      return db
        .all('SELECT * FROM context_versions WHERE context_id = ? ORDER BY version DESC', contextId)
        .map((row) => ({
          id: row.id,
          version: asInt(row.version),
          note: row.note,
          createdAt: asInt(row.created_at),
          config: parseJson(row.config, {}) ?? {},
        }));
    },
    create({ name, description, config, note = 'initial' }) {
      const at = now();
      const contextId = newId('ctx');
      const normalized = normalizeProfile(config);
      checkResources(normalized.tools);
      checkInjection(normalized.injection);
      db.tx(() => {
        db.run(
          'INSERT INTO contexts (id, name, description, current_version, created_at, updated_at, deleted_at) VALUES (?,?,?,1,?,?,NULL)',
          contextId,
          requireString(name, 'name', { max: 200, allowEmpty: false }),
          optionalString(description, 'description', 2000),
          at,
          at,
        );
        db.run(
          'INSERT INTO context_versions (id, context_id, version, config, note, created_at) VALUES (?,?,1,?,?,?)',
          newId('ctxv'),
          contextId,
          stringifyJson(normalized),
          note,
          at,
        );
      });
      return repo.contexts.get(contextId);
    },
    /** Always appends a new version — context configs are never edited in place. */
    saveVersion(contextId, { config, note = '', expectedVersion = null }) {
      const row = db.get('SELECT * FROM contexts WHERE id = ? AND deleted_at IS NULL', contextId);
      if (!row) throw new RepoError('context not found', 'NOT_FOUND', 404);
      if (expectedVersion !== null && asInt(row.current_version) !== asInt(expectedVersion)) {
        throw new RepoError(
          `context was changed by someone else (expected version ${expectedVersion}, current ${row.current_version})`,
          'VERSION_CONFLICT',
          409,
        );
      }
      const normalized = normalizeProfile(config);
      checkResources(normalized.tools);
      checkInjection(normalized.injection);
      const nextVersion = asInt(row.current_version, 1) + 1;
      const at = now();
      db.tx(() => {
        db.run(
          'INSERT INTO context_versions (id, context_id, version, config, note, created_at) VALUES (?,?,?,?,?,?)',
          newId('ctxv'),
          contextId,
          nextVersion,
          stringifyJson(normalized),
          note,
          at,
        );
        db.run('UPDATE contexts SET current_version = ?, updated_at = ? WHERE id = ?', nextVersion, at, contextId);
      });
      return repo.contexts.get(contextId);
    },
    rename(contextId, { name, description }) {
      db.run(
        'UPDATE contexts SET name = ?, description = ?, updated_at = ? WHERE id = ?',
        requireString(name, 'name', { max: 200, allowEmpty: false }),
        optionalString(description, 'description', 2000),
        now(),
        contextId,
      );
      return repo.contexts.get(contextId);
    },
    duplicate(contextId, name) {
      const src = repo.contexts.get(contextId);
      if (!src) throw new RepoError('context not found', 'NOT_FOUND', 404);
      return repo.contexts.create({
        name: name || `${src.name} 副本`,
        description: src.description,
        config: src.config,
        note: `copied from ${src.name} v${src.currentVersion}`,
      });
    },
    remove(contextId) {
      if(repo.dshLinks?.getLinks().some(link=>link.contextId===contextId&&!link.unlinked))throw new RepoError('上下文仍用于关联 DSH 会话，请先替换方案','IN_USE',409);
      const usage = asInt(
        db.get('SELECT COUNT(*) AS n FROM tasks WHERE context_id = ? AND deleted_at IS NULL', contextId)?.n,
        0,
      );
      if (usage > 0) {
        throw new RepoError(`context is still used by ${usage} task(s)`, 'IN_USE', 409);
      }
      const res = db.run('UPDATE contexts SET deleted_at = ? WHERE id = ?', now(), contextId);
      return res.changes > 0;
    },
    snapshot({ runId, conversationId, contextId, contextVersion, resolved }) {
      const snapshotId = newId('snap');
      db.run(
        'INSERT INTO context_snapshots (id, run_id, conversation_id, context_id, context_version, resolved, created_at) VALUES (?,?,?,?,?,?,?)',
        snapshotId,
        runId ?? null,
        conversationId ?? null,
        contextId ?? null,
        contextVersion ?? null,
        stringifyJson(resolved),
        now(),
      );
      return snapshotId;
    },
    recordToolEnforcement(snapshotId, enforcement) {
      const snapshot = repo.contexts.snapshotById(snapshotId);
      if (!snapshot) throw new RepoError('snapshot not found', 'NOT_FOUND', 404);
      db.run('UPDATE context_snapshots SET resolved = ? WHERE id = ?', stringifyJson({ ...snapshot.resolved, toolEnforcement: enforcement }), snapshotId);
    },
    snapshotById(snapshotId) {
      const row = db.get('SELECT * FROM context_snapshots WHERE id = ?', snapshotId);
      if (!row) return null;
      return {
        id: row.id,
        runId: row.run_id,
        conversationId: row.conversation_id,
        contextId: row.context_id,
        contextVersion: row.context_version === null ? null : asInt(row.context_version),
        createdAt: asInt(row.created_at),
        resolved: parseJson(row.resolved, {}) ?? {},
      };
    },
    latestSnapshotFor(conversationId) {
      const row = db.get(
        'SELECT id FROM context_snapshots WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1',
        conversationId,
      );
      return row ? repo.contexts.snapshotById(row.id) : null;
    },
  };

  // ------------------------------------------------------- conversations
  repo.conversations = {
    assertBindable: assertConversationBindable,
    beginClosing(id) {
      assertConversationBindable(id);
      closingConversations.add(id);
      return () => closingConversations.delete(id);
    },
    list({ kind, status, limit = 100, search = '' } = {}) {
      const where = [];
      const params = [];
      if (kind) {
        where.push('kind = ?');
        params.push(kind);
      }
      if (status) {
        where.push('status = ?');
        params.push(status);
      }
      if (search) {
        where.push('(title LIKE ? OR peer_label LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      const sql = `SELECT * FROM conversations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`;
      const rows = db.all(sql, ...params, Math.max(1, Math.min(500, limit)));
      const conversations = rows.map((row) => {
        const conv = mapConversation(row);
        conv.messageCount = asInt(
          db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', row.id)?.n,
          0,
        );
        conv.lastMessageAt = asInt(
          db.get('SELECT MAX(at) AS m FROM messages WHERE conversation_id = ?', row.id)?.m,
          asInt(row.updated_at),
        );
        return conv;
      });
      // "Which conversation did memory actually absorb?" is a join, not a guess:
      // one aggregate for the whole page instead of a query per row.
      if (conversations.length) {
        const marks = conversations.map(() => '?').join(',');
        const stats = db.all(
          `SELECT conversation_id, COUNT(*) AS n,
                  SUM(CASE WHEN absorbed_at IS NOT NULL THEN 1 ELSE 0 END) AS absorbed,
                  MAX(created_at) AS last
           FROM archives WHERE conversation_id IN (${marks}) GROUP BY conversation_id`,
          ...conversations.map((conv) => conv.id),
        );
        const byId = new Map(stats.map((row) => [row.conversation_id, row]));
        for (const conv of conversations) {
          const row = byId.get(conv.id);
          conv.archives = {
            count: asInt(row?.n, 0),
            absorbed: asInt(row?.absorbed, 0),
            lastAt: row?.last ? asInt(row.last) : null,
          };
          conv.memorized = conv.archives.absorbed > 0;
          conv.hasSession = Boolean(conv.sessionId);
        }
      }
      return conversations;
    },
    get(conversationId) {
      return mapConversation(db.get('SELECT * FROM conversations WHERE id = ?', conversationId));
    },
    /**
     * The conversation a peer's next message belongs to.
     *
     * Archived conversations are skipped: they were closed on purpose (their DSH
     * session is archived too), so a new message must open a new conversation
     * rather than walk back into the old session's context.
     */
    findRouted({ channelId, peerId, kind, taskId = null, authority = null, includeArchived = false }) {
      const rows = db.all(
        `SELECT * FROM conversations WHERE channel_id = ? AND peer_id = ? AND kind = ?
          ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY updated_at DESC LIMIT 30`,
        channelId ?? '', peerId ?? '', kind,
      );
      if (!taskId || !authority) return mapConversation(rows[0]);
      for (const row of rows) {
        const conversation = mapConversation(row);
        if (conversation.meta?.routeTaskId === taskId && conversation.meta?.routeAuthority === authority) return conversation;
      }
      // Adopt only a legacy conversation proven to belong to this task and
      // authority. A guest transcript must never become an owner's chat.
      for (const row of rows) {
        const conversation = mapConversation(row);
        if (conversation.meta?.routeTaskId || conversation.meta?.routeAuthority) continue;
        const prior = db.get(`SELECT id FROM runs WHERE conversation_id = ? AND task_id = ?
          AND json_extract(meta, '$.authority') = ? ORDER BY queued_at DESC LIMIT 1`,
          conversation.id, taskId, authority);
        if (!prior) continue;
        const activeAuthority = conversation.contextSnapshotId ? db.get(
          `SELECT json_extract(resolved, '$.authority') AS authority FROM context_snapshots WHERE id = ?`,
          conversation.contextSnapshotId)?.authority : null;
        const scopedToCurrent = conversation.sessionId && activeAuthority === authority;
        const mixed = db.get(`SELECT id FROM runs WHERE conversation_id = ?
          ${scopedToCurrent ? 'AND session_id = ?' : ''} AND
          (task_id IS NOT ? OR json_extract(meta, '$.authority') IS NOT ?) LIMIT 1`,
          conversation.id, ...(scopedToCurrent ? [conversation.sessionId] : []), taskId, authority);
        if (mixed) continue;
        return repo.conversations.update(conversation.id, {
          meta: { ...conversation.meta, routeTaskId: taskId, routeAuthority: authority },
        });
      }
      return null;
    },
    create({
      title,
      kind = 'web',
      channelId = null,
      peerId = null,
      peerLabel = '',
      projectId = null,
      contextId = null,
      sessionId = null,
      meta = {},
    }) {
      const at = now();
      const conversationId = newId('conv');
      db.run(
        `INSERT INTO conversations (id,title,kind,channel_id,peer_id,peer_label,project_id,context_id,session_id,
          context_snapshot_id,status,archive_cursor_seq,created_at,updated_at,archived_at,meta)
         VALUES (?,?,?,?,?,?,?,?,?,NULL,'idle',0,?,?,NULL,?)`,
        conversationId,
        String(title ?? '').slice(0, 300),
        enumValue(kind, ['web', 'task', 'qq_private', 'qq_group', 'qq_official', 'reading'], 'kind', 'web'),
        channelId,
        peerId,
        peerLabel ?? '',
        projectId,
        contextId,
        sessionId,
        at,
        at,
        stringifyJson(meta),
      );
      return repo.conversations.get(conversationId);
    },
    update(conversationId, patch) {
      const current = repo.conversations.get(conversationId);
      if (!current) throw new RepoError('conversation not found', 'NOT_FOUND', 404);
      const next = { ...current, ...patch };
      db.run(
        `UPDATE conversations SET title=?,status=?,session_id=?,context_id=?,context_snapshot_id=?,
          archive_cursor_seq=?,archived_at=?,updated_at=?,meta=? WHERE id=?`,
        next.title ?? '',
        next.status ?? 'idle',
        next.sessionId ?? null,
        next.contextId ?? null,
        next.contextSnapshotId ?? null,
        asInt(next.archiveCursorSeq, 0),
        next.archivedAt ?? null,
        now(),
        stringifyJson(next.meta ?? {}),
        conversationId,
      );
      return repo.conversations.get(conversationId);
    },
    touch(conversationId, status) {
      if (status) {
        db.run('UPDATE conversations SET updated_at = ?, status = ? WHERE id = ?', now(), status, conversationId);
      } else {
        db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', now(), conversationId);
      }
    },
    setContext(conversationId, contextId) {
      db.run('UPDATE conversations SET context_id = ?, updated_at = ? WHERE id = ?', contextId, now(), conversationId);
    },
    archive(conversationId, cursorSeq) {
      const at = now();
      db.run(
        'UPDATE conversations SET status = ?, archived_at = ?, archive_cursor_seq = ?, updated_at = ? WHERE id = ?',
        'archived',
        at,
        asInt(cursorSeq, 0),
        at,
        conversationId,
      );
      return repo.conversations.get(conversationId);
    },
    reopen(conversationId) {
      db.run(
        'UPDATE conversations SET status = ?, archived_at = NULL, updated_at = ? WHERE id = ?',
        'idle',
        now(),
        conversationId,
      );
      return repo.conversations.get(conversationId);
    },
    remove(conversationId) {
      const res = db.run('DELETE FROM conversations WHERE id = ?', conversationId);
      return res.changes > 0;
    },
  };

  // ------------------------------------------------------------ messages
  repo.messages = {
    list(conversationId, { limit = 200, before = null } = {}) {
      const params = [conversationId];
      let sql = 'SELECT * FROM messages WHERE conversation_id = ?';
      if (before) {
        sql += ' AND at < ?';
        params.push(before);
      }
      sql += ' ORDER BY at DESC, rowid DESC LIMIT ?';
      params.push(Math.max(1, Math.min(1000, limit)));
      return db
        .all(sql, ...params)
        .map((row) => ({
          id: row.id,
          conversationId: row.conversation_id,
          runId: row.run_id ?? null,
          role: row.role,
          text: row.text,
          blocks: parseJson(row.blocks, []) ?? [],
          at: asInt(row.at),
          seq: asInt(row.seq, 0),
          meta: parseJson(row.meta, {}) ?? {},
        }))
        .reverse();
    },
    add({ conversationId, runId = null, role, text, blocks = [], seq = 0, meta = {} }) {
      const messageId = newId('msg');
      db.run(
        'INSERT INTO messages (id, conversation_id, run_id, role, text, blocks, at, seq, meta) VALUES (?,?,?,?,?,?,?,?,?)',
        messageId,
        conversationId,
        runId,
        role,
        String(text ?? ''),
        stringifyJson(blocks),
        now(),
        asInt(seq, 0),
        stringifyJson(meta),
      );
      repo.conversations.touch(conversationId);
      return messageId;
    },
    updateMeta(messageId, meta) {
      db.run('UPDATE messages SET meta = ? WHERE id = ?', stringifyJson(meta), messageId);
    },
    count(conversationId) {
      return asInt(db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conversationId)?.n, 0);
    },
  };

  // ------------------------------------------------------------ projects
  repo.projects = {
    savedProgress() { return parseJson(db.getMeta('projects.savedProgress','{}'),{}) ?? {}; },
    list() {
      return db.all('SELECT * FROM projects ORDER BY updated_at DESC').map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        state: parseJson(row.state, {}) ?? {},
        createdAt: asInt(row.created_at),
        updatedAt: asInt(row.updated_at),
      }));
    },
    get(projectId) {
      const row = db.get('SELECT * FROM projects WHERE id = ?', projectId);
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        state: parseJson(row.state, {}) ?? {},
        createdAt: asInt(row.created_at),
        updatedAt: asInt(row.updated_at),
      };
    },
    upsert({ id: projectId, name, kind = 'reading', state }) {
      const at = now();
      if (projectId && repo.projects.get(projectId)) {
        db.run('UPDATE projects SET name = ?, kind = ?, state = ?, updated_at = ? WHERE id = ?', name, kind, stringifyJson(state), at, projectId);
        return repo.projects.get(projectId);
      }
      const pid = projectId || newId('prj');
      db.run(
        'INSERT INTO projects (id,name,kind,state,updated_at,created_at) VALUES (?,?,?,?,?,?)',
        pid,
        name,
        kind,
        stringifyJson(state),
        at,
        at,
      );
      return repo.projects.get(pid);
    },
    /**
     * Transactional progress advance. `advance` receives the current state and
     * returns the next state; a guarded write makes a repeated call a no-op,
     * so a crash between business commit and bookkeeping cannot re-advance.
     */
    advance(projectId, advanceFn) {
      return db.tx(() => {
        const current = repo.projects.get(projectId);
        if (!current) throw new RepoError('project not found', 'NOT_FOUND', 404);
        const nextState = advanceFn(current.state ?? {});
        if (nextState === null || nextState === undefined) return current;
        db.run('UPDATE projects SET state = ?, updated_at = ? WHERE id = ?', stringifyJson(nextState), now(), projectId);
        return repo.projects.get(projectId);
      });
    },
  };

  // ------------------------------------------------------------ archives
  repo.archives = {
    create({ runId, conversationId, taskId, projectId, fromSeq, toSeq, material, path = null }) {
      const archiveId = newId('arc');
      db.run(
        `INSERT INTO archives (id,run_id,conversation_id,task_id,project_id,created_at,from_seq,to_seq,material,path,absorbed_at,memory_version_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
        archiveId,
        runId ?? null,
        conversationId ?? null,
        taskId ?? null,
        projectId ?? null,
        now(),
        asInt(fromSeq, 0),
        asInt(toSeq, 0),
        stringifyJson(material),
        path,
      );
      return repo.archives.get(archiveId);
    },
    get(archiveId) {
      const row = db.get('SELECT * FROM archives WHERE id = ?', archiveId);
      if (!row) return null;
      return {
        id: row.id,
        runId: row.run_id,
        conversationId: row.conversation_id,
        taskId: row.task_id,
        projectId: row.project_id,
        createdAt: asInt(row.created_at),
        fromSeq: asInt(row.from_seq),
        toSeq: asInt(row.to_seq),
        material: parseJson(row.material, {}) ?? {},
        path: row.path ?? null,
        absorbedAt: row.absorbed_at === null ? null : asInt(row.absorbed_at),
        memoryVersionId: row.memory_version_id ?? null,
      };
    },
    list({ limit = 100, pendingOnly = false, projectId = null } = {}) {
      const where = [];
      const params = [];
      if (pendingOnly) where.push('absorbed_at IS NULL');
      if (projectId) {
        where.push('project_id = ?');
        params.push(projectId);
      }
      const sql = `SELECT * FROM archives ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
      return db.all(sql, ...params, Math.max(1, Math.min(500, limit))).map((row) => repo.archives.get(row.id));
    },
    pending(limit = 40) {
      return db
        .all('SELECT id FROM archives WHERE absorbed_at IS NULL ORDER BY created_at ASC LIMIT ?', limit)
        .map((row) => repo.archives.get(row.id));
    },
    markAbsorbed(archiveId, versionId, at = now()) {
      db.run(
        'UPDATE archives SET absorbed_at = ?, memory_version_id = ? WHERE id = ? AND absorbed_at IS NULL',
        at,
        versionId,
        archiveId,
      );
    },
    // Unused-but-explicit: absorbing the same archive twice must be impossible.
    alreadyAbsorbed(archiveId) {
      return Boolean(db.get('SELECT 1 AS x FROM memory_absorptions WHERE archive_id = ?', archiveId));
    },
  };

  // -------------------------------------------------------------- memory
  repo.memory = {
    blocks({ includeDisabled = true } = {}) {
      const rows = db.all(
        `SELECT * FROM memory_blocks ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY order_index ASC, created_at ASC`,
      );
      return rows.map(mapMemoryBlock);
    },
    blockBySlug(slug) {
      return mapMemoryBlock(db.get('SELECT * FROM memory_blocks WHERE slug = ?', slug));
    },
    createBlock({ slug, name, category, content = '', orderIndex = 0, enabled = true }) {
      const cleanSlug = requireString(slug, 'slug', { max: 80, allowEmpty: false }).toLowerCase();
      if (repo.memory.blockBySlug(cleanSlug)) throw new RepoError('slug already exists', 'DUPLICATE', 409);
      const at = now();
      db.run(
        'INSERT INTO memory_blocks (id,slug,name,category,order_index,enabled,content,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        newId('mem'),
        cleanSlug,
        requireString(name, 'name', { max: 120, allowEmpty: false }),
        enumValue(category, MEMORY_CATEGORIES, 'category', 'custom'),
        asInt(orderIndex, 99),
        enabled ? 1 : 0,
        String(content ?? ''),
        at,
        at,
      );
      return repo.memory.blockBySlug(cleanSlug);
    },
    updateBlock(slug, patch) {
      const current = repo.memory.blockBySlug(slug);
      if (!current) throw new RepoError('memory block not found', 'NOT_FOUND', 404);
      const next = { ...current, ...patch };
      db.run(
        'UPDATE memory_blocks SET name=?, category=?, order_index=?, enabled=?, content=?, updated_at=? WHERE slug=?',
        requireString(next.name, 'name', { max: 120, allowEmpty: false }),
        enumValue(next.category, MEMORY_CATEGORIES, 'category', current.category),
        asInt(next.orderIndex, current.orderIndex),
        asBool(next.enabled, current.enabled) ? 1 : 0,
        String(next.content ?? ''),
        now(),
        slug,
      );
      return repo.memory.blockBySlug(slug);
    },
    deleteBlock(slug) {
      const res = db.run('DELETE FROM memory_blocks WHERE slug = ?', slug);
      return res.changes > 0;
    },
    reorder(slugs) {
      db.tx(() => {
        slugs.forEach((slug, index) => {
          db.run('UPDATE memory_blocks SET order_index = ?, updated_at = ? WHERE slug = ?', index * 10, now(), slug);
        });
        db.setMeta('memory.projectionPending', '1');
        repo.memory.registerProjection?.();
      });
      return repo.memory.blocks();
    },
    versions({ limit = 50 } = {}) {
      return db.all('SELECT * FROM memory_versions ORDER BY version DESC LIMIT ?', limit).map((row) => ({
        id: row.id,
        version: asInt(row.version),
        note: row.note,
        createdAt: asInt(row.created_at),
        publishedAt: asInt(row.published_at),
        source: row.source,
        blocks: parseJson(row.blocks, []) ?? [],
        style: row.style ?? '',
      }));
    },
    versionById(versionId) {
      const row = db.get('SELECT * FROM memory_versions WHERE id = ?', versionId);
      if (!row) return null;
      return {
        id: row.id,
        version: asInt(row.version),
        note: row.note,
        createdAt: asInt(row.created_at),
        publishedAt: asInt(row.published_at),
        source: row.source,
        blocks: parseJson(row.blocks, []) ?? [],
        style: row.style ?? '',
      };
    },
    latestVersion() {
      const row = db.get('SELECT * FROM memory_versions ORDER BY version DESC LIMIT 1');
      return row ? repo.memory.versionById(row.id) : null;
    },
    pendingSyncConversations() { return db.all("SELECT * FROM conversations WHERE json_extract(meta,'$.maintenance')=1 AND json_extract(meta,'$.syncCommitted')=1 AND archived_at IS NULL").map(mapConversation); },
    syncCursor() { return parseJson(db.getMeta('memory.sync.cursor.v1', '{}'), {}) ?? {}; },
    longCursor() { return parseJson(db.getMeta('memory.long.cursor.v1', '{}'), {}) ?? {}; },
    commitLongCursor(cursor, messages = []) {
      db.setMeta('memory.long.cursor.v1',JSON.stringify(cursor));
      for(const row of messages) db.run('INSERT OR IGNORE INTO memory_long_consumed(message_id,consumed_at) VALUES(?,?)',row.id,now());
    },
    longMessages() {
      return db.all(`SELECT m.rowid AS cursor,m.*,c.title FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE json_extract(c.meta,'$.maintenance') IS NOT 1 AND m.role='user' AND json_extract(m.meta,'$.failed') IS NOT 1 AND NOT EXISTS(SELECT 1 FROM memory_long_consumed x WHERE x.message_id=m.id) ORDER BY m.rowid`);
    },
    commitSyncCursor(cursor, messages = []) {
      db.setMeta('memory.sync.cursor.v1', JSON.stringify(cursor));
      for(const row of messages) db.run('INSERT OR IGNORE INTO memory_sync_consumed(message_id,conversation_id,consumed_at) VALUES(?,?,?)',row.id,row.conversation_id,now());
    },
    syncMessages() {
      return db.all(`SELECT m.rowid AS cursor, m.*, c.title FROM messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE json_extract(c.meta,'$.maintenance') IS NOT 1 AND m.role IN ('user','assistant')
        AND json_extract(m.meta,'$.failed') IS NOT 1 AND NOT EXISTS (SELECT 1 FROM memory_sync_consumed x WHERE x.message_id=m.id) ORDER BY m.rowid`);
    },
    /** Atomic publish: version row + block table swapped in one transaction. */
    publish({ blocks, style = '', note = '', source = 'manual', absorbedArchiveIds = [], expectedRevision = null }) {
      return db.tx(() => {
        repo.memory.assertRevision(expectedRevision);
        const last = db.get('SELECT MAX(version) AS v FROM memory_versions');
        const version = asInt(last?.v, 0) + 1;
        const versionId = newId('mv');
        const at = now();
        const snapshot = blocks.map((b, index) => ({
          slug: b.slug,
          name: b.name,
          category: b.category,
          orderIndex: asInt(b.orderIndex, index * 10),
          enabled: b.enabled !== false,
          content: String(b.content ?? ''),
        }));
        db.run(
          'INSERT INTO memory_versions (id,version,note,blocks,style,created_at,published_at,source) VALUES (?,?,?,?,?,?,?,?)',
          versionId,
          version,
          String(note ?? ''),
          stringifyJson(snapshot),
          String(style ?? ''),
          at,
          at,
          source,
        );
        for (const b of snapshot) {
          const existing = db.get('SELECT id FROM memory_blocks WHERE slug = ?', b.slug);
          if (existing) {
            db.run(
              'UPDATE memory_blocks SET name=?,category=?,order_index=?,enabled=?,content=?,updated_at=? WHERE slug=?',
              b.name,
              b.category,
              b.orderIndex,
              b.enabled ? 1 : 0,
              b.content,
              at,
              b.slug,
            );
          } else {
            db.run(
              'INSERT INTO memory_blocks (id,slug,name,category,order_index,enabled,content,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
              newId('mem'),
              b.slug,
              b.name,
              b.category,
              b.orderIndex,
              b.enabled ? 1 : 0,
              b.content,
              at,
              at,
            );
          }
        }
        for (const archiveId of absorbedArchiveIds) {
          db.run(
            'INSERT OR IGNORE INTO memory_absorptions (id, version_id, archive_id, created_at) VALUES (?,?,?,?)',
            newId('abs'),
            versionId,
            archiveId,
            at,
          );
          db.run(
            'UPDATE archives SET absorbed_at = COALESCE(absorbed_at, ?), memory_version_id = ? WHERE id = ? AND absorbed_at IS NULL',
            at,
            versionId,
            archiveId,
          );
        }
        // `style_versions` is the authority the context compiler reads, so a
        // memory snapshot that carries a changed style must publish one too —
        // in this same transaction, or a page could show a style the runs never
        // see.
        if (String(style ?? '').trim()) {
          const currentStyle = db.get('SELECT content FROM style_versions ORDER BY version DESC LIMIT 1');
          if (!currentStyle || currentStyle.content !== String(style)) {
            const lastStyle = db.get('SELECT MAX(version) AS v FROM style_versions');
            db.run(
              'INSERT INTO style_versions (id,version,content,note,created_at,published_at,source) VALUES (?,?,?,?,?,?,?)',
              newId('sv'),
              asInt(lastStyle?.v, 0) + 1,
              String(style),
              `memory v${version}`,
              at,
              at,
              source === 'manual' ? 'manual' : 'maintenance',
            );
          }
        }
        db.setMeta('memory.projectionPending', '1');
        repo.memory.registerProjection?.();
        return repo.memory.versionById(versionId);
      });
    },
    restoreVersion(versionId, note = '') {
      const version = repo.memory.versionById(versionId);
      if (!version) throw new RepoError('memory version not found', 'NOT_FOUND', 404);
      return repo.memory.publish({
        blocks: version.blocks,
        style: version.style,
        note: note || `restore of v${version.version}`,
        source: 'restore',
      });
    },
    logMaintenance({ status, trigger, runId = null, versionId = null, absorbed = 0, error = null, detail = {} }) {
      const entryId = newId('mmt');
      db.run(
        'INSERT INTO memory_maintenance (id, at, status, trigger, run_id, version_id, absorbed, error, detail) VALUES (?,?,?,?,?,?,?,?,?)',
        entryId,
        now(),
        status,
        trigger,
        runId,
        versionId,
        absorbed,
        error,
        stringifyJson(detail),
      );
      return entryId;
    },
    maintenanceLog(limit = 30) {
      return db.all('SELECT * FROM memory_maintenance ORDER BY at DESC LIMIT ?', limit).map((row) => ({
        id: row.id,
        at: asInt(row.at),
        status: row.status,
        trigger: row.trigger,
        runId: row.run_id,
        versionId: row.version_id,
        absorbed: asInt(row.absorbed),
        error: row.error,
        detail: parseJson(row.detail, {}) ?? {},
      }));
    },
    /** Rendered Markdown of one block set — what the model actually reads. */
    render(blocks) {
      return blocks
        .filter((b) => b.enabled !== false && String(b.content ?? '').trim())
        .map((b) => `### ${b.name}\n\n${String(b.content).trim()}`)
        .join('\n\n');
    },
  };

  // --------------------------------------------------------------- style
  repo.style = {
    versions(limit = 50) {
      return db.all('SELECT * FROM style_versions ORDER BY version DESC LIMIT ?', limit).map((row) => ({
        id: row.id,
        version: asInt(row.version),
        content: row.content,
        note: row.note,
        createdAt: asInt(row.created_at),
        publishedAt: asInt(row.published_at),
        source: row.source,
      }));
    },
    current() {
      const row = db.get('SELECT * FROM style_versions ORDER BY version DESC LIMIT 1');
      if (!row) return null;
      return {
        id: row.id,
        version: asInt(row.version),
        content: row.content,
        note: row.note,
        createdAt: asInt(row.created_at),
        publishedAt: asInt(row.published_at),
        source: row.source,
      };
    },
    publish({ content, note = '', source = 'manual' }) {
      return db.tx(() => {
        const last = db.get('SELECT MAX(version) AS v FROM style_versions');
        const version = asInt(last?.v, 0) + 1;
        const versionId = newId('sv');
        const at = now();
        db.run(
          'INSERT INTO style_versions (id,version,content,note,created_at,published_at,source) VALUES (?,?,?,?,?,?,?)',
          versionId,
          version,
          String(content ?? ''),
          String(note ?? ''),
          at,
          at,
          source,
        );
        const row = db.get('SELECT * FROM style_versions WHERE id = ?', versionId);
        return {
          id: row.id,
          version: asInt(row.version),
          content: row.content,
          note: row.note,
          createdAt: asInt(row.created_at),
          publishedAt: asInt(row.published_at),
          source: row.source,
        };
      });
    },
    restore(versionId) {
      const row = db.get('SELECT * FROM style_versions WHERE id = ?', versionId);
      if (!row) throw new RepoError('style version not found', 'NOT_FOUND', 404);
      return repo.style.publish({
        content: row.content,
        note: `restore of v${row.version}`,
        source: 'restore',
      });
    },
  };

  // ---------------------------------------------------------- tool overlay
  repo.tools = {
    overlay(name) {
      const row = db.get('SELECT * FROM tool_overlays WHERE name = ?', name);
      if (!row) return null;
      return {
        name: row.name,
        enabled: asBool(row.enabled, true),
        description: row.description ?? null,
        example: row.example ?? null,
        config: parseJson(row.config, {}) ?? {},
        updatedAt: asInt(row.updated_at),
      };
    },
    overlays() {
      return db.all('SELECT * FROM tool_overlays').map((row) => ({
        name: row.name,
        enabled: asBool(row.enabled, true),
        description: row.description ?? null,
        example: row.example ?? null,
        config: parseJson(row.config, {}) ?? {},
        updatedAt: asInt(row.updated_at),
      }));
    },
    setOverlay(name, patch) {
      const current = repo.tools.overlay(name);
      const enabled = patch.enabled === undefined ? (current?.enabled ?? true) : asBool(patch.enabled, true);
      const description = patch.description === undefined ? (current?.description ?? null) : patch.description;
      const example = patch.example === undefined ? (current?.example ?? null) : patch.example;
      const config = patch.config === undefined ? (current?.config ?? {}) : patch.config;
      db.run(
        `INSERT INTO tool_overlays (name, enabled, description, example, config, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled, description=excluded.description,
           example=excluded.example, config=excluded.config, updated_at=excluded.updated_at`,
        name,
        enabled ? 1 : 0,
        description,
        example,
        stringifyJson(config),
        now(),
      );
      return repo.tools.overlay(name);
    },
    recordCall({ name, runId = null, sessionId = null, args, result, error = null, ok = true, durationMs = 0 }) {
      db.run(
        'INSERT INTO tool_calls (id,name,run_id,session_id,arguments,result,error,ok,duration_ms,at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        newId('tcl'),
        name,
        runId,
        sessionId,
        stringifyJson(args),
        result === undefined ? null : stringifyJson(result),
        error,
        ok ? 1 : 0,
        asInt(durationMs, 0),
        now(),
      );
    },
    callsForRun(runId) {
      return this.recentCalls(null, null, runId);
    },
    recentCalls(name = null, limit = 30, runId = null) {
      const rows = runId ? db.all('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY at ASC',runId) : name
        ? db.all('SELECT * FROM tool_calls WHERE name = ? ORDER BY at DESC LIMIT ?', name, limit)
        : db.all('SELECT * FROM tool_calls ORDER BY at DESC LIMIT ?', limit);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        runId: row.run_id,
        sessionId: row.session_id,
        arguments: parseJson(row.arguments, {}),
        result: parseJson(row.result, null),
        error: row.error,
        ok: asBool(row.ok, true),
        durationMs: asInt(row.duration_ms),
        at: asInt(row.at),
      }));
    },
  };

  // ------------------------------------------------------------ channels
  repo.channels = {
    list() {
      return db.all('SELECT * FROM channels ORDER BY created_at ASC').map(mapChannel);
    },
    get(channelId) {
      return mapChannel(db.get('SELECT * FROM channels WHERE id = ?', channelId));
    },
    create({ name, type, config, enabled = false }) {
      const at = now();
      const channelId = newId('ch');
      db.run(
        'INSERT INTO channels (id,name,type,config,enabled,status,last_error,last_event_at,connected_at,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,?)',
        channelId,
        requireString(name, 'name', { max: 120, allowEmpty: false }),
        enumValue(type, ['web', 'napcat', 'snowluma', 'qq-official', 'onebot'], 'type', 'napcat'),
        stringifyJson(config ?? {}),
        enabled ? 1 : 0,
        enabled ? 'connecting' : 'disabled',
        at,
        at,
      );
      return repo.channels.get(channelId);
    },
    update(channelId, patch) {
      const current = repo.channels.get(channelId);
      if (!current) throw new RepoError('channel not found', 'NOT_FOUND', 404);
      const next = { ...current, ...patch };
      db.run(
        'UPDATE channels SET name=?, config=?, enabled=?, status=?, last_error=?, connected_at=?, updated_at=? WHERE id=?',
        requireString(next.name, 'name', { max: 120, allowEmpty: false }),
        stringifyJson(next.config ?? {}),
        next.enabled ? 1 : 0,
        next.status ?? current.status,
        next.lastError ?? null,
        next.connectedAt ?? null,
        now(),
        channelId,
      );
      return repo.channels.get(channelId);
    },
    setRuntime(channelId, { status, lastError = null, connectedAt = null, lastEventAt = null }) {
      db.run(
        `UPDATE channels SET status = ?, last_error = ?, connected_at = COALESCE(?, connected_at),
           last_event_at = COALESCE(?, last_event_at), updated_at = ? WHERE id = ?`,
        status,
        lastError,
        connectedAt,
        lastEventAt,
        now(),
        channelId,
      );
    },
    remove(channelId) {
      db.run('DELETE FROM group_glances WHERE channel_id=?',channelId);
      const res = db.run('DELETE FROM channels WHERE id = ?', channelId);
      return res.changes > 0;
    },
    /**
     * Claim an inbound event exactly once. Returns false when this
     * (channel, account, event) triple was already seen.
     */
    observePeer(event) {
      if(!['qq_private','qq_group'].includes(event.kind) || !event.peerId) return;
      db.run('INSERT INTO channel_peers(channel_id,peer_kind,peer_id,peer_label,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(channel_id,peer_kind,peer_id) DO UPDATE SET peer_label=excluded.peer_label,last_seen_at=excluded.last_seen_at',event.channelId,event.kind==='qq_group'?'group':'private',String(event.peerId),String(event.peerLabel??'').slice(0,120),now());
    },
    peers() {
      const peers=new Map();const add=p=>{const key=[p.channelId,p.peerKind,p.peerId].join(':');if(p.channelId&&p.peerId&&!peers.has(key))peers.set(key,p);};
      for(const p of db.all('SELECT channel_id AS channelId,peer_kind AS peerKind,peer_id AS peerId,peer_label AS peerLabel,last_seen_at AS lastSeenAt FROM channel_peers ORDER BY last_seen_at DESC LIMIT 1000'))add(p);
      for(const p of db.all("SELECT channel_id AS channelId,CASE kind WHEN 'qq_group' THEN 'group' ELSE 'private' END AS peerKind,peer_id AS peerId,peer_label AS peerLabel FROM conversations WHERE kind IN ('qq_private','qq_group') ORDER BY updated_at DESC LIMIT 1000"))add(p);
      // Metadata only: older no-task events still identify their received source.
      for(const e of db.all('SELECT channel_id,event_id FROM channel_events ORDER BY at DESC LIMIT 2000')){const m=/^(private|group):(\d+):/.exec(e.event_id);if(m)add({channelId:e.channel_id,peerKind:m[1],peerId:m[2],peerLabel:''});}
      return [...peers.values()];
    },
    claimEvent({ channelId, accountId = '', eventId, detail = {} }) {
      const at = now();
      const existing = db.get(
        'SELECT status FROM channel_events WHERE channel_id = ? AND account_id = ? AND event_id = ?',
        channelId,
        accountId,
        eventId,
      );
      if (existing) return false;
      db.run(
        'INSERT INTO channel_events (channel_id, account_id, event_id, status, at, detail) VALUES (?,?,?,?,?,?)',
        channelId,
        accountId,
        eventId,
        'received',
        at,
        stringifyJson(detail),
      );
      return true;
    },
    markEvent(channelId, accountId, eventId, status, detail = {}) {
      db.run(
        'UPDATE channel_events SET status = ?, detail = ? WHERE channel_id = ? AND account_id = ? AND event_id = ?',
        status,
        stringifyJson(detail),
        channelId,
        accountId,
        eventId,
      );
    },
    pruneEvents(keepPerChannel = 2000) {
      db.run(
        `DELETE FROM channel_events WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid, ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY at DESC) AS rn FROM channel_events
           ) WHERE rn > ?
         )`,
        keepPerChannel,
      );
    },
    eventCount(channelId) {
      return asInt(db.get('SELECT COUNT(*) AS n FROM channel_events WHERE channel_id = ?', channelId)?.n, 0);
    },
  };

  /**
   * The group message buffer.
   *
   * Every group message lands here — no model call, no per-message run. The
   * attention policy reads a window when it decides to look, and memory
   * maintenance drains the whole buffer into one absorption pass before deleting
   * it. Everything here is cheap on purpose: appending must never be the reason a
   * busy room lags.
   */
  repo.groupBuffer = {
    glance(bindingId, channelId, peerId, message, {keywords = [], messageCount = 20, windowMessages = 30, direct = false, defer = false} = {}) {
      return db.tx(() => {
        const previous = db.get('SELECT * FROM group_glances WHERE binding_id=? AND channel_id=? AND peer_id=?', bindingId, channelId, peerId);
        const pending = previous ? JSON.parse(previous.pending) : [];
        pending.push({...message,text:String(message.text??'').slice(0,4000),senderName:String(message.senderName??'').slice(0,80)});
        const count = (previous?.count ?? 0) + 1;
        const keyword = keywords.find(word => String(message.text).toLowerCase().includes(String(word).toLowerCase()));
        const fire = !direct && !defer && (Boolean(keyword) || count >= messageCount);
        db.run(`INSERT INTO group_glances(binding_id,channel_id,peer_id,count,pending) VALUES(?,?,?,?,?) ON CONFLICT(binding_id,channel_id,peer_id) DO UPDATE SET count=excluded.count,pending=excluded.pending`, bindingId,channelId,peerId,direct || fire ? 0 : count,JSON.stringify(direct || fire ? [] : pending.slice(-windowMessages)));
        return {fire, keyword, count, messages: pending.slice(-windowMessages)};
      });
    },
    restoreGlance(bindingId, channelId, peerId, batch, limit = 30) {
      const row = db.get('SELECT * FROM group_glances WHERE binding_id=? AND channel_id=? AND peer_id=?',bindingId,channelId,peerId);
      db.run('UPDATE group_glances SET count=?,pending=? WHERE binding_id=? AND channel_id=? AND peer_id=?', (row?.count ?? 0)+batch.count, JSON.stringify([...batch.messages,...JSON.parse(row?.pending ?? '[]')].slice(-limit)), bindingId,channelId,peerId);
    },
    add({ channelId, peerId, senderId = null, senderName = '', text, messageId = null, at = null }) {
      const body = String(text ?? '').trim();
      if (!body) return null;
      const id = newId('gmsg');
      const when = at ?? now();
      db.run(
        `INSERT INTO group_messages (id,channel_id,peer_id,sender_id,sender_name,text,message_id,at,answered_at,consumed_at)
         VALUES (?,?,?,?,?,?,?,?,NULL,NULL)`,
        id,
        channelId,
        peerId,
        senderId,
        String(senderName ?? '').slice(0, 80),
        body.slice(0, 4000),
        messageId,
        when,
      );
      return { id, channelId, peerId, senderId, senderName, text: body.slice(0, 4000), messageId, at: when };
    },
    window({ channelId, peerId, limit = 60, sinceMs = null }) {
      const rows = db.all(
        `SELECT * FROM group_messages
          WHERE channel_id = ? AND peer_id = ? ${sinceMs ? 'AND at >= ?' : ''}
          ORDER BY at DESC LIMIT ?`,
        ...(sinceMs ? [channelId, peerId, sinceMs, limit] : [channelId, peerId, limit]),
      );
      return rows.reverse().map(mapGroupMessage);
    },
    /**
     * How far into this room the reader has already looked.
     *
     * `lastAt` is the timestamp of the newest message a look actually sent;
     * `lastLookAt` is when that look happened, which is what the attention
     * cooldown reads. Both live in the database so a restart does not make her
     * re-read a room from the beginning.
     */
    cursor(channelId, peerId) {
      const row = db.get(
        'SELECT * FROM group_cursors WHERE channel_id = ? AND peer_id = ?',
        channelId,
        peerId,
      );
      if (!row) return null;
      return { lastAt: asInt(row.last_at, 0), lastLookAt: asInt(row.last_look_at, 0), updatedAt: asInt(row.updated_at, 0) };
    },
    setCursor(channelId, peerId, { lastAt = null, lastLookAt = null } = {}) {
      const at = now();
      db.run(
        `INSERT INTO group_cursors (channel_id, peer_id, last_at, last_look_at, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(channel_id, peer_id) DO UPDATE SET
           last_at = MAX(last_at, excluded.last_at),
           last_look_at = MAX(last_look_at, excluded.last_look_at),
           updated_at = excluded.updated_at`,
        channelId,
        peerId,
        lastAt ?? 0,
        lastLookAt ?? 0,
        at,
      );
      return repo.groupBuffer.cursor(channelId, peerId);
    },
    /** Rows that arrived strictly after `sinceAt`, oldest first, newest when capped. */
    windowAfter({ channelId, peerId, sinceAt = 0, limit = 30 }) {
      // Take the *newest* N, not the oldest N: a look that falls behind must still
      // answer what is being said now, and the older lines it skipped are in the
      // buffer for the memory pass either way.
      const rows = db.all(
        `SELECT * FROM group_messages
          WHERE channel_id = ? AND peer_id = ? AND at > ?
          ORDER BY at DESC LIMIT ?`,
        channelId,
        peerId,
        sinceAt,
        limit,
      );
      return rows.reverse().map(mapGroupMessage);
    },
    /** Oldest-first rows not yet absorbed by a memory pass. */
    pending({ channelId = null, peerId = null, limit = 500 } = {}) {
      const where = ['consumed_at IS NULL'];
      const params = [];
      if (channelId) {
        where.push('channel_id = ?');
        params.push(channelId);
      }
      if (peerId) {
        where.push('peer_id = ?');
        params.push(peerId);
      }
      return db
        .all(`SELECT * FROM group_messages WHERE ${where.join(' AND ')} ORDER BY at ASC LIMIT ?`, ...params, limit)
        .map(mapGroupMessage);
    },
    stats({ channelId = null, peerId = null } = {}) {
      const where = [];
      const params = [];
      if (channelId) {
        where.push('channel_id = ?');
        params.push(channelId);
      }
      if (peerId) {
        where.push('peer_id = ?');
        params.push(peerId);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const row = db.get(
        `SELECT COUNT(*) AS n, MIN(at) AS oldest, MAX(at) AS newest,
                SUM(CASE WHEN consumed_at IS NULL THEN 1 ELSE 0 END) AS pending
           FROM group_messages ${clause}`,
        ...params,
      );
      return {
        count: asInt(row?.n, 0),
        pending: asInt(row?.pending, 0),
        oldestAt: row?.oldest ? asInt(row.oldest) : null,
        newestAt: row?.newest ? asInt(row.newest) : null,
      };
    },
    /** How many messages arrived in the window — the flood signal. */
    countSince(channelId, peerId, sinceMs) {
      const row = db.get(
        'SELECT COUNT(*) AS n FROM group_messages WHERE channel_id = ? AND peer_id = ? AND at >= ?',
        channelId,
        peerId,
        sinceMs,
      );
      return asInt(row?.n, 0);
    },
    /** The last N senders, newest first — the "someone is talking a lot" signal. */
    recentSenders(channelId, peerId, limit = 8) {
      return db
        .all(
          'SELECT sender_id, sender_name FROM group_messages WHERE channel_id = ? AND peer_id = ? ORDER BY at DESC LIMIT ?',
          channelId,
          peerId,
          limit,
        )
        .map((row) => ({ senderId: row.sender_id, senderName: row.sender_name }));
    },
    markAnswered(ids) {
      if (!ids?.length) return 0;
      const at = now();
      let changed = 0;
      db.tx(() => {
        for (const id of ids) {
          changed += db.run('UPDATE group_messages SET answered_at = COALESCE(answered_at, ?) WHERE id = ?', at, id)
            .changes;
        }
      });
      return changed;
    },
    /** Mark every pending row as absorbed; `consumeAll` then deletes them. */
    markConsumed({ channelId = null, peerId = null, before = null } = {}) {
      const where = ['consumed_at IS NULL'];
      const params = [];
      if (channelId) {
        where.push('channel_id = ?');
        params.push(channelId);
      }
      if (peerId) {
        where.push('peer_id = ?');
        params.push(peerId);
      }
      if (before) {
        where.push('at <= ?');
        params.push(before);
      }
      params.push(now());
      return db.run(`UPDATE group_messages SET consumed_at = ? WHERE ${where.join(' AND ')}`, ...params).changes;
    },
    /** Drop everything that memory has already absorbed. */
    consumeAll() {
      return db.run('DELETE FROM group_messages WHERE consumed_at IS NOT NULL').changes;
    },
    /** Keep the buffer bounded even when nothing consumes it. */
    prune({ keepHours = 72, keepPerRoom = 2000 } = {}) {
      const cutoff = now() - keepHours * 3_600_000;
      const byAge = db.run('DELETE FROM group_messages WHERE at < ?', cutoff).changes;
      const byCount = db.run(
        `DELETE FROM group_messages WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid, ROW_NUMBER() OVER (PARTITION BY channel_id, peer_id ORDER BY at DESC) AS rn
               FROM group_messages
           ) WHERE rn > ?
         )`,
        keepPerRoom,
      ).changes;
      return byAge + byCount;
    },
    clear({ channelId = null, peerId = null } = {}) {
      if (!channelId) db.run('DELETE FROM group_glances');
      else if (!peerId) db.run('DELETE FROM group_glances WHERE channel_id=?',channelId);
      else db.run('DELETE FROM group_glances WHERE channel_id=? AND peer_id=?',channelId,peerId);
      if (!channelId) return db.run('DELETE FROM group_messages').changes;
      if (!peerId) return db.run('DELETE FROM group_messages WHERE channel_id = ?', channelId).changes;
      return db.run('DELETE FROM group_messages WHERE channel_id = ? AND peer_id = ?', channelId, peerId).changes;
    },
    rooms() {
      return db
        .all(
          `SELECT channel_id, peer_id, COUNT(*) AS n, MAX(at) AS last_at
             FROM group_messages GROUP BY channel_id, peer_id ORDER BY last_at DESC`,
        )
        .map((row) => ({
          channelId: row.channel_id,
          peerId: row.peer_id,
          count: asInt(row.n, 0),
          lastAt: asInt(row.last_at),
        }));
    },
  };

  // -------------------------------------------------------------- retention
  /**
   * Housekeeping that keeps a long-running install usable.
   *
   * The run log and the channel ledger are diagnostic, not history: keeping a
   * year of them costs disk and slows every page that counts. Archives are not
   * touched here — they are memory material and are deleted only after memory
   * has absorbed them.
   */
  repo.retention = {
    prune({ runDays = 90, eventDays = 30, nowMs = now() } = {}) {
      const runCutoff = nowMs - Math.max(7, runDays) * 86_400_000;
      const eventCutoff = nowMs - Math.max(1, eventDays) * 86_400_000;
      const runs = db.run(
        `DELETE FROM runs
          WHERE finished_at IS NOT NULL AND finished_at < ?
            AND status IN ('succeeded','failed','canceled','interrupted')`,
        runCutoff,
      ).changes;
      const events = db.run('DELETE FROM channel_events WHERE at < ?', eventCutoff).changes;
      // Messages belong to a conversation the user may still open, so they stay.
      return { runs, events };
    },
  };

  // -------------------------------------------------------------- alerts
  repo.alerts = {
    list() {
      return db.all('SELECT * FROM alert_states ORDER BY key').map((row) => ({
        key: row.key,
        status: row.status,
        since: asInt(row.since),
        lastSentAt: row.last_sent_at === null ? null : asInt(row.last_sent_at),
        lastReason: row.last_reason,
        suppressedUntil: row.suppressed_until === null ? null : asInt(row.suppressed_until),
        count: asInt(row.count),
      }));
    },
    get(key) {
      const row = db.get('SELECT * FROM alert_states WHERE key = ?', key);
      if (!row) return null;
      return {
        key: row.key,
        status: row.status,
        since: asInt(row.since),
        lastSentAt: row.last_sent_at === null ? null : asInt(row.last_sent_at),
        lastReason: row.last_reason,
        suppressedUntil: row.suppressed_until === null ? null : asInt(row.suppressed_until),
        count: asInt(row.count),
      };
    },
    upsert(key, patch) {      const current = repo.alerts.get(key) ?? {
        key,
        status: 'ok',
        since: now(),
        lastSentAt: null,
        lastReason: null,
        suppressedUntil: null,
        count: 0,
      };
      const next = { ...current, ...patch };
      db.run(
        `INSERT INTO alert_states (key,status,since,last_sent_at,last_reason,suppressed_until,count) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET status=excluded.status, since=excluded.since, last_sent_at=excluded.last_sent_at,
           last_reason=excluded.last_reason, suppressed_until=excluded.suppressed_until, count=excluded.count`,
        key,
        next.status,
        next.since,
        next.lastSentAt ?? null,
        next.lastReason ?? null,
        next.suppressedUntil ?? null,
        asInt(next.count, 0),
      );
      return repo.alerts.get(key);
    },
  };

  // --------------------------------------------------------------- audit
  repo.audit = {
    log(action, target, detail = {}, actor = 'user') {
      db.run(
        'INSERT INTO audit (id, at, actor, action, target, detail) VALUES (?,?,?,?,?,?)',
        newId('aud'),
        now(),
        actor,
        action,
        String(target ?? ''),
        stringifyJson(detail),
      );
    },
    list(limit = 100) {
      return db.all('SELECT * FROM audit ORDER BY at DESC LIMIT ?', limit).map((row) => ({
        id: row.id,
        at: asInt(row.at),
        actor: row.actor,
        action: row.action,
        target: row.target,
        detail: parseJson(row.detail, {}) ?? {},
      }));
    },
  };

  // ------------------------------------------------------ long-term memory
  //
  // The blocks above are the short working set. This is the durable half: one
  // row per atomic statement, deduplicated on write, never rewritten wholesale.
  repo.memories = {
    create({ kind = 'fact', subject = '', text, tags = [], weight = 1, source = 'maintenance', sourceArchiveId = null, at = null, meta = {} }) {
      const id = newId('m');
      const stamp = asInt(at, now());
      db.run(
        `INSERT INTO memories (id,kind,subject,text,tags,weight,hits,status,first_seen_at,last_seen_at,
          source,source_archive_id,merged_into,meta)
         VALUES (?,?,?,?,?,?,1,'active',?,?,?,?,NULL,?)`,
        id,
        enumValue(kind, MEMORY_KINDS, 'kind', 'fact'),
        optionalString(subject, 'subject', 120),
        requireString(text, 'text', { max: 1000, allowEmpty: false }),
        stringifyJson(Array.isArray(tags) ? tags.slice(0, 12).map((t) => String(t).slice(0, 40)) : []),
        Number.isFinite(Number(weight)) ? Number(weight) : 1,
        stamp,
        stamp,
        optionalString(source, 'source', 40) || 'maintenance',
        sourceArchiveId,
        stringifyJson(meta ?? {}),
      );
      return repo.memories.byId(id);
    },
    byId(id) {
      return mapMemory(db.get('SELECT * FROM memories WHERE id = ?', id));
    },
    list({ status = 'active', kind = null, subject = null, search = '', limit = 200, offset = 0, order = 'recent' } = {}) {
      const where = [];
      const params = [];
      if (status) {
        where.push('status = ?');
        params.push(status);
      }
      if (kind) {
        where.push('kind = ?');
        params.push(kind);
      }
      if (subject) {
        where.push('subject = ?');
        params.push(subject);
      }
      if (search) {
        where.push('(text LIKE ? OR subject LIKE ? OR tags LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      const orderBy =
        order === 'hits'
          ? 'hits DESC, last_seen_at DESC'
          : order === 'oldest'
            ? 'first_seen_at ASC'
            : 'last_seen_at DESC';
      const sql = `SELECT * FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
      return db.all(sql, ...params, Math.max(1, Math.min(2000, asInt(limit, 200))), Math.max(0, asInt(offset, 0))).map(mapMemory);
    },
    /** Same filters as `list`, but only the count — used by the graph caption. */
    count({ status = 'active', kind = null, search = '' } = {}) {
      const where = [];
      const params = [];
      if (status) {
        where.push('status = ?');
        params.push(status);
      }
      if (kind) {
        where.push('kind = ?');
        params.push(kind);
      }
      if (search) {
        where.push('(text LIKE ? OR subject LIKE ? OR tags LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      const row = db.get(`SELECT COUNT(*) AS n FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, ...params);
      return asInt(row?.n, 0);
    },
    /**
     * Candidate pool for retrieval.
     *
     * Not the console's paginated list: this is the "recent N" window the
     * scoring pass reads on every turn. It used to be 2,000 and silently hid
     * older facts from the model; the size is now a setting (default 20k).
     */
    searchCandidates({ limit = 20000 } = {}) {
      const rows = db.all(
        'SELECT * FROM memories WHERE status = ? ORDER BY last_seen_at DESC LIMIT ?',
        'active',
        Math.max(1, Math.min(50000, asInt(limit, 20000))),
      );
      return rows.map(mapMemory);
    },
    /** Dedupe support: the recent window a new candidate is compared against. */
    dedupeCandidates({ kind, subject, limit = 400 } = {}) {
      const rows = db.all(
        `SELECT * FROM memories WHERE status = 'active' AND kind = ? ORDER BY last_seen_at DESC LIMIT ?`,
        kind,
        Math.max(1, Math.min(2000, limit)),
      );
      return rows.map(mapMemory);
    },
    bump(id, { at = null, weight = null, hits = 1, text = null } = {}) {
      const current = repo.memories.byId(id);
      if (!current) return null;
      db.run(
        'UPDATE memories SET hits = hits + ?, last_seen_at = ?, weight = ?, text = ? WHERE id = ?',
        Math.max(1, asInt(hits, 1)),
        asInt(at, now()),
        weight === null ? current.weight : Number(weight),
        text === null ? current.text : String(text),
        id,
      );
      return repo.memories.byId(id);
    },
    setStatus(id, status) {
      db.run('UPDATE memories SET status = ? WHERE id = ?', enumValue(status, MEMORY_STATUSES, 'status', 'active'), id);
      return repo.memories.byId(id);
    },
    edgesFor(ids) {
      if (!ids.length) return [];
      const marks = ids.map(() => '?').join(',');
      return db
        .all(`SELECT * FROM memory_edges WHERE a_id IN (${marks}) OR b_id IN (${marks})`, ...ids, ...ids)
        .map((row) => ({ a: row.a_id, b: row.b_id, kind: row.kind, weight: Number(row.weight), updatedAt: asInt(row.updated_at) }));
    },
    link(a, b, { kind = 'co-occur', weight = 1, at = null } = {}) {
      if (!a || !b || a === b) return;
      const [left, right] = a < b ? [a, b] : [b, a];
      db.run(
        `INSERT INTO memory_edges (a_id,b_id,kind,weight,updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(a_id,b_id,kind) DO UPDATE SET weight = weight + excluded.weight, updated_at = excluded.updated_at`,
        left,
        right,
        kind,
        Number(weight) || 1,
        asInt(at, now()),
      );
    },
    /** Stats for the console: counts, kind mix, subject mix, daily formation. */
    stats({ days = 120 } = {}) {
      const totals = db.get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(hits) AS hits,
                MIN(first_seen_at) AS oldest,
                MAX(last_seen_at) AS newest
         FROM memories`,
      );
      const kinds = db.all(
        `SELECT kind, COUNT(*) AS n, SUM(hits) AS hits FROM memories WHERE status = 'active' GROUP BY kind ORDER BY n DESC`,
      );
      const subjects = db.all(
        `SELECT subject, COUNT(*) AS n FROM memories WHERE status = 'active' AND subject <> '' GROUP BY subject ORDER BY n DESC LIMIT 40`,
      );
      const subjectTotal = asInt(
        db.get("SELECT COUNT(DISTINCT subject) AS n FROM memories WHERE status = 'active' AND subject <> ''")?.n,
        0,
      );
      const byDay = db.all(
        `SELECT strftime('%Y-%m-%d', first_seen_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
         FROM memories WHERE status = 'active' GROUP BY day ORDER BY day DESC LIMIT ?`,
        Math.max(1, Math.min(3650, asInt(days, 120))),
      );
      const recent = db.all(`SELECT * FROM memories WHERE status = 'active' ORDER BY first_seen_at DESC LIMIT 8`).map(mapMemory);
      return {
        total: asInt(totals?.total, 0),
        active: asInt(totals?.active, 0),
        hits: asInt(totals?.hits, 0),
        oldest: totals?.oldest ? asInt(totals.oldest) : null,
        newest: totals?.newest ? asInt(totals.newest) : null,
        kinds: kinds.map((row) => ({ kind: row.kind, count: asInt(row.n, 0), hits: asInt(row.hits, 0) })),
        subjects: subjects.map((row) => ({ subject: row.subject, count: asInt(row.n, 0) })),
        // The list above is capped at 40; the page must not call that "all subjects".
        subjectCount: subjectTotal,
        byDay: byDay.map((row) => ({ day: row.day, count: asInt(row.n, 0) })).reverse(),
        recent,
      };
    },
    recordRetrieval({ query = '', conversationId = null, runId = null, memoryIds = [], meta = {} }) {
      db.run(
        'INSERT INTO memory_retrievals (id,at,query,conversation_id,run_id,memory_ids,meta) VALUES (?,?,?,?,?,?,?)',
        newId('mret'),
        now(),
        String(query ?? '').slice(0, 500),
        conversationId,
        runId,
        stringifyJson(memoryIds),
        stringifyJson(meta ?? {}),
      );
    },
    retrievals(limit = 30) {
      return db.all('SELECT * FROM memory_retrievals ORDER BY at DESC LIMIT ?', Math.max(1, Math.min(500, limit))).map((row) => ({
        id: row.id,
        at: asInt(row.at),
        query: row.query,
        conversationId: row.conversation_id ?? null,
        runId: row.run_id ?? null,
        memoryIds: parseJson(row.memory_ids, []) ?? [],
        meta: parseJson(row.meta, {}) ?? {},
      }));
    },
  };

  repo.constants = deepFreeze({
    TASK_KINDS,
    CONV_MODES,
    RUN_STATUSES,
    TRIGGER_TYPES,
    MEMORY_CATEGORIES,
    MEMORY_KINDS,
    MEMORY_STATUSES,
    TOOL_MODES,
    ARCHIVE_MODES,
    HISTORY_MODES,
  });

  // ------------------------------------------------------ memory documents
  //
  // Long text an agent wrote about itself or its world: diary, self-portrait,
  // glossary. Unlike a memory row it is hand-edited and opened one at a time;
  // unlike a block it is not injected into every prompt.
  repo.documents = {
    list({ category = null, search = '' } = {}) {
      const where = [];
      const params = [];
      if (category) {
        where.push('category = ?');
        params.push(category);
      }
      if (search) {
        where.push('(title LIKE ? OR content LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      const sql = `SELECT id,slug,title,category,chars,source,order_index,created_at,updated_at
                   FROM memory_documents ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY category ASC, order_index DESC, updated_at DESC`;
      return db.all(sql, ...params).map(mapDocument);
    },
    get(slug) {
      return mapDocument(db.get('SELECT * FROM memory_documents WHERE slug = ?', slug));
    },
    /** Create, or refresh metadata of an existing document. */
    upsert({ slug, title, category = 'note', content = '', source = '', orderIndex = 0, overwriteContent = false }) {
      const cleanSlug = requireString(slug, 'slug', { max: 120, allowEmpty: false });
      const existing = repo.documents.get(cleanSlug);
      const at = now();
      const body = String(content ?? '');
      if (!existing) {
        db.run(
          `INSERT INTO memory_documents (id,slug,title,category,content,chars,source,order_index,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          newId('doc'),
          cleanSlug,
          requireString(title, 'title', { max: 200, allowEmpty: false }),
          requireString(category, 'category', {max:120,allowEmpty:false}),
          body,
          body.length,
          optionalString(source, 'source', 400),
          asInt(orderIndex, 0),
          at,
          at,
        );
        return { ...repo.documents.get(cleanSlug), created: true };
      }
      db.run(
        `UPDATE memory_documents SET title=?, category=?, source=?, order_index=?, content=?, chars=?, updated_at=?
         WHERE slug=?`,
        requireString(title ?? existing.title, 'title', { max: 200, allowEmpty: false }),
        requireString(category ?? existing.category, 'category', {max:120,allowEmpty:false}),
        optionalString(source ?? existing.source, 'source', 400),
        asInt(orderIndex, existing.orderIndex),
        overwriteContent ? body : existing.content,
        overwriteContent ? body.length : existing.chars,
        overwriteContent ? at : existing.updatedAt,
        cleanSlug,
      );
      return { ...repo.documents.get(cleanSlug), created: false };
    },
    update(slug, { title, category, content } = {}) {
      const existing = repo.documents.get(slug);
      if (!existing) throw new RepoError('document not found', 'NOT_FOUND', 404);
      const body = content === undefined ? existing.content : String(content ?? '');
      db.run(
        `UPDATE memory_documents SET title=?, category=?, content=?, chars=?, updated_at=? WHERE slug=?`,
        requireString(title ?? existing.title, 'title', { max: 200, allowEmpty: false }),
        requireString(category ?? existing.category, 'category', {max:120,allowEmpty:false}),
        body,
        body.length,
        now(),
        slug,
      );
      return repo.documents.get(slug);
    },
    remove(slug) {
      return db.run('DELETE FROM memory_documents WHERE slug = ?', slug).changes > 0;
    },
    /** Per-category counts and total characters, for the page header. */
    stats() {
      const rows = db.all(
        'SELECT category, COUNT(*) AS n, SUM(chars) AS chars FROM memory_documents GROUP BY category ORDER BY category',
      );
      const totals = db.get('SELECT COUNT(*) AS n, SUM(chars) AS chars FROM memory_documents');
      return {
        total: asInt(totals?.n, 0),
        chars: asInt(totals?.chars, 0),
        categories: rows.map((row) => ({ category: row.category, count: asInt(row.n, 0), chars: asInt(row.chars, 0) })),
      };
    },
  };

  // Synchronous DB transactions are the shared commit boundary. Model work stays
  // outside it; its revision is checked again inside BEGIN IMMEDIATE.
  repo.memory.revision = () => createHash('sha256').update(JSON.stringify({
    blocks: repo.memory.blocks(), style: repo.style.current(), version: repo.memory.latestVersion()?.id,
  })).digest('hex');
  repo.memory.assertRevision = (revision) => {
    if (revision != null && revision !== repo.memory.revision()) {
      throw new RepoError('memory changed while work was in progress', 'MEMORY_CONFLICT', 409);
    }
  };
  const pendingTargets = () => parseJson(db.getMeta('memory.projectionTargets', '{}'), {}) ?? {};
  repo.memory.projectionState = () => ({ pending: db.getMeta('memory.projectionPending', '0') === '1', revision: repo.memory.revision(), error: db.getMeta('memory.projectionError', ''), targets: pendingTargets() });
  let projectMemory = null;
  let inspectFiles = null;
  let projectionDepth = 0;
  repo.memory.configureProjection = (project, inspect = null) => { projectMemory = project; if (inspect) inspectFiles = inspect; };
  repo.memory.deferProjection = (fn) => {
    projectionDepth += 1;
    try { return fn(); }
    finally { projectionDepth -= 1; if (!projectionDepth && repo.memory.projectionState().pending) repo.memory.repairProjection(); }
  };
  repo.memory.repairProjection = () => {
    if (projectionDepth || db.raw.isTransaction) return repo.memory.projectionState();
    try {
      const targets = pendingTargets();
      if (Object.keys(targets).length) projectMemory?.(targets);
      if (projectMemory) { db.setMeta('memory.projectionTargets', '{}'); db.setMeta('memory.projectionPending', '0'); db.setMeta('memory.projectionError', ''); }
    } catch (error) {
      db.setMeta('memory.projectionPending', '1'); db.setMeta('memory.projectionError', error.message);
      log?.warn('memory committed; file projection requires repair: ' + error.message);
    }
    return repo.memory.projectionState();
  };
  for (const name of ['createBlock', 'updateBlock', 'deleteBlock', 'reorder', 'publish']) {
    const original = repo.memory[name];
    repo.memory[name] = (...args) => {
      const slugs = name === 'publish' ? args[0].blocks.map((block) => block.slug) : name === 'reorder' ? [] : [name === 'createBlock' ? String(args[0].slug).trim().toLowerCase() : args[0]];
      const basis = inspectFiles?.(slugs) ?? {};
      const register = () => {
        const targets = pendingTargets();
        for (const slug of slugs) targets[slug] = { fileHash: targets[slug] ? targets[slug].fileHash : basis[slug] ?? null, deleted: name === 'deleteBlock' };
        db.setMeta('memory.projectionTargets', stringifyJson(targets));
        db.setMeta('memory.projectionPending', Object.keys(targets).length ? '1' : '0');
      };
      let result;
      const commit = () => {
        if (name === 'updateBlock') repo.memory.assertRevision(args[1]?.expectedRevision);
        repo.memory.registerProjection = register;
        try { result = original(...args); register(); }
        finally { repo.memory.registerProjection = null; }
      };
      // publish/reorder already own BEGIN IMMEDIATE; callers in an outer DB
      // transaction defer all file work until that transaction has committed.
      if (name === 'publish' || name === 'reorder' || db.raw.isTransaction) commit();
      else db.tx(commit);
      if (!db.raw.isTransaction) repo.memory.repairProjection();
      return result;
    };
  }

  return repo;
}

// Small date helpers kept here so the repo has no import cycle with the scheduler.
function startOfZonedDay(day, timezone) {
  const [y, m, d] = String(day).split('-').map(Number);
  return zonedToInstant({ year: y, month: m, day: d }, timezone);
}

function addOneDay(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}
