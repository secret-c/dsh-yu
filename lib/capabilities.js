import fs from 'node:fs';
import path from 'node:path';

/** Capability ids Yu depends on. Missing ones degrade a named feature, never silence. */
const PROBES = [
  { id: 'agents.create', probe: (ctx) => fn(ctx.get('agents')?.create), feature: '运行任务与网页对话' },
  { id: 'agents.resume', probe: (ctx) => fn(ctx.get('agents')?.resume), feature: '重启后继续已有对话' },
  { id: 'agents.list', probe: (ctx) => fn(ctx.get('agents')?.list), feature: '运行状态与活动视图' },
  { id: 'llm.listProviders', probe: (ctx) => fn(ctx.get('llm')?.listProviders), feature: '模型选择器' },
  { id: 'llm.listModels', probe: (ctx) => fn(ctx.get('llm')?.listModels), feature: '模型列表' },
  { id: 'llm.resolveModelInfo', probe: (ctx) => fn(ctx.get('llm')?.resolveModelInfo), feature: '思考强度校验' },
  { id: 'systemPrompt.section', probe: (ctx) => fn(ctx.get('systemPrompt')?.section), feature: '上下文注入' },
  { id: 'systemPrompt.assemble', probe: (ctx) => fn(ctx.get('systemPrompt')?.assemble), feature: '上下文预览' },
  { id: 'tools.schemas', probe: (ctx) => fn(ctx.get('tools')?.schemas), feature: '工具目录' },
  { id: 'tools.execute', probe: (ctx) => fn(ctx.get('tools')?.execute), feature: '工具只读试运行' },
  { id: 'tools.restrict', probe: (ctx) => fn(ctx.get('tools')?.restrict), feature: '按任务收敛工具授权' },
  { id: 'sessions.get', probe: (ctx) => fn(ctx.get('sessions')?.get), feature: '读取活会话事件' },
  {
    id: 'sessionPersistence.list',
    probe: (ctx) => fn(ctx.get('sessionPersistence')?.list),
    feature: '读取落盘原始历史',
  },
  { id: 'sessionPersistence.open', probe: (ctx) => fn(ctx.get('sessionPersistence')?.open), feature: '恢复归档游标' },
  { id: 'webServer.register', probe: (ctx) => fn(ctx.get('webServer')?.register), feature: 'DSH 源站 /yu 入口' },
  {
    id: 'agentDefaultModel.currentSelection',
    probe: (ctx) => fn(ctx.get('agentDefaultModel')?.currentSelection),
    feature: '沿用 DSH 默认模型',
  },
  { id: 'credentials.readRecord', probe: (ctx) => fn(ctx.get('credentials')?.readRecord), feature: '复用 DSH 凭据' },
  { id: 'workingDirectory.get', probe: (ctx) => fn(ctx.get('workingDirectory')?.get), feature: '会话工作目录' },
  { id: 'agentPresets.list', probe: (ctx) => fn(ctx.get('agentPresets')?.list), feature: 'Agent 预设选择' },
  { id: 'jobs.list', probe: (ctx) => fn(ctx.get('jobs')?.list) ?? true, feature: '后台作业视图（可选）' },
];

function fn(value) {
  return typeof value === 'function';
}

/**
 * Reads the harness build identity from disk. The desktop runtime ships its own
 * `dsh` tree inside `app.asar`, addressed through Electron's `resourcesPath`;
 * a source or CLI deployment has a plain directory. Every failure is reported,
 * because the compatibility claim has to name what it actually observed.
 */
export function detectHarness() {
  const candidates = [];
  const versions = { node: process.versions.node, electron: process.versions.electron ?? null };

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'));
    candidates.push(path.join(process.resourcesPath, 'dsh', 'package.json'));
  }
  candidates.push(path.resolve(process.cwd(), 'package.json'));

  // A CLI install (Linux / WSL, or a global npm install) has no resourcesPath:
  // the running CLI file itself sits inside the package, so walking up from it
  // finds the harness regardless of where npm put it.
  try {
    let dir = path.dirname(fs.realpathSync(process.argv[1] ?? ''));
    for (let i = 0; i < 6 && dir && dir !== path.dirname(dir); i += 1) {
      const candidate = path.join(dir, 'package.json');
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (pkg?.name === '@deepseek-ai/dsh') {
          candidates.push(candidate);
          break;
        }
      } catch {
        /* keep walking */
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* no argv[1] (embedded runtime) */
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) {
    candidates.push(path.join(home, '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  }
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
  candidates.push('/usr/lib/node_modules/@deepseek-ai/dsh/package.json');

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const pkg = JSON.parse(raw);
      if (pkg?.name === '@deepseek-ai/dsh-desktop-runtime' || pkg?.name === '@deepseek-ai/dsh' || pkg?.name === 'deepseek-harness') {
        return { ...versions, version: pkg.version, name: pkg.name, source: candidate };
      }
    } catch {
      /* try the next candidate */
    }
  }

  // Last resort: ask a bundled package whose version tracks the harness.
  try {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    let dir = here;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        return { ...versions, version: pkg.version, name: pkg.name, source: candidate };
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* ignore */
  }

  return { ...versions, version: null, name: null, source: null };
}

/** Semver-ish comparison good enough for `^0.2.1-rc.2` style support claims. */
export function compareVersions(a, b) {
  const split = (v) =>
    String(v ?? '')
      .replace(/^v/, '')
      .split(/[.-]/)
      .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pa = split(a);
  const pb = split(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = typeof x === 'number';
    const yn = typeof y === 'number';
    if (xn && yn) return x < y ? -1 : 1;
    if (xn && !yn) return -1; // a release sorts below its pre-releases
    if (!xn && yn) return 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

export const SUPPORTED_DSH = '^0.2.1-rc.2';
export const SUPPORTED_DSH_MIN = '0.2.1-rc.2';
export const SUPPORTED_DSH_MAX_EXCLUSIVE = '0.3.0';

export function versionSupported(version) {
  if (!version) return { supported: false, reason: 'harness version could not be detected' };
  if (compareVersions(version, SUPPORTED_DSH_MIN) < 0) {
    return { supported: false, reason: `harness ${version} predates the supported ${SUPPORTED_DSH}` };
  }
  if (compareVersions(version, SUPPORTED_DSH_MAX_EXCLUSIVE) >= 0) {
    return { supported: false, reason: `harness ${version} is newer than the supported ${SUPPORTED_DSH}` };
  }
  return { supported: true, reason: null };
}

export function probeCapabilities(ctx) {
  const list = PROBES.map(({ id: capId, probe, feature }) => {
    let available = false;
    try {
      available = Boolean(probe(ctx));
    } catch {
      available = false;
    }
    return { id: capId, available, feature };
  });
  const missing = list.filter((c) => !c.available);
  return {
    list,
    missing,
    degraded: missing.filter((c) => c.id !== 'jobs.list'),
  };
}
