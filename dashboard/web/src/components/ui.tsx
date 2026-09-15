import { useEffect, useState, type ReactNode } from 'react';

/* Shared primitives. Kept small and explicit rather than abstracted early. */

export function Panel({
  title, actions, children, className = '', dense = false,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  return (
    <section
      className={`flex min-h-0 flex-col rounded-lg border border-ink-700 bg-ink-900 shadow-sm ${className}`}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-ink-700 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-wide text-ink-200 uppercase">
            {title}
          </h2>
          {actions}
        </header>
      )}
      <div className={`flex min-h-0 flex-1 flex-col ${dense ? '' : 'p-4'}`}>{children}</div>
    </section>
  );
}

const TONES = {
  neutral: 'bg-ink-800 text-ink-300 border-ink-600',
  info: 'bg-signal-500/10 text-signal-300 border-signal-500/25',
  ok: 'bg-ok-500/10 text-ok-400 border-ok-500/25',
  warn: 'bg-warn-500/10 text-warn-400 border-warn-500/25',
  crit: 'bg-crit-500/10 text-crit-400 border-crit-500/25',
  think: 'bg-think-400/10 text-think-400 border-think-400/25',
} as const;

export type Tone = keyof typeof TONES;

export function Badge({
  children, tone = 'neutral', className = '',
}: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children, onClick, variant = 'default', disabled, className = '', type = 'button', title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const variants = {
    default: 'bg-ink-900 hover:bg-ink-800 text-ink-200 border-ink-600',
    primary: 'bg-signal-500 hover:bg-signal-400 text-white border-signal-400',
    danger: 'bg-crit-500/90 hover:bg-crit-500 text-white border-crit-400',
    ghost: 'bg-transparent hover:bg-ink-800 text-ink-400 border-transparent',
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    running: 'bg-signal-400 pulse-ring',
    queued: 'bg-ink-400',
    awaiting_approval: 'bg-warn-400 pulse-ring',
    succeeded: 'bg-ok-500',
    failed: 'bg-crit-500',
    cancelled: 'bg-ink-500',
    firing: 'bg-crit-500 pulse-ring',
    acknowledged: 'bg-warn-400',
    resolved: 'bg-ok-500',
  };
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${map[status] ?? 'bg-ink-400'}`}
      aria-hidden
    />
  );
}

export function Metric({
  label, value, hint, tone,
}: { label: string; value: ReactNode; hint?: string; tone?: 'ok' | 'warn' | 'crit' }) {
  const color =
    tone === 'crit' ? 'text-crit-400' : tone === 'warn' ? 'text-warn-400' : tone === 'ok' ? 'text-ok-400' : 'text-ink-100';
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className={`mt-0.5 font-mono text-lg font-semibold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-400">{hint}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center rounded-md border border-dashed border-ink-700 px-4 py-8 text-[13px] text-ink-400">
      {children}
    </div>
  );
}

/** Compact relative time - "4m ago". Absolute timestamps waste width here. */
export function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const fmtDuration = (ms: number) => {
  if (!ms) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

export const fmtCost = (usd: number) => (usd ? `$${usd.toFixed(3)}` : '$0.000');

/**
 * Labels, in one place and in sentence case.
 *
 * Statuses and kinds arrive from the API as machine values - `sdlc`,
 * `awaiting_approval`, `running` - and were being printed raw, so the dashboard
 * read as a database dump: "delivery", "running", "ready" in lower case beside
 * properly cased headings.
 */
const KIND_NAMES: Record<string, string> = {
  sdlc: 'Delivery',
  incident: 'Incident',
  ticket: 'Ticket',
  review: 'Review',
};

const STATUS_NAMES: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Awaiting you',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  working: 'Working',
  idle: 'Idle',
  firing: 'Firing',
  resolved: 'Resolved',
  ready: 'Ready',
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  ignored: 'Ignored',
  duplicate: 'Duplicate',
  dispatched: 'Dispatched',
};

/** Sentence case for anything not in the maps above. */
const sentence = (v: string) =>
  v ? v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : v;

export const kindLabel = (kind: string): string => KIND_NAMES[kind] ?? sentence(kind);
export const statusLabel = (status: string): string => STATUS_NAMES[status] ?? sentence(status);

/**
 * Elapsed time for something still running, ticking once a second.
 *
 * Duration was only written when a mission finished, so a live mission showed
 * "-" in the one column people watch while they wait. Passing `null` for the
 * end time means "still going"; the hook re-renders until it stops.
 */
export function useElapsed(startedAt: string | null | undefined, finishedAt: string | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  const live = Boolean(startedAt) && !finishedAt;

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  if (!startedAt) return null;
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  const ms = end - new Date(startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Duration text that keeps counting while the thing is still running. */
export function Elapsed({
  startedAt, finishedAt, fallback = '—',
}: { startedAt?: string | null; finishedAt?: string | null; fallback?: string }) {
  const ms = useElapsed(startedAt, finishedAt);
  if (ms === null) return <>{fallback}</>;
  return <>{fmtDuration(ms)}</>;
}
