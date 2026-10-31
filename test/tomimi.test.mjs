import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTomimiService, resolveTomimiDataDir } from '../lib/tomimi.js';

function makeDataDir(base) {
  const dataDir = path.join(base, 'yu');
  const tomimiDir = path.join(base, 'yu-knowledge', 'tomimi');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(tomimiDir, { recursive: true });
  fs.writeFileSync(path.join(tomimiDir, 'enemy_database.json'), '{}');
  fs.writeFileSync(path.join(tomimiDir, 'stage_name_lookup_table.json'), '{}');
  fs.writeFileSync(
    path.join(tomimiDir, 'manifest.json'),
    JSON.stringify({ source: 'test', commit: 'abc', importedFiles: 2, topics: { rogue_skz: { stageFiles: 1 } } }),
  );
  return { dataDir, tomimiDir };
}

test('Tomimi data is discovered beside the Yu data root', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-tomimi-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { dataDir, tomimiDir } = makeDataDir(base);
  const resolved = resolveTomimiDataDir({
    settings: { get: () => '' },
    paths: { dataDir },
  });
  assert.equal(resolved.exists, true);
  assert.equal(resolved.resolvedPath, tomimiDir);
});

test('the Tomimi tool is one action-shaped tool, not three separate ones', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-tomimi-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { dataDir } = makeDataDir(base);
  const service = createTomimiService({
    settings: { get: () => '' },
    paths: { dataDir },
    log: null,
  });
  assert.deepEqual(service.definitions.map((definition) => definition.name), ['tomimi']);
  const tool = service.definitions[0];
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.deepEqual(tool.parameters.properties.action.enum, ['search', 'scenario', 'calculate']);
  assert.equal(service.status().ok, true);
  assert.equal(service.status().path, path.join(base, 'yu-knowledge', 'tomimi'));
});
