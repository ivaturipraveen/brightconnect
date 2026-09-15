/**
 * Remediation actions.
 *
 * Every action declares its own blast radius. High-impact actions are gated by
 * the approval flow in the orchestrator (see canUseTool) - the agent proposes,
 * a human decides. That gate is the point, not a limitation: it is exactly the
 * "human stays in the loop for go/no-go" control the platform promises.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { incidentState } from '../sim/state.ts';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

interface ActionSpec {
  id: string;
  title: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
  /** Whether a human must approve before this runs. */
  requiresApproval: boolean;
  reversible: string;
}

export const RUNBOOK_ACTIONS: ActionSpec[] = [
  {
    id: 'restart_pods',
    title: 'Rolling restart of a workload',
    description:
      'Restarts pods one at a time, respecting the pod disruption budget. Clears transient state but does not change configuration - if the cause is a bad config, symptoms return.',
    impact: 'medium',
    requiresApproval: true,
    reversible: 'Self-limiting; pods return to their prior state.',
  },
  {
    id: 'scale_replicas',
    title: 'Change replica count',
    description:
      'Scales a deployment up or down. Adds capacity, but will not help if each replica is itself constrained.',
    impact: 'medium',
    requiresApproval: true,
    reversible: 'Scale back to the prior count.',
  },
  {
    id: 'rollback_deployment',
    title: 'Roll back to the previous revision',
    description:
      'Reverts a deployment to its previous revision, undoing both the image and the configuration it shipped with. The correct action when a recent deploy caused the incident.',
    impact: 'high',
    requiresApproval: true,
    reversible: 'Re-deploy the newer revision once fixed.',
  },
  {
    id: 'update_config',
    title: 'Patch a configuration value',
    description:
      'Changes a single environment variable or config value on a workload and restarts it. Narrower than a full rollback when exactly one value is wrong.',
    impact: 'high',
    requiresApproval: true,
    reversible: 'Patch the value back.',
  },
  {
    id: 'regional_failover',
    title: 'Fail over to the secondary region',
    description:
      'Shifts traffic to the standby region. Use when the primary region cannot be recovered inside the RTO target. Carries real data-loss risk up to the RPO window.',
    impact: 'high',
    requiresApproval: true,
    reversible: 'Fail back once the primary is healthy; expect a second disruption.',
  },
  {
    id: 'acknowledge_alert',
    title: 'Acknowledge an alert',
    description: 'Marks an alert as acknowledged so responders know it is being worked.',
    impact: 'low',
    requiresApproval: false,
    reversible: 'Un-acknowledge.',
  },
];

export const actionById = (id: string) => RUNBOOK_ACTIONS.find((a) => a.id === id);

const listActions = tool(
  'list_actions',
  'List the remediation actions available, with their blast radius and whether they need human approval. Call this before proposing a fix.',
  {},
  async () =>
    text(
      RUNBOOK_ACTIONS.map(
        (a) =>
          `${a.id} - ${a.title}\n  impact=${a.impact} requires_approval=${a.requiresApproval}\n  ${a.description}\n  rollback: ${a.reversible}`,
      ).join('\n\n'),
    ),
);

const executeAction = tool(
  'execute_action',
  'Execute a remediation action. High-impact actions pause for human approval before running - propose clearly and expect to wait.',
  {
    actionId: z.string().describe('Action id from list_actions, e.g. rollback_deployment.'),
    target: z.string().describe('Resource to act on, e.g. oms-api.'),
    reason: z.string().describe('Why this action resolves the incident. Shown to the human approver.'),
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional()
      .describe('Action parameters, e.g. { replicas: 8 } or { DB_MAX_POOL_SIZE: "50" }.'),
  },
  async ({ actionId, target, reason, params }) => {
    const spec = actionById(actionId);
    if (!spec) {
      return text(
        `Unknown action "${actionId}". Available: ${RUNBOOK_ACTIONS.map((a) => a.id).join(', ')}`,
      );
    }

    const appliedAt = new Date().toISOString();
    let result: string;

    switch (actionId) {
      case 'rollback_deployment':
        result =
          `Rolled back ${target} to the previous revision.\n` +
          `  deployment.apps/${target} rolled back to revision 8 (image 2.14.2, DB_MAX_POOL_SIZE=50)\n` +
          `  Waiting for rollout: 6 of 6 updated replicas available.\n` +
          `  Rollout complete.`;
        break;
      case 'update_config':
        result =
          `Patched configuration on ${target}: ${JSON.stringify(params ?? {})}\n` +
          `  deployment.apps/${target} patched; rolling restart triggered.\n` +
          `  Rollout complete: 6 of 6 replicas ready.`;
        break;
      case 'scale_replicas':
        result = `Scaled ${target} to ${params?.replicas ?? 'the requested count'} replicas.`;
        break;
      case 'restart_pods':
        result = `Rolling restart of ${target} complete; 6 of 6 pods restarted within the disruption budget.`;
        break;
      case 'regional_failover':
        result =
          `Traffic for ${target} shifted to us-east1.\n` +
          `  Cloud SQL failover replica promoted. Replication lag at cutover: 0.4s (within the 5 minute RPO).`;
        break;
      case 'acknowledge_alert':
        result = `Alert ${target} acknowledged.`;
        break;
      default:
        result = `Executed ${actionId} on ${target}.`;
    }

    incidentState.record({ actionId, target, params: params ?? {}, appliedAt, result });

    return text(
      `${result}\n\nReason recorded: ${reason}\n` +
        `Verify with telemetry before declaring the incident resolved - metrics take a minute or two to reflect the change.`,
    );
  },
);

export const runbookServer = createSdkMcpServer({
  name: 'runbook',
  version: '1.0.0',
  instructions:
    'Remediation actions for the Exol OMS platform. High-impact actions require human approval.',
  tools: [listActions, executeAction],
});
