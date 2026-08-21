# metadata-store-validator

JavaScript validation library for the [metadata-store](https://github.com/skofic/metadata-store) data dictionary, plus a Node `dbAccess` adapter and a CLI.

Validates values and documents against `_data` section schemas defined in the dictionary. The library runs synchronously in `'use strict'` mode, has no Node built-ins on its hot path, and runs unchanged in Node and in ArangoDB Foxx services. The dictionary's own vocabularies (`_type_shape`, `_type_scalar`, `_type_key`) are read from the database at runtime — the only things fixed in code are those three anchor GIDs.

Authored inside `metadata-store` (as `validator/`, `workflows/validate/` and `test/`) and moved here on 2026-08-21; history up to `metadata-store@cf4453e` lives in that repository.

---

## Directory structure

```
index.js            — package entry: re-exports lib/ + compute, errors, ANCHOR, makeDbAccess (lazy)
lib/                — the validator library (pure; Node + Foxx)
  index.js          — public API (five entry points)
  validate.js       — shape dispatcher (validateData)
  conformance.js    — dictionary-driven validator (validateByDictionary, validateConformance)
  compute.js        — resolve computed properties (_key, _gid, _aid) for terms, edges, and blobs
  md5.js            — MD5 shim: Node `crypto`, or `@arangodb/crypto` under Foxx
  coerce.js         — type coercion before strict validation
  errors.js         — error codes and makeError() builder
  ranges.js         — shared numeric and string range checks
  type-registry.js  — reads the type vocabularies from the three anchor terms
  types/
    number.js       — _number, _number_float, _number_integer
    boolean.js      — _boolean
    string.js       — _string and all _string_* variants
    text.js         — _text, _text_HTML, _text_Markdown, _text_SVG
    other.js        — _handle, _timestamp
    enum.js         — _enum (requires dbAccess)
    term-key.js     — _term_key and _term_key_* variants (requires dbAccess)
  shapes/
    scalar.js       — _scalar dispatcher + coercion
    object.js       — _object (open/closed schemas, selectors)
    geojson.js      — _object_GeoJSON (top-level shape; RFC 7946 geometry, _type_GeoJSON narrowing)
    objects.js      — _objects (positional slot schemas + _unique / _ordered invariants)
    array.js        — _array
    set.js          — _set (unique elements)
    dict.js         — _dict
    keyed-by.js     — _keyed (sibling-derived runtime keys)
    tuple.js        — _tuple
    nested.js       — _nested (recursive arrays)
    typedef.js      — _typedef (DB lookup + recursive validation)
db/                 — Node dbAccess adapter: synchronous HTTP to ArangoDB (needs `sync-request`)
  db-access.js      — makeDbAccess(credentials, cacheSize): pre-loads enum/rule edges, LRU term cache
  lru-cache.js, queries/index.js
bin/validate.js     — the `metadata-validate` CLI (validate JSON files against the loaded dictionary)
test/               — regression suite: run.js + test.*.json cases + fixtures/ (see MILKO.md)
```

---

## Installation

Distributed as a **GitHub-tagged npm dependency** (no registry publish). Pin a tag:

```json
{ "dependencies": { "metadata-store-validator": "github:skofic/metadata-store-validator#v1.0.0" } }
```

```js
const { validateValue, validateDocument, validateFile,
        validateByDictionary, validateConformance } = require('metadata-store-validator');
```

It depends on [`geojson-s2`](https://github.com/skofic/geojson-s2) (pinned the same way) for `_object_GeoJSON` values, and **optionally** on `sync-request`, which only `db/` and `bin/` use.

**In a Foxx service** — add the dependency to the service's `package.json`, run `npm install --omit=optional` in the service directory (no `sync-request`; Foxx needs neither HTTP client nor CLI), and ship `node_modules/` with the bundle. Implement `dbAccess` with `@arangodb` queries — see the example below. `metadata-store-service` does exactly this for its `/validate` routes.

**CLI** — after `npm install` the `metadata-validate` bin is available (`npx metadata-validate …`, or `node bin/validate.js …` from a checkout):

```sh
metadata-validate --compute --credentials path/to/db.credentials.json path/to/data/ --errors-only
```

Run without arguments for the full option list; `MILKO.md` documents the flags, modes, pre-validation transforms and output format.

---

## Public API

### `validateByDictionary(doc, descriptorGid, dbAccess, opts)`

Validates a document against the dictionary using a named descriptor term. For each property key in the document, looks up the key as a dictionary term via `dbAccess.getTerm()` and validates the property value against that term's `_data` section. Recurses into nested `_object` values, `_array` elements whose element type is `_object`, and `_dict` values whose value type is `_object`.

Returns `{ errors, warnings, coercions }`. Unknown property keys produce a hard error in strict mode (default) or a warning in lenient mode.

```js
const { validateByDictionary } = require('metadata-store-validator');

const result = validateByDictionary(
  doc,
  '_term',      // descriptor _gid
  dbAccess,
  { strict: true }  // false → UNKNOWN_PROPERTY becomes a warning
);

// result.errors    — hard errors (empty = valid)
// result.warnings  — soft warnings (unknown properties in lenient mode)
// result.coercions — coercion records
```

**Validation modes** (by descriptor GID):

| Descriptor | Typical use |
|---|---|
| `_term`  | Term documents in `terms.*` files |
| `_edge`  | Edge documents in `edges.*` files |
| `_link`  | Link documents in `links.*` files |
| `_blob`  | Blob documents in `blobs.*` files |
| any GID  | Dataset documents (use `strict: false` for mixed data) |

---

### `validateConformance(value, dataSection, dbAccess, opts)`

Lower-level entry point used by `validateByDictionary`. Runs the structural shape validator (`validateData`) then adds the dictionary-lookup pass for `_object` shapes. Can be called directly when you already have the `_data` section in hand.

Returns `{ errors, warnings, coercions }`.

---

### `validateValue(value, dataSection, dbAccess, opts)`

Validates a single value against a `_data` section. Used for real-time UI field validation.

```js
const { validateValue } = require('metadata-store-validator');

const result = validateValue(
  3.14,
  { _scalar: { _number_float: { _range_valid: { '_min-inclusive': 0 } } } },
  null,   // no DB checks needed for this type
  {}
);

// result.errors   — array of error objects (empty = valid)
// result.coercions — array of coercion records (empty when coerce: false)
```

---

### `validateDocument(doc, descriptor, dbAccess, opts)`

Resolves computed properties then validates a single document against a descriptor's `_data` section. Mutates `doc` in place to add computed fields.

```js
const doc = { _code: { _nid: 'ISO_3166', _lid: 'ITA' } };

const result = validateDocument(
  doc,
  descriptorTerm,   // term document with a _data section
  dbAccess,
  { coerce: true }
);

console.log(doc._code._gid);  // → "ISO_3166_ITA"
console.log(doc._key);        // → "ISO_3166_ITA"
```

---

### `validateFile(docs, getDescriptor, dbAccess, opts)`

Batch validates an array of documents (e.g. a loaded JSON file). Stops collecting failures after `opts.maxErrors` documents have failed.

```js
const report = validateFile(
  docs,
  function(doc) { return lookupDescriptor(doc._code._gid); },
  dbAccess,
  { maxErrors: 10, coerce: false }
);

// report.passed    — number of documents that passed
// report.failed    — number of documents that failed
// report.truncated — true if stopped early due to maxErrors
// report.errors    — [{ index, doc, errors }]
// report.coercions — [{ index, path, from, to, rule }]
```

Set `opts.maxErrors` to `0` for unlimited error collection.

---

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `coerce` | boolean | `false` | Attempt type coercion before strict validation. Coerced values are reported in `result.coercions`. |
| `strict` | boolean | `true` | (`validateByDictionary` / `validateConformance` only) When `false`, unknown property keys produce warnings instead of errors. |
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

Every error object has the same shape:

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
| `UNKNOWN_PROPERTY` | Closed schema: property not in the whitelist |
| `MISSING_REQUIRED` | Required property is absent |
| `BANNED_PROPERTY` | Banned property is present |
| `SELECTION_VIOLATION` | `_required` selector count constraint not satisfied |
| `RANGE_VIOLATION` | Value outside `_range_valid` (hard error) |
| `RANGE_OUTLIER` | Value outside `_range_normal` (warning — outside expected range) |
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
| `TYPEDEF_NOT_FOUND` | `_typedef` value does not match any term `_gid` |
| `INVALID_TYPEDEF` | The typedef term has no usable `_data` section |
| `MISSING_FIELD` | A field required for property computation is absent |
| `COMPUTE_MISMATCH` | A computed property is present but its value disagrees with the computed result |
| `COMPUTE_ADDED` | A computed property was absent; the computed value was added (or should be added) |

---

## The `dbAccess` object

Some validations require querying the ArangoDB database: `_enum` (vocabulary membership), `_term_key*` (term existence and role), `_typedef` (typedef resolution), the type vocabularies themselves, and — in conformance mode — the rule edges. Pass `null` to skip the DB-backed checks (the type vocabularies then fall back to the dispatch tables).

`db/db-access.js` is the reference implementation (synchronous HTTP; used by the CLI and the tests). When providing your own, implement these synchronous methods:

```js
const dbAccess = {

  // Returns true if the term with _gid `value` is reachable via
  // _predicate_enum-of from at least one of the `roots` (_gid array).
  isEnumMember(value, roots) { /* ... */ return true; },

  // Returns true if a term with this _gid exists in the dictionary.
  termExists(gid) { /* ... */ return true; },

  // Returns true if the term has `role` in its _domn._term_role array.
  termHasRole(gid, role) { /* ... */ return true; },

  // Returns the full term document (must include _data) or null.
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

In both cases there is **no list to keep in sync** — the dispatch table records only which entries the code can handle, which is a different fact from which entries exist. A term declaring something the code cannot handle raises `UNIMPLEMENTED_SHAPE` rather than passing silently.

> Historical note: these lists were previously duplicated by hand in four places. Two copies drifted, and because an unrecognised key is read as "no key" — which both `shapes/array.js` and `shapes/scalar.js` treat as "accept anything" — the drift disabled validation silently instead of raising an error. Reading the terms removes that failure mode by construction.

When `dbAccess` is null (offline runs, the DB-less unit tests) there is no dictionary to consult, and the registry falls back to the dispatch-table keys. `keyTypes()` instead returns `null`, and the `_dict_key` check is skipped — key eligibility is a dictionary decision the code cannot infer.

Each type and shape validator is independently accessible for use in UI components that need to validate a specific field without running the full stack.
