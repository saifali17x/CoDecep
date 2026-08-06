// ── The AST baseline allowlist (gap-fix session, part 1) ────────────────────
//
// WHY THIS MODULE EXISTS. Before this, the baseline lived as a plain array in
// server.ts and was used ONLY as the fallback when a class had no syllabus. A
// class WITH a Gemini-generated allowlist got that list verbatim — and the
// Gemini prompt merely ASKS the model to include the mandatory boilerplate. An
// instructor can also hand-edit the list before saving. Neither is a guarantee,
// and the live database proved it: a real stored `week1` list was missing
// `namespace_identifier`, `system_lib_string`, `string_content` and
// `function_declarator`, so this completely valid program raised SEVEN
// violations against it —
//
//   #include <iostream>
//   int main() {
//     int x = 0;
//     std::cout << "Enter: ";
//     std::cin >> x;
//     std::cout << x << std::endl;
//     return 0;
//   }
//
// — four of them the `std` in `std::cout`. A student writing the fully-qualified
// style instead of `using namespace std;` was flagged for writing correct C++.
//
// THE FIX is not to add node types (they were already listed here); it is to
// make the baseline ENFORCED rather than merely suggested. `withBaseline()` is
// unioned into every resolved week list, so no syllabus parse and no instructor
// edit can make mandatory boilerplate a violation. The Gemini prompt still
// injects the same set — generated lists should look right on their own — but
// the union is what makes it true.
//
// WHAT IS DELIBERATELY ABSENT: for_statement, while_statement, do_statement and
// every other TAUGHT construct. Those are exactly what a week's allowlist is
// supposed to gate, and putting them here would disable the feature. The rule
// for membership is "a program cannot be written without it, or it carries no
// pedagogical meaning on its own" — structure, literals, comments — never a
// construct a syllabus introduces in a given week.

/**
 * Constructs that can NEVER be a violation, in any week, under any allowlist.
 * Verified against real `tree-sitter-cpp` parses rather than assumed — see the
 * unit tests, which parse the programs above and assert the produced node types
 * are a subset of this list.
 */
export const BASELINE_ALLOWLIST: string[] = [
  // ── Structural / translation unit ─────────────────────────────────────────
  'translation_unit',
  'preproc_include',      // #include
  'preproc_arg',
  'system_lib_string',    // <iostream>
  'comment',              // // and /* */ — a student annotating their work
                          // is not using a construct; this flagged before.

  // ── The std:: fully-qualified style ───────────────────────────────────────
  // Both C++ I/O styles must validate clean: `using namespace std;` + bare
  // `cout`, and the fully-qualified `std::cout`. The two node types below are
  // everything the qualified form adds — confirmed by parsing it and listing
  // every node, not by guessing. (The `::` itself is an anonymous token, so the
  // walker never sees it.)
  'using_declaration',    // using namespace std;
  'namespace_identifier', // the `std` in std::cout
  'qualified_identifier', // std::cout / std::cin / std::endl as a whole

  // ── Function structure ────────────────────────────────────────────────────
  'function_definition',
  'function_declarator',
  'primitive_type',       // int, void, char, bool, double, ...
  'type_identifier',      // string, and other non-primitive type names
  'compound_statement',   // { ... }
  'parameter_list',

  // ── Basic statements & expressions (cout / cin / return / assignment) ─────
  'declaration',
  'init_declarator',
  'expression_statement',
  'return_statement',
  'identifier',
  'binary_expression',    // << chaining and arithmetic
  'assignment_expression',
  'call_expression',
  'argument_list',
  'field_expression',
  'field_identifier',     // the member name in a field_expression

  // ── Literals ──────────────────────────────────────────────────────────────
  // A literal is a value, not a technique — there is no week in which writing
  // `true` is a construct the student has not been taught yet.
  'string_literal',       // "..."
  'string_content',       // text inside a string_literal
  'escape_sequence',      // "\n" inside a string_literal
  'number_literal',
  'char_literal',
  'character',            // the char inside a char_literal
  'true',
  'false',
  'null',                 // nullptr — usable only where pointer_declarator,
                          // which is NOT baseline, is already permitted.
]

/**
 * Union a week's allowlist with the baseline. This is what makes the baseline a
 * guarantee instead of a request: whatever Gemini generated or an instructor
 * saved, mandatory boilerplate stays allowed. Order is irrelevant (the walker
 * does an `includes` test) but duplicates are dropped so logs and any future
 * display of the list stay readable.
 */
export function withBaseline(list: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(list) || list.length === 0) return [...BASELINE_ALLOWLIST]
  return [...new Set([...BASELINE_ALLOWLIST, ...list])]
}

// ── Violation detail (gap-fix session, Fix 2) ───────────────────────────────
// An AST_VIOLATION used to report only a count ("6 violations"), which tells an
// instructor nothing about WHAT the student used, and told us nothing while
// debugging — the std:: bug above would have been obvious in seconds if the
// alert had read "flagged: namespace_identifier (line 4)".

/** How many distinct constructs a single detail string names before "+N more". */
export const VIOLATION_DETAIL_LIMIT = 6

export interface ViolationLike {
  nodeType: string
  line: number
  column?: number
}

/**
 * A `type` rather than an `interface` on purpose: this is stored in a Prisma
 * JSONB column, and Prisma's `InputJsonObject` requires an implicit index
 * signature that TypeScript grants to type aliases but not to interfaces.
 */
export type ViolationSummary = {
  /** Distinct {nodeType, line} pairs, capped at VIOLATION_DETAIL_LIMIT. */
  items: { nodeType: string; line: number; column: number }[]
  /** Every violation the walker raised, including repeats. */
  total: number
  /** Distinct {nodeType, line} pairs before the cap. */
  distinct: number
  /** True when `distinct` exceeded the cap, so `items` is a prefix. */
  truncated: boolean
}

/**
 * Collapse a raw violation list into something reportable. De-duplicated by
 * nodeType+line, because one disallowed `for` loop can produce the same finding
 * on every pass, and capped so a file full of them cannot produce an unbounded
 * alert string.
 */
export function summariseViolations(
  violations: readonly ViolationLike[] | null | undefined,
  limit: number = VIOLATION_DETAIL_LIMIT,
): ViolationSummary {
  const list = Array.isArray(violations) ? violations : []
  const seen = new Set<string>()
  const items: { nodeType: string; line: number; column: number }[] = []
  for (const v of list) {
    if (!v || typeof v.nodeType !== 'string') continue
    const key = `${v.nodeType}:${v.line}`
    if (seen.has(key)) continue
    seen.add(key)
    if (items.length < limit) {
      items.push({ nodeType: v.nodeType, line: v.line, column: v.column ?? 0 })
    }
  }
  return {
    items,
    total: list.length,
    distinct: seen.size,
    truncated: seen.size > items.length,
  }
}

/**
 * The human sentence both the live alert and the instructor report show, e.g.
 * `for_statement (line 12), while_statement (line 15) and 3 more`.
 *
 * Probabilistic framing (Constraint 7) lives at the call site: this names the
 * construct and where it was used, and never says what it means. "Used a
 * construct not permitted for this week" is a fact; "cheated" is not.
 */
export function describeViolations(summary: ViolationSummary): string {
  if (summary.items.length === 0) return 'no disallowed constructs'
  const named = summary.items.map((v) => `${v.nodeType} (line ${v.line})`).join(', ')
  const rest = summary.distinct - summary.items.length
  return rest > 0 ? `${named} and ${rest} more` : named
}
