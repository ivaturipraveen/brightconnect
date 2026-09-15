/**
 * Observability tools. These are the adapter boundary: today they read the
 * simulator, and swapping them for Cloud Monitoring / Cloud Logging clients is
 * a change to these four handlers and nothing else.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { alerts as alertStore } from '../db/index.ts';
import type { LogEntry, MetricPoint, ResourceDescriptor } from '../sim/environment.ts';
import {
  CHANGES, INCIDENT_WINDOW, LOGS, METRICS, RESOURCES, SLO_TARGETS,
} from '../sim/environment.ts';
import { incidentState } from '../sim/state.ts';

/**
 * After a remediation lands, telemetry has to actually show recovery -
 * otherwise the agent's verification step is theatre. These helpers project
 * the post-fix trajectory onto whatever the simulator would otherwise report.
 */
const RECOVERED_METRIC_TARGETS: Record<string, number> = {
  request_latency_p99: 118,
  error_rate_5xx: 0.04,
  replicas_ready: 6,
  db_pool_in_use: 14,
  db_pool_waiters: 0,
  orders_submitted: 1420,
};

function recoveryTail(metric: string, lastValue: number): MetricPoint[] {
  const mins = incidentState.minutesSinceRemediation;
  if (mins === null) return [];
  const target = RECOVERED_METRIC_TARGETS[metric];
  if (target === undefined) return [];
  const points: MetricPoint[] = [];
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    // Converge on the healthy baseline over roughly three minutes.
    const progress = Math.min(1, (mins + i * 0.75) / 3);
    const value = lastValue + (target - lastValue) * progress;
    points.push({
      timestamp: new Date(Date.now() - (steps - i) * 45_000).toISOString(),
      value: Number(value.toFixed(2)),
    });
  }
  return points;
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

const queryAlerts = tool(
  'query_alerts',
  'List monitoring alerts, optionally filtered by status or service. Use this to understand what is currently firing.',
  {
    status: z.enum(['firing', 'acknowledged', 'resolved', 'any']).optional()
      .describe('Filter by alert status. Defaults to any.'),
    service: z.string().optional().describe('Filter to a single service, e.g. oms-api.'),
  },
  async ({ status, service }) => {
    let rows = await alertStore.list();
    if (status && status !== 'any') rows = rows.filter((a) => a.status === status);
    if (service) rows = rows.filter((a) => a.service === service);
    if (rows.length === 0) return text('No alerts matched that filter.');
    return text(
      rows
        .map(
          (a) =>
            `[${a.severity.toUpperCase()}] ${a.id} ${a.title}\n` +
            `  service=${a.service} status=${a.status} fired=${a.firedAt}\n` +
            `  metric=${a.metric ?? 'n/a'} observed=${a.value ?? 'n/a'} threshold=${a.threshold ?? 'n/a'}\n` +
            `  resource=${a.resource}\n  ${a.description}`,
        )
        .join('\n\n'),
    );
  },
);

const queryLogs = tool(
  'query_logs',
  'Search platform and application logs. Supports filtering by service, minimum severity, and a free-text match. Returns entries in chronological order.',
  {
    service: z.string().optional().describe('Service name, e.g. oms-api. Omit for all services.'),
    minSeverity: z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']).optional()
      .describe('Only return entries at or above this severity.'),
    contains: z.string().optional().describe('Case-insensitive substring to match in the log message.'),
    limit: z.number().int().min(1).max(200).optional().describe('Max entries to return. Default 50.'),
  },
  async ({ service, minSeverity, contains, limit }) => {
    const rank = { DEFAULT: 0, INFO: 1, WARNING: 2, ERROR: 3, CRITICAL: 4 };
    let rows = LOGS;
    if (service) rows = rows.filter((l) => l.service === service);
    if (minSeverity) rows = rows.filter((l) => rank[l.severity] >= rank[minSeverity]);
    if (contains) {
      const needle = contains.toLowerCase();
      rows = rows.filter((l) => l.message.toLowerCase().includes(needle));
    }
    if (incidentState.remediated) rows = [...rows, ...recoveryLogs()];
    rows = rows.slice(0, limit ?? 50);
    if (rows.length === 0) return text('No log entries matched that query.');
    return text(
      `Incident window: first error at ${INCIDENT_WINDOW.firstError}\n\n` +
        rows
          .map((l) => {
            const labels = l.labels
              ? ' ' + Object.entries(l.labels).map(([k, v]) => `${k}=${v}`).join(' ')
              : '';
            return `${l.timestamp} ${l.severity.padEnd(8)} [${l.service}] ${l.message}${labels}`;
          })
          .join('\n'),
    );
  },
);

