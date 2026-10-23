---
"@dalgo/core": minor
---

Rename DTQL to TugQL everywhere and add `--` and `//` comments with text to YAML conversion that keeps them.

This is a breaking release with no aliases. Every `DTQL` name is now `TugQL`: `executeJoinedDTQLQuery` is `executeJoinedTugQLQuery`, `executeRecursiveDTQLQuery` is `executeRecursiveTugQLQuery`, `executeSourceComposedJoinedDTQLQuery` is `executeSourceComposedJoinedTugQLQuery`, `parseRecursiveDTQL` is `parseRecursiveTugQL`, `serializeJoinedDTQL` and `stringifyJoinedDTQL` are `serializeJoinedTugQL` and `stringifyJoinedTugQL`, and the types `DTQLSchema`, `JoinedDTQLQuery`, `RecursiveDTQLQuery` and the rest follow the same rule. `parseDTQL`, which parses the structured YAML or JSON form, is now `parseTugQLYaml` because `parseTugQL` already names the text parser. The query kinds `joined-dtql` and `recursive-dtql` are now `joined-tugql` and `recursive-tugql`, the internal key collections `__dtql__` and `__dtql_derived__` are now `__tugql__` and `__tugql_derived__`, and the optional database capability keys `dtql`, `dtqlStreaming` and `dtqlStreamingErrors` are now `tugql`, `tugqlStreaming` and `tugqlStreamingErrors`. The error text `invalid DTQL` is now `invalid TugQL`.

In the text form `--` and `//` both start a comment that runs to the end of the line, outside string literals and quoted identifiers; `#` is not a comment. Comments live on the parsed tree (`tree.comments`), are kept by `formatTugQL` with the author's marker, and never reach resolution. New `tugqlToYaml`, `yamlToTugQL` and `printTugQL` convert between the text form and the structured YAML form; a text comment becomes a `#` comment where it annotated, a `#` comment comes back as `--`, and no comment is dropped. The YAML written matches the Go reference byte for byte for the shared comment vectors. The lexer now treats an unexpected character as a lone symbol, as the Go lexer does, so `#` is reported by the parser instead of a lexical `unexpected-character` diagnostic.

The vendored Go conformance corpus is re-copied from `tugql/testdata/tugql/v1` and now includes `comments.json`.
