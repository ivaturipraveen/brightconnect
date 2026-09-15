/**
 * In-process pub/sub that fans mission activity out to connected dashboards
 * over SSE. Every event is persisted first, then broadcast, so a client that
 * connects late can replay history and then stream live without a gap.
 */
import { EventEmitter } from 'node:events';
import { events } from './db/index.ts';
import type { MissionEvent } from './types.ts';

type Envelope =
  | { channel: 'event'; payload: MissionEvent }
  | { channel: 'mission'; payload: { missionId: string; status: string } }
  | { channel: 'approval'; payload: unknown }
  | { channel: 'alert'; payload: unknown };

class Bus extends EventEmitter {
  /**
   * Serialises event writes.
   *
   * The governance trail is only useful in order, and persistence is now
   * asynchronous, so concurrent agents would otherwise interleave their rows.
   * Chaining the writes keeps the trail ordered while letting callers fire and
   * forget - which matters because emitEvent is called from dozens of places on
   * the hot path of a running mission.
   */
  private writes: Promise<unknown> = Promise.resolve();

  /** Persist an event, then broadcast it. Safe to call without awaiting. */
  emitEvent(e: Omit<MissionEvent, 'id' | 'createdAt'>): Promise<MissionEvent | null> {
    const queued = this.writes.then(async () => {
      try {
        const stored = await events.append(e);
        this.publish({ channel: 'event', payload: stored });
        return stored;
      } catch (err) {
        // A trail write that fails must not take the mission down with it.
        console.error('[bus] failed to persist event:', err instanceof Error ? err.message : err);
        return null;
      }
    });
    this.writes = queued;
    return queued;
  }

  publish(envelope: Envelope) {
    this.emit('message', envelope);
  }

  subscribe(listener: (e: Envelope) => void): () => void {
    this.on('message', listener);
    return () => this.off('message', listener);
  }
}

export const bus = new Bus();
// A busy mission fans out to every open dashboard tab; the default cap of 10
// listeners would warn spuriously.
bus.setMaxListeners(100);
