import React, { useEffect, useRef, useState } from 'react';
import { api, bytes, fmtDateTime, fmtRelative, truncate } from '../lib';
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
  Tabs,
  Toggle,
  useApi,
  useToast,
} from '../ui';

const GROUP_LABEL: Record<string, string> = {
  model: '模型',
  runtime: '运行',
  tools: '工具',
  prompt: '提示词',
  archive: '归档',
  memory: '记忆',
  web: '网页与认证',
  channel: '私聊身份',
  mail: '邮件',
  alert: '告警',
};

const SETTINGS_TABS = ['model', 'storage', 'config', 'migration', 'environment', 'devices', 'advanced'] as const;

export function SettingsPage({ tab }: { tab: string }) {
  // An old bookmark to a removed tab (prompt / mail) should land on the first
  // tab instead of rendering a page with no panel.
  const initial = SETTINGS_TABS.includes(tab as any) ? tab : 'model';
  const [active, setActive] = useState(initial);
  useEffect(() => setActive(SETTINGS_TABS.includes(tab as any) ? tab : 'model'), [tab]);

  return (
    <>
      <PageHead
        eyebrow="设置"
        title="模型、存储与环境"
        description="这里的每一项都会写入 Yu 自己的配置库；插件包内的默认值只用于首次启动。"
      />
      <Tabs
        tabs={[
          { id: 'model', label: '模型与运行' },
          { id: 'storage', label: '数据与文件' },
          { id: 'config', label: '配置文件' },
          { id: 'migration', label: '迁移' },
          { id: 'environment', label: '环境与诊断' },
          { id: 'devices', label: '设备' },
          { id: 'advanced', label: '全部运行设置' },
        ]}
        active={active as any}
        onChange={(id) => setActive(id)}
      />
      {active === 'model' && <ModelSettings />}
      {active === 'storage' && <StorageSettings />}
      {active === 'config' && <ConfigSettings />}
      {active === 'migration' && <MigrationSettings />}
      {active === 'environment' && <EnvironmentSettings />}
      {active === 'devices' && <DeviceSettings />}
      {active === 'advanced' && <AdvancedSettings />}
    </>
  );
}

export function useSettings() {
  const settings = useApi<any>('/api/settings');
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    const flat: Record<string, any> = {};
    for (const list of Object.values<any>(settings.data.groups)) {
      for (const item of list) flat[item.key] = item.secret ? '' : item.value;
    }
    setDraft(flat);
    setDirty(false);
  }, [settings.data]);

  const set = (key: string, value: any) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  return { settings, draft, set, dirty, setDirty };
}

