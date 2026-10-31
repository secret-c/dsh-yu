import fs from 'node:fs';
import path from 'node:path';
import { now, truncate } from './util.js';
import { summarizeEvents } from './agent-host.js';

/**
 * Archiving.
 *
 * An archive is the immutable材料 for one completed run: the real input, the
 * final reply, the tool calls that shaped it, the project snapshot it acted on,
 * and the exact session range it came from. DSH keeps the raw session log; Yu
 * keeps this projection plus the range, and records every gap it could not fill
 * instead of pretending the material is complete.
 */
export function createArchiveService({ repo, settings, paths, log }) {
  const writeMarkdown = (archive, material, task, conversation) => {
    try {
      fs.mkdirSync(paths.archivesDir, { recursive: true });
      const lines = [
        `# 归档 ${archive.id}`,
        '',
        `- 时间：${new Date(archive.createdAt).toISOString()}`,
        `- 任务：${task?.name ?? '（网页对话）'}`,
        `- 对话：${conversation?.title || conversation?.id || '—'}`,
        `- 会话：${material.sessionId ?? '—'}（seq ${archive.fromSeq}–${archive.toSeq}）`,
        `- 模型：${material.route?.provider ?? '?'}/${material.route?.model ?? '?'}`,
        `- 项目：${material.project?.id ?? '—'}`,
        '',
        '## 输入',
        '',
        material.input || '（空）',
        '',
        '## 回复',
        '',
        material.reply || '（空）',
        '',
      ];
      if (material.toolCalls?.length) {
        lines.push('## 工具调用', '');
        for (const call of material.toolCalls) {
          lines.push(`### ${call.name}`, '', '```json', JSON.stringify(call.arguments ?? {}, null, 2), '```');
          if (call.isError) lines.push(`> 错误：${call.error?.message ?? call.resultText ?? ''}`);
          else if (call.resultText) lines.push('```', truncate(call.resultText, 2000), '```');
          lines.push('');
        }
      }
      if (material.notes?.length) {
        lines.push('## 笔记', '');
        for (const note of material.notes) lines.push(`- （${note.kind}）${truncate(note.text, 1200)}`);
        lines.push('');
      }
      if (material.gaps?.length) {
        lines.push('## 采集缺口', '');
        for (const gap of material.gaps) lines.push(`- ${gap}`);
        lines.push('');
      }
      const target = path.join(paths.archivesDir, `${archive.id}.md`);
      fs.writeFileSync(target, lines.join('\n'), 'utf8');
      return target;
    } catch (error) {
      log?.warn(`writing archive markdown failed: ${error.message}`);
      return null;
    }
  };

  return {
    /**
     * Archive one run. `summary` is the durable turn summary; `events` is the
     * raw session slice used to detect collection gaps.
     */
    archiveRun({ run, task, conversation, summary, compiled, events = null, fromSeq = 0, toSeq = 0 }) {
      const gaps = [];
      if (!summary?.sessionId) gaps.push('没有会话标识，无法关联 DSH 原始日志');
      if (events === null) gaps.push('原始事件未采集（仅使用摘要）');
      else if (!events.length) gaps.push('该区间没有可读的会话事件');
      const missingResults = (summary?.toolCalls ?? []).filter((c) => c.resultText === undefined);
      if (missingResults.length) {
        gaps.push(`${missingResults.length} 次工具调用没有结果记录`);
      }

      const notes = [];
      if (task?.kind === 'reading' && summary?.assistantText) {
        notes.push({ kind: 'reading-note', text: summary.assistantText });
      }

      const material = {
        source: 'dsh-session',
        taskId: task?.id ?? null,
        taskKind: task?.kind ?? 'chat',
        triggerReason: run.triggerReason,
        input: run.inputText,
        reply: summary?.assistantText ?? run.outputText ?? '',
        reasoning: summary?.reasoning ?? '',
        toolCalls: (summary?.toolCalls ?? []).map((c) => ({
          name: c.name,
          arguments: c.arguments,
          resultText: c.resultText === undefined ? null : truncate(c.resultText, 4000),
          isError: Boolean(c.isError),
          error: c.error ?? null,
        })),
        notes,
        project: compiled?.project ? { id: compiled.project.id, name: compiled.project.name, state: compiled.project.state } : null,
        route: { provider: compiled?.route?.provider ?? null, model: compiled?.route?.model ?? null, effort: compiled?.route?.reasoningEffort ?? null },
        usage: summary?.usage ?? {},
        turnEnd: summary?.turnEnd ?? null,
        sessionId: summary?.sessionId ?? null,
        contextSnapshotId: run.contextSnapshotId ?? null,
        memoryVersion: compiled?.memory?.version ?? null,
        styleVersion: compiled?.style?.version ?? null,
        gaps,
        collectedAt: now(),
      };

      const archive = repo.archives.create({
        runId: run.id,
        conversationId: conversation?.id ?? null,
        taskId: task?.id ?? null,
        projectId: compiled?.project?.id ?? task?.projectId ?? null,
        fromSeq,
        toSeq,
        material,
      });
      const file = writeMarkdown(archive, material, task, conversation);
      if (file) {
        try {
          repo.raw.run('UPDATE archives SET path = ? WHERE id = ?', file, archive.id);
        } catch (error) {
          log?.debug(`recording archive path failed: ${error.message}`);
        }
      }
      if (conversation?.id) {
        repo.conversations.update(conversation.id, {
          archiveCursorSeq: Math.max(conversation.archiveCursorSeq ?? 0, toSeq),
        });
      }
      return repo.archives.get(archive.id);
    },

    /**
     * Capture the rest of a conversation before it is closed.
     *
     * Archiving used to mean "flip a flag": runs that never produced an archive —
     * a reply shorter than the archive threshold, a failed turn, a run whose
     * policy said not to archive — were left out of memory forever. On close, the
     * messages not covered by any existing archive are folded into one tail
     * archive, so the memory pass that follows sees the whole conversation.
     */
    archiveConversationTail({ conversation, limit = 1000 }) {
      if (!conversation?.id) return { created: false, reason: 'no-conversation' };
      const coveredRows = repo.raw.all(
        'SELECT run_id FROM archives WHERE conversation_id = ? AND run_id IS NOT NULL',
        conversation.id,
      );
      const covered = new Set(coveredRows.map((row) => row.run_id));
      const messages = repo.messages
        .list(conversation.id, { limit })
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .filter((message) => !message.runId || !covered.has(message.runId));
      if (!messages.length) return { created: false, reason: 'nothing-unarchived' };

      const input = messages
        .filter((message) => message.role === 'user')
        .map((message) => message.text)
        .join('\n')
        .trim();
      const reply = messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.text)
        .join('\n')
        .trim();
      const material = {
        source: 'conversation-tail',
        taskId: null,
        taskKind: conversation.kind ?? 'chat',
        triggerReason: '归档时补齐',
        input,
        reply,
        notes: [],
        toolCalls: [],
        project: null,
        route: null,
        usage: {},
        turnEnd: null,
        sessionId: conversation.sessionId ?? null,
        gaps: [],
        collectedAt: now(),
      };
      const archive = repo.archives.create({
        runId: null,
        conversationId: conversation.id,
        taskId: null,
        projectId: null,
        fromSeq: 0,
        toSeq: conversation.archiveCursorSeq ?? 0,
        material,
      });
      return { created: true, archiveId: archive.id, messages: messages.length };
    },

    /** Re-export scheduled: a human can rebuild the Markdown projection. */
    exportAll(limit = 200) {
      const list = repo.archives.list({ limit });
      return list.map((archive) => ({
        id: archive.id,
        path: archive.path,
        createdAt: archive.createdAt,
        absorbedAt: archive.absorbedAt,
      }));
    },

    summarizeForMaintenance(archive) {
      const m = archive.material ?? {};
      return {
        id: archive.id,
        at: archive.createdAt,
        taskKind: m.taskKind,
        input: truncate(m.input ?? '', 400),
        reply: truncate(m.reply ?? '', 1200),
        notes: (m.notes ?? []).map((n) => truncate(n.text ?? '', 600)),
        tools: (m.toolCalls ?? []).map((c) => ({ name: c.name, ok: !c.isError })),
        project: m.project ? { id: m.project.id, name: m.project.name, state: m.project.state } : null,
      };
    },
  };
}

export { summarizeEvents };
