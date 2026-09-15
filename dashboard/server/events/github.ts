/**
 * GitHub as the work queue.
 *
 * Real agentic operations are not driven by someone clicking "run" in a
 * dashboard - work arrives as events. An issue is filed, a pull request opens,
 * an alert fires. The fleet picks it up, does the work, and reports back where
 * the team already works.
 *
 * Two ways in, because a laptop cannot receive webhooks:
 *   - webhook  the real path, once the API has a public URL
 *   - poller   asks GitHub what is new on an interval; works anywhere
 *
 * Both funnel through the same normalise-and-dispatch path, and both are
 * deduplicated on delivery id, so running them together cannot double-start a
 * piece of work.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { nanoid } from 'nanoid';
import { config, hasGithubToken } from '../config.ts';
import { inboundEvents, missions } from '../db/index.ts';
import { bus } from '../bus.ts';
import type { MissionKind } from '../types.ts';

export interface NormalizedEvent {
  /** Delivery id; the dedupe key. */
  id: string;
  kind: string;
  /** Stable external reference, e.g. "issue#42". */
  sourceRef: string;
  title: string;
  /** What the mission should work on. */
  body: string;
  missionKind: MissionKind;
  payload: unknown;
}

const repoRef = { owner: config.github.owner, repo: config.github.repo };
const octokit = () => (hasGithubToken() ? new Octokit({ auth: config.github.token }) : null);

/* ------------------------------------------------------------- webhooks */

/**
 * Verify GitHub's HMAC signature.
 *
 * An unauthenticated endpoint that starts agent runs is a way to burn someone
 * else's API budget, so an unsigned or badly signed delivery is rejected
 * outright when a secret is configured.
 */
