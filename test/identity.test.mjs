import test from 'node:test';
import assert from 'node:assert/strict';

import { guestToolPolicy } from '../lib/runner.js';
import { renderTranscript } from '../lib/group-watch.js';
import { privateIdentityLine } from '../lib/channels/manager.js';
import { SETTINGS_SPEC } from '../lib/settings.js';

test('a private message from the owner says so', () => {
  const line = privateIdentityLine({ senderName: '测试用户', senderId: '100000001', senderIsOwner: true });
  assert.match(line, /测试用户/);
  assert.match(line, /100000001/);
  assert.match(line, /主人/);
  assert.equal(line.includes('不是主人'), false);
});

test('a private message from anyone else is marked as not the owner', () => {
  const line = privateIdentityLine({ senderName: '111', senderId: '100000002', senderIsOwner: false });
  assert.match(line, /111/);
  assert.match(line, /100000002/);
  assert.match(line, /不是主人/);
});

test('a guest loses the self-modification and shell tools, reads stay', () => {
  const policy = guestToolPolicy({ mode: 'all', allow: [], deny: [] });
  assert.equal(policy.mode, 'deny');
  assert.ok(policy.deny.includes('yu_admin'));
  assert.ok(policy.deny.includes('bash'));
  assert.ok(!policy.deny.includes('read'));
  assert.ok(!policy.deny.includes('memory.search'));
});

test('a guest policy keeps an existing allow list minus the denied names', () => {
  const policy = guestToolPolicy({ mode: 'allow', allow: ['read', 'yu_admin', 'grep'], deny: [] });
  assert.equal(policy.mode, 'allow');
  assert.deepEqual(policy.allow, ['read', 'grep']);
  assert.ok(policy.deny.includes('yu_admin'));
});

test('an allow list made only of denied tools remains an empty allow list', () => {
  const policy = guestToolPolicy({ mode: 'allow', allow: ['yu_admin'], deny: [] });
  assert.equal(policy.mode, 'allow');
  assert.deepEqual(policy.allow, []);
  assert.ok(policy.deny.includes('yu_admin'));
});

test('the group transcript marks the owner and leaves everyone else alone', () => {
  const at = 1_700_000_000_000;
  const text = renderTranscript(
    [
      { senderId: '100000001', senderName: '测试用户', text: '这个怎么配', at },
      { senderId: '100000002', senderName: '111', text: '同问', at },
    ],
    { at, ownerIds: new Set(['100000001']) },
  );
  assert.match(text, /测试用户（主人）：这个怎么配/);
  assert.match(text, /111：同问/);
  assert.equal(text.includes('111（主人）'), false);
});

test('the owner QQ list is a real setting with an empty default for a new install', () => {
  const spec = SETTINGS_SPEC.find((item) => item.key === 'channel.ownerIds');
  assert.ok(spec, 'channel.ownerIds must exist');
  assert.equal(spec.def, '');
  assert.equal(spec.group, 'channel');
});
