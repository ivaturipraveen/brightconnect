/** Domain model shared by the API and, via /api/schema, the web client. */

/** The two workflows the platform runs. */
export type MissionKind = 'sdlc' | 'incident';

export type MissionStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface Mission {
  id: string;
  kind: MissionKind;
  title: string;
  /** The PRD / tech spec, or the incident alert payload. */
  input: string;
  status: MissionStatus;
  /** Populated from the alert that triggered an incident mission. */
  alertId?: string | null;
  sessionId?: string | null;
  /** Final narrative result produced by the orchestrator. */
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
}

/**
 * One fleet member's participation in a mission. Created when the orchestrator
 * delegates, so the UI can show the fleet filling up as work fans out.
 */
export interface AgentRun {
  id: string;
  missionId: string;
  /** Key into the fleet registry, e.g. 'log-analyst'. */
  agentType: string;
  /** The SDK's tool_use id for the delegation, used to correlate events. */
  toolUseId?: string | null;
  status: 'running' | 'succeeded' | 'failed';
  task?: string | null;
  result?: string | null;
  costUsd: number;
  startedAt: string;
  finishedAt?: string | null;
}

/**
 * The governance trail. Every observable thing an agent does lands here, in
 * order, and is never mutated - this is the audit record we show customers.
 */
export type EventType =
  | 'mission.created'
  | 'mission.started'
  | 'mission.finished'
  | 'agent.thinking'
  | 'agent.message'
  | 'agent.spawned'
  | 'agent.finished'
  | 'tool.called'
  | 'tool.result'
  | 'approval.requested'
  | 'approval.decided'
  | 'artifact.created'
  | 'error';

export interface MissionEvent {
  id: number;
  missionId: string;
  type: EventType;
  /** Which fleet member produced this. 'orchestrator' for the main thread. */
  actor: string;
  text?: string | null;
  data?: unknown;
  createdAt: string;
}

/**
 * A gated action. The agent proposes; a human decides. This is the
 * "human stays in the loop only for go/no-go" control.
 */
export interface Approval {
  id: string;
  missionId: string;
  actor: string;
  toolName: string;
  /** Human-readable description of what the agent wants to do. */
  summary: string;
  input: unknown;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy?: string | null;
  reason?: string | null;
  createdAt: string;
  decidedAt?: string | null;
}

/** Something the fleet produced: a PR, an issue, an RCA, a doc. */
export interface Artifact {
  id: string;
  missionId: string;
  kind: 'pull_request' | 'issue' | 'rca' | 'document' | 'remediation';
  title: string;
  url?: string | null;
  body?: string | null;
  createdAt: string;
}

/** A simulated GCP-shaped alert that can trigger an incident mission. */
export interface Alert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  service: string;
  title: string;
  description: string;
  /** GCP-style resource path. */
  resource: string;
  metric?: string | null;
  value?: string | null;
  threshold?: string | null;
  status: 'firing' | 'acknowledged' | 'resolved';
  firedAt: string;
}
