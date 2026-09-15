import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Artifact, type InboundEvent, type Mission, type MissionEvent, type MissionKind, type Template } from '../lib/api.ts';
import { useActivityStream } from '../lib/stream.ts';
import {
  Badge, Button, Empty, Panel, StatusDot, fmtCost, fmtDuration, relTime, type Tone,
} from '../components/ui.tsx';

const KIND_LABEL: Record<MissionKind, string> = {
  sdlc: 'delivery',
  incident: 'incident',
  ticket: 'ticket',
  review: 'review',
};
const KIND_TONE: Record<MissionKind, Tone> = {
  sdlc: 'info',
  incident: 'crit',
  ticket: 'think',
  review: 'ok',
};
/** Where the work came from - a click, or the outside world. */
const TRIGGER_LABEL: Record<string, string> = {
  manual: 'launched by hand',
  alert: 'from an alert',
  github_webhook: 'GitHub webhook',
  github_poll: 'seen on GitHub',
};

const STATUS_TONE: Record<string, Tone> = {
  running: 'info',
  queued: 'neutral',
  awaiting_approval: 'warn',
  succeeded: 'ok',
  failed: 'crit',
  cancelled: 'neutral',
};

export default function MissionControl() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [inbound, setInbound] = useState<InboundEvent[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [trail, setTrail] = useState<MissionEvent[]>([]);
  const [tab, setTab] = useState<'missions' | 'artifacts' | 'audit'>('missions');
  const [composerOpen, setComposerOpen] = useState(false);

  const load = () => {
    void api.missions().then(setMissions).catch(() => {});
    void api.inboundEvents().then(setInbound).catch(() => {});
    void api.artifacts().then(setArtifacts).catch(() => {});
    void fetch('/api/events').then((r) => r.json()).then(setTrail).catch(() => {});
  };

  useEffect(() => {
    load();
    void api.templates().then(setTemplates).catch(() => {});
  }, []);

  useActivityStream({ onMission: load, onEvent: (e) => { if (e.type === 'mission.created') load(); } });

  /** Empty the board. Live missions are cancelled on the way out. */
  const clearAll = async () => {
    const live = missions.filter((m) =>
      ['queued', 'running', 'awaiting_approval'].includes(m.status),
    ).length;
    const warning = live
      ? `Delete all ${missions.length} missions? ${live} ${live === 1 ? 'is' : 'are'} still live and will be cancelled. This cannot be undone.`
      : `Delete all ${missions.length} missions and their trails? This cannot be undone.`;
    if (!window.confirm(warning)) return;
    await api.deleteAllMissions().catch(() => {});
    load();
  };

  const active = missions.filter((m) =>
    ['running', 'queued', 'awaiting_approval'].includes(m.status),
  );
  const done = missions.filter((m) => !active.includes(m));

  return (
    <div className="h-full space-y-5 overflow-y-auto pb-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">Mission Control</h1>
          <p className="mt-0.5 text-[13px] text-ink-400">
            Hand the fleet a specification or an incident. It plans the work, delegates to
            specialists, and comes back to you for the decisions that matter.
          </p>
        </div>
        <Button variant="primary" onClick={() => setComposerOpen((v) => !v)}>
          {composerOpen ? 'Close' : '+ New mission'}
        </Button>
      </div>

      {composerOpen && (
        <Composer
          templates={templates}
          onLaunched={() => { setComposerOpen(false); load(); }}
        />
      )}

      <Intake events={inbound} onChanged={load} />

      <Panel
        title={
          <div className="flex items-center gap-1">
            {([
              ['missions', `Missions${active.length ? ` (${active.length})` : ''}`],
              ['artifacts', `Artifacts${artifacts.length ? ` (${artifacts.length})` : ''}`],
              ['audit', 'Audit trail'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`rounded px-2 py-0.5 text-[12px] font-semibold uppercase tracking-wide transition-colors ${
                  tab === id ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        }
        dense
        actions={
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-ink-500">
              {tab === 'audit'
                ? 'every gated decision and outcome, appended not rewritten'
                : tab === 'artifacts'
                  ? 'what the fleet produced'
                  : ''}
            </span>
            {tab === 'missions' && missions.length > 0 && (
              <button
                type="button"
                onClick={() => void clearAll()}
                className="rounded px-2 py-0.5 text-[11px] text-ink-500 transition-colors hover:bg-crit-500/10 hover:text-crit-400"
              >
                Clear all
              </button>
            )}
          </div>
        }
      >
        {tab === 'missions' && (
          <>
            {active.length > 0 && <MissionTable missions={active} onDeleted={load} />}
            {done.length > 0 && (
              <>
                {active.length > 0 && (
                  <div className="border-t border-ink-800 bg-ink-850/60 px-4 py-1 text-[10px] uppercase tracking-wide text-ink-500">
                    Finished
                  </div>
                )}
                <MissionTable missions={done} onDeleted={load} />
              </>
            )}
            {missions.length === 0 && (
              <div className="p-4">
                <Empty>Nothing yet. Describe a task in the Console, or file a ticket on GitHub.</Empty>
              </div>
            )}
          </>
        )}

        {tab === 'artifacts' && (
          artifacts.length === 0 ? (
            <div className="p-4"><Empty>No pull requests or tickets yet.</Empty></div>
          ) : (
            <ul className="divide-y divide-ink-800">
              {artifacts.map((a) => (
                <li key={a.id} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={a.kind === 'pull_request' ? 'ok' : 'info'}>
                      {a.kind.replace('_', ' ')}
                    </Badge>
                    <span className="text-[13px] text-ink-100">{a.title}</span>
                    <Link to={`/missions/${a.missionId}`} className="text-[11px] text-ink-500 hover:text-signal-300">
                      mission {a.missionId}
                    </Link>
                    <span className="ml-auto text-[11px] text-ink-500">{relTime(a.createdAt)}</span>
                  </div>
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noreferrer" className="truncate text-[11px] text-signal-300 hover:underline">
                      {a.url}
                    </a>
                  ) : (
                    <span className="text-[11px] text-ink-500">recorded locally — no GitHub token</span>
                  )}
                </li>
              ))}
            </ul>
          )
        )}

        {tab === 'audit' && (
          (() => {
            const decisions = trail.filter((e) =>
              ['approval.requested', 'approval.decided', 'artifact.created', 'mission.finished', 'error'].includes(e.type),
            );
            return decisions.length === 0 ? (
              <div className="p-4"><Empty>No recorded decisions yet.</Empty></div>
            ) : (
              <ul className="max-h-[60vh] divide-y divide-ink-800 overflow-y-auto">
                {decisions.slice().reverse().map((e) => (
                  <li key={e.id} className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={e.type === 'error' ? 'crit' : e.type === 'artifact.created' ? 'ok' : e.type.startsWith('approval') ? 'warn' : 'neutral'}>
                        {e.type}
                      </Badge>
                      <span className="font-mono text-[11px] text-ink-400">{e.actor}</span>
                      <Link to={`/missions/${e.missionId}`} className="text-[11px] text-ink-500 hover:text-signal-300">
                        {e.missionId}
                      </Link>
                      <span className="ml-auto text-[11px] text-ink-500">{relTime(e.createdAt)}</span>
                    </div>
                    {e.text && <div className="mt-1 line-clamp-2 text-[12px] leading-snug text-ink-300">{e.text}</div>}
                  </li>
                ))}
              </ul>
            );
          })()
        )}
      </Panel>
    </div>
  );
}

/**
 * Work arriving from GitHub.
 *
 * The point of this panel is that most rows should not say "launched by hand" -
 * an agentic platform where a human starts every task is just a chatbot with
 * extra steps.
 */
function Intake({ events, onChanged }: { events: InboundEvent[]; onChanged: () => void }) {
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setNote(null);
    try {
      const r = await api.pollNow();
      setNote(
        r.dispatched > 0
          ? `Picked up ${r.dispatched} new item${r.dispatched === 1 ? '' : 's'}.`
          : r.checked > 0
            ? `${r.checked} open item${r.checked === 1 ? '' : 's'}, all already handled.`
            : 'Nothing new on GitHub.',
      );
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const STATUS: Record<string, Tone> = {
    dispatched: 'ok',
    received: 'info',
    ignored: 'neutral',
    duplicate: 'neutral',
  };

  return (
    <Panel
      title="Intake — work arriving from GitHub"
      dense
      actions={
        <div className="flex items-center gap-2">
          {note && <span className="text-[11px] text-ink-400">{note}</span>}
          <Button onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check GitHub now'}
          </Button>
        </div>
      }
    >
      {events.length === 0 ? (
        <div className="p-4">
          <Empty>
            Nothing has arrived yet. Issues labelled for the fleet, and new pull requests,
            start missions on their own.
          </Empty>
        </div>
      ) : (
        <ul className="max-h-64 divide-y divide-ink-800 overflow-y-auto">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
              <Badge tone={STATUS[e.status] ?? 'neutral'}>{e.status}</Badge>
              <span className="font-mono text-[11px] text-ink-400">{e.sourceRef}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink-100">{e.title}</span>
              {e.missionId && (
                <Link
                  to={`/missions/${e.missionId}`}
                  className="text-[11px] text-signal-300 hover:underline"
                >
                  mission →
                </Link>
              )}
              <span className="text-[11px] text-ink-500">{relTime(e.receivedAt)}</span>
              {e.note && (
                <div className="w-full pl-1 text-[11px] text-ink-500">{e.note}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function MissionTable({ missions, onDeleted }: { missions: Mission[]; onDeleted: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const remove = async (m: Mission) => {
    const live = ['queued', 'running', 'awaiting_approval'].includes(m.status);
    const warning = live
      ? `"${m.title}" is still live. Deleting it cancels the run and removes its trail. Continue?`
      : `Delete "${m.title}" and its full trail? This cannot be undone.`;
    if (!window.confirm(warning)) return;
    setBusy(m.id);
    try {
      await api.deleteMission(m.id);
      onDeleted();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-[13px]">
        <thead>
          <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wide text-ink-400">
            <th className="px-4 py-2 font-medium">Mission</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Turns</th>
            <th className="px-3 py-2 text-right font-medium">Duration</th>
            <th className="px-3 py-2 text-right font-medium">Cost</th>
            <th className="px-4 py-2 text-right font-medium">Started</th>
            <th className="w-10 px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {missions.map((m) => (
            <tr key={m.id} className="border-b border-ink-800 last:border-0 hover:bg-ink-850/60">
              <td className="px-4 py-2.5">
                <Link to={`/missions/${m.id}`} className="group flex items-center gap-2">
                  <StatusDot status={m.status} />
                  <span className="font-medium text-ink-100 group-hover:text-signal-300">
                    {m.title}
                  </span>
                </Link>
              </td>
              <td className="px-3 py-2.5">
                <Badge tone={KIND_TONE[m.kind]}>{KIND_LABEL[m.kind]}</Badge>
                {m.sourceRef && (
                  <div className="mt-0.5 font-mono text-[10px] text-ink-500">{m.sourceRef}</div>
                )}
              </td>
              <td className="px-3 py-2.5">
                <Badge tone={STATUS_TONE[m.status] ?? 'neutral'}>
                  {m.status.replace('_', ' ')}
                </Badge>
              </td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-300">
                {m.numTurns || '-'}
              </td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-300">
                {fmtDuration(m.durationMs)}
              </td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-300">
                {fmtCost(m.costUsd)}
              </td>
              <td className="px-4 py-2.5 text-right text-ink-400">
                {relTime(m.createdAt)}
                <div className="text-[10px] text-ink-500">
                  {TRIGGER_LABEL[m.trigger] ?? m.trigger}
                </div>
              </td>
              <td className="px-2 py-2.5 text-right">
                <button
                  type="button"
                  aria-label={`Delete ${m.title}`}
                  title="Delete this mission and its trail"
                  disabled={busy === m.id}
                  onClick={() => void remove(m)}
                  className="rounded p-1 text-ink-600 transition-colors hover:bg-crit-500/10 hover:text-crit-400 disabled:opacity-40"
                >
                  <TrashIcon />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Composer({
  templates, onLaunched,
}: { templates: Template[]; onLaunched: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [kind, setKind] = useState<MissionKind>('sdlc');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyTemplate = (t: Template) => {
    setTitle(t.title.replace(/\s*\((PRD|tech spec|ARD)\)$/i, ''));
    setInput(t.input);
    setKind(t.kind);
  };

  const launch = async () => {
    if (!title.trim() || !input.trim()) {
      setError('Give the mission a title and a specification.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const mission = await api.createMission({ kind, title: title.trim(), input: input.trim() });
      onLaunched();
      navigate(`/missions/${mission.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Panel title="New mission">
      <div className="space-y-3">
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-400">
            Start from a template
          </div>
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => applyTemplate(t)}
                className="max-w-xs rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-left transition-colors hover:border-signal-500/50 hover:bg-ink-800"
              >
                <div className="text-[13px] font-medium text-ink-100">{t.title}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-ink-400">{t.blurb}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Mission title"
            className="w-full rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-[13px] text-ink-100 placeholder:text-ink-500 focus:border-signal-500 focus:outline-none"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as MissionKind)}
            className="rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-[13px] text-ink-100 focus:border-signal-500 focus:outline-none"
          >
            <option value="sdlc">Software delivery</option>
            <option value="incident">Incident response</option>
            <option value="ticket">Resolve a ticket</option>
            <option value="review">Review a pull request</option>
          </select>
        </div>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={12}
          placeholder="Paste a PRD, ARD, or technical specification. The fleet works from the same material your engineers would."
          className="w-full resize-y rounded-md border border-ink-600 bg-ink-850 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-100 placeholder:text-ink-500 focus:border-signal-500 focus:outline-none"
        />

        {error && <div className="text-[13px] text-crit-400">{error}</div>}

        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-400">
            The orchestrator plans the work and engages specialists. You decide on the pull request.
          </span>
          <Button variant="primary" onClick={launch} disabled={busy}>
            {busy ? 'Launching…' : 'Launch mission'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** Trash glyph. Inline so the page carries no icon dependency. */
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
