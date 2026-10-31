import { createTomimiService } from './tomimi.js';
import { createDocumentTools } from './tools-documents.js';

const output = {schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};

// Trusted, local adapter factories only. A manifest is data, never executable code.
export function createToolPackages({settings,repo,paths,log}) {
  const adapters = {
    calculator: () => ({definitions:[{name:'calculate',description:'有限数值的四则运算；不执行表达式或代码。',parameters:{type:'object',properties:{operator:{type:'string',enum:['add','subtract','multiply','divide']},a:{type:'number'},b:{type:'number'}},required:['operator','a','b'],additionalProperties:false},output,execute:async({operator,a,b})=>{
      if(!Number.isFinite(a)||!Number.isFinite(b))throw new Error('a、b 必须是有限数值');
      if(!['add','subtract','multiply','divide'].includes(operator))throw new Error('未知运算');
      if(operator==='divide' && b===0)throw new Error('不能除以零');
      const value=({add:()=>a+b,subtract:()=>a-b,multiply:()=>a*b,divide:()=>a/b})[operator]();
      if(!Number.isFinite(value))throw new Error('结果超出有限数值范围');return {value};
    }}],close(){}}),
    documents: () => ({definitions:createDocumentTools({repo,settings}).definitions,close(){}}),
    tomimi: m => {
      const service=createTomimiService({settings:{get:key=>key==='tools.tomimiDataDir'?m.config.path:settings.get(key)},paths,log,strictDataPath:true});
      if(!service.status().ok)throw new Error(service.status().note);
      return {definitions:service.definitions,close:()=>service.dispose()};
    },
  };
  const validateManifest=m=>{
    if(!m || !/^[a-z][a-z0-9_]{0,39}$/.test(m.id??'') || typeof m.name!=='string' || !m.name.trim() || typeof m.version!=='string' || !m.version.trim() || !Object.hasOwn(adapters,m.adapter) || (Object.hasOwn(m,'enabled')&&typeof m.enabled!=='boolean'))throw new Error('工具包清单无效：需要唯一 id、name、version、已支持 adapter');
    if(m.config!==undefined && (!m.config || typeof m.config!=='object' || Array.isArray(m.config)))throw new Error('config 必须是对象');
    const config=m.config??{};
    if(Object.keys(config).some(k=>m.adapter!=='tomimi'||k!=='path') || (config.path!==undefined&&typeof config.path!=='string'))throw new Error('此适配器不支持该配置字段');
    return {id:m.id,name:m.name,version:m.version,adapter:m.adapter,config:{...config},enabled:m.enabled!==false};
  };
  const read=()=>JSON.parse(settings.get('tools.packages')||'[]');
  let active=new Map();const diagnostics=new Map();
  const close=entries=>{for(const entry of entries.values()){entry.alive=false;entry.instance.close();}};
  const prepare=(rows,{skipFailed=false,retry=null}={})=>{
    if(!Array.isArray(rows))throw new Error('工具包清单必须是数组');
    const next=new Map(),ids=new Set();
    try {for(const raw of rows){const m=validateManifest(raw);if(ids.has(m.id))throw new Error('工具包 ID 重复');ids.add(m.id);if(skipFailed&&diagnostics.has(m.id)&&m.id!==retry&&JSON.stringify(raw)===diagnostics.get(m.id).manifest)continue;if(m.enabled){const old=active.get(m.id);next.set(m.id,skipFailed&&old?.alive&&JSON.stringify(old.manifest)===JSON.stringify(m)?old:{manifest:m,instance:adapters[m.adapter](m),alive:true});}}return next;}
    catch(error){close(new Map([...next].filter(([id,e])=>active.get(id)!==e)));throw error;}
  };
  const list=()=>read().map(m=>({...m,active:active.has(m.id),diagnostic:diagnostics.get(m.id)?.message??null,operations:active.get(m.id)?.instance.definitions.map(d=>({name:`package_${m.id}_${d.name}`,description:d.description,parameters:d.parameters}))??[]}));
  const commit=(rows,persist=true,retry=null)=>{
    const next=prepare(rows,{skipFailed:persist,retry});
    try{if(persist)settings.set('tools.packages',JSON.stringify(rows.map(validateManifest)));}catch(error){close(new Map([...next].filter(([id,e])=>active.get(id)!==e)));throw error;}
    const old=active;active=next;close(new Map([...old].filter(([id,e])=>next.get(id)!==e)));for(const id of diagnostics.keys())if(!rows.some(m=>m.id===id&&m.enabled!==false)||active.has(id))diagnostics.delete(id);return list();
  };
  const install=raw=>{const m=validateManifest(raw),rows=read();if(rows.some(x=>x.id===m.id))throw new Error('工具包 ID 已存在');const probe=adapters[m.adapter](m);probe.close();return commit([...rows,m]);};
  const setEnabled=(id,enabled)=>{if(typeof enabled!=='boolean')throw new Error('enabled 必须是布尔值');const rows=read();if(!rows.some(x=>x.id===id))throw new Error('工具包不存在');return commit(rows.map(x=>x.id===id?{...x,enabled}:x),true,enabled?id:null);};
  const uninstall=id=>{const rows=read();if(!rows.some(x=>x.id===id))throw new Error('工具包不存在');return commit(rows.filter(x=>x.id!==id));};
  const handle=(id,operation)=>{
    const entry=active.get(id);if(!entry)throw new Error('工具包不存在或已停用');
    const definition=entry.instance.definitions.find(d=>`package_${id}_${d.name}`===operation);if(!definition)throw new Error('未知工具包操作');
    return async args=>{if(!entry.alive||active.get(id)!==entry||!read().some(m=>m.id===id&&m.enabled!==false))throw new Error('工具包已停用或卸载');return definition.execute(args);};
  };
  const execute=({packageId,operation,arguments:args={}})=>handle(packageId,operation)(args);
  const start=()=>{close(active);active=new Map();diagnostics.clear();for(const raw of read())try{const m=validateManifest(raw);if(m.enabled)active.set(m.id,{manifest:m,instance:adapters[m.adapter](m),alive:true});}catch(error){diagnostics.set(raw.id,{message:error.message,manifest:JSON.stringify(raw)});}return list();};
  const migrateLegacy=({alreadyMigrated,markMigrated})=>{
    if(alreadyMigrated)return;const rows=read();
    for(const [id,adapter,enabled] of [['legacy_documents','documents',settings.get('tools.documentsEnabled')!==false&&settings.get('tools.exposure')!=='none'],['legacy_tomimi','tomimi',Boolean(settings.get('tools.tomimiEnabled'))&&settings.get('tools.exposure')==='all']]){
      if(!rows.some(m=>m.id===id))rows.push(validateManifest({id,name:adapter==='tomimi'?'Tomimi（迁移）':'文档检索（迁移）',adapter,version:'1',enabled,config:adapter==='tomimi'?{path:settings.get('tools.tomimiDataDir')||''}:{}}));
    }
    settings.set('tools.packages',JSON.stringify(rows));markMigrated();
  };
  const definitions=[
    {name:'yu_tool_packages',description:'列出可装卸工具包实例、启停状态及每个命名操作的参数。调用前先查列表。',parameters:{type:'object',properties:{},additionalProperties:false},output,execute:async()=>({packages:list()})},
    {name:'yu_tool_call',description:'调用已启用工具包实例。packageId、operation、arguments 取自 yu_tool_packages；停用卸载立即拒绝。',parameters:{type:'object',properties:{packageId:{type:'string'},operation:{type:'string'},arguments:{type:'object',additionalProperties:true}},required:['packageId','operation','arguments'],additionalProperties:false},output,execute},
  ];
  return {list,install,setEnabled,uninstall,handle,execute,start,migrateLegacy,definitions,adapters:Object.keys(adapters),sync:()=>commit(read(),false),validate:rows=>{const probe=prepare(rows);close(probe);},dispose:()=>{close(active);active=new Map();}};
}
