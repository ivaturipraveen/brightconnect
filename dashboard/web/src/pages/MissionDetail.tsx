import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api, type AgentRun, type Approval, type Artifact, type Mission, type MissionEvent,
} from '../lib/api.ts';
import { useActivityStream } from '../lib/stream.ts';
import {
  Badge, Elapsed, Button, Empty, Panel, StatusDot, fmtCost, fmtDuration, relTime, statusLabel, type Tone,
} from '../components/ui.tsx';
import MissionFlow from '../components/MissionFlow.tsx';
import MissionGraph from '../components/MissionGraph.tsx';
import Markdown from '../components/Markdown.tsx';
import SplitPane from '../components/SplitPane.tsx';

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
  const [view, setView] = useState<'flow' | 'graph' | 'activity'>('flow');
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
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pb-2">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/missions" className="text-[12px] text-ink-400 hover:text-signal-300">
            ← Mission Control
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-ink-100">
            <StatusDot status={mission.status} />
            <span className="truncate">{mission.title}</span>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-400">
            <Badge tone={mission.kind === 'incident' ? 'crit' : mission.kind === 'ticket' ? 'think' : mission.kind === 'review' ? 'ok' : 'info'}>
              {{
                incident: 'Incident response',
                sdlc: 'Software delivery',
                ticket: 'Ticket resolution',
                review: 'Pull request review',
              }[mission.kind]}
            </Badge>
            {mission.sourceRef && (
              <Badge tone="neutral">
                <span className="font-mono">{mission.sourceRef}</span>
              </Badge>
            )}
            <Badge tone={mission.status === 'failed' ? 'crit' : mission.status === 'succeeded' ? 'ok' : 'warn'}>
              {statusLabel(mission.status)}
            </Badge>
            <span>Started {relTime(mission.createdAt)}</span>
            <MissionRef id={mission.id} />
          </div>
        </div>
        {isLive && (
          <Button variant="danger" onClick={() => void api.cancelMission(id).then(load)}>
            Cancel mission
          </Button>
        )}
      </header>

      {/* One slim strip: five boxed metrics ate a third of the screen that the
          flow and graph needed more. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border border-ink-700 bg-ink-900 px-3.5 py-2 text-[12px]">
        <Stat label="agents" value={agents.length} extra={`${agents.filter((a) => a.status === 'running').length} working`} />
        <Stat label="turns" value={mission.numTurns || '—'} />
        <Stat
          label="duration"
          value={
            mission.durationMs
              ? fmtDuration(mission.durationMs)
              : <Elapsed startedAt={mission.startedAt ?? mission.createdAt} finishedAt={mission.finishedAt} />
          }
        />
        <Stat label="tokens" value={`${((mission.inputTokens + mission.outputTokens) / 1000).toFixed(1)}k`} />
        <Stat label="cost" value={fmtCost(mission.costUsd)} />
      </div>

      {pending.length > 0 && (
        <div className="shrink-0 space-y-2">
          {pending.map((a) => (
            <ApprovalCard key={a.id} approval={a} onDecided={load} />
          ))}
        </div>
      )}

      <SplitPane
        id="mission"
        className="min-h-[26rem] flex-1 shrink-0"
        initial={340}
        min={280}
        max={700}
        left={
        <Panel
          className="min-h-0 flex-1"
          title={
            <div className="flex items-center gap-1">
              {(['flow', 'graph', 'activity'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded px-2 py-0.5 text-[12px] font-semibold uppercase tracking-wide transition-colors ${
                    view === v ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-200'
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
                Show reasoning
              </label>
            ) : (
              <span className="text-[11px] text-ink-500">
                {view === 'graph' ? 'Click any node for its brief and its output' : 'Click a step to see that stage'}
              </span>
            )
          }
        >
          {view === 'flow' && (
            <MissionFlow
              agents={agents}
              events={events}
              missionKind={mission.kind}
              missionStatus={mission.status}
              missionInput={mission.input}
              missionSummary={mission.summary}
            />
          )}
          {view === 'graph' && (
            <MissionGraph
              agents={agents}
              events={events}
              missionKind={mission.kind}
              missionStatus={mission.status}
              missionInput={mission.input}
              missionSummary={mission.summary}
            />
          )}
          {view === 'activity' && <ActivityFeed events={visibleEvents} live={isLive} />}
        </Panel>
        }
        right={
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <Panel title={`Fleet (${agents.length})`} dense className="shrink-0">
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
                      <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-ink-400">
                        <Elapsed startedAt={a.startedAt} finishedAt={a.finishedAt} />
                      </span>
                    </div>
                    {a.task && (
                      <div className="mt-0.5 line-clamp-2 pl-4 text-[11px] leading-snug text-ink-400">
                        {a.task}
                      </div>
                    )}
                    <div className="pl-4 text-[10px] text-ink-600">
                      {a.status === 'running' ? 'Working now' : relTime(a.finishedAt ?? a.startedAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {artifacts.length > 0 && (
            <Panel title={`Produced (${artifacts.length})`} dense className="shrink-0">
              <ul className="divide-y divide-ink-800">
                {artifacts.map((a) => (
                  <li key={a.id} className="px-3 py-2">
                    <Badge tone={a.kind === 'pull_request' ? 'ok' : 'info'}>
                      {a.kind.replace('_', ' ')}
                    </Badge>
                    <div className="mt-1 text-[12px] text-ink-100">{a.title}</div>
                    {a.url && (
                      <a href={a.url} target="_blank" rel="noreferrer" className="block truncate text-[11px] text-signal-300 hover:underline">
                        {a.url}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
        }
      />

      {/* Bounded on purpose. The page is a fixed-height flex column, so an
          unbounded summary - and they run to a screenful - pushed past the
          bottom and the panels above it drew over it. */}
      {mission.summary && (
        <Panel title="Mission outcome" className="max-h-[22rem] shrink-0 overflow-y-auto">
          <Markdown className="text-[13px]">{mission.summary}</Markdown>
        </Panel>
      )}

      {mission.error && (
        <Panel title="Failure" className="max-h-56 shrink-0 overflow-y-auto">
          <div className="whitespace-pre-wrap text-[13px] text-crit-400">{mission.error}</div>
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

/**
 * Consecutive events of the same kind from the same actor collapse into one
 * row. A specialist making twenty telemetry queries is one thing that happened,
 * not twenty - and listing them individually buries the messages that matter
 * between them.
 */
interface Group {
  key: string;
  type: string;
  actor: string;
  items: MissionEvent[];
}

function groupEvents(events: MissionEvent[]): Group[] {
  const COLLAPSIBLE = new Set(['tool.called', 'tool.result', 'agent.thinking']);
  const out: Group[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && COLLAPSIBLE.has(e.type) && last.type === e.type && last.actor === e.actor) {
      last.items.push(e);
    } else {
      out.push({ key: `${e.id}`, type: e.type, actor: e.actor, items: [e] });
    }
  }
  return out;
}

function Stat({ label, value, extra }: { label: string; value: ReactNode; extra?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-ink-500">{label}</span>
      <span className="font-mono font-semibold tabular-nums text-ink-100">{value}</span>
      {extra && <span className="text-[10px] text-ink-500">{extra}</span>}
    </span>
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

  const groups = groupEvents(events);

  if (events.length === 0) {
    return <div className="p-4"><Empty>Waiting for the orchestrator…</Empty></div>;
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full divide-y divide-ink-800 overflow-y-auto"
      >
        {groups.map((g) => (
          <EventGroup key={g.key} group={g} />
        ))}
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

function EventGroup({ group }: { group: Group }) {
  const [open, setOpen] = useState(false);
  const style = EVENT_STYLE[group.type] ?? { tone: 'neutral' as Tone, label: group.type };
  const collapsed = group.items.length > 1 && !open;

  if (collapsed) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="slide-in flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-ink-850"
      >
        <Badge tone={style.tone}>{style.label}</Badge>
        <span className="font-mono text-[11px] text-ink-300">{group.actor}</span>
        <span className="text-[11px] text-ink-400">
          {group.items.length} in a row
        </span>
        <span className="ml-auto text-[11px] text-ink-500">
          {relTime(group.items[group.items.length - 1].createdAt)}
        </span>
        <span className="text-[10px] text-signal-300">expand</span>
      </button>
    );
  }

  return (
    <div className="slide-in">
      {group.items.length > 1 && (
        <button
          onClick={() => setOpen(false)}
          className="flex w-full items-center gap-2 px-3 pt-1.5 text-left text-[10px] text-signal-300 hover:underline"
        >
          collapse {group.items.length} {style.label} events
        </button>
      )}
      {group.items.map((e) => {
        const narrative = e.type === 'agent.message' || e.type === 'mission.finished';
        return (
          <div key={e.id} className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={style.tone}>{style.label}</Badge>
              <span className="font-mono text-[11px] text-ink-300">{e.actor}</span>
              <span className="ml-auto text-[11px] text-ink-500">{relTime(e.createdAt)}</span>
            </div>
            {e.text && (
              narrative ? (
                <Markdown className="mt-1 text-[13px]">{e.text}</Markdown>
              ) : (
                <div
                  className={
                    e.type === 'agent.thinking'
                      ? 'mt-1 line-clamp-6 whitespace-pre-wrap border-l-2 border-think-400/40 pl-2 text-[12px] italic leading-snug text-ink-400'
                      : 'mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-[12px] leading-snug text-ink-300'
                  }
                >
                  {e.text}
                </div>
              )
            )}
          </div>
        );
      })}
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
            <pre className="mt-1.5 max-h-64 overflow-auto rounded border border-ink-700 bg-ink-850 p-2.5 font-mono text-[11px] leading-relaxed text-ink-300">
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

/**
 * The mission id, as a reference you can copy rather than a bare token.
 *
 * It was printed as raw text in the middle of the metadata line, where it read
 * as debug output - but it is the thing people quote to each other, so it earns
 * a label and one-click copy instead of a careful double-click.
 */
function MissionRef({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure origin, or denied). The id is on screen.
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title="Copy mission reference"
      className="group inline-flex items-center gap-1.5 rounded-md border border-ink-700 bg-ink-900 px-2 py-0.5 transition-colors hover:border-ink-600"
    >
      <span className="text-[10px] uppercase tracking-wide text-ink-500">Ref</span>
      <span className="font-mono text-[11px] text-ink-300">{id}</span>
      <span className={`text-[10px] ${copied ? 'text-ok-400' : 'text-ink-600 group-hover:text-ink-400'}`}>
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  );
}
