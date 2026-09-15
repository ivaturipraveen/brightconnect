/** Load the simulated environment's alerts into the database on boot. */
import { agentRuns, alerts, db, missions, now } from './db.ts';
import { bus } from './bus.ts';
import { SEED_ALERTS } from './sim/environment.ts';
import { incidentState } from './sim/state.ts';

export function seedAlerts() {
  for (const a of SEED_ALERTS) alerts.upsert(a);
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
export function reconcileOrphanedMissions(): number {
  const orphans = db
    .prepare(`SELECT id, title FROM missions WHERE status IN ('running', 'queued', 'awaiting_approval')`)
    .all() as Array<{ id: string; title: string }>;

  for (const o of orphans) {
    db.prepare(
      `UPDATE missions SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
    ).run('Interrupted by a server restart; the run did not survive.', now(), o.id);
    agentRuns.failAllRunning(o.id);
    db.prepare(
      `UPDATE approvals SET status = 'rejected', reason = ?, decided_by = 'system', decided_at = ?
        WHERE mission_id = ? AND status = 'pending'`,
    ).run('Server restarted before a decision was recorded.', now(), o.id);
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
export function resetIncident() {
  incidentState.reset();
  for (const a of SEED_ALERTS) {
    alerts.upsert({ ...a, status: 'firing' });
    alerts.setStatus(a.id, 'firing');
  }
}
