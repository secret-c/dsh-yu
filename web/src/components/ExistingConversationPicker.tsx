import React from 'react';
import { Button, Field } from '../ui';

export interface BindingConversation { id: string; title?: string; peerLabel?: string; sessionId?: string | null; archivedAt?: number | null }
export default function ExistingConversationPicker({ conversations, loading, error, retry, id, query, setQuery, onSelect, onFixed }: {
  conversations?: BindingConversation[]; loading: boolean; error: unknown; retry: () => void; id: string | null; query: string;
  setQuery: (value: string) => void; onSelect: (id: string | null) => void; onFixed: () => void;
}) {
  const available = (conversations ?? []).filter(c => !c.archivedAt);
  const search = query.trim().toLowerCase();
  const matches = available.filter(c => `${c.title ?? ''} ${c.peerLabel ?? ''} ${c.id} ${c.sessionId ?? ''}`.toLowerCase().includes(search));
  const selected = available.find(c => c.id === id);
  // Keep the explicit selection visible even if a later search excludes it.
  const options = selected && !matches.some(c => c.id === id) ? [selected, ...matches] : matches;
  return <>
    <Field label="搜索会话" help="搜索只筛选列表，不会选中会话。范围为 Yu 最近 500 个会话；可按名称、Yu 会话 ID 或已绑定的会话 session ID 查找。Harness 中独立创建的会话不在此列表。">
      <input aria-label="搜索会话" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索名称、Yu ID 或已绑定的 session ID" />
    </Field>
    <Field label="已有会话" error={!selected ? (id ? '原会话不可用，请重新选择。' : '还没有选择会话，请从下拉列表选中一项。') : undefined}>
      <select aria-label="已有会话" value={id ?? ''} onChange={e => onSelect(e.target.value || null)}>
        <option value="">请选择会话</option>
        {options.map(c => <option key={c.id} value={c.id}>{c.title || c.peerLabel || '未命名会话'} · {c.id}</option>)}
        {id && !selected && <option value={id}>原会话不可用，请重新选择</option>}
      </select>
    </Field>
    {loading && !conversations && <div role="status">正在读取会话…</div>}
    {error ? <div className="notice warn">会话列表读取失败。<Button variant="quiet" onClick={retry}>重试</Button></div> : conversations && <>
      {!available.length && <div className="notice">还没有可用的 Yu 会话。可以新建固定会话，任务草稿会保留。</div>}
      {search && !matches.length && <div className="notice">当前 Yu 会话列表没有匹配项；输入的 ID 若只属于 Harness，不能直接绑定到任务。<Button variant="quiet" onClick={() => setQuery('')}>清除搜索</Button></div>}
    </>}
    <div><Button variant="quiet" onClick={onFixed}>改为新建固定会话</Button><span className="li-sub"> 保留任务名称、触发和其他已填内容。</span></div>
  </>;
}
