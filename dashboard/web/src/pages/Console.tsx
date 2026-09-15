import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Attachment, type ConsoleEvent, type Overview } from '../lib/api.ts';
import { useActivityStream } from '../lib/stream.ts';
import { Badge, Button, Panel, fmtCost } from '../components/ui.tsx';
import ControlSidebar from '../components/ControlSidebar.tsx';

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

export default function Console() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [view, setView] = useState<'console' | 'preview'>('console');
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadOverview = () => void api.overview().then(setOverview).catch(() => {});
  useEffect(() => {
    loadOverview();
    // The fleet's status is the point of the sidebar, so keep it fresh even
    // when no stream event happens to fire.
    const id = setInterval(loadOverview, 5000);
    return () => clearInterval(id);
  }, []);
  useActivityStream({ onMission: loadOverview, onEvent: loadOverview });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, busy]);

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
          } else if (e.type === 'tool' && e.text) {
            patch((t) => ({ ...t, tools: [...(t.tools ?? []), e.text!] }));
          } else if (e.type === 'mission' && e.missionId) {
            patch((t) => ({ ...t, missionIds: [...(t.missionIds ?? []), e.missionId!] }));
            loadOverview();
          } else if (e.type === 'document' && e.document) {
            patch((t) => ({ ...t, documents: [...(t.documents ?? []), e.document!] }));
          } else if (e.type === 'done') {
            patch((t) => ({ ...t, cost: e.cost }));
          } else if (e.type === 'error') {
            setError(e.text ?? 'Something went wrong');
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
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Panel
        title={
          <div className="flex items-center gap-1">
            {(['console', 'preview'] as const).map((v) => (
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
          <span className="text-[11px] text-ink-500">
            {view === 'console'
              ? 'ask a question, or describe work to be done'
              : 'the product the fleet maintains, live'}
          </span>
        }
      >
        <div className={`flex min-h-0 flex-1 flex-col ${view === 'preview' ? 'hidden' : ''}`}>
          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {turns.length === 0 ? (
              <Welcome onPick={setInput} />
            ) : (
              turns.map((t, i) => <TurnView key={i} turn={t} streaming={busy && i === turns.length - 1} />)
            )}
            {error && (
              <div className="rounded-md border border-crit-500/30 bg-crit-500/10 px-3 py-2 text-[13px] text-crit-400">
                {error}
              </div>
            )}
            <div ref={endRef} />
          </div>

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

      <ControlSidebar overview={overview} />
    </div>
  );
}

function Welcome({ onPick }: { onPick: (s: string) => void }) {
  const examples = [
    { text: 'What is running right now?', icon: 'pulse' },
    { text: 'Add a dark theme toggle to the chat UI', icon: 'code' },
    { text: 'Summarise the last incident as a PDF', icon: 'doc' },
  ] as const;

  const Icon = ({ kind }: { kind: 'pulse' | 'code' | 'doc' }) => (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
      {kind === 'pulse' && <path d="M3 12h4l3-8 4 16 3-8h4" strokeLinecap="round" strokeLinejoin="round" />}
      {kind === 'code' && <path d="M8 6 3 12l5 6M16 6l5 6-5 6" strokeLinecap="round" strokeLinejoin="round" />}
      {kind === 'doc' && <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-signal-500/12 text-signal-400">
        <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-3.9-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 4 11.5a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8 8.4z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h2 className="text-[24px] font-semibold tracking-tight text-ink-100">What needs doing?</h2>
      <p className="mt-2 max-w-md text-[14px] leading-relaxed text-ink-400">
        Describe a task and the fleet picks it up. Ask a question and it just answers.
      </p>
      <div className="mt-7 flex max-w-2xl flex-wrap justify-center gap-2">
        {examples.map((e) => (
          <button
            key={e.text}
            onClick={() => onPick(e.text)}
            className="inline-flex items-center gap-2 rounded-full border border-ink-700 bg-ink-850 px-3.5 py-2 text-[13px] text-ink-300 transition-colors hover:border-signal-500/50 hover:bg-ink-800 hover:text-ink-100"
          >
            <span className="text-ink-500"><Icon kind={e.icon} /></span>
            {e.text}
          </button>
        ))}
      </div>
    </div>
  );
}

function TurnView({ turn, streaming }: { turn: Turn; streaming: boolean }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-signal-500 px-3 py-2 text-[13px] text-white">
          {turn.content}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {turn.tools && turn.tools.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {turn.tools.map((t, i) => (
            <span key={i} className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-400">
              {t}
            </span>
          ))}
        </div>
      )}

      {turn.content && (
        <div className="whitespace-pre-wrap rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 text-[13px] leading-relaxed text-ink-200">
          {turn.content}
        </div>
      )}
      {!turn.content && streaming && (
        <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 text-[13px] text-ink-400">
          Thinking…
        </div>
      )}

      {turn.missionIds?.map((id) => (
        <Link
          key={id}
          to={`/missions/${id}`}
          className="flex items-center gap-2 rounded-lg border border-think-400/40 bg-think-400/10 px-3 py-2 text-[13px] hover:bg-think-400/15"
        >
          <Badge tone="think">mission started</Badge>
          <span className="font-mono text-[11px] text-ink-300">{id}</span>
          <span className="ml-auto text-[12px] text-signal-300">watch the flow →</span>
        </Link>
      ))}

      {turn.documents?.map((d) => (
        <a
          key={d.url}
          href={d.url}
          download
          className="flex items-center gap-2 rounded-lg border border-ok-500/40 bg-ok-500/10 px-3 py-2 text-[13px] hover:bg-ok-500/15"
        >
          <Badge tone="ok">document</Badge>
          <span className="truncate text-ink-100">{d.name}</span>
          <span className="ml-auto text-[12px] text-signal-300">download →</span>
        </a>
      ))}

      {turn.cost !== undefined && turn.cost > 0 && (
        <div className="text-[10px] text-ink-500">{fmtCost(turn.cost)}</div>
      )}
    </div>
  );
}
