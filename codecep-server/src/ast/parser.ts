import Parser from 'tree-sitter'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CPP = require('tree-sitter-cpp') as Parser.Language

const parser = new Parser()
parser.setLanguage(CPP)

export interface Violation {
  nodeType: string
  line: number
  column: number
  snippet: string
}

export interface ValidationResult {
  isValid: boolean
  violations: Violation[]
}

// ── SIGNIFICANT constructs vs STRUCTURAL scaffolding ───────────────────────
//
// Two failures shaped this, in opposite directions, and the rule has to avoid
// both at once.
//
// The FIRST was an over-count. The walker used to record every named
// non-allowlisted node in the tree, descendants included, so one construct
// shattered into all of its sub-nodes: a single `class` reported
// class_specifier + field_declaration_list + access_specifier +
// field_declaration…, one `std::vector<T>` reported template_type +
// template_argument_list + type_descriptor, and one `for` reported
// for_statement + update_expression (gap #37). A real program measured
// **107 findings**, which is not something an instructor can act on.
//
// The fix for that was to record the top-most disallowed node and skip its
// whole subtree — which introduced the SECOND failure, a blind spot (gap #67):
// a genuinely different disallowed construct nested inside a disallowed one was
// never reported. If loops are not yet taught and a forbidden `class` contains
// a `for` loop in a method, only the class was named. The loop — a distinct
// technique, at its own line — vanished from the finding list.
//
// THE RULE NOW: walk the whole tree, and report a disallowed node UNLESS it is
// structural scaffolding of a construct already reported above it. So:
//
//   class with ordinary members            → 1 (the class; not its member list)
//   class CONTAINING a disallowed for-loop → 2 (class + for, each at its line)
//   for-loop with i++                      → 1 (the for; i++ is its scaffolding)
//   std::vector<int>                       → 1 (template_type; not <int>'s nodes)
//
// TWO PROPERTIES MAKE THIS SAFE, and both are tested:
//
// 1. The violation set is a strict SUPERSET of the previous behavior. The
//    top-most disallowed node is still always recorded (nothing is suppressed
//    unless it sits under something already flagged), so a program that flagged
//    before still flags, and the count can only go UP — never down. This
//    changed what gets ENUMERATED, never what gets DETECTED.
// 2. Significance is a DENY-LIST, not an allow-list. Anything not named in
//    STRUCTURAL_NODE_TYPES counts as significant, so a construct nobody
//    enumerated here — a language feature we did not think of, or one a future
//    tree-sitter-cpp adds — is REPORTED rather than silently ignored. An
//    allow-list of "significant" types would fail the other way: forget one and
//    the checker goes quiet about it forever, which is the one failure mode a
//    forensic tool must not have.
//
// Suppression is also CONTEXTUAL — a structural type is only skipped when it is
// actually under a flagged construct. `update_expression` is the reason: `i++`
// is scaffolding inside a `for`, but a bare `i++` statement in a program where
// the increment operator is not yet taught is a finding in its own right, and a
// blanket type rule would lose it.

/**
 * Node types that exist only as PART of a larger construct and carry no
 * pedagogical meaning on their own. Reporting one of these next to the
 * construct it belongs to is the "107 constructs" over-count.
 *
 * Derived from REAL `tree-sitter-cpp` parses, never guessed — run
 * `npx tsx scripts/ast-node-dump.ts` to see the tree any program produces.
 * That discipline is not ceremony: the parses corrected two names while this
 * list was being written (a range-based `for` is `for_range_loop`, and a
 * subscript's arguments are a `subscript_argument_list`), and every previous
 * AST bug here came from reasoning about node names in the abstract.
 *
 * Membership rule: "this node cannot be written on its own — it is part of the
 * construct that encloses it." A `field_declaration_list` is the body of a
 * class; an `else_clause` is part of an `if`; a `catch_clause` is part of a
 * `try`. None of them is a technique a syllabus introduces by itself.
 */
export const STRUCTURAL_NODE_TYPES: ReadonlySet<string> = new Set([
  // class / struct / union bodies
  'field_declaration_list',   // the { ... } of a class or struct
  'access_specifier',         // public: / private: / protected:
  'field_declaration',        // one member declaration inside that body
  'base_class_clause',        // the `: public A` of a derived class — part of
                              // the class declaration head. When classes are
                              // ALLOWED and inheritance is not yet taught this
                              // is still reported, because then it is not
                              // sitting under anything flagged.

  // templates — `<int>` in vector<int>, `<typename T>` in a template
  'template_argument_list',
  'type_descriptor',
  'template_parameter_list',
  'type_parameter_declaration',

  // statement scaffolding
  'condition_clause',         // the ( ... ) of if / while / switch
  'else_clause',              // part of an if_statement
  'case_statement',           // part of a switch_statement
  'catch_clause',             // part of a try_statement
  'update_expression',        // the i++ of a for header (gap #37)
  'parenthesized_expression', // the ( ... ) of a do-while, and grouping

  // callables
  'parameter_declaration',    // one parameter inside a parameter_list
  'lambda_capture_specifier', // the [ ] of a lambda
  'abstract_function_declarator',
  'placeholder_type_specifier', // the wrapper around `auto`

  // subscripting
  'subscript_argument_list',  // the [0] of a[0]
])

/**
 * Is this node type worth reporting in its own right, rather than being part of
 * a construct already reported above it?
 *
 * Deny-list semantics on purpose — see property 2 above. Unknown means
 * significant, so the checker's failure direction is "reports something you
 * must look at", never "silently stops looking".
 */
export function isSignificantConstruct(nodeType: string): boolean {
  return !STRUCTURAL_NODE_TYPES.has(nodeType)
}

export async function validateAST(
  sourceCode: string,
  allowlist: string[]
): Promise<ValidationResult> {
  const tree = parser.parse(sourceCode)
  const violations: Violation[] = []

  /**
   * @param insideFlagged true once we are somewhere beneath a construct that
   *   has already been recorded as a violation. It is the ONLY thing that can
   *   suppress a finding, and it can only suppress a STRUCTURAL one.
   */
  function walk(node: Parser.SyntaxNode, insideFlagged: boolean) {
    // The route is called on a debounce WHILE the student is still typing, so the
    // parser regularly sees incomplete C++ (e.g. `cout <`). Tree-sitter represents
    // those transient states as ERROR / MISSING nodes. They are not "allowed"
    // constructs — they are "ignore while typing", so drop the whole subtree.
    if (node.type === 'ERROR' || node.isMissing) {
      return
    }

    let nowInside = insideFlagged
    // Anonymous tokens (punctuation, operators like '{', ';', '(') are skipped —
    // a student cannot "use" a semicolon.
    if (node.isNamed && !allowlist.includes(node.type)) {
      if (insideFlagged && !isSignificantConstruct(node.type)) {
        // Scaffolding of a construct already reported above. Not a separate
        // finding — this is the over-count that made a class read as dozens of
        // violations. We keep DESCENDING, because a distinct construct may be
        // nested deeper (gap #67).
      } else {
        violations.push({
          nodeType: node.type,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          snippet: node.text.slice(0, 80),
        })
      }
      // Either way we are now inside a flagged construct: a suppressed node is
      // suppressed BECAUSE something above it was flagged, and that is still
      // true for everything below.
      nowInside = true
    }
    for (const child of node.children) {
      walk(child, nowInside)
    }
  }

  walk(tree.rootNode, false)

  return {
    isValid: violations.length === 0,
    violations,
  }
}
