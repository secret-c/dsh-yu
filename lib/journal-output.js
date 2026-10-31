import { parseJournalCursor, compareJournalCursor } from './session-rollover.js';

export function persistJournal({ repo, run, text }) {
  if (!String(text ?? '').trim()) throw Object.assign(new Error('日记没有正文，未创建文档'), { code: 'JOURNAL_EMPTY' });
  const date = run.meta?.rolloverDay ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(run.meta?.trigger?.scheduledFor || run.queuedAt || Date.now()));
  const slug = repo.documents.get(`journal-${date}`)?.slug ??
    repo.documents.list({ category: 'diary' }).find(document => document.title.includes(date))?.slug ??
    `journal-${date}`;
  const marker = `<!-- yu-journal:${run.id} -->`;
  // The page and its source cursor commit together. A failed next page can
  // retry without rewriting a previously saved page or skipping raw sources.
  return (repo.transaction ?? (fn => fn()))(() => {
    const existing = repo.documents.get(slug);
    let document = existing;
    if (!existing?.content.includes(marker) && existing?.source !== `任务运行 ${run.id}`) {
      const addition = existing ? `\n\n## 续记\n\n${String(text).trim()}\n\n${marker}` : `${String(text).trim()}\n\n${marker}`;
      document = existing
        ? repo.documents.update(slug, { content: existing.content + addition })
        : repo.documents.upsert({ slug, title: `${date} 日记`, category: 'diary', content: addition, source: `任务运行 ${run.id}` });
    }
    if (run.meta?.journalSourceCursor && repo.setSyncMeta) {
      const key = `journal.cursor.${date}`;
      const cursor = parseJournalCursor(run.meta.journalSourceCursor);
      if (compareJournalCursor(cursor, repo.syncMeta?.(key)) > 0) repo.setSyncMeta(key, JSON.stringify(cursor));
    }
    return document;
  });
}
