/**
 * Preflight check.
 *
 * Confirms the three things that must work before a demo, in order of how
 * expensive they are to discover broken on stage:
 *   1. the API key authenticates
 *   2. a subagent can be spawned and inherits the MCP tools it was scoped to
 *   3. the GitHub token can see the target repo
 *
 * Run:  npm run preflight
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Octokit } from '@octokit/rest';
import { config, hasAnthropicKey, hasGithubToken } from '../dashboard/server/config.ts';
import { changeMgmtServer, telemetryServer } from '../dashboard/server/tools/telemetry.ts';
import { createRunbookServer } from '../dashboard/server/tools/runbook.ts';
import { createGithubServer } from '../dashboard/server/tools/github.ts';
import { initDatabase } from '../dashboard/server/db/index.ts';
import { hydratePlatformModel, platformModel } from '../dashboard/server/models.ts';
import { seedAlerts } from '../dashboard/server/seed.ts';

const pass = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m: string) => console.log(`  \x1b[90m·\x1b[0m ${m}`);

let failures = 0;

console.log('\nBright Connect preflight\n');

/* ------------------------------------------------------------ 1. API key */

console.log('Anthropic');
if (!hasAnthropicKey()) {
  fail('ANTHROPIC_API_KEY is not set - nothing else can be checked');
  console.log('\n    Add it to .env and re-run.\n');
  process.exit(1);
}
pass(`key present (${config.anthropic.apiKey.slice(0, 12)}…)`);

/* ------------------------------------------------------------- 2. database */

/**
 * The telemetry tools read the alerts table, so the database has to be open
 * before any of this means anything. Without it the probe below "passes" while
 * every tool call fails - which is exactly the false green a pre-demo check
 * exists to prevent.
 */
console.log('\nDatabase');
try {
  const driver = await initDatabase();
  await hydratePlatformModel();
  await seedAlerts();
  pass(`connected: ${driver.describe()}`);
} catch (err) {
  fail(`cannot open the database: ${err instanceof Error ? err.message : err}`);
  failures++;
}

/* ------------------------------------------------- 3. every tool registers */

/**
 * One tool with a schema the harness cannot convert takes down its whole MCP
 * server, silently: the server still reports itself connected, and every tool
 * on it disappears. That cost a debugging session - the orchestrator was told
 * "No such tool available: mcp__runbook__execute_action" while the runbook
 * server looked healthy - so it is now checked before every demo.
 */
console.log('\nTool registration');

const EXPECTED: Record<string, string[]> = {
  telemetry: ['query_alerts', 'query_logs', 'query_metrics', 'describe_resource'],
  changemgmt: ['recent_changes', 'describe_change'],
  runbook: ['list_actions', 'execute_action'],
  github: ['get_repo_context', 'list_issues', 'create_issue', 'comment_issue', 'open_pull_request'],
};

let registered: string[] = [];
for await (const message of query({
  prompt: 'Reply with the single word: ready',
  options: {
    model: platformModel(),
    mcpServers: {
      telemetry: telemetryServer,
      changemgmt: changeMgmtServer,
      runbook: createRunbookServer({ missionId: 'preflight', actor: 'preflight' }),
      github: createGithubServer({ missionId: 'preflight', workspaceDir: '/tmp', actor: 'preflight' }),
    },
    settingSources: [],
    permissionMode: 'bypassPermissions',
    maxTurns: 1,
    maxBudgetUsd: 0.5,
    env: { ...process.env, ANTHROPIC_API_KEY: config.anthropic.apiKey },
  },
})) {
  if (message.type === 'system' && Array.isArray((message as any).tools)) {
    registered = (message as any).tools as string[];
  }
}

for (const [server, tools] of Object.entries(EXPECTED)) {
  const missing = tools.filter((t) => !registered.includes(`mcp__${server}__${t}`));
  if (missing.length === 0) pass(`${server}: all ${tools.length} tools registered`);
  else {
    fail(`${server}: ${missing.length}/${tools.length} MISSING - ${missing.join(', ')}`);
    failures++;
  }
}

/* ------------------------------------------------------------- 4. sandbox */

/**
 * Missions run sandboxed, and the sandbox has OS dependencies.
 *
 * On a box without bubblewrap and socat, every mission fails on its first turn
 * with "Sandbox required but unavailable" - while the dashboard serves happily
 * and every other check here passes. That combination is how a deployment ends
 * up looking healthy and being incapable of running a single agent, so the
 * sandbox is now exercised exactly as a mission configures it.
 */
console.log('\nSandbox');

