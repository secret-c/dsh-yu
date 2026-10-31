import test from 'node:test';
import assert from 'node:assert/strict';
import { rolloverReason, isOwnerMainChat, dailyJournalSources, compareJournalCursor } from '../lib/session-rollover.js';
import { persistJournal } from '../lib/journal-output.js';

test('daily boundary and pending rollover', () => {
  const c = { sessionId: 's', meta: { sessionDay: '2026-10-31' } };
  assert.equal(rolloverReason(c, Date.parse('2026-10-31T15:59:59Z'), 'Asia/Shanghai', 'daily'), null);
  assert.equal(rolloverReason(c, Date.parse('2026-10-31T16:00:00Z'), 'Asia/Shanghai', 'daily'), 'day-end');
  c.meta.rolloverDue = { sessionId: 's', reason: 'pressure' };
  assert.equal(rolloverReason(c, Date.now(), 'Asia/Shanghai', 'keep'), 'pressure');
  c.archivedAt = 1;
  assert.equal(rolloverReason(c, Date.now(), 'Asia/Shanghai', 'daily'), null);
  assert.equal(rolloverReason({sessionId:'yu-maint-old',meta:{sessionDay:'2026-10-31'}},Date.now(),'Asia/Shanghai','daily'),null);
  assert.equal(rolloverReason({sessionId:'s',meta:{sessionDay:'2026-10-31',maintenance:true}},Date.now(),'Asia/Shanghai','daily'),null);
});

test('only owner private chat is owner main chat', () => {
  const settings = { get: () => '1, 2' };
  assert.equal(isOwnerMainChat({ kind: 'qq_private', peerId: '1', meta: { routeAuthority: 'owner' } }, settings), true);
  assert.equal(isOwnerMainChat({ kind: 'qq_private', peerId: '1', meta: {} }, settings), false);
  assert.equal(isOwnerMainChat({ kind: 'qq_private', peerId: '1', meta: { routeAuthority: 'guest' } }, settings), false);
  assert.equal(isOwnerMainChat({ kind: 'qq_group', peerId: '1' }, settings), false);
  assert.equal(isOwnerMainChat({ kind: 'qq_private', peerId: '3' }, settings), false);
});

test('daily sources exclude guest, group and maintenance and cap input', () => {
  const base = { queuedAt: Date.parse('2026-10-31T04:00:00Z'), businessDone: true, status: 'succeeded', inputText: 'x', outputText: 'y' };
  const rows = Array.from({ length: 35 }, (_, i) => ({ ...base, id: String(i), meta: { authority: 'owner', source: 'message' } }));
  rows.push({ ...base, id: 'guest', meta: { authority: 'guest' } }, { ...base, id: 'group', meta: { kind: 'qq_group' } }, { ...base, id: 'maintenance', taskId: 'm', meta: {} });
  const repo = { runs: { list: () => rows }, tasks: { get: () => ({ kind: 'maintenance' }) } };
  const result = dailyJournalSources(repo, '2026-10-31', 'Asia/Shanghai');
  assert.equal(result.included, 30);
  assert.ok(result.text.length <= 8000);
  assert.ok(!result.runIds.some(id => ['guest', 'group', 'maintenance'].includes(id)));
});

test('daily source pages preserve equal timestamps and split a single long run', () => {
  const at = Date.parse('2026-10-31T05:00:00Z');
  const rows = [
    { id: 'a', queuedAt: at, finishedAt: at, status: 'succeeded', businessDone: true,
      inputText: '😀'.repeat(5000), outputText: '尾段', meta: { authority: 'owner', source: 'message' } },
    { id: 'b', queuedAt: at, finishedAt: at, status: 'succeeded', businessDone: true,
      inputText: '同时间戳下一条', outputText: '完成', meta: { authority: 'owner', source: 'message' } },
  ];
  const repo = { runs: { listJournalSources: ({ cursor, limit }) => rows.filter(r =>
    r.finishedAt > cursor.at || (r.finishedAt === cursor.at &&
      (r.id > cursor.id || (r.id === cursor.id && cursor.offset > 0)))).slice(0, limit) },
    tasks: { get: () => null } };
  let cursor = null, pages = 0, collected = '';
  do {
    const page = dailyJournalSources(repo, '2026-10-31', 'Asia/Shanghai', cursor);
    assert.ok(page.text.length <= 8000);
    assert.ok(page.included > 0);
    assert.ok(compareJournalCursor(page.cursor, cursor) > 0);
    collected += page.text;
    cursor = page.cursor; pages++;
    if (!page.truncated) break;
  } while (pages < 20);
  assert.ok(pages > 1);
  assert.equal((collected.match(/😀/g) ?? []).length, 5000);
  assert.match(collected, /同时间戳下一条/);
  assert.match(collected, /尾段/);
});

test('journal appends once per session and preserves manual edits', () => {
  const docs = new Map();
  const repo = { documents: { get: id => docs.get(id), list: () => [...docs.values()], upsert: d => (docs.set(d.slug, d), d), update: (id, patch) => { const d = { ...docs.get(id), ...patch }; docs.set(id, d); return d; } }, transaction: fn => fn() };
  const run = id => ({ id, meta: { rolloverDay: '2026-10-31', rolloverSessionId: id } });
  persistJournal({ repo, run: run('a'), text: 'first' });
  docs.get('journal-2026-10-31').content += '\nmanual';
  persistJournal({ repo, run: run('b'), text: 'second' });
  const content = docs.get('journal-2026-10-31').content;
  assert.match(content, /first[\s\S]*manual[\s\S]*续记[\s\S]*second/);
  persistJournal({ repo, run: run('b'), text: 'second' });
  assert.equal(docs.get('journal-2026-10-31').content, content);
  assert.equal(docs.size, 1);
});
