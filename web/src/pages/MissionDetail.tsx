import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api, type AgentRun, type Approval, type Artifact, type Mission, type MissionEvent,
} from '../lib/api.ts';
import { useActivityStream } from '../lib/stream.ts';
import {
  Badge, Button, Empty, Metric, Panel, StatusDot, fmtCost, fmtDuration, relTime, type Tone,
} from '../components/ui.tsx';
import MissionFlow from '../components/MissionFlow.tsx';

const EVENT_STYLE: Record<string, { tone: Tone; label: string }> = {
  'mission.created': { tone: 'neutral', label: 'mission' },
  'mission.started': { tone: 'info', label: 'mission' },
  'mission.finished': { tone: 'ok', label: 'mission' },
  'agent.spawned': { tone: 'think', label: 'delegate' },
  'agent.finished': { tone: 'ok', label: 'report' },
  'agent.message': { tone: 'neutral', label: 'agent' },
  'agent.thinking': { tone: 'think', label: 'reasoning' },
  'tool.called': { tone: 'info', label: 'tool' },
  'tool.result': { tone: 'neutral', label: 'result' },
  'approval.requested': { tone: 'warn', label: 'gate' },
  'approval.decided': { tone: 'warn', label: 'decision' },
  'artifact.created': { tone: 'ok', label: 'artifact' },
  error: { tone: 'crit', label: 'error' },
};

