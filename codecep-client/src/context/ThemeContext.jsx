import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_THEME_ID,
  THEME_LIST,
  THEME_STORAGE_KEY,
  normalizeThemeId,
  themeById,
} from "../lib/themes";

// ── Theme selection (UI polish part 2) ──────────────────────────────────────
//
// PRESENTATIONAL ONLY. This provider owns one string, writes it to one
// attribute on <html>, and mirrors it to localStorage. It touches no route, no
// request, no telemetry and no exam state.
//
// It sits ABOVE the router in main.jsx rather than inside a page, for two
// reasons. The exam IDE at /exam/:assignmentId and the propless dev flow at
// /legacy are both outside AppShell, so a provider mounted in the shell would
// leave the two screens a student actually sits in unthemed. And a provider
// that unmounts on navigation would re-read localStorage on every route
// change, which is a flash of the wrong palette for no gain.

const ThemeContext = createContext(null);

/** Read the persisted choice. Anything unreadable — no value, a blank string,
 *  a theme id that no longer exists, a localStorage that throws in a hardened
 *  browser — resolves to the default, because the alternate palette is opt-in
 *  and a broken preference is not an opt-in. */
function readStoredThemeId() {
  try {
    return normalizeThemeId(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function ThemeProvider({ children }) {
  const [themeId, setThemeIdState] = useState(readStoredThemeId);

  // The attribute IS the theme — every color in the app resolves through the
  // token block it selects (theme.css). Written on <html> rather than a
  // wrapper div so it also covers anything portalled to <body>.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", themeId);
  }, [themeId]);

  const value = useMemo(() => {
    function setTheme(next) {
      const id = normalizeThemeId(next);
      setThemeIdState(id);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, id);
      } catch {
        // Persistence is a convenience. A browser that refuses the write still
        // gets the theme for this session — losing the preference on reload is
        // a far smaller failure than refusing to switch at all.
      }
    }
    return {
      themeId,
      theme: themeById(themeId),
      themes: THEME_LIST,
      setTheme,
    };
  }, [themeId]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * The current theme.
 *
 * Deliberately does NOT throw when used outside the provider, unlike useAuth.
 * The consumers are Monaco and xterm, which need a palette to paint at all; a
 * component tree that somehow rendered without the provider should fall back
 * to the default look, not crash an exam mid-session over a color.
 */
export function useTheme() {
  return (
    useContext(ThemeContext) ?? {
      themeId: DEFAULT_THEME_ID,
      theme: themeById(DEFAULT_THEME_ID),
      themes: THEME_LIST,
      setTheme: () => {},
    }
  );
}
