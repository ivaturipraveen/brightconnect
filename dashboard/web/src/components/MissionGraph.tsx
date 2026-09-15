import { useMemo, useState } from 'react';
import type { AgentRun, MissionEvent, MissionKind } from '../lib/api.ts';
import { fmtDuration } from './ui.tsx';
import Markdown from './Markdown.tsx';

/**
 * The mission as a graph: intake, the orchestrator, and the specialists it
 * engaged, connected by curved edges.
 *
 * Positions are computed rather than measured from the DOM - the layout is
 * regular enough that arithmetic beats a resize observer, and it means the
 * edges are correct on first paint instead of snapping into place.
 */

const WAVE_WINDOW_MS = 4000;

const NODE_W = 330;
const NODE_H = 186;
const COL_GAP = 28;
const ROW_GAP = 46;
const PAD_X = 20;
const PAD_Y = 16;

const INTAKE: Record<MissionKind, string> = {
  incident: 'Alert',
  sdlc: 'Task',
  ticket: 'Ticket',
  review: 'Pull request',
};

interface Props {
  agents: AgentRun[];
  events: MissionEvent[];
  missionKind: MissionKind;
  missionStatus: string;
  missionInput: string;
  missionSummary?: string | null;
}

interface Node {
  key: string;
  kind: 'intake' | 'orchestrator' | 'agent' | 'outcome';
  title: string;
  subtitle: string;
  state: 'done' | 'running' | 'failed' | 'pending';
  x: number;
  y: number;
  run?: AgentRun;
  /** What this node was told to do, where that applies. */
  brief?: string;
  /** What it produced, shown inside the node. */
  body?: string;
  bodyLabel?: string;
}

const toolCallsFor = (events: MissionEvent[], agent: string) =>
  events.filter((e) => e.type === 'tool.called' && e.actor === agent).length;

/**
 * Markdown syntax stripped for the small card previews.
 *
 * A four-line thumbnail rendered as real markdown is mostly heading margins, so
 * the cards show the prose and the detail pane renders it properly.
 */
