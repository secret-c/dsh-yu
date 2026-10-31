/**
 * Memory iteration rules.
 *
 * Memory used to absorb whatever the model wrote, including its own bookkeeping:
 * `【本轮 arc_alcajkuo (2026-10-27T04:07:59.187Z，类型 reading）】`. That is a log,
 * not a memory — it says nothing about a person, an event, or a state, and it grows
 * forever. These rules decide what may enter a block, how much may grow per
 * iteration, and they report every removal so the ledger can show why.
 *
 * Pure functions only: no database, no clock, no settings object. The caller hands
 * in the candidate and the previous blocks, which makes the rules testable and
 * replayable.
 */

/** Runtime identifiers and timestamps that must never become "memory". */
const ID_PATTERNS = [
  /\b(?:arc|run|conv|mem|task|evt|trg|sess|dev|ch|msg|rec)_[A-Za-z0-9]{4,}\b/g,
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g,
  /\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?\b/g,
];

/**
 * Narration about the maintenance process itself. Matched per line, because a
 * line that talks about "this round" is entirely process.
 */
const PROCESS_PATTERNS = [
  /本轮/,
  /上一轮/,
  /这轮/,
  /第[一二三四五六七八九十\d]+次(?:原样)?回来/,
  /输入为空/,
  /回复还是/,
  /原样回来/,
  /没有新(?:输入|对话|内容)/,
  /^revision\b/i,
  /lastRunId/i,
];

const DEFAULT_RULES = {
  stripIds: true,
  stripProcess: true,
  dedupe: true,
  dedupeThreshold: 0.82,
  maxGrowthPerRun: 400,
  maxBlockChars: 6000,
  maxStyleChars: 800,
};

/** Character-bigram Jaccard: cheap, language-agnostic, good enough for near-dupes. */
export function similarity(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (text) => {
    const set = new Set();
    const value = text.replace(/\s+/g, '');
    for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
    return set;
  };
  const first = grams(left);
  const second = grams(right);
  if (first.size === 0 || second.size === 0) return 0;
  let shared = 0;
  for (const gram of first) if (second.has(gram)) shared += 1;
  return shared / (first.size + second.size - shared);
}

const linesOf = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

function stripIdsFromLine(line, counters, examples) {
  let next = line;
  for (const pattern of ID_PATTERNS) {
    next = next.replace(pattern, (match) => {
      counters.ids += 1;
      if (examples.ids.length < 3) examples.ids.push(match);
      return '';
    });
  }
  // Removing a token mid-sentence can leave `（ ，` debris.
  return next
    .replace(/[（(]\s*[，,、]?\s*[）)]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[，,]\s*$/g, '')
    .trim();
}

const isProcessLine = (line) => PROCESS_PATTERNS.some((pattern) => pattern.test(line));

/**
 * Apply the rules to one candidate.
 *
 * @returns {{blocks: Record<string,string>, style: string, report: object}}
 */
