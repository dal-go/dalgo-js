---
"@dalgo/core": patch
---

Preserve native own enumerable data fields such as `__proto__`, `constructor`, and `prototype` when assembling recursive and joined rows. Row assembly now defines own data properties instead of invoking inherited setters, so those fields are not dropped and result or global prototypes are not mutated.
