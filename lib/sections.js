import { id } from './util.js';

/**
 * The injectable context sections.
 *
 * Before this module the prompt had a fixed shape: core, rules, memory,
 * retrieval — four hard-coded pushes in `context-compiler.js`. The console could
 * edit the text but not the *organization*, and anyone whose way of writing a
 * persona differed from ours had to live inside our four boxes. This registry is
 * the answer: an ordered list the person owns.
 *
 * Each entry says what it is (`kind`), what it is called (`title`), what heading
 * (if any) goes into the prompt, where it sits (`order`), which channel it is
 * delivered through, how often it is re-read (`scope`), and whether it is on at
 * all. Built-in kinds read their text from the place that already owns it
 * (`prompt.core`, `prompt.rules`, memory blocks, retrieval); a custom section
 * carries its own `body`.
 *
 * Channels are the part people actually feel:
 *
 *   - `system`  — the section becomes part of the system prompt (the front of
 *                 the request, where identity lives). Frozen per session unless
 *                 `scope: 'turn'`.
 *   - `history` — the section is delivered as *material in the user turn*
 *                 instead: once at the start of a session (`scope: 'session'`)
 *                 or on every message (`scope: 'turn'`). Nothing here ever
 *                 reaches the system prompt.
 *
 * The rendered section *name* is a stable technical id (`yu:rules`,
 * `yu:custom:<id>`) because that name is what a conversation frame freezes and
 * what a context profile lists in `turnSections`. Titles are for people and for
 * the heading line; renaming a section must never change its identity.
 */

/** Where a section is delivered. */
export const CHANNELS = ['system', 'history'];

/**
 * The order band the system channel occupies.
 *
 * DSH's own sections use -1000 (harness identity), 0 (deployment persona), 500
 * (plan policy), 600 (team policy), 800 (PTC only), 900 (file reference) and
 * 1000+ (tool documentation). Keeping Yu between 1 and 499 puts it directly
 * after the deployment persona and before every policy/tool section, which is
 * where a companion's own text belongs — and guarantees no exact order collision
 * with a reserved slot.
 */
export const SYSTEM_BAND = { min: 1, max: 499 };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Map a visible order (0–1000) onto the system band.
 *
 * The mapping is injective and lands on integers only at the two ends, so two
 * Yu sections can never tie with each other or with a reserved DSH order.
 */
export function wireOrder(order) {
  const value = Number(order);
  const normalized = Number.isFinite(value) ? clamp(value, 0, 1000) : 0;
  return SYSTEM_BAND.min + (normalized / 1000) * (SYSTEM_BAND.max - SYSTEM_BAND.min);
}

/** Default channel for a section kind, used when stored data predates channels. */
export function defaultChannel(kind) {
  return kind === 'memory' || kind === 'retrieved' ? 'history' : 'system';
}

/** Default refresh scope for a section kind. */
export function defaultScope(kind) {
  return kind === 'retrieved' ? 'turn' : 'session';
}

/** Human wording used by the API and the console. */
export const CHANNEL_LABELS = {
  system: '系统提示词',
  history: '用户消息里的材料',
};

export const BUILTIN_SECTIONS = [
  {
    id: 'core',
    kind: 'core',
    title: '核心',
    heading: '',
    order: 100,
    enabled: true,
    channel: 'system',
    scope: 'session',
  },
  {
    id: 'rules',
    kind: 'rules',
    title: '角色卡',
    heading: '角色卡（你可以自己改）',
    order: 110,
    enabled: true,
    channel: 'system',
    scope: 'session',
  },
  {
    id: 'memory',
    kind: 'memory',
    title: '短期记忆',
    heading: '短期记忆',
    order: 500,
    enabled: true,
    channel: 'history',
    scope: 'session',
  },
  {
    id: 'retrieved',
    kind: 'retrieved',
    title: '长期检索',
    heading: '长期记忆（数据库检索，可能过时）',
    order: 700,
    enabled: true,
    channel: 'history',
    scope: 'turn',
  },
];

const BUILTIN_KINDS = new Map(BUILTIN_SECTIONS.map((section) => [section.id, section.kind]));
const CUSTOM_ID = /^sec_[a-z0-9_]{3,160}$/;
const MAX_BODY = 400_000;

export function defaultSections() {
  return BUILTIN_SECTIONS.filter(section=>['core','memory','retrieved'].includes(section.id)).map((section) => ({ ...section,title:section.id==='core'?'核心记忆':section.id==='retrieved'?'长期记忆':section.title }));
}

/** The technical name a frozen frame and a profile's `turnSections` use. */
export function sectionName(section) {
  if (!section) return '';
  if (section.kind === 'custom') return `yu:custom:${section.id}`;
  return `yu:${section.id}`;
}

export function sectionKindOf(idOrName) {
  const text = String(idOrName ?? '');
  if (text.startsWith('yu:custom:')) return 'custom';
  if (text.startsWith('yu:')) return BUILTIN_KINDS.get(text.slice(3)) ?? null;
  return null;
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').slice(0, max);
}

/**
 * Turn whatever is stored (or posted) into a usable list.
 *
 * Invalid entries are dropped with a reason instead of throwing: a hand-edited
 * config should be able to say "this one line is wrong" without losing the rest
 * of the document. The API still refuses to *save* anything that produced a
 * problem, so the file never becomes the only copy of a broken section.
 */
