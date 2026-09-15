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
import type { Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { provisionWorkspace } from '../workspace.ts';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { config, hasAnthropicKey } from '../config.ts';
import { agentDefinitions, loadFleet } from '../agents/fleet.ts';
import { platformModel } from '../models.ts';
import { agentRuns, alerts, approvals, artifacts, missions } from '../db/index.ts';
import { bus } from '../bus.ts';
import { createGithubServer } from '../tools/github.ts';
import { changeMgmtServer, telemetryServer } from '../tools/telemetry.ts';
import { createRunbookServer } from '../tools/runbook.ts';
import {
  incidentMissionPrompt, orchestratorSystemPrompt, reviewMissionPrompt,
  sdlcMissionPrompt, ticketMissionPrompt,
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

/** Tool inputs that name a filesystem path. */
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'cwd'];

/**
 * Confine filesystem tools to the mission workspace.
 *
 * Without this an agent writes into the platform's own source tree. It happened:
 * a backend engineer created server/metrics.ts in this repository, edited it,
 * added jest to package.json and ran npm install - which restarted the server
 * and killed its own mission. Agents are supposed to build in their workspace,
 * and the workspace is what becomes the pull request.
 */
/**
 * Where npm may write while a mission runs.
 *
 * Outside the workspace so it survives between missions, inside the sandbox's
 * allowWrite so npm can actually use it.
 */
const NPM_CACHE_DIR = join(config.paths.data, 'npm-cache');
mkdirSync(NPM_CACHE_DIR, { recursive: true });

/**
 * A home directory the sandboxed agents are allowed to have.
 *
 * The service account's real home is outside the sandbox, so every Bash call
 * opened with "/home/brightconnect/.bash_profile: Permission denied" - bash
 * looking for a login profile it is not allowed to stat. Harmless, and prefixed
 * to every command's output in the activity view, which is the part of this
 * platform people are meant to read.
 *
 * Safe to move because nothing in a mission depends on the real home: the API
 * key arrives through env, and pull requests are built through GitHub's git
 * data API rather than a local clone, so there is no ~/.gitconfig or credential
 * helper in the path.
 */
const AGENT_HOME_DIR = join(config.paths.data, 'agent-home');
mkdirSync(AGENT_HOME_DIR, { recursive: true });

/** Paths a shell names that are devices, not files in the workspace. */
const SHELL_DEVICES = new Set([
  '/dev/null', '/dev/zero', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/urandom',
]);

function escapesWorkspace(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir: string,
): string | null {
  const root = resolve(workspaceDir);
  const outside = (candidate: string): boolean => {
    const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
    const rel = relative(root, abs);
    return rel.startsWith('..') || isAbsolute(rel);
  };

  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.trim() && outside(value)) return value;
  }

  // Bash can name paths anywhere in the command string. Scanning a shell
  // command for paths is inherently approximate, so this errs towards allowing:
  // the sandbox below is the actual enforcement, and a false denial here breaks
  // legitimate work. (A workspace path containing a space - "New POC" - was
  // matched as the truncated "/path/with a/space/New" and denied, blocking
  // the agent from its own workspace.)
  if (toolName === 'Bash' && typeof input.command === 'string') {
    const command = input.command.replace(/\\ /g, ' ');
    for (const token of command.match(/\/(?:[\w.\-@+]|\/| (?=[\w.\-@+]))+/g) ?? []) {
      const candidate = token.trim();
      if (candidate.length <= 4) continue;
      // Character devices are not the filesystem. `2>/dev/null` is in half the
      // shell commands anyone writes, and denying it stopped the QA agent from
      // running the test suite at all. The first-segment check matters because
      // the pattern above tolerates spaces inside a path - so `> /dev/null 2>&1`
      // arrives here as the single token "/dev/null 2".
      if (SHELL_DEVICES.has(candidate) || SHELL_DEVICES.has(candidate.split(' ')[0])) continue;
      // A truncated match that the workspace path starts with is not an escape.
      if (root.startsWith(candidate)) continue;
      if (outside(candidate)) return candidate;
    }
  }
  return null;
}

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
  trigger?: Mission['trigger'];
  /** What in the outside world this answers, e.g. "issue#42". */
  sourceRef?: string | null;
}

