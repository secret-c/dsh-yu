import fs from 'node:fs';
import path from 'node:path';
import { parseStats, EMPTY_STAT_MODS } from './vendor/statHelpers.mts';

const STAGE_KEY = 'ISW-DF_授法';
const STAGE_FILE = 'ro4/level_rogue4_b-7.json';
const ENEMY_KEY = 'enemy_2089_skzjkl';
const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

export function quilONScenario(data, source, input = {}) {
  const supported = { action: 'scenario', query: '最高难度奎隆', topic: 'rogue_skz', stage: STAGE_KEY, difficulty: 18, floor: 6, mode: 'normal', enemy: ENEMY_KEY, modifiers: [] };
  const allowed = ['action', 'query', 'topic', 'stage', 'difficulty', 'floor', 'mode', 'enemy', 'modifiers'];
  if (Object.keys(input).some(k => !allowed.includes(k)) ||
      (input.topic !== undefined && input.topic !== supported.topic) ||
      (input.stage !== undefined && input.stage !== supported.stage) ||
      (input.difficulty !== undefined && input.difficulty !== 18) ||
      (input.floor !== undefined && input.floor !== 6) ||
      (input.mode !== undefined && input.mode !== 'normal') ||
      (input.enemy !== undefined && input.enemy !== ENEMY_KEY) ||
      (input.modifiers !== undefined && (!Array.isArray(input.modifiers) || input.modifiers.length)))
    return { ok: false, error: { code: 'UNSUPPORTED_CONDITIONS', message: '此场景只支持萨卡兹「授法」第6层普通模式18难度奎隆、无额外运行修正。', supported }, source };
  const query = String(input.query ?? '最高难度奎隆');
  if (!/奎隆|quilon|qui.lon/i.test(query)) return { ok: false, error: { code: 'UNKNOWN_SCENARIO', message: '未找到可核对的场景。', supported }, source };
  const mentionedDifficulties = [...query.matchAll(/难度\s*(\d+)|(\d+)\s*(?:难度|难|[nN])|[nN]\s*(\d+)/g)].map(m => Number(m[1] ?? m[2] ?? m[3]));
  const mentionedFloors = [...query.matchAll(/第\s*(\d+)\s*层|(\d+)\s*层/g)].map(m => Number(m[1] ?? m[2]));
  const hasMaxIntent = /最高难度|难度\s*18|18\s*(?:难|n)|n18|顶难/i.test(query);
  const unexplained = query
    .replace(/奎隆|quilon|qui.lon|授法|ISW-DF/gi, '')
    .replace(/最高难度|顶难|难度\s*18|18\s*(?:难度|难|n)|n18/gi, '')
    .replace(/第\s*6\s*层|6\s*层|普通模式|普通/gi, '')
    .replace(/请问|请|求|给我|看一下|一下|是什么|是怎么样的|怎么样|多少|数值|面板|属性|生命值|血量|血|攻击力|防御力|和|的|是|呢|吗|啊|呀/gi, '')
    .replace(/[\s,，。？?！!：:、（）()]/g, '');
  if (!hasMaxIntent || mentionedDifficulties.some(n => n !== 18) || mentionedFloors.some(n => n !== 6) || unexplained)
    return { ok: false, error: { code: 'AMBIGUOUS_SCENARIO', message: '该问句未唯一指向已验证的普通模式18难度第6层无额外增益场景；请明确或使用可支持的场景。', supported }, source };
  const stage = read(data, STAGE_FILE);
  const database = read(data, 'enemy_database.json');
  const table = read(data, 'difficulty_mods_sarkaz.json');
  const relics = read(data, 'relics_sarkaz.json');
  const index = read(data, 'stage_name_lookup_table.json');
  if (index[STAGE_KEY]?.key !== stage.levelId || index[STAGE_KEY]?.topic !== 'rogue_skz' ||
      stage.floors?.length !== 1 || stage.floors[0] !== 6 ||
      stage.n_mods !== null || stage.elite_mods !== null ||
      table[18]?.difficulty !== 18 || table[18]?.floorBuff !== 0.22)
    return { ok: false, error: { code: 'DATA_MISMATCH', message: '固定场景数据与已验证规则不一致。' }, source };
  const entry = stage.enemies.find(e => e.id === ENEMY_KEY && e.prefabKey === ENEMY_KEY);
  const template = database[ENEMY_KEY];
  if (!entry || !template?.stats?.[entry.level] || entry.overwrittenData)
    return { ok: false, error: { code: 'DATA_MISMATCH', message: '关卡敌人定义不符。' }, source };
  const makeEnemy = () => ({ ...structuredClone(template), stageId: entry.id, level: entry.level, stats: structuredClone(template.stats[entry.level]), traits: template.stats[entry.level].traits, modsList: [] });
  const applied = table.filter(x => x.difficulty <= 18);
  const requiredRelic = relics.find(x => x.id === 'rogue_4_relic_final_6');
  if (!requiredRelic?.effects?.length) return { ok: false, error: { code: 'DATA_MISMATCH', message: '授法必需藏品数据缺失。' }, source };
  const floorMultiplier = (1 + table[18].floorBuff) ** 6;
  const floorEffects = [{ targets: ['ALL'], mods: ['hp', 'atk'].map(key => ({ key, value: floorMultiplier, mode: 'mul' })) }];
  const mods = {
    ...EMPTY_STAT_MODS,
    runes: { key: 'combat_ops', mods: [null, stage.all_mods] },
    diff: { key: 'difficulty', mods: applied.map(x => x.effects).filter(x => x.length), stackType: 'mul' },
    others: [{ key: 'floor_diff', mods: [floorEffects] }, { key: 'low_diff', mods: [null] }, { key: 'sarkaz_disaster', mods: [] }, { key: requiredRelic.id, mods: [requiredRelic.effects] }]
  };
  const base = parseStats(makeEnemy(), EMPTY_STAT_MODS, 0, {});
  const enemy = makeEnemy();
  const final = parseStats(enemy, mods, 0, {});
  const compiledMods = enemy.modsList.at(-1);
  const group = key => compiledMods.find(x => x.key === key)?.mods ?? [];
  const value = (key, stat) => group(key).find(x => x.key === stat)?.value;
  return { ok: true, scenario: 'quilon_sarkaz_d18_floor6_normal', query, stage: { key: STAGE_KEY, id: stage.id, levelId: stage.levelId, name: stage.name_zh }, enemy: { key: ENEMY_KEY, stageId: entry.id, name: template.name_zh, level: entry.level }, conditions: { topic: 'rogue_skz', mode: 'normal', difficulty: 18, floor: 6, modifiers: [], requiredRelics: [requiredRelic.id], optionalRelics: [], disasters: [] }, base, final, calculation: { stageMultiplier: { hp: value('combat_ops', 'hp'), atk: value('combat_ops', 'atk'), def: value('combat_ops', 'def') }, difficultyMultiplier: { hp: value('difficulty', 'hp'), atk: value('difficulty', 'atk'), dmgRes: value('difficulty', 'dmg_res') }, floorBuff: table[18].floorBuff, floorMultiplier, requiredRelic: { id: requiredRelic.id, name: requiredRelic.name_zh, hp: value(requiredRelic.id, 'hp') }, compiledMods }, source: { ...source, stage: STAGE_FILE, requiredRelic: 'relics_sarkaz.json', websiteParity: 'unverified' }, scope: '固定关卡、难度和层数且自动计入必需藏品的面板；额外藏品、灾厄、临时战斗增益可能改变数值，不能宣称绝对最大值。' };
}
