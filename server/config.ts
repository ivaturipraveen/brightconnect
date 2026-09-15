/**
 * Central configuration. Everything the demo needs to be re-pointed at a
 * different customer, repo, or model lives here and nowhere else.
 */

import { fileURLToPath } from 'node:url';

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  port: Number(env('PORT', '8787')),
  nodeEnv: env('NODE_ENV', 'development'),

  /** Display name shown throughout the UI. One line to rebrand. */
  productName: env('PRODUCT_NAME', 'Brightworks'),
  customerName: env('CUSTOMER_NAME', 'Exol'),

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    /** The agent that plans the mission and delegates to the fleet. */
    orchestratorModel: env('ORCHESTRATOR_MODEL', 'claude-opus-5'),
    /** Default model for fleet members. Overridable per agent. */
    agentModel: env('AGENT_MODEL', 'claude-opus-5'),
  },

  github: {
    token: process.env.GITHUB_TOKEN ?? '',
    owner: env('GITHUB_OWNER', 'ivaturipraveen'),
    repo: env('GITHUB_REPO', 'brightconnect'),
  },

  /**
   * Hard ceiling per mission. The SDK aborts the run if the estimated spend
   * crosses this, so a runaway agent cannot burn the account during a demo.
   */
  maxMissionCostUsd: Number(env('MAX_MISSION_COST_USD', '5')),

  paths: {
    // fileURLToPath, not URL.pathname: pathname percent-encodes, so a repo
    // checked out under a path containing a space silently writes to a
    // directory literally named "New%20POC".
    data: fileURLToPath(new URL('../data/', import.meta.url)),
    workspaces: fileURLToPath(new URL('../workspaces/', import.meta.url)),
  },
} as const;

/**
 * A copied .env.example leaves literal placeholders behind. Treat those as
 * missing: failing fast with "no key" is far better than a doomed API call
 * that hangs on retries, which is how this is usually discovered.
 */
const isPlaceholder = (v: string) =>
  v.length === 0 || /^(sk-ant-\.{3}|github_pat_\.{3}|\.{3}|changeme|your[-_]?\w*)$/i.test(v.trim()) || v.trim().endsWith('...');

export const hasAnthropicKey = () => !isPlaceholder(config.anthropic.apiKey);
export const hasGithubToken = () => !isPlaceholder(config.github.token);
