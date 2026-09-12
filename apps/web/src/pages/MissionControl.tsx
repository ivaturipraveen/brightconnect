import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Mission, type Template } from '../lib/api.ts';
import { useActivityStream } from '../lib/stream.ts';
import {
  Badge, Button, Empty, Panel, StatusDot, fmtCost, fmtDuration, relTime, type Tone,
} from '../components/ui.tsx';

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
  const [composerOpen, setComposerOpen] = useState(false);

  const load = () => void api.missions().then(setMissions).catch(() => {});

  useEffect(() => {
    load();
    void api.templates().then(setTemplates).catch(() => {});
  }, []);

  useActivityStream({ onMission: load, onEvent: (e) => { if (e.type === 'mission.created') load(); } });

  const active = missions.filter((m) =>
    ['running', 'queued', 'awaiting_approval'].includes(m.status),
  );
  const done = missions.filter((m) => !active.includes(m));

  return (
    <div className="space-y-5">
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

      <Panel title={`Active missions${active.length ? ` (${active.length})` : ''}`} dense>
        {active.length === 0 ? (
          <div className="p-4">
            <Empty>No missions running. Launch one above, or trigger an incident.</Empty>
          </div>
        ) : (
          <MissionTable missions={active} />
        )}
      </Panel>

      <Panel title="History" dense>
        {done.length === 0 ? (
          <div className="p-4"><Empty>Completed missions will appear here.</Empty></div>
        ) : (
          <MissionTable missions={done} />
        )}
      </Panel>
    </div>
  );
}

function MissionTable({ missions }: { missions: Mission[] }) {
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
                <Badge tone={m.kind === 'incident' ? 'crit' : 'info'}>
                  {m.kind === 'incident' ? 'incident' : 'delivery'}
                </Badge>
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
              <td className="px-4 py-2.5 text-right text-ink-400">{relTime(m.createdAt)}</td>
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
  const [kind, setKind] = useState<'sdlc' | 'incident'>('sdlc');
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
            onChange={(e) => setKind(e.target.value as 'sdlc' | 'incident')}
            className="rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-[13px] text-ink-100 focus:border-signal-500 focus:outline-none"
          >
            <option value="sdlc">Software delivery</option>
            <option value="incident">Incident response</option>
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
