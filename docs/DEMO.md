# Demo script — Randy Schneiderman, Exol

**Audience:** Randy (Director, Cloud & Data Engineering) plus one or two of his engineers.
**Length:** 20 minutes of demo, leaving room for questions.
**Anchor:** the AI-native SDLC, per Sarat's notes. Incident response is the opener because
it lands faster and it is the pain he described most vividly.

---

## What Randy actually said he wants

Every beat below maps to a line from the meeting notes. Say the mapping out loud — he
will recognise his own words, and that is what makes it land.

| Randy's words | Where it shows up |
|---|---|
| "no foundational agentic-first mindset or workflow in place yet" | The fleet page: 17 specialists, each scoped. This *is* the foundation. |
| "hundreds of agents handling code reviews, security notifications, scheduling, incident response" | Fleet page. Adding one is a definition, not a rebuild. |
| "current approach is all-hands-on-deck with no structured triage" | Incident mission: three investigations dispatched in parallel, in seconds. |
| "AI to analyze alerts, cross-reference logs, GCP configs, GitHub, and change management" | Exactly the four tools the SRE agents hold. |
| "automated root cause analysis, ticket creation, and auto-remediation" | The full incident mission, end to end. |
| "Ties directly to RPO/RTO targets for the OMS platform" | The RCA states impact against the 5 min RPO / 15 min RTO. |
| "feed PRDs, ARDs, and tech specs into an agentic platform" | The mission composer takes exactly those. |
| "infra-as-code, software dev, docs-as-code, monitoring, security remediations, linting" | The SDLC department, one agent each. |
| "Human stays in loop only for go/no-go on PRs" | The approval gate. Literally the only click he makes. |
| "produces governance trail" | The Governance page. |

---

## Before you start

```bash
npm run preflight                                  # key, subagents, tools, GitHub
npm run dev                                        # starts server + console
curl -X POST http://localhost:8787/api/sim/reset   # put the incident back
```

`npm run dev` deliberately does not watch files: a watcher restarts the server on any
change, which kills a running mission - an editor autosave is enough to do it. Use
`npm run dev:watch` while developing, never before a demo.

The mission view opens on the **Flow** tab. Leave it there while a mission runs - the
delegation shape is what people want to see. **Activity** has the raw trail for anyone
who asks for receipts.

Open two tabs: **Incidents** and **Mission Control**. Have the repo open in a third.
Confirm the header shows **agents ready** and the repo name — if it says *no API key*,
stop and fix it before anyone walks in.

---

## Act 1 — Incident response (7 min)

> "Let's start where you said it hurts most. Your words were all-hands-on-deck with no
> structured triage. Here's a tier-1 alert on your order management platform."

**Incidents page.** Three alerts firing on `oms-api`. 64% of order submissions failing.
Point at the resource path — it is GCP-shaped, because that is his world.

**Click Dispatch fleet.**

Now narrate what happens, because the speed is the point:

1. The orchestrator writes its plan. Read the first line aloud.
2. It engages **three specialists at once** - log analyst, config auditor, change
   correlator. They land on **one row of the flow, marked "3 in parallel"**. Point at
   that row: *"Three independent lines of enquiry, at the same time. A human team
   serialises them, and serialising costs you minutes of customer impact."* Click a
   card to show what that specialist was asked and what it reported back.
3. Watch the tool calls stream: log queries, resource config, change records.
4. The RCA analyst synthesises: a deploy four minutes before the first error cut the
   database connection pool from 50 to 5.

> "Nobody told it about the connection pool. It found the deploy, correlated the timing,
> checked that fulfilment was untouched and healthy, checked the database was fine, and
> ruled out the alternatives."

5. A ticket is filed in GitHub. Open it. Real issue, real URL.
6. The remediation engineer proposes a rollback — **and stops.**

**This is the moment.** Do not rush it.

> "It will not touch your production estate. This is your go/no-go. You said the human
> should stay in the loop exactly here — so that is the only place we put one."

Show the approval card. Expand *Inspect the exact action* — the precise command, the
blast radius, the rollback path.

