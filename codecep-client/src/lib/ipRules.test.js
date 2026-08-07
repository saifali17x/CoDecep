import { describe, it, expect } from "vitest";
import { validateIpRule, ipRuleLabel } from "./ipRules";

// Mirrors codecep-server/src/lib/ipAccess.ts — the server re-validates every
// entry on save, so these tests pin that the UI never ACCEPTS something the
// server would then reject (or reject something it would accept).

describe("validateIpRule", () => {
  it("accepts single IPv4 addresses", () => {
    for (const ok of ["203.0.113.5", "10.0.0.1", "0.0.0.0", "255.255.255.255"]) {
      expect(validateIpRule(ok)).toBeNull();
    }
  });

  it("accepts CIDR ranges including both edges", () => {
    for (const ok of ["10.0.0.0/24", "172.16.0.0/16", "0.0.0.0/0", "8.8.8.8/32"]) {
      expect(validateIpRule(ok)).toBeNull();
    }
  });

  it("accepts an IPv6 literal (exact match only)", () => {
    expect(validateIpRule("2001:db8::1")).toBeNull();
    expect(validateIpRule("::1")).toBeNull();
  });

  it("rejects an empty entry", () => {
    expect(validateIpRule("")).toMatch(/Enter an IP/);
    expect(validateIpRule("   ")).toMatch(/Enter an IP/);
  });

  it("rejects malformed addresses", () => {
    for (const bad of ["999.0.0.1", "10.0.0", "10.0.0.0.1", "hello", "1.2.3.4.5"]) {
      expect(validateIpRule(bad)).toBeTruthy();
    }
  });

  it("rejects a zero-padded octet — it is octal to some parsers, decimal to others", () => {
    expect(validateIpRule("010.0.0.1")).toBeTruthy();
  });

  it("rejects a bad prefix length", () => {
    expect(validateIpRule("10.0.0.0/33")).toMatch(/0 to 32/);
    expect(validateIpRule("10.0.0.0/")).toMatch(/0 to 32/);
    expect(validateIpRule("10.0.0.0/xx")).toMatch(/0 to 32/);
  });

  it("rejects a CIDR whose network part is not IPv4", () => {
    expect(validateIpRule("hello/24")).toMatch(/network part/);
  });

  it("trims surrounding whitespace before judging", () => {
    expect(validateIpRule("  10.0.0.0/8  ")).toBeNull();
  });

  it("labels ranges and single addresses for the chip", () => {
    expect(ipRuleLabel("10.0.0.0/24")).toBe("range");
    expect(ipRuleLabel("10.0.0.1")).toBe("single");
  });
});
