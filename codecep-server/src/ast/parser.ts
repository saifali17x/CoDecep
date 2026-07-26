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
