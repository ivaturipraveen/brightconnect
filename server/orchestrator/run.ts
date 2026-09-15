/**
 * The mission runner.
 *
 * Drives one Claude Agent SDK query per mission, translates the message stream
 * into the governance trail, and implements the human approval gate.
 *
 * The fan-out shown in the UI is the model genuinely delegating via the Agent
 * tool - we observe those delegations here rather than scripting them.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import { config, hasAnthropicKey } from '../config.ts';
import { agentDefinitions, loadFleet } from '../agents/fleet.ts';
import { agentRuns, alerts, approvals, artifacts, missions } from '../db.ts';
import { bus } from '../bus.ts';
import { createGithubServer } from '../tools/github.ts';
import { changeMgmtServer, telemetryServer } from '../tools/telemetry.ts';
import { createRunbookServer } from '../tools/runbook.ts';
import {
  incidentMissionPrompt, orchestratorSystemPrompt, sdlcMissionPrompt,
} from './prompts.ts';
import {
  registerMissionAbort, releaseMissionAbort, resolveApproval,
} from './approvals.ts';
import type { Mission } from '../types.ts';

/** Tools that always require a human decision before they run. */
const GATED_TOOLS = new Set([
  'mcp__github__open_pull_request',
  'mcp__runbook__execute_action',
]);

/**
 * Built-ins that have no place in a mission. Left enabled they burn turns and
 * clutter the activity feed - agents reached for ListAgents and ToolSearch
 * during testing, neither of which means anything here.
 */
const DISALLOWED_TOOLS = [
  // Agent-to-agent and session plumbing
  'ListAgents', 'SendMessage', 'TaskOutput', 'TaskStop', 'KillShell',
  // Discovery and outside-world access - the fleet works from its own tools
  'ToolSearch', 'WebSearch', 'WebFetch', 'Skill',
  // Host integrations that mean nothing inside a mission
  'PushNotification', 'ScheduleWakeup', 'SendFeedback', 'Workflow',
  'DesignSync', 'RemoteTrigger', 'Monitor', 'ReportFindings',
  'ShareOnboardingGuide', 'Artifact', 'NotebookEdit', 'LSP',
  'EnterWorktree', 'ExitWorktree', 'EnterPlanMode', 'ExitPlanMode',
  'CronCreate', 'CronList', 'CronDelete',
];

/** Missions currently executing, so they can be cancelled. */
const running = new Map<string, AbortController>();

export const isRunning = (missionId: string) => running.has(missionId);

