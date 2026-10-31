import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { isEmail, truncate } from '../util.js';

/**
 * A small SMTP client.
 *
 * Yu needs three things from mail: preview a message locally, send a real test
 * after explicit authorisation, and deliver an alert. Pulling in nodemailer
 * would mean shipping a dependency tree inside a plugin, so the subset SMTP
 * actually needs is implemented here: EHLO, AUTH LOGIN/PLAIN, MAIL/RCPT/DATA,
 * implicit TLS or STARTTLS, and a hard timeout at every await.
 *
 * Every failure carries the SMTP reply code and text so the page can show the
 * provider's own words instead of "send failed".
 */

const encoder = new TextEncoder();

export class MailError extends Error {
  constructor(message, code, detail = {}) {
    super(message);
    this.name = 'MailError';
    this.code = code;
    this.detail = detail;
  }
}

class SmtpSession {
  constructor(socket, log) {
    this.socket = socket;
    this.log = log;
    this.buffer = '';
    this.waiters = [];
    this.closed = false;
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      this.drain();
    });
    socket.on('error', (error) => {
      this.closed = true;
      this.failAll(new MailError(`连接错误：${error.message}`, 'SMTP_SOCKET', { message: error.message }));
    });
    socket.on('close', () => {
      this.closed = true;
      this.failAll(new MailError('连接被对端关闭', 'SMTP_CLOSED'));
    });
  }

  failAll(error) {
    const pending = this.waiters.splice(0);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  drain() {
    for (;;) {
      const match = this.buffer.match(/^(\d{3}) ([\s\S]*?)\r?\n/);
      if (!match && !/^\d{3}-/.test(this.buffer)) return;
      // Multi-line replies: read until a line with "NNN " (space).
      const lines = this.buffer.split(/\r?\n/);
      let index = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^\d{3} /.test(lines[i])) {
          index = i;
          break;
        }
      }
      if (index < 0) return;
      const consumed = lines.slice(0, index + 1).join('\r\n') + '\r\n';
      this.buffer = this.buffer.slice(consumed.length);
      const code = Number(lines[index].slice(0, 3));
      const text = lines.slice(0, index + 1).join('\n');
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve({ code, text });
      }
    }
  }

  expect(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new MailError('连接已关闭', 'SMTP_CLOSED'));
        return;
      }
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new MailError('SMTP 服务器响应超时', 'SMTP_TIMEOUT'));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push({ resolve, reject, timer });
      this.drain();
    });
  }

  async command(line, timeoutMs) {
    this.socket.write(`${line}\r\n`);
    return this.expect(timeoutMs);
  }

  async writeRaw(text) {
    this.socket.write(text);
  }

  close() {
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
  }
}

function connectSocket({ host, port, secure, timeoutMs, log }) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(new MailError(`无法连接 ${host}:${port}：${error.message}`, 'SMTP_CONNECT'));
    if (secure === 'tls') {
      const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true }, () => {
        socket.removeListener('error', onError);
        resolve({ socket, session: new SmtpSession(socket, log) });
      });
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        reject(new MailError('TLS 连接超时', 'SMTP_TIMEOUT'));
      });
      socket.once('error', onError);
      return;
    }
    const socket = net.connect({ host, port }, () => {
      socket.removeListener('error', onError);
      resolve({ socket, session: new SmtpSession(socket, log) });
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new MailError('连接超时', 'SMTP_TIMEOUT'));
    });
    socket.once('error', onError);
  });
}

