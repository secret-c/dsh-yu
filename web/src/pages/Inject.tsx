import ResourceImpact from '../components/ResourceImpact';
import React, { useEffect, useState } from 'react';
import { api, MEMORY_CATEGORY } from '../lib';
import {
  Badge,
  Button,
  Card,
  Code,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHead,
  Toggle,
  useApi,
  useToast,
} from '../ui';

/**
 * The injectable context, as an ordered list the person owns.
 *
 * It used to be four fixed cards. That shape assumed everyone organizes a
 * persona the way this install did — core, rules, memory, retrieval — and made
 * "add a small section that says how to behave in group chat" impossible without
 * editing the code. Now every row here is a section: rename it, give it a
 * heading, move it, turn it off, delete it, add another. Built-ins still read
 * their text from where it lives (core/rules in settings, memory from blocks,
 * retrieval from the long-term database), so the rest of Yu keeps working.
 */

interface Section {
  id: string;
  kind: 'core' | 'rules' | 'memory' | 'retrieved' | 'custom';
  title: string;
  heading: string;
  order: number;
  enabled: boolean;
  channel: 'system' | 'history';
  scope: 'session' | 'turn';
  wireOrder?: number | null;
  channelLabel?: string;
  body?: string;
  name?: string;
  source?: {path:string;format:string};
  maxChars?: number;
  template?: string;
  fileHash?: string;
  file?: any;
  legacyMemorySlug?: string;
}

interface Block {
  slug: string;
  name: string;
  category: string;
  orderIndex: number;
  enabled: boolean;
  content: string;
}

const KIND_LABEL: Record<string, string> = {
  core: '核心',
  rules: '角色卡',
  memory: '短期记忆',
  retrieved: '长期检索',
  custom: '自定义',
};

const KIND_TONE: Record<string, any> = {
  core: 'warn',
  rules: 'accent',
  memory: 'ok',
  retrieved: 'ok',
  custom: 'muted',
};

/**
 * Channel × refresh, as one choice. Two dropdowns would describe the model
 * honestly but ask the person to hold four combinations in their head; this is
 * the same four states with the words people actually use.
 */
const DELIVERY_OPTIONS = [
  {
    value: 'system:session',
    label: '系统提示词 · 会话定格',
    hint: '写进系统提示词，和 DSH 的身份段同一条消息。模型读作「我是谁、我的规矩」。',
  },
  {
    value: 'system:turn',
    label: '系统提示词 · 每轮重读',
    hint: '同上，但每轮重新读一次；改一个字都会让后面的缓存失效。',
  },
  {
    value: 'history:session',
    label: '用户消息 · 每会话一次',
    hint: '拼在会话第一条用户消息前，模型读作「这次会话我拿到的材料」。',
  },
  {
    value: 'history:turn',
    label: '用户消息 · 每轮',
    hint: '每条消息前都拼一次；适合时间、检索这种这轮才需要的东西。',
  },
];

const deliveryValue = (section: Section) => `${section.channel}:${section.scope}`;

const DELIVERY_LABEL: Record<string, string> = Object.fromEntries(
  DELIVERY_OPTIONS.map((option) => [option.value, option.label]),
);

const sortSections = (list: Section[]) => [...list].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh'));

