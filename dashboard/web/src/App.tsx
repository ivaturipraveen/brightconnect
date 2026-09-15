import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, type AppConfig, type Approval } from './lib/api.ts';
import { useActivityStream } from './lib/stream.ts';
import { useTheme } from './lib/theme.ts';
import { Badge } from './components/ui.tsx';
import Analytics from './pages/Analytics.tsx';
import Repository from './pages/Repository.tsx';
import Console from './pages/Console.tsx';
import MissionControl from './pages/MissionControl.tsx';
import MissionDetail from './pages/MissionDetail.tsx';
import Fleet from './pages/Fleet.tsx';
import Incidents from './pages/Incidents.tsx';

const NAV = [
  { to: '/console', label: 'Console' },
  { to: '/missions', label: 'Mission Control' },
  { to: '/incidents', label: 'Incidents' },
  { to: '/fleet', label: 'Agent Fleet' },
  { to: '/repository', label: 'Repository' },
  { to: '/analytics', label: 'Analytics' },
];

export default function App() {
  const [theme, setTheme] = useTheme();
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
    <div className="flex h-screen flex-col overflow-hidden bg-ink-950">
      <header className="sticky top-0 z-30 border-b border-ink-700 bg-ink-900">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <Logo />
            <div className="leading-tight">
              <div className="text-[15px] font-semibold text-ink-100">
                {config?.productName ?? 'Bright Connect'}
              </div>
              <div className="text-[11px] text-ink-400">
                AI engineering workforce
                {config?.customerName ? ` · ${config.customerName}` : ''}
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
                      ? 'bg-ink-800 text-ink-100'
                      : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                  }`
                }
              >
                {item.label}
                {item.to === '/missions' && pending.length > 0 && (
                  <span className="ml-1.5 rounded bg-warn-500/20 px-1.5 py-0.5 text-[11px] font-semibold text-warn-400">
                    {pending.length}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              className="grid h-7 w-7 place-items-center rounded-md border border-ink-600 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-200"
            >
              {theme === 'dark' ? (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            {config && <ReadinessPills config={config} connected={connected} />}
          </div>
        </div>
      </header>

      {config && !config.readiness.anthropic && <SetupBanner />}

      <main className="mx-auto w-full max-w-[1600px] flex-1 overflow-hidden px-4 py-4 sm:px-6">
        <Routes>
          <Route path="/" element={<Navigate to="/console" replace />} />
          <Route path="/console" element={<Console />} />
          <Route path="/missions" element={<MissionControl />} />
          <Route path="/missions/:id" element={<MissionDetail />} />
          <Route path="/incidents" element={<Incidents />} />
          <Route path="/fleet" element={<Fleet />} />
          <Route path="/repository" element={<Repository />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="*" element={<Navigate to="/console" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Logo() {
  return (
    <img
      src="/brightcone-logo.webp"
      alt=""
      className="h-8 w-8 shrink-0 object-contain"
      aria-hidden
    />
  );
}

/**
 * One status, not three. "agents ready" and "live" were the same fact stated
 * twice, and the repository is already linked in the sidebar under Services.
 */
function ReadinessPills({ config, connected }: { config: AppConfig; connected: boolean }) {
  const ready = config.readiness.anthropic && connected;
  const label = !config.readiness.anthropic
    ? 'no API key'
    : !connected
      ? 'reconnecting'
      : config.readiness.github
        ? 'ready'
        : 'ready · github local';

  return (
    <Badge tone={ready ? 'ok' : config.readiness.anthropic ? 'warn' : 'crit'}>
      <span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-ok-400' : 'bg-warn-400'}`} />
      {label}
    </Badge>
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
