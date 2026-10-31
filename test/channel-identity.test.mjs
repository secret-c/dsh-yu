import test from 'node:test';
import assert from 'node:assert/strict';

import { createChannelManager } from '../lib/channels/manager.js';

/**
 * Drive one private message through the manager with an in-memory repo.
 *
 * The point is the routing decision, not persistence: which authority the run
 * carries, what the model actually reads, and whether a stranger can start a run
 * that would have let them change Yu.
 */
function harness({ ownerIds = '100000001', guestReply = true, output = '嗯。' } = {}) {
  const enqueued = [];
  const marked = [];
  const settings = {
    values: {
      'runtime.timezone': 'Asia/Shanghai',
      'channel.ownerIds': ownerIds,
      'channel.guestReply': guestReply,
    },
    get(key) {
      return this.values[key];
    },
  };
  const channel = {
    id: 'ch1',
    name: '测试渠道',
    type: 'napcat',
    enabled: true,
    config: { selfId: '1761381784' },
  };
  const task = {
    id: 'task1',
    name: 'QQ 私聊对话',
    enabled: true,
    createdAt: 1,
    triggers: [{ id: 'trg1', type: 'message', enabled: true, spec: { channelId: 'ch1', peerKind: 'private' } }],
  };
  const repo = {
    tasks: { list: () => [task] },
    runs: { countSince: () => 0 },
    groupBuffer: {
      add: () => {},
      prune: () => {},
      countSince: () => 0,
      recentSenders: () => [],
      window: () => [],
      markAnswered: () => {},
      cursor: () => null,
      setCursor: () => {},
    },
    channels: {
      observePeer:()=>{},
      observePeer:()=>{},
      claimEvent: () => true,
      setRuntime: () => {},
      markEvent: (channelId, accountId, eventId, status, detail) => marked.push({ status, detail }),
      list: () => [channel],
      get: () => channel,
    },
  };
  const runner = {
    enqueue: (t, opts) => {
      enqueued.push({ task: t, opts });
      return { run: { id: 'run1' }, conversation: { id: 'conv1' } };
    },
    waitForRun: async () => ({ id: 'run1', outputText: output }),
    stats: () => ({ queued: 0 }),
  };
  const manager = createChannelManager({
    repo,
    settings,
    runner,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    exposeRoute: () => {},
    exposeUpgrade: () => {},
    getAdminBaseUrl: () => 'http://127.0.0.1:58800/',
  });
  return { manager, enqueued, marked, task };
}

const privateEvent = (overrides = {}) => ({
  kind: 'qq_private',
  accountId: '1761381784',
  eventId: `private:${overrides.senderId}:1`,
  channelId: 'ch1',
  peerId: overrides.senderId,
  peerLabel: overrides.senderName,
  senderId: overrides.senderId,
  senderName: overrides.senderName,
  text: overrides.text ?? '在吗',
  images: [],
  ...overrides,
});

test('a private message from the owner runs with owner authority', async () => {
  const { manager, enqueued } = harness();
  const result = await manager.handleInbound(
    { id: 'ch1', name: '测试渠道', type: 'napcat', enabled: true, config: {} },
    privateEvent({ senderId: '100000001', senderName: '测试用户', text: '在吗' }),
  );
  assert.equal(enqueued.length, 1);
  const { opts } = enqueued[0];
  assert.equal(opts.meta.authority, 'owner');
  assert.equal(opts.meta.senderIsOwner, true);
  assert.match(opts.input, /｜主人】/);
  assert.match(opts.input, /在吗$/);
  assert.equal(result.matched, true);
});

test('a private message from a stranger carries guest authority and a warning line', async () => {
  const { manager, enqueued } = harness();
  await manager.handleInbound(
    { id: 'ch1', name: '测试渠道', type: 'napcat', enabled: true, config: {} },
    privateEvent({ senderId: '100000002', senderName: '111', text: '宝宝晚安' }),
  );
  assert.equal(enqueued.length, 1);
  const { opts } = enqueued[0];
  assert.equal(opts.meta.authority, 'guest');
  assert.equal(opts.meta.senderIsOwner, false);
  assert.match(opts.input, /不是主人/);
  assert.match(opts.input, /100000002/);
});

