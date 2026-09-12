/**
 * In-process pub/sub that fans mission activity out to connected dashboards
 * over SSE. Every event is persisted first, then broadcast, so a client that
 * connects late can replay history and then stream live without a gap.
 */
import { EventEmitter } from 'node:events';
import { events } from './db.ts';
import type { MissionEvent } from './types.ts';

type Envelope =
  | { channel: 'event'; payload: MissionEvent }
  | { channel: 'mission'; payload: { missionId: string; status: string } }
  | { channel: 'approval'; payload: unknown }
  | { channel: 'alert'; payload: unknown };

class Bus extends EventEmitter {
  /** Persist an event, then broadcast it. Returns the stored row. */
  emitEvent(e: Omit<MissionEvent, 'id' | 'createdAt'>): MissionEvent {
    const stored = events.append(e);
    this.publish({ channel: 'event', payload: stored });
    return stored;
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
