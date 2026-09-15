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
import multipart from '@fastify/multipart';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Octokit } from '@octokit/rest';
import { config, hasAnthropicKey, hasGithubToken } from './config.ts';
import { loadFleet, readAgentFile, validateAgentFile, writeAgentFile } from './agents/fleet.ts';
import { fleetSummary } from './orchestrator/prompts.ts';
import {
  agentRuns, alerts, approvals, artifacts, events, inboundEvents, initDatabase, missions,
} from './db/index.ts';
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
import { runConsoleTurn, type ConsoleTurn } from './console/agent.ts';
import { DOCUMENTS_DIR } from './console/documents.ts';

// Open the database and create the schema before anything touches it.
const driver = await initDatabase();
await seedAlerts();
const orphaned = await reconcileOrphanedMissions();
const pruned = await pruneWorkspaces();

const app = Fastify({ logger: { level: config.nodeEnv === 'production' ? 'warn' : 'info' } });
await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 5 } });

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

/**
 * Everything the control panel's sidebar needs in one call: session counters,
 * each agent with whether it is working right now, and where the services live.
 */
app.get('/api/overview', async () => {
  const [all, pending, arts, stats] = await Promise.all([
    missions.list(200),
    approvals.listPending(),
    artifacts.listAll(200),
    agentRuns.stats(),
  ]);
  const active = all.filter((m) => ['queued', 'running', 'awaiting_approval'].includes(m.status));

  // Which agents are mid-task, across every running mission.
  const runningByAgent = new Map<string, string>();
  for (const m of active) {
    for (const r of await agentRuns.listByMission(m.id)) {
      if (r.status === 'running') runningByAgent.set(r.agentType, m.id);
    }
  }

  const statsBy = new Map(stats.map((s) => [s.agentType, s]));
  return {
    // The orchestrator is not one of the fleet - it is what decides which of
    // them to engage - but leaving it off the roster made the thing doing the
    // deciding invisible, which is the part people most want to see.
    orchestrator: {
      id: 'orchestrator',
      name: 'Orchestrator',
      role: 'Reads the request, decides what it is, and engages the specialists it needs',
      model: config.anthropic.orchestratorModel,
      status: active.length > 0 ? 'working' : 'idle',
      missionId: active[0]?.id ?? null,
    },
    session: {
      activeMissions: active.length,
      totalMissions: all.length,
      artifacts: arts.length,
      pendingApprovals: pending.length,
      spendUsd: Number(all.reduce((sum, m) => sum + m.costUsd, 0).toFixed(3)),
      agentsWorking: runningByAgent.size,
    },
    fleet: loadFleet().map((m) => ({
      id: m.id,
      name: m.name,
      department: m.department,
      role: m.role,
      model: m.model,
      runs: statsBy.get(m.id)?.runs ?? 0,
      status: runningByAgent.has(m.id) ? 'working' : 'idle',
      missionId: runningByAgent.get(m.id) ?? null,
    })),
    services: {
      product: '/app/',
      productApi: '/app/api/health',
      repo: `https://github.com/${config.github.owner}/${config.github.repo}`,
    },
  };
});

/**
 * Analytics: what the fleet has done, what it consumed, and what it cost.
 *
 * Aggregated from the mission record rather than a separate metrics store -
 * the cost figures are the ones the SDK reported for each run, so the totals
 * here and the number on a mission always agree.
 */
