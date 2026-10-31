import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { createFakeHost } from './fake-harness.mjs';
import { syncFromFiles, blockPath, writeAllBlockFiles } from '../lib/memory-files.js';

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-memory-commit-'));
  const app = apply(createFakeHost().ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  t.after(async () => { await app.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return app;
}
test('stale model proposal cannot overwrite a newer manual draft', async (t) => {
  const app = await fixture(t);
  const base = app.repo.memory.revision();
  const old = app.repo.memory.blocks();
  app.repo.memory.updateBlock(old[0].slug, { content: 'new manual draft' });
  assert.throws(() => app.repo.memory.publish({ blocks: old, expectedRevision: base }), { code: 'MEMORY_CONFLICT' });
  assert.equal(app.repo.memory.blockBySlug(old[0].slug).content, 'new manual draft');
  assert.equal(app.repo.memory.versions().length, 0);
});
test('DB publish survives file failure and repair creates no duplicate version', async (t) => {
  const app = await fixture(t);
  app.repo.memory.configureProjection(() => { throw new Error('second file failed'); });
  const version = app.repo.memory.publish({ blocks: app.repo.memory.blocks() });
  assert.equal(app.repo.memory.projectionState().pending, true);
  assert.equal(app.repo.memory.versionById(version.id).id, version.id);
  assert.throws(() => syncFromFiles(app.repo, app.paths), { code: 'MEMORY_PROJECTION_PENDING' });
  app.repo.memory.configureProjection(() => writeAllBlockFiles(app.repo, app.paths));
  assert.equal(app.repo.memory.repairProjection().pending, false);
  assert.equal(app.repo.memory.versions().length, 1);
});
test('one file import preserves edits in every block', async (t) => {
  const app = await fixture(t);
  const blocks = app.repo.memory.blocks().slice(0, 2);
  for (const block of blocks) {
    const file = blockPath(app.paths, block.slug);
    fs.writeFileSync(file, 'external ' + block.slug);
    const future = new Date(Date.now() + 3000); fs.utimesSync(file, future, future);
  }
  syncFromFiles(app.repo, app.paths);
  for (const block of blocks) assert.equal(app.repo.memory.blockBySlug(block.slug).content, 'external ' + block.slug);
});

test('explicit import rejects changed DB or files after a read-only preview', async (t) => {
  const app = await fixture(t);
  const { previewFileImport, validateFileImport } = await import('../lib/memory-files.js');
  const basis = previewFileImport(app.repo, app.paths);
  const fileHashes = Object.fromEntries(basis.files.map((file) => [file.slug, file.fileHash]));
  fs.writeFileSync(blockPath(app.paths, basis.files[0].slug), 'later file edit');
  assert.throws(() => validateFileImport(app.repo, app.paths, { expectedRevision: basis.revision, fileHashes }), { code: 'MEMORY_FILE_CONFLICT' });
  app.repo.memory.updateBlock(basis.files[0].slug, { content: 'later DB edit' });
  assert.throws(() => validateFileImport(app.repo, app.paths, { expectedRevision: basis.revision }), { code: 'MEMORY_CONFLICT' });
});

test('editing A never projects over an unimported external edit in B', async (t) => {
  const app = await fixture(t);
  const [a, b] = app.repo.memory.blocks();
  const file = blockPath(app.paths, b.slug);
  fs.writeFileSync(file, 'external B');
  const future = new Date(Date.now() + 3000); fs.utimesSync(file, future, future);
  app.repo.memory.updateBlock(a.slug, { content: 'draft A' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'external B');
  syncFromFiles(app.repo, app.paths);
  assert.equal(app.repo.memory.blockBySlug(b.slug).content, 'external B');
});
test('failed projection retry detects and preserves later external edits', async (t) => {
  const app = await fixture(t);
  const { projectMemoryTargets } = await import('../lib/memory-files.js');
  const block = app.repo.memory.blocks()[0];
  app.repo.memory.configureProjection(() => { throw new Error('disk offline'); });
  app.repo.memory.updateBlock(block.slug, { content: 'committed DB value' });
  const file = blockPath(app.paths, block.slug);
  fs.writeFileSync(file, 'later external edit');
  app.repo.memory.configureProjection((targets) => projectMemoryTargets(app.repo, app.paths, targets));
  assert.throws(() => syncFromFiles(app.repo, app.paths), { code: 'MEMORY_PROJECTION_PENDING' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'later external edit');
  assert.equal(app.repo.memory.blockBySlug(block.slug).content, 'committed DB value');
});

test('HTTP editing cannot bypass a pending external-file conflict and rejects stale revisions', async (t) => {
  const app = await fixture(t);
  const { projectMemoryTargets } = await import('../lib/memory-files.js');
  const base = app.httpService.url();
  const code = fs.readFileSync(path.join(app.paths.dataDir, 'pairing-code.txt'), 'utf8').match(/[A-Z]{4}-[0-9]{4}/)[0];
  const paired = await fetch(base + 'api/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: base.replace(/\/$/, '') }, body: JSON.stringify({ code }) });
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const block = app.repo.memory.blocks()[0];
  const oldRevision = app.repo.memory.revision();
  app.repo.memory.configureProjection(() => { throw new Error('disk offline'); });
  app.repo.memory.updateBlock(block.slug, { content: 'committed DB' });
  const file = blockPath(app.paths, block.slug); fs.writeFileSync(file, 'external edit');
  app.repo.memory.configureProjection((targets) => projectMemoryTargets(app.repo, app.paths, targets));
  const request = (body) => fetch(base + 'api/memory/blocks/' + block.slug, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: base.replace(/\/$/, ''), cookie }, body: JSON.stringify(body) });
  const stale = await request({ content: 'stale overwrite', expectedRevision: oldRevision });
  assert.equal(stale.status, 409);
  const edited = await request({ content: 'another DB edit', expectedRevision: app.repo.memory.revision() });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).projection.pending, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'external edit');
});

test('applying an empty config does not project unrelated memory files', async (t) => {
  const app = await fixture(t);
  const block = app.repo.memory.blocks()[0];
  const file = blockPath(app.paths, block.slug);
  fs.writeFileSync(file, 'external config-independent edit');
  await app.configFile.apply({ text: '{}', confirm: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'external config-independent edit');
});

test('a pending update followed by deletion repairs the latest committed operation', async (t) => {
  const app = await fixture(t);
  const { projectMemoryTargets } = await import('../lib/memory-files.js');
  const block = app.repo.memory.blocks()[0];
  app.repo.memory.configureProjection(() => { throw new Error('disk offline'); });
  app.repo.memory.updateBlock(block.slug, { content: 'pending update' });
  app.repo.memory.deleteBlock(block.slug);
  app.repo.memory.configureProjection((targets) => projectMemoryTargets(app.repo, app.paths, targets));
  assert.equal(app.repo.memory.repairProjection().pending, false);
  assert.equal(fs.existsSync(blockPath(app.paths, block.slug)), false);
});

test('created block projection uses the same trimmed lowercase slug as the DB', async (t) => {
  const app = await fixture(t);
  const block = app.repo.memory.createBlock({ slug: ' Spaced ', name: 'space normalization', category: 'custom', content: 'normalized file' });
  assert.equal(block.slug, 'spaced');
  assert.equal(fs.readFileSync(blockPath(app.paths, 'spaced'), 'utf8'), 'normalized file');
  assert.equal(app.repo.memory.projectionState().pending, false);
});
