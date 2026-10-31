import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createChannelMedia } from '../lib/channels/media.js';

/**
 * Incoming pictures must become files.
 *
 * A chat platform gives a URL; the model needs a path. This covers the two
 * outcomes that matter: a real download that lands under uploads/ and can be
 * named in the run input, and a broken image that is reported as broken instead
 * of being silently dropped.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('a chat image is downloaded to uploads and described by path', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const uploads = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yu-media-')), 'uploads');
  t.after(() => fs.rmSync(path.dirname(uploads), { recursive: true, force: true }));

  const media = createChannelMedia({ paths: { uploads }, log: null });
  const saved = await media.ingest({
    channel: { type: 'napcat' },
    event: { eventId: 'evt_1', at: Date.parse('2026-10-27T12:00:00Z') },
    images: [{ url: `http://127.0.0.1:${port}/ok.png` }, { url: `http://127.0.0.1:${port}/missing.png` }],
  });

  assert.equal(saved.length, 2);
  assert.ok(saved[0].path, JSON.stringify(saved[0]));
  assert.equal(fs.readFileSync(saved[0].path).equals(PNG), true, 'bytes are stored unchanged');
  assert.match(saved[0].path, /uploads[\\/]napcat[\\/]2026-10-27[\\/]/);
  assert.ok(saved[1].error, 'a 404 is reported, not swallowed');

  const note = media.describe(saved);
  assert.match(note, /图片已保存: /);
  assert.match(note, /read_image/);
  assert.match(note, /图片无法读取: HTTP 404/);
});

test('a non-http image reference is reported without a fetch', async (t) => {
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'yu-media-'));
  t.after(() => fs.rmSync(uploads, { recursive: true, force: true }));
  const media = createChannelMedia({ paths: { uploads }, log: null });
  const saved = await media.ingest({
    channel: { type: 'snowluma' },
    event: { eventId: 'evt_2', at: Date.now() },
    images: [{ url: '/tmp/astrbot/data/temp/1.jpg' }],
  });
  assert.equal(saved.length, 1);
  assert.match(saved[0].error, /不是 HTTP URL/);
  assert.equal(fs.readdirSync(uploads).length, 0);
});