app.get('/api/analytics', async () => {
  const [all, runs, arts, appr] = await Promise.all([
    missions.list(500),
    agentRuns.stats(),
    artifacts.listAll(500),
    approvals.listPending(),
  ]);

  const finished = all.filter((m) => ['succeeded', 'failed', 'cancelled'].includes(m.status));
  const succeeded = all.filter((m) => m.status === 'succeeded');
  const inTok = all.reduce((n, m) => n + m.inputTokens, 0);
  const outTok = all.reduce((n, m) => n + m.outputTokens, 0);
  const spend = all.reduce((n, m) => n + m.costUsd, 0);

  const byKind: Record<string, { missions: number; spendUsd: number; tokens: number }> = {};
  for (const m of all) {
    const k = (byKind[m.kind] ??= { missions: 0, spendUsd: 0, tokens: 0 });
    k.missions++;
    k.spendUsd += m.costUsd;
    k.tokens += m.inputTokens + m.outputTokens;
  }

  const byTrigger: Record<string, number> = {};
  for (const m of all) byTrigger[m.trigger] = (byTrigger[m.trigger] ?? 0) + 1;

  // Which models are actually in use, and on how many agents.
  const fleet = loadFleet();
  const byModel: Record<string, number> = {};
  for (const m of fleet) byModel[m.model] = (byModel[m.model] ?? 0) + 1;
  byModel[config.anthropic.orchestratorModel] = (byModel[config.anthropic.orchestratorModel] ?? 0) + 1;

  const runsBy = new Map(runs.map((r) => [r.agentType, r]));

  return {
    totals: {
      missions: all.length,
      succeeded: succeeded.length,
      failed: all.filter((m) => m.status === 'failed').length,
      active: all.filter((m) => ['queued', 'running', 'awaiting_approval'].includes(m.status)).length,
      awaitingApproval: appr.length,
      artifacts: arts.length,
      agentRuns: runs.reduce((n, r) => n + r.runs, 0),
      inputTokens: inTok,
      outputTokens: outTok,
      spendUsd: Number(spend.toFixed(4)),
      avgSpendUsd: finished.length ? Number((spend / finished.length).toFixed(4)) : 0,
      avgDurationMs: finished.length
        ? Math.round(finished.reduce((n, m) => n + m.durationMs, 0) / finished.length)
        : 0,
      successRate: finished.length ? Math.round((succeeded.length / finished.length) * 100) : 0,
    },
    models: {
      orchestrator: config.anthropic.orchestratorModel,
      inUse: Object.entries(byModel).map(([model, agents]) => ({ model, agents })),
    },
    byKind: Object.entries(byKind).map(([kind, v]) => ({
      kind, ...v, spendUsd: Number(v.spendUsd.toFixed(4)),
    })),
    byTrigger: Object.entries(byTrigger).map(([trigger, missions]) => ({ trigger, missions })),
    agents: fleet.map((m) => ({
      id: m.id,
      name: m.name,
      department: m.department,
      model: m.model,
      runs: runsBy.get(m.id)?.runs ?? 0,
      succeeded: runsBy.get(m.id)?.succeeded ?? 0,
    })).sort((a, b) => b.runs - a.runs),
    recent: all.slice(0, 12).map((m) => ({
      id: m.id,
      title: m.title,
      kind: m.kind,
      status: m.status,
      spendUsd: m.costUsd,
      tokens: m.inputTokens + m.outputTokens,
      durationMs: m.durationMs,
      createdAt: m.createdAt,
    })),
  };
});

/* ------------------------------------------------------------ repository */

/**
 * The repository the fleet works in: what it has opened, and what has landed.
 *
 * Proxied through the server rather than called from the browser so the token
 * never reaches the client, and so this still answers something sensible when
 * no token is configured at all.
 */
const gh = () => (hasGithubToken() ? new Octokit({ auth: config.github.token }) : null);
const repoRef = { owner: config.github.owner, repo: config.github.repo };

app.get('/api/repo/pulls', async (req) => {
  const client = gh();
  if (!client) return { configured: false, pulls: [] };
  const { state } = req.query as { state?: 'open' | 'closed' | 'all' };
  const res = await client.pulls.list({ ...repoRef, state: state ?? 'all', per_page: 30, sort: 'created', direction: 'desc' });
  return {
    configured: true,
    pulls: res.data.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.merged_at ? 'merged' : p.state,
      author: p.user?.login ?? 'unknown',
      branch: p.head?.ref,
      base: p.base?.ref,
      url: p.html_url,
      createdAt: p.created_at,
      draft: p.draft ?? false,
    })),
  };
});

