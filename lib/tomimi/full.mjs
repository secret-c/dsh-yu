import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStats, compileSpecialMods, EMPTY_STAT_MODS } from './vendor/statHelpers.mts';

const root = process.env.YU_TOMIMI_DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/knowledge/tomimi');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const exists = file => fs.existsSync(path.join(root, file));
const index = read('stage_name_lookup_table.json');
const enemies = read('enemy_database.json');
const source = { repository: 'https://github.com/tanch-p/tomimi-dev', commit: '7c6b9346ae8213be106b7af5ad2534c61b71e79d', algorithm: 'statHelpers.ts and topic stores.js', websiteParity: 'unverified' };
const configs = {
  rogue_phantom: ['ro1','difficulty_mods_phantom.json','relics_phantom.json','mul'],
  rogue_mizuki: ['ro2','difficulty_mods_mizuki.json','relics_mizuki.json','mul'],
  rogue_sami: ['ro3','difficulty_mods_sami.json','relics_sami.json','add'],
  rogue_skz: ['ro4','difficulty_mods_sarkaz.json','relics_sarkaz.json','mul'],
  rogue_yan: ['ro5','difficulty_mods_sui.json','relics_sui.json','mul'],
  rogue_6: ['ro6','difficulty_mods.json','relics_black.json','mul']
};
const aliases = { 萨米:'rogue_sami', 萨卡兹:'rogue_skz', 傀影:'rogue_phantom', 水月:'rogue_mizuki', 岁:'rogue_yan', 黑流树海:'rogue_6' };
const enemyAliases = { 红王:'enemy_2057_smkght', 黄王:'enemy_2058_smlion', 奎隆:'enemy_2089_skzjkl' };
const fail = (code, message, supported={}) => ({ ok:false, error:{ code, message, supported }, source });
const table = topic => read(configs[topic][1]);
const stageRows = [...Object.entries(index).filter(([,v])=>configs[v.topic]).reduce((map,row)=>{
  const id=row[1].topic+':'+row[1].key;
  if(!map.has(id)||row[1].lang==='zh') map.set(id,row);
  return map;
},new Map()).values()];
const levels = topic => table(topic).map(x => x.difficulty);
const group = (key, effects) => ({ key, mods:[effects] });
const effect = values => [{ targets:['ALL'], mods:Object.entries(values).map(([key,value]) => ({key,value,mode:'mul'})) }];
const conditional = (effects, type) => effects.filter(x => !x.conditions || x.conditions.includes(type));

