import { useEffect, useRef, useState } from 'react';
import type { MissionEvent } from './api.ts';

type Handlers = {
  onEvent?: (e: MissionEvent) => void;
  onMission?: (m: { missionId: string; status: string }) => void;
  onApproval?: (a: any) => void;
};

/**
 * One activity stream, shared by every component that wants it.
 *
 * Each page used to open its own EventSource, and the shell opened one too, so
 * two or three were live at once against a browser limit of six connections per
 * origin over HTTP/1.1 - which is how the header ends up stuck on
 * "reconnecting" while ordinary API calls queue behind streams that never
 * finish. One connection, fanned out to subscribers, with the socket closed
 * when the last of them goes away.
 */

type Listener = { handlers: Handlers };

const listeners = new Set<Listener>();
const statusListeners = new Set<(connected: boolean) => void>();

let source: EventSource | null = null;
let connected = false;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  for (const fn of statusListeners) fn(next);
}

function fanOut(pick: (h: Handlers) => ((payload: any) => void) | undefined, raw: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // a malformed frame should not take the stream down
  }
  for (const l of listeners) pick(l.handlers)?.(payload);
}

function connect() {
  if (source || listeners.size === 0) return;

  const es = new EventSource('/api/stream');
  source = es;

  es.addEventListener('open', () => {
    retry = 0;
    setConnected(true);
  });

  // EventSource reconnects on its own, but only while the connection was
  // cleanly lost. A server that is down answers immediately and it gives up,
  // so the retry is ours: back off, then rebuild the socket.
  es.addEventListener('error', () => {
    setConnected(false);
    if (es.readyState !== EventSource.CLOSED) return;
    es.close();
    if (source === es) source = null;
    if (listeners.size === 0 || retryTimer) return;
    const delay = Math.min(1000 * 2 ** retry, 15_000);
    retry += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  });

  es.addEventListener('event', (ev) => fanOut((h) => h.onEvent, (ev as MessageEvent).data));
  es.addEventListener('mission', (ev) => fanOut((h) => h.onMission, (ev as MessageEvent).data));
  es.addEventListener('approval', (ev) => fanOut((h) => h.onApproval, (ev as MessageEvent).data));
}

function release() {
  if (listeners.size > 0) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  source?.close();
  source = null;
  setConnected(false);
}

/** Subscribe to the server's activity stream. */
export function useActivityStream(handlers: Handlers) {
  // Held in a ref so a parent re-render does not resubscribe and drop events.
  const ref = useRef(handlers);
  ref.current = handlers;
  const [isConnected, setIsConnected] = useState(connected);

  useEffect(() => {
    const listener: Listener = { get handlers() { return ref.current; } };
    listeners.add(listener);
    statusListeners.add(setIsConnected);
    connect();
    setIsConnected(connected);

    return () => {
      listeners.delete(listener);
      statusListeners.delete(setIsConnected);
      // Deferred: navigating between pages unmounts one subscriber and mounts
      // another in the same tick, and tearing the socket down in between would
      // reconnect on every route change.
      setTimeout(release, 0);
    };
  }, []);

  return { connected: isConnected };
}

/** Poll a fetcher on an interval, pausing while the tab is hidden. */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs = 4000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const next = await fetcherRef.current();
        if (alive) { setData(next); setError(null); }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs]);

  return { data, error, refresh: () => fetcherRef.current().then(setData).catch(() => {}) };
}
