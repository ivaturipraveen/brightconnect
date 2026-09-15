import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'brightconnect-theme';

function initial(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Private browsing, or storage disabled. Fall through to the OS preference.
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Not being able to remember the choice is not a reason to fail to apply it.
    }
  }, [theme]);

  return [theme, setTheme];
}
