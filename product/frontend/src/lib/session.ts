import type { Message } from './chat.ts';

/**
 * Metadata for a session - stored in the sessions list.
 */
export interface SessionMetadata {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A complete session with all messages.
 */
export interface Session extends SessionMetadata {
  messages: Message[];
}

/**
 * Extract a title from the first user message, truncating to a reasonable length.
 */
export function generateTitleFromMessage(content: string): string {
  const maxLength = 60;
  const cleaned = content.trim().replace(/\n/g, ' ').replace(/\s+/g, ' ');
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + '…' : cleaned;
}

/**
 * Load all session metadata from localStorage.
 */
export function loadSessionList(): SessionMetadata[] {
  try {
    const stored = localStorage.getItem('brightconnect:sessions');
    if (!stored) return [];
    const parsed = JSON.parse(stored) as SessionMetadata[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Save session metadata list to localStorage.
 */
export function saveSessionList(sessions: SessionMetadata[]): void {
  try {
    localStorage.setItem('brightconnect:sessions', JSON.stringify(sessions));
  } catch (error) {
    console.error('Failed to save session list:', error);
  }
}

/**
 * Load a single session by ID.
 */
export function loadSession(id: string): Session | null {
  try {
    const stored = localStorage.getItem(`brightconnect:session:${id}`);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Session;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save a session to localStorage.
 */
export function saveSession(session: Session): void {
  try {
    localStorage.setItem(`brightconnect:session:${session.id}`, JSON.stringify(session));
  } catch (error) {
    console.error('Failed to save session:', error);
  }
}

/**
 * Delete a session from localStorage.
 */
export function deleteSession(id: string): void {
  try {
    localStorage.removeItem(`brightconnect:session:${id}`);
  } catch (error) {
    console.error('Failed to delete session:', error);
  }
}

/**
 * Get the currently active session ID.
 */
export function getCurrentSessionId(): string | null {
  try {
    const stored = localStorage.getItem('brightconnect:current');
    return stored ? String(stored) : null;
  } catch {
    return null;
  }
}

/**
 * Set the currently active session ID.
 */
export function setCurrentSessionId(id: string): void {
  try {
    localStorage.setItem('brightconnect:current', id);
  } catch (error) {
    console.error('Failed to set current session ID:', error);
  }
}

/**
 * Create a new session with a generated ID.
 */
export function createNewSession(): Session {
  const id = crypto.randomUUID();
  const now = Date.now();
  return {
    id,
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}
