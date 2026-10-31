import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost } from './fake-harness.mjs';
import { apply } from '../index.js';

/**
 * The document library: long text stored next to the memories.
 *
 * The list endpoint must not ship every document body — a diary is opened one at
 * a time — and an edit has to survive a re-read, because the whole point of the
 * page is that a human can rewrite what Yu wrote.
 */

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-docs-'));
  const host = createFakeHost();
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
  const base = app.httpService.url();
  const code = fs
    .readFileSync(path.join(dataDir, 'pairing-code.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^[A-Z]{4}-\d{4}$/.test(line));
  const state = { app, base, dataDir, cookie: null };
  const pair = await api(state, 'POST', '/api/pair', { code });
  assert.equal(pair.status, 200, JSON.stringify(pair.body));
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

test('documents are created, listed without bodies, edited and deleted', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  assert.equal(state.app.db.schemaVersion, 11, 'schema v11 adds durable per-binding group glance batches');

  const created = await api(state, 'POST', '/api/memory/docs', {
    title: '日记 2026-10-20',
    category: 'diary',
    content: '# 2026-10-20\n\n今天学会了把话说短。',
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const slug = created.body.document.slug;
  assert.ok(slug);

  const list = await api(state, 'GET', '/api/memory/docs');
  assert.equal(list.status, 200);
  assert.equal(list.body.documents.length, 1);
  assert.equal(list.body.documents[0].content, undefined, 'the list must not ship bodies');
  assert.equal(list.body.stats.chars, created.body.document.chars);

  const one = await api(state, 'GET', `/api/memory/docs/${slug}`);
  assert.equal(one.body.document.content, '# 2026-10-20\n\n今天学会了把话说短。');

  const edited = await api(state, 'PATCH', `/api/memory/docs/${slug}`, {
    content: '# 2026-10-20\n\n今天学会了把话说短，也学会了先问一句。',
  });
  assert.equal(edited.status, 200);
  assert.ok(edited.body.document.chars > one.body.document.chars);
  assert.equal(edited.body.effectiveFrom, 'immediately');

  const reread = await api(state, 'GET', `/api/memory/docs/${slug}`);
  assert.match(reread.body.document.content, /先问一句/);

  const removed = await api(state, 'DELETE', `/api/memory/docs/${slug}`);
  assert.equal(removed.status, 200);
  const missing = await api(state, 'GET', `/api/memory/docs/${slug}`);
  assert.equal(missing.status, 404);
});

test('re-importing a path keeps the edited document', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  // Upsert without overwrite is what the importer does on a second run.
  const first = state.app.repo.documents.upsert({
    slug: 'diary-2026-10-20',
    title: '日记 2026-10-20',
    category: 'diary',
    content: '原始内容',
    source: 'wsl:/home/yu/yu/space/diary/2026-10-20.md',
  });
  assert.equal(first.created, true);

  state.app.repo.documents.update('diary-2026-10-20', { content: '人手改过的内容' });

  const again = state.app.repo.documents.upsert({
    slug: 'diary-2026-10-20',
    title: '日记 2026-10-20',
    category: 'diary',
    content: '原始内容',
    source: 'wsl:/home/yu/yu/space/diary/2026-10-20.md',
  });
  assert.equal(again.created, false);
  assert.equal(again.content, '人手改过的内容', 'a re-import must not undo an edit');

  const forced = state.app.repo.documents.upsert({
    slug: 'diary-2026-10-20',
    title: '日记 2026-10-20',
    category: 'diary',
    content: '原始内容',
    overwriteContent: true,
  });
  assert.equal(forced.content, '原始内容', '--force is the explicit override');
});
