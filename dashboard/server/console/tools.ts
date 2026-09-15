/**
 * Tools for the console agent - the conversational front door to the platform.
 *
 * This agent is not the orchestrator. It answers questions about what the
 * platform is doing, and when someone asks for work rather than an answer, it
 * starts a mission and hands off. Keeping those separate matters: the
 * orchestrator should be deciding how to build something, not deciding whether
 * the person meant to ask a question.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { agentRuns, alerts, approvals, artifacts, missions } from '../db/index.ts';
import { loadFleet } from '../agents/fleet.ts';
import { Octokit } from '@octokit/rest';
import { config, hasGithubToken } from '../config.ts';
import type { MissionKind } from '../types.ts';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export interface ConsoleContext {
  /** Starts a mission and returns its id. */
  launch: (args: { kind: MissionKind; title: string; input: string }) => Promise<string>;
  /** Files the user attached to this conversation, already saved to disk. */
  attachments: Array<{ name: string; path: string; type: string }>;
}

/** Read-only GitHub client, or null when no token is configured. */
const octokit = (): Octokit | null =>
  hasGithubToken() ? new Octokit({ auth: config.github.token }) : null;

export function createConsoleServer(ctx: ConsoleContext) {
  const listMissions = tool(
    'list_missions',
    'List recent missions with their status, cost and what triggered them. Use this to answer questions about what the platform has been doing.',
    {
      status: z.enum(['active', 'finished', 'all']).optional()
        .describe('active = running or waiting on a human. Defaults to all.'),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ status, limit }) => {
      let rows = await missions.list(limit ?? 20);
      if (status === 'active') {
        rows = rows.filter((m) => ['queued', 'running', 'awaiting_approval'].includes(m.status));
      } else if (status === 'finished') {
        rows = rows.filter((m) => ['succeeded', 'failed', 'cancelled'].includes(m.status));
      }
      if (rows.length === 0) return text('No missions match that.');
      return text(
        rows
          .map(
            (m) =>
              `${m.id}  [${m.status}]  ${m.kind}  "${m.title}"\n` +
              `   trigger=${m.trigger}${m.sourceRef ? ` source=${m.sourceRef}` : ''} ` +
              `cost=$${m.costUsd.toFixed(3)} duration=${Math.round(m.durationMs / 1000)}s`,
          )
          .join('\n'),
      );
    },
  );

  const describeMission = tool(
    'describe_mission',
    'Everything about one mission: which specialists ran, what they produced, what is waiting on a human.',
    { id: z.string().describe('Mission id.') },
    async ({ id }) => {
      const mission = await missions.get(id);
      if (!mission) return text(`No mission ${id}.`);
      const [runs, appr, arts] = await Promise.all([
        agentRuns.listByMission(id),
        approvals.listByMission(id),
        artifacts.listByMission(id),
      ]);
      return text(
        `${mission.title}\n` +
          `status=${mission.status} kind=${mission.kind} trigger=${mission.trigger}\n` +
          `cost=$${mission.costUsd.toFixed(3)} turns=${mission.numTurns} duration=${Math.round(mission.durationMs / 1000)}s\n\n` +
          `Specialists engaged:\n` +
          (runs.map((r) => `  [${r.status}] ${r.agentType}${r.task ? ` - ${r.task.slice(0, 80)}` : ''}`).join('\n') || '  (none yet)') +
          `\n\nProduced:\n` +
          (arts.map((a) => `  ${a.kind}: ${a.title}${a.url ? ` (${a.url})` : ' (recorded locally)'}`).join('\n') || '  (nothing yet)') +
          `\n\nAwaiting a human:\n` +
          (appr.filter((a) => a.status === 'pending').map((a) => `  ${a.summary}`).join('\n') || '  (nothing)') +
          (mission.summary ? `\n\nOutcome:\n${mission.summary.slice(0, 2000)}` : ''),
      );
    },
  );

  const describeFleet = tool(
    'describe_fleet',
    'The specialists available, what each does, and which tools they hold. Use this to answer "what can you do".',
    {},
    async () => {
      const fleet = loadFleet();
      const byDept = new Map<string, typeof fleet>();
      for (const m of fleet) {
        byDept.set(m.department, [...(byDept.get(m.department) ?? []), m]);
      }
      return text(
        [...byDept.entries()]
          .map(([dept, members]) =>
            `${dept}:\n` + members.map((m) => `  ${m.id} (${m.name}, ${m.title}) - ${m.role}`).join('\n'),
          )
          .join('\n\n'),
      );
    },
  );

  const platformStatus = tool(
    'platform_status',
    'A snapshot: active missions, firing alerts, and anything waiting on a human decision.',
    {},
    async () => {
      const [all, firing, pending] = await Promise.all([
        missions.list(100),
        alerts.list(),
        approvals.listPending(),
      ]);
      const active = all.filter((m) => ['queued', 'running', 'awaiting_approval'].includes(m.status));
      return text(
        `Missions: ${active.length} active, ${all.length} total\n` +
          (active.map((m) => `  [${m.status}] ${m.id} "${m.title}"`).join('\n') || '  (none running)') +
          `\n\nAlerts firing: ${firing.filter((a) => a.status === 'firing').length}\n` +
          (firing.filter((a) => a.status === 'firing').map((a) => `  [${a.severity}] ${a.id} ${a.title}`).join('\n') || '  (none)') +
          `\n\nWaiting on a human: ${pending.length}\n` +
          (pending.map((a) => `  ${a.summary} (mission ${a.missionId})`).join('\n') || '  (nothing)'),
      );
    },
  );

  const launchMission = tool(
    'launch_mission',
    'Start a mission. Use this when the person is asking for work to be done rather than asking a question - building a feature, fixing a bug, changing the UI, investigating an incident. Returns the mission id immediately; the work then runs on its own.',
    {
      kind: z.enum(['sdlc', 'incident', 'ticket', 'review'])
        .describe('sdlc = build or change something. incident = investigate a production problem. ticket = resolve a filed issue. review = review a pull request.'),
      title: z.string().describe('Short, specific title. This is what appears in the mission list.'),
      brief: z.string().describe(
        'The full brief for the fleet. Expand what the person asked for into something a team could build from: what is wanted, what done looks like, and any constraint they mentioned. Do not invent requirements they did not state - if something important is genuinely unspecified, say so in the brief as an open question.',
      ),
    },
    async ({ kind, title, brief }) => {
      const attachmentNote = ctx.attachments.length
        ? `\n\n--- ATTACHED FILES ---\n` +
          ctx.attachments.map((a) => `${a.name} (${a.type}) - readable at ${a.path}`).join('\n')
        : '';
      const id = await ctx.launch({ kind, title, input: brief + attachmentNote });
      return text(
        `Mission ${id} started: "${title}" (${kind}).\n` +
          `It is running now - the flow view shows which specialists are engaged. ` +
          `Anything that changes the outside world will stop and ask for approval.`,
      );
    },
  );

  /**
   * Read a ticket the person is referring to.
   *
   * Asked to "fix issue 6 and raise a PR" the console had no way to find out
   * what issue 6 said, so it asked the person to paste the description back -
   * which is exactly the work they were delegating. Read-only on purpose: the
   * console dispatches missions, and everything that changes the outside world
   * stays with the orchestrator behind the approval gates.
   */
  const readIssue = tool(
    'read_issue',
    'Read one GitHub issue by number, so you can write the brief from it. Use this whenever someone refers to an issue, a ticket or a number like "#6".',
    {
      number: z.number().int().positive().describe('The issue number, e.g. 6.'),
    },
    async ({ number }) => {
      const gh = octokit();
      if (!gh) {
        return text('No GitHub token is configured, so issues cannot be read. Ask the person to paste the description.');
      }
      try {
        const { data } = await gh.issues.get({
          owner: config.github.owner,
          repo: config.github.repo,
          issue_number: number,
        });
        if (data.pull_request) {
          return text(`#${number} is a pull request, not an issue: "${data.title}" (${data.html_url}).`);
        }
        const labels = (data.labels ?? [])
          .map((l) => (typeof l === 'string' ? l : l.name))
          .filter(Boolean)
          .join(', ');
        return text(
          [
            `Issue #${data.number} [${data.state}] ${data.title}`,
            `Labels: ${labels || 'none'}`,
            `URL: ${data.html_url}`,
            '',
            data.body?.trim() || '(no description)',
          ].join('\n'),
        );
      } catch (err: any) {
        if (err?.status === 404) {
          return text(`Issue #${number} does not exist in ${config.github.owner}/${config.github.repo}.`);
        }
        return text(`Could not read issue #${number}: ${err?.message ?? String(err)}`);
      }
    },
  );

  const listOpenIssues = tool(
    'list_open_issues',
    'List the open issues in the repository, so you can find the one someone is describing without a number.',
    {},
    async () => {
      const gh = octokit();
      if (!gh) return text('No GitHub token is configured, so issues cannot be listed.');
      const { data } = await gh.issues.listForRepo({
        owner: config.github.owner,
        repo: config.github.repo,
        state: 'open',
        per_page: 20,
      });
      const issues = data.filter((i) => !i.pull_request);
      return text(
        issues.length
          ? issues.map((i) => `#${i.number} ${i.title}`).join('\n')
          : 'No open issues.',
      );
    },
  );

  const readAttachment = tool(
    'read_attachment',
    'Read a file the person attached to this conversation. Use it before answering questions about an attached document.',
    { name: z.string().describe('The file name, as listed in the conversation.') },
    async ({ name }) => {
      const file = ctx.attachments.find((a) => a.name === name);
      if (!file) {
        return text(
          ctx.attachments.length
            ? `No attachment named "${name}". Attached: ${ctx.attachments.map((a) => a.name).join(', ')}`
            : 'Nothing is attached to this conversation.',
        );
      }
      return text(`${file.name} is at ${file.path}. Use the Read tool to open it.`);
    },
  );

  return createSdkMcpServer({
    name: 'platform',
    version: '1.0.0',
    instructions:
      'Read the platform state, and start missions when someone asks for work to be done.',
    tools: [
      listMissions, describeMission, describeFleet, platformStatus,
      readIssue, listOpenIssues, launchMission, readAttachment,
    ],
  });
}
