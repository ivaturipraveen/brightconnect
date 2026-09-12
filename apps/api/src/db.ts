/**
 * Persistence. Uses node:sqlite (built into Node 24+) so there is no native
 * module to compile - the whole app installs and runs anywhere Node does,
 * which matters when we redeploy onto a fresh EC2 box.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { config } from './config.ts';
import type {
  Alert, AgentRun, Approval, Artifact, Mission, MissionEvent, MissionStatus,
} from './types.ts';

mkdirSync(config.paths.data, { recursive: true });

export const db = new DatabaseSync(`${config.paths.data}brightconnect.db`);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS missions (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    title         TEXT NOT NULL,
    input         TEXT NOT NULL,
    status        TEXT NOT NULL,
    alert_id      TEXT,
    session_id    TEXT,
    summary       TEXT,
    error         TEXT,
    cost_usd      REAL NOT NULL DEFAULT 0,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    num_turns     INTEGER NOT NULL DEFAULT 0,
    duration_ms   INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id           TEXT PRIMARY KEY,
    mission_id   TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    agent_type   TEXT NOT NULL,
    tool_use_id  TEXT,
    status       TEXT NOT NULL,
    task         TEXT,
    result       TEXT,
    cost_usd     REAL NOT NULL DEFAULT 0,
    started_at   TEXT NOT NULL,
    finished_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agent_runs_mission ON agent_runs(mission_id);

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id TEXT NOT NULL,
    type       TEXT NOT NULL,
    actor      TEXT NOT NULL,
    text       TEXT,
    data       TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_mission ON events(mission_id, id);

  CREATE TABLE IF NOT EXISTS approvals (
    id         TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    actor      TEXT NOT NULL,
    tool_name  TEXT NOT NULL,
    summary    TEXT NOT NULL,
    input      TEXT NOT NULL,
    status     TEXT NOT NULL,
    decided_by TEXT,
    reason     TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_mission ON approvals(mission_id);

  CREATE TABLE IF NOT EXISTS artifacts (
    id         TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL,
    url        TEXT,
    body       TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_mission ON artifacts(mission_id);

  CREATE TABLE IF NOT EXISTS alerts (
    id          TEXT PRIMARY KEY,
    severity    TEXT NOT NULL,
    service     TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    resource    TEXT NOT NULL,
    metric      TEXT,
    value       TEXT,
    threshold   TEXT,
    status      TEXT NOT NULL,
    fired_at    TEXT NOT NULL
  );
`);

export const now = () => new Date().toISOString();

/* ---------------------------------------------------------------- missions */

