import React, { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../lib';
import { Button, Card, Field, Toggle, navigate, useApi, useToast } from '../ui';
import ExistingConversationPicker from './ExistingConversationPicker';

export default function TaskConversation({ task, onPending }: { task: any; onPending: (value: boolean) => void }) {
  const list = useApi<any>('/api/conversations?limit=500');
  const toast = useToast();
  const [choice, setChoice] = useState(task.conversationMode === 'reuse' ? (task.conversationId ? 'existing' : 'fixed') : task.conversationMode);
  const [id, setId] = useState<string | null>(task.conversationId);
  const [query, setQuery] = useState('');
  const [name, setName] = useState(`${task.name}的会话`);
  const [archive, setArchive] = useState(task.archivePolicy?.conversation ?? 'keep');
  const [continuity, setContinuity] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(task.conversationId);
  const selected = list.data?.conversations.find((c: any) => c.id === id);
  useEffect(() => { setContinuity(selected?.meta?.continuity?.enabled === true); }, [id, selected?.meta?.continuity?.enabled]);
  const pending = choice === 'existing' && (!id || !selected || selected.archivedAt);
  useEffect(() => { onPending(Boolean(pending || busy)); }, [pending, busy]);
  const label = (c: any) => c.title || c.peerLabel || `未命名会话（${fmtDateTime(c.createdAt)}）`;
  const save = async () => {
    setBusy(true);
    try {
      const result = await api<any>(`/api/tasks/${task.id}/conversation`, { method: 'PATCH', body: {
        mode: choice, conversationId: id, title: name, continuity,
        archive: choice === 'new' ? archive : 'keep',
      } });
      setId(result.task.conversationId); setSaved(result.task.conversationId);
      if (choice === 'fixed') setChoice('existing');
      await list.reload();
      toast('会话设置已保存，下次运行生效', 'ok');
    } catch (error) { toast((error as Error).message, 'bad'); }
    finally { setBusy(false); }
  };
  return <Card title="任务会话" subtitle="先选在哪里聊，再设置下方触发。会话设置单独保存；正在运行的任务保持原配置。">
    <div className="stack">
      <Field label="会话使用方式"><select value={choice} onChange={e => { setChoice(e.target.value); setId(null); setContinuity(false); }}>
        <option value="per-peer">跟随消息来源</option><option value="existing">选择已有会话</option>
        <option value="fixed">新建固定会话</option><option value="new">每次新建独立会话</option>
      </select></Field>
      <div className="li-sub">{{ 'per-peer': '回复进入消息来源的会话；不同来源分别保留上下文。', existing: '按名称找到要接着聊的会话，保存后任务会在那里继续。', fixed: '输入名称并保存，立即创建固定会话；以后每次任务都在这里继续。', new: '每次运行从空白会话开始，适合互不相关的一次性任务。' }[choice as string]}</div>
      {choice === 'existing' && <>
        <ExistingConversationPicker conversations={list.data?.conversations} loading={list.loading} error={list.error} retry={() => void list.reload()} id={id} query={query} setQuery={setQuery} onSelect={setId} onFixed={() => { setChoice('fixed'); setId(null); setContinuity(false); }} />
      </>}
      {choice === 'fixed' && <Field label="会话名称"><input value={name} onChange={e => setName(e.target.value)} /></Field>}
      {(choice === 'fixed' || (choice === 'existing' && selected && !selected.archivedAt)) && <>
        <Toggle checked={continuity} onChange={setContinuity} label="长期会话：接近容量时自动摘要接续" />
        <div className="li-sub">随会话设置一起保存。摘要会调用模型并可能产生费用；历史记录保留，摘要可能遗漏细节。共享此会话的任务也使用这一设置。</div>
      </>}
      {choice === 'new' && <Field label="运行成功后"><select value={archive} onChange={e => setArchive(e.target.value)}><option value="keep">保留会话，稍后可查看或继续</option><option value="on-success">归档会话（保留历史）</option></select></Field>}
      {(pending || (choice === 'fixed' && !name.trim())) && <div role="status" className="error-text">暂不能保存：{pending ? '还没有选择可用会话。请选中一项，或改为新建固定会话。' : '请填写会话名称。'}</div>}
      <div className="row"><Button onClick={() => void save()} disabled={busy || Boolean(pending) || (choice === 'fixed' && !name.trim())}>{busy ? '保存中…' : choice === 'fixed' ? '创建并绑定会话' : '保存会话设置'}</Button>
        {id && id === saved && selected && !selected.archivedAt && <Button variant="ghost" onClick={() => navigate(`/conversations/${encodeURIComponent(id)}`)}>打开会话：{label(selected)}</Button>}
      </div>
    </div>
  </Card>;
}
