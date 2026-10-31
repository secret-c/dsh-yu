import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Tomimi (TMM) roguelike enemy-panel calculator.
 *
 * This is the tool the old Yu had. Tomimi's data covers six Integrated
 * Strategies themes (Phantom, Mizuki, Sami, Sarkaz, Sui, Blackstream), with
 * official difficulty tables, floor multipliers and stage modifiers. The
 * calculator itself is vendored from the old local copy; the data is kept
 * outside the plugin (it is ~36 MB) and discovered in the data root's sibling
 * `yu-knowledge/tomimi` directory, matching the Arknights corpus layout.
 *
 * Running it in a child process keeps the calculator's module-level data load
 * out of Yu's event loop; one lookup is ~100–300 ms and does not block chat.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'tomimi', 'cli.mjs');

export function resolveTomimiDataDir({ settings, paths, strictDataPath = false }) {
  const configured = String(settings?.get?.('tools.tomimiDataDir') ?? '').trim();
  const candidates = [];
  if (configured) candidates.push(configured);
  if(!configured || !strictDataPath) {
    candidates.push(path.join(paths.dataDir, '..', 'yu-knowledge', 'tomimi'));
    candidates.push(path.join(paths.dataDir, 'knowledge', 'tomimi'));
    candidates.push(path.join(paths.dataDir, 'files', 'knowledge', 'tomimi'));
  }
  const complete = (dir) => {
    try {
      return (
        fs.statSync(path.join(dir, 'enemy_database.json')).isFile() &&
        fs.statSync(path.join(dir, 'stage_name_lookup_table.json')).isFile()
      );
    } catch {
      return false;
    }
  };
  const resolvedPath = candidates.find(complete) ?? null;
  return {
    configured: configured || null,
    candidates,
    resolvedPath,
    exists: Boolean(resolvedPath),
    note: resolvedPath
      ? null
      : '未找到 Tomimi 数据。需要 enemy_database.json、stage_name_lookup_table.json 与 ro1–ro6 关卡目录。',
  };
}

