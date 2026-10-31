/**
 * The iteration rules must gate publishing, not merely exist.
 *
 * This drives the real `memory.absorb()` with a real repository, a real settings
 * service and a stubbed model turn, so the assertion is about the wiring: a dirty
 * candidate ("【本轮 arc_…】…") must never reach a published block, and the ledger
 * must carry the reason.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../lib/db.js';
import { createRepo } from '../lib/repo.js';
import { createSettings } from '../lib/settings.js';
import { createMemoryService } from '../lib/memory.js';

const DIRTY_CANDIDATE = {
  style: '说话更短',
  note: 'dirty candidate',
  blocks: {
    recent:
      '【本轮 arc_alcajkuo (2026-10-27T04:07:59.187Z，类型 reading）】回复还是第一章那三段笔记，第五次原样回来\n' +
      'ta 这周在为组会准备材料（run_gb2dytmp），压力不小',
    people: '上一轮 回复还是原样回来\nta 的同事叫小李，负责数据',
    ongoing: 'ta 在写一本小说的第一章笔记',
    thoughts: 'ta 有点担心进度',
    state: '正常工作节奏',
  },
};

function harness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-memrules-'));
  const db = openDatabase(path.join(dir, 'yu.db'));
  const repo = createRepo(db);
  const settings = createSettings(db);
  // The absorb path reads a handful of switches; the rules are the defaults.
  settings.setMany(
    {
      'memory.autoAbsorb': true,
      'memory.maintenanceStrategy': 'legacy',
      'memory.rules.stripIds': true,
      'memory.rules.stripProcess': true,
      'memory.rules.dedupe': true,
      ...overrides.settings,
    },
    'user',
  );

  const reply = overrides.reply ?? JSON.stringify(DIRTY_CANDIDATE);
  const agentHost = {
    runTurn: async () => ({ assistantText: reply, turnEnd: { kind: 'completed' } }),
    disposeSession: async () => {},
  };
  const models = {
    effectiveSelection: () => ({ ready: true, provider: 'stub', model: 'stub', routeId: 'stub' }),
  };
  const archiveService = {
    summarizeForMaintenance: (archive) => ({
      id: archive.id,
      at: archive.createdAt,
      taskId: archive.taskId ?? null,
      taskKind: 'chat',
      input: archive.material?.input ?? '',
      reply: archive.material?.reply ?? '',
      notes: [],
      tools: [],
      project: null,
    }),
  };
  const service = createMemoryService({
    ctx: { get: () => undefined },
    repo,
    settings,
    log: null,
    agentHost,
    models,
    archiveService,
  });
  return { dir, db, repo, settings, service };
}

function seedArchive(repo) {
  repo.archives.create({
    taskId: null,
    conversationId: null,
    runId: null,
    material: { input: '你好', reply: '你好，我在。' },
    path: null,
  });
}

test('a dirty candidate cannot publish ids or process narration', async (t) => {
  const state = harness();
  t.after(() => {
    try {
      state.db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(state.dir, { recursive: true, force: true });
    } catch {
      /* the temp dir is disposable */
    }
  });
  seedArchive(state.repo);

  const result = await state.service.requireAbsorb({ trigger: 'manual' });
  assert.equal(result.status, 'published', JSON.stringify(result));

  const blocks = Object.fromEntries(state.repo.memory.blocks().map((b) => [b.slug, b.content]));
  assert.equal(/arc_/.test(blocks.recent), false, blocks.recent);
  assert.equal(/2026-10-27T/.test(blocks.recent), false, blocks.recent);
  assert.equal(blocks.recent.includes('本轮'), false, blocks.recent);
  assert.equal(blocks.people.includes('上一轮'), false, blocks.people);
  // The real fact survives.
  assert.match(blocks.recent, /组会准备材料/);
  assert.equal(/run_gb2dytmp/.test(blocks.recent), false, blocks.recent);
  assert.match(blocks.people, /小李/);

  const report = result.rules;
  assert.equal(report.stats.processLinesDropped >= 2, true, JSON.stringify(report.stats));
  assert.equal(report.violations.some((v) => v.rule === 'process-narration'), true);
  assert.equal(report.violations.some((v) => v.rule === 'id-leak'), true);
});

