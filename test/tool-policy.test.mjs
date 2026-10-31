import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentHost } from '../lib/agent-host.js';
import { createFakeHost } from './fake-harness.mjs';

for (const failure of ['missing restrict', 'throws', 'empty catalog', 'missing schemas']) {
  test('restricted owner fails closed: ' + failure, async () => {
    const host = createFakeHost();
    const tools = host.ctx.get('tools');
    tools.register({ name: 'read', execute: () => 'ok' });
    if (failure === 'missing restrict') tools.restrict = undefined;
    if (failure === 'throws') tools.restrict = () => { throw new Error('rejected'); };
    if (failure === 'empty catalog') tools.schemas = () => [];
    if (failure === 'missing schemas') tools.schemas = undefined;
    const adapter = createAgentHost({ ctx: host.ctx, settings: { get: () => null } });
    await assert.rejects(adapter.ensureAgent({ sessionId: failure, route: {}, policy: { mode: 'none' }, holder: { parts: {}, problems: [] } }), { code: 'TOOL_POLICY_UNENFORCED' });
    assert.equal(adapter.aliveCount(), 0);
    await adapter.disposeAll();
  });
}
test('unknown allow denies every known tool; policy switch replaces protected slot', async () => {
  const host = createFakeHost();
  const tools = host.ctx.get('tools');
  tools.register({ name: 'read', execute: () => 'ok' });
  tools.register({ name: 'write', execute: () => 'ok' });
  let denied = [];
  tools.restrict = (filter) => { denied = filter.deny; return () => { denied = []; }; };
  const adapter = createAgentHost({ ctx: host.ctx, settings: { get: () => null } });
  const args = { sessionId: 'policy', route: {}, holder: { parts: {}, problems: [] } };
  const first = await adapter.ensureAgent({ ...args, policy: { mode: 'allow', allow: ['unknown'] } });
  assert.deepEqual(denied, ['read', 'write']);
  assert.deepEqual(adapter.policyState('policy').visibleTools, []);
  const next = await adapter.ensureAgent({ ...args, policy: { mode: 'allow', allow: ['read'] } });
  assert.notEqual(first, next);
  assert.deepEqual(denied, ['write']);
  await adapter.disposeAll();
});

test('mode none restricts with an empty allow list, not a deny list of scoped names', async () => {
  const host = createFakeHost();
  const tools = host.ctx.get('tools');
  tools.register({ name: 'read', execute: () => 'ok' });
  tools.register({ name: 'subagent', execute: () => 'ok' });
  const seen = [];
  tools.restrict = (filter) => {
    seen.push(filter);
    return () => {};
  };
  const adapter = createAgentHost({ ctx: host.ctx, settings: { get: () => null } });
  await adapter.ensureAgent({
    sessionId: 'none-mode',
    route: {},
    holder: { parts: {}, problems: [] },
    policy: { mode: 'none' },
  });
  assert.deepEqual(seen, [{ allow: [] }], 'an empty allow list needs no names to validate');
  await adapter.disposeAll();
});

test('a name the runtime refuses to restrict is dropped, not fatal', async () => {
  const host = createFakeHost();
  const tools = host.ctx.get('tools');
  tools.register({ name: 'read', execute: () => 'ok' });
  tools.register({ name: 'subagent', execute: () => 'ok' });
  const seen = [];
  tools.restrict = (filter) => {
    seen.push(filter);
    if (filter.deny?.includes('subagent')) {
      throw new Error('tools.restrict() names unknown global tool "subagent"; known global tools: "read"');
    }
    return () => {};
  };
  const adapter = createAgentHost({ ctx: host.ctx, settings: { get: () => null } });
  const holder = { parts: {}, problems: [] };
  await adapter.ensureAgent({
    sessionId: 'drop-unknown',
    route: {},
    holder,
    policy: { mode: 'deny', deny: ['subagent'] },
  });
  assert.equal(seen.length, 2, 'the first attempt failed, the retry omitted the name');
  assert.deepEqual(seen[1], { deny: [] });
  assert.ok(holder.problems.some((problem) => /cannot name subagent/.test(problem)), 'the omission is recorded');
  await adapter.disposeAll();
});

test('the schema scope comes from setup, not from the inject-gated ctx property', async () => {
  const host = createFakeHost();
  const tools = host.ctx.get('tools');
  tools.register({ name: 'read', execute: () => 'ok' });
  const agents = host.ctx.get('agents');
  const create = agents.create;
  agents.create = async (args) => {
    const setup = args.setup;
    args.setup = async (agentCtx, agent) => {
      Object.defineProperty(agentCtx, 'agent', {
        get() {
          throw new Error('cannot get property "agent" without inject');
        },
      });
      return setup(agentCtx, agent);
    };
    return create(args);
  };
  const adapter = createAgentHost({ ctx: host.ctx, settings: { get: () => null } });
  await adapter.ensureAgent({
    sessionId: 'inject-gate',
    route: {},
    holder: { parts: {}, problems: [] },
    policy: { mode: 'none' },
  });
  assert.equal(adapter.policyState('inject-gate').verified, true);
  await adapter.disposeAll();
});

test('disposeAll attempts healthy leases even when another disposal fails', async () => {
  const host = createFakeHost();
  const agents = host.ctx.get('agents');
  const create = agents.create;
  const attempts = [];
  agents.create = async (args) => {
    const handle = await create(args);
    const dispose = handle.dispose;
    handle.dispose = async () => {
      attempts.push(args.sessionId);
      if (args.sessionId === 'bad') throw new Error('lease failure');
      await dispose();
    };
    return handle;
  };
  const adapter = createAgentHost({ ctx: host.ctx, settings: { get: () => null } });
  for (const sessionId of ['bad', 'healthy']) await adapter.ensureAgent({ sessionId, route: {}, holder: { parts: {}, problems: [] } });
  await assert.rejects(adapter.disposeAll(), /could not be disposed/);
  assert.deepEqual(attempts.sort(), ['bad', 'healthy']);
  assert.equal(adapter.aliveCount(), 1);
});

test('failed disposal retains its restriction and cannot reuse a verified policy key', async () => {
  const host = createFakeHost();
  const tools = host.ctx.get('tools');
  tools.register({ name: 'write', execute: () => 'ok' });
  let denied = false;
  tools.restrict = () => { denied = true; return () => { denied = false; }; };
  const adapter = createAgentHost({ ctx: host.ctx, settings: { get: () => null } });
  const args = { sessionId: 'lease', route: {}, holder: { parts: {}, problems: [] } };
  const slot = await adapter.ensureAgent({ ...args, policy: { mode: 'none' } });
  slot.handle.dispose = async () => { throw new Error('dispose failed'); };
  await assert.rejects(adapter.ensureAgent({ ...args, policy: { mode: 'all' } }), /dispose failed/);
  assert.equal(denied, true);
  await assert.rejects(adapter.ensureAgent({ ...args, policy: { mode: 'none' } }), /dispose failed/);
});
