# metadata-store-validator — maintainer notes

Dictionary-conformance validator for the metadata-store data dictionary: the **library** (`lib/`, pure, Node + Foxx), the **Node `dbAccess` adapter** (`db/`, synchronous HTTP to ArangoDB), the **CLI** (`bin/validate.js`, published as `metadata-validate`), and the **regression suite** (`test/`). `README.md` is the user-facing document (public API, options, error object, the `dbAccess` contract, how the type vocabularies are read from the dictionary); this file covers the CLI in depth, the test suite, and how the package is released and consumed.

## Provenance and layout

Authored inside `metadata-store` as three directories — `validator/` (library), `workflows/validate/` (db adapter + CLI), `test/` (suite) — and moved here as a plain copy on 2026-08-21 (history up to `metadata-store@cf4453e` stays in that repository). `metadata-store` now consumes this package: its `workflows/validate/` is a thin wrapper that installs the pinned tag and forwards to `bin/validate.js`.

```
index.js             package entry (re-exports lib/ + compute, errors, ANCHOR; makeDbAccess,
                     buildSnapshot, makeHttpQuery lazily)
lib/                 validator library — see README "Directory structure"
  md5.js             the one Node/Foxx seam: `crypto` in Node, `@arangodb/crypto` in Foxx
  edge-index.js      enumeration + rule-edge lookups over pre-loaded rows (shared by both adapters)
  snapshot.js        makeSnapshotDbAccess(snapshot) — dbAccess over a pre-fetched snapshot
  properties.js      validateProperties — a data record keyed by descriptor _gid
  envelope.js        describeEnvelopeNeeds / validateEnvelope — aggregates of large data
  report.js          createReport — errors and warnings tallied per descriptor
  units.js           unit_range lookups + checkUnitBounds
db/
  db-access.js       makeDbAccess(credentials, cacheSize) — synchronous ArangoDB accessor, LRU cache
  snapshot-builder.js buildSnapshot({ gids, query }) — async; any AQL client
  http-query.js      makeHttpQuery(credentials) — fetch-based AQL query function
  lru-cache.js       Map-backed LRU
  queries/index.js   the AQL the adapters run (pre-loads, term lookups, snapshot queries)
bin/validate.js      CLI
test/                run.js + test.*.json + fixtures/
```

Dependencies: `geojson-s2` (GitHub tag, required — `_object_GeoJSON`), `sync-request` (**optional** — only the live adapter `db/db-access.js`, `bin/` and `test/` need it; Foxx consumers and snapshot-based pipelines install with `--omit=optional`).

## Consumers and release procedure

Distributed as a **GitHub-tagged npm dependency**; no registry publish.

| Consumer | How |
|---|---|
| `metadata-store` (`workflows/validate/`) | `"metadata-store-validator": "github:skofic/metadata-store-validator#vX.Y.Z"`; thin `index.js` wrapper supplies the repo's default credentials path |
| `metadata-store-service` (Foxx, `/validate` routes) | same pin in the service's `package.json`; `npm install --omit=optional`; a Foxx `dbAccess` built on `@arangodb` |
| `metadata-external-databases` (data pipeline, ESM) | pin + `npm ci --omit=optional`; `createRequire`; a snapshot built once per run (`buildSnapshot` + arangojs), `validateProperties` at the record builders, `validateEnvelope` in the verify scripts, `createReport` printed at the end. Integration handed over in that repository's `notes/2026-09-15-dictionary-validator-handoff.md` |

Release:

1. Run the suite — `npm test` (no DB: JSON cases, snapshot tests, ESM import) and `npm run test:db` (needs a localhost `metadata` database loaded from `metadata-store`, see below; adds the snapshot-parity check) — then the heaviest check: the full-repository sweep from a `metadata-store` checkout, `node bin/validate.js --compute --credentials ../metadata-store/globals/auth/db.credentials.local.json ../metadata-store/data/ --exclude ../metadata-store/data/examples --errors-only` → every document must pass (term mode includes the unit-bound conflict check).
2. Bump `version` in `package.json`, commit, `git tag vX.Y.Z`, `git push && git push --tags`.
3. Bump the pin in each consumer; re-run its tests. If `geojson-s2` moved, bump its pin here first.

