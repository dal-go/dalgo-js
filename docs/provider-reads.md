# Provider observations v1 — consumer contract

`QueryMetadata.providerReads` accepts the closed `ovdb-provider-read/1` envelope.
This is a **consumer capability**, with no producer, source activation, live-data
fixture, retained response, or historical evidence. Omitted metadata continues to
mean unknown. The explicit `validateProviderReads(metadata, admittedPlan)` gate
requires evidence and refuses before output when it is absent or invalid.

The envelope has exactly `format`, `execution`, `bindings`, `reads` and `usage`.
See exported interfaces for the closed field sets. IDs are opaque and bounded.
`providerSourceId` identifies the catalog's original provider recordset and must
be distinct from executor-scoped legacy `rightsSourceId`. Full `sourceRights`
and `usedSourceIds` must match the independently admitted plan exactly. Existing
server identity checks are not replaced by this gate.

`execution` freezes id, direct/proxy mode and admitted executor authority.
Bindings freeze canonical provider, rights source, original resource, immutable
definition digest, decoder digest and rights digest. The verified immutable
definition must itself bind exact model/meaning artifacts: this reader checks
digest equality, not artifact existence or semantic admission. v1 has one binding
per resource; multiple recordsets sharing an upstream resource need a separately
reviewed extension rather than an ambiguous observation binding.

Each read identifies the request, UTC fetch time, exact admitted HTTPS upstream
URL, successful response status, content type, consumed body SHA-256/byte count,
and optional source reference date, Last-Modified and ETag. Headers are bounded
plain text; no arbitrary header map, credentials, body or rows are allowed.
Rights declaration and notice text separately preserves LF, CR and tabs, while
rejecting other Unicode controls. HTTPS rights links allow fragments and preserve
the admitted string exactly; they are not upstream-resource locators.
`fetchedAt` accepts UTC seconds or millisecond precision. Reference dates are
validated Gregorian labels, not publication instants. Direct and proxy use their
respective executor-observed attestations; these are not signatures or publisher
verification of live response bytes.

`usage` binds canonical provider and legacy rights source to observation IDs.
Actual use includes empty and projected-away input and is never inferred from
output rows. Identical repeated observation IDs deduplicate; changed content for
the same ID fails. Identical repeated self-join usage deduplicates. Conflicting
duplicate usage, unknown/missing/unclaimed observations, unplanned resources,
and missing live legacy usage fail. Query aliases stay in the query plan.
Distinct admitted request parameters or read times yield distinct observations.
Planned but unread bindings can remain without usage. Non-live legacy sources
can coexist in the exact admitted rights/used-source inventory.

SHA-256 digests are lowercase 64-hex of RFC 8785 canonical UTF-8 JSON. The
consumer implements ECMAScript number serialization and UTF-16 property ordering,
rejects invalid Unicode scalars, and applies no Unicode normalization. Counts,
statuses and public numeric request parameters are safe integers; decimals should
be strings. Public parameters are a closed admitted dictionary of scalar
string/integer/boolean/null values or bounded arrays of those values. This HTTP
profile admits GET only and requires reviewed non-secret parameters.
Trusted definition admission and request construction must exclude secrets in
URL paths/query values and parameters. Exact plan equality is not a secret detector.

Canonical hash payloads are:

```text
rightsDigest:
  {format:"ovdb-rights-binding/1",right:<complete normalized SourceRight>}
requestDigest:
  {format:"ovdb-resource-request/1",resourceId,method,upstreamUrl,params}
observationId:
  {format:"ovdb-read-observation-id/1",execution:<complete execution>,
   binding:<complete preflight binding>,
   read:<complete observation with only its top-level observationId omitted>}
```

No recursive key stripping is permitted. Full rights equality precedes digest
checking. The synthetic corpus tests scalar serialization, UTF-16 ordering,
Unicode differences and an independently calculated SHA-256 vector; Go producers
must adopt this payload and cross-runtime corpus before emission is enabled.

Arrays are bounded to 64 items, strings to 4096 UTF-16 units, and combined
`sourceRights`/`usedSourceIds`/`providerReads` canonical UTF-8 JSON to 256 KiB.
Rights URLs additionally follow the Go declaration's 2048-UTF-8-byte bound. The
v1 4096-UTF-16 text bound is narrower than Go's 65536-UTF-8-byte terms bound;
producers must check admission compatibility without truncating or rewriting terms.
Admitted plans can lower read and metadata budgets. Producers must also charge
metadata to the existing whole-response limit before any row output, reserve the
planned source/resource limits before reads, and respect smaller existing limits.

`snapshotQueryMetadata` detaches and structurally validates this new envelope.
It does **not** substitute for asynchronous digest and plan verification. Call
`validateProviderReads` once the trusted execution has finalized actual usage,
await it before emitting rows, and carry its detached metadata to results.
The three caller evidence properties are each captured once, detached, and then
validated; caller getters/proxies cannot swap a checked envelope for returned
data. QueryPage rows and other parent fields are never accessed or cloned.
Caller metadata and plan are detached before its first await. Generic joins and
recursive transforms keep refusing annotated inputs until their own source-rights
preflight exists; this change does not enable rights-aware federation.

Before producer insertion or activation: deploy aware consumers and advertise
the `ovdb-provider-read/1` capability during admission; retain legacy profiles;
verify immutable definition/decoder/model artifacts and exact provider-to-executor
bindings independently; add a per-execution collector without retaining bodies;
test Go/JS canonical parity; prove no-store/no-retention and all actual storage
sinks; and pass semantic/rights, notices and live product journey gates. A legacy
consumer must not select a profile requiring this envelope. No query click,
source terms, or this metadata API authorizes source/result copies or snapshots.

## Independent review r1 disposition

Both major findings were accepted. The capture mismatch is fixed by reading each
parent evidence property once, detaching the selected metadata, and validating
that exact capture; getter/proxy and forbidden-field regressions cover both APIs.
Rights compatibility is fixed with field-specific multiline text and fragment-link
validation, preserving exact bytes and digests in live and mixed-source cases.
No finding was declined. Independent review r2 remains a separate acceptance gate.
