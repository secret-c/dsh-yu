import { now } from './util.js';
import { similarity } from './memory-rules.js';

/**
 * Long-term memory.
 *
 * Two layers, deliberately different shapes:
 *
 *   短期记忆  memory_blocks — five short texts, injected into every prompt, and
 *             rewritten as a whole on each maintenance pass. Cheap to read,
 *             expensive to keep precise.
 *   长期记忆  memories — one row per atomic statement, append-or-merge, never
 *             rewritten. This is what a year of running accumulates, what the
 *             console draws, and what retrieval searches instead of raw archives.
 *
 * The model may only *propose* items; the merge rules (similarity threshold,
 * process-text rejection, length caps) decide what enters the database, and the
 * same proposal twice must not create two rows.
 */

export const MEMORY_KINDS = ['fact', 'person', 'event', 'preference', 'plan'];

export const KIND_LABELS = {
  fact: '事实',
  person: '人物',
  event: '事件',
  preference: '偏好',
  plan: '计划',
};

const KIND_SET = new Set(MEMORY_KINDS);

/**
 * Text that describes the machinery rather than the world. It is rejected here
 * as well as in the block rules, because a database row is permanent: letting
 * "本轮没有新输入" in once makes it show up in the graph forever.
 */
const PROCESS_PATTERNS = [
  /本轮|上一轮|这轮|下一次运行|运行轮次/,
  /\b(?:arc|run|conv|msg|mret)_[a-z0-9]+/i,
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
  /^(?:回复|输出|输入|结果)[:：]/,
  // Imported transcripts arrived wrapped as `用户：…` with the whole prompt
  // boilerplate attached. That is a log line, not a fact about the world.
  /^用户[:：]/,
  /Current runtime context|snapshot supersedes|runtime-context snapshots/i,
];

export function looksLikeProcess(text) {
  return PROCESS_PATTERNS.some((pattern) => pattern.test(String(text ?? '')));
}

/** Same red lines as the block validator: a phone number or address never enters. */
const SENSITIVE = /(?:1[3-9]\d{9})|(?:\d{17}[\dXx])|(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(?:\d{6,})/;

export function normalizeMemoryText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s，。、；：！？"'“”‘’（）()\[\]【】…—－\-·,.;:!?]+/g, '')
    .trim();
}

