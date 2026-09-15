/**
 * API server.
 *
 * REST for state, SSE for live mission activity. The dashboard replays history
 * from the REST endpoints, then follows /api/stream, so a client that connects
 * mid-mission sees the whole trail with no gap.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config, hasAnthropicKey, hasGithubToken } from './config.ts';
import { loadFleet, readAgentFile, validateAgentFile, writeAgentFile } from './agents/fleet.ts';
import { fleetSummary } from './orchestrator/prompts.ts';
import {
  agentRuns, alerts, approvals, artifacts, events, inboundEvents, missions,
} from './db.ts';
import {
  dispatchEvent, newDeliveryId, normalizeWebhook, pollGitHub, verifySignature,
} from './events/github.ts';
import { bus } from './bus.ts';
import {
  cancelMission, createMission, isRunning, missionFromAlert,
  resolveApproval, startMissionInBackground,
} from './orchestrator/run.ts';
import { pruneWorkspaces, reconcileOrphanedMissions, resetIncident, seedAlerts } from './seed.ts';
import { TEMPLATES } from './templates.ts';

seedAlerts();
const orphaned = reconcileOrphanedMissions();
const pruned = pruneWorkspaces();

const app = Fastify({ logger: { level: config.nodeEnv === 'production' ? 'warn' : 'info' } });
await app.register(cors, { origin: true });

// Webhook signatures are computed over the exact bytes GitHub sent, so the raw
// body has to survive JSON parsing.
app.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (req, body: string, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

/* ------------------------------------------------------------------ meta */

app.get('/api/health', async () => ({ ok: true, uptime: process.uptime() }));

app.get('/api/config', async () => ({
  productName: config.productName,
  customerName: config.customerName,
  repo: `${config.github.owner}/${config.github.repo}`,
  models: {
    orchestrator: config.anthropic.orchestratorModel,
    agent: config.anthropic.agentModel,
  },
  maxMissionCostUsd: config.maxMissionCostUsd,
  /** Drives the setup banner in the UI. */
  readiness: {
    anthropic: hasAnthropicKey(),
    github: hasGithubToken(),
  },
  fleetSize: loadFleet().length,
}));

/* ----------------------------------------------------------------- fleet */

app.get('/api/fleet', async () => {
  const stats = new Map(agentRuns.stats().map((s) => [s.agentType, s] as const));
  return fleetSummary().map((m) => ({
    ...m,
    runs: stats.get(m.id)?.runs ?? 0,
    succeeded: stats.get(m.id)?.succeeded ?? 0,
  }));
});

/** Raw agent definition file, for the prompt editor. */
app.get('/api/agents/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const member = loadFleet().find((m) => m.id === id);
  if (!member) return reply.code(404).send({ error: 'No such agent' });
  try {
    return { id, content: readAgentFile(id), member: { name: member.name, model: member.model } };
  } catch (err) {
    return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

const agentBody = z.object({ content: z.string().min(1) });

/** Validate an edit without saving it, so the editor can warn as you type. */
app.post('/api/agents/:id/validate', async (req, reply) => {
  const { id } = req.params as { id: string };
  const parsed = agentBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });
  return validateAgentFile(id, parsed.data.content);
});

app.put('/api/agents/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const parsed = agentBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });
  try {
    const member = writeAgentFile(id, parsed.data.content);
    // Definitions are read from disk per mission, so this applies to the next
    // mission immediately - no restart.
    return { ok: true, id, model: member.model, name: member.name };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

/* -------------------------------------------------------------- missions */

app.get('/api/missions', async () =>
  missions.list().map((m) => ({ ...m, live: isRunning(m.id) })),
);

app.get('/api/templates', async () => TEMPLATES);

const createMissionBody = z.object({
  kind: z.enum(['sdlc', 'incident']),
  title: z.string().min(1),
  input: z.string().min(1),
});

app.post('/api/missions', async (req, reply) => {
  const parsed = createMissionBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid body', details: parsed.error.issues });
  }
  const mission = createMission(parsed.data);
  startMissionInBackground(mission.id);
  return reply.code(201).send(mission);
});

app.get('/api/missions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const mission = missions.get(id);
  if (!mission) return reply.code(404).send({ error: 'Mission not found' });
  return {
    mission: { ...mission, live: isRunning(id) },
    events: events.listByMission(id),
    agents: agentRuns.listByMission(id),
    approvals: approvals.listByMission(id),
    artifacts: artifacts.listByMission(id),
  };
});

app.post('/api/missions/:id/cancel', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!missions.get(id)) return reply.code(404).send({ error: 'Mission not found' });
  const cancelled = cancelMission(id);
  return { cancelled };
});

/* ------------------------------------------------------------- approvals */

app.get('/api/approvals', async () => approvals.listPending());

const decideBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string().default('operator'),
  reason: z.string().optional(),
});

app.post('/api/approvals/:id/decide', async (req, reply) => {
  const { id } = req.params as { id: string };
  const parsed = decideBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid body', details: parsed.error.issues });
  }
  const record = approvals.get(id);
  if (!record) return reply.code(404).send({ error: 'Approval not found' });
  if (record.status !== 'pending') {
    return reply.code(409).send({ error: `Already ${record.status}` });
  }
  const ok = resolveApproval(id, parsed.data.decision, parsed.data.decidedBy, parsed.data.reason);
  if (!ok) return reply.code(409).send({ error: 'Approval is no longer waiting' });
  return approvals.get(id);
});

