import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createFakeHost} from './fake-harness.mjs';
import {apply} from '../index.js';
import {createToolPackages} from '../lib/tool-packages.js';
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


test('conversation card saves atomically and never persists unrelated task drafts', async t => {
 const s=await boot();t.after(async()=>{await s.app.stop();fs.rmSync(s.dataDir,{recursive:true});});
 const task=s.app.repo.tasks.create({name:'Task',goal:'Original',conversationMode:'new',archivePolicy:{conversation:'on-success'}});
 const route='/api/tasks/'+task.id+'/conversation';
 const body={mode:'fixed',title:'Daily chat',continuity:true,archive:'keep',goal:'Must not persist'};
 const result=await api(s,'PATCH',route,body);assert.equal(result.status,200);
 const bound=s.app.repo.tasks.get(task.id);assert.equal(bound.goal,'Original');assert.equal(bound.conversationMode,'reuse');
 assert.equal(s.app.repo.conversations.get(bound.conversationId).title,'Daily chat');assert.equal(s.app.repo.conversations.get(bound.conversationId).meta.continuity.enabled,true);
 const count=s.app.repo.conversations.list().length;const original=s.app.repo.tasks.update;
 s.app.repo.tasks.update=()=>{throw new Error('injected failure');};
 assert.equal((await api(s,'PATCH',route,body)).status,500);s.app.repo.tasks.update=original;
 assert.equal(s.app.repo.conversations.list().length,count,'failed binding rolls back new conversation');
 const close=s.app.repo.conversations.beginClosing(bound.conversationId);
 const existing={mode:'existing',conversationId:bound.conversationId,continuity:false,archive:'keep'};
 assert.equal((await api(s,'PATCH',route,existing)).status,409);close();
 assert.equal(s.app.repo.conversations.get(bound.conversationId).meta.continuity.enabled,true,'failed binding does not change continuity');
 s.app.repo.conversations.archive(bound.conversationId,0);assert.equal((await api(s,'PATCH',route,existing)).status,400);
 assert.equal((await api(s,'PATCH',route,{...existing,conversationId:null})).status,400);
 assert.equal((await api(s,'PATCH',route,{...body,title:''})).status,400);
 assert.equal((await api(s,'PATCH',route,{...body,archive:'on-success'})).status,400);
 assert.equal((await api(s,'PATCH',route,{mode:'new',continuity:false,archive:'on-success'})).status,200);
 assert.equal((await api(s,'PATCH','/api/tasks/'+task.id,{name:'Changed',archivePolicy:{mode:'off'}})).status,200);
 assert.equal(s.app.repo.tasks.get(task.id).archivePolicy.conversation,'on-success');
});
