// ── Allowlist entry validation (Feature 2) ──────────────────────────────────
//
// Mirrors `codecep-server/src/lib/ipAccess.ts` — **keep the two in step**, the
// same rule the workspace file model follows. The server is the authority (it
// re-validates every entry on save); this exists so an instructor is told about
// a typo while typing rather than after pressing Save.
//
// Pure module: no React, no DOM.

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    // Zero-padded octets are rejected: "010" is octal to some parsers and
    // decimal to others, and an allowlist entry that means different things in
    // different places is worse than one that is refused outright.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === "0") return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/** Error string for the instructor, or null when the entry is usable. */
export function validateIpRule(raw) {
  const rule = (raw ?? "").trim();
  if (!rule) return "Enter an IP address or CIDR range.";
  if (rule.length > 64) return "That entry is too long to be an address.";

  const slash = rule.indexOf("/");
  if (slash === -1) {
    if (ipv4ToInt(rule) !== null) return null;
    // An IPv6 literal is allowed, but only as an exact match.
    if (/^[0-9a-f:]+$/i.test(rule) && rule.includes(":")) return null;
    return "Use an IPv4 address (203.0.113.5), a CIDR range (10.0.0.0/24), or an IPv6 address.";
  }

  const base = rule.slice(0, slash);
  const bitsRaw = rule.slice(slash + 1);
  if (ipv4ToInt(base) === null) return "The network part of a CIDR range must be an IPv4 address.";
  if (!/^\d{1,2}$/.test(bitsRaw)) return "The prefix length must be a number from 0 to 32.";
  if (Number(bitsRaw) > 32) return "The prefix length must be a number from 0 to 32.";
  return null;
}

/** 'range' for a CIDR entry, 'single' for one address — used for the chip label. */
export function ipRuleLabel(rule) {
  return String(rule).includes("/") ? "range" : "single";
}
