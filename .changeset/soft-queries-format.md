---
"@dalgo/core": patch
---

Keep invalid multiline quoted values unchanged during TugQL formatting and return the same lexer diagnostics as Go. Also handle compact parenthesized SELECT expressions in CTEs without creating a false SELECT block.
