/**
 * The agent fleet - the "AI engineering workforce".
 *
 * Each specialist is defined in `.claude/agents/<id>.md`: YAML frontmatter for
 * the metadata, markdown body for the system prompt. That is Claude Code's own
 * agent format, so the same files work from the Claude Code CLI as well as from
 * this platform - and it means the prompts, which are the part worth iterating
 * on, are editable without touching TypeScript.
 *
 * Definitions are read from disk on demand rather than cached at import, so an
 * edit through the console takes effect on the next mission with no restart.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

export type Department = 'sdlc' | 'sre' | 'platform';

export interface FleetMember {
  /** Stable key, the filename stem, and the subagent name used to delegate. */
  id: string;
  /** What we call them: a first name, so a fleet of nineteen reads as people. */
  name: string;
  /** The job: Frontend Engineer, Incident Commander, and so on. */
  title: string;
  department: Department;
  /** One-line pitch shown on the fleet dashboard. */
  role: string;
  /** The editable prompt body, without the generated preamble. */
  body: string;
  /** Resolved model id, or 'inherit' when it follows the platform model. */
  model: string;
  definition: AgentDefinition;
}

/**
 * The fleet lives with the code it works on, not with the dashboard that
 * watches it - so `product/` is a self-contained Claude Code project and the
 * same agents load whether they are driven from here or from the CLI.
 */
export const AGENTS_DIR = fileURLToPath(new URL('../../../product/.claude/agents/', import.meta.url));

/**
 * House rules every fleet member inherits. Kept in code rather than repeated in
 * seventeen files so a change applies everywhere at once.
 */
const HOUSE_RULES = `
Operating rules:
- Ground every claim in something you actually retrieved with a tool. If you did not verify it, say so explicitly rather than asserting it.
- When evidence is thin or contradictory, state your confidence and what additional signal would settle it.
- Be concise and concrete. Engineers read your output under time pressure.
- Never fabricate log lines, metric values, resource names, commit SHAs, or ticket numbers.
- End with a short, scannable summary of what you found or produced.
`.trim();

/**
 * Spell out the agent's exact tool names in its prompt.
 *
 * Without this the model guesses from the role and gets it wrong - during
 * testing agents called `mcp__runbook__run_action` and
 * `mcp__changemgmt__list_changes`, neither of which exists. Generating this
 * from the same list that scopes the agent means the two cannot drift apart.
 */
function toolManifest(tools: string[]): string {
  const mcp = tools.filter((t) => t.startsWith('mcp__'));
  const builtin = tools.filter((t) => !t.startsWith('mcp__'));
  return [
    'Your tools, by exact name - call them exactly as written:',
    ...mcp.map((t) => `  ${t}`),
    ...(builtin.length ? [`  built-in: ${builtin.join(', ')}`] : []),
    'These are the only tools you have. Do not guess at other names.',
    'You can only read and write inside the mission workspace; platform state comes from the tools above, not the filesystem.',
  ].join('\n');
}

interface Frontmatter {
  name?: string;
  displayName?: string;
  title?: string;
  department?: Department;
  role?: string;
  description?: string;
  tools?: string[];
  model?: string;
  effort?: AgentDefinition['effort'];
  maxTurns?: number;
}

/** Split a Claude Code agent file into frontmatter and prompt body. */
export function parseAgentFile(raw: string, id: string): { fm: Frontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`${id}.md has no YAML frontmatter block (expected a leading --- ... --- section)`);
  }
  let fm: Frontmatter;
  try {
    fm = (parseYaml(match[1]) ?? {}) as Frontmatter;
  } catch (err) {
    throw new Error(`${id}.md frontmatter is not valid YAML: ${err instanceof Error ? err.message : err}`);
  }
  const body = match[2].trim();
  if (!body) throw new Error(`${id}.md has an empty prompt body`);
  return { fm, body };
}

/**
 * An agent names a model only when it needs a different one.
 *
 * The default is to inherit the platform model, so changing one setting moves
 * the whole fleet - which is what people actually want - while an agent that
 * genuinely needs more capability than the rest can still say so in its own
 * file and keep it across a platform-wide change.
 */
function resolveModel(alias: string | undefined): string {
  const requested = (alias ?? 'inherit').trim();
  if (requested === '' || requested === 'inherit') return 'inherit';
  const aliases: Record<string, string> = {
    haiku: 'claude-haiku-4-5',
    sonnet: 'claude-sonnet-5',
    opus: 'claude-opus-5',
  };
  return aliases[requested] ?? requested;
}

function toMember(id: string, raw: string): FleetMember {
  const { fm, body } = parseAgentFile(raw, id);
  const tools = fm.tools ?? [];
  const model = resolveModel(fm.model);

  return {
    id,
    name: fm.displayName ?? id,
    title: fm.title ?? fm.role ?? id,
    department: fm.department ?? 'platform',
    role: fm.role ?? '',
    body,
    model,
    definition: {
      description: fm.description ?? fm.role ?? id,
      prompt: `${body}\n\n${toolManifest(tools)}\n\n${HOUSE_RULES}`,
      tools,
      model,
      ...(fm.effort ? { effort: fm.effort } : {}),
      ...(fm.maxTurns ? { maxTurns: fm.maxTurns } : {}),
    },
  };
}

/** Read every agent definition from disk. */
export function loadFleet(): FleetMember[] {
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
  const members: FleetMember[] = [];
  for (const file of files.sort()) {
    const id = file.replace(/\.md$/, '');
    try {
      members.push(toMember(id, readFileSync(join(AGENTS_DIR, file), 'utf8')));
    } catch (err) {
      // One malformed file must not take the whole fleet down - the console
      // surfaces the error and the other sixteen agents keep working.
      console.error(`[fleet] skipping ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const order: Department[] = ['sdlc', 'sre', 'platform'];
  return members.sort(
    (a, b) => order.indexOf(a.department) - order.indexOf(b.department) || a.id.localeCompare(b.id),
  );
}

export const fleetById = (id: string): FleetMember | undefined =>
  loadFleet().find((m) => m.id === id);

/** The `agents` option passed to query(). */
export const agentDefinitions = (): Record<string, AgentDefinition> =>
  Object.fromEntries(loadFleet().map((m) => [m.id, m.definition]));

/** Raw file contents, for the prompt editor. */
export const readAgentFile = (id: string): string =>
  readFileSync(join(AGENTS_DIR, `${id}.md`), 'utf8');

/**
 * Save an edited agent file.
 *
 * Parsed before it is written: a prompt editor that can leave the fleet in a
 * broken state is worse than no editor, particularly ten minutes before a demo.
 * Throws with a readable message if the file would not load.
 */
export function writeAgentFile(id: string, raw: string): FleetMember {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid agent id "${id}"`);
  const member = toMember(id, raw); // throws if frontmatter or body is bad
  writeFileSync(join(AGENTS_DIR, `${id}.md`), raw, 'utf8');
  return member;
}

/** Check an edit without saving it. */
export function validateAgentFile(id: string, raw: string): { ok: true } | { ok: false; error: string } {
  try {
    toMember(id, raw);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
