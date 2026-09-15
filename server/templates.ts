/**
 * Ready-made mission inputs for the demo. Each one is written the way the
 * customer's own team would write it, so the fleet is working from realistic
 * material rather than a prompt tuned to make it look good.
 */
export interface Template {
  id: string;
  kind: 'sdlc' | 'incident';
  title: string;
  blurb: string;
  input: string;
}

export const TEMPLATES: Template[] = [
  {
    id: 'order-status-webhook',
    kind: 'sdlc',
    title: 'Order status webhook (PRD)',
    blurb: 'A product requirements doc for a customer-facing webhook. Exercises the full delivery path.',
    input: `# PRD: Order Status Webhooks

## Background
Exol's larger retail partners currently poll \`GET /v1/orders/{id}\` every 30 seconds to
track fulfilment state. At current partner counts this is roughly 40% of all OMS API
traffic and it contributes materially to the load on the order service. Partners have
also asked repeatedly for faster notification of state changes.

## Goal
Let partners subscribe to order lifecycle events and receive an HTTP callback when an
order changes state, so they can stop polling.

## Requirements
- Partners can register a webhook endpoint with a shared secret.
- We emit an event on these transitions: PLACED, PICKED, PACKED, SHIPPED, DELIVERED, CANCELLED.
- Deliveries are signed so the partner can verify authenticity.
- Failed deliveries retry with exponential backoff for up to 24 hours, then dead-letter.
- Partners can see recent delivery attempts and their status.
- A slow or failing partner endpoint must not degrade order processing.

## Non-functional
- p99 added latency to the order write path: under 20ms.
- Webhook delivery attempted within 5 seconds of the state change at p95.
- No order event may be lost: at-least-once delivery.
- This is a tier-1 revenue-critical service; RPO 5 minutes, RTO 15 minutes.

## Out of scope
- Partner-facing UI for managing subscriptions (API only for this phase).
- Historical event replay beyond the 24 hour retry window.

## Open questions for the team
- Do we need per-partner rate limiting on delivery?
- Should cancellation events carry the cancellation reason, given it may contain PII?`,
  },
  {
    id: 'pool-hardening',
    kind: 'sdlc',
    title: 'Connection pool guardrails (tech spec)',
    blurb: 'Follow-up work from the incident. Shows the platform closing its own loop.',
    input: `# Tech Spec: Connection Pool Guardrails

## Context
A production incident was caused by a deployment that reduced DB_MAX_POOL_SIZE from 50
to 5 on oms-api. The change passed review and deployed cleanly; nothing in the pipeline
recognised that the new value could not sustain production traffic. The service
degraded within four minutes of rollout.

## Goal
Make this class of change impossible to ship unnoticed.

## Requirements
- Validate connection pool configuration at service startup against observed peak
  concurrency, and refuse to start if the pool is obviously undersized.
- Emit a metric for pool saturation and pool wait time, and alert on sustained saturation.
- Add a CI check that flags any change to connection pool, timeout, or thread pool
  settings and requires an explicit acknowledgement in the PR.
- Document the sizing rationale so the next person to change it knows what it is for.

## Non-functional
- Startup validation must add under 100ms to boot time.
- The CI check must not block unrelated changes.

## Acceptance
- A PR that changes the pool size without acknowledgement fails CI.
- A service started with a pool size below the computed floor fails fast with a clear error.`,
  },
  {
    id: 'terraform-gke-hpa',
    kind: 'sdlc',
    title: 'Autoscaling policy as code (ARD)',
    blurb: 'Infrastructure-weighted mission. Exercises the IaC and observability agents.',
    input: `# ARD: Standardise Autoscaling Policy Across OMS Workloads

## Context
Autoscaling configuration on OMS workloads has drifted. Some deployments scale on CPU
alone, some have min replicas set below what the service needs to survive a single zone
loss, and none scale on a signal that reflects actual user-visible load.

## Decision to make
Define one autoscaling policy, expressed as Terraform modules, applied consistently
across OMS workloads.

## Requirements
- Minimum replicas must survive the loss of one zone for tier-1 services.
- Scale on a request-rate or queue-depth signal, not only CPU.
- Scale-down must be slower than scale-up to avoid flapping under spiky load.
- Every workload gets cost-attribution labels.
- Policy differs by service tier; tier is an input to the module, not a copy of it.

## Non-functional
- Applying the module to an existing workload must not cause a restart.
- The change must be reviewable: a reader should see what the blast radius is.`,
  },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);
