import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Attachment, type ConsoleEvent, type Overview } from '../lib/api.ts';
import { useActivityStream } from '../lib/stream.ts';
import { Button, Panel } from '../components/ui.tsx';
import ControlSidebar from '../components/ControlSidebar.tsx';
import SplitPane from '../components/SplitPane.tsx';
import TerminalLog, { type TerminalLine } from '../components/TerminalLog.tsx';

/**
 * The console: type a task or a question.
 *
 * Questions are answered from platform state; work becomes a mission. The
 * distinction is the agent's to make, so the input is deliberately one plain
 * box rather than a mode switch the person has to get right.
 */

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** What the agent did while answering, for the activity line. */
  tools?: string[];
  missionIds?: string[];
  documents?: Array<{ name: string; url: string }>;
  cost?: number;
}

/**
 * The conversation, kept across navigation.
 *
 * The console holds its history in component state, and React unmounts the page
 * the moment you visit Mission Control - so a conversation vanished the instant
 * you went to look at the mission it had just started, which is the first thing
 * anybody does. sessionStorage keeps it for the life of the tab, which is the
 * right lifetime: it survives navigation and a refresh, and a new tab starts
 * clean rather than inheriting somebody else's session.
 */
const HISTORY_KEY = 'brightconnect.console.turns';
const DRAFT_KEY = 'brightconnect.console.draft';
const LOG_KEY = 'brightconnect.console.log';

/**
 * How much of the stream is kept, and what gets dropped first.
 *
 * A single mission emits a couple of hundred tool calls, so a flat cap threw
 * away the conversation - what you asked and what came back - to make room for
 * another `tool.result`. The conversation is the part nobody can reconstruct,
 * so it is kept to the ceiling and the machine noise is trimmed under it.
 */
const KEEP_TOTAL = 4000;
const KEEP_STORED = 1500;
const NOISE: ReadonlySet<TerminalLine['kind']> = new Set(['tool', 'result', 'system', 'thinking']);

function append(lines: TerminalLine[], line: TerminalLine): TerminalLine[] {
  const next = [...lines, line];
  if (next.length <= KEEP_TOTAL) return next;

  // Over the ceiling: drop the oldest noise first, and only start on the
  // conversation once there is no noise left to give.
  let excess = next.length - KEEP_TOTAL;
  const kept: TerminalLine[] = [];
  for (const l of next) {
    if (excess > 0 && NOISE.has(l.kind)) { excess -= 1; continue; }
    kept.push(l);
  }
  return excess > 0 ? kept.slice(excess) : kept;
}

function loadLog(): TerminalLine[] {
  try {
    const raw = sessionStorage.getItem(LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as TerminalLine[]) : [];
  } catch {
    return [];
  }
}

function loadHistory(): Turn[] {
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as Turn[]) : [];
  } catch {
    return []; // storage disabled, or a shape we no longer understand
  }
}

