// ── Network restriction (Feature 2) ─────────────────────────────────────────
//
// An instructor can restrict a class to a set of addresses — a lab's subnet,
// typically — with a toggle that fully bypasses the check when off.
//
// HONEST FRAMING, carried into the UI and the docs: this stops casual
// off-network access. It is a DETERRENT, not a guarantee. The server can only
// see the address a request arrives from, so a VPN or a tunnel defeats it, and
// it is not a substitute for the behavioral forensics — it is one more reason a
// student has to make an effort rather than wander in from a dorm room. Do not
// describe it as making off-campus access impossible.
//
// Pure module: no Express, no Prisma, so the matching rules are driven by tests.

/** IPv4 dotted-quad → 32-bit unsigned, or null if it isn't one. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    // Reject empty, non-numeric, out-of-range and zero-padded ("010") forms —
    // the last because a padded octet is octal in some parsers and decimal in
    // others, and an allowlist entry that means different things in different
    // places is worse than one that is rejected outright.
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part[0] === '0') return null
    const n = Number(part)
    if (n > 255) return null
    out = out * 256 + n
  }
  return out >>> 0
}

/**
 * Normalize what the transport hands us into something comparable.
 *
 * Node reports an IPv4 client on a dual-stack socket as the IPv4-mapped IPv6
 * form `::ffff:127.0.0.1`, and localhost as `::1`. Without this, an instructor
 * who allowlists `127.0.0.1` would be locked out by their own rule — which is
 * exactly the sort of self-inflicted failure a demo cannot afford.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  let ip = raw.trim()
  if (ip.length === 0) return null
  // Strip a zone index (fe80::1%eth0) and an IPv4-mapped prefix.
  const zone = ip.indexOf('%')
  if (zone !== -1) ip = ip.slice(0, zone)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped) return mapped[1]
  if (ip === '::1') return '127.0.0.1'
  return ip
}

export type IpRuleKind = 'ipv4' | 'ipv4-cidr' | 'other'

/**
 * Validate an allowlist entry. Returns an error string for the instructor, or
 * null when the entry is usable.
 *
 * IPv4 and IPv4 CIDR are matched properly. Anything else (an IPv6 literal, a
 * hostname-looking string) is accepted only as an EXACT string match and is
 * reported as such, rather than being silently treated as a range it isn't.
 */
export function validateIpRule(raw: string): string | null {
  const rule = (raw ?? '').trim()
  if (!rule) return 'Enter an IP address or CIDR range.'
  if (rule.length > 64) return 'That entry is too long to be an address.'

  const slash = rule.indexOf('/')
  if (slash === -1) {
    if (ipv4ToInt(rule) !== null) return null
    // An IPv6 literal is allowed as an exact match; reject obvious nonsense.
    if (/^[0-9a-f:]+$/i.test(rule) && rule.includes(':')) return null
    return 'Use an IPv4 address (203.0.113.5), a CIDR range (10.0.0.0/24), or an IPv6 address.'
  }

  const base = rule.slice(0, slash)
  const bitsRaw = rule.slice(slash + 1)
  if (ipv4ToInt(base) === null) return 'The network part of a CIDR range must be an IPv4 address.'
  if (!/^\d{1,2}$/.test(bitsRaw)) return 'The prefix length must be a number from 0 to 32.'
  const bits = Number(bitsRaw)
  if (bits > 32) return 'The prefix length must be a number from 0 to 32.'
  return null
}

export function ipRuleKind(rule: string): IpRuleKind {
  const trimmed = rule.trim()
  if (trimmed.includes('/')) return 'ipv4-cidr'
  return ipv4ToInt(trimmed) !== null ? 'ipv4' : 'other'
}

function matchesRule(ip: string, rule: string): boolean {
  const trimmed = rule.trim()
  if (!trimmed) return false

  const slash = trimmed.indexOf('/')
  if (slash === -1) {
    // Exact match. Case-insensitive so an IPv6 literal typed in either case
    // still matches.
    return ip.toLowerCase() === trimmed.toLowerCase()
  }

  const baseInt = ipv4ToInt(trimmed.slice(0, slash))
  const ipInt = ipv4ToInt(ip)
  if (baseInt === null || ipInt === null) return false
  const bits = Number(trimmed.slice(slash + 1))
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  // /0 matches everything; the shift below is undefined for 32 in JS, so both
  // ends are handled explicitly rather than relying on operator edge cases.
  if (bits === 0) return true
  if (bits === 32) return ipInt === baseInt
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0
}

/**
 * Is this address allowed by this list?
 *
 * An EMPTY or unusable list denies everything when restriction is enabled —
 * deliberately. "Enabled with nothing allowed" is a misconfiguration, and
 * failing open would mean an instructor who switched the toggle on believes
 * they are protected while they are not. The UI refuses to save an enabled
 * restriction with an empty list, so the only way to reach this state is
 * through the API directly.
 */
export function isIpAllowed(rawIp: string | null | undefined, rules: unknown): boolean {
  const ip = normalizeIp(rawIp)
  if (!ip) return false
  if (!Array.isArray(rules)) return false
  return rules.some((rule) => typeof rule === 'string' && matchesRule(ip, rule))
}

/**
 * The whole policy decision for a class, in one place.
 *
 * Toggle OFF short-circuits BEFORE anything else is examined — that is what
 * makes "off fully bypasses the check" true by construction rather than by
 * every caller remembering to ask.
 */
export function isNetworkAllowed(
  klass: { ipRestrictionEnabled?: boolean | null; allowedIps?: unknown } | null | undefined,
  rawIp: string | null | undefined,
): boolean {
  if (!klass?.ipRestrictionEnabled) return true
  return isIpAllowed(rawIp, klass.allowedIps)
}
