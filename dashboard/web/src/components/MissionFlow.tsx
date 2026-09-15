import { useMemo, useState } from 'react';
import type { AgentRun, MissionEvent, MissionKind } from '../lib/api.ts';
import { Badge, StatusDot, fmtDuration } from './ui.tsx';

/**
 * How the work actually moved: the request arrives, the orchestrator decides
 * what it is and who should do it, specialists run, each reports back.
 *
 * Agents engaged within a few seconds of each other are drawn as one row,
 * because concurrent and sequential work look identical in a list and the
 * difference is the whole point.
 */

const WAVE_WINDOW_MS = 4000;

const INTAKE: Record<MissionKind, { title: string; from: string }> = {
  incident: { title: 'Alert received', from: 'from monitoring' },
  sdlc: { title: 'Task received', from: 'from the console' },
  ticket: { title: 'Ticket received', from: 'from GitHub Issues' },
  review: { title: 'Pull request opened', from: 'from GitHub' },
};

interface Props {
  agents: AgentRun[];
  events: MissionEvent[];
  missionKind: MissionKind;
  missionStatus: string;
  missionInput: string;
}

export default function MissionFlow({
  agents, events, missionKind, missionStatus, missionInput,
}: Props) {
  const [open, setOpen] = useState<string | null>(null);

  const waves = useMemo(() => {
    const sorted = [...agents].sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
    );
    const out: AgentRun[][] = [];
    for (const a of sorted) {
      const last = out[out.length - 1];
      const t = new Date(a.startedAt).getTime();
      if (last && t - new Date(last[0].startedAt).getTime() <= WAVE_WINDOW_MS) last.push(a);
      else out.push([a]);
    }
    return out;
  }, [agents]);

  /** The orchestrator's own words - its plan, before it delegated anything. */
  const plan = events.find(
    (e) => e.type === 'agent.message' && e.actor === 'orchestrator' && (e.text ?? '').trim(),
  )?.text;

  const live = ['running', 'queued', 'awaiting_approval'].includes(missionStatus);
  const toolCount = (agentType: string) =>
    events.filter((e) => e.type === 'tool.called' && e.actor === agentType).length;

  return (
    <div className="space-y-0 p-4">
      <Step index="1" title={INTAKE[missionKind].title} caption={INTAKE[missionKind].from}>
        <p className="line-clamp-3 text-[12px] leading-relaxed text-ink-400">{missionInput}</p>
      </Step>

      <Link />

      <Step
        index="2"
        title="Orchestrator"
        caption={agents.length === 0 ? 'working out what this is…' : 'decided the plan and who should do it'}
        busy={live && agents.length === 0}
        tone="think"
      >
        {plan ? (
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink-300">
            {plan.length > 420 ? plan.slice(0, 420) + '…' : plan}
          </p>
        ) : (
          <p className="text-[12px] text-ink-500">Reading the request…</p>
        )}
      </Step>

      {waves.length === 0 ? (
        <>
          <Link />
          <div className="rounded-lg border border-dashed border-ink-700 px-4 py-5 text-center text-[12px] text-ink-400">
            No specialist engaged yet.
          </div>
        </>
      ) : (
        waves.map((wave, i) => (
          <div key={i}>
            <Link label={wave.length > 1 ? `${wave.length} working in parallel` : 'delegated to'} />
            <div className={`grid gap-2 ${wave.length > 1 ? 'sm:grid-cols-2' : ''}`}>
              {wave.map((a) => {
                const isOpen = open === a.id;
                const ms =
                  new Date(a.finishedAt ?? a.startedAt).getTime() - new Date(a.startedAt).getTime();
                return (
                  <div
                    key={a.id}
                    className={`rounded-lg border bg-ink-900 ${
                      a.status === 'running'
                        ? 'border-signal-500/50'
                        : a.status === 'failed'
                          ? 'border-crit-500/40'
                          : 'border-ink-700'
                    }`}
                  >
                    <button
                      onClick={() => setOpen(isOpen ? null : a.id)}
                      className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
                    >
                      <StatusDot status={a.status} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2">
                          <span className="font-mono text-[12px] font-medium text-ink-100">
                            {a.agentType}
                          </span>
                          <span className="text-[10px] text-ink-500">
                            {a.status === 'running' ? 'working…' : fmtDuration(ms)}
                            {toolCount(a.agentType) > 0 && ` · ${toolCount(a.agentType)} tool calls`}
                          </span>
                        </div>
                        {a.task && (
                          <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-400">
                            asked to: {a.task}
                          </div>
                        )}
                      </div>
                      <span className="mt-0.5 shrink-0 text-[10px] text-ink-500">
                        {isOpen ? 'hide' : 'output'}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="border-t border-ink-700 px-3 py-2.5">
                        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-500">
                          Reported back
                        </div>
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-ink-300">
                          {a.result?.trim() || (a.status === 'running' ? 'Still working…' : 'Nothing returned.')}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}

      {['succeeded', 'failed', 'cancelled'].includes(missionStatus) && (
        <>
          <Link />
          <Step
            index="✓"
            title={
              missionStatus === 'succeeded'
                ? 'Done'
                : missionStatus === 'cancelled'
                  ? 'Cancelled'
                  : 'Failed'
            }
            caption={missionStatus === 'succeeded' ? 'outcome below' : undefined}
            tone={missionStatus === 'succeeded' ? 'ok' : 'crit'}
          />
        </>
      )}
    </div>
  );
}

function Link({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5 pl-[13px]">
      <div className="h-6 w-px bg-ink-600" />
      {label && (
        <Badge tone="info" className="ml-1">
          {label}
        </Badge>
      )}
    </div>
  );
}

function Step({
  index, title, caption, children, busy, tone = 'neutral',
}: {
  index: string;
  title: string;
  caption?: string;
  children?: React.ReactNode;
  busy?: boolean;
  tone?: 'neutral' | 'think' | 'ok' | 'crit';
}) {
  const ring = {
    neutral: 'border-ink-600 text-ink-400',
    think: 'border-think-400/50 text-think-400',
    ok: 'border-ok-500/50 text-ok-400',
    crit: 'border-crit-500/50 text-crit-400',
  }[tone];

  return (
    <div className="flex gap-2.5">
      <span
        className={`mt-0.5 grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full border bg-ink-900 text-[11px] font-semibold ${ring} ${
          busy ? 'pulse-ring' : ''
        }`}
      >
        {index}
      </span>
      <div className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-semibold text-ink-100">{title}</span>
          {caption && <span className="text-[11px] text-ink-400">{caption}</span>}
        </div>
        {children && <div className="mt-1.5">{children}</div>}
      </div>
    </div>
  );
}