function lookupStage(topic, name, variant) {
  const rows = stageRows.filter(([label,v]) => v.topic===topic && (name===label || name===v.key || name===label.replace(/^ISW-[A-Z]+_/,'')));
  const keys = [...new Set(rows.map(([,v])=>v.key))];
  if (!keys.length) return fail('UNKNOWN_STAGE','主题中没有该关卡。');
  if (keys.length!==1) return fail('AMBIGUOUS_STAGE','名称对应多个关卡，请使用完整键。',{stages:rows.map(([label,v])=>({label,key:v.key}))});
  const file = `${configs[topic][0]}/${keys[0]}.json`;
  if (!exists(file)) return fail('DATA_MISMATCH','官方索引对应的关卡文件缺失。');
  const original=read(file), options=original.data??[original];
  const stage=options.length===1?options[0]:options.find(x=>x.id===variant);
  if (!stage) return fail(variant?'UNKNOWN_VARIANT':'AMBIGUOUS_VARIANT','请指定该关卡版本。',{variants:options.map(x=>({id:x.id,name:x.name_zh}))});
  if(options.length===1&&stage.levelId!==keys[0]) return fail('DATA_MISMATCH','关卡 ID 与官方索引不一致。');
  return {stage,file,label:rows[0][0]};
}
function stageType(stage,topic) {
  if(stage.levelId.includes('_b-')) return 'BATTLE_BOSS';
  if(topic==='rogue_yan'&&stage.levelId.includes('_sv-')) return 'BATTLE_SKY';
  if(topic==='rogue_6'&&stage.tags?.includes('savage')) return 'BATTLE_SAVAGE';
  return '';
}
function floorMod(buff,floor) {
  return effect(typeof buff==='number'?{hp:(1+buff)**floor,atk:(1+buff)**floor}:{hp:buff.hp**floor,atk:buff.atk**floor});
}
function lowMod(topic,d,type) {
  if(topic==='rogue_skz'&&d<=2) return effect({hp:[.8,.85,.9][d]});
  if(topic==='rogue_6'&&d<=3) return effect({hp:[.6,.8,.85,.9][d],atk:[.7,.8,.85,.9][d]});
  if(topic==='rogue_yan') {
    const effects=[];
    if(d<7&&type==='BATTLE_SKY') effects.push(...effect({hp:.5,atk:.75}));
    if(d<=1) effects.push(...effect({hp:[.8,.9][d],atk:[.8,.9][d]}));
    return effects;
  }
  return [];
}
function getEnemy(stage,requested) {
  const matches=stage.enemies.filter(e=>e.id===requested);
  if(!matches.length) matches.push(...stage.enemies.filter(e=>e.prefabKey===requested));
  if(!matches.length) matches.push(...stage.enemies.filter(e=>enemies[e.prefabKey]?.name_zh===requested));
  if(!matches.length) return fail('UNKNOWN_ENEMY','该关卡未列出此敌人。',{enemies:stage.enemies.map(e=>({id:e.id,key:e.prefabKey,name:enemies[e.prefabKey]?.name_zh}))});
  if(new Set(matches.map(e=>e.id+':'+e.prefabKey+':'+e.level)).size>1) return fail('AMBIGUOUS_ENEMY','敌人名称对应多个版本，请给出关卡敌人 ID。',{enemies:matches.map(e=>e.id)});
  const entry=matches[0], template=enemies[entry.prefabKey];
  if(!template?.stats?.[entry.level]) return fail('DATA_MISMATCH','敌人模板缺少关卡指定等级。');
  const enemy=structuredClone(template);
  enemy.stageId=entry.id; enemy.level=entry.level; enemy.stats=structuredClone(template.stats[entry.level]);
  for(const [key,value] of Object.entries(entry.overwrittenData??{})) {
    if(key==='talentBlackboard') {
      for(const ref of value) {
        const traitIndex=enemy.stats.traits.findIndex(x=>x.key===ref.key);
        if(traitIndex!==-1) {enemy.stats.traits.splice(traitIndex,1,ref);continue;}
        let replaced=false;
        for(let i=0;i<(enemy.stats.special?.length??0);i++) {
          const specialIndex=enemy.stats.special[i].findIndex(x=>x.key===ref.key&&i===ref.formIndex);
          if(specialIndex!==-1) {enemy.stats.special[i].splice(specialIndex,1,ref);replaced=true;break;}
        }
        if(!replaced) enemy.stats.traits.push(ref);
      }
    }
    if(key==='levelType') {
      if(value!=='NORMAL') return fail('UNSUPPORTED_OVERRIDE','此敌人的关卡类型覆盖尚未适配。');
      enemy.type=enemy.type.filter(x=>!['BOSS','ELITE'].includes(x));
    } else enemy.stats[key]=value;
  }
  enemy.traits=enemy.stats.traits; enemy.modsList=[];
  return {enemy,entry};
}
function selectedModifiers(topic,ids,type) {
  if(!Array.isArray(ids)||ids.some(x=>typeof x!=='string')||new Set(ids).size!==ids.length) return fail('UNSUPPORTED_MODIFIERS','修正必须是不重复的官方 ID 数组。');
  const relics=configs[topic][2]?read(configs[topic][2]):[];
  const catalogs={
    rogue_phantom:['variations_phantom.json','capsules_phantom.json'],
    rogue_mizuki:['variations_mizuki.json'],
    rogue_sami:['chaos_sami.json'],
    rogue_skz:['disasters_sarkaz.json'],
    rogue_yan:['sui_wrath.json'],
    rogue_6:['weather_black.json']
  };
  const events=catalogs[topic].flatMap(file=>read(file));
  const result=[];
  for(const id of ids) {
    const item=relics.find(x=>x.id===id)??events.find(x=>x.id===id);
    if(!item) return fail('UNSUPPORTED_MODIFIERS','未知或未映射的藏品、事件。',{modifier:id});
    const description=[item.description_zh,item.tooltip_zh,item.desc_zh,item.outerDesc_zh].filter(Boolean).join(' ');
    if(/概率|几率|随机/.test(description)||id==='rogue_3_chaos_4_a'||!Array.isArray(item.effects)||item.stages||item.effects.some(x=>x.probability||x.chance||!Array.isArray(x.targets)||!Array.isArray(x.mods)&&!x.special))
      return fail('UNSUPPORTED_MODIFIERS','此修正需要阶段、条件或概率参数，不能给出唯一面板。',{modifier:id});
    result.push(group(id,conditional(item.effects,type)));
  }
  return result;
}
export function calculate(input) {
  const allowed=['action','topic','stage','variant','enemy','difficulty','floor','mode','modifiers','form'];
  if(Object.keys(input).some(k=>!allowed.includes(k))) return fail('UNSUPPORTED_CONDITIONS','存在未适配参数，不会静默忽略。');
  const topic=aliases[input.topic]??input.topic;
  if(!configs[topic]) return fail('UNKNOWN_TOPIC','不支持该主题。',{topics:Object.keys(configs)});
  const difficulties=levels(topic);
  if(!Number.isInteger(input.difficulty)||!difficulties.includes(input.difficulty)) return fail('UNSUPPORTED_DIFFICULTY','难度不在官方主题表内。',{topic,difficulties});
  const found=lookupStage(topic,input.stage,input.variant); if(found.ok===false) return found;
  const {stage,file,label}=found;
  const floors=stage.floors??[];
  const floor=input.floor===undefined&&floors.length===1?floors[0]:input.floor;
  if(!Number.isInteger(floor)||!floors.includes(floor)) return fail('AMBIGUOUS_FLOOR','请指定该关卡准确层数。',{floors});
  const mode=input.mode??'normal';
  if(!['normal','elite'].includes(mode)||mode==='elite'&&!stage.elite_mods) return fail('UNSUPPORTED_MODE','此关卡不支持该模式。',{modes:stage.elite_mods?['normal','elite']:['normal']});
  const prepared=getEnemy(stage,input.enemy); if(prepared.ok===false) return prepared;
  const {enemy,entry}=prepared, form=input.form??0;
  if(!Number.isInteger(form)||form<0||form>0&&!enemy.stats.form_mods?.[form]) return fail('UNSUPPORTED_FORM','敌人形态序号无效。');
  const type=stageType(stage,topic), chosen=input.modifiers??[];
  const required=[];
  if(topic==='rogue_skz') {
    if(['level_rogue4_b-4-b','level_rogue4_b-5-b'].includes(stage.levelId)) required.push('rogue_4_relic_explore_7');
    if(stage.levelId==='level_rogue4_b-7') required.push('rogue_4_relic_final_6');
  }
  if(topic==='rogue_6') {
    if(stage.levelId==='level_rogue6_b-6') required.push('rogue_6_relic_final_3');
    if(stage.levelId==='level_rogue6_s-1'&&!chosen.some(x=>['rogue_6_relic_final_7','rogue_6_relic_final_9'].includes(x))) required.push('rogue_6_relic_final_7');
  }
  const modifierIds=[...required,...chosen.filter(x=>!required.includes(x))];
  const modifiers=selectedModifiers(topic,modifierIds,type); if(modifiers.ok===false) return modifiers;
  const diffTable=table(topic), selected=diffTable.find(x=>x.difficulty===input.difficulty);
  const applied=diffTable.filter(x=>x.difficulty<=input.difficulty&&x.effects.length);
  if(applied.some(x=>x.effects.some(e=>e.conditions))) return fail('UNSUPPORTED_DIFFICULTY','官方难度档含尚未映射的条件效果。');
  const extra=[];
  if(topic==='rogue_phantom'&&input.difficulty>=10&&(type==='BATTLE_BOSS'||mode==='elite'))
    extra.push(group('N10',effect({atk:1.15})));
  const effectiveFloor=topic==='rogue_6'&&modifierIds.includes('rogue_6_relic_artifact_5')?floor+1:floor;
  const runeEffects=[mode==='elite'?stage.elite_mods:stage.n_mods,stage.all_mods];
  const special=compileSpecialMods(runeEffects,applied.map(x=>x.effects),modifiers.map(x=>x.mods[0]));
  const mods={...EMPTY_STAT_MODS,
    runes:{key:mode==='elite'?'elite_ops':'combat_ops',mods:runeEffects},
    diff:{key:'difficulty',mods:applied.map(x=>x.effects),stackType:configs[topic][3]},
    others:[...extra,...(selected.floorBuff===undefined?[]:[group('floor_diff',floorMod(selected.floorBuff,effectiveFloor))]),group('low_diff',lowMod(topic,input.difficulty,type)),...modifiers]
  };
  const base=parseStats(structuredClone(enemy),EMPTY_STAT_MODS,form,{});
  const final=parseStats(enemy,mods,form,special);
  return {ok:true,topic,stage:{key:label,id:stage.id,levelId:stage.levelId,name:stage.name_zh,variant:stage.id},
    enemy:{key:enemy.key,stageId:entry.id,level:entry.level,name:enemy.name_zh,type:enemy.type,form},
    conditions:{difficulty:input.difficulty,floor,mode,modifiers:chosen,requiredRelics:required},
    rawLevelStats:enemy.stats,base,final,
    appliedDifficulty:applied.map(x=>({difficulty:x.difficulty,description:x.ruleDesc,effects:x.effects})),
    calculation:{floorBuff:selected.floorBuff,effectiveFloor,stackType:configs[topic][3],compiledMods:enemy.modsList.at(-1)},
    source:{...source,stage:file,difficulty:configs[topic][1],enemy:'enemy_database.json',stageIndex:'stage_name_lookup_table.json'},
    scope:'指定关卡、难度、层数、模式及已列修正的面板；未指定的随机事件或额外藏品不计入。'};
}
export function search(input) {
  const q=String(input.query??'').trim().toLowerCase();
  const offset=input.offset??0, limit=input.limit??40;
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)
    return fail('INVALID_PAGINATION','offset 必须为非负整数，limit 必须为 1–100 的整数。');
  const topicMatch=Object.entries(aliases).find(([name])=>q.includes(name.toLowerCase()))
    ??Object.keys(configs).map(key=>[key,key]).find(([key])=>q.includes(key));
  const topic=topicMatch?.[1];
  const remainder=topicMatch?q.replace(topicMatch[0].toLowerCase(),'').trim():q;
  const alias=Object.keys(enemyAliases).find(name=>remainder.includes(name));
  const stageQuery=alias?remainder.replace(alias,'').trim():remainder;
  const enemyQuery=alias??remainder;
  const namedEnemy=alias&&enemyAliases[alias];
  const enemyMatches=Object.entries(enemies).filter(([key,e])=>enemyQuery&&(key.toLowerCase().includes(enemyQuery)||e.name_zh?.toLowerCase().includes(enemyQuery)||key===namedEnemy)).slice(0,30).map(([key,e])=>({key,name:e.name_zh}));
  const enemyKeys=new Set(enemyMatches.map(x=>x.key));
  const matches=stageRows.filter(([label,v])=>{
    if(topic&&v.topic!==topic) return false;
    if(!remainder) return true;
    const stageFound=stageQuery&&(label.toLowerCase().includes(stageQuery)||v.key.toLowerCase().includes(stageQuery));
    if(!alias&&stageFound) return true;
    if(alias&&stageQuery&&!stageFound||!enemyKeys.size) return false;
    const file=`${configs[v.topic][0]}/${v.key}.json`;
    if(!exists(file)) return false;
    const raw=read(file);
    return (raw.data??[raw]).some(stage=>stage.enemies?.some(e=>enemyKeys.has(e.prefabKey)));
  });
  const stages=matches.slice(offset,offset+limit).map(([label,v])=>{
    const raw=read(`${configs[v.topic][0]}/${v.key}.json`), options=raw.data??[raw];
    return {topic:v.topic,stage:label,levelId:v.key,difficulties:levels(v.topic),
      floors:[...new Set(options.flatMap(s=>s.floors??[]))],
      variants:options.length>1?options.map(s=>s.id):undefined};
  });
  return {ok:true,stages,stageCount:matches.length,offset,limit,hasMore:offset+stages.length<matches.length,enemies:enemyMatches,
    topics:Object.fromEntries(Object.keys(configs).map(topic=>[topic,{difficulties:levels(topic),stageFiles:fs.readdirSync(path.join(root,configs[topic][0])).length}])),source};
}
export function scenario(input) {
  const q=String(input.query??'').trim();
  const enemy=q.includes('奎隆')?'enemy_2089_skzjkl':q.includes('红王')?'enemy_2057_smkght':q.includes('黄王')?'enemy_2058_smlion':undefined;
  const topic=enemy==='enemy_2089_skzjkl'?'rogue_skz':enemy?'rogue_sami':Object.entries(aliases).find(([alias])=>q.includes(alias))?.[1];
  if(!enemy||!topic) return fail('UNKNOWN_SCENARIO','自然问句暂需包含可识别敌人；可先检索官方 ID 再结构化计算。');
  const number=/(?:难度\s*|[nN]\s*)(\d+)|(\d+)\s*(?:难|[nN])/.exec(q);
  const difficulty=number?Number(number[1]??number[2]):/最高难度|顶难/.test(q)?Math.max(...levels(topic)):undefined;
  const floor=Number(/第?\s*(\d+)\s*层/.exec(q)?.[1])||undefined;
  const stageName=q.match(/时光之沙|迈入永恒|授法/)?.[0];
  const stage=stageName?`ISW-DF_${stageName}`:enemy==='enemy_2089_skzjkl'?'ISW-DF_授法':undefined;
  if(difficulty===undefined||!stage) return fail('AMBIGUOUS_SCENARIO','请明确难度和关卡；红王出现在多个萨米关卡。',{topic,enemy,stages:enemy==='enemy_2089_skzjkl'?['ISW-DF_授法']:['ISW-DF_时光之沙','ISW-DF_迈入永恒'],difficulties:levels(topic)});
  if(/藏品|事件|坍缩|灾厄|语奇终无/.test(q)) return fail('AMBIGUOUS_SCENARIO','问句含额外修正，请用官方 ID 逐项指定。');
  const result=calculate({topic,stage,enemy,difficulty,floor,mode:'normal',modifiers:[]});
  return result.ok?{...result,scenario:`${topic}_${result.stage.levelId}_d${difficulty}_floor${result.conditions.floor}_normal`,query:q}:result;
}
export const error = fail;
