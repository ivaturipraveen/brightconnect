/** Typed client for the Brightworks API. */

export interface AppConfig {
  productName: string;
  customerName: string;
  repo: string;
  models: { orchestrator: string; agent: string };
  maxMissionCostUsd: number;
  readiness: { anthropic: boolean; github: boolean };
  fleetSize: number;
}

export type MissionStatus =
  | 'queued' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled';

export type MissionKind = 'sdlc' | 'incident' | 'ticket' | 'review';

export interface InboundEvent {
  id: string;
  source: string;
  kind: string;
  sourceRef: string;
  title?: string | null;
  missionId?: string | null;
  status: 'received' | 'dispatched' | 'ignored' | 'duplicate';
  note?: string | null;
  receivedAt: string;
}

export interface Mission {
  id: string;
  kind: MissionKind;
  title: string;
  input: string;
  status: MissionStatus;
  summary?: string | null;
  error?: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  durationMs: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  live?: boolean;
  trigger: 'manual' | 'alert' | 'github_webhook' | 'github_poll';
  sourceRef?: string | null;
}

export interface MissionEvent {
  id: number;
  missionId: string;
  type: string;
  actor: string;
  text?: string | null;
  data?: any;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  missionId: string;
  agentType: string;
  status: 'running' | 'succeeded' | 'failed';
  task?: string | null;
  result?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

export interface Approval {
  id: string;
  missionId: string;
  actor: string;
  toolName: string;
  summary: string;
  input: any;
  status: 'pending' | 'approved' | 'rejected';
  reason?: string | null;
  createdAt: string;
}

export interface Artifact {
  id: string;
  missionId: string;
  kind: string;
  title: string;
  url?: string | null;
  body?: string | null;
  createdAt: string;
}

export interface Alert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  service: string;
  title: string;
  description: string;
  resource: string;
  metric?: string | null;
  value?: string | null;
  threshold?: string | null;
  status: 'firing' | 'acknowledged' | 'resolved';
  firedAt: string;
}

export interface FleetMember {
  id: string;
  name: string;
  department: 'sdlc' | 'sre' | 'platform';
  role: string;
  description: string;
  /** Resolved model id this agent runs on. */
  model: string;
  tools: string[];
  runs: number;
  succeeded: number;
}

export interface AgentFile {
  id: string;
  content: string;
  member: { name: string; model: string };
}

export interface Template {
  id: string;
  kind: MissionKind;
  title: string;
  blurb: string;
  input: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  config: () => req<AppConfig>('/config'),
  fleet: () => req<FleetMember[]>('/fleet'),
  templates: () => req<Template[]>('/templates'),

  missions: () => req<Mission[]>('/missions'),
  mission: (id: string) =>
    req<{
      mission: Mission;
      events: MissionEvent[];
      agents: AgentRun[];
      approvals: Approval[];
      artifacts: Artifact[];
    }>(`/missions/${id}`),
  createMission: (body: { kind: MissionKind; title: string; input: string }) =>
    req<Mission>('/missions', { method: 'POST', body: JSON.stringify(body) }),
  cancelMission: (id: string) =>
    req<{ cancelled: boolean }>(`/missions/${id}/cancel`, { method: 'POST' }),

  alerts: () => req<Alert[]>('/alerts'),
  triggerAlert: (id: string) =>
    req<Mission>(`/alerts/${id}/trigger`, { method: 'POST' }),
  resetSim: () => req<{ ok: boolean }>('/sim/reset', { method: 'POST' }),

  approvals: () => req<Approval[]>('/approvals'),
  decide: (id: string, decision: 'approved' | 'rejected', reason?: string) =>
    req<Approval>(`/approvals/${id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, decidedBy: 'operator', reason }),
    }),

  artifacts: () => req<Artifact[]>('/artifacts'),

  inboundEvents: () => req<InboundEvent[]>('/events/inbound'),
  pollNow: () => req<{ checked: number; dispatched: number }>('/events/poll', { method: 'POST' }),

  agentFile: (id: string) => req<AgentFile>(`/agents/${id}`),
  validateAgent: (id: string, content: string) =>
    req<{ ok: boolean; error?: string }>(`/agents/${id}/validate`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  saveAgent: (id: string, content: string) =>
    req<{ ok: boolean; id: string; model: string; name: string }>(`/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
};
