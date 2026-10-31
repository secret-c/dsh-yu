import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime, fmtRelative } from '../lib';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, useApi, useToast } from '../ui';

/**
 * The document library: the long text Yu wrote about itself.
 *
 * Diary entries, a self-portrait, a group timeline, a glossary. They are stored
 * in the database next to the memories but behave differently: nothing is
 * injected into a prompt, each one is opened by hand, and a human can edit it.
 * So the page is a two-pane reader/editor, not a list of cards.
 */

interface DocumentMeta {
  slug: string;
  title: string;
  category: string;
  chars: number;
  source: string;
  updatedAt: number;
}

interface DocumentFull extends DocumentMeta {
  content: string;
}

export function MemoryDocsTab({initialSlug = null}: {initialSlug?: string|null}) {
  const list = useApi<{
    documents: DocumentMeta[];
    stats: { total: number; chars: number; categories: Array<{ category: string; count: number; chars: number }> };
    categories: Array<{ id: string; label: string }>;
  }>('/api/memory/docs');
  const config=useApi<any>('/api/settings');
  const [libraries,setLibraries]=useState<any[]>([]);
  const [libraryId,setLibraryId]=useState('');
  useEffect(()=>{const item=config.data?.groups?.tools?.find((x:any)=>x.key==='tools.documentLibraries');if(item)try{setLibraries(JSON.parse(item.value));}catch{}},[config.data]);
  const saveLibraries=async(next:any[])=>{try{await api('/api/settings',{method:'PATCH',body:{settings:{'tools.documentLibraries':JSON.stringify(next)}}});setLibraries(next);toast('库配置已保存；检索立即生效','ok');}catch(error){toast((error as Error).message,'bad');}};
  const [active, setActive] = useState<string | null>(initialSlug);
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const doc = useApi<{ document: DocumentFull }>(active ? `/api/memory/docs/${encodeURIComponent(active)}` : null, [active]);

  useEffect(() => {
    if (doc.data?.document) {
      setDraft(doc.data.document.content);
      setTitleDraft(doc.data.document.title);
    } else {
      setDraft(null);
      setTitleDraft('');
    }
  }, [doc.data]);

  const labels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const entry of list.data?.categories ?? []) map[entry.id] = entry.label;
    return map;
  }, [list.data]);

  const documents = list.data?.documents ?? [];
  const visible = documents.filter((entry) => {
    const owner=libraries.find(l=>l.category===entry.category)??libraries.find(l=>l.category==='*');
    if(libraryId && owner?.id!==libraryId)return false;
    if (category && entry.category !== category) return false;
    if (search.trim() && !`${entry.title} ${entry.category}`.includes(search.trim())) return false;
    return true;
  });

  useEffect(() => {
    if (!active && documents.length) setActive(documents[0].slug);
  }, [active, documents]);

  const current = doc.data?.document ?? null;
  const dirty = Boolean(current && draft !== null && (draft !== current.content || titleDraft !== current.title));

  const save = async () => {
    if (!current || draft === null) return;
    setSaving(true);
    try {
      await api(`/api/memory/docs/${encodeURIComponent(current.slug)}`, {
        method: 'PATCH',
        body: { content: draft, title: titleDraft },
      });
      toast('已保存', 'ok');
      await Promise.all([doc.reload(), list.reload()]);
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setSaving(false);
    }
  };

  const create = async () => {
    setSaving(true);
    try {
      const created = await api<{ document: DocumentFull }>('/api/memory/docs', {
        method: 'POST',
        body: { title: '新文档', category: (libraries.find(l=>l.id===libraryId)?.category==='*'?'note':libraries.find(l=>l.id===libraryId)?.category) ?? category ?? 'note', content: '' },
      });
      await list.reload();
      setActive(created.document.slug);
      toast('已新建', 'ok');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!current) return;
    if (!window.confirm(`删除「${current.title}」？删除后可以再导入回来。`)) return;
    setSaving(true);
    try {
      await api(`/api/memory/docs/${encodeURIComponent(current.slug)}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      setActive(null);
      await list.reload();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setSaving(false);
    }
  };

  if (list.error) return <ErrorBox error={list.error} onRetry={() => void list.reload()} />;
  if (!list.data) return <Loading label="正在读取文档库…" />;

  const stats = list.data.stats;

  return (
    <Card
      title="个人库文档"
      subtitle={
        <span>
          用户管理的知识文档：{stats.total} 篇、{stats.chars.toLocaleString()} 字。存在数据库里，不自动整篇注入；启用的具名库可由模型关键词检索，
          修改直接保存到数据库。
        </span>
      }
      actions={
        <div className="row" style={{ gap: 8 }}>
          <Button variant="ghost" size="small" disabled={saving} onClick={() => void create()}>
            新建
          </Button>
          <Button
            variant="quiet"
            size="small"
            disabled={saving || !current}
            onClick={() => void save()}
            title={dirty ? '有未保存的修改' : '没有修改'}
          >
            {saving ? '保存中…' : dirty ? '保存修改' : '已保存'}
          </Button>
        </div>
      }
    >
      <details style={{marginBottom:16}}><summary>高级：旧文档工具分类与权限兼容配置</summary><div className="stack">
        <div className="row"><strong>具名知识库</strong><Button size="small" onClick={()=>{const id='library_'+Date.now().toString(36);setLibraries([...libraries,{id,name:'新知识库',category:id,enabled:true}]);}}>新增库</Button><Button size="small" onClick={()=>void saveLibraries(libraries)}>保存库配置</Button></div>
        <p className="li-sub">每个库使用唯一文档分类；分类 * 的默认库收纳未分库的旧文档。停用后模型无法检索或读取。移除库定义会保留全部文档，并回归默认库（若有）；重新加入相同分类可恢复分库。未归属启用库的文档仅供管理台阅读。</p>
        {libraries.map((lib,index)=><div className="row" key={lib.id}><input aria-label="知识库名称" value={lib.name} onChange={e=>setLibraries(libraries.map((l,i)=>i===index?{...l,name:e.target.value}:l))}/><input aria-label="知识库分类" value={lib.category} onChange={e=>setLibraries(libraries.map((l,i)=>i===index?{...l,category:e.target.value}:l))}/><code>{lib.id}</code><label><input type="checkbox" checked={lib.enabled} onChange={e=>setLibraries(libraries.map((l,i)=>i===index?{...l,enabled:e.target.checked}:l))}/>启用</label><Button size="small" variant="quiet" onClick={()=>setLibraries(libraries.filter((_,i)=>i!==index))}>移除定义</Button></div>)}
        <Field label="按知识库查看 / 新建文档归属"><select value={libraryId} onChange={e=>{setLibraryId(e.target.value);setCategory(null);}}><option value="">全部文档（含未归属）</option>{libraries.map(lib=><option key={lib.id} value={lib.id}>{lib.name}{lib.enabled?'':'（停用）'}</option>)}</select></Field>
      </div>
      </details>
      <div className="docs">
        <aside className="docs-list">
          <input
            className="docs-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索标题"
            aria-label="搜索文档"
          />
          <div className="docs-cats">
            <button
              type="button"
              className={`memo-chip${category === null ? ' active' : ''}`}
              onClick={() => setCategory(null)}
            >
              全部 <b>{documents.length}</b>
            </button>
            {(list.data.categories ?? [])
              .filter((entry) => stats.categories.some((item) => item.category === entry.id))
              .map((entry) => {
                const count = stats.categories.find((item) => item.category === entry.id)?.count ?? 0;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={`memo-chip${category === entry.id ? ' active' : ''}`}
                    onClick={() => setCategory(category === entry.id ? null : entry.id)}
                  >
                    {entry.label} <b>{count}</b>
                  </button>
                );
              })}
          </div>
          <ul className="docs-items">
            {visible.map((entry) => (
              <li key={entry.slug}>
                <button
                  type="button"
                  className={`docs-item${entry.slug === active ? ' active' : ''}`}
                  onClick={() => setActive(entry.slug)}
                >
                  <span className="docs-item-title">{entry.title}</span>
                  <span className="docs-item-meta">
                    {labels[entry.category] ?? entry.category} · {entry.chars} 字 · {fmtRelative(entry.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
            {visible.length === 0 ? <Empty title="没有匹配的文档" hint="换个分类或清空搜索。" /> : null}
          </ul>
        </aside>

        <section className="docs-reader">
          {doc.error ? <ErrorBox error={doc.error} onRetry={() => void doc.reload()} /> : null}
          {!active ? (
            <Empty title="选一篇打开" hint="左边是文档列表，右边可以直接改。" />
          ) : doc.loading && !current ? (
            <Loading label="正在打开…" />
          ) : current && draft !== null ? (
            <>
              <div className="docs-head">
                <input
                  className="docs-title"
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  aria-label="文档标题"
                />
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <Badge tone="muted">{labels[current.category] ?? current.category}</Badge>
                  {dirty ? <Badge tone="warn">未保存</Badge> : <Badge tone="ok">已同步</Badge>}
                  <Button variant="quiet" size="small" disabled={saving} onClick={() => void remove()}>
                    删除
                  </Button>
                </div>
              </div>
              <textarea
                className="docs-body"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck={false}
                aria-label="文档正文"
              />
              <div className="docs-foot">
                <span>
                  {draft.length.toLocaleString()} 字 · 保存于 {fmtDateTime(current.updatedAt)}
                </span>
                <span className="muted">{current.source || '手工创建'}</span>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </Card>
  );
}