export function lintMemoryCandidate({ candidate, previous = {}, previousStyle = '', rules = {} }) {
  const config = { ...DEFAULT_RULES, ...rules };
  const violations = [];
  const counters = { ids: 0, process: 0, duplicates: 0, growthTrims: 0, caps: 0, empties: 0 };
  const examples = { ids: [], process: [], duplicates: [], growth: [], empties: [] };

  const noteViolation = (rule, block, detail) => {
    violations.push({ rule, block, ...detail });
  };

  const blocks = {};
  for (const [slug, raw] of Object.entries(candidate?.blocks ?? {})) {
    const previousText = String(previous[slug] ?? '');
    const previousLines = linesOf(previousText);
    const kept = [];

    for (const line of linesOf(raw)) {
      if (config.stripProcess && isProcessLine(line)) {
        counters.process += 1;
        if (examples.process.length < 3) examples.process.push(line.slice(0, 80));
        continue;
      }
      let next = line;
      if (config.stripIds) next = stripIdsFromLine(next, counters, examples);
      if (!next) continue;

      // A line the block already carries, or one that says the same thing again,
      // adds nothing — memory must get sharper, not longer.
      if (config.dedupe) {
        const against = [...previousLines, ...kept];
        const hit = against.find((other) => similarity(next, other) >= config.dedupeThreshold);
        if (hit) {
          counters.duplicates += 1;
          if (examples.duplicates.length < 3) examples.duplicates.push({ kept: hit.slice(0, 60), dropped: next.slice(0, 60) });
          continue;
        }
      }
      kept.push(next);
    }

    let text = kept.join('\n');
    const growth = text.length - previousText.length;
    if (config.maxGrowthPerRun > 0 && growth > config.maxGrowthPerRun) {
      // Trim from the oldest end, on a line boundary so a fact is never cut in half.
      let lines = kept;
      while (lines.length > 1 && lines.join('\n').length - previousText.length > config.maxGrowthPerRun) {
        lines = lines.slice(1);
      }
      text = lines.join('\n');
      counters.growthTrims += 1;
      if (examples.growth.length < 3) examples.growth.push({ before: growth, after: text.length - previousText.length });
    }
    if (config.maxBlockChars > 0 && text.length > config.maxBlockChars) {
      text = text.slice(0, config.maxBlockChars);
      counters.caps += 1;
    }

    // Never let the rules punch a hole in existing memory. If everything a block
    // proposed was filtered out, the honest result is "no update", not "empty".
    if (!text.trim() && previousText.trim()) {
      text = previousText;
      counters.empties += 1;
      if (examples.empties.length < 3) examples.empties.push(slug);
    }

    blocks[slug] = text;

    if (previousText !== text) {
      const delta = text.length - previousText.length;
      noteViolation('block-changed', slug, { previousChars: previousText.length, chars: text.length, delta });
    }
  }

  if (counters.ids > 0) noteViolation('id-leak', null, { count: counters.ids, examples: examples.ids });
  if (counters.process > 0) noteViolation('process-narration', null, { count: counters.process, examples: examples.process });
  if (counters.duplicates > 0) noteViolation('duplicate', null, { count: counters.duplicates, examples: examples.duplicates });
  if (counters.growthTrims > 0) noteViolation('growth-cap', null, { count: counters.growthTrims, examples: examples.growth });
  if (counters.caps > 0) noteViolation('block-cap', null, { count: counters.caps });
  if (counters.empties > 0) noteViolation('empty-guard', null, { count: counters.empties, blocks: examples.empties });

  // Style is one prose paragraph, so line rules do not apply; the useful guard is
  // a length cap. It only ever grows with per-round self-review otherwise.
  let style = String(candidate?.style ?? '');
  if (config.maxStyleChars > 0 && style.length > config.maxStyleChars) {
    style = style.slice(0, config.maxStyleChars);
    counters.styleCaps = 1;
    noteViolation('style-cap', null, { chars: style.length, cap: config.maxStyleChars });
  }
  if (!style.trim() && String(previousStyle ?? '').trim()) {
    style = String(previousStyle);
    counters.empties += 1;
    noteViolation('empty-guard', 'style', { count: 1 });
  }

  return {
    blocks,
    style,
    report: {
      rules: config,
      violations,
      stats: {
        idsRemoved: counters.ids,
        processLinesDropped: counters.process,
        duplicatesDropped: counters.duplicates,
        growthTrims: counters.growthTrims,
        capsApplied: counters.caps,
        emptyGuards: counters.empties,
        styleCaps: counters.styleCaps ?? 0,
        charsBefore: Object.values(candidate?.blocks ?? {}).reduce((sum, text) => sum + String(text ?? '').length, 0),
        charsAfter: Object.values(blocks).reduce((sum, text) => sum + text.length, 0),
      },
      at: null,
    },
  };
}

/** Read the rule values out of the settings service, falling back to defaults. */
export function readMemoryRules(settings) {
  const read = (key, fallback) => {
    const value = settings?.get?.(`memory.rules.${key}`);
    return value === undefined || value === null || value === '' ? fallback : value;
  };
  return {
    stripIds: Boolean(read('stripIds', DEFAULT_RULES.stripIds)),
    stripProcess: Boolean(read('stripProcess', DEFAULT_RULES.stripProcess)),
    dedupe: Boolean(read('dedupe', DEFAULT_RULES.dedupe)),
    dedupeThreshold: Number(read('dedupeThreshold', DEFAULT_RULES.dedupeThreshold)),
    maxGrowthPerRun: Number(read('maxGrowthPerRun', DEFAULT_RULES.maxGrowthPerRun)),
    maxStyleChars: Number(read('maxStyleChars', DEFAULT_RULES.maxStyleChars)),
    maxBlockChars: Number(read('maxBlockChars', DEFAULT_RULES.maxBlockChars)),
  };
}

export { DEFAULT_RULES };
