/**
 * GitHub integration - the ticketing system, the PR surface, and half the
 * governance trail.
 *
 * Built as a per-mission factory because these tools need mission context: the
 * workspace whose files become a commit, and the mission to attach artifacts to.
 *
 * Without a token the tools still work, recording locally and clearly labelling
 * the result as unpublished. That keeps the whole product demonstrable before
 * credentials land, and means a token outage during a demo degrades instead of
 * dead-ending.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { changedFiles } from '../workspace.ts';
import { join, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import { config, hasGithubToken } from '../config.ts';
import { artifacts } from '../db/index.ts';
import { bus } from '../bus.ts';
import { requestApproval } from '../orchestrator/approvals.ts';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export interface GithubToolContext {
  missionId: string;
  /** Directory the fleet writes into; its contents become the PR. */
  workspaceDir: string;
  /** Who to attribute tool calls to in the audit trail. */
  actor: string;
}

const octokit = () =>
  hasGithubToken() ? new Octokit({ auth: config.github.token }) : null;

const repoRef = { owner: config.github.owner, repo: config.github.repo };

/**
 * Long markdown does not survive the tool-call round trip reliably - during
 * testing, create_issue calls carrying a ~2800 character body came back as
 * "interrupted before a result was received" while short ones succeeded.
 *
 * So callers write long content to a file in the mission workspace and pass the
 * path. That keeps the tool call small, and has the side benefit of leaving the
 * full write-up in the workspace, where it becomes part of the pull request.
 */
async function resolveBody(
  workspaceDir: string,
  body: string,
  bodyFile?: string,
): Promise<{ text: string; note: string | null }> {
  if (!bodyFile) return { text: body, note: null };
  const abs = resolve(workspaceDir, bodyFile);
  if (!abs.startsWith(resolve(workspaceDir))) {
    return { text: body, note: `Ignored bodyFile "${bodyFile}": outside the mission workspace.` };
  }
  try {
    const extra = await readFile(abs, 'utf8');
    return { text: body ? `${body}\n\n${extra}` : extra, note: null };
  } catch {
    return {
      text: body,
      note: `Could not read bodyFile "${bodyFile}" - used the inline body only. Write the file into the workspace first.`,
    };
  }
}

