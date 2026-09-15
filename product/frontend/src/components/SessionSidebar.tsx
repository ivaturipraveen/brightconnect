import type { SessionMetadata } from '../lib/session.ts';
import SessionItem from './SessionItem.tsx';

interface SessionSidebarProps {
  sessions: SessionMetadata[];
  currentSessionId: string | null;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
}

export default function SessionSidebar({
  sessions,
  currentSessionId,
  onNewChat,
  onSelectSession,
  onDeleteSession,
}: SessionSidebarProps) {
  // Sort sessions by updatedAt in descending order (most recent first)
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <aside className="flex w-64 flex-col border-r border-line bg-raised">
      {/* New Chat Button */}
      <div className="border-b border-line p-3">
        <button
          onClick={onNewChat}
          className="w-full rounded-lg border border-line px-3 py-2 text-[13px] font-medium text-text transition-colors hover:border-line-strong hover:bg-page"
        >
          + New chat
        </button>
      </div>

      {/* Sessions List */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="p-4 text-center text-[12px] text-text-faint">
            No sessions yet
          </div>
        ) : (
          <nav className="space-y-1 p-2">
            {sorted.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isActive={currentSessionId === session.id}
                onSelect={() => onSelectSession(session.id)}
                onDelete={() => onDeleteSession(session.id)}
              />
            ))}
          </nav>
        )}
      </div>
    </aside>
  );
}
