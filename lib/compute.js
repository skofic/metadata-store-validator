'use strict';

/**
 * compute.js — Resolve computed properties in documents before validation.
 *
 * The rules live in the dictionary: a schema body lists its computed
 * properties in `_computed`, each entry declaring the kind of computation and
 * its parameters. lib/compute-registry.js reads the entries (resolveEntry) and
 * runs them; this module is the driver:
 *
 *   applyComputed(doc, descriptorGid, dbAccess, opts)
 *     → { errors, warnings, computed }
 *
 *   With a dbAccess the walk is SCHEMA-DRIVEN: the descriptor's body is read
 *   from the dictionary, every object-valued property whose own term has a body
 *   is visited first (bottom-up, so `_code._gid` exists before `_term._key`
 *   copies it), then the body's `_computed` entries are applied in list order.
 *   An entry that cannot run is an error at the property's path:
 *   NO_COMPUTE_FUNCTION (unknown kind / digest / rule — the drift guard),
 *   INVALID_COMPUTE (a parameter missing or of the wrong type, or an entry that
 *   is not an object — a bare gid, the shape retired in v1.5.0), DUPLICATE_VALUE
 *   (a path repeated in _compute_from).
 *
 *   Without a dbAccess the FALLBACK runs CORE_DECLARATIONS — the six core
 *   bodies in the declared shape — over the fixed core layout (_term: _code
 *   then the root; _edge / _link / _blob: the root), chosen by descriptorGid
 *   or, failing that, by document shape. The three historical functions remain
 *   as wrappers over it.
 *
 * For each absent computed property the behaviour depends on opts:
 *
 *   Default (no opts)    fill in the computed value + emit COMPUTE_ADDED warning.
 *   strictCompute        fill in the computed value + emit COMPUTE_ADDED error.
 *   quietCompute         fill in the computed value silently (no message).
 *   noFill               do not mutate; emit COMPUTE_ADDED warning (or error if strictCompute).
 *
 * For each present computed property with a different value:
 *   replace kinds (copy, concat, hash)  → COMPUTE_MISMATCH error, no mutation
 *   merge kinds (union, rule)           → the stored value is a stale derivation
 *                                         (an _aid lacking _lid, a _term_role that
 *                                         no longer matches the graph): treated
 *                                         like an absence — filled unless noFill,
 *                                         reported as COMPUTE_ADDED
 *   constant                            → nothing: a constant only fills an absence
 *
 * Every value computed — written or not — is kept in a shadow keyed by document
 * path, so under noFill `_term._key` is still reported from the `_code._gid`
 * that was computed but not written.
 *
 * `computed` lists every fill as { path, value } so a caller (the /ui service
 * answering an insert form) can show what the system supplied.
 *
 * NOTE: edge and link _key depend on _from/_to being fully-qualified handles.
 * Always resolve handles (--resolve-handles) before applyComputed.
 */

const { ErrorCode, makeError }       = require('./errors');
const { resolveEntry,
        CORE_DECLARATIONS }          = require('./compute-registry');
const { allowedProperties,
        computedFields }             = require('./fields');

const MAX_DEPTH = 8;

/** The fixed core layout the fallback path walks when no dictionary is available. */
const FALLBACK_LAYOUT = {
	_term: [ { container: ['_code'], schema: '_code' }, { container: [], schema: '_term' } ],
	_edge: [ { container: [], schema: '_edge' } ],
	_link: [ { container: [], schema: '_link' } ],
	_blob: [ { container: [], schema: '_blob' } ],
};

function emptyResult() { return { errors: [], warnings: [], computed: [] }; }

