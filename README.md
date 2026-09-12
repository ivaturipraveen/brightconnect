# Brightworks

An AI engineering workforce: a fleet of specialist agents that take a specification
or a production alert, plan the work, delegate it, and come back to a human only for
the decisions that matter.

Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). The
fan-out you see in the console is the orchestrator genuinely delegating to subagents,
not a scripted animation.

---

## What it does

**Two mission types**, mapped to the two workflows a platform team runs:

| Mission | Input | The fleet does | Human does |
|---|---|---|---|
| **Software delivery** | A PRD, ARD, or tech spec | Requirements → design → code → IaC → tests → docs → security and code review → pull request | One go/no-go on the PR |
| **Incident response** | A firing alert | Parallel investigation of logs, config, and recent changes → root cause → ticket → remediation → verification | Approve the remediation |

**17 agents across three departments** — each with its own instructions, its own tools,
and a scope it cannot exceed. Adding a capability means adding an agent, not rebuilding
the platform.

**GitHub is the system of record.** Tickets are Issues, changes are Pull Requests. The
audit trail lives where engineers already work.

---

## Running it locally

Requires **Node 24+** (the app uses `node:sqlite`, so there is no native module to build).

```bash
npm install
cp .env.example .env     # then add your ANTHROPIC_API_KEY
npm run dev
```

- Console: http://localhost:5173
- API: http://localhost:8787

### Configuration

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | **yes** | Agents cannot run without it. |
| `GITHUB_TOKEN` | no | Publishes Issues and PRs. Without it they are recorded locally and labelled unpublished. |
| `GITHUB_OWNER` / `GITHUB_REPO` | no | Target repository. |
| `PRODUCT_NAME` | no | Display name throughout the UI. One line to rebrand. |
| `MAX_MISSION_COST_USD` | no | Hard per-mission spend ceiling. Default 5. |

The GitHub token needs fine-grained permissions on the target repo:
`Contents: RW`, `Issues: RW`, `Pull requests: RW`.

---

## Architecture

```
  Console (React)
      │  REST for state · SSE for live activity
      ▼
  API (Fastify)
      │
      ├── Orchestrator ──── Claude Agent SDK query()
      │       │                    │
      │       │                    └── delegates via the Agent tool to:
      │       │                          17 specialist subagents
      │       │
      │       └── canUseTool ──── human approval gate
      │
      ├── MCP tools
      │     telemetry    alerts, logs, metrics, resource config
      │     changemgmt   deployments, config changes, feature flags
      │     runbook      remediation actions, with blast radius
      │     github       issues, pull requests
      │
      └── SQLite  missions · agent runs · events · approvals · artifacts
```

### Where the design earns its keep

**The approval gate is real.** `canUseTool` intercepts two tools — opening a pull
request, and executing a high-impact remediation — and returns a promise that does not
resolve until a human clicks. The agent is genuinely blocked. A rejection is fed back
to the agent as a reason, not swallowed.

**Cost accounting includes subagents.** Read from `modelUsage` rather than `usage`,
which covers only the main loop. `maxBudgetUsd` caps each mission so a runaway agent
cannot burn the account mid-demo.

**Telemetry closes the loop.** Remediation mutates simulated state, and the telemetry
tools read that state — so when an agent rolls back the bad deploy and then verifies,
the recovery it observes is real, not scripted.

**Degrades rather than dead-ends.** No GitHub token means issues and PRs are recorded
locally and clearly labelled unpublished. No API key means the console still works and
says exactly what is missing.

### The simulated environment

`src/sim/environment.ts` models the Exol OMS platform in GCP shapes — Cloud Logging
entries, Cloud Monitoring series, GKE workloads, Cloud SQL, change records.

It contains a genuine causal chain the agents have to *find*: a deployment four minutes
before the first error reduced `DB_MAX_POOL_SIZE` from 50 to 5, starving the API of
database connections. Two controls rule out the obvious wrong answers — the fulfilment
service was untouched and stayed healthy, and the database itself is fine throughout.

This is simulated deliberately. A live demo that depends on a real cloud account is a
demo that can fail on stage. The tool handlers are the adapter boundary: pointing them
at real Cloud Monitoring and Cloud Logging changes those four handlers and nothing else.

---

## Layout

```
apps/api/src/
  agents/fleet.ts        the 17 specialists
  orchestrator/
    run.ts               mission runner, stream translation, approval gate
    prompts.ts           orchestrator and mission briefs
  tools/                 MCP servers: telemetry, changemgmt, runbook, github
  sim/                   simulated environment and mutable incident state
  db.ts                  SQLite schema and queries
  index.ts               REST + SSE

apps/web/src/
  pages/                 Mission Control · Mission Detail · Fleet · Incidents · Governance
  components/ui.tsx      shared primitives
  lib/                   typed API client, SSE hook

infra/                   EC2 deployment
docs/DEMO.md             the demo script
```

---

## Deploying

See `infra/README.md`. One script provisions a fresh Ubuntu box; a second deploys.
Services run under systemd behind nginx, so they restart on crash and survive reboot.
