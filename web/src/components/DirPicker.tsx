import React, { useEffect, useState } from 'react';
import { api } from '../lib';
import { Button, Field, Loading, Modal, useToast } from '../ui';

/**
 * A folder picker backed by Yu's own filesystem.
 *
 * The browser cannot open a native folder dialog and read an absolute path out
 * of it, so "type the path" was the only honest option — and it is a bad one on
 * a machine where the path lives inside WSL. `/api/system/dirs` already lists
 * directories for the data-root move; this modal reuses it, so choosing a work
 * directory is clicking, not spelling.
 */
export function DirField({
  value,
  onChange,
  label = '工作目录',
  help,
  placeholder = '留空使用 Yu 数据目录',
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  help?: React.ReactNode;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Field label={label} help={help}>
      <div className="file-input-row">
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
        <Button variant="ghost" size="small" onClick={() => setOpen(true)}>
          选择文件夹
        </Button>
      </div>
      {open && (
        <DirPickerModal
          initial={value}
          onClose={() => setOpen(false)}
          onPick={(picked) => {
            onChange(picked);
            setOpen(false);
          }}
        />
      )}
    </Field>
  );
}

function DirPickerModal({
  initial,
  onClose,
  onPick,
}: {
  initial: string;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const toast = useToast();
  const [listing, setListing] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const browse = async (target: string) => {
    setLoading(true);
    try {
      const data = await api<any>(`/api/system/dirs?path=${encodeURIComponent(target || '')}`);
      setListing(data);
      setError(data.error ?? null);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void browse(initial || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal
      open
      wide
      title="选择文件夹"
      subtitle="这是 Yu 所在的机器看到的目录；选中后写入工作目录。"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() => {
              if (!listing?.path) return;
              onPick(listing.path);
              toast(`工作目录：${listing.path}`, 'ok');
            }}
            disabled={!listing?.path}
          >
            选择这层目录
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row between">
          <code style={{ wordBreak: 'break-all' }}>{listing?.path ?? '正在读取…'}</code>
          <div className="row" style={{ gap: 6 }}>
            <Button variant="quiet" size="small" onClick={() => void browse('')}>
              根目录
            </Button>
            {listing?.parent && (
              <Button variant="quiet" size="small" onClick={() => void browse(listing.parent)}>
                上一级
              </Button>
            )}
          </div>
        </div>

        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {(listing?.roots ?? []).map((root: string) => (
            <Button key={root} variant="ghost" size="small" onClick={() => void browse(root)}>
              {root}
            </Button>
          ))}
        </div>

        {loading && !listing ? <Loading label="正在列目录…" /> : null}
        {error && <div className="notice warn">无法读取：{error}</div>}
        {listing && (
          <div
            style={{
              maxHeight: 340,
              overflow: 'auto',
              border: '1px solid var(--line-2)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {(listing.entries ?? []).length === 0 && (
              <div className="li-sub" style={{ padding: 12 }}>
                没有子目录
              </div>
            )}
            {(listing.entries ?? []).map((entry: any) => (
              <button
                key={entry.path}
                type="button"
                className="list-item"
                style={{ width: '100%', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
                onClick={() => void browse(entry.path)}
              >
                <div className="li-main">
                  <div className="li-title">{entry.name}</div>
                  <div className="li-sub">{entry.path}</div>
                </div>
                <span className="tag">打开</span>
              </button>
            ))}
          </div>
        )}
        <div className="li-sub">
          只列出目录，不读取文件内容。`/mnt/c` 是 Windows 的 C 盘；Yu 的数据根在设置 · 数据与文件里可以看到。
        </div>
      </div>
    </Modal>
  );
}
