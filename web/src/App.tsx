import React, { useCallback, useEffect, useState } from 'react';
import { api, basePath, healthBuild, type Tone } from './lib';
import { Badge, Button, Card, ErrorBox, Field, Loading, PageHead, ToastProvider, navigate, useApi, useRoute } from './ui';
import { Today } from './pages/Today';
import { RunDetail } from './pages/RunDetail';
import { Tasks } from './pages/Tasks';
import { Triggers } from './pages/Triggers';
import { TaskDetail } from './pages/TaskDetail';
import { Conversations } from './pages/Conversations';
import { DshSessions } from './pages/DshSessions';
import { Contexts } from './pages/Contexts';
import { Inject } from './pages/Inject';
import { MemoryPage } from './pages/Memory';
import { ToolsPage } from './pages/Tools';
import { Channels } from './pages/Channels';
import { SettingsPage } from './pages/Settings';
import { Onboarding } from './pages/Onboarding';

const NAV = [
  { id: 'today', label: 'Yu 今日', path: '/today', icon: IconToday },
  { id: 'tasks', label: '任务', path: '/tasks', icon: IconTasks },
  { id: 'conversations', label: 'Yu 会话', path: '/conversations', icon: IconChat },
  { id: 'contexts', label: '上下文', path: '/contexts', icon: IconLayers },
  { id: 'inject', label: '注入', path: '/inject', icon: IconLayers },
  { id: 'memory', label: '记忆', path: '/memory', icon: IconMemory },
  { id: 'tools', label: '工具', path: '/tools', icon: IconTool },
  { id: 'channels', label: '接入', path: '/channels', icon: IconPlug },
  { id: 'onboarding', label: '初始化', path: '/onboarding', icon: IconGear },
  { id: 'settings', label: '设置', path: '/settings', icon: IconGear },
];

interface SessionInfo {
  paired: boolean;
  pairingPending: boolean;
  device: { id: string; label: string; expiresAt: number } | null;
  env: {
    version: string;
    harness: { version: string | null; supported: boolean; reason: string | null };
    dataDir: string;
    adminUrl: string;
    instanceLabel?: string;
    timezone: string;
    platform: string;
    node: string;
  };
}

export default function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

