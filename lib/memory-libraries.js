import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { searchMemories, tokenize } from './memories.js';

const tables = ['memories','memory_documents','memory_edges'];
const keys = {memories:['id'],memory_documents:['id'],memory_edges:['a_id','b_id','kind']};
const hash = row => createHash('sha256').update(JSON.stringify(row)).digest('hex');
const readJson = (value,fallback) => {try{return JSON.parse(value ?? 'null') ?? fallback;}catch{return fallback;}};
function documentHits(raw,{table,textColumn,fields,query,limit}) {
  const terms=[...new Set([...String(query).trim().split(/\s+/).filter(t=>t.length>=2),...tokenize(query)])].slice(0,12);
  if(!terms.length)return [];
  const likes=terms.flatMap(t=>['%'+t+'%','%'+t+'%']);
  const score=terms.map(()=>`(CASE WHEN title LIKE ? THEN 5 ELSE 0 END + CASE WHEN "${textColumn}" LIKE ? THEN 1 ELSE 0 END)`).join('+');
  return raw.prepare(`SELECT ${fields},"${textColumn}" AS text,(${score}) AS score FROM ${table} WHERE ${terms.map(()=>`(title LIKE ? OR "${textColumn}" LIKE ?)`).join(' OR ')} ORDER BY score DESC LIMIT ?`).all(...likes,...likes,limit).map(row=>{
    const full=String(row.text??''),lower=full.toLowerCase();
    const term=[...terms].sort((a,b)=>b.length-a.length).find(t=>lower.includes(t.toLowerCase()));
    const start=Math.max(0,(term?lower.indexOf(term.toLowerCase()):0)-240);
    return {...row,text:(start?'…':'')+full.slice(start,start+1600)+(full.length>start+1600?'…':'')};
  });
}

/** A single catalog over owned rows and explicitly mounted read-only adapters.
 * Policies affect retrieval/automatic writes; manual edits remain user actions. */
