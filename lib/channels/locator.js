import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';

/**
 * Finding and starting NapCat / SnowLuma.
 *
 * The operator's problem was never the OneBot protocol: it was that the two
 * programs live somewhere unguessable, must be started by hand, and only then do
 * they show a QR. So this module does the three things a person would do —
 * look for an installation in the usual places, start it hidden, wait until its
 * console answers — and reports exactly what it found and what it started.
 *
 * Everything here is read-only until `launch()`, and `launch()` only starts a
 * program that already exists on disk. No downloads, no silent installs.
 */

const SKIP_DIRS = new Set([
  'windows',
  'winsxs',
  'system32',
  'syswow64',
  'node_modules',
  '.git',
  '.cache',
  '$recycle.bin',
  'system volume information',
  'programdata',
  'temp',
  'tmp',
  'packages',
  'microsoft',
  'windowsapps',
  'driverstore',
]);

const MARKERS = [
  'config/webui.json',
  'config/onebot11.json',
  'config/ui.json',
  'config/snowluma.json',
  'config/app.json',
];

const NAME_PATTERN = /(napcat|snowluma|snow_luma)/i;

/**
 * Folders that usually *contain* tools rather than being one. Visiting these
 * before the rest of a drive is what keeps a bounded scan from spending its
 * whole budget in `C:\Windows`-adjacent noise.
 */
const CONTAINER_PATTERN =
  /^(code|projects?|github|git|tools?|apps?|applications?|software|programs?|dev|work|workspace|workspaces|local-tools|\.local-tools|portable|downloads|desktop|desktop-apps|green|greensoft)$/i;

function roots() {
  const out = [];
  const push = (label, dir, maxDepth) => {
    if (!dir) return;
    if (!fs.existsSync(dir)) return;
    for (const entry of out) if (path.resolve(entry.dir) === path.resolve(dir)) return;
    out.push({ label, dir, maxDepth });
  };
  if (process.platform === 'win32') {
    push('本地应用数据', process.env.LOCALAPPDATA, 3);
    push('应用数据', process.env.APPDATA, 3);
    push('用户目录', process.env.USERPROFILE, 3);
    push('桌面', process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : null, 3);
    push('下载', process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Downloads') : null, 3);
    push('Program Files', process.env.ProgramFiles, 3);
    push('Program Files (x86)', process.env['ProgramFiles(x86)'], 3);
    for (const drive of ['C:', 'D:', 'E:', 'F:']) {
      if (fs.existsSync(`${drive}\\`)) push(`${drive}\\`, `${drive}\\`, 4);
    }
  } else {
    push('home', process.env.HOME, 3);
    push('/opt', '/opt', 3);
    push('/usr/local', '/usr/local', 3);
    for (const name of ['/mnt/c', '/mnt/d', '/mnt/e']) if (fs.existsSync(name)) push(name, name, 2);
  }
  return out;
}

/**
 * Is this directory an installation?
 *
 * Only two signals count: a config file the program itself writes, or an
 * executable named after it. A *folder* called `QQNT` proves only that QQ is
 * installed — treating that as a hit is how a "find my bot" button reports the
 * wrong folder with confidence.
 */
function looksLikeInstall(dir) {
  for (const marker of MARKERS) {
    if (fs.existsSync(path.join(dir, marker))) return { marker, dir };
  }
  // A manifest that names itself is the strongest signal a distribution offers.
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (/snowluma|napcat/i.test(String(manifest?.name ?? ''))) {
      return { marker: `manifest ${manifest.name}`, dir };
    }
  } catch {
    /* no manifest */
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && NAME_PATTERN.test(entry.name) && /\.(exe|bat|cmd|sh|jar)$/i.test(entry.name)) {
      return { marker: `文件 ${entry.name}`, dir };
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME_PATTERN.test(entry.name)) continue;
    const inner = path.join(dir, entry.name);
    if (fs.existsSync(path.join(inner, 'package.json')) || fs.existsSync(path.join(inner, 'config'))) {
      // The install is the plugin folder itself, not the repository around it.
      return { marker: `插件目录 ${entry.name}`, dir: inner };
    }
  }
  return null;
}

