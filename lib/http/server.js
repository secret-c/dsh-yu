import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { sendJson, readBody } from './router.js';
import { createStaticHandler } from './static.js';

/**
 * Yu's HTTP surface.
 *
 * Two entrances, one implementation:
 *  - the plugin's own listener on a fixed port, which yields a *stable* URL
 *    (`http://127.0.0.1:58800/`) because the harness web port is OS-assigned;
 *  - an optional `/yu` prefix route on the harness web server, so the console is
 *    also reachable from the DeepSeek Harness origin while it runs.
 *
 * Both run the same router, auth and static handler, so a route exists exactly
 * once.
 */
export function createHttpService({ log, router, auth, distRoot, basePath = '', guard = null }) {
  const extraRoutes = []; // { kind, path, handler, options }
  const upgrades = []; // { path, handler }
  let accepting = true;
  const inFlight = new Set();
  let server = null;
  let listening = null;
  let harnessDisposers = [];
  let harnessState = { mounted: false, url: null, reason: null };

  const staticHandler = createStaticHandler({
    root: distRoot,
    log,
    // The console is served from two mount points (`/` and `/yu/`), and assets
    // are relative. Deriving the API base at runtime from the document path keeps
    // one build working under both, without a server-side mount flag.
    transformHtml: (html) =>
      html
        .replace(
          '</head>',
          `<script>window.__YU_BASE__=(location.pathname==='/yu'||location.pathname.startsWith('/yu/'))?'/yu':'${basePath}';` +
            `window.__YU_BUILD__=${JSON.stringify(buildId())};</script></head>`,
        ),
  });

  /**
   * Identity of the built console.
   *
   * The asset file name carries a content hash, so it changes exactly when the UI
   * changes. The page compares this value with the one baked into its own HTML and
   * reloads itself when they differ — otherwise a deployed change stays invisible
   * behind an open tab, which has cost real time.
   */
  function buildId() {
    try {
      const html = fs.readFileSync(path.join(distRoot, 'index.html'), 'utf8');
      const match = /assets\/index-([A-Za-z0-9_-]+)\.js/.exec(html);
      if (match) return match[1];
      return String(Math.round(fs.statSync(path.join(distRoot, 'index.html')).mtimeMs));
    } catch {
      return null;
    }
  }

  const dispatchAccepted = async (req, res, { prefix = '' } = {}) => {
    const rawUrl = req.url ?? '/';
    let pathname = rawUrl.split('?')[0];
    const search = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
    if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      pathname = pathname.slice(prefix.length) || '/';
      req.url = pathname + search;
    }

    // Channel-owned routes (webhooks) take precedence over the SPA fallback.
    for (const route of extraRoutes) {
      const matches =
        route.kind === 'exact'
          ? pathname === route.path
          : pathname === route.path || pathname.startsWith(`${route.path}/`);
      if (!matches) continue;
      try {
        if (route.options?.rawBody) {
          const body = await readBody(req, { raw: true, maxBytes: route.options.maxBytes ?? 512 * 1024 });
          await route.handler(req, res, body);
        } else {
          await route.handler(req, res);
        }
        return true;
      } catch (error) {
        log?.warn(`channel route ${route.path} failed: ${error.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: { code: 'CHANNEL_ROUTE_FAILED', message: error.message } });
        return true;
      }
    }

    const handled = await router.handle(req, res, { authenticate: auth?.authenticate, guard });
    if (handled) return true;

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `没有这个接口：${pathname}` } });
      return true;
    }

    if (staticHandler.handle(req, res, pathname)) return true;

    sendJson(res, 503, {
      error: {
        code: 'WEB_UI_NOT_BUILT',
        message: '前端构建产物缺失（dist/web）。运行 npm run build:web 后重试。',
      },
    });
    return true;
  };

  const dispatch = (req, res, options) => {
    if (!accepting) {
      sendJson(res, 503, { error: { code: 'STOPPING', message: '服务正在停止' } });
      return Promise.resolve(true);
    }
    const pending = dispatchAccepted(req, res, options);
    inFlight.add(pending);
    return pending.finally(() => inFlight.delete(pending));
  };

  const handleRequest = async (req, res) => {
    try {
      await dispatch(req, res);
    } catch (error) {
      log?.error(`unhandled request failure: ${error.stack ?? error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: '未知错误' } });
      else res.destroy();
    }
  };

  const handleUpgrade = (req, socket, head) => {
    if (!accepting) { socket.destroy(); return; }
    const pathname = (req.url ?? '').split('?')[0];
    for (const route of upgrades) {
      if (route.path !== pathname) continue;
      try {
        route.handler(req, socket, head);
      } catch (error) {
        log?.warn(`upgrade handler for ${pathname} failed: ${error.message}`);
        socket.destroy();
      }
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  };

  return {
    /** Content hash of the built console; the page reloads itself when it changes. */
    buildId,
    stopAccepting() { accepting = false; },
    drain() { return Promise.allSettled([...inFlight]); },
    async listen({ port, host }) {
      server = http.createServer(handleRequest);
      server.on('upgrade', handleUpgrade);
      server.keepAliveTimeout = 65_000;
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server?.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      listening = server.address();
      log?.info(`admin console listening on http://${host}:${listening.port}/`);
      return listening;
    },
    /** Register on the harness web server as a secondary entrance. */
    exposeOnHarness(ctx) {
      const webServer = ctx.get?.('webServer');
      if (!webServer?.register) {
        harnessState = { mounted: false, url: null, reason: 'ctx.webServer.register unavailable' };
        return { exposed: false, reason: harnessState.reason };
      }
      try {
        const disposers = [];
        disposers.push(
          webServer.register({
            kind: 'prefix',
            path: '/yu',
            handler: async (req, res) => {
              // `/yu` without a trailing slash would make relative asset URLs
              // resolve against `/`; redirect once so `/yu/` is canonical.
              if ((req.url ?? '').split('?')[0] === '/yu') {
                res.writeHead(302, { location: `/yu/${(req.url ?? '').includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}` });
                res.end();
                return;
              }
              try {
                await dispatch(req, res, { prefix: '/yu' });
              } catch (error) {
                log?.error(`/yu route failed: ${error.stack ?? error.message}`);
                if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: '未知错误' } });
              }
            },
          }),
        );
        if (webServer.registerUpgrade) {
          for (const route of upgrades) {
            try {
              disposers.push(
                webServer.registerUpgrade({
                  path: `/yu${route.path}`,
                  handler: (req, socket, head) => {
                    if (!accepting) { socket.destroy(); return; }
                    if (req.url) req.url = String(req.url).replace(/^\/yu/, '') || '/';
                    route.handler(req, socket, head);
                  },
                }),
              );
            } catch (error) {
              log?.warn(`mirroring upgrade ${route.path} on /yu failed: ${error.message}`);
            }
          }
        }
        harnessDisposers = disposers;
        const url = `${webServer.getOrigin?.() ?? ''}/yu`;
        harnessState = { mounted: true, url, reason: null };
        return { exposed: true, url };
      } catch (error) {
        log?.warn(`exposing /yu on the harness web server failed: ${error.message}`);
        harnessState = { mounted: false, url: null, reason: error.message };
        return { exposed: false, reason: error.message };
      }
    },
    /** Drop the harness mount (a service went away, or the plugin is stopping). */
    releaseHarness() {
      for (const dispose of harnessDisposers) {
        try {
          dispose?.();
        } catch {
          /* ignore */
        }
      }
      harnessDisposers = [];
      harnessState = { mounted: false, url: null, reason: 'released' };
    },
    harnessState: () => ({ ...harnessState }),
    registerRoute(kind, routePath, handler, options = {}) {
      const entry = { kind, path: routePath, handler, options };
      extraRoutes.push(entry);
      return () => {
        const index = extraRoutes.indexOf(entry);
        if (index >= 0) extraRoutes.splice(index, 1);
      };
    },
    registerUpgrade(routePath, handler) {
      const entry = { path: routePath, handler };
      upgrades.push(entry);
      return () => {
        const index = upgrades.indexOf(entry);
        if (index >= 0) upgrades.splice(index, 1);
      };
    },
    url() {
      if (!listening) return null;
      const host = listening.address === '::' || listening.address === '0.0.0.0' ? '127.0.0.1' : listening.address;
      return `http://${host}:${listening.port}/`;
    },
    handleRequest,
    async close() {
      accepting = false;
      await Promise.allSettled([...inFlight]);
      for (const dispose of harnessDisposers) {
        try {
          dispose?.();
        } catch {
          /* ignore */
        }
      }
      harnessDisposers = [];
      upgrades.length = 0;
      extraRoutes.length = 0;
      if (!server) return;
      const current = server;
      server = null;
      listening = null;
      await new Promise((resolve) => {
        current.closeAllConnections?.();
        const timer = setTimeout(resolve, 2000);
        current.close(() => { clearTimeout(timer); resolve(); });
        // Must stay referenced: an unref'd timer lets Node exit mid-shutdown, and
        // the stop sequence then dies before "Yu stopped" and before the session
        // write leases are released.

      });
    },
  };
}
