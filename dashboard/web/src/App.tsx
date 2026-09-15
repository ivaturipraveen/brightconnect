import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, type AppConfig, type Approval } from './lib/api.ts';
import { useActivityStream } from './lib/stream.ts';
import { Badge } from './components/ui.tsx';
import Console from './pages/Console.tsx';
import MissionControl from './pages/MissionControl.tsx';
import MissionDetail from './pages/MissionDetail.tsx';
import Fleet from './pages/Fleet.tsx';
import Incidents from './pages/Incidents.tsx';
import Governance from './pages/Governance.tsx';

const NAV = [
  { to: '/console', label: 'Console' },
  { to: '/missions', label: 'Mission Control' },
  { to: '/incidents', label: 'Incidents' },
  { to: '/fleet', label: 'Agent Fleet' },
  { to: '/governance', label: 'Governance' },
];

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [pending, setPending] = useState<Approval[]>([]);

  useEffect(() => {
    void api.config().then(setConfig).catch(() => {});
    void api.approvals().then(setPending).catch(() => {});
  }, []);

  // The approval count in the nav has to be live - it is the thing a human is
  // waiting to act on.
  const { connected } = useActivityStream({
    onApproval: () => void api.approvals().then(setPending).catch(() => {}),
    onEvent: (e) => {
      if (e.type === 'approval.decided' || e.type === 'approval.requested') {
        void api.approvals().then(setPending).catch(() => {});
      }
    },
  });

  return (
    <div className="flex min-h-screen flex-col bg-ink-950">
      <header className="sticky top-0 z-30 border-b border-ink-700 bg-ink-900/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <Logo />
            <div className="leading-tight">
              <div className="text-[15px] font-semibold text-ink-100">
                {config?.productName ?? 'Bright Connect'}
              </div>
              <div className="text-[11px] text-ink-400">
                AI engineering workforce
                {config?.customerName ? ` · ${config.customerName} OMS` : ''}
              </div>
            </div>
          </div>

          <nav className="flex flex-1 flex-wrap items-center gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    isActive
                      ? 'bg-ink-700 text-ink-100'
                      : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                  }`
                }
              >
                {item.label}
                {item.to === '/governance' && pending.length > 0 && (
                  <span className="ml-1.5 rounded bg-warn-500/20 px-1.5 py-0.5 text-[11px] font-semibold text-warn-400">
                    {pending.length}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            {config && <ReadinessPills config={config} />}
            <Badge tone={connected ? 'ok' : 'crit'}>
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-ok-400' : 'bg-crit-400'}`} />
              {connected ? 'live' : 'offline'}
            </Badge>
          </div>
        </div>
      </header>

      {config && !config.readiness.anthropic && <SetupBanner />}

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5 sm:px-6">
        <Routes>
          <Route path="/" element={<Navigate to="/console" replace />} />
          <Route path="/console" element={<Console />} />
          <Route path="/missions" element={<MissionControl />} />
          <Route path="/missions/:id" element={<MissionDetail />} />
          <Route path="/incidents" element={<Incidents />} />
          <Route path="/fleet" element={<Fleet />} />
          <Route path="/governance" element={<Governance />} />
          <Route path="*" element={<Navigate to="/console" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Logo() {
  return (
    <div className="grid h-8 w-8 place-items-center rounded-md bg-gradient-to-br from-signal-500 to-think-400">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
        <path d="M12 3v6m0 6v6M3 12h6m6 0h6" stroke="white" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="12" r="2.5" fill="white" />
      </svg>
    </div>
  );
}

function ReadinessPills({ config }: { config: AppConfig }) {
  return (
    <div className="hidden items-center gap-1.5 lg:flex">
      <Badge tone={config.readiness.anthropic ? 'ok' : 'crit'}>
        {config.readiness.anthropic ? 'agents ready' : 'no API key'}
      </Badge>
      <Badge tone={config.readiness.github ? 'ok' : 'warn'}>
        {config.readiness.github ? config.repo : 'github: local mode'}
      </Badge>
    </div>
  );
}

function SetupBanner() {
  return (
    <div className="border-b border-crit-500/30 bg-crit-500/10 px-4 py-2 text-[13px] text-crit-400 sm:px-6">
      <span className="font-semibold">ANTHROPIC_API_KEY is not set.</span>{' '}
      The console works, but missions will not run. Add the key to{' '}
      <code className="rounded bg-ink-800 px-1 py-0.5 font-mono text-[12px]">.env</code> and restart
      the API.
    </div>
  );
}
