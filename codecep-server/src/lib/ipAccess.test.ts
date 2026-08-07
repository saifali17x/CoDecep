import { describe, it, expect } from 'vitest'
import { isIpAllowed, isNetworkAllowed, normalizeIp, validateIpRule, ipRuleKind } from './ipAccess'

describe('normalizeIp', () => {
  it('unwraps the IPv4-mapped IPv6 form Node reports on dual-stack sockets', () => {
    // Without this an instructor who allowlists 127.0.0.1 is locked out by
    // their own rule — the exact self-inflicted failure a demo cannot afford.
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5')
    expect(normalizeIp('::FFFF:10.0.0.1')).toBe('10.0.0.1')
  })
  it('maps IPv6 localhost onto IPv4 localhost', () => {
    expect(normalizeIp('::1')).toBe('127.0.0.1')
  })
  it('strips a zone index', () => {
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1')
  })
  it('returns null for nothing usable', () => {
    expect(normalizeIp(undefined)).toBeNull()
    expect(normalizeIp('')).toBeNull()
    expect(normalizeIp('   ')).toBeNull()
  })
})

describe('isIpAllowed — exact addresses', () => {
  it('allows an exact match', () => {
    expect(isIpAllowed('203.0.113.5', ['203.0.113.5'])).toBe(true)
  })
  it('denies an address not on the list', () => {
    expect(isIpAllowed('203.0.113.9', ['203.0.113.5'])).toBe(false)
  })
  it('allows a localhost client against a 127.0.0.1 rule however it arrives', () => {
    expect(isIpAllowed('::1', ['127.0.0.1'])).toBe(true)
    expect(isIpAllowed('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(true)
  })
  it('matches an IPv6 literal exactly, case-insensitively', () => {
    expect(isIpAllowed('2001:DB8::1', ['2001:db8::1'])).toBe(true)
  })
})

describe('isIpAllowed — CIDR ranges', () => {
  it('matches an address inside a /24', () => {
    expect(isIpAllowed('10.0.0.7', ['10.0.0.0/24'])).toBe(true)
    expect(isIpAllowed('10.0.0.255', ['10.0.0.0/24'])).toBe(true)
  })
  it('rejects an address outside the /24', () => {
    expect(isIpAllowed('10.0.1.7', ['10.0.0.0/24'])).toBe(false)
  })
  it('handles a /16 lab network', () => {
    expect(isIpAllowed('172.16.44.9', ['172.16.0.0/16'])).toBe(true)
    expect(isIpAllowed('172.17.0.1', ['172.16.0.0/16'])).toBe(false)
  })
  it('handles the /32 and /0 edges (JS shift edge cases)', () => {
    expect(isIpAllowed('8.8.8.8', ['8.8.8.8/32'])).toBe(true)
    expect(isIpAllowed('8.8.4.4', ['8.8.8.8/32'])).toBe(false)
    expect(isIpAllowed('1.2.3.4', ['0.0.0.0/0'])).toBe(true)
  })
  it('checks every rule, not only the first', () => {
    expect(isIpAllowed('192.168.5.5', ['10.0.0.0/8', '192.168.0.0/16'])).toBe(true)
  })
  it('never matches an IPv6 client against an IPv4 range', () => {
    expect(isIpAllowed('2001:db8::1', ['10.0.0.0/8'])).toBe(false)
  })
})

describe('isIpAllowed — failure modes', () => {
  it('denies when the list is empty or not a list', () => {
    // "Enabled with nothing allowed" is a misconfiguration; failing OPEN would
    // let an instructor believe they are protected when they are not.
    expect(isIpAllowed('10.0.0.1', [])).toBe(false)
    expect(isIpAllowed('10.0.0.1', null)).toBe(false)
    expect(isIpAllowed('10.0.0.1', 'nope')).toBe(false)
  })
  it('denies when the client address is unknown', () => {
    expect(isIpAllowed(undefined, ['0.0.0.0/0'])).toBe(false)
  })
  it('ignores unusable entries instead of throwing', () => {
    expect(isIpAllowed('10.0.0.1', ['not-an-ip', 42 as unknown as string, '10.0.0.0/8'])).toBe(true)
  })
})

describe('isNetworkAllowed — the class policy', () => {
  it('allows everything when the toggle is OFF, whatever the list says', () => {
    const klass = { ipRestrictionEnabled: false, allowedIps: ['203.0.113.5'] }
    expect(isNetworkAllowed(klass, '198.51.100.7')).toBe(true)
  })
  it('allows everything for a class with no policy at all', () => {
    expect(isNetworkAllowed({}, '198.51.100.7')).toBe(true)
    expect(isNetworkAllowed(null, '198.51.100.7')).toBe(true)
  })
  it('enforces the list when the toggle is ON', () => {
    const klass = { ipRestrictionEnabled: true, allowedIps: ['203.0.113.0/24'] }
    expect(isNetworkAllowed(klass, '203.0.113.44')).toBe(true)
    expect(isNetworkAllowed(klass, '198.51.100.7')).toBe(false)
  })
})

describe('validateIpRule', () => {
  it('accepts addresses and ranges', () => {
    for (const ok of ['203.0.113.5', '10.0.0.0/24', '0.0.0.0/0', '8.8.8.8/32', '2001:db8::1']) {
      expect(validateIpRule(ok)).toBeNull()
    }
  })
  it('rejects an empty entry', () => {
    expect(validateIpRule('')).toMatch(/Enter an IP/)
  })
  it('rejects out-of-range octets and malformed addresses', () => {
    expect(validateIpRule('999.0.0.1')).toBeTruthy()
    expect(validateIpRule('10.0.0')).toBeTruthy()
    expect(validateIpRule('hello')).toBeTruthy()
  })
  it('rejects a zero-padded octet, which is ambiguous across parsers', () => {
    expect(validateIpRule('010.0.0.1')).toBeTruthy()
  })
  it('rejects a bad prefix length', () => {
    expect(validateIpRule('10.0.0.0/33')).toMatch(/0 to 32/)
    expect(validateIpRule('10.0.0.0/abc')).toMatch(/0 to 32/)
  })
  it('classifies rules for the UI', () => {
    expect(ipRuleKind('10.0.0.0/24')).toBe('ipv4-cidr')
    expect(ipRuleKind('10.0.0.1')).toBe('ipv4')
    expect(ipRuleKind('2001:db8::1')).toBe('other')
  })
})