export async function createMission(args: StartMissionArgs): Promise<Mission> {
  const mission = await missions.create({
    id: nanoid(10),
    kind: args.kind,
    title: args.title,
    input: args.input,
    alertId: args.alertId ?? null,
    trigger: args.trigger ?? 'manual',
    sourceRef: args.sourceRef ?? null,
  });
  bus.emitEvent({
    missionId: mission.id,
    type: 'mission.created',
    actor: 'system',
    text:
      `Mission created: ${mission.title}` +
      (mission.sourceRef ? ` (from ${mission.sourceRef})` : ''),
    data: { kind: mission.kind, trigger: mission.trigger, sourceRef: mission.sourceRef },
  });
  return mission;
}

/**
 * Execute a mission end to end. Resolves when the run finishes; callers
 * generally fire this without awaiting and watch the event stream instead.
 */
export async function runMission(missionId: string): Promise<void> {
  const mission = await missions.get(missionId);
  if (!mission) throw new Error(`No mission ${missionId}`);

  if (!hasAnthropicKey()) {
    const message =
      'ANTHROPIC_API_KEY is not configured, so the agent fleet cannot run. ' +
      'Set it in .env and restart the API.';
    await missions.finish(missionId, { status: 'failed', error: message });
    bus.emitEvent({ missionId, type: 'error', actor: 'system', text: message });
    bus.publish({ channel: 'mission', payload: { missionId, status: 'failed' } });
    return;
  }

  // The workspace is a working copy of the product, not an empty directory:
  // agents change real code, and the diff becomes the pull request.
  const { workspaceDir, filesCopied } = await provisionWorkspace(missionId, {
    title: mission.title,
    input: mission.input,
  });

  const abort = new AbortController();
  running.set(missionId, abort);
  registerMissionAbort(missionId, abort);
  await missions.setStatus(missionId, 'running');
  bus.publish({ channel: 'mission', payload: { missionId, status: 'running' } });
  bus.emitEvent({
    missionId,
    type: 'mission.started',
    actor: 'orchestrator',
    text:
      `Orchestrator engaged. Workspace provisioned with ${filesCopied} product file(s) ` +
      `from backend/ and frontend/.`,
    data: { workspaceDir, filesCopied },
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
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let numTurns = 0;
  let sessionId = '';

  // On an incident, nothing legitimately needs a shell: remediation goes through
  // the runbook tool so it passes the approval gate and lands in the audit trail.
  // Telling the orchestrator that in the prompt was not enough - it kept reaching
  // for kubectl, failing with exit 127, and closing the mission at a diagnosis.
  // Removing the tool is what actually holds.
  const disallowed =
    mission.kind === 'incident' ? [...DISALLOWED_TOOLS, 'Bash'] : DISALLOWED_TOOLS;

  /**
   * Containment only. The approval gate lives inside the gated tools, so this
   * callback stays fast and synchronous - it never blocks waiting on a human,
   * which is what made the earlier gate-in-canUseTool design fragile.
   */
  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const escaped = escapesWorkspace(toolName, input, workspaceDir);
    if (!escaped) return { behavior: 'allow' };

    bus.emitEvent({
      missionId,
      type: 'tool.result',
      actor: 'system',
      text: `Blocked ${toolName}: ${escaped} is outside the mission workspace`,
      data: { blocked: true, toolName, path: escaped },
    });
    return {
      behavior: 'deny',
      message:
        `Denied: ${escaped} is outside the mission workspace (${workspaceDir}). ` +
        `Build inside the workspace - its contents become the pull request. ` +
        `Never modify the platform's own source, and do not install packages globally.`,
    };
  };

  // OS-level containment.
  //
  // canUseTool is delivered for the main thread but not for subagent tool
  // calls, so a permission callback cannot confine the fleet - proven twice,
  // both times by a backend engineer writing server/metrics.ts into this
  // repository, adding jest to package.json, running npm install and
  // restarting the server mid-mission. The sandbox is enforced by the
  // operating system, so it holds for every agent regardless of how its tool
  // call was routed.
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  const sandbox = {
    enabled: true,
    // Never silently degrade to unsandboxed: a containment control that
    // quietly turns itself off is worse than not having one.
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      // The npm cache is shared across missions on purpose: per-workspace it
      // would re-download the dependency tree every run, and without it npm
      // cannot write at all - `npm ci` fails EPERM on the user's ~/.npm and the
      // QA agent never gets to run the tests, which is most of what it is for.
      allowWrite: [workspaceDir, NPM_CACHE_DIR, AGENT_HOME_DIR],
      denyWrite: [projectRoot],
    },
  };

  const options: Options = {
    model: platformModel(),
    systemPrompt: orchestratorSystemPrompt(workspaceDir),
    agents: agentDefinitions(),
    cwd: workspaceDir,
    // Keep the run isolated from whatever settings happen to exist on the host.
    settingSources: [],
    disallowedTools: disallowed,
    // 'default' plus a containment-only callback. bypassPermissions was a
    // mistake: it disables the SDK's own path sandbox, and an agent promptly
    // wrote into this repository.
    permissionMode: 'default',
    canUseTool,
    sandbox,
    abortController: abort,
    maxBudgetUsd: config.maxMissionCostUsd,
    /**
     * Medium, not high.
     *
     * The orchestrator delegates and reads results; it is not the one solving
     * the problem. On a 31-turn mission the extra reasoning per turn is paid
     * thirty-one times before any specialist starts work, and the decisions it
     * makes - which specialist, in what order - were not close calls. The
     * specialists keep their own effort setting, which is where the thinking
     * that matters happens.
     */
    effort: 'medium',
    mcpServers: {
      telemetry: telemetryServer,
      changemgmt: changeMgmtServer,
        runbook: createRunbookServer({ missionId, actor: 'orchestrator' }),
      github: createGithubServer({ missionId, workspaceDir, actor: 'orchestrator' }),
    },
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: config.anthropic.apiKey,
      // Point npm at the cache the sandbox allows, so an agent never has to
      // discover the problem and invent a --cache flag of its own.
      npm_config_cache: NPM_CACHE_DIR,
      HOME: AGENT_HOME_DIR,
    },
  };

  const prompt =
    mission.kind === 'incident'
      ? incidentMissionPrompt(mission.input)
      : mission.kind === 'ticket'
        ? ticketMissionPrompt(mission.input)
        : mission.kind === 'review'
          ? reviewMissionPrompt(mission.input)
          : sdlcMissionPrompt(mission.input);

  try {
    for await (const message of query({ prompt, options })) {
      handleMessage(message);
    }

    const status = finalResult ? 'succeeded' : 'failed';
    await missions.finish(missionId, {
      status,
      summary: finalResult || null,
      costUsd,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      numTurns,
      durationMs: Date.now() - started,
      sessionId,
    });
    await agentRuns.failAllRunning(missionId);
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
    await missions.finish(missionId, {
      status: aborted ? 'cancelled' : 'failed',
      error: aborted ? 'Cancelled by operator' : message,
      costUsd,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      numTurns,
      durationMs: Date.now() - started,
      sessionId,
    });
    await agentRuns.failAllRunning(missionId);
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
          void missions.setSession(missionId, sessionId);
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
          cacheReadTokens = 0;
          cacheWriteTokens = 0;
          for (const usage of Object.values(message.modelUsage)) {
            inputTokens += (usage as any).inputTokens ?? 0;
            outputTokens += (usage as any).outputTokens ?? 0;
            // Counted separately: cache reads are billed at a tenth of the
            // input rate, so folding them into inputTokens would make the
            // saving from prompt caching invisible in the analytics.
            cacheReadTokens += (usage as any).cacheReadInputTokens ?? 0;
            cacheWriteTokens += (usage as any).cacheCreationInputTokens ?? 0;
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
      void agentRuns.start({
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
      void agentRuns.finishByToolUseId(toolUseId, failed ? 'failed' : 'succeeded', raw.slice(0, 20_000));
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
export async function missionFromAlert(alertId: string): Promise<Mission | null> {
  const alert = await alerts.get(alertId);
  if (!alert) return null;
  const summary =
    `Alert: ${alert.id} - ${alert.title}\n` +
    `Severity: ${alert.severity}\n` +
    `Service: ${alert.service}\n` +
    `Resource: ${alert.resource}\n` +
    `Metric: ${alert.metric} observed ${alert.value} against threshold ${alert.threshold}\n` +
    `Fired at: ${alert.firedAt}\n\n${alert.description}`;
  await alerts.setStatus(alertId, 'acknowledged');
  return createMission({
    kind: 'incident',
    title: alert.title,
    input: summary,
    alertId,
    trigger: 'alert',
    sourceRef: alert.id,
  });
}

export { artifacts };
export { resolveApproval } from './approvals.ts';
