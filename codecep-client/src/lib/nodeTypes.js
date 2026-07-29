// Curated Tree-sitter C++ node types for the searchable "add construct" menu
// (Session 20). Grouped so an instructor who doesn't speak Tree-sitter can
// still find the right entry by topic. This is a convenience list, not a
// whitelist of everything Tree-sitter emits — the instructor can still type a
// node type by hand if their syllabus needs one that isn't here.
export const NODE_TYPE_GROUPS = [
  {
    group: "Baseline (every valid program needs these)",
    nodes: [
      "translation_unit", "preproc_include", "preproc_arg", "system_lib_string",
      "string_literal", "string_content", "escape_sequence", "using_declaration",
      "namespace_identifier", "qualified_identifier", "function_definition",
      "function_declarator", "primitive_type", "type_identifier",
      "compound_statement", "parameter_list", "declaration", "init_declarator",
      "expression_statement", "return_statement", "identifier", "number_literal",
      "char_literal", "character", "binary_expression", "assignment_expression",
      "call_expression", "argument_list", "field_expression", "field_identifier",
    ],
  },
  {
    group: "Conditionals",
    nodes: ["if_statement", "else_clause", "condition_clause", "conditional_expression",
      "switch_statement", "case_statement", "break_statement"],
  },
  {
    group: "Loops",
    nodes: ["for_statement", "while_statement", "do_statement", "continue_statement",
      "for_range_loop", "update_expression"],
  },
  {
    group: "Arrays & strings",
    nodes: ["array_declarator", "subscript_expression", "initializer_list",
      "sized_type_specifier", "concatenated_string"],
  },
  {
    group: "Pointers & references",
    nodes: ["pointer_declarator", "reference_declarator", "pointer_expression",
      "abstract_pointer_declarator", "new_expression", "delete_expression"],
  },
  {
    group: "Structs, classes & objects",
    nodes: ["struct_specifier", "class_specifier", "field_declaration",
      "field_declaration_list", "access_specifier", "base_class_clause",
      "field_initializer_list", "this", "template_type", "template_argument_list"],
  },
  {
    group: "Functions & operators",
    nodes: ["parameter_declaration", "optional_parameter_declaration",
      "default_method_clause", "operator_name", "unary_expression",
      "parenthesized_expression", "comma_expression", "cast_expression", "sizeof_expression"],
  },
  {
    group: "Misc / formatting",
    nodes: ["comment", "preproc_def", "preproc_ifdef", "null", "true", "false",
      "enum_specifier", "enumerator", "type_definition", "static_assert_declaration"],
  },
];

export const ALL_NODE_TYPES = Array.from(
  new Set(NODE_TYPE_GROUPS.flatMap((g) => g.nodes)),
).sort();