export function SettingsGroup({
  group,
  settings,
  draft,
  set,
}: {
  group: string;
  settings: any;
  draft: Record<string, any>;
  set: (key: string, value: any) => void;
}) {
  const items = settings.data.groups[group] ?? [];
  if (!items.length) return null;
  return (
    <Card title={GROUP_LABEL[group] ?? group}>
      <div className="grid two">
        {items.map((item: any) => (
          <Field
            key={item.key}
            label={item.label}
            help={item.help || undefined}
          >
            {item.type === 'boolean' ? (
              <Toggle checked={Boolean(draft[item.key])} label={draft[item.key] ? '启用' : '停用'} onChange={(next) => set(item.key, next)} />
            ) : item.type === 'enum' ? (
              <select value={draft[item.key] ?? ''} onChange={(event) => set(item.key, event.target.value)}>
                {(item.enum ?? []).map((option: string) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : item.type === 'number' ? (
              <input
                type="number"
                value={draft[item.key] ?? 0}
                min={item.min ?? undefined}
                max={item.max ?? undefined}
                onChange={(event) => set(item.key, Number(event.target.value))}
              />
            ) : item.type === 'text' ? (
              <textarea className="editor" rows={5} value={draft[item.key] ?? ''} onChange={(event) => set(item.key, event.target.value)} />
            ) : (
              <input
                type={item.secret ? 'password' : 'text'}
                value={draft[item.key] ?? ''}
                placeholder={item.secret && item.isSet ? '已设置（留空保持不变）' : ''}
                onChange={(event) => set(item.key, event.target.value)}
              />
            )}
            {item.secret && item.isSet && <div className="help">当前已保存一个值；不回显。</div>}
          </Field>
        ))}
      </div>
    </Card>
  );
}

function ModelSettings() {
  const { settings, draft, set, dirty, setDirty } = useSettings();
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  if (settings.error) return <ErrorBox error={settings.error} onRetry={() => void settings.reload()} />;
  if (!settings.data) return <Loading label="正在读取设置…" />;

  const effective = settings.data.effectiveSelection;
  const providers = settings.data.models?.providers ?? [];
  const dshDefault = settings.data.models?.defaultSelection;

  const save = async () => {
    setSaving(true);
    try {
      // Only the groups this page actually shows. Sending every draft key
      // would also write the empty placeholder of a secret field and erase it.
      const visibleGroups = new Set(['model', 'runtime', 'channel', 'tools', 'archive', 'web']);
      const groupOf = new Map<string, string>();
      const secretKeys = new Set<string>();
      for (const [group, items] of Object.entries<any>(settings.data.groups)) {
        for (const item of items) {
          groupOf.set(item.key, group);
          if (item.secret) secretKeys.add(item.key);
        }
      }
      const payload: Record<string, any> = {};
      for (const [key, value] of Object.entries(draft)) {
        if (key.endsWith('__set')) continue;
        const group = groupOf.get(key);
        if (!group || !visibleGroups.has(group)) continue;
        if (secretKeys.has(key) && (value === '' || value === null || value === undefined)) continue;
        payload[key] = value;
      }
      const result = await api<any>('/api/settings', { method: 'PATCH', body: { settings: payload } });
      toast(
        result.effectiveFrom === 'restart'
          ? `已保存 ${result.changes.length} 项修改；重启插件后生效`
          : `已保存 ${result.changes.length} 项修改，下次运行生效`,
        'ok',
      );
      setDirty(false);
      await settings.reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <Card title="当前生效的模型路由" subtitle="上下文里的局部覆盖优先级更高">
        <KV
          items={[
            { label: '解析结果', value: effective.ready ? '可用' : '不可用' },
            { label: 'Provider', value: effective.provider ?? '—' },
            { label: 'Model', value: effective.model ?? '—' },
            { label: '思考强度', value: effective.reasoningEffort ?? '适配器默认' },
            {
              label: '来源',
              value:
                effective.source === 'dsh-default'
                  ? '沿用 DSH 默认选择'
                  : effective.source === 'settings'
                    ? 'Yu 设置'
                    : effective.source,
            },
            {
              label: 'DSH 默认',
              value: dshDefault ? `${dshDefault.provider} / ${dshDefault.model}` : '未读取到',
            },
            ...(effective.problems.length
              ? [{ label: '问题', value: effective.problems.join('；') }]
              : []),
          ]}
        />
        {!effective.ready && (
          <div className="notice warn" style={{ marginTop: 12 }}>
            没有可用的模型路由时，管理台仍可使用，但对话与任务会被拒绝执行并给出原因。
          </div>
        )}
      </Card>

      <Card title="模型默认值" subtitle="留空表示沿用 DSH 默认，不改动其他会话的选择">
        <div className="grid three">
          <Field label="Provider">
            <select value={draft['model.provider'] ?? ''} onChange={(event) => set('model.provider', event.target.value)}>
              <option value="">（沿用 DSH 默认）</option>
              {providers.map((provider: any) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <select value={draft['model.model'] ?? ''} onChange={(event) => set('model.model', event.target.value)}>
              <option value="">（沿用 DSH 默认）</option>
              {providers
                .find((provider: any) => provider.id === (draft['model.provider'] || dshDefault?.provider))
                ?.models?.map((model: any) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="思考强度" help="适配器支持的 effort id；留空为默认">
            <input
              value={draft['model.reasoningEffort'] ?? ''}
              onChange={(event) => set('model.reasoningEffort', event.target.value)}
              list="effort-options"
            />
            <datalist id="effort-options">
              {['low', 'medium', 'high', 'max', 'off'].map((effort) => (
                <option key={effort} value={effort} />
              ))}
            </datalist>
          </Field>
        </div>
      </Card>

      <SettingsGroup group="runtime" settings={settings} draft={draft} set={set} />
      <SettingsGroup group="channel" settings={settings} draft={draft} set={set} />
      <SettingsGroup group="tools" settings={settings} draft={draft} set={set} />
      <SettingsGroup group="archive" settings={settings} draft={draft} set={set} />
      <SettingsGroup group="web" settings={settings} draft={draft} set={set} />

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? '保存中…' : '保存设置'}
        </Button>
      </div>
    </div>
  );
}

function StorageSettings() {
  const backups = useApi<any>('/api/backups');
  const env = useApi<any>('/api/environment');
  const dataRoot = useApi<any>('/api/data-root');
  const inventory = useApi<any>('/api/data-root/inventory');
  const sessions = useApi<any>('/api/system/sessions');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const [exported, setExported] = useState<any | null>(null);

  const reloadAll = async () => {
    await Promise.all([env.reload(), dataRoot.reload(), inventory.reload(), sessions.reload(), backups.reload()]);
  };

  const createBackup = async () => {
    setBusy(true);
    try {
      const result = await api<any>('/api/backups', { method: 'POST', body: { label: 'manual' } });
      toast(`已创建备份 ${result.backup.name}`, 'ok');
      await backups.reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const reveal = async (key: string) => {
    try {
      const result = await api<any>('/api/system/reveal', { method: 'POST', body: { key } });
      toast(result.note, 'ok');
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  const doExport = async () => {
    try {
      const result = await api<any>('/api/memory/export', { method: 'POST', body: {} });
      setExported(result);
      toast(`已导出到 ${result.path}`, 'ok');
      await Promise.all([inventory.reload(), dataRoot.reload()]);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  const sourceLabel: Record<string, string> = {
    config: '插件行 config 指定',
    pointer: '页面设置（location.json）',
    default: '平台默认',
    fallback: '配置不可用，已回退默认',
  };

  return (
    <div className="stack">
      <Card
        title="数据根"
        subtitle="所有 Yu 产生的数据都在这个目录里；改位置是复制而不是移动，旧目录会保留"
        actions={
          <>
            <Button variant="ghost" size="small" onClick={() => void reveal('data')}>
              打开文件夹
            </Button>
            <Button onClick={() => setMoving(true)}>更改位置</Button>
          </>
        }
      >
        {dataRoot.data ? (
          <>
            <KV
              items={[
                { label: '当前路径', value: <CopyPath value={dataRoot.data.dataDir} /> },
                { label: '来源', value: <Badge tone={dataRoot.data.source === 'default' ? 'muted' : 'accent'}>{sourceLabel[dataRoot.data.source] ?? dataRoot.data.source}</Badge> },
                { label: '占用', value: `${bytes(dataRoot.data.totalBytes)}${dataRoot.data.freeBytes ? ` · 磁盘可用 ${bytes(dataRoot.data.freeBytes)}` : ''}` },
                { label: '短期记忆文件', value: <span>相对这里：<code className="tag">memory/short-term/*.md</code></span> },
                { label: '指针文件', value: <CopyPath value={dataRoot.data.pointerFile} /> },
                { label: '说明', value: dataRoot.data.note },
              ]}
            />
            <div className="grid three" style={{ marginTop: 14 }}>
              {dataRoot.data.children
                .filter((child: any) => child.exists)
                .map((child: any) => (
                  <div key={child.key} className="stat" style={{ background: 'var(--surface-2)', border: '1px solid var(--line-2)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
                    <div className="stat-label">{child.key}</div>
                    <div style={{ fontSize: 15, fontWeight: 620 }}>{bytes(child.bytes)}</div>
                    <div className="stat-note">{child.files} 个文件</div>
                  </div>
                ))}
            </div>
          </>
        ) : (
          <Loading />
        )}
      </Card>

      <Card
        title="文件与保存位置"
        subtitle="逐项列出 Yu 会写什么、写到哪里；会话原文副本让整个目录可独立备份"
        actions={
          <Button variant="ghost" size="small" onClick={() => void reloadAll()}>
            刷新
          </Button>
        }
      >
        {inventory.data ? (
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 120 }}>内容</th>
                <th>路径</th>
                <th style={{ width: 150 }}>用途</th>
                <th style={{ width: 90 }}>大小</th>
                <th style={{ width: 70 }}>文件数</th>
                <th style={{ width: 130 }} />
              </tr>
            </thead>
            <tbody>
              {inventory.data.rows.map((row: any) => (
                <tr key={row.key}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{row.label}</div>
                    {!row.exists && <Badge tone="muted">未生成</Badge>}
                  </td>
                  <td>
                    <CopyPath value={row.path} />
                  </td>
                  <td className="li-sub">{row.purpose}</td>
                  <td>{bytes(row.bytes)}</td>
                  <td>{row.files}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <Button variant="quiet" size="small" onClick={() => void reveal(row.key)}>
                        打开
                      </Button>
                      <Button
                        variant="quiet"
                        size="small"
                        onClick={() => {
                          void navigator.clipboard?.writeText(row.path);
                          toast('路径已复制', 'ok');
                        }}
                      >
                        复制
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Loading />
        )}
      </Card>

      <Card
        title="会话原文副本"
        subtitle="DSH 原日志在 ~/.dsh/sessions 下，仍是运行中的权威；这里存 Yu 自己的明文副本"
        actions={
          <Button variant="ghost" size="small" onClick={() => void reveal('sessions')}>
            打开文件夹
          </Button>
        }
      >
        {sessions.data ? (
          <KV
            items={[
              { label: '副本目录', value: <CopyPath value={sessions.data.mirror.dir} /> },
              { label: '会话数', value: `${sessions.data.mirror.files} 个文件` },
              { label: '占用', value: bytes(sessions.data.mirror.bytes) },
              { label: '最近写入', value: sessions.data.mirror.newestAt ? fmtDateTime(sessions.data.mirror.newestAt) : '—' },
              { label: '说明', value: sessions.data.note },
            ]}
          />
        ) : (
          <Loading />
        )}
      </Card>

      <Card
        title="备份"
        subtitle="备份前会先做 WAL checkpoint，保证副本自洽"
        actions={
          <Button onClick={() => void createBackup()} disabled={busy}>
            {busy ? '创建中…' : '立即备份'}
          </Button>
        }
      >
        {backups.data?.backups.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>文件</th>
                <th>时间</th>
                <th>大小</th>
                <th>Schema</th>
                <th>SHA-256</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {backups.data.backups.map((backup: any) => (
                <tr key={backup.name}>
                  <td>
                    <code>{backup.name}</code>
                  </td>
                  <td>{fmtDateTime(backup.createdAt)}</td>
                  <td>{bytes(backup.bytes)}</td>
                  <td>v{backup.manifest?.schemaVersion ?? '?'}</td>
                  <td>
                    <code>{backup.manifest?.sha256?.slice(0, 12) ?? '—'}…</code>
                  </td>
                  <td>
                    <Button
                      variant="quiet"
                      size="small"
                      onClick={async () => {
                        if (!window.confirm('恢复会用该备份替换当前数据库。当前库会另存一份，替换后立即生效（无需重启）。')) return;
                        try {
                          const result = await api<any>(`/api/backups/${backup.name}/restore`, { method: 'POST', body: {} });
                          toast(
                            result.restartRequired
                              ? `已替换；安全副本 ${result.safetyCopy}。请重启插件。`
                              : `已切换到这个备份；安全副本 ${result.safetyCopy}。刷新页面即可。`,
                            result.restartRequired ? 'warn' : 'ok',
                          );
                          await backups.reload();
                        } catch (error) {
                          toast((error as Error).message, 'bad');
                        }
                      }}
                    >
                      恢复
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="还没有备份" hint="建议在改动配置或迁移前先备份一次。" />
        )}
      </Card>

      <Card
        title="导出"
        subtitle="把记忆块导成一份可读的 Markdown，写入数据根的 exports/"
        actions={
          <Button variant="ghost" onClick={() => void doExport()}>
            导出记忆
          </Button>
        }
      >
        {exported ? (
          <KV
            items={[
              { label: '文件', value: <CopyPath value={exported.path} /> },
              { label: '大小', value: bytes(exported.bytes) },
              { label: '预览', value: <pre style={{ maxHeight: 160 }}>{exported.preview}</pre> },
            ]}
          />
        ) : (
          <div className="li-sub">导出是数据库的派生视图；权威仍是 yu.db。</div>
        )}
      </Card>

      <Card title="安全提示">
        <div className="notice warn">
          数据根里包含凭据字段（SMTP 密码、OneBot 令牌）与全部对话内容。整目录备份请自行保管；
          分享给他人前请先在设置里清空凭据，或只导出记忆 Markdown。
          卸载插件不会删除这个目录。
        </div>
      </Card>

      {moving && dataRoot.data && (
        <DataRootModal
          current={dataRoot.data.dataDir}
          onClose={() => setMoving(false)}
          onDone={async () => {
            setMoving(false);
            await reloadAll();
          }}
        />
      )}
    </div>
  );
}

function CopyPath({ value }: { value: string }) {
  return (
    <span className="row" style={{ gap: 6, alignItems: 'center' }}>
      <code style={{ wordBreak: 'break-all' }}>{value}</code>
      <button
        type="button"
        className="btn quiet small"
        title="复制路径"
        style={{ minHeight: 24, padding: '0 6px' }}
        onClick={() => void navigator.clipboard?.writeText(value)}
      >
        复制
      </button>
    </span>
  );
}

function DataRootModal({
  current,
  onClose,
  onDone,
}: {
  current: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const [path, setPath] = useState(current);
  const [listing, setListing] = useState<any | null>(null);
  const [check, setCheck] = useState<any | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<any | null>(null);

  const browse = async (target: string) => {
    setLoading(true);
    try {
      const data = await api<any>(`/api/system/dirs?path=${encodeURIComponent(target)}`);
      setListing(data);
      setPath(data.path);
      setCheck(null);
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void browse(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runPrecheck = async () => {
    setLoading(true);
    try {
      const data = await api<any>('/api/data-root/precheck', { method: 'POST', body: { target: path } });
      setCheck(data);
      if (data.ok) toast('预检通过', 'ok');
      else toast('预检未通过，见下方原因', 'warn');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    setApplying(true);
    try {
      const data = await api<any>('/api/data-root/apply', {
        method: 'POST',
        body: { target: path, confirm: true },
      });
      setResult(data);
      toast(data.mode === 'live' ? '已切换到新目录，立即生效' : '已写入新位置，重启后生效', 'ok');
      await onDone();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setApplying(false);
    }
  };

  if (result) {
    const live = result.mode === 'live';
    return (
      <Modal
        open
        title={live ? '数据根已切换（立即生效）' : '数据根已迁移'}
        subtitle={live ? '数据库句柄已在新目录上重新打开；任务、渠道与日志已跟过去' : '旧目录没有删除；重启插件后使用新目录'}
        onClose={onClose}
        footer={<Button onClick={onClose}>知道了</Button>}
      >
        <div className="stack">
          <KV
            items={[
              { label: '新位置', value: <CopyPath value={result.target} /> },
              { label: '旧位置（保留）', value: <CopyPath value={result.previous} /> },
              { label: '数据库校验', value: `${result.verification.integrity} · schema v${result.verification.schemaVersion} · ${result.verification.tasks} 个任务` },
              { label: '耗时', value: `${result.durationMs} ms` },
              { label: '指针', value: <CopyPath value={result.pointerFile} /> },
            ]}
          />
          {live ? (
            <div className="notice">
              现在这条页面请求就落在新目录上：刷新列表即可看到任务仍在、数据未丢。旧目录保持原样，
              确认无误后可以自行删除。重启 Yu 之后也会继续使用新目录（由 location.json 指针决定）。
            </div>
          ) : (
            <div className="notice">
              重启方式：`plugin_manager` 里先 <code>remove_bundle target=@yu/companion</code>，再
              <code>install_bundle target=C:\apps\yu</code>。确认新目录正常后，旧目录可以手动删除。
            </div>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      wide
      title="更改数据根"
      subtitle="先选一个空目录；Yu 会暂停调度与渠道，把数据库快照复制过去并立即切换，旧目录不发生删除"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            取消
          </Button>
          <Button variant="ghost" onClick={() => void runPrecheck()} disabled={loading}>
            预检
          </Button>
          <Button onClick={() => void apply()} disabled={!check?.ok || !confirmed || applying}>
            {applying ? '切换中…' : '开始切换'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="目标目录" help="必须是绝对路径；不能是当前目录或其父子目录">
          <div className="file-input-row">
            <input value={path} onChange={(event) => setPath(event.target.value)} />
            <Button variant="ghost" size="small" onClick={() => void browse(path)} disabled={loading}>
              浏览
            </Button>
          </div>
        </Field>

        {listing && (
          <div>
            <div className="row between" style={{ marginBottom: 6 }}>
              <span className="li-sub">{listing.path}</span>
              <div className="row" style={{ gap: 6 }}>
                {listing.parent && (
                  <Button variant="quiet" size="small" onClick={() => void browse(listing.parent)}>
                    上一级
                  </Button>
                )}
                <Button variant="ghost" size="small" onClick={() => void runPrecheck()}>
                  选择此目录
                </Button>
              </div>
            </div>
            <div className="row" style={{ gap: 4, marginBottom: 8 }}>
              {(listing.roots ?? []).map((root: string) => (
                <Button key={root} variant="quiet" size="small" onClick={() => void browse(root)}>
                  {root}
                </Button>
              ))}
            </div>
            {listing.error && <div className="notice warn">无法读取：{listing.error}</div>}
            <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--line-2)', borderRadius: 'var(--radius-sm)' }}>
              {listing.entries.length === 0 && <div className="li-sub" style={{ padding: 12 }}>没有子目录</div>}
              {listing.entries.map((entry: any) => (
                <button
                  key={entry.path}
                  type="button"
                  className="list-item"
                  style={{ width: '100%', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => void browse(entry.path)}
                >
                  <div className="li-main">
                    <div className="li-title">{entry.name}</div>
                    <div className="li-sub">{entry.path}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {check && (
          <div className="stack tight">
            {check.ok ? (
              <div className="notice">
                预检通过：需要约 {bytes(check.requiredBytes)}，目标可用 {bytes(check.freeBytes ?? 0)}。
              </div>
            ) : (
              <div className="notice bad">
                <strong>不能迁移：</strong>
                <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                  {check.problems.map((problem: string, index: number) => (
                    <li key={index}>{problem}</li>
                  ))}
                </ul>
              </div>
            )}
            {(check.warnings ?? []).map((warning: string, index: number) => (
              <div className="notice warn" key={index}>
                {warning}
              </div>
            ))}
            {check.ok && (
              <Toggle
                checked={confirmed}
                label="我理解：重启后才生效，旧目录会保留（需要我手动删除）"
                onChange={setConfirmed}
              />
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * One JSON document for the whole configuration.
 *
 * The alternative — a form per feature — is what the console already had, and
 * it is fine for changing one value and terrible for "what is this install's
 * configuration?" or "copy it to the other machine". The document is exported
 * from the database, edited as text, validated, then applied as a merge.
 */
function ConfigSettings() {
  const current = useApi<any>('/api/config');
  const toast = useToast();
  const [text, setText] = useState('');
  const [baseline, setBaseline] = useState('');
  const [preview, setPreview] = useState<any | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const uploadRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!current.data) return;
    setText(current.data.text);
    setBaseline(current.data.text);
  }, [current.data]);

  const edited = text !== baseline;

  const exportNow = async () => {
    if (edited && !window.confirm('当前文本框里有未应用的修改，重新导出会覆盖它。继续？')) return;
    setBusy('export');
    try {
      const result = await api<any>('/api/config/export', {
        method: 'POST',
        body: { includeSecrets },
      });
      setText(result.text);
      setBaseline(result.text);
      setPreview(null);
      toast(result.secretsIncluded ? '已导出（含凭据，请小心保管）' : '已导出（不含凭据）', 'ok');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const validate = async () => {
    setBusy('validate');
    try {
      const result = await api<any>('/api/config/preview', { method: 'POST', body: { text } });
      setPreview(result);
      toast(result.ok ? '校验通过，可以应用' : '校验没通过，见下方问题', result.ok ? 'ok' : 'warn');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!preview?.ok) {
      toast('先校验通过再应用', 'warn');
      return;
    }
    if (!window.confirm('把这份配置应用到当前实例？这是合并：文档里的任务、上下文、记忆块会新增或更新，文档里没有的不会被删除。')) return;
    setBusy('apply');
    try {
      const result = await api<any>('/api/config/apply', { method: 'POST', body: { text, confirm: true } });
      toast(
        `已应用：设置 ${result.settings} · 注入段 ${result.sections} · 记忆块 ${result.blocks} · 上下文 ${result.contexts} · 任务 ${result.tasks} · 触发 ${result.triggers}`,
        'ok',
      );
      setEffectiveFrom([result.effectiveFrom,...(result.warnings ?? [])].join('；'));
      setPreview(null);
      // The database is now the source this text described; re-read it so the
      // editor shows the canonical export (and the file stats refresh).
      await current.reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const clearConfig = async () => {
    if (!window.confirm('清空运行配置和全部渠道凭据、任务触发器、上下文方案、项目定义（进度单独保存）及工具覆盖？自定义人格提示和注入段将恢复内建默认；独立人格文件、所有记忆、对话归档、项目进度及设备登录保留。设置恢复内建默认，自动维护关闭。此操作不可撤销。')) return;
    setBusy('clear');
    try {
      const result = await api<any>('/api/config/clear', {method:'POST',body:{confirm:true}});
      setEffectiveFrom([result.effectiveFrom,...(result.warnings ?? [])].join('；'));
      setPreview(null);
      await current.reload();
      toast('运行配置已清空；提示恢复默认，记忆与业务数据已保留','ok');
    } catch(error) { toast((error as Error).message,'bad'); }
    finally {setBusy(null);}
  };
  const writeFile = async () => {
    setBusy('file');
    try {
      const result = await api<any>('/api/config/file', { method: 'POST', body: { text } });
      toast(`已写入 ${result.path}`, 'ok');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const readFile = async () => {
    setBusy('read');
    try {
      const result = await api<any>('/api/config/file');
      if (!result.exists) {
        toast('数据根里还没有 yu.config.json', 'warn');
        return;
      }
      setText(result.text);
      setPreview(null);
      toast('已从数据根读取，记得校验后再应用', 'ok');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const download = () => {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'yu.config.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (current.error) return <ErrorBox error={current.error} onRetry={() => void current.reload()} />;
  if (!current.data) return <Loading label="正在读取配置…" />;

  const summary = preview?.summary;
  const count = (value: number | undefined) => (value === undefined ? '—' : String(value));
  const hasChanges = Boolean(
    (summary?.channels?.length ?? 0) > 0 || (summary?.overlays?.length ?? 0) > 0 ||
    (summary?.settings?.length ?? 0) > 0 ||
      (summary?.blocks?.create?.length ?? 0) > 0 ||
      (summary?.blocks?.update?.length ?? 0) > 0 ||
      (summary?.contexts?.create?.length ?? 0) > 0 ||
      (summary?.contexts?.update?.length ?? 0) > 0 ||
      (summary?.tasks?.create?.length ?? 0) > 0 ||
      (summary?.tasks?.update?.length ?? 0) > 0 ||
      (summary?.projects?.create?.length ?? 0) > 0 ||
      (summary?.projects?.update?.length ?? 0) > 0 ||
      (summary?.sections?.changed ?? false) ||
      (summary?.triggers?.create ?? 0) > 0 ||
      (summary?.triggers?.update ?? 0) > 0 ||
      (summary?.secrets?.length ?? 0) > 0,
  );

  return (
    <div className="stack">
      <Card
        title="Yu 行为配置，一份 JSON"
        subtitle="设置、注入段、短期记忆块、上下文方案、项目状态、任务/触发器、渠道连接与工具覆盖。改文本、校验、应用；导出与加载用来迁移。"
        actions={
          <>
            <Toggle checked={includeSecrets} label="导出时包含凭据" onChange={setIncludeSecrets} />
            <Button variant="ghost" size="small" onClick={() => void exportNow()} disabled={busy === 'export'}>
              {busy === 'export' ? '导出中…' : '重新导出'}
            </Button>
          </>
        }
      >
        <div className="notice" style={{ fontSize: 12, lineHeight: 1.75 }}>
          导入是<strong>合并</strong>，不是替换：任务与上下文按名称匹配，项目按 id，触发器按 type + label；文档里没有的东西保持原样。
          项目状态（阅读进度等）会被文档里的值覆盖；对话、归档、长期记忆库与设备登录不在文档里；渠道连接包含在文档内。凭据默认不导出；
          勾上再导出时请把文本当密码保管。
        </div>
        <textarea
          className="editor"
          style={{ minHeight: 460, fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.65 }}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setPreview(null);
          }}
          spellCheck={false}
        />
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 10, flexWrap: 'wrap' }}>
          <div className="row">
            <Button variant="ghost" onClick={() => void validate()} disabled={busy === 'validate'}>
              {busy === 'validate' ? '校验中…' : '校验'}
            </Button>
            <Button onClick={() => void apply()} disabled={busy === 'apply' || !preview?.ok}>
              {busy === 'apply' ? '应用中…' : '应用'}
            </Button>
            <Button variant="quiet" onClick={download}>
              下载 .json
            </Button>
            <Button variant="quiet" onClick={() => uploadRef.current?.click()}>
              从文件载入
            </Button>
            <input
              ref={uploadRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void file.text().then((content) => {
                  setText(content);
                  setPreview(null);
                  toast(`已载入 ${file.name}，先校验再应用`, 'ok');
                });
                event.target.value = '';
              }}
            />
          </div>
          <div className="row">
            <Button variant="quiet" onClick={() => void readFile()} disabled={busy === 'read'}>
              从数据根读取
            </Button>
            <Button variant="quiet" onClick={() => void writeFile()} disabled={busy === 'file'}>
              写入数据根
            </Button>
          </div>
        </div>
        <div className="li-sub" style={{ marginTop: 8 }}>
          应用后立即写入数据库：渠道与触发器同步；注入段与记忆从下一次运行 / 下一个会话生效；工具开放范围、工具注册变化需重启。
        </div>
        <div className="li-sub" style={{ marginTop: 4 }}>
          数据根文件：<code>{current.data.filePath}</code>
          {current.data.file?.exists ? `（${bytes(current.data.file.bytes)}）` : '（还没有）'} · 当前导出{' '}
          {bytes(current.data.bytes)}
          {edited ? ' · 文本框有未应用的修改' : ''}
        </div>
      </Card>

      {effectiveFrom && <div className="notice">{effectiveFrom}</div>}
      <Card title="清空运行配置" subtitle="自定义提示与注入段恢复内建默认；删除渠道凭据、任务、上下文、项目定义和工具覆盖。独立人格文件、记忆、对话归档、设备登录保留；项目进度可用相同 id、省略 state 的项目 JSON 恢复。"><Button variant="ghost" onClick={() => void clearConfig()} disabled={busy !== null}>清空运行配置</Button></Card>
      {preview && (
        <Card
          title={preview.ok ? '校验通过' : '校验没通过'}
          subtitle={preview.note}
          actions={<Badge tone={preview.ok ? 'ok' : 'bad'}>{preview.ok ? '可以应用' : '不会写入'}</Badge>}
        >
          <div className="notice">渠道改动 {summary?.channels?.length ?? 0} · 工具覆盖 {summary?.overlays?.length ?? 0} · 凭据 {summary?.secrets?.length ?? 0}</div>
          <div className="grid four">
            <div className="stat">
              <div className="stat-label">设置改动</div>
              <div className="stat-value">{count(summary?.settings?.length)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">注入段</div>
              <div className="stat-value">{count(summary?.sections?.entries)}</div>
              <div className="stat-note">
                当前 {count(summary?.sections?.current)} · {summary?.sections?.changed ? '将替换' : '无改动'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">记忆块</div>
              <div className="stat-value">
                {(summary?.blocks?.create?.length ?? 0) + (summary?.blocks?.update?.length ?? 0)}
              </div>
              <div className="stat-note">
                新增 {summary?.blocks?.create?.length ?? 0} / 更新 {summary?.blocks?.update?.length ?? 0}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">上下文</div>
              <div className="stat-value">
                {(summary?.contexts?.create?.length ?? 0) + (summary?.contexts?.update?.length ?? 0)}
              </div>
              <div className="stat-note">
                新增 {summary?.contexts?.create?.length ?? 0} / 更新 {summary?.contexts?.update?.length ?? 0}
              </div>
            </div>
          </div>
          <div className="grid four" style={{ marginTop: 10 }}>
            <div className="stat">
              <div className="stat-label">任务</div>
              <div className="stat-value">
                {(summary?.tasks?.create?.length ?? 0) + (summary?.tasks?.update?.length ?? 0)}
              </div>
              <div className="stat-note">
                新增 {summary?.tasks?.create?.length ?? 0} / 更新 {summary?.tasks?.update?.length ?? 0}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">触发器</div>
              <div className="stat-value">
                {(summary?.triggers?.create ?? 0) + (summary?.triggers?.update ?? 0)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">项目</div>
              <div className="stat-value">
                {(summary?.projects?.create?.length ?? 0) + (summary?.projects?.update?.length ?? 0)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">凭据</div>
              <div className="stat-value">{count(summary?.secrets?.length)}</div>
            </div>
          </div>

          {preview.problems?.length > 0 && (
            <div className="notice bad" style={{ marginTop: 12 }}>
              <strong>问题</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {preview.problems.map((problem: string, index: number) => (
                  <li key={index}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
          {preview.warnings?.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary className="li-sub" style={{ cursor: 'pointer' }}>
                提示（{preview.warnings.length}）
              </summary>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {preview.warnings.map((warning: string, index: number) => (
                  <li key={index} className="li-sub">
                    {warning}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {preview.ok && (summary?.settings?.length ?? 0) > 0 && (
            <div className="stack tight" style={{ marginTop: 12 }}>
              <div className="caption" style={{ padding: 0 }}>
                设置改动
              </div>
              {summary.settings.map((change: any) => (
                <div key={change.key} className="ledger-row">
                  <code className="tag">{change.key}</code>
                  <div className="li-sub" style={{ marginTop: 4, wordBreak: 'break-all' }}>
                    {truncate(JSON.stringify(change.before), 180)} → {truncate(JSON.stringify(change.after), 180)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {preview.ok && hasChanges && (
            <div className="stack tight" style={{ marginTop: 12 }}>
              <div className="caption" style={{ padding: 0 }}>
                变更明细
              </div>
              {[
                ['记忆块 · 新增', summary?.blocks?.create?.map((item: any) => item.slug)],
                ['记忆块 · 更新', summary?.blocks?.update?.map((item: any) => item.slug)],
                ['上下文 · 新增', summary?.contexts?.create?.map((item: any) => item.name)],
                ['上下文 · 更新', summary?.contexts?.update?.map((item: any) => item.name)],
                ['任务 · 新增', summary?.tasks?.create?.map((item: any) => item.name)],
                ['任务 · 更新', summary?.tasks?.update?.map((item: any) => item.name)],
                ['项目', summary?.projects?.create?.concat(summary?.projects?.update ?? []).map((item: any) => item.id)],
              ]
                .filter(([, items]) => Array.isArray(items) && items.length > 0)
                .map(([label, items]: any) => (
                  <div key={label} className="ledger-row">
                    <b>{label}</b>
                    <div className="li-sub" style={{ marginTop: 4 }}>
                      {items.join('、')}
                    </div>
                  </div>
                ))}
              {summary?.triggers && summary.triggers.create + summary.triggers.update > 0 && (
                <div className="ledger-row">
                  <b>触发器</b>
                  <div className="li-sub" style={{ marginTop: 4 }}>
                    新增 {summary.triggers.create} · 更新 {summary.triggers.update}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function MigrationSettings() {
  const toast = useToast();
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);

  const loadPreview = async () => {
    setBusy(true);
    try {
      setPreview(await api(`/api/migration/preview?path=${encodeURIComponent(path)}`));
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!window.confirm('把预览中列出的内容导入 Yu 的数据库？旧目录不会被修改。')) return;
    setBusy(true);
    try {
      setResult(
        await api('/api/migration/import', {
          method: 'POST',
          body: { legacyRoot: path, confirm: true, includeStyle: true, includeOwner: true, includePeople: true },
        }),
      );
      toast('导入完成', 'ok');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Card title="旧项目迁移（只读源）" subtitle="先在副本预览，确认后再导入；原始文件不会被改动">
        <div className="file-input-row">
          <input value={path} onChange={(event) => setPath(event.target.value)} />
          <Button variant="ghost" onClick={() => void loadPreview()} disabled={busy}>
            生成预览
          </Button>
          <Button onClick={() => void doImport()} disabled={busy || !preview?.exists}>
            导入
          </Button>
        </div>
      </Card>

      {preview && (
        <>
          <Card title="发现的内容">
            <table className="data">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>路径</th>
                  <th>存在</th>
                  <th>大小</th>
                </tr>
              </thead>
              <tbody>
                {(preview.artifacts ?? []).map((artifact: any) => (
                  <tr key={artifact.key}>
                    <td>{artifact.label}</td>
                    <td>
                      <code>{artifact.path}</code>
                    </td>
                    <td>{artifact.exists ? <Badge tone="ok">是</Badge> : <Badge tone="muted">否</Badge>}</td>
                    <td>{bytes(artifact.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <KV
              items={[
                { label: '人物档案', value: `${preview.people.count} 个` },
                { label: '群组目录', value: preview.groups.length ? preview.groups.join('、') : '无' },
                { label: '知识库', value: preview.knowledge ? <code>{preview.knowledge}</code> : '未发现' },
              ]}
            />
          </Card>

          <Card title="映射关系">
            <div className="stack tight">
              {(preview.mapped ?? []).map((item: any, index: number) => (
                <div className="row" key={index}>
                  <Badge tone="ok">可映射</Badge>
                  <span className="li-sub">
                    {item.source} → {item.target}
                  </span>
                </div>
              ))}
              {(preview.unmapped ?? []).map((item: any, index: number) => (
                <div className="row" key={index}>
                  <Badge tone="warn">未映射</Badge>
                  <span className="li-sub">
                    {item.source}：{item.reason}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      {result && (
        <Card title="导入结果">
          <div className="stack tight">
            {result.actions.map((action: any, index: number) => (
              <div className="row" key={index}>
                <Badge tone={action.type === 'skipped' ? 'muted' : 'ok'}>{action.type}</Badge>
                <span className="li-sub">
                  {action.source ?? action.slug ?? action.key} {action.version ? `→ v${action.version}` : ''}
                  {action.reason ? `：${action.reason}` : ''}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function EnvironmentSettings() {
  const env = useApi<any>('/api/environment');
  const diag = useApi<any>('/api/diagnostics');

  if (env.error) return <ErrorBox error={env.error} onRetry={() => void env.reload()} />;
  if (!env.data) return <Loading />;

  return (
    <div className="stack">
      <Card title="运行环境">
        <KV
          items={[
            { label: 'Yu 版本', value: env.data.version },
            { label: '插件启动于', value: `${fmtDateTime(env.data.startedAt)}（${fmtRelative(env.data.startedAt)}）` },
            {
              label: 'DSH 版本',
              value: (
                <span className="row" style={{ gap: 6 }}>
                  {env.data.harness.version ?? '未知'}
                  <Badge tone={env.data.compat.supported ? 'ok' : 'warn'}>
                    {env.data.compat.supported ? '支持范围内' : '超出支持范围'}
                  </Badge>
                </span>
              ),
            },
            { label: 'DSH 来源', value: <code>{env.data.harness.source ?? '未检测到'}</code> },
            { label: 'Node / Electron', value: `${env.data.platform.node} / ${env.data.platform.electron ?? '—'}` },
            { label: '平台', value: `${env.data.platform.os} ${env.data.platform.arch}` },
            { label: '时区', value: env.data.timezone },
          ]}
        />
      </Card>

      <Card title="能力探测" subtitle="缺失项会降级对应功能并在下方注明">
        <div className="grid two">
          {env.data.capabilities.map((capability: any) => (
            <div className="row" key={capability.id}>
              <Badge tone={capability.available ? 'ok' : 'warn'}>{capability.available ? '可用' : '缺失'}</Badge>
              <span className="li-sub">
                <code>{capability.id}</code> · {capability.feature}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card title="最近宿主日志" subtitle="包含 Yu 自己的日志环形缓冲">
        {diag.data ? <Code>{diag.data.log.map((line: any) => `${new Date(line.at).toISOString()} [${line.level}] ${line.msg}${line.extra ? ' ' + JSON.stringify(line.extra) : ''}`).join('\n')}</Code> : <Loading />}
      </Card>

      <Card title="审计">
        {diag.data ? (
          <div className="list">
            {diag.data.audit.map((entry: any) => (
              <div className="list-item" key={entry.id}>
                <Badge tone="muted">{entry.actor}</Badge>
                <div className="li-main">
                  <div className="li-title">{entry.action}</div>
                  <div className="li-sub">
                    {entry.target} · {fmtDateTime(entry.at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Loading />
        )}
      </Card>
    </div>
  );
}

function DeviceSettings() {
  const devices = useApi<any>('/api/devices');
  const toast = useToast();
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mintCode = async () => {
    setBusy(true);
    try {
      const result = await api<any>('/api/devices/pairing-code', { method: 'POST', body: {} });
      setPairCode(result.code);
      toast('已生成一次性配对码（10 分钟内有效）', 'ok');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Card
        title="已配对设备"
        subtitle="每台设备一个独立令牌；撤销后需要重新配对"
        actions={
          <div className="row">
            <Button variant="ghost" size="small" onClick={() => void mintCode()} disabled={busy}>
              生成配对码
            </Button>
            <Button variant="quiet" size="small" onClick={() => void devices.reload()}>
              刷新
            </Button>
          </div>
        }
      >
        {pairCode && (
          <div className="notice" style={{ marginBottom: 12 }}>
            在另一台设备打开管理台并输入：{' '}
            <code style={{ fontSize: 15, letterSpacing: 2, fontWeight: 700 }}>{pairCode}</code>
            <div className="li-sub" style={{ marginTop: 4 }}>
              只能使用一次，10 分钟内有效。也可以从 Yu 数据目录的 pairing-code.txt 读取。
            </div>
          </div>
        )}
        {devices.data?.devices.length ? (
          <div className="list">
            {devices.data.devices.map((device: any) => (
              <div className="list-item" key={device.id}>
                <Badge tone={device.revokedAt ? 'muted' : 'ok'}>{device.revokedAt ? '已撤销' : '有效'}</Badge>
                <div className="li-main">
                  <div className="li-title">{device.label}</div>
                  <div className="li-sub">
                    配对 {fmtDateTime(device.createdAt)} · 最近使用 {fmtRelative(device.lastSeenAt)} · 到期{' '}
                    {fmtDateTime(device.expiresAt)}
                  </div>
                </div>
                {!device.revokedAt && (
                  <Button
                    variant="quiet"
                    size="small"
                    onClick={async () => {
                      await api(`/api/devices/${device.id}`, { method: 'DELETE' });
                      toast('已撤销该设备', 'ok');
                      await devices.reload();
                    }}
                  >
                    撤销
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty title="还没有已配对设备" />
        )}
      </Card>
    </div>
  );
}

function AdvancedSettings() {
  const {settings,draft,set,dirty,setDirty}=useSettings(); const toast=useToast();
  const [saving,setSaving]=useState(false);
  if(settings.error)return <ErrorBox error={settings.error} onRetry={()=>void settings.reload()} />;
  if(!settings.data)return <Loading />;
  const save=async()=>{setSaving(true);try {
    const payload:Record<string,any>={};
    for(const [group,items] of Object.entries<any>(settings.data.groups)) for(const item of items) {
      if(group==='memory')continue;
      if(item.secret && !draft[item.key])continue;
      if(draft[item.key]!==item.value)payload[item.key]=draft[item.key];
    }
    const result=await api<any>('/api/settings',{method:'PATCH',body:{settings:payload}});
    toast(result.effectiveFrom==='restart'?'已保存；工具注册改动需重启插件':'已保存；下一次维护/运行生效，冻结注入需换新会话','ok');
    setDirty(false);await settings.reload();
  }catch(error){toast((error as Error).message,'bad');}finally{setSaving(false);}};
  return <div className="stack"><Card title="全部运行设置" subtitle="注入预算下次运行生效；工具开关、工具暴露级别及领域数据路径需重启插件。秘密字段留空保留已有值。"><Button disabled={!dirty||saving} onClick={()=>void save()}>保存修改</Button></Card>{Object.keys(settings.data.groups).filter(group=>group!=='memory').map(group=><SettingsGroup key={group} group={group} settings={settings} draft={draft} set={set} />)}</div>;
}