/** JSON with object keys sorted at every level — equality that ignores key order (ArangoDB stores keys sorted). */
function canonical(v) {
	if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
	if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
	return JSON.stringify(v);
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Equality for a computed value: order-insensitive for merge-type arrays. */
function sameValue(stored, computed, merge) {
	if (merge && Array.isArray(stored) && Array.isArray(computed)) {
		if (stored.length !== computed.length) return false;
		const a = stored.slice().map(x => JSON.stringify(x)).sort(), b = computed.slice().map(x => JSON.stringify(x)).sort();
		return a.every((v, i) => v === b[i]);
	}
	return JSON.stringify(stored) === JSON.stringify(computed);
}

/** Apply one resolved entry to one container property, with the fill / report rules above. */
function applyEntry(entry, container, root, path, opts, ctx, result) {
	const noFill        = opts && opts.noFill;
	const quietCompute  = opts && opts.quietCompute;
	const strictCompute = opts && opts.strictCompute;
	const prop          = entry.field;
	const present       = container[prop] !== undefined;

	if (entry.fillOnly && present) return;                // a constant never argues with a stored value

	ctx.containerPath = path.slice(0, -1);
	const value = entry.compute(container, root, ctx);
	if (value === undefined) return;                      // cannot compute here; nothing to say
	ctx.shadow[path.join('.')] = value;

	if (present && sameValue(container[prop], value, entry.merge)) return;

	if (present && !entry.merge) {
		result.errors.push(makeError(
			ErrorCode.COMPUTE_MISMATCH, path, container[prop], JSON.stringify(value),
			path.join('.') + ' ' + JSON.stringify(container[prop]) + ' does not match its computed value ' + JSON.stringify(value)
		));
		return;
	}

	if (!noFill) container[prop] = value;
	result.computed.push({ path: path.join('.'), value });
	if (quietCompute) return;
	const item = makeError(
		ErrorCode.COMPUTE_ADDED, path, present ? container[prop] : undefined, JSON.stringify(value),
		present
			? path.join('.') + ' was stale; computed value is ' + JSON.stringify(value) + (noFill ? '' : ' (updated)')
			: path.join('.') + ' is absent; computed value is ' + JSON.stringify(value)
	);
	if (strictCompute) result.errors.push(item); else result.warnings.push(item);
}

/** Apply one schema body's _computed entries, in list order, to `container`. */
function applyBody(schemaGid, body, container, root, path, opts, ctx, result) {
	const list = Array.isArray(body._computed) ? body._computed : [];
	for (const raw of list) {
		const entry = resolveEntry(schemaGid, raw);
		if (entry.problem) {
			result.errors.push(makeError(ErrorCode[entry.problem.code], [...path, entry.field], raw, entry.problem.expected, entry.problem.message));
			continue;
		}
		applyEntry(entry, container, root, [...path, entry.field], opts, ctx, result);
	}
}

/** The schema body (_open or _closed content) of a term, through one _typedef hop. */
function bodyOf(term, dbAccess) {
	if (!term || !term._data) return null;
	let data = term._data;
	if (typeof data._typedef === 'string') {
		const t = dbAccess.getTerm(data._typedef);
		if (!t || !t._data) return null;
		data = t._data;
	}
	const obj = data._object;
	if (!obj || typeof obj !== 'object') return null;
	return obj._closed || obj._open || null;
}

function declaresComputed(body) {
	return !!body && computedFields(body).length > 0;
}

/**
 * Schema-driven walk: containers first, then this body's computed properties.
 * A container the document lacks is created when its schema declares computed
 * properties (a new term without `_domn` still gets its `_term_role`), and
 * removed again if nothing could be computed into it.
 */
function walk(value, schemaGid, path, root, dbAccess, opts, ctx, result, depth) {
	if (!isPlainObject(value) || depth > MAX_DEPTH) return;
	const body = bodyOf(dbAccess.getTerm(schemaGid), dbAccess);
	if (!body) return;

	const keys = new Set(Object.keys(value));
	for (const key of allowedProperties(body)) keys.add(key);

	for (const key of keys) {
		const child = dbAccess.getTerm(key);
		const childBody = child ? bodyOf(child, dbAccess) : null;
		if (!childBody) continue;
		if (value[key] === undefined) {
			if (!declaresComputed(childBody) || (opts && opts.noFill)) continue;
			value[key] = {};
			walk(value[key], key, [...path, key], root, dbAccess, opts, ctx, result, depth + 1);
			if (Object.keys(value[key]).length === 0) delete value[key];
		} else if (isPlainObject(value[key])) {
			walk(value[key], key, [...path, key], root, dbAccess, opts, ctx, result, depth + 1);
		}
	}
	applyBody(schemaGid, body, value, root, path, opts, ctx, result);
}

/** The historical pre-checks of a term document: _code must be an object carrying a non-empty _lid. */
function termPrechecks(doc, result) {
	const code = doc._code;
	if (!code || typeof code !== 'object') {
		result.errors.push(makeError(ErrorCode.MISSING_FIELD, ['_code'], doc._code, 'object', 'Term document must have a _code section'));
		return false;
	}
	if (typeof code._lid !== 'string' || code._lid === '') {
		result.errors.push(makeError(ErrorCode.MISSING_FIELD, ['_code', '_lid'], code._lid, 'non-empty string', '_lid is required to compute _gid'));
		return false;
	}
	return true;
}

/** Which core layout a document follows when no descriptor is given: by shape. */
function detectLayout(doc) {
	if (doc && doc._code)      return '_term';
	if (doc && doc._predicate) return '_edge';
	if (doc && doc._blob_item) return '_blob';
	return null;
}

/**
 * Resolve the computed properties of `doc`.
 *
 * @param {Object}      doc            - The document (mutated in place unless opts.noFill).
 * @param {string|null} descriptorGid  - The schema term (`_term`, `_edge`, `_link`, `_blob`, a dataset
 *                                       descriptor, …). With no dbAccess only the four core layouts are
 *                                       known; null means "detect by shape".
 * @param {Object|null} dbAccess       - Dictionary accessor; null selects the fallback layout.
 * @param {Object}      [opts]         - { noFill, quietCompute, strictCompute }.
 * @returns {{ errors: Object[], warnings: Object[], computed: Object[] }}
 */
function applyComputed(doc, descriptorGid, dbAccess, opts) {
	const result = emptyResult();
	if (!doc || typeof doc !== 'object') return result;
	const ctx = { dbAccess: dbAccess || null, shadow: {}, containerPath: [] };

	if (dbAccess && typeof dbAccess.getTerm === 'function' && descriptorGid) {
		if (descriptorGid === '_term' && !termPrechecks(doc, result)) return result;
		walk(doc, descriptorGid, [], doc, dbAccess, opts, ctx, result, 0);
		return result;
	}

	const layoutKey = (descriptorGid && FALLBACK_LAYOUT[descriptorGid]) ? descriptorGid : detectLayout(doc);
	if (!layoutKey) return result;
	if (layoutKey === '_term' && !termPrechecks(doc, result)) return result;
	for (const step of FALLBACK_LAYOUT[layoutKey]) {
		let container = doc;
		for (const seg of step.container) container = container && container[seg];
		if (!isPlainObject(container)) continue;
		applyBody(step.schema, { _computed: CORE_DECLARATIONS[step.schema] }, container, doc, step.container, opts, ctx, result);
	}
	return result;
}

/**
 * Cross-check the dictionary's `_computed` declarations against what the code
 * can run. Returns an array of problem strings (empty =
 * consistent); the CLI prints them as warnings at start-up. Needs
 * dbAccess.listComputedDeclarations (the Node HTTP adapter, a snapshot built
 * since v1.4.0, and the Foxx adapter have it); otherwise returns [].
 *
 *   1. every declared entry resolves (an entry object with a known kind,
 *      digest and rule, well-typed parameters);
 *   2. the built-in CORE_DECLARATIONS match the dictionary: the same computed
 *      fields per core schema and identical entries — the fallback must not
 *      drift from the terms.
 */
function checkComputeRegistry(dbAccess) {
	if (!dbAccess || typeof dbAccess.listComputedDeclarations !== 'function') return [];
	const problems = [];
	const rows = dbAccess.listComputedDeclarations() || [];
	const bySchema = new Map();
	for (const row of rows) {
		bySchema.set(row.gid, row);
		for (const raw of row.computed || []) {
			const e = resolveEntry(row.gid, raw);
			if (e.problem) problems.push(row.gid + '.' + e.field + ': ' + e.problem.message);
		}
	}
	for (const schema of Object.keys(CORE_DECLARATIONS)) {
		const core = CORE_DECLARATIONS[schema];
		const row  = bySchema.get(schema);
		const coreFields = core.map(e => e._field).sort();
		const dictFields = row ? computedFields({ _computed: row.computed }).slice().sort() : [];
		if (JSON.stringify(coreFields) !== JSON.stringify(dictFields)) {
			problems.push(schema + ': the built-in fallback computes [' + coreFields.join(', ') + '] but the dictionary declares [' + dictFields.join(', ') + ']');
			continue;
		}
		for (const raw of row.computed) {
			if (typeof raw !== 'object' || raw === null) continue;     // already reported by resolveEntry above
			const mine = core.find(e => e._field === raw._field);
			if (canonical(mine) !== canonical(raw)) {
				problems.push(schema + '.' + raw._field + ': the built-in fallback ' + JSON.stringify(mine) + ' differs from the dictionary ' + JSON.stringify(raw));
			}
		}
	}
	return problems;
}

// ── Historical entry points, kept as wrappers over the fallback layout ───────

function computeTermCode(doc, opts) { return applyComputed(doc, '_term', null, opts); }
function computeEdgeKey(doc, opts)  { return applyComputed(doc, '_edge', null, opts); }
function computeBlobKey(doc, opts)  { return applyComputed(doc, '_blob', null, opts); }

module.exports = { applyComputed, checkComputeRegistry, computeTermCode, computeEdgeKey, computeBlobKey };
