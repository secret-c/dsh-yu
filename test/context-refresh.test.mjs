import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost,enableLegacyRules } from './fake-harness.mjs';
import { apply } from '../index.js';

/**
 * Context frame: built once per session, reused until the session rotates.
 *
 * The harness assembles the system prompt before every request, so a section
 * function that reads live state makes the prompt different on every turn. That
 * is the behaviour these tests deliberately reject now:
 *
 *   - rules, style, short-term memory and retrieval are compiled when the
 *     session is created, so the prefix stays byte-identical for the whole
 *     conversation (provider cache hits, no mid-conversation reframing);
 *   - memory written after the session started is not spliced into it; it waits
 *     for the next session, or is looked up with `memory.search`.
 *
 * `runtime.contextMode = turn` restores the old per-message behaviour, and the
 * third test pins that switch.
 */

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-fresh-'));
  const host = createFakeHost();
  const app = apply(host.ctx, { port: 0, dataDir, exposeViaDshWeb: false });
  await app.ready;
  for(const task of app.repo.tasks.list().filter(t=>t.kind==='maintenance')) app.repo.tasks.update(task.id,{memoryPolicy:{...task.memoryPolicy,shortTermSlug:app.repo.memory.blocks()[0]?.slug}}); enableLegacyRules(app);
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

