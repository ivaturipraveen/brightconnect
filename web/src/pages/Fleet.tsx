import { useEffect, useState } from 'react';
import { api, type FleetMember } from '../lib/api.ts';
import { Badge, Empty, Panel } from '../components/ui.tsx';
import AgentEditor from '../components/AgentEditor.tsx';

const DEPARTMENTS = [
  { id: 'sdlc', label: 'Software delivery', blurb: 'Specification through to a reviewable pull request.' },
  { id: 'sre', label: 'Site reliability', blurb: 'Alert through to verified remediation.' },
  { id: 'platform', label: 'Platform', blurb: 'Ticketing, release, and cost.' },
] as const;

export default function Fleet() {
  const [fleet, setFleet] = useState<FleetMember[]>([]);
  const [editing, setEditing] = useState<string | null>(null);

  const load = () => void api.fleet().then(setFleet).catch(() => {});
  useEffect(load, []);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-100">Agent Fleet</h1>
        <p className="mt-0.5 max-w-3xl text-[13px] text-ink-400">
          Each agent is a specialist with its own instructions, its own tools, and a scope it
          cannot exceed. The orchestrator engages whichever the mission needs — adding a
          capability means adding an agent, not rebuilding the platform.
        </p>
        <p className="mt-1.5 max-w-3xl text-[13px] text-ink-400">
          Definitions live in <code className="rounded bg-ink-800 px-1 font-mono text-[12px]">.claude/agents/</code>{' '}
          as Claude Code agent files. <span className="text-ink-200">Click any agent to edit its prompt,
          tools, or model</span> — changes apply to the next mission, no restart.
        </p>
      </div>

      {DEPARTMENTS.map((dept) => {
        const members = fleet.filter((m) => m.department === dept.id);
        return (
          <Panel
            key={dept.id}
            title={
              <span className="flex items-baseline gap-2">
                {dept.label}
                <span className="text-[11px] font-normal normal-case text-ink-400">
                  {dept.blurb}
                </span>
              </span>
            }
          >
            {members.length === 0 ? (
              <Empty>Loading…</Empty>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {members.map((m) => (
                  <article
                    key={m.id}
                    onClick={() => setEditing(m.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setEditing(m.id); }}
                    className="flex cursor-pointer flex-col rounded-lg border border-ink-700 bg-ink-850 p-3 transition-colors hover:border-signal-500/50 hover:bg-ink-800"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-[14px] font-semibold text-ink-100">{m.name}</h3>
                        <div className="font-mono text-[11px] text-ink-500">{m.id}</div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {m.runs > 0 && (
                          <Badge tone={m.succeeded === m.runs ? 'ok' : 'warn'}>
                            {m.succeeded}/{m.runs}
                          </Badge>
                        )}
                        <span className="font-mono text-[10px] text-ink-500">
                          {m.model.replace('claude-', '').replace(/-\d+$/, '')}
                        </span>
                      </div>
                    </div>
                    <p className="mt-2 flex-1 text-[12px] leading-snug text-ink-300">{m.role}</p>
                    <div className="mt-2.5 flex flex-wrap gap-1">
                      {m.tools.slice(0, 5).map((t) => (
                        <span
                          key={t}
                          className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-400"
                        >
                          {t.replace(/^mcp__/, '').replace(/__/g, '.')}
                        </span>
                      ))}
                      {m.tools.length > 5 && (
                        <span className="px-1 py-0.5 text-[10px] text-ink-500">
                          +{m.tools.length - 5}
                        </span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        );
      })}

      {editing && (
        <AgentEditor
          agentId={editing}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