Semver intent: a new error code or a stricter check is **minor**; a change to the public API or the `dbAccess` contract is **major**; fixes are **patch**.

### Releases

- **v1.1.1** (2026-09-15) — Documentation and tests only; library code identical to v1.1.0. README gains *Using it in a data pipeline* (install, snapshot once per run, per-record checks, end-of-run report, envelope checks with an example aggregation query, offline tests). Fixed the `_scope_enum` compound test, whose value used a bare `eng` that is not a term (now `ISO_639_3.ISO_639_3_eng`): `test:db` passes with no failures.
- **v1.1.0** (2026-09-15) — **Outliers are warnings**: `RANGE_OUTLIER` (`_range_normal`) moves from `errors` to `warnings` in every entry point; only `_range_valid` and unit bounds make a value invalid (a consumer counting failed documents will see fewer). **`unit_range` enforced** on numeric values (`RANGE_VIOLATION` naming the unit), and `checkUnitBounds` / `UNIT_RANGE_CONFLICT` for descriptors whose declared range contradicts their unit (run by the CLI in term mode). **Bulk data**: `makeSnapshotDbAccess` + `buildSnapshot` + `makeHttpQuery`, `validateProperties`, `describeEnvelopeNeeds` / `validateEnvelope`, `createReport`, CLI `--summary`. `validateValue` / `validateDocument` return `warnings`; `validateFile` adds `warned` and `warnings`. Fixed: `validateDocument` / `validateFile` threw because they read `computeTermCode`'s `{ errors, warnings }` result as an array. The live adapter's edge logic moved to `lib/edge-index.js` (behaviour unchanged, shared with the snapshot).
- **v1.0.2** (2026-09-02) — CLI `--exclude <path>`.
- **v1.0.1** (2026-08-21) — `makeDbAccess` export made lazy (Foxx load path).
- **v1.0.0** (2026-08-21) — extracted from `metadata-store`.

**Keep the library pure.** Nothing under `lib/` may `require` a Node built-in except through `lib/md5.js`; nothing there may touch the network or the file system. Everything DB-shaped goes through the `dbAccess` seam so the same code runs under Foxx.

---

# The CLI — `metadata-validate` (`bin/validate.js`)

## What it does

Reads one or more JSON files (arrays of documents), optionally applies pre-validation transforms (handle resolution, computed-property fill-in), validates each document against the loaded ArangoDB dictionary, and reports errors and warnings. Stops after the first document that has at least one hard error.

---

## Architecture

```
bin/validate.js   — CLI: argument parsing, file iteration, output
db/db-access.js   — synchronous ArangoDB accessor with LRU cache
db/lru-cache.js   — LRU cache (Map-backed, configurable max size)
db/queries/       — the AQL the accessor runs
```

The validator logic lives in `lib/`. Three entry points are used:

- `validateValue(value, dataSection, dbAccess, opts)` — validates a value against an inline `_data` section; no rule-edge application.
- `validateConformance(value, dataSection, path, dbAccess, opts)` — validates with dictionary-conformance checking: each property key of an object is looked up as a term and its value validated against that term's `_data` section. Also applies rule edges (`_predicate_property-of` and `_predicate_value-of` with non-empty `_path_data`).
- `validateByDictionary(doc, descriptorGid, dbAccess, opts)` — public entry point; fetches the named descriptor from the DB then delegates to `validateConformance`.

Computed-property logic lives in `lib/compute.js` (the driver) and `lib/compute-registry.js` (the interpreter of the six compute kinds, plus the legacy per-property functions):

- `applyComputed(doc, descriptorGid, dbAccess, opts)` — runs every `_computed` entry of the descriptor's bodies; schema-driven with a dictionary, the built-in `CORE_DECLARATIONS` without one.
- `checkComputeRegistry(dbAccess)` — the start-up cross-check between the dictionary's declarations and what the code can run.
- `computeTermCode` / `computeEdgeKey` / `computeBlobKey` — the historical wrappers over the no-dictionary path.

### How the DB access works

`db/db-access.js` uses `sync-request` to make synchronous HTTP POST calls to ArangoDB's `/_api/cursor` endpoint. This is intentional: the validator library is synchronous (Foxx-compatible), so DB lookups must also be synchronous.

