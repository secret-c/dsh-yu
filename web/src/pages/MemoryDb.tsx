import React, { useEffect, useState } from 'react';
import MemoryLibraries from '../components/MemoryLibraries';
import { api, fmtDateTime, fmtRelative, truncate } from '../lib';
import { Badge, Button, Card, Empty, ErrorBox, Field, KV, Loading, Modal, useApi, useToast } from '../ui';
import { KIND_COLORS, KindRing, MemoryCalendar, MemoryGraph, type MemoryEdge, type MemoryNode } from '../components/MemoryAtlas';

/**
 * The long-term half of memory, as a page.
 *
 * The five blocks are the short summary that gets injected; this is the database
 * behind them. The page is built around one question — "what does Yu actually
 * remember?" — so it opens with the picture of the whole store, then lets you
 * filter, read one entry, test retrieval with a real query, and see the ledger
 * of what retrieval literally fed to a prompt.
 */

interface MemoryStats {
  total: number;
  active: number;
  hits: number;
  oldest: number | null;
  newest: number | null;
  kinds: Array<{ kind: string; count: number; hits: number }>;
  subjects: Array<{ subject: string; count: number }>;
  subjectCount?: number;
  byDay: Array<{ day: string; count: number }>;
  recent: MemoryNode[];
}

interface RetrievalEntry {
  id: string;
  at: number;
  query: string;
  memoryIds: string[];
  runId: string | null;
}

export function MemoryDbTab() {
  return (
    <div className="memo-page">
      <PersonalMemoryBrowser />
      <MemoryLibraries />
    </div>
  );
}

