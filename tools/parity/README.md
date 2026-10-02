# Go parity generator

`main.go` runs every case in `../../test/parity/cases/*.json` through the Go
DTQL engine (`dtql.Deserialize` then `dal.ExecuteFederatedQuery`, over the
in-memory tables of `../../test/parity/dataset.json`) and writes the results to
`../../test/parity/expected.json`, together with the dalgo version and commit.

`test/parity.test.ts` runs the same cases through this package's TypeScript
engine and compares exactly (numbers within 1e-9).

Regenerate by hand with `tools/parity/regenerate.sh` (needs Go and network
access to the module proxy). CI does not use Go. Not shipped in the npm package.