app.get('/api/repo/pulls/:number', async (req, reply) => {
  const client = gh();
  if (!client) return reply.code(503).send({ error: 'No GitHub token configured' });
  const number = Number((req.params as { number: string }).number);
  const [pr, files] = await Promise.all([
    client.pulls.get({ ...repoRef, pull_number: number }),
    client.pulls.listFiles({ ...repoRef, pull_number: number, per_page: 60 }),
  ]);
  return {
    number: pr.data.number,
    title: pr.data.title,
    body: pr.data.body,
    state: pr.data.merged_at ? 'merged' : pr.data.state,
    author: pr.data.user?.login ?? 'unknown',
    branch: pr.data.head?.ref,
    base: pr.data.base?.ref,
    url: pr.data.html_url,
    createdAt: pr.data.created_at,
    additions: pr.data.additions,
    deletions: pr.data.deletions,
    files: files.data.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
    })),
  };
});

app.get('/api/repo/commits', async () => {
  const client = gh();
  if (!client) return { configured: false, commits: [] };
  const res = await client.repos.listCommits({ ...repoRef, per_page: 40 });
  return {
    configured: true,
    commits: res.data.map((c) => ({
      sha: c.sha,
      message: c.commit.message.split('\n')[0],
      author: c.commit.author?.name ?? c.author?.login ?? 'unknown',
      date: c.commit.author?.date ?? '',
      url: c.html_url,
    })),
  };
});

app.get('/api/repo/commits/:sha', async (req, reply) => {
  const client = gh();
  if (!client) return reply.code(503).send({ error: 'No GitHub token configured' });
  const { sha } = req.params as { sha: string };
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return reply.code(400).send({ error: 'Invalid commit sha' });
  const c = await client.repos.getCommit({ ...repoRef, ref: sha });
  return {
    sha: c.data.sha,
    message: c.data.commit.message,
    author: c.data.commit.author?.name ?? 'unknown',
    date: c.data.commit.author?.date ?? '',
    url: c.data.html_url,
    stats: c.data.stats,
    files: (c.data.files ?? []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
    })),
  };
});

/* ----------------------------------------------------------------- fleet */

app.get('/api/fleet', async () => {
  const stats = new Map((await agentRuns.stats()).map((s) => [s.agentType, s] as const));
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

/**
 * Change one agent's model without opening the whole file.
 *
 * Model choice is the setting people actually want to change - a cheap agent
 * for retrieval, an expensive one for synthesis - and making that a text edit
 * in YAML is a good way to ensure nobody ever does it.
 */
app.patch('/api/agents/:id/model', async (req, reply) => {
  const { id } = req.params as { id: string };
  const parsed = z.object({ model: z.enum(['haiku', 'sonnet', 'opus']) }).safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'model must be haiku, sonnet or opus' });
  }
  const member = loadFleet().find((m) => m.id === id);
  if (!member) return reply.code(404).send({ error: 'No such agent' });

  try {
    const raw = readAgentFile(id);
    const next = /^model:\s*.*$/m.test(raw)
      ? raw.replace(/^model:\s*.*$/m, `model: ${parsed.data.model}`)
      : raw.replace(/^---\s*$/m, `model: ${parsed.data.model}\n---`);
    const saved = writeAgentFile(id, next);
    return { ok: true, id, model: saved.model };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
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
  (await missions.list()).map((m) => ({ ...m, live: isRunning(m.id) })),
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
  const mission = await createMission(parsed.data);
  startMissionInBackground(mission.id);
  return reply.code(201).send(mission);
});

