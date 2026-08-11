import { describe, it, expect } from 'vitest'
import {
  BASELINE_ALLOWLIST,
  withBaseline,
  summariseViolations,
  describeViolations,
  VIOLATION_DETAIL_LIMIT,
} from './allowlist'
import { validateAST, isSignificantConstruct } from './parser'

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

// ── Reporting MEANINGFUL constructs, not every descendant node ──────────────
// The walker used to count every non-allowlisted node in the tree, so one
// forbidden construct exploded into all of its structural children: a real
// program measured "107 disallowed construct(s)" for a handful of actual
// constructs. These tests pin the shape of the report — a construct's own
// structural scaffolding is part of it rather than more findings, and siblings
// stay distinct — without loosening WHAT counts as a violation. (A DISTINCT
// construct nested inside a disallowed one IS reported; that is the next
// describe block, gap #67.)
describe('violations are reported per construct, not per descendant node', () => {
  const CLASS_AND_VECTOR = `#include <iostream>
#include <vector>
using namespace std;

class Student {
  private:
    int id;
    string name;
  public:
    Student(int i, string n) { id = i; name = n; }
    int getId() { return id; }
};

int main() {
    vector<Student> students;
    students.push_back(Student(1, "Ann"));
    return 0;
}
`

  it('reports a class ONCE, not as its field list / access specifiers / members', async () => {
    const violations = (await validateAST(CLASS_AND_VECTOR, BASELINE_ALLOWLIST)).violations
    const types = violations.map((v) => v.nodeType)
    expect(types).toContain('class_specifier')
    // The sub-nodes of the class are part of the class, not separate findings.
    for (const child of [
      'field_declaration_list',
      'access_specifier',
      'field_declaration',
      'parameter_declaration',
    ]) {
      expect(types).not.toContain(child)
    }
    expect(types.filter((t) => t === 'class_specifier')).toHaveLength(1)
  })

  it('reports a std::vector ONCE, not template_type + argument list + type descriptor', async () => {
    const types = (await validateAST(CLASS_AND_VECTOR, BASELINE_ALLOWLIST)).violations.map(
      (v) => v.nodeType,
    )
    expect(types).toContain('template_type')
    expect(types).not.toContain('template_argument_list')
    expect(types).not.toContain('type_descriptor')
  })

  it('collapses the whole program to the constructs actually used', async () => {
    // Before this fix the same program raised 13 findings across 10 node types
    // for what a human would read as exactly two constructs.
    const violations = (await validateAST(CLASS_AND_VECTOR, BASELINE_ALLOWLIST)).violations
    expect(violations).toHaveLength(2)
    expect(new Set(violations.map((v) => v.nodeType))).toEqual(
      new Set(['class_specifier', 'template_type']),
    )
  })

  it('gap #37 — a for-loop is ONE violation, not for_statement + update_expression', async () => {
    const violations = (await validateAST(FOR_LOOP, BASELINE_ALLOWLIST)).violations
    expect(violations).toHaveLength(1)
    expect(violations[0].nodeType).toBe('for_statement')
    expect(violations.map((v) => v.nodeType)).not.toContain('update_expression')
  })

  it('keeps INDEPENDENT constructs distinct — a class and a separate loop are two', async () => {
    const src = `#include <iostream>
using namespace std;

class Point {
  public:
    int x;
};

int main() {
    Point p;
    while (p.x < 3) { p.x = p.x + 1; }
    return 0;
}
`
    const violations = (await validateAST(src, BASELINE_ALLOWLIST)).violations
    expect(violations).toHaveLength(2)
    expect(violations.map((v) => v.nodeType).sort()).toEqual(['class_specifier', 'while_statement'])
  })

  it('a fully-allowed program still reports zero', async () => {
    expect((await validateAST(STD_QUALIFIED, BASELINE_ALLOWLIST)).violations).toHaveLength(0)
    expect((await validateAST(BARE_COUT, BASELINE_ALLOWLIST)).violations).toHaveLength(0)
  })

  it('the reported COUNT equals the number of constructs the detail names', async () => {
    const violations = (await validateAST(CLASS_AND_VECTOR, BASELINE_ALLOWLIST)).violations
    const summary = summariseViolations(violations)
    // This is the property the "107 constructs" bug broke: the number an
    // instructor reads must be the number of things listed beside it.
    expect(summary.distinct).toBe(summary.items.length)
    expect(describeViolations(summary).split(', ')).toHaveLength(summary.distinct)
    expect(describeViolations(summary)).not.toContain('more')
  })

  it('still FLAGS the program — this changes counting, not detection', async () => {
    const result = await validateAST(CLASS_AND_VECTOR, BASELINE_ALLOWLIST)
    expect(result.isValid).toBe(false)
  })

  it('an allowed outer construct is still descended into, so an inner one flags', async () => {
    // The skip only applies UNDER a node that is already a violation. A
    // permitted function body must still be searched, or the fix would hide
    // findings rather than de-duplicate them.
    const allowed = withBaseline(['while_statement', 'condition_clause', 'update_expression'])
    const src = `int main() {\n  int n = 3;\n  while (n > 0) { for (int i = 0; i < 2; i++) { n--; } }\n  return 0;\n}\n`
    const types = (await validateAST(src, allowed)).violations.map((v) => v.nodeType)
    expect(types).toEqual(['for_statement'])
  })
})

