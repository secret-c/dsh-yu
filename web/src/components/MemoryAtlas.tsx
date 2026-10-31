import React, { useMemo, useState } from 'react';

/**
 * The long-term memory atlas.
 *
 * Three views of one dataset, chosen so that a year of running stays readable:
 *
 *   graph     — what relates to what (co-occurrence edges, radius by consolidation)
 *   calendar  — when it was learned (a year at a glance)
 *   kinds     — what it is made of
 *
 * No chart library: a deterministic force layout over a capped node count keeps
 * the bundle small and the result reproducible — the same database draws the
 * same picture on every reload.
 */

export const KIND_COLORS: Record<string, string> = {
  fact: '#137e7a',
  person: '#4a6fa5',
  event: '#8a5a8f',
  preference: '#b0813a',
  plan: '#4e8a5f',
};

export const KIND_ORDER = ['fact', 'person', 'event', 'preference', 'plan'];

export interface MemoryNode {
  id: string;
  kind: string;
  subject: string;
  text: string;
  tags: string[];
  hits: number;
  weight: number;
  firstSeenAt: number;
  lastSeenAt: number;
  degree?: number;
  sourceArchiveId?: string | null;
  meta?: {evidence?: {quote?:string;title?:string;conversationId?:string;sessionKey?:string;eventSeq?:number}};
}

export interface MemoryEdge {
  a: string;
  b: string;
  kind: string;
  weight: number;
}

/**
 * Deterministic force layout.
 *
 * Seeded on a circle rather than at random, then relaxed with repulsion,
 * spring links and a weak centring force. Bounded work: the caller caps nodes.
 */
export function layoutGraph(
  nodes: MemoryNode[],
  edges: MemoryEdge[],
  { width = 720, height = 460, iterations = 220 } = {},
) {
  const count = nodes.length;
  if (!count) return { points: [], links: [] };
  const cx = width / 2;
  const cy = height / 2;
  const ring = Math.min(width, height) * 0.34;
  const points = nodes.map((node, index) => {
    const angle = (index / count) * Math.PI * 2;
    const jitter = ((index * 2654435761) % 1000) / 1000;
    return {
      node,
      x: cx + Math.cos(angle) * ring * (0.6 + jitter * 0.5),
      y: cy + Math.sin(angle) * ring * (0.6 + jitter * 0.5),
      vx: 0,
      vy: 0,
    };
  });
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]));
  const links = edges
    .map((edge) => ({ a: indexOf.get(edge.a), b: indexOf.get(edge.b), weight: edge.weight }))
    .filter(
      (link): link is { a: number; b: number; weight: number } =>
        link.a !== undefined && link.b !== undefined && link.a !== link.b,
    );

  const area = width * height;
  const repulsion = Math.max(600, area / Math.max(8, count * 2.2));
  const damping = 0.82;

  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / iterations;
    for (let i = 0; i < count; i += 1) {
      const p = points[i];
      for (let j = i + 1; j < count; j += 1) {
        const q = points[j];
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) {
          dx = (i % 7) - 3;
          dy = (j % 5) - 2;
          dist2 = dx * dx + dy * dy + 0.01;
        }
        const force = repulsion / dist2;
        const dist = Math.sqrt(dist2);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        p.vx += fx;
        p.vy += fy;
        q.vx -= fx;
        q.vy -= fy;
      }
    }
    for (const link of links) {
      const p = points[link.a];
      const q = points[link.b];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ideal = 96;
      const force = (dist - ideal) * 0.035 * Math.min(2, link.weight);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      p.vx += fx;
      p.vy += fy;
      q.vx -= fx;
      q.vy -= fy;
    }
    for (const p of points) {
      p.vx += (cx - p.x) * 0.004;
      p.vy += (cy - p.y) * 0.004;
      p.vx *= damping;
      p.vy *= damping;
      p.x += p.vx * cooling;
      p.y += p.vy * cooling;
      // Stay inside the frame with a margin for the label.
      p.x = Math.max(34, Math.min(width - 34, p.x));
      p.y = Math.max(26, Math.min(height - 26, p.y));
    }
  }
  return { points, links };
}

