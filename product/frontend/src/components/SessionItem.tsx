import { useState } from 'react';
import type { SessionMetadata } from '../lib/session.ts';

interface SessionItemProps {
  session: SessionMetadata;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export default function SessionItem({
  session,
  isActive,
  onSelect,
  onDelete,
}: SessionItemProps) {
  const [showDelete, setShowDelete] = useState(false);

  const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  };

  return (
    <div
      role="menuitem"
      className={`group relative rounded-lg px-3 py-2 transition-colors ${
        isActive
          ? 'bg-page text-text'
          : 'text-text-soft hover:bg-page hover:text-text'
      }`}
    >
      <button
        onClick={onSelect}
        className="w-full truncate text-left text-[13px] leading-tight"
        title={session.title}
      >
        <div className="truncate font-medium">{session.title}</div>
        <div className="text-[11px] text-text-faint">{formatDate(session.updatedAt)}</div>
      </button>

      {/* Delete button - only show on hover or when explicitly opened */}
      {(isActive || showDelete) && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (showDelete) {
              onDelete();
            } else {
              setShowDelete(true);
            }
          }}
          onBlur={() => setTimeout(() => setShowDelete(false), 100)}
          className="absolute right-2 top-1/2 -translate-y-1/2 transform rounded p-1 text-text-faint transition-colors hover:bg-line hover:text-text"
          title={showDelete ? 'Confirm delete' : 'Delete session'}
          aria-label={showDelete ? 'Confirm delete' : 'Delete session'}
        >
          {showDelete ? (
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          ) : (
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}
