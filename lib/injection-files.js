import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readSections } from './sections.js';
import { relativeBlockPath } from './memory-files.js';

// All static injection content has one visible UTF-8 file. Metadata stays in
// the registry; neither a stale editor nor a database cache wins over that file.
export function injectionPath(settings, declared) {
  return path.isAbsolute(declared) ? path.normalize(declared) : path.resolve(settings.dataDir || process.cwd(), declared);
}
export function readInjection(settings, section) {
  const declared = section.source?.path;
  if (!declared) return {status:'unmapped',text:'',path:null};
  const resolved = injectionPath(settings, declared);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return {status:'not-a-file',text:'',path:resolved};
    if (stat.size > 2 * 1024 * 1024) return {status:'too-large',text:'',path:resolved};
    return {status:'ok',text:fs.readFileSync(resolved,'utf8'),path:resolved};
  } catch (error) { return {status:error.code === 'ENOENT'?'missing':'unreadable',text:'',path:resolved}; }
}
export function writeInjection(settings, section, text, {expectedHash} = {}) {
  const target = injectionPath(settings, section.source.path);
  const current = readInjection(settings,section);
  const hash = value => createHash('sha256').update(value).digest('hex');
  if (expectedHash && hash(current.text) !== expectedHash) throw Object.assign(new Error('文件已被其他编辑器修改，请重新读取'),{status:409});
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const tmp = `${target}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp,String(text),'utf8'); fs.renameSync(tmp,target); }
  finally { if(fs.existsSync(tmp))fs.unlinkSync(tmp); }
  const result = readInjection(settings,section);
  if (result.status !== 'ok' || result.text !== String(text)) throw new Error('注入文件写入核验失败');
  return result;
}
export const injectionHash = text => createHash('sha256').update(text).digest('hex');

/** Save a set as one edit. Validate every optimistic lock before the first
 * write and restore files if either a later file or the metadata commit fails. */
export function saveInjectionFiles({repo,settings,sections,contents={},hashes={},apply}) {
  const entries = sections.map(s=>s.source?s:{...s,source:{path:`injections/${s.id}.md`,format:'utf8'}});
  const snapshots = new Map();
  for(const section of entries) {
    const current=readInjection(settings,section);
    if(Object.hasOwn(contents,section.id)&&hashes[section.id]&&injectionHash(current.text)!==hashes[section.id])throw Object.assign(new Error('文件已被其他编辑器修改，请重新读取：'+section.title),{status:409});
    snapshots.set(injectionPath(settings,section.source.path),current.status==='missing'?null:current.status==='ok'?current.text:undefined);
  }
  try{return repo.transaction(()=>{
    for(const section of sections)if(section.source&&Object.hasOwn(contents,section.id))writeInjection(settings,section,contents[section.id]);
    return apply();
  });}catch(error){
    for(const [file,text]of snapshots)if(text!==undefined){if(text===null){if(fs.existsSync(file))fs.rmSync(file,{force:true});}else {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,'utf8');}}
    settings.reload();throw error;
  }
}

/** Idempotent compatibility conversion; no file is overwritten on startup. */
export function migrateInjectionFiles({repo,settings}) {
  const {sections} = readSections(settings);
  let changed = false;
  const next = [];
  for (const section of sections) {
    if (section.kind === 'memory' && !section.source) {
      const options = JSON.parse(settings.get('memory.injection') || '{}');
      for (const block of repo.memory.blocks()) {
        const entry = {...section,id:'sec_mem_'+Buffer.from(block.slug).toString('hex'),kind:'custom',
          title:block.name,heading:block.name,order:Math.min(1000,section.order + next.length / 100),
          enabled:section.enabled && block.enabled !== false,legacyMemorySlug:block.slug,
          source:{path:relativeBlockPath(block.slug),format:'utf8'},
          maxChars:options[block.slug]?.maxChars ?? 6000,
          template:options[block.slug]?.template ?? '{{content}}'};
        if (readInjection(settings,entry).status === 'missing') writeInjection(settings,entry,block.content || '');
        next.push(entry);
      }
      changed = true;
      continue;
    }
    if (section.kind !== 'retrieved' && !section.source) {
      section.source = {path:`injections/${section.id}.md`,format:'utf8'};
      const text = section.kind === 'core' ? settings.get('prompt.core') : section.kind === 'rules' ? settings.get('prompt.rules') : section.body;
      if (readInjection(settings,section).status === 'missing') writeInjection(settings,section,text || '');
      delete section.body;
      changed = true;
    }
    next.push(section);
  }
  if(changed)settings.set('prompt.sections',JSON.stringify(next));
  return next;
}

export function renderInjection(section, text) {
  const cap = section.maxChars ?? 14000;
  if(cap === 0)return '';
  const content = text.length > cap ? text.slice(0,cap)+'\n…（已截断）' : text;
  return String(section.template ?? '{{content}}').replace(/{{(content|name|slug|title)}}/g,(_,key)=>key==='content'?content:key==='slug'?section.legacyMemorySlug || section.id:section.title);
}
