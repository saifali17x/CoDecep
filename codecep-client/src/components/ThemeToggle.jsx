import { useTheme } from "../context/ThemeContext";
import "./ThemeToggle.css";

// ── Theme switcher (UI polish part 2) ───────────────────────────────────────
//
// A segmented control rather than a single toggle button, because a two-state
// button has to label either the state it is in or the state it would move to,
// and whichever it picks reads as the other one to half its users. Two
// labelled segments say which themes exist and which one is on, unambiguously.
//
// Where it appears is a decision, not an oversight: the app shell (portal,
// class, dashboard) and the auth pages. It is deliberately NOT in the exam
// TopBar — that strip is kept minimal on purpose so nothing tempts a student
// mid-exam, and a theme is not a thing to change with a timer running. The
// choice persists, so a student who prefers Quarantine picks it before they
// open the paper and the exam IDE honours it.
export default function ThemeToggle({ compact = false }) {
  const { themeId, themes, setTheme } = useTheme();

  return (
    <div
      className={`theme-toggle ${compact ? "compact" : ""}`}
      role="group"
      aria-label="Colour theme"
    >
      {themes.map((t) => {
        const active = t.id === themeId;
        return (
          <button
            key={t.id}
            type="button"
            className={`theme-toggle-opt ${active ? "active" : ""}`}
            onClick={() => setTheme(t.id)}
            aria-pressed={active}
            title={`${t.label} theme — ${t.blurb}`}
          >
            {/* The swatch previews the theme's two most characteristic colors.
                It is decoration on top of the label, never instead of it: the
                control still reads correctly with color vision differences,
                the same rule the severity pills follow. */}
            <span className={`theme-swatch ${t.id}`} aria-hidden="true" />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
