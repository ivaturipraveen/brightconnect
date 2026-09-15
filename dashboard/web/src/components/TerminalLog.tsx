import { useEffect, useRef } from 'react';

/**
 * The execution stream, the way the CLI shows it.
 *
 * The console shows the answer; this shows the work - every tool call with its
 * arguments, every result, the reasoning when the model emits it, and the
 * mission events that follow. People who have used Claude Code expect to be
 * able to watch it run rather than wait for a paragraph, and "what did it
 * actually do" is the question a demo audience asks first.
 */

export interface TerminalLine {
  at: number;
  kind: 'prompt' | 'text' | 'thinking' | 'tool' | 'result' | 'mission' | 'document' | 'error' | 'system';
  text: string;
  detail?: string;
  /** Rendered as a link when present - a mission, or a generated document. */
  href?: string;
}

const STYLE: Record<TerminalLine['kind'], { marker: string; className: string }> = {
  prompt:   { marker: '›', className: 'text-signal-300' },
  text:     { marker: '·', className: 'text-ink-100' },
  thinking: { marker: '~', className: 'text-think-400' },
  tool:     { marker: '⟳', className: 'text-warn-400' },
  result:   { marker: '←', className: 'text-ink-400' },
  mission:  { marker: '»', className: 'text-ok-400' },
  document: { marker: '⇩', className: 'text-signal-300' },
  error:    { marker: '✗', className: 'text-crit-400' },
  system:   { marker: '·', className: 'text-ink-500' },
};

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function TerminalLog({ lines, live }: { lines: TerminalLine[]; live: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the tail, but only while the person is already at the bottom -
  // yanking the view back while they are reading something is worse than
  // missing a line.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (atBottom) endRef.current?.scrollIntoView({ block: 'end' });
  }, [lines]);

  if (lines.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div>
          <div className="font-mono text-[13px] text-ink-400">Ready.</div>
          <div className="mt-1 text-[12px] text-ink-500">
            Type below. Every step the fleet takes — each tool call, its result, and the
            missions it starts — appears here as it happens.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto bg-ink-950/60 px-3 py-3 font-mono text-[12px] leading-relaxed">
      {lines.map((l, i) => {
        const style = STYLE[l.kind];
        // What you asked and what came back is the conversation; the rest is
        // the machine working. Give the first more room so it stays findable
        // in a stream that is mostly the second.
        const conversation = l.kind === 'prompt' || l.kind === 'text';
        return (
          <div
            key={i}
            className={
              conversation
                ? `my-1.5 flex gap-2 rounded border-l-2 py-1.5 pl-2 pr-1 ${
                    l.kind === 'prompt'
                      ? 'border-signal-500 bg-signal-500/[0.06]'
                      : 'border-ink-600 bg-ink-900/70'
                  }`
                : 'flex gap-2 py-px'
            }
          >
            <span className="shrink-0 select-none text-ink-600">{clock(l.at)}</span>
            <span className={`shrink-0 select-none ${style.className}`}>{style.marker}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
              {l.href ? (
                <a
                  href={l.href}
                  target={l.href.startsWith('http') ? '_blank' : undefined}
                  rel="noreferrer"
                  className={`${style.className} underline decoration-dotted underline-offset-2 hover:decoration-solid`}
                >
                  {l.text}
                </a>
              ) : (
                <span className={`${style.className} ${conversation ? 'text-[12.5px]' : ''}`}>
                  {l.text}
                </span>
              )}
              {l.detail && <span className="text-ink-500"> {l.detail}</span>}
            </span>
          </div>
        );
      })}
      {live && (
        <div className="flex gap-2 py-px text-ink-500">
          <span className="select-none">{clock(Date.now())}</span>
          <span className="animate-pulse select-none">▍</span>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
