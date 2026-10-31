import React from 'react';
import { fmtDateTime, fmtDuration, labelOfStatus, toneOfStatus, truncate } from '../lib';
import { Badge, Button, Card, Code, Empty, ErrorBox, KV, Loading, PageHead, navigate, useApi, usePolling } from '../ui';

const known = (value: unknown) => value == null ? '未记录' : typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
const names = (items: any) => Array.isArray(items) ? (items.length ? items.map((x: any) => typeof x === 'string' ? x : `${x.name ?? x.id ?? '未命名'}${Array.isArray(x.operations) ? `（${x.operations.join('、') || '无操作'}）` : ''}`).join('、') : '无') : '未记录';
const resultSummary = (value: any) => value == null ? '未记录' : Array.isArray(value) ? `列表，${value.length} 项` : typeof value === 'object' ? `对象，字段：${Object.keys(value).slice(0, 15).join('、') || '无'}` : typeof value === 'string' ? `文本，${value.length} 字符` : `${typeof value} 类型`;
const operation = (args: any) => typeof args?.operation === 'string' && /^[\w.-]{1,100}$/.test(args.operation) ? args.operation : null;

export function RunDetail({ id }: { id: string }) {
  const detail = useApi<any>(`/api/runs/${encodeURIComponent(id)}`);
  usePolling(() => { if (detail.data && ['queued', 'running', 'stopping'].includes(detail.data.run.status)) void detail.reload(); }, 12000);
  if (detail.error && !detail.data) return <><ErrorBox error={detail.error} onRetry={() => void detail.reload()} /><Button onClick={() => navigate('/')}>回到今日</Button></>;
  if (!detail.data) return <Loading label="正在读取运行记录…" />;
  const { run, steps = [], actual, diagnostics, toolCalls = [], archive } = detail.data;
  return <>
    <PageHead eyebrow="运行诊断" title={run.taskName || '运行记录'} description={`运行编号 ${run.id}`} actions={<div className="row">
      {run.taskId && <Button variant="quiet" onClick={() => navigate(`/tasks/${encodeURIComponent(run.taskId)}`)}>返回任务</Button>}
      {run.conversationId && <Button variant="quiet" onClick={() => navigate(`/conversations/${encodeURIComponent(run.conversationId)}`)}>打开会话</Button>}
      <Button variant="quiet" onClick={() => navigate('/')}>回到今日</Button>
    </div>} />
    {detail.error && <ErrorBox error={detail.error} onRetry={() => void detail.reload()} />}
    <Card title="本次运行" subtitle="状态和时间来自这次运行的记录">
      <KV items={[
        { label: '状态', value: <Badge tone={toneOfStatus(run.status)}>{labelOfStatus(run.status)}</Badge> },
        { label: '阶段', value: run.phase || '未记录' },
        { label: '触发原因', value: run.triggerReason || '未记录' },
        { label: '计划触发时间', value: diagnostics?.trigger?.scheduledFor ? fmtDateTime(diagnostics.trigger.scheduledFor) : '未记录' },
        { label: '排队 / 开始 / 结束', value: `${fmtDateTime(run.queuedAt)} / ${fmtDateTime(run.startedAt)} / ${fmtDateTime(run.finishedAt)}` },
        { label: '耗时', value: fmtDuration(run.durationMs) },
        { label: '业务已提交', value: known(diagnostics?.businessCommitted) },
        { label: '归档已提交', value: known(diagnostics?.archiveCommitted) },
        { label: '失败信息', value: run.errorMessage ? `${run.errorCode || '失败'}：${truncate(run.errorMessage, 500)}` : '未记录' },
      ]} />
    </Card>
    <Card title="当时的配置与上下文" subtitle="运行时保存的快照；缺少记录时无法从当前配置推断。">
      {!actual ? <Empty title="未记录上下文快照" hint="这次运行可能尚未生成快照，或历史记录没有保存。" /> : <KV items={[
        { label: '资源包', value: names(actual.resources?.packages) },
        { label: '数据源', value: names(actual.resources?.sources) },
        { label: '上下文段', value: names(actual.sections) },
        { label: '注入文件', value: Array.isArray(actual.promptFiles) ? (actual.promptFiles.length ? actual.promptFiles.map((f: any) => `${f.path || '未命名'}（${f.status || '状态未记录'}）`).join('、') : '无') : '未记录' },
        { label: '检索记录', value: Array.isArray(actual.retrieved) ? `${actual.retrieved.length} 条` : '未记录' },
        { label: '工具授权策略', value: actual.toolPolicy == null ? '未记录' : '模式：' + known(actual.toolPolicy.mode) + '；允许：' + names(actual.toolPolicy.allow) + '；禁止：' + names(actual.toolPolicy.deny) + '（不代表实际调用）' },
        { label: '授权执行验证', value: actual.toolEnforcement?.verified === true ? '已验证' : actual.toolEnforcement?.verified === false ? '未验证' : '未记录' },
        { label: '可见工具', value: names(actual.toolEnforcement?.visibleTools) },
      ]} />}
    </Card>
    <Card title="执行时序" subtitle="按记录时间排列；错误步骤可帮助定位失败环节。">
      {steps.length === 0 ? <Empty title="没有步骤记录" /> : <div className="list">{steps.map((step: any) => <div className="list-item" key={step.id}>
        <Badge tone={step.kind === 'error' ? 'bad' : 'accent'}>{step.kind === 'error' ? '错误' : '步骤'}</Badge><div className="li-main"><div className="li-title">{step.title}</div><div className="li-sub">{fmtDateTime(step.at)}{step.detail ? ` · ${truncate(step.detail, 500)}` : ''}</div></div>
      </div>)}</div>}
    </Card>
    <Card title="实际工具调用" subtitle="按本次运行查询调用记录；零次调用可能是正常的。展开查看后端已脱敏的参数与结果。">
      {toolCalls.length === 0 ? <Empty title="没有工具调用记录" /> : <div className="list">{toolCalls.map((call: any) => <div className="list-item" key={call.id}>
        <Badge tone={call.ok ? 'ok' : 'bad'}>{call.ok ? '成功' : '失败'}</Badge><div className="li-main"><div className="li-title">{call.name}{operation(call.arguments) ? ` · ${operation(call.arguments)}` : ''}</div><div className="li-sub">{fmtDateTime(call.at)} · {fmtDuration(call.durationMs)}{call.error ? ` · ${truncate(call.error, 300)}` : ''}</div><details><summary>调用摘要</summary><div className="li-sub">参数字段：{call.arguments && typeof call.arguments === 'object' ? Object.keys(call.arguments).slice(0, 15).join('、') || '无' : '未记录'} · 结果：{resultSummary(call.result)}</div><div className="li-sub">已脱敏参数</div><Code>{JSON.stringify(call.arguments ?? null,null,2)}</Code><div className="li-sub">已脱敏结果</div><Code>{JSON.stringify(call.result ?? null,null,2)}</Code></details></div>
      </div>)}</div>}
    </Card>
    <Card title="结果与归档"><KV items={[
      { label: '输出摘要', value: run.outputText ? truncate(run.outputText, 500) : '未记录' },
      { label: '归档', value: archive ? '已找到归档记录' : '未找到归档记录' },
    ]} /></Card>
  </>;
}


