import React, { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtRelative, MEMORY_CATEGORY } from '../lib';
import { MemoryDbTab } from './MemoryDb';
import { MemoryDocsTab } from './MemoryDocs';
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
  Tabs,
  Toggle,
  useApi,
  useToast,
} from '../ui';

export function MemoryPage({documentSlug = null}: {documentSlug?: string|null}) {
  const memory = useApi<any>('/api/memory');
  const [tab, setTab] = useState<'db' | 'blocks' | 'docs' | 'versions'>(documentSlug ? 'docs' : 'db');

  if (memory.error) return <ErrorBox error={memory.error} onRetry={() => void memory.reload()} />;
  if (!memory.data) return <Loading label="正在读取记忆…" />;

  return (
    <>
      <div className="notice">最近成功版本：{memory.data.versions[0] ? 'v'+memory.data.versions[0].version+' · '+fmtDateTime(memory.data.versions[0].createdAt) : '尚未同步'}。新会话同步规则启用时会先等待同步；关闭时使用最近成功记忆。已有会话继续沿用开头的记忆。 <a href="#/tasks">查看同步设置</a></div>
      <PageHead
        eyebrow="记忆"
        title="短期记忆与长期记忆"
        description="长期记忆库统一保存个人记忆与外部资料，按上下文授权检索。个人库支持自动积累与文档编辑，外部资料只读。短期记忆按配置注入会话；冻结内容的修改从新会话生效。"
      />

      {memory.data.projection?.pending && <p role="status">数据库改动已保存；文件同步待修复。外部文件编辑已保留，请核对文件与数据库后再同步。</p>}
      <Tabs
        tabs={[
          // The long-term database goes first on purpose: it is the part that
          // grows, merges and answers questions; blocks are the summary on top.
          { id: 'db', label: '长期记忆库' },
          { id: 'blocks', label: `短期记忆（${memory.data.blocks.length}）` },
          { id: 'docs', label: '个人库文档' },
          { id: 'versions', label: `版本（${memory.data.versions.length}）` },
        ]}
        active={tab}
        onChange={(id) => setTab(id as typeof tab)}
      />

      {tab === 'db' && <MemoryDbTab />}
      {tab === 'blocks' && <BlocksTab memory={memory} />}
      {tab === 'docs' && <MemoryDocsTab initialSlug={documentSlug} />}
      {tab === 'versions' && <VersionsTab memory={memory} />}
    </>
  );
}

