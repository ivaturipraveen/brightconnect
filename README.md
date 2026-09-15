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
npm run preflight        # verifies the key, subagents, tools, GitHub
npm run dev
```

- Console: http://localhost:5173
- API: http://localhost:8787

`npm run preflight` is worth running before any demo. It confirms in about thirty
seconds that the key authenticates, that a subagent spawns **and can reach the MCP
tools it was scoped to**, and that the GitHub token has write access — the three
things that are expensive to discover broken in front of an audience.

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
.claude/agents/          the 17 specialists - EDIT PROMPTS HERE
  log-analyst.md         frontmatter (tools, model) + prompt body
  rca-analyst.md
  ...

server/                  the API and the agent fleet
  index.ts               REST + SSE
  config.ts              all configuration, one place
  db.ts                  SQLite schema and queries
  bus.ts                 event fan-out to connected dashboards
  agents/fleet.ts        loads and validates the agent files
  orchestrator/
    run.ts               mission runner, stream translation, approval gate
    prompts.ts           orchestrator and mission briefs
  tools/                 MCP servers: telemetry, changemgmt, runbook, github
  sim/                   simulated environment and mutable incident state

web/                     the console
  index.html
  src/
    pages/               Mission Control · Mission Detail · Fleet · Incidents · Governance
    components/
      MissionFlow.tsx    live delegation flow
      AgentEditor.tsx    prompt editor
      ui.tsx             shared primitives
    lib/                 typed API client, SSE hook

scripts/preflight.ts     pre-demo check: key, subagents, tools, GitHub
infra/                   EC2 deployment (systemd + nginx)
docs/DEMO.md             the demo script
data/                    SQLite database (gitignored)
workspaces/              per-mission agent scratch space (gitignored)
dist/                    built console (gitignored)
```

One package, one `package.json`, one `npm install`. The server and the console
share a dependency tree; `vite.config.ts` points at `web/` as its root.

---

## Editing the agents

Each specialist is a [Claude Code agent file](https://code.claude.com/docs/en/agent-sdk/subagents)
in `.claude/agents/`:

```markdown
---
name: log-analyst
displayName: Log Analyst
department: sre
role: Cross-references logs against the alert window
description: "Searches and correlates logs around an incident window..."
tools:
  - mcp__telemetry__query_logs
  - mcp__telemetry__query_metrics
model: haiku
---
You are an SRE analysing logs during a live incident.
...
```

Two ways to edit: the file directly, or **the Fleet page in the console** — click
any agent to open its definition, edit, and save. Saves are validated first; a
file that would not load is rejected and the original is left untouched.

Changes apply to the **next** mission. A running mission keeps the definitions it
started with, so editing mid-demo cannot destabilise a run in progress.

Because these are standard Claude Code agent files, they also work from the
Claude Code CLI directly — the fleet is not locked inside this platform.

### Choosing a model

`model:` in frontmatter takes `haiku`, `sonnet`, `opus`, or a full model id.
Omit it and the agent falls back to `AGENT_MODEL`.

| Model | $/MTok in/out | Use for |
|---|---|---|
| `claude-haiku-4-5` | $1 / $5 | Cheapest. Retrieval and summarisation agents. |
| `claude-sonnet-5` | $2 / $10 | Middle ground. |
| `claude-opus-5` | $5 / $25 | Hardest reasoning — RCA synthesis, architecture. |

Mixing is the point: an agent that greps logs does not need the model that
synthesises a root cause from three conflicting reports.

---

## Deploying

See `infra/README.md`. One script provisions a fresh Ubuntu box; a second deploys.
Services run under systemd behind nginx, so they restart on crash and survive reboot.
