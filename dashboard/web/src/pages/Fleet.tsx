import { useEffect, useState } from 'react';
import { api, type FleetMember, type ModelSettings } from '../lib/api.ts';
import { Badge, Button, Empty, Panel } from '../components/ui.tsx';
import PromptEditor from '../components/AgentEditor.tsx';

/**
 * The fleet, and the controls to change it.
 *
 * The model is one setting for the whole platform rather than a dropdown beside
 * each of twenty names: they were always set to the same thing, and twenty
 * identical dropdowns turned a page about what the agents *do* into a page
 * about model selection.
 */

const DEPARTMENTS = [
  { id: 'sdlc', label: 'Software delivery', blurb: 'Specification through to a reviewable pull request.' },
  { id: 'sre', label: 'Site reliability', blurb: 'Alert through to verified remediation.' },
  { id: 'platform', label: 'Platform', blurb: 'Ticketing, release and cost.' },
] as const;

const ORCHESTRATOR = {
  name: 'Ada',
  title: 'Orchestrator',
  id: 'orchestrator',
  role: 'Reads the request, decides what kind of work it is, engages the specialists it needs, and holds them to the evidence.',
  tools: [
    'Agent', 'telemetry.query_alerts', 'telemetry.query_logs', 'telemetry.query_metrics',
    'changemgmt.recent_changes', 'runbook.execute_action', 'github.create_issue',
    'github.open_pull_request',
  ],
};

export default function Fleet() {
  const [fleet, setFleet] = useState<FleetMember[]>([]);
  const [models, setModels] = useState<ModelSettings | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = () => {
    void api.fleet().then(setFleet).catch(() => {});
    void api.modelSettings().then(setModels).catch(() => {});
  };
  useEffect(load, []);

  const flash = (text: string) => {
    setNote(text);
    setTimeout(() => setNote(null), 5000);
  };

  const changePlatformModel = async (model: string) => {
    setBusy(true);
    try {
      const res = await api.setPlatformModel(model);
      flash(`The fleet now runs on ${res.alias}. Applies to the next mission.`);
      load();
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const current = models?.choices.find((c) => c.id === models.model);

  return (
    <div className="h-full space-y-5 overflow-y-auto pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-ink-100">Agent fleet</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-ink-400">
            Twenty agents: one orchestrator that decides, and nineteen specialists that do the
            work. Each has its own instructions, its own tools, and a scope it cannot exceed.
            Open an agent to change what it does and what it can reach. Edits apply to the next
            mission — a running one keeps the definitions it started with.
          </p>
        </div>

        {/* One setting for the whole application, as a labelled control rather
            than three cards: it is chosen rarely and read often, so it should
            state what is running without taking a panel to do it. */}
        <div className="shrink-0 rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-2.5">
          <label
            htmlFor="platform-model"
            className="block text-[11px] font-medium uppercase tracking-wide text-ink-400"
          >
            Model
          </label>
          <select
            id="platform-model"
            value={models?.model ?? ''}
            disabled={!models || busy}
            onChange={(e) => void changePlatformModel(e.target.value)}
            className="mt-1 w-full min-w-[190px] rounded-md border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-[13px] font-medium text-ink-100 focus:border-signal-500 focus:outline-none disabled:opacity-50"
          >
            {!models && <option value="">Loading…</option>}
            {models?.choices.map((c) => (
              <option key={c.alias} value={c.id}>{c.label}</option>
            ))}
          </select>
          <p className="mt-1.5 max-w-[230px] text-[11px] leading-snug text-ink-500">
            {busy
              ? 'Saving…'
              : current
                ? current.hint
                : 'Runs the orchestrator and all nineteen specialists.'}
          </p>
        </div>
      </div>

      {note && (
        <div className="rounded-lg border border-ok-500/30 bg-ok-500/10 px-3 py-2 text-[12px] text-ok-400">
          {note}
        </div>
      )}

      {/* The orchestrator is not one of the fleet - it is what decides which of
          them to engage - but leaving it off the roster made the thing doing
          the deciding the one thing you could not see. */}
      <Panel
        title={
          <span className="flex items-baseline gap-2">
            Orchestration
            <span className="text-[11px] font-normal normal-case text-ink-400">
              Decides what the work is and who does it.
            </span>
          </span>
        }
        actions={<span className="text-[11px] text-ink-500">1 agent</span>}
        dense
      >
        <div className="flex flex-wrap items-start gap-3 border-l-2 border-signal-500 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-semibold text-ink-100">{ORCHESTRATOR.name}</span>
              <span className="text-[12px] text-ink-300">{ORCHESTRATOR.title}</span>
              <span className="font-mono text-[11px] text-ink-500">{ORCHESTRATOR.id}</span>
              <Badge tone="think">delegates to all 19</Badge>
            </div>
            <p className="mt-0.5 text-[12px] leading-snug text-ink-400">{ORCHESTRATOR.role}</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {ORCHESTRATOR.tools.map((t) => (
                <span key={t} className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-400">
                  {t}
                </span>
              ))}
              <span className="px-1 py-0.5 text-[10px] text-ink-500">+ the whole toolset</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
              The only agent that acts outside the platform: it files the tickets, opens the pull
              requests and runs remediation, so every external side effect has one accountable
              actor.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button onClick={() => setEditing('orchestrator')}>Edit</Button>
          </div>
        </div>
      </Panel>

      {DEPARTMENTS.map((dept) => {
        const members = fleet.filter((m) => m.department === dept.id);
        return (
          <Panel
            key={dept.id}
            title={
              <span className="flex items-baseline gap-2">
                {dept.label}
                <span className="text-[11px] font-normal normal-case text-ink-400">{dept.blurb}</span>
              </span>
            }
            actions={<span className="text-[11px] text-ink-500">{members.length} agents</span>}
            dense
          >
            {members.length === 0 ? (
              <div className="p-4"><Empty>Loading…</Empty></div>
            ) : (
              <ul className="divide-y divide-ink-800">
                {members.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-semibold text-ink-100">{m.name}</span>
                        <span className="text-[12px] text-ink-300">{m.title}</span>
                        <span className="font-mono text-[11px] text-ink-500">{m.id}</span>
                        {m.runs > 0 && (
                          <Badge tone={m.succeeded === m.runs ? 'ok' : 'warn'}>
                            {m.succeeded}/{m.runs} runs
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-[12px] leading-snug text-ink-400">{m.role}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {m.tools.length === 0 ? (
                          <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-500">
                            no tools — reasons from its brief
                          </span>
                        ) : (
                          <>
                            {m.tools.slice(0, 6).map((t) => (
                              <span key={t} className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-400">
                                {t.replace(/^mcp__/, '').replace(/__/g, '.')}
                              </span>
                            ))}
                            {m.tools.length > 6 && (
                              <span className="px-1 py-0.5 text-[10px] text-ink-500">
                                +{m.tools.length - 6} more
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Button onClick={() => setEditing(m.id)}>Edit</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        );
      })}

      <p className="text-[12px] text-ink-400">
        Definitions live in{' '}
        <code className="rounded bg-ink-800 px-1 font-mono text-[11px]">product/.claude/agents/</code>{' '}
        as Claude Code agent files, so the same fleet also loads from the Claude Code CLI.
      </p>

      {editing && (
        <PromptEditor agentId={editing} onClose={() => setEditing(null)} onSaved={load} />
      )}
    </div>
  );
}
