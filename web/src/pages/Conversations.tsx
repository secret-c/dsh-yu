import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  fmtDateTime,
  fmtRelative,
  labelOfStatus,
  streamSse,
  truncate,
} from '../lib';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  KV,
  Loading,
  PageHead,
  Tabs,
  navigate,
  useApi,
  useToast,
} from '../ui';

interface ConversationArchives {
  count: number;
  absorbed: number;
  lastAt: number | null;
}

interface Conversation {
  id: string;
  title: string;
  kind: string;
  status: string;
  updatedAt: number;
  messageCount: number;
  peerLabel: string;
  sessionId: string | null;
  contextId: string | null;
  archivedAt: number | null;
  memorized?: boolean;
  hasSession?: boolean;
  archives?: ConversationArchives;
}

interface Message {
  id: string;
  role: string;
  text: string;
  at: number;
  meta?: any;
}

type Filter = 'active' | 'archived' | 'all';

const KIND_LABEL: Record<string, string> = {
  web: '网页',
  task: '任务',
  qq_private: 'QQ 私聊',
  qq_group: 'QQ 群聊',
  qq_official: 'QQ 官方',
  reading: '阅读',
};

export function Conversations({ id }: { id: string | null }) {
  const list = useApi<{ conversations: Conversation[] }>('/api/conversations?limit=200');
  const [activeId, setActiveId] = useState<string | null>(id);
  const [filter, setFilter] = useState<Filter>('active');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (id) setActiveId(id);
  }, [id]);

  const conversations = list.data?.conversations ?? [];
  const active = useMemo(() => conversations.filter((item) => !item.archivedAt), [conversations]);
  const archived = useMemo(() => conversations.filter((item) => Boolean(item.archivedAt)), [conversations]);
  const visible = filter === 'active' ? active : filter === 'archived' ? archived : conversations;

  useEffect(() => {
    if (activeId && !conversations.some((item) => item.id === activeId) && conversations.length) {
      setActiveId(conversations[0].id);
    }
  }, [activeId, conversations]);

  const select = (nextId: string) => {
    setActiveId(nextId);
    navigate(`/conversations/${nextId}`);
  };

  const mutate = async (path: string, body: unknown, message: string) => {
    setBusy(true);
    try {
      await api(path, { method: 'POST', body });
      toast(message, 'ok');
      await list.reload();
    } catch (failure) {
      toast((failure as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const archiveOld = async () => {
    const cutoff = Date.now() - 30 * 86_400_000;
    const ids = active.filter((item) => item.updatedAt < cutoff).map((item) => item.id);
    if (!ids.length) {
      toast('没有 30 天前的会话需要归档', 'info');
      return;
    }
    await mutate('/api/conversations/archive', { ids, archived: true }, `已归档 ${ids.length} 个；记忆吸收已排队`);
  };

  const memorizedCount = conversations.filter((item) => item.memorized).length;

  return (
    <>
      <PageHead
        eyebrow="会话"
        title="对话"
        description="网页对话直接使用真实 DSH Agent。归档会同时关掉 DSH 那边的物理会话：消息和已吸收的记忆都保留，但这个对话不会再接回旧会话——同一个人的下一条消息会开一个新的对话和新的上下文。"
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button variant="ghost" disabled={busy} onClick={() => void archiveOld()}>
              归档 30 天前
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setActiveId(null);
                navigate('/conversations');
              }}
            >
              新对话
            </Button>
          </div>
        }
      />

      {list.error && <ErrorBox error={list.error} onRetry={() => void list.reload()} />}

      <div className="chat-wrap">
        <Card
          title="会话"
          subtitle={`进行中 ${active.length} · 已归档 ${archived.length} · 其中 ${memorizedCount} 个已有内容进入记忆`}
        >
          <Tabs
            tabs={[
              { id: 'active', label: `进行中 ${active.length}` },
              { id: 'archived', label: `已归档 ${archived.length}` },
              { id: 'all', label: `全部 ${conversations.length}` },
            ]}
            active={filter}
            onChange={(next) => setFilter(next as Filter)}
          />

          {list.loading && !list.data ? (
            <Loading />
          ) : visible.length ? (
            <div className="conv-list">
              {visible.map((conversation) => (
                <div
                  key={conversation.id}
                  role="button"
                  tabIndex={0}
                  className={`conv-item conv-row ${conversation.id === activeId ? 'active' : ''}${
                    conversation.archivedAt ? ' archived' : ''
                  }`}
                  aria-current={conversation.id === activeId}
                  onClick={() => select(conversation.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      select(conversation.id);
                    }
                  }}
                >
                  <div className="conv-main">
                    <div className="conv-title">
                      {conversation.title || '（未命名对话）'}
                      {conversation.archivedAt ? (
                        <Badge tone="muted">已归档</Badge>
                      ) : (
                        <Badge tone="ok">进行中</Badge>
                      )}
                      {conversation.memorized ? <Badge tone="accent">已入记忆</Badge> : null}
                    </div>
                    <div className="conv-meta">
                      {KIND_LABEL[conversation.kind] ?? conversation.kind} ·{' '}
                      {conversation.messageCount ?? 0} 条 ·{' '}
                      {conversation.archives?.count
                        ? `归档 ${conversation.archives.count} 次（吸收 ${conversation.archives.absorbed}）`
                        : '尚未归档'}{' '}
                      · {fmtRelative(conversation.updatedAt)}
                      {conversation.archivedAt ? ` · 归档于 ${fmtRelative(conversation.archivedAt)}` : ''}
                    </div>
                    <div className="conv-meta">
                      {conversation.sessionId ? (
                        <>
                          会话 {truncate(conversation.sessionId, 30)} ·{' '}
                          {(conversation as any).meta?.sessionDay
                            ? `${(conversation as any).meta.sessionDay} 起`
                            : '日期未记录'}
                          <span className="li-sub">（跨天第一条消息会自动换新会话，旧会话留档）</span>
                        </>
                      ) : (
                        '还没有 DSH 会话，下一条消息会开一个'
                      )}
                    </div>
                  </div>
                  <div className="conv-actions" onClick={(event) => event.stopPropagation()}>
                    {conversation.sessionId && !conversation.archivedAt && (
                      <Button
                        variant="ghost"
                        size="small"
                        disabled={busy}
                        title="关掉当前 DSH 会话，下一条消息用现在的记忆和设置重新拼一次上下文"
                        onClick={() =>
                          void mutate(
                            `/api/conversations/${conversation.id}/new-session`,
                            {},
                            '下一条消息会用新会话；旧的留在归档里',
                          )
                        }
                      >
                        换新会话
                      </Button>
                    )}
                    {conversation.archivedAt ? (
                      <Button
                        variant="quiet"
                        size="small"
                        disabled={busy}
                        onClick={() =>
                          void mutate(`/api/conversations/${conversation.id}/restore`, {}, '已恢复到进行中')
                        }
                      >
                        恢复
                      </Button>
                    ) : (
                      <Button
                        variant="quiet"
                        size="small"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            `/api/conversations/${conversation.id}/archive`,
                            {},
                            '已归档；没归档的消息补进归档，记忆吸收已排队',
                          )
                        }
                      >
                        归档
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title={filter === 'archived' ? '还没有归档的会话' : '还没有对话'}
              hint={
                filter === 'archived'
                  ? '归档后仍然可以在这里恢复；记忆里已经吸收的内容不受影响。'
                  : '在右侧输入第一句话开始。'
              }
            />
          )}
        </Card>

        <ChatPane
          conversationId={activeId}
          onChanged={() => void list.reload()}
          onCreate={(nextId) => select(nextId)}
          onArchived={() => {
            setActiveId(null);
            void list.reload();
          }}
        />
      </div>
    </>
  );
}

function ChatPane({
  conversationId,
  onChanged,
  onCreate,
  onArchived,
}: {
  conversationId: string | null;
  onChanged: () => void;
  onCreate: (id: string) => void;
  onArchived: () => void;
}) {
  const toast = useToast();
  const detail = useApi<any>(conversationId ? `/api/conversations/${conversationId}` : null, [conversationId]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const messages: Message[] = detail.data?.messages ?? [];
  const conversation: Conversation | null = detail.data?.conversation ?? null;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, streaming, sending]);

  useEffect(() => {
    setStreaming('');
    setReasoning('');
    setRunId(null);
    setError(null);
  }, [conversationId]);

  const send = async () => {
    const input = text.trim();
    if (!input || sending) return;
    setSending(true);
    setError(null);
    setStreaming('');
    setReasoning('');
    setText('');
    const controller = new AbortController();
    abortRef.current = controller;
    let newConversation: string | null = null;
    try {
      await streamSse(
        '/api/chat',
        { conversationId: conversationId ?? undefined, text: input },
        {
          signal: controller.signal,
          onEvent: (event, data) => {
            if (event === 'accepted') {
              setRunId(data.runId);
              newConversation = data.conversationId;
            } else if (event === 'delta') {
              if (data.kind === 'text') setStreaming((prev) => prev + data.text);
              else if (data.kind === 'reasoning') setReasoning((prev) => prev + data.text);
            } else if (event === 'message') {
              setStreaming(data.text ?? '');
            } else if (event === 'error') {
              setError(new Error(data.message ?? '对话失败'));
            } else if (event === 'done') {
              if (data.status === 'failed' || data.status === 'canceled') {
                setError(new Error(data.errorMessage ?? labelOfStatus(data.status)));
              }
            }
          },
        },
      );
    } catch (failure) {
      if ((failure as Error).name !== 'AbortError') setError(failure as Error);
    } finally {
      setSending(false);
      setStreaming('');
      setReasoning('');
      abortRef.current = null;
      await detail.reload();
      onChanged();
      if (newConversation && newConversation !== conversationId) onCreate(newConversation);
    }
  };

  const stop = async () => {
    if (!runId) return;
    try {
      await api(`/api/runs/${runId}/stop`, { method: 'POST', body: {} });
      toast('已请求停止', 'warn');
    } catch (failure) {
      toast((failure as Error).message, 'bad');
    }
  };

  const archive = async () => {
    if (!conversationId) return;
    try {
      await api(`/api/conversations/${conversationId}/archive`, { method: 'POST', body: {} });
      toast('已归档', 'ok');
      onArchived();
    } catch (failure) {
      toast((failure as Error).message, 'bad');
    }
  };

  return (
    <Card
      title={conversation ? conversation.title || '对话' : '新对话'}
      subtitle={
        conversation
          ? `${KIND_LABEL[conversation.kind] ?? conversation.kind} · 会话 ${truncate(conversation.sessionId ?? '（未建立）', 26)} · 上下文 ${truncate(conversation.contextId ?? '默认', 18)}${
              conversation.archivedAt ? ' · 已归档' : ''
            }`
          : '发送第一条消息时会创建对话与 DSH 会话。'
      }
      actions={
        <div className="row" style={{ gap: 6 }}>
          {conversationId && !conversation?.archivedAt ? (
            <Button variant="quiet" size="small" onClick={() => void archive()}>
              归档
            </Button>
          ) : null}
          {conversationId && conversation?.archivedAt ? (
            <Badge tone="muted">已归档，可继续对话</Badge>
          ) : null}
          {sending || runId ? (
            <Button variant="ghost" size="small" onClick={() => void stop()} disabled={!runId}>
              停止
            </Button>
          ) : null}
        </div>
      }
    >
      {conversationId && conversation && <ContinuitySettings conversation={conversation} onSaved={() => void detail.reload()} />}
      <div className="chat">
        <div className="chat-log" ref={logRef}>
          {detail.loading && !detail.data && <Loading label="正在读取对话…" />}
          {detail.error && <ErrorBox error={detail.error} onRetry={() => void detail.reload()} />}
          {!detail.loading && messages.length === 0 && !streaming && (
            <Empty title="还没有消息" hint="Yu 会使用当前默认上下文方案回复。" />
          )}
          {messages.map((message) => (
            <div className={`msg ${message.role === 'user' ? 'user' : 'assistant'}`} key={message.id}>
              <div className="msg-bubble">{message.text}</div>
              <div className="msg-meta">
                {message.role === 'user' ? '你' : 'Yu'} · {fmtDateTime(message.at)}
                {message.meta?.usage?.totalTokens || message.meta?.usage?.outputTokens
                  ? ` · ${message.meta.usage.outputTokens ?? 0} 输出 token`
                  : ''}
                {message.meta?.turnEnd && message.meta.turnEnd.kind !== 'completed'
                  ? ` · 结束：${message.meta.turnEnd.kind}`
                  : ''}
              </div>
            </div>
          ))}
          {reasoning && (
            <div className="msg assistant">
              <div className="msg-bubble" style={{ opacity: 0.72, fontStyle: 'italic' }}>
                {reasoning}
              </div>
              <div className="msg-meta">思考过程（流式）</div>
            </div>
          )}
          {streaming && (
            <div className="msg assistant">
              <div className="msg-bubble">{streaming}</div>
              <div className="msg-meta">Yu · 正在生成…</div>
            </div>
          )}
          {sending && !streaming && !reasoning && (
            <div className="msg assistant">
              <div className="msg-bubble" style={{ opacity: 0.65 }}>
                正在请求模型…
              </div>
            </div>
          )}
          {error && <ErrorBox error={error} />}
        </div>

        <div className="composer">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="说点什么… （Ctrl/⌘ + Enter 发送）"
            rows={2}
            disabled={sending}
          />
          <Button onClick={() => void send()} disabled={sending || !text.trim()}>
            {sending ? '发送中…' : '发送'}
          </Button>
        </div>
      </div>

      {detail.data?.snapshot && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--line-2)', paddingTop: 12 }}>
          <div className="caption" style={{ padding: 0, marginBottom: 8 }}>
            本次运行实际使用的上下文
          </div>
          <KV
            items={[
              {
                label: '模型路由',
                value: (
                  <code>
                    {detail.data.snapshot.route?.provider ?? '?'} / {detail.data.snapshot.route?.model ?? '?'}
                    {detail.data.snapshot.route?.reasoningEffort
                      ? ` · effort ${detail.data.snapshot.route.reasoningEffort}`
                      : ''}
                  </code>
                ),
              },
              {
                label: '估算 token',
                value: `${detail.data.snapshot.budget?.totalTokens ?? '?'}（系统 ${detail.data.snapshot.budget?.systemTokens ?? '?'} / 历史材料 ${detail.data.snapshot.budget?.historyTokens ?? 0} / 输入 ${detail.data.snapshot.budget?.inputTokens ?? '?'}）`,
              },
              {
                label: '段落',
                value: (detail.data.snapshot.sections ?? [])
                  .map((section: any) => `${section.name}(${section.tokens})`)
                  .join(' · '),
              },
            ]}
          />
        </div>
      )}
    </Card>
  );
}

