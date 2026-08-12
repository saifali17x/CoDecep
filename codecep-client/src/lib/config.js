// ── Where the server is: the ONE place the client answers that question ─────
// Gap #61. Every HTTP call and the Socket.io connection resolve their base URL
// here, so a deploy changes one value rather than six call sites.
//
// THREE cases, and the default in each is the one that needs no configuration:
//
//   1. dev (`npm run dev`, VITE_API_URL unset) → "http://localhost:3001",
//      byte-for-byte the string these call sites used to hardcode. Local dev
//      therefore needs no env file and behaves exactly as it always has.
//
//   2. production build, VITE_API_URL unset → "" (EMPTY = same origin). This is
//      the single-app Heroku deploy: one dyno serves this bundle AND the API, so
//      `${""}/api/session/create` is the relative `/api/session/create` and
//      resolves to whatever host the page was loaded from. Nothing to configure,
//      nothing to get wrong at build time, and CORS never enters the picture —
//      a same-origin request sends no Origin header at all.
//
//   3. VITE_API_URL set → that value wins, for a two-host deploy (static client
//      on one origin, API on another). Then the server's CORS_ORIGIN must name
//      this client's origin.
//
// `import.meta.env.PROD` is Vite's own build-mode flag and is inlined at build
// time like everything else here, so case 1 and case 2 cannot be confused at
// runtime — they are different bundles.
//
// Vite INLINES `import.meta.env.*` at BUILD time; it is NOT read when the page
// loads. A case-3 value must be present when `vite build` RUNS — setting it as a
// Heroku runtime config var does nothing.
//
// The trailing slash is stripped so a value written `https://host/` cannot
// produce `https://host//api/...`, which some proxies treat as a different path.
const RAW_API_URL = import.meta.env.VITE_API_URL;

export const API_BASE = RAW_API_URL
  ? RAW_API_URL.replace(/\/+$/, "")
  : import.meta.env.PROD
    ? "" // same origin — the single-app deploy
    : "http://localhost:3001";