function plainPreview(text: string): string {
  return text
    .replace(/^```.*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*(---+|\*\*\*+|___+)\s*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default function MissionGraph({
  agents, events, missionKind, missionStatus, missionInput, missionSummary,
}: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  const done = ['succeeded', 'failed', 'cancelled'].includes(missionStatus);
  const plan = events.find(
    (e) => e.type === 'agent.message' && e.actor === 'orchestrator' && (e.text ?? '').trim(),
  )?.text;

  const { nodes, edges, width, height } = useMemo(() => {
    const sorted = [...agents].sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
    );
    const waves: AgentRun[][] = [];
    for (const a of sorted) {
      const last = waves[waves.length - 1];
      const t = new Date(a.startedAt).getTime();
      if (last && t - new Date(last[0].startedAt).getTime() <= WAVE_WINDOW_MS) last.push(a);
      else waves.push([a]);
    }

    const widest = Math.max(1, ...waves.map((w) => w.length));
    const canvasW = PAD_X * 2 + widest * NODE_W + (widest - 1) * COL_GAP;
    const centre = canvasW / 2 - NODE_W / 2;

    const ns: Node[] = [];
    let y = PAD_Y;

    ns.push({
      key: 'intake', kind: 'intake', title: INTAKE[missionKind], subtitle: 'received',
      state: 'done', x: centre, y,
      body: missionInput, bodyLabel: 'Request',
    });
    y += NODE_H + ROW_GAP;

    ns.push({
      key: 'orchestrator', kind: 'orchestrator', title: 'Orchestrator',
      subtitle: plan ? 'planned the work' : 'deciding…',
      state: plan ? 'done' : 'running', x: centre, y,
      body: plan ?? undefined, bodyLabel: 'Plan',
    });
    y += NODE_H + ROW_GAP;

    const es: Array<{ from: string; to: string }> = [{ from: 'intake', to: 'orchestrator' }];

    for (const wave of waves) {
      const rowW = wave.length * NODE_W + (wave.length - 1) * COL_GAP;
      const startX = (canvasW - rowW) / 2;
      wave.forEach((run, i) => {
        const key = `agent-${run.id}`;
        ns.push({
          key, kind: 'agent', title: run.agentType,
          subtitle:
            run.status === 'running'
              ? 'working'
              : fmtDuration(new Date(run.finishedAt ?? run.startedAt).getTime() - new Date(run.startedAt).getTime()),
          state: run.status === 'running' ? 'running' : run.status === 'failed' ? 'failed' : 'done',
          x: startX + i * (NODE_W + COL_GAP), y, run,
          brief: run.task ?? undefined,
          body: run.result?.trim() || undefined,
          bodyLabel: 'Reported back',
        });
        // Every specialist is engaged by the orchestrator, whichever wave it is.
        es.push({ from: 'orchestrator', to: key });
      });
      y += NODE_H + ROW_GAP;
    }

    if (done) {
      ns.push({
        key: 'outcome', kind: 'outcome',
        title: missionStatus === 'succeeded' ? 'Complete' : missionStatus === 'cancelled' ? 'Cancelled' : 'Failed',
        subtitle: missionSummary ? 'outcome recorded' : missionStatus,
        state: missionStatus === 'succeeded' ? 'done' : 'failed',
        x: centre, y,
        body: missionSummary ?? undefined, bodyLabel: 'Outcome',
      });
      for (const n of ns.filter((n) => n.kind === 'agent')) es.push({ from: n.key, to: 'outcome' });
      if (waves.length === 0) es.push({ from: 'orchestrator', to: 'outcome' });
      y += NODE_H;
    } else {
      y -= ROW_GAP;
      y += NODE_H;
    }

    return { nodes: ns, edges: es, width: canvasW, height: y + PAD_Y };
  }, [agents, missionKind, missionStatus, missionSummary, missionInput, plan, done, events]);

  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const chosen = selected ? byKey.get(selected) : null;

  /** A vertical cubic curve: leaves the bottom, arrives at the top. */
  const curve = (from: Node, to: Node) => {
    const x1 = from.x + NODE_W / 2;
    const y1 = from.y + NODE_H;
    const x2 = to.x + NODE_W / 2;
    const y2 = to.y;
    const lift = Math.max(24, (y2 - y1) * 0.55);
    return `M ${x1} ${y1} C ${x1} ${y1 + lift}, ${x2} ${y2 - lift}, ${x2} ${y2}`;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="relative mx-auto" style={{ width, height }}>
          <svg
            className="absolute inset-0 overflow-visible"
            width={width}
            height={height}
            aria-hidden
          >
            {edges.map((e, i) => {
              const from = byKey.get(e.from);
              const to = byKey.get(e.to);
              if (!from || !to) return null;
              const pending = to.state === 'pending';
              return (
                <path
                  key={i}
                  d={curve(from, to)}
                  fill="none"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  className={
                    to.state === 'running'
                      ? 'stroke-signal-500'
                      : to.state === 'failed'
                        ? 'stroke-crit-500/50'
                        : pending
                          ? 'stroke-ink-700'
                          : 'stroke-ink-600'
                  }
                  strokeDasharray={to.state === 'running' ? '5 4' : undefined}
                >
                  {to.state === 'running' && (
                    <animate attributeName="stroke-dashoffset" from="18" to="0" dur="1.1s" repeatCount="indefinite" />
                  )}
                </path>
              );
            })}
          </svg>

          {nodes.map((n) => (
            <button
              key={n.key}
              onClick={() => setSelected(selected === n.key ? null : n.key)}
              className={`absolute flex flex-col overflow-hidden rounded-xl border text-left transition-shadow hover:shadow-md ${
                selected === n.key ? 'ring-2 ring-signal-500/50' : ''
              } ${
                n.kind === 'orchestrator'
                  ? 'border-think-400/45 bg-think-400/[0.06]'
                  : n.state === 'running'
                    ? 'border-signal-500/50 bg-ink-900'
                    : n.state === 'failed'
                      ? 'border-crit-500/45 bg-ink-900'
                      : n.kind === 'intake' || n.kind === 'outcome'
                        ? 'border-ink-600 bg-ink-850'
                        : 'border-ink-700 bg-ink-900'
              }`}
              style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
            >
              <div className="flex shrink-0 items-center gap-2 border-b border-ink-800 px-2.5 py-2">
                <span
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[9px] font-bold ${
                    n.kind === 'orchestrator'
                      ? 'bg-think-400/25 text-think-400'
                      : n.state === 'running'
                        ? 'bg-signal-500/25 text-signal-400'
                        : n.state === 'failed'
                          ? 'bg-crit-500/20 text-crit-400'
                          : 'bg-ink-800 text-ink-400'
                  } ${n.state === 'running' ? 'pulse-ring' : ''}`}
                  aria-hidden
                >
                  {initials(n)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11.5px] font-semibold text-ink-100">
                    {n.title}
                  </span>
                  <span className="block truncate text-[9px] uppercase tracking-wide text-ink-500">
                    {n.subtitle}
                    {n.run ? ` · ${toolCallsFor(events, n.run.agentType)} tool calls` : ''}
                  </span>
                </span>
              </div>

              <div className="min-h-0 flex-1 space-y-1.5 overflow-hidden px-2.5 py-2">
                {n.brief && (
                  <div className="rounded border border-ink-700 bg-ink-100 px-1.5 py-1">
                    <div className="font-mono text-[8px] font-semibold uppercase tracking-wider text-ink-950/55">
                      Asked
                    </div>
                    <div className="line-clamp-2 text-[10.5px] leading-snug text-ink-950">{n.brief}</div>
                  </div>
                )}
                {n.body ? (
                  <div>
                    <div className="font-mono text-[8px] font-semibold uppercase tracking-wider text-ink-500">
                      {n.bodyLabel}
                    </div>
                    <div className="line-clamp-4 whitespace-pre-wrap text-[10.5px] leading-snug text-ink-300">
                      {plainPreview(n.body)}
                    </div>
                  </div>
                ) : (
                  <div className="text-[10.5px] text-ink-500">
                    {n.state === 'running' ? 'Working…' : 'Nothing recorded.'}
                  </div>
                )}
              </div>

              <div className="shrink-0 border-t border-ink-800 px-2.5 py-1 text-[9px] text-signal-300">
                {selected === n.key ? 'showing in full →' : 'click for the full text'}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ---- detail for whichever node is chosen ---- */}
      <aside className="min-h-0 shrink-0 overflow-y-auto border-t border-ink-700 p-4 lg:w-[340px] lg:border-l lg:border-t-0">
        {!chosen ? (
          <p className="text-[12px] leading-relaxed text-ink-500">
            Click any node to see what it was given and what it produced.
          </p>
        ) : chosen.kind === 'intake' ? (
          <Detail label="The request">{missionInput}</Detail>
        ) : chosen.kind === 'orchestrator' ? (
          <Detail label="Orchestrator · plan">
            {plan ?? 'Still reading the request.'}
          </Detail>
        ) : chosen.kind === 'outcome' ? (
          <Detail label="Outcome">{missionSummary ?? missionStatus}</Detail>
        ) : (
          <div className="space-y-3">
            <Detail label="From orchestrator" tone="instruction">
              {chosen.run?.task ?? 'No brief recorded.'}
            </Detail>
            <Detail label={`${chosen.title} · reported back`}>
              {chosen.run?.result?.trim() ||
                (chosen.run?.status === 'running' ? 'Working…' : 'Nothing returned.')}
            </Detail>
          </div>
        )}
      </aside>
    </div>
  );
}

function initials(n: Node): string {
  if (n.kind === 'orchestrator') return 'AD';
  if (n.kind === 'intake') return '→';
  if (n.kind === 'outcome') return '✓';
  return n.title.split('-').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function Detail({
  label, tone = 'normal', children,
}: { label: string; tone?: 'normal' | 'instruction'; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        tone === 'instruction' ? 'border-ink-600 bg-ink-100' : 'border-ink-700 bg-ink-900'
      }`}
    >
      <div
        className={`mb-1 font-mono text-[9px] font-semibold uppercase tracking-wider ${
          tone === 'instruction' ? 'text-ink-950/55' : 'text-ink-500'
        }`}
      >
        {label}
      </div>
      {typeof children === 'string' ? (
        <Markdown className={`text-[12px] ${tone === 'instruction' ? 'text-ink-950' : 'text-ink-300'}`}>
          {children}
        </Markdown>
      ) : (
        <div
          className={`whitespace-pre-wrap text-[12px] leading-relaxed ${
            tone === 'instruction' ? 'text-ink-950' : 'text-ink-300'
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