export function normalizeSections(input) {
  const problems = [];
  if (!Array.isArray(input)) {
    return { sections: defaultSections(), problems: ['sections 必须是一个数组'] };
  }
  const out = [];
  const seen = new Set();
  input.forEach((raw, index) => {
    const where = `第 ${index + 1} 段`;
    if (!raw || typeof raw !== 'object') {
      problems.push(`${where}不是对象`);
      return;
    }
    const builtin = BUILTIN_SECTIONS.find((section) => section.id === String(raw.id ?? ''));
    const builtinKind = builtin?.kind;
    const kind = builtinKind ?? 'custom';
    let sectionId = String(raw.id ?? '').trim();
    if (kind === 'custom') {
      if (!sectionId) sectionId = id('sec').replace(/[^a-z0-9_]/g, '').slice(0, 40);
      if (!CUSTOM_ID.test(sectionId)) {
        problems.push(`${where}的自定义 id 只能是小写字母、数字与下划线，且以 sec_ 开头（${sectionId}）`);
        return;
      }
    }
    if (seen.has(sectionId)) {
      problems.push(`${where}的 id 重复（${sectionId}）`);
      return;
    }
    const title =
      cleanText(raw.title ?? raw.name ?? '', 60).trim() ||
      (kind === 'custom' ? '未命名段落' : builtin?.title ?? sectionId);
    const heading =
      raw.heading === undefined
        ? kind === 'custom'
          ? title
          : builtin?.heading ?? ''
        : cleanText(raw.heading, 120).trim();
    const order = Number(raw.order);
    const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);
    // A stored entry without `channel` predates channels. Its scope came from the
    // old two-way switch, but the old defaults were wrong for the new model: a
    // frozen retrieval meant every message of a session searched with the first
    // sentence. Migrating applies the new defaults once; after that the value is
    // explicit and respected.
    const legacy = raw.channel === undefined;
    const channel = legacy ? defaultChannel(kind) : String(raw.channel);
    if (!CHANNELS.includes(channel)) {
      problems.push(`${where}的 channel 只能是 system 或 history（${channel}）`);
      return;
    }
    const scope =
      raw.scope === 'turn' ? 'turn' : legacy && kind === 'retrieved' ? 'turn' : 'session';
    if (!Number.isFinite(order) || order < 0 || order > 1000) {
      problems.push(`${where}的 order 必须是 0 到 1000 之间的数字`);
      return;
    }
    const body = kind === 'custom' ? cleanText(raw.body ?? '', MAX_BODY) : '';
    let source;
    if(raw.source !== undefined) {
      if(!raw.source || typeof raw.source.path !== 'string' || !raw.source.path.trim() || (raw.source.format && raw.source.format !== 'utf8')) {
        problems.push(`${where}的 source 需要文件 path，format 只支持 utf8`); return;
      }
      source = {path:raw.source.path.trim(),format:'utf8'};
    }
    const maxChars = raw.maxChars === undefined ? 14000 : Number(raw.maxChars);
    if(!Number.isInteger(maxChars) || maxChars < 0 || maxChars > 400000) { problems.push(`${where}的 maxChars 须为0至400000整数`); return; }
    seen.add(sectionId);
    out.push({
      id: sectionId,
      kind,
      title,
      heading,
      order: Math.round(order),
      enabled,
      channel,
      scope,
      ...(kind === 'custom' && !source ? { body } : {}),
      ...(source ? {source,maxChars,template:cleanText(raw.template ?? '{{content}}',2000)} : {}),
      ...(raw.legacyMemorySlug ? {legacyMemorySlug:String(raw.legacyMemorySlug)} : {}),
    });
  });
  out.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh'));
  return { sections: out, problems };
}

/** Read the registry from settings; a damaged value falls back to the defaults. */
export function readSections(settings) {
  let raw;
  try {
    raw = JSON.parse(settings.get('prompt.sections') || '[]');
  } catch {
    return { sections: defaultSections(), problems: ['prompt.sections 不是合法 JSON，已按默认三段处理'] };
  }
  if (!Array.isArray(raw)) {
    return { sections: defaultSections(), problems: ['prompt.sections 不是数组，已按默认三段处理'] };
  }
  const normalized = normalizeSections(raw);
  return { sections: normalized.sections, problems: normalized.problems };
}

export function serializeSections(sections) {
  const { sections: clean, problems } = normalizeSections(sections);
  if (problems.length) {
    const error = new Error(`注入段配置有问题：${problems.join('；')}`);
    error.code = 'SECTIONS_INVALID';
    error.status = 400;
    throw error;
  }
  return JSON.stringify(clean);
}

/** The choices a context profile can move to the per-turn lane. */
export function turnSectionChoices(settings) {
  const { sections } = readSections(settings);
  return sections
    .filter((section) => section.enabled)
    .map((section) => ({
      name: sectionName(section),
      title: section.title,
      kind: section.kind,
      channel: section.channel,
      channelLabel: CHANNEL_LABELS[section.channel] ?? section.channel,
      scope: section.scope,
    }));
}

/** Names the registry itself marks as per-turn (added to a profile's own list). */
export function registryTurnNames(settings) {
  const { sections } = readSections(settings);
  return sections.filter((section) => section.enabled && section.scope === 'turn').map(sectionName);
}
