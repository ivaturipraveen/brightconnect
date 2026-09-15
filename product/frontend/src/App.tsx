import { useEffect, useRef, useState } from 'react';
import { checkHealth, streamChat, type Message } from './lib/chat.ts';

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void checkHealth()
      .then((h) => setReady(h.ready))
      .catch(() => setReady(false));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const next: Message[] = [...messages, { role: 'user', content: text }];
    setMessages([...next, { role: 'assistant', content: '' }]);
    setInput('');
    setError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat(
        next,
        (chunk) => {
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last?.role === 'assistant') {
              copy[copy.length - 1] = { ...last, content: last.content + chunk };
            }
            return copy;
          });
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
        // Drop the empty assistant bubble so the transcript stays honest.
        setMessages((prev) =>
          prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev,
        );
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-4">
      <header className="flex items-center justify-between border-b border-line py-3">
        <div>
          <h1 className="text-[15px] font-semibold">Assistant</h1>
          <p className="text-[12px] text-text-muted">Ask a question.</p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={() => { setMessages([]); setError(null); }}
            className="rounded-md border border-line px-2.5 py-1 text-[12px] text-text-muted hover:bg-surface-sunken"
          >
            New chat
          </button>
        )}
      </header>

      {ready === false && (
        <div className="mt-3 rounded-md border border-line bg-surface-sunken px-3 py-2 text-[13px] text-text-muted">
          The service is not configured yet, so answers are unavailable.
        </div>
      )}

      <main className="flex-1 space-y-4 overflow-y-auto py-5">
        {messages.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <p className="text-[15px] font-medium">What would you like to know?</p>
              <p className="mt-1 text-[13px] text-text-muted">
                Type a question below and press Enter.
              </p>
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <Bubble
              key={i}
              message={m}
              streaming={streaming && i === messages.length - 1 && m.role === 'assistant'}
            />
          ))
        )}
        {error && (
          <div className="rounded-md border border-line bg-surface-sunken px-3 py-2 text-[13px]">
            <span className="font-medium">Something went wrong.</span>{' '}
            <span className="text-text-muted">{error}</span>
          </div>
        )}
        <div ref={endRef} />
      </main>

      <footer className="border-t border-line py-3">
        <div className="flex items-end gap-2">
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
            placeholder="Ask a question…"
            className="max-h-40 min-h-[42px] flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2.5 text-[14px] outline-none placeholder:text-text-muted focus:border-accent"
          />
          {streaming ? (
            <button
              onClick={stop}
              className="rounded-lg border border-line px-4 py-2.5 text-[14px] font-medium hover:bg-surface-sunken"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!input.trim()}
              className="rounded-lg bg-accent px-4 py-2.5 text-[14px] font-medium text-white disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-text-muted">
          Enter to send, Shift+Enter for a new line.
        </p>
      </footer>
    </div>
  );
}

function Bubble({ message, streaming }: { message: Message; streaming: boolean }) {
  const isUser = message.role === 'user';
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed ${
          isUser
            ? 'bg-accent text-white'
            : 'border border-line bg-surface-sunken text-text'
        } ${streaming ? 'caret' : ''}`}
      >
        {message.content}
      </div>
    </div>
  );
}
