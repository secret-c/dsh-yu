/**
 * A very small HTTP router: exact and `:param` segments, per-method tables,
 * JSON body parsing with a size cap, uniform error envelopes, and an SSE helper.
 *
 * It is deliberately not a framework: Yu's API is ~60 routes and the plugin must
 * stay dependency-free.
 */

export class HttpError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const MAX_BODY = 2 * 1024 * 1024;

export function readBody(req, { maxBytes = MAX_BODY, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'BODY_TOO_LARGE', `请求体超过 ${maxBytes} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (raw) {
        resolve(buffer.toString('utf8'));
        return;
      }
      if (!buffer.length) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(buffer.toString('utf8')));
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', (error) => reject(new HttpError(400, 'BODY_READ_FAILED', error.message)));
  });
}

function matchPath(pattern, pathname) {
  if (pattern === pathname) return {};
  if (!pattern.includes(':')) return null;
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected.startsWith(':')) {
      if (!actual) return null;
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export function createRouter({ log } = {}) {
  const routes = [];

  const add = (method, pattern, handler, options = {}) => {
    routes.push({ method, pattern, handler, options });
    return () => {
      const index = routes.indexOf(routes.find((r) => r.method === method && r.pattern === pattern));
      if (index >= 0) routes.splice(index, 1);
    };
  };

  const resolve = (method, pathname) => {
    for (const route of routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.pattern, pathname);
      if (params) return { route, params };
    }
    return null;
  };

  const handle = async (req, res, { authenticate, guard, extra = {} } = {}) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    const found = resolve(method, pathname);

    if (!found) {
      // HEAD falls back to GET for convenience.
      if (method === 'HEAD') {
        const getFound = resolve('GET', pathname);
        if (getFound) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end();
          return true;
        }
      }
      return false;
    }

    const { route, params } = found;
    const requestContext = {
      req,
      res,
      params,
      query: Object.fromEntries(url.searchParams.entries()),
      url,
      ...extra,
    };

    try {
      if (authenticate && !route.options.public) {
        const identity = await authenticate(req, res);
        if (!identity) return true; // authenticate already answered
        requestContext.auth = identity;
      }
      // Last line of defence for a runtime that must not be written to: a
      // data-root switch closes the door instead of racing the writer.
      if (guard) await guard(requestContext, { method, pathname });
      if (!route.options.rawBody && method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
        const length = Number(req.headers['content-length'] ?? 0);
        if (length > 0) requestContext.body = await readBody(req, route.options);
        else requestContext.body = null;
      } else if (route.options.rawBody) {
        requestContext.body = await readBody(req, { raw: true, maxBytes: route.options.maxBytes });
      }
      const result = await route.handler(requestContext);
      if (result === undefined || res.writableEnded || res.headersSent) return true;
      if (result && typeof result === 'object' && result.__sse) {
        return true;
      }
      sendJson(res, 200, result);
      return true;
    } catch (error) {
      if (res.writableEnded || res.headersSent) return true;
      const status = error.status ?? (error.code === 'NOT_FOUND' ? 404 : 500);
      if (status >= 500) log?.error(`api ${method} ${pathname} failed: ${error.stack ?? error.message}`);
      else log?.debug(`api ${method} ${pathname} -> ${status}: ${error.message}`);
      sendJson(res, status, {
        error: {
          code: error.code ?? 'INTERNAL',
          message: status >= 500 && !error.status ? '服务器内部错误，请查看服务日志' : error.message ?? '服务器内部错误',
          detail: status >= 500 && !error.status ? null : error.detail ?? null,
        },
      });
      return true;
    }
  };

  return {
    get: (pattern, handler, options) => add('GET', pattern, handler, options),
    post: (pattern, handler, options) => add('POST', pattern, handler, options),
    patch: (pattern, handler, options) => add('PATCH', pattern, handler, options),
    put: (pattern, handler, options) => add('PUT', pattern, handler, options),
    delete: (pattern, handler, options) => add('DELETE', pattern, handler, options),
    handle,
    routes: () => routes.map((r) => `${r.method} ${r.pattern}`),
  };
}

export function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value ?? null), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * Start an SSE response. Returns a writer with `event(type, data)` / `close()`,
 * and registers a heartbeat so proxies keep the connection open.
 */
export function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  let closed = false;
  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15_000);
  heartbeat.unref?.();

  return {
    event(type, data) {
      if (closed) return;
      try {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data ?? null)}\n\n`);
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {
        /* ignore */
      }
    },
    get closed() {
      return closed;
    },
  };
}