export function cancelMission(missionId: string): boolean {
  const ctrl = running.get(missionId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

export interface StartMissionArgs {
  kind: Mission['kind'];
  title: string;
  input: string;
  alertId?: string | null;
}

export function createMission(args: StartMissionArgs): Mission {
  const mission = missions.create({
    id: nanoid(10),
    kind: args.kind,
    title: args.title,
    input: args.input,
    alertId: args.alertId ?? null,
  });
  bus.emitEvent({
    missionId: mission.id,
    type: 'mission.created',
    actor: 'system',
    text: `Mission created: ${mission.title}`,
    data: { kind: mission.kind },
  });
  return mission;
}

/**
 * Execute a mission end to end. Resolves when the run finishes; callers
 * generally fire this without awaiting and watch the event stream instead.
 */
export async function runMission(missionId: string): Promise<void> {
  const mission = missions.get(missionId);
  if (!mission) throw new Error(`No mission ${missionId}`);

  if (!hasAnthropicKey()) {
    const message =
      'ANTHROPIC_API_KEY is not configured, so the agent fleet cannot run. ' +
      'Set it in .env and restart the API.';
    missions.finish(missionId, { status: 'failed', error: message });
    bus.emitEvent({ missionId, type: 'error', actor: 'system', text: message });
    bus.publish({ channel: 'mission', payload: { missionId, status: 'failed' } });
    return;
  }

  const workspaceDir = join(config.paths.workspaces, missionId);
  await mkdir(workspaceDir, { recursive: true });
  // Seed the workspace so agents have the mission brief on disk as well as in
  // context - useful when a specialist needs to re-read the original ask.
  await writeFile(join(workspaceDir, 'MISSION.md'), `# ${mission.title}\n\n${mission.input}\n`, 'utf8');

  const abort = new AbortController();
  running.set(missionId, abort);
  registerMissionAbort(missionId, abort);
  missions.setStatus(missionId, 'running');
  bus.publish({ channel: 'mission', payload: { missionId, status: 'running' } });
  bus.emitEvent({
    missionId,
    type: 'mission.started',
    actor: 'orchestrator',
    text: `Orchestrator engaged. Workspace ${workspaceDir}`,
  });

  // Snapshot the fleet once per mission: definitions are read from disk, and a
  // mid-mission edit should not change the agents this run is using.
  const fleetSnapshot = new Map(loadFleet().map((m) => [m.id, m]));

  /** toolUseId -> fleet member id, so we can attribute messages to an agent. */
  const agentByToolUse = new Map<string, string>();
  const actorFor = (parentToolUseId: string | null | undefined) =>
    (parentToolUseId && agentByToolUse.get(parentToolUseId)) || 'orchestrator';

  const started = Date.now();
  let finalResult = '';
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let numTurns = 0;
  let sessionId = '';

  const options: Options = {
    model: config.anthropic.orchestratorModel,
    systemPrompt: orchestratorSystemPrompt(workspaceDir),
    agents: agentDefinitions(),
    cwd: workspaceDir,
    // Keep the run isolated from whatever settings happen to exist on the host.
    settingSources: [],
    disallowedTools: DISALLOWED_TOOLS,
    // The approval gate lives inside the gated tools (see orchestrator/approvals.ts),
    // not in a permission callback: canUseTool is not reliably delivered for
    // subagent tool calls, and a gate that silently stops firing is worse than
    // no gate. Subagents get their scope from each agent's `tools` list instead.
    permissionMode: 'bypassPermissions',
    abortController: abort,
    maxBudgetUsd: config.maxMissionCostUsd,
    effort: 'high',
    mcpServers: {
      telemetry: telemetryServer,
      changemgmt: changeMgmtServer,
        runbook: createRunbookServer({ missionId, actor: 'orchestrator' }),
      github: createGithubServer({ missionId, workspaceDir, actor: 'orchestrator' }),
    },
    env: { ...process.env, ANTHROPIC_API_KEY: config.anthropic.apiKey },
  };

  const prompt =
    mission.kind === 'incident'
      ? incidentMissionPrompt(mission.input)
      : sdlcMissionPrompt(mission.input);

  try {
    for await (const message of query({ prompt, options })) {
      handleMessage(message);
    }

    const status = finalResult ? 'succeeded' : 'failed';
    missions.finish(missionId, {
      status,
      summary: finalResult || null,
      costUsd,
      inputTokens,
      outputTokens,
      numTurns,
      durationMs: Date.now() - started,
      sessionId,
    });
    agentRuns.failAllRunning(missionId);
    bus.emitEvent({
      missionId,
      type: 'mission.finished',
      actor: 'orchestrator',
      text: finalResult || 'Mission ended without a result.',
      data: { costUsd, numTurns, durationMs: Date.now() - started },
    });
    bus.publish({ channel: 'mission', payload: { missionId, status } });
  } catch (err) {
    const aborted = abort.signal.aborted;
    const message = err instanceof Error ? err.message : String(err);
    missions.finish(missionId, {
      status: aborted ? 'cancelled' : 'failed',
      error: aborted ? 'Cancelled by operator' : message,
      costUsd,
      inputTokens,
      outputTokens,
      numTurns,
      durationMs: Date.now() - started,
      sessionId,
    });
    agentRuns.failAllRunning(missionId);
    bus.emitEvent({
      missionId,
      type: aborted ? 'mission.finished' : 'error',
      actor: 'system',
      text: aborted ? 'Mission cancelled by operator.' : `Mission failed: ${message}`,
    });
    bus.publish({
      channel: 'mission',
      payload: { missionId, status: aborted ? 'cancelled' : 'failed' },
    });
  } finally {
    running.delete(missionId);
    releaseMissionAbort(missionId);
  }

  /* --------------------------------------------------- stream translation */

  function handleMessage(message: SDKMessage) {
    switch (message.type) {
      case 'system': {
        if ('session_id' in message && message.session_id) {
          sessionId = message.session_id;
          missions.setSession(missionId, sessionId);
        }
        return;
      }

      case 'assistant': {
        const actor = actorFor(message.parent_tool_use_id);
        for (const block of message.message.content ?? []) {
          if (block.type === 'text' && block.text.trim()) {
            bus.emitEvent({ missionId, type: 'agent.message', actor, text: block.text });
          } else if (block.type === 'thinking' && 'thinking' in block && block.thinking?.trim()) {
            bus.emitEvent({ missionId, type: 'agent.thinking', actor, text: block.thinking });
          } else if (block.type === 'tool_use') {
            onToolUse(actor, block.id, block.name, block.input as Record<string, unknown>);
          }
        }
        return;
      }

      case 'user': {
        // Tool results arrive as user messages in the SDK stream.
        const content = message.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          onToolResult(block.tool_use_id, block);
        }
        return;
      }

      case 'result': {
        if (message.subtype === 'success') {
          finalResult = message.result;
          numTurns = message.num_turns;
        }
        if ('total_cost_usd' in message) costUsd = message.total_cost_usd ?? 0;
        // modelUsage covers subagents too, which `usage` does not.
        if ('modelUsage' in message && message.modelUsage) {
          inputTokens = 0;
          outputTokens = 0;
          for (const usage of Object.values(message.modelUsage)) {
            inputTokens += (usage as any).inputTokens ?? 0;
            outputTokens += (usage as any).outputTokens ?? 0;
          }
        }
        return;
      }

      default:
        return;
    }
  }

  function onToolUse(
    actor: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
  ) {
    // A delegation: the orchestrator engaging a specialist.
    if (toolName === 'Agent' || toolName === 'Task') {
      const agentType = String(input.subagent_type ?? 'unknown');
      const member = fleetSnapshot.get(agentType);
      agentByToolUse.set(toolUseId, agentType);
      agentRuns.start({
        id: nanoid(10),
        missionId,
        agentType,
        toolUseId,
        task: String(input.description ?? input.prompt ?? '').slice(0, 500),
      });
      bus.emitEvent({
        missionId,
        type: 'agent.spawned',
        actor,
        text: `Engaged ${member?.name ?? agentType}: ${input.description ?? ''}`,
        data: { agentType, toolUseId, task: input.description },
      });
      return;
    }

    bus.emitEvent({
      missionId,
      type: 'tool.called',
      actor,
      text: toolLabel(toolName, input),
      data: { toolName, input },
    });
  }

  function onToolResult(toolUseId: string, block: any) {
    const agentType = agentByToolUse.get(toolUseId);
    const raw = Array.isArray(block.content)
      ? block.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      : typeof block.content === 'string'
        ? block.content
        : '';

    if (agentType) {
      const failed = Boolean(block.is_error);
      agentRuns.finishByToolUseId(toolUseId, failed ? 'failed' : 'succeeded', raw.slice(0, 20_000));
      const member = fleetSnapshot.get(agentType);
      bus.emitEvent({
        missionId,
        type: 'agent.finished',
        actor: agentType,
        text: `${member?.name ?? agentType} ${failed ? 'failed' : 'reported back'}`,
        data: { agentType, toolUseId, resultPreview: raw.slice(0, 4000), failed },
      });
      return;
    }

    bus.emitEvent({
      missionId,
      type: 'tool.result',
      actor: 'system',
      text: raw.slice(0, 2000),
      data: { toolUseId, isError: Boolean(block.is_error) },
    });
  }
}

/** Short, readable label for a tool call in the activity feed. */
function toolLabel(toolName: string, input: Record<string, unknown>): string {
  const short = toolName.replace(/^mcp__/, '').replace(/__/g, '.');
  const detail =
    input.metric ??
    input.name ??
    input.title ??
    input.actionId ??
    input.contains ??
    input.service ??
    input.file_path ??
    input.id ??
    '';
  return detail ? `${short} - ${String(detail).slice(0, 120)}` : short;
}

/** Fire a mission off in the background and return immediately. */
export function startMissionInBackground(missionId: string) {
  void runMission(missionId).catch((err) => {
    bus.emitEvent({
      missionId,
      type: 'error',
      actor: 'system',
      text: `Runner crashed: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
}

/** Turn a firing alert into an incident mission. */
export function missionFromAlert(alertId: string): Mission | null {
  const alert = alerts.get(alertId);
  if (!alert) return null;
  const summary =
    `Alert: ${alert.id} - ${alert.title}\n` +
    `Severity: ${alert.severity}\n` +
    `Service: ${alert.service}\n` +
    `Resource: ${alert.resource}\n` +
    `Metric: ${alert.metric} observed ${alert.value} against threshold ${alert.threshold}\n` +
    `Fired at: ${alert.firedAt}\n\n${alert.description}`;
  alerts.setStatus(alertId, 'acknowledged');
  return createMission({
    kind: 'incident',
    title: alert.title,
    input: summary,
    alertId,
  });
}

export { artifacts };
export { resolveApproval } from './approvals.ts';
