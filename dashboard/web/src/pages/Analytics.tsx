import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Analytics as Data } from '../lib/api.ts';
import { Badge, Empty, Panel, fmtCost, fmtDuration, relTime } from '../components/ui.tsx';

/**
 * What the fleet has done, what it consumed, and what it cost.
 *
 * Every figure comes from the mission record, so the totals here and the number
 * on any individual mission always agree - a dashboard that disagrees with its
 * own detail pages stops being believed.
 */
export default function Analytics() {
  const [d, setD] = useState<Data | null>(null);

  useEffect(() => {
    const load = () => void api.analytics().then(setD).catch(() => {});
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, []);

  if (!d) return <Empty>Loading analytics…</Empty>;
  const t = d.totals;
  const totalTokens = t.inputTokens + t.outputTokens;

  return (
    <div className="h-full space-y-4 overflow-y-auto pb-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-100">Analytics</h1>
        <p className="mt-0.5 text-[13px] text-ink-400">
          Consumption and outcomes across every mission. Cost is what the model actually
          reported for each run, including the specialists a mission spawned.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Big label="Total spend" value={fmtCost(t.spendUsd)} hint={`${fmtCost(t.avgSpendUsd)} per mission`} />
        <Big label="Tokens" value={fmtTokens(totalTokens)} hint={`${fmtTokens(t.inputTokens)} in · ${fmtTokens(t.outputTokens)} out`} />
        <Big
          label="Prompt cache"
          value={`${t.cacheHitRate}%`}
          hint={`${fmtTokens(t.cacheReadTokens)} read · ${fmtTokens(t.cacheWriteTokens)} written`}
          tone={t.cacheHitRate >= 50 ? 'ok' : undefined}
        />
        <Big label="Missions" value={t.missions} hint={`${t.active} active · ${t.succeeded} succeeded`} />
        <Big
          label="Success rate"
          value={`${t.successRate}%`}
          hint={`${t.failed} failed · avg ${fmtDuration(t.avgDurationMs)}`}
          tone={t.successRate >= 80 ? 'ok' : t.successRate >= 50 ? 'warn' : 'crit'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Models in use" dense>
          <ul className="divide-y divide-ink-800">
            {d.models.inUse.map((m) => (
              <li key={m.model} className="flex items-center gap-3 px-4 py-2.5">
                <span className="font-mono text-[12.5px] text-ink-100">{m.model}</span>
                {m.model === d.models.platform && <Badge tone="think">platform model</Badge>}
                <span className="ml-auto text-[12px] text-ink-400">
                  {m.agents} agent{m.agents === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
          <p className="px-4 py-2.5 text-[11px] leading-relaxed text-ink-500">
            One model runs the orchestrator and all nineteen specialists. Change it on the
            Agent Fleet page; it applies to the whole application from the next mission.
          </p>
        </Panel>

        <Panel title="Where the work comes from" dense>
          {d.byTrigger.length === 0 ? (
            <div className="p-4"><Empty>Nothing yet.</Empty></div>
          ) : (
            <ul className="divide-y divide-ink-800">
              {d.byTrigger.map((x) => (
                <li key={x.trigger} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="text-[12.5px] text-ink-200">{TRIGGER[x.trigger] ?? x.trigger}</span>
                  <span className="ml-auto font-mono text-[12px] text-ink-300">{x.missions}</span>
                  <Bar value={x.missions} max={Math.max(...d.byTrigger.map((y) => y.missions))} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Spend by mission type" dense>
        {d.byKind.length === 0 ? (
          <div className="p-4"><Empty>No missions yet.</Empty></div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wide text-ink-400">
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-3 py-2 text-right font-medium">Missions</th>
                <th className="px-3 py-2 text-right font-medium">Tokens</th>
                <th className="px-4 py-2 text-right font-medium">Spend</th>
              </tr>
            </thead>
            <tbody>
              {d.byKind.map((k) => (
                <tr key={k.kind} className="border-b border-ink-800 last:border-0">
                  <td className="px-4 py-2.5"><Badge tone="info">{KIND[k.kind] ?? k.kind}</Badge></td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-300">{k.missions}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-300">{fmtTokens(k.tokens)}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-ink-100">{fmtCost(k.spendUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Agent utilisation" dense actions={<span className="text-[11px] text-ink-500">{t.agentRuns} runs across the fleet</span>}>
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-ink-900">
              <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wide text-ink-400">
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 text-right font-medium">Runs</th>
                <th className="px-4 py-2 text-right font-medium">Succeeded</th>
              </tr>
            </thead>
            <tbody>
              {d.agents.map((a) => (
                <tr key={a.id} className="border-b border-ink-800 last:border-0">
                  <td className="px-4 py-2">
                    <span className="text-[12.5px] font-medium text-ink-100">{a.name}</span>
                    <span className="ml-2 text-[11px] text-ink-400">{a.title}</span>
                    <span className="ml-2 font-mono text-[10px] text-ink-500">{a.id}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-300">
                    {a.runs || <span className="text-ink-600">—</span>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums text-ink-300">
                    {a.runs ? `${a.succeeded}/${a.runs}` : <span className="text-ink-600">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Recent missions" dense>
        {d.recent.length === 0 ? (
          <div className="p-4"><Empty>Nothing yet.</Empty></div>
        ) : (
          <ul className="divide-y divide-ink-800">
            {d.recent.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <Link to={`/missions/${m.id}`} className="min-w-0 flex-1 truncate text-[13px] text-ink-100 hover:text-signal-300">
                  {m.title}
                </Link>
                <Badge tone={m.status === 'succeeded' ? 'ok' : m.status === 'failed' ? 'crit' : 'info'}>
                  {m.status.replace('_', ' ')}
                </Badge>
                <span className="font-mono text-[11px] tabular-nums text-ink-400">{fmtTokens(m.tokens)}</span>
                <span className="font-mono text-[11px] tabular-nums text-ink-300">{fmtCost(m.spendUsd)}</span>
                <span className="text-[11px] text-ink-500">{relTime(m.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

const KIND: Record<string, string> = {
  sdlc: 'delivery', incident: 'incident', ticket: 'ticket', review: 'review',
};
const TRIGGER: Record<string, string> = {
  manual: 'Console',
  alert: 'Monitoring alert',
  github_webhook: 'GitHub webhook',
  github_poll: 'GitHub (polled)',
};

const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

function Big({
  label, value, hint, tone,
}: { label: string; value: string | number; hint?: string; tone?: 'ok' | 'warn' | 'crit' }) {
  const colour =
    tone === 'crit' ? 'text-crit-400' : tone === 'warn' ? 'text-warn-400' : tone === 'ok' ? 'text-ok-400' : 'text-ink-100';
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className={`mt-1 font-mono text-[26px] font-semibold leading-none tabular-nums ${colour}`}>
        {value}
      </div>
      {hint && <div className="mt-1.5 text-[11px] text-ink-500">{hint}</div>}
    </div>
  );
}

const Bar = ({ value, max }: { value: number; max: number }) => (
  <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-ink-800 sm:block" aria-hidden>
    <span
      className="block h-full rounded-full bg-signal-500"
      style={{ width: `${max ? (value / max) * 100 : 0}%` }}
    />
  </span>
);
