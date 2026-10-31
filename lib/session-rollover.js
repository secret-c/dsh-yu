import { dayKey, startOfDay, addDays } from './util.js';

export function rolloverReason(conversation, at, timeZone, rotation) {
  if (!conversation?.sessionId || conversation.archivedAt || conversation.meta?.maintenance ||
      conversation.sessionId.startsWith('yu-maint-')) return null;
  if (conversation.meta?.rolloverDue?.sessionId === conversation.sessionId)
    return conversation.meta.rolloverDue.reason;
  if (rotation === 'daily' && conversation.meta?.sessionDay &&
      conversation.meta.sessionDay < dayKey(at, timeZone)) return 'day-end';
  return null;
}

export function ownerIds(settings) {
  return new Set(String(settings.get('channel.ownerIds') ?? '').split(/[,\s，、]+/).filter(Boolean));
}

export function isOwnerMainChat(conversation, settings) {
  return conversation.kind === 'qq_private' && ownerIds(settings).has(String(conversation.peerId ?? '')) &&
    (conversation.meta?.routeAuthority === 'owner' || conversation.meta?.sessionDelivery?.authority === 'owner');
}

export function parseJournalCursor(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = Number(value); }
  }
  if (typeof value === 'number') return { at: Number.isFinite(value) ? value : 0, id: '\uffff', offset: 0 };
  return { at: Number(value?.at) || 0, id: String(value?.id ?? ''), offset: Math.max(0, Number(value?.offset) || 0) };
}

export function compareJournalCursor(a, b) {
  const x = parseJournalCursor(a), y = parseJournalCursor(b);
  return x.at - y.at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0) || x.offset - y.offset;
}

// At most 30 fragments / 8000 characters per page. A large completed run is
// consumed in slices; the offset is committed only after its page is saved.
export function dailyJournalSources(repo, day, timeZone, after = null) {
  const cursor = parseJournalCursor(after);
  const from = startOfDay(day, timeZone), to = startOfDay(addDays(day, 1), timeZone);
  const rows = repo.runs.listJournalSources
    ? repo.runs.listJournalSources({ from, to, cursor, limit: 31 })
    : repo.runs.list({ limit: 1000 }).filter(run => {
      const at = run.finishedAt ?? run.queuedAt;
      const task = run.taskId ? repo.tasks.get(run.taskId) : null;
      return dayKey(run.queuedAt, timeZone) === day && run.businessDone && run.status === 'succeeded' &&
        !run.meta?.internalRollover && run.meta?.authority !== 'guest' && run.meta?.kind !== 'qq_group' &&
        task?.kind !== 'maintenance' && task?.kind !== 'journal' &&
        !(run.meta?.source === 'message' && run.meta?.authority !== 'owner') &&
        (at > cursor.at || (at === cursor.at && (run.id > cursor.id || (run.id === cursor.id && cursor.offset > 0))));
    }).sort((a, b) => (a.finishedAt ?? a.queuedAt) - (b.finishedAt ?? b.queuedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 31);
  const included = [], runIds = [];
  let used = 0, completedRows = 0, next = { ...cursor };
  for (const run of rows) {
    const task = run.taskId ? repo.tasks.get(run.taskId) : null;
    const at = run.finishedAt ?? run.queuedAt;
    const source = Array.from(`用户：${run.inputText ?? ''}\n回复：${run.outputText ?? ''}`);
    let offset = at === cursor.at && run.id === cursor.id ? cursor.offset : 0;
    do {
      const header = `[${run.id} · ${task?.name ?? '对话'} · 字符 ${offset + 1} 起]\n`;
      const room = 8000 - used - header.length - 2;
      if (included.length >= 30 || room < 1) break;
      let count = Math.min(1600, Math.max(0, source.length - offset), room);
      let chunk = source.slice(offset, offset + count).join('');
      while (chunk.length > room) chunk = source.slice(offset, offset + --count).join('');
      if (count < 1) break;
      const body = header + chunk;
      included.push(body); runIds.push(run.id); used += body.length + 2;
      offset += count;
      next = { at, id: run.id, offset: offset < source.length ? offset : 0 };
    } while (offset < source.length);
    if (offset < source.length) break;
    completedRows++;
  }
  return { text: included.join('\n\n'), runIds, included: included.length,
    cursor: next, truncated: next.offset > 0 || completedRows < rows.length };
}
