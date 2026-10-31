import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost,enableLegacyRules } from './fake-harness.mjs';
import { apply } from '../index.js';
import { normalizeSections, defaultSections, sectionName } from '../lib/sections.js';

/**
 * The injectable context is a registry now. These tests cover the contract the
 * page depends on: order, titles, custom bodies, turn scope, and that the
 * compiler actually renders what the registry says.
 */

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-inject-'));
  const host = createFakeHost();
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}}); enableLegacyRules(app);
  const base = app.httpService.url();
  const code = fs
    .readFileSync(path.join(dataDir, 'pairing-code.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^[A-Z]{4}-\d{4}$/.test(line));
  const state = { app, host, base, dataDir, cookie: null };
  await api(state, 'POST', '/api/pair', { code });
  return state;
}

async function api(state, method, url, body) {
  const response = await fetch(`${state.base}${url.replace(/^\//, '')}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: state.base.replace(/\/$/, ''),
      ...(state.cookie ? { cookie: state.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) state.cookie = setCookie.split(';')[0];
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('the registry normalizes, keeps built-in identities and rejects bad ids', () => {
  const defaults = defaultSections();
  assert.deepEqual(
    defaults.map((section) => section.id),
    ['core', 'memory', 'retrieved'],
  );
  assert.equal(sectionName(defaults[1]), 'yu:memory');

  const custom = normalizeSections([
    { id: 'rules', title: '人格', heading: '', order: 20, enabled: true, scope: 'turn' },
    { id: 'sec_groupstyle', title: '群里的分寸', order: 30, body: '别刷屏。', scope: 'session' },
  ]);
  assert.deepEqual(custom.problems, []);
  assert.equal(custom.sections.length, 2);
  assert.equal(custom.sections[0].kind, 'rules');
  assert.equal(custom.sections[0].heading, '');
  assert.equal(custom.sections[0].scope, 'turn');
  assert.equal(custom.sections[1].kind, 'custom');
  assert.equal(sectionName(custom.sections[1]), 'yu:custom:sec_groupstyle');

  const bad = normalizeSections([{ id: 'not-a-custom-id', title: 'x', order: 10 }]);
  assert.equal(bad.sections.length, 0);
  assert.match(bad.problems[0], /sec_/);
});

test('the page can rename, reorder, add and render a custom section', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  const before = await api(state, 'GET', '/api/inject');
  assert.equal(before.status, 200);
  assert.equal(before.body.sections.length, 8, 'each memory block becomes an independently selectable file');
  assert.equal(before.body.sections.find((section) => section.kind === 'rules').title, '角色卡');

  const sections = before.body.sections
    .map((section) => ({
      id: section.id,
      title: section.kind === 'rules' ? '人格' : section.title,
      heading: section.kind === 'rules' ? '你的人格' : section.heading,
      order: section.order,
      enabled: section.enabled,
      scope: section.scope,
    }))
    .concat([
      {
        id: 'sec_groupstyle',
        title: '群里的分寸',
        heading: '在群里',
        order: 120,
        enabled: true,
        scope: 'session',
        body: '你在群里是普通群友，不刷屏，不装作客服。',
      },
    ]);

  const saved = await api(state, 'POST', '/api/inject/sections', {
    sections,
    texts: { 'prompt.rules': '你是小雨。说话短。', 'prompt.core': '你是小雨。' },
    retrieval: { enabled: true, items: 3 },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const after = await api(state, 'GET', '/api/inject');
  const custom = after.body.sections.find((section) => section.id === 'sec_groupstyle');
  assert.equal(custom.title, '群里的分寸');
  assert.equal(custom.body, '你在群里是普通群友，不刷屏，不装作客服。');
  assert.equal(after.body.retrieval.items, 3);
  assert.equal(after.body.sections.find((section) => section.kind === 'rules').title, '人格');

  const preview = await api(state, 'POST', '/api/inject/preview', { input: '今天想做点什么？' });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const names = preview.body.compiled.sections.map((section) => section.name);
  assert.ok(names.includes('yu:custom:sec_groupstyle'));
  const ruleIndex = names.indexOf('yu:rules');
  const customIndex = names.indexOf('yu:custom:sec_groupstyle');
  assert.ok(ruleIndex >= 0 && customIndex > ruleIndex, 'custom section follows the rules section');
  assert.match(preview.body.compiled.renderedSystem, /## 你的人格\n\n你是小雨。说话短。/);
  assert.match(preview.body.compiled.renderedSystem, /## 在群里\n\n你在群里是普通群友/);
});

test('a disabled section is absent from the compiled prompt', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  // Remove explicit profile bindings through the public context API before disabling the shared resource.
  for(const profile of state.app.repo.contexts.list())if(Array.isArray(profile.config.injection)) {
    const saved=await api(state,'POST','/api/contexts/'+profile.id+'/versions',{config:{...profile.config,injection:profile.config.injection.filter(b=>b.id!=='core')}});
    assert.equal(saved.status,200);
  }
  const before = await api(state, 'GET', '/api/inject');
  const sections = before.body.sections.map((section) => ({
    id: section.id,
    title: section.title,
    heading: section.heading,
    order: section.order,
    enabled: section.kind === 'core' ? false : section.enabled,
    scope: section.scope,
  }));
  await api(state, 'POST', '/api/inject/sections', { sections });
  const preview = await api(state, 'POST', '/api/inject/preview', { input: '在吗' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.compiled.sections.some((section) => section.name === 'yu:core'), false);
});