const queryMetrics = tool(
  'query_metrics',
  'Read a monitoring time series. Use this to see how a metric moved across the incident window rather than only its current value.',
  {
    metric: z.string().describe(
      'Metric name. Available: request_latency_p99, error_rate_5xx, replicas_ready, db_pool_in_use, db_pool_waiters, cloudsql_connections, cloudsql_cpu, orders_submitted.',
    ),
    resource: z.string().optional().describe('Resource the metric belongs to, e.g. oms-api.'),
  },
  async ({ metric, resource }) => {
    const found = METRICS.filter(
      (s) => s.metric === metric && (!resource || s.resource === resource),
    );
    if (found.length === 0) {
      return text(
        `No series named "${metric}". Available metrics: ${[...new Set(METRICS.map((s) => s.metric))].join(', ')}`,
      );
    }
    return text(
      found
        .map((s) => {
          const points = [...s.points, ...recoveryTail(s.metric, s.points[s.points.length - 1].value)];
          const vals = points.map((p) => p.value);
          const peak = Math.max(...vals);
          const base = vals[0];
          const note = incidentState.remediated
            ? '\n  (remediation applied; trailing points reflect recovery)'
            : '';
          return (
            `${s.metric} (${s.resource}) in ${s.unit}${note}\n` +
            `  baseline=${base} peak=${peak} latest=${vals[vals.length - 1]}\n` +
            points.map((p) => `  ${p.timestamp}  ${p.value}`).join('\n')
          );
        })
        .join('\n\n'),
    );
  },
);

/** Log lines the platform would emit once the fix lands. */
function recoveryLogs(): LogEntry[] {
  const fix = incidentState.applied.find(
    (a) => a.actionId === 'rollback_deployment' || a.actionId === 'update_config',
  );
  if (!fix) return [];
  const api = 'projects/exol-oms-prod/locations/us-central1/clusters/oms-prod/workloads/oms-api';
  const t = (offsetSec: number) =>
    new Date(new Date(fix.appliedAt).getTime() + offsetSec * 1000).toISOString();
  return [
    { timestamp: t(5), severity: 'INFO', resource: api, service: 'oms-api', message: 'Rolling update started (remediation)' },
    { timestamp: t(40), severity: 'INFO', resource: api, service: 'oms-api', message: 'Config loaded: DB_MAX_POOL_SIZE=50 DB_CONNECTION_TIMEOUT_MS=2000' },
    { timestamp: t(75), severity: 'INFO', resource: api, service: 'oms-api', message: 'Rolling update complete: 6/6 pods ready' },
    { timestamp: t(110), severity: 'INFO', resource: api, service: 'oms-api', message: 'Connection pool healthy: pool_in_use=14/50 waiters=0' },
    { timestamp: t(150), severity: 'INFO', resource: api, service: 'oms-api', message: 'Handled 1,398 requests in last window; p99=121ms; 5xx rate 0.03%' },
  ];
}

const describeResource = tool(
  'describe_resource',
  'Get the current configuration and state of a cloud resource - replica counts, environment variables, probes, autoscaling, instance settings. Use this to find misconfiguration.',
  {
    name: z.string().optional().describe(
      'Full or partial resource name, e.g. "oms-api". Omit to list every resource.',
    ),
  },
  async ({ name }) => {
    const rows = name
      ? RESOURCES.filter((r) => r.name.toLowerCase().includes(name.toLowerCase()))
      : RESOURCES;
    if (rows.length === 0) {
      return text(
        `No resource matched "${name}". Known resources:\n` +
          RESOURCES.map((r) => `  ${r.name} (${r.type})`).join('\n'),
      );
    }
    const slo = JSON.stringify(SLO_TARGETS, null, 2);
    return text(
      rows
        .map((r) => {
          const view = projectRecovery(r);
          return `${view.name}\n  type=${view.type} state=${view.state}\n  config=${JSON.stringify(view.config, null, 2)}`;
        })
        .join('\n\n') + `\n\nService level objectives:\n${slo}`,
    );
  },
);

