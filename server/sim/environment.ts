/**
 * A simulated GCP-shaped environment for the Exol Order Management System.
 *
 * Why simulated: we have no access to the customer's GCP project, and a live
 * demo that depends on a real cloud account is a demo that can fail on stage.
 * The shapes here mirror Cloud Logging / Cloud Monitoring / GKE so the analysis
 * the agents perform is the same analysis they would perform against the real
 * APIs - only the adapter behind these tools would change.
 *
 * The scenario contains a genuine causal chain that the agents have to *find*:
 * a connection-pool change shipped four minutes before the first error, which
 * starved the OMS API of database connections under normal load.
 */

export interface LogEntry {
  timestamp: string;
  severity: 'DEFAULT' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  resource: string;
  service: string;
  message: string;
  labels?: Record<string, string>;
}

export interface MetricPoint {
  timestamp: string;
  value: number;
}

export interface MetricSeries {
  metric: string;
  resource: string;
  unit: string;
  points: MetricPoint[];
}

export interface ResourceDescriptor {
  name: string;
  type: string;
  state: string;
  config: Record<string, unknown>;
}

export interface ChangeRecord {
  id: string;
  type: 'deployment' | 'config' | 'infrastructure' | 'feature_flag';
  title: string;
  author: string;
  service: string;
  timestamp: string;
  summary: string;
  details: Record<string, unknown>;
  /** Linked GitHub PR number where one exists. */
  pr?: number;
  rollbackCommand?: string;
}

/** Incident anchor: the first error. Everything else is relative to this. */
const INCIDENT_START = new Date(Date.now() - 22 * 60_000);
const at = (minutesFromStart: number) =>
  new Date(INCIDENT_START.getTime() + minutesFromStart * 60_000).toISOString();

export const INCIDENT_WINDOW = {
  start: at(-30),
  firstError: at(0),
  now: new Date().toISOString(),
};

/* ------------------------------------------------------------- resources */

export const RESOURCES: ResourceDescriptor[] = [
  {
    name: 'projects/exol-oms-prod/locations/us-central1/clusters/oms-prod/workloads/oms-api',
    type: 'k8s_deployment',
    state: 'DEGRADED',
    config: {
      replicas: { desired: 6, ready: 2, unavailable: 4 },
      image: 'gcr.io/exol-oms-prod/oms-api:2.14.3',
      resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2', memory: '2Gi' } },
      readinessProbe: { path: '/healthz', periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 1 },
      env: {
        // The smoking gun. Was 50 until the 2.14.3 rollout.
        DB_MAX_POOL_SIZE: '5',
        DB_CONNECTION_TIMEOUT_MS: '2000',
        DB_HOST: '10.42.0.14',
      },
      autoscaling: { minReplicas: 4, maxReplicas: 20, targetCPUUtilization: 70 },
    },
  },
  {
    name: 'projects/exol-oms-prod/instances/oms-primary',
    type: 'cloudsql_instance',
    state: 'RUNNABLE',
    config: {
      tier: 'db-custom-8-32768',
      region: 'us-central1',
      maxConnections: 800,
      currentConnections: 61,
      replicationType: 'SYNCHRONOUS',
      failoverReplica: 'oms-primary-failover (us-east1, healthy)',
      pointInTimeRecovery: true,
      backupRetentionDays: 7,
    },
  },
  {
    name: 'projects/exol-oms-prod/locations/us-central1/clusters/oms-prod/workloads/oms-fulfilment',
    type: 'k8s_deployment',
    state: 'HEALTHY',
    config: {
      replicas: { desired: 4, ready: 4, unavailable: 0 },
      image: 'gcr.io/exol-oms-prod/oms-fulfilment:1.9.0',
      env: { DB_MAX_POOL_SIZE: '40' },
    },
  },
  {
    name: 'projects/exol-oms-prod/global/backendServices/oms-api-lb',
    type: 'load_balancer',
    state: 'DEGRADED',
    config: {
      backends: 6,
      healthyBackends: 2,
      healthCheck: { path: '/healthz', timeoutSec: 1, unhealthyThreshold: 3 },
      cdnEnabled: false,
    },
  },
];

/* ----------------------------------------------------------------- logs */

