import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {apply} from '../index.js';
import {createFakeHost} from './fake-harness.mjs';
import {persistJournal} from '../lib/journal-output.js';
test('journal runner persists a document and preserves it across archive and retry', async t => {
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'yu-journal-')); const host=createFakeHost();
 const app=apply(host.ctx,{port:0,dataDir,exposeViaDshWeb:false}); await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}}); app.scheduler.stop();
 t.after(async()=>{await app.stop();fs.rmSync(dataDir,{recursive:true,force:true});});
 const task=app.repo.tasks.create({name:'日记',kind:'journal',goal:'CUSTOM_JOURNAL_GOAL',conversationMode:'new',archivePolicy:{mode:'always'}});
 const {run}=app.runner.enqueue(task); const result=await app.runner.waitForRun(run.id);
 assert.equal(result.status,'succeeded'); assert.ok(result.meta.documentSlug);
 const doc=app.repo.documents.get(result.meta.documentSlug); assert.equal(doc.content,result.outputText); assert.match(doc.title,/^\d{4}-\d{2}-\d{2} 日记$/);
 assert.match(host.calls.at(-1).system,/不要编造/); assert.match(host.calls.at(-1).system,/CUSTOM_JOURNAL_GOAL/);
 assert.ok(app.repo.archives.list({limit:10}).some(a=>a.runId===run.id));
 app.repo.documents.update(doc.slug,{content:'手工修改'}); persistJournal({repo:app.repo,run:result,text:'重复'}); assert.equal(app.repo.documents.get(doc.slug).content,'手工修改');
});
test('empty and failed document writes do not report success',()=>{
 assert.throws(()=>persistJournal({repo:{},run:{id:'a'},text:'  '}),/没有正文/);
 assert.throws(()=>persistJournal({repo:{documents:{get:()=>null,upsert:()=>{throw Error('write failed')}}},run:{id:'a'},text:'内容'}),/write failed/);
});
