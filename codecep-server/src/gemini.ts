import { GoogleGenerativeAI } from '@google/generative-ai'
// Injected into the prompt from the SAME constant the validator enforces, so
// the two can never drift. Note this is belt-and-braces: a generated list that
// omits the baseline anyway is still safe, because resolveAllowlistFor() unions
// the baseline in at validation time. Asking for it here just means the list an
// instructor reviews looks correct on its own.
import { BASELINE_ALLOWLIST } from './ast/allowlist'

// Imports are hoisted, so this module evaluates before server.ts's own
// loadEnv() call runs — load the env files here so GEMINI_API_KEY is available.
import { loadEnv } from './env'
loadEnv()

// GEMINI_API_KEY must be set (.env.local locally, a Heroku config var in
// production). Never print or log the key itself.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set (.env.local locally, config var in production)')

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
// gemini-flash-latest: alias tracking the current flash model — fast, cheap,
// sufficient for structured extraction. Pinned names failed on this key as of
// 2026-07: gemini-1.5-flash is retired (404) and gemini-2.0-flash* return 429
// (no quota); the alias resolves to a model with working free-tier quota.
const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' })

export interface AllowlistResult {
  weeks: Record<string, string[]> // { "week1": ["node_type", ...], ... }
  warning?: string // set if parsing was degraded/fell back
}

export async function parseSyllabusToAllowlist(pdfText: string): Promise<AllowlistResult> {
  const prompt = `You are a compiler engineer configuring a Tree-sitter C++ AST allowlist for a
university programming course. Below is the course syllabus text.

Produce a JSON object mapping each week to the list of Tree-sitter C++ node types that students
are ALLOWED to use in that week's assignments. Each week must be CUMULATIVE (week 3 includes
everything from weeks 1-2 plus that week's new constructs).

ALWAYS include this baseline in EVERY week (mandatory C++ boilerplate — without these, valid
programs get falsely flagged). Note it covers BOTH C++ I/O styles: \`using namespace std;\` with
bare \`cout\`, and the fully-qualified \`std::cout\` form:
${BASELINE_ALLOWLIST.join(', ')}

Then ADD week-specific constructs based on what the syllabus teaches each week. Examples of
Tree-sitter C++ node types for common topics:

- conditionals: if_statement, else_clause, condition_clause
- loops: for_statement, while_statement, do_statement
- arrays: array_declarator, subscript_expression, initializer_list
- functions/params: (already in baseline)
- pointers/references: pointer_declarator, reference_declarator, pointer_expression
- structs/classes: struct_specifier, class_specifier, field_declaration, field_declaration_list
- recursion: (no special node — allowed once functions are)

Output ONLY valid JSON, no markdown, no explanation, matching:
{ "week1": ["..."], "week2": ["..."], ... }

If the syllabus doesn't clearly delineate weeks, produce a reasonable week1-week8 progression
from basics to advanced. Syllabus text:
${pdfText}`

  try {
    const result = await model.generateContent(prompt)
    let text = result.response.text().trim()
    // strip markdown fences if present
    text = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
      throw new Error('Gemini returned unexpected JSON shape')
    }
    // Validate every value is a string array
    for (const [wk, list] of Object.entries(parsed)) {
      if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) {
        throw new Error(`Week ${wk} is not a string array`)
      }
    }
    return { weeks: parsed as Record<string, string[]> }
  } catch (err) {
    console.error('[GEMINI] parse failed:', err instanceof Error ? err.message : err)
    throw new Error('Gemini could not parse the syllabus into a valid allowlist')
  }
}