Three pre-load passes run at startup:

1. **Enum edges** — all `_predicate_enum-of` edges loaded into `Map<fromHandle, Set<pathHandle>>`. `isEnumMember()` is then an O(1) in-memory lookup. This is the main reason validation of large enumeration files (ISO 3166: 14K+ documents) completes in ~1 second.
2. **Property-of rules** — all `_predicate_property-of` edges with non-empty `_path_data` loaded into `Map<fromHandle+"|"+schemaHandle, ruleDataSection>`. `getPropertyRules()` fires when a property key is present in the validated object.
3. **Value-of rules** — all `_predicate_value-of` edges with non-empty `_path_data` loaded into a nested map. `getValueRules()` fires when a property holds a specific term-GID value.

Term documents are fetched on demand by `getTerm(gid)` and cached with an LRU cache (default 500 entries, configurable via `--cache-size`). Not-found terms are cached as `null` to avoid repeated lookups.

### Conformance validator (`lib/conformance.js`)

`validateConformance` is the main entry point for structured document validation. It:

1. **Pre-collects triggered rules** for any `_object`-shaped value: both presence rules (`getPropertyRules`) and value rules (`getValueRules`) are resolved before the structural check. Rules that add properties to a `_closed` schema's whitelist are merged in via `mergeRulesIntoSchema()` so those properties are not rejected as `UNKNOWN_PROPERTY` before the rule applies.
2. **Runs the structural check** via `validateData()` (from `validate.js`) against the (possibly augmented) schema.
3. **Applies triggered presence rules** independently via `validateData()` — their `_required` and `_banned` constraints are enforced on top of the base schema.
4. **Applies value-of rules** — when `_target` is present on the edge, the rule is directed at a specific sub-property of the object (target-scoped rule) rather than the whole object. Target-scoped rules replace dictionary validation for their targeted property.
5. **Recurses** into `_object`, `_array` (element type `_object`), `_dict` (value type `_object`), `_typedef`, and `_keyed` sub-shapes.

### `_fields` check (`lib/fields.js`)

A schema body may carry `_fields`, the ordered presentation list (order, `_group` panel, `_index` intent) a form builder reads. The conformance validator anchors it by name: when the object being validated carries a `_fields` key — i.e. a body is being validated against `_rule` — `checkFields(body, path)` runs beside the ordinary `_objects` validation of the list and reports `FIELD_NOT_IN_SCHEMA` / `FIELD_BANNED` (errors) and `FIELDS_INCOMPLETE` (warning). The same module exports `formFields(body)`, the single implementation of the order rule (`_fields`, then the uncovered `_required`/`_recommended` members; `fallback: true` without `_fields`) consumed by the `/ui` service's `GET /fields/:gid`. `allowedProperties(body)` is the whitelist union both `object.js` and `fields.js` use, so the closed-schema check and the `_fields` check cannot drift apart.

### LRU cache

Term documents are cached by `_gid` after first fetch. Not-found terms are cached as `null` to avoid repeated DB queries for missing dictionary entries. Default cache size is 500 entries; use `--cache-size` to adjust.

---

## How to run

The examples below assume a `metadata-store` checkout next to this one and use `node bin/validate.js`; with the package installed, `metadata-validate` is the same program. From inside `metadata-store`, `workflows/validate/index.js` forwards here and the old invocation (`node index.js … ../../data/`) keeps working.

### Install dependencies (once)

```
npm install
```

### Validate a directory (auto-detect mode from filename)

```
node bin/validate.js --credentials ../metadata-store/globals/auth/db.credentials.local.json ../metadata-store/data/core/
```

### Validate a single file

```
node bin/validate.js --credentials … ../metadata-store/data/core/terms.scalar.json
```

### Override mode explicitly

```
node bin/validate.js --mode term --credentials … ../metadata-store/data/core/terms.scalar.json
```

### Validate a custom dataset

```
node bin/validate.js --mode strict  --descriptor my_dataset --credentials … dataset.json
node bin/validate.js --mode lenient --descriptor my_dataset --credentials … dataset.json
```

### Choosing the target server

