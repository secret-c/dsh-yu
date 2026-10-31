/* API client, data hooks and formatting helpers. */

declare global {
  interface Window {
    __YU_BASE__?: string;
    __YU_BUILD__?: string | null;
  }
}

const BASE = typeof window !== 'undefined' ? (window.__YU_BASE__ ?? '') : '';

/** Public health probe, used to notice that a new console build was deployed. */
export async function healthBuild(): Promise<string | null> {
  const response = await fetch(`${BASE}/api/health`, { cache: 'no-store' });
  if (!response.ok) return null;
  const body = (await response.json()) as { build?: string | null };
  return body.build ?? null;
}

export class ApiError extends Error {
  status: number;
  code: string;
  detail: unknown;
  constructor(status: number, code: string, message: string, detail: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export async function api<T = any>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
    signal: options.signal,
  });
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: { code: 'INVALID_RESPONSE', message: text.slice(0, 400) } };
  }
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? `HTTP ${response.status}`, error.detail);
  }
  return payload as T;
}

/** Server-sent events over fetch (EventSource cannot POST). */
export async function streamSse(
  path: string,
  body: unknown,
  handlers: {
    onEvent: (event: string, data: any) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal: handlers.signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new ApiError(response.status, 'STREAM_FAILED', text.slice(0, 300) || `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) {
        let parsed: any = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        handlers.onEvent(event, parsed);
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

export function basePath(): string {
  return BASE;
}

// ------------------------------------------------------------- formatting

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtTime(ms)}`;
}

export function fmtDay(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`;
}

export function fmtRelative(ms: number | null | undefined): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const future = diff < 0;
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  let text: string;
  if (abs < minute) text = '刚刚';
  else if (abs < hour) text = `${Math.round(abs / minute)} 分钟`;
  else if (abs < day) text = `${Math.round(abs / hour)} 小时`;
  else text = `${Math.round(abs / day)} 天`;
  if (text === '刚刚') return text;
  return future ? `${text}后` : `${text}前`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function bytes(n: number | null | undefined): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

// ------------------------------------------------------------- vocabulary

export type Tone = 'ok' | 'warn' | 'bad' | 'accent' | 'muted' | '';

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: '排队中', tone: 'muted' },
  running: { label: '正在执行', tone: 'accent' },
  stopping: { label: '停止中', tone: 'warn' },
  succeeded: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'bad' },
  canceled: { label: '已停止', tone: 'muted' },
  interrupted: { label: '中断（未重跑）', tone: 'warn' },
};

export const TASK_KIND: Record<string, string> = {
  chat: '对话',
  reading: '阅读',
  journal: '日记',
  activity: '自由活动',
  maintenance: '记忆维护',
  backup: '数据库备份',
  alert: '提醒',
  custom: '自定义',
};

export const CHANNEL_STATUS: Record<string, { label: string; tone: Tone }> = {
  disabled: { label: '已停用', tone: 'muted' },
  connecting: { label: '连接中', tone: 'accent' },
  listening: { label: '等待客户端', tone: 'warn' },
  connected: { label: '已连接', tone: 'ok' },
  'auth-failed': { label: '认证失败', tone: 'bad' },
  misconfigured: { label: '待配置', tone: 'warn' },
  error: { label: '连接异常', tone: 'bad' },
  stopped: { label: '未运行', tone: 'muted' },
};

export const CHANNEL_TYPE: Record<string, string> = {
  napcat: 'NapCat / OneBot v11',
  snowluma: 'SnowLuma / OneBot v11',
  'qq-official': 'QQ 官方机器人',
  web: '网页聊天',
};

export const MEMORY_CATEGORY: Record<string, string> = {
  recent: '近期经历',
  people: '人物与关系',
  ongoing: '进行中的事',
  thoughts: '想法',
  state: '当前状态',
  custom: '自定义',
};

export function toneOfStatus(status: string): Tone {
  return RUN_STATUS[status]?.tone ?? '';
}

export function labelOfStatus(status: string): string {
  return RUN_STATUS[status]?.label ?? status;
}

export function truncate(text: string | null | undefined, max = 120): string {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
