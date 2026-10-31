import React, { useEffect, useState } from 'react';
import { Field, navigate, useApi } from '../ui';
import ExistingConversationPicker, { BindingConversation } from './ExistingConversationPicker';

export default function ConversationBinding({ mode, id, onChange, onPending }: { mode: string; id: string | null; onPending: (pending: boolean) => void; onChange: (mode: string, id: string | null) => void }) {
  const list = useApi<{ conversations: BindingConversation[] }>('/api/conversations?limit=500');
  const [choosing, setChoosing] = useState(false);
  const [query, setQuery] = useState('');
  const choice = mode === 'reuse' ? (id || choosing ? 'existing' : 'fixed') : mode;
  const selected = list.data?.conversations.find(item => item.id === id);
  const pending = choice === 'existing' && (!selected || Boolean(selected.archivedAt));
  useEffect(() => { onPending(pending); }, [pending, onPending]);
  const changeChoice = (v: string) => { setChoosing(v === 'existing'); onPending(v === 'existing'); onChange(v === 'fixed' || v === 'existing' ? 'reuse' : v, null); };
  return <div className="stack">
    <div className="notice">选择已有或固定会话会共享上下文信息。消息触发只回复消息来源；定时和手动运行默认仅记录在会话中。</div><Field label="任务会话" help="保存后影响后续运行；正在运行的任务保持原配置。模型上下文有限。固定会话首次创建后可打开会话启用摘要接续。">
      <select aria-label="任务会话" value={choice} onChange={e => changeChoice(e.target.value)}>
        <option value="per-peer">跟随消息来源</option><option value="existing">选择已有会话</option><option value="fixed">新建固定会话（首次运行时创建）</option><option value="new">每次新建独立会话</option>
      </select>
    </Field>
    {choice === 'existing' && <ExistingConversationPicker conversations={list.data?.conversations} loading={list.loading} error={list.error} retry={() => void list.reload()} id={id} query={query} setQuery={setQuery} onSelect={value => { onPending(!value); onChange('reuse', value); }} onFixed={() => changeChoice('fixed')} />}
    {id && mode === 'reuse' && <button type="button" className="btn quiet" onClick={() => navigate(`/conversations/${encodeURIComponent(id)}`)}>打开会话：{selected?.title || id}</button>}
  </div>;
}
