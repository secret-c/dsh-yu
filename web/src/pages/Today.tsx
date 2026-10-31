import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtDuration, fmtRelative, fmtTime, labelOfStatus, shiftDay, todayKey, toneOfStatus, truncate, TASK_KIND } from '../lib';
import { Timeline } from '../components/Timeline';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  KV,
  Loading,
  PageHead,
  Spinner,
  Stat,
  navigate,
  useApi,
  usePolling,
  useToast,
} from '../ui';

interface Overview {
  date: string;
  timezone: string;
  now: number;
  stats: {
    tasksEnabled: number;
    tasksTotal: number;
    runsToday: number;
    succeeded: number;
    failed: number;
    active: number;
    queued: number;
    pendingMemory: number;
  };
  active: Run[];
  recent: Run[];
  conversations: Conv[];
  pending: Pending[];
  timeline: { date: string; hours: Array<{ planned: any[]; actual: any[]; listening: any[] }> };
  watch: Array<{
    taskId: string;
    taskName: string;
    kind: 'message' | 'group';
    label: string;
    lastFiredAt: number | null;
    buffered?: number | null;
    lastMessageAt?: number | null;
  }>;
  nextUpcoming: Array<{ taskId: string; taskName: string; at: number; label: string }>;
}

interface Run {
  id: string;
  taskId: string | null;
  taskName: string;
  taskKind: string;
  status: string;
  phase: string;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  outputText: string;
  errorCode: string | null;
  errorMessage: string | null;
  triggerReason: string;
  archiveDone: boolean;
  memoryDone: boolean;
}

interface Conv {
  id: string;
  title: string;
  kind: string;
  updatedAt: number;
  messageCount: number;
}

interface Pending {
  kind: string;
  severity: 'info' | 'warn' | 'error';
  title: string;
  detail: string;
  action?: { label: string; href: string };
}

