// ── Brand image assets (UI polish part 2) ───────────────────────────────────
//
// The two logo files, imported once so every consumer references the same
// emitted asset. Vite resolves these from the project root — they live in
// codecep-client/logos/, outside src/ — and emits them as content-hashed files
// at build time. Importing rather than hardcoding a URL means a missing or
// renamed file is a BUILD error, not a broken image found during a demo.
//
// A plain module rather than part of BrandMark.jsx: a file that exports both
// components and non-components defeats react-refresh's fast reload (and the
// lint rule that guards it).
//
// The files are used AS SHIPPED — never edited. Both are full lockups on a
// dark ground with generous margin, and every place that needs a different
// framing crops with CSS background positioning (see BrandMark.css).
//
// Worth knowing: logo-2 is 2.2MB and logo-1 is 4.3MB, as authored. Each is
// fetched once and then served from cache under a hashed filename, but the
// first paint of the nav does pull 2.2MB. If that ever matters, the fix is a
// downscaled derivative committed beside the originals — not an edit to them.

// Primary mark: the app nav, the exam strip, the auth lockup, the touch icon.
export { default as logoMain } from "../../logos/logo-2.png";

// Secondary: the circuit-grid variant, used only as the dimmed auth backdrop,
// so its weight is never paid on a page a student sits an exam in.
export { default as logoAlt } from "../../logos/logo-1.png";
