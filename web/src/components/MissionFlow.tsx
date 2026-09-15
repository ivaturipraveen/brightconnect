import { useMemo, useState } from 'react';
import type { AgentRun, MissionEvent } from '../lib/api.ts';
import { Badge, StatusDot, fmtDuration } from './ui.tsx';

/**
 * The delegation flow: the request arrives at the orchestrator, which engages
 * specialists.
 *
 * Agents are grouped into "waves" by how close together they were engaged.
 * That grouping is the whole point of the view - three investigators on one row
 * is the visible difference between concurrent work and a serial queue, and it
 * is the thing that is hard to convey in a text feed.
 */

/** Agents engaged within this window of each other count as concurrent. */
const WAVE_WINDOW_MS = 4000;

interface Props {
  agents: AgentRun[];
  events: MissionEvent[];
  missionKind: 'sdlc' | 'incident';
  missionStatus: string;
}

export default function MissionFlow({ agents, events, missionKind, missionStatus }: Props) {
  const [selected, setSelected] = useState<string | null>(null);

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

  const toolsFor = (agentType: string) =>
    events.filter((e) => e.type === 'tool.called' && e.actor === agentType).length;

  const selectedAgent = agents.find((a) => a.id === selected);
  const orchestratorBusy = ['running', 'queued', 'awaiting_approval'].includes(missionStatus);

  return (
    <div className="p-4">
      {/* ---- intake ---- */}
      <Node
        tone="intake"
        title={missionKind === 'incident' ? 'Alert received' : 'Specification received'}
        subtitle={missionKind === 'incident' ? 'from monitoring' : 'from the requester'}
      />
      <Connector />

      {/* ---- orchestrator ---- */}
      <Node
        tone="orchestrator"
        busy={orchestratorBusy}
        title="Orchestrator"
        subtitle={
          agents.length === 0
            ? 'planning the mission…'
            : `planned the work and engaged ${agents.length} specialist${agents.length === 1 ? '' : 's'}`
        }
      />

      {/* ---- waves of specialists ---- */}
      {waves.length === 0 ? (
        <>
          <Connector />
          <div className="mx-auto max-w-md rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-[13px] text-ink-400">
            No specialists engaged yet.
          </div>
        </>
      ) : (
        waves.map((wave, i) => (
          <div key={i}>
            <Connector label={wave.length > 1 ? `${wave.length} in parallel` : undefined} />
            <div
              className={`grid gap-2.5 ${
                wave.length === 1
                  ? 'grid-cols-1 sm:max-w-md sm:mx-auto'
                  : wave.length === 2
                    ? 'sm:grid-cols-2'
                    : 'sm:grid-cols-2 lg:grid-cols-3'
              }`}
            >
              {wave.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSelected(selected === a.id ? null : a.id)}
                  className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    selected === a.id
                      ? 'border-signal-500 bg-ink-800'
                      : a.status === 'running'
                        ? 'border-signal-500/50 bg-ink-850 hover:bg-ink-800'
                        : a.status === 'failed'
                          ? 'border-crit-500/40 bg-ink-850 hover:bg-ink-800'
                          : 'border-ink-700 bg-ink-850 hover:bg-ink-800'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <StatusDot status={a.status} />
                    <span className="truncate font-mono text-[12px] font-medium text-ink-100">
                      {a.agentType}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-ink-500">
                      {a.status === 'running'
                        ? 'working'
                        : fmtDuration(
                            new Date(a.finishedAt ?? a.startedAt).getTime() -
                              new Date(a.startedAt).getTime(),
                          )}
                    </span>
                  </div>
                  {a.task && (
                    <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-400">
                      {a.task}
                    </div>
                  )}
                  <div className="mt-1.5 text-[10px] text-ink-500">
                    {toolsFor(a.agentType)} tool call{toolsFor(a.agentType) === 1 ? '' : 's'}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))
      )}

      {/* ---- outcome ---- */}
      {['succeeded', 'failed', 'cancelled'].includes(missionStatus) && (
        <>
          <Connector />
          <Node
            tone={missionStatus === 'succeeded' ? 'done' : 'failed'}
            title={
              missionStatus === 'succeeded'
                ? 'Mission complete'
                : missionStatus === 'cancelled'
                  ? 'Cancelled by operator'
                  : 'Mission failed'
            }
            subtitle={missionStatus === 'succeeded' ? 'results below' : undefined}
          />
        </>
      )}

      {/* ---- selected agent detail ---- */}
      {selectedAgent && (
        <div className="mt-4 rounded-lg border border-signal-500/40 bg-ink-850 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info">{selectedAgent.agentType}</Badge>
            <Badge tone={selectedAgent.status === 'succeeded' ? 'ok' : selectedAgent.status === 'failed' ? 'crit' : 'info'}>
              {selectedAgent.status}
            </Badge>
            <button
              onClick={() => setSelected(null)}
              className="ml-auto text-[11px] text-ink-400 hover:text-ink-200"
            >
              close
            </button>
          </div>
          {selectedAgent.task && (
            <div className="mt-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                Assigned
              </div>
              <div className="mt-0.5 text-[12px] text-ink-200">{selectedAgent.task}</div>
            </div>
          )}
          <div className="mt-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
              Reported back
            </div>
            <pre className="mt-0.5 max-h-72 overflow-auto whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-ink-300">
              {selectedAgent.result?.trim() || 'Still working…'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Connector({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center py-1.5">
      <div className="h-4 w-px bg-ink-600" />
      {label && (
        <span className="my-1 rounded-full border border-signal-500/30 bg-signal-500/10 px-2 py-0.5 text-[10px] font-medium text-signal-300">
          {label}
        </span>
      )}
      <div className="h-4 w-px bg-ink-600" />
      <svg width="9" height="6" viewBox="0 0 9 6" className="-mt-px" aria-hidden>
        <path d="M4.5 6L0 0h9z" className="fill-ink-600" />
      </svg>
    </div>
  );
}

function Node({
  title, subtitle, tone, busy,
}: {
  title: string;
  subtitle?: string;
  tone: 'intake' | 'orchestrator' | 'done' | 'failed';
  busy?: boolean;
}) {
  const styles = {
    intake: 'border-ink-600 bg-ink-850',
    orchestrator: 'border-think-400/50 bg-think-400/10',
    done: 'border-ok-500/50 bg-ok-500/10',
    failed: 'border-crit-500/50 bg-crit-500/10',
  };
  return (
    <div
      className={`mx-auto max-w-md rounded-lg border px-4 py-2.5 text-center ${styles[tone]} ${
        busy ? 'pulse-ring' : ''
      }`}
    >
      <div className="text-[13px] font-semibold text-ink-100">{title}</div>
      {subtitle && <div className="mt-0.5 text-[11px] text-ink-400">{subtitle}</div>}
    </div>
  );
}
