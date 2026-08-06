// ── AST violation reporting (gap-fix session, Fix 2) ────────────────────────
//
// PURE module (no React/DOM) so it can be unit-tested and shared by the DVR and
// the per-task report.
//
// An AST violation used to be reported as a COUNT — "6 violations". That tells
// an instructor nothing they can act on: they cannot tell whether the student
// wrote a `for` loop three weeks early or whether the allowlist itself is
// wrong. Naming the construct and the line makes the finding checkable in both
// directions, and it makes false positives self-diagnosing: the `std::` bug
// this session fixed would have been obvious the moment an alert read
// "namespace_identifier (line 4)" instead of "6 violations".
//
// Mirrors `codecep-server/src/ast/allowlist.ts` (`summariseViolations` /
// `describeViolations`) — keep the two in step, and note the SERVER is the
// source of truth for the wording a live alert carries. This exists for the
// stored record, where the client holds the raw violation list and formats it
// itself.

/** How many distinct constructs a summary names before "and N more". */
export const VIOLATION_DETAIL_LIMIT = 6;

/**
 * Collapse a raw violation list into distinct {nodeType, line} findings.
 * One disallowed loop can be reported on every validation pass; that is one
 * finding, not many.
 */
export function summariseViolationList(violations, limit = VIOLATION_DETAIL_LIMIT) {
  const list = Array.isArray(violations) ? violations : [];
  const seen = new Set();
  const items = [];
  for (const v of list) {
    if (!v || typeof v.nodeType !== "string") continue;
    const key = `${v.nodeType}:${v.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (items.length < limit) {
      items.push({ nodeType: v.nodeType, line: v.line ?? null, column: v.column ?? 0 });
    }
  }
  return {
    items,
    total: list.length,
    distinct: seen.size,
    truncated: seen.size > items.length,
  };
}

/**
 * The human sentence shown in the report, e.g.
 * `for_statement (line 12), while_statement (line 15) and 3 more`.
 *
 * Deliberately descriptive only — it says what construct appeared and where.
 * What that MEANS is the instructor's call (Constraint 7), so no wording here
 * ever implies intent.
 */
export function describeViolationList(violations, limit = VIOLATION_DETAIL_LIMIT) {
  const summary = summariseViolationList(violations, limit);
  if (summary.items.length === 0) return "no disallowed constructs";
  const named = summary.items
    .map((v) => (v.line == null ? v.nodeType : `${v.nodeType} (line ${v.line})`))
    .join(", ");
  const rest = summary.distinct - summary.items.length;
  return rest > 0 ? `${named} and ${rest} more` : named;
}

/**
 * The node type an AST_VIOLATION alert was about, recovered from the detail
 * string the client emitted. Used for scrubber tooltips.
 *
 * The alert payload carries a formatted sentence rather than structured fields
 * (changing that shape would be a capture-layer change, which this session
 * deliberately does not touch), so this reads the leading construct back out.
 * Returns null when the detail predates Fix 2 or does not match — callers then
 * show the raw detail, never a guess.
 */
export function nodeTypeFromDetail(detail) {
  if (typeof detail !== "string") return null;
  // Fix 2 format: "Used for_statement (line 12) in Task 1 / main.cpp"
  const used = /^Used\s+([a-z_][a-z0-9_]*)\s*\(line\s+(\d+)\)/i.exec(detail);
  if (used) return { nodeType: used[1], line: Number(used[2]) };
  // Pre-Fix-2 format: "6 violation(s) in main.cpp: for_statement"
  const legacy = /:\s*([a-z_][a-z0-9_]*)\s*$/i.exec(detail);
  if (legacy) return { nodeType: legacy[1], line: null };
  return null;
}
