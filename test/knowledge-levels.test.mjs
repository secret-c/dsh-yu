import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createKnowledgeTools } from '../lib/tools-knowledge.js';

/**
 * The corpus stores skill levels 1–7 plus mastery 1–3 as levels 8–10. The tool
 * used to clamp every request to 7, so "专精三多少" was answered with the level-7
 * numbers and a note that the mastery data did not exist — while it was sitting
 * in `skill_levels` the whole time.
 */

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-knowledge-levels-'));
  // The knowledge module caches an open handle; on Windows the file stays locked,
  // so cleanup is best-effort (a failed rm must not fail the test).
  t.after(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* handle still open */
    }
  });
  const dataDir = path.join(base, 'yu');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(base, 'knowledge.sqlite3');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT, kind TEXT, corpus TEXT);
    CREATE TABLE aliases (alias TEXT, entity_id TEXT);
    CREATE TABLE sources (id TEXT PRIMARY KEY, path TEXT, sha256 TEXT, kind TEXT, bytes INTEGER, metadata TEXT);
    CREATE TABLE documents (id TEXT PRIMARY KEY, corpus TEXT, title TEXT, locator TEXT, evidence_type TEXT,
                            event_date TEXT, url TEXT, text TEXT);
    CREATE TABLE skill_refs (character_id TEXT, skill_index INTEGER, skill_id TEXT, form TEXT,
                             source_id TEXT, locator TEXT);
    CREATE TABLE skill_levels (skill_id TEXT, level INTEGER, payload TEXT, source_id TEXT, locator TEXT);
  `);
  db.prepare('INSERT INTO entities VALUES (?,?,?,?)').run('game:char_900_test', '测试干员', 'character', 'arknights_game_data');
  db.prepare('INSERT INTO skill_refs VALUES (?,?,?,?,?,?)').run('char_900_test', 1, 'sk_test_1', 'CASTER', null, 'skill_1');
  for (let level = 1; level <= 10; level += 1) {
    db.prepare('INSERT INTO skill_levels VALUES (?,?,?,?,?)').run(
      'sk_test_1',
      level,
      JSON.stringify({ name: '测试技能', description: level === 10 ? '专精三描述' : `等级${level}描述` }),
      null,
      `level_${level}`,
    );
  }
  db.close();
  const connection=new DatabaseSync(file,{readOnly:true});
  t.after(()=>connection.close());
  return {
    dataDir,
    service: createKnowledgeTools({
      dbProvider:()=>connection,
      paths: { dataDir, files: path.join(dataDir, 'files') },
      log: null,
    }),
  };
}

test('mastery levels are reachable: level 10 returns the mastery payload', (t) => {
  const { service } = fixture(t);
  const result = service.skills({ character_id: 'char_900_test', level: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.requestedLevel, 10);
  assert.equal(result.entries[0].level, 10, 'the requested level is honoured, not clamped to 7');
  assert.match(result.entries[0].description, /专精三/);
  assert.deepEqual(result.entries[0].availableLevels, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('the default stays level 7, and the lookup tool honours an explicit level', (t) => {
  const { service } = fixture(t);
  const plain = service.skills({ character_id: 'char_900_test' });
  assert.equal(plain.entries[0].level, 7, 'default unchanged for callers that do not ask');

  const looked = service.lookup({ query: '测试干员', level: 10 });
  assert.equal(looked.ok, true);
  assert.equal(looked.character.skills[0].level, 10);
  assert.match(looked.character.skills[0].level_data.description, /专精三/);
});

test('a level the corpus lacks falls back to the closest one instead of returning nothing', (t) => {
  const { service } = fixture(t);
  const result = service.skills({ character_id: 'char_900_test', level: 12 });
  assert.equal(result.ok, true);
  assert.equal(result.entries[0].level, 10, 'closest available level');
});
