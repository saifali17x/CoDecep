import { describe, it, expect } from 'vitest'
import {
  BASELINE_ALLOWLIST,
  withBaseline,
  summariseViolations,
  describeViolations,
  VIOLATION_DETAIL_LIMIT,
} from './allowlist'
import { validateAST } from './parser'

// The two C++ I/O styles a first-year student writes. Both are correct C++ and
// neither may ever raise a violation — the fully-qualified one did, against a
// real class allowlist, which is the bug these tests pin down.
const STD_QUALIFIED = `#include <iostream>
int main() {
int x = 0;
std::cout << "Enter: ";
std::cin >> x;
std::cout << x << std::endl;
return 0;
}
`

const BARE_COUT = `#include <iostream>
using namespace std;
int main() {
    int x = 0;
    cout << "Enter: ";
    cin >> x;
    cout << x << endl;
    return 0;
}
`

const FOR_LOOP = `#include <iostream>
using namespace std;
int main() {
    int total = 0;
    for (int i = 0; i < 10; i++) {
        total += i;
    }
    cout << total << endl;
    return 0;
}
`

// The allowlist that was actually stored for a real class in the live database,
// reproduced verbatim. It is missing namespace_identifier, system_lib_string,
// string_content and function_declarator — the Gemini prompt asked for all four
// and the saved list did not contain them, which is exactly why the baseline
// has to be enforced at validation time rather than merely requested.
const REAL_INCOMPLETE_CLASS_ALLOWLIST = [
  'translation_unit', 'preproc_include', 'function_definition', 'compound_statement',
  'declaration', 'expression_statement', 'call_expression', 'identifier',
  'string_literal', 'number_literal', 'return_statement', 'binary_expression',
  'using_declaration', 'qualified_identifier', 'primitive_type', 'parameter_list',
  'init_declarator', 'assignment_expression', 'argument_list', 'type_identifier',
  'field_expression', 'comment', 'ERROR',
]

describe('BASELINE_ALLOWLIST', () => {
  it('validates the std:: fully-qualified style with ZERO violations', async () => {
    const result = await validateAST(STD_QUALIFIED, BASELINE_ALLOWLIST)
    expect(result.violations).toEqual([])
    expect(result.isValid).toBe(true)
  })

  it('validates the bare-cout + `using namespace std;` style with ZERO violations', async () => {
    const result = await validateAST(BARE_COUT, BASELINE_ALLOWLIST)
    expect(result.violations).toEqual([])
    expect(result.isValid).toBe(true)
  })

  it('still allows comments and boolean literals — annotating is not a construct', async () => {
    const result = await validateAST(
      `int main() {\n  // a note\n  /* another */\n  bool ok = true;\n  bool no = false;\n  return 0;\n}\n`,
      BASELINE_ALLOWLIST,
    )
    expect(result.violations).toEqual([])
  })

  it('does NOT contain the taught control-flow constructs', () => {
    // The whole point of a per-week allowlist. If these ever land in the
    // baseline the feature silently stops working.
    for (const taught of ['for_statement', 'while_statement', 'do_statement', 'if_statement']) {
      expect(BASELINE_ALLOWLIST).not.toContain(taught)
    }
  })

  it('STILL FLAGS a for-loop, naming the node type and the correct line', async () => {
    const result = await validateAST(FOR_LOOP, BASELINE_ALLOWLIST)
    expect(result.isValid).toBe(false)
    const forViolation = result.violations.find((v) => v.nodeType === 'for_statement')
    expect(forViolation).toBeDefined()
    // The for-loop is on line 5 of FOR_LOOP (1-indexed).
    expect(forViolation!.line).toBe(5)
  })

  it('flags while_statement and do_statement too', async () => {
    const src = `int main() {\n  int n = 3;\n  while (n > 0) { n--; }\n  do { n++; } while (n < 2);\n  return 0;\n}\n`
    const types = (await validateAST(src, BASELINE_ALLOWLIST)).violations.map((v) => v.nodeType)
    expect(types).toContain('while_statement')
    expect(types).toContain('do_statement')
  })
})