`--credentials <path>` names a credentials file. Without it, the CLI reads
`$METADATA_VALIDATOR_CREDENTIALS`, and failing that `./globals/auth/db.credentials.current.json`
relative to the **current directory** — which is where `metadata-store` keeps its JSON pointer
`{ "use": "db.credentials.<name>.json" }` naming the active server. The CLI follows the pointer one hop
(a pointer that names another pointer is rejected) and prints
`Validating against <host>/<database> (creds: <resolved path>)` at startup, so the target is always visible.

---

## Pre-validation transforms

Transforms run on each document **in-memory** before validation. Source files are never modified.

**Order matters**: handles are always resolved before computed properties are filled in, because the edge `_key` is an MD5 of the resolved handle form of `_from`, `_predicate`, and `_to`.

### `--resolve-handles`

Expands bare GID strings (no `/`) to `<termsCol>/<gid>` handles in `_from`, `_to`, and each element of `_path`. Also renames matching bare-GID keys in `_path_data` to their handle form. Source edge files use bare GIDs; the loader converts them to handles before insertion.

```
node bin/validate.js --resolve-handles --credentials … ../metadata-store/data/ISO/3166/
```

### Compute flags

The compute phase fills in or verifies `_key` and other computed properties. The behaviour when a computed property is absent is controlled by flags:

| Flag | Missing property | Mismatch |
|------|-----------------|----------|
| `--compute` (default) | fill in + warn | error |
| `--compute --strict-compute` | fill in + error | error |
| `--compute --quiet-compute` | fill in silently | error |
| `--compute --no-fill` | warn only, do not fill | error |
| `--compute --no-fill --strict-compute` | error, do not fill | error |
| `--persist` | fill in silently (implies `--compute`) | error |

**`--compute`** — fills in computed properties and emits a warning when any are absent.

```
node bin/validate.js --compute --credentials … ../metadata-store/data/core/
```

**`--strict-compute`** — promotes absent-property warnings to errors. Combine with `--compute`.

```
node bin/validate.js --compute --strict-compute --credentials … ../metadata-store/data/core/
```

**`--quiet-compute`** — fills in computed properties silently (no warning). Combine with `--compute`.

```
node bin/validate.js --compute --quiet-compute --credentials … ../metadata-store/data/core/
```

**`--no-fill`** — reports absent computed properties without filling them in. Use to check existing DB objects or pre-filled files. Combine with `--compute`.

```
node bin/validate.js --compute --no-fill --credentials … ../metadata-store/data/core/
```

**`--persist`** — prepares documents for DB insertion: fills in all computed properties silently. Implies `--compute --quiet-compute`. Mutually exclusive with `--no-fill`.

```
node bin/validate.js --persist --resolve-handles --credentials … ../metadata-store/data/core/
```

### Computed properties — the interpreter (v1.4.0)

Since v1.4.0 the dictionary declares *how* a property is computed, not only *that* it is: each `_computed` entry is an object `{ _field, _compute_kind, …parameters }`, and `lib/compute-registry.js` interprets six kinds — copy, concat, hash, union, rule, constant (the README table has their parameters and their replace / merge / fill-only behaviour). `lib/compute.js` is the driver. With a database it reads the descriptor's body and walks the document bottom-up (containers first, so `_code._gid` exists before `_term._key` copies it); a container the document lacks is created when its schema declares computed properties; entries apply in list order; an entry that cannot run is `NO_COMPUTE_FUNCTION` (unknown kind / digest / rule), `INVALID_COMPUTE` (a parameter missing or mistyped) or `DUPLICATE_VALUE` (a repeated `_compute_from` path). A value computed under `noFill` is kept in a shadow keyed by document path so later entries still see it. Without a database the driver runs `CORE_DECLARATIONS` — the six core bodies in the declared shape, built into the module — over the fixed core layout.

| Declaration | Entry |
|---|---|
| `_code._gid` | concat of `_nid`, `_lid` with `_` — absent `_nid` skipped, `""` kept, hence `_code` (see rules below) |
| `_code._aid` | union: `_lid` added to the stored list (merge: filled, not a mismatch) |
| `_term._key` | copy of `_code._gid` |
| `_edge._key`, `_link._key` | hash of `_from`, `_predicate`, `_to` joined by `/`, md5, lowercase |
| `_blob._key` | hash of `_blob_item`, `_blob_type`, `_blob_kind`, `_blob_identifier` joined by `/`, md5 |
| `_domn._term_role` | rule `_compute_rule_term-role`: the five `assign-roles` rules (derived roles recomputed; user-assigned roles and `_term_role_system` kept) — needs the optional `dbAccess` facts `isPathRoot`, `isEnumItem`, `isNamespace`, `isPredicate`, `isEnumSource` |

