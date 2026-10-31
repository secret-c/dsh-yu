import { syncTriggerDefinitions } from './trigger-definitions.js';
import { zonedParts, zonedToInstant, minutesOfDay, now, dayKey } from './util.js';

/**
 * Trigger scheduling.
 *
 * Semantics, stated once so the page can state them too:
 * - every computation is done on the wall clock of `runtime.timezone`;
 * - a local time that does not exist (DST spring-forward) fires at the first
 *   instant after the gap; an ambiguous repeated time fires at the earlier one;
 * - a missed fire while Yu was down is governed by `runtime.catchUpPolicy`:
 *   `skip` reschedules without running, `run-once` fires a single late run;
 * - recurrence is computed from the trigger's own rule, never from "now plus
 *   interval" drift, so repeated restarts cannot shift a daily 20:00 task.
 */

const FIELD_RANGES = [
  { name: 'minute', lo: 0, hi: 59 },
  { name: 'hour', lo: 0, hi: 23 },
  { name: 'dom', lo: 1, hi: 31 },
  { name: 'month', lo: 1, hi: 12 },
  { name: 'dow', lo: 0, hi: 6 },
];

export class CronError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CronError';
    this.code = 'CRON_INVALID';
  }
}

function expandField(text, { name, lo, hi }) {
  const values = new Set();
  for (const part of String(text).split(',')) {
    const chunk = part.trim();
    if (!chunk) throw new CronError(`empty ${name} field`);
    let step = 1;
    let range = chunk;
    const slash = chunk.indexOf('/');
    if (slash >= 0) {
      step = Number(chunk.slice(slash + 1));
      range = chunk.slice(0, slash);
      if (!Number.isInteger(step) || step < 1) throw new CronError(`invalid step in ${name}: ${chunk}`);
    }
    let start;
    let end;
    if (range === '*') {
      start = lo;
      end = hi;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      start = a;
      end = b;
    } else {
      const single = Number(range);
      // `5/15` means "from 5 to the field max, every 15".
      start = single;
      end = slash >= 0 ? hi : single;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < lo || end > hi || start > end) {
      throw new CronError(`invalid ${name} value: ${chunk} (expected ${lo}-${hi})`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  if (!values.size) throw new CronError(`empty ${name} field`);
  return values;
}

export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError('a cron expression needs exactly 5 fields');
  const sets = parts.map((text, index) => expandField(text, FIELD_RANGES[index]));
  // Normalize Sunday: 7 also means Sunday.
  if (parts[4].includes('7')) sets[4].add(0);
  return {
    minute: [...sets[0]].sort((a, b) => a - b),
    hour: [...sets[1]].sort((a, b) => a - b),
    dom: [...sets[2]].sort((a, b) => a - b),
    month: [...sets[3]].sort((a, b) => a - b),
    dow: [...new Set([...sets[4]].map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b),
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

function dayMatches(cron, { month, day, weekday }) {
  if (!cron.month.includes(month)) return false;
  const domOk = cron.dom.includes(day);
  const dowOk = cron.dow.includes(weekday);
  // Vixie crontab: when both day fields are restricted, either one matches.
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

/** Next instant matching `cron`, strictly after `fromMs`. */
export function nextCronFire(cron, fromMs, timeZone, { maxDays = 400 } = {}) {
  const start = fromMs + 1;
  // Walk calendar days in the zone, then the allowed hours/minutes inside them.
  const startParts = zonedParts(start, timeZone);
  let cursor = { year: startParts.year, month: startParts.month, day: startParts.day };
  for (let d = 0; d < maxDays; d++) {
    const weekday = isoWeekdayOf(cursor, timeZone);
    if (dayMatches(cron, { month: cursor.month, day: cursor.day, weekday })) {
      for (const hour of cron.hour) {
        for (const minute of cron.minute) {
          const instant = zonedToInstant(
            { year: cursor.year, month: cursor.month, day: cursor.day, hour, minute, second: 0 },
            timeZone,
          );
          if (instant > fromMs) return instant;
        }
      }
    }
    cursor = addDayParts(cursor);
  }
  return null;
}

function isoWeekdayOf({ year, month, day }) {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun
  return dow;
}

function addDayParts({ year, month, day }) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

/** Next instant for a `daily`/`weekly` HH:MM rule. */
function nextWallTimeFire({ at, days = null }, fromMs, timeZone) {
  const [hh, mm] = String(at).split(':').map(Number);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) throw new CronError('spec.at must be HH:MM');
  const p = zonedParts(fromMs, timeZone);
  let cursor = { year: p.year, month: p.month, day: p.day };
  for (let i = 0; i < 400; i++) {
    const weekday = isoWeekdayOf(cursor);
    if (!days || days.includes(weekday === 0 ? 7 : weekday)) {
      const instant = zonedToInstant({ ...cursor, hour: hh, minute: mm, second: 0 }, timeZone);
      if (instant > fromMs) return instant;
    }
    cursor = addDayParts(cursor);
  }
  return null;
}

/**
 * Resolve the next fire instant for a trigger.
 * `interval` is anchored on the previous fire (or on `anchorMs` when fresh) so a
 * restart never shortens or stretches the period.
 */
export function nextFireFor(trigger, { fromMs = now(), timeZone = 'Asia/Shanghai', anchorMs = null, random = Math.random } = {}) {
  const spec = trigger.spec ?? {};
  timeZone = spec.timezone || timeZone;
  if (trigger.type !== 'schedule') return null;
  switch (spec.kind) {
    case 'daily':
      return nextWallTimeFire({ at: spec.at }, fromMs, timeZone);
    case 'weekly': {
      const days = (spec.days ?? []).map(Number).filter((d) => d >= 1 && d <= 7);
      if (!days.length) throw new CronError('weekly schedule has no weekday');
      return nextWallTimeFire({ at: spec.at, days }, fromMs, timeZone);
    }
    case 'random':
    case 'roll': {
      const meanMs = Number(spec.minutes) * 60_000;
      if (!(meanMs >= 60_000 && meanMs <= 10080 * 60_000)) throw new CronError('invalid random period');
      const wait = spec.cadence === 'interval' ? meanMs : Math.max(Number(spec.cooldownMinutes ?? 1) * 60_000, -Math.log1p(-Math.min(1 - Number.EPSILON, Math.max(0, random()))) * meanMs);
      let candidate = fromMs + Math.ceil(wait);
      if (spec.hours) {
        const [start,end] = spec.hours;
        const hour = zonedParts(candidate,timeZone).hour;
        if (hour < start || hour >= end) candidate = nextWallTimeFire({at:String(start).padStart(2,'0')+':00'},candidate,timeZone);
      }
      return candidate;
    }
    case 'interval': {
      const stepMs = Math.max(1, Number(spec.minutes) || 0) * 60_000;
      if (!stepMs) throw new CronError('interval schedule has no minutes');
      const base = anchorMs ?? trigger.lastFiredAt ?? fromMs;
      if (!anchorMs && !trigger.lastFiredAt) return fromMs + stepMs;
      let next = base + stepMs;
      if (next <= fromMs) {
        const skipped = Math.floor((fromMs - base) / stepMs) + 1;
        next = base + skipped * stepMs;
      }
      return next;
    }
    case 'cron':
      return nextCronFire(parseCron(spec.expr), fromMs, timeZone);
    default:
      throw new CronError(`unknown schedule kind "${spec.kind}"`);
  }
}

/** Human sentence used by the UI and by the audit log. */
export function describeTrigger(trigger, timeZone = 'Asia/Shanghai') {
  const spec = trigger.spec ?? {};
  timeZone = spec.timezone || timeZone;
  switch (trigger.type) {
    case 'manual':
      return spec.event==='new-session' ? '新会话开始前（等待完成；创建空任务不触发）' : '仅手动运行';
    case 'system':
      return spec.label ? `系统事件：${spec.label}` : '系统事件';
    case 'group-watch': {
      const words = (spec.keywords ?? []).join('、') || '（无）';
      if (spec.policy === 'keyword-or-count') return `群聊看一眼（群 ${spec.peerId || '待选择'}）：叫「${words}」或累计 ${spec.messageCount ?? 20} 条；看后可保持安静，仅回复原群`;
      const odds = Math.round((spec.keywordProbability ?? 0) * 100);
      const peak = Math.round((spec.peakMultiplier ?? 0) * 100);
      return (
        `群聊观察${spec.peerId ? `（群 ${spec.peerId}）` : '（所有群）'}：` +
        `叫「${words}」按 ${odds}% 回，峰价 ×${peak}%；` +
        `刷屏 ${spec.floodThreshold ?? 12} 条/${spec.floodWindowSec ?? 90} 秒看一眼`
      );
    }
    case 'webhook':
      return `外部触发：POST /api/hooks/${spec.token}`;
    case 'message': {
      const peer = spec.peerKind === 'private' ? '私聊' : spec.peerKind === 'group' ? '群聊' : '任意会话';
      const match =
        spec.match === 'prefix'
          ? `以「${spec.value || ''}」开头`
          : spec.match === 'contains'
            ? `包含「${spec.value || ''}」`
            : spec.match === 'commands'
              ? '斜杠命令'
              : spec.match === 'mention' ? '@我'
              : '任意消息';
      const hours = Array.isArray(spec.hours) ? `，仅 ${spec.hours[0]}:00–${spec.hours[1]}:00` : '';
      const cap = spec.maxPerHour ? `，每小时最多 ${spec.maxPerHour} 条` : '';
      return `${peer}${spec.peerId ? ' · '+spec.peerId : ''}消息（${match}${hours}${cap}）${spec.replyMode === 'record' ? ' · 仅记录' : ''}`;
    }
    case 'schedule': {
      const catchUp = trigger.misfirePolicy === 'run-once' ? '，错过补一次' : '';
      switch (spec.kind) {
        case 'daily':
          return `每天 ${spec.at}（${timeZone}）${catchUp}`;
        case 'weekly': {
          const names = ['日', '一', '二', '三', '四', '五', '六'];
          const days = (spec.days ?? []).map((d) => names[d % 7]).join('、');
          return `每周${days} ${spec.at}（${timeZone}）${catchUp}`;
        }
        case 'random':
        case 'roll':
          return (spec.cadence === 'interval' ? '固定周期 ' : '泊松指数等待，平均 ') + spec.minutes + ' 分钟' + (spec.kind === 'roll' ? '；掷 d' + spec.sides + '，≤ ' + spec.target + ' 执行（' + Math.round(spec.target/spec.sides*10000)/100 + '%）' : '；到期执行') + '；冷却 ≥ ' + (spec.cooldownMinutes ?? 1) + ' 分钟' + (spec.hours ? '；' + spec.hours[0]+':00–'+spec.hours[1]+':00' : '');
        case 'interval':
          return `每 ${spec.minutes} 分钟`;
        case 'cron':
          return `cron：${spec.expr}`;
        default:
          return '定时（未配置）';
      }
    }
    default:
      return trigger.type;
  }
}

/**
 * Should a missed fire be caught up?
 *
 * Pure so the rule is testable and so the scheduler cannot quietly invent a
 * different one. Today's rule set:
 *  - `misfirePolicy: 'skip'` never back-fills;
 *  - `'run-once'` fires once when the machine returns — and never twice in the
 *    same local day, which is what "一天最多补一次" means in practice;
 *  - a slot older than 36 hours is stale: reschedule, do not run yesterday's job
 *    at noon today.
 */
export function decideCatchUp({ policy, lateBy, lastFiredAt = null, at, timeZone }) {
  if (policy !== 'run-once') return { fire: false, reason: 'policy=skip' };
  if (lateBy > 36 * 3_600_000) return { fire: false, reason: `stale by ${Math.round(lateBy / 3_600_000)}h` };
  if (lastFiredAt && dayKey(lastFiredAt, timeZone) === dayKey(at, timeZone)) {
    return { fire: false, reason: 'already fired today' };
  }
  return { fire: true, reason: 'catch-up' };
}

/**
 * The tick loop. One timer, idempotent start/stop, and a guard so a slow fire
 * computation can never enqueue the same trigger twice in one tick window.
 */
export function createScheduler({ repo, settings, runner, log, onError = () => {} }) {
  let timer = null;
  let running = false;
  const TICK_MS = 10_000;
  // A fire this far in the past means Yu was not running at the scheduled time.
  const MISFIRE_GRACE_MS = 120_000;

  const tz = () => settings.get('runtime.timezone');

  // A missed daily slot is worth running when it is still "recent". A three-day
  // old diary entry is noise: reschedule instead of writing yesterday's page at
  // noon today.
  const CATCH_UP_MAX_LATE_MS = 36 * 3_600_000;

  /**
   * Which catch-up rule applies to this trigger.
   *
   * The trigger's own `misfirePolicy` wins; the global setting is only the
   * fallback for triggers created before the field existed.
   */
  const catchUpPolicyFor = (trigger) => trigger.misfirePolicy ?? settings.get('runtime.catchUpPolicy') ?? 'skip';

  /**
   * Decide whether a missed fire is caught up. The pure rule lives in
   * `decideCatchUp` so the tests can state it without a clock or a database.
   */
  const checkCatchUp = ({ trigger, at, lateBy, policy }) =>
    decideCatchUp({ policy, lateBy, lastFiredAt: trigger.lastFiredAt ?? null, at, timeZone: trigger.spec?.timezone || tz() });

  const computeNext = (trigger, fromMs = now(), anchorMs = null) => {
    try {
      return nextFireFor(trigger, { fromMs, timeZone: tz(), anchorMs });
    } catch (error) {
      log?.warn(`trigger ${trigger.id} has an invalid schedule: ${error.message}`);
      return null;
    }
  };

  const refresh = (triggerId) => {
    const trigger = repo.triggers.get(triggerId);
    if (!trigger) return null;
    if (trigger.type !== 'schedule' || !trigger.enabled) {
      repo.triggers.setSchedule(triggerId, { nextFireAt: null });
      return null;
    }
    const next = computeNext(trigger, now());
    repo.triggers.setSchedule(triggerId, { nextFireAt: next });
    return next;
  };

  const refreshAll = () => {
    syncTriggerDefinitions({ repo, settings });
    let count = 0;
    for (const trigger of repo.triggers.listScheduled()) {
      if (!trigger.enabled || trigger.nextFireAt != null) continue;
      const next = computeNext(trigger, now(), trigger.nextFireAt ?? null);
      repo.triggers.setSchedule(trigger.id, { nextFireAt: next });
      count++;
    }
    return count;
  };

  /**
   * Nightly memory maintenance is a normal task with a daily trigger (see
   * `ensureMaintenanceSchedule`), so the scheduler needs no special case here:
   * the task page shows the next fire and the run history shows the result.
   */
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const at = now();
      // The same durable run queue and conversation lock finalize sessions
      // after the local day changes, even if no new message arrives.
      runner.rolloverDue?.();
      const due = repo.triggers.due(at);
      for (const trigger of due) {
        const task = repo.tasks.get(trigger.taskId);
        if (!task || task.deletedAt || !task.enabled) {
          repo.triggers.setSchedule(trigger.id, { nextFireAt: null });
          continue;
        }
        if (['random','roll'].includes(trigger.spec?.kind) && trigger.spec.hours) {
          const hour = zonedParts(at,trigger.spec.timezone || tz()).hour;
          if (hour < trigger.spec.hours[0] || hour >= trigger.spec.hours[1]) { repo.triggers.setSchedule(trigger.id,{nextFireAt:computeNext(trigger,at)}); continue; }
        }
        const lateBy = at - (trigger.nextFireAt ?? at);
        const next = computeNext(trigger, at);
        const policy = catchUpPolicyFor(trigger);
        const missed = lateBy > MISFIRE_GRACE_MS;

        if (missed) {
          const verdict = checkCatchUp({ trigger, at, lateBy, policy });
          if (!verdict.fire) {
            log?.info(`skipping missed fire of ${task.name} (${verdict.reason}, late ${Math.round(lateBy / 60000)}min)`);
            repo.triggers.setSchedule(trigger.id, { nextFireAt: next, lastFiredAt: trigger.lastFiredAt ?? null });
            repo.audit.log('trigger.missed', trigger.id, { taskId: task.id, lateBy, reason: verdict.reason }, 'scheduler');
            continue;
          }
          log?.info(
            `catching up ${task.name}: scheduled ${new Date(trigger.nextFireAt).toISOString()}, ` +
              `late ${Math.round(lateBy / 60000)}min (once per day)`,
          );
        }

        repo.triggers.setSchedule(trigger.id, { nextFireAt: next, lastFiredAt: at });
        const scheduledFor = trigger.nextFireAt;
        let roll = null;
        if (trigger.spec?.kind === 'roll') {
          roll = 1 + Math.floor(Math.random() * trigger.spec.sides);
          repo.audit.log('trigger.roll', trigger.id, { scheduledFor, roll, sides: trigger.spec.sides, target: trigger.spec.target, matched: roll <= trigger.spec.target }, 'scheduler');
          if (roll > trigger.spec.target) continue;
        }
        try {
          runner.enqueue(task, {
            triggerId: trigger.id,
            reason: missed
              ? // Describe the slot itself: "错过补一次" is the policy, not part of
                // what happened, and repeating it here reads like a stutter.
                `补跑 ${describeTrigger({ ...trigger, misfirePolicy: 'skip' }, tz())}（错过 ${Math.round(lateBy / 60000)} 分钟）`
              : `定时触发 ${describeTrigger(trigger, tz())}`,
            trigger: { scheduledFor, firedAt: at, lateBy, catchUp: missed, roll },
          });
        } catch (error) {
          log?.error(`enqueue for ${task.name} failed: ${error.message}`);
          onError(error);
        }
      }
    } catch (error) {
      log?.error(`scheduler tick failed: ${error.message}`);
      onError(error);
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer) return;
      refreshAll();
      timer = setInterval(() => {
        void tick();
      }, TICK_MS);
      timer.unref?.();
      log?.info(`scheduler started (timezone ${tz()}, tick ${TICK_MS / 1000}s)`);
      void tick();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log?.info('scheduler stopped');
      }
    },
    tick,
    refresh,
    refreshAll,
    computeNext,
    describe: (trigger) => describeTrigger(trigger, tz()),
    timezone: tz,
  };
}