**Click Approve.** The rollback runs. The agent then re-queries telemetry and confirms
recovery — 6/6 replicas, error rate back to baseline. Finish on the RPO/RTO line.

**If anyone asks whether you can reject:** do it on the second run. The rejection is fed
back to the agent as a reason and it adapts. That answers the control question better
than any slide.

---

## Act 2 — AI-native SDLC (10 min)

> "You said you're reading the AI-Native SDLC playbook and want to feed PRDs and tech
> specs into an agentic platform. Let's do that with the follow-up work from the
> incident we just watched."

**Mission Control → New mission → "Connection pool guardrails".**

Scroll the spec so they see it is a real document, not a prompt. Point out it is the
*fix for the incident they just watched* — the platform closing its own loop.

**Launch.**

Narrate the fan-out against his own list:

- Spec analyst → testable requirements and the open questions a human must answer
- Architect → the design and the trade-off it rejected
- Backend and infrastructure engineers → the code and the Terraform
- QA → tests, actually run
- Observability → the metrics and alerts, *"so the next person to make this change gets
  caught by the platform instead of by customers"*
- Security and code review → findings with file and line
- Docs → the runbook

> "Infra-as-code, software dev, docs-as-code, monitoring, security, linting. That was
> your list. One agent each, and you can see which one did what."

It stops at the pull request. **Approve it.** Open the PR in GitHub — real branch, real
commit, real description with risk and rollback.

> "One decision. Everything up to it was the fleet's."

---

## Act 3 — The governance answer (3 min)

**Governance page.** Every gated decision, every artifact, every outcome. Appended,
never rewritten.

> "When your auditor asks what the agents did and who approved it, this is the answer.
> And when you're evaluating whether to widen the mandate, this is the evidence."

**Fleet page** to close.

> "Seventeen today. You said hundreds. Each one is instructions, tools, and a scope —
> so getting to hundreds is a staffing exercise, not another platform build."

---

## Questions he is likely to ask

**"Is this really running, or is it a video?"**
Reject an approval and let it re-plan. Or hand him the keyboard and let him write the
mission input. Nothing is pre-recorded.

**"How does it connect to our GCP?"**
Be straight: today the observability tools read a simulator, because we do not have
access to your project. The tool handlers are the adapter boundary — four functions.
Pointing them at Cloud Monitoring and Cloud Logging is a scoped piece of work, not a
redesign. Do not overclaim this; he will check.

**"What stops an agent doing something destructive?"**
Four layers, and they are worth showing rather than asserting:
1. **Least privilege per agent.** On the Fleet page, the log analyst has no filesystem
   tools at all; the code reviewer can read but not write.
2. **Only the orchestrator touches the outside world.** No specialist can file a
   ticket, open a pull request, or execute remediation - one accountable actor for
   every external side effect.
3. **High-impact actions are gated on a human**, and the gate lives inside the tool, so
   it holds no matter which agent calls it.
4. **A hard spend ceiling per mission**, after which the run aborts.

**"Can we change how an agent behaves?"**
Yes, live. Fleet page, click an agent, edit its prompt or swap its model, save - the
next mission uses it. They are standard Claude Code agent files in `.claude/agents/`,
so the same definitions also work from the Claude Code CLI. That is the honest answer
to "are we buying a black box".

**"What does this cost to run?"**
Per-mission cost is on every mission, measured, including subagents. Use the real
numbers on screen rather than a projection.

**"Can we deploy it in our VPC?"**
Yes — it is a Node service and a SQLite file behind nginx. It runs wherever you put it.

**"What about our robotics/warehouse side?"**
He said himself he does not know enough to scope it. Do not invent a story. Offer to
work it through with the team that owns it.

---

## Honest boundaries

Hold these lines. He is technical, he joined to assess exactly this, and being caught
overclaiming costs more than the feature is worth.

- The cloud telemetry is simulated. Say so before he asks.
- This is a demo built for this conversation, not a product with years of production
  mileage.
- The agents are genuinely doing the reasoning — that part is not staged, and it is the
  part worth defending.
