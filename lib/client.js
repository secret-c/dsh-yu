/**
 * Yu — DSH settings page.
 *
 * Two jobs, and no more: pair this device, and show where the data lives with a
 * link into the console that actually manages it. The file inventory, the
 * migration form and the per-folder table used to live here too; they now live
 * only in the admin console, where changing the data root is a live switch. A
 * settings page that duplicates a destructive control is worse than a small one
 * that points at the real one.
 *
 * Everything it calls goes to `/yu/api/*` on the **same origin** as this page,
 * because the Yu plugin mounts its router under `/yu` on the harness web server.
 * Pairing here sets the device cookie for the harness origin, so the mutating
 * endpoints are ordinary authenticated calls — this page adds no new
 * unauthenticated surface.
 */
window.__ModuleLoader__.load({
  id: '@yu/companion',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    // Desktop's dsh-app origin is a proxy, not an external browser URL. Its
    // proxy also withholds Set-Cookie, so pair in the external HTTP browser.
    const desktop = window.location.protocol === 'dsh-app:';
    function consoleUrl(entry) {
      const candidates = desktop
        ? [entry?.localUrl, entry?.adminUrl, entry?.harnessUrl]
        : [entry?.harnessUrl, entry?.adminUrl, entry?.localUrl];
      for (const value of candidates) {
        if (!value) continue;
        try {
          const parsed = new URL(value);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) continue;
          const base = !desktop && value === entry?.harnessUrl && ['http:', 'https:'].includes(window.location.protocol)
            ? new URL(parsed.pathname, window.location.origin)
            : parsed;
          base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
          return base.href;
        } catch { /* Try the next URL advertised by this running instance. */ }
      }
      return null;
    }

    const MUTED = { opacity: 0.62 };
    const CARD = {
      border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
      borderRadius: 12,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    };
    const BTN = {
      font: 'inherit',
      fontSize: 12.5,
      padding: '6px 12px',
      borderRadius: 8,
      cursor: 'pointer',
      color: 'inherit',
      background: 'color-mix(in srgb, currentColor 9%, transparent)',
      border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
    };
    const BTN_PRIMARY = { ...BTN, background: '#137e7a', borderColor: '#137e7a', color: '#fff', fontWeight: 600 };
    const CODE = {
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: 11.5,
      wordBreak: 'break-all',
      background: 'color-mix(in srgb, currentColor 7%, transparent)',
      padding: '2px 6px',
      borderRadius: 5,
    };
    const human = (bytes) => {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let size = value;
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
    };

    const uptime = (ms) => {
      if (!ms) return '—';
      const minutes = Math.floor(ms / 60000);
      if (minutes < 60) return `${minutes} 分钟`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
      return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
    };

    async function call(method, path, body) {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
        error.code = payload?.error?.code ?? null;
        throw error;
      }
      return payload;
    }

    function Row({ label, children }) {
      return h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: '96px 1fr', gap: 10, alignItems: 'baseline' } },
        h('div', { style: { ...MUTED, fontSize: 12 } }, label),
        h('div', { style: { fontSize: 12.5, minWidth: 0 } }, children),
      );
    }

    function Note({ tone, children }) {
      const styles = {
        info: { background: 'rgba(19,126,122,0.10)', border: '1px solid rgba(19,126,122,0.28)' },
        warn: { background: 'rgba(176,68,63,0.10)', border: '1px solid rgba(176,68,63,0.30)' },
        ok: { background: 'rgba(47,125,95,0.10)', border: '1px solid rgba(47,125,95,0.30)' },
      }[tone ?? 'info'];
      return h('div', { style: { ...styles, borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: 1.6 } }, children);
    }

    function YuSettings() {
      const [entry, setEntry] = useState(null);
      const [session, setSession] = useState(null);
      const [pairing, setPairing] = useState(null);
      const [phase, setPhase] = useState('loading');
      const [busy, setBusy] = useState('');
      const [message, setMessage] = useState(null);
      const [copied, setCopied] = useState(false);

      const load = useCallback(async () => {
        try {
          const [entryData, sessionData, pairingData] = await Promise.all([
            call('GET', '/yu/api/entry'),
            call('GET', '/yu/api/session'),
            call('GET', '/yu/api/pairing'),
          ]);
          setEntry(entryData);
          setSession(sessionData);
          setPairing(pairingData);
          setPhase('ok');
        } catch (error) {
          setMessage({ tone: 'warn', text: `连不上 Yu：${error.message}` });
          setPhase('error');
        }
      }, []);

      useEffect(() => {
        void load();
      }, [load]);

      const run = async (label, fn) => {
        setBusy(label);
        setMessage(null);
        try {
          await fn();
        } catch (error) {
          setMessage({ tone: 'warn', text: error.message });
        } finally {
          setBusy('');
        }
      };

      const pairWithCode = () =>
        run('pair', async () => {
          if (desktop) {
            openConsole(adminUrl);
            return;
          }
          const code = pairing?.code;
          if (!code) throw new Error('当前没有可用的配对码');
          await call('POST', '/yu/api/pair', { code });
          const verified = await call('GET', '/yu/api/session');
          if (!verified?.paired) throw new Error('登录凭据未保存，请在外部浏览器打开管理台后配对。');
          await load();
          setMessage({ tone: 'ok', text: '这台设备已登录 Yu。' });
        });

      const adminUrl = consoleUrl(entry);
      const paired = Boolean(session?.paired);
      // Deep link into the console page that owns storage: one place to change a
      // path, one place to explain what the change does.
      const storageUrl = adminUrl ? `${adminUrl}#/settings/storage` : null;
      function openConsole(url) {
        if (!url) {
          setMessage({ tone: 'warn', text: 'Yu 尚未提供可用的管理台地址，请刷新后重试。' });
          return;
        }
        try {
          window.open(url, '_blank', 'noopener');
          // Electron intentionally returns null after handing HTTP URLs to the
          // OS browser. Do not misreport that as a blocked popup or success.
          setMessage({ tone: 'info', text: '已请求在浏览器打开管理台；若没有打开，请复制下方地址到浏览器。首次使用请在管理台输入上方配对码登录。' });
        } catch (error) {
          setMessage({ tone: 'warn', text: `打开失败：${error.message}。请复制下方地址到浏览器。` });
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, padding: '2px 0 24px', maxWidth: 760 } },

        h(
          'div',
          null,
          h('div', { style: { fontSize: 16, fontWeight: 650, letterSpacing: '-0.2px' } }, 'Yu · 个人 AI 陪伴'),
          h(
            'div',
            { style: { ...MUTED, fontSize: 12.5, marginTop: 4 } },
            phase === 'ok'
              ? `运行中 · v${entry?.version} · DSH ${entry?.harness?.version ?? '未知'} · 已运行 ${uptime(entry?.uptimeMs)}` +
                  (entry?.runtime ? ` · 执行 ${entry.runtime.active} / 排队 ${entry.runtime.queued}` : '')
              : phase === 'error'
                ? 'Yu 未运行或未挂载到本页源站'
                : '正在读取…',
          ),
        ),

        message && h(Note, { tone: message.tone }, message.text),

        // ------------------------------------------------------------ pair
        h(
          'div',
          { style: CARD },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '配对这台设备'),
            h('div', { style: { ...MUTED, fontSize: 11.5 } }, paired ? '已登录' : `已配对 ${pairing?.pairedDevices ?? 0} 台`),
          ),
          paired
            ? h(
                'div',
                { style: { ...MUTED, fontSize: 12, lineHeight: 1.7 } },
                '这台设备已登录，下面的操作会真实执行。可在管理台「设置 · 设备」撤销。',
              )
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                pairing?.showCode && pairing?.code
                  ? h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
                      h(
                        'div',
                        {
                          style: {
                            fontFamily: "'Cascadia Code', Consolas, monospace",
                            fontSize: 22,
                            fontWeight: 700,
                            letterSpacing: 4,
                            color: '#137e7a',
                          },
                        },
                        pairing.code,
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          style: BTN,
                          onClick: () => {
                            try {
                              void navigator.clipboard?.writeText(pairing.code);
                              setCopied(true);
                              setTimeout(() => setCopied(false), 1500);
                            } catch {
                              /* clipboard optional */
                            }
                          },
                        },
                        copied ? '已复制' : '复制',
                      ),
                      h(
                        'button',
                        { type: 'button', style: BTN_PRIMARY, onClick: pairWithCode, disabled: busy === 'pair' },
                        busy === 'pair' ? '登录中…' : desktop ? '在浏览器中登录' : '用这个码登录',
                      ),
                    )
                  : h(
                      'div',
                      { style: { ...MUTED, fontSize: 12, lineHeight: 1.7 } },
                      pairing?.hint ??
                        '没有可用配对码。若已有配对设备而你没有会话，可在管理台「设置 · 设备」生成新码，或运行 scripts/yu-reset-devices.mjs。',
                    ),
                h(
                  'div',
                  { style: { ...MUTED, fontSize: 11.5, lineHeight: 1.6 } },
                  desktop ? '桌面设置页无法保存 Yu 登录凭据。请在外部浏览器管理台输入上方配对码；不要在桌面页消耗配对码。' : '配对码只把这台浏览器登记为 Yu 的可信设备，不改变 DSH 自己的任何设置。',
                ),
              ),
        ),

        // ------------------------------------------------------- data root
        h(
          'div',
          { style: CARD },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '数据保存位置'),
            h(
              'div',
              { style: { ...MUTED, fontSize: 11.5 } },
              entry?.dataRoot?.source === 'pointer'
                ? '已自定义'
                : entry?.dataRoot?.source === 'config'
                  ? '由插件行 config 指定'
                  : '平台默认',
            ),
          ),
          h(Row, { label: '数据根' }, h('code', { style: CODE }, entry?.dataRoot?.path ?? '—')),
          h(
            Row,
            { label: '占用' },
            `${human(entry?.dataRoot?.bytes)}${entry?.dataRoot?.freeBytes ? ` · 磁盘可用 ${human(entry.dataRoot.freeBytes)}` : ''}`,
          ),

          h(
            'div',
            { style: { ...MUTED, fontSize: 11.5, lineHeight: 1.65 } },
            '数据库、备份、归档、日志和会话副本都在这个文件夹里。要看每个子目录、换到别的盘或做备份恢复，' +
              '到 Yu 管理台的「设置 · 数据与文件」——那里改完立即生效，不用重启。',
          ),

          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                style: BTN_PRIMARY,
                onClick: () => openConsole(storageUrl),
              },
              '在管理台修改位置',
            ),
            h('button', { type: 'button', style: BTN, onClick: () => openConsole(adminUrl) }, '打开管理台'),
            paired &&
              h(
                'button',
                {
                  type: 'button',
                  style: BTN,
                  onClick: () =>
                    run('reveal', async () => {
                      await call('POST', '/yu/api/system/reveal', { key: 'data' });
                    }),
                },
                '在文件管理器中打开',
              ),
            h('button', { type: 'button', style: BTN, onClick: () => void load() }, '刷新'),
          ),
          adminUrl && h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('input', { 'aria-label': '管理台地址', readOnly: true, value: adminUrl, style: { ...CODE, flex: 1, minWidth: 0 }, onFocus: (event) => event.target.select() }),
            h('button', { type: 'button', style: BTN, onClick: () => run('copy-url', async () => {
              if (!navigator.clipboard?.writeText) throw new Error('无法自动复制，请选中左侧地址手动复制。');
              await navigator.clipboard.writeText(adminUrl);
              setMessage({ tone: 'ok', text: '管理台地址已复制。' });
            }) }, '复制地址'),
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'yu', order: 92, label: 'Yu' }, YuSettings),
        );
      },
    };
  },
});
