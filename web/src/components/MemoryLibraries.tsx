import React, { useState } from 'react';
import { api } from '../lib';
import { Badge, Button, Card, Code, Empty, ErrorBox, Field, Loading, Toggle, useApi, useToast } from '../ui';

export interface MemoryLibrary {
  id: string; name: string; adapter: string; enabled: boolean; retrieval: boolean; retrievalSupported?: boolean; autoWrite: boolean; readOnly: boolean;
  counts: { memories: number; edges: number; documents: number }; status: string; diagnostic?: string; path: string;
  usage: Array<{ id: string; name: string }>;
}
export interface MemoryLibraryList { libraries: MemoryLibrary[]; contexts?: Array<{ id: string; name: string }> }

function LibraryPath({ lib, busy, onSave }: { lib: MemoryLibrary; busy: boolean; onSave: (path: string) => void }) {
  const [path, setPath] = useState(lib.path);
  return <Field label="库文件路径" help={lib.id === 'personal' ? '个人库路径由应用管理。停用会暂停使用并保留记录。' : '修改路径会重新检测并连接此库；原文件保留。'}>
    <input aria-label={lib.name + '文件路径'} value={path} disabled={busy || lib.id === 'personal'} onChange={e => setPath(e.target.value)} />
    {lib.id !== 'personal' && <Button size="small" disabled={busy || !path.trim() || path.trim() === lib.path} onClick={() => onSave(path.trim())}>保存路径</Button>}
  </Field>;
}

/** Explicit selection preserves [] as no access; absence alone means personal. */
export function MemoryLibrarySelection({ value, onChange }: { value: string[] | undefined; onChange: (ids: string[] | undefined) => void }) {
  const list = useApi<MemoryLibraryList>('/api/memory-libraries');
  const ids = value ?? ['personal'];
  return <Field label="允许检索的长期记忆库" help="未设置时仅使用个人库；自选空列表表示不允许检索任何库。勾选后仍须保存方案。库本身也须启用并允许检索。">
    <select aria-label="长期记忆库授权方式" value={value === undefined ? 'default' : 'custom'} onChange={e => onChange(e.target.value === 'default' ? undefined : [...ids])}>
      <option value="default">默认：仅个人库</option><option value="custom">自选库</option>
    </select>
    {list.error ? <ErrorBox error={list.error} /> : !list.data ? <Loading /> : list.data.libraries.map(lib => <label key={lib.id} style={{ display: 'block', marginTop: 8 }}>
      <input type="checkbox" checked={ids.includes(lib.id)} onChange={e => onChange(e.target.checked ? [...ids, lib.id] : ids.filter(id => id !== lib.id))} /> {lib.name}{!lib.enabled ? '（停用）' : !lib.retrieval ? '（检索关闭）' : ''}
    </label>)}
    {value?.filter(id => !list.data?.libraries.some(l => l.id === id)).map(id => <label key={id} style={{ display: 'block' }}><input type="checkbox" checked onChange={() => onChange(value.filter(v => v !== id))} /> {id}（当前不可用）</label>)}
    <a href="#/memory">管理长期记忆库</a>
  </Field>;
}

