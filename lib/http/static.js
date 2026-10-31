import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the built admin SPA. Any path that is not a real file falls back to
 * `index.html`, so client-side routing works without server cooperation.
 * Paired with a strict path join so `..` can never escape the build directory.
 */
export function createStaticHandler({ root, log, prefix = '', transformHtml = null }) {
  const indexPath = path.join(root, 'index.html');

  const serveFile = (res, filePath, { immutable = false, head = false } = {}) => {
    let data;
    try {
      data = fs.readFileSync(filePath);
    } catch {
      return false;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (head) res.end();
    else res.end(data);
    return true;
  };

  return {
    available: () => fs.existsSync(indexPath),
    /**
     * @returns true when a response was written.
     */
    handle(req, res, pathname) {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') return false;
      const head = method === 'HEAD';

      let relative = pathname;
      if (prefix && relative.startsWith(prefix)) relative = relative.slice(prefix.length);
      relative = relative.replace(/^\/+/, '');

      if (relative) {
        const resolved = path.resolve(root, relative);
        const rootResolved = path.resolve(root);
        if (resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)) {
          if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            const immutable = resolved.includes(`${path.sep}assets${path.sep}`);
            if (serveFile(res, resolved, { immutable, head })) return true;
          }
        } else {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return true;
        }
      }

      if (fs.existsSync(indexPath)) {
        // Never cache the shell: it references content-hashed assets.
        const html = fs.readFileSync(indexPath, 'utf8');
        const body = Buffer.from(transformHtml ? transformHtml(html) : html, 'utf8');
        res.writeHead(200, {
          'content-type': TYPES['.html'],
          'content-length': body.length,
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        if (head) res.end();
        else res.end(body);
        return true;
      }
      return false;
    },
  };
}