export function createGithubServer(ctx: GithubToolContext) {
  const record = async (
    kind: 'pull_request' | 'issue',
    title: string,
    url: string | null,
    body: string,
  ) => {
    const artifact = await artifacts.create({
      id: nanoid(10),
      missionId: ctx.missionId,
      kind,
      title,
      url,
      body,
    });
    bus.emitEvent({
      missionId: ctx.missionId,
      type: 'artifact.created',
      actor: ctx.actor,
      text: `${kind === 'issue' ? 'Ticket' : 'Pull request'}: ${title}`,
      data: artifact,
    });
    return artifact;
  };

  const getRepoContext = tool(
    'get_repo_context',
    'Get information about the target repository: default branch, recent commits, and open issues. Call this before creating issues or pull requests.',
    {},
    async () => {
      const gh = octokit();
      if (!gh) {
        return text(
          `Repository: ${repoRef.owner}/${repoRef.repo} (no GitHub credentials configured - operating in local mode)\n` +
            `Default branch: main\nIssues and pull requests will be recorded locally and marked unpublished.`,
        );
      }
      const [repo, commits, issues] = await Promise.all([
        gh.repos.get(repoRef),
        gh.repos.listCommits({ ...repoRef, per_page: 5 }),
        gh.issues.listForRepo({ ...repoRef, state: 'open', per_page: 10 }),
      ]);
      return text(
        `Repository: ${repo.data.full_name}\n` +
          `Default branch: ${repo.data.default_branch}\n` +
          `Open issues: ${repo.data.open_issues_count}\n\n` +
          `Recent commits:\n` +
          commits.data
            .map((c) => `  ${c.sha.slice(0, 7)} ${c.commit.message.split('\n')[0]} (${c.commit.author?.name})`)
            .join('\n') +
          `\n\nOpen issues:\n` +
          (issues.data.length
            ? issues.data.map((i) => `  #${i.number} ${i.title} [${i.labels.map((l: any) => (typeof l === 'string' ? l : l.name)).join(', ')}]`).join('\n')
            : '  (none)'),
      );
    },
  );

  const listIssues = tool(
    'list_issues',
    'List issues in the repository, optionally filtered by state or label.',
    {
      state: z.enum(['open', 'closed', 'all']).optional().describe('Defaults to open.'),
      label: z.string().optional().describe('Filter to a single label.'),
    },
    async ({ state, label }) => {
      const gh = octokit();
      if (!gh) {
        const local = (await artifacts.listAll(50)).filter((a) => a.kind === 'issue');
        return text(
          local.length
            ? `Locally recorded tickets (unpublished):\n` +
                local.map((a) => `  ${a.title} - ${a.url ?? 'local'}`).join('\n')
            : 'No issues recorded yet (local mode).',
        );
      }
      const res = await gh.issues.listForRepo({
        ...repoRef,
        state: state ?? 'open',
        ...(label ? { labels: label } : {}),
        per_page: 30,
      });
      return text(
        res.data.length
          ? res.data
              .map((i) => `#${i.number} [${i.state}] ${i.title}\n  ${(i.body ?? '').slice(0, 400)}`)
              .join('\n\n')
          : 'No issues matched.',
      );
    },
  );

  /**
   * One issue, in full.
   *
   * list_issues truncates each body so a listing stays readable, which is right
   * for a listing and wrong for the thing the mission is about: asked to
   * "resolve issue #4" the orchestrator would work from the first 160
   * characters of the description and never know what else it said.
   */
  const getIssue = tool(
    'get_issue',
    'Read one issue in full - title, body, labels and state. Use this before working on a ticket.',
    {
      number: z.number().int().positive().describe('The issue number, e.g. 4 for #4.'),
    },
    async ({ number }) => {
      const gh = octokit();
      if (!gh) return text(`No GitHub token configured, so issue #${number} cannot be read.`);
      try {
        const { data } = await gh.issues.get({ ...repoRef, issue_number: number });
        const labels = (data.labels ?? [])
          .map((l) => (typeof l === 'string' ? l : l.name))
          .filter(Boolean)
          .join(', ');
        return text(
          [
            `#${data.number} [${data.state}] ${data.title}`,
            labels ? `Labels: ${labels}` : 'Labels: none',
            `URL: ${data.html_url}`,
            '',
            data.body?.trim() || '(no description)',
          ].join('\n'),
        );
      } catch (err: any) {
        if (err?.status === 404) return text(`Issue #${number} does not exist in this repository.`);
        throw err;
      }
    },
  );

  const createIssue = tool(
    'create_issue',
    'File a ticket in the repository. Use this to raise incidents, defects, and follow-up work that a human needs to act on.',
    {
      title: z.string().describe('Concise, specific issue title.'),
      body: z.string().describe(
        'Short markdown summary, under about 1000 characters. For a longer write-up, put it in a workspace file and pass bodyFile instead of inlining it here.',
      ),
      bodyFile: z.string().optional().describe(
        'Workspace-relative path to a markdown file whose contents are appended to the body, e.g. "INCIDENT.md". Preferred for anything long.',
      ),
      labels: z.array(z.string()).optional().describe('Labels, e.g. ["incident","severity:critical"].'),
    },
    async ({ title, body, bodyFile, labels }) => {
      const gh = octokit();
      const resolved = await resolveBody(ctx.workspaceDir, body, bodyFile);
      const signed = `${resolved.text}\n\n---\n_Filed by ${config.productName} - agent \`${ctx.actor}\` - mission \`${ctx.missionId}\`_`;

      if (!gh) {
        const a = await record('issue', title, null, signed);
        return text(
          `Ticket recorded locally (unpublished - no GitHub credentials).\n` +
            `  id=${a.id} title=${title}\n  labels=${(labels ?? []).join(', ') || 'none'}\n` +
            (resolved.note ? `  ${resolved.note}\n` : '') +
            `\nIt will appear in the mission's artifacts. Configure GITHUB_TOKEN to publish to ${repoRef.owner}/${repoRef.repo}.`,
        );
      }

      const res = await gh.issues.create({ ...repoRef, title, body: signed, labels });
      await record('issue', title, res.data.html_url, signed);
      return text(
        `Created issue #${res.data.number}: ${res.data.html_url}` +
          (resolved.note ? `\n${resolved.note}` : ''),
      );
    },
  );

  const commentIssue = tool(
    'comment_issue',
    'Add a comment to an existing issue - for example attaching an RCA to the incident ticket it belongs to.',
    {
      issueNumber: z.number().int().describe('The issue number to comment on.'),
      body: z.string().describe('Markdown comment body.'),
    },
    async ({ issueNumber, body }) => {
      const gh = octokit();
      if (!gh) return text(`Comment recorded locally for #${issueNumber} (unpublished).`);
      const res = await gh.issues.createComment({ ...repoRef, issue_number: issueNumber, body });
      return text(`Commented on #${issueNumber}: ${res.data.html_url}`);
    },
  );

  const openPullRequest = tool(
    'open_pull_request',
    'Open a pull request containing everything the fleet wrote into the mission workspace. This is the human go/no-go gate - it requires approval before it runs.',
    {
      title: z.string().describe('PR title.'),
      body: z.string().describe(
        'Short PR description, under about 1000 characters. For a longer write-up, put it in a workspace file and pass bodyFile.',
      ),
      bodyFile: z.string().optional().describe(
        'Workspace-relative path to a markdown file appended to the description, e.g. "PR.md". Preferred for anything long.',
      ),
      branch: z.string().describe('Branch name to create, e.g. feature/order-status-webhook.'),
    },
    async ({ title, body, bodyFile, branch }) => {
      // The human go/no-go. Blocks in the handler so it holds for any caller.
      const decision = await requestApproval({
        missionId: ctx.missionId,
        actor: ctx.actor,
        toolName: 'mcp__github__open_pull_request',
        summary: `Open pull request "${title}" on branch ${branch}`,
        input: { title, branch, body },
      });
      if (!decision.approved) {
        return text(
          `REJECTED by a human reviewer${decision.reason ? `: ${decision.reason}` : '.'}\n` +
            `The pull request was not opened. Do not retry it. Summarise what was built, ` +
            `what the reviewer objected to, and what you would change.`,
        );
      }

      // Only files that actually differ from the product as it stands - a PR
      // carrying the whole codebase as "changes" is unreviewable.
      const files = await changedFiles(ctx.workspaceDir);
      if (files.length === 0) {
        return text(
          'Nothing in the workspace differs from the current product, so there is no ' +
            'pull request to open. Make the changes in the workspace copy of backend/ or ' +
            'frontend/ first, then try again.',
        );
      }

      const resolved = await resolveBody(ctx.workspaceDir, body, bodyFile);
      const signed = `${resolved.text}\n\n---\n_Opened by ${config.productName} - mission \`${ctx.missionId}\`. ${files.length} file(s) changed._`;
      const gh = octokit();

      if (!gh) {
        const a = await record('pull_request', title, null, signed);
        return text(
          `Pull request prepared locally (unpublished - no GitHub credentials).\n` +
            `  branch=${branch}\n  files=${files.length}\n` +
            files.map((f) => `    ${f.path}`).join('\n') +
            `\n\nRecorded as artifact ${a.id}. Configure GITHUB_TOKEN to publish to ${repoRef.owner}/${repoRef.repo}.`,
        );
      }

      // Build a real commit via the git data API so no local clone is needed.
      const repo = await gh.repos.get(repoRef);
      const base = repo.data.default_branch;
      const baseRef = await gh.git.getRef({ ...repoRef, ref: `heads/${base}` });
      const baseSha = baseRef.data.object.sha;

      const blobs = await Promise.all(
        files.map(async (f) => {
          const blob = await gh.git.createBlob({
            ...repoRef,
            content: Buffer.from(f.content, 'utf8').toString('base64'),
            encoding: 'base64',
          });
          return { path: f.path, mode: '100644' as const, type: 'blob' as const, sha: blob.data.sha };
        }),
      );

      const tree = await gh.git.createTree({ ...repoRef, base_tree: baseSha, tree: blobs });
      const commit = await gh.git.createCommit({
        ...repoRef,
        message: `${title}\n\nGenerated by ${config.productName} (mission ${ctx.missionId})`,
        tree: tree.data.sha,
        parents: [baseSha],
      });
      await gh.git.createRef({ ...repoRef, ref: `refs/heads/${branch}`, sha: commit.data.sha });

      const pr = await gh.pulls.create({ ...repoRef, title, body: signed, head: branch, base });
      await record('pull_request', title, pr.data.html_url, signed);

      return text(
        `Opened pull request #${pr.data.number}: ${pr.data.html_url}\n` +
          `  branch=${branch} -> ${base}\n  files=${files.length}\n` +
          files.map((f) => `    ${f.path}`).join('\n'),
      );
    },
  );

  return createSdkMcpServer({
    name: 'github',
    version: '1.0.0',
    instructions: `GitHub integration for ${repoRef.owner}/${repoRef.repo}: issues as the ticketing system, and pull requests as the human review gate.`,
    tools: [getRepoContext, listIssues, getIssue, createIssue, commentIssue, openPullRequest],
  });
}
