/**
 * The console agent.
 *
 * Someone types into the dashboard; this decides whether they asked a question
 * or asked for work. Questions it answers from platform state. Work it turns
 * into a brief and hands to the orchestrator, then says so.
 *
 * It deliberately cannot change the product itself - it has no file tools over
 * the codebase. Everything that changes code goes through a mission, which is
 * what produces the audit trail and the approval gates.
 */
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.ts';
import { platformModel } from '../models.ts';
import { createConsoleServer, type ConsoleContext } from './tools.ts';
import { createDocumentServer } from './documents.ts';
import { projectMap } from '../workspace.ts';

export interface ConsoleTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The console's system prompt, split for the prompt cache.
 *
 * The console is the most-used surface in the platform - every question anyone
 * types starts a fresh, stateless turn - so the same instructions were being
 * re-read on every keystroke's worth of conversation. Everything up to the
 * boundary is identical turn to turn and is served from cache; only the list of
 * attached files, which genuinely changes, sits after it.
 */
function systemPrompt(attachments: ConsoleContext['attachments']): string[] {
  const staticPrefix = `You are the console for ${config.productName}, an AI engineering workforce.
A person types here to find out what the platform is doing, or to ask for work.

Your job is to tell those two apart.

**A question** - "what's running?", "what did that mission find?", "what can you
do?", "how much has this cost?" - you answer from platform state, using your
tools. Answer it directly and briefly. Do not start a mission to answer a
question.

**A request for work** - "add a dark theme", "the login page is broken",
"build a settings screen", "investigate the latency alert" - you turn into a
brief and call launch_mission. Then tell them it has started and what will
happen next. Do not try to do the work yourself; you have no access to the
codebase, and the mission is what produces the review gates and the audit trail.

**Landing work** - "merge the PR and close the ticket", "land #7" - you do it.
Call list_open_pulls and list_open_issues to find what they mean rather than
asking for numbers: with one open pull request and the ticket it closes, there
is nothing to disambiguate, and asking is just handing the lookup back to them.
Merge, then close the issue with a note naming the pull request that delivered
it. Say what you did with the numbers and the URLs. Ask only when it is
genuinely ambiguous - several open pull requests and no way to tell which.

**A ticket** - "fix issue 6 and raise a PR", "can you do #12", "there's a ticket
about the search box" - you read first and ask second. Call read_issue with the
number, or list_open_issues when they described it rather than numbered it, and
build the brief from what the ticket actually says. Never ask the person to
paste a description you can fetch yourself: they referred you to the ticket
precisely so they would not have to repeat it. Launch it as kind "ticket" and
quote the issue number and title back so they know you read the right one. Only
ask if the issue genuinely does not exist, or says too little to act on - and
then say what is missing rather than asking them to start again.

**A document** - "write me a one-pager", "make a deck about X", "summarise that
incident as a PDF" - you produce with the document tools. That is output for a
person to read, not a change to the product, so it does not need a mission.

When a request is ambiguous, prefer answering over launching: it costs the person
five seconds to confirm, and a mission started on a misreading wastes real money
and fills the board with work nobody wanted.

Writing a brief well is most of your value. Expand what they said into something
a team could build from - what is wanted, what done looks like, which part of the
codebase it touches - without inventing requirements they did not state. If
something important is genuinely unspecified, put it in the brief as an open
question rather than guessing.

${projectMap()}

Be brief and concrete. You are a status line and a dispatcher, not a chat
companion. No preamble, no restating the question back.`;

  const attached = attachments.length
    ? `Attached to this conversation: ${attachments.map((a) => a.name).join(', ')}. Read them before answering questions about them.`
    : 'Nothing is attached to this conversation.';

  return [staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, attached];
}

export interface ConsoleEvent {
  type: 'text' | 'tool' | 'tool_result' | 'thinking' | 'mission' | 'document' | 'done' | 'error';
  text?: string;
  /** For a tool call: a compact rendering of its arguments. */
  detail?: string;
  missionId?: string;
  document?: { name: string; url: string };
  cost?: number;
}

/** Run one console turn, streaming what happens. */
export async function* runConsoleTurn(
  history: ConsoleTurn[],
  ctx: ConsoleContext,
  scratchDir: string,
): AsyncGenerator<ConsoleEvent> {
  // The conversation is replayed as a transcript: the console is stateless
  // between turns, so the client owns the history.
  const transcript = history
    .map((t) => `${t.role === 'user' ? 'Person' : 'You'}: ${t.content}`)
    .join('\n\n');

  const options: Options = {
    model: platformModel(),
    systemPrompt: systemPrompt(ctx.attachments),
    cwd: scratchDir,
    settingSources: [],
    permissionMode: 'bypassPermissions',
    // No Agent tool: the console dispatches missions, it does not run a fleet.
    disallowedTools: [
      'Agent', 'Task', 'ListAgents', 'SendMessage', 'ToolSearch', 'WebSearch',
      'WebFetch', 'Skill', 'PushNotification', 'ScheduleWakeup', 'Artifact',
    ],
    maxTurns: 20,
    maxBudgetUsd: 1,
    mcpServers: {
     platform: createConsoleServer(ctx),
      documents: createDocumentServer(scratchDir),
    },
    env: { ...process.env, ANTHROPIC_API_KEY: config.anthropic.apiKey },
  };

  try {
    for await (const message of query({ prompt: transcript, options })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content ?? []) {
          if (block.type === 'text' && block.text.trim()) {
            yield { type: 'text', text: block.text };
          } else if (block.type === 'thinking' && (block as any).thinking?.trim()) {
            yield { type: 'thinking', text: (block as any).thinking };
          } else if (block.type === 'tool_use') {
            const name = block.name.replace(/^mcp__\w+__/, '');
            // The arguments are what makes a tool line readable in the terminal
            // view: "read_issue" says nothing, "read_issue {number: 6}" does.
            yield { type: 'tool', text: name, detail: summarise(block.input) };
          }
        }
      }

      if (message.type === 'user') {
        const content = (message as any).message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const raw = Array.isArray(block.content)
            ? block.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
            : String(block.content ?? '');
          // Every result, so the terminal view shows what came back, not just
          // what was asked.
          yield { type: 'tool_result', text: raw.slice(0, 4000) };

          // Surface the things the client needs to act on.
          const mission = raw.match(/Mission ([A-Za-z0-9_-]{6,}) started/);
          if (mission) yield { type: 'mission', missionId: mission[1] };
          const doc = raw.match(/DOCUMENT_READY (\S+) (\S+)/);
          if (doc) yield { type: 'document', document: { name: doc[1], url: doc[2] } };
        }
      }

      if (message.type === 'result') {
        yield { type: 'done', cost: 'total_cost_usd' in message ? message.total_cost_usd : 0 };
      }
    }
  } catch (err) {
    yield { type: 'error', text: err instanceof Error ? err.message : String(err) };
  }
}

/** Tool arguments rendered for one terminal line. */
function summarise(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const rendered =
      typeof value === 'string'
        ? value.length > 80 ? `${value.slice(0, 80)}…` : value
        : JSON.stringify(value);
    parts.push(`${key}: ${rendered}`);
  }
  const line = parts.join(', ');
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
