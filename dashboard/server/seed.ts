/** Load the simulated environment's alerts into the database on boot. */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { agentRuns, alerts, db, missions, now } from './db/index.ts';
import { bus } from './bus.ts';
import { config } from './config.ts';
import { SEED_ALERTS } from './sim/environment.ts';
import { incidentState } from './sim/state.ts';

export async function seedAlerts() {
  for (const a of SEED_ALERTS) await alerts.upsert(a);
}

/**
 * Drop workspaces for missions that finished a while ago.
 *
 * Each mission gets a scratch directory, and they accumulate: a fortnight of
 * testing left fourteen of them behind. The database keeps the record of what
 * happened; the scratch files only matter while the work is live or recent.
 */
export async function pruneWorkspaces(keepHours = 48): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(config.paths.workspaces);
  } catch {
    return 0; // nothing created yet
  }

  const cutoff = Date.now() - keepHours * 3600_000;
  for (const name of entries) {
    const dir = join(config.paths.workspaces, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const mission = await missions.get(name);
      // Keep anything still running, and anything recent enough to inspect.
      if (mission && ['queued', 'running', 'awaiting_approval'].includes(mission.status)) continue;
      const finished = mission?.finishedAt ?? mission?.createdAt;
      const age = finished ? new Date(finished).getTime() : statSync(dir).mtimeMs;
      if (age > cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // A workspace we cannot stat or remove is not worth failing boot over.
    }
  }
  return removed;
}

/**
 * Close out missions orphaned by a restart.
 *
 * A mission's runner lives in this process, so anything still marked running or
 * awaiting_approval when we boot has no runner behind it - its in-memory state
 * and any pending approval promise died with the previous process. Left alone
 * those rows sit "running" in the console forever and cannot be cancelled,
 * because the cancel path looks for a runner that no longer exists.
 */
export async function reconcileOrphanedMissions(): Promise<number> {
  const orphans = await db().query<{ id: string; title: string }>(
    `SELECT id, title FROM missions WHERE status IN ('running', 'queued', 'awaiting_approval')`,
  );

  for (const o of orphans) {
    await db().run(
      `UPDATE missions SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
      ['Interrupted by a server restart; the run did not survive.', now(), o.id],
    );
    await agentRuns.failAllRunning(o.id);
    await db().run(
      `UPDATE approvals SET status = 'rejected', reason = ?, decided_by = 'system', decided_at = ?
        WHERE mission_id = ? AND status = 'pending'`,
      ['Server restarted before a decision was recorded.', now(), o.id],
    );
    bus.emitEvent({
      missionId: o.id,
      type: 'error',
      actor: 'system',
      text: 'Mission interrupted by a server restart.',
    });
  }
  return orphans.length;
}

/** Put the simulated incident back to its pre-remediation state. */
export async function resetIncident() {
  incidentState.reset();
  for (const a of SEED_ALERTS) {
    await alerts.upsert({ ...a, status: 'firing' });
    await alerts.setStatus(a.id, 'firing');
  }
}

/**
 * Wipe the operating history: every mission and everything hanging off one.
 *
 * Kept separate from the simulated environment on purpose. The alerts and the
 * change log are the world the fleet investigates - they are scenery, and
 * clearing them would leave the incident demo with nothing to find. What goes
 * is the record of what the fleet *did*: missions, the agent runs inside them,
 * the event trail, approvals, artifacts and the inbound GitHub events that
 * triggered them.
 *
 * The settings table survives too, so a cleared platform keeps the model it was
 * set to.
 */
export async function clearHistory(): Promise<Record<string, number>> {
  const driver = db();
  const counts: Record<string, number> = {};

  // Children first: approvals and runs reference a mission.
  const tables = ['approvals', 'artifacts', 'agent_runs', 'events', 'inbound_events', 'missions'];
  for (const table of tables) {
    const [{ n }] = await driver.query<{ n: string | number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    counts[table] = Number(n);
    await driver.run(`DELETE FROM ${table}`);
  }

  // The files those records pointed at: generated documents, console uploads
  // and mission workspaces. Leaving them would mean a "cleared" platform still
  // has gigabytes of somebody else's work on disk.
  for (const dir of [join(config.paths.data, 'documents'), join(config.paths.data, 'uploads'), config.paths.workspaces]) {
    try {
      let removed = 0;
      for (const entry of readdirSync(dir)) {
        rmSync(join(dir, entry), { recursive: true, force: true });
        removed++;
      }
      counts[dir.replace(config.paths.data, 'data/')] = removed;
    } catch {
      /* directory was never created */
    }
  }

  return counts;
}

/**
 * Record the tickets that are open right now as already handled.
 *
 * Clearing history wipes the dedup ledger along with everything else, and the
 * poll id is stable per issue - so the next poll re-dispatches every open
 * ticket the fleet has already worked. Thirty seconds after clearing the board
 * for a demo, a mission nobody asked for appears on it.
 *
 * Marking them ignored draws the line at the clear: work already done stays
 * done, and a ticket filed afterwards still triggers normally.
 */
export async function markOpenIntakeAsSeen(): Promise<number> {
  const { pollGitHub } = await import('./events/github.ts');
  const { inboundEvents } = await import('./db/index.ts');

  let marked = 0;
  for (const event of await pollGitHub()) {
    if (await inboundEvents.seen(event.id)) continue;
    await inboundEvents.record({
      id: event.id,
      source: 'github',
      kind: event.kind,
      sourceRef: event.sourceRef,
      title: event.title,
      payload: event.payload,
      status: 'ignored',
      note: 'Open before the history was cleared',
    });
    marked++;
  }
  return marked;
}