function buildLogs(): LogEntry[] {
  const logs: LogEntry[] = [];
  const api = 'projects/exol-oms-prod/locations/us-central1/clusters/oms-prod/workloads/oms-api';

  // Quiet baseline before anything goes wrong.
  for (let m = -30; m < -4; m += 4) {
    logs.push({
      timestamp: at(m),
      severity: 'INFO',
      resource: api,
      service: 'oms-api',
      message: `Handled 1,4${Math.abs(m)} requests in last window; p99=118ms; pool_in_use=12/50`,
    });
  }

  // The deploy lands. Innocuous-looking.
  logs.push({
    timestamp: at(-4),
    severity: 'INFO',
    resource: api,
    service: 'oms-api',
    message: 'Rolling update started: oms-api:2.14.2 -> oms-api:2.14.3',
    labels: { deployment_id: 'dep-8817', triggered_by: 'cloudbuild' },
  });
  logs.push({
    timestamp: at(-3),
    severity: 'INFO',
    resource: api,
    service: 'oms-api',
    message: 'Config loaded: DB_MAX_POOL_SIZE=5 DB_CONNECTION_TIMEOUT_MS=2000',
    labels: { deployment_id: 'dep-8817' },
  });
  logs.push({
    timestamp: at(-2),
    severity: 'INFO',
    resource: api,
    service: 'oms-api',
    message: 'Rolling update complete: 6/6 pods running oms-api:2.14.3',
    labels: { deployment_id: 'dep-8817' },
  });

  // Pressure builds as normal traffic exceeds the new pool ceiling.
  logs.push({
    timestamp: at(-1),
    severity: 'WARNING',
    resource: api,
    service: 'oms-api',
    message: 'Connection pool saturated: pool_in_use=5/5 waiters=3 avg_wait=340ms',
  });

  // First genuine error.
  logs.push({
    timestamp: at(0),
    severity: 'ERROR',
    resource: api,
    service: 'oms-api',
    message:
      'HikariPool-1 - Connection is not available, request timed out after 2000ms (pool size 5, active 5, waiting 18)',
    labels: { trace: 'a3f9c21e', endpoint: 'POST /v1/orders' },
  });

  // Cascade: timeouts -> failed readiness -> pods removed -> load concentrates.
  const cascade: Array<[number, LogEntry['severity'], string]> = [
    [0.5, 'ERROR', 'POST /v1/orders failed: 503 Service Unavailable (db_connection_timeout) in 2041ms'],
    [1, 'ERROR', 'Readiness probe failed: GET /healthz timed out after 1000ms'],
    [1.5, 'WARNING', 'Pod oms-api-7d9f4b-x2k9 removed from service endpoints (readiness failing)'],
    [2, 'ERROR', 'HikariPool-1 - Connection is not available, request timed out after 2000ms (pool size 5, active 5, waiting 47)'],
    [3, 'ERROR', 'Readiness probe failed 3/3: restarting container oms-api'],
    [4, 'CRITICAL', 'Only 2/6 replicas ready; upstream 5xx rate 64%'],
    [6, 'ERROR', 'POST /v1/orders failed: 503 Service Unavailable (db_connection_timeout) in 2003ms'],
    [8, 'CRITICAL', 'Order submission error budget for the hour exhausted (SLO 99.9%, observed 93.1%)'],
    [11, 'ERROR', 'HikariPool-1 - Connection is not available, request timed out after 2000ms (pool size 5, active 5, waiting 63)'],
    [15, 'CRITICAL', 'Sustained degradation: 2/6 replicas ready for 11 minutes'],
  ];
  for (const [m, severity, message] of cascade) {
    logs.push({ timestamp: at(m), severity, resource: api, service: 'oms-api', message });
  }

  // Fulfilment stays healthy - it did not receive the pool change. This is the
  // control that rules out a database-side fault.
  for (const m of [-10, 0, 8, 16]) {
    logs.push({
      timestamp: at(m),
      severity: 'INFO',
      resource:
        'projects/exol-oms-prod/locations/us-central1/clusters/oms-prod/workloads/oms-fulfilment',
      service: 'oms-fulfilment',
      message: `Processed fulfilment batch; p99=96ms; pool_in_use=14/40; no errors`,
    });
  }

  // Database is fine throughout - another control.
  for (const m of [-5, 2, 10, 18]) {
    logs.push({
      timestamp: at(m),
      severity: 'INFO',
      resource: 'projects/exol-oms-prod/instances/oms-primary',
      service: 'cloudsql',
      message: `Instance healthy; connections=61/800; cpu=22%; replication_lag=0.4s`,
    });
  }

  return logs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export const LOGS: LogEntry[] = buildLogs();

/* -------------------------------------------------------------- metrics */

function series(metric: string, resource: string, unit: string, fn: (m: number) => number): MetricSeries {
  const points: MetricPoint[] = [];
  for (let m = -30; m <= 20; m += 2) {
    points.push({ timestamp: at(m), value: Number(fn(m).toFixed(2)) });
  }
  return { metric, resource, unit, points };
}

const API = 'oms-api';

export const METRICS: MetricSeries[] = [
  series('request_latency_p99', API, 'ms', (m) => (m < -1 ? 115 + Math.sin(m) * 8 : Math.min(2100, 140 + (m + 1) * 260))),
  series('error_rate_5xx', API, 'percent', (m) => (m < 0 ? 0.04 : Math.min(66, 2 + m * 5.5))),
  series('replicas_ready', API, 'count', (m) => (m < 1 ? 6 : Math.max(2, 6 - Math.floor((m + 1) / 1.2)))),
  series('db_pool_in_use', API, 'connections', (m) => (m < -3 ? 12 : 5)),
  series('db_pool_waiters', API, 'count', (m) => (m < -1 ? 0 : Math.min(63, m * 4.2))),
  series('cloudsql_connections', 'oms-primary', 'connections', (m) => (m < -3 ? 74 : 61)),
  series('cloudsql_cpu', 'oms-primary', 'percent', () => 22 + Math.random() * 3),
  series('orders_submitted', API, 'count/min', (m) => (m < 0 ? 1420 + Math.sin(m) * 40 : Math.max(480, 1420 - m * 62))),
];

/* --------------------------------------------------------------- changes */

export const CHANGES: ChangeRecord[] = [
  {
    id: 'CHG-4471',
    type: 'deployment',
    title: 'oms-api 2.14.3 - tune database connection pool',
    author: 'm.okafor@exol.com',
    service: 'oms-api',
    timestamp: at(-4),
    summary:
      'Reduced DB_MAX_POOL_SIZE from 50 to 5 to address a Cloud SQL connection-count alert raised last week.',
    details: {
      deployment_id: 'dep-8817',
      from_version: '2.14.2',
      to_version: '2.14.3',
      changed_env: { DB_MAX_POOL_SIZE: { from: '50', to: '5' } },
      approved_by: 'r.castellanos@exol.com',
      change_window: 'standard',
      load_tested: false,
    },
    pr: 142,
    rollbackCommand: 'kubectl rollout undo deployment/oms-api -n oms-prod',
  },
  {
    id: 'CHG-4468',
    type: 'infrastructure',
    title: 'Enable point-in-time recovery on oms-primary',
    author: 'platform-bot@exol.com',
    service: 'cloudsql',
    timestamp: at(-180),
    summary: 'Terraform apply enabling PITR and extending backup retention to 7 days.',
    details: { terraform_run: 'run-99f2', resources_changed: 1, blast_radius: 'low' },
    pr: 139,
  },
  {
    id: 'CHG-4465',
    type: 'feature_flag',
    title: 'Enable express_checkout for 10% of traffic',
    author: 'j.patel@exol.com',
    service: 'oms-api',
    timestamp: at(-420),
    summary: 'Gradual rollout of express checkout flow.',
    details: { flag: 'express_checkout', rollout_percent: 10, prior_percent: 0 },
  },
  {
    id: 'CHG-4460',
    type: 'config',
    title: 'Raise HPA max replicas for oms-fulfilment 8 -> 12',
    author: 'm.okafor@exol.com',
    service: 'oms-fulfilment',
    timestamp: at(-1440),
    summary: 'Capacity increase ahead of seasonal volume.',
    details: { from: 8, to: 12 },
    pr: 137,
  },
];

/* ---------------------------------------------------------------- alerts */

export const SEED_ALERTS = [
  {
    id: 'ALERT-9F3C',
    severity: 'critical' as const,
    service: 'oms-api',
    title: 'OMS API 5xx error rate above SLO threshold',
    description:
      'Order submission endpoint returning 503 at 64% of requests. Error budget for the hour is exhausted. Customer-facing order placement is failing.',
    resource:
      'projects/exol-oms-prod/locations/us-central1/clusters/oms-prod/workloads/oms-api',
    metric: 'error_rate_5xx',
    value: '64%',
    threshold: '1%',
    status: 'firing' as const,
    firedAt: at(4),
  },
  {
    id: 'ALERT-7B21',
    severity: 'critical' as const,
    service: 'oms-api',
    title: 'OMS API replica availability degraded',
    description: 'Only 2 of 6 desired replicas are passing readiness checks.',
    resource:
      'projects/exol-oms-prod/locations/us-central1/clusters/oms-prod/workloads/oms-api',
    metric: 'replicas_ready',
    value: '2',
    threshold: '>= 4',
    status: 'firing' as const,
    firedAt: at(3),
  },
  {
    id: 'ALERT-2D88',
    severity: 'warning' as const,
    service: 'oms-api',
    title: 'OMS API p99 latency elevated',
    description: 'p99 request latency has exceeded 2s, up from a 115ms baseline.',
    resource:
      'projects/exol-oms-prod/locations/us-central1/clusters/oms-prod/workloads/oms-api',
    metric: 'request_latency_p99',
    value: '2100ms',
    threshold: '500ms',
    status: 'firing' as const,
    firedAt: at(2),
  },
];

/** Service-level objectives, used when reasoning about RPO/RTO impact. */
export const SLO_TARGETS = {
  'oms-api': {
    availability: '99.9%',
    latencyP99Ms: 500,
    rpoMinutes: 5,
    rtoMinutes: 15,
    tier: 'tier-1-revenue-critical',
  },
  'oms-fulfilment': {
    availability: '99.5%',
    latencyP99Ms: 800,
    rpoMinutes: 15,
    rtoMinutes: 60,
    tier: 'tier-2',
  },
} as const;