function PersonalMemoryBrowser() {
  const db = useApi<{ items: MemoryNode[]; stats: MemoryStats; retrievals: RetrievalEntry[]; kinds: Record<string, string> }>(
    '/api/memory/db?limit=240',
  );
  const [kind, setKind] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<MemoryNode | null>(null);
  const [probe, setProbe] = useState<{ query: string; hits: MemoryNode[]; terms: string[] } | null>(null);
  const [probeQuery, setProbeQuery] = useState('今天的报纸有什么有趣的新闻');
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any | null>(null);
  // The list endpoint returns the newest N rows. Filtering those client-side
  // cannot find an older fact — which is what "明日方舟" looked like on an
  // install with 16k rows. A non-empty query goes to the database instead.
  const [remote, setRemote] = useState<MemoryNode[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<Error | null>(null);
  const [refresh, setRefresh] = useState(0);
  // The graph used to be a fixed "newest 240" picture while the list searched
  // the whole table — so a search looked like it changed nothing. Let the graph
  // follow the same filter (with its own debounce; layout is heavier than list).
  const [graphFilter, setGraphFilter] = useState<{ search: string; kind: string | null }>({
    search: '',
    kind: null,
  });
  const toast = useToast();

  useEffect(() => {
    const timer = window.setTimeout(() => setGraphFilter({ search: search.trim(), kind }), 280);
    return () => window.clearTimeout(timer);
  }, [search, kind]);

  const graphParams = new URLSearchParams({ limit: '240' });
  if (graphFilter.search) graphParams.set('search', graphFilter.search);
  if (graphFilter.kind) graphParams.set('kind', graphFilter.kind);
  const graph = useApi<{
    nodes: MemoryNode[];
    edges: MemoryEdge[];
    truncated: boolean;
    matched: number;
    search: string;
    kind: string | null;
  }>(`/api/memory/db/graph?${graphParams.toString()}`);

  const items = db.data?.items ?? [];
  const labels = db.data?.kinds ?? {};
  const stats = db.data?.stats ?? null;

  useEffect(() => {
    const needle = search.trim();
    if (!needle && !kind) {
      setRemote(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      const params = new URLSearchParams({ limit: '500' });
      if (needle) params.set('search', needle);
      if (kind) params.set('kind', kind);
      void api<{ items: MemoryNode[] }>(`/api/memory/db?${params.toString()}`, { signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return;
          setRemote(result.items);
          setSearchError(null);
        })
        .catch((error) => {
          if (controller.signal.aborted || (error as any)?.name === 'AbortError') return;
          setSearchError(error as Error);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 260);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [search, kind, refresh]);

  const filtered = remote ?? items;
  const filtering = Boolean(search.trim() || kind);

  const runProbe = async () => {
    if (!probeQuery.trim()) return;
    setBusy(true);
    try {
      const result = await api<{ query: string; hits: MemoryNode[]; terms: string[] }>('/api/memory/db/search', {
        method: 'POST',
        body: { query: probeQuery, limit: 8 },
      });
      setProbe(result);
    } catch (failure) {
      toast((failure as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const forget = async (node: MemoryNode) => {
    setBusy(true);
    try {
      await api(`/api/memory/db/${node.id}`, { method: 'DELETE' });
      toast('已移出长期记忆库（可恢复）', 'ok');
      setSelected(null);
      setRefresh((value) => value + 1);
      await Promise.all([db.reload(), graph.reload()]);
    } catch (failure) {
      toast((failure as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const importBlocks = async () => {
    setImporting(true);
    try {
      const result = await api<any>('/api/memory/db/import', { method: 'POST', body: {} });
      setImportResult(result);
      toast(`导入完成：新增 ${result.created} 条`, 'ok');
      setRefresh((value) => value + 1);
      await Promise.all([db.reload(), graph.reload()]);
    } catch (failure) {
      toast((failure as Error).message, 'bad');
    } finally {
      setImporting(false);
    }
  };

  if (db.error) return <ErrorBox error={db.error} onRetry={() => void db.reload()} />;
  if (!db.data || !stats) return <Loading label="正在读取长期记忆…" />;

  return (
    <div className="memo-page">
      <Card
        title="个人库条目与图谱"
        subtitle={
          <span>
            一条记忆 = 一句关于人、事或状态的事实。它不随短期记忆重建而消失，按相似度合并、按时间累积。
            {stats.newest ? ` 最近一条：${fmtRelative(stats.newest)}。` : ''}
          </span>
        }
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Badge tone="accent">共 {stats.active} 条</Badge>
            <Badge tone="muted">累计命中 {stats.hits}</Badge>
            <Button variant="ghost" size="small" disabled={importing} onClick={() => void importBlocks()}>
              {importing ? '导入中…' : '从短期记忆导入'}
            </Button>
          </div>
        }
      >
        {stats.active === 0 ? (
          <div className="notice" style={{ marginBottom: 14 }}>
            长期记忆库还是空的。维护任务的定时或手动运行可按长期策略筛选用户自述；也可点右上角
            「从短期记忆导入」，把已有短期记忆拆成条目。导入不会修改短期记忆本身。
          </div>
        ) : null}
        {importResult ? (
          <div className="notice" style={{ marginBottom: 14 }}>
            导入完成：新增 {importResult.created} 条，合并 {importResult.merged} 条。
            {importResult.blocks
              ?.filter((entry: any) => entry.candidates > 0)
              .map((entry: any) => `${entry.name} ${entry.created}/${entry.candidates}`)
              .join(' · ')}
          </div>
        ) : null}
        <div className="memo-top">
          <KindRing
            kinds={stats.kinds}
            labels={labels}
            total={stats.active}
            active={kind}
            onPick={(next) => setKind(next)}
          />          <div className="memo-cal-wrap">
            <div className="caption" style={{ padding: 0, marginBottom: 8 }}>
              记忆形成时间
            </div>
            <MemoryCalendar byDay={stats.byDay} />
            <div className="memo-subjects">
              {stats.subjects.slice(0, 8).map((entry) => (
                <button
                  key={entry.subject}
                  type="button"
                  className={`memo-chip${search === entry.subject ? ' active' : ''}`}
                  onClick={() => setSearch(search === entry.subject ? '' : entry.subject)}
                >
                  {entry.subject}
                  <b>{entry.count}</b>
                </button>
              ))}
            </div>
          </div>
          <div className="memo-facts">
            <KV
              items={[
                { label: '最早', value: stats.oldest ? fmtDateTime(stats.oldest) : '—' },
                { label: '最新', value: stats.newest ? fmtDateTime(stats.newest) : '—' },
                { label: '主体', value: `${stats.subjectCount ?? stats.subjects.length} 个` },
              ]}
            />
          </div>
        </div>

        <div className="memo-main">
          <div className="memo-graph-wrap">
            {graph.error ? (
              <ErrorBox error={graph.error} onRetry={() => void graph.reload()} />
            ) : graph.data ? (
              <>
                <div className="li-sub" style={{ padding: '0 4px 8px' }}>
                  {graph.data.search || graph.data.kind
                    ? `筛选图谱：匹配 ${graph.data.matched} 条；图中最多 160 个节点`
                    : `全库 ${stats.active} 条；图中最多 160 个节点，数据来自 memories / memory_edges`}
                </div>
                <MemoryGraph
                  nodes={graph.data.nodes}
                  edges={graph.data.edges}
                  selectedId={selected?.id ?? null}
                  onSelect={(node) => setSelected(node)}
                />
              </>
            ) : (
              <Loading label="正在布局…" />
            )}
            <div className="memo-graph-legend">
              {Object.entries(labels).map(([key, value]) => (
                <span key={key} className="memo-legend-inline">
                  <span className="memo-dot" style={{ background: KIND_COLORS[key] ?? '#6f8288' }} />
                  {value}
                </span>
              ))}
              <span className="muted">圆越大 = 被重复印证越多；连线 = 同一次材料里学到的</span>
            </div>
          </div>

          <div className="memo-list">
            <div className="memo-list-head">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="在全库中搜索文字 / 主体 / 标签"
                aria-label="搜索长期记忆"
              />
              {kind || search ? (
                <Button
                  variant="quiet"
                  size="small"
                  onClick={() => {
                    setKind(null);
                    setSearch('');
                  }}
                >
                  清除
                </Button>
              ) : null}
            </div>
            <div className="li-sub" style={{ padding: '0 4px 8px' }}>
              {filtering
                ? searching
                  ? '正在全库搜索…'
                  : `全库匹配 ${filtered.length} 条${filtered.length >= 500 ? '（最多显示 500 条）' : ''}`
                : `共 ${stats.active} 条；这里只列出最近 ${items.length} 条，输入关键词会搜索全库`}
            </div>
            {searchError ? (
              <ErrorBox error={searchError} />
            ) : filtered.length === 0 ? (
              searching ? (
                <Loading label="正在全库搜索…" />
              ) : (
                <Empty title="全库没有匹配的记忆" hint="换个词，或者先在维护里跑一次吸收。" />
              )
            ) : (
              <ul className="memo-items">
                {filtered.slice(0, 500).map((item) => (
                  <li key={item.id}>
                    <button type="button" className="memo-item" onClick={() => setSelected(item)}>
                      <span className="memo-dot" style={{ background: KIND_COLORS[item.kind] ?? '#6f8288' }} />
                      <span className="memo-item-body">
                        <span className="memo-item-text">{item.text}</span>
                        <span className="memo-item-meta">
                          {item.subject ? `${item.subject} · ` : ''}
                          {labels[item.kind] ?? item.kind} · 命中 {item.hits} · {fmtRelative(item.lastSeenAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>

      <Card
        title="检索测试"
        subtitle="这就是一次真实检索：同样的评分函数、同样会进入提示词的「长期记忆」小节。没有向量、没有改写，只看字面重合、重复印证与新鲜度。"
      >
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Field label="输入一句话，看会捞出哪些记忆">
              <input value={probeQuery} onChange={(event) => setProbeQuery(event.target.value)} placeholder="例如：明天的天气" />
            </Field>
          </div>
          <Button onClick={() => void runProbe()} disabled={busy || !probeQuery.trim()}>
            检索
          </Button>
        </div>
        {probe ? (
          probe.hits.length ? (
            <div className="memo-probe">
              <div className="memo-probe-terms">
                切词：{probe.terms.slice(0, 14).map((term) => <code key={term}>{term}</code>)}
              </div>
              <ol>
                {probe.hits.map((hit) => (
                  <li key={hit.id}>
                    <span className="memo-dot" style={{ background: KIND_COLORS[hit.kind] ?? '#6f8288' }} />
                    <span>{hit.text}</span>
                    <Badge tone="muted">{labels[hit.kind] ?? hit.kind}</Badge>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <Empty title="没有命中" hint="检索只认字面重合；换个更具体的词试试。" />
          )
        ) : null}
      </Card>

      <Card title="检索账本" subtitle="每次真实运行里，长期记忆实际被检索进了提示词，都会留一行。">
        {db.data.retrievals.length ? (
          <ul className="memo-ledger">
            {db.data.retrievals.map((entry) => (
              <li key={entry.id}>
                <span className="memo-ledger-time">{fmtDateTime(entry.at)}</span>
                <span className="memo-ledger-query">{truncate(entry.query, 60) || '（空查询）'}</span>
                <Badge tone="accent">{entry.memoryIds.length} 条</Badge>
                {entry.runId ? <code className="memo-ledger-run">{truncate(entry.runId, 18)}</code> : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="还没有检索记录" hint="下一次真实对话或任务运行后，这里会出现第一行。" />
        )}
      </Card>

      {selected ? (
        <Modal
          open
          title="这条记忆"
          subtitle="它是长期记忆库里的一行；短期记忆块只是它的摘要，不会因为这里删除而改变。"
          onClose={() => setSelected(null)}
          footer={
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="ghost" onClick={() => setSelected(null)}>
                关闭
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void forget(selected)}>
                移出记忆库
              </Button>
            </div>
          }
        >
          <KV
            items={[
              { label: '内容', value: <span style={{ whiteSpace: 'pre-wrap' }}>{selected.text}</span> },
              { label: '类型', value: labels[selected.kind] ?? selected.kind },
              { label: '主体', value: selected.subject || '—' },
              { label: '标签', value: selected.tags.length ? selected.tags.join('、') : '—' },
              { label: '命中次数', value: `${selected.hits} 次（每次合并 +1）` },
              { label: '权重', value: selected.weight.toFixed(2) },
              { label: '首次', value: fmtDateTime(selected.firstSeenAt) },
              { label: '最近', value: fmtDateTime(selected.lastSeenAt) },
              { label: '来源', value: selected.sourceArchiveId ? `归档 ${selected.sourceArchiveId}` : '手工 / 维护' },
              ...(selected.meta?.evidence ? [{label:'用户自述依据',value:<span style={{whiteSpace:'pre-wrap'}}>「{selected.meta.evidence.quote}」<br/>{selected.meta.evidence.title} {selected.meta.evidence.conversationId ? <a href={`#/conversations/${encodeURIComponent(selected.meta.evidence.conversationId)}`}>查看原会话</a> : `${selected.meta.evidence.sessionKey ?? ''} · 事件 ${selected.meta.evidence.eventSeq ?? ''}`}</span>}] : []),
            ]}
          />
        </Modal>
      ) : null}
    </div>
  );
}
