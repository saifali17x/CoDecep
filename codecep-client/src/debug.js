// Dev-only console tracing. The [EMIT]/[RECV]/[PASTE] alert traces are gated
// behind VITE_DEBUG so a normal exam runs with a clean console; set
// VITE_DEBUG=true in codecep-client/.env.local to re-enable them.
const DEBUG = import.meta.env.VITE_DEBUG === "true" || import.meta.env.VITE_DEBUG === "1";

export function debugLog(...args) {
  if (DEBUG) console.log(...args);
}
