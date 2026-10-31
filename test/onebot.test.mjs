import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost } from './fake-harness.mjs';
import { connectWebSocket, probeUpgrade } from './ws-client.mjs';
import { apply } from '../index.js';

/**
 * OneBot v11 reverse-WebSocket protocol test.
 *
 * No QQ account is involved: the test plays the NapCat client, so the parts that
 * matter — handshake authentication, event normalisation, durable dedupe, task
 * matching, and the reply call — are exercised against the real adapter.
 */

async function boot(configureHost=null) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-onebot-'));
  const host = createFakeHost();
  configureHost?.(host);
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}});
  const base = app.httpService.url();
  const port = Number(new URL(base).port);
  const code = fs
    .readFileSync(path.join(dataDir, 'pairing-code.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^[A-Z]{4}-\d{4}$/.test(line));
  const response = await fetch(`${base}api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base.replace(/\/$/, '') },
    body: JSON.stringify({ code }),
  });
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  const call = async (method, url, body) => {
    const r = await fetch(`${base}${url.replace(/^\//, '')}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        origin: base.replace(/\/$/, ''),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    const json = text ? JSON.parse(text) : null;
    if (!r.ok) throw Object.assign(new Error(json?.error?.message ?? `HTTP ${r.status}`), { code: json?.error?.code });
    return json;
  };
  return { app, host, base, port, call };
}

const TOKEN = 'test-token-123456';

test('task API → shared native DSH → OneBot stub isolates private/group/multiple connections and autonomous output',async t=>{
 const events=[],prompts=[];const controller={async list(){return {items:[{sessionId:'native',running:false,title:'native'}]}},async *follow(){yield {type:'snapshot',cursor:events.length-1}},async page(r){return {records:events.filter(e=>e.seq<=r.throughSeq).map(event=>({type:'event',event})),hasMore:false}},async prompt(r){prompts.push(r);return {accepted:true}}};
 const s=await boot(host=>{const get=host.ctx.get;host.ctx.get=k=>k==='sessionController'?controller:k==='remoteAccess'?{allows:()=>true}:get(k)});t.after(()=>s.app.stop());s.app.scheduler.stop();s.app.settings.set('channel.guestReply',true);
 const link=(await s.call('POST','/api/dsh/links',{sessionId:'native'})).link;
 const task=(await s.call('POST','/api/tasks',{name:'native bridge',goal:'reply',kind:'chat',enabled:false,executionTarget:{mode:'dsh-session',linkId:link.id,busyPolicy:'queue-latest'}})).task;
 const sent=[];const channels=[];
 for(let i=0;i<2;i++){const ch=(await s.call('POST','/api/channels',{name:'stub '+i,type:'onebot',enabled:true,config:{token:TOKEN}})).channel;channels.push(ch);const ws=await connectWebSocket({port:s.port,path:`/onebot/${ch.id}`,headers:{authorization:`Bearer ${TOKEN}`}});t.after(()=>ws.close());ws.on('message',raw=>{const a=JSON.parse(raw);if(a.action?.startsWith('send_')){sent.push({channelId:ch.id,...a});ws.send(JSON.stringify({echo:a.echo,status:'ok',retcode:0,data:{message_id:sent.length}}));}});}
 const binding=(await s.call('POST',`/api/tasks/${task.id}/triggers`,{type:'message',enabled:false,spec:{channelId:channels[0].id,peerKind:'private',peerId:'111',requirePeer:true}})).trigger;
 await s.call('PATCH',`/api/tasks/${task.id}/triggers/${binding.id}`,{enabled:true,activateTask:true,spec:{channelId:channels[0].id,peerKind:'private',peerId:'111',requirePeer:true}});
 assert.equal(s.app.repo.tasks.get(task.id).enabled,true);
 for(const [ch,kind,id] of [[channels[0],'group','111'],[channels[1],'private','222']])await s.call('POST',`/api/tasks/${task.id}/triggers`,{type:'message',enabled:true,spec:{channelId:ch.id,peerKind:kind,peerId:id,requirePeer:true}});
 const incoming=(ch,kind,peerId,eventId)=>s.app.channelManager.handleInbound(ch,{channelId:ch.id,accountId:'bot',eventId,kind,peerId,peerLabel:'observed '+kind,senderId:'555',senderName:'stub',text:'hello',at:Date.now()});
 const pending=[incoming(channels[0],'qq_private','111','p'),incoming(channels[0],'qq_group','111','g'),incoming(channels[1],'qq_private','222','c')];
 s.app.runner.enqueue(s.app.repo.tasks.get(task.id),{source:'manual'});s.app.runner.enqueue(s.app.repo.tasks.get(task.id),{source:'schedule'});
 const add=(type,data)=>events.push({type,data,seq:events.length});
 for(let turn=1;turn<=5;turn++){await s.app.repo.dshLinks.tick();assert.equal(prompts.length,turn);add('turn/start',{turn});add('user/message',{source:{kind:'user',rpcId:prompts.at(-1).requestId},content:[]});add('assistant/message',{turn,message:{content:[{type:'text',text:'answer '+turn}]}});add('turn/end',{turn,reason:{kind:'completed'}});await s.app.repo.dshLinks.tick();}
 await Promise.all(pending);assert.deepEqual(sent.map(a=>[a.channelId,a.action,a.params.user_id??a.params.group_id]),[[channels[0].id,'send_private_msg',111],[channels[0].id,'send_group_msg',111],[channels[1].id,'send_private_msg',222]]);
 const peers=(await s.call('GET','/api/channels/peers')).peers;assert.equal(peers.filter(p=>p.peerId==='111').length,2);
 await s.app.repo.dshLinks.tick();assert.equal(sent.length,3);
});

for (const channelType of ['napcat','onebot']) test('OneBot '+channelType+' reverse WS: auth, normalisation, dedupe, reply', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
  });

  const created = await state.call('POST', '/api/channels', {
    name: 'NapCat 测试',
    type: channelType,
    config: { token: TOKEN, selfId: '10001' },
    enabled: true,
  });
  const channelId = created.channel.id;
  assert.equal(created.channel.enabled, true);

  // A fresh install seeds the chat tasks switched off on purpose; this test is
  // about the protocol, so it turns the chat tasks on explicitly.
  const chatTasks = state.app.repo.tasks.list().filter((task) => task.kind === 'chat');
  assert.ok(chatTasks.length, 'chat tasks are seeded');
  for (const task of chatTasks) {
    state.app.repo.tasks.setEnabled(task.id, true);
    for (const trigger of task.triggers) state.app.repo.triggers.update(trigger.id, { type:task.name==='QQ私聊'?'message':'group-watch',enabled: true, spec:{...trigger.spec,definitionId:undefined,localEnabled:undefined,channelId,peerKind:task.name==='QQ私聊'?'private':'group',peerId:task.name==='QQ私聊'?'20002':'30003',requirePeer:true} });
  }
  state.app.channelManager.sync();

  const wsPath = `/onebot/${channelId}`;

  // 1. A wrong or missing token must be refused at the upgrade.
  const unauth = await probeUpgrade({ port: state.port, path: wsPath });
  assert.equal(unauth.status, 401, 'missing token is rejected');
  const wrongToken = await probeUpgrade({ port: state.port, path: wsPath, headers: { authorization: 'Bearer nope' } });
  assert.equal(wrongToken.status, 401, 'wrong token is rejected');

  // 2. An authenticated client connects.
  const client = await connectWebSocket({
    port: state.port,
    path: wsPath,
    headers: { authorization: `Bearer ${TOKEN}`, 'x-self-id': '10001' },
  });
  t.after(() => client.close());

  // 3. A private message is normalised, matched, run, and answered.
  const event = {
    post_type: 'message',
    message_type: 'private',
    self_id: 10001,
    user_id: 20002,
    message_id: 555001,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: '测试用户', card: '' },
    message: [
      { type: 'text', data: { text: '你好，Yu。' } },
      { type: 'face', data: { id: '14' } },
    ],
  };
  const replyWait = client.waitFor((msg) => msg.action === 'send_private_msg');
  client.send(JSON.stringify(event));
  const action = await replyWait;
  assert.equal(action.action, 'send_private_msg');
  assert.equal(action.params.user_id, 20002);
  const text = action.params.message.map((segment) => segment.data.text ?? '').join('');
  assert.match(text, /已收到你的消息/, 'the run output is delivered back');
  assert.match(text, /\[表情14\]/, 'segments are normalised into prompt-safe text');
  // Acknowledge the action so the adapter marks the delivery as sent.
  client.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data: { message_id: 90001 } }));

  // 4. The same event redelivered must not produce a second run or reply.
  const runsBefore = (await state.call('GET', '/api/runs?limit=50')).runs.length;
  let secondReply = false;
  client.on('message', (raw) => {
    try {
      if (JSON.parse(raw).action === 'send_private_msg') secondReply = true;
    } catch {
      /* ignore */
    }
  });
  client.send(JSON.stringify(event));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const runsAfter = (await state.call('GET', '/api/runs?limit=50')).runs.length;
  assert.equal(secondReply, false, 'a duplicate event is not answered twice');
  assert.equal(runsAfter, runsBefore, 'a duplicate event creates no run');

  // 5. The conversation is routed per peer and carries the channel identity.
  const conversations = await state.call('GET', '/api/conversations?limit=10');
  const conversation = conversations.conversations.find((c) => c.peerId === '20002');
  assert.ok(conversation, 'a per-peer conversation exists');
  assert.equal(conversation.kind, 'qq_private');
  assert.equal(conversation.channelId, channelId);

  // 6. In a group, being @-ed is answered through the `group-watch` trigger.
  //    A plain line is not: the trigger decides, and being called always counts.
  const beforeGroup = (await state.call('GET', '/api/runs?limit=50')).runs.length;
  const groupReply = client.waitFor((msg) => msg.action === 'send_group_msg');
  client.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      self_id: 10001,
      group_id: 30003,
      group_name: '测试群',
      user_id: 20002,
      message_id: 555002,
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: '测试用户', card: '群昵称' },
      message: [
        { type: 'at', data: { qq: '10001', name: 'Yu' } },
        { type: 'text', data: { text: ' 在吗' } },
      ],
    }),
  );
  const groupAction = await groupReply;
  assert.equal(groupAction.params.group_id, 30003);
  client.send(JSON.stringify({ echo: groupAction.echo, status: 'ok', retcode: 0, data: { message_id: 90002 } }));
  const afterGroup = (await state.call('GET', '/api/runs?limit=50')).runs.length;
  assert.equal(afterGroup, beforeGroup + 1, 'being @-ed in a group produced exactly one run');

  const routed = (await state.call('GET', '/api/conversations?limit=10')).conversations.find((c) => c.peerId === '30003');
  assert.ok(routed, 'a per-peer group conversation exists');
  assert.equal(routed.kind, 'qq_group');

  // 7. An ordinary line is buffered and starts no run: that is the whole point of
  //    the group-watch trigger.
  const beforeQuiet = (await state.call('GET', '/api/runs?limit=50')).runs.length;
  let quietReply = false;
  client.on('message', (raw) => {
    try {
      if (JSON.parse(raw).action === 'send_group_msg') quietReply = true;
    } catch {
      /* ignore */
    }
  });
  client.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      self_id: 10001,
      group_id: 30003,
      group_name: '测试群',
      user_id: 20002,
      message_id: 555003,
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: '测试用户', card: '群昵称' },
      message: [{ type: 'text', data: { text: '随便说一句不叫她' } }],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 800));
  const afterQuiet = (await state.call('GET', '/api/runs?limit=50')).runs.length;
  assert.equal(afterQuiet, beforeQuiet, 'an ambient group line starts no run');
  assert.equal(quietReply, false, 'and it is not answered');
  const buffer = await state.call('GET', '/api/group/buffer');
  assert.ok(buffer.total.count >= 1, 'the observed group line is in the buffer');
  assert.equal(buffer.stats.pending, buffer.stats.count, 'nothing consumed yet');
});

