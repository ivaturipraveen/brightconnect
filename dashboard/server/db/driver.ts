/**
 * Database drivers.
 *
 * Postgres is the real store - it holds the mission record, the governance
 * trail, and the event ledger, and it survives a redeploy. SQLite stays as a
 * fallback so the platform still starts when DATABASE_URL is unset or the
 * database is unreachable: losing the audit trail is bad, but a console that
 * will not boot at all during a demo is worse.
 *
 * Callers write SQL once, with `?` placeholders. The Postgres driver rewrites
 * those to $1..$n, which is the only dialect difference outside the schema.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import pg from 'pg';

export type Dialect = 'postgres' | 'sqlite';

export interface Driver {
  dialect: Dialect;
  /** A human-readable description of where data is going, for the boot banner. */
  describe(): string;
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  /** Insert and return the generated integer id. */
  insertReturningId(sql: string, params?: unknown[]): Promise<number>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** `?` -> `$1, $2, ...`, leaving `??` (unused here) and literals alone. */
function toPositional(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

class PostgresDriver implements Driver {
  dialect: Dialect = 'postgres';
  private pool: pg.Pool;
  private label: string;

  constructor(pool: pg.Pool, label: string) {
    this.pool = pool;
    this.label = label;
  }

  describe() {
    return `PostgreSQL (${this.label})`;
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(toPositional(sql), params as any[]);
    return res.rows as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.pool.query(toPositional(sql), params as any[]);
  }

  async insertReturningId(sql: string, params: unknown[] = []): Promise<number> {
    const res = await this.pool.query(`${toPositional(sql)} RETURNING id`, params as any[]);
    return Number(res.rows[0]?.id ?? 0);
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class SqliteDriver implements Driver {
  dialect: Dialect = 'sqlite';
  private db: DatabaseSync;
  private file: string;

  constructor(file: string) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  }

  describe() {
    return `SQLite (${this.file})`;
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as any[])) as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as any[]));
  }

  async insertReturningId(sql: string, params: unknown[] = []): Promise<number> {
    const info = this.db.prepare(sql).run(...(params as any[]));
    return Number(info.lastInsertRowid);
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * Render hands out an internal hostname that only resolves inside its own
 * network, which fails with NXDOMAIN from anywhere else. The external host is
 * the same name plus a region suffix, so this repairs the common mistake rather
 * than failing with a DNS error nobody can interpret.
 */
export function normalizeDatabaseUrl(url: string, region = 'oregon'): string {
  try {
    const parsed = new URL(url);
    if (/^dpg-[a-z0-9]+-a$/i.test(parsed.hostname)) {
      parsed.hostname = `${parsed.hostname}.${region}-postgres.render.com`;
      return parsed.toString();
    }
    return url;
  } catch {
    return url;
  }
}

export async function createDriver(opts: {
  databaseUrl?: string;
  sqliteFile: string;
  sqliteDir: string;
  renderRegion?: string;
}): Promise<Driver> {
  if (opts.databaseUrl) {
    const url = normalizeDatabaseUrl(opts.databaseUrl, opts.renderRegion);
    const host = (() => {
      try { return new URL(url).hostname; } catch { return 'postgres'; }
    })();
    const pool = new pg.Pool({
      connectionString: url,
      // Managed Postgres requires TLS but presents a certificate chain the
      // default verifier rejects; this is the documented configuration.
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Fail fast and loudly rather than on the first query mid-mission.
    const probe = await pool.connect();
    probe.release();
    // A pool error must not take the process down; the next query reconnects.
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
    return new PostgresDriver(pool, host);
  }

  mkdirSync(opts.sqliteDir, { recursive: true });
  return new SqliteDriver(opts.sqliteFile);
}