export function Today() {
  const [date, setDate] = useState(todayKey());
  const [stopping, setStopping] = useState<string | null>(null);
  const toast = useToast();
  const overview = useApi<Overview>(`/api/overview?date=${date}`);
  const reload = overview.reload;

  usePolling(() => void reload(), 12_000);

  const data = overview.data;

  const stop = async (runId: string) => {
    setStopping(runId);
    try {
      await api(`/api/runs/${runId}/stop`, { method: 'POST', body: {} });
      toast('已请求停止，正在取消当前模型请求', 'warn');
      await reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setStopping(null);
    }
  };

  return (
    <>
      <PageHead
        eyebrow="今日"
        title="今天在做什么"
        description="时间轴区分计划、实际执行与持续监听。所有时间按 Yu 配置的时区（Asia/Shanghai）显示。"
        actions={
          <div className="row">
            <Button variant="ghost" size="small" onClick={() => setDate(shiftDay(date, -1))}>
              ‹ 前一天
            </Button>
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value || todayKey())}
              style={{ width: 150 }}
              aria-label="选择日期"
            />
            <Button variant="ghost" size="small" onClick={() => setDate(shiftDay(date, 1))}>
              后一天 ›
            </Button>
            <Button variant="quiet" size="small" onClick={() => setDate(todayKey())}>
              今天
            </Button>
          </div>
        }
      />

      {overview.error && <ErrorBox error={overview.error} onRetry={() => void reload()} />}

      {data && (
        <>
          <div className="grid four" style={{ marginTop: overview.error ? 16 : 0 }}>
            <Card>
              <Stat
                label="正在执行"
                value={data.stats.active}
                note={data.stats.queued ? `${data.stats.queued} 个排队中` : '没有排队'}
              />
            </Card>
            <Card>
              <Stat
                label="今日运行"
                value={data.stats.runsToday}
                note={`成功 ${data.stats.succeeded} · 失败 ${data.stats.failed}`}
              />
            </Card>
            <Card>
              <Stat label="已启用任务" value={data.stats.tasksEnabled} note={`共 ${data.stats.tasksTotal} 个任务`} />
            </Card>
            <Card>
              <Stat
                label="待吸收归档"
                value={data.stats.pendingMemory}
                note={data.stats.pendingMemory ? '可在记忆页手动维护' : '记忆已同步'}
              />
            </Card>
          </div>

          {data.active.length > 0 && (
            <Card title="正在执行" subtitle="同一对话串行；不同对话可并行" className="card" >
              <div className="list">
                {data.active.map((run) => (
                  <div className="list-item" key={run.id}>
                    <Spinner />
                    <div className="li-main">
                      <div className="li-title">
                        {run.taskName}
                        <Badge tone="accent">{labelOfStatus(run.status)}</Badge>
                        <span className="tag">{run.phase}</span>
                      </div>
                      <div className="li-sub">
                        {run.triggerReason} · 开始 {fmtTime(run.startedAt)} · 已运行{' '}
                        {fmtDuration((data.now ?? Date.now()) - (run.startedAt ?? data.now))}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="small"
                      disabled={stopping === run.id || run.status === 'stopping'}
                      onClick={() => void stop(run.id)}
                    >
                      {run.status === 'stopping' ? '停止中…' : '停止'}
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card
            title="时间轴"
            subtitle={`${data.date} · 一条 0—24 点的时间线：标记指向时刻，色条代表运行占用的时段`}
            actions={
              <Button variant="quiet" size="small" onClick={() => void reload()}>
                刷新
              </Button>
            }
          >
            <Timeline
              data={data.timeline as any}
              onOpenTask={(taskId) => navigate(`/tasks/${taskId}`)}
              onOpenRun={(run) => navigate(`/runs/${encodeURIComponent(run.runId)}`)}
            />
          </Card>

          <div className="grid two" style={{ marginTop: 16 }}>
            <Card title="待处理问题" subtitle="按影响排序，点击直达修改位置">
              {data.pending.length === 0 ? (
                <Empty title="没有需要处理的问题" hint="配置与连接都正常。" />
              ) : (
                <div className="list">
                  {data.pending.map((item, index) => (
                    <div className="list-item" key={index}>
                      <Badge tone={item.severity === 'error' ? 'bad' : item.severity === 'warn' ? 'warn' : 'accent'}>
                        {item.severity === 'error' ? '阻塞' : item.severity === 'warn' ? '注意' : '提示'}
                      </Badge>
                      <div className="li-main">
                        <div className="li-title">{item.title}</div>
                        <div className="li-sub">{item.detail}</div>
                      </div>
                      {item.action && (
                        <Button variant="ghost" size="small" onClick={() => navigate(item.action!.href)}>
                          {item.action.label}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="接下来" subtitle="按下次触发时间排序">
              {data.nextUpcoming.length === 0 ? (
                <Empty title="没有已排定的定时触发" hint="在任务页给任务添加一个每日触发。" />
              ) : (
                <div className="list">
                  {data.nextUpcoming.map((item, index) => (
                    <div className="list-item" key={index}>
                      <div className="li-main">
                        <div className="li-title">{item.taskName}</div>
                        <div className="li-sub">{item.label}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{fmtRelative(item.at)}</div>
                        <div className="li-sub">{fmtTime(item.at)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {data.watch.length > 0 && (
                <>
                  <div className="caption" style={{ marginTop: 14, padding: 0 }}>
                    持续监听
                  </div>
                  <div className="list">
                    {data.watch.map((item, index) => (
                      <div className="list-item" key={index}>
                        <span className="dot ok" style={{ marginTop: 7 }} />
                        <div className="li-main">
                          <div className="li-title">
                            {item.taskName}
                            {item.kind === 'group' && <span className="tag">群聊</span>}
                          </div>
                          <div className="li-sub">
                            {item.label}
                            {item.kind === 'group' && item.buffered != null
                              ? ` · 缓存 ${item.buffered} 条${
                                  item.lastMessageAt ? `，最近一条 ${fmtRelative(item.lastMessageAt)}` : ''
                                }`
                              : ''}
                            {' · '}最近触发 {item.lastFiredAt ? fmtRelative(item.lastFiredAt) : '从未'}
                          </div>
                        </div>
                        <Button variant="quiet" size="small" onClick={() => navigate(`/tasks/${item.taskId}`)}>
                          打开
                        </Button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>
          </div>

          <Card title="最近运行" subtitle="点击查看该任务的上下文快照与实际结果" className="card">
            {data.recent.length === 0 ? (
              <Empty
                title="今天还没有运行记录"
                hint="去「会话」发一条消息，或手动运行一个任务。"
                action={<Button onClick={() => navigate('/conversations')}>打开会话</Button>}
              />
            ) : (
              <div className="list">
                {data.recent.map((run) => (
                  <div className="list-item" key={run.id}>
                    <Badge tone={toneOfStatus(run.status)}>{labelOfStatus(run.status)}</Badge>
                    <div className="li-main">
                      <div className="li-title">
                        {run.taskName}
                        <span className="tag">{TASK_KIND[run.taskKind] ?? run.taskKind}</span>
                      </div>
                      <div className="li-sub">
                        {run.triggerReason} · {fmtTime(run.queuedAt)} · {truncate(run.outputText || run.errorMessage || '（无输出）', 90)}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 11.5, color: 'var(--muted)' }}>
                      <div>{fmtDuration(run.durationMs)}</div>
                      <div>
                        {run.archiveDone ? '已归档' : '未归档'} · {run.memoryDone ? '已吸收' : '待吸收'}
                      </div>
                    </div>
                    <Button
                      variant="quiet"
                      size="small"
                      onClick={() => navigate(`/runs/${encodeURIComponent(run.id)}`)}
                    >
                      查看
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {!data && overview.loading && <Loading label="正在读取今日概览…" />}
    </>
  );
}