/** One chat turn over SSE; resolves when the run reports `done`. */
async function chat(state, text, conversationId = null) {
  const response = await fetch(`${state.base}api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: state.base.replace(/\/$/, ''),
      ...(state.cookie ? { cookie: state.cookie } : {}),
    },
    body: JSON.stringify({ text, ...(conversationId ? { conversationId } : {}) }),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let out = { conversationId: null, runId: null, status: null };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at = buffer.indexOf('\n\n');
    while (at >= 0) {
      const raw = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = null;
        }
        if (parsed && event === 'accepted') {
          out.conversationId = parsed.conversationId;
          out.runId = parsed.runId;
        } else if (parsed && event === 'done') {
          out.status = parsed.status;
        }
      }
      at = buffer.indexOf('\n\n');
    }
    if (out.status) break;
  }
  await reader.cancel().catch(() => {});
  assert.equal(out.status, 'succeeded', `turn failed: ${out.status}`);
  return out;
}

test('session material is delivered once, in the first user turn', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  await api(state, 'PATCH', '/api/memory/blocks/recent', { content: '第一轮标记：ALPHA-ONLY' });
  const first = await chat(state, '用一句话打个招呼');
  const conversation = first.conversationId;

  // Memory changes between the two messages. The handoff is session material:
  // it rode along with the first message, and repeating it every turn would pay
  // for it again and leak it into the transcript.
  await api(state, 'PATCH', '/api/memory/blocks/recent', { content: '第二轮标记：BETA-ONLY' });
  await chat(state, '再说一句', conversation);

  const calls = state.host.calls.filter(call=>!call.sessionId.startsWith('yu-maint-'));
  assert.equal(calls.length, 2, 'two model requests were made');
  assert.equal(state.host.liveAgents.size, 1, 'the same physical agent served both messages');
  assert.match(calls[0].text, /ALPHA-ONLY/, 'the first message carries the session material');
  assert.doesNotMatch(calls[1].text, /ALPHA-ONLY/, 'the second message does not repeat it');
  assert.doesNotMatch(calls[1].text, /BETA-ONLY/, 'a mid-session memory change waits for the next session');
  assert.doesNotMatch(calls[0].system, /ALPHA-ONLY/, 'memory never reaches the system prompt');
  assert.equal(calls[0].system, calls[1].system, 'the system prompt is byte-identical inside a session');
});

test('by default nothing is re-read: a rule changed mid-session waits for the next one', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  await api(state, 'PATCH', '/api/settings', { settings: { 'prompt.rules': '旧规矩 OLD-RULE' } });
  const first = await chat(state, '第一句');

  await api(state, 'PATCH', '/api/settings', { settings: { 'prompt.rules': '新规矩 NEW-RULE' } });
  await api(state, 'PATCH', '/api/memory/blocks/recent', { content: '会话中间：LATE-BLOCK' });
  await chat(state, '第二句', first.conversationId);

  const systems = state.host.calls.filter(call=>!call.sessionId.startsWith('yu-maint-')).map((call) => call.system);
  assert.match(systems[0], /OLD-RULE/);
  assert.match(systems[1], /OLD-RULE/, 'the whole frame is frozen by default');
  assert.doesNotMatch(systems[1], /NEW-RULE/);
  assert.doesNotMatch(systems[1], /LATE-BLOCK/);
  assert.equal(systems[0], systems[1], 'byte-identical, so the provider prefix cache can hit');
});

test('turnSections makes a section live: listed names are re-read every message', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  const contexts = await api(state, 'GET', '/api/contexts');
  const context = contexts.body.contexts[0];
  assert.ok(context?.id, 'a default context exists');
  const patched = await api(state, 'PATCH', `/api/contexts/${context.id}`, {
    config: { ...context.config, turnSections: ['yu:rules'] },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  await api(state, 'PATCH', '/api/settings', { settings: { 'prompt.rules': '旧规矩 OLD-RULE' } });
  await api(state, 'PATCH', '/api/memory/blocks/recent', { content: '会话开头：HANDOFF-ONLY' });
  const first = await chat(state, '第一句');

  await api(state, 'PATCH', '/api/settings', { settings: { 'prompt.rules': '新规矩 NEW-RULE' } });
  await api(state, 'PATCH', '/api/memory/blocks/recent', { content: '会话中间：LATE-BLOCK' });
  await chat(state, '第二句', first.conversationId);

  const systems = state.host.calls.filter(call=>!call.sessionId.startsWith('yu-maint-')).map((call) => call.system);
  assert.match(systems[0], /OLD-RULE/);
  assert.match(systems[1], /NEW-RULE/, 'a listed section is re-read on every message');
  assert.doesNotMatch(systems[1], /OLD-RULE/);
  const texts = state.host.calls.filter(call=>!call.sessionId.startsWith('yu-maint-')).map((call) => call.text);
  assert.match(texts[0], /HANDOFF-ONLY/, 'the session material still arrives once');
  assert.doesNotMatch(texts[1], /HANDOFF-ONLY/, 'and is not repeated because a different section is live');
  assert.doesNotMatch(texts[1], /LATE-BLOCK/);
});

test('a new session picks up memory that was written after the previous one started', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  await api(state, 'PATCH', '/api/memory/blocks/recent', { content: '旧会话标记：OLD-FRAME' });
  await chat(state, '第一段对话');

  // A different conversation is a different physical session: its frame is built
  // now, from memory as it is now.
  await api(state, 'PATCH', '/api/memory/blocks/recent', { content: '新会话标记：NEW-FRAME' });
  await chat(state, '新的一天，继续');

  const systems = state.host.calls.filter(call=>!call.sessionId.startsWith('yu-maint-')).map((call) => call.system);
  const texts = state.host.calls.filter(call=>!call.sessionId.startsWith('yu-maint-')).map((call) => call.text);
  assert.equal(systems.length, 2);
  assert.match(texts[0], /OLD-FRAME/);
  assert.match(texts[1], /NEW-FRAME/, 'a session started after the change sees the new memory');
  assert.doesNotMatch(texts[1], /OLD-FRAME/);
  assert.doesNotMatch(systems[0], /OLD-FRAME/, 'memory rides in the user turn, not the system prompt');
});

test('retrieval follows each message instead of freezing on the first one', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  const first = await chat(state, '今天天气怎么样');
  await api(state, 'POST', '/api/memory/db', { text: '用户的猫叫团子，是一只三花猫。', kind: 'fact', subject: '团子' });
  await chat(state, '我的猫叫什么名字？', first.conversationId);

  const texts = state.host.calls.filter(call=>!call.sessionId.startsWith('yu-maint-')).map((call) => call.text);
  assert.doesNotMatch(texts[0], /团子/, 'nothing was known on the first message');
  assert.match(texts[1], /团子/, 'the next message retrieves again, with its own query');
});

test('runtime.contextMode = turn re-reads the system sections on every message', async (t) => {
  const state = await boot();
  t.after(async () => {
    await state.app.stop();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  const settings = await api(state, 'PATCH', '/api/settings', { settings: { 'runtime.contextMode': 'turn' } });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));

  await api(state, 'PATCH', '/api/settings', { settings: { 'prompt.rules': '旧规矩 OLD-RULE' } });
  const first = await chat(state, '用一句话打个招呼');
  await api(state, 'PATCH', '/api/settings', { settings: { 'prompt.rules': '新规矩 NEW-RULE' } });
  await chat(state, '再说一句', first.conversationId);

  const systems = state.host.calls.filter(call=>!call.sessionId.startsWith('yu-maint-')).map((call) => call.system);
  assert.match(systems[0], /OLD-RULE/);
  assert.match(systems[1], /NEW-RULE/, 'turn mode keeps the old behaviour for system sections');
});