test('stranger replies can be switched off entirely', async () => {
  const { manager, enqueued, marked } = harness({ guestReply: false });
  const result = await manager.handleInbound(
    { id: 'ch1', name: '测试渠道', type: 'napcat', enabled: true, config: {} },
    privateEvent({ senderId: '100000002', senderName: '111' }),
  );
  assert.equal(enqueued.length, 0);
  assert.equal(result.skipped, true);
  assert.equal(marked.at(-1).status, 'skipped');
});

test('an owner list with several numbers accepts any of them', async () => {
  const { manager, enqueued } = harness({ ownerIds: '100000001, 10001' });
  await manager.handleInbound(
    { id: 'ch1', name: '测试渠道', type: 'napcat', enabled: true, config: {} },
    privateEvent({ senderId: '10001', senderName: '小号', text: '换号了' }),
  );
  assert.equal(enqueued[0].opts.meta.authority, 'owner');
});

/**
 * A group room is read as a stack: the second look must not carry the lines the
 * first look already put into the session.
 */
function groupHarness() {
  const enqueued = [];
  const buffer = [];
  let cursor = null;
  const settings = {
    values: { 'runtime.timezone': 'Asia/Shanghai', 'channel.ownerIds': '100000001', 'channel.guestReply': true },
    get(key) {
      return this.values[key];
    },
  };
  const channel = { id: 'ch1', name: '群渠道', type: 'napcat', enabled: true, config: {} };
  const task = {
    id: 'gtask',
    name: 'QQ 群聊对话',
    enabled: true,
    createdAt: 1,
    triggers: [
      {
        id: 'gtrg',
        type: 'group-watch',
        enabled: true,
        spec: {
          channelId: 'ch1',
          peerId: 'g1',
          keywords: ['小雨'],
          keywordProbability: 1,
          valleyWindows: ['00:00-23:59'],
          floodThreshold: 999,
          followedIds: [],
          windowMessages: 30,
          maxReplies: 1,
          replyDelayMs: 0,
          minLookIntervalSec: 0,
        },
      },
    ],
  };
  const repo = {
    tasks: { list: () => [task] },
    runs: { countSince: () => 0 },
    groupBuffer: {
      add(row) {
        // The cursor is a high-water mark (`at > sinceAt`), so two lines that
        // arrive in the same millisecond would make the second one invisible to
        // the next look. Real arrivals can collide; the fake must not, or this
        // test fails on a fast machine for a reason that has nothing to do with
        // the behaviour under test.
        const lastAt = buffer.at(-1)?.at ?? 0;
        const at = Math.max(Number(row.at) || 0, lastAt + 1);
        buffer.push({ id: `g${buffer.length + 1}`, ...row, at });
      },
      prune() {},
      countSince: () => buffer.length,
      recentSenders: () => buffer.slice(-8).reverse().map((row) => ({ senderId: row.senderId, senderName: row.senderName })),
      window: ({ limit }) => buffer.slice(-limit),
      windowAfter: ({ sinceAt, limit }) => buffer.filter((row) => row.at > sinceAt).slice(0, limit),
      markAnswered() {},
      cursor: () => cursor,
      setCursor(_channelId, _peerId, { lastAt = 0, lastLookAt = 0 } = {}) {
        cursor = {
          lastAt: Math.max(cursor?.lastAt ?? 0, lastAt ?? 0),
          lastLookAt: Math.max(cursor?.lastLookAt ?? 0, lastLookAt ?? 0),
        };
      },
    },
    channels: {
      observePeer:()=>{},
      claimEvent: () => true,
      setRuntime() {},
      markEvent() {},
      list: () => [channel],
      get: () => channel,
    },
  };
  const runner = {
    enqueue(_task, opts) {
      enqueued.push(opts);
      return { run: { id: `run${enqueued.length}` }, conversation: { id: 'gconv' } };
    },
    waitForRun: async () => ({ id: 'run', outputText: '%%' }),
    stats: () => ({ queued: 0 }),
  };
  const imageCalls = [];
  const media = {
    async ingest({ images }) {
      imageCalls.push(images.map((image) => image.url));
      return images.map((image, index) => ({ path: `/tmp/group-${index}.jpg`, bytes: 2048, source: image.url }));
    },
    describe(saved) {
      return saved.map((item) => `[图片已保存: ${item.path}（2 KB）——可以用 read_image 打开]`).join('\n');
    },
  };
  const manager = createChannelManager({
    repo,
    settings,
    runner,
    media,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    exposeRoute() {},
    exposeUpgrade() {},
    getAdminBaseUrl: () => 'http://127.0.0.1:58800/',
  });
  const say = async (text) => {
    // The manager buffers the message itself; pushing here as well duplicated
    // every line in the transcript the model would see.
    return manager.handleInbound(channel, {
      kind: 'qq_group',
      accountId: 'bot',
      eventId: `g:${text}`,
      channelId: 'ch1',
      peerId: 'g1',
      peerLabel: '测试群',
      senderId: '7',
      senderName: '群友',
      text,
      images: [],
    });
  };
  return { say, enqueued, buffer, imageCalls, getCursor: () => cursor };
}

