import PeerSelector from '../components/PeerSelector';
import TriggerRuleForm, {triggerRuleError} from '../components/TriggerRuleForm';
import DshTarget from '../components/DshTarget';
import TaskConversation from '../components/TaskConversation';
import ResourceSelection from '../components/ResourceSelection';
import React, { useEffect, useMemo, useState } from 'react';
import InjectionSelection from '../components/InjectionSelection';
import {
  api,
  basePath,
  fmtDateTime,
  fmtDuration,
  fmtRelative,
  labelOfStatus,
  toneOfStatus,
  truncate,
  TASK_KIND,
} from '../lib';
import {
  Badge,
  Button,
  Card,
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

export function TaskDetail({ id, initialTab }: { id: string; initialTab?: 'runs' | 'reading' | 'trigger' }) {
  const detail = useApi<any>(`/api/tasks/${id}`);
  const contexts = useApi<{ contexts: Array<{ id: string; name: string }> }>('/api/contexts');
  const toast = useToast();
  const [draft, setDraft] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [bindingPending, setBindingPending] = useState(false);
  const peers=useApi<{peers:any[]}>('/api/channels/peers');

  useEffect(() => {
    if (detail.data?.task) { setDraft(detail.data.task); setBindingPending(false); }
  }, [detail.data]);

  // The trigger list links to `/tasks/<id>/trigger`. This page has no tabs — it
  // shows everything — so the useful behaviour for a deep link is to bring the
  // matching card into view once the data is there.
  useEffect(() => {
    if (!initialTab || !detail.data) return;
    const targetId = initialTab === 'trigger' ? 'task-triggers' : initialTab === 'reading' ? 'task-reading' : null;
    if (!targetId) return;
    const timer = window.setTimeout(() => {
      document.getElementById(targetId)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [initialTab, id, detail.data]);

  if (detail.error) return <ErrorBox error={detail.error} onRetry={() => void detail.reload()} />;
  if (!detail.data || !draft) return <Loading label="正在读取任务…" />;

  const task = detail.data.task;
  const runs: any[] = detail.data.runs ?? [];
  const reading = detail.data.reading;

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/tasks/${id}`, {
        method: 'PATCH',
        body: {
          executionTarget: draft.executionTarget ?? {mode:'yu'},
          deliveryTarget: draft.deliveryTarget ?? {mode:'conversation'},
          name: draft.name,
          description: draft.description,
          kind: draft.kind,
          contextId: draft.contextId,
          goal: draft.goal,
          inputTemplate: draft.inputTemplate,
          projectId: draft.projectId,
          archivePolicy: { ...draft.archivePolicy, conversation: undefined },
          toolPolicy: draft.toolPolicy,
          injection: draft.injection,
          ...(draft.kind === 'maintenance' ? { memoryPolicy: { shortTermSlug:draft.memoryPolicy?.shortTermSlug??'', longTermEnabled: draft.memoryPolicy?.longTermEnabled ?? true, longTermInstructions: draft.memoryPolicy?.longTermInstructions ?? '', longTermMaxItems: draft.memoryPolicy?.longTermMaxItems ?? 8 } } : {}),
        },
      });
      toast('已保存，下次运行生效', 'ok');
      await detail.reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const result = await api<any>(`/api/tasks/${id}/run`, { method: 'POST', body: {} });
      if (result.skipped) toast(result.reason, 'warn');
      else toast('已开始运行', 'ok');
      setTimeout(() => void detail.reload(), 1200);
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const stopRun = async (runId: string) => {
    try {
      const result = await api<any>(`/api/runs/${runId}/stop`, { method: 'POST', body: {} });
      toast(result.status === 'stopping' ? '停止中：正在取消当前请求' : '已停止（未产生副作用）', 'warn');
      setTimeout(() => void detail.reload(), 800);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  return (
    <>
      <PageHead
        eyebrow={`任务 · ${TASK_KIND[task.kind] ?? task.kind}`}
        title={task.name}
        description={task.description || '（无描述）'}
        actions={
          <div className="row">
            <Toggle
              checked={task.enabled}
              label={task.enabled ? '已启用' : '已停用'}
              onChange={async (next) => {
                await api(`/api/tasks/${id}/enable`, { method: 'POST', body: { enabled: next } });
                await detail.reload();
              }}
            />
            <Button variant="ghost" onClick={() => void runNow()} disabled={busy}>
              立即运行
            </Button>
            <Button variant="quiet" onClick={() => navigate('/tasks')}>
              返回列表
            </Button>
          </div>
        }
      />

      <div className="grid two">
        <Card title="基本信息" subtitle="保存后下次运行生效；正在运行的那次保持原配置。">
          <div className="stack">
            <Field label="名称">
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label="描述">
              <input
                value={draft.description ?? ''}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </Field>
            <Field label="定时与手动运行的输出目标" help="消息触发仍只回复消息来源；选择输出目标不会扩大消息授权。"><select value={draft.deliveryTarget?.mode==='onebot' ? [draft.deliveryTarget.channelId,draft.deliveryTarget.peerKind,draft.deliveryTarget.peerId].join('|') : ''} onChange={e=>{const peer=peers.data?.peers.find(p=>[p.channelId,p.peerKind,p.peerId].join('|')===e.target.value);setDraft({...draft,deliveryTarget:peer?{mode:'onebot',channelId:peer.channelId,peerKind:peer.peerKind,peerId:peer.peerId}:{mode:'conversation'}});}}><option value="">仅任务会话</option>{peers.data?.peers.map(p=><option key={[p.channelId,p.peerKind,p.peerId].join('|')} value={[p.channelId,p.peerKind,p.peerId].join('|')}>{p.peerKind==='group'?'群聊':'私聊'} · {p.peerLabel||p.peerId} ({p.channelId})</option>)}</select></Field><DshTarget value={draft.executionTarget ?? {mode:'yu'}} onChange={executionTarget=>setDraft({...draft,executionTarget})}/>
            <div className="grid two">
              <Field label="类型">
                <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
                  {['chat', 'reading', 'journal', 'activity', 'maintenance', 'alert', 'custom'].map((kind) => (
                    <option key={kind} value={kind}>
                      {TASK_KIND[kind]}
                    </option>
                  ))}
                </select>
              </Field>
              {draft.executionTarget?.mode !== 'dsh-session' && <Field label="上下文方案">
                <select
                  value={draft.contextId ?? ''}
                  onChange={(event) => setDraft({ ...draft, contextId: event.target.value || null })}
                >
                  <option value="">（默认）</option>
                  {(contexts.data?.contexts ?? []).map((context) => (
                    <option key={context.id} value={context.id}>
                      {context.name}
                    </option>
                  ))}
                </select>
              </Field>}
            </div>
            <Field label="做什么（目标）" help="写进上下文的固定任务说明。">
              <textarea
                value={draft.goal ?? ''}
                rows={4}
                onChange={(event) => setDraft({ ...draft, goal: event.target.value })}
              />
            </Field>
            {draft.kind === 'maintenance' && <>
              <div className="notice">新会话输出短期正文；手动或定时开启长期整理且有资料时，再调用一次模型筛选原文引用。整理要求全部在上方任务目标中编辑；长期引用保留来源编号。</div>
              <Field label="短期输出文件" help="只更新选中的文件，其他记忆保留。"><select value={draft.memoryPolicy?.shortTermSlug??''} onChange={event=>setDraft({...draft,memoryPolicy:{...draft.memoryPolicy,shortTermSlug:event.target.value}})}><option value="">{detail.data.memoryDefaultOutputSlug?'默认：'+(detail.data.memoryOutputs??[]).find((b:any)=>b.slug===detail.data.memoryDefaultOutputSlug)?.path:'请选择输出文件'}</option>{(detail.data.memoryOutputs??[]).map((b:any)=><option key={b.slug} value={b.slug}>{b.name} · {b.path}</option>)}</select></Field>
              <Toggle label="启用长期记忆整理" checked={draft.memoryPolicy?.longTermEnabled ?? true} onChange={value => setDraft({ ...draft, memoryPolicy: { ...(draft.memoryPolicy ?? {}), longTermEnabled: value } })} />
              <Field label="每次最多长期记忆条数" help="本次材料中筛选的条目上限；无可靠事实可为 0。其余已审阅材料不会作为待办重复提取。关闭长期整理会保留未处理来源，重新启用再处理。"><input type="number" min={1} max={12} value={draft.memoryPolicy?.longTermMaxItems ?? 8} onChange={event => setDraft({ ...draft, memoryPolicy: { ...(draft.memoryPolicy ?? {}), longTermMaxItems: Number(event.target.value) } })} /></Field>
            </>}
            <Field label="触发输入模板">
              <textarea
                value={draft.inputTemplate ?? ''}
                rows={2}
                onChange={(event) => setDraft({ ...draft, inputTemplate: event.target.value })}
              />
            </Field>
            <div className="grid two">
              <Field label="归档策略">
                <select
                  value={draft.archivePolicy?.mode ?? 'on-complete'}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      archivePolicy: { ...(draft.archivePolicy ?? {}), mode: event.target.value },
                    })
                  }
                >
                  <option value="off">不归档</option>
                  <option value="on-complete">完成后归档</option>
                  <option value="always">总是归档</option>
                </select>
              </Field>
              <Field label="最小归档长度（字）">
                <input
                  type="number"
                  min={0}
                  value={draft.archivePolicy?.minChars ?? 40}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      archivePolicy: { ...(draft.archivePolicy ?? {}), minChars: Number(event.target.value) },
                    })
                  }
                />
              </Field>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button onClick={() => void save()} disabled={busy || (draft.executionTarget?.mode!=='dsh-session' && bindingPending)}>
                {busy ? '保存中…' : '保存修改'}
              </Button>
            </div>
          </div>
        </Card>

        <div className="stack">
          {draft.executionTarget?.mode !== 'dsh-session' && <TaskConversation key={task.id} task={task} onPending={setBindingPending} />}
          <div id="task-triggers">
          <Card title="触发绑定" subtitle="移除触发不会删除历史。">
            <TriggerEditor taskId={id} taskEnabled={task.enabled} triggers={detail.data.triggerDescriptions ?? []} onChange={() => void detail.reload()} />
          </Card>
          </div>
        </div>
      </div>

      {(detail.data.triggerDescriptions ?? []).some((trigger: any) => trigger.type === 'group-watch') && (
        <GroupBufferPanel
          peerId={
            (detail.data.triggerDescriptions ?? []).find((trigger: any) => trigger.type === 'group-watch')?.spec?.peerId ?? ''
          }
        />
      )}

      {task.kind === 'reading' && (
        <div id="task-reading">
          <Card title="阅读项目" subtitle="章节进度是权威来源；记忆里只存摘要。">
            <ReadingPanel taskId={id} projectId={task.projectId} reading={reading} onChanged={() => void detail.reload()} />
          </Card>
        </div>
      )}

      {draft.executionTarget?.mode !== 'dsh-session' && <><Card title="工具与数据源授权"><ResourceSelection value={draft.toolPolicy} onChange={toolPolicy=>setDraft({...draft,toolPolicy})} inherited={detail.data?.context?.config?.tools}/><Button onClick={()=>void save()} disabled={busy || (draft.executionTarget?.mode!=='dsh-session' && bindingPending)}>保存资源授权</Button></Card>
      <Card title="任务的注入选择"><InjectionSelection parentContext value={draft.injection} onChange={injection=>setDraft({...draft,injection})} label="覆盖上下文的注入资源"/><Button onClick={()=>void save()} disabled={busy || (draft.executionTarget?.mode!=='dsh-session' && bindingPending)}>保存注入选择</Button></Card>
      <TaskContextPreview taskId={id} contextId={task.contextId} /></>}

      <Card title="运行历史" subtitle="业务完成、归档完成与记忆吸收分别记录。">
        {runs.length === 0 ? (
          <Empty title="还没有运行记录" hint="点击右上角「立即运行」试一次。" />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>时间</th>
                <th>状态</th>
                <th>触发</th>
                <th>耗时</th>
                <th>收尾</th>
                <th>结果</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <div>{fmtDateTime(run.queuedAt)}</div>
                    <div className="li-sub">{fmtRelative(run.queuedAt)}</div>
                  </td>
                  <td>
                    <Badge tone={toneOfStatus(run.status)}>{labelOfStatus(run.status)}</Badge>
                  </td>
                  <td style={{ maxWidth: 180 }}>{run.triggerReason}<Button variant="quiet" size="small" onClick={()=>navigate(`/runs/${run.id}`)}>运行详情</Button></td>
                  <td>{fmtDuration(run.durationMs)}</td>
                  <td>
                    <div className="stack tight">
                      <span className={run.businessDone ? 'tag' : 'badge warn'}>
                        {run.businessDone ? '业务已提交' : '业务未完成'}
                      </span>
                      <span className={run.archiveDone ? 'tag' : 'badge muted'}>
                        {run.archiveDone ? '已归档' : '未归档'}
                      </span>
                      <span className={run.memoryDone ? 'tag' : 'badge muted'}>
                        {run.memoryDone ? '已吸收' : '待吸收'}
                      </span>
                    </div>
                  </td>
                  <td style={{ maxWidth: 260 }}>
                    <div className="li-sub" style={{ marginTop: 0 }}>
                      {truncate(run.outputText || run.errorMessage || '（无输出）', 110)} {run.meta?.documentSlug && <a href={`#/memory/docs/${encodeURIComponent(run.meta.documentSlug)}`}>打开日记文档</a>}
                    </div>
                  </td>
                  <td>
                    {['running', 'stopping', 'queued'].includes(run.status) ? (
                      <Button variant="ghost" size="small" onClick={() => void stopRun(run.id)}>
                        {run.status === 'stopping' ? '停止中' : '停止'}
                      </Button>
                    ) : (
                      <Button variant="quiet" size="small" onClick={() => navigate(`/conversations/${run.conversationId}`)}>
                        会话
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="高级信息">
        <KV
          items={[
            { label: '任务 ID', value: <code>{task.id}</code> },
            { label: '创建时间', value: fmtDateTime(task.createdAt) },
            { label: '最近更新', value: fmtDateTime(task.updatedAt) },
            { label: '项目', value: task.projectId ? <code>{task.projectId}</code> : '—' },
            { label: '最大运行时长', value: fmtDuration(task.maxRuntimeMs) },
            {
              label: '工具策略',
              value: (
                <code>
                  {task.toolPolicy?.mode === 'allow'
                    ? `仅允许 ${task.toolPolicy.allow.length} 个`
                    : task.toolPolicy?.deny?.length
                      ? `禁止 ${task.toolPolicy.deny.length} 个`
                      : '全部可用'}
                </code>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

/**
 * What the watched room has overheard.
 *
 * Lives on the task that owns the room, next to the trigger that decides what to
 * do with it: the buffer is an implementation detail of the group-watch trigger,
 * not a global state of the install.
 */
function GroupBufferPanel({ peerId }: { peerId: string }) {
  const toast = useToast();
  const data = useApi<any>(`/api/group/buffer${peerId ? `?peerId=${encodeURIComponent(peerId)}` : ''}`);
  const [clearing, setClearing] = useState(false);

  const clear = async () => {
    if (!window.confirm('清空这个群的消息缓存？已经进记忆的不受影响，未吸收的会丢。')) return;
    setClearing(true);
    try {
      const result = await api<{ cleared: number }>('/api/group/buffer/clear', {
        method: 'POST',
        body: { peerId: peerId || null },
      });
      toast(`已清空 ${result.cleared} 条`, 'ok');
      await data.reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setClearing(false);
    }
  };

  return (
    <Card
      title="群聊缓存"
      subtitle="所有群消息先进这里，不逐条回复；每晚记忆维护吸收后清空"
      actions={
        <div className="row" style={{ gap: 6 }}>
          <Button variant="ghost" size="small" onClick={() => void data.reload()}>
            刷新
          </Button>
          <Button variant="quiet" size="small" disabled={clearing || !data.data?.total?.count} onClick={() => void clear()}>
            {clearing ? '清空中…' : '清空'}
          </Button>
        </div>
      }
    >
      {data.error ? <ErrorBox error={data.error} onRetry={() => void data.reload()} /> : null}
      {!data.data ? (
        <Loading />
      ) : (
        <>
          <KV
            items={[
              { label: '缓存条数', value: data.data.total?.count ?? 0 },
              { label: '未吸收', value: data.data.total?.pending ?? 0 },
              { label: '房间', value: data.data.rooms?.length ?? 0 },
            ]}
          />
          {data.data.recent?.length ? (
            <div className="list" style={{ marginTop: 12 }}>
              {data.data.recent.slice(-8).map((message: any) => (
                <div className="list-item" key={message.id}>
                  <div className="li-main">
                    <div className="li-title">
                      {message.senderName || message.senderId || '某人'}
                      {message.answeredAt ? <Badge tone="ok">回过</Badge> : null}
                    </div>
                    <div className="li-sub">{String(message.text).slice(0, 110)}</div>
                  </div>
                  <span className="li-sub">{fmtRelative(message.at)}</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="缓存是空的" hint="群里来消息就会进这里；记忆维护吸收之后会清掉。" />
          )}
        </>
      )}
    </Card>
  );
}

function TriggerEditor({
  taskId,
  taskEnabled,
  triggers,
  onChange,
}: {
  taskId: string;
  taskEnabled: boolean;
  triggers: any[];
  onChange: () => void;
}) {
  const toast = useToast();
  const definitions = useApi<{definitions:any[]}>('/api/trigger-definitions');
  const channels = useApi<{channels:any[]}>('/api/channels');
  const status = (t:any) => {
    if (!taskEnabled) return '任务已停用';
    if (!(t.spec?.localEnabled ?? t.enabled)) return '此任务引用已停用';
    const definition = definitions.data?.definitions.find(d => d.id === t.spec?.definitionId);
    if (t.spec?.definitionId && !definitions.data) return '正在检查共享规则状态';
    if (t.spec?.definitionId && !definition) return '共享规则不可用';
    if (definition && !definition.enabled) return '共享规则已停用，请到规则库启用';
    if (!t.enabled) return '触发规则已停用';
    if (t.type === 'message') {
      if (!t.spec?.peerId && t.spec?.requirePeer !== false) return '待选择聊天对象';
      if (!t.spec?.channelId) return '待选择接入';
      if (!channels.data) return '正在检查接入状态';
      if (!channels.data.channels.some(c => c.id === t.spec.channelId && c.enabled)) return '接入已停用或不可用';
      return t.spec?.peerId ? '规则已启用；实际接收还受接入授权限制' : '规则已启用；未指定对象，实际接收受接入授权限制';
    }
    return '规则已启用';
  };
  const [definitionId,setDefinitionId] = useState('');
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState('schedule');
  const [scheduleKind, setScheduleKind] = useState('daily');
  const [time, setTime] = useState('20:00');
  const [minutes, setMinutes] = useState(180);
  const [cron, setCron] = useState('0 20 * * *');
  const [peerKind, setPeerKind] = useState('private');
  const [match, setMatch] = useState('any');
  const [value, setValue] = useState('');
  // Chat triggers can be gated by local time: cheap at night, strict by day.
  const [windowed, setWindowed] = useState(false);
  const [hoursFrom, setHoursFrom] = useState(0);
  const [hoursTo, setHoursTo] = useState(9);
  const [maxPerHour, setMaxPerHour] = useState(0);
  const [hookRate, setHookRate] = useState(60);
  const [busy, setBusy] = useState(false);
  // Editing an existing trigger reuses this same form: a policy you cannot tune
  // afterwards is a policy you have to delete and retype.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  // Daily slots promise "one per day": a missed one is caught up once.
  const [catchUp, setCatchUp] = useState('run-once');

  /** Load an existing trigger into the form. Every field is restored from spec. */
  const [messageSpec,setMessageSpec]=useState<any>({requirePeer:true});
  const [watchSpec,setWatchSpec]=useState<any>({policy:'keyword-or-count',peerKind:'group',channelId:'',peerId:'',keywords:[],messageCount:20,windowMessages:30});
  const startEdit = (trigger: any) => {
    const spec = trigger.spec ?? {};
    setEditingId(trigger.id);
    setAdding(true);
    setType(trigger.type);
    setLabel(trigger.label ?? '');
    if (trigger.type === 'schedule') {
      setScheduleKind(spec.kind ?? 'daily');
      setCatchUp(trigger.misfirePolicy ?? 'skip');
      if (spec.at) setTime(spec.at);
      if (spec.kind === 'interval' && spec.minutes) setMinutes(Number(spec.minutes));
      if (spec.kind === 'cron' && spec.expr) setCron(spec.expr);
      if (Array.isArray(spec.days) && spec.days.length) setWeekdays(spec.days.map(Number));
    }
    if (trigger.type === 'message') {
      setMessageSpec(spec);
      setPeerKind(spec.peerKind ?? 'any');
      setMatch(spec.match ?? 'any');
      setValue(spec.value ?? '');
      setMaxPerHour(Number(spec.maxPerHour) || 0);
      const hours = Array.isArray(spec.hours) ? spec.hours : null;
      setWindowed(Boolean(hours));
      if (hours) {
        setHoursFrom(Number(hours[0]));
        setHoursTo(Number(hours[1]));
      }
    }
    if (trigger.type === 'group-watch') {
      setWatchSpec({...spec});
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setMessageSpec({requirePeer:true});
    setWatchSpec({policy:'keyword-or-count',peerKind:'group',channelId:'',peerId:'',keywords:[],messageCount:20,windowMessages:30});
    setAdding(false);
    setLabel('');
  };

  const save = async () => {
    setBusy(true);
    try {
      const spec: any =
        type === 'schedule'
          ? scheduleKind === 'daily'
            ? { kind: 'daily', at: time }
            : scheduleKind === 'weekly'
              ? { kind: 'weekly', at: time, days: weekdays.length ? weekdays : [1] }
              : scheduleKind === 'interval'
                ? { kind: 'interval', minutes }
                : { kind: 'cron', expr: cron }
          : type === 'group-watch'
            ? watchSpec
            : type === 'message'
              ? {
                  ...messageSpec,
                  requirePeer: messageSpec.requirePeer ?? true,
                  match,
                  value,
                  hours: windowed ? [hoursFrom, hoursTo] : null,
                  maxPerHour,
                }
              : type === 'webhook'
                ? { maxPerHour: hookRate }
                : { kind: 'custom' };
      if (type === 'group-watch') { const error=triggerRuleError(type,spec); if(error) throw new Error(error); }
      if (type === 'message' && (!spec.channelId || !spec.peerId)) throw new Error('请选择接入和聊天对象');
      if (editingId) {
        await api(`/api/tasks/${taskId}/triggers/${editingId}`, {
          method: 'PATCH',
          body: { type, spec, enabled:true, activateTask:true, label: label.trim() || undefined, misfirePolicy: type === 'schedule' ? catchUp : undefined },
        });
        toast('触发已更新，下一条消息起按新规则', 'ok');
      } else {
        await api(`/api/tasks/${taskId}/triggers`, {
          method: 'POST',
          body: { type, spec, label: label.trim() || undefined, enabled: true, activateTask: true, misfirePolicy: type === 'schedule' ? catchUp : undefined },
        });
        toast('触发已添加并写入调度', 'ok');
      }
      resetForm();
      onChange();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const toggleTrigger = async (trigger: any) => {
    try {
      const enabled=!(trigger.spec?.localEnabled ?? trigger.enabled);
      await api(`/api/tasks/${taskId}/triggers/${trigger.id}`, { method: 'PATCH', body: { enabled, ...(enabled?{activateTask:true}:{}) } });
      onChange();
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  const remove = async (triggerId: string) => {
    if (!window.confirm('移除这个触发绑定？历史运行记录会保留。')) return;
    await api(`/api/triggers/${triggerId}`, { method: 'DELETE' });
    onChange();
  };

  return (
    <div className="stack">
      <Card title="使用独立触发器" subtitle="规则在触发器页统一编辑，任务有独立启停与运行状态。">
        <div className="row"><select value={definitionId} onChange={e=>setDefinitionId(e.target.value)}><option value="">选择已有触发规则</option>{definitions.data?.definitions.filter(d=>!triggers.some(t=>t.spec?.definitionId===d.id)).map(d=><option key={d.id} value={d.id}>{d.label}</option>)}</select><Button disabled={!definitionId} onClick={async()=>{try{await api('/api/tasks/'+taskId+'/triggers',{method:'POST',body:{definitionId}});setDefinitionId('');onChange();}catch(e){toast((e as Error).message,'bad');}}}>使用触发器</Button><Button variant="quiet" onClick={()=>navigate('/tasks/triggers')}>管理规则库</Button></div>
      </Card>
      {triggers.length === 0 ? (
        <Empty title="没有触发绑定" hint="只能手动运行。添加一个每日触发即可自动化。" />
      ) : (
        <div className="list">
          {triggers.map((trigger) => (
            <div className="list-item" key={trigger.id}>
              <Badge tone={trigger.enabled ? 'accent' : 'muted'}>{trigger.type}</Badge>
              <div className="li-main">
                <div className="li-title">{trigger.description}</div>
                <div className="li-sub">
                  {trigger.nextFireAt ? `下次 ${fmtDateTime(trigger.nextFireAt)}` : '没有排定下次触发'}
                  {trigger.lastFiredAt ? ` · 上次 ${fmtRelative(trigger.lastFiredAt)}` : ''}
                   · {status(trigger)}
                </div>
                {trigger.type === 'webhook' && trigger.spec?.token ? (
                  <div className="li-sub">
                    <code>{`${window.location.origin}${basePath()}/api/hooks/${trigger.spec.token}`}</code>{' '}
                    <Button
                      variant="quiet"
                      size="small"
                      onClick={() =>
                        void navigator.clipboard?.writeText(
                          `${window.location.origin}${basePath()}/api/hooks/${trigger.spec.token}`,
                        )
                      }
                    >
                      复制
                    </Button>{' '}
                    <span>POST 正文就是这次运行的输入</span>
                  </div>
                ) : null}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Button variant="quiet" size="small" onClick={() => startEdit(trigger)}>
                  编辑
                </Button>
                <Button variant="quiet" size="small" onClick={() => void toggleTrigger(trigger)}>
                  {(trigger.spec?.localEnabled ?? trigger.enabled) ? '停用此任务引用' : '启用此任务引用'}
                </Button>
                <Button variant="quiet" size="small" onClick={() => void remove(trigger.id)}>
                  移除
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="stack" style={{ borderTop: '1px solid var(--line-2)', paddingTop: 12 }}>
          <div className="row between">
            <strong>{editingId ? '编辑触发' : '添加触发'}</strong>
            {editingId ? <span className="li-sub">保存后立即按新规则判断，下一条消息生效</span> : null}
          </div>
          <Field label="触发类型" help={editingId ? '编辑时不能改类型；要换类型请移除后重新添加。' : undefined}>
            <select value={type} onChange={(event) => setType(event.target.value)} disabled={Boolean(editingId)}>
              <option value="schedule">定时</option>
              <option value="message">消息（私聊 / 群聊）</option>
              <option value="group-watch">群聊观察（先缓存，再决定要不要看一眼）</option>
              <option value="webhook">外部触发（POST 一个 URL 就跑）</option>
              <option value="manual">手动</option>
              <option value="system">系统事件</option>
            </select>
          </Field>
          <Field label="备注（可选）" help="只影响这条触发在列表里的显示名。">
            <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如：群聊观察 · 大群" />
          </Field>
          {type === 'webhook' && (
            <>
              <div className="notice" style={{ fontSize: 12, lineHeight: 1.7 }}>
                保存后会生成一个只有你知道的 URL。任何能发 HTTP 请求的东西——脚本、计划任务、另一台机器、手机快捷指令——
                POST 到这个地址，任务就带着请求正文跑一次。正文写什么，就相当于对任务说了什么。
              </div>
              <Field label="每小时最多几次" help="防止脚本抽风把额度刷爆；0 表示不限制。">
                <input
                  type="number"
                  min={0}
                  max={1000}
                  value={hookRate}
                  onChange={(event) => setHookRate(Number(event.target.value))}
                />
              </Field>
            </>
          )}
          {type === 'schedule' && (
            <>
              <Field label="重复方式">
                <select
                  value={scheduleKind}
                  onChange={(event) => {
                    const kind = event.target.value;
                    setScheduleKind(kind);
                    // Only daily/weekly slots are worth back-filling; an interval
                    // or cron trigger fires again soon enough.
                    setCatchUp(kind === 'daily' || kind === 'weekly' ? 'run-once' : 'skip');
                  }}
                >
                  <option value="daily">每天固定时间</option>
                  <option value="weekly">每周固定几天</option>
                  <option value="interval">按间隔</option>
                  <option value="cron">cron 表达式</option>
                </select>
              </Field>
              {(scheduleKind === 'daily' || scheduleKind === 'weekly') && (
                <Field label="时间（Asia/Shanghai）">
                  <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
                </Field>
              )}
              {scheduleKind === 'weekly' && (
                <Field label="星期几" help="周一 = 1，周日 = 7。">
                  <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                    {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                      <label key={day} className="toggle">
                        <input
                          type="checkbox"
                          checked={weekdays.includes(day)}
                          onChange={(event) => {
                            const next = new Set(weekdays);
                            if (event.target.checked) next.add(day);
                            else next.delete(day);
                            setWeekdays([...next].sort((a, b) => a - b));
                          }}
                        />
                        <span className="toggle-track" />
                        <span>{['一', '二', '三', '四', '五', '六', '日'][day - 1]}</span>
                      </label>
                    ))}
                  </div>
                </Field>
              )}
              {scheduleKind === 'interval' && (
                <Field label="间隔（分钟）">
                  <input
                    type="number"
                    min={1}
                    value={minutes}
                    onChange={(event) => setMinutes(Number(event.target.value))}
                  />
                </Field>
              )}
              {scheduleKind === 'cron' && (
                <Field label="cron（5 段）" help="分 时 日 月 周；日与周同时限定时按“或”匹配。">
                  <input value={cron} onChange={(event) => setCron(event.target.value)} />
                </Field>
              )}
              <Field
                label="错过时间怎么处理"
                help="机器关着、Yu 没起来时，这条触发的那个时间点就错过了。补一次 = 开机后补跑一遍；一天最多补一次。"
              >
                <select value={catchUp} onChange={(event) => setCatchUp(event.target.value)}>
                  <option value="run-once">补一次（推荐：日记、备份、记忆维护这类一天一次的事）</option>
                  <option value="skip">不补，等下一个时间点</option>
                </select>
              </Field>
            </>
          )}
          {type === 'message' && (
            <>
              <PeerSelector value={messageSpec} onChange={setMessageSpec}/>
              <Field label="匹配方式">
                <select value={match} onChange={(event) => setMatch(event.target.value)}>
                  <option value="any">任意消息</option>
                  <option value="prefix">以…开头</option>
                  <option value="contains">包含…</option>
                  <option value="commands">斜杠命令</option>
                </select>
              </Field>
              {(match === 'prefix' || match === 'contains') && (
                <Field label="匹配内容">
                  <input value={value} onChange={(event) => setValue(event.target.value)} />
                </Field>
              )}
              <Toggle checked={windowed} onChange={setWindowed} label="只在指定时段接话" />
              {windowed ? (
                <Field
                  label="时段（本地时间）"
                  help="左闭右开；结束早于开始表示跨零点。两个任务各给一段，就能做出「夜里宽松、白天收紧」。"
                >
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={hoursFrom}
                      onChange={(event) => setHoursFrom(Number(event.target.value))}
                      style={{ width: 80 }}
                      aria-label="开始小时"
                    />
                    <span>点到</span>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={hoursTo}
                      onChange={(event) => setHoursTo(Number(event.target.value))}
                      style={{ width: 80 }}
                      aria-label="结束小时"
                    />
                    <span>点</span>
                  </div>
                </Field>
              ) : null}
              <Field label="每小时最多回几条" help="0 表示不限制；按触发计，重启也不会清零。">
                <input
                  type="number"
                  min={0}
                  max={240}
                  value={maxPerHour}
                  onChange={(event) => setMaxPerHour(Number(event.target.value))}
                  style={{ width: 120 }}
                />
              </Field>
            </>
          )}
          {type === 'group-watch' && <TriggerRuleForm type={type} spec={watchSpec} onChange={setWatchSpec}/>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="quiet" onClick={resetForm}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={busy}>
              {editingId ? '保存并启用此任务触发' : '添加并启用此任务触发'}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" onClick={() => setAdding(true)}>
          添加此任务专用触发（兼容旧版）
        </Button>
      )}
    </div>
  );
}

function ReadingPanel({
  taskId,
  projectId,
  reading,
  onChanged,
}: {
  taskId: string;
  projectId: string | null;
  reading: any;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [sourcePath, setSourcePath] = useState(reading?.sourcePath ?? '');
  const [progress, setProgress] = useState(reading?.progress ?? 0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSourcePath(reading?.sourcePath ?? '');
    setProgress(reading?.progress ?? 0);
  }, [reading?.sourcePath, reading?.progress]);

  if (!projectId) {
    return <Empty title="这个阅读任务还没有绑定项目" hint="编辑任务并设置 projectId 为 reading-main。" />;
  }

  const load = async () => {
    setBusy(true);
    try {
      const result = await api<any>(`/api/projects/${projectId}`, {
        method: 'PATCH',
        body: { sourcePath },
      });
      toast(`已载入 ${result.reading?.total ?? 0} 章；进度已重置为 0`, 'ok');
      onChanged();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const applyProgress = async () => {
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}`, { method: 'PATCH', body: { progress } });
      toast('进度已更新', 'ok');
      onChanged();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const total = reading?.total ?? 0;
  const percent = total ? Math.round(((reading?.progress ?? 0) / total) * 100) : 0;

  return (
    <div className="stack">
      <Field
        label="小说文件路径"
        help="支持 Markdown / 纯文本，按 `## 标题` 分章。读取是只读的；路径变化会重置进度。"
      >
        <div className="file-input-row">
          <input
            value={sourcePath}
            onChange={(event) => setSourcePath(event.target.value)}
            placeholder="E:\books\novel.md"
          />
          <Button variant="ghost" onClick={() => void load()} disabled={busy || !sourcePath.trim()}>
            载入
          </Button>
        </div>
      </Field>

      {reading?.error && <div className="notice warn">{reading.error.message}</div>}

      <div className="row between">
        <KV
          items={[
            { label: '章节总数', value: total || '—' },
            { label: '当前进度', value: total ? `${reading.progress} / ${total}（${percent}%）` : '—' },
            { label: '当前章节', value: reading?.currentChapter?.title ?? '—' },
            { label: '文件指纹', value: reading?.source?.sha ? <code>{reading.source.sha.slice(0, 16)}…</code> : '—' },
          ]}
        />
      </div>

      {total > 0 && (
        <div className="row">
          <input
            type="number"
            min={0}
            max={total}
            value={progress}
            onChange={(event) => setProgress(Number(event.target.value))}
            style={{ width: 110 }}
          />
          <Button variant="ghost" size="small" onClick={() => void applyProgress()} disabled={busy}>
            设置进度
          </Button>
          <span className="li-sub">手动调整进度会立即生效，不需要等下一次阅读。</span>
        </div>
      )}

      {reading?.project?.state?.notes?.length > 0 && (
        <div>
          <div className="caption" style={{ padding: 0, marginBottom: 6 }}>
            最近笔记
          </div>
          <div className="list">
            {reading.project.state.notes
              .slice(-3)
              .reverse()
              .map((note: any, index: number) => (
                <div className="list-item" key={index}>
                  <Badge tone="accent">第 {note.chapter} 章</Badge>
                  <div className="li-main">
                    <div className="li-title">{note.title}</div>
                    <div className="li-sub">{truncate(note.text, 160)}</div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Per-task context preview: the same assembly a run uses, with this task's goal,
 * tool policy and project progress — not just the bare context profile.
 */
function TaskContextPreview({ taskId, contextId }: { taskId: string; contextId?: string | null }) {
  const toast = useToast();
  const [input, setInput] = useState('（示例输入）');
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const run = async () => {
    if (!contextId) {
      toast('这个任务还没有绑定上下文方案', 'warn');
      return;
    }
    setBusy(true);
    try {
      const result = await api<any>(`/api/contexts/${contextId}/preview`, { method: 'POST', body: { input, taskId } });
      setData(result.compiled);
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="上下文预览" subtitle="按这个任务真实的目标、工具策略与上下文方案，算出这次会注入什么；不调用模型。">
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <Field label="示例输入">
            <input value={input} onChange={(event) => setInput(event.target.value)} />
          </Field>
        </div>
        <Button onClick={() => void run()} disabled={busy}>
          {busy ? '计算中…' : '预览'}
        </Button>
      </div>
      {data ? (
        <div className="stack" style={{ marginTop: 12 }}>
          <KV
            items={[
              { label: '模型路由', value: `${data.route?.provider ?? '?'} / ${data.route?.model ?? '?'}` },
              {
                label: '估算 token',
                value: `${data.budget?.totalTokens ?? '?'}（系统 ${data.budget?.systemTokens ?? '?'} / 输入 ${data.budget?.inputTokens ?? '?'}）`,
              },
              { label: '段落', value: `${(data.sections ?? []).length} 段` },
            ]}
          />
          <div className="list">
            {(data.sections ?? []).map((section: any) => (
              <div className="list-item" key={section.name}>
                <Badge tone="muted">{section.order}</Badge>
                <div className="li-main">
                  <div className="li-title">
                    {section.name} · ≈{section.tokens} token
                  </div>
                  {open === section.name ? (
                    <pre className="console-log" style={{ maxHeight: 260 }}>
                      {section.text}
                    </pre>
                  ) : null}
                </div>
                <Button variant="quiet" size="small" onClick={() => setOpen(open === section.name ? null : section.name)}>
                  {open === section.name ? '收起' : '展开'}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
