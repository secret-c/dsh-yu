import { now, humanDuration } from './util.js';

/**
 * QQ health alerting.
 *
 * The state machine is pure and lives here so the page can run an isolated
 * simulation (no SMTP, no network, no side effects) and show exactly which
 * notifications would have been produced. The live evaluator is the same code
 * fed by real channel health.
 *
 * Categories are deliberately distinct, because "the network blipped" and
 * "the account was signed out" need different responses:
 *   transient   短暂断网 / 刚好在重连
 *   offline     账号离线
 *   auth-failed 认证失败（token / 签名 / 授权码）
 *   permission  权限不足或凭据缺失
 *   disabled    主动停用 —— 默认不告警
 */

export const ALERT_CATEGORIES = ['ok', 'transient', 'offline', 'auth-failed', 'permission', 'disabled'];

export function categoryOf(healthState) {
  switch (healthState) {
    case 'ok':
      return 'ok';
    case 'disabled':
      return 'disabled';
    case 'auth-failed':
      return 'auth-failed';
    case 'permission':
      return 'permission';
    case 'offline':
      return 'offline';
    default:
      return 'transient';
  }
}

export function describeCategory(category) {
  switch (category) {
    case 'ok':
      return '正常';
    case 'transient':
      return '短暂异常（未达阈值）';
    case 'offline':
      return '账号离线';
    case 'auth-failed':
      return '认证失败';
    case 'permission':
      return '权限/凭据不足';
    case 'disabled':
      return '主动停用（不告警）';
    default:
      return category;
  }
}

/**
 * One state transition.
 * @param prev   previous state `{ status, since, lastSentAt, alerted, count }`
 * @param sample `{ at, category, detail }`
 * @param cfg    `{ thresholdMs, cooldownMs, notifyRecovery, suppressedUntil }`
 * @returns `{ state, action }` where action is null | {kind:'alert'|'recovery', reason}
 */
export function transition(prev, sample, cfg) {
  const base = prev ?? { status: 'ok', since: sample.at, lastSentAt: null, alerted: false, count: 0 };
  const category = sample.category;

  if (category === 'disabled') {
    // A deliberate stop must never raise an alert, but it also must not erase
    // the fact that the operator was already told the connection was broken:
    // when it comes back, a recovery notice is still owed.
    return {
      state: { ...base, status: 'disabled', since: sample.at, count: 0 },
      action: null,
    };
  }

  if (category === 'ok') {
    const wasAlerted = Boolean(base.alerted);
    const next = { ...base, status: 'ok', since: sample.at, alerted: false, count: 0 };
    if (wasAlerted && cfg.notifyRecovery) {
      const suppressed = cfg.suppressedUntil && sample.at < cfg.suppressedUntil;
      if (!suppressed) {
        return {
          state: { ...next, lastSentAt: sample.at },
          action: { kind: 'recovery', reason: '连接已恢复', detail: sample.detail ?? '' },
        };
      }
    }
    return { state: next, action: null };
  }

  // Unhealthy.
  const continuing = base.status === category || (base.status !== 'ok' && base.status !== 'disabled');
  const since = continuing ? base.since : sample.at;
  const count = (base.count ?? 0) + 1;
  const elapsed = sample.at - since;
  const next = { ...base, status: category, since, count, lastReason: sample.detail ?? '' };

  const suppressed = cfg.suppressedUntil && sample.at < cfg.suppressedUntil;
  const reachedThreshold = elapsed >= cfg.thresholdMs;
  const cooldownElapsed = !base.lastSentAt || sample.at - base.lastSentAt >= cfg.cooldownMs;
  const dedupe = !base.alerted;

  if (!suppressed && reachedThreshold && dedupe && cooldownElapsed) {
    return {
      state: { ...next, alerted: true, lastSentAt: sample.at },
      action: {
        kind: 'alert',
        reason: `${describeCategory(category)} 持续 ${humanDuration(elapsed)}`,
        detail: sample.detail ?? '',
        category,
      },
    };
  }
  return { state: next, action: null };
}

