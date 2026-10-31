import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { now, truncate } from './util.js';

/**
 * The reading project.
 *
 * Chapter progress lives in the project state and is the only authority for
 * "where are we". Memory only ever receives a summary. The advance is a
 * compare-and-swap on `state.revision` guarded by the run id, so a crash between
 * the model reply and the commit cannot advance twice, and a repeated commit of
 * the same run is a no-op.
 */

export function splitChapters(text) {
  const source = String(text ?? '');
  const matches = [...source.matchAll(/^##\s+(.+)$/gm)];
  if (!matches.length) {
    return [{ index: 0, title: '正文', text: source.trim(), sha: sha(source) }];
  }
  return matches.map((match, i) => {
    const body = source.slice(match.index, matches[i + 1]?.index ?? source.length).trim();
    return { index: i, title: match[1].trim(), text: body, sha: sha(body) };
  });
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function defaultReadingState() {
  return {
    revision: 0,
    progress: 0,
    source: null, // { path, sha, loadedAt, chapters: [{index,title,chars}] }
    notes: [],
    finished: false,
    lastRunId: null,
  };
}

export class ReadingError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'ReadingError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Load the source text. Books are read fresh each run but a changed digest is
 * refused unless the caller explicitly resets, because silently continuing at
 * the old chapter index in a different file would corrupt progress.
 */
export function loadSource(sourcePath) {
  if (!sourcePath) {
    throw new ReadingError('尚未选择小说文件', 'NO_SOURCE', 409);
  }
  const resolved = path.resolve(sourcePath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new ReadingError(
      `小说文件不可读：${resolved}（${error.code ?? error.message}）`,
      'SOURCE_UNREADABLE',
      409,
    );
  }
  if (!stat.isFile()) throw new ReadingError(`不是文件：${resolved}`, 'SOURCE_NOT_FILE', 409);
  if (stat.size > 8 * 1024 * 1024) {
    throw new ReadingError('小说文件超过 8 MB，请拆分后再用', 'SOURCE_TOO_LARGE', 409);
  }
  const text = fs.readFileSync(resolved, 'utf8');
  const digest = sha(text);
  const chapters = splitChapters(text);
  return {
    path: resolved,
    sha: digest,
    text,
    chapters,
    summary: chapters.map((c) => ({ index: c.index, title: c.title, chars: c.text.length })),
  };
}

export function createReadingService({ repo, settings, log }) {
  const readingProjectState = (projectId) => {
    const project = repo.projects.get(projectId);
    if (!project) return null;
    return { project, state: { ...defaultReadingState(), ...(project.state ?? {}) } };
  };

  return {
    /** Everything the reading page needs: source state, chapters, progress. */
    status(projectId) {
      const loaded = readingProjectState(projectId);
      if (!loaded) return null;
      const { project, state } = loaded;
      const sourcePath = state.source?.path ?? project.state?.sourcePath ?? '';
      let sourceInfo = null;
      let error = null;
      if (sourcePath) {
        try {
          const source = loadSource(sourcePath);
          sourceInfo = {
            path: source.path,
            sha: source.sha,
            chapters: source.chapters.map((c) => ({ index: c.index, title: c.title, chars: c.text.length })),
          };
          if (state.source?.sha && state.source.sha !== source.sha) {
            error = {
              code: 'SOURCE_CHANGED',
              message: '文件内容已变化。请确认后重置进度，否则不应继续推进章节。',
            };
          }
        } catch (e) {
          error = { code: e.code ?? 'SOURCE_UNREADABLE', message: e.message };
        }
      }
      const total = sourceInfo?.chapters.length ?? state.source?.chapters?.length ?? 0;
      return {
        projectId,
        name: project.name,
        state,
        sourcePath,
        source: sourceInfo ?? state.source,
        error,
        progress: state.progress ?? 0,
        total,
        finished: (state.progress ?? 0) >= total && total > 0,
        currentChapter: sourceInfo?.chapters?.[state.progress ?? 0] ?? null,
      };
    },

    setSource(projectId, sourcePath) {
      const project = repo.projects.get(projectId);
      if (!project) throw new ReadingError('项目不存在', 'NOT_FOUND', 404);
      const source = loadSource(sourcePath);
      return repo.projects.upsert({
        id: projectId,
        name: project.name,
        kind: project.kind,
        state: {
          ...defaultReadingState(),
          ...(project.state ?? {}),
          revision: (project.state?.revision ?? 0) + 1,
          progress: 0,
          finished: false,
          source: {
            path: source.path,
            sha: source.sha,
            loadedAt: now(),
            chapters: source.summary,
          },
          notes: [],
        },
      });
    },

    setProgress(projectId, progress) {
      const loaded = readingProjectState(projectId);
      if (!loaded) throw new ReadingError('项目不存在', 'NOT_FOUND', 404);
      const total = loaded.state.source?.chapters?.length ?? 0;
      const next = Number(progress);
      if (!Number.isInteger(next) || next < 0 || (total > 0 && next > total)) {
        throw new ReadingError(`进度必须在 0 到 ${total} 之间`, 'INVALID_PROGRESS', 400);
      }
      return repo.projects.upsert({
        id: projectId,
        name: loaded.project.name,
        kind: loaded.project.kind,
        state: { ...loaded.state, revision: (loaded.state.revision ?? 0) + 1, progress: next, finished: total > 0 && next >= total },
      });
    },

    /**
     * Materials for one reading turn. Returns `null` when the book is finished,
     * so the caller can record a completion message without a model call.
     */
    prepare(projectId, { task }) {
      const loaded = readingProjectState(projectId);
      if (!loaded) throw new ReadingError('阅读项目不存在', 'PROJECT_NOT_FOUND', 404);
      const { project, state } = loaded;
      if (!state.source?.path) throw new ReadingError('尚未选择小说文件', 'NO_SOURCE', 409);
      const source = loadSource(state.source.path);
      if (state.source.sha && source.sha !== state.source.sha) {
        throw new ReadingError('小说文件内容已变化，请先在阅读页面重置进度', 'SOURCE_CHANGED', 409);
      }
      const progress = state.progress ?? 0;
      if (progress >= source.chapters.length) {
        return { finished: true, project, state, total: source.chapters.length };
      }
      const chapter = source.chapters[progress];
      const instruction =
        task?.inputTemplate?.trim() ||
        '阅读下面这一章，写出有具体依据的阅读笔记：发生了什么、人物的变化、一个值得继续追踪的问题。' +
          '请区分原文事实与你的推测，不要把虚构人物当成真实人物。自然写作，不要输出 JSON。';
      const input = [
        instruction,
        '',
        `书名/项目：${project.name}`,
        `进度：第 ${progress + 1} / ${source.chapters.length} 章`,
        `章节标题：${chapter.title}`,
        '',
        '—— 原文开始 ——',
        truncate(chapter.text, 16000),
        '—— 原文结束 ——',
      ].join('\n');
      return {
        finished: false,
        project,
        state,
        chapter,
        progress,
        total: source.chapters.length,
        sourceSha: source.sha,
        input,
      };
    },

    /**
     * Commit progress for a completed run. Idempotent per `runId` and guarded by
     * the state revision captured in `prepare`, so neither a retry nor a
     * concurrent run can advance twice.
     */
    commit({ projectId, runId, chapter, note, sourceSha, expectedRevision }) {
      return repo.projects.advance(projectId, (state) => {
        const merged = { ...defaultReadingState(), ...(state ?? {}) };
        if (merged.lastRunId === runId) return null; // already committed
        if (expectedRevision !== undefined && merged.revision !== expectedRevision) {
          throw new ReadingError(
            `项目状态已被其他运行修改（期望 revision ${expectedRevision}，实际 ${merged.revision}）`,
            'CHECKPOINT_CONFLICT',
            409,
          );
        }
        if (merged.source?.sha && sourceSha && merged.source.sha !== sourceSha) {
          throw new ReadingError('小说文件在本次运行期间发生变化，已拒绝推进进度', 'SOURCE_CHANGED', 409);
        }
        const nextProgress = Math.min((merged.progress ?? 0) + 1, merged.source?.chapters?.length ?? Infinity);
        const notes = [
          ...(merged.notes ?? []),
          {
            chapter: chapter.index + 1,
            title: chapter.title,
            text: truncate(note ?? '', 2000),
            at: now(),
            runId,
            chapterSha: chapter.sha,
          },
        ].slice(-200);
        return {
          ...merged,
          revision: (merged.revision ?? 0) + 1,
          progress: nextProgress,
          finished: nextProgress >= (merged.source?.chapters?.length ?? 0),
          lastRunId: runId,
          notes,
        };
      });
    },
  };
}
