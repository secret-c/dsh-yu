import { MemoryLibrarySelection } from '../components/MemoryLibraries';
import ResourceImpact from '../components/ResourceImpact';
import ResourceSelection from '../components/ResourceSelection';
import React, { useEffect, useState } from 'react';
import InjectionSelection from '../components/InjectionSelection';
import { api, fmtDateTime, truncate } from '../lib';
import { DirField } from '../components/DirPicker';
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
  PageHead,
  Tabs,
  Toggle,
  navigate,
  useApi,
  useToast,
} from '../ui';

/**
 * The effort ids adapters accept today: the deepseek adapter knows off/low/high/max
 * (anything else falls back to high), other adapters use the usual ladder. A
 * datalist rather than a closed select, because a provider may know an id this
 * list does not and typing it must still work.
 */
const REASONING_EFFORTS = [
  { value: 'off', label: 'off · 不思考' },
  { value: 'minimal', label: 'minimal · 最少' },
  { value: 'low', label: 'low · 低' },
  { value: 'medium', label: 'medium · 中' },
  { value: 'high', label: 'high · 高' },
  { value: 'max', label: 'max · 最高' },
];

interface ContextSummary {
  id: string;
  name: string;
  description: string;
  currentVersion: number;
  updatedAt: number;
  usage: number;
  config: any;
}