export default function Console() {
  const [turns, setTurns] = useState<Turn[]>(loadHistory);
  const [input, setInput] = useState(() => {
    try {
      return sessionStorage.getItem(DRAFT_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [view, setView] = useState<'terminal' | 'preview'>('terminal');
  const [log, setLog] = useState<TerminalLine[]>(loadLog);
  const fileRef = useRef<HTMLInputElement>(null);

  /** One line on the execution stream. */
  const emit = (kind: TerminalLine['kind'], text: string, detail?: string) =>
    setLog((prev) => append(prev, { at: Date.now(), kind, text, detail }));

  const loadOverview = () => void api.overview().then(setOverview).catch(() => {});
  useEffect(() => {
    loadOverview();
    // The fleet's status is the point of the sidebar, so keep it fresh even
    // when no stream event happens to fire.
    const id = setInterval(loadOverview, 5000);
    return () => clearInterval(id);
  }, []);
  useActivityStream({
    onMission: (m) => {
      emit('mission', `mission ${m.missionId}`, m.status);
      loadOverview();
    },
    onEvent: (e) => {
      // The fleet's own execution, live, in the same place as the console's.
      const label = e.actor === 'system' ? e.type : `${e.actor} · ${e.type}`;
      emit(
        e.type === 'error' ? 'error' : e.type.startsWith('tool') ? 'tool' : 'system',
        label,
        (e.text ?? '').split('\n')[0].slice(0, 160),
      );
      loadOverview();
    },
  });

  // Persist the conversation and the unsent draft as they change.
  useEffect(() => {
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(turns));
    } catch {
      // A conversation too large to store is not a reason to lose the page.
    }
  }, [turns]);

  // The terminal is the transcript now, so it has to survive a refresh too.
  useEffect(() => {
    try {
      sessionStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-KEEP_STORED)));
    } catch {
      /* storage full or disabled */
    }
  }, [log]);

  useEffect(() => {
    try {
      if (input) sessionStorage.setItem(DRAFT_KEY, input);
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      /* storage disabled */
    }
  }, [input]);

  /** Start again, and forget the stored conversation with it. */
  const newConversation = () => {
    if (turns.length > 0 && !window.confirm('Clear this conversation and start a new one?')) return;
    setTurns([]);
    setInput('');
    setAttachments([]);
    setError(null);
    setLog([]);
    try {
      sessionStorage.removeItem(HISTORY_KEY);
      sessionStorage.removeItem(DRAFT_KEY);
      sessionStorage.removeItem(LOG_KEY);
    } catch {
      /* storage disabled */
    }
  };

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files).slice(0, 5)) {
      try {
        const uploaded = await api.uploadAttachment(file);
        setAttachments((prev) => [...prev, uploaded]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;

    const history: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns([...history, { role: 'assistant', content: '', tools: [] }]);
    setInput('');
    setError(null);
    setBusy(true);
    emit('prompt', text.split('\n')[0].slice(0, 200));

    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === 'assistant') copy[copy.length - 1] = fn(last);
        return copy;
      });

    try {
      const res = await fetch('/api/console/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.map((t) => ({ role: t.role, content: t.content })),
          attachments,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const e = JSON.parse(line.slice(6)) as ConsoleEvent;

          if (e.type === 'text' && e.text) {
            patch((t) => ({ ...t, content: t.content + (t.content ? '\n\n' : '') + e.text }));
            emit('text', e.text);
          } else if (e.type === 'thinking' && e.text) {
            emit('thinking', e.text);
          } else if (e.type === 'tool' && e.text) {
            patch((t) => ({ ...t, tools: [...(t.tools ?? []), e.text!] }));
            emit('tool', e.text, e.detail);
          } else if (e.type === 'tool_result' && e.text) {
            emit('result', e.text.length > 600 ? `${e.text.slice(0, 600)}…` : e.text);
          } else if (e.type === 'mission' && e.missionId) {
            patch((t) => ({ ...t, missionIds: [...(t.missionIds ?? []), e.missionId!] }));
            setLog((prev) => append(prev, {
              at: Date.now(), kind: 'mission',
              text: `mission ${e.missionId} started`, href: `/missions/${e.missionId}`,
            }));
            loadOverview();
          } else if (e.type === 'document' && e.document) {
            patch((t) => ({ ...t, documents: [...(t.documents ?? []), e.document!] }));
            setLog((prev) => append(prev, {
              at: Date.now(), kind: 'document',
              text: e.document!.name, href: e.document!.url,
            }));
          } else if (e.type === 'done') {
            patch((t) => ({ ...t, cost: e.cost }));
            if (e.cost) emit('system', `done · $${e.cost.toFixed(4)}`);
          } else if (e.type === 'error') {
            setError(e.text ?? 'Something went wrong');
            emit('error', e.text ?? 'Something went wrong');
          }
        }
      }
      // Attachments belong to the message that used them.
      setAttachments([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTurns((prev) => (prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-xl font-semibold text-ink-100">Console</h1>
        <p className="mt-0.5 max-w-3xl text-[13px] text-ink-400">
          Ask a question and it answers from platform state. Describe work and it briefs the
          fleet and starts a mission.
        </p>
      </div>

      <SplitPane id="console" className="min-h-0 flex-1" initial={320} min={260} max={620} left={
      <Panel
        className="min-h-0 flex-1"
        title={
          <div className="flex items-center gap-1">
            {(['terminal', 'preview'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded px-2 py-0.5 text-[12px] font-semibold uppercase tracking-wide transition-colors ${
                  view === v ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-200'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        }
        dense
        actions={
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-ink-500">
              {view === 'terminal'
                ? 'Ask a question or describe work — every step shows here'
                : 'The product the fleet maintains, live'}
            </span>
            {view === 'terminal' && (log.length > 0 || turns.length > 0) && (
              <button
                type="button"
                onClick={newConversation}
                className="rounded px-2 py-0.5 text-[11px] text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
              >
                New conversation
              </button>
            )}
          </div>
        }
      >
        {/* The composer stays mounted in both views: watching the execution and
            typing the next instruction are the same activity, not two modes. */}
        <div className={`flex min-h-0 flex-1 flex-col ${view === 'preview' ? 'hidden' : ''}`}>
          <div className="min-h-0 flex-1">
            <TerminalLog lines={log} live={busy} />
          </div>

          {error && (
            <div className="border-t border-crit-500/30 bg-crit-500/10 px-4 py-2 font-mono text-[12px] text-crit-400">
              {error}
            </div>
          )}

          {/* The starters stay reachable while the terminal is empty - a blank
              prompt is a worse first impression than three examples. */}
          {log.length === 0 && <Starters onPick={setInput} />}

          <div className="border-t border-ink-700 p-3">
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {attachments.map((a) => (
                  <span
                    key={a.path}
                    className="inline-flex items-center gap-1.5 rounded border border-ink-600 bg-ink-850 px-2 py-1 text-[11px] text-ink-300"
                  >
                    {a.name}
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
                      className="text-ink-500 hover:text-crit-400"
                      aria-label={`Remove ${a.name}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void attach(e.target.files)}
            />
            <div className="flex items-end gap-2 rounded-xl border border-ink-600 bg-ink-850 px-2.5 py-2 transition-colors focus-within:border-signal-500">
              <button
                onClick={() => fileRef.current?.click()}
                title="Attach a file"
                aria-label="Attach a file"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-200"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21.4 11.1 12.3 20.2a5.6 5.6 0 0 1-7.9-7.9l9.2-9.1a3.7 3.7 0 1 1 5.3 5.3l-9.2 9.1a1.9 1.9 0 0 1-2.6-2.6l8.5-8.4" strokeLinecap="round" />
                </svg>
              </button>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder="Add a settings page… / What's running? / Summarise the last incident as a PDF"
                className="max-h-40 min-h-[32px] flex-1 resize-none bg-transparent py-1.5 text-[13px] leading-relaxed text-ink-100 outline-none placeholder:text-ink-500"
              />
              <Button
                variant="primary"
                onClick={() => void send()}
                disabled={busy || !input.trim()}
                className="shrink-0 gap-1.5"
              >
                {busy ? 'Working…' : 'Send'}
                {!busy && (
                  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 16 16 4M8 4h8v8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-ink-500">
              Press Enter to send · Shift + Enter for a new line
            </p>
          </div>
        </div>

        {view === 'preview' && (
          <div className="min-h-0 flex-1 bg-ink-850">
            <iframe
              src="/app/"
              title="The product the fleet maintains"
              className="h-full w-full border-0"
            />
          </div>
        )}
      </Panel>
    } right={<ControlSidebar overview={overview} />} />
    </div>
  );
}

/** Three starting points, as a strip above the composer. */
function Starters({ onPick }: { onPick: (s: string) => void }) {
  const examples = [
    'What is running right now?',
    'Add a dark theme toggle to the chat UI',
    'Summarise the last incident as a PDF',
  ];
  return (
    <div className="flex flex-wrap gap-1.5 border-t border-ink-800 px-3 pt-2.5">
      {examples.map((e) => (
        <button
          key={e}
          onClick={() => onPick(e)}
          className="rounded-full border border-ink-700 bg-ink-850 px-3 py-1 font-mono text-[11px] text-ink-400 transition-colors hover:border-signal-500/50 hover:text-ink-100"
        >
          {e}
        </button>
      ))}
    </div>
  );
}

