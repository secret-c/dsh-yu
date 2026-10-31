import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createKnowledgeTools } from './tools-knowledge.js';

// Adapter contract: open(manifest) validates and returns {definitions, close}.
// New formats must be explicitly added to this registry; manifests never execute code.
const adapters = {
  'sqlite-readonly': (manifest) => {
    const db = open(manifest.config.path);
    const definitions = [{
      name: `source_${manifest.id}_query`,
      description: `只读查询数据源 ${manifest.name}。使用单条 SELECT；sqlite_schema 可查看表结构。`,
      parameters: { type:'object', properties:{ sql:{type:'string'}, params:{type:'array',items:{type:['string','number','null']}} }, required:['sql'], additionalProperties:false },
      output: { schema:{type:'object',additionalProperties:true}, render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}] },
      execute: async ({sql,params=[]}) => {
        if (typeof sql !== 'string' || !/^\s*select\b/i.test(sql) || /;|--|\/\*|\b(attach|detach|pragma|insert|update|delete|replace|create|drop|alter|vacuum|reindex|load_extension)\b/i.test(sql)) throw new Error('仅允许单条只读 SELECT');
        if (!Array.isArray(params)) throw new Error('params 必须是数组');
        const rows=[];for(const row of db.prepare(sql).iterate(...params)){rows.push(row);if(rows.length>=1000)break;}return {rows};
      },
    }];
    return { definitions, close:()=>db.close() };
  },
  arknights: (manifest) => {
    const db = open(manifest.config.path);
    try {
      const columns={entities:'id,name,kind,corpus',aliases:'alias,entity_id',documents:'id,corpus,title,locator,evidence_type,event_date,url,text',sources:'id,path,sha256,kind,bytes,metadata',skill_refs:'character_id,skill_index,skill_id,form,source_id,locator',skill_levels:'skill_id,level,payload,source_id,locator'};
      for(const [table,fields] of Object.entries(columns)) db.prepare(`SELECT ${fields} FROM "${table}" LIMIT 0`).all();
      // Older corpora may omit these optional capabilities; their tools report that absence.
      for(const [table,fields] of Object.entries({document_entities:'document_id,entity_id,role',relic_effects:'topic,relic_id,relic_name,phase,mode,trigger,amount,scope,note,damage_type,attribute'})) {
        if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))db.prepare(`SELECT ${fields} FROM "${table}" LIMIT 0`).all();
      }
      const knowledge = createKnowledgeTools({ dbProvider:()=>db });
      return { definitions:knowledge.definitions.map(d=>({...d,name:`source_${manifest.id}_${d.name}`})), close:()=>db.close() };
    } catch (error) { db.close(); throw error; }
  },
};
function open(file) {
  if (typeof file !== 'string' || !file.trim() || !fs.statSync(file).isFile()) throw new Error('数据库路径无效');
  const db = new DatabaseSync(file, {readOnly:true});
  try { db.exec('PRAGMA query_only = ON'); db.prepare('SELECT name FROM sqlite_schema LIMIT 1').all(); return db; }
  catch (error) { db.close(); throw error; }
}
function validate(m) {
  if (!m || typeof m !== 'object' || !/^[a-z][a-z0-9_]{0,39}$/.test(m.id || '') || typeof m.name !== 'string' || !m.name.trim() || typeof m.version !== 'string' || !m.version.trim() || !m.config || (typeof m.config.path !== 'string' || !m.config.path.trim()) || (Object.hasOwn(m,'enabled') && typeof m.enabled!=='boolean')) throw new Error('数据源清单无效（需要 id、name、version、adapter 和 config.path）');
  if (!Object.hasOwn(adapters,m.adapter)) throw new Error(`未知数据源适配器: ${m.adapter}`);
  return {id:m.id,name:m.name,version:m.version,adapter:m.adapter,config:{path:path.resolve(m.config.path)},enabled: m.enabled !== false};
}
export function createDatabaseSources({settings}) {
  let active = new Map();
  const diagnostics = new Map();
  const read = () => JSON.parse(settings.get('tools.databaseSources') || '[]');
  const save = rows => settings.set('tools.databaseSources',JSON.stringify(rows));
  const prepare = (rows,{skipFailed=false,retry=null}={}) => {
    if(!Array.isArray(rows)) throw new Error('数据源清单必须是数组');
    const next=new Map(), ids=new Set();
    try {
      for(const raw of rows) {
        const m=validate(raw); if(ids.has(m.id))throw new Error('数据源 ID 重复'); ids.add(m.id);
        if(skipFailed && diagnostics.has(m.id) && m.id!==retry && JSON.stringify(m)===diagnostics.get(m.id).manifest) continue;
        if(m.enabled) {const instance=adapters[m.adapter](m);next.set(m.id,{manifest:m,instance,alive:true});}
      }
      return next;
    } catch(error) { for(const e of next.values())e.instance.close(); throw error; }
  };
  const close = entries => {for(const e of entries.values()){e.alive=false;e.instance.close();}};
  const commit = (rows,persist=true,retry=null) => {
    const next=prepare(rows,{skipFailed:persist,retry});
    try {if(persist)save(rows.map(validate));} catch(error){close(next);throw error;}
    const old=active; active=next; close(old);
    for(const id of diagnostics.keys())if(!rows.some(m=>m.id===id && m.enabled!==false) || active.has(id))diagnostics.delete(id);
    return list();
  };
  const list = () => read().map(m=>({...m,active:active.has(m.id),diagnostic:diagnostics.get(m.id)?.message ?? null,operations:active.get(m.id)?.instance.definitions.map(d=>({name:d.name,description:d.description,parameters:d.parameters})) ?? []}));
  const install = manifest => {const m=validate(manifest),rows=read();if(!m.enabled){const probe=adapters[m.adapter](m);probe.close();}if(rows.some(x=>x.id===m.id))throw new Error('数据源 ID 已存在');return commit([...rows,m]);};
  const setEnabled = (id,enabled) => {if(typeof enabled!=='boolean')throw new Error('enabled 必须是布尔值');const rows=read();if(!rows.some(x=>x.id===id))throw new Error('数据源不存在');return commit(rows.map(x=>x.id===id?{...x,enabled}:x),true,enabled?id:null);};
  const uninstall = id => {const rows=read();if(!rows.some(x=>x.id===id))throw new Error('数据源不存在');return commit(rows.filter(x=>x.id!==id));};
  const update = (id,changes) => {const rows=read();if(!rows.some(x=>x.id===id))throw new Error('数据源不存在');return commit(rows.map(x=>x.id===id?validate({...x,...changes,id}):x),true,id);};
  const migrateLegacy = ({alreadyMigrated=false,markMigrated=()=>{}}={}) => {
    if(alreadyMigrated)return;
    const file=String(settings.get('tools.knowledgeDbPath') ?? '').trim();
    if(file){
      const rows=read();let id='legacy_arknights';let n=1;while(rows.some(m=>m.id===id))id='legacy_arknights_'+n++;
      save([...rows,validate({id,name:'明日方舟（迁移）',version:'1',adapter:'arknights',config:{path:file},enabled:Boolean(settings.get('tools.arknightsEnabled'))})]);
    }
    markMigrated();
  };
  const sync = () => commit(read(),false);
  const start = () => {
    close(active);active=new Map();diagnostics.clear();
    for(const raw of read()) {
      try {const m=validate(raw);if(m.enabled){const instance=adapters[m.adapter](m);active.set(m.id,{manifest:m,instance,alive:true});}}
      catch(error){diagnostics.set(raw.id,{message:error.message,manifest:JSON.stringify(raw)});}
    }
    return list();
  };
  const handle = (id,operation) => {
    const entry=active.get(id);if(!entry)throw new Error('数据源不存在或已停用');
    const definition=entry.instance.definitions.find(d=>d.name===operation);if(!definition)throw new Error('未知数据源操作');
    return async args=>{if(!entry.alive || active.get(id)!==entry || !read().some(m=>m.id===id && m.enabled!==false))throw new Error('数据源已停用');return definition.execute(args);};
  };
  const execute = ({sourceId,operation,arguments:args={}}) => handle(sourceId,operation)(args);
  const render=(_args,value)=>[{type:'text',text:JSON.stringify(value)}];
  const definitions=[
    {name:'yu_database_sources',description:'列出已安装数据库及启用状态。启用来源包含可调用操作名及参数schema；查询前先调用此工具。',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render},execute:async()=>({sources:list()})},
    {name:'yu_database_query',description:'调用已启用数据库操作。sourceId、operation与arguments格式来自 yu_database_sources。停用或卸载立即拒绝查询。',parameters:{type:'object',properties:{sourceId:{type:'string'},operation:{type:'string'},arguments:{type:'object',additionalProperties:true}},required:['sourceId','operation','arguments'],additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render},execute},
  ];
  return {list,install,setEnabled,uninstall,update,sync,migrateLegacy,start,execute,handle,definitions,validate:rows=>{const probe=prepare(rows);close(probe);},attach(){sync();},dispose(){close(active);active=new Map();}};
}
