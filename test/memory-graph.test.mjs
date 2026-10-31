import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost } from './fake-harness.mjs';
import { apply } from '../index.js';

/**
 * The atlas is a view over two SQL tables: `memories` for nodes and
 * `memory_edges` for links. A filtered graph must report the true match count
 * even though only a sample is drawn.
 */

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-graph-'));
  const host = createFakeHost();
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
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

test('the graph endpoint filters nodes by search and reports the full match count', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });
  const { repo } = state.app;

  const hit = repo.memories.create({
    kind: 'fact',
    subject: '思华年',
    text: '明日方舟肉鸽玩家，研究不期节点和轴',
  });
  repo.memories.create({ kind: 'fact', subject: '其他', text: '今天天气不错' });
  repo.memories.create({ kind: 'fact', subject: '思华年', text: '明日方舟113级' });

  const all = await api(state, 'GET', '/api/memory/db/graph?limit=240');
  assert.equal(all.status, 200);
  assert.equal(all.body.matched, 3);

  const filtered = await api(state, 'GET', `/api/memory/db/graph?limit=240&search=${encodeURIComponent('明日方舟')}`);
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.matched, 2);
  assert.equal(filtered.body.search, '明日方舟');
  assert.equal(filtered.body.nodes.length, 2);
  assert.ok(filtered.body.nodes.some((node) => node.id === hit.id));
  assert.equal(filtered.body.edges.length, 0);
});
