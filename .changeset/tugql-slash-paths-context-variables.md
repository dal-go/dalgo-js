---
"@dalgo/core": patch
---

TugQL `FROM` and `JOIN` sources accept slash paths for nested collections (`from spaces/{space}/ext/datatug/projects`): the last segment is the name and the earlier ones, joined with `/`, the schema. Segments are words, quoted identifiers without `{`, `}` or `/`, or `{name}`; `/` must touch its segments, `.` and `/` cannot be mixed, and a `//` touching a path segment is now an `empty_path_segment` error instead of a comment (`from users//note` no longer parses; `from users // note` still does). Printing writes such a schema back in slash form. The parser passes the shared Go vectors in `test/testdata/tugql/slash-paths/cases.json`.

`resolveTugQL` accepts `contextVariables` (host-supplied string values that count as declared, bound parameters; declaring a parameter with the same name fails with `reserved_parameter`) and `schemaless` (skip `authorizedSchemas`, accept any source and field, leave a query without SELECT unprojected). `{name}` path segments are substituted from parameters and context variables, refusing a missing, empty, non-string, `/`-containing, `.`, `..` or `__.*__` value with `invalid_path_value` naming the variable.