const sandboxProbe = join(config.paths.data, 'preflight-sandbox');
mkdirSync(sandboxProbe, { recursive: true });

let sandboxOk = false;
let sandboxError = '';
try {
  for await (const message of query({
    prompt: 'Reply with the single word: ready',
    options: {
      model: platformModel(),
      cwd: sandboxProbe,
      settingSources: [],
      permissionMode: 'default',
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        filesystem: { allowWrite: [sandboxProbe] },
      },
      maxTurns: 1,
      maxBudgetUsd: 0.5,
      env: { ...process.env, ANTHROPIC_API_KEY: config.anthropic.apiKey },
    },
  })) {
    if (message.type === 'result') {
      if (message.subtype === 'success') sandboxOk = true;
      else sandboxError = (message as any).result ?? message.subtype;
    }
  }
} catch (err) {
  sandboxError = err instanceof Error ? err.message : String(err);
}

if (sandboxOk) {
  pass('sandbox available - missions can run');
} else {
  fail(`sandbox unavailable: ${sandboxError.slice(0, 200)}`);
  info('on Ubuntu: sudo apt-get install -y bubblewrap socat');
  failures++;
}

/* -------------------------------------- 5. subagent + MCP tool inheritance */

console.log('\nAgent fleet');
info('spawning a probe subagent that must call an MCP tool…');

const probe = {
  description: 'Preflight probe',
  prompt:
    'You are a preflight probe. Call the query_alerts tool exactly once with no filter, ' +
    'then reply with only the number of alerts it returned. Nothing else.',
  tools: ['mcp__telemetry__query_alerts'],
};

let sawSubagent = false;
let sawMcpCall = false;
let result = '';
let cost = 0;

try {
  for await (const message of query({
    prompt:
      'Delegate to the "probe" agent using the Agent tool with subagent_type "probe". ' +
      'Ask it to report how many alerts are currently firing. Then state that number and stop.',
    options: {
      model: platformModel(),
      agents: { probe },
      mcpServers: { telemetry: telemetryServer },
      settingSources: [],
      permissionMode: 'bypassPermissions',
      maxTurns: 12,
      maxBudgetUsd: 1,
      env: { ...process.env, ANTHROPIC_API_KEY: config.anthropic.apiKey },
    },
  })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content ?? []) {
        if (block.type === 'tool_use') {
          if (block.name === 'Agent' || block.name === 'Task') sawSubagent = true;
          if (block.name.startsWith('mcp__telemetry')) sawMcpCall = true;
        }
      }
    }
    if (message.type === 'result') {
      if (message.subtype === 'success') result = message.result;
      if ('total_cost_usd' in message) cost = message.total_cost_usd ?? 0;
    }
  }

  if (sawSubagent) pass('orchestrator delegated via the Agent tool');
  else { fail('orchestrator never delegated - check the agents option'); failures++; }

  if (sawMcpCall) pass('subagent reached its MCP tool (tool scoping works)');
  else { fail('no MCP tool call observed - subagents may not inherit mcpServers'); failures++; }

  if (/\b3\b/.test(result)) {
    pass(`probe read the environment correctly: "${result.trim().slice(0, 60)}"`);
  } else {
    fail(`probe could not read the environment: "${result.trim().slice(0, 90)}"`);
    failures++;
  }

  info(`probe cost $${cost.toFixed(4)}`);
} catch (err) {
  fail(`agent run failed: ${err instanceof Error ? err.message : String(err)}`);
  failures++;
}

/* -------------------------------------------------------------- 6. GitHub */

console.log('\nGitHub');
if (!hasGithubToken()) {
  info('no GITHUB_TOKEN - issues and PRs will be recorded locally and labelled unpublished');
} else {
  try {
    const gh = new Octokit({ auth: config.github.token });
    const repo = await gh.repos.get({ owner: config.github.owner, repo: config.github.repo });
    pass(`can read ${repo.data.full_name} (default branch: ${repo.data.default_branch})`);

    const perms = repo.data.permissions;
    if (perms?.push) pass('token has write access - PRs can be opened');
    else { fail('token is read-only - PRs will fail. Needs Contents/Issues/PRs: Read and write'); failures++; }
  } catch (err) {
    fail(`cannot reach ${config.github.owner}/${config.github.repo}: ${err instanceof Error ? err.message : String(err)}`);
    failures++;
  }
}

console.log(
  failures === 0
    ? '\n\x1b[32mReady.\x1b[0m All checks passed.\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m Fix before demoing.\n`,
);
process.exit(failures === 0 ? 0 : 1);