test('the ledger records the rules report for the published version', async (t) => {
  const state = harness();
  t.after(() => {
    try {
      state.db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(state.dir, { recursive: true, force: true });
    } catch {
      /* the temp dir is disposable */
    }
  });
  seedArchive(state.repo);
  await state.service.requireAbsorb({ trigger: 'manual' });

  const log = state.repo.memory.maintenanceLog(5);
  const published = log.find((entry) => entry.status === 'published');
  assert.ok(published, JSON.stringify(log));
  assert.ok(published.detail.rules, 'rules report is part of the ledger entry');
  assert.equal(published.detail.rules.stats.processLinesDropped >= 2, true);
  assert.equal(typeof published.detail.rules.rules.dedupeThreshold, 'number');
});

test('turning the rules off lets the same candidate through', async (t) => {
  const state = harness({
    settings: {
      'memory.rules.stripIds': false,
      'memory.rules.stripProcess': false,
      'memory.rules.dedupe': false,
      'memory.rules.maxGrowthPerRun': 0,
    },
  });
  t.after(() => {
    try {
      state.db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(state.dir, { recursive: true, force: true });
    } catch {
      /* the temp dir is disposable */
    }
  });
  seedArchive(state.repo);
  await state.service.requireAbsorb({ trigger: 'manual' });

  const blocks = Object.fromEntries(state.repo.memory.blocks().map((b) => [b.slug, b.content]));
  assert.match(blocks.recent, /arc_alcajkuo/, 'rules disabled means the text is stored as-is');
  assert.equal(blocks.recent.includes('本轮'), true);
});

test('rules never punch a hole: an all-process candidate keeps existing memory', async (t) => {
  // The regression that produced this rule: a round whose model output was eight
  // lines of process narration passed through and published five empty blocks.
  const state = harness({
    reply: JSON.stringify({
      style: '',
      note: 'all process',
      blocks: {
        recent: '【本轮 arc_1】输入为空，没有新输入\n上一轮 回复还是原样回来',
        people: '本轮 回复还是原样回来',
        ongoing: '输入为空',
        thoughts: '第5次原样回来',
        state: '本轮 revision',
      },
    }),
  });
  t.after(() => {
    try {
      state.db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(state.dir, { recursive: true, force: true });
    } catch {
      /* the temp dir is disposable */
    }
  });

  // Start from memory that has real content.
  state.repo.memory.createBlock({
    slug: 'recent',
    name: '近期经历',
    category: 'recent',
    content: 'ta 这周在准备组会',
    orderIndex: 10,
  });
  seedArchive(state.repo);

  const result = await state.service.requireAbsorb({ trigger: 'manual' });
  assert.equal(result.status, 'noop', JSON.stringify(result));
  const blocks = Object.fromEntries(state.repo.memory.blocks().map((b) => [b.slug, b.content]));
  assert.equal(blocks.recent, 'ta 这周在准备组会', 'existing content survives');
  assert.equal(state.repo.memory.versions({ limit: 5 }).length, 0, 'nothing was published');
  const log = state.repo.memory.maintenanceLog(3);
  assert.equal(log[0].detail.rules.stats.emptyGuards >= 1, true, JSON.stringify(log[0].detail.rules.stats));
});

test('a candidate that fails validation publishes nothing', async (t) => {
  const state = harness({ reply: '这不是 JSON' });
  t.after(() => {
    try {
      state.db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(state.dir, { recursive: true, force: true });
    } catch {
      /* the temp dir is disposable */
    }
  });
  seedArchive(state.repo);
  const result = await state.service.requireAbsorb({ trigger: 'manual' });
  assert.equal(result.status, 'failed');
  assert.equal(state.repo.memory.versions({ limit: 5 }).length, 0);
  const log = state.repo.memory.maintenanceLog(5);
  assert.equal(log[0].status, 'failed');
});
