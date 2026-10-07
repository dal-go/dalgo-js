# JS-local materialized source composition

`executeSourceComposedJoinedDTQLQuery(query, options)` is an explicit opt-in
materialized relation-tree join. Each leaf is independently admitted by a
trusted application before any source query. The output has
`sourceComposition.format: "dalgo-source-composition/1"`, including when
`records` is empty. Ordinary `executeJoinedDTQLQuery`, paged joins and recursive
execution continue to refuse annotated inputs.

This core slice is verified with fabricated in-memory currency descriptors and
fabricated GET observations. It does not make provider requests. Adoption by the
private HTTP adapter and its in-memory browser viewer is a separate consumer
acceptance step. No production source activation, provider permission, browser
CORS journey, package publication or cross-language transport is claimed here.

## Envelope and namespaces

A composed result contains a composer-owned `compositionId`, `operation: "join"`
and an ordered `inputs` array. Each entry records:

- `scanId` and the exact AST `relationPath`, such as `from.joins[0].from`;
- the trusted resolved executor's `source` identity and admitted `semanticRef`;
- its exact admitted scan `scope` and completeness contract reference;
- `rightsStatus: "unknown"` when `sourceRights` was omitted, or `"provided"`
  when an inventory was supplied, including `[]`;
- a detached capture of that leaf's `sourceRights`, `usedSourceIds` and
  `providerReads`, with their original IDs and declaration/evidence content.

The outer page does not flatten legacy metadata. References are scoped by
`(scanId, sourceId)`; source/resource/execution IDs can collide between leaves
without being renamed. The composition ID is never a provider execution ID.
Every physical scan remains a separate entry, including self-joins. This route
does not infer scan reuse or deduplicate independent executions.

`provided` reports metadata presence; it does not certify reuse permission.
Omission stays unknown and cannot become a fabricated empty inventory or a
licence for joined output. Source use includes empty and projected-away inputs.
The envelope describes query dependencies. It makes no row-lineage guarantee.

## Preflight and evidence

The caller supplies `compositionId` and a synchronous
`resolveInput(relation, relationPath)` callback returning an
`AdmittedMaterializedJoinInput`. It includes the secured executor, trusted
source identity, semantic reference, exact `scanQuery`, scan scope and evidence
admission. Every resolver runs once before the first await. Core captures all
executor methods, sources, scan queries, semantic bindings and admissions before
the first source query; mutating callbacks, methods or the original plan during
a later await cannot change those captured choices.

The generated scan must equal the independently admitted `scanQuery`: its
resolved collection source, empty filters, relation scan ordering and explicit
admitted limit. A mismatch fails before any source I/O. Core detaches query
objects again when passing them to an executor. Executor resolution comes only
from `resolveInput`; the composed entry point refuses `resolveExecutor`,
`scanPages`, `pageSize` and `money` options.

Evidence admissions are a closed union:

- `unknown-local`: explicitly admitted local/demo omission, requiring an empty
  metadata capture;
- `declaration`: an exact admitted rights inventory and optional used IDs.
  The complete declaration shape, identities, IDs, pins, notices and used IDs
  are checked. It cannot contain live observations;
- `provider-get`: an independently admitted `ProviderReadPlan`. Closed GET
  plans and immutable rights digests are checked before source I/O. The actual
  captured page then passes `validateProviderReads`, including execution
  authority, request/observation digests, bindings, source terms and usage.

Each page's four metadata properties are read once and detached before awaits.
The checked capture is emitted. Missing required evidence, unexpected annotations,
changed rights, unplanned observations and composed leaves fail before result
row access. Provider evidence remains `ovdb-provider-read/1`; POST/job receipts
cannot be represented as GET observations.

Trusted application admission owns permission, source contract review and
semantic compatibility. A callback, JSON object, declaration or digest cannot
grant those permissions. Core verifies correspondence to admitted facts; it
cannot independently attest a caller's source contract or source identity.

## Scan completeness

No cursor and a short page never prove completeness. Supported scopes are:

- `complete` with `proof: "immutable-local-array"`, an independently reviewed
  `contractRef`, `requestedLimit` and `maxRows`. The contract must expose the
  entire immutable local array with no hidden cap. `maxRows` may be zero and
  cannot exceed the requested limit. The returned row count must equal it.
