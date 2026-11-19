'use client';
/** Small shared building blocks: loading / empty / error states, money, dates, badges, forms. */
import { cloneElement, isValidElement, useCallback, useEffect, useId, useState } from 'react';
import { ApiError, describeError } from '@/lib/api';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';

export function Loading({ label = 'Đang tải…' }: { label?: string }) {
  return (
    <p className="muted" role="status">
      {label}
    </p>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const text = typeof error === 'string' ? error : describeError(error);
  return (
    <div className="alert error" role="alert">
      <span>{text}</span>
      {onRetry && (
        <button type="button" className="link" onClick={onRetry}>
          Thử lại
        </button>
      )}
    </div>
  );
}

export function Notice({
  children,
  tone = 'info',
}: {
  children: React.ReactNode;
  tone?: 'info' | 'success' | 'warning';
}) {
  return (
    <div className={`alert ${tone}`} role="status">
      {children}
    </div>
  );
}

export const Money = ({ value }: { value: number }) => (
  <span className="money">{formatMoney(value)}</span>
);
export const DateText = ({ value }: { value: string | null | undefined }) => (
  <span>{formatDate(value)}</span>
);
export const DateTime = ({ value }: { value: string | null | undefined }) => (
  <span>{formatDateTime(value)}</span>
);

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** A submit / action button that is disabled while its action runs (no double submits). */
export function ActionButton({
  onClick,
  children,
  busyLabel = 'Đang xử lý…',
  variant = 'primary',
  disabled,
  type = 'button',
}: {
  onClick?: () => Promise<unknown> | void;
  children: React.ReactNode;
  busyLabel?: string;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type={type}
      className={`btn ${variant}`}
      disabled={busy || disabled}
      onClick={
        onClick &&
        (async () => {
          setBusy(true);
          try {
            await onClick();
          } finally {
            setBusy(false);
          }
        })
      }
    >
      {busy ? busyLabel : children}
    </button>
  );
}

/**
 * A labelled form control. The hint is linked with aria-describedby, so the control's
 * accessible name stays exactly the label.
 */
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactElement<{ id?: string; 'aria-describedby'?: string }>;
  hint?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {isValidElement(children)
        ? cloneElement(children, { id, ...(hint && { 'aria-describedby': hintId }) })
        : children}
      {hint && (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}

/** A confirmation step for destructive actions. */
export function Confirm({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <div>{children}</div>
        <div className="row end">
          <button type="button" className="btn secondary" onClick={onCancel}>
            Không
          </button>
          <ActionButton variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

/** Load data from the API on mount (and on `reload()`), keeping loading / error state. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error: unknown; loading: boolean }>({
    error: null,
    loading: true,
  });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => {
    setState((s) => ({ ...s, error: null, loading: true }));
    setVersion((v) => v + 1);
  }, []);
  const setData = useCallback((data: T) => setState((s) => ({ ...s, data })), []);
  useEffect(() => {
    let current = true;
    load().then(
      (data) => current && setState({ data, error: null, loading: false }),
      (error) => current && setState((s) => ({ ...s, error, loading: false })),
    );
    return () => {
      current = false;
    };
    // `load` is a fresh closure each render; `deps` says when it really changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);
  return { data: state.data, error: state.error, loading: state.loading, reload, setData };
}

/** Renders loading / error / content for a `useLoad` result. */
export function Loaded<T>({
  state,
  children,
}: {
  state: { data: T | undefined; error: unknown; loading: boolean; reload: () => void };
  children: (data: T) => React.ReactNode;
}) {
  if (state.loading && state.data === undefined) return <Loading />;
  if (state.error instanceof ApiError && state.error.kind === 'forbidden') return <NoPermission />;
  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (state.data === undefined) return <Loading />;
  return <>{children(state.data)}</>;
}

/** Shown in place of content the API refused with 403. */
export function NoPermission() {
  return (
    <div className="card">
      <h2>Bạn không có quyền xem nội dung này</h2>
      <p className="muted">
        Nội dung này dành cho người dùng khác. Hãy liên hệ giáo viên hoặc quản trị viên nếu cần.
      </p>
    </div>
  );
}
