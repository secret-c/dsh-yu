import assert from 'node:assert/strict';
import test from 'node:test';
import { lintMemoryCandidate, readMemoryRules, similarity, DEFAULT_RULES } from '../lib/memory-rules.js';

const build = (blocks, style = '') => ({ blocks, style });

test('runtime ids and timestamps never reach memory', () => {
  const candidate = build({
    recent: '【本轮 arc_alcajkuo (2026-10-27T04:07:59.187Z，类型 reading）】回复还是第一章那三段笔记\n今天陪 ta 改完了小说第一章的笔记结构',
  });
  const result = lintMemoryCandidate({ candidate, previous: {}, rules: { stripProcess: false } });
  const text = result.blocks.recent;
  assert.equal(/arc_/.test(text), false, text);
  assert.equal(/2026-10-27T/.test(text), false, text);
  assert.equal(result.report.stats.idsRemoved >= 2, true, JSON.stringify(result.report.stats));
});

test('process narration lines are dropped whole', () => {
  const candidate = build({
    recent: '【本轮 arc_x1】输入为空，没有新输入\n本周 ta 在准备组会，压力大',
    people: '上一轮 回复还是原样回来\nta 有个同事叫小李',
  });
  const result = lintMemoryCandidate({ candidate, previous: {} });
  assert.equal(result.blocks.recent.includes('本轮'), false);
  assert.equal(result.blocks.recent.includes('本周 ta 在准备组会'), true);
  assert.equal(result.blocks.people.includes('上一轮'), false);
  assert.equal(result.blocks.people.includes('小李'), true);
  assert.equal(result.report.stats.processLinesDropped, 2);
});

test('near-duplicate lines are not appended again', () => {
  const previous = { recent: 'ta 这周在写小说第一章的笔记' };
  const candidate = build({ recent: 'ta 这周在写小说第一章的笔记\nta 说下周想去做个实验' });
  const result = lintMemoryCandidate({ candidate, previous });
  assert.equal(result.blocks.recent, 'ta 说下周想去做个实验');
  assert.equal(result.report.stats.duplicatesDropped, 1);
  assert.equal(result.report.violations.some((v) => v.rule === 'duplicate'), true);
});

test('growth is capped by trimming the oldest lines, never mid-line', () => {
  const previous = { recent: '旧的一行' };
  const long = Array.from({ length: 12 }, (_, index) => `第${index}条：${'内容'.repeat(30)}`).join('\n');
  const result = lintMemoryCandidate({ candidate: build({ recent: long }), previous, rules: { maxGrowthPerRun: 200 } });
  const lines = result.blocks.recent.split('\n');
  assert.equal(result.blocks.recent.length - previous.recent.length <= 200, true, String(result.blocks.recent.length));
  assert.equal(lines.every((line) => line.startsWith('第')), true);
  assert.equal(result.report.stats.growthTrims, 1);
});

test('absolute block cap applies after growth handling', () => {
  const long = '长'.repeat(400);
  const result = lintMemoryCandidate({ candidate: build({ state: long }), previous: {}, rules: { maxBlockChars: 120, maxGrowthPerRun: 0 } });
  assert.equal(result.blocks.state.length, 120);
  assert.equal(result.report.stats.capsApplied, 1);
});

test('clean input passes through untouched and reports no violations', () => {
  const candidate = build({ recent: 'ta 最近在准备一场考试', people: 'ta 的同事叫小李' }, '说话更短一些');
  const result = lintMemoryCandidate({ candidate, previous: {}, rules: DEFAULT_RULES });
  assert.deepEqual(result.blocks, { recent: 'ta 最近在准备一场考试', people: 'ta 的同事叫小李' });
  assert.equal(result.style, '说话更短一些');
  assert.equal(result.report.violations.filter((v) => v.rule !== 'block-changed').length, 0);
});

test('similarity is symmetric and bounded', () => {
  assert.equal(similarity('abc', 'abc'), 1);
  assert.equal(similarity('abc', ''), 0);
  const a = 'ta 这周在写小说';
  const b = 'ta 这周在写小说第一章';
  assert.equal(Math.abs(similarity(a, b) - similarity(b, a)) < 1e-9, true);
  assert.equal(similarity(a, b) > 0.5, true);
});

test('style is capped and never wiped by an empty proposal', () => {
  const long = '很长的风格描述。'.repeat(200);
  const capped = lintMemoryCandidate({ candidate: build({ recent: '事实' }, long), previous: {}, rules: { maxStyleChars: 100 } });
  assert.equal(capped.style.length, 100);
  assert.equal(capped.report.stats.styleCaps, 1);
  assert.equal(capped.report.violations.some((v) => v.rule === 'style-cap'), true);

  const kept = lintMemoryCandidate({
    candidate: build({ recent: '事实' }, ''),
    previous: {},
    previousStyle: '原来的风格',
    rules: {},
  });
  assert.equal(kept.style, '原来的风格');
  assert.equal(kept.report.violations.some((v) => v.rule === 'empty-guard'), true);
});

test('rules read from settings fall back to defaults for unset keys', () => {
  const values = { 'memory.rules.stripIds': false, 'memory.rules.maxGrowthPerRun': 50 };
  const settings = { get: (key) => values[key] };
  const rules = readMemoryRules(settings);
  assert.equal(rules.stripIds, false);
  assert.equal(rules.maxGrowthPerRun, 50);
  assert.equal(rules.dedupeThreshold, DEFAULT_RULES.dedupeThreshold);
});
