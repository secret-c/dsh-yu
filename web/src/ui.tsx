import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, api, type Tone } from './lib';

// ------------------------------------------------------------------ router

export interface Route {
  path: string;
  segments: string[];
}

function readRoute(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return { path, segments: path.split('/').filter(Boolean) };
}

export function navigate(path: string) {
  const next = path.startsWith('/') ? path : `/${path}`;
  if (window.location.hash === `#${next}`) return;
  window.location.hash = next;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

// ------------------------------------------------------------------ toasts

type ToastKind = 'info' | 'ok' | 'warn' | 'bad';
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++seq.current;
    setToasts((list) => [...list, { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((list) => list.filter((toast) => toast.id !== id));
    }, 4600);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind === 'bad' ? 'bad' : toast.kind === 'warn' ? 'warn' : ''}`}>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ------------------------------------------------------------------- data

export interface Resource<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (next: T) => void;
}

export function useApi<T>(path: string | null, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const active = useRef(0);

  const load = useCallback(async () => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    const token = ++active.current;
    setLoading(true);
    try {
      const result = await api<T>(path);
      if (token !== active.current) return;
      setData(result);
      setError(null);
    } catch (failure) {
      if (token !== active.current) return;
      setError(failure as Error);
    } finally {
      if (token === active.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  return { data, error, loading, reload: load, setData };
}

/** Poll while the tab is visible; used by the Today page. */
export function usePolling(callback: () => void, intervalMs: number, enabled = true) {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') saved.current();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, enabled]);
}

// --------------------------------------------------------------- primitives

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
  padded = true,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={`card ${className}`} style={padded ? undefined : { padding: 0 }}>
      {(title || actions) && (
        <header className="card-head" style={padded ? undefined : { padding: '18px 20px 0' }}>
          <div>
            {title && <div className="card-title">{title}</div>}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="row" style={{ gap: 8 }}>{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHead({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <div className="page-desc">{description}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Button({
  children,
  variant = 'primary',
  size,
  wide,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'quiet' | 'danger';
  size?: 'small';
  wide?: boolean;
}) {
  const cls = [
    'btn',
    variant !== 'primary' ? variant : '',
    size === 'small' ? 'small' : '',
    wide ? 'wide' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  );
}

export function Badge({ children, tone = '' }: { children: React.ReactNode; tone?: Tone }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Field({
  label,
  help,
  error,
  children,
  htmlFor,
}: {
  label?: React.ReactNode;
  help?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {help && <div className="help">{help}</div>}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="toggle" style={disabled ? { opacity: 0.55 } : undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Loading({ label = '正在读取…' }: { label?: string }) {
  return (
    <div className="loading-line">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint && <div>{hint}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function ErrorBox({
  error,
  onRetry,
}: {
  error: Error | ApiError | null;
  onRetry?: () => void;
}) {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : '';
  return (
    <div className="error-box" role="alert">
      <div style={{ fontWeight: 620 }}>{error.message}</div>
      {code && <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{code}</div>}
      {onRetry && (
        <div className="row">
          <Button variant="ghost" size="small" onClick={onRetry}>
            重试
          </Button>
        </div>
      )}
    </div>
  );
}

export function Modal({
  open,
  title,
  subtitle,
  children,
  footer,
  onClose,
  wide,
}: {
  open: boolean;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div>
            <div className="card-title">{title}</div>
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          <Button variant="quiet" size="small" onClick={onClose} aria-label="关闭">
            ✕
          </Button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: React.ReactNode }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          className="tab"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function KV({ items }: { items: Array<{ label: React.ReactNode; value: React.ReactNode }> }) {
  return (
    <dl className="kv">
      {items.map((item, index) => (
        <React.Fragment key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function Stat({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

export function Code({ children }: { children: React.ReactNode }) {
  return <pre>{children}</pre>;
}

/** A save button that reports its own pending/error state. */
export function SaveButton({
  onClick,
  label = '保存',
  disabled,
}: {
  onClick: () => Promise<void> | void;
  label?: string;
  disabled?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  return (
    <Button
      disabled={saving || disabled}
      onClick={async () => {
        setSaving(true);
        try {
          await onClick();
        } catch (error) {
          toast((error as Error).message, 'bad');
        } finally {
          setSaving(false);
        }
      }}
    >
      {saving ? '保存中…' : label}
    </Button>
  );
}

export function useDraft<T>(initial: T | null) {
  const [draft, setDraft] = useState<T | null>(initial);
  const [dirty, setDirty] = useState(false);
  const initialRef = useRef(initial);
  useEffect(() => {
    if (initial === null) return;
    initialRef.current = initial;
    setDraft(initial);
    setDirty(false);
  }, [initial]);
  const update = useCallback((next: T) => {
    setDraft(next);
    setDirty(true);
  }, []);
  return { draft, setDraft, dirty, setDirty, update, reset: () => setDraft(initialRef.current) };
}

export function useMemoized<T>(factory: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, deps);
}
