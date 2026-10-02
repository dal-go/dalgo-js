# Go parity generator

`main.go` runs every case in `../../test/parity/cases/*.json` through the Go
DTQL engine (`dtql.Deserialize` then `dal.ExecuteFederatedQuery`, over the
in-memory tables of `../../test/parity/dataset.json`) and writes the results to
`../../test/parity/expected.json`, together with the dalgo version and commit.

`test/parity.test.ts` runs the same cases through this package's TypeScript
engine and compares exactly (numbers within 1e-9).

Regenerate by hand with `tools/parity/regenerate.sh` (needs Go and network
access to the module proxy). CI does not use Go. Not shipped in the npm package.

A case must run through Go's own join or aggregation executor: a plain single-source
query (no join, aggregate or subquery) is handed to the database by the Go engine, and the
in-memory database in `main.go` does not filter, sort or project. Use a join (for example
`Sale` with `Dim`) or a `groupBy` for a case about `where`, `columns` or `orderBy`.