**Transition.** The legacy shape — a bare property gid, its rule the hand-written function in the module's `REGISTRY` table — is still accepted, and the two shapes may mix in one body, until every body in the dictionary carries object entries; then `REGISTRY` goes. `computedFields(body)` / `computedEntry(body, gid)` in `lib/fields.js` are the one reader of either shape, used by the whitelist union, the `_fields` check, `formFields`, the rule merge, the compute driver and the snapshot builder.

**The cross-check.** `checkComputeRegistry(dbAccess)` requires every declared entry to resolve, every legacy function's property to be declared, and `CORE_DECLARATIONS` to match the dictionary (same fields per core schema; identical entries once the dictionary carries objects). The CLI prints its findings at start-up. Found in v1.4.0: the Node HTTP adapter defined `listComputedDeclarations` but `makeEdgeBackedAccess` never copied it onto the accessor, so the check had returned `[]` unconditionally since v1.3.0 — `test/compute-db.test.js` now refuses to run without the method. `test/compute-db.test.js` also recomputes `_term_role` for every term of the live dictionary and requires the same answer `assign-roles` stored — the two implementations must agree.

**`_gid` computation rules:**

| `_nid` | Formula | Example |
|--------|---------|---------|
| Absent | `_lid` | `ISO` |
| `""` (empty string) | `"_" + _lid` | `_code` |
| Non-empty string | `_nid + "_" + _lid` | `ISO_3166_ITA` |

### Collection name overrides

```
node bin/validate.js --terms-col myterms --edges-col myedges --credentials … ../metadata-store/data/
```

| Flag | Default |
|------|---------|
| `--terms-col <n>` | `terms` |
| `--edges-col <n>` | `edges` |
| `--links-col <n>` | `links` |
| `--blobs-col <n>` | `blobs` |

### Skipping part of the tree

| Flag | Purpose |
|------|---------|
| `--exclude <path>` | Skip a file, or everything under a directory. Repeatable. |

The validator checks documents against the **loaded** dictionary, so a
directory that exists in the working tree but is *not* loaded will fail on its
own internal cross-references — the referenced terms are simply not in the
database. `--exclude` is how you keep the two in step:

```sh
node bin/validate.js --compute --credentials … ../metadata-store/data/ \
  --exclude ../metadata-store/data/examples --errors-only
```

Matching is on the resolved absolute path and respects path boundaries, so
excluding `data/examples` does not also exclude `data/examples-extra`.

---

## Validation modes

| Mode | Descriptor | `UNKNOWN_PROPERTY` |
|------|------------|-------------------|
| `term` | `_term` | error |
| `edge` | `_edge` | error |
| `link` | `_link` | error |
| `blob` | `_blob` | error |
| `strict` | caller-supplied GID | error |
| `lenient` | caller-supplied GID | warning |

Mode is auto-detected from the filename when `--mode` is not given:
- `terms.*.json` → `term`
- `edges.*.json` → `edge`
- `links.*.json` → `link`
- `blobs.*.json` → `blob`

Use `--strict` / `--lenient` to override the `UNKNOWN_PROPERTY` treatment independently of the mode.

---

## Output flags

| Flag | Effect |
|------|--------|
| `--quiet` | Suppress per-file headers for files that pass; show only files with problems |
| `--errors-only` | Suppress all warnings; show only errors |
| `--summary` | Do not print each warning; at the end print errors and warnings per descriptor and code with the share of values checked (`createReport`). For dataset files validated with `--mode strict|lenient`, each document's keys count as values |

---

## Fail strategy

1. Validate the **entire document** (all properties, all nesting levels) before deciding.
2. If the document has at least one **error** → report all errors (and warnings unless `--errors-only`), then exit 1.
3. If the document has only **warnings** → report them (unless `--errors-only` or `--summary`), continue to the next document. Warnings never stop a run: a value outside `_range_normal` is a `RANGE_OUTLIER` warning, not an error.
4. If the document passes → move to the next document.