/* ------------------------------------------------------- inbound events */

/** Everything GitHub has sent us, and what we did with it. */
app.get('/api/events/inbound', async () => inboundEvents.list());

/**
 * GitHub webhook receiver.
 *
 * This is how work should really arrive: someone files an issue or opens a pull
 * request, and the fleet picks it up. Always answers 202 once the delivery is
 * accepted - a webhook endpoint that returns errors gets disabled by GitHub,
 * and whether we chose to act is our business, not a delivery failure.
 */
app.post('/api/webhooks/github', async (req, reply) => {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const raw = (req as any).rawBody ?? '';
  if (!verifySignature(raw, signature)) {
    return reply.code(401).send({ error: 'Invalid signature' });
  }

  const event = (req.headers['x-github-event'] as string) ?? 'unknown';
  const deliveryId = (req.headers['x-github-delivery'] as string) ?? newDeliveryId();
  const normalized = normalizeWebhook(event, deliveryId, req.body);

  if ('skip' in normalized) {
    return reply.code(202).send({ accepted: true, acted: false, reason: normalized.skip });
  }

  const result = dispatchEvent(
    normalized,
    startMissionInBackground,
    (args) => createMission(args),
    'github_webhook',
  );
  return reply.code(202).send({ accepted: true, acted: result.status === 'dispatched', ...result });
});

/** Poll once on demand - useful to show the flow without a public URL. */
app.post('/api/events/poll', async () => {
  const found = await pollGitHub();
  const results = found.map((e) =>
    dispatchEvent(e, startMissionInBackground, (args) => createMission(args), 'github_poll'),
  );
  return {
    checked: found.length,
    dispatched: results.filter((r) => r.status === 'dispatched').length,
    results,
  };
});

/* ---------------------------------------------------------------- alerts */

app.get('/api/alerts', async () => alerts.list());

app.post('/api/alerts/:id/trigger', async (req, reply) => {
  const { id } = req.params as { id: string };
  const mission = missionFromAlert(id);
  if (!mission) return reply.code(404).send({ error: 'Alert not found' });
  startMissionInBackground(mission.id);
  return reply.code(201).send(mission);
});

/** Reset the simulated incident so the demo can be run again cleanly. */
app.post('/api/sim/reset', async () => {
  resetIncident();
  bus.publish({ channel: 'alert', payload: { reset: true } });
  return { ok: true, alerts: alerts.list() };
});

/* -------------------------------------------------------------- artifacts */

app.get('/api/artifacts', async () => artifacts.listAll());

/* ----------------------------------------------------------------- events */

app.get('/api/events', async (req) => {
  const { missionId, after } = req.query as { missionId?: string; after?: string };
  return missionId
    ? events.listByMission(missionId, Number(after ?? 0))
    : events.recent(200);
});

/* -------------------------------------------------------------------- SSE */

app.get('/api/stream', (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Without this, nginx buffers the stream and the dashboard looks frozen.
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(`: connected\n\n`);

  const unsubscribe = bus.subscribe((envelope) => {
    reply.raw.write(`event: ${envelope.channel}\ndata: ${JSON.stringify(envelope.payload)}\n\n`);
  });

  // Proxies drop idle connections; a comment every 20s keeps it open.
  const heartbeat = setInterval(() => reply.raw.write(`: ping\n\n`), 20_000);

  req.raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/* ------------------------------------------------- static web build (prod) */

const webDist = fileURLToPath(new URL('../dist/', import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  // SPA fallback so client-side routes survive a refresh.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

/* ------------------------------------------------------------------ boot */

await app.listen({ port: config.port, host: '0.0.0.0' });

/**
 * Background poll.
 *
 * A laptop cannot receive webhooks, so polling is what makes the event-driven
 * path demonstrable locally. Deduplication is on the event id, so this running
 * alongside a real webhook cannot start the same work twice.
 */
if (hasGithubToken() && config.github.pollSeconds > 0) {
  const tick = async () => {
    try {
      const found = await pollGitHub();
      for (const e of found) {
        dispatchEvent(e, startMissionInBackground, (args) => createMission(args), 'github_poll');
      }
    } catch (err) {
      app.log.warn({ err }, 'github poll failed');
    }
  };
  setInterval(tick, config.github.pollSeconds * 1000).unref();
  void tick();
}

const banner = [
  ``,
  `  ${config.productName} API listening on http://localhost:${config.port}`,
  `  Fleet: ${loadFleet().length} agents   Repo: ${config.github.owner}/${config.github.repo}`,
  `  Anthropic key: ${hasAnthropicKey() ? 'configured' : 'MISSING - missions will not run'}`,
  ...(orphaned ? [`  Closed out ${orphaned} mission(s) orphaned by the last restart`] : []),
  ...(pruned ? [`  Pruned ${pruned} old mission workspace(s)`] : []),
  `  GitHub token:  ${hasGithubToken() ? 'configured' : 'missing - issues/PRs recorded locally'}`,
  hasGithubToken() && config.github.pollSeconds > 0
    ? `  Watching ${config.github.owner}/${config.github.repo} every ${config.github.pollSeconds}s` +
      (config.github.triggerLabel ? ` for issues labelled "${config.github.triggerLabel}"` : '')
    : `  Event intake: webhook only (POST /api/webhooks/github)`,
  ``,
].join('\n');
console.log(banner);