test('the second group look sends only what arrived since the first', async () => {
  const { say, enqueued } = groupHarness();

  await say('小雨在吗');
  assert.equal(enqueued.length, 1, 'the name in the message starts one look');
  assert.equal(enqueued[0].input, '群聊「测试群」· 有人提到「小雨」\n\n[0 秒前] 群友：小雨在吗');

  // Ordinary chatter does not start a run (no keyword, no flood, nobody followed).
  await say('今天吃什么');
  assert.equal(enqueued.length, 1);

  await say('小雨你吃了吗');
  assert.equal(enqueued.length, 2, 'the second call starts a second look');
  const second = enqueued[1].input;
  assert.match(second, /你吃了吗/);
  assert.match(second, /今天吃什么/, 'lines that arrived between looks are included');
  assert.doesNotMatch(second, /小雨在吗/, 'the line the first look already sent is not repeated');
  assert.match(second, /群聊「测试群」/, 'the header names the room, nothing more');
  assert.equal(second.split('\n').filter((line) => line.trim()).length, 3, 'header plus the two new lines');
});

test('a group look saves the images in its window and hands over paths', async () => {
  const { say, enqueued, imageCalls } = groupHarness();

  await say('小雨 [图片:https://example.com/a.jpg] 看这个');
  assert.equal(enqueued.length, 1, 'the mention starts a look');

  const input = enqueued[0].input;
  assert.match(input, /\[图片:https:\/\/example\.com\/a\.jpg\]/, 'the transcript still shows where it came from');
  assert.match(input, /图片已保存: \/tmp\/group-0\.jpg/, 'the look appends the local path');
  assert.match(input, /read_image/, 'and says which tool opens it');
  assert.deepEqual(imageCalls, [['https://example.com/a.jpg']], 'the picture is fetched exactly once');
});

test('the group cursor moves forward after a look', async () => {
  const { say, buffer, getCursor } = groupHarness();
  await say('小雨在吗');
  const cursor = getCursor();
  assert.ok(cursor, 'a look writes a cursor');
  assert.equal(cursor.lastAt, buffer[0].at);
  assert.ok(cursor.lastLookAt >= cursor.lastAt);
});

test('explicit group rules honor channel, peer, mention and record route',async()=>{
 const {manager,enqueued,task,marked}=harness();task.triggers[0].spec={channelId:'ch1',peerKind:'group',peerId:'room1',match:'mention',replyMode:'record'};
 const channel={id:'ch1',name:'fixture',type:'napcat',enabled:true,config:{}};
 const event={kind:'qq_group',channelId:'ch1',peerId:'room1',senderId:'100000001',text:'[@我] hello',mentioned:true,eventId:'g1'};
 for(const change of [{peerId:'other'},{channelId:'other'},{mentioned:false},{kind:'qq_private'}]){await manager.handleInbound(channel,{...event,...change});assert.equal(enqueued.length,0);}
 const result=await manager.handleInbound(channel,event);assert.equal(enqueued.length,1);assert.equal(enqueued[0].opts.meta.peerId,'room1');assert.equal(result.reply,'record-only');assert.equal(marked.at(-1).status,'processed');
});
