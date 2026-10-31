import React, { useMemo, useState } from 'react';
import { fmtDuration, fmtTime, labelOfStatus } from '../lib';

/**
 * The day as one horizontal line.
 *
 * Three lanes share a single 0–24h axis: what was planned, what actually ran, and
 * what is listening continuously. Planned marks point at an instant, actual runs
 * occupy a segment (start → end), and listening is a band because it has no
 * position in time. A vertical "now" line only exists on today.
 */
export interface TimelinePlanned {
  triggerId: string;
  taskId: string;
  taskName: string;
  kind: string;
  at: string;
  minutes: number;
  nextFireAt: number | null;
  label: string;
  enabled?: boolean;
  triggerEnabled?: boolean;
}

export interface TimelineRun {
  runId: string;
  taskId: string | null;
  taskName: string;
  status: string;
  start: number;
  end: number;
  startMinutes: number;
  endMinutes: number;
  durationMs: number | null;
  triggerReason: string;
}

export interface TimelineListening {
  taskId: string;
  taskName: string;
  label: string;
  enabled?: boolean;
}

export interface TimelineData {
  date: string;
  timezone: string;
  planned: TimelinePlanned[];
  actual: TimelineRun[];
  listening: TimelineListening[];
  isToday: boolean;
  nowMinutes: number | null;
}

const TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

const statusTone = (status: string) =>
  status === 'succeeded'
    ? 'ok'
    : status === 'running' || status === 'stopping'
      ? 'running'
      : status === 'failed' || status === 'interrupted'
        ? 'bad'
        : 'idle';

const pct = (minutes: number) => `${Math.min(100, Math.max(0, (minutes / 1440) * 100))}%`;

export function Timeline({
  data,
  onOpenTask,
  onOpenRun,
}: {
  data: TimelineData;
  onOpenTask: (taskId: string) => void;
  onOpenRun: (run: TimelineRun) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);

  // Two label rows for planned marks: with a handful of daily triggers the simple
  // alternation removes almost every collision without a layout pass.
  const plannedRows = useMemo(() => {
    const sorted = [...data.planned].sort((a, b) => a.minutes - b.minutes);
    const rows: TimelinePlanned[][] = [[], []];
    let lastMinute = [-1e9, -1e9];
    for (const item of sorted) {
      let target = 0;
      if (Math.abs(item.minutes - lastMinute[0]) < 70) target = 1;
      if (Math.abs(item.minutes - lastMinute[1]) < 70) target = 0;
      rows[target].push(item);
      lastMinute[target] = item.minutes;
    }
    return rows;
  }, [data.planned]);

  const hasAnything = data.planned.length + data.actual.length + data.listening.length > 0;

  return (
    <div className="tl2">
      <div className="tl2-legend">
        <span className="tl2-key tl2-key-planned">计划</span>
        <span className="tl2-key tl2-key-ok">完成</span>
        <span className="tl2-key tl2-key-running">执行中</span>
        <span className="tl2-key tl2-key-bad">失败 / 中断</span>
        <span className="tl2-key tl2-key-listening">持续监听</span>
        <span className="tl2-key tl2-key-now">现在</span>
      </div>

      <div className="tl2-body">
        <div className="tl2-lane-label">监听</div>
        <div className="tl2-lane tl2-lane-listening">
          {data.listening.length === 0 ? (
            <span className="tl2-empty-inline">没有持续监听的触发</span>
          ) : (
            <div className="tl2-band">
              {data.listening.map((item) => (
                <button
                  key={`${item.taskId}-${item.label}`}
                  type="button"
                  className={`tl2-band-chip ${item.enabled === false ? 'tl2-band-chip-off' : ''}`}
                  onClick={() => onOpenTask(item.taskId)}
                  title={`${item.taskName} · ${item.label}`}
                >
                  {item.taskName}
                  <span className="tl2-band-sub">{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="tl2-lane-label">计划</div>
        <div className="tl2-lane tl2-lane-planned">
          <div className="tl2-axis-line" />
          {data.planned.length === 0 && <span className="tl2-empty-inline">没有排定的定时触发</span>}
          {plannedRows.map((row, rowIndex) =>
            row.map((item) => (
              <button
                key={item.triggerId}
                type="button"
                className={`tl2-mark ${rowIndex === 1 ? 'tl2-mark-below' : ''} ${
                  item.enabled === false || item.triggerEnabled === false ? 'tl2-mark-off' : ''
                }`}
                style={{ left: pct(item.minutes) }}
                onMouseEnter={() => setHover(item.triggerId)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onOpenTask(item.taskId)}
                title={`${item.taskName} · ${item.label}`}
              >
                <span className="tl2-mark-dot" />
                <span className="tl2-mark-stem" />
                <span className="tl2-mark-label">
                  {item.at} {item.taskName}
                </span>
              </button>
            )),
          )}
          {data.nowMinutes !== null && (
            <span className="tl2-now" style={{ left: pct(data.nowMinutes) }}>
              <span className="tl2-now-label">{fmtTime(Date.now())}</span>
            </span>
          )}
        </div>

        <div className="tl2-lane-label">实际</div>
        <div className="tl2-lane tl2-lane-actual">
          <div className="tl2-axis-line" />
          {data.actual.length === 0 && <span className="tl2-empty-inline">这一天没有运行记录</span>}
          {data.actual.map((run) => {
            const widthPct = ((run.endMinutes - run.startMinutes) / 1440) * 100;
            const tone = statusTone(run.status);
            return (
              <button
                key={run.runId}
                type="button"
                className={`tl2-run tl2-run-${tone}`}
                style={{ left: pct(run.startMinutes), width: `max(6px, ${widthPct}%)` }}
                onMouseEnter={() => setHover(run.runId)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onOpenRun(run)}
                title={`${run.taskName} · ${labelOfStatus(run.status)} · ${fmtTime(run.start)}–${fmtTime(run.end)}`}
              >
                {hover === run.runId && (
                  <span className="tl2-tip">
                    <strong>{run.taskName}</strong>
                    <span>
                      {fmtTime(run.start)}–{fmtTime(run.end)} · {labelOfStatus(run.status)}
                      {run.durationMs ? ` · ${fmtDuration(run.durationMs)}` : ''}
                    </span>
                    <span className="tl2-tip-sub">{run.triggerReason}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="tl2-lane-label tl2-lane-label-axis" />
        <div className="tl2-axis">
          {TICKS.map((hour) => (
            <span key={hour} className="tl2-tick" style={{ left: pct(hour * 60) }}>
              <span className="tl2-tick-line" />
              <span className="tl2-tick-text">{String(hour).padStart(2, '0')}:00</span>
            </span>
          ))}
        </div>
      </div>

      {!hasAnything && (
        <div className="tl2-empty">这一天没有安排，也没有运行记录。</div>
      )}
    </div>
  );
}
