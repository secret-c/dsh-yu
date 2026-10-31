import test from 'node:test';
import assert from 'node:assert/strict';

import { decideCatchUp, describeTrigger } from '../lib/scheduler.js';

const TZ = 'Asia/Shanghai';
// 2026-10-28 09:00 +08:00
const AT = Date.UTC(2026, 9, 28, 1, 0, 0);

test('a missed daily slot is caught up once when the machine comes back', () => {
  const verdict = decideCatchUp({ policy: 'run-once', lateBy: 40 * 60_000, lastFiredAt: null, at: AT, timeZone: TZ });
  assert.equal(verdict.fire, true);
  assert.equal(verdict.reason, 'catch-up');
});

test('skip policy never back-fills', () => {
  const verdict = decideCatchUp({ policy: 'skip', lateBy: 5 * 60_000, lastFiredAt: null, at: AT, timeZone: TZ });
  assert.equal(verdict.fire, false);
});

test('at most one catch-up per local day, even across restarts', () => {
  // It already ran this morning at 08:00 (same local day as AT).
  const sameDay = Date.UTC(2026, 9, 28, 0, 0, 0);
  const verdict = decideCatchUp({ policy: 'run-once', lateBy: 60 * 60_000, lastFiredAt: sameDay, at: AT, timeZone: TZ });
  assert.equal(verdict.fire, false);
  assert.equal(verdict.reason, 'already fired today');

  // Yesterday's run does not block today's catch-up.
  const yesterday = Date.UTC(2026, 9, 27, 0, 0, 0);
  assert.equal(
    decideCatchUp({ policy: 'run-once', lateBy: 60 * 60_000, lastFiredAt: yesterday, at: AT, timeZone: TZ }).fire,
    true,
  );
});

test('a slot older than 36 hours is stale, not caught up', () => {
  const verdict = decideCatchUp({ policy: 'run-once', lateBy: 50 * 3_600_000, lastFiredAt: null, at: AT, timeZone: TZ });
  assert.equal(verdict.fire, false);
  assert.match(verdict.reason, /stale/);
});

test('the trigger description says whether it will catch up', () => {
  const daily = describeTrigger({
    type: 'schedule',
    misfirePolicy: 'run-once',
    spec: { kind: 'daily', at: '23:30' },
  });
  assert.match(daily, /每天 23:30/);
  assert.match(daily, /错过补一次/);

  const skip = describeTrigger({ type: 'schedule', misfirePolicy: 'skip', spec: { kind: 'daily', at: '23:30' } });
  assert.doesNotMatch(skip, /补一次/);
});

test('group-watch and message descriptions survive the schedule change', () => {
  const watch = describeTrigger({
    type: 'group-watch',
    misfirePolicy: 'skip',
    spec: { keywords: ['小雨'], keywordProbability: 0.35, peakMultiplier: 0.3, floodThreshold: 12, floodWindowSec: 90 },
  });
  assert.match(watch, /群聊观察/);
  assert.match(watch, /35%/);

  const message = describeTrigger({ type: 'message', spec: { peerKind: 'private', match: 'any' } });
  assert.match(message, /私聊消息/);
});
