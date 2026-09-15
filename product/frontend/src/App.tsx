import { useEffect, useRef, useState } from 'react';
import { checkHealth, streamChat, type Message } from './lib/chat.ts';
import { useSessionManager } from './hooks/useSessionManager.ts';
import SessionSidebar from './components/SessionSidebar.tsx';

export default function App() {
  const {
    sessions,
    currentSession,
    initialized,
    updateMessages,
    setTitleFromFirstMessage,
    createSession,
    switchSession,
    removeSession,
  } = useSessionManager();

  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const titleSetRef = useRef(false);

  useEffect(() => {
    void checkHealth().then((h) => setReady(h.ready)).catch(() => setReady(false));
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [currentSession?.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [currentSession?.messages, streaming]);

  const send = async (text: string) => {
    if (!currentSession) return;

    const question = text.trim();
    if (!question || streaming) return;

    const next: Message[] = [...(currentSession.messages || []), { role: 'user' as const, content: question }];
    const initialMessages: Message[] = [...next, { role: 'assistant' as const, content: '' }];
    updateMessages(initialMessages);
    setInput('');
    setError(null);
    setStreaming(true);

    // Set title from first message if not already set
    if (!titleSetRef.current && next.length === 1) {
      titleSetRef.current = true;
      setTitleFromFirstMessage();
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let currentMessages: Message[] = initialMessages;

    try {
      await streamChat(
        next,
        (chunk) => {
          // Update the assistant message with streamed content
          const copy: Message[] = [...currentMessages];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') {
            copy[copy.length - 1] = { ...last, content: last.content + chunk };
            currentMessages = copy;
            updateMessages(copy);
          }
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
        // Drop the empty bubble so the transcript stays honest.
        if (currentMessages[currentMessages.length - 1]?.content === '') {
          updateMessages(currentMessages.slice(0, -1));
        }
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  };

  if (!initialized || !currentSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-text-faint">Loading...</div>
      </div>
    );
  }

  const messages = currentSession.messages || [];
  const empty = messages.length === 0;

  return (
    <div className="flex h-full flex-row">
      {/* Sidebar */}
      <SessionSidebar
        sessions={sessions}
        currentSessionId={currentSession.id}
        onNewChat={() => {
          createSession();
          titleSetRef.current = false;
        }}
        onSelectSession={(id) => {
          switchSession(id);
          titleSetRef.current = false;
        }}
        onDeleteSession={removeSession}
      />

      {/* Main chat area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="border-b border-line">
          <div className="flex items-center gap-3 px-5 py-3">
            <img src="./brightcone-logo.webp" alt="" className="h-7 w-7 object-contain" aria-hidden />
            <div className="flex-1">
              <h1 className="text-[14px] font-semibold tracking-tight">Assistant</h1>
            </div>
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