export function createMemoryLibraries({db,repo,settings,databaseSources}) {
  const policies=()=>readJson(db.getMeta('memory.libraries.policies'),{});
  const batches=()=>readJson(db.getMeta('memory.libraries.batches'),[]);
  const policy=id=>({enabled:true,retrieval:true,autoWrite:id==='personal',...policies()[id]});
  const contexts=()=>repo.contexts.list();
  const usage=id=>contexts().filter(c=>(c.config?.databaseSearch?.libraryIds ?? ['personal']).includes(id)).map(c=>({id:c.id,name:c.name,retrievalEnabled:c.config?.databaseSearch?.enabled!==false}));
  const list=()=>{
    const p=policy('personal');
    return [{id:'personal',name:'个人长期记忆',adapter:'owned',...p,readOnly:false,status:p.enabled?'ready':'disabled',path:db.file,counts:{memories:db.get('SELECT count(*) n FROM memories').n,edges:db.get('SELECT count(*) n FROM memory_edges').n,documents:db.get('SELECT count(*) n FROM memory_documents').n},usage:usage('personal')},...databaseSources.list().map(s=>{
      const id='source:'+s.id,p=policy(id); let counts={};
      {let external;try{external=new DatabaseSync(s.config.path,{readOnly:true});for(const [key,table] of Object.entries({documents:'documents',entities:'entities',sources:'sources'})) if(external.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))counts[key]=external.prepare(`SELECT count(*) n FROM "${table}"`).get().n;}catch{}finally{external?.close();}}
      return {id,name:s.name,adapter:s.adapter,...p,enabled:s.enabled,readOnly:true,autoWrite:false,retrieval:s.adapter==='arknights'&&p.retrieval,retrievalSupported:s.adapter==='arknights',status:s.diagnostic?'error':s.active?'ready':'disabled',diagnostic:s.diagnostic,path:s.config.path,counts,usage:usage(id)};
    })];
  };
  const search=({query,libraryIds=['personal'],limit=6}={})=>{
    if(!Array.isArray(libraryIds))throw new Error('libraryIds 必须是数组');
    const max=Math.max(0,Math.min(30,Number(limit)||0)); if(!max || !String(query??'').trim())return [];
    const hits=[];
    for(const library of list().filter(l=>libraryIds.includes(l.id)&&l.enabled&&l.retrieval&&l.status==='ready')) {
      if(library.id==='personal') {
        hits.push(...searchMemories(repo,{query,limit:max,searchPool:settings.get('memory.db.searchPool')}).map(r=>({...r,libraryId:library.id,libraryName:library.name})));
        for(const d of documentHits(db.raw,{table:'memory_documents',textColumn:'content',fields:'id,title,updated_at,source',query,limit:max})) hits.push({...d,kind:'document',subject:d.title,lastSeenAt:d.updated_at,libraryId:library.id,libraryName:library.name});
      } else if(library.adapter==='arknights') {
        const sourceId=library.id.slice(7), external=new DatabaseSync(library.path,{readOnly:true});
        try {
          const rows=documentHits(external,{table:'documents',textColumn:'text',fields:'id,title,locator,url',query,limit:max});
          hits.push(...rows.map(r=>({...r,id:`${sourceId}:${r.id}`,kind:'document',subject:r.title,lastSeenAt:0,source:r.locator,libraryId:library.id,libraryName:library.name})));
        } finally {external.close();}
      }
    }
    return hits.sort((a,b)=>b.score-a.score).slice(0,max);
  };
  function inspect(file) {
    const resolved=path.resolve(String(file??''));
    if(!fs.statSync(resolved).isFile())throw new Error('请选择本地文件');
    if(/\.json$/i.test(resolved)) {
      const manifest=JSON.parse(fs.readFileSync(resolved,'utf8'));
      if(manifest.config?.path&&!path.isAbsolute(manifest.config.path))manifest.config.path=path.resolve(path.dirname(resolved),manifest.config.path);
      const existing=databaseSources.list().find(s=>s.id===manifest.id);
      if(existing && (existing.adapter!==manifest.adapter || path.resolve(existing.config.path)!==path.resolve(manifest.config.path)))throw new Error('同名库指向不同资料，已保留原库');
      databaseSources.validate(existing?[]:[manifest]);
      return {type:'reference',path:resolved,manifest,existing:!!existing,conflicts:[],counts:{}};
    }
    const source=new DatabaseSync(resolved,{readOnly:true});
    try {
      const rows={},added={},skipped={},conflicts=[];
      for(const table of tables) {
        const columns=db.all(`PRAGMA table_info(${table})`).map(r=>r.name);
        rows[table]=source.prepare(`SELECT ${columns.map(c=>'"'+c+'"').join(',')} FROM "${table}"`).all();
        added[table]=[];skipped[table]=0;
        const seenKeys=new Set(),seenSlugs=new Set();
        for(const row of rows[table]) {
          if(keys[table].some(k=>typeof row[k]!=='string'||!row[k].trim()))throw new Error(`${table} 存在空或非文本主键，未导入任何记录`);
          const key=JSON.stringify(keys[table].map(k=>row[k]));if(seenKeys.has(key))throw new Error(`${table} 存在重复主键，未导入任何记录`);seenKeys.add(key);
          if(table==='memory_documents'){if(typeof row.slug!=='string'||!row.slug.trim()||seenSlugs.has(row.slug))throw new Error('文档 slug 为空或重复，未导入任何记录');seenSlugs.add(row.slug);}
          const where=keys[table].map(k=>`"${k}"=?`).join(' AND ');
          const old=db.get(`SELECT * FROM ${table} WHERE ${where}`,...keys[table].map(k=>row[k]));
          const slug=table==='memory_documents'?db.get('SELECT id FROM memory_documents WHERE slug=?',row.slug):null;
          if(old) {if(hash(old)===hash(row))skipped[table]++;else conflicts.push({table,key:keys[table].map(k=>row[k]),reason:'同 ID 内容不同'});}
          else if(slug)conflicts.push({table,key:row.id,reason:'slug 已被其它文档使用'});
          else added[table].push(row);
        }
      }
      const ids=new Set([...db.all('SELECT id FROM memories').map(r=>r.id),...added.memories.map(r=>r.id)]);
      const conflictingIds=new Set(conflicts.filter(c=>c.table==='memories').map(c=>c.key[0]));
      added.memory_edges=added.memory_edges.filter(r=>{if(ids.has(r.a_id)&&ids.has(r.b_id)&&!conflictingIds.has(r.a_id)&&!conflictingIds.has(r.b_id))return true;conflicts.push({table:'memory_edges',key:[r.a_id,r.b_id,r.kind],reason:'关系端点缺失或内容冲突'});return false;});
      const referenceWarnings={missingMergedInto:0,externalArchiveReferences:0};
      for(const row of added.memories){if(row.merged_into&&!ids.has(row.merged_into))referenceWarnings.missingMergedInto++;if(row.source_archive_id&&!db.get('SELECT id FROM archives WHERE id=?',row.source_archive_id))referenceWarnings.externalArchiveReferences++;}
      return {type:'owned',path:resolved,rows:added,counts:Object.fromEntries(tables.map(t=>[t,rows[t].length])),added:Object.fromEntries(tables.map(t=>[t,added[t].length])),skipped,conflicts,referenceWarnings};
    } finally {source.close();}
  }
  const preview=file=>{const {rows,manifest,...result}=inspect(file);return {...result,...(manifest?{name:manifest.name,libraryId:'source:'+manifest.id}:{libraryId:'personal'})};};
  const importFile=async file=>{
    const plan=inspect(file);
    if(plan.type==='reference'){if(!plan.existing)databaseSources.install(plan.manifest);return {...preview(file),alreadyInstalled:plan.existing,filesRetained:true,libraries:list()};}
    const count=Object.values(plan.added).reduce((a,b)=>a+b,0);
    let backupPath=null,batchId=null;
    if(count) {
      backupPath=db.file+'.before-library-import-'+Date.now()+'.sqlite3';await backup(db.raw,backupPath);
      db.tx(()=>{
        // Re-plan inside the write lock: concurrent imports cannot overwrite rows.
        const current=inspect(file);batchId=randomUUID();
        for(const table of tables)for(const row of current.rows[table]){const cols=Object.keys(row);db.run(`INSERT INTO ${table} (${cols.map(c=>'"'+c+'"').join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,...cols.map(c=>row[c]));}
        const entries=tables.flatMap(table=>current.rows[table].map(row=>({table,key:keys[table].map(k=>row[k]),hash:hash(row)})));
        db.setMeta('memory.libraries.batches',JSON.stringify([...batches(),{id:batchId,at:Date.now(),path:plan.path,entries}]));
      });
    }
    return {...preview(file),added:plan.added,skipped:plan.skipped,conflicts:plan.conflicts,referenceWarnings:plan.referenceWarnings,batchId,backupPath,libraryId:'personal',libraries:list()};
  };
  const update=(id,changes)=>{
    const library=list().find(l=>l.id===id);if(!library)throw new Error('库不存在');
    const accepted={};for(const k of ['enabled','retrieval','autoWrite'])if(Object.hasOwn(changes,k)){if(typeof changes[k]!=='boolean')throw new Error(k+' 必须是布尔值');accepted[k]=changes[k];}
    if(library.readOnly&&accepted.autoWrite)throw new Error('此资料库只读，不支持自动写入');
    if(changes.retrieval===true&&library.retrievalSupported===false)throw new Error('此适配器目前只支持高级查询，尚不支持自动检索');
    if(changes.path!==undefined){if(!id.startsWith('source:'))throw new Error('个人记录位置由应用数据目录管理');const source=databaseSources.list().find(s=>s.id===id.slice(7));databaseSources.update(source.id,{config:{...source.config,path:path.resolve(String(changes.path))}});}
    if(id.startsWith('source:')&&accepted.enabled!==undefined)databaseSources.setEnabled(id.slice(7),accepted.enabled);
    db.setMeta('memory.libraries.policies',JSON.stringify({...policies(),[id]:{...policy(id),...accepted}}));return {libraries:list()};
  };
  const remove=id=>{if(id==='personal')return {...update(id,{enabled:false,retrieval:false,autoWrite:false}),filesRetained:true,note:'个人记录已保留，重新启用可恢复使用'};databaseSources.uninstall(id.slice(7));return {libraries:list(),filesRetained:true};};
  const undo=batchId=>db.tx(()=>{
    const batch=batches().find(b=>b.id===batchId);if(!batch)throw new Error('导入批次不存在');
    const deleted={},preserved=[];
    const removable=new Set(batch.entries.filter(e=>e.table==='memories').filter(e=>{const row=db.get('SELECT * FROM memories WHERE id=?',e.key[0]);return row&&hash(row)===e.hash;}).map(e=>e.key[0]));
    const removableEdges=new Set(batch.entries.filter(e=>e.table==='memory_edges').filter(e=>{const row=db.get('SELECT * FROM memory_edges WHERE a_id=? AND b_id=? AND kind=?',...e.key);return row&&hash(row)===e.hash;}).map(e=>JSON.stringify(e.key)));
    for(const id of removable)if(db.all('SELECT * FROM memory_edges WHERE a_id=? OR b_id=?',id,id).some(r=>!removableEdges.has(JSON.stringify([r.a_id,r.b_id,r.kind]))))removable.delete(id);
    let changed=true;while(changed){changed=false;for(const id of removable){if(db.all('SELECT id FROM memories WHERE merged_into=?',id).some(r=>!removable.has(r.id))){removable.delete(id);changed=true;}}}
    for(const table of [...tables].reverse())for(const entry of batch.entries.filter(e=>e.table===table)) {
      const where=keys[table].map(k=>`"${k}"=?`).join(' AND '),row=db.get(`SELECT * FROM ${table} WHERE ${where}`,...entry.key);
      if(!row)continue;if(hash(row)!==entry.hash){preserved.push(entry);continue;}
      if(table==='memories'&&(!removable.has(row.id)||db.get('SELECT 1 FROM memory_edges WHERE a_id=? OR b_id=?',row.id,row.id))){preserved.push(entry);continue;}
      db.run(`DELETE FROM ${table} WHERE ${where}`,...entry.key);deleted[table]=(deleted[table]??0)+1;
    }
    db.setMeta('memory.libraries.batches',JSON.stringify(batches().filter(b=>b.id!==batchId)));return {deleted,preserved};
  });
  return {list,search,preview,importFile,update,remove,undo,contexts:()=>contexts().map(c=>({id:c.id,name:c.name})),personalEnabled:()=>policy('personal').enabled,canAutoWrite:()=>policy('personal').enabled&&policy('personal').autoWrite};
}
