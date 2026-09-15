/**
 * Mission briefs.
 *
 * The orchestrator is a real planning agent, not a script: it decides which
 * specialists to engage and in what order. These prompts set the objective,
 * the standard of evidence, and the gates - then get out of the way.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { loadFleet, type Department, type FleetMember } from '../agents/fleet.ts';
import { projectMap } from '../workspace.ts';

const roster = (fleet: FleetMember[], d: Department) =>
  fleet
    .filter((m) => m.department === d)
    .map((m) => `  - ${m.id} — ${m.name}, ${m.title}: ${m.role}`)
    .join('\n');

/**
 * The orchestrator's own tools, by exact name.
 *
 * The fleet gets this and the orchestrator did not, which is why a mission
 * would announce "now executing the remediation" and then write a summary
 * instead: it never knew mcp__runbook__execute_action existed by name, and
 * nothing ever called list_actions.
 */
const ORCHESTRATOR_TOOLS = `
Your own tools, by exact name - these are yours to call directly:

  mcp__telemetry__query_alerts        what is firing
  mcp__telemetry__query_logs         platform and application logs
  mcp__telemetry__query_metrics       metric time series
  mcp__telemetry__describe_resource   resource config and state
  mcp__changemgmt__recent_changes     deploys, config changes, flags
  mcp__changemgmt__describe_change    one change in full, with its rollback
  mcp__runbook__list_actions          remediation actions and their blast radius
  mcp__runbook__execute_action        run one - PAUSES FOR HUMAN APPROVAL
  mcp__github__get_repo_context       repository state
  mcp__github__list_issues            existing tickets
  mcp__github__get_issue              one ticket in full - read this before working on it
  mcp__github__create_issue           file a ticket
  mcp__github__comment_issue          add to a ticket
  mcp__github__open_pull_request      open a PR - PAUSES FOR HUMAN APPROVAL
  mcp__github__merge_pull_request     land an approved PR - PAUSES FOR HUMAN APPROVAL
  mcp__github__close_issue            close a delivered ticket - PAUSES FOR HUMAN APPROVAL

  Agent                               delegate to a specialist
  Read, Write, Edit, Glob, Grep       the mission workspace

Do not guess at other names.
`.trim();

/**
 * The orchestrator's brief, on disk rather than in this file.
 *
 * The fleet's nineteen prompts have always been editable from the dashboard;
 * the one belonging to the agent that decides what the other nineteen do was
 * the exception, buried in source. It reads from a markdown file for the same
 * reason they do - so it can be changed, reviewed and rolled back without a
 * deploy.
 */
export const ORCHESTRATOR_FILE = fileURLToPath(new URL('./orchestrator.md', import.meta.url));

export const readOrchestratorPrompt = (): string => readFileSync(ORCHESTRATOR_FILE, 'utf8');

/** The placeholders the file may use, and what each one expands to. */
export const ORCHESTRATOR_PLACEHOLDERS = [
  { token: '{{ROSTER_SDLC}}', describes: 'the software delivery agents, generated' },
  { token: '{{ROSTER_SRE}}', describes: 'the site reliability agents, generated' },
  { token: '{{ROSTER_PLATFORM}}', describes: 'the platform agents, generated' },
  { token: '{{TOOLS}}', describes: "the orchestrator's own tools, by exact name" },
  { token: '{{PROJECT_MAP}}', describes: 'the layout of the codebase it maintains' },
] as const;

/** Substitute the generated sections into the edited brief. */
function expand(template: string): string {
  const fleet = loadFleet();
  return template
    .replaceAll('{{ROSTER_SDLC}}', roster(fleet, 'sdlc'))
    .replaceAll('{{ROSTER_SRE}}', roster(fleet, 'sre'))
    .replaceAll('{{ROSTER_PLATFORM}}', roster(fleet, 'platform'))
    .replaceAll('{{TOOLS}}', ORCHESTRATOR_TOOLS)
    .replaceAll('{{PROJECT_MAP}}', projectMap());
}

/**
 * Reject an edit that would break a mission before it is saved, the way the
 * agent editor does. A brief that never names the Agent tool produces an
 * orchestrator that quietly does all nineteen jobs itself.
 */
export function validateOrchestratorPrompt(content: string): { ok: boolean; error?: string } {
  if (!content.trim()) return { ok: false, error: 'The brief cannot be empty' };
  const unknown = [...content.matchAll(/\{\{([A-Z_]+)\}\}/g)]
    .map((m) => m[0])
    .filter((t) => !ORCHESTRATOR_PLACEHOLDERS.some((p) => p.token === t));
  if (unknown.length) {
    return { ok: false, error: `Unknown placeholder: ${[...new Set(unknown)].join(', ')}` };
  }
  for (const required of ['{{ROSTER_SDLC}}', '{{TOOLS}}'] as const) {
    if (!content.includes(required)) {
      return { ok: false, error: `${required} is missing - without it the orchestrator cannot see what it can call` };
    }
  }
  return { ok: true };
}