export function radiusOf(node: MemoryNode): number {
  const hits = Math.max(1, node.hits ?? 1);
  const degree = node.degree ?? 0;
  return Math.min(13, 4.5 + Math.log2(hits) * 1.9 + Math.min(4, degree * 0.7));
}

/** A node caption: the subject if there is one, else the first clause. */
export function shortLabel(node: MemoryNode, max = 10): string {
  if (node.subject) return node.subject.slice(0, max);
  const firstClause = String(node.text ?? '').split(/[，。；：,;:]/)[0].trim();
  return (firstClause || String(node.text ?? '')).slice(0, max);
}

export function MemoryGraph({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  selectedId?: string | null;
  onSelect?: (node: MemoryNode | null) => void;
}) {
  const [hover, setHover] = useState<MemoryNode | null>(null);
  const capped = useMemo(() => nodes.slice(0, 160), [nodes]);
  const cappedEdges = useMemo(() => {
    const ids = new Set(capped.map((node) => node.id));
    return edges.filter((edge) => ids.has(edge.a) && ids.has(edge.b));
  }, [capped, edges]);
  const { points, links } = useMemo(() => layoutGraph(capped, cappedEdges), [capped, cappedEdges]);
  const labelled = useMemo(() => {
    // Greedy declutter: biggest nodes first, and a caption is dropped when it
    // would sit on top of one already placed. A dense cluster with nine
    // overlapping captions reads as noise; the hover card names every node.
    const placed: Array<{ x: number; y: number }> = [];
    const kept = new Map<string, number>();
    const candidates = [...points]
      .filter((point) => (point.node.degree ?? 0) > 0 || point.node.hits > 1)
      .sort((a, b) => radiusOf(b.node) - radiusOf(a.node));
    for (const point of candidates) {
      if (kept.size >= 9) break;
      const y = point.y > 240 ? point.y + radiusOf(point.node) + 13 : point.y - radiusOf(point.node) - 6;
      const tooClose = placed.some((other) => Math.abs(other.x - point.x) < 78 && Math.abs(other.y - y) < 22);
      if (tooClose) continue;
      placed.push({ x: point.x, y });
      kept.set(point.node.id, y);
    }
    return kept;
  }, [points]);

  if (!capped.length) {
    return <div className="memo-graph-empty">当前范围内还没有节点：维护任务吸收归档之后，这里会长出来。</div>;
  }

  return (
    <div className="memo-graph">
      <svg viewBox="0 0 720 460" role="img" aria-label="长期记忆关系图">
        <defs>
          <radialGradient id="memoGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(19,126,122,0.10)" />
            <stop offset="100%" stopColor="rgba(19,126,122,0)" />
          </radialGradient>
        </defs>
        <rect x="0" y="0" width="720" height="460" fill="url(#memoGlow)" rx="14" />
        {links.map((link, index) => {
          const p = points[link.a];
          const q = points[link.b];
          return (
            <line
              key={`${link.a}-${link.b}-${index}`}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              stroke="rgba(19,126,122,0.16)"
              strokeWidth={Math.min(2, 0.6 + link.weight * 0.25)}
            />
          );
        })}
        {points.map((point) => {
          const r = radiusOf(point.node);
          const color = KIND_COLORS[point.node.kind] ?? '#6f8288';
          const active = point.node.id === selectedId || point.node.id === hover?.id;
          return (
            <g
              key={point.node.id}
              className="memo-node"
              onMouseEnter={() => setHover(point.node)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect?.(point.node)}
            >
              <circle cx={point.x} cy={point.y} r={r + (active ? 3 : 0)} fill={color} fillOpacity={active ? 0.95 : 0.8} />
              <circle cx={point.x} cy={point.y} r={r + 4} fill="none" stroke={color} strokeOpacity={active ? 0.5 : 0.14} />
              {labelled.has(point.node.id) ? (
                <text
                  x={point.x}
                  y={labelled.get(point.node.id)}
                  textAnchor="middle"
                  className="memo-node-label"
                >
                  {shortLabel(point.node)}
                </text>
              ) : null}
              <title>{`${point.node.text}\n${point.node.kind} · ${point.node.hits} 次 · ${new Date(point.node.lastSeenAt).toLocaleDateString()}`}</title>
            </g>
          );
        })}
      </svg>
      {hover ? (
        <div className="memo-hover">
          <span className="memo-dot" style={{ background: KIND_COLORS[hover.kind] ?? '#6f8288' }} />
          <strong>{hover.subject || '（无主体）'}</strong>
          <span className="muted">{hover.text}</span>
        </div>
      ) : null}
      {nodes.length > capped.length ? (
        <div className="memo-graph-note">图中最多显示 {capped.length} 个节点；完整列表在右侧。</div>
      ) : null}
    </div>
  );
}

