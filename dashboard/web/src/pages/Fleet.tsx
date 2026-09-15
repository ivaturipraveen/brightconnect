import { useEffect, useState } from 'react';
import { api, type FleetMember } from '../lib/api.ts';
import { Badge, Button, Empty, Panel } from '../components/ui.tsx';
import AgentEditor from '../components/AgentEditor.tsx';

/**
 * The fleet, and the controls to change it.
 *
 * Two levels of editing on purpose: the model is a dropdown, because swapping a
 * cheap agent for a capable one is the change people actually make and it
 * should not require opening a YAML file; everything else opens the definition,
 * because tools and instructions deserve to be read in full before they change.
 */

const DEPARTMENTS = [
  { id: 'sdlc', label: 'Software delivery', blurb: 'Specification through to a reviewable pull request.' },
  { id: 'sre', label: 'Site reliability', blurb: 'Alert through to verified remediation.' },
  { id: 'platform', label: 'Platform', blurb: 'Ticketing, release and cost.' },
] as const;

const MODELS = [
  { value: 'haiku', label: 'Haiku', hint: 'cheapest · retrieval, summarising' },
  { value: 'sonnet', label: 'Sonnet', hint: 'middle ground' },
  { value: 'opus', label: 'Opus', hint: 'hardest reasoning' },
] as const;

const shortModel = (m: string) => m.replace('claude-', '').replace(/-\d+(-\d+)?$/, '');

export default function Fleet() {
  const [fleet, setFleet] = useState<FleetMember[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = () => void api.fleet().then(setFleet).catch(() => {});
  useEffect(load, []);

  const changeModel = async (id: string, model: 'haiku' | 'sonnet' | 'opus') => {
    setBusy(id);
    setNote(null);
    try {
      await api.setAgentModel(id, model);
      setNote(`${id} now runs on ${model}. Applies to the next mission.`);
      load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setTimeout(() => setNote(null), 4000);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">Agent fleet</h1>
          <p className="mt-0.5 max-w-3xl text-[13px] text-ink-400">
            Each agent has its own instructions, its own tools, and a scope it cannot exceed.
            Change the model here; open an agent to change what it does and what it can reach.
            Edits apply to the next mission — a running one keeps the definitions it started with.
          </p>
        </div>
        {note && <Badge tone="ok">{note}</Badge>}
      </div>

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
                      <label className="sr-only" htmlFor={`model-${m.id}`}>Model for {m.name}</label>
                      <select
                        id={`model-${m.id}`}
                        value={MODELS.find((x) => shortModel(m.model).startsWith(x.value))?.value ?? 'haiku'}
                        disabled={busy === m.id}
                        onChange={(e) => void changeModel(m.id, e.target.value as 'haiku' | 'sonnet' | 'opus')}
                        className="rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-[12px] text-ink-200 focus:border-signal-500 focus:outline-none disabled:opacity-50"
                        title={MODELS.find((x) => shortModel(m.model).startsWith(x.value))?.hint}
                      >
                        {MODELS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
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
        <AgentEditor agentId={editing} onClose={() => setEditing(null)} onSaved={load} />
      )}
    </div>
  );
}
