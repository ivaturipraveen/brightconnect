/**
 * The data layer.
 *
 * Every store is async because Postgres is: the previous synchronous
 * node:sqlite API could not survive the move to a real database, so the API is
 * async regardless of which driver is underneath.
 */
import { config } from '../config.ts';
import { createDriver, type Driver } from './driver.ts';
import { migrationsFor, schemaFor } from './schema.ts';
import type {
  Alert, AgentRun, Approval, Artifact, Mission, MissionEvent, MissionStatus,
} from '../types.ts';

let driver: Driver;

export const now = () => new Date().toISOString();
export const db = () => driver;

/** Open the database and create the schema. Called once, before the server listens. */
export async function initDatabase(): Promise<Driver> {
  driver = await createDriver({
    databaseUrl: config.database.url,
    sqliteFile: `${config.paths.data}brightconnect.db`,
    sqliteDir: config.paths.data,
    renderRegion: config.database.renderRegion,
  });
  for (const statement of schemaFor(driver.dialect)) {
    await driver.exec(statement);
  }
  // Additive column migrations. Expected to fail with "already exists" on every
  // boot after the one that applied them, so a failure here is not fatal.
  for (const statement of migrationsFor(driver.dialect)) {
    try {
      await driver.exec(statement);
    } catch {
      /* column is already there */
    }
  }
  return driver;
}

/* ---------------------------------------------------------------- missions */

