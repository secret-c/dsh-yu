import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFakeHost } from './fake-harness.mjs';
import { apply } from '../index.js';

/**
 * Moving the data root while Yu runs.
 *
 * The point of this test is the difference between "the folder was copied" and
 * "the running instance now uses the copied folder": it boots on the platform
 * default (so the pointer file is the mechanism under test), moves to a new
 * folder, and then reads and writes through the *live* handle to prove the swap
 * happened rather than being scheduled for the next restart.
 */

async function bootOnDefaultRoot() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-root-'));
  const previous = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_DATA_HOME: process.env.XDG_DATA_HOME, HOME: process.env.HOME };
  if (process.platform === 'win32') process.env.LOCALAPPDATA = path.join(sandbox, 'localappdata');
  else process.env.XDG_DATA_HOME = path.join(sandbox, 'xdg');
  const host = createFakeHost();
  const app = apply(host.ctx, { port: 0, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
  const base = app.httpService.url();
  const code = fs
    .readFileSync(path.join(app.paths.dataDir, 'pairing-code.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^[A-Z]{4}-\d{4}$/.test(line));
  const state = { app, host, base, code, sandbox, cookie: null };
  const pair = await api(state, 'POST', '/api/pair', { code });
  assert.equal(pair.status, 200, JSON.stringify(pair.body));
  return {
    state,
    async cleanup() {
      await app.stop();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
    },
  };
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

test('the data root moves while the plugin runs, and the live handle follows', async (t) => {
  const { state, cleanup } = await bootOnDefaultRoot();
  t.after(cleanup);
  const { app } = state;
  const oldRoot = app.paths.dataDir;
  assert.match(path.basename(oldRoot), /^yu$/i, 'default root is the platform default');

  const before = await api(state, 'POST', '/api/tasks', { name: '迁移前任务', kind: 'custom' });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const taskId = before.body.task.id;

  const target = path.join(state.sandbox, 'moved-data');
  const precheck = await api(state, 'POST', '/api/data-root/precheck', { target });
  assert.equal(precheck.status, 200);
  assert.equal(precheck.body.ok, true, JSON.stringify(precheck.body.problems));

  const missingConfirm = await api(state, 'POST', '/api/data-root/apply', { target });
  assert.equal(missingConfirm.status, 400);
  assert.equal(missingConfirm.body.error.code, 'CONFIRM_REQUIRED');

  const applied = await api(state, 'POST', '/api/data-root/apply', { target, confirm: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.mode, 'live');
  assert.equal(applied.body.restartRequired, false);
  assert.equal(applied.body.verification.integrity, 'ok');

  // The running instance — not the next boot — is on the new root now.
  assert.equal(app.paths.dataDir, target);
  assert.equal(app.db.file, path.join(target, 'yu.db'));
  assert.equal(app.paths.db, path.join(target, 'yu.db'));

  // Reads go through the new handle: the pre-migration row is there.
  const list = await api(state, 'GET', '/api/tasks');
  assert.equal(list.status, 200);
  assert.ok(list.body.tasks.some((task) => task.id === taskId), 'pre-migration task survived the switch');

  // Writes go through the new handle too: verify at the file level, not via the API.
  const after = await api(state, 'POST', '/api/tasks', { name: '迁移后任务', kind: 'custom' });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  const direct = new DatabaseSync(path.join(target, 'yu.db'), { readOnly: true });
  try {
    const rows = direct.prepare('SELECT name FROM tasks WHERE deleted_at IS NULL ORDER BY created_at').all();
    const names = rows.map((row) => row.name);
    assert.ok(names.includes('迁移前任务'), 'pre-migration row is in the new file');
    assert.ok(names.includes('迁移后任务'), 'post-migration write landed in the new file');
  } finally {
    direct.close();
  }

  // Side folders were rebased, not just copied: a new backup lands in the target.
  const backup = await api(state, 'POST', '/api/backups', { label: 'after-move' });
  assert.equal(backup.status, 200, JSON.stringify(backup.body));
  assert.ok(fs.existsSync(path.join(target, 'backups')), 'backups folder exists in the new root');
  assert.ok(
    fs.readdirSync(path.join(target, 'backups')).some((name) => name.endsWith('.db')),
    'the new backup was written under the new root',
  );

  // The pointer records the choice so a restart lands on the same root.
  const pointerFile = path.join(app.paths.bootstrap, 'location.json');
  const pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
  assert.equal(path.resolve(pointer.dataDir), path.resolve(target));

  // Reset to the default root for the cleanup path, and confirm it is reversible.
  const reset = await api(state, 'POST', '/api/data-root/reset-pointer');
  assert.equal(reset.status, 200);
  assert.equal(fs.existsSync(pointerFile), false);
});

test('a rejected target never touches the filesystem', async (t) => {
  const { state, cleanup } = await bootOnDefaultRoot();
  t.after(cleanup);
  const nested = path.join(state.app.paths.dataDir, 'sub');
  const precheck = await api(state, 'POST', '/api/data-root/precheck', { target: nested });
  assert.equal(precheck.status, 200);
  assert.equal(precheck.body.ok, false);
  assert.ok(precheck.body.problems.some((problem) => problem.includes('内部')), JSON.stringify(precheck.body.problems));
  assert.equal(fs.existsSync(nested), false, 'a rejected precheck must not create the folder');
});
