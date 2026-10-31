import React, { useCallback, useEffect, useState } from 'react';
import { api, fmtDateTime, fmtRelative, fmtTime, CHANNEL_STATUS, CHANNEL_TYPE } from '../lib';
import {
  Badge,
  Button,
  Card,
  Code,
  Empty,
  ErrorBox,
  Field,
  KV,
  Loading,
  Modal,
  PageHead,
  Toggle,
  useApi,
  useToast,
} from '../ui';

interface Channel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  connectedAt: number | null;
  lastEventAt: number | null;
  config: any;
  runtime: any;
  health: { state: string; detail: string };
}

export function Channels({ id }: { id: string | null }) {
  const list = useApi<{ channels: Channel[]; types: any[]; adminBase: string }>('/api/channels');
  const alerts = useApi<any>('/api/alerts');
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, any>>({});
  const [editing, setEditing] = useState<string | null>(id);

  useEffect(() => {
    if (id) setEditing(id);
  }, [id]);

  if (list.error) return <ErrorBox error={list.error} onRetry={() => void list.reload()} />;
  if (!list.data) return <Loading label="正在读取接入…" />;
  const adminBase = list.data.adminBase;

  const test = async (channel: Channel) => {    setTesting(channel.id);
    try {
      const result = await api<any>(`/api/channels/${channel.id}/test`, { method: 'POST', body: {} });
      setResults({ ...results, [channel.id]: result });
      toast(result.ok ? '连接测试通过' : '连接测试未通过，详见结果', result.ok ? 'ok' : 'warn');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setTesting(null);
    }
  };

  const toggle = async (channel: Channel) => {
    try {
      await api(`/api/channels/${channel.id}/enable`, { method: 'POST', body: { enabled: !channel.enabled } });
      await list.reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  const remove = async (channel: Channel) => {
    if (!window.confirm(`删除连接「${channel.name}」？`)) return;
    await api(`/api/channels/${channel.id}`, { method: 'DELETE' });
    await list.reload();
  };

  return (
    <>
      <PageHead
        eyebrow="接入"
        title="渠道连接"
        description="支持通用 OneBot v11 反向 WebSocket，NapCat 与 SnowLuma 复用同一协议；QQ 官方机器人使用独立协议。凭据只保存在本地数据库。"
        actions={<Button onClick={() => setCreating(true)}>新增连接</Button>}
      />

      {list.data.channels.length === 0 ? (
        <Card>
          <Empty
            title="还没有接入"
            hint="网页对话已经可用。要接入 QQ，请新增一个连接并把地址填进对端。"
            action={<Button onClick={() => setCreating(true)}>新增连接</Button>}
          />
        </Card>
      ) : (
        <div className="stack">
          {list.data.channels.map((channel) => {
            const status = CHANNEL_STATUS[channel.status] ?? { label: channel.status, tone: '' as const };
            return (
              <Card
                key={channel.id}
                title={
                  <span className="row" style={{ gap: 8 }}>
                    {channel.name}
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span className="tag">{CHANNEL_TYPE[channel.type] ?? channel.type}</span>
                  </span>
                }
                subtitle={
                  channel.health?.detail ||
                  (channel.enabled ? '尚未与对端建立连接' : '已主动停用，不会产生告警')
                }
                actions={
                  <div className="row" style={{ gap: 6 }}>
                    <Toggle checked={channel.enabled} label={channel.enabled ? '启用' : '停用'} onChange={() => void toggle(channel)} />
                    <Button variant="ghost" size="small" onClick={() => void test(channel)} disabled={testing === channel.id}>
                      {testing === channel.id ? '测试中…' : '连接测试'}
                    </Button>
                    {['onebot','snowluma','napcat'].includes(channel.type) && <Button variant="ghost" size="small" onClick={async()=>{try{const result=await api<{token:string}>(`/api/channels/${channel.id}/setup-token`,{method:'POST',body:{}});await navigator.clipboard.writeText(result.token);toast('已复制连接口令，粘贴到 Snow 的反向 WebSocket 客户端访问令牌栏','ok');}catch(error){toast((error as Error).message,'bad');}}}>复制连接口令</Button>}
                    <Button variant="quiet" size="small" onClick={() => setEditing(editing === channel.id ? null : channel.id)}>
                      {editing === channel.id ? '收起' : '配置'}
                    </Button>
                    <Button variant="quiet" size="small" onClick={() => void remove(channel)}>
                      删除
                    </Button>
                  </div>
                }
              >
                <KV
                  items={[
                    {
                      label: '连接位置',
                      value:
                        channel.type === 'qq-official'
                          ? `Webhook：${adminBase.replace(/\/$/, '')}${channel.runtime?.endpoint?.path ?? ''}`
                          : `反向 WS：${adminBase.replace(/^http/, 'ws').replace(/\/$/, '')}${channel.runtime?.endpoint?.path ?? `/onebot/${channel.id}`}`,
                    },
                    { label: '最近连接', value: channel.connectedAt ? fmtDateTime(channel.connectedAt) : '—' },
                    { label: '最近事件', value: channel.lastEventAt ? fmtRelative(channel.lastEventAt) : '—' },
                    { label: '最近错误', value: channel.lastError ?? '—' },
                  ]}
                />

                {results[channel.id] && (
                  <div style={{ marginTop: 12 }}>
                    <div className="caption" style={{ padding: 0 }}>
                      测试结果
                    </div>
                    <div className="stack tight">
                      {(results[channel.id].checks ?? []).map((check: any, index: number) => (
                        <div className="row" key={index} style={{ alignItems: 'flex-start' }}>
                          <Badge tone={check.ok ? 'ok' : 'bad'}>{check.ok ? '通过' : '失败'}</Badge>
                          <div className="li-main">
                            <div className="li-title">{check.name}</div>
                            <div className="li-sub">{check.detail}</div>
                          </div>
                        </div>
                      ))}
                      {results[channel.id].note && <div className="notice">{results[channel.id].note}</div>}
                      {results[channel.id].selfTest && (
                        <div className="notice">
                          本地协议自检：{results[channel.id].selfTest.ok ? '通过' : '未通过'} · 密钥派生{' '}
                          {results[channel.id].selfTest.keyDerivation}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {editing === channel.id && (
                  <ChannelConfig channel={channel} adminBase={adminBase} onSaved={() => void list.reload()} />
                )}

                <ChannelConsole channel={channel} />
              </Card>
            );
          })}
        </div>
      )}

      <Card title="异常邮件提醒" subtitle="QQ 连接或登录持续失效后发信；主动停用默认不告警" actions={
        <Button variant="ghost" size="small" onClick={() => void alerts.reload()}>刷新</Button>
      }>
        {alerts.data ? (
          <AlertPanel data={alerts.data} onChanged={() => void alerts.reload()} />
        ) : (
          <Loading />
        )}
      </Card>


      {creating && (
        <CreateChannelModal
          types={list.data.types}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Console face of a bot framework.
 *
 * The old flow assumed the operator already knew where NapCat was installed,
 * had started it, and could find its console: three pieces of knowledge the
 * product should own. This one starts from a single button — find it if needed,
 * start it hidden, wait for the console, pull the QR — and falls back to the
 * manual directory only when the automatic path says it could not find one.
 */
function ChannelConsole({ channel }: { channel: Channel }) {
  const toast = useToast();
  const [info, setInfo] = useState<any>(null);
  const [qr, setQr] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const [installDir, setInstallDir] = useState('');
  const [installs, setInstalls] = useState<any[] | null>(null);
  const [showWeak, setShowWeak] = useState(false);
  const [launch, setLaunch] = useState<any>(null);
  const [showManual, setShowManual] = useState(false);

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await api<any>(`/api/channels/${channel.id}/console`));
    } catch (error) {
      setInfo({ error: (error as Error).message });
    }
  }, [channel.id]);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  const loadQr = useCallback(async () => {
    setBusy('qr');
    try {
      setQr(await api<any>(`/api/channels/${channel.id}/qr`));
    } catch (error) {
      setQr({ ok: false, reason: (error as Error).message });
    } finally {
      setBusy('');
    }
  }, [channel.id]);

  const refreshQr = async () => {
    setBusy('refresh');
    try {
      await api(`/api/channels/${channel.id}/qr/refresh`, { method: 'POST' });
      await loadQr();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy('');
    }
  };

  const scan = async (refresh = false) => {
    setBusy('scan');
    try {
      const result = await api<any>(`/api/channels/installs${refresh ? '?refresh=1' : ''}`);
      setInstalls(result.hits ?? []);
      if (!result.hits?.length) {
        toast('常见位置没有找到安装目录；可以展开「手动指定目录」', 'warn');
      }
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy('');
    }
  };

  const discover = async (dir?: string) => {
    setBusy('discover');
    try {
      const target = (dir ?? installDir).trim();
      const result = await api<any>(`/api/channels/${channel.id}/discover`, {
        method: 'POST',
        body: target ? { installDir: target } : {},
      });
      toast(`已读取：${result.found ? Object.keys(result.found).join('、') : '配置'}`, 'ok');
      await loadInfo();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy('');
    }
  };

  const start = async (dir?: string) => {
    setBusy('launch');
    setLaunch(null);
    try {
      const result = await api<any>(`/api/channels/${channel.id}/launch`, {
        method: 'POST',
        body: dir ? { installDir: dir } : {},
      });
      setLaunch(result);
      toast(result.note ?? '已启动', result.ok ? 'ok' : 'warn');
      await loadInfo();
      if (result.ok && channel.type === 'napcat') await loadQr();
      if (result.ok && channel.type === 'snowluma' && result.consoleUrl) {
        window.open(result.consoleUrl, '_blank', 'noopener');
      }
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy('');
    }
  };

  const consoleUrl = info?.consoleUrl ?? '';
  const supportsQr = info?.supportsQr === true;
  const consoleUp = info?.consoleUp === true;
  // A folder with a `napcat` launcher but no readable config is a weaker guess;
  // show the confident ones first and keep the rest one click away.
  const strong = (installs ?? []).filter((hit) => hit.found?.consoleUrl);

  return (
    <div className="stack tight" style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Badge tone={consoleUp ? 'ok' : 'muted'}>控制台{consoleUp ? '在线' : '未运行'}</Badge>
          {info?.httpBase && (
            <Badge tone={info?.onebotUp ? 'ok' : 'muted'}>OneBot {info.onebotUp ? '在线' : '未运行'}</Badge>
          )}
          {consoleUrl && <code className="tag">{consoleUrl}</code>}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <Button variant="quiet" size="small" onClick={() => void loadInfo()}>
            刷新状态
          </Button>
        </div>
      </div>

      {channel.type === 'onebot' ? (<div className="li-sub">通用 OneBot v11 反向 WebSocket：在兼容客户端填写 ws://Yu地址/onebot/{channel.id} 和相同令牌；请在客户端自行启动与登录。使用 v11 message / send_private_msg / send_group_msg 事件与动作；不代表支持任意平台协议。</div>) : channel.type === 'qq-official' ? (
        <div className="li-sub">QQ 官方机器人没有本机程序；扫码和回调配置都在 q.qq.com 后台完成。</div>
      ) : (
        <div className="console-start">
          {consoleUp ? (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Button
                onClick={() => window.open(consoleUrl, '_blank', 'noopener')}
                disabled={!consoleUrl}
              >
                打开 {channel.type === 'snowluma' ? 'SnowLuma' : 'NapCat'} 控制台
              </Button>
              {supportsQr ? (
                <Button variant="ghost" onClick={() => void loadQr()} disabled={busy === 'qr'}>
                  {qr?.ok ? '重新取码' : '在页面里扫码'}
                </Button>
              ) : null}
              {info ? (
                <span className="li-sub" style={{ alignSelf: 'center', display: 'inline-flex', gap: 6 }}>
                  <Badge tone={info.consoleUp ? 'ok' : 'muted'}>{info.consoleUp ? '控制台在线' : '控制台离线'}</Badge>
                  {info.remote ? (
                    <Badge tone={info.bridgeStatus?.qqRunning ? 'ok' : 'muted'}>
                      {info.bridgeStatus?.qqRunning ? 'QQ 在运行' : 'QQ 未运行'}
                    </Badge>
                  ) : null}
                </span>
              ) : null}
              {info?.login ? (
                <span className="li-sub" style={{ alignSelf: 'center' }}>
                  登录 <code>{info.login.username}</code> / <code>{info.login.password}</code>
                  <Button
                    variant="quiet"
                    size="small"
                    style={{ marginLeft: 6 }}
                    onClick={() => {
                      void navigator.clipboard?.writeText(String(info.login.password));
                      toast('已复制密码（不含用户名）', 'ok');
                    }}
                  >
                    复制
                  </Button>
                  <span className="muted">（{info.login.source}）</span>
                </span>
              ) : (
                <span className="li-sub" style={{ alignSelf: 'center' }}>
                  控制台已在线；登录二维码在它自己的页面里。
                </span>
              )}
            </div>
          ) : (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Button onClick={() => void start()} disabled={busy === 'launch'}>
                {busy === 'launch' ? '正在启动…' : `启动 ${channel.type === 'snowluma' ? 'SnowLuma' : 'NapCat'} 并继续`}
              </Button>
              <Button variant="ghost" onClick={() => void scan()} disabled={busy === 'scan'}>
                {busy === 'scan' ? '查找中…' : '它装在哪？'}
              </Button>
              <span className="li-sub" style={{ alignSelf: 'center' }}>
                Yu 会自己在常见位置找安装目录，隐藏窗口启动，等控制台就绪。
              </span>
            </div>
          )}
        </div>
      )}

      {launch ? (
        <div className={`notice ${launch.ok ? '' : 'warn'}`}>
          <div className="li-title">
            {launch.ok ? `已就绪${launch.already ? '（本来就在运行）' : `，用时 ${Math.round((launch.waitedMs ?? 0) / 1000)} 秒`}` : '没有起来'}
          </div>
          <div className="li-sub">{launch.note}</div>
          {launch.qq ? (
            <div className="li-sub">
              QQ：
              {launch.qq.started
                ? '本次已一起拉起'
                : launch.qq.running
                  ? '本来就在运行'
                  : (launch.qq.note ?? launch.qq.reason ?? '未能启动，请手动打开 QQ')}
            </div>
          ) : null}
          {launch.launched ? (
            <div className="li-sub">
              安装目录：<code>{launch.dir}</code>
              {launch.discovered?.length ? ` · 已从配置读取 ${launch.discovered.join('、')}` : ''}
            </div>
          ) : null}
          {launch.logTail ? <pre className="console-log">{launch.logTail}</pre> : null}
        </div>
      ) : null}

      {installs ? (
        <div className="install-list">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="li-title">
              找到的安装位置（{installs.length}）
              {strong.length ? ` · ${strong.length} 个读到了控制台配置` : ''}
            </div>
            <Button variant="quiet" size="small" onClick={() => void scan(true)} disabled={busy === 'scan'}>
              重新查找
            </Button>
          </div>
          {installs.length === 0 ? (
            <div className="li-sub">常见位置没有命中。展开下面的「手动指定目录」，或者先手动启动一次，Yu 会从运行中的进程里认出它。</div>
          ) : (
            <ul className="install-items">
              {(showWeak ? installs : strong.length ? strong : installs).map((hit) => (
                <li key={hit.dir}>
                  <div className="install-main">
                    <div className="install-dir">
                      <Badge tone={hit.type === 'snowluma' ? 'accent' : 'muted'}>
                        {hit.type === 'snowluma' ? 'SnowLuma' : 'NapCat'}
                      </Badge>
                      <code>{hit.dir}</code>
                    </div>
                    <div className="li-sub">
                      {hit.found?.consoleUrl ? `控制台 ${hit.found.consoleUrl}` : '未读到控制台配置'}
                      {hit.launchers?.length ? ` · 启动器 ${hit.launchers.length} 个` : ' · 没有启动器'}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <Button
                      variant="quiet"
                      size="small"
                      disabled={busy === 'launch'}
                      onClick={() => void start(hit.dir)}
                    >
                      启动这个
                    </Button>
                    <Button
                      variant="quiet"
                      size="small"
                      disabled={busy === 'discover'}
                      onClick={() => void discover(hit.dir)}
                    >
                      用它的配置
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {strong.length && installs.length > strong.length ? (
            <Button variant="quiet" size="small" onClick={() => setShowWeak((value) => !value)}>
              {showWeak ? '只看读到配置的' : `显示其余 ${installs.length - strong.length} 个候选`}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="row" style={{ gap: 8 }}>
        <Button variant="quiet" size="small" onClick={() => setShowManual((value) => !value)}>
          {showManual ? '收起手动目录' : '手动指定目录'}
        </Button>
        {installDir ? <code className="tag">{installDir}</code> : null}
      </div>

      {showManual ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            value={installDir}
            onChange={(event) => setInstallDir(event.target.value)}
            placeholder="安装目录，例如 C:\apps\napcat"
            style={{ flex: '1 1 320px' }}
          />
          <Button
            variant="ghost"
            size="small"
            disabled={!installDir.trim() || busy === 'discover'}
            onClick={() => void discover()}
          >
            {busy === 'discover' ? '读取中…' : '从该目录读取端口与 token'}
          </Button>
        </div>
      ) : null}

      {supportsQr && (
        <div className="qr-box">
          <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div className="li-title">扫码登录 QQ</div>
            <div className="row" style={{ gap: 6 }}>
              <Button variant="ghost" size="small" onClick={() => void loadQr()} disabled={busy === 'qr'}>
                {busy === 'qr' ? '取码中…' : qr ? '重新取码' : '显示二维码'}
              </Button>
              {qr?.ok && (
                <Button variant="quiet" size="small" onClick={() => void refreshQr()} disabled={busy === 'refresh'}>
                  刷新
                </Button>
              )}
            </div>
          </div>
          {qr?.ok ? (
            <div className="row" style={{ gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <img src={qr.image} alt="QQ 登录二维码" width={188} height={188} className="qr-img" />
              <div className="stack tight" style={{ flex: '1 1 200px' }}>
                <div className="li-sub">用手机 QQ 扫码登录。二维码由 NapCat 控制台生成，Yu 只做同源代理，令牌不会到浏览器。</div>
                {qr.status && (
                  <div className="li-sub">
                    登录状态：
                    {qr.status.isLogin ? '已登录' : qr.status.isOffline ? '离线' : '待扫码'}
                    {qr.status.uin ? ` · QQ ${qr.status.uin}` : ''}
                  </div>
                )}
                {qr.fetchedAt && <div className="li-sub">取码于 {fmtTime(qr.fetchedAt)}</div>}
              </div>
            </div>
          ) : qr ? (
            <div className="notice">{qr.reason}</div>
          ) : (
            <div className="li-sub">
              点「启动并继续」时 Yu 会自动把二维码取过来；也可以直接点「显示二维码」。
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelConfig({ channel, onSaved, adminBase }: { channel: Channel; onSaved: () => void; adminBase: string }) {
  const toast = useToast();
  const [config, setConfig] = useState<any>(channel.config ?? {});
  const [saving, setSaving] = useState(false);

  const set = (patch: any) => setConfig({ ...config, ...patch });

  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        body: { name: channel.name, config, enabled: channel.enabled },
      });
      toast('已保存；配置变化会重启该连接', 'ok');
      onSaved();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setSaving(false);
    }
  };

  const isOneBot = channel.type === 'onebot' || channel.type === 'napcat' || channel.type === 'snowluma';

  return (
    <div className="stack" style={{ marginTop: 14, borderTop: '1px solid var(--line-2)', paddingTop: 14 }}>
      {isOneBot ? (
        <>
          <div className="notice">
            1. 在 {CHANNEL_TYPE[channel.type]} 控制台确认 QQ 已登录。2. 在网络配置中添加 OneBot v11 WebSocket 客户端（反向连接），填入下面的地址和相同的访问令牌。3. 保存并启用此连接，再点击「连接测试」。控制台在线不代表 QQ 已登录或 Yu 已连接。
          </div>
          <Code>{`${adminBase.replace(/^http/, 'ws').replace(/\/$/, '')}${channel.runtime?.endpoint?.path ?? `/onebot/${channel.id}`}`}</Code>
          <div className="grid two">
            <Field label="访问令牌（token）" help={config.token__set ? '已设置；留空表示保持不变' : '必须设置，Yu 拒绝未认证连接'}>
              <input type="password" value={config.token ?? ''} onChange={(event) => set({ token: event.target.value })} />
            </Field>
            <Field label="机器人 QQ 号（selfId）" help="可选；填写后会校验 x-self-id 头">
              <input value={config.selfId ?? ''} onChange={(event) => set({ selfId: event.target.value })} />
            </Field>
          </div>
          <div className="grid two">
            <Field label="OneBot HTTP API（可选）" help="填写后连接测试会真实调用 get_status">
              <input value={config.httpBase ?? ''} onChange={(event) => set({ httpBase: event.target.value })} placeholder="http://127.0.0.1:3000" />
            </Field>
            <Field label="HTTP API 令牌（可选）">
              <input type="password" value={config.httpToken ?? ''} onChange={(event) => set({ httpToken: event.target.value })} />
            </Field>
          </div>
        </>
      ) : (
        <>
          <div className="notice">
            在 QQ 开放平台把回调地址设为：<code>{config.webhookHint ?? `/qq/${channel.id}`}</code>
            。Yu 使用 Ed25519 校验回调签名。
          </div>
          <div className="grid two">
            <Field label="AppID">
              <input value={config.appId ?? ''} onChange={(event) => set({ appId: event.target.value })} />
            </Field>
            <Field label="服务端凭据（AppSecret）">
              <input
                type="password"
                value={config.clientSecret ?? ''}
                onChange={(event) => set({ clientSecret: event.target.value })}
                placeholder={config.clientSecret__set ? '已设置，留空保持不变' : ''}
              />
            </Field>
          </div>
          <Field label="签名密钥（botSecret，可选）" help="用于 Webhook 签名校验；留空则复用 AppSecret">
            <input type="password" value={config.botSecret ?? ''} onChange={(event) => set({ botSecret: event.target.value })} />
          </Field>
          <div className="li-sub">
            已实现：access_token 获取与刷新、Webhook 校验握手、签名校验、群/C2C 回复、去重。
            未实现：WebSocket 网关模式（页面明确标注，不会假装可用）。
          </div>
        </>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存配置'}
        </Button>
      </div>
    </div>
  );
}

function AlertPanel({ data, onChanged }: { data: any; onChanged: () => void }) {
  const toast = useToast();
  const [preview, setPreview] = useState<any | null>(null);
  const [sim, setSim] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const runPreview = async () => {
    setBusy(true);
    try {
      setPreview(await api('/api/alerts/preview', { method: 'POST', body: {} }));
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const runSim = async () => {
    setBusy(true);
    try {
      setSim(await api('/api/alerts/simulate', { method: 'POST', body: {} }));
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <KV
        items={[
          {
            label: '邮件通道',
            value: data.mailReady ? '已启用' : '未启用（提醒只会记录，不会发信）',
          },
          { label: '持续阈值', value: `${data.config.thresholdMinutes} 分钟` },
          { label: '冷却', value: `${data.config.cooldownMinutes} 分钟` },
          { label: '恢复提醒', value: data.config.notifyRecovery ? '开启' : '关闭' },
          {
            label: '维护抑制',
            value: data.config.suppressionUntil
              ? `至 ${fmtDateTime(data.config.suppressionUntil)}`
              : '未设置',
          },
        ]}
      />

      <div className="row">
        <Button variant="ghost" size="small" onClick={() => void runPreview()} disabled={busy}>
          隔离预览
        </Button>
        <Button variant="ghost" size="small" onClick={() => void runSim()} disabled={busy}>
          状态机模拟
        </Button>
        <Button
          variant="quiet"
          size="small"
          onClick={async () => {
            const until = Date.now() + 60 * 60_000;
            await api('/api/alerts/suppress', { method: 'POST', body: { until } });
            toast('已抑制 1 小时的告警', 'ok');
            onChanged();
          }}
        >
          抑制 1 小时
        </Button>
        <Button
          variant="quiet"
          size="small"
          onClick={async () => {
            await api('/api/alerts/suppress', { method: 'POST', body: { until: 0 } });
            toast('已取消抑制', 'ok');
            onChanged();
          }}
        >
          取消抑制
        </Button>
      </div>

      {data.states.length > 0 && (
        <div className="list">
          {data.states.map((state: any) => (
            <div className="list-item" key={state.key}>
              <Badge tone={state.status === 'ok' ? 'ok' : 'warn'}>{state.status}</Badge>
              <div className="li-main">
                <div className="li-title">{state.key}</div>
                <div className="li-sub">
                  自 {fmtDateTime(state.since)} · 采样 {state.count} 次
                  {state.lastSentAt ? ` · 上次发信 ${fmtRelative(state.lastSentAt)}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <div className="notice">
          {preview.note}
          {preview.results.length === 0 && <div style={{ marginTop: 6 }}>当前没有任何已启用的连接需要提醒。</div>}
          {preview.results.map((item: any, index: number) => (
            <div key={index} style={{ marginTop: 8 }}>
              <strong>{item.channelName}</strong> · {item.category} · {item.action.reason}
              <Code>{item.mail.body}</Code>
            </div>
          ))}
        </div>
      )}

      {sim && (
        <div className="stack">
          <div className="notice">
            隔离模拟：不发信、不写状态。阈值 {Math.round(sim.config.thresholdMs / 60000)} 分钟，冷却{' '}
            {Math.round(sim.config.cooldownMs / 60000)} 分钟。
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>时间</th>
                <th>采样</th>
                <th>状态变化</th>
                <th>动作</th>
              </tr>
            </thead>
            <tbody>
              {sim.timeline.map((row: any, index: number) => (
                <tr key={index}>
                  <td>{fmtDateTime(row.at)}</td>
                  <td>{row.label}</td>
                  <td>{row.statusChanged ? '是' : '否'}</td>
                  <td>
                    {row.action ? <Badge tone={row.action.kind === 'alert' ? 'bad' : 'ok'}>{row.action.kind}</Badge> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CreateChannelModal({
  types,
  onClose,
  onCreated,
}: {
  types: any[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [type, setType] = useState('napcat');
  const [name, setName] = useState('我的 NapCat');
  const [config, setConfig] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<any | null>(null);

  const isOneBot = type === 'onebot' || type === 'napcat' || type === 'snowluma';

  const test = async () => {
    setBusy(true);
    try {
      setTestResult(await api('/api/channels/test', { method: 'POST', body: { type, config } }));
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      await api('/api/channels', {
        method: 'POST',
        body: { name, type, config, enabled: false },
      });
      toast('已创建（默认停用）；确认配置无误后再启用', 'ok');
      onCreated();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="新增连接"
      subtitle="第一步：选择已使用的程序并设置令牌。创建后会显示专属连接地址，按步骤填入对端。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={() => void test()} disabled={busy}>
            连接测试
          </Button>
          <Button variant="quiet" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void create()} disabled={busy || (isOneBot && !String(config.token ?? '').trim())}>
            创建
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid two">
          <Field label="类型">
            <select
              value={type}
              onChange={(event) => {
                const next = event.target.value;
                setType(next);
                setName(next === 'onebot' ? '我的 OneBot v11' : next === 'qq-official' ? 'QQ 官方机器人' : next === 'snowluma' ? '我的 SnowLuma' : '我的 NapCat');
              }}
            >
              {types
                .filter((item) => item.id !== 'web')
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="名称">
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
        </div>

        {isOneBot ? (
          <div className="grid two">
            <Field label="访问令牌（必填）" help="自行设置一段随机令牌，创建后在 SnowLuma 的 WebSocket 客户端填写同一令牌。">
              <input type="password" value={config.token ?? ''} onChange={(event) => setConfig({ ...config, token: event.target.value })} />
              <Button variant="quiet" size="small" onClick={() => { const bytes = crypto.getRandomValues(new Uint8Array(24)); setConfig({ ...config, token: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') }); }}>生成随机令牌</Button>
              {config.token && <Button variant="quiet" size="small" onClick={() => { void navigator.clipboard.writeText(config.token); toast('令牌已复制，请填入对端', 'ok'); }}>复制令牌</Button>}
            </Field>
            <Field label="机器人 QQ 号">
              <input value={config.selfId ?? ''} onChange={(event) => setConfig({ ...config, selfId: event.target.value })} />
            </Field>
          </div>
        ) : (
          <div className="grid two">
            <Field label="AppID">
              <input value={config.appId ?? ''} onChange={(event) => setConfig({ ...config, appId: event.target.value })} />
            </Field>
            <Field label="AppSecret">
              <input
                type="password"
                value={config.clientSecret ?? ''}
                onChange={(event) => setConfig({ ...config, clientSecret: event.target.value })}
              />
            </Field>
          </div>
        )}

        {testResult && (
          <div className="stack tight">
            {(testResult.checks ?? []).map((check: any, index: number) => (
              <div className="row" key={index}>
                <Badge tone={check.ok ? 'ok' : 'bad'}>{check.ok ? '通过' : '失败'}</Badge>
                <span className="li-sub">
                  {check.name}：{check.detail}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
