/**
 * Schema, in both dialects.
 *
 * The tables are identical apart from the auto-increment column and the
 * timestamp type, so the differences are isolated here rather than smeared
 * through the queries.
 */
import type { Dialect } from './driver.ts';

export function schemaFor(dialect: Dialect): string[] {
  const serial =
    dialect === 'postgres' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const real = dialect === 'postgres' ? 'DOUBLE PRECISION' : 'REAL';
  const int = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';

  // Separate statements: node:sqlite will run a batch, pg will not.
  return [
    `CREATE TABLE IF NOT EXISTS missions (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      title         TEXT NOT NULL,
      input         TEXT NOT NULL,
      status        TEXT NOT NULL,
      alert_id      TEXT,
      trigger       TEXT NOT NULL DEFAULT 'manual',
      source_ref    TEXT,
      session_id    TEXT,
      summary       TEXT,
      error         TEXT,
      cost_usd      ${real} NOT NULL DEFAULT 0,
      input_tokens  ${int} NOT NULL DEFAULT 0,
      output_tokens ${int} NOT NULL DEFAULT 0,
      num_turns     ${int} NOT NULL DEFAULT 0,
      duration_ms   ${int} NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      started_at    TEXT,
      finished_at   TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_missions_source ON missions(source_ref)`,

    `CREATE TABLE IF NOT EXISTS agent_runs (
      id           TEXT PRIMARY KEY,
      mission_id   TEXT NOT NULL,
      agent_type   TEXT NOT NULL,
      tool_use_id  TEXT,
      status       TEXT NOT NULL,
      task         TEXT,
      result       TEXT,
      cost_usd     ${real} NOT NULL DEFAULT 0,
      started_at   TEXT NOT NULL,
      finished_at  TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_mission ON agent_runs(mission_id)`,

    `CREATE TABLE IF NOT EXISTS events (
      id         ${serial},
      mission_id TEXT NOT NULL,
      type       TEXT NOT NULL,
      actor      TEXT NOT NULL,
      text       TEXT,
      data       TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_events_mission ON events(mission_id, id)`,

    `CREATE TABLE IF NOT EXISTS approvals (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_approvals_mission ON approvals(mission_id)`,

    `CREATE TABLE IF NOT EXISTS artifacts (
      id         TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      kind       TEXT NOT NULL,
      title      TEXT NOT NULL,
      url        TEXT,
      body       TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_artifacts_mission ON artifacts(mission_id)`,

    `CREATE TABLE IF NOT EXISTS inbound_events (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL,
      kind        TEXT NOT NULL,
      source_ref  TEXT NOT NULL,
      title       TEXT,
      payload     TEXT NOT NULL,
      mission_id  TEXT,
      status      TEXT NOT NULL,
      note        TEXT,
      received_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_inbound_ref ON inbound_events(source_ref)`,

    `CREATE TABLE IF NOT EXISTS alerts (
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
    )`,
  ];
}
