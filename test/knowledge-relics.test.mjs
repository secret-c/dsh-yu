import {createDatabaseSources} from '../lib/database-sources.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createKnowledgeTools } from '../lib/tools-knowledge.js';

/**
 * Attack relics split by layer, not by wording: 局外 raises the operator's panel
 * (剑锤、指中狼) and the whole 局外 pool multiplies the in-battle one; 局内 applies
 * during battle and adds together with skill ATK buffs (叙拉古人的愤怒、黑色郁金香).
 */

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-knowledge-relics-'));
  t.after(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* the cached handle keeps the file open on Windows */
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
    CREATE TABLE documents (id TEXT PRIMARY KEY, source_id TEXT, locator TEXT, corpus TEXT, title TEXT,
                            text TEXT, evidence_type TEXT, event_date TEXT, url TEXT, version TEXT, metadata TEXT);
    CREATE TABLE skill_refs (character_id TEXT, skill_index INTEGER, skill_id TEXT, form TEXT, source_id TEXT, locator TEXT);
    CREATE TABLE skill_levels (skill_id TEXT, level INTEGER, payload TEXT, source_id TEXT, locator TEXT);
    CREATE TABLE document_entities (document_id TEXT, entity_id TEXT, role TEXT);
    CREATE TABLE relic_effects (topic TEXT, relic_id TEXT, relic_name TEXT, slot INTEGER, buff_key TEXT,
                                attribute TEXT, amount REAL, phase TEXT, mode TEXT, trigger TEXT, category TEXT,
                                scope TEXT, condition TEXT, note TEXT, raw TEXT, damage_type TEXT,
                                PRIMARY KEY (topic, relic_id, slot, attribute));
  `);
  db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    'rogue:rogue_6:item:relic_a', 'src:1', 'x', 'arknights_rogue', '树海 · 剑锤（藏品）',
    '攻击力、防御力、生命 +50%\n\n机制：局外｜攻击力 +50%（全部）｜相加（与局内相乘）', 'game_data', null, null, 'abc', null,
  );
  db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    'rogue:rogue_6:item:relic_b', 'src:1', 'y', 'arknights_rogue', '树海 · 残弩-神准（藏品）',
    '攻击力提升至140%\n\n机制：局内｜攻击力 ×1.4（狙击）｜相乘', 'game_data', null, null, 'abc', null,
  );
  const insert = db.prepare('INSERT INTO relic_effects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('rogue_6', 'relic_a', '剑锤', 1, 'char_attribute_mul', 'atk', 0.5, '局外', '相加', '常驻', 'char_attribute_mul', '全部', null, '攻击力 +50%（全部）', '{}', null);
  insert.run('rogue_6', 'relic_c', '皇帝的恩宠', 1, 'char_attribute_mul', 'atk', 0.15, '局外', '相加', '常驻', 'char_attribute_mul', '近战', null, '攻击力 +15%（近战）', '{}', null);
  insert.run('rogue_6', 'relic_b', '残弩-神准', 1, 'char_ability_new', 'atk', 1.4, '局内', '相乘', '光环/条件', 'atk_scale', '职业:sniper', 'x', '攻击力 ×1.4（职业:sniper）', '{}', null);
  insert.run('rogue_6', 'relic_a', '剑锤', 2, 'char_attribute_mul', 'def', 0.5, '局外', '相加', '常驻', 'char_attribute_mul', '全部', null, '防御力 +50%（全部）', '{}', null);
  insert.run('rogue_6', 'relic_d', '制式防暴用具', 10001, 'usage_text', 'damage', 0.2, '局内', '相加', '常驻', '法术', null, null, '敌方受到法术伤害 +20%', '{}', '法术');
  insert.run('rogue_6', 'relic_e', '红日冠冕', 10002, 'usage_text', 'damage', 3, '局内', '相乘', '常驻', '通用', null, null, '伤害提升至 300%（独立乘区）', '{}', '通用');
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

test('relics separates the panel layer from the in-battle layer', (t) => {
  const { service } = fixture(t);
  const all = service.relics({ topic: '树海', attribute: 'atk' });
  assert.equal(all.ok, true);
  assert.equal(all.topic, 'rogue_6', 'the alias 树海 resolves to the topic id');
  assert.deepEqual(all.byPhase, { 局外: 2, 局内: 1 });
  assert.deepEqual(all.byMode, { 相加: 2, 相乘: 1 });

  const panel = service.relics({ topic: 'rogue_6', phase: '局外' });
  assert.equal(panel.total, 2);
  assert.deepEqual(panel.effects.map((entry) => entry.relic).sort(), ['剑锤', '皇帝的恩宠']);

  const battle = service.relics({ topic: 'rogue_6', phase: '局内' });
  assert.equal(battle.total, 1);
  assert.equal(battle.effects[0].relic, '残弩-神准');
  assert.equal(battle.effects[0].amount, 1.4);
  assert.match(battle.effects[0].usage, /提升至140%/);
});

test('relics filters by attribute and keyword', (t) => {
  const { service } = fixture(t);
  const def = service.relics({ attribute: 'def' });
  assert.equal(def.total, 1);
  assert.equal(def.effects[0].phase, '局外');

  const named = service.relics({ topic: '树海', keyword: '剑锤' });
  assert.equal(named.total, 1);
  assert.equal(named.effects[0].relic, '剑锤');
});

test('damage multipliers are queryable by damage type', (t) => {
  const { service } = fixture(t);
  const damage = service.relics({ topic: 'rogue_6', attribute: 'damage' });
  assert.equal(damage.total, 2);
  assert.deepEqual(damage.byMode, { 相加: 1, 相乘: 1 });
  const magic = service.relics({ topic: 'rogue_6', attribute: 'damage', damage_type: '法术' });
  assert.equal(magic.total, 1);
  assert.equal(magic.effects[0].relic, '制式防暴用具');
});

test('relics reports a missing table instead of failing the turn', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-knowledge-relics-empty-'));
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
    CREATE TABLE documents (id TEXT PRIMARY KEY, source_id TEXT, locator TEXT, corpus TEXT, title TEXT,
                            text TEXT, evidence_type TEXT, event_date TEXT, url TEXT, version TEXT, metadata TEXT);
  `);
  db.close();
  const connection=new DatabaseSync(file,{readOnly:true});
  t.after(()=>connection.close());
  const service = createKnowledgeTools({
    dbProvider:()=>connection,
    paths: { dataDir, files: path.join(dataDir, 'files') },
    log: null,
  });
  const result = service.relics({ topic: '树海' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'RELIC_EFFECTS_MISSING');
});

test('managed arknights adapter queries the explicitly installed corpus',async(t)=>{
 const {dataDir}=fixture(t);let state='[]';
 const manager=createDatabaseSources({settings:{get:()=>state,set:(_k,v)=>state=v}});t.after(()=>manager.dispose());
 manager.install({id:'ark',name:'Arknights',version:'1',adapter:'arknights',config:{path:path.join(path.dirname(dataDir),'knowledge.sqlite3')}});
 const result=await manager.execute({sourceId:'ark',operation:'source_ark_arknights_relics',arguments:{topic:'树海',attribute:'atk'}});
 assert.equal(result.ok,true);assert.equal(result.total,3);
 manager.setEnabled('ark',false);assert.throws(()=>manager.execute({sourceId:'ark',operation:'source_ark_arknights_relics',arguments:{topic:'树海'}}));
});
