import PeerSelector from '../components/PeerSelector';
import DshTarget, { type ExecutionTarget } from '../components/DshTarget';
import TriggerRuleForm, { triggerRuleError, triggerSummary } from '../components/TriggerRuleForm';
import ConversationBinding from '../components/ConversationBinding';
import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  fmtDateTime,
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
  Loading,
  Modal,
  PageHead,
  Toggle,
  navigate,
  useApi,
  useToast,
} from '../ui';
import { TaskTabs } from '../components/TaskTabs';

interface TaskRow {
  id: string;
  name: string;
  kind: string;
  description: string;
  enabled: boolean;
  contextId: string | null;
  executionTarget?: ExecutionTarget;
  conversationMode: string;
  conversationId: string | null;
  projectId: string | null;
  goal: string;
  triggerDescriptions: Array<{ id: string; description: string; enabled: boolean; nextFireAt: number | null }>;
  lastRun: { id: string; status: string; at: number; errorCode: string | null } | null;
  runCount: number;
  nextFireAt: number | null;
}

interface Template {
  id: string;
  name: string;
  kind: string;
  description: string;
  goal: string;
  conversationMode: string;
  projectId?: string;
  triggers: Array<{ type: string; spec: any; label?: string }>;
}

interface TasksResponse {
  tasks: TaskRow[];
  kinds: string[];
  templates: Template[];
}

const CONV_MODE_LABEL: Record<string, string> = {
  reuse: '复用同一对话',
  new: '每次新建对话',
  'per-peer': '按对象复用（渠道）',
};