export function createTomimiService({ settings, paths, log, strictDataPath = false }) {
  const pending = new Set();
  let disposed = false;
  const resolve = () => resolveTomimiDataDir({ settings, paths, strictDataPath });

  const status = () => {
    const resolved = resolve();
    if (!resolved.resolvedPath) {
      return {
        ok: false,
        ...resolved,
        error: { code: 'TOMIMI_DATA_NOT_FOUND', message: resolved.note },
      };
    }
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(resolved.resolvedPath, 'manifest.json'), 'utf8'));
    } catch {
      /* manifest is optional for running; it is only status metadata */
    }
    return {
      ok: true,
      path: resolved.resolvedPath,
      source: manifest?.source ?? 'https://github.com/tanch-p/tomimi-dev',
      commit: manifest?.commit ?? null,
      importedFiles: manifest?.importedFiles ?? null,
      topics: manifest?.topics ?? null,
    };
  };

  const run = (payload, { timeout = 20_000 } = {}) =>
    new Promise((resolveRun) => {
      if(disposed){resolveRun({ok:false,error:{code:'TOMIMI_UNLOADED',message:'工具包已卸载'}});return;}
      const resolved = resolve();
      if (!resolved.resolvedPath) {
        resolveRun({ ok: false, error: { code: 'TOMIMI_DATA_NOT_FOUND', message: resolved.note } });
        return;
      }
      const child = spawn(process.execPath, [SCRIPT], {
        env: { ...process.env, YU_TOMIMI_DATA_DIR: resolved.resolvedPath },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        pending.delete(cancel);
        clearTimeout(timer);
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolveRun(value);
      };
      const cancel = () => finish({ok:false,error:{code:'TOMIMI_UNLOADED',message:'工具包已卸载'}});
      pending.add(cancel);
      const timer = setTimeout(
        () => finish({ ok: false, error: { code: 'TOMIMI_TIMEOUT', message: `Tomimi 计算超时（${timeout} ms）` } }),
        timeout,
      );
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) =>
        finish({ ok: false, error: { code: 'TOMIMI_SPAWN_FAILED', message: error.message } }),
      );
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish({
            ok: false,
            error: {
              code: 'TOMIMI_FAILED',
              message: `Tomimi 进程退出码 ${code}${stderr ? `：${stderr.slice(0, 300)}` : ''}`,
            },
          });
          return;
        }
        try {
          finish(JSON.parse(stdout));
        } catch {
          finish({
            ok: false,
            error: { code: 'TOMIMI_INVALID_OUTPUT', message: `Tomimi 返回不是 JSON：${stdout.slice(0, 200)}` },
          });
        }
      });
      child.stdin.on('error', () => {
        /* the child may exit before reading; close handler reports it */
      });
      child.stdin.end(JSON.stringify(payload));
      log?.debug?.(`tomimi ${payload?.action ?? '?'} ${payload?.query ?? payload?.stage ?? ''}`);
    });
  const search = (args) =>
    run({ action: 'search', query: args?.query ?? '', offset: args?.offset ?? 0, limit: args?.limit ?? 40 });
  const scenario = (args) => run({ action: 'scenario', query: args?.query ?? '' });
  const calculate = (args) =>
    run({
      action: 'calculate',
      topic: args?.topic,
      stage: args?.stage,
      enemy: args?.enemy,
      difficulty: args?.difficulty,
      floor: args?.floor,
      mode: args?.mode ?? 'normal',
      variant: args?.variant,
      form: args?.form,
      modifiers: args?.modifiers ?? [],
    });

  const definitions = [
    {
      name: 'tomimi',
      description:
        '明日方舟集成战略（肉鸽）敌人面板计算器，Tomimi 六主题官方数据（傀影/水月/萨米/萨卡兹/岁/黑流树海）。' +
        '用户问某关或某敌人“有没有数据/多少难度/多少层/多少血”时：action=search，query 填用户说的词（如「萨米红王」「奎隆」）。' +
        '问「N18 奎隆多少血」「最高难度红王血量」这类自然问法：action=scenario，query 填原话。' +
        '已知 topic/stage/enemy/difficulty/floor 后要精确面板：action=calculate。' +
        '先 search 拿到官方键再 calculate；条件不唯一时不要猜，工具会返回 ok=false。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'scenario', 'calculate'],
            description: 'search 找键 / scenario 自然问法 / calculate 精确计算',
          },
          query: { type: 'string', description: 'search 或 scenario 用；填用户原话或关卡/敌人名' },
          topic: { type: 'string', description: '主题键，如 rogue_sami、rogue_skz、rogue_6' },
          stage: { type: 'string', description: '关卡标签或 levelId，如 ISW-DF_时光之沙' },
          enemy: { type: 'string', description: '敌人 key 或名称，如 enemy_2057_smkght' },
          difficulty: { type: 'integer', description: '官方难度档' },
          floor: { type: 'integer', description: '层数' },
          mode: { type: 'string', enum: ['normal', 'elite'], description: '普通/紧急' },
          variant: { type: 'string', description: '多版本关卡的 variant id' },
          form: { type: 'integer', description: '敌人形态序号，默认 0' },
          modifiers: { type: 'array', items: { type: 'string' }, description: '已映射的藏品/事件 ID' },
          offset: { type: 'integer', description: 'search 翻页起点' },
          limit: { type: 'integer', description: 'search 每页 1–100，默认 40' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: `tomimi\n${JSON.stringify(value, null, 2)}` }],
      },
      execute: async (args) => {
        if (args?.action === 'search') return search(args);
        if (args?.action === 'scenario') return scenario(args);
        if (args?.action === 'calculate') return calculate(args);
        return {
          ok: false,
          error: { code: 'INVALID_ACTION', message: 'action 必须是 search、scenario 或 calculate。' },
        };
      },
    },
  ];

  return { definitions, run, search, scenario, calculate, status, resolve, dispose(){disposed=true;for(const cancel of [...pending])cancel();} };
}