app.get('/api/missions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const mission = await missions.get(id);
  if (!mission) return reply.code(404).send({ error: 'Mission not found' });
  const [evts, agents, appr, arts] = await Promise.all([
    events.listByMission(id),
    agentRuns.listByMission(id),
    approvals.listByMission(id),
    artifacts.listByMission(id),
  ]);
  return {
    mission: { ...mission, live: isRunning(id) },
    events: evts,
    agents,
    approvals: appr,
    artifacts: arts,
  };
});

app.post('/api/missions/:id/cancel', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!(await missions.get(id))) return reply.code(404).send({ error: 'Mission not found' });
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
  const record = await approvals.get(id);
  if (!record) return reply.code(404).send({ error: 'Approval not found' });
  if (record.status !== 'pending') {
    return reply.code(409).send({ error: `Already ${record.status}` });
  }
  const ok = await resolveApproval(id, parsed.data.decision, parsed.data.decidedBy, parsed.data.reason);
  if (!ok) return reply.code(409).send({ error: 'Approval is no longer waiting' });
  return approvals.get(id);
});

/* --------------------------------------------------------------- console */

/**
 * The console: someone types a task or a question and the platform works out
 * which it is. Streams the reply, and tells the client when a mission starts or
 * a document is ready so it can link to them.
 */
const consoleBody = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1),
  })).min(1),
  attachments: z.array(z.object({
    name: z.string(),
    path: z.string(),
    type: z.string(),
  })).optional(),
});

app.post('/api/console/chat', async (req, reply) => {
  const parsed = consoleBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid body', details: parsed.error.issues });
  }
  if (!hasAnthropicKey()) {
    return reply.code(503).send({ error: 'ANTHROPIC_API_KEY is not configured.' });
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const scratch = join(config.paths.data, 'console');
  mkdirSync(scratch, { recursive: true });

  try {
    for await (const event of runConsoleTurn(
      parsed.data.messages as ConsoleTurn[],
      {
        attachments: parsed.data.attachments ?? [],
        launch: async ({ kind, title, input }) => {
          const mission = await createMission({ kind, title, input, trigger: 'manual' });
          startMissionInBackground(mission.id);
          return mission.id;
        },
      },
      scratch,
    )) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    reply.raw.write(
      `data: ${JSON.stringify({ type: 'error', text: err instanceof Error ? err.message : String(err) })}\n\n`,
    );
  } finally {
    reply.raw.end();
  }
});

/** Attach a file to the console conversation. */
app.post('/api/console/upload', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'No file provided' });

  const uploads = join(config.paths.data, 'uploads');
  mkdirSync(uploads, { recursive: true });
  // Keep the original name for the human, prefix for uniqueness on disk.
  const safe = file.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 80);
  const stored = join(uploads, `${Date.now().toString(36)}-${safe}`);
  await pipeline(file.file, createWriteStream(stored));

  return {
    name: file.filename,
    path: stored,
    type: file.mimetype || 'application/octet-stream',
  };
});

/** Serve a generated document. */
app.get('/api/console/documents/:file', async (req, reply) => {
  const { file } = req.params as { file: string };
  // Never let a path escape the documents directory.
  if (file.includes('/') || file.includes('..')) {
    return reply.code(400).send({ error: 'Invalid document name' });
  }
  const path = join(DOCUMENTS_DIR, file);
  if (!existsSync(path)) return reply.code(404).send({ error: 'No such document' });
  return reply.type(contentTypeFor(file)).send(createReadStream(path));
});

const contentTypeFor = (file: string): string => {
  if (file.endsWith('.pdf')) return 'application/pdf';
  if (file.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (file.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  return 'application/octet-stream';
};

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

  const result = await dispatchEvent(
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
  const results = [];
  for (const e of found) {
    results.push(
      await dispatchEvent(e, startMissionInBackground, (args) => createMission(args), 'github_poll'),
    );
  }
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
  const mission = await missionFromAlert(id);
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
        await dispatchEvent(e, startMissionInBackground, (args) => createMission(args), 'github_poll');
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
  `  Store: ${driver.describe()}`,
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