function readJson(dir, relative) {
  const file = path.join(dir, relative);
  try {
    return { file: relative, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return null;
  }
}

/** `localhost` spellings that are not usable in a URL as written. */
const normalizeHost = (host) => {
  const value = String(host ?? '').trim();
  if (!value || value === '0.0.0.0' || value === '::' || value === '[::]' || value === '*') return '127.0.0.1';
  return value;
};

/** What one directory says about itself: console address, OneBot address, token. */
export function inspectDir(dir) {
  const found = {};
  const sources = [];
  // SnowLuma ships a manifest that names its own start script and console URL.
  const manifest = readJson(dir, 'manifest.json');
  if (manifest?.value && /snowluma|napcat/i.test(String(manifest.value.name ?? ''))) {
    sources.push(manifest.file);
    found.installName = String(manifest.value.name);
    if (manifest.value.webuiUrl) found.consoleUrl = String(manifest.value.webuiUrl).replace(/\/+$/, '');
    if (manifest.value.startScript) found.launchScript = String(manifest.value.startScript);
    if (manifest.value.stopScript) found.stopScript = String(manifest.value.stopScript);
    if (manifest.value.oneBotHttpUrl) found.httpBase = String(manifest.value.oneBotHttpUrl).replace(/\/+$/, '');
  }
  const webui = readJson(dir, 'config/webui.json');
  if (webui?.value && typeof webui.value === 'object') {
    sources.push(webui.file);
    if (webui.value.token) found.webuiToken = String(webui.value.token);
    if (webui.value.port) found.consoleUrl = `http://${normalizeHost(webui.value.host)}:${webui.value.port}`;
  }
  const onebot = readJson(dir, 'config/onebot11.json');
  if (onebot?.value && typeof onebot.value === 'object') {
    sources.push(onebot.file);
    const servers = onebot.value?.network?.httpServers ?? [];
    const server = servers.find?.((item) => item?.enable !== false && item?.port);
    if (server) {
      found.httpBase = `http://${normalizeHost(server.host)}:${server.port}`;
      if (server.token) found.token = String(server.token);
    }
    const selfId = onebot.value?.selfId ?? onebot.value?.qq ?? onebot.value?.account?.uin;
    if (selfId) found.selfId = String(selfId);
  }
  const ui = readJson(dir, 'config/ui.json');
  if (ui?.value && typeof ui.value === 'object') {
    sources.push(ui.file);
    if (ui.value.port && !found.consoleUrl) found.consoleUrl = `http://${normalizeHost(ui.value.host)}:${ui.value.port}`;
  }
  const snow = readJson(dir, 'config/snowluma.json');
  if (snow?.value && typeof snow.value === 'object') {
    sources.push(snow.file);
    if (snow.value.port && !found.consoleUrl) found.consoleUrl = `http://${normalizeHost(snow.value.host)}:${snow.value.port}`;
    if (snow.value.token && !found.token) found.token = String(snow.value.token);
  }
  return { dir, found, sources, launchers: launchersIn(dir) };
}

/**
 * Programs that plausibly start this install, most specific first.
 *
 * A bot distribution may start through an `.exe`, a `.bat`, or — for the
 * SnowLuma build unpacked next to the old project — a PowerShell script. All
 * three are launchable; `node.exe` is not, and is explicitly demoted.
 */
export function launchersIn(dir) {
  const scored = [];
  const score = (relative) => {
    const name = path.basename(relative);
    if (!/\.(exe|bat|cmd|ps1)$/i.test(name)) return null;
    if (/^node\.exe$/i.test(name)) return null;
    let value = 0;
    if (/(napcat|snowluma|snow_luma)/i.test(name)) value += 10;
    if (/boot|launcher|start|run/i.test(name)) value += 6;
    if (/\.ps1$/i.test(name)) value += 1;
    if (/unins|update|repair|crash|remove|stop/i.test(name)) value -= 20;
    return value > 0 ? { relative, value } : null;
  };
  for (const sub of ['', 'boot', 'app', 'bin']) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const relative = sub ? path.join(sub, entry.name) : entry.name;
      const hit = score(relative);
      if (hit) scored.push(hit);
    }
  }
  // The manifest names its own start script; believe it over any heuristic.
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (manifest?.startScript && fs.existsSync(manifest.startScript)) {
      scored.push({ relative: manifest.startScript, value: 50 });
    }
  } catch {
    /* no manifest */
  }
  return scored
    .sort((a, b) => b.value - a.value)
    .map((item) => (path.isAbsolute(item.relative) ? item.relative : path.join(dir, item.relative)))
    .filter((value, index, all) => all.indexOf(value) === index);
}