const missionFromRow = (r: any): Mission => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  input: r.input,
  status: r.status,
  alertId: r.alert_id,
  sessionId: r.session_id,
  summary: r.summary,
  error: r.error,
  costUsd: r.cost_usd,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  numTurns: r.num_turns,
  durationMs: r.duration_ms,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export const missions = {
  create(m: Pick<Mission, 'id' | 'kind' | 'title' | 'input'> & { alertId?: string | null }) {
    db.prepare(
      `INSERT INTO missions (id, kind, title, input, status, alert_id, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(m.id, m.kind, m.title, m.input, m.alertId ?? null, now());
    return this.get(m.id)!;
  },

  get(id: string): Mission | undefined {
    const r = db.prepare(`SELECT * FROM missions WHERE id = ?`).get(id);
    return r ? missionFromRow(r) : undefined;
  },

  list(limit = 100): Mission[] {
    return db
      .prepare(`SELECT * FROM missions ORDER BY created_at DESC LIMIT ?`)
      .all(limit)
      .map(missionFromRow);
  },

  setStatus(id: string, status: MissionStatus) {
    const stamp =
      status === 'running' ? `, started_at = COALESCE(started_at, '${now()}')` : '';
    db.prepare(`UPDATE missions SET status = ?${stamp} WHERE id = ?`).run(status, id);
  },

  finish(id: string, patch: Partial<Mission> & { status: MissionStatus }) {
    db.prepare(
      `UPDATE missions
          SET status = ?, summary = ?, error = ?, cost_usd = ?, input_tokens = ?,
              output_tokens = ?, num_turns = ?, duration_ms = ?, session_id = ?,
              finished_at = ?
        WHERE id = ?`,
    ).run(
      patch.status,
      patch.summary ?? null,
      patch.error ?? null,
      patch.costUsd ?? 0,
      patch.inputTokens ?? 0,
      patch.outputTokens ?? 0,
      patch.numTurns ?? 0,
      patch.durationMs ?? 0,
      patch.sessionId ?? null,
      now(),
      id,
    );
  },

  setSession(id: string, sessionId: string) {
    db.prepare(`UPDATE missions SET session_id = ? WHERE id = ?`).run(sessionId, id);
  },
};

/* ------------------------------------------------------------- agent runs */

const agentRunFromRow = (r: any): AgentRun => ({
  id: r.id,
  missionId: r.mission_id,
  agentType: r.agent_type,
  toolUseId: r.tool_use_id,
  status: r.status,
  task: r.task,
  result: r.result,
  costUsd: r.cost_usd,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export const agentRuns = {
  start(a: { id: string; missionId: string; agentType: string; toolUseId?: string | null; task?: string | null }) {
    db.prepare(
      `INSERT INTO agent_runs (id, mission_id, agent_type, tool_use_id, status, task, started_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    ).run(a.id, a.missionId, a.agentType, a.toolUseId ?? null, a.task ?? null, now());
  },

  finishByToolUseId(toolUseId: string, status: 'succeeded' | 'failed', result?: string) {
    db.prepare(
      `UPDATE agent_runs SET status = ?, result = ?, finished_at = ?
        WHERE tool_use_id = ? AND status = 'running'`,
    ).run(status, result ?? null, now(), toolUseId);
  },

  failAllRunning(missionId: string) {
    db.prepare(
      `UPDATE agent_runs SET status = 'failed', finished_at = ?
        WHERE mission_id = ? AND status = 'running'`,
    ).run(now(), missionId);
  },

  listByMission(missionId: string): AgentRun[] {
    return db
      .prepare(`SELECT * FROM agent_runs WHERE mission_id = ? ORDER BY started_at ASC`)
      .all(missionId)
      .map(agentRunFromRow);
  },

  /** Fleet-wide utilisation, for the dashboard. */
  stats(): { agentType: string; runs: number; succeeded: number }[] {
    return db
      .prepare(
        `SELECT agent_type AS agentType, COUNT(*) AS runs,
                SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded
           FROM agent_runs GROUP BY agent_type`,
      )
      .all() as any[];
  },
};

/* ----------------------------------------------------------------- events */

const eventFromRow = (r: any): MissionEvent => ({
  id: r.id,
  missionId: r.mission_id,
  type: r.type,
  actor: r.actor,
  text: r.text,
  data: r.data ? JSON.parse(r.data) : undefined,
  createdAt: r.created_at,
});

export const events = {
  append(e: Omit<MissionEvent, 'id' | 'createdAt'>): MissionEvent {
    const createdAt = now();
    const info = db
      .prepare(
        `INSERT INTO events (mission_id, type, actor, text, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.missionId,
        e.type,
        e.actor,
        e.text ?? null,
        e.data === undefined ? null : JSON.stringify(e.data),
        createdAt,
      );
    return { ...e, id: Number(info.lastInsertRowid), createdAt };
  },

  listByMission(missionId: string, afterId = 0): MissionEvent[] {
    return db
      .prepare(`SELECT * FROM events WHERE mission_id = ? AND id > ? ORDER BY id ASC`)
      .all(missionId, afterId)
      .map(eventFromRow);
  },

  recent(limit = 200): MissionEvent[] {
    return db
      .prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`)
      .all(limit)
      .map(eventFromRow)
      .reverse();
  },
};

/* -------------------------------------------------------------- approvals */

const approvalFromRow = (r: any): Approval => ({
  id: r.id,
  missionId: r.mission_id,
  actor: r.actor,
  toolName: r.tool_name,
  summary: r.summary,
  input: JSON.parse(r.input),
  status: r.status,
  decidedBy: r.decided_by,
  reason: r.reason,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export const approvals = {
  create(a: Omit<Approval, 'status' | 'createdAt' | 'decidedAt' | 'decidedBy' | 'reason'>) {
    db.prepare(
      `INSERT INTO approvals (id, mission_id, actor, tool_name, summary, input, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(a.id, a.missionId, a.actor, a.toolName, a.summary, JSON.stringify(a.input), now());
    return this.get(a.id)!;
  },

  get(id: string): Approval | undefined {
    const r = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id);
    return r ? approvalFromRow(r) : undefined;
  },

  decide(id: string, status: 'approved' | 'rejected', decidedBy: string, reason?: string) {
    db.prepare(
      `UPDATE approvals SET status = ?, decided_by = ?, reason = ?, decided_at = ?
        WHERE id = ? AND status = 'pending'`,
    ).run(status, decidedBy, reason ?? null, now(), id);
    return this.get(id)!;
  },

  listPending(): Approval[] {
    return db
      .prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`)
      .all()
      .map(approvalFromRow);
  },

  listByMission(missionId: string): Approval[] {
    return db
      .prepare(`SELECT * FROM approvals WHERE mission_id = ? ORDER BY created_at ASC`)
      .all(missionId)
      .map(approvalFromRow);
  },
};

/* -------------------------------------------------------------- artifacts */

const artifactFromRow = (r: any): Artifact => ({
  id: r.id,
  missionId: r.mission_id,
  kind: r.kind,
  title: r.title,
  url: r.url,
  body: r.body,
  createdAt: r.created_at,
});

export const artifacts = {
  create(a: Omit<Artifact, 'createdAt'>) {
    db.prepare(
      `INSERT INTO artifacts (id, mission_id, kind, title, url, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, a.missionId, a.kind, a.title, a.url ?? null, a.body ?? null, now());
    return { ...a, createdAt: now() };
  },

  listByMission(missionId: string): Artifact[] {
    return db
      .prepare(`SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at ASC`)
      .all(missionId)
      .map(artifactFromRow);
  },

  listAll(limit = 100): Artifact[] {
    return db
      .prepare(`SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?`)
      .all(limit)
      .map(artifactFromRow);
  },
};

/* ----------------------------------------------------------------- alerts */

const alertFromRow = (r: any): Alert => ({
  id: r.id,
  severity: r.severity,
  service: r.service,
  title: r.title,
  description: r.description,
  resource: r.resource,
  metric: r.metric,
  value: r.value,
  threshold: r.threshold,
  status: r.status,
  firedAt: r.fired_at,
});

export const alerts = {
  upsert(a: Alert) {
    db.prepare(
      `INSERT INTO alerts (id, severity, service, title, description, resource, metric, value, threshold, status, fired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
    ).run(
      a.id, a.severity, a.service, a.title, a.description, a.resource,
      a.metric ?? null, a.value ?? null, a.threshold ?? null, a.status, a.firedAt,
    );
    return this.get(a.id)!;
  },

  get(id: string): Alert | undefined {
    const r = db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(id);
    return r ? alertFromRow(r) : undefined;
  },

  list(): Alert[] {
    return db.prepare(`SELECT * FROM alerts ORDER BY fired_at DESC`).all().map(alertFromRow);
  },

  setStatus(id: string, status: Alert['status']) {
    db.prepare(`UPDATE alerts SET status = ? WHERE id = ?`).run(status, id);
  },
};
