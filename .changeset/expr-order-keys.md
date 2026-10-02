---
"@dalgo/core": minor
---

Accept expression `orderBy` keys in DTQL (for example a binary `/` over aggregates, with `desc`), matching the Go engine. Parsing, canonical serialisation and generic and streaming joined execution handle them; plain field keys are unchanged. `DTQLQueryOrder` is now the union `DTQLFieldOrder | DTQLExpressionOrder`, so code that read `order.field` must narrow on `order.expression`. Arithmetic division by zero now evaluates to null (as in Go) instead of `Infinity`.
