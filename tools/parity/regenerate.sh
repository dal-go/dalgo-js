#!/usr/bin/env bash
# Regenerates test/parity/expected.json from the Go reference engine.
#
#   tools/parity/regenerate.sh                # regenerate against the dalgo version pinned in tools/parity/go.mod
#   tools/parity/regenerate.sh <dalgo-ref>    # repin to <dalgo-ref>, then regenerate
#
# <dalgo-ref> is anything `go get github.com/dal-go/dalgo@<ref>` accepts: a
# release tag (v0.89.0), a commit SHA, a branch or a pseudo-version. The pin
# lives in tools/parity/go.mod and go.sum only; this script keeps no copy of it.
#
# To move the reference to a released dalgo, for example after a dalgo change
# that dalgo-js depends on has been released:
#
#   tools/parity/regenerate.sh v0.89.0 && git diff --stat && pnpm test
#
# The script itself fails (exit 3, expected.json left as regenerated) when
# anything but the `dalgo` block (version, commit) of expected.json changed: any
# other difference is a semantic change in the Go engine between the two
# revisions, to be reviewed (and ported) before committing.
#
# Run it by hand after adding or changing a case in test/parity/cases, or to
# move the reference. It needs Go (see go.mod for the minimum), git, and network
# access to the Go module proxy and to github.com; the TypeScript test suite and
# CI never need any of them, they only read the checked-in expected.json.
# Commit expected.json together with go.mod and go.sum.
set -euo pipefail

repository="https://github.com/dal-go/dalgo.git"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"
command -v go >/dev/null 2>&1 || { echo "regenerate: go not found on PATH" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "regenerate: git not found on PATH" >&2; exit 1; }

if [ "$#" -gt 1 ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  echo "usage: tools/parity/regenerate.sh [<dalgo tag | commit | branch>]" >&2
  exit 2
fi

expected="../../test/parity/expected.json"
before=""
if [ "$#" -eq 1 ]; then
  before="$(mktemp)"
  trap 'rm -f "$before"' EXIT
  cp "$expected" "$before"
  go get "github.com/dal-go/dalgo@$1"
  go mod tidy
fi

version="$(go list -m -f '{{.Version}}' github.com/dal-go/dalgo)"

# The full commit behind the pinned version, recorded in expected.json: a
# pseudo-version ends in the 12-hex commit prefix, a tag is peeled to its commit.
commit=""
if [[ "$version" =~ -([0-9a-f]{12})$ ]]; then
  prefix="${BASH_REMATCH[1]}"
  commit="$(git ls-remote "$repository" | awk -v prefix="$prefix" 'index($1, prefix) == 1 && found == "" { found = $1; print $1 }')"
  commit="${commit:-$prefix}"
else
  commit="$(git ls-remote "$repository" "refs/tags/${version}^{}" "refs/tags/${version}" | awk '{ if ($2 ~ /\^\{\}$/) peeled = $1; else if (direct == "") direct = $1 } END { print (peeled != "" ? peeled : direct) }')"
fi
[ -n "$commit" ] || { echo "regenerate: cannot resolve a commit for dalgo ${version}" >&2; exit 1; }

echo "regenerate: dalgo ${version} (${commit})" >&2
go run . -root ../../test/parity -commit "${commit}"

# A repin must not change what Go answers: only the recorded version and commit may differ.
if [ -n "$before" ]; then
  strip() { grep -vE '^ +"(commit|version)":' "$1" || true; }
  if ! diff <(strip "$before") <(strip "$expected") >/dev/null; then
    echo "regenerate: expected.json changed beyond its dalgo block; Go's answers differ between the two revisions:" >&2
    diff <(strip "$before") <(strip "$expected") | head -40 >&2 || true
    exit 3
  fi
  echo "regenerate: zero semantic difference from the previous expected.json" >&2
fi
