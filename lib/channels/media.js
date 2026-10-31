import fs from 'node:fs';
import path from 'node:path';

/**
 * Incoming images.
 *
 * A chat platform hands Yu a URL, and everything downstream — the model, the
 * reader, the archive — works with files. This turns one into the other: fetch
 * the picture, store it under `uploads/<channel type>/<day>/`, and hand back the
 * absolute path so a run can actually look at it.
 *
 * It is deliberately forgiving: one broken image must not drop the message that
 * carried it, so a failure becomes a note in the run input, not an exception.
 */

const MAX_BYTES = 8 * 1024 * 1024;

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

function extensionOf(url, contentType) {
  const byType = EXTENSIONS[String(contentType ?? '').toLowerCase().split(';')[0]];
  if (byType) return byType;
  const match = String(url ?? '').match(/\.([A-Za-z0-9]{2,5})(?:\?|$)/);
  return match ? match[1].toLowerCase() : 'jpg';
}

export function createChannelMedia({ paths, log }) {
  const dirFor = (channel, at) => {
    const day = new Date(at).toISOString().slice(0, 10);
    return path.join(paths.uploads, String(channel.type ?? 'chat'), day);
  };

  /**
   * @returns {Promise<Array<{path?: string, bytes?: number, type?: string, error?: string, source?: string}>>}
   */
  const ingest = async ({ channel, event, images = [], maxImages = 4 }) => {
    const out = [];
    const list = Array.isArray(images) ? images.slice(0, maxImages) : [];
    for (const [index, image] of list.entries()) {
      const url = String(image?.url ?? image?.file ?? '').trim();
      if (!url) continue;
      // OneBot sometimes reports a path on the bot's own host; that is not
      // reachable from here, so it is recorded rather than guessed at.
      if (!/^https?:\/\//i.test(url)) {
        out.push({ error: '图片地址不是 HTTP URL，无法下载', source: url.slice(0, 160) });
        continue;
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) throw new Error('空文件');
        if (buffer.length > MAX_BYTES) throw new Error(`超过 ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);
        const type = response.headers.get('content-type') ?? '';
        const dir = dirFor(channel, Number(event?.at) || Date.now());
        fs.mkdirSync(dir, { recursive: true });
        const stem = String(event?.eventId ?? `msg-${Date.now()}`).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
        const file = path.join(dir, `${stem}-${index}.${extensionOf(url, type)}`);
        fs.writeFileSync(file, buffer, { mode: 0o600 });
        out.push({ path: file, bytes: buffer.length, type, source: url.slice(0, 200) });
        log?.debug(`saved chat image ${file} (${buffer.length} bytes)`);
      } catch (error) {
        out.push({ error: error.message, source: url.slice(0, 200) });
        log?.warn(`downloading a chat image failed: ${error.message}`);
      }
    }
    return out;
  };

  /**
   * Turn download results into lines a model can act on: the absolute path for
   * each picture, and an explicit note for each failure so "I can't see it" is
   * never invented.
   */
  const describe = (saved) =>
    saved
      .map((item) =>
        item.path
          ? `[图片已保存: ${item.path}（${Math.round((item.bytes ?? 0) / 1024)} KB）——可以用 read_image 打开]`
          : `[图片无法读取: ${item.error ?? '未知原因'}（来源 ${item.source ?? '—'}）]`,
      )
      .join('\n');

  return { ingest, describe, dirFor };
}

/**
 * Pull image URLs out of already-rendered chat text.
 *
 * Group messages are buffered as text, and the adapter renders an image as
 * `[图片:https://…]`. By the time a look is assembled the URL is the only thing
 * left, so the look has to fetch it itself — otherwise the model is told about a
 * picture it has no file for.
 */
export function collectImageUrls(texts, { limit = 4 } = {}) {
  const urls = [];
  const seen = new Set();
  for (const text of texts ?? []) {
    for (const match of String(text ?? '').matchAll(/\[图片[:：]\s*(https?:\/\/[^\]]+)\]/g)) {
      const url = match[1].trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= limit) return urls;
    }
  }
  return urls;
}