This gives the full picture of what is wrong with the failing document before stopping.

In **term mode** each document is also checked with `checkUnitBounds`: a descriptor whose `_range_valid` or `_range_normal` reaches beyond its unit's physical bound (`unit_range`) fails with `UNIT_RANGE_CONFLICT`.

---

## Output format

```
FILE  /path/to/terms.scalar.json
      mode=term  descriptor=_term  docs=44

  [3] line 45 FAIL  _number_float
    ERR   _data._scalar._number_float._range_valid  doc:5  file:49
      code:     RANGE_VIOLATION
      value:    -1
      expected: >= 0
      message:  Value -1 is below the minimum of 0 (inclusive)

Stopped at first failure.
  Passed: 3  Warned: 0  Validated: 4
```

- `[3] line 45` — document index and the file line where the document's opening `{` appears.
- `doc:5  file:49` — line within the document and absolute file line where the failing property key appears.

Exit code `0` = all documents passed. Exit code `1` = at least one error or exception.

---

## Error codes reference

All error codes are defined in `lib/errors.js`:

| Code | Meaning |
|------|---------|
| `WRONG_TYPE` | Value is not the expected JS type |
| `AMBIGUOUS_SHAPE` | Multiple shape keys present, or duplicate values in a set |
| `MISSING_SHAPE` | No recognisable shape key present |
| `UNKNOWN_PROPERTY` | Closed schema: property not in whitelist |
| `MISSING_REQUIRED` | Required property is absent |
| `BANNED_PROPERTY` | Banned property is present |
| `SELECTION_VIOLATION` | `_required` selector count not satisfied |
| `RANGE_VIOLATION` | Value outside `_range_valid`, or outside its unit's physical bound (hard error) |
| `RANGE_OUTLIER` | Value outside `_range_normal` (**warning**) |
| `UNIT_RANGE_CONFLICT` | Descriptor's declared range reaches beyond its unit's physical bound (term mode) |
| `REGEXP_MISMATCH` | String does not match `_regexp` constraint |
| `CASE_MISMATCH` | String letter case violates the `_case` constraint |
| `LENGTH_VIOLATION` | String length outside the `_length` bounds |
| `INVALID_ENUM` | `_enum` value is not a member of the vocabulary |
| `INVALID_ENUM_SCOPE` | `_scope_enum` value is not a valid enum root or compound `root.node` |
| `INVALID_TARGET_SCOPE` | `_scope_target` value is not a valid `handle.property` compound string |
| `INVALID_SIBLING_SCOPE` | `_scope_sibling` value is not a valid local sibling reference (slash, empty segment, or unknown descriptor segment) |
| `INVALID_SIBLING_TYPE` | `_scope_sibling` leaf descriptor's declared type can never produce string values (dictionary keys) |
| `INVALID_TERM_KEY` | `_term_key` references an unknown or wrong-role term |
| `INVALID_HANDLE` | `_handle` is malformed or missing |
| `INVALID_KEY_TYPE` | `_dict_key` declares a type that `_type_key` does not list as key-eligible |
| `UNIMPLEMENTED_SHAPE` | The dictionary declares a shape or scalar type this validator has no implementation for |
| `MIN_ITEMS` | Array or set has fewer elements than `_min-items` |
| `MAX_ITEMS` | Array or set has more elements than `_max-items` |
| `FIELD_NOT_IN_SCHEMA` | `_fields` entry names a property the body does not admit |
| `FIELD_BANNED` | `_fields` entry names a property the body bans |
| `FIELDS_INCOMPLETE` | A `_required` / `_recommended` property is not placed by `_fields` (**warning**) |
| `TYPEDEF_NOT_FOUND` | `_typedef` value does not match any term `_gid` |
| `INVALID_TYPEDEF` | The typedef term has no usable `_data` section |
| `MISSING_FIELD` | A field required for property computation is absent |
| `COMPUTE_MISMATCH` | Existing computed value differs from the expected value |
| `COMPUTE_ADDED` | A computed property was absent or stale and was filled (warning) |
| `NO_COMPUTE_FUNCTION` | A `_computed` entry names a kind, digest or rule the interpreter does not implement (or a legacy gid with no function) |
| `INVALID_COMPUTE` | A `_computed` entry is malformed for its kind (parameter missing or mistyped) |