/**
 * Breadth-first search for installations, bounded by depth and directory count.
 * Bounded on purpose: an unbounded walk of a user's disk from inside an HTTP
 * request is how a "find my bot" button turns into a hang.
 */
export function scanForInstalls({ maxDirs = 12_000, maxMs = 9000 } = {}) {
  const startedAt = Date.now();
  const hits = [];
  const claimed = new Set();
  const allRoots = roots();
  // A single shared queue lets a deep `C:\` walk starve `E:\` — the folder the
  // bot actually lives in. Each root gets its own budget instead.
  const perRoot = Math.max(600, Math.floor(maxDirs / Math.max(1, allRoots.length)));
  let scanned = 0;
  let truncated = false;
  for (const root of allRoots) {
    if (Date.now() - startedAt > maxMs) {
      truncated = true;
      break;
    }
    const queue = [{ ...root, depth: 0 }];
    let used = 0;
    while (queue.length) {
      if (used >= perRoot || Date.now() - startedAt > maxMs) {
        truncated = true;
        break;
      }
      const current = queue.shift();
      if (claimed.has(current.dir)) continue; // an install folder is not a container
      used += 1;
      scanned += 1;
      const marker = looksLikeInstall(current.dir);
      if (marker) {
        const installDir = marker.dir ?? current.dir;
        if (!claimed.has(installDir)) {
          claimed.add(installDir);
          const info = inspectDir(installDir);
          hits.push({
            type: /snow/i.test(installDir) || info.sources.some((file) => /snow/i.test(file)) ? 'snowluma' : 'napcat',
            dir: installDir,
            root: current.label,
            marker: marker.marker ?? String(marker),
            found: info.found,
            sources: info.sources,
            launchers: info.launchers.slice(0, 3),
          });
        }
        // Keep walking the surrounding folder: a repository can hold the bot in
        // a subfolder and other tools next to it.
      }
      if (current.depth >= (current.maxDepth ?? 3)) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const matched = [];
      const containers = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const lower = entry.name.toLowerCase();
        if (SKIP_DIRS.has(lower)) continue;
        const node = {
          label: current.label,
          maxDepth: current.maxDepth,
          dir: path.join(current.dir, entry.name),
          depth: current.depth + 1,
        };
        // A directory that is *named* after a bot framework is the most likely
        // install, so it is searched before its siblings instead of after them.
        if (NAME_PATTERN.test(entry.name)) matched.push(node);
        else if (CONTAINER_PATTERN.test(entry.name)) containers.push(node);
        else queue.push(node);
      }
      queue.unshift(...containers);
      queue.unshift(...matched);
    }
  }
  return {
    // Most useful first: an install whose console address is known beats one
    // that merely has a launcher with "napcat" in the name.
    hits: hits.sort((a, b) => confidence(b) - confidence(a)),
    scanned,
    truncated,
    durationMs: Date.now() - startedAt,
    roots: allRoots.map((root) => root.dir),
    note: truncated
      ? '搜索有上限（每个位置分别限时/限量），没找到不代表不存在；可以在渠道里直接填安装目录。'
      : '已扫描常见位置。',
  };
}

