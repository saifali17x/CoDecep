// ── Theme registry (UI polish part 2) ───────────────────────────────────────
//
// PRESENTATIONAL ONLY. Nothing here is read by capture, telemetry, execution,
// forensics, auth or the Immune Phase; deleting this module would change what
// the app looks like and nothing about what it records.
//
// The app themes by swapping CSS custom properties — one data attribute on
// <html>, defined in theme.css. Two consumers cannot participate in that,
// because they paint to a canvas rather than to styled DOM:
//
//   • Monaco, which takes a registered theme object
//   • xterm, which takes a color map on its instance options
//
// So their colors are duplicated here as literals. That duplication is the
// price of having a themed editor and terminal at all, and it is the one thing
// in this pass that can silently drift: a color changed in theme.css and not
// here shows up as a seam between the chrome (CSS) and the canvas (JS). Keep
// the two in step — theme.css names the tokens each field mirrors.

export const DEFAULT_THEME_ID = "default";

/** localStorage key. A missing, blank or unrecognised value falls back to the
 *  default theme, so a new user (and a corrupted value) sees the current look
 *  rather than being surprised by the alternate one. */
export const THEME_STORAGE_KEY = "codecep_theme";

// Monaco's built-in "vs-dark" is what the editor has always used, and the
// default theme keeps it verbatim rather than re-declaring it — a hand-rolled
// copy would be a second thing to drift.
const MONACO_DEFAULT = "vs-dark";
const MONACO_QUARANTINE = "codecep-quarantine";

export const THEMES = {
  default: {
    id: "default",
    label: "Default",
    // Shown beside the name in the switcher. Says what the theme IS, so the
    // choice does not depend on trying it.
    blurb: "The standard dark palette.",
    monacoTheme: MONACO_DEFAULT,
    // Registered with Monaco only when it is not a built-in.
    monacoDefinition: null,
    xterm: {
      background: "#0a0d12",
      foreground: "#e6edf3",
      cursor: "#0a0d12", // input is disabled — no blinking cursor to mislead
      selectionBackground: "#30363d",
      black: "#0a0d12",
      red: "#f85149",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#388bfd",
      cyan: "#58a6ff",
      white: "#e6edf3",
      brightBlack: "#6e7681",
    },
  },

  quarantine: {
    id: "quarantine",
    label: "Quarantine",
    blurb: "Atmospheric dark green and rust.",
    monacoTheme: MONACO_QUARANTINE,
    monacoDefinition: {
      base: "vs-dark",
      inherit: true,
      rules: [
        // Comments read as Faded Moss, keywords as Cordyceps, strings as
        // Clicker Sense — the same three roles the rest of the theme gives
        // those colors, so the editor is not a differently-themed island.
        { token: "comment", foreground: "859385", fontStyle: "italic" },
        { token: "keyword", foreground: "9fc473" },
        { token: "keyword.control", foreground: "9fc473" },
        { token: "string", foreground: "c3d6a4" },
        { token: "number", foreground: "d2a65c" },
        { token: "type", foreground: "a8c483" },
        { token: "type.identifier", foreground: "a8c483" },
        { token: "identifier", foreground: "e5e7e1" },
        { token: "delimiter", foreground: "859385" },
        { token: "operator", foreground: "c08f45" },
        // #include and friends — the C++ preprocessor, in the brass that the
        // theme reserves for "notable but not an error".
        { token: "keyword.directive", foreground: "c08f45" },
        { token: "keyword.directive.include", foreground: "c08f45" },
        { token: "string.include.identifier", foreground: "c3d6a4" },
        { token: "invalid", foreground: "d2664e" },
      ],
      colors: {
        // Abyss, matching --editor-bg. The DVR reuses this theme for its
        // read-only replay editor, so a forensic playback and the exam it
        // reconstructs look like the same tool.
        "editor.background": "#121412",
        "editor.foreground": "#e5e7e1",
        "editorLineNumber.foreground": "#4e5a4e",
        "editorLineNumber.activeForeground": "#9fc473",
        "editorCursor.foreground": "#9fc473",
        "editor.selectionBackground": "#2f4030",
        "editor.inactiveSelectionBackground": "#232a23",
        "editor.lineHighlightBackground": "#1a1d1a",
        "editor.lineHighlightBorder": "#00000000",
        "editorIndentGuide.background1": "#252c25",
        "editorIndentGuide.activeBackground1": "#3a453a",
        "editorWhitespace.foreground": "#2a312a",
        "editorGutter.background": "#121412",
        "editorWidget.background": "#1a1d1a",
        "editorWidget.border": "#2a312a",
        "editorSuggestWidget.background": "#1a1d1a",
        "editorSuggestWidget.border": "#2a312a",
        "editorSuggestWidget.selectedBackground": "#2a312a",
        "editorHoverWidget.background": "#1a1d1a",
        "editorHoverWidget.border": "#2a312a",
        "editorError.foreground": "#d2664e",
        "editorWarning.foreground": "#c08f45",
        "scrollbarSlider.background": "#2a312a99",
        "scrollbarSlider.hoverBackground": "#3a453acc",
        "scrollbarSlider.activeBackground": "#7a9659aa",
        "editorOverviewRuler.border": "#00000000",
      },
    },
    xterm: {
      // Abyss, matching --console-bg.
      background: "#121412",
      foreground: "#e5e7e1",
      cursor: "#121412", // input is disabled — no blinking cursor to mislead
      selectionBackground: "#2f4030",
      black: "#121412",
      // The console speaks the app's severity language: a compile error is the
      // same rust an AST violation is, a clean exit the same Clicker Sense a
      // passing metric is. Both stay paired with the words the terminal
      // already prints — the color is emphasis, never the message.
      red: "#d2664e",
      green: "#9fc473",
      yellow: "#c08f45",
      blue: "#7a9659",
      cyan: "#a8c483",
      white: "#e5e7e1",
      brightBlack: "#859385",
    },
  },
};

/** The themes the switcher offers, in display order. */
export const THEME_LIST = [THEMES.default, THEMES.quarantine];

/** Coerce anything — a stale localStorage value, a typo, null — to a real
 *  theme id. Unknown always means the default: an alternate palette is opt-in,
 *  so an unreadable preference must never be what turns it on. */
export function normalizeThemeId(id) {
  return Object.prototype.hasOwnProperty.call(THEMES, id) && id
    ? id
    : DEFAULT_THEME_ID;
}

/** The theme object for an id, never null. */
export function themeById(id) {
  return THEMES[normalizeThemeId(id)];
}

/**
 * Register every non-built-in theme with a Monaco instance.
 *
 * Called from `beforeMount` by each Monaco host (the exam editor and the DVR's
 * replay editor). Monaco keeps themes on the global instance, so re-running
 * this is a harmless overwrite — which is what makes it safe to call from more
 * than one component without either owning the other's setup.
 */
export function defineMonacoThemes(monaco) {
  if (!monaco?.editor?.defineTheme) return;
  for (const theme of THEME_LIST) {
    if (theme.monacoDefinition) {
      monaco.editor.defineTheme(theme.monacoTheme, theme.monacoDefinition);
    }
  }
}
