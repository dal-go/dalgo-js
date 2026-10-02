# Go parity generator

`main.go` runs every case in `../../test/parity/cases/*.json` through the Go
DTQL engine (`dtql.Deserialize` then `dal.ExecuteFederatedQuery`, over the
in-memory tables of `../../test/parity/dataset.json`) and writes the results to
`../../test/parity/expected.json`, together with the dalgo version and commit.

`test/parity.test.ts` runs the same cases through this package's TypeScript
engine and compares exactly (numbers within 1e-9).

Regenerate by hand with `tools/parity/regenerate.sh` (needs Go, git and network
access; CI does not use Go). The dalgo revision is pinned in `go.mod` only. To move
the reference, pass the ref, which repins and regenerates in one step:

```sh
tools/parity/regenerate.sh v0.89.0      # a release tag, a commit SHA or a branch
pnpm test
```

The script exits 3 if anything but the `dalgo` block (version, commit) of `expected.json`
changed: that is a semantic change in the Go engine between the two revisions, to review
and port before committing `expected.json` with `go.mod` and `go.sum`.

A case must run through Go's own join or aggregation executor: a plain single-source
query (no join, aggregate or subquery) is handed to the database by the Go engine, and the
in-memory database in `main.go` does not filter, sort or project. Use a join (for example
`Sale` with `Dim`) or a `groupBy` for a case about `where`, `columns` or `orderBy`.
