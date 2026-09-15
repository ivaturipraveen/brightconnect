/** Typed client for the Bright Connect API. */

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
  title: string;
  department: 'sdlc' | 'sre' | 'platform';
  role: string;
  description: string;
  /** Resolved model id this agent runs on. */
  model: string;
  tools: string[];
  runs: number;
  succeeded: number;
}

export interface Attachment {
  name: string;
  path: string;
  type: string;
}

/** One frame of a console reply. */
export interface ConsoleEvent {
  type: 'text' | 'tool' | 'mission' | 'document' | 'done' | 'error';
  text?: string;
  missionId?: string;
  document?: { name: string; url: string };
  cost?: number;
}

export interface Overview {
  orchestrator: {
    id: string;
    name: string;
    title: string;
    role: string;
    model: string;
    status: 'working' | 'idle';
    missionId: string | null;
  };
  session: {
    activeMissions: number;
    totalMissions: number;
    artifacts: number;
    pendingApprovals: number;
    spendUsd: number;
    agentsWorking: number;
  };
  fleet: Array<{
    id: string;
    name: string;
    title: string;
    department: 'sdlc' | 'sre' | 'platform';
    role: string;
    model: string;
    runs: number;
    status: 'working' | 'idle';
    missionId: string | null;
  }>;
  services: { product: string; productApi: string; repo: string };
}

export interface Analytics {
  totals: {
    missions: number; succeeded: number; failed: number; active: number;
    awaitingApproval: number; artifacts: number; agentRuns: number;
    inputTokens: number; outputTokens: number; spendUsd: number;
    avgSpendUsd: number; avgDurationMs: number; successRate: number;
  };
  models: { orchestrator: string; inUse: Array<{ model: string; agents: number }> };
  byKind: Array<{ kind: string; missions: number; spendUsd: number; tokens: number }>;
  byTrigger: Array<{ trigger: string; missions: number }>;
  agents: Array<{
    id: string; name: string; title: string; department: string; model: string;
    runs: number; succeeded: number;
  }>;
  recent: Array<{
    id: string; title: string; kind: string; status: string;
    spendUsd: number; tokens: number; durationMs: number; createdAt: string;
  }>;
}

export interface RepoPull {
  number: number; title: string; state: string; author: string;
  branch?: string; base?: string; url: string; createdAt: string; draft: boolean;
}
export interface RepoCommit {
  sha: string; message: string; author: string; date: string; url: string;
}
export interface DiffFile {
  filename: string; status: string; additions: number; deletions: number; patch: string | null;
}
export interface PullDetail extends RepoPull {
  body: string | null; additions: number; deletions: number; files: DiffFile[];
}
export interface CommitDetail {
  sha: string; message: string; author: string; date: string; url: string;
  stats?: { additions?: number; deletions?: number; total?: number };
  files: DiffFile[];
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

  overview: () => req<Overview>('/overview'),
  analytics: () => req<Analytics>('/analytics'),

  pulls: () => req<{ configured: boolean; pulls: RepoPull[] }>('/repo/pulls'),
  pull: (n: number) => req<PullDetail>(`/repo/pulls/${n}`),
  commits: () => req<{ configured: boolean; commits: RepoCommit[] }>('/repo/commits'),
  commit: (sha: string) => req<CommitDetail>(`/repo/commits/${sha}`),
  inboundEvents: () => req<InboundEvent[]>('/events/inbound'),
  pollNow: () => req<{ checked: number; dispatched: number }>('/events/poll', { method: 'POST' }),

  uploadAttachment: async (file: File): Promise<Attachment> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/console/upload', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return res.json() as Promise<Attachment>;
  },

  agentFile: (id: string) => req<AgentFile>(`/agents/${id}`),
  setAgentModel: (id: string, model: 'haiku' | 'sonnet' | 'opus') =>
    req<{ ok: boolean; id: string; model: string }>(`/agents/${id}/model`, {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    }),
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