test('OneBot health is reported honestly when no client is connected', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
  });
  const created = await state.call('POST', '/api/channels', {
    name: 'SnowLuma 测试',
    type: 'snowluma',
    config: { token: TOKEN, selfId: '10001' },
    enabled: true,
  });
  const status = (await state.call('GET', '/api/channels')).channels.find((c) => c.id === created.channel.id);
  assert.equal(status.runtime.status, 'listening');
  assert.equal(status.health.state, 'offline', 'waiting for a client reads as offline, not healthy');
  const disabled = await state.call('POST', `/api/channels/${created.channel.id}/enable`, { enabled: false });
  assert.equal(disabled.channel.enabled, false);
  const after = (await state.call('GET', '/api/channels')).channels.find((c) => c.id === created.channel.id);
  assert.equal(after.health.state, 'disabled', 'a deliberately stopped channel is not an alert source');
});

test('QQ official adapter signs and verifies without credentials', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
  });
  const created = await state.call('POST', '/api/channels', {
    name: 'QQ 官方测试',
    type: 'qq-official',
    config: { appId: '', clientSecret: '' },
    enabled: false,
  });
  const probe = await state.call('POST', `/api/channels/${created.channel.id}/test`, {});
  assert.equal(probe.ok, false, 'without credentials the test must not claim success');
  assert.equal(probe.selfTest.ok, true, 'the ed25519 protocol self-test still passes offline');
  assert.ok(probe.selfTest.checks.every((check) => check.ok));
  assert.equal(probe.selfTest.keyDerivation, 'sha256-of-secret');
});
