# metadata-store-validator

JavaScript validation library for the [metadata-store](https://github.com/skofic/metadata-store) data dictionary, plus a Node `dbAccess` adapter, a dictionary snapshot for bulk data, and a CLI.

Validates values and documents against `_data` section schemas defined in the dictionary. The library runs synchronously in `'use strict'` mode, has no Node built-ins on its hot path, and runs unchanged in Node and in ArangoDB Foxx services. The dictionary's own vocabularies (`_type_shape`, `_type_scalar`, `_type_key`) are read from the database at runtime — the only things fixed in code are those three anchor GIDs.

Authored inside `metadata-store` (as `validator/`, `workflows/validate/` and `test/`) and moved here on 2026-08-21; history up to `metadata-store@cf4453e` lives in that repository.

---

## Directory structure

```
index.js            — package entry: re-exports lib/ + compute, errors, ANCHOR;
                      makeDbAccess, buildSnapshot, makeHttpQuery (lazy)
lib/                — the validator library (pure; Node + Foxx)
  index.js          — public API
  validate.js       — shape dispatcher (validateData)
  conformance.js    — dictionary-driven validator (validateByDictionary, validateConformance)
  properties.js     — validateProperties: a data record keyed by descriptor _gid
  envelope.js       — describeEnvelopeNeeds / validateEnvelope: aggregates of large data
  report.js         — createReport: errors and warnings tallied per descriptor
  snapshot.js       — makeSnapshotDbAccess: dbAccess over a pre-fetched dictionary snapshot
  edge-index.js     — enumeration and rule-edge lookups shared by both Node adapters
  units.js          — unit physical bounds (unit_range) and checkUnitBounds
  compute.js        — resolve computed properties: the schema-driven driver over compute-registry.js
  compute-registry.js — the compute functions behind every `_computed` declaration, keyed schema → property
  md5.js            — MD5 shim: Node `crypto`, or `@arangodb/crypto` under Foxx
  coerce.js         — type coercion before strict validation
  errors.js         — error codes, makeError(), WARNING_CODES, partitionFindings()
  ranges.js         — shared numeric and string range checks
  type-registry.js  — reads the type vocabularies from the three anchor terms
  types/            — _number*, _boolean, _string*, _text*, _handle / _timestamp / scopes, _enum, _term_key*
  shapes/           — _scalar, _object, _object_GeoJSON, _objects, _array, _set, _dict, _keyed, _tuple, _nested, _typedef
db/                 — Node-side tools
  db-access.js      — makeDbAccess(credentials, cacheSize): live synchronous HTTP (needs `sync-request`)
  snapshot-builder.js — buildSnapshot({ gids, query }): fetch a snapshot (async, any AQL client)
  http-query.js     — makeHttpQuery(credentials): dependency-free AQL query function (fetch)
  lru-cache.js, queries/index.js
bin/validate.js     — the `metadata-validate` CLI (validate JSON files against the loaded dictionary)
test/               — regression suite (see MILKO.md)
```

---

## Installation

Distributed as a **GitHub-tagged npm dependency** (no registry publish). Pin a tag:

```json
{ "dependencies": { "metadata-store-validator": "github:skofic/metadata-store-validator#v1.1.1" } }
```

```js
const { validateByDictionary, validateProperties, makeSnapshotDbAccess } = require('metadata-store-validator');
```

**From an ES module** the package is CommonJS and builds its exports dynamically, so named imports do not work. Use `createRequire` or a default import:

```js
import { createRequire } from 'node:module';
const validator = createRequire(import.meta.url)('metadata-store-validator');
// or: import validator from 'metadata-store-validator';
```

It depends on [`geojson-s2`](https://github.com/skofic/geojson-s2) (pinned the same way) for `_object_GeoJSON` values, and **optionally** on `sync-request`, which only the live adapter (`makeDbAccess`), the CLI and the DB tests use. A pipeline that validates through a snapshot does not need it: install with `npm ci --omit=optional`.

**In a Foxx service** — add the dependency to the service's `package.json`, run `npm install --omit=optional` in the service directory, and ship `node_modules/` with the bundle. Implement `dbAccess` with `@arangodb` queries — see the example below. `metadata-store-service` does exactly this for its `/validate` routes.

**CLI** — after `npm install` the `metadata-validate` bin is available (`npx metadata-validate …`, or `node bin/validate.js …` from a checkout):

```sh
metadata-validate --compute --credentials path/to/db.credentials.json path/to/data/ --errors-only
```

Run without arguments for the full option list; `MILKO.md` documents the flags, modes, pre-validation transforms and output format.

---

## Errors and warnings

Every entry point returns findings in two lists:

- **`errors`** — the value breaks a hard constraint: wrong type, outside `_range_valid`, outside its unit's physical bound, not a member of its enumeration, a required property missing, …
- **`warnings`** — the value is acceptable but notable. A value outside `_range_normal` (the range where values are *expected* to fall) is an outlier, reported as `RANGE_OUTLIER`. Lenient mode also reports unknown properties here.

Only errors make a value invalid. The type validators produce one mixed list; `partitionFindings()` (in `errors`) sorts it by the codes in `WARNING_CODES`.

---

## Public API

### `validateByDictionary(doc, descriptorGid, dbAccess, opts)`

Validates a document against the dictionary using a named descriptor term. For each property key in the document, looks up the key as a dictionary term via `dbAccess.getTerm()` and validates the property value against that term's `_data` section. Recurses into nested `_object` values, `_array` elements whose element type is `_object`, and `_dict` values whose value type is `_object`. Also works for a single value: `validateByDictionary(12.3, 'env_climate_bio01', dbAccess)`.

Returns `{ errors, warnings, coercions }`. Unknown property keys produce a hard error in strict mode (default) or a warning in lenient mode.

```js
const result = validateByDictionary(doc, '_term', dbAccess, { strict: true });
// result.errors    — hard errors (empty = valid)
// result.warnings  — outliers; unknown properties in lenient mode
// result.coercions — coercion records
```

| Descriptor | Typical use |
|---|---|
| `_term`  | Term documents in `terms.*` files |
| `_edge`  | Edge documents in `edges.*` files |
| `_link`  | Link documents in `links.*` files |
| `_blob`  | Blob documents in `blobs.*` files |
| any GID  | Dataset documents (use `strict: false` for mixed data) |

---

### `validateProperties(properties, dbAccess, opts)`

Validates a **data record**: an object whose keys are descriptor `_gid`s, such as the `properties` of a loaded document. Each value is checked against its descriptor — type, valid range, the unit's physical bound, enumeration membership, formats (errors) and normal range (warnings). Finding paths start with the descriptor gid. A `dbAccess` is required.

```js
const r = validateProperties({ env_climate_bio01: 12.4, env_climate_cdi: 'env_climate_cdi_1' }, dbAccess);
```

Returns `{ errors, warnings, coercions }`. Options: `strict` (default `true`; `false` turns an unknown gid into a warning), `coerce`.

---

### `validateConformance(value, dataSection, path, dbAccess, opts)`

Lower-level entry point used by `validateByDictionary`. Runs the structural shape validator (`validateData`) then adds the dictionary-lookup pass for `_object` shapes. Can be called directly when you already have the `_data` section in hand.

Returns `{ errors, warnings, coercions }`.

---

### `validateValue(value, dataSection, dbAccess, opts)`

Validates a single value against a `_data` section (no dictionary pass, no rule edges). Used for real-time UI field validation.

```js
const result = validateValue(
  3.14,
  { _scalar: { _number_float: { _range_valid: { '_min-inclusive': 0 } } } },
  null,   // no DB checks needed for this type
  {}
);
// result.errors, result.warnings, result.coercions
```

---

### `validateDocument(doc, descriptor, dbAccess, opts)`

Resolves computed properties (every `_computed` entry of the descriptor's bodies, interpreted by kind) then validates a single document — a term, an edge, a link, a blob, or any object whose descriptor declares `_computed` — against the descriptor's `_data` section. Mutates `doc` in place to add computed fields (see *Computed properties* below). Returns `{ errors, warnings, coercions, computed }`; compute warnings (e.g. `COMPUTE_ADDED`) appear in `warnings`, and `computed` lists every fill as `{ path, value }`.

```js
const doc = { _code: { _nid: 'ISO_3166', _lid: 'ITA' } };
const result = validateDocument(doc, descriptorTerm, dbAccess, { coerce: true });
console.log(doc._code._gid);  // → "ISO_3166_ITA"
```

---

### `validateFile(docs, getDescriptor, dbAccess, opts)`

Batch validates an array of term documents. Stops collecting failures after `opts.maxErrors` documents have failed (default 10; `0` = unlimited). A document with warnings but no errors counts as passed.

```js
const report = validateFile(docs, doc => lookupDescriptor(doc._code._gid), dbAccess, { maxErrors: 10 });
// report.passed, report.failed, report.warned, report.truncated
// report.errors    — [{ index, doc, errors }]
// report.warnings  — [{ index, path, code, value, expected, message }]
// report.coercions — [{ index, path, from, to, rule }]
```

---

### `createReport(options)` — validation summary

For large runs, printing every warning is useless; the share of values that are outliers is what matters. A report collects many results and tallies errors and warnings **per descriptor and code**, as a share of the values checked, with a few examples of each. It sets no threshold — deciding what share calls for action is up to the consumer.

```js
const report = createReport({ samples: 3 });
for (const doc of docs) {
  report.add(validateProperties(doc.properties, dbAccess), { properties: doc.properties });
}
console.log(report.format());
// Validation summary: 37,476,186 document(s), 0 with errors, 12,400 with warnings
// Errors: 0
// Warnings: 12,400
//   env_climate_spi3  RANGE_OUTLIER  12,400 / 37,476,186 (0.033%)
//       e.g. Value 3.2 exceeds the maximum of 2 (inclusive)
```

| Method | Purpose |
|---|---|
| `add(result, context)` | Add one result. `context.properties` counts one value per key of the record; `context.gid` (+ `context.values`) attributes a single-value check. |
| `addEnvelope(result, envelope)` | Add a `validateEnvelope` result; values come from each entry's `count`, findings carry their own counts. |
| `countValues(gid, n)` | Record values checked without a result. |
| `summary()` | The tallies as data: `{ documents, documentsWithErrors, documentsWithWarnings, values, errors, warnings }`, each section `{ total, byCode, byDescriptor: { gid: { code: { count, values, share, samples } } } }`. |
| `format()` | The tallies as text, largest counts first. |

The CLI's `--summary` flag prints the same report at the end of a run.

---

### `describeEnvelopeNeeds(gids, dbAccess)` / `validateEnvelope(envelope, dbAccess, opts)` — large data

A collection of hundreds of millions of documents cannot be read back one value at a time. Its **envelope** can: the database computes a few aggregates per descriptor and these are checked against the dictionary. The aggregation query depends on the collection's layout and stays with the consumer.

`describeEnvelopeNeeds` tells the consumer what to aggregate for each gid: `{ found, kind, type, unit, ranges: { valid, normal, unit } }`, where `kind` is `number | integer | timestamp | boolean | enum | string | other` and the ranges are the dictionary's `_range` objects (so the query can count values outside them).

`validateEnvelope` takes, per gid (all fields optional):

| Field | Meaning |
|---|---|
| `count` | values present |
| `min`, `max` | numeric extremes — validated as values |
| `types` | distinct AQL `TYPENAME()`s seen, e.g. `["number"]` |
| `nonInteger` | values with a fractional part (integer and timestamp kinds) |
| `outOfValid` | values outside the valid range or the unit bound |
| `outOfNormal` | values outside the normal range |
| `distinct` | string / enum values, `[value]` or `[{ value, count }]` — each validated |
| `distinctTruncated` | `true` when `distinct` is not the complete set |

It returns `{ errors, warnings, skipped }`; each finding carries `gid`, `which` (`descriptor | type | integer | count | min | max | distinct`) and `count` (values concerned, or `null` when only an example is known). Non-scalar descriptors are `skipped` — validate those in-process.

---

### `checkUnitBounds(term, dbAccess)`

Authoring check: reports `UNIT_RANGE_CONFLICT` when a descriptor's declared `_range_valid` or `_range_normal` reaches beyond the physical bound of the unit it selects (or cannot overlap it). The CLI runs it on every term in term mode.

---

### `applyComputed(doc, descriptorGid, dbAccess, opts)` / `checkComputeRegistry(dbAccess)` — computed properties

A schema body declares the properties the system supplies in `_computed`, one entry per property, each stating the **kind** of computation and its parameters. `lib/compute-registry.js` is the interpreter of eight kinds; `lib/compute.js` the driver.

| Kind (`_compute_kind`) | Parameters | Absent inputs | Stored value present |
|---|---|---|---|
| `_compute_kind_copy` | `_compute_from` (exactly one path) | nothing computed | replaced — a different value is `COMPUTE_MISMATCH` |
| `_compute_kind_concat` | `_compute_from` (ordered paths), `_compute_separator` | absent parts skipped (`""` counts as present) | replaced |
| `_compute_kind_hash` | `_compute_from`, `_compute_separator`, `_compute_digest` (`_compute_digest_md5` → lowercase hex) | any absent part → nothing computed | replaced |
| `_compute_kind_union` | `_compute_from` (each value, scalar or array, added if missing) | contributes nothing | merged — a stale list is `COMPUTE_ADDED` and filled |
| `_compute_kind_rule` | `_compute_rule` (`_compute_rule_term-role`: the `assign-roles` rules) | the rule decides | merged |
| `_compute_kind_constant` | `_compute_value` (any JSON, deep-copied) | — | kept as found: a constant only fills an absence |
| `_compute_kind_generate` | `_compute_generator` — `_compute_generator_now` (the current date and time in the property's declared type, truncated to its `_scale_time`; needs a `dbAccess` to read the type) or `_compute_generator_key` (the collection assigns it: nothing is computed here) | — | kept as found; an absent value the interpreter cannot produce is **pending** (`COMPUTE_PENDING` warning, listed in `pending`) |
| `_compute_kind_service` | `_compute_service` (the gid of the process that derives it, declared by the project that runs it) | — | kept as found — a seed the service verifies; an absent value is **pending** for the service |

Paths in `_compute_from` are container-relative (`_scope_object` strings: `_lid` inside `_code`, `_code._gid` on the term root), `_compute_from` is ordered and its paths must be unique, and the entries of one body apply in list order. The six core declarations:

```json
"_code":  [ { "_field": "_gid", "_compute_kind": "_compute_kind_concat", "_compute_from": ["_nid", "_lid"], "_compute_separator": "_" },
            { "_field": "_aid", "_compute_kind": "_compute_kind_union",  "_compute_from": ["_lid"] } ]
"_term":  [ { "_field": "_key", "_compute_kind": "_compute_kind_copy",   "_compute_from": ["_code._gid"] } ]
"_edge", "_link":
          [ { "_field": "_key", "_compute_kind": "_compute_kind_hash",   "_compute_from": ["_from", "_predicate", "_to"],
              "_compute_separator": "/", "_compute_digest": "_compute_digest_md5" } ]
"_blob":  [ { "_field": "_key", "_compute_kind": "_compute_kind_hash",   "_compute_from": ["_blob_item", "_blob_type", "_blob_kind", "_blob_identifier"],
              "_compute_separator": "/", "_compute_digest": "_compute_digest_md5" } ]
"_domn":  [ { "_field": "_term_role", "_compute_kind": "_compute_kind_rule", "_compute_rule": "_compute_rule_term-role" } ]
```

**One shape.** Since v1.5.0 a `_computed` entry must be an entry object; a bare property gid — the shape every body carried before v1.4.0, accepted by v1.4.0 during the dictionary's switch — is reported as `INVALID_COMPUTE` and runs nothing. `computedFields(body)` / `computedEntry(body, gid)` (exported) read the entries and are what every consumer of the list uses.

```js
const { applyComputed } = require('metadata-store-validator');

const doc = { _code: { _nid: 'chr', _lid: 'NewVariable' }, _info: { … }, _data: { _scalar: { _number_float: {} } } };
const { errors, warnings, computed } = applyComputed(doc, '_term', dbAccess, { quietCompute: true });
// doc now carries _code._gid, _code._aid, _key and _domn._term_role;
// computed: [{ path: '_code._gid', value: 'chr_NewVariable' }, …]
```

With a `dbAccess` the walk is **schema-driven**: the descriptor's body is read from the dictionary, containers are computed before their parent, a container the document lacks is created when its schema declares computed properties (a new term gets its `_domn`), and an entry that cannot run is an error at the property's path — `NO_COMPUTE_FUNCTION` (a kind, digest or rule the interpreter does not implement), `INVALID_COMPUTE` (a parameter missing or mistyped, or an entry that is not an object), `DUPLICATE_VALUE` (a repeated `_compute_from` path). Without a `dbAccess` the driver runs `CORE_DECLARATIONS` — the six declarations above, built in — over the fixed core layout (terms, edges/links, blobs); that is what the historical `compute.computeTermCode` / `computeEdgeKey` / `computeBlobKey` wrappers do.

Absent values are filled and reported as `COMPUTE_ADDED` (a warning, an error under `strictCompute`, silent under `quietCompute`, reported without filling under `noFill`). Every computed value, written or not, is kept in a shadow keyed by document path, so under `noFill` `_term._key` is still reported from the `_code._gid` that was computed but not written. The term-role rule needs five optional `dbAccess` facts (see the contract below); when the accessor cannot answer them the stored roles are left alone.

`checkComputeRegistry(dbAccess)` returns the differences between the dictionary's `_computed` declarations and what the code can run, as strings (the CLI prints them at start-up): every declared entry must resolve, and the built-in `CORE_DECLARATIONS` must match the dictionary — the same computed fields per core schema and identical entries (compared with sorted keys, since ArangoDB returns object keys sorted). It needs `dbAccess.listComputedDeclarations()`, which the Node HTTP adapter, a snapshot built since v1.4.0 and the Foxx adapter provide. (Before v1.4.0 the HTTP adapter dropped the method on its way through `makeEdgeBackedAccess`, so the check always reported nothing.)

**Pending.** `applyComputed` returns `pending`, the paths of the absent properties the collection or a service fills at or after insertion. `validateDocument` removes the `MISSING_REQUIRED` of those paths (`dropPendingRequired(errors, pending)` is exported for callers that run `applyComputed` themselves), so a dataset record whose key the collection assigns and whose count a service derives validates before it is inserted. `opts.now` fixes the moment a `now` generator writes (tests).

### `formFields(body)` / `checkFields(body, path)` — the presentation list

A schema body (the content of `_open` or `_closed`) may carry `_fields`: an ordered list with one entry per property, stating the order a form presents the properties in, the panel each belongs to (`_group`, default `_group_main`) and whether the property is indexed in the collection holding the object (`_index`). The rule lists decide presence and mode; `_fields` only adds presentation.

```js
const { formFields } = require('metadata-store-validator');

const { fallback, fields } = formFields(codeTerm._data._object._closed);
// fallback: false (the body carries _fields)
// fields[0]: { gid: '_nid', group: '_group_main', index: '_index_identity',
//              required: false, selector: null, computed: false, compute: null,
//              computedBy: null, locked: false, immutable: true, default: undefined }
```

`computed` is true for a property a `_computed` entry derives (read-only once the object exists) — except a **constant**-kind entry, which is a pre-fill the user may change: it is reported with `computed: false` and its `_compute_value` in `default`. `compute` carries the entry's `_compute_kind` gid (null when not computed) and `computedBy` the generator, service or rule gid it names, which is what tells the creation modes apart: the declarative kinds (copy, concat, hash, union, rule) are hidden on creation; a generated value is shown read-only, pre-filled by the form when it can produce it (`_compute_generator_now`) and blank when only the database can (`_compute_generator_key`); a service-derived value is absent on creation when `locked` and an input the user may seed when not. `group` is `_group_main`, `_group_more` or `_group_hidden` (never presented, in any form or display). `index` is the entry's `_index` intent, or the body's own `_index` when the container indexes every property it holds, or null.

The order rule has one implementation, shared by a form builder, the `/ui` `GET /fields/:gid` route and an index generator: `_fields` order first, then any `_required` or `_recommended` property it left out, in required-then-recommended order; a body without `_fields` returns the whole list as that fallback (`fallback: true`). `required` is true only for a member of an unconditional `_all {}` selector; a property that belongs to a choice (`_any`, or `_all` with counts) carries `selector: { id, kind, min, max, group? }` instead, so the members of one selector can be rendered together as one choice.

`checkFields` is the authoring check the conformance validator runs on every validated body that carries `_fields`: `FIELD_NOT_IN_SCHEMA` and `FIELD_BANNED` are errors, `FIELDS_INCOMPLETE` is a warning. Entry shape, descriptor existence and duplicate `_field` values are the ordinary `_objects` validation of the `_fields` term.

### `indexPlan(rootGid, dbAccess, opts)` — what a collection index must cover

```js
const { indexPlan } = require('metadata-store-validator');
const plan = indexPlan('_term', dbAccess, { languages: ['ISO_639_3_eng'] });
// { root: '_term', languages: ['ISO_639_3_eng'],
//   containers: [ { path: '_domn', gid: '_domn', intent: '_index_identity' } ],
//   fields: [
//     { path: '_code._gid',   gid: '_gid',   intent: '_index_segment',  leaf: '_string', shape: '_scalar' },
//     { path: '_info._title', gid: '_title', intent: '_index_text',     leaf: '_text',   shape: '_dict',
//       multilingual: true, languages: ['ISO_639_3_eng'] },
//     { path: '_domn._class', gid: '_class', intent: '_index_identity', leaf: '_enum',   shape: '_scalar',
//       enums: ['_class'], single: true },
//     … ],
//   problems: [] }
```

The dictionary says how the objects of a collection are indexed: each `_fields` entry of a schema body may carry an `_index` intent — `_index_identity` (one token: exact match, a facet when the leaf is an enumeration), `_index_text` (analysed text; on a multilingual value one field per configured language) or `_index_segment` (the value split on the `_` namespace separator; the `_gid` index) — and a body may carry `_index` itself, meaning the container indexes **every** property it holds (`_domn`). `indexPlan` walks the root schema through its containers (one `_typedef` hop at each level, arrays and sets unwrapped) and returns that as data: `containers` for the index-all bodies, `fields` for the hinted leaves with their leaf type and shape, `multilingual` or `dict` when the value is a language-keyed or a free dictionary, `enums` / `single` for enumeration leaves (a facet's roots and whether an object carries one value or several). It names no analyzer, no index name and no database feature: the service that owns the collection maps the plan to its inverted index and compares the result with the live one (`metadata-store-service`, `lib/index-gen.js`). `problems` are advisory — `UNKNOWN_TERM`, `HINT_ON_CONTAINER`, `UNINDEXABLE_SHAPE`, `SEGMENT_ON_NON_STRING`, `TEXT_ON_TOKEN`, `IDENTITY_ON_TEXT`, `UNKNOWN_INTENT`, `TOO_DEEP` — never thrown. The CLI prints a plan with `--index-plan <gid>` (`--languages a,b` to expand more languages).

## Unit physical bounds (`unit_range`)

A unit term may carry `_prop.unit_range`, a `_range` object stating a bound no value in that unit can cross — kelvin ≥ 0, °C ≥ −273.15, percent 0…100. When a numeric descriptor selects such a unit via `_unit`, a value must satisfy **both** the descriptor's `_range_valid` and the unit's bound (their intersection). A breach of the unit bound is a `RANGE_VIOLATION` whose message names the unit. Without a `dbAccess` the unit term cannot be read and the bound is not checked.

---

## Dictionary snapshots — bulk validation

The live adapter makes a blocking HTTP call per new term: fine for a CLI sweep, wrong for a pipeline validating millions of values. A **snapshot** holds just the terms and edges a run needs, fetched once, and answers every lookup from memory.

```js
const { buildSnapshot, makeHttpQuery, makeSnapshotDbAccess } = require('metadata-store-validator');

const snapshot = await buildSnapshot({
  gids:  ['env_climate_bio01', 'env_climate_spi3', 'env_climate_cdi'],
  query: makeHttpQuery({ host, database: 'metadata', username, password }),
  // or with arangojs: query: (q, b) => db.query(q, b).then(cursor => cursor.all()),
});
if (snapshot.missing.length) throw new Error('unknown descriptors: ' + snapshot.missing.join(', '));

const dbAccess = makeSnapshotDbAccess(snapshot);   // synchronous, no network
```

`buildSnapshot` fetches the three anchor terms, the requested terms, and everything their `_data` refers to (`_typedef` targets, `_unit` terms, `_enums` roots, object-schema property gids, `_keyed` keys), plus the enumeration edges of those roots and the rule edges. A failed query rejects; requested gids with no term are listed in `missing`.

The snapshot is plain JSON (version 1: `terms`, `missing`, `enumEdges`, `propertyOfRules`, `valueOfRules`, `source`, `builtAt`), so a run can store it as the record of the dictionary its data was checked against. `makeSnapshotDbAccess` refuses a snapshot without the anchor terms, and a lookup for a gid never requested **throws** — pass `{ onMiss: 'null' }` to treat such gids as absent instead. `isEnumRoot` for roots outside the snapshot's enumerations falls back to a term lookup and throws likewise; data descriptors do not use it.

The snapshot accessor and the live adapter share their edge logic (`lib/edge-index.js`), so they validate identically (`test/snapshot-parity.js` checks it against a live database).

---

## Using it in a data pipeline

A guide for a loader that writes documents whose values are described by dictionary descriptors, such as a pipeline filling a geospatial database with remote-sensing indicators. The library checks values and reports; what to do with an invalid value (stop, leave it out, or store it and count it) is the pipeline's decision.

### 1. Install

Pin a tag and skip the optional dependency (only the live adapter and the CLI need it):

```sh
npm install --omit=optional github:skofic/metadata-store-validator#v1.1.1
```

From an ES module, load it with `createRequire` (named imports do not work):

```js
import { createRequire } from 'node:module'
const validator = createRequire(import.meta.url)('metadata-store-validator')
```

### 2. Load the dictionary once per run

Build a snapshot for the descriptors the run can write, from the `metadata` database. Any AQL client works; with arangojs:

```js
import { Database } from 'arangojs'

const dictionaryDb = new Database({ url: host, databaseName: 'metadata', auth: { username, password } })
const snapshot = await validator.buildSnapshot({
  gids,                                                     // every descriptor gid the run may write
  query: (aql, bindVars) => dictionaryDb.query(aql, bindVars).then((cursor) => cursor.all()),
})
if (snapshot.missing.length) throw new Error(`not in the dictionary: ${snapshot.missing.join(', ')}`)

const dictionary = validator.makeSnapshotDbAccess(snapshot)
```

- The user needs read access to `metadata`; the snapshot is fetched in a handful of queries, and nothing is read from the database afterwards.
- A gid that was not requested **throws** when looked up — right where a gid outside the run's list is a bug. Where stray gids can legitimately appear (checking data already stored), pass `{ onMiss: 'null' }`: an unknown gid is then reported as `UNKNOWN_PROPERTY`.
- The snapshot is plain JSON. Saving it with the run's log records which dictionary the data was checked against.

### 3. Check values as records are built

A record keyed by descriptor gid:

```js
const report = validator.createReport()

const result = validator.validateProperties(record.properties, dictionary)
report.add(result, { properties: record.properties })
if (result.errors.length) {
  // stop, drop, or keep — the pipeline's policy. Warnings never make a value invalid.
}
```

When values are nested under keys that are not gids (periods, models, scenarios, …), walk to the leaves and check each value against its descriptor:

```js
const result = validator.validateByDictionary(value, gid, dictionary)
report.add(result, { gid })
```

Each finding has `code`, `path` (starting with the gid), `value`, `expected` and `message`. On localhost (Apple M1 Max) `validateProperties` plus `report.add` took 2–3 µs for a record of five properties; measure on the target machine before choosing to sample.

### 4. Print the report at the end of the run

```js
console.log(report.format())
```

It lists errors and warnings per descriptor and code, with the share of the values checked. The report sets no threshold: a high share of `RANGE_OUTLIER` warnings on one descriptor is the signal to look at the data (or at that descriptor's normal range).

### 5. Check what is stored

For collections too large to read back, aggregate per descriptor in the database and validate the aggregates. Start from what the dictionary says about each gid:

```js
const needs = validator.describeEnvelopeNeeds(gids, dictionary)
// needs[gid] = { found, kind, type, unit, ranges: { valid, normal, unit } }
```

For documents whose `properties` is a flat object keyed by gid, one query gathers the basics:

```js
const rows = await dataDb.query(`
  FOR d IN @@collection
    FOR gid IN ATTRIBUTES(d.properties)
      LET x = d.properties[gid]
      COLLECT g = gid AGGREGATE
        count      = COUNT(1),
        min        = MIN(IS_NUMBER(x) ? x : null),
        max        = MAX(IS_NUMBER(x) ? x : null),
        types      = UNIQUE(TYPENAME(x)),
        nonInteger = SUM(IS_NUMBER(x) && x != FLOOR(x) ? 1 : 0)
      RETURN { gid: g, count, min, max, types, nonInteger }`,
  { '@collection': name }).then((cursor) => cursor.all())

const envelope = Object.fromEntries(rows.map(({ gid, ...aggregates }) => [gid, aggregates]))
```

The extremes show *whether* a range is breached. To know *how many* values are outside, count them for the gids whose extremes breach a range, with a condition built from `needs[gid].ranges`: `outOfValid` counts values outside the valid range or the unit bound, `outOfNormal` values outside the normal range.

```js
// "x is outside this _range object", as an AQL condition; null when there is no range
function outside(range, x = 'x') {
  if (!range) return null
  const parts = []
  if (range['_min-inclusive'] != null) parts.push(`${x} < ${range['_min-inclusive']}`)
  if (range['_min-exclusive'] != null) parts.push(`${x} <= ${range['_min-exclusive']}`)
  if (range['_max-inclusive'] != null) parts.push(`${x} > ${range['_max-inclusive']}`)
  if (range['_max-exclusive'] != null) parts.push(`${x} >= ${range['_max-exclusive']}`)
  return parts.length ? parts.join(' OR ') : null
}
```

For enumeration and string descriptors, collect the distinct values with their counts (capped, setting `distinctTruncated` when the cap is reached). Then:

```js
const result = validator.validateEnvelope(envelope, dictionary)
report.addEnvelope(result, envelope)
console.log(report.format())
```

`result.skipped` lists descriptors an envelope cannot check (object-shaped values) — check those in step 3. Aggregating a whole collection can be long; try it on a sample (`LIMIT`) first.

### 6. Tests without a database

`makeSnapshotDbAccess` accepts any object of the snapshot's shape, so tests can use a small hand-written snapshot instead of a database. `test/fixtures/snapshot.test.json` in this repository is a working example: the three anchor terms, a few unit terms, test descriptors, enumeration edges and one rule edge.

---

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `coerce` | boolean | `false` | Attempt type coercion before strict validation. Coerced values are reported in `result.coercions`. |
| `strict` | boolean | `true` | (`validateByDictionary` / `validateConformance` / `validateProperties`) When `false`, unknown property keys produce warnings instead of errors. |
| `maxErrors` | number | `10` | (`validateFile` only) Stop after this many failed documents. Set to `0` for unlimited. |

### Coercion rules

When `coerce: true`, the library attempts the following conversions before validating:

| From | To | Example |
|---|---|---|
| string | `_number`, `_number_float` | `"3.14"` → `3.14` |
| string | `_number_integer` | `"2"` → `2` (only if exactly integral) |
| float | `_number_integer` | `2.0` → `2` (only if exactly integral) |
| boolean | `_number*` | `true` → `1`, `false` → `0` |
| number | `_boolean` | non-zero → `true`, `0` → `false` |
| string | `_boolean` | `"true"/"1"/"yes"` → `true`, `"false"/"0"/"no"` → `false` |
| number | `_string` | `42` → `"42"` |
| boolean | `_string` | `true` → `"true"` |

Typed string variants (`_string_date`, `_string_URI`, etc.) are excluded from coercion. `"hello"` into any number type always fails.

---

## Error object

Every error and warning has the same shape:

```js
{
  code:     'RANGE_VIOLATION',        // machine-readable constant (see errors.js)
  path:     '_data._scalar._number',  // dot-path to the failing location
  value:    -5,                       // the value that failed
  expected: '>= 0',                   // human-readable constraint
  message:  'Value -5 is below the minimum of 0 (inclusive)'
}
```

### Error codes

| Code | Meaning |
|---|---|
| `WRONG_TYPE` | Value is not the expected JavaScript type |
| `AMBIGUOUS_SHAPE` | Multiple shape or type keys found where only one is allowed |
| `MISSING_SHAPE` | No recognisable shape key present |
| `UNKNOWN_PROPERTY` | Closed schema: property not in the whitelist; conformance: key is not a dictionary term |
| `MISSING_REQUIRED` | Required property is absent |
| `BANNED_PROPERTY` | Banned property is present |
| `SELECTION_VIOLATION` | `_required` selector count constraint not satisfied |
| `RANGE_VIOLATION` | Value outside `_range_valid`, or outside its unit's physical bound (`unit_range`) |
| `RANGE_OUTLIER` | **Warning** — value outside `_range_normal` (outside the expected range) |
| `UNIT_RANGE_CONFLICT` | A descriptor's declared range reaches beyond its unit's physical bound |
| `REGEXP_MISMATCH` | String does not match `_regexp` constraint |
| `CASE_MISMATCH` | String letter case violates the `_case` constraint |
| `LENGTH_VIOLATION` | String length outside the `_length` bounds |
| `INVALID_ENUM` | `_enum` value is not a member of the declared vocabulary |
| `INVALID_ENUM_SCOPE` | `_scope_enum` value is not a valid enum root or compound `root.node` |
| `INVALID_TARGET_SCOPE` | `_scope_target` value is not a valid `<handle>.<property>` compound |
| `INVALID_OBJECT_SCOPE` | `_scope_object` value is not a valid property reference (top-level name or dotted path) |
| `INVALID_SIBLING_SCOPE` | `_scope_sibling` value is not a valid local sibling reference (slash, empty segment, or unknown descriptor segment) |
| `INVALID_SIBLING_TYPE` | `_scope_sibling` leaf descriptor's declared type can never produce string values (dictionary keys) |
| `INVALID_TERM_KEY` | `_term_key` references an unknown or wrong-role term |
| `INVALID_HANDLE` | `_handle` is malformed |
| `INVALID_KEY_TYPE` | `_dict_key` declares a type that `_type_key` does not list as key-eligible |
| `UNIMPLEMENTED_SHAPE` | The dictionary declares a shape or scalar type this validator has no implementation for |
| `MIN_ITEMS` | Array or set has fewer elements than `_min-items` |
| `MAX_ITEMS` | Array or set has more elements than `_max-items` |
| `DUPLICATE_VALUE` | Set has a duplicate element, or `_objects._unique` reports a repeated value across elements |
| `ORDERING_VIOLATION` | `_objects._ordered` reports values out of order for the declared direction |
| `NO_SCHEMA_FOR_POSITION` | `_objects` element index has no matching slot schema |
| `UNREACHABLE_OBJECT_SCOPE` | `_scope_object` body is non-empty but the referenced sibling is missing from the container |
| `INVALID_GEOJSON_TYPE` | GeoJSON object's `type` field is not in the `_type_GeoJSON` allowed set |
| `INVALID_GEOJSON` | GeoJSON structure or coordinates are malformed (RFC 7946 / S2) |
| `INVALID_GEOJSON_WINDING` | A polygon ring winds the wrong way; S2 would index the complement of the intended area |
| `FIELD_NOT_IN_SCHEMA` | A `_fields` entry places a property the schema body does not admit (not in `_required`, `_recommended`, `_computed`, `_locked` or `_immutable`) |
| `FIELD_BANNED` | A `_fields` entry places a property the schema body bans |
| `FIELDS_INCOMPLETE` | **Warning** — a `_required` or `_recommended` property is not placed by `_fields`; it is presented last |
| `TYPEDEF_NOT_FOUND` | `_typedef` value does not match any term `_gid` |
| `INVALID_TYPEDEF` | The typedef term has no usable `_data` section |
| `MISSING_FIELD` | A field required for property computation is absent |
| `COMPUTE_MISMATCH` | A computed property is present but its value disagrees with the computed result |
| `COMPUTE_ADDED` | **Warning** — a computed property was absent (or stale, for a merge kind: union, rule); the computed value was added (or should be added) |
| `NO_COMPUTE_FUNCTION` | A `_computed` entry names a kind, digest or rule the interpreter does not implement |
| `INVALID_COMPUTE` | A `_computed` entry is malformed: not an entry object (a bare gid, the shape retired in v1.5.0), a parameter missing or of the wrong type, an empty `_compute_from`, more than one path on a copy |

---

## The `dbAccess` object

Some validations require the dictionary: `_enum` (vocabulary membership), `_term_key*` (term existence and role), `_typedef` (typedef resolution), unit physical bounds, the type vocabularies themselves, and — in conformance mode — the rule edges. Pass `null` to skip the DB-backed checks (the type vocabularies then fall back to the dispatch tables).

Two implementations ship with the package: the live `makeDbAccess` (`db/db-access.js`, synchronous HTTP; used by the CLI and the tests) and `makeSnapshotDbAccess` (above). Both build their edge lookups with `lib/edge-index.js`. When providing your own, implement these synchronous methods:

```js
const dbAccess = {

  // Returns true if the term with _gid `value` is reachable via
  // _predicate_enum-of from at least one of the `roots` (_gid array).
  isEnumMember(value, roots) { /* ... */ return true; },

  // Returns true if a term with this _gid exists in the dictionary.
  termExists(gid) { /* ... */ return true; },

  // Returns true if the term has `role` in its _domn._term_role array.
  termHasRole(gid, role) { /* ... */ return true; },

  // Returns the full term document (must include _data and, for units, _prop) or null.
  getTerm(gid) { /* ... */ return termDoc; },

  // Returns true if `node` is a valid branch in the graph rooted at `root` —
  // linked via _predicate_section-of (a section grouping) or _predicate_bridge-of
  // (a bridge into another enumeration). Optional: only consulted by _scope_enum
  // compound validation (`<root>.<node>` accepts elements OR branches). If
  // omitted, _scope_enum nodes are restricted to enum elements.
  isEnumBranch(node, root) { /* ... */ return true; },

  // Returns true if `gid` is the root of an enumeration: it is the _to / a _path
  // element of some _predicate_enum-of edge, or carries _term_role_enum-source
  // (declared but not yet populated). Used by _term_key_enum-root and _scope_enum.
  isEnumRoot(gid) { /* ... */ return true; },

  // Conformance mode (rule edges). `schemaHandle` is the full handle of the
  // containing schema term, e.g. "terms/_scalar".
  //
  // The _path_data[schemaHandle] rule object of the first _predicate_property-of
  // edge whose _from is propGid, or null.
  getPropertyRules(propGid, schemaHandle) { /* ... */ return ruleOrNull; },
  // The _path_data[schemaHandle] rule object of the first _predicate_value-of edge
  // with _from = valueGid and _to = propGid, or null.
  getValueRules(valueGid, propGid, schemaHandle) { /* ... */ return ruleOrNull; },
  // { <propertyName>: rule } for _path_data keys of the form schemaHandle + "." + name
  // on the same value-of edges (target-scoped rules). Empty object when none.
  getValueRuleTargets(valueGid, propGid, schemaHandle) { /* ... */ return {}; },

  // "<termsCollection>/<gid>" — the handle form used as _path_data keys.
  makeHandle(gid) { return 'terms/' + gid; },

  // Optional — the facts _domn._term_role is computed from (applyComputed). An
  // accessor without them leaves stored roles alone. Answer null for "unknown".
  isPathRoot(gid)    { /* handle in the _path of an enum-of / section-of / bridge-of edge */ return true; },
  isEnumItem(gid)    { /* _from of an enum-of edge, or an alias bridge node */ return true; },
  isNamespace(gid)   { /* some term's _code._nid */ return true; },
  isPredicate(gid)   { /* some edge's or link's _predicate */ return true; },
  isEnumSource(gid)  { /* named in some _enums array */ return true; },

  // Optional — [{ gid, computed[] }] for every schema body declaring _computed,
  // the entries passed through as stored (gid strings or entry objects); used
  // by checkComputeRegistry().
  listComputedDeclarations() { /* ... */ return []; },

};
```

### Foxx implementation example

```js
'use strict';
const db = require('@arangodb').db;

function makeDbAccess(collections) {
  const termsCol = collections.terms || 'terms';
  const edgesCol = collections.edges || 'edges';

  return {
    isEnumMember: function(value, roots) {
      return roots.some(function(root) {
        return db._query(
          'FOR e IN @@edges FILTER e._from == CONCAT(@col, "/", @val) ' +
          'AND e._predicate == "_predicate_enum-of" ' +
          'AND e._to == CONCAT(@col, "/", @root) LIMIT 1 RETURN 1',
          { '@edges': edgesCol, col: termsCol, val: value, root: root }
        ).hasNext();
      });
    },
    termExists: function(gid) {
      return db._collection(termsCol).exists(gid);
    },
    termHasRole: function(gid, role) {
      const term = db._collection(termsCol).document(gid);
      const roles = (term._domn && term._domn._term_role) || [];
      return roles.indexOf(role) !== -1;
    },
    getTerm: function(gid) {
      try { return db._collection(termsCol).document(gid); }
      catch (_) { return null; }
    },
    isEnumBranch: function(node, root) {
      return db._query(
        'FOR e IN @@edges FILTER e._from == CONCAT(@col, "/", @node) ' +
        'AND e._predicate IN ["_predicate_section-of", "_predicate_bridge-of"] ' +
        'AND CONCAT(@col, "/", @root) IN e._path LIMIT 1 RETURN 1',
        { '@edges': edgesCol, col: termsCol, node: node, root: root }
      ).hasNext();
    },
  };
}
```

---

## Adding new types or shapes

The vocabularies are **declared by the dictionary, not by the code**. Which shapes exist, which scalar types exist, and which of those may serve as dictionary keys are read at runtime from three anchor terms:

| Anchor term | Declares | Read via |
|---|---|---|
| `_type_shape` | data-shape keys valid in a `_data` section | `shapeKeys(dbAccess)` |
| `_type_scalar` | scalar type keys valid in `_scalar` / `_set` / … | `scalarTypes(dbAccess)` |
| `_type_key` | the subset eligible as `_dict_key` types | `keyTypes(dbAccess)` |

All three live in `metadata-store`'s `data/core/terms.type.json` and declare their list the same way — `_data._object._closed._required[*]._selection`. `lib/type-registry.js` reads them; their GIDs are the only vocabulary facts fixed in code.

**New scalar type**: add the type to `_type_scalar`'s selection (and to `_type_key` if it may be a dictionary key), write a validator in `lib/types/`, and add one row to `TYPE_VALIDATORS` in `lib/shapes/scalar.js`.

**New shape**: add the shape to `_type_shape`'s selection, write a validator in `lib/shapes/`, and add one row to `SHAPE_VALIDATORS` in `lib/validate.js`.

**New warning-class finding**: add its code to `WARNING_CODES` in `lib/errors.js`, or it will be reported as an error.

In both type and shape cases there is **no list to keep in sync** — the dispatch table records only which entries the code can handle, which is a different fact from which entries exist. A term declaring something the code cannot handle raises `UNIMPLEMENTED_SHAPE` rather than passing silently.

> Historical note: these lists were previously duplicated by hand in four places. Two copies drifted, and because an unrecognised key is read as "no key" — which both `shapes/array.js` and `shapes/scalar.js` treat as "accept anything" — the drift disabled validation silently instead of raising an error. Reading the terms removes that failure mode by construction.

When `dbAccess` is null (offline runs, the DB-less unit tests) there is no dictionary to consult, and the registry falls back to the dispatch-table keys. `keyTypes()` instead returns `null`, and the `_dict_key` check is skipped — key eligibility is a dictionary decision the code cannot infer.

Each type and shape validator is independently accessible for use in UI components that need to validate a specific field without running the full stack.