---

## Adding a new mode

1. Define the descriptor term in `metadata-store`'s `data/core/` and load it into the DB.
2. Add an entry to `MODE_DESCRIPTORS` in `bin/validate.js`.
3. Add a filename detection rule in `detectMode()` if applicable.

---

# The test suite (`test/`)

A self-contained Node.js test runner for the library. No external test framework is required beyond `sync-request` (used only for fixture loading).

---

## Purpose

The test suite provides regression coverage for the validator library (`lib/`). After any change to the validator, run the suite to confirm nothing is broken. Tests are plain JSON — no code is needed to add a new case.

---

## Directory Structure

```
test/
  run.js               Test runner (~290 lines, no framework)
  fixtures/            DB fixtures for rule-edge and enum tests
    terms.test.json    Term documents to insert (format: metadata-store data/*/terms.*.json)
    edges.test.json    Edge documents to insert (format: metadata-store data/*/edges.*.json)
  test.scalar.json     Scalar type tests — no DB required
  test.object.json     Object schema tests — no DB required
  test.objects.json    _objects shape, _scope_object / _scope_sibling, _keyed, _dict_key
  test.array.json      Array, set, dict, tuple tests — no DB required
  test.geojson.json    _object_GeoJSON (delegates to geojson-s2)
  test.rules.json      Rule-edge tests — DB required, uses fixtures
  test.units.json      Unit physical bounds — snapshot cases (no DB) + live-dictionary cases
  fixtures/snapshot.test.json   Hand-built dictionary snapshot (anchor + unit terms copied from metadata-store)
  snapshot.test.js     Snapshot dbAccess contract, validateProperties, envelope, report, checkUnitBounds (no DB)
  esm-import.test.mjs  The package loads from an ES module (createRequire / default import)
  snapshot-parity.js   Snapshot vs live adapter give identical results (DB; part of test:db)
```

The DB-backed cases need a localhost `metadata` database loaded by `metadata-store`'s loader (they reference real dictionary terms and the `_TEST_*` fixtures). One failure is **expected and carried**: `_scope_enum: compound root.node passes` in `test.scalar.json` (since metadata-store Session 31; the canonical leaf is `ISO_639_3_eng`, not the bare `eng`).

---

## Running the Tests

### Simple tests (no DB)

```bash
npm test                      # = node test/run.js
```

### Full suite with DB and fixtures

```bash
npm run test:db               # = node test/run.js --db ../metadata-store/globals/auth/db.credentials.local.json --fixtures
node test/run.js --db <credentials.json> --fixtures --verbose
```

### All flags

| Flag | Description |
|------|-------------|
| `--db <path>` | Path to a credentials file (e.g. `globals/auth/db.credentials.local.json`). Required for `_db: true` test cases. |
| `--fixtures` | Insert fixture documents before the run; delete them after. Requires `--db`. |
| `--no-cleanup` | Keep fixture documents in the DB after the run (for manual inspection). |
| `--filter <name>` | Only run test files whose filename contains `<name>` (e.g. `--filter scalar`). |
| `--verbose` | Show passing and skipped cases in addition to failures. |

Exit code: `0` = all tests passed; `1` = at least one failure.

---

## Test Case Format

Each test file is a flat JSON array. Every element is one test case:

```json
[
    {
        "_label": "valid float",
        "_data": { "_scalar": { "_number_float": {} } },
        "_value": 3.14,
        "_expect": "pass"
    },
    {
        "_label": "integer fails float check",
        "_data": { "_scalar": { "_number_float": {} } },
        "_value": 42,
        "_expect": "fail",
        "_codes": ["WRONG_TYPE"]
    },
    {
        "_label": "rule edge: banned property fires",
        "_descriptor": "_TEST_schema",
        "_value": { "_TEST_schema_prop_a": "x", "_TEST_schema_prop_b": "y" },
        "_expect": "fail",
        "_codes": ["BANNED_PROPERTY"],
        "_db": true,
        "_conformance": true
    }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `_label` | No | Human-readable name shown in output |
| `_data` | Yes* | `_data` section to validate `_value` against (no DB needed) |
| `_descriptor` | Yes* | GID of a dictionary term whose `_data` section to use (requires `--db`) |
| `_value` | Yes | The value under test |
| `_expect` | Yes | `"pass"` or `"fail"` |
| `_codes` | No | When `_expect: "fail"`: error codes that must all appear in the result |
| `_db` | No | `true` = skip this case when no DB credentials are provided |
| `_conformance` | No | `true` = route through `validateConformance`/`validateByDictionary`, which applies rule edges |
| `_warnings` | No | Warning codes that must all appear in `result.warnings`; `[]` = no warning at all. Warnings never decide `_expect` |
| `_snapshot` | No | `true` = run against the dbAccess built from `fixtures/snapshot.test.json` (no DB needed) |

\* Exactly one of `_data` or `_descriptor` must be present.

`_conformance: true` is required whenever the test needs rule edges (`_predicate_property-of` or `_predicate_value-of`) to be applied. Without it, only the inline `_data` schema is validated — rule edges in the DB are invisible.

---

## Validator Entry Points Used

| Condition | Entry point |
|-----------|-------------|
| `_conformance: false` (or absent) | `validateValue(value, dataSection, dbAccess, opts)` |
| `_conformance: true` + `_descriptor` | `validateByDictionary(value, descriptorGid, dbAccess, opts)` |
| `_conformance: true`, no `_descriptor` | `validateConformance(value, dataSection, [], dbAccess, opts)` |

---

## Fixture Documents

Fixtures are test-only documents inserted into the live DB before the test run and deleted immediately after (unless `--no-cleanup`). They enable tests that require real dictionary terms or rule edges without polluting production data.

### Key computation

- **Term** `_key` = `doc._code._gid` (the `_gid` field lives inside `_code` in term JSON files)
- **Edge** `_key` = `LOWER(MD5(_from + "/" + _predicate + "/" + _to))`

Keys are computed at load time by `run.js`; the JSON files do not include `_key`.

### Critical ordering constraint

The DB accessor (`db/db-access.js`) pre-loads **all** rule edges into memory at startup. If fixtures are inserted after the accessor is initialised, their edges are invisible to the conformance validator. `run.js` enforces the correct order:

```
loadFixtures()   ← inserts fixture documents into DB
initDbAccess()   ← pre-loads edge maps (now includes fixture edges)
runTests()       ← rule-edge tests see fixture edges
cleanupFixtures() ← deletes fixture documents
```

Never call `initDbAccess()` before `loadFixtures()`.

### Naming convention

All fixture GIDs must use a `_TEST_` prefix (e.g. `_TEST_schema`, `_TEST_schema_prop_a`). This prevents collisions with production terms. Fixture inserts use `?overwrite=true`, so the `_TEST_` prefix is the only collision guard.

---

## Adding Tests

### No-DB test

Add an element to an existing `test.*.json` file with `_data` and `_value`:

```json
{
    "_label": "my new test",
    "_data": { "_scalar": { "_string_Email": {} } },
    "_value": "not-an-email",
    "_expect": "fail",
    "_codes": ["WRONG_TYPE"]
}
```

### Rule-edge test

1. Add fixture terms to `fixtures/terms.test.json` using `_TEST_` GID prefixes.
2. Add fixture edges to `fixtures/edges.test.json`.
3. Add test cases to `test.rules.json` with `_db: true` and `_conformance: true`.
4. Run with `npm run test:db` (or `--db <credentials> --fixtures`).

### New test file

Create `test.myname.json` in the `test/` directory. The runner picks up all `test.*.json` files automatically.

---

## Architecture Notes

- `run.js` uses `sync-request` only for fixture loading (HTTP POST/DELETE to ArangoDB's `/_api/document`). The validator itself is fully synchronous and has no HTTP dependency.
- `sync-request` is an optional dependency of the package; `npm install` at the root is sufficient (do not use `--omit=optional` when you intend to run the DB-backed tests).
- Error de-duplication in `validateByDictionary` ensures that a rule triggered by multiple properties only reports each error once.