export function Contexts({ id }: { id: string | null }) {
  const list = useApi<{ contexts: ContextSummary[] }>('/api/contexts');
  const links = useApi<{links:Array<{id:string;contextId?:string|null}>}>('/api/dsh/links');
  const [activeId, setActiveId] = useState<string | null>(id);

  useEffect(() => {
    if (id) setActiveId(id);
    else if (!activeId && list.data?.contexts.length) setActiveId(list.data.contexts[0].id);
  }, [id, list.data]);

  const select = (nextId: string) => {
    setActiveId(nextId);
    navigate(`/contexts/${nextId}`);
  };

  const create = async () => {
    const result = await api<{ context: { id: string } }>('/api/contexts', {
      method: 'POST',
      body: { name: '新上下文方案', description: '' },
    });
    await list.reload();
    select(result.context.id);
  };

  return (
    <>
      <PageHead
        eyebrow="上下文"
        title="上下文方案"
        description="配置、预览与实际执行是三件不同的事：保存只影响下次运行，运行时会固定一份快照。"
        actions={<Button onClick={() => void create()}>新建方案</Button>}
      />

      {list.error && <ErrorBox error={list.error} onRetry={() => void list.reload()} />}

      <div className="chat-wrap">
        <Card title="方案" subtitle={`${list.data?.contexts.length ?? 0} 个`}>
          {list.loading && !list.data ? (
            <Loading />
          ) : (
            <div className="conv-list">
              {list.data?.contexts.map((context) => (
                <button
                  key={context.id}
                  type="button"
                  className="conv-item"
                  aria-current={context.id === activeId}
                  onClick={() => select(context.id)}
                >
                  <div className="conv-title">{context.name}</div>
                  <div className="conv-meta">
                    v{context.currentVersion} · {context.usage} 个任务在用 · {links.data?.links.filter(l=>l.contextId===context.id).length ?? 0} 个关联会话在用
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        {activeId ? (
          <ContextEditor key={activeId} id={activeId} onDeleted={() => { setActiveId(null); void list.reload(); navigate('/contexts'); }} />
        ) : (
          <Card>
            <Empty title="选择一个方案" hint="或新建一个。" />
          </Card>
        )}
      </div>
    </>
  );
}

function ContextEditor({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const detail = useApi<any>(`/api/contexts/${id}`);
  const options = useApi<any>('/api/contexts/options');
  const toast = useToast();
  const [tab, setTab] = useState<'form' | 'advanced' | 'versions' | 'preview'>('form');
  const [config, setConfig] = useState<any>(null);
  const [meta, setMeta] = useState({ name: '', description: '' });
  const [dirty, setDirty] = useState(false);
  const [advanced, setAdvanced] = useState('');
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [previewInput, setPreviewInput] = useState('（示例）今天想做点什么？');
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (!detail.data?.context) return;
    setConfig(detail.data.context.config);
    setMeta({ name: detail.data.context.name, description: detail.data.context.description });
    setAdvanced(JSON.stringify(detail.data.context.config, null, 2));
    setDirty(false);
    setAdvancedError(null);
  }, [detail.data]);

  if (detail.error) return <ErrorBox error={detail.error} onRetry={() => void detail.reload()} />;
  if (!detail.data || !config) return <Loading label="正在读取方案…" />;

  const context = detail.data.context;
  const update = (patch: any) => {
    setConfig({ ...config, ...patch });
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await api<any>(`/api/contexts/${id}`, {
        method: 'PATCH',
        body: {
          name: meta.name,
          description: meta.description,
          config,
          expectedVersion: context.currentVersion,
          note: '编辑于管理台',
        },
      });
      toast(`已保存为 v${result.context.currentVersion}，下次运行生效`, 'ok');
      setDirty(false);
      await detail.reload();
    } catch (error: any) {
      if (error.code === 'VERSION_CONFLICT') {
        toast('有人先改了这份方案。刷新后可基于新版本重做修改。', 'warn');
      } else {
        toast(error.message, 'bad');
      }
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const result = await api<any>(`/api/contexts/${id}/preview`, { method: 'POST', body: { input: previewInput } });
      setPreview(result);
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setPreviewing(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`删除方案「${context.name}」？正在使用的方案不能删除。`)) return;
    try {
      await api(`/api/contexts/${id}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      onDeleted();
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  const duplicate = async () => {
    const result = await api<{ context: { id: string } }>(`/api/contexts/${id}/duplicate`, { method: 'POST', body: {} });
    toast('已复制', 'ok');
    navigate(`/contexts/${result.context.id}`);
  };

  const models = options.data?.models?.providers ?? [];
  const tools = options.data?.tools ?? [];
  const presets = options.data?.presets ?? [];

  return (
    <Card
      title={
        <span className="row" style={{ gap: 8 }}>
          {context.name}
          <Badge tone="accent">v{context.currentVersion}</Badge>
          {dirty && <Badge tone="warn">未保存</Badge>}
        </span>
      }
      subtitle={`更新于 ${fmtDateTime(context.updatedAt)} · 被 ${context.usage} 个任务使用`}
      actions={
        <>
          <Button variant="quiet" size="small" onClick={() => void duplicate()}>
            复制
          </Button>
          <Button variant="quiet" size="small" onClick={() => void remove()}>
            删除
          </Button>
          <Button onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? '保存中…' : '保存为新版本'}
          </Button>
        </>
      }
    >
      <ResourceImpact kind="context" id={id} onChanged={()=>{void detail.reload();onDeleted();}}/>
      <Tabs
        tabs={[
          { id: 'form', label: '表单' },
          { id: 'advanced', label: '高级文本' },
          { id: 'versions', label: `版本（${context.versions?.length ?? 0}）` },
          { id: 'preview', label: '预览' },
        ]}
        active={tab}
        onChange={(id) => setTab(id as typeof tab)}
      />

      {tab === 'form' && (
        <div className="stack">
          <div className="grid two">
            <Field label="名称">
              <input value={meta.name} onChange={(event) => { setMeta({ ...meta, name: event.target.value }); setDirty(true); }} />
            </Field>
            <Field label="说明">
              <input
                value={meta.description}
                onChange={(event) => { setMeta({ ...meta, description: event.target.value }); setDirty(true); }}
              />
            </Field>
          </div>

          <div className="caption" style={{ padding: 0 }}>模型与工作目录</div>
          <div className="grid three">
            <Field label="服务商" help="留空表示沿用 DSH 默认（推荐）。">
              <select value={config.provider ?? ''} onChange={(event) => update({ provider: event.target.value })}>
                <option value="">（沿用默认）</option>
                {models.map((provider: any) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="模型">
              <select value={config.model ?? ''} onChange={(event) => update({ model: event.target.value })}>
                <option value="">（沿用默认）</option>
                {(models.find((p: any) => p.id === (config.provider || options.data?.models?.defaultSelection?.provider))?.models ?? []).map(
                  (model: any) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ),
                )}
              </select>
            </Field>
            <Field label="思考强度" help="下拉里选一个，也可以直接输入；留空用适配器默认。">
              <input
                list="yu-reasoning-effort"
                value={config.reasoningEffort ?? ''}
                onChange={(event) => update({ reasoningEffort: event.target.value })}
                placeholder="留空为适配器默认"
              />
              <datalist id="yu-reasoning-effort">
                {REASONING_EFFORTS.map((effort) => (
                  <option key={effort.value} value={effort.value}>
                    {effort.label}
                  </option>
                ))}
              </datalist>
            </Field>
          </div>
          <div className="grid two">
            <DirField
              value={config.cwd ?? ''}
              onChange={(next) => update({ cwd: next })}
              label="工作目录（cwd）"
              help="模型的相对路径基准。点「选择文件夹」浏览 Yu 所在机器的目录；留空使用 Yu 数据目录。"
            />
            <Field label="Agent 预设" help="预设会改变可用工具与提示词，切换后从新物理会话生效。">
              <select value={config.agentPreset ?? ''} onChange={(event) => update({ agentPreset: event.target.value })}>
                <option value="">（默认）</option>
                {presets.map((preset: any) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="caption" style={{ padding: 0 }}>注入内容与顺序</div>
          <ResourceSelection value={config.tools} onChange={tools=>update({tools})}/>
          <InjectionSelection label="注入" value={config.injection} onChange={injection=>update({injection})}/>
          <Field label="固定上下文说明" help="每次调用都会附加，与任务目标无关。">
            <textarea value={config.fixedInstructions ?? ''} rows={3} onChange={(event) => update({ fixedInstructions: event.target.value })} />
          </Field>

          {(config.style?.custom || config.style?.mode === 'custom') && <Field label="旧版附加风格说明" help={config.style?.mode === 'custom' ? '保留的旧版正文，每次使用本方案附带。新说明可统一写在固定上下文说明中。' : '保留的旧版正文，目前未启用。可复制到固定上下文说明。'}>
            <textarea value={config.style?.custom ?? ''} rows={3} onChange={(event) => update({ style: { ...config.style, custom: event.target.value } })} />
          </Field>}

          <Field label="提示词文件" help="按顺序读取；文件缺失时按每行的缺失策略处理。">
            <div className="stack tight">
              {(config.promptFiles ?? []).map((file: any, index: number) => (
                <div className="row" key={index} style={{ gap: 6, alignItems: 'flex-end' }}>
                  <input
                    value={file.path}
                    onChange={(event) => {
                      const next = [...config.promptFiles];
                      next[index] = { ...file, path: event.target.value };
                      update({ promptFiles: next });
                    }}
                    placeholder="C:\path\to\notes.md"
                    style={{ flex: 3 }}
                  />
                  <input
                    value={file.purpose ?? ''}
                    onChange={(event) => {
                      const next = [...config.promptFiles];
                      next[index] = { ...file, purpose: event.target.value };
                      update({ promptFiles: next });
                    }}
                    placeholder="用途"
                    style={{ flex: 2 }}
                  />
                  <select
                    value={file.range ?? 'full'}
                    onChange={(event) => {
                      const next = [...config.promptFiles];
                      next[index] = { ...file, range: event.target.value };
                      update({ promptFiles: next });
                    }}
                    style={{ flex: 1, minWidth: 92 }}
                  >
                    <option value="full">全文</option>
                    <option value="head">前 N 行</option>
                    <option value="tail">后 N 行</option>
                  </select>
                  <input
                    type="number"
                    value={file.lines ?? 0}
                    min={0}
                    onChange={(event) => {
                      const next = [...config.promptFiles];
                      next[index] = { ...file, lines: Number(event.target.value) };
                      update({ promptFiles: next });
                    }}
                    style={{ width: 76 }}
                  />
                  <select
                    value={file.missing ?? 'error'}
                    onChange={(event) => {
                      const next = [...config.promptFiles];
                      next[index] = { ...file, missing: event.target.value };
                      update({ promptFiles: next });
                    }}
                    style={{ flex: 1, minWidth: 96 }}
                  >
                    <option value="error">缺失即失败</option>
                    <option value="skip">缺失跳过</option>
                  </select>
                  <Button
                    variant="quiet"
                    size="small"
                    onClick={() => update({ promptFiles: config.promptFiles.filter((_: any, i: number) => i !== index) })}
                  >
                    移除
                  </Button>
                </div>
              ))}
              <Button
                variant="ghost"
                size="small"
                onClick={() =>
                  update({
                    promptFiles: [
                      ...(config.promptFiles ?? []),
                      { path: '', purpose: '', order: ((config.promptFiles?.length ?? 0) + 1) * 10, refresh: 'run', range: 'full', lines: 0, missing: 'error' },
                    ],
                  })
                }
              >
                添加文件
              </Button>
            </div>
          </Field>

          <div className="caption" style={{ padding: 0 }}>工具、检索与预算</div>
          <Field label="工具范围">
            <select
              value={config.tools?.mode ?? 'all'}
              onChange={(event) => update({ tools: { ...config.tools, mode: event.target.value } })}
            >
              <option value="all">全部可用</option>
              <option value="allow">只允许列出的工具</option>
            </select>
          </Field>
          {(config.tools?.mode ?? 'all') === 'allow' && (
            <Field label="允许的工具（多选）">
              <div className="row" style={{ gap: 8, maxHeight: 180, overflow: 'auto' }}>
                {tools.map((tool: any) => (
                  <label key={tool.name} className="toggle" title={tool.description}>
                    <input
                      type="checkbox"
                      checked={(config.tools?.allow ?? []).includes(tool.name)}
                      onChange={(event) => {
                        const current = new Set(config.tools?.allow ?? []);
                        if (event.target.checked) current.add(tool.name);
                        else current.delete(tool.name);
                        update({ tools: { ...config.tools, mode: 'allow', allow: [...current] } });
                      }}
                    />
                    <span className="toggle-track" />
                    <span>{tool.name}</span>
                  </label>
                ))}
              </div>
            </Field>
          )}

          <div className="grid three">
            <Field label="数据库检索">
              <Toggle
                checked={config.databaseSearch?.enabled !== false}
                label="检索 Yu 归档"
                onChange={(next) => update({ databaseSearch: { ...config.databaseSearch, enabled: next } })}
              />
            </Field>
            <Field label="检索范围">
              <select
                value={config.databaseSearch?.scope ?? 'project'}
                onChange={(event) => update({ databaseSearch: { ...config.databaseSearch, scope: event.target.value } })}
              >
                <option value="project">仅本项目归档</option>
                <option value="all">全部归档</option>
              </select>
            </Field>
            <Field label="最多条数">
              <input
                type="number"
                min={0}
                max={50}
                value={config.databaseSearch?.maxItems ?? 6}
                onChange={(event) => update({ databaseSearch: { ...config.databaseSearch, maxItems: Number(event.target.value) } })}
              />
            </Field>
          </div>

          <MemoryLibrarySelection value={config.databaseSearch?.libraryIds} onChange={libraryIds => update({ databaseSearch: { ...config.databaseSearch, libraryIds } })} />

          <div className="caption" style={{ padding: 0 }}>对话历史</div>
          <div className="li-sub">对话历史由会话自身管理。</div>
          <div className="grid two">
            <Field label="上下文预算（token，0 为不限）">
              <input
                type="number"
                min={0}
                value={config.history?.contextBudget ?? 0}
                onChange={(event) => update({ history: { ...config.history, contextBudget: Number(event.target.value) } })}
              />
            </Field>
          </div>
          <Field label="超限处理">
            <select
              value={config.history?.overLimit ?? 'compact'}
              onChange={(event) => update({ history: { ...config.history, overLimit: event.target.value } })}
            >
              <option value="compact">压缩后继续</option>
              <option value="trim">裁剪后继续</option>
              <option value="fail">拒绝执行</option>
            </select>
          </Field>
          <Field label="触发输入模板">
            <textarea
              value={config.inputTemplate ?? '{{input}}'}
              rows={2}
              onChange={(event) => update({ inputTemplate: event.target.value })}
            />
          </Field>
        </div>
      )}

      {tab === 'advanced' && (
        <div className="stack">
          <div className="notice">
            高级文本与表单是同一份数据：保存时以文本为准。字段未知或类型错误会在保存时被拒绝。
          </div>
          <textarea
            className="editor"
            value={advanced}
            onChange={(event) => {
              setAdvanced(event.target.value);
              setDirty(true);
              try {
                const parsed = JSON.parse(event.target.value);
                setConfig(parsed);
                setAdvancedError(null);
              } catch (error) {
                setAdvancedError((error as Error).message);
              }
            }}
            rows={22}
          />
          {advancedError && <ErrorBox error={new Error(`JSON 解析失败：${advancedError}`)} />}
        </div>
      )}

      {tab === 'versions' && (
        <div className="list">
          {(context.versions ?? []).map((version: any) => (
            <div className="list-item" key={version.id}>
              <Badge tone={version.version === context.currentVersion ? 'accent' : 'muted'}>v{version.version}</Badge>
              <div className="li-main">
                <div className="li-title">{version.note || '（无备注）'}</div>
                <div className="li-sub">{fmtDateTime(version.createdAt)}</div>
              </div>
              <Button
                variant="quiet"
                size="small"
                onClick={() => {
                  setConfig(version.config);
                  setAdvanced(JSON.stringify(version.config, null, 2));
                  setDirty(true);
                  setTab('form');
                  toast(`已载入 v${version.version} 的内容，保存后会生成新版本`, 'info');
                }}
              >
                以此为基础编辑
              </Button>
            </div>
          ))}
        </div>
      )}

      {tab === 'preview' && (
        <div className="stack">
          <Field label="示例输入" help="预览使用当前保存的配置与你提供的示例输入，不会调用模型。">
            <textarea value={previewInput} rows={2} onChange={(event) => setPreviewInput(event.target.value)} />
          </Field>
          <div className="row">
            <Button onClick={() => void runPreview()} disabled={previewing}>
              {previewing ? '生成中…' : '生成预览'}
            </Button>
            <span className="li-sub">注意：先保存修改，预览才会反映最新配置。</span>
          </div>
          {preview && (
            <>
              <div className="grid three">
                <Card>
                  <KV
                    items={[
                      { label: '估算 token', value: preview.compiled.budget.totalTokens },
                      { label: '系统段', value: preview.compiled.budget.systemTokens },
                      { label: '输入段', value: preview.compiled.budget.inputTokens },
                    ]}
                  />
                </Card>
                <Card>
                  <KV
                    items={[
                      { label: '服务商', value: preview.compiled.route.provider ?? '未解析' },
                      { label: '模型', value: preview.compiled.route.model ?? '未解析' },
                      { label: 'effort', value: preview.compiled.route.reasoningEffort ?? '默认' },
                    ]}
                  />
                </Card>
                <Card>
                  <KV
                    items={[
                      { label: '记忆', value: preview.compiled.memory.source },
                      { label: '检索命中', value: preview.compiled.retrieved.length },
                      { label: '段落数', value: preview.compiled.sections.length },
                    ]}
                  />
                </Card>
              </div>
              {preview.compiled.problems.length > 0 && (
                <div className="notice bad">
                  <strong>阻塞问题</strong>
                  <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                    {preview.compiled.problems.map((problem: any, index: number) => (
                      <li key={index}>
                        {problem.code}: {problem.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.compiled.warnings.length > 0 && (
                <div className="notice warn">
                  <strong>提示</strong>
                  <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                    {preview.compiled.warnings.map((warning: any, index: number) => (
                      <li key={index}>
                        {warning.code}: {warning.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <Card title="Yu 注入的块" subtitle="按投递方式分开：系统提示词进 prompt，其余跟着用户消息走">
                <div className="list">
                  {preview.compiled.sections.map((section: any, index: number) => (
                    <details key={index} className="list-item" style={{ display: 'block' }}>
                      <summary style={{ cursor: 'pointer' }}>
                        <span style={{ fontWeight: 600 }}>{section.name}</span>{' '}
                        <Badge tone={section.channel === 'history' ? 'ok' : 'accent'}>
                          {section.channel === 'history' ? '用户消息' : '系统提示词'}
                        </Badge>{' '}
                        <Badge tone={section.scope === 'turn' ? 'accent' : 'muted'}>
                          {section.scope === 'turn' ? '每轮' : '会话一次'}
                        </Badge>{' '}
                        <span className="tag">order {section.order}</span> <span className="tag">≈{section.tokens} token</span>
                      </summary>
                      <Code>{section.text}</Code>
                    </details>
                  ))}
                </div>
              </Card>
              {preview.compiled.history?.session ? (
                <Card title="会话材料" subtitle="拼在会话第一条用户消息前，只发一次">
                  <Code>{preview.compiled.history.session}</Code>
                </Card>
              ) : null}
              {preview.compiled.history?.turn ? (
                <Card title="每轮材料" subtitle="拼在每条用户消息前">
                  <Code>{preview.compiled.history.turn}</Code>
                </Card>
              ) : null}
              <Card title="DSH 基础提示词（只读）" subtitle="由 harness 在运行时追加，Yu 无法修改">
                <div className="list">
                  {(preview.harnessSections ?? []).map((section: any, index: number) => (
                    <div className="list-item" key={index}>
                      <div className="li-main">
                        <div className="li-title">{section.name}</div>
                        <div className="li-sub">{truncate(section.preview, 220)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
              <Card title="说明">
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {preview.notes.map((note: string, index: number) => (
                    <li key={index} className="li-sub">
                      {note}
                    </li>
                  ))}
                </ul>
              </Card>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