function confidence(hit) {
  let score = 0;
  if (hit.found?.consoleUrl) score += 10;
  if (hit.found?.webuiToken) score += 4;
  if (hit.found?.httpBase) score += 3;
  if (hit.launchers?.length) score += 2;
  if (hit.marker?.startsWith('manifest') || hit.marker === 'config/webui.json') score += 2;
  return score;
}

/** Running processes whose path names a bot framework (fast path). */
export function runningInstalls({ timeoutMs = 4000 } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ supported: false, hits: [] });
  const query =
    'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "napcat|snowluma" } ' +
    '| Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error || !stdout?.trim()) return resolve({ supported: true, hits: [], error: error?.message ?? null });
      try {
        const parsed = JSON.parse(stdout.trim());
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const hits = list
          .filter((item) => item?.ExecutablePath)
          .map((item) => ({
            pid: item.ProcessId,
            name: item.Name,
            dir: path.dirname(item.ExecutablePath),
            exe: item.ExecutablePath,
          }));
        resolve({ supported: true, hits });
      } catch (parseError) {
        resolve({ supported: true, hits: [], error: parseError.message });
      }
    });
  });
}

/**
 * Start a process so that it outlives Yu.
 *
 * `detached: true` is the obvious way to do this on Windows and it is wrong for
 * this job: a DETACHED_PROCESS PowerShell exits 0 without running the script (the
 * console host never initialises), which looks exactly like a successful start.
 * The invocation that works is
 *
 *   cmd.exe /c start "" /b <program> ...
 *
 * plus, for a `.ps1`, `-Command "& 'x.ps1' *>&1 | Out-File -File <log>"`: PowerShell
 * writes to a console handle rather than to an inherited file descriptor, so the
 * redirect has to happen inside PowerShell itself for the output to be readable.
 */
function spawnDetached(command, args, cwd, extraEnv = null) {
  const logFile = path.join(os.tmpdir(), `yu-launch-${Date.now().toString(36)}.log`);
  let inner;
  if (/\.ps1$/i.test(command)) {
    const quoted = command.replace(/'/g, "''");
    const log = logFile.replace(/'/g, "''");
    inner = [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `& '${quoted}' *>&1 | Out-File -FilePath '${log}' -Encoding utf8`,
    ];
  } else {
    inner = [command, ...args];
  }
  const child = spawn('cmd.exe', ['/c', 'start', '', '/b', ...inner], {
    cwd,
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...(extraEnv ?? {}) },
  });
  child.unref();
  // `start` gives the pid to the new process, not to us: the console address is
  // the evidence that a start worked, not this number.
  return { pid: child.pid ?? null, logFile, spawnedVia: 'cmd-start' };
}

/** Last lines of a launcher log, for the page to show when a start fails. */
export function launcherLogTail(logFile, { lines = 12 } = {}) {
  try {
    const text = fs.readFileSync(logFile, 'utf8').trim();
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Start an install without a console window.
 *
 * A `.bat`/`.cmd` needs `cmd.exe`, a `.ps1` needs PowerShell, an `.exe` starts
 * directly. The child is detached and unreferenced, so closing Yu does not close
 * the bot — it is the same program the user would have started by hand, just
 * without the terminal window.
 */
export function launchInstall(dir, { launcher = null, log, env = null } = {}) {
  if (!fs.existsSync(dir)) return { ok: false, reason: 'INSTALL_DIR_MISSING', dir };
  const candidates = launcher ? [launcher] : launchersIn(dir);
  if (!candidates.length) {
    return {
      ok: false,
      reason: 'NO_LAUNCHER',
      dir,
      note: '目录里没有找到可执行文件。请手动启动一次，或把启动程序路径填进「安装目录」。',
    };
  }
  const command = candidates.find((candidate) => fs.existsSync(candidate));
  if (!command) return { ok: false, reason: 'NO_LAUNCHER', dir, note: '候选启动器都不存在', candidates };
  try {
    let spawned;
    if (/\.ps1$/i.test(command)) {
      spawned = spawnDetached(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', command],
        path.dirname(command),
        env,
      );
    } else if (/\.(bat|cmd)$/i.test(command)) {
      spawned = spawnDetached('cmd.exe', ['/c', 'start', '', path.basename(command)], path.dirname(command), env);
    } else {
      spawned = spawnDetached(command, [], path.dirname(command), env);
    }
    log?.info(`launched ${command} (pid ${spawned.pid ?? '?'})`);
    return {
      ok: true,
      command,
      pid: spawned.pid,
      logFile: spawned.logFile,
      dir,
      candidates: candidates.slice(0, 3),
    };
  } catch (error) {
    return { ok: false, reason: 'LAUNCH_FAILED', error: error.message, command };
  }
}

/** Poll an address until it answers or the deadline passes. */
export async function waitForHttp(url, { timeoutMs = 25_000, intervalMs = 700 } = {}) {
  if (!url) return { ok: false, waitedMs: 0, reason: 'NO_URL' };
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(1500) });
      // Any HTTP status means the listener is alive; 401 from a token-protected
      // console is a success for "is it up".
      return { ok: true, waitedMs: Date.now() - startedAt, status: response.status };
    } catch (error) {
      lastError = error.message;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return { ok: false, waitedMs: Date.now() - startedAt, reason: lastError ?? 'TIMEOUT' };
}

/** Is the QQ client itself running? Bots that inject into QQ need it. */
export function qqRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/NH'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    });
    return /QQ\.exe/i.test(out);
  } catch {
    return false;
  }
}