export default function MemoryLibraries() {
  const list = useApi<MemoryLibraryList>('/api/memory-libraries');
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [saved, setSaved] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  const [searchIds, setSearchIds] = useState<string[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const toast = useToast();
  const act = async (work: () => Promise<void>) => { setBusy(true); setError(null); try { await work(); } catch (e) { setError(e as Error); } finally { setBusy(false); } };
  const patch = (lib: MemoryLibrary, values: any) => act(async () => { await api('/api/memory-libraries/' + encodeURIComponent(lib.id), { method: 'PATCH', body: values }); await list.reload(); });
  const authorize = (lib: MemoryLibrary, contextId: string, enabled: boolean) => act(async () => {
    const { context } = await api<any>('/api/contexts/' + encodeURIComponent(contextId));
    const search = context.config.databaseSearch ?? {};
    const ids: string[] = search.libraryIds ?? ['personal'];
    await api('/api/contexts/' + encodeURIComponent(contextId), { method: 'PATCH', body: {
      config: { ...context.config, databaseSearch: { ...search, libraryIds: enabled ? Array.from(new Set([...ids, lib.id])) : ids.filter(id => id !== lib.id) } },
      expectedVersion: context.currentVersion, note: '更新长期记忆库授权',
    } });
    await list.reload(); toast('上下文授权已保存，下次运行生效；上下文检索开关保持原设置', 'ok');
  });
  if (list.error) return <ErrorBox error={list.error} onRetry={() => void list.reload()} />;
  if (!list.data) return <Loading label="正在读取长期记忆库…" />;
  const libraries = list.data.libraries;
  return <Card title="长期记忆库" subtitle="统一管理个人记忆与外部资料。导入后先保存到库；只有获授权的上下文才会使用它。" actions={<Button size="small" variant="quiet" onClick={() => void list.reload()}>刷新</Button>}>
    <form onSubmit={e => { e.preventDefault(); void act(async () => { setPreview(await api('/api/memory-libraries/preview', { method: 'POST', body: { path: path.trim() } })); }); }}>
      <Field label="导入文件路径" help="输入本机个人记忆 SQLite 或外部库 manifest.json 路径，系统自动识别。"><input value={path} onChange={e => { setPath(e.target.value); setPreview(null); setSaved(null); }} placeholder="E:/data/memory.sqlite 或 E:/data/manifest.json" /></Field>
      <Button disabled={busy || !path.trim()} onClick={() => void act(async () => { setPreview(await api('/api/memory-libraries/preview', { method: 'POST', body: { path: path.trim() } })); })}>检查文件</Button>
    </form>
    {preview && <div className="notice" style={{ marginTop: 12 }}>
      <b>{preview.type === 'owned' ? '个人记忆文件 → 合并到个人库' : `外部只读库 → ${preview.name ?? '新增资料库'}`}</b>
      {preview.type === 'owned' && <p>待新增：记忆 {preview.added?.memories ?? 0} · 关系 {preview.added?.memory_edges ?? 0} · 文档 {preview.added?.memory_documents ?? 0}。跳过重复：{Object.values(preview.skipped ?? {}).reduce<number>((sum, n) => sum + Number(n), 0)} 条。冲突：{preview.conflicts?.length ?? 0} 条（保留现有记录）。</p>}
      <p>{preview.existing ? '此库已安装。' : '确认导入后保存到长期记忆库，再按需授权上下文。'}</p>
      <details><summary>查看导入预览</summary><Code>{JSON.stringify(preview, null, 2)}</Code></details>
      <Button disabled={busy} onClick={() => void act(async () => { const result = await api<any>('/api/memory-libraries/import', { method: 'POST', body: { path: path.trim() } }); setSaved(result); setPreview(null); await list.reload(); toast('已保存到长期记忆库', 'ok'); })}>确认导入</Button>
    </div>}
    {saved && <div className="notice" role="status" style={{ marginTop: 12 }}>
      <b>{saved.undone ? '本批导入已撤销。' : '已保存到长期记忆库。'}</b>
      {!saved.undone && <>下方「使用处与策略」可查看尚未授权的上下文并直接选择使用；导入不会修改上下文授权。{saved.type === 'owned' && <p>本次内容已合并到个人库；已授权个人库的上下文下次检索即可使用。</p>}</>}
      {saved.batchId && !saved.undone && <Button size="small" variant="quiet" disabled={busy} onClick={() => { if (window.confirm('撤销本批导入？仅移除导入后尚未修改的新增记录，原文件保留。')) void act(async () => { const result = await api('/api/memory-libraries/batches/' + encodeURIComponent(saved.batchId) + '/undo', { method: 'POST', body: {} }); setSaved({ ...result, undone: true }); await list.reload(); }); }}>撤销本批导入</Button>}
      <details><summary>导入结果</summary><Code>{JSON.stringify(saved, null, 2)}</Code></details>
    </div>}
    {error && <ErrorBox error={error} />}
    <div className="list" style={{ marginTop: 20 }}>
      {libraries.map(lib => <div key={lib.id} className="ledger-row" style={{ padding: '14px 0' }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}><strong>{lib.name}</strong><Badge tone={lib.enabled ? 'ok' : 'muted'}>{lib.enabled ? '已启用' : '已停用'}</Badge><span className="li-sub">{({ready:'可用',disabled:'已停用',error:'连接失败'} as Record<string,string>)[lib.status] ?? lib.status}{lib.readOnly ? ' · 只读' : ''}</span><span className="li-sub">记忆 {lib.counts?.memories ?? 0} · 关系 {lib.counts?.edges ?? 0} · 文档 {lib.counts?.documents ?? 0}</span></div>
        {lib.diagnostic && <div className="notice bad">{lib.diagnostic}</div>}
        <div className="li-sub" style={{ overflowWrap: 'anywhere', margin: '6px 0' }}>{lib.path}</div>
        <div className="li-sub">已授权：{lib.usage.length ? lib.usage.map(c => <a key={c.id} href={'#/contexts/' + encodeURIComponent(c.id)} style={{ marginRight: 10 }}>{c.name}</a>) : '尚未用于任何上下文'}</div>
        <div className="row" style={{ gap: 12, marginTop: 10, flexWrap: 'wrap' }}><Toggle checked={lib.enabled} disabled={busy} label="启用" onChange={enabled => void patch(lib, { enabled })} /><Button size="small" variant="quiet" onClick={() => setExpanded(expanded === lib.id ? null : lib.id)}>使用处与策略</Button>{lib.id !== 'personal' && <Button size="small" variant="quiet" disabled={busy} onClick={() => { if (window.confirm(`移除「${lib.name}」？原始文件会保留。`)) void act(async () => { await api('/api/memory-libraries/' + encodeURIComponent(lib.id), { method: 'DELETE' }); await list.reload(); }); }}>移除（保留文件）</Button>}</div>
        {expanded === lib.id && <div className="stack" style={{ marginTop: 12 }}>
          <LibraryPath key={lib.path} lib={lib} busy={busy} onSave={path => void patch(lib, { path })} />
          <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}><Toggle label="允许检索" checked={lib.retrieval} disabled={busy || lib.retrievalSupported === false} onChange={retrieval => void patch(lib, { retrieval })} /><Toggle label={lib.readOnly ? '允许自动积累（外部只读库不可用）' : '允许自动积累'} checked={lib.autoWrite} disabled={busy || lib.readOnly} onChange={autoWrite => void patch(lib, { autoWrite })} /></div>
          {lib.retrievalSupported === false && <div className="li-sub">此适配器目前支持高级查询。可在工具目录中查看查询操作与授权。</div>}
          <div className="li-sub">授权上下文（保存后下次运行生效；其检索开关须开启）：</div>
          {(list.data?.contexts ?? []).map(c => <label key={c.id}><input type="checkbox" disabled={busy} checked={lib.usage.some(u => u.id === c.id)} onChange={e => void authorize(lib, c.id, e.target.checked)} /> {c.name} <a href={'#/contexts/' + encodeURIComponent(c.id)}>查看配置</a>{!lib.usage.some(u => u.id === c.id) ? ' · 尚未使用此库' : ''}</label>)}
          <details><summary>技术信息</summary><code>{lib.id} · {lib.adapter}</code></details>
        </div>}
      </div>)}
      {!libraries.length && <Empty title="暂无长期记忆库" />}
    </div>
    <details style={{ marginTop: 20 }}><summary>跨库检索测试</summary>
      <Field label="检索问题"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="输入关键词或问题" /></Field>
      <div className="li-sub">{searchIds === null ? '默认检索所有可用库' : `已选 ${searchIds.length} 个库`}；测试结果不等于某个上下文的实际授权。</div>
      {libraries.map(lib => <label key={lib.id} style={{ marginRight: 14 }}><input type="checkbox" checked={(searchIds ?? libraries.map(l => l.id)).includes(lib.id)} onChange={e => { const ids = searchIds ?? libraries.map(l => l.id); setSearchIds(e.target.checked ? [...ids, lib.id] : ids.filter(id => id !== lib.id)); }} /> {lib.name}</label>)}
      <Button disabled={busy || !query.trim()} onClick={() => void act(async () => { const result = await api<any>('/api/memory-libraries/search', { method: 'POST', body: { query, libraryIds: searchIds ?? libraries.map(l => l.id), limit: 20 } }); setHits(result.hits); })}>检索</Button>
      {hits?.map((hit, index) => <div key={index} className="ledger-row"><Badge tone="muted">{hit.libraryName ?? hit.libraryId ?? hit.sourceId ?? '个人库'}</Badge><p style={{ whiteSpace: 'pre-wrap' }}>{hit.text ?? hit.content ?? hit.snippet ?? hit.title ?? JSON.stringify(hit)}</p><details><summary>来源与评分</summary><Code>{JSON.stringify(hit, null, 2)}</Code></details></div>)}
      {hits?.length === 0 && <Empty title="没有命中" />}
    </details>
  </Card>;
}