export function Inject() {
  const inject = useApi<any>('/api/inject');
  const memory = useApi<any>('/api/memory');
  const toast = useToast();
  const [sections, setSections] = useState<Section[]>([]);
  const [retrieval, setRetrieval] = useState<{ enabled: boolean; items: number }>({ enabled: true, items: 6 });
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [dirtyBlocks, setDirtyBlocks] = useState<Set<string>>(new Set());
  const [baseline, setBaseline] = useState('');
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addingBlock, setAddingBlock] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (!inject.data) return;
    const next = sortSections(inject.data.sections ?? []);
    setSections(next);
    setRetrieval({
      enabled: Boolean(inject.data.retrieval?.enabled),
      items: Number(inject.data.retrieval?.items ?? 6),
    });
    setBaseline(JSON.stringify({ sections: next, retrieval: inject.data.retrieval }));
  }, [inject.data]);

  useEffect(() => {
    if (!memory.data) return;
    setBlocks(
      (memory.data.blocks ?? []).map((block: any) => ({
        slug: block.slug,
        name: block.name,
        category: block.category,
        orderIndex: block.orderIndex,
        enabled: block.enabled !== false,
        content: block.content ?? '',
      })),
    );
    setDirtyBlocks(new Set());
  }, [memory.data]);

  if (inject.error) return <ErrorBox error={inject.error} onRetry={() => void inject.reload()} />;
  if (memory.error) return <ErrorBox error={memory.error} onRetry={() => void memory.reload()} />;
  if (!inject.data || !memory.data) return <Loading label="正在读取注入内容…" />;

  const dirty = JSON.stringify({ sections, retrieval }) !== baseline || dirtyBlocks.size > 0;
  const registryProblems: string[] = inject.data.problems ?? [];

  const update = (id: string, patch: Partial<Section>) => {
    setSections((current) => sortSections(current.map((section) => (section.id === id ? { ...section, ...patch } : section))));
  };

  const move = (id: string, direction: -1 | 1) => {
    const ordered = sortSections(sections);
    const index = ordered.findIndex((section) => section.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    const a = ordered[index];
    const b = ordered[target];
    // Swapping explicit order values (not array positions) keeps the document
    // readable in the config file: every section still has its own number.
    const next = sections.map((section) => {
      if (section.id === a.id) return { ...section, order: b.order };
      if (section.id === b.id) return { ...section, order: a.order };
      return section;
    });
    setSections(sortSections(next));
  };

  const removeSection = (section: Section) => {
    if (!window.confirm(`删除注入段「${section.title}」？对应文件会保留，只移除注入资源定义。`)) return;
    setSections((current) => current.filter((item) => item.id !== section.id));
  };

  const restoreDefaults = () => {
    if (!window.confirm('恢复默认资源布局？自定义资源会移出列表，对应文件仍保留。')) return;
    const bodies = new Map(sections.map((section) => [section.kind, section.body ?? '']));
    setSections(
      sortSections(
        (inject.data.defaults ?? []).map((section: Section) => ({
          ...section,
          body: bodies.get(section.kind) ?? '',
          name: `yu:${section.id}`,
        })),
      ),
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      // A block is its own endpoint (text files on disk), but the top button
      // promises "save everything": flush the pending block edits first so an
      // edit cannot be lost because it needed a different button.
      for (const block of blocks) {
        if (!dirtyBlocks.has(block.slug)) continue;
        await api(`/api/memory/blocks/${block.slug}`, {
          method: 'PATCH',
          body: {
            name: block.name,
            category: block.category,
            orderIndex: block.orderIndex,
            enabled: block.enabled,
            content: block.content,
          },
        });
      }
      const texts: Record<string, string> = {};
      for (const section of sections) {
        if (section.kind === 'core'&&!section.source) texts['prompt.core'] = section.body ?? '';
        if (section.kind === 'rules'&&!section.source) texts['prompt.rules'] = section.body ?? '';
      }
      await api('/api/inject/sections', {
        method: 'POST',
        body: {
          sections: sections.map((section) => ({
            id: section.id,
            title: section.title,
            heading: section.heading,
            order: section.order,
            enabled: section.enabled,
            channel: section.channel,
            scope: section.scope,
            ...(section.source?{source:section.source,maxChars:section.maxChars,template:section.template,legacyMemorySlug:section.legacyMemorySlug}:{}),
            ...(section.kind === 'custom' ? { body: section.body ?? '' } : {}),
          })),
          fileTexts:Object.fromEntries(sections.filter(s=>s.source&&s.source.path===inject.data.sections.find((original:Section)=>original.id===s.id)?.source?.path&&s.body!==inject.data.sections.find((original:Section)=>original.id===s.id)?.body).map(s=>[s.id,s.body??''])),
          fileHashes:Object.fromEntries(sections.filter(s=>s.fileHash).map(s=>[s.id,s.fileHash])),
          texts,
          retrieval,
        },
      });
      toast('已保存；下一个会话按这个顺序拼', 'ok');
      await Promise.all([inject.reload(), memory.reload()]);
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setSaving(false);
    }
  };

  const saveBlock = async (block: Block) => {
    try {
      await api(`/api/memory/blocks/${block.slug}`, {
        method: 'PATCH',
        body: {
          name: block.name,
          category: block.category,
          orderIndex: block.orderIndex,
          enabled: block.enabled,
          content: block.content,
        },
      });
      setDirtyBlocks((current) => {
        const next = new Set(current);
        next.delete(block.slug);
        return next;
      });
      toast(`${block.name} 已保存`, 'ok');
      await memory.reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  const removeBlock = async (block: Block) => {
    if (!window.confirm(`删除短期记忆块「${block.name}」？历史版本仍保留。`)) return;
    try {
      await api(`/api/memory/blocks/${block.slug}`, { method: 'DELETE' });
      toast('记忆块已删除', 'ok');
      await Promise.all([memory.reload(), inject.reload()]);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  // A plain derivation, not a hook: this page returns early while loading, and
  // a hook below that return would change the hook count between renders.
  let totalChars = 0;
  for (const section of sections) {
    if (!section.enabled) continue;
    if (section.kind === 'memory') {
      totalChars += blocks.filter((block) => block.enabled).reduce((sum, block) => sum + block.content.length, 0);
    } else {
      totalChars += String(section.body ?? '').length;
    }
  }

  return (
    <>
      <PageHead
        eyebrow="注入"
        title="模型到底看到什么"
        description="一个有序的块列表。每块自己选投递方式：进系统提示词（会话开头定格），还是当成材料拼进用户消息（一次或每轮）。系统提示词里的块按这里的顺序写进请求，不再被暗中重排。"
        actions={
          <>
            <Badge tone="muted">约 {totalChars} 字</Badge>
            <Button variant="ghost" onClick={() => setPreviewOpen(true)}>
              合成预览
            </Button>
            <Button onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? '保存中…' : dirty ? '保存全部修改' : '没有改动'}
            </Button>
          </>
        }
      />

      {registryProblems.length > 0 && (
        <div className="notice warn">
          注入段配置里有问题，正在按能读的部分工作：
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {registryProblems.map((problem, index) => (
              <li key={index}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="notice" style={{ fontSize: 12, lineHeight: 1.75 }}>
        <strong>顺序</strong>由每段的数字决定，用 ↑ ↓ 调整；系统提示词里的段按这个顺序写进请求，
        「实际」就是它落进的真实位置（Yu 的段全部排在 DSH 自己的身份段之后、策略与工具说明之前）。
        <strong>投递方式</strong>决定它进系统提示词还是跟着用户消息走：系统提示词按会话定格，
        用户消息每轮都重新拼，所以真正会变的东西（时间、检索）放后者更对。
        记忆块的正文保存在数据根的 <code className="tag">memory/short-term/*.md</code>，这里改完单独保存。
      </div>

      {sections.length === 0 ? (
        <Card>
          <Empty
            title="一段都没有"
            hint="至少留一个核心段，否则模型收到的系统提示会是空的。"
            action={<Button onClick={() => setAdding(true)}>添加一段</Button>}
          />
        </Card>
      ) : (
        sections.map((section, index) => (
          <Card
            key={section.id}
            title={
              <span className="row" style={{ gap: 8 }}>
                <Badge tone={KIND_TONE[section.kind] ?? 'muted'}>{KIND_LABEL[section.kind] ?? section.kind}</Badge>
                <span>{section.title || '未命名段落'}</span>
                {!section.enabled && <Badge tone="muted">已停用</Badge>}
                <Badge tone={section.channel === 'system' ? 'accent' : 'ok'}>
                  {section.channel === 'system' ? '系统提示词' : '用户消息'}
                </Badge>
                {section.scope === 'turn' && <Badge tone="muted">每轮</Badge>}
                <code className="tag">order {section.order}</code>
                {section.channel === 'system' && section.wireOrder !== null && section.wireOrder !== undefined && (
                  <code className="tag">实际 {section.wireOrder.toFixed(1)}</code>
                )}
                <code className="tag">{section.name}</code>
              </span>
            }
            subtitle={
              section.kind === 'memory'
                ? '整段短期记忆：每个启用的块按顺序拼进来。默认跟着会话第一条用户消息走，整段对话不再重发。'
                : section.kind === 'retrieved'
                  ? '按当前这句话检索长期记忆库，命中几条就拼几条，和用户消息一起送达。条目本身在记忆页管理。'
                  : section.kind === 'custom'
                    ? '自定义段：正文完全自己写；投递方式决定它进系统提示词还是跟着用户消息走。'
                    : section.channel === 'system'
                      ? '正文来自对应文件；写进系统提示词，按会话定格。这里改完点右上角「保存全部修改」。'
                      : '正文来自对应文件；作为材料跟着用户消息走。这里改完点右上角「保存全部修改」。'
            }
            actions={
              <div className="row" style={{ gap: 6 }}>
                <Button variant="quiet" size="small" disabled={index === 0} onClick={() => move(section.id, -1)}>
                  ↑
                </Button>
                <Button
                  variant="quiet"
                  size="small"
                  disabled={index === sections.length - 1}
                  onClick={() => move(section.id, 1)}
                >
                  ↓
                </Button>
                <Toggle
                  checked={section.enabled}
                  onChange={(next) => update(section.id, { enabled: next })}
                  label={section.enabled ? '启用' : '停用'}
                />
                <Button variant="quiet" size="small" onClick={() => removeSection(section)}>
                  删除
                </Button>
              </div>
            }
          >
            <ResourceImpact kind="injection" id={section.id} onChanged={()=>void inject.reload()}/>
            <div className="grid three">
              <Field label="名称（页面显示）">
                <input value={section.title} onChange={(event) => update(section.id, { title: event.target.value })} />
              </Field>
              <Field label="注入标题" help="写进提示词的 ## 标题；留空表示不加标题。">
                <input
                  value={section.heading}
                  onChange={(event) => update(section.id, { heading: event.target.value })}
                  placeholder="例如：角色卡（你可以自己改）"
                />
              </Field>
              <Field label="投递方式" help="决定这段文字进系统提示词，还是跟着用户那句话一起送；以及多久重读一次。">
                <select
                  value={deliveryValue(section)}
                  onChange={(event) => {
                    const [channel, scope] = event.target.value.split(':') as ['system' | 'history', 'session' | 'turn'];
                    update(section.id, { channel, scope });
                  }}
                >
                  {DELIVERY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {section.source&&<div className="stack"><Field label="对应文件（UTF-8，相对数据目录或绝对路径）"><input value={section.source.path} onChange={e=>update(section.id,{source:{path:e.target.value,format:'utf8'}})}/></Field><div>读取状态：{section.file?.status??'保存后读取'}</div><Field label="字符预算（0关闭）"><input type="number" min="0" max="400000" value={section.maxChars??14000} onChange={e=>update(section.id,{maxChars:Number(e.target.value)})}/></Field><Field label="模板（支持 content、name、slug）"><textarea value={section.template??'{{content}}'} onChange={e=>update(section.id,{template:e.target.value})}/></Field></div>}
            {(section.kind === 'core' || section.kind === 'rules' || section.kind === 'custom') && (
              <Field
                label={section.kind === 'rules' ? '角色卡正文' : section.kind === 'core' ? '核心正文' : '正文'}
                help={
                  section.kind === 'core'
                    ? '只有人能改，模型改不了。'
                    : section.kind === 'rules'
                      ? '模型可以用 yu_admin 改这一份。'
                      : '自定义段的内容；保存后会出现在注入里。'
                }
              >
                <textarea
                  className="editor"
                  rows={section.kind === 'rules' ? 24 : 8}
                  value={section.body ?? ''}
                  onChange={(event) => update(section.id, { body: event.target.value })}
                />
              </Field>
            )}

            {section.kind === 'memory' && (
              <div className="stack">
                <div className="row between">
                  <span className="li-sub">
                    启用的块会按顺序拼进「{section.heading || '短期记忆'}」；关闭的块不注入，但内容仍然保留。
                  </span>
                  <Button variant="ghost" size="small" onClick={() => setAddingBlock(true)}>
                    新增记忆块
                  </Button>
                </div>
                {blocks.length === 0 ? (
                  <Empty title="还没有记忆块" hint="至少建一个，短期记忆才有内容。" />
                ) : (
                  blocks.map((block) => (
                    <div key={block.slug} className="stack tight" style={{ borderTop: '1px solid var(--line-2)', paddingTop: 10 }}>
                      <div className="row between">
                        <div className="row" style={{ gap: 8, flex: 1 }}>
                          <input
                            value={block.name}
                            onChange={(event) => {
                              setBlocks((current) =>
                                current.map((item) => (item.slug === block.slug ? { ...item, name: event.target.value } : item)),
                              );
                              setDirtyBlocks((current) => new Set([...current, block.slug]));
                            }}
                            style={{ width: 180 }}
                          />
                          <Badge tone="muted">{MEMORY_CATEGORY[block.category] ?? block.category}</Badge>
                          <code className="tag">{block.slug}</code>
                          <span className="li-sub">{block.content.length} 字</span>
                        </div>
                        <div className="row" style={{ gap: 6 }}>
                          <Toggle
                            checked={block.enabled}
                            onChange={(next) => {
                              setBlocks((current) =>
                                current.map((item) => (item.slug === block.slug ? { ...item, enabled: next } : item)),
                              );
                              setDirtyBlocks((current) => new Set([...current, block.slug]));
                            }}
                            label={block.enabled ? '注入' : '不注入'}
                          />
                          <Button variant="quiet" size="small" onClick={() => void removeBlock(block)}>
                            删除
                          </Button>
                        </div>
                      </div>
                      <textarea
                        className="editor"
                        rows={4}
                        value={block.content}
                        onChange={(event) => {
                          setBlocks((current) =>
                            current.map((item) => (item.slug === block.slug ? { ...item, content: event.target.value } : item)),
                          );
                          setDirtyBlocks((current) => new Set([...current, block.slug]));
                        }}
                      />
                      <div className="row between">
                        <span className="li-sub">正文写在磁盘，保存后下个会话生效。</span>
                        <Button
                          variant="quiet"
                          size="small"
                          disabled={!dirtyBlocks.has(block.slug)}
                          onClick={() => void saveBlock(block)}
                        >
                          保存 {block.name}
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {section.kind === 'retrieved' && (
              <div className="grid two">
                <Field label="会话开头做检索">
                  <Toggle
                    checked={retrieval.enabled}
                    label={retrieval.enabled ? '开' : '关'}
                    onChange={(next) => setRetrieval({ ...retrieval, enabled: next })}
                  />
                </Field>
                <Field label="最多注入几条" help="0 到 20；一次会话只查一次。">
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={retrieval.items}
                    onChange={(event) => setRetrieval({ ...retrieval, items: Number(event.target.value) })}
                  />
                </Field>
              </div>
            )}
          </Card>
        ))
      )}

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <Button variant="ghost" onClick={() => setAdding(true)}>
            添加一段
          </Button>
          <Button variant="quiet" onClick={restoreDefaults}>
            恢复默认段落
          </Button>
        </div>
        <Button onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? '保存中…' : dirty ? '保存全部修改' : '没有改动'}
        </Button>
      </div>

      {adding && (
        <AddSectionModal
          nextOrder={Math.min(1000, Math.max(0, ...sections.map((section) => section.order)) + 10)}
          onClose={() => setAdding(false)}
          onAdd={(section) => {
            setSections((current) => sortSections([...current, section]));
            setAdding(false);
          }}
        />
      )}

      {addingBlock && (
        <AddBlockModal
          existing={blocks.map((block) => block.slug)}
          onClose={() => setAddingBlock(false)}
          onCreated={async () => {
            setAddingBlock(false);
            await Promise.all([memory.reload(), inject.reload()]);
            toast('记忆块已创建', 'ok');
          }}
        />
      )}

      {previewOpen && <PreviewModal sections={sections} onClose={() => setPreviewOpen(false)} />}
    </>
  );
}

function AddSectionModal({
  nextOrder,
  onClose,
  onAdd,
}: {
  nextOrder: number;
  onClose: () => void;
  onAdd: (section: Section) => void;
}) {
  const [title, setTitle] = useState('');
  const [heading, setHeading] = useState('');
  const [body, setBody] = useState('');
  const [delivery, setDelivery] = useState('system:session');
  const [order, setOrder] = useState(nextOrder);

  return (
    <Modal
      open
      wide
      title="添加一个注入段"
      subtitle="正文、标题、顺序都可以之后再改；先给它一个名字。"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() => {
              const id = `sec_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
              const [channel, scope] = delivery.split(':') as ['system' | 'history', 'session' | 'turn'];
              onAdd({
                id,
                kind: 'custom',
                title: title.trim() || '未命名段落',
                heading: heading.trim(),
                body,
                order: Math.max(0, Math.min(1000, Number(order) || nextOrder)),
                enabled: true,
                channel,
                scope,
                name: `yu:custom:${id}`,
              });
            }}
          >
            添加
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid two">
          <Field label="名称（页面显示）">
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：群聊里的分寸" autoFocus />
          </Field>
          <Field label="注入标题" help="留空表示不加 ## 标题。">
            <input value={heading} onChange={(event) => setHeading(event.target.value)} placeholder="例如：在群里" />
          </Field>
        </div>
        <div className="grid two">
          <Field label="顺序">
            <input
              type="number"
              min={0}
              max={1000}
              value={order}
              onChange={(event) => setOrder(Number(event.target.value))}
            />
          </Field>
          <Field label="投递方式" help="进系统提示词 = 身份和规矩；跟着用户消息走 = 材料。">
            <select value={delivery} onChange={(event) => setDelivery(event.target.value)}>
              {DELIVERY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="正文">
          <textarea className="editor" rows={10} value={body} onChange={(event) => setBody(event.target.value)} />
        </Field>
        <div className="li-sub">
          顺序决定它和其它块之间的先后。投递到系统提示词的块会落在 DSH 身份段之后、策略与工具说明之前；
          投递到用户消息的块按顺序拼在用户这句话前面，并被标注为「背景材料，不是新的请求」。
        </div>
      </div>
    </Modal>
  );
}

function AddBlockModal({
  existing,
  onClose,
  onCreated,
}: {
  existing: string[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const toast = useToast();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('custom');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api('/api/memory/blocks', {
        method: 'POST',
        body: { slug: slug.trim().toLowerCase(), name: name.trim(), category, content },
      });
      await onCreated();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const duplicate = existing.includes(slug.trim().toLowerCase());

  return (
    <Modal
      open
      title="新增记忆块"
      subtitle="一个块就是一段注入文本，例如「近期经历」「人物」「群里的规矩」。"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !slug.trim() || !name.trim() || duplicate}>
            {busy ? '创建中…' : '创建'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="标识（小写字母、数字、连字符）" error={duplicate ? '这个标识已经存在' : undefined}>
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
            placeholder="group-manners"
          />
        </Field>
        <Field label="显示名称">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="群里的分寸" />
        </Field>
        <Field label="类别">
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {Object.entries(MEMORY_CATEGORY).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="初始正文">
          <textarea className="editor" rows={6} value={content} onChange={(event) => setContent(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function PreviewModal({ onClose, sections }: { onClose: () => void; sections:Section[] }) {
  const [input, setInput] = useState('（预览：今天想做点什么？）');
  const [result, setResult] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const run = async () => {
    setBusy(true);
    try {
      setResult(await api<any>('/api/inject/preview', { method: 'POST', body: { input, mode:'draft',sections,fileTexts:Object.fromEntries(sections.filter(s=>s.source).map(s=>[s.id,s.body??''])) } }));
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal
      open
      wide
      title="合成预览"
      subtitle="用已保存的配置与默认上下文拼一遍；不调用模型，不写检索账本。"
      onClose={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      <div className="stack">
        <Field label="示例输入" help="检索按这句话去长期记忆库找。">
          <div className="file-input-row">
            <input value={input} onChange={(event) => setInput(event.target.value)} />
            <Button variant="ghost" onClick={() => void run()} disabled={busy}>
              {busy ? '生成中…' : '重新生成'}
            </Button>
          </div>
        </Field>
        {result && (
          <>
            <div className="notice">
              上下文：{result.context?.name ?? '（无方案，用默认配置）'} · 约 {result.compiled.budget.totalTokens} token
              （系统 {result.compiled.budget.systemTokens} / 历史材料 {result.compiled.budget.historyTokens} / 输入{' '}
              {result.compiled.budget.inputTokens}）
            </div>
            {result.compiled.problems?.length > 0 && (
              <div className="notice bad">
                {result.compiled.problems.map((problem: any) => `${problem.code}: ${problem.message}`).join('；')}
              </div>
            )}
            <Card title="块与投递方式">
              <div className="list">
                {result.compiled.sections.map((section: any) => (
                  <details key={section.name} className="list-item" style={{ display: 'block' }}>
                    <summary style={{ cursor: 'pointer' }}>
                      <span style={{ fontWeight: 600 }}>{section.title || section.name}</span>{' '}
                      <Badge tone={section.channel === 'system' ? 'accent' : 'ok'}>
                        {section.channel === 'system' ? '系统提示词' : '用户消息'}
                      </Badge>{' '}
                      <Badge tone="muted">{section.scope === 'turn' ? '每轮' : '会话一次'}</Badge>{' '}
                      <code className="tag">order {section.order}</code>{' '}
                      {section.channel === 'system' && (
                        <code className="tag">
                          实际{' '}
                          {Number(
                            result.compiled.systemBlocks?.find((block: any) => block.name === section.name)?.wireOrder,
                          ).toFixed(1)}
                        </code>
                      )}
                      <span className="tag">≈{section.tokens} token</span>
                    </summary>
                    <Code>{section.text}</Code>
                  </details>
                ))}
              </div>
            </Card>
            <Card title="① 系统提示词（Yu 的部分）">
              <Code>{result.compiled.renderedSystem || '（空：没有任何段投递到系统提示词）'}</Code>
            </Card>
            <Card title="② 会话材料（拼在第一条用户消息前，只发一次）">
              <Code>{result.compiled.history?.session || '（空）'}</Code>
            </Card>
            <Card title="③ 每轮材料（拼在每条用户消息前）">
              <Code>{result.compiled.history?.turn || '（空）'}</Code>
            </Card>
            <Card title="④ 本次输入">
              <Code>{result.compiled.renderedInput}</Code>
            </Card>
          </>
        )}
      </div>
    </Modal>
  );
}
