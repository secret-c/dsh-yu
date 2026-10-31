import {BUILTIN_SECTIONS,readSections} from '../lib/sections.js';
import {migrateInjectionFiles} from '../lib/injection-files.js';
export function enableLegacyRules(app) {const sections=readSections(app.settings).sections;if(!sections.some(s=>s.id==='rules')){app.settings.set('prompt.sections',JSON.stringify([...sections,{...BUILTIN_SECTIONS.find(s=>s.id==='rules')} ]));migrateInjectionFiles({repo:app.repo,settings:app.settings});}}
import { EventEmitter } from 'node:events';

/**
 * A deterministic stand-in for the DeepSeek Harness.
 *
 * It implements exactly the service surface `lib/agent-host.js` and the runner
 * depend on, so Yu's whole pipeline — context assembly, queuing, streaming,
 * archive, memory absorption — can be tested without a model. It is a test
 * double, and the delivery report states which evidence came from here versus a
 * real harness session.
 */
export function createFakeHost({ reply = null, maintenanceReply = null } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const sessions = new Map();
  const liveAgents = new Map();
  const archivedSessions = new Set();
  const archiveCalls = [];
  const tools = new Map();
  const registeredSections = new Map(); // agentId -> [{name, order, text}]
  const calls = [];

  const now = () => Date.now();

  const createSession = (id) => {
    const events = [];
    const session = {
      id,
      header: { id, createdAt: now(), isSeeded: false, version: 1 },
      get seq() {
        return events.length;
      },
      snapshotEvents(from = 0, to = events.length) {
        return events.slice(from, to);
      },
      ownEvents() {
        return events.slice();
      },
      append(type, data) {
        const event = { type, seq: events.length, time: now(), data };
        events.push(event);
        return event;
      },
      deriveMessages() {
        return [];
      },
      _events: events,
    };
    sessions.set(id, session);
    return session;
  };

  const renderSystem = (agentId) => {
    const sections = registeredSections.get(agentId) ?? [];
    return sections
      .map((s) => `${s.name}:${typeof s.text === 'function' ? s.text() : s.text}`)
      .join('\n');
  };

  const buildReply = (input, system = '') => {
    if (String(input).includes('记忆维护器') || String(system).includes('记忆维护器') || String(system).includes('【正文维护】')) {
      if (maintenanceReply) return typeof maintenanceReply==='function'?maintenanceReply(input,system):maintenanceReply;
      if(String(input).includes('## 当前阶段')) {
        if(String(input).includes('## 当前阶段\n长期引用'))return '无新增事实';
        const slug=String(input).match(/## 输出目标\n([^\n]+)/)?.[1];
        const marker='### '+slug+'\n';const start=String(input).indexOf(marker);
        return start>=0?(String(input).slice(start+marker.length).split(/\n\n(?:### |## )/)[0].trim()||'暂无新增事实。'):'稳定的短期事实';
      }
      return maintenanceJson();
    }
    if (reply) return typeof reply === 'function' ? reply(input) : reply;
    return `已收到你的消息：${String(input).slice(0, 6000)}`;
  };

  const agents = {
    create: async ({ sessionId, agentOptions = {}, setup, meta }) => {
      const session = createSession(sessionId);
      const agentId = sessionId;
      const agentCtx = {
        agent: { id: sessionId },
        get: (key) => (key === 'systemPrompt' ? makeScopedSystemPrompt(sessionId) : services[key]),
        on: (name, fn) => {
          const wrapped = (payload) => {
            if (payload?.agent?.id && payload.agent.id !== sessionId) return;
            fn(payload);
          };
          emitter.on(name, wrapped);
          return () => emitter.off(name, wrapped);
        },
        effect: (fn) => {
          const disposer = fn();
          return typeof disposer === 'function' ? disposer : () => {};
        },
      };
      const pending = { resolve: null };
      const agent = {
        id: sessionId,
        session,
        options: agentOptions,
        status: 'idle',
        ctx: agentCtx,
        followup(message) {
          if (archivedSessions.has(sessionId)) throw new Error(`session ${sessionId} is archived (blocked)`);
          const text = (message.content ?? []).map((b) => b.text ?? '').join('');
          calls.push({ sessionId, text, system: renderSystem(sessionId), agentOptions, meta });
          agent.status = 'running';
          session.append('turn/start', { turn: 1 });
          session.append('user/message', {
            id: `m_${session.seq}`,
            role: 'user',
            content: [{ type: 'text', text }],
            time: now(),
          });
          const answer = buildReply(text, renderSystem(sessionId));
          setImmediate(() => {
            const outro = renderSystem(sessionId).includes('【正文维护】')?answer:`[模拟回复 @ ${agentOptions.provider ?? '?'}/${agentOptions.model ?? '?'}] ${answer}`;
            for (const piece of [outro.slice(0, 12), outro.slice(12)]) {
              emitter.emit('agent/assistant-stream', {
                agent: { id: sessionId },
                frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: piece } },
              });
            }
            session.append('assistant/message', {
              turn: 1,
              step: 1,
              message: {
                id: `a_${session.seq}`,
                role: 'assistant',
                source: { kind: 'model', provider: agentOptions.provider ?? 'fake', model: agentOptions.model ?? 'fake' },
                content: [{ type: 'text', text: outro }],
                time: now(),
              },
              stream: [{type:'chunk',chunk:{type:'finish',reason:{kind:'stop'}}}],
              usage: { inputTokens: 100, outputTokens: 20 },
            });
            session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
            agent.status = 'idle';
            pending.resolve?.();
            pending.resolve = null;
          });
        },
        whenIdle() {
          if (agent.status === 'idle') return Promise.resolve();
          return new Promise((resolve) => {
            pending.resolve = resolve;
          });
        },
        cancel() {
          agent.status = 'idle';
          pending.resolve?.();
          pending.resolve = null;
        },
      };
      liveAgents.set(sessionId, agent);
      if (typeof setup === 'function') await setup(agentCtx, agent);
      return {
        agent,
        dispose: async () => {
          liveAgents.delete(sessionId);
          // Disposing a live lease retains the durable session for resume.
        },
      };
    },
    resume: async (options) => {
      if (!sessions.has(options.resumeSessionId)) {
        throw new Error(`session ${options.resumeSessionId} not found`);
      }
      return agents.create({ ...options, sessionId: options.resumeSessionId });
    },
    get: (id) => liveAgents.get(id),
    list: () => [...liveAgents.values()],
    roots: () => [...liveAgents.values()],
  };

  const toolService = {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
    schemas: () =>
      [...tools.values()].map((d) => ({
        name: d.name,
        description: d.description,
        parameters: d.parameters,
      })),
    get: (name) => tools.get(name),
    restrict: () => () => {},
    execute: async ({ name, arguments: args }) => {
      const definition = tools.get(name);
      if (!definition) return { isError: true, error: { message: `unknown tool ${name}` }, content: [] };
      try {
        const value = await definition.execute(args, {});
        return {
          isError: false,
          value,
          content: definition.output?.render?.(args, value) ?? [{ type: 'text', text: JSON.stringify(value) }],
        };
      } catch (error) {
        return { isError: true, error: { message: error.message }, content: [] };
      }
    },
  };

  const systemPrompt = {
    section(section) {
      const list = registeredSections.get(section?.__agentId ?? '*') ?? [];
      list.push(section);
      registeredSections.set(section?.__agentId ?? '*', list);
      return () => {};
    },
    context: () => () => {},
    variable: () => () => {},
    assemble: async () => ({ sections: [{ name: 'harness:base', text: 'base prompt' }], contexts: [], tools: [], variables: {} }),
  };

  /** Sections registered through `agentCtx` belong to that agent only. */
  const makeScopedSystemPrompt = (agentId) => ({
    section(section) {
      const list = registeredSections.get(agentId) ?? [];
      list.push(section);
      registeredSections.set(agentId, list);
      return () => {
        const index = list.indexOf(section);
        if (index >= 0) list.splice(index, 1);
      };
    },
    context: () => () => {},
    variable: () => () => {},
    assemble: async () => ({ sections: [], contexts: [], tools: [], variables: {} }),
  });

  const services = {
    agents,
    tools: toolService,
    systemPrompt,
    llm: {
      listProviders: () => [{ id: 'fake', name: 'Fake Provider' }],
      listModels: async () => [{ id: 'fake-model', name: 'Fake Model' }],
      resolveModelInfo: async (provider, model) => ({
        provider,
        id: model,
        name: model,
        context: { contextWindow: 32000 },
        reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }], defaultEffort: 'low' },
      }),
    },
    sessions: {
      get: (id) => sessions.get(id),
      list: () => [...sessions.values()],
    },
    sessionPersistence: {
      list: async () => [],
      open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
      flush: async () => {},
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
    workspaceRegistry: {
      get archivedSessionIds() { return [...archivedSessions]; },
      async archiveSession(sessionId, { stopActivity = false } = {}) {
        const active = liveAgents.get(sessionId);
        if (active && active.status !== 'idle') {
          if (!stopActivity) throw new Error('session is active');
          active.cancel();
        }
        archiveCalls.push({ sessionId, stopActivity });
        archivedSessions.add(sessionId);
      },
      async unarchiveSession(sessionId) { archivedSessions.delete(sessionId); },
    },
    credentials: { readRecord: async () => undefined },
    workingDirectory: { get: () => process.cwd(), defaultDirectory: process.cwd() },
    agentPresets: { list: async () => [{ id: 'default', name: 'Default' }] },
    webServer: {
      register: () => () => {},
      registerUpgrade: () => () => {},
      getOrigin: () => 'http://127.0.0.1:1234',
    },
  };

  const ctx = {
    get: (key) => services[key],
    on: (name, fn) => {
      emitter.on(name, fn);
      return () => emitter.off(name, fn);
    },
    /** Same contract as Cordis: run once every dependency resolves. */
    inject: (deps, callback) => {
      let disposed = false;
      const scoped = {
        ...ctx,
        get: (key) => services[key],
        effect: (fn) => {
          const disposer = fn();
          return typeof disposer === 'function' ? disposer : () => {};
        },
      };
      let dispose = null;
      const attempt = () => {
        if (disposed) return;
        if (!deps.every((name) => services[name] != null)) {
          setTimeout(attempt, 5).unref?.();
          return;
        }
        dispose = callback(scoped);
      };
      attempt();
      return () => {
        disposed = true;
        try {
          dispose?.();
        } catch {
          /* ignore */
        }
      };
    },
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  return {
    ctx,
    calls,
    sessions,
    liveAgents,
    archivedSessions,
    archiveCalls,
    tools,
    registeredSections,
    emit: (name, payload) => emitter.emit(name, payload),
  };
}

function maintenanceJson() {
  return JSON.stringify({
    style: '说话简短，保留口癖「嗯」。',
    blocks: {
      recent: '今天读了一章。',
      people: '（空）',
      ongoing: '继续读下一章。',
      thoughts: '我推测这一章埋了伏笔。',
      state: '平静。',
    },
    note: 'absorbed test archives',
  });
}