function Root() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [bootError, setBootError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const info = await api<SessionInfo>('/api/session');
      setSession(info);
      setBootError(null);
    } catch (error) {
      setBootError(error as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Reload the tab when a newly deployed console build appears.
   *
   * Without this, a change that has already shipped stays invisible behind an
   * open tab until someone thinks to hard-refresh — which reads as "you didn't
   * build it".
   */
  useEffect(() => {
    const current = window.__YU_BUILD__ ?? null;
    if (!current) return;
    const timer = window.setInterval(() => {
      void healthBuild()
        .then((build) => {
          if (build && build !== current) window.location.reload();
        })
        .catch(() => {});
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (loading) {
    return (
      <div className="login-screen">
        <Card>
          <Loading label="正在连接 Yu…" />
        </Card>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="eyebrow">无法连接</div>
          <h1>Yu 管理台不可达</h1>
          <p className="login-lead">请确认插件已启动，且浏览器与 Yu 在同一台机器上。</p>
          <ErrorBox error={bootError} onRetry={() => void load()} />
        </div>
      </div>
    );
  }

  if (!session?.paired) {
    return <Login env={session?.env ?? null} pairingPending={session?.pairingPending ?? true} onPaired={() => void load()} />;
  }

  return <Shell session={session} onSignedOut={() => void load()} />;
}

function Login({
  env,
  pairingPending,
  onPaired,
}: {
  env: SessionInfo['env'] | null;
  pairingPending: boolean;
  onPaired: () => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  // The console can hand the code straight to the page while nobody is paired;
  // typing it from a file was pure friction, and the code only ever guarded that
  // file read. Prefill it so entering is a single click.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await api<any>('/api/pairing');
        if (cancelled) return;
        setPairing(info);
        if (info?.showCode && info.code) setCode(String(info.code));
      } catch {
        /* the manual path still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/pair', { method: 'POST', body: { code: code.trim().toUpperCase() } });
      onPaired();
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="brand" style={{ padding: 0, marginBottom: 20 }}>
          <div className="brand-mark">Yu</div>
          <div>
            <div className="brand-name">Yu 管理台</div>
            <div className="brand-sub">DSH 会话监听 · 任务投递</div>
          </div>
        </div>
        <div className="eyebrow">{pairing?.showCode ? '配对码已自动填入' : '首次使用需要配对'}</div>
        <h1 style={{ marginBottom: 4 }}>欢迎回来</h1>
        <p className="login-lead">
          {pairing?.showCode
            ? '点一下就能进入；这台设备之后会长期有效。'
            : pairingPending
              ? '输入一次性配对码即可在这台设备上长期登录。'
              : '这台设备还没有登录凭据。可在一台已登录的设备上生成新配对码。'}
        </p>

        {pairing?.showCode && pairing.code && (
          <div
            style={{
              border: '1px solid #cfe6e2',
              background: 'var(--accent-soft)',
              borderRadius: 12,
              padding: '14px 16px',
              marginBottom: 16,
              textAlign: 'center',
            }}
          >
            <div className="stat-label" style={{ marginBottom: 6 }}>
              本次配对码
            </div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: 6,
                color: 'var(--accent-dark)',
                lineHeight: 1.2,
              }}
            >
              {pairing.code}
            </div>
            <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  void navigator.clipboard?.writeText(pairing.code);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? '已复制' : '复制'}
              </button>
            </div>
          </div>
        )}

        <form onSubmit={submit} className="stack">
          <Field label="配对码" htmlFor="pair-code" help={pairing?.hint ?? undefined}>
            <input
              id="pair-code"
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="ABCD-1234"
              autoComplete="one-time-code"
              autoFocus
              style={{ letterSpacing: 2, fontFamily: 'var(--mono)', textTransform: 'uppercase' }}
            />
          </Field>
          {error && <ErrorBox error={error} />}
          <Button type="submit" disabled={busy || code.trim().length < 4} wide>
            {busy ? '校验中…' : '配对并进入'}
          </Button>
        </form>

        <div className="login-hint">
          {pairing?.showCode ? (
            <div>配对码同时写在数据根的 <code>pairing-code.txt</code>，配对成功后该文件会被删除。</div>
          ) : (
            <div>{pairing?.hint ?? '配对码写在数据根的 pairing-code.txt，也出现在 DeepSeek Harness 的插件日志里。'}</div>
          )}
          {env && (
            <div style={{ marginTop: 8 }}>
              数据根：<code>{env.dataDir}</code>
              <br />
              入口：<code>{env.adminUrl}</code>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Shell({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const route = useRoute();
  const [unconfigured, setUnconfigured] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(`yu-onboarding-dismissed:${session.env.dataDir}`) === '1'; } catch { return false; }
  });
  useEffect(() => {
    let cancelled = false;
    void api<any>('/api/onboarding').then(s => {
      if (cancelled) return;
      setUnconfigured(s.status === 'unconfigured');
      if (s.status !== 'unconfigured') {
        try { localStorage.removeItem(`yu-onboarding-dismissed:${session.env.dataDir}`); } catch { /* UI preference only */ }
        setDismissed(false);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [route.path, session.env.dataDir]);
  const [health, setHealth] = useState<{ agentAlive: number; active: number; queued: number } | null>(null);
  const instanceLabel = String(session.env.instanceLabel ?? '').trim();

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api<any>('/api/environment');
        if (!cancelled) {
          setHealth({
            agentAlive: data.liveAgents ?? 0,
            active: data.runtime?.active ?? 0,
            queued: data.runtime?.queued ?? 0,
          });
        }
      } catch {
        /* the shell keeps working even if this fails */
      }
    };
    void poll();
    const timer = window.setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const active = NAV.find((item) => item.path === route.path || (item.path !== '/' && route.path.startsWith(item.path)));
  const currentId = active?.id ?? 'today';

  const signOut = async () => {
    await api('/api/unpair', { method: 'POST', body: {} }).catch(() => {});
    onSignedOut();
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">Yu</div>
          <div className="brand-text">
            <div className="brand-name">Yu</div>
            <div className="brand-sub">个人 AI 陪伴</div>
          </div>
        </div>
        <div className="caption">工作空间</div>
        <nav className="nav" aria-label="主导航">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className="nav-item"
                aria-current={currentId === item.id ? 'page' : undefined}
                onClick={() => navigate(item.path)}
              >
                <Icon />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="conn">
            <span className={`dot ${health && health.active > 0 ? 'ok' : 'ok'}`} />
            <span>
              {health ? `${health.active} 执行 / ${health.queued} 排队` : '状态读取中'}
            </span>
          </div>
          {/* Two Yu installs look identical; the label, the port and the data root
              are what tell them apart, so all three stay visible. */}
          {instanceLabel ? (
            <div className="conn" title="在 设置 · 网页与认证 里改">
              <span className="dot" />
              <span>{instanceLabel}</span>
            </div>
          ) : null}
          <div className="conn" title={session.env.dataDir}>
            <span className="dot" />
            <span>
              本机 {window.location.host} · {shortRoot(session.env.dataDir)}
            </span>
          </div>
          <div className="conn">
            <span className="dot" />
            <span>v{session.env.version} · DSH {session.env.harness.version ?? '未知'}</span>
          </div>
          <button type="button" className="btn quiet" onClick={signOut} style={{ justifyContent: 'flex-start' }}>
            退出此设备
          </button>
        </div>
      </aside>

      <main className="main">
        {(route.path === '/' || route.path === '/today') && unconfigured && !dismissed && (
          <div className="notice" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span>Yu 还未初始化，完成设置后即可开始使用。</span>
            <Button size="small" onClick={() => navigate('/onboarding')}>开始设置</Button>
            <Button size="small" variant="ghost" onClick={() => { try { localStorage.setItem(`yu-onboarding-dismissed:${session.env.dataDir}`, '1'); } catch { /* UI preference only */ } setDismissed(true); }}>先收起</Button>
          </div>
        )}
        {!session.env.harness.supported && (
          <div className="notice warn" style={{ marginBottom: 16 }}>
            <strong>版本兼容提示：</strong>
            {session.env.harness.reason ?? '当前 DSH 版本不在声明支持范围内'}。Yu 会按能力探测降级，缺失能力会在诊断页列出。
          </div>
        )}
        <RouteView route={route} />
        <div className="footer-note">
          当前实例 {window.location.host} · 数据根 {session.env.dataDir} · 所有操作通过本地网络完成
        </div>
      </main>

      <nav className="mobile-bar" aria-label="移动端导航">
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className="mobile-tab"
              aria-current={currentId === item.id ? 'page' : undefined}
              onClick={() => navigate(item.path)}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function MemoryRedirect({ maintenance = false }: { maintenance?: boolean }) {
  useEffect(() => navigate(maintenance ? '/tasks' : '/memory'), [maintenance]);
  return <Loading />;
}

function RouteView({ route }: { route: ReturnType<typeof useRoute> }) {
  const segments = route.segments;
  if (segments.length === 0) return <Today />;
  const [root, second, third] = segments;
  switch (root) {
    case 'onboarding': return <Onboarding />;
    case 'today':
      return <Today />;
    case 'runs':
      return second ? <RunDetail id={second} /> : <Today />;
    case 'tasks':
      if (second === 'triggers') return <Triggers />;
      if (second === 'dsh') return <DshSessions />;
      return second ? (
        <TaskDetail id={second} initialTab={third === 'trigger' ? 'trigger' : third === 'reading' ? 'reading' : undefined} />
      ) : (
        <Tasks />
      );
    case 'conversations':
      return <Conversations id={second ?? null} />;
    case 'dsh':
      return <DshSessions />;
    case 'contexts':
      return <Contexts id={second ?? null} />;
    case 'inject':
      return <Inject />;
    case 'memory':
      if (['rules', 'settings', 'maintenance'].includes(second)) return <MemoryRedirect maintenance={second === 'maintenance'} />;
      return <MemoryPage documentSlug={second === 'docs' && third ? decodeURIComponent(third) : null} />;
    case 'tools':
      return <ToolsPage name={second ?? null} />;
    case 'channels':
      return <Channels id={second ?? null} />;
    case 'settings':
      if (second === 'memory') return <MemoryRedirect />;
      return <SettingsPage tab={second ?? 'model'} />;
    default:
      return (
        <Card>
          <PageHead title="页面不存在" description={`没有找到 ${route.path}`} />
          <Button onClick={() => navigate('/')}>回到 Yu 今日</Button>
        </Card>
      );
  }
}

// ------------------------------------------------------------------- icons

type IconProps = { size?: number; className?: string };

/** `C:\apps\yu` -> `yu`; `/home/yu/.local/share/yu` -> `yu`. */
function shortRoot(dir: string | null | undefined): string {
  const text = String(dir ?? '').replace(/[\\/]+$/, '');
  if (!text) return '数据根未知';
  const parts = text.split(/[\\/]+/);
  return parts[parts.length - 1] || text;
}

function base(size = 18) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

function IconToday({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}
function IconTasks({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4.5 7.5h15M4.5 12h15M4.5 16.5h9" />
    </svg>
  );
}
function IconChat({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4.5 6.5h15v9h-9l-4 3v-3h-2z" />
    </svg>
  );
}
function IconLayers({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3.8 4.5 8l7.5 4.2L19.5 8z" />
      <path d="M4.5 12.4 12 16.6l7.5-4.2" />
      <path d="M4.5 16.4 12 20.6l7.5-4.2" />
    </svg>
  );
}
function IconMemory({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="4.5" y="4.5" width="15" height="15" rx="4" />
      <path d="M9 9h6M9 12.5h6M9 16h3.5" />
    </svg>
  );
}
function IconTool({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M14.5 5.5a3.8 3.8 0 0 0 4.9 4.9L9.9 19.9l-2.4-2.4z" />
      <path d="M6.2 6.2 8.6 8.6" />
    </svg>
  );
}
function IconPlug({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 3.8v4M15 3.8v4" />
      <path d="M6.5 7.8h11v4.4a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 17.7v2.5" />
    </svg>
  );
}
function IconGear({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.6v2M12 18.4v2M4.6 12h2M17.4 12h2M6.8 6.8l1.4 1.4M15.8 15.8l1.4 1.4M17.2 6.8l-1.4 1.4M8.2 15.8l-1.4 1.4" />
    </svg>
  );
}