export default function MissionDetail() {
  const { id = '' } = useParams();
  const [mission, setMission] = useState<Mission | null>(null);
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [agents, setAgents] = useState<AgentRun[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [showReasoning, setShowReasoning] = useState(false);
  // Flow first: the delegation shape is what people want to see during a run.
  const [view, setView] = useState<'flow' | 'activity'>('flow');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.mission(id);
      setMission(data.mission);
      setEvents(data.events);
      setAgents(data.agents);
      setApprovals(data.approvals);
      setArtifacts(data.artifacts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Append live events rather than refetching the whole mission on every frame -
  // a busy mission emits several events per second.
  useActivityStream({
    onEvent: (e) => {
      if (e.missionId !== id) return;
      setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e]));
      if (['agent.spawned', 'agent.finished', 'artifact.created', 'approval.requested', 'approval.decided', 'mission.finished'].includes(e.type)) {
        void load();
      }
    },
    onMission: (m) => { if (m.missionId === id) void load(); },
  });

  if (error) return <Empty>{error}</Empty>;
  if (!mission) return <Empty>Loading mission…</Empty>;

  const pending = approvals.filter((a) => a.status === 'pending');
  const visibleEvents = showReasoning ? events : events.filter((e) => e.type !== 'agent.thinking');
  const isLive = ['running', 'queued', 'awaiting_approval'].includes(mission.status);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/missions" className="text-[12px] text-ink-400 hover:text-signal-300">
            ← Mission Control
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-ink-100">
            <StatusDot status={mission.status} />
            <span className="truncate">{mission.title}</span>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-400">
            <Badge tone={mission.kind === 'incident' ? 'crit' : 'info'}>
              {mission.kind === 'incident' ? 'incident response' : 'software delivery'}
            </Badge>
            <Badge tone={mission.status === 'failed' ? 'crit' : mission.status === 'succeeded' ? 'ok' : 'warn'}>
              {mission.status.replace('_', ' ')}
            </Badge>
            <span className="font-mono">{mission.id}</span>
            <span>started {relTime(mission.createdAt)}</span>
          </div>
        </div>
        {isLive && (
          <Button variant="danger" onClick={() => void api.cancelMission(id).then(load)}>
            Cancel mission
          </Button>
        )}
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Agents engaged" value={agents.length} hint={`${agents.filter((a) => a.status === 'running').length} working now`} />
        <Metric label="Turns" value={mission.numTurns || '—'} />
        <Metric label="Duration" value={fmtDuration(mission.durationMs)} />
        <Metric label="Tokens" value={((mission.inputTokens + mission.outputTokens) / 1000).toFixed(1) + 'k'} hint="in + out, incl. subagents" />
        <Metric label="Cost" value={fmtCost(mission.costUsd)} hint="estimated, this mission" />
      </div>

      {pending.length > 0 && (
        <div className="space-y-2">
          {pending.map((a) => (
            <ApprovalCard key={a.id} approval={a} onDecided={load} />
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel
          title={
            <div className="flex items-center gap-1">
              {(['flow', 'activity'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded px-2 py-0.5 text-[12px] font-semibold uppercase tracking-wide transition-colors ${
                    view === v ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          }
          dense
          actions={
            view === 'activity' ? (
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-400">
                <input
                  type="checkbox"
                  checked={showReasoning}
                  onChange={(e) => setShowReasoning(e.target.checked)}
                  className="accent-signal-500"
                />
                show reasoning
              </label>
            ) : (
              <span className="text-[11px] text-ink-500">click an agent to see its report</span>
            )
          }
        >
          {view === 'flow' ? (
            <MissionFlow
              agents={agents}
              events={events}
              missionKind={mission.kind}
              missionStatus={mission.status}
            />
          ) : (
            <ActivityFeed events={visibleEvents} live={isLive} />
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title={`Fleet (${agents.length})`} dense>
            {agents.length === 0 ? (
              <div className="p-4"><Empty>No specialists engaged yet.</Empty></div>
            ) : (
              <ul className="divide-y divide-ink-800">
                {agents.map((a) => (
                  <li key={a.id} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <StatusDot status={a.status === 'running' ? 'running' : a.status} />
                      <span className="truncate text-[13px] font-medium text-ink-100">
                        {a.agentType}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-ink-400">
                        {a.status === 'running' ? 'working' : relTime(a.finishedAt ?? a.startedAt)}
                      </span>
                    </div>
                    {a.task && (
                      <div className="mt-0.5 line-clamp-2 pl-4 text-[11px] leading-snug text-ink-400">
                        {a.task}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={`Artifacts (${artifacts.length})`} dense>
            {artifacts.length === 0 ? (
              <div className="p-4"><Empty>Nothing produced yet.</Empty></div>
            ) : (
              <ul className="divide-y divide-ink-800">
                {artifacts.map((a) => (
                  <li key={a.id} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Badge tone={a.kind === 'pull_request' ? 'ok' : 'info'}>
                        {a.kind.replace('_', ' ')}
                      </Badge>
                    </div>
                    <div className="mt-1 text-[13px] text-ink-100">{a.title}</div>
                    {a.url ? (
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-0.5 block truncate text-[11px] text-signal-300 hover:underline"
                      >
                        {a.url}
                      </a>
                    ) : (
                      <div className="mt-0.5 text-[11px] text-ink-500">
                        recorded locally — no GitHub token
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      {mission.summary && (
        <Panel title="Mission outcome">
          <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-ink-200">
            {mission.summary}
          </pre>
        </Panel>
      )}

      {mission.error && (
        <Panel title="Failure">
          <div className="text-[13px] text-crit-400">{mission.error}</div>
        </Panel>
      )}

      <details className="rounded-lg border border-ink-700 bg-ink-900/80">
        <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-semibold uppercase tracking-wide text-ink-300">
          Mission input
        </summary>
        <pre className="max-h-96 overflow-auto border-t border-ink-700 px-4 py-3 font-mono text-[12px] leading-relaxed text-ink-300">
          {mission.input}
        </pre>
      </details>
    </div>
  );
}

function ActivityFeed({ events, live }: { events: MissionEvent[]; live: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follow the tail while the operator is at the bottom; stop the moment they
  // scroll up to read something, or the feed fights them.
  useEffect(() => {
    if (pinned) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length, pinned]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  if (events.length === 0) {
    return <div className="p-4"><Empty>Waiting for the orchestrator…</Empty></div>;
  }

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="max-h-[62vh] divide-y divide-ink-800 overflow-y-auto"
      >
        {events.map((e) => {
          const style = EVENT_STYLE[e.type] ?? { tone: 'neutral' as Tone, label: e.type };
          const isNarrative = e.type === 'agent.message' || e.type === 'mission.finished';
          return (
            <div key={e.id} className="slide-in px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={style.tone}>{style.label}</Badge>
                <span className="font-mono text-[11px] text-ink-300">{e.actor}</span>
                <span className="ml-auto text-[11px] text-ink-500">{relTime(e.createdAt)}</span>
              </div>
              {e.text && (
                <div
                  className={
                    isNarrative
                      ? 'mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-200'
                      : e.type === 'agent.thinking'
                        ? 'mt-1 line-clamp-6 whitespace-pre-wrap border-l-2 border-think-400/40 pl-2 text-[12px] italic leading-snug text-ink-400'
                        : 'mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-[12px] leading-snug text-ink-300'
                  }
                >
                  {e.text}
                </div>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {!pinned && live && (
        <button
          onClick={() => { setPinned(true); endRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-signal-500/40 bg-ink-800 px-3 py-1 text-[12px] text-signal-300 shadow-lg hover:bg-ink-700"
        >
          ↓ jump to latest
        </button>
      )}
    </div>
  );
}

function ApprovalCard({
  approval, onDecided,
}: { approval: Approval; onDecided: () => void }) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [showReason, setShowReason] = useState(false);

  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    try {
      await api.decide(approval.id, decision, reason || undefined);
      onDecided();
    } finally {
      setBusy(false);
    }
  };

  const isPR = approval.toolName.includes('open_pull_request');

  return (
    <div className="rounded-lg border border-warn-500/40 bg-warn-500/[0.07] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge tone="warn">human decision required</Badge>
            <span className="font-mono text-[11px] text-ink-400">{approval.toolName}</span>
          </div>
          <div className="mt-1.5 text-[14px] font-medium text-ink-100">{approval.summary}</div>
          <p className="mt-1 text-[12px] text-ink-400">
            {isPR
              ? 'The fleet has finished the work and assembled it for review. This is the go/no-go.'
              : 'The fleet proposes this remediation. It will change production state.'}
          </p>

          <details className="mt-2">
            <summary className="cursor-pointer text-[12px] text-signal-300 hover:underline">
              Inspect the exact action
            </summary>
            <pre className="mt-1.5 max-h-64 overflow-auto rounded border border-ink-700 bg-ink-950 p-2.5 font-mono text-[11px] leading-relaxed text-ink-300">
              {JSON.stringify(approval.input, null, 2)}
            </pre>
          </details>

          {showReason && (
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (sent back to the agent, and recorded in the trail)"
              className="mt-2 w-full rounded-md border border-ink-600 bg-ink-850 px-3 py-1.5 text-[12px] text-ink-100 placeholder:text-ink-500 focus:border-signal-500 focus:outline-none"
            />
          )}
        </div>

        <div className="flex shrink-0 gap-2">
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => (showReason ? decide('rejected') : setShowReason(true))}
          >
            {showReason ? 'Confirm reject' : 'Reject'}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => decide('approved')}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