/** Where QQ lives: the running process first, then the usual install roots. */
export function findQq() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process QQ -ErrorAction SilentlyContinue | Select-Object -First 1).Path'],
      { windowsHide: true, encoding: 'utf8', timeout: 6000 },
    );
    const line = String(out ?? '').trim();
    if (line && fs.existsSync(line)) return line;
  } catch {
    /* fall through to the usual locations */
  }
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
    'D:\\Program Files',
    'C:\\Program Files',
  ].filter(Boolean);
  for (const root of roots) {
    for (const rel of ['Tencent\\QQNT\\QQ.exe', 'Tencent\\QQ\\Bin\\QQ.exe', 'Tencent\\QQ\\QQ.exe']) {
      const full = path.join(root, rel);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * Start QQ before a bot that injects into it.
 *
 * NapCat and SnowLuma both load into a running QQ; starting them first leaves a
 * console that says "no QQ process to inject into". Starting QQ first is what a
 * person would do with two clicks, so it is one click here.
 */
export function ensureQq({ log } = {}) {
  if (process.platform !== 'win32') return { ok: false, reason: 'UNSUPPORTED' };
  if (qqRunning()) return { ok: true, running: true, started: false };
  const exe = findQq();
  if (!exe) return { ok: false, reason: 'QQ_NOT_FOUND', note: '没找到 QQ.exe，请手动打开 QQ 后再启动渠道。' };
  try {
    const spawned = spawnDetached(exe, [], path.dirname(exe));
    log?.info(`started QQ ${exe} (pid ${spawned.pid ?? '?'})`);
    return { ok: true, running: false, started: true, path: exe, pid: spawned.pid };
  } catch (error) {
    return { ok: false, reason: 'QQ_LAUNCH_FAILED', error: error.message };
  }
}
/**
 * Stop a locally installed framework through its own stop script.
 *
 * Restarting is the only way to change the environment a running process was
 * started with, so "enable the hook" means "stop, then start with the flag".
 */
export function stopInstall(dir, { log } = {}) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, reason: 'INSTALL_DIR_MISSING' };
  let script = null;
  try {
    script = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))?.stopScript ?? null;
  } catch {
    script = null;
  }
  if (!script || !fs.existsSync(script)) return { ok: false, reason: 'NO_STOP_SCRIPT' };
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, encoding: 'utf8', timeout: 60_000 },
    );
    log?.info(`stopped ${dir}: ${String(out).trim().split('\n').pop()}`);
    return { ok: true, script, output: String(out ?? '').trim().slice(-300) };
  } catch (error) {
    return { ok: false, reason: 'STOP_FAILED', error: error.message };
  }
}