/** Save an edited brief, after checking it. */
export function writeOrchestratorPrompt(content: string): string {
  const check = validateOrchestratorPrompt(content);
  if (!check.ok) throw new Error(check.error);
  writeFileSync(ORCHESTRATOR_FILE, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  return content;
}

/**
 * The orchestrator's system prompt, split for the prompt cache.
 *
 * Everything before SYSTEM_PROMPT_DYNAMIC_BOUNDARY is identical for every
 * mission, so the API can serve it from cache instead of re-reading it - about
 * 3,300 tokens of roster, rules and tool names that used to be billed in full
 * on the first turn of every run. The only per-mission fact, the workspace
 * path, goes after the marker where it cannot invalidate the prefix.
 */
export function orchestratorSystemPrompt(workspaceDir: string): string[] {
  return [
    expand(readOrchestratorPrompt()).trim(),
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    `This mission's workspace is ${workspaceDir}. Read and write there.`,
  ];
}

export function sdlcMissionPrompt(spec: string): string {
  return `New software delivery mission.

Take the specification below from intake to a pull request that a human can
approve or reject. That means: understand what is being asked, design it,
build it, test it, document it, review it for correctness and security, and
assemble it into a reviewable pull request.

Engage the specialists you judge necessary - you are accountable for the outcome,
not for using every agent available. Independent work should run concurrently.

The human's only required decision is the go/no-go on the pull request. Get them
to that decision with everything they need to make it.

--- SPECIFICATION ---
${spec}
--- END SPECIFICATION ---`;
}

export function incidentMissionPrompt(alertSummary: string): string {
  return `Production incident. Treat this as live.

An alert is firing on a tier-1, revenue-critical service. Your objective is to
establish the root cause from evidence, get a ticket filed that a human can act
on, and propose remediation - then execute it once approved and verify it worked.

Start the investigations that do not depend on each other at the same time:
logs, resource configuration, and recent changes are three independent lines of
enquiry and should run concurrently. Serialising them costs real minutes of
customer impact.

Hold a high bar on causation. A deploy that landed shortly before the first error
is a strong lead, not a conclusion - confirm the mechanism. Say so plainly if the
evidence does not support a confident answer.

Assess impact against the service's RPO and RTO targets, and state whether they
are at risk.

--- ALERT ---
${alertSummary}
--- END ALERT ---`;
}

export function ticketMissionPrompt(issue: string): string {
  return `A ticket has been assigned to the fleet. Resolve it.

This did not come from a person clicking a button - it arrived from GitHub, and
the team that filed it expects to see the answer back on the ticket, not in a
dashboard they do not use.

Take it from the issue as written to a pull request that closes it:
understand what is being asked, decide whether it is well enough specified to
build, design it, build it, test it, document it, review it, and assemble it
into a pull request that references the issue.

Two judgement calls are yours to make:
- If the issue is too vague to build from, do not guess. Comment on the issue
  with the specific questions that would unblock it, and stop. A confident
  implementation of the wrong thing wastes more of their time than a question.
- If the issue is a question rather than a change request, answer it on the
  issue and stop. Not every ticket needs code.

When you open the pull request, reference the issue number so it closes on
merge, and comment on the issue with a one-line summary and the link.

--- TICKET ---
${issue}
--- END TICKET ---`;
}

export function reviewMissionPrompt(pr: string): string {
  return `A pull request is open and needs review.

Review it the way a good staff engineer would: correctness first, then security,
then maintainability. Engage the specialists for the dimensions that matter -
the code reviewer and the security reviewer both hold this scope.

Read the change before judging it. If you cannot see the diff through the tools
you have, say so plainly rather than reviewing the description and presenting it
as a review of the code.

Post your findings as a comment on the pull request. For each one give the file,
the line, what breaks, and a concrete failure scenario. Approve explicitly when
the change is sound - a review that never approves anything gets ignored, and so
does one that never finds anything.

--- PULL REQUEST ---
${pr}
--- END PULL REQUEST ---`;
}

/** Compact fleet reference used by the UI. */
export const fleetSummary = () =>
  loadFleet().map((m) => ({
    id: m.id,
    name: m.name,
    title: m.title,
    department: m.department,
    role: m.role,
    description: m.definition.description,
    tools: m.definition.tools ?? [],
  }));