export function buildAlertMail({ channelName, category, elapsedMs, detail, adminUrl, since }) {
  const subject = `Yu：QQ 连接异常（${describeCategory(category)}）`;
  const body = [
    `连接：${channelName}`,
    `状态：${describeCategory(category)}`,
    `持续：${humanDuration(elapsedMs ?? 0)}`,
    `开始：${since ? new Date(since).toISOString() : '未知'}`,
    detail ? `详情：${detail}` : '',
    '',
    '处理建议：',
    category === 'offline' ? '- 检查 QQ 客户端是否被登出，必要时重新扫码登录。' : '',
    category === 'auth-failed' ? '- 检查 OneBot 令牌、Webhook 签名密钥或邮箱授权码是否过期。' : '',
    category === 'permission' ? '- 检查账号凭据、应用权限与订阅配置是否完整。' : '',
    category === 'transient' ? '- 若只是短暂断网，可忽略；若持续异常请检查本机网络。' : '',
    adminUrl ? `\n管理入口：${adminUrl}` : '',
    '',
    '— Yu',
  ]
    .filter((line) => line !== '')
    .join('\n');
  return { subject, body };
}

/**
 * Isolated simulation. No network, no SMTP, no database writes: it runs the
 * exact state machine over a supplied sample sequence and returns the timeline.
 */
export function simulate({ samples, config }) {
  const cfg = {
    thresholdMs: Math.max(0, Number(config?.thresholdMs ?? 15 * 60_000)),
    cooldownMs: Math.max(0, Number(config?.cooldownMs ?? 180 * 60_000)),
    notifyRecovery: config?.notifyRecovery !== false,
    suppressedUntil: Number(config?.suppressedUntil ?? 0) || 0,
  };
  let state = null;
  const timeline = [];
  for (const sample of samples) {
    const { state: nextState, action } = transition(state, sample, cfg);
    const changed = !state || state.status !== nextState.status;
    state = nextState;
    timeline.push({
      at: sample.at,
      category: sample.category,
      label: describeCategory(sample.category),
      detail: sample.detail ?? '',
      statusChanged: changed,
      action,
      alerted: Boolean(nextState.alerted),
      since: nextState.since,
    });
  }
  return { config: cfg, timeline, final: state, actions: timeline.filter((t) => t.action) };
}

export function defaultSimulationSamples(baseAt = now()) {
  const minute = 60_000;
  return [
    { at: baseAt, category: 'ok', detail: '连接正常' },
    { at: baseAt + 2 * minute, category: 'transient', detail: 'WebSocket 断开' },
    { at: baseAt + 4 * minute, category: 'ok', detail: '已自动重连' },
    { at: baseAt + 10 * minute, category: 'offline', detail: 'OneBot 报告 QQ 未登录' },
    { at: baseAt + 20 * minute, category: 'offline', detail: '仍未登录（10 分钟，未达阈值 15 分钟）' },
    { at: baseAt + 30 * minute, category: 'offline', detail: '持续 20 分钟，达到阈值 → 发送提醒' },
    { at: baseAt + 31 * minute, category: 'offline', detail: '重复采样，冷却期内不重复发送' },
    { at: baseAt + 40 * minute, category: 'disabled', detail: '管理员主动停用连接（不告警）' },
    { at: baseAt + 50 * minute, category: 'ok', detail: '重新启用并登录成功 → 发送恢复提醒' },
  ];
}