describe('withBaseline', () => {
  it('rescues the std:: program from a real class allowlist that omitted the baseline', async () => {
    // Before: the stored list alone raises violations on valid C++.
    const before = await validateAST(STD_QUALIFIED, REAL_INCOMPLETE_CLASS_ALLOWLIST)
    expect(before.isValid).toBe(false)
    expect(before.violations.map((v) => v.nodeType)).toContain('namespace_identifier')

    // After: the same list, unioned with the baseline, is clean.
    const after = await validateAST(STD_QUALIFIED, withBaseline(REAL_INCOMPLETE_CLASS_ALLOWLIST))
    expect(after.violations).toEqual([])
    expect(after.isValid).toBe(true)
  })

  it('keeps every taught construct a week list adds', () => {
    const merged = withBaseline(['for_statement', 'if_statement'])
    expect(merged).toContain('for_statement')
    expect(merged).toContain('if_statement')
    expect(merged).toContain('namespace_identifier') // and the baseline
  })

  it('does not let a week list re-gate a baseline construct', async () => {
    // A week list that deliberately excludes std:: cannot make it a violation:
    // the baseline is a floor, not a default.
    const merged = withBaseline(['for_statement'])
    expect((await validateAST(STD_QUALIFIED, merged)).violations).toEqual([])
  })

  it('returns the baseline alone for null/empty input, with no duplicates', () => {
    expect(withBaseline(null)).toEqual(BASELINE_ALLOWLIST)
    expect(withBaseline([])).toEqual(BASELINE_ALLOWLIST)
    const merged = withBaseline(['identifier', 'identifier', 'for_statement'])
    expect(new Set(merged).size).toBe(merged.length)
  })
})

describe('summariseViolations / describeViolations', () => {
  const raw = [
    { nodeType: 'for_statement', line: 12, column: 4 },
    { nodeType: 'for_statement', line: 12, column: 4 }, // repeat of the same finding
    { nodeType: 'while_statement', line: 15, column: 2 },
  ]

  it('de-duplicates by nodeType+line while keeping the raw total', () => {
    const s = summariseViolations(raw)
    expect(s.items).toEqual([
      { nodeType: 'for_statement', line: 12, column: 4 },
      { nodeType: 'while_statement', line: 15, column: 2 },
    ])
    expect(s.total).toBe(3) // every occurrence
    expect(s.distinct).toBe(2)
    expect(s.truncated).toBe(false)
  })

  it('treats the same construct on a different line as a separate finding', () => {
    const s = summariseViolations([
      { nodeType: 'for_statement', line: 3 },
      { nodeType: 'for_statement', line: 9 },
    ])
    expect(s.distinct).toBe(2)
  })

  it('caps the list and reports truncation', () => {
    const many = Array.from({ length: VIOLATION_DETAIL_LIMIT + 4 }, (_, i) => ({
      nodeType: 'for_statement',
      line: i + 1,
    }))
    const s = summariseViolations(many)
    expect(s.items).toHaveLength(VIOLATION_DETAIL_LIMIT)
    expect(s.distinct).toBe(VIOLATION_DETAIL_LIMIT + 4)
    expect(s.truncated).toBe(true)
    expect(describeViolations(s)).toContain('and 4 more')
  })

  it('describes findings as construct + line', () => {
    expect(describeViolations(summariseViolations(raw))).toBe(
      'for_statement (line 12), while_statement (line 15)',
    )
  })

  it('handles an empty / missing list without inventing a finding', () => {
    expect(summariseViolations([])).toEqual({ items: [], total: 0, distinct: 0, truncated: false })
    expect(summariseViolations(null)).toEqual({ items: [], total: 0, distinct: 0, truncated: false })
    expect(describeViolations(summariseViolations([]))).toBe('no disallowed constructs')
  })

  it('builds the detail list from a REAL bad parse, not a hand-written fixture', async () => {
    const result = await validateAST(FOR_LOOP, BASELINE_ALLOWLIST)
    const s = summariseViolations(result.violations)
    expect(s.items.some((v) => v.nodeType === 'for_statement' && v.line === 5)).toBe(true)
    expect(describeViolations(s)).toContain('for_statement (line 5)')
  })
})