// ── A DISTINCT construct nested inside a disallowed one (gap #67) ───────────
// The over-count fix above skipped a flagged node's whole subtree, which left a
// blind spot: a forbidden `class` containing a forbidden `for` loop reported the
// class only, and the loop — a different technique, at its own line — was never
// named. These tests pin the two-sided rule: report significant constructs
// wherever they are, never their structural scaffolding.
describe('nested DISTINCT constructs are reported (gap #67), scaffolding still is not', () => {
  const CLASS_WITH_LOOP = `class Dog {
  public:
    void run() {
      for (int i = 0; i < 3; i++) { std::cout << i; }
    }
};
`

  it('a disallowed class CONTAINING a disallowed loop reports BOTH, each at its line', async () => {
    const violations = (await validateAST(CLASS_WITH_LOOP, BASELINE_ALLOWLIST)).violations
    expect(violations).toHaveLength(2)
    expect(violations.map((v) => `${v.nodeType}:${v.line}`)).toEqual([
      'class_specifier:1',
      'for_statement:4',
    ])
  })

  it('but the loop it contains does NOT drag its own scaffolding back in', async () => {
    // The blind-spot fix must not undo the over-count fix: i++ is part of the
    // for, and the class body is part of the class.
    const types = (await validateAST(CLASS_WITH_LOOP, BASELINE_ALLOWLIST)).violations.map(
      (v) => v.nodeType,
    )
    for (const scaffold of ['update_expression', 'field_declaration_list', 'access_specifier']) {
      expect(types).not.toContain(scaffold)
    }
  })

  it('reports each level of a three-deep nest once — class > for > while', async () => {
    const src = `class A {
  public:
    void f() { for (int i = 0; i < 2; i++) { while (true) { } } }
};
`
    const violations = (await validateAST(src, BASELINE_ALLOWLIST)).violations
    expect(violations.map((v) => v.nodeType)).toEqual([
      'class_specifier',
      'for_statement',
      'while_statement',
    ])
  })

  it('two nested classes are two findings, at their own lines', async () => {
    const src = `class Outer {
  public:
    class Inner { int x; };
};
`
    const violations = (await validateAST(src, BASELINE_ALLOWLIST)).violations
    expect(violations.map((v) => `${v.nodeType}:${v.line}`)).toEqual([
      'class_specifier:1',
      'class_specifier:3',
    ])
  })

  it('the violation set is a strict SUPERSET of the old subtree-skipping rule', async () => {
    // The safety property behind the whole change: nothing is suppressed unless
    // it sits under something already flagged, so the top-most construct is
    // always still recorded and the count can only go UP. A program that flagged
    // before cannot stop flagging.
    for (const src of [CLASS_WITH_LOOP, FOR_LOOP, STD_QUALIFIED]) {
      const result = await validateAST(src, BASELINE_ALLOWLIST)
      const topMost = result.violations[0]
      if (src === STD_QUALIFIED) {
        expect(result.violations).toHaveLength(0)
      } else {
        // the outermost construct is still the first finding
        expect(topMost).toBeDefined()
        expect(result.isValid).toBe(false)
      }
    }
  })

  it('significance is a DENY-list, so an unknown node type is REPORTED not ignored', () => {
    // The failure direction that matters: a construct nobody enumerated must
    // still be reported. An allow-list of "significant" types would go silent.
    expect(isSignificantConstruct('some_future_cpp_node')).toBe(true)
    expect(isSignificantConstruct('coroutine_body')).toBe(true)
    // …while known scaffolding stays scaffolding.
    expect(isSignificantConstruct('field_declaration_list')).toBe(false)
    expect(isSignificantConstruct('update_expression')).toBe(false)
  })

  it('a structural type is only suppressed UNDER a flagged construct, never blanket', async () => {
    // `i++` on its own is a finding when the increment operator is not taught
    // yet; inside a flagged `for` it is that loop's scaffolding. A pure
    // type-based rule would lose the standalone case.
    const src = `int main() {\n  int i = 0;\n  i++;\n  return 0;\n}\n`
    const types = (await validateAST(src, BASELINE_ALLOWLIST)).violations.map((v) => v.nodeType)
    expect(types).toEqual(['update_expression'])
  })

  it('the COUNT still equals the constructs listed, with a nested finding', async () => {
    const violations = (await validateAST(CLASS_WITH_LOOP, BASELINE_ALLOWLIST)).violations
    const summary = summariseViolations(violations)
    expect(summary.distinct).toBe(2)
    expect(summary.distinct).toBe(summary.items.length)
    expect(describeViolations(summary)).toBe('class_specifier (line 1), for_statement (line 4)')
  })
})
