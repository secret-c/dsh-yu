import ResourceImpact from '../components/ResourceImpact';
import React, { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtDuration, truncate } from '../lib';
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
  Toggle,
  navigate,
  useApi,
  useToast,
} from '../ui';

interface ToolItem {
  name: string;
  description: string;
  modelDescription: string;
  descriptionOverridden: boolean;
  example: string | null;
  parameters: any;
  enabled: boolean;
  readOnly: boolean;
  source: { owner: string; entry: string; editable: boolean };
  usage: Array<{ contextId?: string; taskId?: string; name: string; mode: string }>;
  lastCallAt: number | null;
  lastCallOk: boolean | null;
  callCount: number;
}

export function ToolsPage({ name }: { name: string | null }) {
  const list = useApi<{ items: ToolItem[]; total: number; knowledge: any }>('/api/tools');
  const admin = useApi<{ exposure: string; registered: boolean; ops: Array<{ op: string; summary: string; args: any }>; note: string }>(
    '/api/tools/admin',
  );
  const [active, setActive] = useState<string | null>(name);
  useEffect(() => {
    if (name) setActive(name);
    // Land on the first tool instead of an empty detail pane: the page is a
    // diagnosis surface, and an empty right column reads as a broken page.
    else if (!active && list.data?.items.length) setActive(list.data.items[0].name);
  }, [name, list.data, active]);

  const select = (next: string) => {
    setActive(next);
    navigate(`/tools/${next}`);
  };

  if (list.error) return <ErrorBox error={list.error} onRetry={() => void list.reload()} />;
  if (!list.data) return <Loading label="正在读取工具目录…" />;

  const exposure = admin.data?.exposure ?? 'admin';
  return (
    <>
      <PageHead
        eyebrow="工具"
        title="工具目录与自我修改"
        description="管理模型工具与可装卸工具包。数据库资料在长期记忆库管理。"
      />

      <div className="notice" style={{ fontSize: 12, lineHeight: 1.75 }}>
        可选工具在下方按实例安装、启停和卸载。模型通过 yu_tool_packages 查看当前操作，再通过 yu_tool_call 指定实例调用。DSH 宿主基础工具由宿主管理；Yu 管理入口保持稳定。
      </div>

      <Card
        title="Yu 能改自己什么"
        subtitle={admin.data?.note ?? '读取中…'}
        actions={
          <div className="row" style={{ gap: 6 }}>
            <Badge tone={exposure === 'none' ? 'muted' : 'accent'}>
              {exposure === 'none' ? '模型入口关闭' : '管理入口 + 已加载资源'}
            </Badge>
            <Button variant="ghost" size="small" onClick={() => void admin.reload()}>
              刷新
            </Button>
          </div>
        }
      >
        {admin.data?.ops?.length ? (
          <div className="ops-grid">
            {admin.data.ops.map((entry) => (
              <div className="op-row" key={entry.op}>
                <code className="op-name">{entry.op}</code>
                <span className="op-summary">{entry.summary}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="notice warn">
            当前设置为不注册任何工具。到「设置 · 工具」把 `tools.exposure` 改成 `admin`，Yu 才能通过工具改自己；
            在此之前，所有修改都在这个管理台里完成。
          </div>
        )}
      </Card>

      <p className="notice">数据库资料统一在 <a href="#/memory">长期记忆库</a> 导入、授权与管理。</p>

      <ToolPackages onChanged={() => void list.reload()} />

      <div className="chat-wrap" style={{ marginTop: 16 }}>
        <Card title="目录" subtitle={`${list.data.total} 个工具`} padded={false}>
          <div className="list">
            {list.data.items.map((tool) => (
              <button
                key={tool.name}
                type="button"
                className="conv-item"
                aria-current={tool.name === active}
                onClick={() => select(tool.name)}
                style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }}
              >
                <div className="conv-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {tool.name}
                  {tool.readOnly && <Badge tone="ok">只读</Badge>}
                  {tool.descriptionOverridden && <Badge tone="warn">说明已改</Badge>}
                </div>
                <div className="conv-meta">
                  {tool.source.owner === 'yu' ? 'Yu 自定义' : 'DSH 内置'} · 调用 {tool.callCount} 次
                  {tool.lastCallAt ? ` · 最近 ${fmtDateTime(tool.lastCallAt)}` : ''}
                </div>
              </button>
            ))}
          </div>
        </Card>

        {active ? (
          <ToolDetail name={active} onChanged={() => void list.reload()} />
        ) : (
          <Card>
            <Empty title="选择一个工具" hint="查看参数、示例、授权与最近调用。" />
          </Card>
        )}
      </div>
    </>
  );
}

function ToolPackages({onChanged}:{onChanged:()=>void}) {
  const packages=useApi<any>('/api/tool-packages');
  const [adapter,setAdapter]=useState('tomimi');const [id,setId]=useState('my_tomimi');const [name,setName]=useState('我的 Tomimi 计算器');const [config,setConfig]=useState('{}');
  const [manifestPath,setPath]=useState('');const [args,setArgs]=useState('{}');const [selected,setSelected]=useState('');
  const [result,setResult]=useState<any>(null);const [error,setError]=useState<Error|null>(null);const [busy,setBusy]=useState(false);
  const act=async(method:string,url:string,body?:any)=>{setBusy(true);setError(null);try{const output=await api(url,{method,body});setResult(output);await packages.reload();onChanged();}catch(e){setError(e as Error);}finally{setBusy(false);}};
  return <Card title="可装卸工具包" subtitle="Tomimi 肉鸽面板计算、结构化四则计算、自有文档检索均为可选包；同类型可安装多个独立命名实例。">
    <Field label="工具包类型"><select value={adapter} onChange={e=>setAdapter(e.target.value)}>{(packages.data?.adapters??['tomimi','calculator','documents']).map((a:string)=><option key={a} value={a}>{a}</option>)}</select></Field>
    <Field label="实例 ID（小写字母、数字、下划线）"><input value={id} onChange={e=>setId(e.target.value)} /></Field>
    <Field label="实例名称"><input value={name} onChange={e=>setName(e.target.value)} /></Field>
    <Field label="配置 JSON" help={'Tomimi 可填 {"path":"/本机数据目录"}，留空路径使用本机默认目录；calculator / documents 使用 {}。'}><textarea value={config} rows={2} onChange={e=>setConfig(e.target.value)} /></Field>
    <Button disabled={busy} onClick={()=>{try{void act('POST','/api/tool-packages',{manifest:{id,name,adapter,version:'1',config:JSON.parse(config)}});}catch(e){setError(e as Error);}}}>安装并加载工具包</Button>
    <Field label="或从服务器清单文件安装"><input value={manifestPath} onChange={e=>setPath(e.target.value)} placeholder="/home/yu/tools/example.json" /></Field>
    <Button disabled={busy||!manifestPath.trim()} onClick={()=>void act('POST','/api/tool-packages',{manifestPath})}>从清单路径安装</Button>
    {(error||packages.error)&&<ErrorBox error={error??packages.error!} />}
    {(packages.data?.packages??[]).map((p:any)=><div className="ledger-row" key={p.id}>
      <b>{p.name}</b> <code>{p.id} · {p.adapter}</code> <Badge tone={p.active?'ok':'muted'}>{p.active?'已加载':p.enabled?'加载失败':'已停用'}</Badge>
      {p.diagnostic&&<div className="notice bad">{p.diagnostic}</div>}
      <Code>{JSON.stringify(p.operations,null,2)}</Code><ResourceImpact kind="packages" id={p.id} onChanged={()=>{void packages.reload();onChanged();}}/>
      <Button disabled={busy} onClick={()=>void act('PATCH','/api/tool-packages/'+p.id,{enabled:!p.enabled})}>{p.enabled?'停用并释放':'启用并加载'}</Button>
      <Button disabled={busy} variant="quiet" onClick={()=>void act('DELETE','/api/tool-packages/'+p.id)}>卸载（保留资料）</Button>
    </div>)}
    <Field label="试运行已加载操作" help={'选择带实例 ID 的操作，参数按上方 schema 填写。四则示例：{"operator":"add","a":2,"b":3}'}><select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">选择操作</option>{(packages.data?.packages??[]).flatMap((p:any)=>p.operations.map((o:any)=><option key={o.name} value={JSON.stringify({packageId:p.id,operation:o.name})}>{p.name} / {o.name}</option>))}</select></Field>
    <Field label="调用参数 JSON"><textarea value={args} onChange={e=>setArgs(e.target.value)} rows={3} /></Field>
    <Button disabled={busy||!selected} onClick={()=>{try{void act('POST','/api/tool-packages/call',{...JSON.parse(selected),arguments:JSON.parse(args)});}catch(e){setError(e as Error);}}}>管理员全局试运行</Button>
    {result&&<Code>{JSON.stringify(result,null,2)}</Code>}
    <p className="li-sub">停用和卸载即时移除操作路由，正在运行的 Tomimi 子进程会停止。框架入口保留，旧实例句柄失效。tools.exposure=none 关闭模型入口；管理台仍可管理和验证。清单不会执行外部脚本。</p>
  </Card>;
}

/**
 * Game text carries presentation markup (`<@ba.vup>`, `{atk_scale:0%}`) that a
 * wiki renders, not a console. Strip the tags but keep the placeholder names,
 * so the numbers are visibly "in the raw payload" rather than silently lost.
 */
function readableSkillText(value: unknown): string {
  return String(value ?? '')
    .replace(/<@ba\.[a-z]+>/g, '')
    .replace(/<\$ba\.[a-z]+>/g, '')
    .replace(/<\/>/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\{([^}]+)\}/g, '$1');
}

