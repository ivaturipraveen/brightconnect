import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Two panes with a handle you can drag.
 *
 * The side panel was a fixed 320-340px in a grid template. On a mission whose
 * specialists have long briefs that is too narrow to read, and on a short
 * mission it is wasted width, and neither could be changed. The width is
 * remembered per pane id, so a person sets it once.
 *
 * Pointer events rather than mouse events, so a trackpad drag and a touch drag
 * behave the same, and setPointerCapture keeps the drag alive when the cursor
 * outruns the handle.
 */
export default function SplitPane({
  id,
  left,
  right,
  initial = 340,
  min = 260,
  max = 720,
  className = '',
}: {
  /** Storage key, so each split remembers its own width. */
  id: string;
  left: ReactNode;
  right: ReactNode;
  initial?: number;
  min?: number;
  max?: number;
  className?: string;
}) {
  const storageKey = `brightconnect.split.${id}`;
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= min && saved <= max) return saved;
    } catch {
      /* storage disabled */
    }
    return initial;
  });
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const clamp = useCallback(
    (px: number) => Math.min(max, Math.max(min, px)),
    [min, max],
  );

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    // The handle sits to the left of the right-hand pane, so the pane's width
    // is whatever is left between the pointer and the container's right edge.
    setWidth(clamp(rect.right - e.clientX));
  };

  const stop = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {
      /* storage disabled */
    }
  };

  // Dragging over the page selects text otherwise, which looks broken.
  useEffect(() => {
    if (!dragging) return;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => { document.body.style.userSelect = previous; };
  }, [dragging]);

  /** Keyboard: the handle is focusable, arrows resize, Home restores. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = clamp(width + step);
    else if (e.key === 'ArrowRight') next = clamp(width - step);
    else if (e.key === 'Home') next = initial;
    if (next === null) return;
    e.preventDefault();
    setWidth(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      /* storage disabled */
    }
  };

  return (
    // The width rides on a CSS variable so the media query decides when it
    // applies: a `window.innerWidth` check would be read once and never again
    // when the window is resized.
    <div
      ref={containerRef}
      style={{ ['--pane-width' as string]: `${width}px` }}
      className={`flex min-h-0 min-w-0 flex-col lg:flex-row ${className}`}
    >
      {/* Slot contents must carry their own `flex-1`: a grid stretched its
          children for free, a flex column does not, and a panel at its natural
          height leaves dead space under the composer. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{left}</div>

      {/* A wide hit area around a thin visible line: a 1px target is a target
          nobody finds, and a 16px gutter looks like a mistake. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={stop}
        onPointerCancel={stop}
        onKeyDown={onKeyDown}
        onDoubleClick={() => {
          setWidth(initial);
          try {
            localStorage.setItem(storageKey, String(initial));
          } catch {
            /* storage disabled */
          }
        }}
        title="Drag to resize · double-click to reset"
        className="group relative mx-1 hidden w-2 shrink-0 cursor-col-resize touch-none lg:block"
      >
        <span
          className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 rounded transition-colors ${
            dragging ? 'bg-signal-500' : 'bg-ink-700 group-hover:bg-signal-500/60 group-focus:bg-signal-500'
          }`}
        />
      </div>

      <div className="flex min-h-0 w-full flex-col lg:w-[var(--pane-width)] lg:shrink-0">
        {right}
      </div>
    </div>
  );
}
