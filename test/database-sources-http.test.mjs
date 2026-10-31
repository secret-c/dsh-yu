import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createFakeHost} from './fake-harness.mjs';
import {apply} from '../index.js';
async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-inject-'));
  const host = createFakeHost();
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
  const base = app.httpService.url();
  const code = fs
    .readFileSync(path.join(dataDir, 'pairing-code.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^[A-Z]{4}-\d{4}$/.test(line));
  const state = { app, host, base, dataDir, cookie: null };
  await api(state, 'POST', '/api/pair', { code });
  return state;
}

async function api(state, method, url, body) {
  const response = await fetch(`${state.base}${url.replace(/^\//, '')}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: state.base.replace(/\/$/, ''),
      ...(state.cookie ? { cookie: state.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) state.cookie = setCookie.split(';')[0];
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}


test('HTTP install exposes actual dispatcher, disable/uninstall/restart/clear retain data without routes',async(t)=>{
 const state=await boot();t.after(async()=>{await state.app.stop();fs.rmSync(state.dataDir,{recursive:true});});
 const dbPath=path.join(state.dataDir,'business.sqlite');const db=new DatabaseSync(dbPath);db.exec("CREATE TABLE inventory(name); INSERT INTO inventory VALUES ('one')");db.close();
 const manifest={id:'inventory',name:'Inventory',version:'1',adapter:'sqlite-readonly',config:{path:dbPath}};
 const manifestPath=path.join(state.dataDir,'manifest.json');fs.writeFileSync(manifestPath,JSON.stringify({...manifest,config:{path:'business.sqlite'}}));
 let response=await api(state,'POST','/api/database-sources',{manifestPath});assert.equal(response.status,200);assert.equal(response.body.sources[0].active,true);
 const tools=state.host.ctx.get('tools');const listing=await tools.execute({name:'yu_database_sources',arguments:{}});assert.equal(listing.isError,false);assert.equal(listing.value.sources[0].operations[0].name,'source_inventory_query');
 const call={sourceId:'inventory',operation:'source_inventory_query',arguments:{sql:'SELECT name FROM inventory'}};
 assert.equal((await tools.execute({name:'yu_database_query',arguments:call})).value.rows[0].name,'one');
 assert.equal((await api(state,'POST','/api/database-sources/query',call)).body.rows[0].name,'one');
 const old=state.app.databaseSources.handle('inventory','source_inventory_query');
 assert.equal((await api(state,'PATCH','/api/database-sources/inventory',{enabled:false})).status,200);
 assert.equal((await tools.execute({name:'yu_database_query',arguments:call})).isError,true);await assert.rejects(()=>old({sql:'SELECT 1'}));
 fs.renameSync(dbPath,dbPath+'.closed');fs.renameSync(dbPath+'.closed',dbPath);
 assert.equal((await api(state,'PATCH','/api/database-sources/inventory',{enabled:true})).status,200);
 assert.equal((await api(state,'POST','/api/database-sources',{manifest:{...manifest,id:'unknown',adapter:'unknown'}})).status,400);
 assert.equal((await api(state,'DELETE','/api/database-sources/inventory')).body.filesRetained,true);assert.equal(fs.existsSync(dbPath),true);
 assert.equal((await tools.execute({name:'yu_database_query',arguments:call})).isError,true);
 await state.app.stop();state.host=createFakeHost();state.app=apply(state.host.ctx,{port:0,dataDir:state.dataDir,exposeViaDshWeb:false});await state.app.ready;
  for(const task of state.app.repo.tasks.list().filter(t=>t.kind==='maintenance')) state.app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:state.app.repo.memory.blocks()[0]?.slug}});
 assert.deepEqual(state.app.databaseSources.list(),[]);
 state.app.databaseSources.install(manifest);
 const exported=state.app.configFile.exportText();const config=JSON.parse(exported.text);
 config.settings['tools.databaseSources']=JSON.stringify([{...manifest,id:'bad',adapter:'unknown'}]);
 assert.equal(state.app.configFile.preview({text:JSON.stringify(config)}).ok,false);
 assert.throws(()=>state.app.configFile.apply({text:JSON.stringify(config),confirm:true}));
 assert.equal(state.app.databaseSources.list()[0].active,true);
 state.app.configFile.clear({confirm:true});assert.deepEqual(state.app.databaseSources.list(),[]);assert.equal(fs.existsSync(dbPath),true);
 assert.equal((await state.host.ctx.get('tools').execute({name:'yu_database_query',arguments:call})).isError,true);
});