export function createAlertService({ repo, settings, channels, mail, log, getAdminBaseUrl }) {
  let monitor = null;
  let busy = false;
  const cfg = () => ({
    thresholdMs: settings.get('alert.qqFailureMinutes') * 60_000,
    cooldownMs: settings.get('alert.cooldownMinutes') * 60_000,
    notifyRecovery: settings.get('alert.notifyRecovery'),
    suppressedUntil: settings.get('alert.maintenanceUntil'),
  });

  const keyFor = (channelId) => `qq-health:${channelId}`;

  const evaluate = async ({ dryRun = false } = {}) => {
    const results = [];
    const at = now();
    const statuses = channels.status();
    for (const channel of statuses) {
      if (!['napcat', 'snowluma', 'qq-official'].includes(channel.type)) continue;
      const health = channel.health ?? { state: 'disabled', detail: '' };
      const category = categoryOf(health.state);
      const stored = repo.alerts.get(keyFor(channel.id));
      const { state, action } = transition(
        stored
          ? {
              status: stored.status,
              since: stored.since,
              lastSentAt: stored.lastSentAt,
              alerted: Boolean(stored.lastSentAt && stored.status !== 'ok'),
              count: stored.count,
              lastReason: stored.lastReason,
            }
          : null,
        { at, category, detail: health.detail ?? '' },
        cfg(),
      );
      if (!dryRun) {
        repo.alerts.upsert(keyFor(channel.id), {
          status: state.status,
          since: state.since,
          lastSentAt: state.lastSentAt,
          lastReason: state.lastReason,
          count: state.count,
          suppressedUntil: cfg().suppressedUntil || null,
        });
      }
      if (action) {
        const elapsedMs = at - state.since;
        const mailContent = buildAlertMail({
          channelName: channel.name,
          category,
          elapsedMs,
          detail: health.detail,
          adminUrl: getAdminBaseUrl?.(),
          since: state.since,
        });
        let delivery = { ok: false, skipped: true, reason: 'dry-run' };
        if (!dryRun) {
          if (!settings.get('mail.enabled')) {
            delivery = { ok: false, skipped: true, reason: '邮件提醒未启用' };
          } else {
            try {
              const sent = await mail.sendTest({
                subject: mailContent.subject,
                body: mailContent.body,
              });
              delivery = { ok: true, reply: sent.reply ?? null };
            } catch (error) {
              delivery = { ok: false, reason: error.message, code: error.code };
              log?.warn(`alert mail delivery failed: ${error.message}`);
            }
          }
          repo.audit.log('alert.fire', channel.id, { category, delivery }, 'system');
        }
        results.push({ channelId: channel.id, channelName: channel.name, category, action, mail: mailContent, delivery });
      }
    }
    return { at, results, config: cfg(), mailReady: settings.get('mail.enabled') };
  };

  const evaluateChannelHealth = (channelId, override) => {
    const statuses = channels.status();
    const target = statuses.find((c) => c.id === channelId);
    if (target && !override) return target.health ?? { state: 'disabled', detail: '' };
    return override ?? { state: 'unknown', detail: '没有找到该连接' };
  };

  const preview = async (options = {}) => {
    const result = await evaluate({ dryRun: true });
    return {
      ...result,
      note: '这是隔离预览：没有发送邮件，也没有写入状态。',
      channelHealth: channels.status().map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        enabled: c.enabled,
        health: c.health ?? null,
        category: categoryOf((c.health ?? {}).state),
      })),
      ...options,
    };
  };

  return {
    evaluate,
    preview,
    simulate: (options) =>
      simulate({
        samples: options?.samples?.length ? options.samples : defaultSimulationSamples(options?.baseAt),
        config: { ...cfg(), ...(options?.config ?? {}) },
      }),
    buildAlertMail,
    categoryOf,
    describeCategory,
    evaluateChannelHealth,
    states: () => repo.alerts.list ? repo.alerts.list() : [],
    resetChannel(channelId) {
      repo.alerts.upsert(keyFor(channelId), { status: 'ok', since: now(), lastSentAt: null, count: 0 });
    },
    /** Continuous monitoring: this is the "持续监听" band in the timeline. */
    startMonitoring(intervalMs = 60_000) {
      if (monitor) return;
      monitor = setInterval(() => {
        if (busy) return;
        busy = true;
        void evaluate()
          .catch((error) => log?.warn(`alert evaluation failed: ${error.message}`))
          .finally(() => {
            busy = false;
          });
      }, intervalMs);
      monitor.unref?.();
      log?.info(`QQ health monitoring started (every ${Math.round(intervalMs / 1000)}s)`);
    },
    stopMonitoring() {
      if (monitor) {
        clearInterval(monitor);
        monitor = null;
      }
    },
  };
}
