import fs from 'node:fs';
import { randomToken, randomPairCode, sha256, safeEqual, now } from '../util.js';
import { writePrivateFile } from '../paths.js';
import { HttpError, sendJson } from './router.js';

/**
 * Admin authentication.
 *
 * The harness exposes no authenticated origin a plugin can reuse (its webserver
 * is a plain loopback carrier), so Yu implements the documented fallback: a
 * short-lived one-time pairing code shown only to the local operator, exchanged
 * for a long-lived device session.
 *
 * Why a pairing code rather than "anything on loopback is trusted": Yu can
 * execute tasks and reach real chat accounts. Any local process could otherwise
 * drive it. The code lives in `<dataDir>/pairing-code.txt` (mode 0600) and in the
 * harness log, so obtaining it already requires local file access.
 */

const COOKIE = 'yu_device';
const PAIR_WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 5 * 60_000;

export function createAuth({ repo, settings, paths, log }) {
  let pending = null; // { code, createdAt }
  const failures = new Map(); // ip -> { count, first }

  const activeDevices = () => repo.devices.countActive();

  const refreshPairCode = (reason = 'initial') => {
    pending = { code: randomPairCode(), createdAt: now() };
    try {
      writePrivateFile(
        paths.pairingCode,
        [
          'Yu 管理台配对码',
          '',
          pending.code,
          '',
          `生成时间：${new Date(pending.createdAt).toISOString()}`,
          '用途：在浏览器打开 Yu 管理台，输入此码完成一次性配对。',
          '该码只能使用一次；配对成功后本文件会被删除。',
          '若已存在设备会话，此文件不会重新生成。',
          '',
        ].join('\n'),
      );
    } catch (error) {
      log?.warn(`writing pairing code file failed: ${error.message}`);
    }
    log?.info(`Yu pairing code (${reason}): ${pending.code}`);
    return pending.code;
  };

  const clearPairCode = () => {
    pending = null;
    try {
      if (fs.existsSync(paths.pairingCode)) fs.unlinkSync(paths.pairingCode);
    } catch (error) {
      log?.debug(`removing pairing code file failed: ${error.message}`);
    }
  };

  /** Called once at boot: only mint a code when nobody is paired yet. */
  const bootstrap = () => {
    if (activeDevices() === 0) {
      refreshPairCode('first-run');
      return { pairingRequired: true, codeWrittenTo: paths.pairingCode };
    }
    clearPairCode();
    return { pairingRequired: false, codeWrittenTo: null };
  };

  const parseCookies = (req) => {
    const header = String(req.headers.cookie ?? '');
    const out = {};
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return out;
  };

  const deviceFromRequest = (req) => {
    const cookies = parseCookies(req);
    const token = cookies[COOKIE];
    if (!token) return null;
    const device = repo.devices.byTokenHash(sha256(token));
    if (!device) return null;
    const days = settings.get('web.sessionDays');
    const expiresAt = now() + days * 86400_000;
    repo.devices.touch(device.id, expiresAt);
    return { ...device, token, expiresAt };
  };

  const setDeviceCookie = (res, token, days) => {
    const maxAge = Math.floor(days * 86400);
    res.setHeader(
      'set-cookie',
      `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`,
    );
  };

  const clearDeviceCookie = (res) => {
    res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  };

  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true; // same-origin fetches may omit Origin on GET
    try {
      const parsed = new URL(origin);
      const host = req.headers.host;
      return parsed.host === host;
    } catch {
      return false;
    }
  };

  const fail = (req, res, status, code, message) => {
    sendJson(res, status, { error: { code, message } });
    return null;
  };

  const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

  /**
   * Is this request arriving from this machine over its loopback interface?
   *
   * Both facts matter: the socket address proves the TCP peer, and the Host
   * header proves the browser addressed loopback (so a proxy or a remote client
   * that spoofed the socket cannot borrow the loopback conveniences).
   */
  const isLoopback = (req) => {
    const remote = String(req.socket?.remoteAddress ?? '');
    const hostHeader = String(req.headers.host ?? '').toLowerCase();
    const hostName = hostHeader.replace(/:\d+$/, '');
    return LOOPBACK_ADDRESSES.has(remote) && LOOPBACK_HOSTS.has(hostName);
  };

  const guard = (req, res) => {
    if (!sameOrigin(req)) return fail(req, res, 403, 'ORIGIN_MISMATCH', '跨站请求被拒绝');
    return true;
  };

  const pair = (req, res, code) => {
    const ip = req.socket?.remoteAddress ?? 'unknown';
    const record = failures.get(ip) ?? { count: 0, first: now() };
    if (now() - record.first > FAILURE_WINDOW_MS) {
      record.count = 0;
      record.first = now();
    }
    if (record.count >= MAX_FAILURES) {
      throw new HttpError(429, 'PAIR_RATE_LIMITED', '配对尝试过于频繁，请稍后再试');
    }
    if (!pending) {
      throw new HttpError(409, 'NO_PAIRING_CODE', '当前没有待使用的配对码；重启 Yu 或从管理台重新生成');
    }
    if (now() - pending.createdAt > PAIR_WINDOW_MS) {
      clearPairCode();
      throw new HttpError(410, 'PAIRING_CODE_EXPIRED', '配对码已过期，请在宿主日志或数据目录重新获取');
    }
    if (!safeEqual(String(code ?? '').trim().toUpperCase(), pending.code)) {
      record.count += 1;
      failures.set(ip, record);
      throw new HttpError(401, 'PAIRING_CODE_INVALID', '配对码不正确');
    }
    const days = settings.get('web.sessionDays');
    const token = randomToken(32);
    const device = repo.devices.create({
      tokenHash: sha256(token),
      label: `${req.headers['user-agent'] ?? 'Browser'}`.slice(0, 120),
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400),
      days,
    });
    setDeviceCookie(res, token, days);
    clearPairCode();
    failures.delete(ip);
    repo.audit.log('auth.pair', device.id, { label: device.label }, 'user');
    log?.info(`device paired: ${device.label}`);
    return { deviceId: device.id, label: device.label, expiresAt: device.expires_at ?? device.expiresAt };
  };

  return {
    bootstrap,
    refreshPairCode,
    clearPairCode,
    parseCookies,
    deviceFromRequest,
    setDeviceCookie,
    clearDeviceCookie,
    guard,
    pair,
    isLoopback,
    fail,
    cookieName: COOKIE,
    pairingPending: () => activeDevices() === 0,
    activeDevices,
    hasPendingCode: () => Boolean(pending),
    pendingCode: () => pending?.code ?? null,
    pendingCodeCreatedAt: () => pending?.createdAt ?? null,
    /**
     * The authenticate hook the router calls for every non-public route.
     * Answers 401 itself and returns null.
     */
    authenticate(req, res) {
      if (!guard(req, res)) return null;
      const device = deviceFromRequest(req);
      if (!device) {
        sendJson(res, 401, {
          error: {
            code: 'UNAUTHENTICATED',
            message: '需要配对设备或重新登录',
            detail: { pairingRequired: activeDevices() === 0 },
          },
        });
        return null;
      }
      return { deviceId: device.id, label: device.label, expiresAt: device.expiresAt };
    },
  };
}
