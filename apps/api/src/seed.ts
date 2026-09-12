/** Load the simulated environment's alerts into the database on boot. */
import { alerts } from './db.ts';
import { SEED_ALERTS } from './sim/environment.ts';
import { incidentState } from './sim/state.ts';

export function seedAlerts() {
  for (const a of SEED_ALERTS) alerts.upsert(a);
}

/** Put the simulated incident back to its pre-remediation state. */
export function resetIncident() {
  incidentState.reset();
  for (const a of SEED_ALERTS) {
    alerts.upsert({ ...a, status: 'firing' });
    alerts.setStatus(a.id, 'firing');
  }
}
