import { useEffect, useMemo, useState } from 'react';
import type { AgentRun, MissionEvent, MissionKind } from '../lib/api.ts';
import { fmtDuration } from './ui.tsx';

/**
 * The execution view.
 *
 * A step chain across the top, and the detail for whichever step you pick
 * below it. Everything at once is unreadable on a real mission - by the time
 * three specialists have reported, the request that started it is a screen and
 * a half away - so the chain stays fixed and only the panel underneath changes.
 */

const WAVE_WINDOW_MS = 4000;

const INTAKE: Record<MissionKind, string> = {
  incident: 'Alert received',
  sdlc: 'Task received',
  ticket: 'Ticket received',
  review: 'Pull request received',
};

type StepId = 'request' | 'plan' | 'execute' | 'outcome';
type StepState = 'done' | 'active' | 'pending';

interface Props {
  agents: AgentRun[];
  events: MissionEvent[];
  missionKind: MissionKind;
  missionStatus: string;
  missionInput: string;
  missionSummary?: string | null;
}

export default function MissionFlow({
  agents, events, missionKind, missionStatus, missionInput, missionSummary,
}: Props) {
  const done = ['succeeded', 'failed', 'cancelled'].includes(missionStatus);

  const plan = events.find(
    (e) => e.type === 'agent.message' && e.actor === 'orchestrator' && (e.text ?? '').trim(),
  )?.text;

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

  const steps: Array<{ id: StepId; n: string; label: string; detail: string; state: StepState }> = [
    { id: 'request', n: '1', label: INTAKE[missionKind], detail: 'what was asked', state: 'done' },
    {
      id: 'plan',
      n: '2',
      label: 'Plan',
      detail: plan ? 'the approach chosen' : 'deciding…',
      state: plan ? 'done' : 'active',
    },
    {
      id: 'execute',
      n: '3',
      label: 'Execute',
      detail: agents.length
        ? `${agents.length} specialist${agents.length === 1 ? '' : 's'}`
        : 'not started',
      state: agents.length === 0 ? 'pending' : done ? 'done' : 'active',
    },
    {
      id: 'outcome',
      n: '4',
      label: missionStatus === 'succeeded' ? 'Complete' : done ? 'Ended' : 'Outcome',
      detail: done ? missionStatus.replace('_', ' ') : 'pending',
      state: done ? 'done' : 'pending',
    },
  ];

  // Follow the work: land on whatever is happening now, until the reader picks
  // a step themselves.
  const liveStep: StepId = !plan ? 'plan' : done ? 'outcome' : agents.length ? 'execute' : 'plan';
  const [picked, setPicked] = useState<StepId | null>(null);
  const [lastLive, setLastLive] = useState(liveStep);
  useEffect(() => {
    if (liveStep !== lastLive) {
      setLastLive(liveStep);
      setPicked(null);
    }
  }, [liveStep, lastLive]);
  const current = picked ?? liveStep;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ---- step chain ---- */}
      <div className="shrink-0 border-b border-ink-700 px-4 py-4">
        <ol className="flex items-start">
          {steps.map((s, i) => (
            <li key={s.id} className="flex flex-1 items-start">
              <button
                onClick={() => setPicked(s.id)}
                className="group flex min-w-0 flex-col items-center gap-1.5 px-1 text-center"
                aria-current={current === s.id ? 'step' : undefined}
              >
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 text-[12px] font-semibold transition-colors ${
                    current === s.id
                      ? 'border-signal-500 bg-signal-500 text-white'
                      : s.state === 'done'
                        ? 'border-ok-500/50 bg-ok-500/15 text-ok-400 group-hover:border-ok-500'
                        : s.state === 'active'
                          ? 'border-signal-500/60 bg-signal-500/15 text-signal-400 pulse-ring'
                          : 'border-ink-700 bg-ink-900 text-ink-500'
                  }`}
                >
                  {s.state === 'done' && current !== s.id ? '✓' : s.n}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block truncate text-[12px] font-semibold ${
                      current === s.id ? 'text-ink-100' : s.state === 'pending' ? 'text-ink-500' : 'text-ink-200'
                    }`}
                  >
                    {s.label}
                  </span>
                  <span className="block truncate text-[10px] text-ink-500">{s.detail}</span>
                </span>
              </button>
              {i < steps.length - 1 && (
                <span
                  className={`mt-4 h-px min-w-6 flex-1 ${
                    steps[i + 1].state === 'pending' ? 'bg-ink-700' : 'bg-ok-500/40'
                  }`}
                  aria-hidden
                />
              )}
            </li>
          ))}
        </ol>
      </div>

      {/* ---- detail for the chosen step ---- */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {current === 'request' && (
          <Block label="The request" tone="muted">
            {missionInput}
          </Block>
        )}

        {current === 'plan' && (
          plan ? (
            <Block label="Orchestrator · plan" tone="think">{plan}</Block>
          ) : (
            <Waiting>The orchestrator is reading the request.</Waiting>
          )
        )}

        {current === 'execute' && (
          waves.length === 0 ? (
            <Waiting>No specialist engaged yet.</Waiting>
          ) : (
            <div className="space-y-5">
              {waves.map((wave, i) => (
                <section key={i}>
                  {wave.length > 1 && (
                    <div className="mb-2 flex items-center gap-2">
                      <span className="rounded-full border border-signal-500/30 bg-signal-500/10 px-2 py-0.5 text-[10px] font-medium text-signal-400">
                        {wave.length} in parallel
                      </span>
                      <span className="h-px flex-1 bg-ink-700" />
                    </div>
                  )}
                  <div className="space-y-3">
                    {wave.map((a) => (
                      <AgentThread
                        key={a.id}
                        run={a}
                        toolCalls={events.filter((e) => e.type === 'tool.called' && e.actor === a.agentType).length}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )
        )}

        {current === 'outcome' && (
          missionSummary ? (
            <Block label="Outcome" tone="ok">{missionSummary}</Block>
          ) : (
            <Waiting>
              {done ? 'The mission ended without a written outcome.' : 'Still running.'}
            </Waiting>
          )
        )}
      </div>
    </div>
  );
}

/** One specialist: what it was asked, and what it said back. */
function AgentThread({ run, toolCalls }: { run: AgentRun; toolCalls: number }) {
  const [open, setOpen] = useState(false);
  const ms = new Date(run.finishedAt ?? run.startedAt).getTime() - new Date(run.startedAt).getTime();
  const result = run.result?.trim() ?? '';
  const long = result.length > 700;

  const tone =
    run.status === 'failed' ? 'crit' : run.status === 'running' ? 'info' : 'ok';
  const border = {
    crit: 'border-crit-500/40',
    info: 'border-signal-500/45',
    ok: 'border-ink-700',
  }[tone];
  const chip = {
    crit: 'bg-crit-500/20 text-crit-400',
    info: 'bg-signal-500/25 text-signal-400',
    ok: 'bg-ink-800 text-ink-400',
  }[tone];

  return (
    <article className={`overflow-hidden rounded-xl border bg-ink-900 ${border}`}>
      <header className="flex items-center gap-2.5 border-b border-ink-800 px-3 py-2.5">
        <span
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[10px] font-bold ${chip} ${
            run.status === 'running' ? 'pulse-ring' : ''
          }`}
          aria-hidden
        >
          {run.agentType.split('-').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12.5px] font-semibold text-ink-100">
            {run.agentType}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-ink-500">
            {run.status === 'running' ? 'working' : fmtDuration(ms)} · {toolCalls} tool call{toolCalls === 1 ? '' : 's'}
          </div>
        </div>
      </header>

      {run.task && (
        <div className="border-b border-ink-800 bg-ink-100 px-3 py-2">
          <div className="mb-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-950/55">
            From orchestrator
          </div>
          <div className="text-[12px] leading-relaxed text-ink-950">{run.task}</div>
        </div>
      )}

      <div className="px-3 py-2.5">
        <div className="mb-1 font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-500">
          Reported back
        </div>
        {result ? (
          <>
            <div
              className={`whitespace-pre-wrap text-[12px] leading-relaxed text-ink-300 ${
                long && !open ? 'max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]' : ''
              }`}
            >
              {result}
            </div>
            {long && (
              <button
                onClick={() => setOpen(!open)}
                className="mt-1.5 text-[11px] font-medium text-signal-300 hover:underline"
              >
                {open ? 'Show less' : 'Show full report'}
              </button>
            )}
          </>
        ) : (
          <div className="text-[12px] text-ink-500">
            {run.status === 'running' ? 'Working…' : 'Nothing returned.'}
          </div>
        )}
      </div>
    </article>
  );
}

function Block({
  label, tone, children,
}: { label: string; tone: 'muted' | 'think' | 'ok'; children: React.ReactNode }) {
  const style = {
    muted: 'border-ink-700 bg-ink-900',
    think: 'border-think-400/35 bg-think-400/[0.06]',
    ok: 'border-ok-500/35 bg-ok-500/[0.06]',
  }[tone];
  return (
    <div className={`rounded-xl border px-4 py-3 ${style}`}>
      <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-500">
        {label}
      </div>
      <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-200">{children}</div>
    </div>
  );
}

const Waiting = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-xl border border-dashed border-ink-700 px-4 py-8 text-center text-[12px] text-ink-500">
    {children}
  </div>
);
