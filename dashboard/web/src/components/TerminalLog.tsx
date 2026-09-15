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
  kind: 'prompt' | 'text' | 'thinking' | 'tool' | 'result' | 'mission' | 'error' | 'system';
  text: string;
  detail?: string;
}

const STYLE: Record<TerminalLine['kind'], { marker: string; className: string }> = {
  prompt:   { marker: '›', className: 'text-signal-300' },
  text:     { marker: '·', className: 'text-ink-100' },
  thinking: { marker: '~', className: 'text-think-400' },
  tool:     { marker: '⟳', className: 'text-warn-400' },
  result:   { marker: '←', className: 'text-ink-400' },
  mission:  { marker: '»', className: 'text-ok-400' },
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
          <div className="font-mono text-[13px] text-ink-400">No execution yet.</div>
          <div className="mt-1 text-[12px] text-ink-500">
            Send something in the console and every tool call, result and mission event
            appears here as it happens.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto bg-ink-950/60 px-3 py-3 font-mono text-[12px] leading-relaxed">
      {lines.map((l, i) => {
        const style = STYLE[l.kind];
        return (
          <div key={i} className="flex gap-2 py-px">
            <span className="shrink-0 select-none text-ink-600">{clock(l.at)}</span>
            <span className={`shrink-0 select-none ${style.className}`}>{style.marker}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
              <span className={style.className}>{l.text}</span>
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
