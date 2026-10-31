export function persistJournal({ repo, run, text }) {
  if (!String(text ?? '').trim()) throw Object.assign(new Error('日记没有正文，未创建文档'), { code: 'JOURNAL_EMPTY' });
  const slug = `journal-${run.id}`;
  const existing = repo.documents.get(slug);
  if (existing) return existing;
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(run.meta?.trigger?.scheduledFor || run.queuedAt || Date.now()));
  return repo.documents.upsert({ slug, title: `${date} 日记`, category: 'diary', content: text, source: `任务运行 ${run.id}` });
}
