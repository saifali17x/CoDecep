/**
 * Print the NAMED node types tree-sitter-cpp actually produces for a program.
 *
 *   npx tsx scripts/ast-node-dump.ts                 # the built-in samples
 *   npx tsx scripts/ast-node-dump.ts path/to/file.cpp
 *
 * Exists because the standing rule for anything touching the allowlist or the
 * AST walker is "derive node names from real parses, never guess" (CLAUDE.md
 * §7.6). Both times this has been got wrong — the std:: false positives and the
 * "107 constructs" over-count — the mistake was reasoning about node names in
 * the abstract instead of parsing the program and reading them.
 *
 * Marks each node: [B] in BASELINE_ALLOWLIST, [S] classified SIGNIFICANT by the
 * walker, [-] structural scaffolding.
 */
import Parser from 'tree-sitter'
import { BASELINE_ALLOWLIST } from '../src/ast/allowlist'
import { isSignificantConstruct } from '../src/ast/parser'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CPP = require('tree-sitter-cpp') as Parser.Language
const parser = new Parser()
parser.setLanguage(CPP)

const SAMPLES: Record<string, string> = {
  'class with methods': `class Dog {
  private:
    int age;
  public:
    void bark() { std::cout << "woof"; }
};`,
  'class CONTAINING a for-loop': `class Dog {
  public:
    void run() {
      for (int i = 0; i < 3; i++) { std::cout << i; }
    }
};`,
  'nested classes': `class Outer {
  public:
    class Inner { int x; };
};`,
  'vector usage': `#include <vector>
int main() { std::vector<int> v; v.push_back(1); return 0; }`,
  'for-loop with i++': `int main() {
  for (int i = 0; i < 3; i++) { }
  return 0;
}`,
  'while + do-while': `int main() {
  int i = 0;
  while (i < 3) { i++; }
  do { i++; } while (i < 5);
  return 0;
}`,
  'pointers / new / delete': `int main() {
  int* p = new int(5);
  delete p;
  return 0;
}`,
  'try / throw': `int main() {
  try { throw 1; } catch (int e) { }
  return 0;
}`,
  'lambda': `int main() {
  auto f = [](int x) { return x; };
  return f(1);
}`,
  'template function': `template <typename T>
T add(T a, T b) { return a + b; }`,
  'struct + switch + array': `struct P { int x; };
int main() {
  int a[3];
  switch (a[0]) { case 1: break; default: break; }
  return 0;
}`,
  'baseline-only program': `#include <iostream>
int main() {
  int x = 0;
  std::cout << "Enter: ";
  std::cin >> x;
  std::cout << x << std::endl;
  return 0;
}`,
}

function dump(label: string, code: string) {
  console.log(`\n=== ${label} ===`)
  const tree = parser.parse(code)
  const seen = new Map<string, string>()
  const walk = (node: Parser.SyntaxNode, depth: number) => {
    if (node.type === 'ERROR' || node.isMissing) return
    if (node.isNamed) {
      const base = BASELINE_ALLOWLIST.includes(node.type)
      const sig = isSignificantConstruct(node.type)
      const mark = base ? 'B' : sig ? 'S' : '-'
      console.log(`${'  '.repeat(depth)}[${mark}] ${node.type} (line ${node.startPosition.row + 1})`)
      if (!base) seen.set(node.type, mark)
    }
    for (const child of node.children) walk(child, node.isNamed ? depth + 1 : depth)
  }
  walk(tree.rootNode, 0)
  const sig = [...seen].filter(([, m]) => m === 'S').map(([t]) => t)
  const str = [...seen].filter(([, m]) => m === '-').map(([t]) => t)
  console.log(`  → non-baseline SIGNIFICANT: ${sig.join(', ') || '(none)'}`)
  console.log(`  → non-baseline structural : ${str.join(', ') || '(none)'}`)
}

const file = process.argv[2]
if (file) {
  dump(file, require('fs').readFileSync(file, 'utf8'))
} else {
  for (const [label, code] of Object.entries(SAMPLES)) dump(label, code)
}
