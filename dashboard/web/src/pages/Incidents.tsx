import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Alert } from '../lib/api.ts';
import { useActivityStream } from '../lib/stream.ts';
import { Badge, Button, Empty, Panel, StatusDot, relTime, type Tone } from '../components/ui.tsx';

const SEVERITY_TONE: Record<string, Tone> = { critical: 'crit', warning: 'warn', info: 'info' };

export default function Incidents() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = () => void api.alerts().then(setAlerts).catch(() => {});
  useEffect(load, []);
  useActivityStream({ onEvent: (e) => { if (e.type === 'mission.finished') load(); } });

  const trigger = async (alert: Alert) => {
    setBusy(alert.id);
    try {
      const mission = await api.triggerAlert(alert.id);
      navigate(`/missions/${mission.id}`);
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    await api.resetSim();
    load();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">Incidents</h1>
          <p className="mt-0.5 max-w-3xl text-[13px] text-ink-400">
            Live alerts from the orders platform. Dispatching one starts an incident mission: the
            fleet investigates logs, configuration, and recent changes in parallel, establishes
            root cause, files the ticket, and proposes remediation for your approval.
          </p>
        </div>
        <Button onClick={reset} title="Return the simulated environment to its pre-incident state">
          Reset environment
        </Button>
      </div>

      <Panel title="Alerts" dense>
        {alerts.length === 0 ? (
          <div className="p-4"><Empty>No alerts firing.</Empty></div>
        ) : (
          <ul className="divide-y divide-ink-800">
            {alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusDot status={a.status} />
                    <Badge tone={SEVERITY_TONE[a.severity] ?? 'neutral'}>{a.severity}</Badge>
                    <span className="text-[14px] font-medium text-ink-100">{a.title}</span>
                    <span className="font-mono text-[11px] text-ink-500">{a.id}</span>
                  </div>
                  <p className="mt-1 text-[12px] leading-snug text-ink-400">{a.description}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-ink-500">
                    <span>service={a.service}</span>
                    {a.metric && (
                      <span className="text-ink-300">
                        {a.metric}: <span className="text-crit-400">{a.value}</span> (threshold {a.threshold})
                      </span>
                    )}
                    <span>fired {relTime(a.firedAt)}</span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px] text-ink-600">{a.resource}</div>
                </div>
                <Button
                  variant="primary"
                  disabled={busy === a.id || a.status === 'resolved'}
                  onClick={() => trigger(a)}
                >
                  {busy === a.id ? 'Dispatching…' : 'Dispatch fleet'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