export function Tasks() {
  const tasks = useApi<TasksResponse>('/api/tasks');
  const contexts = useApi<{ contexts: Array<{ id: string; name: string }> }>('/api/contexts');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const toast = useToast();

  const reload = () => {
    void tasks.reload();
  };

  const toggle = async (task: TaskRow) => {
    setBusyId(task.id);
    try {
      await api(`/api/tasks/${task.id}/enable`, { method: 'POST', body: { enabled: !task.enabled } });
      reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusyId(null);
    }
  };

  const run = async (task: TaskRow) => {
    setBusyId(task.id);
    try {
      const result = await api<any>(`/api/tasks/${task.id}/run`, { method: 'POST', body: {} });
      if (result.skipped) toast(result.reason ?? '该任务不调用模型', 'warn');
      else toast(`已开始运行「${task.name}」`, 'ok');
      reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusyId(null);
    }
  };

  const duplicate = async (task: TaskRow) => {
    setBusyId(task.id);
    try {
      await api(`/api/tasks/${task.id}/duplicate`, { method: 'POST', body: {} });
      toast('已复制为停用副本，确认后再启用', 'ok');
      reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (task: TaskRow) => {
    if (!window.confirm(`移除任务「${task.name}」？历史运行记录会保留。`)) return;
    setBusyId(task.id);
    try {
      await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
      toast('任务已移除，历史保留', 'ok');
      reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHead
        eyebrow="任务"
        title="任务与触发"
        description="先回答三件事：做什么、何时做、使用哪个上下文。触发可以随时移除，历史记录不会丢。"
        actions={<Button onClick={() => setCreating(true)}>新建任务</Button>}
      />

      <TaskTabs
        active="tasks"
        counts={{ tasks: tasks.data?.tasks.length, triggers: tasks.data?.tasks.reduce((n, task) => n + task.triggerDescriptions.length, 0) }}
      />

      {tasks.error && <ErrorBox error={tasks.error} onRetry={reload} />}
      <Card padded={false}>
        {tasks.loading && !tasks.data ? (
          <div style={{ padding: 20 }}>
            <Loading label="正在读取任务…" />
          </div>
        ) : tasks.data?.tasks.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>任务</th>
                <th>触发</th>
                <th>下次触发</th>
                <th>最近结果</th>
                <th style={{ width: 90 }}>启用</th>
                <th style={{ width: 260 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.data.tasks.map((task) => (
                <tr key={task.id} className="clickable">
                  <td onClick={() => navigate(`/tasks/${task.id}`)}>
                    <div style={{ fontWeight: 600 }}>{task.name}</div>
                    <div className="li-sub">
                      {TASK_KIND[task.kind] ?? task.kind} · {task.executionTarget?.mode === 'dsh-session' ? '关联的 DSH 会话' : `Yu · ${CONV_MODE_LABEL[task.conversationMode] ?? task.conversationMode}`}
                      {task.runCount ? ` · ${task.runCount} 次运行` : ''}
                      {task.description && <div>{task.description}</div>}
                    </div>
                  </td>
                  <td onClick={() => navigate(`/tasks/${task.id}`)}>
                    {task.triggerDescriptions.length === 0 ? (
                      <span className="badge muted">仅手动</span>
                    ) : (
                      <div className="stack tight">
                        {task.triggerDescriptions.map((trigger) => (
                          <span key={trigger.id} className={trigger.enabled ? '' : 'tag'}>
                            {trigger.enabled ? trigger.description : `${trigger.description}（已停用）`}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td onClick={() => navigate(`/tasks/${task.id}`)}>
                    {task.nextFireAt ? (
                      <div>
                        <div>{fmtRelative(task.nextFireAt)}</div>
                        <div className="li-sub">{fmtDateTime(task.nextFireAt)}</div>
                      </div>
                    ) : (
                      <span className="li-sub">—</span>
                    )}
                  </td>
                  <td onClick={() => navigate(`/tasks/${task.id}`)}>
                    {task.lastRun ? (
                      <div>
                        <Badge tone={toneOfStatus(task.lastRun.status)}>{labelOfStatus(task.lastRun.status)}</Badge>
                        <div className="li-sub">{fmtRelative(task.lastRun.at)}</div>
                      </div>
                    ) : (
                      <span className="li-sub">从未运行</span>
                    )}
                  </td>
                  <td>
                    <Toggle checked={task.enabled} onChange={() => void toggle(task)} disabled={busyId === task.id} />
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <Button variant="ghost" size="small" disabled={busyId === task.id} onClick={() => void run(task)}>
                        立即运行
                      </Button>
                      {task.conversationId && <Button variant="quiet" size="small" onClick={() => navigate(`/conversations/${encodeURIComponent(task.conversationId!)}`)}>打开会话</Button>}
                      <Button variant="quiet" size="small" onClick={() => navigate(`/tasks/${task.id}`)}>会话设置</Button>
                      <Button variant="quiet" size="small" onClick={() => void duplicate(task)}>
                        复制
                      </Button>
                      <Button variant="quiet" size="small" onClick={() => void remove(task)}>
                        移除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 20 }}>
            <Empty
              title="还没有任务"
              hint="从定时任务、聊天桥、随机活动或群聊响应开始，创建后确认配置再启用。"
              action={<Button onClick={() => setCreating(true)}>新建任务</Button>}
            />
          </div>
        )}
      </Card>

      {creating && tasks.data && (
        <CreateTaskModal
          templates={tasks.data.templates}
          contexts={contexts.data?.contexts ?? []}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            reload();
            navigate(`/tasks/${id}`);
          }}
        />
      )}
    </>
  );
}

function CreateTaskModal({templates,contexts,onClose,onCreated}:{templates:Template[];contexts:Array<{id:string;name:string}>;onClose:()=>void;onCreated:(id:string)=>void}) {
  const [template,setTemplate]=useState<Template|null>(null);
  const [details,setDetails]=useState(false);
  const [name,setName]=useState('');const [goal,setGoal]=useState('');const [kind,setKind]=useState('custom');
  const [contextId,setContextId]=useState(contexts[0]?.id??'');const [mode,setMode]=useState('reuse');const [conversationId,setConversationId]=useState<string|null>(null);const [bindingPending,setBindingPending]=useState(false);
  const [target,setTarget]=useState<ExecutionTarget>({mode:'yu'});
  const [rule,setRule]=useState<any>({type:'schedule',spec:{kind:'daily',at:'20:00',timezone:'Asia/Shanghai'}});
  const [manual,setManual]=useState(false);const [enabled,setEnabled]=useState(true);const [input,setInput]=useState('{{input}}');const [error,setError]=useState<Error|null>(null);const [saving,setSaving]=useState(false);
  const channels=useApi<{channels:any[]}>('/api/channels');const toast=useToast();
  const message=rule.type==='message';const group=template?.id==='group-response';
  const choose=(item:Template|null)=>{setTemplate(item);setName(item?.name??'');setGoal(item?.goal??'');setKind(item?.kind??'custom');setMode(item?.conversationMode??'reuse');setConversationId(null);setBindingPending(false);setManual(!item);setEnabled(true);setError(null);setRule(item?.triggers[0]??{type:'schedule',spec:{kind:'daily',at:'20:00',timezone:'Asia/Shanghai'}});setDetails(true);};
  const validation=manual?null:triggerRuleError(rule.type,rule.spec);
  const missing=message&&!manual?(!rule.spec.channelId||!rule.spec.peerId?'请选择接入和聊天对象':null):null;
  const blockers=[!name.trim()?'请填写任务名称':null,target.mode==='dsh-session'&&!target.linkId?'请选择目标 DSH 会话':null,target.mode==='yu'&&bindingPending?'任务会话：还没有选择可用会话，请选中一项或改为新建固定会话':null,missing,validation].filter(Boolean);
  const submit=async()=>{if(saving)return;setError(null);if(blockers.length){setError(new Error(blockers.join('；')));return;}setSaving(true);try{const result=await api<{task:{id:string}}>('/api/tasks',{method:'POST',body:{executionTarget:target,name:name.trim(),kind,goal,inputTemplate:input,contextId:contextId||null,conversationMode:mode,conversationId,enabled,templateId:template?.id,triggers:manual?[]:[{...rule,spec:message?{...rule.spec,requirePeer:rule.spec.requirePeer??true}:rule.spec,label:name.trim()+' · 触发规则',enabled:true}]}});toast(enabled?'任务已创建并启用':'任务已创建，当前停用；确认后在任务页启用','ok');onCreated(result.task.id);}catch(e){setError(e as Error);}finally{setSaving(false);}};
  const setSpec=(spec:any)=>setRule({...rule,spec});
  return <Modal open wide title={details?'新建任务 · 配置任务与触发':'新建任务 · 选择模板'} onClose={onClose} footer={details?<><div role="status" className="error-text" style={{flex:1}}>{blockers.length>0 ? `暂不能创建：${blockers.join("；")}` : ""}</div><Button variant="quiet" onClick={()=>setDetails(false)}>返回模板</Button><Button variant="quiet" onClick={onClose}>取消</Button><Button disabled={saving||blockers.length>0} onClick={()=>void submit()}>{saving?'创建中…':'创建任务'}</Button></>:<><Button variant="ghost" onClick={()=>choose(null)}>从空白开始</Button><Button variant="quiet" onClick={onClose}>取消</Button></>}>
    {!details?<div className="grid two">{templates.map(item=><button type="button" className="card" style={{textAlign:'left',cursor:'pointer'}} key={item.id} onClick={()=>choose(item)}><strong>{item.name}</strong><p>{item.description}</p><span className="li-sub">{item.triggers[0]?triggerSummary(item.triggers[0].type,item.triggers[0].spec):'仅手动运行'}</span></button>)}</div>:<div className="stack">
      <div className="notice">{template?.description??'配置一个手动任务，也可以添加触发规则。'} 新建不会立即执行。默认启用；必填配置完整后才会按触发规则运行。</div>
      <Field label="任务名称"><input aria-label="任务名称" value={name} onChange={e=>setName(e.target.value)}/></Field>
      <Field label="做什么（目标）"><textarea aria-label="做什么（目标）" rows={3} value={goal} onChange={e=>setGoal(e.target.value)}/></Field>
      {!template&&<Field label="何时做"><select aria-label="何时做" value={manual?'manual':'schedule'} onChange={e=>setManual(e.target.value==='manual')}><option value="manual">仅手动运行</option><option value="schedule">添加定时触发</option></select></Field>}
      {!manual&&<>
        {message?<>
          <PeerSelector value={rule.spec} onChange={setSpec}/><Field label="响应条件"><select aria-label="响应条件" value={rule.spec.match} onChange={e=>setSpec({...rule.spec,match:e.target.value})}>{(group||rule.spec.peerKind==='group')&&<option value="mention">仅 @我</option>}<option value="contains">包含关键词</option><option value="prefix">以前缀开头</option><option value="commands">斜杠命令</option><option value="any">全部消息</option></select></Field>
          {['contains','prefix'].includes(rule.spec.match)&&<Field label="匹配文字"><input aria-label="匹配文字" value={rule.spec.value??''} onChange={e=>setSpec({...rule.spec,value:e.target.value})}/></Field>}
          <Field label="输出路由"><select aria-label="输出路由" value={rule.spec.replyMode??'reply'} onChange={e=>setSpec({...rule.spec,replyMode:e.target.value})}><option value="reply">回复消息来源（原私聊 / 原群）</option><option value="record">仅在任务会话记录</option></select></Field>
          <div className="notice">私聊还遵循接入页的主人与陌生人回复设置。群聊 @ 依赖接入识别机器人提及；明确群规则优先于群聊观察。</div>
        </>:<><Field label="触发方式"><select aria-label="触发方式" value={rule.spec.kind} onChange={e=>setSpec({...rule.spec,kind:e.target.value,...(e.target.value==='weekly'?{days:rule.spec.days??[1]}:{}),...(e.target.value==='roll'?{sides:rule.spec.sides??6,target:rule.spec.target??1}:{}),...(['interval','random','roll'].includes(e.target.value)?{minutes:rule.spec.minutes??180,cooldownMinutes:rule.spec.cooldownMinutes??1}:{}),...(['daily','weekly'].includes(e.target.value)?{at:rule.spec.at??'20:00'}:{})})}><option value="daily">每天固定时间</option><option value="weekly">每周固定时间</option><option value="interval">固定间隔</option><option value="random">随机活动</option><option value="roll">Roll 点</option></select></Field><TriggerRuleForm type={rule.type} spec={rule.spec} onChange={setSpec}/><div className="notice">输出路由：保存在下方选择的任务会话。</div></>}
        <div className="notice">创建独立共享规则并绑定本任务，之后可在“触发器”页修改或在其他任务中引用。{triggerSummary(rule.type,rule.spec)}</div>
      </>}
      <DshTarget value={target} onChange={setTarget}/>
      {target.mode==='yu'&&<><Field label="用哪个上下文" help="可选择已有方案；留空使用全局模型与默认上下文。"><select aria-label="用哪个上下文" value={contextId} onChange={e=>setContextId(e.target.value)}><option value="">默认上下文（无需新建）</option>{contexts.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <ConversationBinding mode={mode} id={conversationId} onPending={setBindingPending} onChange={(m,id)=>{setMode(m);setConversationId(id);}}/></>}
      <Field label="触发输入模板" help="{{input}} 为消息内容，{{date}} / {{time}} 为当前日期时间。"><textarea aria-label="触发输入模板" value={input} onChange={e=>setInput(e.target.value)} rows={2}/></Field>
      <label><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/> 创建后启用任务与触发（可能在保存后按条件执行并回复）</label>
      {(validation||missing)&&<div className="notice">{validation||missing}</div>}{error&&<ErrorBox error={error}/>}
    </div>}
  </Modal>;
}