function ContinuitySettings({ conversation, onSaved }: { conversation: any; onSaved: () => void }) {
  const toast = useToast();
  const config = conversation.meta?.continuity ?? {};
  const state = conversation.meta?.continuityState;
  const [enabled, setEnabled] = useState(config.enabled === true);
  const [threshold, setThreshold] = useState(config.thresholdRatio ?? 0.8);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEnabled(config.enabled === true); setThreshold(config.thresholdRatio ?? 0.8); }, [conversation.id, config.enabled, config.thresholdRatio]);
  const save = async () => { setBusy(true); try { await api(`/api/conversations/${encodeURIComponent(conversation.id)}`, { method: 'PATCH', body: { continuity: { enabled, thresholdRatio: Number(threshold) } } }); toast('接续设置已保存', 'ok'); onSaved(); } catch (error) { toast((error as Error).message, 'bad'); } finally { setBusy(false); } };
  const labels: Record<string, string> = { compacted: '已压缩接续', 'below-threshold': '尚未达到阈值', unavailable: '不可用：宿主能力或模型容量未知', failed: '摘要失败', cooldown: '等待下次检查', 'no-span': '没有可压缩的内容', disabled: '已关闭' };
  return <details><summary>长期会话与摘要接续</summary><div className="stack"><p>开启后保持物理会话，不按天切换，并在成功回合结束后检查上下文压力。摘要使用当前模型，可能产生正常模型费用；原始聊天记录保留，摘要可能丢失细节，模型容量仍有限。</p><p>此比例仅控制 Yu 轮末补充检查。宿主原有的自动整理独立运行，可能更早触发；关闭此选项会恢复原轮换规则，不会关闭宿主保护。</p><label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> 长期会话与轮末摘要检查</label><label>Yu 轮末补充检查比例 <input type="number" min="0.5" max="0.9" step="0.05" value={threshold} onChange={e => setThreshold(Number(e.target.value))} /></label><Button size="small" disabled={busy || !Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.9} onClick={() => void save()}>保存接续设置</Button><div>当前状态：{state ? (labels[state.status] ?? state.status) : '尚无记录'}{state?.reason ? ` · ${state.reason}` : ''}{state?.at ? ` · ${fmtDateTime(state.at)}` : ''}</div>{state?.summarySeq != null && <div>最近摘要记录序号 {state.summarySeq} · 压缩事件 {state.startSeq}–{state.endSeq} · 检查点 {state.compactionId ?? "未知"}</div>}</div></details>;
}