function BlocksTab({ memory }: { memory: any }) {
  const toast = useToast();
  const [blocks, setBlocks] = useState<any[]>(memory.data.blocks);
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newBlock, setNewBlock] = useState({ slug: '', name: '', category: 'custom' });

  useEffect(() => {
    setBlocks(memory.data.blocks);
    setDirty(false);
  }, [memory.data]);

  const update = (index: number, patch: any) => {
    const next = [...blocks];
    next[index] = { ...next[index], ...patch };
    setBlocks(next);
    setDirty(true);
  };

  /**
   * The block text lives in a file. Typing in the console writes that file
   * straight away, so leaving the page never loses an edit and an editor open on
   * the same file sees the same text.
   */
  const writeBlockFile = async (index: number) => {
    const block = blocks[index];
    if (!block?.slug) return;
    try {
      const saved = await api<any>(`/api/memory/blocks/${block.slug}`, {
        method: 'PATCH',
        body: {
          expectedRevision: memory.data.revision,
          name: block.name,
          category: block.category,
          orderIndex: block.orderIndex,
          enabled: block.enabled,
          content: block.content,
        },
      });
      toast(saved.projection?.pending ? '数据库已保存；文件同步存在冲突，请检查外部编辑。' : `已写入 ${block.slug}.md`, saved.projection?.pending ? 'bad' : 'ok');
      await memory.reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  const publish = async (note: string) => {
    const published = await api<any>('/api/memory/publish', {
      method: 'POST',
      body: { blocks, style: memory.data.style?.content ?? '', note, expectedRevision: memory.data.revision },
    });
    toast(published.projection?.pending ? '版本已发布；文件投影待修复，无需重复发布。' : '版本已发布，按段落的读取时机生效', published.projection?.pending ? 'bad' : 'ok');
    setDirty(false);
    await memory.reload();
  };

  const addBlock = async () => {
    try {
      await api('/api/memory/blocks', { method: 'POST', body: newBlock });
      setCreating(false);
      setNewBlock({ slug: '', name: '', category: 'custom' });
      await memory.reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  const removeBlock = async (slug: string) => {
    if (!window.confirm(`删除记忆块「${slug}」？历史版本仍保留。`)) return;
    await api(`/api/memory/blocks/${slug}`, { method: 'DELETE' });
    await memory.reload();
  };

  return (
    <div className="stack">
      <div className="row between">
        <span className="li-sub">
          记忆块按顺序注入。正文一块一个 .md 文件，位置在数据根下的{' '}
          <code className="tag">{memory.data.files?.relativeDir ?? 'memory/short-term'}</code>
          （数据根 {memory.data.files?.root ?? '见设置 · 数据目录'}）。
          {dirty ? ' 有未发布成新版本的改动。' : ' 当前与已发布版本一致。'}
        </span>
        <div className="row">
          <Button variant="ghost" size="small" onClick={() => setCreating(true)}>
            新增记忆块
          </Button>
          <Button onClick={() => void publish('手工编辑记忆块')} disabled={!dirty}>
            发布为新版本
          </Button>
        </div>
      </div>

      {blocks.map((block, index) => (
        <Card
          key={block.id}
          title={
            <span className="row" style={{ gap: 8 }}>
              <input
                value={block.name}
                onChange={(event) => update(index, { name: event.target.value })}
                style={{ width: 180, minHeight: 32 }}
              />
              <Badge tone="muted">{MEMORY_CATEGORY[block.category] ?? block.category}</Badge>
              <code className="tag">{block.slug}</code>
              {block.source && <Badge tone="warn">迁移</Badge>}
            </span>
          }
          actions={
            <div className="row" style={{ gap: 6 }}>
              <Toggle checked={block.enabled} onChange={(next) => update(index, { enabled: next })} />
              <Button variant="quiet" size="small" onClick={() => void removeBlock(block.slug)}>
                删除
              </Button>
            </div>
          }
        >
          <textarea
            className="editor"
            value={block.content}
            rows={6}
            onChange={(event) => update(index, { content: event.target.value })}
            onBlur={() => void writeBlockFile(index)}
            placeholder="（空）"
          />
          <div className="li-sub" style={{ marginTop: 6 }}>
            {block.content.length} 字 · 更新于 {fmtRelative(block.updatedAt)}
            {block.truncatedInPrompt && ' · 超过注入上限，模型只能看到开头 6000 字'}
          </div>
          {block.filePath && (
            <div className="li-sub" style={{ marginTop: 4 }} title={block.filePath}>
              文件：<code className="tag">{block.fileRelative ?? block.filePath}</code>（相对数据根）
              <br />
              这里就是那份文本本身：离开输入框会自动写进文件，你在别的编辑器里改文件，下次运行前也会读回来。
            </div>
          )}
          {block.source && (
            <div className="li-sub" style={{ marginTop: 4, lineHeight: 1.7 }}>
              来自旧项目迁移：<code className="tag">{block.source.path}</code>
              {block.source.count > 1 && `（合并了 ${block.source.count} 个文件）`}
              {block.source.importedAt ? ` · ${fmtRelative(block.source.importedAt)}导入` : ''}
              <br />
              内容就是普通文本，可以直接在上面编辑、删减或整个清空；删掉带「迁移」标记的块不会影响旧项目里的原文件。
            </div>
          )}
        </Card>
      ))}

      {/* Where the text lives comes after the text itself: reading order is
          "what does she remember, then where is it kept". */}
      <Card
        title="磁盘上的文件"
        subtitle="这些文件就是注入给模型的正文；按数据根的相对位置找，数据根搬走它们跟着走"
        actions={
          <Button
            variant="quiet"
            size="small"
            onClick={() =>
              void (async () => {
                try {
                  await api('/api/memory/files/sync', { method: 'POST', body: {} });
                  toast('已从文件读回记忆', 'ok');
                  await memory.reload();
                } catch (error) {
                  toast((error as Error).message, 'bad');
                }
              })()
            }
          >
            从文件重新读取
          </Button>
        }
      >
        {(memory.data.files?.items ?? []).length === 0 ? (
          <Empty title="还没有文件" hint="发布一次记忆，或点上面的按钮写出来。" />
        ) : (
          <div className="list">
            {(memory.data.files.items as any[]).map((file) => (
              <div className="list-item" key={file.name} title={file.path}>
                <code className="tag">{file.relative ?? file.name}</code>
                <div className="li-main">
                  <div className="li-title">{file.relative ?? file.name}</div>
                  <div className="li-sub">
                    {file.bytes >= 1024 ? `${(file.bytes / 1024).toFixed(1)} KB` : `${file.bytes} B`} · 改动于{' '}
                    {fmtRelative(file.mtime)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {creating && (
        <Modal
          open
          title="新增记忆块"
          onClose={() => setCreating(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                取消
              </Button>
              <Button onClick={() => void addBlock()} disabled={!newBlock.slug || !newBlock.name}>
                创建
              </Button>
            </>
          }
        >
          <div className="stack">
            <Field label="标识（小写字母、数字、连字符）">
              <input
                value={newBlock.slug}
                onChange={(event) => setNewBlock({ ...newBlock, slug: event.target.value.toLowerCase() })}
                placeholder="reading-notes"
              />
            </Field>
            <Field label="显示名称">
              <input value={newBlock.name} onChange={(event) => setNewBlock({ ...newBlock, name: event.target.value })} />
            </Field>
            <Field label="类别">
              <select value={newBlock.category} onChange={(event) => setNewBlock({ ...newBlock, category: event.target.value })}>
                {Object.entries(MEMORY_CATEGORY).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function VersionsTab({ memory }: { memory: any }) {
  const toast = useToast();
  const [compare, setCompare] = useState<any | null>(null);

  return (
    <>
      <Card title="已发布版本" subtitle="每个版本是完整快照；回退也会生成新版本，历史不可变。">
        {memory.data.versions.length === 0 ? (
          <Empty title="还没有发布过记忆版本" hint="运行一次记忆维护，或手动发布会话生成第一个版本。" />
        ) : (
          <div className="list">
            {memory.data.versions.map((version: any) => (
              <div className="list-item" key={version.id}>
                <Badge tone="accent">v{version.version}</Badge>
                <div className="li-main">
                  <div className="li-title">{version.note || '（无备注）'}</div>
                  <div className="li-sub">
                    {version.source} · {fmtDateTime(version.publishedAt)} · {version.blocks.length} 个记忆块
                  </div>
                </div>
                <Button variant="quiet" size="small" onClick={() => setCompare(version)}>
                  查看与比较
                </Button>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={async () => {
                    await api(`/api/memory/versions/${version.id}/restore`, { method: 'POST', body: {} });
                    toast('已回退到该版本（生成新版本）', 'ok');
                    await memory.reload();
                  }}
                >
                  回退
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {compare && (
        <Modal open wide title={`版本 v${compare.version}`} subtitle={compare.note} onClose={() => setCompare(null)}>
          <div className="diff">
            <div>
              <div className="caption" style={{ padding: 0 }}>
                该版本
              </div>
              <Code>
                {compare.blocks.map((block: any) => `## ${block.name}\n${block.content || '（空）'}`).join('\n\n')}
              </Code>
            </div>
            <div>
              <div className="caption" style={{ padding: 0 }}>
                当前
              </div>
              <Code>
                {memory.data.blocks.map((block: any) => `## ${block.name}\n${block.content || '（空）'}`).join('\n\n')}
              </Code>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
