import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabaseSources } from '../lib/database-sources.js';
test('independent sources validate, query, detach and retain files', async ()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-sources-')); const paths=['a','b'].map(x=>path.join(dir,x+'.db'));
 for(const [i,p] of paths.entries()){const db=new DatabaseSync(p);db.exec(`CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (${i+1})`);db.close();}
 let state='[]'; const settings={get:()=>state,set:(_k,v)=>{state=v;}};const defs=new Map(); const registry={schemas:()=>[...defs.values()],register(d){if(defs.has(d.name))throw Error('collision');defs.set(d.name,d);return ()=>defs.delete(d.name);}};
 const manager=createDatabaseSources({settings});manager.attach(registry);
 const manifest=(id,p)=>({id,name:id,version:'1',adapter:'sqlite-readonly',config:{path:p}});
 manager.install(manifest('a',paths[0])); manager.install(manifest('b',paths[1]));
 const old=manager.handle('a','source_a_query');assert.equal((await old({sql:'SELECT n FROM t'})).rows[0].n,1);assert.equal((await manager.execute({sourceId:'b',operation:'source_b_query',arguments:{sql:'SELECT n FROM t'}})).rows[0].n,2);
 await assert.rejects(()=>old({sql:'ATTACH DATABASE :memory: AS x'}));
 assert.throws(()=>manager.install({...manifest('c',paths[0]),adapter:'unknown'}));assert.throws(()=>manager.install({...manifest('c',paths[0]),adapter:'arknights'}));assert.throws(()=>manager.install(manifest('c',path.join(dir,'missing'))));assert.equal(manager.list().length,2);
 manager.setEnabled('a',false);assert.equal(manager.list().find(x=>x.id==='a')?.active ?? false,false);await assert.rejects(()=>old({sql:'SELECT 1'}));fs.renameSync(paths[0],paths[0]+'.renamed');manager.uninstall('a');assert.equal(fs.existsSync(paths[0]+'.renamed'),true);
 manager.dispose();const again=createDatabaseSources({settings});again.attach(registry);assert.equal(defs.has('source_a_query'),false);assert.equal(again.list().find(x=>x.id==='b').active,true);again.dispose();fs.rmSync(dir,{recursive:true});
});

test('failed sync preserves every previously active route and handle',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-sync-'));const file=path.join(dir,'ok.db');const db=new DatabaseSync(file);db.exec('CREATE TABLE t(n)');db.close();
 let state='[]';const manager=createDatabaseSources({settings:{get:()=>state,set:(_k,v)=>state=v}});
 manager.install({id:'a',name:'A',version:'1',adapter:'sqlite-readonly',config:{path:file}});
 const old=manager.handle('a','source_a_query');const previous=state;
 state=JSON.stringify([...JSON.parse(state),{id:'broken',name:'bad',version:'1',adapter:'sqlite-readonly',config:{path:path.join(dir,'missing')}}]);
 assert.throws(()=>manager.sync());assert.equal((await old({sql:'SELECT 7 AS n'})).rows[0].n,7);
 state=previous;manager.dispose();fs.rmSync(dir,{recursive:true});
});

test('missing sources degrade startup without blocking management or healthy sources',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-degraded-'));const file=path.join(dir,'ok.sqlite');const db=new DatabaseSync(file);db.exec('CREATE TABLE t(n)');db.close();
 const m=(id,p)=>({id,name:id,version:'1',adapter:'sqlite-readonly',config:{path:p},enabled:true});
 let state=JSON.stringify([m('ok',file),m('bad',path.join(dir,'missing')),m('badtoo',path.join(dir,'missing2'))]);
 const manager=createDatabaseSources({settings:{get:()=>state,set:(_k,v)=>state=v}});manager.start();
 assert.equal(manager.list().find(s=>s.id==='ok').active,true);assert.ok(manager.list().find(s=>s.id==='bad').diagnostic);
 manager.setEnabled('bad',false);manager.uninstall('badtoo');assert.equal((await manager.execute({sourceId:'ok',operation:'source_ok_query',arguments:{sql:'SELECT 1 n'}})).rows[0].n,1);
 manager.dispose();fs.rmSync(dir,{recursive:true});
});

test('explicit legacy path migrates once and uninstall cannot revive it',()=>{
 const values={'tools.databaseSources':'[]','tools.knowledgeDbPath':'E:/offline/legacy.sqlite','tools.arknightsEnabled':true};
 const manager=createDatabaseSources({settings:{get:k=>values[k],set:(k,v)=>values[k]=v}});let sentinel=false;
 const migration=()=>manager.migrateLegacy({alreadyMigrated:sentinel,markMigrated:()=>sentinel=true});
 migration();manager.start();assert.equal(manager.list()[0].enabled,true);assert.ok(manager.list()[0].diagnostic);
 manager.uninstall('legacy_arknights');migration();assert.deepEqual(manager.list(),[]);manager.dispose();
});