const missionFromRow = (r: any): Mission => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  input: r.input,
  status: r.status,
  alertId: r.alert_id,
  trigger: r.trigger ?? 'manual',
  sourceRef: r.source_ref,
  sessionId: r.session_id,
  summary: r.summary,
  error: r.error,
  costUsd: Number(r.cost_usd ?? 0),
  inputTokens: Number(r.input_tokens ?? 0),
  outputTokens: Number(r.output_tokens ?? 0),
  cacheReadTokens: Number(r.cache_read_tokens ?? 0),
  cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
  numTurns: Number(r.num_turns ?? 0),
  durationMs: Number(r.duration_ms ?? 0),
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export const missions = {
  async create(
    m: Pick<Mission, 'id' | 'kind' | 'title' | 'input'> & {
      alertId?: string | null;
      trigger?: Mission['trigger'];
      sourceRef?: string | null;
    },
  ): Promise<Mission> {
    await driver.run(
      `INSERT INTO missions (id, kind, title, input, status, alert_id, trigger, source_ref, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      [m.id, m.kind, m.title, m.input, m.alertId ?? null, m.trigger ?? 'manual', m.sourceRef ?? null, now()],
    );
    return (await this.get(m.id))!;
  },

  async get(id: string): Promise<Mission | undefined> {
    const rows = await driver.query(`SELECT * FROM missions WHERE id = ?`, [id]);
    return rows[0] ? missionFromRow(rows[0]) : undefined;
  },

  async list(limit = 100): Promise<Mission[]> {
    const rows = await driver.query(`SELECT * FROM missions ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows.map(missionFromRow);
  },

  async setStatus(id: string, status: MissionStatus): Promise<void> {
    if (status === 'running') {
      await driver.run(
        `UPDATE missions SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`,
        [status, now(), id],
      );
      return;
    }
    await driver.run(`UPDATE missions SET status = ? WHERE id = ?`, [status, id]);
  },

  async finish(id: string, patch: Partial<Mission> & { status: MissionStatus }): Promise<void> {
    await driver.run(
      `UPDATE missions
          SET status = ?, summary = ?, error = ?, cost_usd = ?, input_tokens = ?,
              output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
              num_turns = ?, duration_ms = ?, session_id = ?, finished_at = ?
        WHERE id = ?`,
      [
        patch.status, patch.summary ?? null, patch.error ?? null, patch.costUsd ?? 0,
        patch.inputTokens ?? 0, patch.outputTokens ?? 0,
        patch.cacheReadTokens ?? 0, patch.cacheWriteTokens ?? 0, patch.numTurns ?? 0,
        patch.durationMs ?? 0, patch.sessionId ?? null, now(), id,
      ],
    );
  },

  async setSession(id: string, sessionId: string): Promise<void> {
    await driver.run(`UPDATE missions SET session_id = ? WHERE id = ?`, [sessionId, id]);
  },

  /**
   * Delete one mission and everything that hangs off it.
   *
   * Children first, so a failure part-way through cannot leave agent runs and
   * events pointing at a mission that no longer exists. The inbound event that
   * triggered it is kept but unlinked: it is the dedup record, and dropping it
   * would let the poller re-dispatch the ticket it already handled.
   */
  async remove(id: string): Promise<void> {
    await driver.run(`DELETE FROM approvals WHERE mission_id = ?`, [id]);
    await driver.run(`DELETE FROM artifacts WHERE mission_id = ?`, [id]);
    await driver.run(`DELETE FROM agent_runs WHERE mission_id = ?`, [id]);
    await driver.run(`DELETE FROM events WHERE mission_id = ?`, [id]);
    await driver.run(
      `UPDATE inbound_events SET mission_id = NULL, status = 'ignored', note = ? WHERE mission_id = ?`,
      ['Mission deleted from the dashboard', id],
    );
    await driver.run(`DELETE FROM missions WHERE id = ?`, [id]);
  },

  /** Is there already a live mission answering this external reference? */
  async activeForSource(sourceRef: string): Promise<Mission | undefined> {
    const rows = await driver.query(
      `SELECT * FROM missions
        WHERE source_ref = ? AND status IN ('queued','running','awaiting_approval')
        ORDER BY created_at DESC LIMIT 1`,
      [sourceRef],
    );
    return rows[0] ? missionFromRow(rows[0]) : undefined;
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
  costUsd: Number(r.cost_usd ?? 0),
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export const agentRuns = {
  async start(a: { id: string; missionId: string; agentType: string; toolUseId?: string | null; task?: string | null }) {
    await driver.run(
      `INSERT INTO agent_runs (id, mission_id, agent_type, tool_use_id, status, task, started_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      [a.id, a.missionId, a.agentType, a.toolUseId ?? null, a.task ?? null, now()],
    );
  },

  async finishByToolUseId(toolUseId: string, status: 'succeeded' | 'failed', result?: string) {
    await driver.run(
      `UPDATE agent_runs SET status = ?, result = ?, finished_at = ?
        WHERE tool_use_id = ? AND status = 'running'`,
      [status, result ?? null, now(), toolUseId],
    );
  },

  async failAllRunning(missionId: string) {
    await driver.run(
      `UPDATE agent_runs SET status = 'failed', finished_at = ? WHERE mission_id = ? AND status = 'running'`,
      [now(), missionId],
    );
  },

  async listByMission(missionId: string): Promise<AgentRun[]> {
    const rows = await driver.query(
      `SELECT * FROM agent_runs WHERE mission_id = ? ORDER BY started_at ASC`, [missionId],
    );
    return rows.map(agentRunFromRow);
  },

  /** Fleet-wide utilisation, for the dashboard. */
  /**
   * Per-agent totals, including how long the agent typically takes.
   *
   * The average is computed here rather than in SQL because the two dialects
   * subtract timestamps differently, and a portable expression for it is worse
   * to read than the loop.
   */
  async stats(): Promise<
    { agentType: string; runs: number; succeeded: number; avgMs: number }[]
  > {
    const rows = await driver.query(
      `SELECT agent_type AS "agentType", status, started_at, finished_at FROM agent_runs`,
    );

    const by = new Map<string, { runs: number; succeeded: number; total: number; timed: number }>();
    for (const r of rows as any[]) {
      const entry = by.get(r.agentType) ?? { runs: 0, succeeded: 0, total: 0, timed: 0 };
      entry.runs += 1;
      if (r.status === 'succeeded') entry.succeeded += 1;
      if (r.started_at && r.finished_at) {
        const ms = new Date(r.finished_at).getTime() - new Date(r.started_at).getTime();
        if (Number.isFinite(ms) && ms >= 0) {
          entry.total += ms;
          entry.timed += 1;
        }
      }
      by.set(r.agentType, entry);
    }

    return [...by.entries()].map(([agentType, e]) => ({
      agentType,
      runs: e.runs,
      succeeded: e.succeeded,
      avgMs: e.timed ? Math.round(e.total / e.timed) : 0,
    }));
  },
};

/* ----------------------------------------------------------------- events */

const eventFromRow = (r: any): MissionEvent => ({
  id: Number(r.id),
  missionId: r.mission_id,
  type: r.type,
  actor: r.actor,
  text: r.text,
  data: r.data ? JSON.parse(r.data) : undefined,
  createdAt: r.created_at,
});

export const events = {
  async append(e: Omit<MissionEvent, 'id' | 'createdAt'>): Promise<MissionEvent> {
    const createdAt = now();
    const id = await driver.insertReturningId(
      `INSERT INTO events (mission_id, type, actor, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [e.missionId, e.type, e.actor, e.text ?? null, e.data === undefined ? null : JSON.stringify(e.data), createdAt],
    );
    return { ...e, id, createdAt };
  },

  async listByMission(missionId: string, afterId = 0): Promise<MissionEvent[]> {
    const rows = await driver.query(
      `SELECT * FROM events WHERE mission_id = ? AND id > ? ORDER BY id ASC`, [missionId, afterId],
    );
    return rows.map(eventFromRow);
  },

  async recent(limit = 200): Promise<MissionEvent[]> {
    const rows = await driver.query(`SELECT * FROM events ORDER BY id DESC LIMIT ?`, [limit]);
    return rows.map(eventFromRow).reverse();
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
  async create(a: Omit<Approval, 'status' | 'createdAt' | 'decidedAt' | 'decidedBy' | 'reason'>): Promise<Approval> {
    await driver.run(
      `INSERT INTO approvals (id, mission_id, actor, tool_name, summary, input, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [a.id, a.missionId, a.actor, a.toolName, a.summary, JSON.stringify(a.input), now()],
    );
    return (await this.get(a.id))!;
  },

  async get(id: string): Promise<Approval | undefined> {
    const rows = await driver.query(`SELECT * FROM approvals WHERE id = ?`, [id]);
    return rows[0] ? approvalFromRow(rows[0]) : undefined;
  },

  async decide(id: string, status: 'approved' | 'rejected', decidedBy: string, reason?: string): Promise<Approval> {
    await driver.run(
      `UPDATE approvals SET status = ?, decided_by = ?, reason = ?, decided_at = ?
        WHERE id = ? AND status = 'pending'`,
      [status, decidedBy, reason ?? null, now(), id],
    );
    return (await this.get(id))!;
  },

  async listPending(): Promise<Approval[]> {
    const rows = await driver.query(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`);
    return rows.map(approvalFromRow);
  },

  async listByMission(missionId: string): Promise<Approval[]> {
    const rows = await driver.query(`SELECT * FROM approvals WHERE mission_id = ? ORDER BY created_at ASC`, [missionId]);
    return rows.map(approvalFromRow);
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
  async create(a: Omit<Artifact, 'createdAt'>): Promise<Artifact> {
    const createdAt = now();
    await driver.run(
      `INSERT INTO artifacts (id, mission_id, kind, title, url, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [a.id, a.missionId, a.kind, a.title, a.url ?? null, a.body ?? null, createdAt],
    );
    return { ...a, createdAt };
  },

  async listByMission(missionId: string): Promise<Artifact[]> {
    const rows = await driver.query(`SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at ASC`, [missionId]);
    return rows.map(artifactFromRow);
  },

  async listAll(limit = 100): Promise<Artifact[]> {
    const rows = await driver.query(`SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows.map(artifactFromRow);
  },
};

/* --------------------------------------------------------- inbound events */

export interface InboundEvent {
  id: string;
  source: 'github';
  kind: string;
  sourceRef: string;
  title?: string | null;
  payload: unknown;
  missionId?: string | null;
  status: 'received' | 'dispatched' | 'ignored' | 'duplicate';
  note?: string | null;
  receivedAt: string;
}

const inboundFromRow = (r: any): InboundEvent => ({
  id: r.id,
  source: r.source,
  kind: r.kind,
  sourceRef: r.source_ref,
  title: r.title,
  payload: r.payload ? JSON.parse(r.payload) : null,
  missionId: r.mission_id,
  status: r.status,
  note: r.note,
  receivedAt: r.received_at,
});

export const inboundEvents = {
  /** Returns false if this delivery id has already been seen. */
  async record(e: Omit<InboundEvent, 'receivedAt'>): Promise<boolean> {
    if (await this.seen(e.id)) return false;
    await driver.run(
      `INSERT INTO inbound_events (id, source, kind, source_ref, title, payload, mission_id, status, note, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, e.source, e.kind, e.sourceRef, e.title ?? null, JSON.stringify(e.payload),
       e.missionId ?? null, e.status, e.note ?? null, now()],
    );
    return true;
  },

  async attachMission(id: string, missionId: string) {
    await driver.run(`UPDATE inbound_events SET mission_id = ?, status = 'dispatched' WHERE id = ?`, [missionId, id]);
  },

  async setStatus(id: string, status: InboundEvent['status'], note?: string) {
    await driver.run(`UPDATE inbound_events SET status = ?, note = ? WHERE id = ?`, [status, note ?? null, id]);
  },

  async seen(id: string): Promise<boolean> {
    const rows = await driver.query(`SELECT 1 AS hit FROM inbound_events WHERE id = ?`, [id]);
    return rows.length > 0;
  },

  async list(limit = 100): Promise<InboundEvent[]> {
    const rows = await driver.query(`SELECT * FROM inbound_events ORDER BY received_at DESC LIMIT ?`, [limit]);
    return rows.map(inboundFromRow);
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
  async upsert(a: Alert): Promise<Alert> {
    await driver.run(
      `INSERT INTO alerts (id, severity, service, title, description, resource, metric, value, threshold, status, fired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         severity = EXCLUDED.severity, service = EXCLUDED.service,
         title = EXCLUDED.title, description = EXCLUDED.description,
         resource = EXCLUDED.resource, metric = EXCLUDED.metric,
         value = EXCLUDED.value, threshold = EXCLUDED.threshold,
         status = EXCLUDED.status, fired_at = EXCLUDED.fired_at`,
      [a.id, a.severity, a.service, a.title, a.description, a.resource,
       a.metric ?? null, a.value ?? null, a.threshold ?? null, a.status, a.firedAt],
    );
    return (await this.get(a.id))!;
  },

  async get(id: string): Promise<Alert | undefined> {
    const rows = await driver.query(`SELECT * FROM alerts WHERE id = ?`, [id]);
    return rows[0] ? alertFromRow(rows[0]) : undefined;
  },

  async list(): Promise<Alert[]> {
    const rows = await driver.query(`SELECT * FROM alerts ORDER BY fired_at DESC`);
    return rows.map(alertFromRow);
  },

  /** Remove one alert. `resetIncident` puts the seeded set back. */
  async remove(id: string): Promise<void> {
    await driver.run(`DELETE FROM alerts WHERE id = ?`, [id]);
  },

  async setStatus(id: string, status: Alert['status']) {
    await driver.run(`UPDATE alerts SET status = ? WHERE id = ?`, [status, id]);
  },
};

/* ---------------------------------------------------------------- settings */

/**
 * Settings changed from the dashboard rather than the environment.
 *
 * Deliberately a key/value table: these are a handful of operator choices, not
 * a domain model, and giving each one a column means a schema change every
 * time somebody wants a new toggle.
 */
export const settings = {
  async get(key: string): Promise<string | undefined> {
    const rows = await driver.query(`SELECT value FROM settings WHERE key = ?`, [key]);
    return rows[0]?.value as string | undefined;
  },

  async set(key: string, value: string): Promise<void> {
    await driver.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, value, now()],
    );
  },
};
