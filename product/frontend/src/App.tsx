import { useEffect, useRef, useState } from 'react';
import { checkHealth, streamChat, type Message } from './lib/chat.ts';

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void checkHealth().then((h) => setReady(h.ready)).catch(() => setReady(false));
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || streaming) return;

    const next: Message[] = [...messages, { role: 'user', content: question }];
    setMessages([...next, { role: 'assistant', content: '' }]);
    setInput('');
    setError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat(
        next,
        (chunk) =>
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last?.role === 'assistant') {
              copy[copy.length - 1] = { ...last, content: last.content + chunk };
            }
            return copy;
          }),
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
        // Drop the empty bubble so the transcript stays honest.
        setMessages((prev) => (prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  };

  const empty = messages.length === 0;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-3">
          <img src="./brightcone-logo.webp" alt="" className="h-7 w-7 object-contain" aria-hidden />
          <div className="flex-1">
            <h1 className="text-[14px] font-semibold tracking-tight">Assistant</h1>
          </div>
          {!empty && (
            <button
              onClick={() => { setMessages([]); setError(null); inputRef.current?.focus(); }}
              className="rounded-md px-2.5 py-1.5 text-[13px] text-text-faint transition-colors hover:bg-raised hover:text-text"
            >
              New chat
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5">
          {empty ? (
            <EmptyState onPick={(q) => void send(q)} disabled={ready === false} />
          ) : (
            <div className="space-y-7 py-8">
              {messages.map((m, i) => (
                <Turn
                  key={i}
                  message={m}
                  streaming={streaming && i === messages.length - 1 && m.role === 'assistant'}
                />
              ))}
            </div>
          )}

          {error && (
            <div className="mb-6 rounded-lg border border-line bg-raised px-4 py-3 text-[13px] leading-relaxed">
              <span className="font-medium">That didn't go through.</span>{' '}
              <span className="text-text-soft">{error}</span>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </main>

      <footer className="border-t border-line bg-page">
        <div className="mx-auto max-w-3xl px-5 py-4">
          {ready === false && (
            <p className="mb-2.5 text-[13px] text-text-faint">
              The assistant is not configured yet, so answers are unavailable.
            </p>
          )}
          <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-page px-3 py-2 transition-colors focus-within:border-accent">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              disabled={ready === false}
              placeholder="Ask anything"
              className="max-h-48 min-h-[26px] flex-1 resize-none bg-transparent py-1 text-[15px] leading-relaxed outline-none placeholder:text-text-faint disabled:cursor-not-allowed"
            />
            {streaming ? (
              <button
                onClick={() => abortRef.current?.abort()}
                title="Stop"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-raised text-text-soft transition-colors hover:bg-line"
              >
                <span className="block h-2.5 w-2.5 rounded-[2px] bg-current" />
              </button>
            ) : (
              <button
                onClick={() => void send(input)}
                disabled={!input.trim() || ready === false}
                title="Send"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-white transition-opacity disabled:opacity-25"
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 16V4M4.5 9.5 10 4l5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
          <p className="mt-2 text-center text-[11px] text-text-faint">
            Enter to send · Shift + Enter for a new line
          </p>
        </div>
      </footer>
    </div>
  );
}

function EmptyState({ onPick, disabled }: { onPick: (q: string) => void; disabled: boolean }) {
  const suggestions = [
    'Explain the difference between SQL and NoSQL',
    'What makes a good API design?',
    'How does HTTPS actually work?',
  ];
  return (
    <div className="flex min-h-[55vh] flex-col items-center justify-center text-center">
      <img src="./brightcone-logo.webp" alt="" className="mb-5 h-12 w-12 object-contain opacity-90" aria-hidden />
      <h2 className="text-[22px] font-semibold tracking-tight">What would you like to know?</h2>
      <p className="mt-1.5 text-[14px] text-text-faint">Ask a question and the answer streams back as it is written.</p>
      {!disabled && (
        <div className="mt-7 flex w-full max-w-lg flex-col gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => onPick(s)}
              className="rounded-lg border border-line px-4 py-2.5 text-left text-[14px] text-text-soft transition-colors hover:border-line-strong hover:bg-raised hover:text-text"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Turn({ message, streaming }: { message: Message; streaming: boolean }) {
  if (message.role === 'user') {
    return (
      <div className="rise flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[15px] leading-relaxed text-text">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="rise">
      <div
        className={`whitespace-pre-wrap text-[15px] leading-[1.7] text-text ${streaming ? 'caret' : ''}`}
      >
        {message.content}
      </div>
    </div>
  );
}
