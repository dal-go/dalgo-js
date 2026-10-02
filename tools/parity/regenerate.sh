#!/usr/bin/env bash
# Regenerates test/parity/expected.json from the Go reference engine.
#
#   tools/parity/regenerate.sh              # use the commit pinned below
#   tools/parity/regenerate.sh <commit|tag> # try another dalgo revision (then edit the pin below)
#
# Run it by hand after adding or changing a case in test/parity/cases, or to
# move the reference to a newer dalgo. It needs Go (see go.mod for the minimum)
# and network access to the Go module proxy; the TypeScript test suite and CI
# never need either, they only read the checked-in expected.json.
#
# After regenerating, run `pnpm test`: any difference is a parity regression in
# one engine (or an intended Go change to port). Commit expected.json together
# with go.mod/go.sum and the new pin below.
set -euo pipefail

# The dalgo revision every expectation was generated from: the head of
# dal-go/dalgo#193 (isNull / isNotNull), v0.88.2 plus that change. Once that pull request
# is merged and released, re-pin this to the released tag's commit and regenerate.
DALGO_COMMIT="${1:-a41035df5f8b5da120b73d84bb1c0e4934f35631}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"
command -v go >/dev/null 2>&1 || { echo "regenerate: go not found on PATH" >&2; exit 1; }

go get "github.com/dal-go/dalgo@${DALGO_COMMIT}"
go mod tidy
go run . -root ../../test/parity -commit "${DALGO_COMMIT}"
