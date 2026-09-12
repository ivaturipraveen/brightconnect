import { useEffect, useRef, useState } from 'react';
import type { MissionEvent } from './api.ts';

type Handlers = {
  onEvent?: (e: MissionEvent) => void;
  onMission?: (m: { missionId: string; status: string }) => void;
  onApproval?: (a: any) => void;
};

/**
 * Subscribe to the server's activity stream.
 *
 * Handlers are held in a ref so a parent re-render does not tear down and
 * rebuild the EventSource - reconnecting mid-mission would drop events.
 */
export function useActivityStream(handlers: Handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource('/api/stream');

    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));

    es.addEventListener('event', (ev) => {
      try {
        ref.current.onEvent?.(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* a malformed frame should not kill the stream */
      }
    });
    es.addEventListener('mission', (ev) => {
      try {
        ref.current.onMission?.(JSON.parse((ev as MessageEvent).data));
      } catch {}
    });
    es.addEventListener('approval', (ev) => {
      try {
        ref.current.onApproval?.(JSON.parse((ev as MessageEvent).data));
      } catch {}
    });

    return () => es.close();
  }, []);

  return { connected };
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
