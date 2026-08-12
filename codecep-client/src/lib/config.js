// ── Where the server is: the ONE place the client answers that question ─────
// Gap #61. Every HTTP call and the Socket.io connection resolve their base URL
// here, so a deploy changes one value rather than six call sites.
//
// UNSET is the local-dev contract: with no VITE_API_URL the base is exactly the
// `http://localhost:3001` that was hardcoded before, so `npm run dev` needs no
// env file and behaves identically to how it always has.
//
// Vite INLINES `import.meta.env.*` at BUILD time — it is not read from the
// environment when the page loads. A production build must therefore be run
// WITH VITE_API_URL set (Heroku: set it before `vite build`, not as a runtime
// config var), because the value is baked into the bundle.
//
// The trailing slash is stripped so a config var written `https://host/` cannot
// produce `https://host//api/...`, which some proxies treat as a different path.
const RAW_API_URL = import.meta.env.VITE_API_URL;

export const API_BASE = (RAW_API_URL || "http://localhost:3001").replace(/\/+$/, "");
