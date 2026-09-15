import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

/**
 * Versioned on purpose.
 *
 * The previous key was written on every mount, not just when somebody picked a
 * theme - so the first visit recorded whatever the default was at the time, and
 * that recording then outranked the default forever. Changing the default to
 * dark had no effect on anyone who had already opened the dashboard once.
 * Bumping the key retires those automatic writes; only a deliberate choice is
 * stored under the new one.
 */
const KEY = 'brightconnect-theme.v2';

function initial(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Private browsing, or storage disabled. The default still applies.
  }
  // Dark is the product's default. A control panel usually sits open on a
  // second screen in a dim room, and the light theme is the deliberate choice.
  return 'dark';
}

/**
 * Theme, remembered per browser.
 *
 * Applied to the document root rather than held in React state alone, so the
 * CSS variables swap for everything at once - including anything rendered
 * outside the React tree.
 */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(initial);

  // Apply only. Writing here is what pinned every returning visitor to whatever
  // the default happened to be on their first visit.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /** Persist only a deliberate choice, so the default stays changeable. */
  const choose = (next: Theme) => {
    setTheme(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Not being able to remember the choice is not a reason to fail to apply it.
    }
  };

  return [theme, choose];
}