/** Reflect an applied fix in the resource view the agent reads back. */
function projectRecovery(r: ResourceDescriptor): ResourceDescriptor {
  if (!incidentState.remediated) return r;
  if (!r.name.includes('oms-api') && !r.name.includes('oms-api-lb')) return r;

  const cfg = structuredClone(r.config) as Record<string, any>;
  if (cfg.replicas) cfg.replicas = { desired: 6, ready: 6, unavailable: 0 };
  if (cfg.env?.DB_MAX_POOL_SIZE) {
    const patch = incidentState.applied.find((a) => a.actionId === 'update_config');
    cfg.env = { ...cfg.env, DB_MAX_POOL_SIZE: String(patch?.params?.DB_MAX_POOL_SIZE ?? 50) };
  }
  if (cfg.image) cfg.image = 'gcr.io/exol-oms-prod/oms-api:2.14.2';
  if (cfg.healthyBackends !== undefined) cfg.healthyBackends = 6;
  return { ...r, state: 'HEALTHY', config: cfg };
}

export const telemetryServer = createSdkMcpServer({
  name: 'telemetry',
  version: '1.0.0',
  instructions:
    'Read-only observability for the Exol OMS platform: alerts, logs, metric time series, and resource configuration.',
  tools: [queryAlerts, queryLogs, queryMetrics, describeResource],
});

/* ------------------------------------------------------- change management */

const recentChanges = tool(
  'recent_changes',
  'List recent deployments, configuration changes, infrastructure applies, and feature flag flips. Use this to find what changed before an incident.',
  {
    service: z.string().optional().describe('Filter to a single service.'),
    withinMinutes: z.number().int().optional()
      .describe('Only changes within this many minutes before now. Omit for all recorded changes.'),
  },
  async ({ service, withinMinutes }) => {
    let rows = CHANGES;
    if (service) rows = rows.filter((c) => c.service === service);
    if (withinMinutes !== undefined) {
      const cutoff = Date.now() - withinMinutes * 60_000;
      rows = rows.filter((c) => new Date(c.timestamp).getTime() >= cutoff);
    }
    if (rows.length === 0) return text('No change records matched that filter.');
    return text(
      `Incident first error: ${INCIDENT_WINDOW.firstError}\n\n` +
        rows
          .map(
            (c) =>
              `${c.id} [${c.type}] ${c.title}\n` +
              `  service=${c.service} author=${c.author} at=${c.timestamp}` +
              (c.pr ? ` pr=#${c.pr}` : '') +
              `\n  ${c.summary}`,
          )
          .join('\n\n'),
    );
  },
);

const describeChange = tool(
  'describe_change',
  'Get the full detail of one change record, including exactly which values changed and how to roll it back.',
  { id: z.string().describe('Change record id, e.g. CHG-4471.') },
  async ({ id }) => {
    const c = CHANGES.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (!c) {
      return text(`No change with id "${id}". Known: ${CHANGES.map((x) => x.id).join(', ')}`);
    }
    return text(
      `${c.id} [${c.type}] ${c.title}\n` +
        `service=${c.service}\nauthor=${c.author}\ntimestamp=${c.timestamp}\n` +
        (c.pr ? `pull_request=#${c.pr}\n` : '') +
        `summary=${c.summary}\n` +
        `details=${JSON.stringify(c.details, null, 2)}\n` +
        (c.rollbackCommand ? `rollback=${c.rollbackCommand}\n` : ''),
    );
  },
);

export const changeMgmtServer = createSdkMcpServer({
  name: 'changemgmt',
  version: '1.0.0',
  instructions:
    'Change management records for the Exol platform: deployments, config changes, infrastructure applies, feature flags.',
  tools: [recentChanges, describeChange],
});