/** Terms for retrieval: latin words plus CJK bigrams (whole-run match is too strict). */
export function tokenize(text) {
  const raw = String(text ?? '').toLowerCase();
  const terms = new Set();
  for (const piece of raw.split(/[\s,，。、;；:：!！?？"“”'‘’()（）\[\]【】<>《》/\\|+*#@~`]+/)) {
    const token = piece.trim();
    if (!token) continue;
    if (/^[a-z0-9_.-]+$/i.test(token)) {
      if (token.length >= 2) terms.add(token);
      continue;
    }
    if (token.length >= 2 && /^[\u4e00-\u9fa5]+$/.test(token)) {
      if (token.length <= 3) terms.add(token);
      for (let i = 0; i + 2 <= token.length; i += 1) terms.add(token.slice(i, i + 2));
    } else if (token.length >= 2) {
      terms.add(token.slice(0, 24));
    }
  }
  return [...terms].slice(0, 24);
}

/**
 * Score long-term memories against a query. Deterministic and inspectable: term
 * hits, consolidation (`hits`), and recency — no embeddings, no hidden index, so
 * the console can show exactly why a row was retrieved.
 */
export function searchMemories(repo, { query, limit = 6, kinds = null, searchPool = 20000 } = {}) {
  const max = Math.max(0, Math.min(30, Number(limit) || 0));
  if (!max) return [];
  const terms = tokenize(query);
  if (!terms.length) return [];
  const pool = Math.max(100, Math.min(50000, Number(searchPool) || 20000));
  const rows = repo.memories.searchCandidates({ limit: pool });
  const scored = [];
  for (const row of rows) {
    if (kinds && !kinds.includes(row.kind)) continue;
    const hay = `${row.subject}\n${row.text}\n${row.tags.join(' ')}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (hay.includes(term)) score += term.length >= 3 ? 2 : 1;
    }
    if (!score) continue;
    const ageDays = Math.max(0, (now() - row.lastSeenAt) / 86_400_000);
    score += Math.min(3, row.hits * 0.3) + Math.max(0, 2 - ageDays / 30);
    scored.push({ ...row, score: Number(score.toFixed(2)) });
  }
  return scored.sort((a, b) => b.score - a.score || b.lastSeenAt - a.lastSeenAt).slice(0, max);
}

/**
 * Split one short-term block into candidate long-term statements.
 *
 * A block is prose written for a prompt; the database wants one statement per
 * row. So: lines first, then sentences, with fragments glued back onto their
 * neighbour rather than becoming a row of their own. The size limits match what
 * `merge()` enforces, so an import cannot smuggle in a paragraph.
 */
export function splitBlockIntoMemories(content, { maxChars = 240, minChars = 8 } = {}) {
  const out = [];
  const push = (text) => {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    if (clean.length < minChars) {
      // A tail fragment like "我推测。" belongs to the sentence before it.
      if (out.length) out[out.length - 1] = `${out[out.length - 1]}${clean}`.slice(0, maxChars);
      return;
    }
    if (clean.length <= maxChars) {
      out.push(clean);
      return;
    }
    let buffer = '';
    for (const piece of clean.split(/(?<=[，。；！？!?;,])/)) {
      if (buffer && buffer.length + piece.length > maxChars) {
        out.push(buffer.trim());
        buffer = '';
      }
      buffer += piece;
    }
    if (buffer.trim()) out.push(buffer.trim().slice(0, maxChars));
  };

  for (const raw of String(content ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•·]|\d+[.)、])\s*/, '').trim();
    if (!line) continue;
    if (/^#+\s/.test(line)) continue;
    if (line.length <= 60) {
      push(line);
      continue;
    }
    for (const sentence of line.split(/(?<=[。；！？!?;])/)) {
      push(sentence);
    }
  }
  return out.filter((item) => !looksLikeProcess(item) && !SENSITIVE.test(item));
}

export function createMemoryStore({ repo, settings, log }) {
  const threshold = () => {
    const value = Number(settings.get('memory.db.mergeThreshold'));
    return Number.isFinite(value) ? Math.min(0.99, Math.max(0.5, value)) : 0.82;
  };

  /**
   * Merge one maintenance pass' proposals into the database.
   *
   * @returns {{created:number, merged:number, rejected:number, ids:string[], problems:string[]}}
   */
  const merge = (candidates, { archiveId = null, at = null, source = 'maintenance' } = {}) => {
    if(source==='maintenance' && repo.memoryLibraries && !repo.memoryLibraries.canAutoWrite()) return {created:0,merged:0,rejected:0,ids:[],problems:['长期库已关闭自动积累']};
    const stamp = at ?? now();
    const result = { created: 0, merged: 0, rejected: 0, ids: [], problems: [] };
    const pool = new Map();
    const list = Array.isArray(candidates) ? candidates : [];
    for (const proposal of list) {
      const kind = KIND_SET.has(String(proposal?.kind ?? '')) ? String(proposal.kind) : 'fact';
      const text = String(proposal?.text ?? '').trim().replace(/\s+/g, ' ');
      if (!text) {
        result.rejected += 1;
        result.problems.push('空条目已丢弃');
        continue;
      }
      if (text.length < 6) {
        result.rejected += 1;
        result.problems.push(`「${text}」太短，不足以成为一条记忆`);
        continue;
      }
      if (text.length > 400) {
        result.rejected += 1;
        result.problems.push(`「${text.slice(0, 20)}…」过长（>400 字），请拆成多条`);
        continue;
      }
      if (looksLikeProcess(text)) {
        result.rejected += 1;
        result.problems.push(`「${text.slice(0, 20)}…」是过程叙述，不入库`);
        continue;
      }
      if (SENSITIVE.test(text)) {
        result.rejected += 1;
        result.problems.push(`「${text.slice(0, 20)}…」含疑似联系方式/编号，不入库`);
        continue;
      }
      const subject = String(proposal?.subject ?? '')
        .trim()
        .replace(/[。，、；：\s]+$/, '')
        .slice(0, 40);
      const tags = Array.isArray(proposal?.tags)
        ? proposal.tags.map((tag) => String(tag).trim().slice(0, 20)).filter(Boolean).slice(0, 6)
        : [];
      if (!pool.has(kind)) pool.set(kind, repo.memories.dedupeCandidates({ kind }));
      const known = pool.get(kind);
      const needle = normalizeMemoryText(text);
      let best = null;
      let bestScore = 0;
      for (const row of known) {
        const score = similarity(needle, normalizeMemoryText(row.text));
        if (score > bestScore) {
          bestScore = score;
          best = row;
        }
      }
      if (best && bestScore >= threshold()) {
        repo.memories.bump(best.id, { at: stamp, weight: Math.min(4, best.weight + 0.15) });
        result.merged += 1;
        result.ids.push(best.id);
        continue;
      }
      const row = repo.memories.create({
        kind,
        subject,
        text,
        tags,
        weight: 1,
        source,
        sourceArchiveId: archiveId,
        at: stamp,
      });
      known.unshift(row);
      if (known.length > 800) known.pop();
      result.created += 1;
      result.ids.push(row.id);
    }
    // Co-occurrence: statements learned from the same material are related. This
    // is the only edge kind Yu creates on its own, so the graph is never a guess.
    for (let i = 0; i < result.ids.length; i += 1) {
      for (let j = i + 1; j < result.ids.length; j += 1) {
        repo.memories.link(result.ids[i], result.ids[j], { at: stamp });
      }
    }
    if (result.created || result.merged) {
      log?.info(`long-term memory: +${result.created} new, ${result.merged} merged, ${result.rejected} rejected`);
    }
    return result;
  };

  const graph = ({ limit = 240, search = '', kind = null } = {}) => {
    const filter = { search: String(search ?? '').trim(), kind: kind || null };
    const nodes = repo.memories.list({ limit, search: filter.search, kind: filter.kind });
    const ids = new Set(nodes.map((node) => node.id));
    const edges = repo.memories.edgesFor([...ids]).filter((edge) => ids.has(edge.a) && ids.has(edge.b));
    // Node degree drives radius in the console; computing it here keeps the UI dumb.
    const degree = new Map();
    for (const edge of edges) {
      degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
      degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
    }
    return {
      nodes: nodes.map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 })),
      edges,
      truncated: nodes.length >= limit,
      // The graph is a sample; the caption needs the true match count so a
      // filtered picture cannot look like the whole store.
      matched: repo.memories.count({ search: filter.search, kind: filter.kind }),
      search: filter.search,
      kind: filter.kind,
    };
  };

  const stats = () => repo.memories.stats();
  const search = (options) =>
    searchMemories(repo, {
      searchPool: Number(settings.get('memory.db.searchPool')) || 20000,
      ...options,
    });

  /**
   * One-time migration: the five blocks Yu already has become rows.
   *
   * This is not a preference for prose over structure — it is the only honest way
   * to fill the database on an install that has been running for months. Each
   * block is reported separately so a giant index block can be left alone.
   */
  const importBlocks = ({ slugs = null, blocks = null } = {}) => {
    const all = blocks ?? repo.memory.blocks();
    const selected = slugs?.length ? all.filter((block) => slugs.includes(block.slug)) : all;
    const report = [];
    for (const block of selected) {
      const candidates = splitBlockIntoMemories(block.content)
        .slice(0, 400)
        .map((text) => ({ kind: block.category === 'people' ? 'person' : 'fact', text }));
      const merged = candidates.length
        ? merge(candidates, { source: 'import', at: null })
        : { created: 0, merged: 0, rejected: 0, problems: [], ids: [] };
      report.push({
        slug: block.slug,
        name: block.name,
        chars: String(block.content ?? '').length,
        candidates: candidates.length,
        created: merged.created,
        merged: merged.merged,
        rejected: merged.rejected,
      });
    }
    return {
      blocks: report,
      created: report.reduce((sum, entry) => sum + entry.created, 0),
      merged: report.reduce((sum, entry) => sum + entry.merged, 0),
    };
  };

  return { merge, graph, stats, search, importBlocks, tokenize, kindLabels: KIND_LABELS };
}
