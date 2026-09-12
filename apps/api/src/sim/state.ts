/**
 * Mutable incident state.
 *
 * Remediation actions mutate this, and the telemetry tools read it - so when an
 * agent rolls back the bad deploy, the metrics it queries afterwards genuinely
 * recover. The verification step in the demo is real verification, not a
 * scripted "looks good".
 */

export interface AppliedAction {
  actionId: string;
  target: string;
  params: Record<string, unknown>;
  appliedAt: string;
  result: string;
}

class IncidentState {
  applied: AppliedAction[] = [];

  /** True once the change that caused the incident has been undone. */
  get remediated(): boolean {
    return this.applied.some(
      (a) => a.actionId === 'rollback_deployment' || a.actionId === 'update_config',
    );
  }

  /** Minutes since the fix landed, used to ramp recovery. */
  get minutesSinceRemediation(): number | null {
    const fix = this.applied.find(
      (a) => a.actionId === 'rollback_deployment' || a.actionId === 'update_config',
    );
    if (!fix) return null;
    return (Date.now() - new Date(fix.appliedAt).getTime()) / 60_000;
  }

  record(a: AppliedAction) {
    this.applied.push(a);
  }

  reset() {
    this.applied = [];
  }
}

export const incidentState = new IncidentState();
