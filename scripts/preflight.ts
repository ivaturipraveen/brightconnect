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
import { Octokit } from '@octokit/rest';
import { config, hasAnthropicKey, hasGithubToken } from '../server/config.ts';
import { telemetryServer } from '../server/tools/telemetry.ts';

const pass = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m: string) => console.log(`  \x1b[90m·\x1b[0m ${m}`);

let failures = 0;

console.log('\nBrightworks preflight\n');

/* ------------------------------------------------------------ 1. API key */

console.log('Anthropic');
if (!hasAnthropicKey()) {
  fail('ANTHROPIC_API_KEY is not set - nothing else can be checked');
  console.log('\n    Add it to .env and re-run.\n');
  process.exit(1);
}
pass(`key present (${config.anthropic.apiKey.slice(0, 12)}…)`);

/* -------------------------------------- 2. subagent + MCP tool inheritance */

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
      model: config.anthropic.orchestratorModel,
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

  if (result.includes('3')) pass(`probe read the environment correctly: "${result.trim().slice(0, 60)}"`);
  else info(`probe replied: "${result.trim().slice(0, 80)}"`);

  info(`probe cost $${cost.toFixed(4)}`);
} catch (err) {
  fail(`agent run failed: ${err instanceof Error ? err.message : String(err)}`);
  failures++;
}

/* -------------------------------------------------------------- 3. GitHub */

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