- `complete` with `proof: "ecb-full-decoded-feed"`, an independently reviewed
  decoder `contractRef`, and exactly `requestedLimit: 256`. It requires GET
  admission and an exact unfiltered unordered query at 256. The admitted
  adapter/decoder contract must reject feeds above 256. This proves the complete
  successfully decoded admitted feed, not all currencies, dates or providers.
- `bounded` with an explicit relation `scan`, the exact requested limit,
  `contractRef` and `ordering: "specified" | "unspecified"`. The ordering label
  must match the relation's scan order. This denotes an admitted prefix/subset,
  never whole-table exhaustion. It can be used only when those bounded relation
  semantics are intended and displayed to the viewer.

Complete scopes cannot replace an explicit bounded relation scan. Returned
cursors and pages exceeding their admitted row limit fail. Unknown completeness
proofs fail. Ordinary BigQuery pages, cursor inference, recursive subqueries,
already composed leaves, streaming sources and non-GET provider evidence remain
unsupported. Nested ordinary relation-tree joins are supported and each AST
leaf is scanned once.

The currency fixture joins native currency-code strings to fabricated descriptor
names. Native decimal/date strings remain source values; no EUR quote is
synthesized and no currency/accounting conversion is approved by this API.

## Bounds and consumers

The fixed composition limits are 64 leaves and 256 KiB combined UTF-8 canonical
metadata. `maxMetadataBytes` can lower that limit. The same combined limit bounds
captured preflights, including their queries and admissions. Declaration-only
terms can exceed the GET contract's 4096-character limit, subject to the combined
metadata bound; terms, notice whitespace and URL fragments are preserved.
Live GET metadata retains its existing tighter field limits.

Existing execution bounds still apply: 10,000 fetched rows, 10,000 result rows,
100,000 candidate evaluations and 16 MiB retained row data by default. Per-scan
limits cannot exceed the admitted fetched-row budget. Cumulative row and data
bounds are checked before evaluating the join. All leaf scans execute even when
an earlier leaf is empty, so the final empty result retains all actual scans.

The initial supported consumer is a transient **in-memory viewer** using this
same core runtime. It must display each input's unknown/provided status, scan
scope and source notices even for zero output rows. `snapshotQueryMetadata`
preserves and structurally checks the envelope. Snapshotting does not establish
that an imported envelope previously passed independent admission.

Call `requireSourceCompositionConsumer(rawPage, consumer)` before reading rows,
codecs, serialization or dispatch. Only `consumer: "in-memory-viewer"` is enabled;
save/export, IndexedDB, persisted RecordSet, generic enrichment and Go/OVDB
dispatch are unsupported. For a boundary with no composition capability, call
`requireNoSourceComposition(rawPage)`. Both reject raw property presence even
when its value is null, undefined or malformed. Legacy joins/recursive paths,
GET snapshot/validation and paged enrichment implement their refusal directly.
The named viewer must snapshot/validate metadata before reading output rows.

No Go or OVDB transport is enabled by this core API. An adopting OVDB JS query
or point-read adapter must reject raw `sourceComposition` before metadata parsing
and row decoding until a reviewed preserving transport exists. Go JSON boundaries
must check the raw field before unknown-field-dropping unmarshalling. The OVDB
JS raw query/point-read refusal was adopted separately in
[`dal-go/dalgo-http-adapters` PR17](https://github.com/dal-go/dalgo-http-adapters/pull/17),
on adapter main `7197cb211ad06d1e8b2ba5e8e3f522b2c1f6b767`. That guard refuses
composition transport; HTTP producer/browser join acceptance remains pending.
Arbitrary third-party code that
deliberately copies only rows is outside this supported consumer inventory.

Generic `QueryExecutor.query` has no signal argument. This route makes no
end-to-end cancellation claim. A consumer that promises cancellation needs a
separately admitted cancellable scan contract.

## Release boundary

This is an additive core changeset, with no package manifest or lockfile bump
and no npm publication. Before adapter adoption, use exactly one canonical
core runtime. A future core 0.6.x publication requires reviewing the private
HTTP adapter's current `>=0.5.0 <0.6.0` bound. BigQuery adoption must review its
peer baseline, workspace overrides and both packed-artifact release scripts;
it is not part of this GET-only slice. Independent review of the exact core
diff and consumer acceptance remain required before claiming delivery.