/** A year of memory formation, one square per day. */
export function MemoryCalendar({ byDay }: { byDay: Array<{ day: string; count: number }> }) {
  const cells = useMemo(() => {
    const map = new Map(byDay.map((entry) => [entry.day, entry.count]));
    const days: Array<{ day: string; count: number; date: Date }> = [];
    const today = new Date();
    for (let offset = 111; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      days.push({ day: key, count: map.get(key) ?? 0, date });
    }
    return days;
  }, [byDay]);
  const max = Math.max(1, ...cells.map((cell) => cell.count));
  return (
    <div className="memo-cal">
      <div className="memo-cal-grid">
        {cells.map((cell) => {
          const ratio = cell.count / max;
          const background =
            cell.count === 0 ? 'var(--line-2)' : `rgba(19, 126, 122, ${0.15 + ratio * 0.75})`;
          return (
            <span
              key={cell.day}
              className="memo-cal-cell"
              style={{ background }}
              title={`${cell.day}：${cell.count} 条`}
            />
          );
        })}
      </div>
      <div className="memo-cal-legend">
        <span className="muted">近 16 周</span>
        <span className="memo-cal-scale">
          少
          {[0.15, 0.35, 0.55, 0.75, 0.95].map((ratio) => (
            <i key={ratio} style={{ background: `rgba(19, 126, 122, ${ratio})` }} />
          ))}
          多
        </span>
      </div>
    </div>
  );
}

/** Composition by kind: a ring plus a legend that is also the filter. */
export function KindRing({
  kinds,
  labels,
  total,
  active,
  onPick,
}: {
  kinds: Array<{ kind: string; count: number }>;
  labels: Record<string, string>;
  total: number;
  active: string | null;
  onPick: (kind: string | null) => void;
}) {
  const sum = Math.max(1, total);
  const ordered = KIND_ORDER.map((kind) => ({
    kind,
    count: kinds.find((entry) => entry.kind === kind)?.count ?? 0,
  })).filter((entry) => entry.count > 0);
  let offset = 0;
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="memo-ring-wrap">
      <svg viewBox="0 0 120 120" className="memo-ring" role="img" aria-label="记忆构成">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--line-2)" strokeWidth="14" />
        {ordered.map((entry) => {
          const fraction = entry.count / sum;
          const dash = fraction * circumference;
          const circle = (
            <circle
              key={entry.kind}
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              stroke={KIND_COLORS[entry.kind] ?? '#6f8288'}
              strokeWidth={active === entry.kind ? 17 : 13}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
              strokeLinecap="butt"
              onClick={() => onPick(active === entry.kind ? null : entry.kind)}
              className="memo-ring-seg"
            />
          );
          offset += dash;
          return circle;
        })}
        <text x="60" y="57" textAnchor="middle" className="memo-ring-total">
          {total}
        </text>
        <text x="60" y="73" textAnchor="middle" className="memo-ring-caption">
          条
        </text>
      </svg>
      <ul className="memo-legend">
        {ordered.map((entry) => (
          <li key={entry.kind}>
            <button
              type="button"
              className={`memo-legend-item${active === entry.kind ? ' active' : ''}`}
              onClick={() => onPick(active === entry.kind ? null : entry.kind)}
            >
              <span className="memo-dot" style={{ background: KIND_COLORS[entry.kind] ?? '#6f8288' }} />
              {labels[entry.kind] ?? entry.kind}
              <b>{entry.count}</b>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
