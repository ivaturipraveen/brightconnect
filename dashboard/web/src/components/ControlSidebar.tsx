import { Link } from 'react-router-dom';
import type { Overview } from '../lib/api.ts';
import { statusLabel } from './ui.tsx';

/**
 * The right-hand rail: what this session has done, who is working, and where
 * the things they build actually live.
 *
 * The fleet list is the point. "Seventeen agents" is a claim; seventeen rows
 * with roles, models and a live status is the evidence.
 */

const DEPARTMENTS = [
  { id: 'sdlc', label: 'Software delivery' },
  { id: 'sre', label: 'Site reliability' },
  { id: 'platform', label: 'Platform' },
] as const;

export default function ControlSidebar({ overview }: { overview: Overview | null }) {
  const s = overview?.session;

  return (
    <aside className="flex h-full flex-col gap-4 overflow-y-auto">
      <section className="shrink-0 rounded-xl border border-ink-700 bg-ink-900 p-3">
        <h2 className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12h4l3-8 4 16 3-8h4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Session
        </h2>
        {/* Five across, one row. Three-then-two left an orphaned pair and made
            the panel look like it had two unrelated sections. */}
        <div className="grid grid-cols-5 gap-1.5">
          <Stat label="Working" value={s?.agentsWorking ?? 0} highlight={(s?.agentsWorking ?? 0) > 0} />
          <Stat label="Missions" value={s?.totalMissions ?? 0} />
          <Stat label="Artifacts" value={s?.artifacts ?? 0} />
          <Stat label="Awaiting" value={s?.pendingApprovals ?? 0} highlight={(s?.pendingApprovals ?? 0) > 0} warn />
          <Stat label="Spend" value={`$${(s?.spendUsd ?? 0).toFixed(2)}`} />
        </div>
      </section>

      <section className="shrink-0 rounded-xl border border-think-400/40 bg-think-400/[0.07]">
        <h2 className="border-b border-think-400/25 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-think-400">
          Orchestrator
        </h2>
        <div className="flex items-start gap-2.5 px-3 py-2.5">
          <span
            className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${
              overview?.orchestrator.status === 'working'
                ? 'bg-think-400/25 text-think-400 pulse-ring'
                : 'bg-ink-800 text-ink-400'
            }`}
            aria-hidden
          >
            AD
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-semibold text-ink-100">
                {overview?.orchestrator.name ?? 'Ada'}
              </span>
              <span className="text-[10px] text-ink-400">
                {overview?.orchestrator.title ?? 'Orchestrator'}
              </span>
              <span className={`text-[9px] ${overview?.orchestrator.status === 'working' ? 'text-think-400' : 'text-ink-600'}`}>
                {statusLabel(overview?.orchestrator.status ?? 'idle')}
              </span>
            </div>
            <div className="text-[10px] leading-tight text-ink-500">
              {overview?.orchestrator.role ?? 'Decides what the work is and who should do it'}
            </div>
          </div>
        </div>
      </section>

      <section className="shrink-0 rounded-xl border border-ink-700 bg-ink-900">
        <h2 className="flex items-center gap-2 border-b border-ink-700 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Specialists
          <span className="ml-auto font-mono text-[10px] normal-case tracking-normal text-ink-500">
            {overview?.fleet.length ?? 0}
          </span>
        </h2>

        {DEPARTMENTS.map((dept) => {
          const members = overview?.fleet.filter((m) => m.department === dept.id) ?? [];
          if (members.length === 0) return null;
          return (
            <div key={dept.id}>
              <div className="bg-ink-850/60 px-3 py-1 text-[10px] uppercase tracking-wide text-ink-500">
                {dept.label}
              </div>
              <ul className="divide-y divide-ink-800/60">
                {members.map((m) => (
                  <li key={m.id} className="flex items-start gap-2.5 px-3 py-1.5">
                    <Avatar name={m.name} working={m.status === 'working'} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[12px] font-semibold text-ink-100">{m.name}</span>
                        <span className="truncate text-[10px] text-ink-400">{m.title}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-1 text-[9px] uppercase tracking-wide">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              m.status === 'working' ? 'bg-signal-400' : 'bg-ink-600'
                            }`}
                          />
                          {m.status === 'working' && m.missionId ? (
                            <Link to={`/missions/${m.missionId}`} className="text-signal-300 hover:underline">
                              working
                            </Link>
                          ) : (
                            <span className={m.status === 'working' ? 'text-signal-300' : 'text-ink-500'}>
                              {m.status}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="truncate text-[10px] leading-tight text-ink-500">{m.role}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      <section className="shrink-0 rounded-xl border border-ink-700 bg-ink-900">
        <h2 className="border-b border-ink-700 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Services
        </h2>
        <ul className="divide-y divide-ink-800">
          <ServiceLink href={overview?.services.product ?? '/app/'} label="Chat UI" hint="the product being maintained" external />
          <ServiceLink href={overview?.services.productApi ?? '/app/api/health'} label="Chat API" hint="health" external />
          <ServiceLink href={overview?.services.repo ?? '#'} label="Repository" hint="issues and pull requests" external />
        </ul>
      </section>
    </aside>
  );
}

function Stat({
  label, value, highlight, warn,
}: { label: string; value: number | string; highlight?: boolean; warn?: boolean }) {
  const lit = highlight && warn;
  return (
    <div
      className={`overflow-hidden rounded-lg border px-1.5 py-2 text-center ${
        lit ? 'border-warn-500/40 bg-warn-500/[0.07]' : 'border-ink-700 bg-ink-850'
      }`}
    >
      <div
        className={`truncate font-mono text-[15px] font-semibold leading-none tabular-nums ${
          lit ? 'text-warn-400' : highlight ? 'text-signal-400' : 'text-ink-100'
        }`}
      >
        {value}
      </div>
      <div className="mt-1.5 truncate text-[8.5px] uppercase tracking-wide text-ink-500">{label}</div>
    </div>
  );
}

/** Initial-letter avatar, so a long fleet list is scannable at a glance. */
function Avatar({ name, working }: { name: string; working: boolean }) {
  return (
    <span
      className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${
        working ? 'bg-signal-500/25 text-signal-300 pulse-ring' : 'bg-ink-800 text-ink-400'
      }`}
      aria-hidden
    >
      {name.split(' ').map((w) => w[0]).join('').slice(0, 2)}
    </span>
  );
}

function ServiceLink({
  href, label, hint, external,
}: { href: string; label: string; hint: string; external?: boolean }) {
  return (
    <li>
      <a
        href={href}
        {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
        className="flex items-center gap-2 px-3 py-2 hover:bg-ink-850"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-ok-500" aria-hidden />
        <span className="text-[12px] text-ink-200">{label}</span>
        <span className="ml-auto truncate text-[10px] text-ink-500">{hint}</span>
      </a>
    </li>
  );
}
