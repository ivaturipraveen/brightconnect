import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Approval, type Artifact, type MissionEvent } from '../lib/api.ts';
import { useActivityStream } from '../lib/stream.ts';
import { Badge, Empty, Panel, relTime, type Tone } from '../components/ui.tsx';

export default function Governance() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [events, setEvents] = useState<MissionEvent[]>([]);

  const load = () => {
    void api.approvals().then(setApprovals).catch(() => {});
    void api.artifacts().then(setArtifacts).catch(() => {});
    void fetch('/api/events').then((r) => r.json()).then(setEvents).catch(() => {});
  };
  useEffect(load, []);
  useActivityStream({ onEvent: () => load(), onApproval: load });

  // The trail a customer audit actually cares about: decisions and outputs.
  const decisions = events.filter((e) =>
    ['approval.requested', 'approval.decided', 'artifact.created', 'mission.finished', 'error'].includes(e.type),
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-100">Governance</h1>
        <p className="mt-0.5 max-w-3xl text-[13px] text-ink-400">
          Every gated decision, every artifact, and every mission outcome — appended, never
          rewritten. This is the record that answers "what did the agents do, and who approved it".
        </p>
      </div>

      <Panel title={`Awaiting human decision (${approvals.length})`} dense>
        {approvals.length === 0 ? (
          <div className="p-4"><Empty>Nothing is waiting on a human right now.</Empty></div>
        ) : (
          <ul className="divide-y divide-ink-800">
            {approvals.map((a) => (
              <li key={a.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warn">pending</Badge>
                  <Link
                    to={`/missions/${a.missionId}`}
                    className="text-[13px] font-medium text-ink-100 hover:text-signal-300"
                  >
                    {a.summary}
                  </Link>
                  <span className="ml-auto text-[11px] text-ink-500">{relTime(a.createdAt)}</span>
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-ink-500">{a.toolName}</div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={`Artifacts (${artifacts.length})`} dense>
          {artifacts.length === 0 ? (
            <div className="p-4"><Empty>No pull requests or tickets yet.</Empty></div>
          ) : (
            <ul className="max-h-[55vh] divide-y divide-ink-800 overflow-y-auto">
              {artifacts.map((a) => (
                <li key={a.id} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={a.kind === 'pull_request' ? 'ok' : 'info'}>
                      {a.kind.replace('_', ' ')}
                    </Badge>
                    <Link
                      to={`/missions/${a.missionId}`}
                      className="text-[11px] text-ink-500 hover:text-signal-300"
                    >
                      mission {a.missionId}
                    </Link>
                    <span className="ml-auto text-[11px] text-ink-500">{relTime(a.createdAt)}</span>
                  </div>
                  <div className="mt-1 text-[13px] text-ink-100">{a.title}</div>
                  {a.url && (
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-[11px] text-signal-300 hover:underline"
                    >
                      {a.url}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Audit trail" dense>
          {decisions.length === 0 ? (
            <div className="p-4"><Empty>No recorded decisions yet.</Empty></div>
          ) : (
            <ul className="max-h-[55vh] divide-y divide-ink-800 overflow-y-auto">
              {decisions.slice().reverse().map((e) => {
                const tone: Tone =
                  e.type === 'error' ? 'crit'
                  : e.type === 'artifact.created' ? 'ok'
                  : e.type.startsWith('approval') ? 'warn'
                  : 'neutral';
                return (
                  <li key={e.id} className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={tone}>{e.type}</Badge>
                      <span className="font-mono text-[11px] text-ink-400">{e.actor}</span>
                      <Link
                        to={`/missions/${e.missionId}`}
                        className="text-[11px] text-ink-500 hover:text-signal-300"
                      >
                        {e.missionId}
                      </Link>
                      <span className="ml-auto text-[11px] text-ink-500">{relTime(e.createdAt)}</span>
                    </div>
                    {e.text && (
                      <div className="mt-1 line-clamp-2 text-[12px] leading-snug text-ink-300">
                        {e.text}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
