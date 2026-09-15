import { useEffect, useState, useCallback } from 'react';
import type { Message } from '../lib/chat.ts';
import type { Session, SessionMetadata } from '../lib/session.ts';
import {
  createNewSession,
  loadSessionList,
  loadSession,
  saveSession,
  saveSessionList,
  deleteSession,
  getCurrentSessionId,
  setCurrentSessionId,
  generateTitleFromMessage,
} from '../lib/session.ts';

/**
 * Hook to manage session state and localStorage persistence.
 * Returns the current session, list of sessions, and operations to manipulate them.
 */
export function useSessionManager() {
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Initialize on mount: load sessions and restore the last active session
  useEffect(() => {
    const stored = loadSessionList();
    setSessions(stored);

    const currentId = getCurrentSessionId();
    if (currentId) {
      const session = loadSession(currentId);
      if (session) {
        setCurrentSession(session);
      } else {
        // Current session was deleted, create a new one
        const newSession = createNewSession();
        setCurrentSession(newSession);
        setCurrentSessionId(newSession.id);
        saveSession(newSession);
        const newSessions = [...stored, { id: newSession.id, title: newSession.title, createdAt: newSession.createdAt, updatedAt: newSession.updatedAt }];
        setSessions(newSessions);
        saveSessionList(newSessions);
      }
    } else {
      // No current session, create one
      const newSession = createNewSession();
      setCurrentSession(newSession);
      setCurrentSessionId(newSession.id);
      saveSession(newSession);
      const newSessions = [...stored, { id: newSession.id, title: newSession.title, createdAt: newSession.createdAt, updatedAt: newSession.updatedAt }];
      setSessions(newSessions);
      saveSessionList(newSessions);
    }

    setInitialized(true);
  }, []);

  // Update messages in the current session
  const updateMessages = useCallback((messages: Message[]) => {
    setCurrentSession((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, messages, updatedAt: Date.now() };
      saveSession(updated);
      return updated;
    });
  }, []);

  // Set the title from the first user message
  const setTitleFromFirstMessage = useCallback(() => {
    setCurrentSession((prev) => {
      if (!prev || prev.messages.length === 0) return prev;
      const firstUserMessage = prev.messages.find((m) => m.role === 'user');
      if (!firstUserMessage) return prev;

      const title = generateTitleFromMessage(firstUserMessage.content);
      const updated = { ...prev, title, updatedAt: Date.now() };
      saveSession(updated);

      // Update the sessions list
      setSessions((prevSessions) => {
        const updated_sessions = prevSessions.map((s) =>
          s.id === prev.id
            ? { ...s, title, updatedAt: Date.now() }
            : s
        );
        saveSessionList(updated_sessions);
        return updated_sessions;
      });

      return updated;
    });
  }, []);

  // Create a new session and switch to it
  const createSession = useCallback(() => {
    const newSession = createNewSession();
    setCurrentSession(newSession);
    setCurrentSessionId(newSession.id);
    const newMetadata = {
      id: newSession.id,
      title: newSession.title,
      createdAt: newSession.createdAt,
      updatedAt: newSession.updatedAt,
    };
    setSessions((prev) => {
      const updated = [...prev, newMetadata];
      saveSessionList(updated);
      return updated;
    });
    saveSession(newSession);
  }, []);

  // Switch to an existing session
  const switchSession = useCallback((id: string) => {
    const session = loadSession(id);
    if (session) {
      setCurrentSession(session);
      setCurrentSessionId(id);
    }
  }, []);

  // Delete a session
  const removeSession = useCallback((id: string) => {
    deleteSession(id);

    // Check if we're deleting the current session
    const isDeletingCurrent = currentSession?.id === id;

    // Update the sessions list
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      saveSessionList(remaining);

      // If we deleted the current session, switch to the first remaining or create a new one
      if (isDeletingCurrent) {
        if (remaining.length === 0) {
          const newSession = createNewSession();
          setCurrentSession(newSession);
          setCurrentSessionId(newSession.id);
          saveSession(newSession);
          return [{ id: newSession.id, title: newSession.title, createdAt: newSession.createdAt, updatedAt: newSession.updatedAt }];
        } else {
          const nextSession = loadSession(remaining[0].id);
          if (nextSession) {
            setCurrentSession(nextSession);
            setCurrentSessionId(remaining[0].id);
          }
        }
      }

      return remaining;
    });
  }, [currentSession?.id]);

  return {
    sessions,
    currentSession,
    initialized,
    updateMessages,
    setTitleFromFirstMessage,
    createSession,
    switchSession,
    removeSession,
  };
}
