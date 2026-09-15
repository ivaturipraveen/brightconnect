/**
 * Mission workspaces.
 *
 * A mission workspace is a working copy of the product - backend/ and
 * frontend/ - not an empty scratch directory. That is the difference between
 * "write me a dark theme" producing a file in a vacuum and producing a diff
 * against the actual chat UI.
 *
 * It also fixes a failure we hit repeatedly: with no product code in sight, the
 * only code agents could find was the platform's own, and they edited that
 * instead.
 */
import { cp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { config } from './config.ts';

/** Directories copied into every workspace, and what they are. */
export const PRODUCT_AREAS = [
  {
    dir: 'backend',
    title: 'Chat API',
    summary:
      'Node + Fastify service that answers user questions by calling Claude. Streams replies over server-sent events.',
    stack: 'TypeScript, Fastify 5, @anthropic-ai/sdk, Node 24 (node:test for tests)',
    entry: 'src/index.ts',
    notes: [
      'src/index.ts   - HTTP routes: /api/health, /api/chat, /api/chat/stream',
      'src/chat.ts    - Claude client, system prompt, streaming and history trimming',
      'src/config.ts  - all configuration, read from environment',
      'Tests are colocated as *.test.ts and run with `npm test`.',
    ],
  },
  {
    dir: 'frontend',
    title: 'Chat UI',
    summary: 'React single-page app where a user types a question and watches the answer stream in.',
    stack: 'TypeScript, React 19, Vite 6, Tailwind CSS 4',
    entry: 'src/App.tsx',
    notes: [
      'src/App.tsx        - the whole chat screen: transcript, composer, streaming state',
      'src/lib/chat.ts    - talks to the API, parses the SSE stream',
      'src/index.css      - Tailwind v4 theme tokens (@theme) and base styles',
      'Colours are theme tokens, not literals: change --color-* in index.css rather than hardcoding hex values in components.',
      'The UI already follows the browser light/dark preference via prefers-color-scheme.',
    ],
  },
] as const;

/** Never copied: generated, huge, or secret. */
const EXCLUDE = new Set(['node_modules', 'dist', '.git', '.env', '.env.local', 'coverage']);

async function copyArea(source: string, destination: string): Promise<number> {
  if (!existsSync(source)) return 0;
  let copied = 0;
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      copied += await copyArea(from, to);
    } else {
      const info = await stat(from);
      if (info.size > 1024 * 1024) continue; // not source code
      await cp(from, to);
      copied++;
    }
  }
  return copied;
}

/** A map of the codebase, written into the workspace and given to the fleet. */
export function projectMap(): string {
  const areas = PRODUCT_AREAS.map(
    (a) =>
      `### ${a.dir}/ — ${a.title}\n` +
      `${a.summary}\n\n` +
      `Stack: ${a.stack}\n` +
      `Entry point: ${a.dir}/${a.entry}\n\n` +
      a.notes.map((n) => `- ${n}`).join('\n'),
  ).join('\n\n');

  return `# The codebase you are working on

This workspace is a working copy of the product. Everything you change here
becomes the pull request, so build here and nowhere else.

${areas}

## Running things

- Backend: \`cd backend && npm install && npm run dev\` (port 8080)
- Frontend: \`cd frontend && npm install && npm run dev\` (port 5174, proxies /api to 8080)
- Typecheck: \`npm run typecheck\` in either directory
- Backend tests: \`cd backend && npm test\`

## House rules for this codebase

- TypeScript throughout, strict mode. No \`any\` without a reason in a comment.
- The frontend's colours come from Tailwind v4 \`@theme\` tokens in
  \`frontend/src/index.css\`. Change a token to change the palette everywhere;
  do not hardcode hex values in components.
- The backend validates anything that arrives from a client before using it.
- Keep the existing file layout unless the change genuinely needs a new file.
- Match the surrounding style: it is consistent, so follow it rather than
  introducing a second convention.
`;
}

export interface ProvisionResult {
  workspaceDir: string;
  filesCopied: number;
}

/**
 * Link each area's dependencies instead of installing them.
 *
 * An agent that needs to typecheck or run tests will otherwise run npm install,
 * and one mission left a 314 MB node_modules behind. Linking the product's own
 * dependencies means tooling works immediately, costs nothing on disk, and the
 * link is skipped by the diff that builds the pull request.
 */
async function linkDependencies(workspaceDir: string): Promise<void> {
  for (const area of PRODUCT_AREAS) {
    const source = join(config.paths.productRoot, area.dir, 'node_modules');
    if (!existsSync(source)) continue;
    const target = join(workspaceDir, area.dir, 'node_modules');
    if (existsSync(target)) continue;
    try {
      await symlink(source, target, 'dir');
    } catch {
      // Without the link an agent may install its own; that is slow, not broken.
    }
  }
}

/** Create a mission workspace containing the product code and its brief. */
export async function provisionWorkspace(
  missionId: string,
  brief: { title: string; input: string },
): Promise<ProvisionResult> {
  const workspaceDir = join(config.paths.workspaces, missionId);
  await mkdir(workspaceDir, { recursive: true });

  let filesCopied = 0;
  for (const area of PRODUCT_AREAS) {
    filesCopied += await copyArea(
      join(config.paths.productRoot, area.dir),
      join(workspaceDir, area.dir),
    );
  }

  await writeFile(
    join(workspaceDir, 'MISSION.md'),
    `# ${brief.title}\n\n${brief.input}\n`,
    'utf8',
  );
  await writeFile(join(workspaceDir, 'PROJECT.md'), projectMap(), 'utf8');
  await linkDependencies(workspaceDir);

  return { workspaceDir, filesCopied };
}

/**
 * Files that differ from the product as it stands - what the pull request
 * should contain. Comparing against the original avoids a PR carrying the
 * entire codebase as "changes".
 */
export async function changedFiles(
  workspaceDir: string,
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];

  async function walk(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (EXCLUDE.has(entry.name)) continue;
      // Symlinks are the linked dependency trees; never follow them.
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = relative(workspaceDir, full);
      // The brief and the map are ours, not part of the product.
      if (rel === 'MISSION.md' || rel === 'PROJECT.md') continue;
      const info = await stat(full);
      if (info.size > 512 * 1024) continue;

      const content = await readFile(full, 'utf8');
      const originalPath = join(config.paths.productRoot, rel);
      let original: string | null = null;
      try {
        original = await readFile(originalPath, 'utf8');
      } catch {
        original = null; // a new file
      }
      if (original !== content) out.push({ path: rel, content });
    }
  }

  await walk(workspaceDir);
  return out;
}