function ToolDetail({ name, onChanged }: { name: string; onChanged: () => void }) {
  const detail = useApi<any>(`/api/tools/${name}`);
  const toast = useToast();
  const [description, setDescription] = useState('');
  const [example, setExample] = useState('');
  const [behavior, setBehavior] = useState(false);
  const [argsText, setArgsText] = useState('{}');
  const [result, setResult] = useState<any | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!detail.data) return;
    setDescription(detail.data.tool.descriptionOverridden ? detail.data.tool.modelDescription : '');
    setExample(detail.data.tool.example ?? '');
    setBehavior(false);
    const properties = detail.data.tool.parameters?.properties ?? {};
    const required: string[] = detail.data.tool.parameters?.required ?? [];
    const sample: Record<string, any> = {};
    for (const key of required) {
      const type = properties[key]?.type;
      sample[key] = type === 'integer' || type === 'number' ? 1 : type === 'boolean' ? true : '';
    }
    setArgsText(JSON.stringify(sample, null, 2));
    setResult(null);
  }, [detail.data]);

  if (detail.error) return <ErrorBox error={detail.error} onRetry={() => void detail.reload()} />;
  if (!detail.data) return <Loading label="正在读取工具…" />;

  const tool = detail.data.tool;
  const calls = detail.data.calls ?? [];

  const saveOverlay = async () => {
    let config: any = {};
    try {
      config = JSON.parse(JSON.stringify({ behavior }));
    } catch {
      config = {};
    }
    await api(`/api/tools/${name}`, {
      method: 'PATCH',
      body: { description: description || undefined, example, config, enabled: tool.enabled },
    });
    toast(behavior ? '已保存；该说明会作为遮蔽定义对 Yu 的 Agent 生效' : '已保存说明（仅管理台展示）', 'ok');
    await detail.reload();
    onChanged();
  };

  const toggleEnabled = async () => {
    await api(`/api/tools/${name}`, { method: 'PATCH', body: { enabled: !tool.enabled } });
    await detail.reload();
    onChanged();
  };

  const tryRun = async () => {
    setRunning(true);
    setResult(null);
    try {
      const args = JSON.parse(argsText || '{}');
      const output = await api<any>(`/api/tools/${name}/try`, { method: 'POST', body: { arguments: args } });
      setResult(output);
      toast(output.ok ? `成功，用时 ${output.durationMs}ms` : '工具返回错误，详见结果', output.ok ? 'ok' : 'warn');
      onChanged();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card
      title={
        <span className="row" style={{ gap: 8 }}>
          {tool.name}
          {tool.readOnly ? <Badge tone="ok">只读</Badge> : <Badge tone="warn">有副作用</Badge>}
          {!tool.enabled && <Badge tone="muted">已在目录停用</Badge>}
        </span>
      }
      subtitle={tool.description}
      actions={<Toggle checked={tool.enabled} label="启用" onChange={() => void toggleEnabled()} />}
    >
      <div className="stack">
        <KV
          items={[
            { label: '实现来源', value: <code>{tool.source.entry}</code> },
            { label: '归属', value: tool.source.owner === 'yu' ? 'Yu 自定义工具' : 'DeepSeek Harness 内置' },
            {
              label: '使用该工具的上下文',
              value:
                tool.usage.length === 0 ? (
                  '没有方案显式限制，默认可用'
                ) : (
                  <div className="stack tight">
                    {tool.usage.map((usage: any, index: number) => (
                      <span key={index}>
                        {usage.taskId ? '任务 ' : '方案 '}
                        {usage.name} · {usage.mode}
                      </span>
                    ))}
                  </div>
                ),
            },
            { label: '调用统计', value: `${tool.callCount} 次` },
          ]}
        />

        <div className="caption" style={{ padding: 0 }}>
          说明修改（只影响管理台展示）
        </div>
        <Field label="模型说明替代文本" help="留空表示使用原始说明。勾选“对模型生效”会把替代说明作为该 Agent 的遮蔽定义注册。">
          <textarea value={description} rows={3} onChange={(event) => setDescription(event.target.value)} placeholder={tool.description} />
        </Field>
        <Field label="真实示例" help="建议写一条你实际验证过的调用，帮助定位“调用不熟练”的问题。">
          <textarea value={example} rows={3} onChange={(event) => setExample(event.target.value)} />
        </Field>
        <div className="row">
          <Toggle checked={behavior} label="对模型生效（行为修改）" onChange={setBehavior} />
          <span className="li-sub">行为修改需要为 Yu 的 Agent 注册遮蔽定义，属于真实变更。</span>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={() => void saveOverlay()}>保存说明</Button>
        </div>

        <div className="caption" style={{ padding: 0 }}>
          参数 schema
        </div>
        <Code>{JSON.stringify(tool.parameters, null, 2)}</Code>

        <div className="caption" style={{ padding: 0 }}>
          只读试运行
        </div>
        {tool.readOnly ? (
          <>
            <Field label="参数（JSON）">
              <textarea className="editor" value={argsText} rows={6} onChange={(event) => setArgsText(event.target.value)} />
            </Field>
            <div className="row">
              <Button onClick={() => void tryRun()} disabled={running}>
                {running ? '运行中…' : '运行一次'}
              </Button>
              <span className="li-sub">试运行会经过与模型调用相同的工具管线，并记录到调用日志。</span>
            </div>
            {result && (
              <div className="stack">
                <div className="row">
                  <Badge tone={result.ok ? 'ok' : 'bad'}>{result.ok ? '成功' : '失败'}</Badge>
                  <span className="li-sub">
                    用时 {result.durationMs}ms · {fmtDateTime(result.observedAt)}
                  </span>
                </div>
                <Code>{JSON.stringify(result.ok ? result.value : result.error, null, 2)}</Code>
              </div>
            )}
          </>
        ) : (
          <div className="notice warn">
            该工具可能产生副作用，管理台不提供一键试运行。请在任务中授权后由模型调用，或使用受限上下文验证。
          </div>
        )}

        <div className="caption" style={{ padding: 0 }}>
          最近调用
        </div>
        {calls.length === 0 ? (
          <Empty title="还没有调用记录" hint="运行一次相关任务或试运行后即可看到参数与结果。" />
        ) : (
          <div className="list">
            {calls.map((call: any) => (
              <div className="list-item" key={call.id}>
                <Badge tone={call.ok ? 'ok' : 'bad'}>{call.ok ? '成功' : '错误'}</Badge>
                <div className="li-main">
                  <div className="li-title">
                    <code>{truncate(JSON.stringify(call.arguments), 120)}</code>
                  </div>
                  <div className="li-sub">
                    {fmtDateTime(call.at)} · {call.durationMs}ms
                    {call.error ? ` · ${call.error}` : ''}
                  </div>
                  {call.result !== null && (
                    <details>
                      <summary className="li-sub" style={{ cursor: 'pointer' }}>
                        查看结果
                      </summary>
                      <Code>{truncate(JSON.stringify(call.result, null, 2), 3000)}</Code>
                    </details>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
