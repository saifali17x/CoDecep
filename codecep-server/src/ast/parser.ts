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

// ── Report the CONSTRUCT, not every node inside it ─────────────────────────
//
// The walker used to record a violation for every named non-allowlisted node in
// the whole tree, descendants included. One disallowed construct therefore
// shattered into all of its structural sub-nodes: a single `class` reported
// class_specifier + field_declaration_list + access_specifier +
// field_declaration + parameter_declaration…, one `std::vector<T>` reported
// template_type + template_argument_list + type_descriptor, and one `for` loop
// reported for_statement + update_expression (that was gap #37). A small
// class-and-vector program measured 13 findings for 3 constructs; a real one
// measured 107. "107 disallowed constructs" is not something an instructor can
// act on — "class_specifier (line 7), template_type (line 9)" is.
//
// THE RULE: a disallowed node is the violation, and its subtree is PART of that
// construct rather than more violations. So the walker records the TOP-MOST
// disallowed node and does not descend into it. Siblings are unaffected — two
// independent disallowed constructs stay two findings — so this changes how
// violations are COUNTED, never whether a file is flagged: a program that
// flagged before still flags, because the top-most node is always recorded.
//
// The trade, stated rather than hidden: a disallowed construct nested inside
// another disallowed construct (a `for` loop inside a forbidden `class`) is no
// longer enumerated separately. It cannot hide a file from review — the class
// already flags it — but the finding list describes the outermost construct
// only. Enumerating both would mean re-introducing exactly the sub-node noise
// this removes.
export async function validateAST(
  sourceCode: string,
  allowlist: string[]
): Promise<ValidationResult> {
  const tree = parser.parse(sourceCode)
  const violations: Violation[] = []

  function walk(node: Parser.SyntaxNode) {
    // The route is called on a debounce WHILE the student is still typing, so the
    // parser regularly sees incomplete C++ (e.g. `cout <`). Tree-sitter represents
    // those transient states as ERROR / MISSING nodes. They are not "allowed"
    // constructs — they are "ignore while typing", so drop the whole subtree.
    if (node.type === 'ERROR' || node.isMissing) {
      return
    }

    // Skip anonymous tokens (punctuation, operators like '{', ';', '(')
    if (node.isNamed && !allowlist.includes(node.type)) {
      violations.push({
        nodeType: node.type,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        snippet: node.text.slice(0, 80),
      })
      // The construct is reported once, here. Its structural children belong to
      // it and are not separate findings.
      return
    }
    for (const child of node.children) {
      walk(child)
    }
  }

  walk(tree.rootNode)

  return {
    isValid: violations.length === 0,
    violations,
  }
}