export function verifySignature(rawBody: string, signature: string | undefined): boolean {
  const secret = config.github.webhookSecret;
  if (!secret) return true; // no secret configured: local development only
  if (!signature) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Should this issue be picked up by the fleet? */
function labelMatches(labels: Array<{ name?: string } | string> | undefined): boolean {
  const required = config.github.triggerLabel.trim();
  if (!required) return true; // unset: act on everything
  const names = (labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')).toLowerCase());
  return names.includes(required.toLowerCase());
}

/** Turn a raw GitHub webhook into work, or nothing. */
export function normalizeWebhook(
  event: string,
  deliveryId: string,
  payload: any,
): NormalizedEvent | { skip: string } {
  if (event === 'issues' && ['opened', 'labeled', 'reopened'].includes(payload?.action)) {
    const issue = payload.issue;
    if (!issue || issue.pull_request) return { skip: 'not an issue' };
    if (!labelMatches(issue.labels)) {
      return { skip: `no "${config.github.triggerLabel}" label` };
    }
    return {
      id: deliveryId,
      kind: `issues.${payload.action}`,
      sourceRef: `issue#${issue.number}`,
      title: issue.title,
      body: issueBrief(issue),
      missionKind: 'ticket',
      payload,
    };
  }

  if (event === 'pull_request' && ['opened', 'reopened', 'synchronize'].includes(payload?.action)) {
    const pr = payload.pull_request;
    if (!pr) return { skip: 'no pull request' };
    // Never review our own work - that is not a review, it is a loop.
    if ((pr.body ?? '').includes(config.productName) || pr.head?.ref?.startsWith('brightconnect/')) {
      return { skip: 'opened by the platform itself' };
    }
    return {
      id: deliveryId,
      kind: `pull_request.${payload.action}`,
      sourceRef: `pr#${pr.number}`,
      title: pr.title,
      body: prBrief(pr),
      missionKind: 'review',
      payload,
    };
  }

  return { skip: `${event}.${payload?.action ?? '?'} is not actionable` };
}

const issueBrief = (issue: any) =>
  `GitHub issue #${issue.number}: ${issue.title}\n` +
  `Opened by: ${issue.user?.login ?? 'unknown'}\n` +
  `Labels: ${(issue.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)).join(', ') || 'none'}\n` +
  `URL: ${issue.html_url}\n\n` +
  `--- ISSUE BODY ---\n${issue.body ?? '(no description provided)'}\n--- END ---`;

const prBrief = (pr: any) =>
  `Pull request #${pr.number}: ${pr.title}\n` +
  `Author: ${pr.user?.login ?? 'unknown'}\n` +
  `Branch: ${pr.head?.ref} -> ${pr.base?.ref}\n` +
  `Changes: +${pr.additions ?? '?'} -${pr.deletions ?? '?'} across ${pr.changed_files ?? '?'} file(s)\n` +
  `URL: ${pr.html_url}\n\n` +
  `--- DESCRIPTION ---\n${pr.body ?? '(none)'}\n--- END ---`;

/* --------------------------------------------------------------- polling */

/** Newest first, so the most recent work is picked up first. */
export async function pollGitHub(): Promise<NormalizedEvent[]> {
  const gh = octokit();
  if (!gh) return [];

  const out: NormalizedEvent[] = [];
  try {
    const issues = await gh.issues.listForRepo({ ...repoRef, state: 'open', per_page: 20, sort: 'created', direction: 'desc' });
    for (const issue of issues.data) {
      // listForRepo returns pull requests too; they are handled separately.
      if (issue.pull_request) continue;
      if (!labelMatches(issue.labels as any)) continue;
      out.push({
        // Stable per issue, so polling repeatedly cannot restart the same work.
        id: `poll-issue-${issue.number}`,
        kind: 'issues.polled',
        sourceRef: `issue#${issue.number}`,
        title: issue.title,
        body: issueBrief(issue),
        missionKind: 'ticket',
        payload: issue,
      });
    }

    const prs = await gh.pulls.list({ ...repoRef, state: 'open', per_page: 10, sort: 'created', direction: 'desc' });
    for (const pr of prs.data) {
      if ((pr.body ?? '').includes(config.productName) || pr.head?.ref?.startsWith('brightconnect/')) continue;
      out.push({
        id: `poll-pr-${pr.number}`,
        kind: 'pull_request.polled',
        sourceRef: `pr#${pr.number}`,
        title: pr.title,
        body: prBrief(pr),
        missionKind: 'review',
        payload: pr,
      });
    }
  } catch (err) {
    // A poll failure must never take the server down; the next tick retries.
    console.error('[github-poll]', err instanceof Error ? err.message : err);
  }
  return out;
}

/* ------------------------------------------------------------- dispatch */

export interface DispatchResult {
  status: 'dispatched' | 'duplicate' | 'ignored';
  missionId?: string;
  note?: string;
}

/**
 * Record an event and start work on it, unless we have seen it before or a
 * mission for the same reference is already running.
 */
export async function dispatchEvent(
  event: NormalizedEvent,
  start: (missionId: string) => void,
  create: (args: {
    kind: MissionKind;
    title: string;
    input: string;
    trigger: 'github_webhook' | 'github_poll';
    sourceRef: string;
  }) => Promise<{ id: string }>,
  trigger: 'github_webhook' | 'github_poll',
): Promise<DispatchResult> {
  if (await inboundEvents.seen(event.id)) return { status: 'duplicate' };

  await inboundEvents.record({
    id: event.id,
    source: 'github',
    kind: event.kind,
    sourceRef: event.sourceRef,
    title: event.title,
    payload: event.payload,
    status: 'received',
  });

  const active = await missions.activeForSource(event.sourceRef);
  if (active) {
    await inboundEvents.setStatus(event.id, 'ignored', `Mission ${active.id} is already working on ${event.sourceRef}`);
    return { status: 'ignored', note: `already being worked by mission ${active.id}` };
  }

  const mission = await create({
    kind: event.missionKind,
    title: event.title,
    input: event.body,
    trigger,
    sourceRef: event.sourceRef,
  });
  await inboundEvents.attachMission(event.id, mission.id);
  bus.publish({ channel: 'alert', payload: { inbound: true, sourceRef: event.sourceRef } });
  start(mission.id);
  return { status: 'dispatched', missionId: mission.id };
}

export const newDeliveryId = () => nanoid(12);