function encodeHeader(value) {
  // RFC 2047 for anything beyond ASCII so Chinese subjects survive.
  const text = String(value ?? '');
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

export function buildMessage({ from, to, subject, body, date = new Date() }) {
  const boundary = `yu-${crypto.randomBytes(8).toString('hex')}`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    'X-Mailer: Yu Companion',
  ];
  const bodyLines = String(body ?? '').split(/\r?\n/).map((line) => (line.startsWith('.') ? `.${line}` : line));
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(body ?? ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
    '',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

export function createMailService({ settings, log }) {
  const config = () => ({
    enabled: settings.get('mail.enabled'),
    host: settings.get('mail.host'),
    port: settings.get('mail.port'),
    secure: settings.get('mail.secure'),
    user: settings.get('mail.user'),
    password: settings.get('mail.password'),
    from: settings.get('mail.from') || settings.get('mail.user'),
    to: settings.get('mail.to'),
  });

  const validate = (cfg = config()) => {
    const problems = [];
    if (!cfg.host) problems.push('未配置 SMTP 主机');
    if (!cfg.port) problems.push('未配置 SMTP 端口');
    if (!cfg.user) problems.push('未配置 SMTP 用户名');
    if (!cfg.password) problems.push('未配置 SMTP 密码/授权码');
    if (!cfg.from) problems.push('未配置发件地址');
    if (!cfg.to) problems.push('未配置收件地址');
    else if (!isEmail(cfg.to)) problems.push('收件地址格式不正确');
    if (cfg.from && !isEmail(cfg.from)) problems.push('发件地址格式不正确');
    return { ok: problems.length === 0, problems, config: cfg };
  };

  const send = async ({ subject, body, to = null, dryRun = false, timeoutMs = 25_000 }) => {
    const check = validate();
    if (!check.ok) {
      throw new MailError(`邮件配置不完整：${check.problems.join('；')}`, 'MAIL_CONFIG_INVALID', {
        problems: check.problems,
      });
    }
    const cfg = check.config;
    const recipient = to || cfg.to;
    const message = buildMessage({ from: cfg.from, to: recipient, subject, body });
    if (dryRun) {
      return { ok: true, dryRun: true, recipient, bytes: message.length, message };
    }

    const { session } = await connectSocket({ host: cfg.host, port: cfg.port, secure: cfg.secure, timeoutMs, log });
    const timeout = timeoutMs;
    try {
      const greeting = await session.expect(timeout);
      if (greeting.code !== 220) {
        throw new MailError(`SMTP 问候失败：${greeting.text}`, 'SMTP_GREETING', { reply: greeting });
      }
      let ehlo = await session.command(`EHLO yu.local`, timeout);
      if (ehlo.code !== 250) {
        ehlo = await session.command('HELO yu.local', timeout);
      }
      if (ehlo.code !== 250) throw new MailError(`EHLO 失败：${ehlo.text}`, 'SMTP_EHLO', { reply: ehlo });

      if (cfg.secure === 'starttls') {
        const starttls = await session.command('STARTTLS', timeout);
        if (starttls.code !== 220) {
          throw new MailError(`STARTTLS 被拒绝：${starttls.text}`, 'SMTP_STARTTLS', { reply: starttls });
        }
        session.close();
        // Reconnect in TLS mode on the same port.
        const tlsConn = await connectSocket({ host: cfg.host, port: cfg.port, secure: 'tls', timeoutMs, log });
        const upgraded = tlsConn.session;
        try {
          return await authenticateAndSend(upgraded, cfg, recipient, message, timeout);
        } finally {
          upgraded.close();
        }
      }
      return await authenticateAndSend(session, cfg, recipient, message, timeout);
    } finally {
      session.close();
    }
  };

  const authenticateAndSend = async (session, cfg, recipient, message, timeout) => {
    const authPlain = await session.command(`AUTH PLAIN ${Buffer.from(`\u0000${cfg.user}\u0000${cfg.password}`, 'utf8').toString('base64')}`, timeout);
    if (authPlain.code !== 235) {
      if (authPlain.code === 535 || authPlain.code === 534) {
        throw new MailError(
          `邮箱认证失败（${authPlain.code}）：${authPlain.text.split('\n').pop()}`,
          'MAIL_AUTH_INVALID',
          { reply: authPlain },
        );
      }
      const authLogin = await session.command('AUTH LOGIN', timeout);
      if (authLogin.code !== 334) {
        throw new MailError(`认证方式不被接受：${authLogin.text}`, 'MAIL_AUTH_UNSUPPORTED', { reply: authLogin });
      }
      const user = await session.command(Buffer.from(cfg.user, 'utf8').toString('base64'), timeout);
      if (user.code !== 334) throw new MailError(`AUTH LOGIN 用户名被拒绝`, 'MAIL_AUTH_INVALID', { reply: user });
      const pass = await session.command(Buffer.from(cfg.password, 'utf8').toString('base64'), timeout);
      if (pass.code !== 235) {
        throw new MailError(`邮箱认证失败（${pass.code}）`, 'MAIL_AUTH_INVALID', { reply: pass });
      }
    }
    const mailFrom = await session.command(`MAIL FROM:<${cfg.from}>`, timeout);
    if (mailFrom.code !== 250) throw new MailError(`MAIL FROM 被拒绝：${mailFrom.text}`, 'SMTP_MAIL_FROM', { reply: mailFrom });
    const rcpt = await session.command(`RCPT TO:<${recipient}>`, timeout);
    if (rcpt.code !== 250 && rcpt.code !== 251) {
      throw new MailError(`RCPT TO 被拒绝：${rcpt.text}`, 'SMTP_RCPT', { reply: rcpt });
    }
    const data = await session.command('DATA', timeout);
    if (data.code !== 354) throw new MailError(`DATA 被拒绝：${data.text}`, 'SMTP_DATA', { reply: data });
    await session.writeRaw(message.replace(/\r?\n/g, '\r\n'));
    if (!message.endsWith('\r\n')) await session.writeRaw('\r\n');
    await session.writeRaw('.\r\n');
    const accepted = await session.expect(timeout);
    if (accepted.code !== 250) throw new MailError(`邮件被拒绝：${accepted.text}`, 'MAIL_SEND_FAILED', { reply: accepted });
    await session.command('QUIT', 5000).catch(() => {});
    return { ok: true, recipient, reply: accepted.text };
  };

  return {
    config,
    validate,
    /**
     * Local preview: renders the exact message that would be sent, without a
     * network connection. Returns the same shape for preview and dry-run.
     */
    preview({ subject, body, to = null }) {
      const check = validate();
      const cfg = check.config;
      const recipient = to || cfg.to || '(未配置)';
      const message = buildMessage({ from: cfg.from || 'yu@localhost', to: recipient, subject, body });
      return {
        ok: check.ok,
        problems: check.problems,
        recipient,
        from: cfg.from,
        subject,
        body,
        bytes: message.length,
        message,
        note: '这是本地渲染结果，没有连接任何邮件服务器。',
      };
    },
    /** Real send — the caller must have explicit user authorisation. */
    async sendTest({ subject = 'Yu 邮件通道测试', body, to = null }) {
      const text =
        body ??
        [
          '这是一封来自 Yu 的测试邮件。',
          '',
          `发送时间：${new Date().toISOString()}`,
          '说明：本次测试只验证 SMTP 通道，没有改变任何 QQ 登录状态。',
        ].join('\n');
      return send({ subject, body: text, to });
    },
    /** The same transport, for content Yu wants to deliver itself. */
    async send({ subject, body, to = null }) {
      return send({ subject, body, to });
    },
    buildMessage,
    /** Simulated delivery used by the alert task preview. */
    simulate({ subject, body, to = null }) {
      const check = validate();
      return {
        ok: check.ok,
        simulated: true,
        problems: check.problems,
        to: to || check.config.to || '(未配置)',
        subject,
        body: truncate(body, 4000),
      };
    },
  };
}
