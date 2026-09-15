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
