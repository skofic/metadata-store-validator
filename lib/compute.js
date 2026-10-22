'use strict';

/**
 * compute.js — Resolve computed properties in documents before validation.
 *
 * The rules live in lib/compute-registry.js, keyed by the schema term whose body
 * declares the property (`_computed`) and by the property. This module is the
 * driver:
 *
 *   applyComputed(doc, descriptorGid, dbAccess, opts)
 *     → { errors, warnings, computed }
 *
 *   With a dbAccess the walk is SCHEMA-DRIVEN: the descriptor's body is read
 *   from the dictionary, every object-valued property whose own term has a body
 *   is visited first (bottom-up, so `_code._gid` exists before `_term._key`
 *   asks for it), then the body's `_computed` list is applied through the
 *   registry. A declared computed property with no registry entry is
 *   NO_COMPUTE_FUNCTION — the drift guard: the dictionary is the authority.
 *
 *   Without a dbAccess the FALLBACK is the fixed core layout over the same
 *   registry entries (_term: _code._gid, _code._aid, _key; _edge / _link: _key;
 *   _blob: _key), chosen by descriptorGid or, failing that, by document shape —
 *   the behaviour of the three historical functions, which remain as wrappers.
 *
 * For each absent computed property the behaviour depends on opts:
 *
 *   Default (no opts)    fill in the computed value + emit COMPUTE_ADDED warning.
 *   strictCompute        fill in the computed value + emit COMPUTE_ADDED error.
 *   quietCompute         fill in the computed value silently (no message).
 *   noFill               do not mutate; emit COMPUTE_ADDED warning (or error if strictCompute).
 *
 * For each present computed property with a wrong value:
 *   merge: false  → COMPUTE_MISMATCH error, no mutation (a _key that disagrees
 *                   with its _gid is a fault, not something to repair silently).
 *   merge: true   → the stored value is a stale derivation (an _aid lacking
 *                   _lid, a _term_role that no longer matches the graph):
 *                   treated like an absence — filled unless noFill, reported as
 *                   COMPUTE_ADDED.
 *
 * `computed` lists every fill as { path, value } so a caller (the /ui service
 * answering an insert form) can show what the system supplied.
 *
 * NOTE: edge and link _key depend on _from/_to being fully-qualified handles.
 * Always resolve handles (--resolve-handles) before applyComputed.
 */

const { ErrorCode, makeError } = require('./errors');
const { lookup, declarations, REGISTRY } = require('./compute-registry');
const { allowedProperties }    = require('./fields');

const MAX_DEPTH = 8;

/** The fixed core layout the fallback path walks when no dictionary is available. */
const FALLBACK_LAYOUT = {
	_term: [ { container: ['_code'], schema: '_code' }, { container: [], schema: '_term' } ],
	_edge: [ { container: [], schema: '_edge' } ],
	_link: [ { container: [], schema: '_link' } ],
	_blob: [ { container: [], schema: '_blob' } ],
};

function emptyResult() { return { errors: [], warnings: [], computed: [] }; }

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Equality for a computed value: order-insensitive for merge-type arrays. */
function sameValue(stored, computed, merge) {
	if (merge && Array.isArray(stored) && Array.isArray(computed)) {
		if (stored.length !== computed.length) return false;
		const a = stored.slice().sort(), b = computed.slice().sort();
		return a.every((v, i) => v === b[i]);
	}
	return JSON.stringify(stored) === JSON.stringify(computed);
}

/** Order a body's _computed list so that every `after` dependency comes first. */
function orderByAfter(schemaGid, props) {
	const out = []; const pending = props.slice();
	let guard = props.length + 1;
	while (pending.length > 0 && guard-- > 0) {
		for (let i = 0; i < pending.length; i++) {
			const entry = lookup(schemaGid, pending[i]);
			const after = (entry && entry.after) || [];
			if (after.every(a => out.includes(a) || !props.includes(a))) { out.push(pending[i]); pending.splice(i, 1); i--; }
		}
	}
	return out.concat(pending);   // a cycle (never in practice) falls through in declaration order
}

/** Apply one registry entry to one container property, with the fill / report rules above. */
function applyEntry(entry, container, root, prop, path, opts, ctx, result) {
	const noFill        = opts && opts.noFill;
	const quietCompute  = opts && opts.quietCompute;
	const strictCompute = opts && opts.strictCompute;

	const value = entry.compute(container, root, ctx);
	if (value === undefined) return;                      // cannot compute here; nothing to say

	const present = container[prop] !== undefined;
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

/** Apply one schema body's _computed list to `container`. */
function applyBody(schemaGid, body, container, root, path, opts, ctx, result) {
	const props = Array.isArray(body._computed) ? body._computed.filter(p => typeof p === 'string') : [];
	for (const prop of orderByAfter(schemaGid, props)) {
		const entry = lookup(schemaGid, prop);
		if (!entry) {
			result.errors.push(makeError(
				ErrorCode.NO_COMPUTE_FUNCTION, [...path, prop], undefined, 'a registered compute function',
				'"' + schemaGid + '" declares "' + prop + '" as computed but the compute registry has no function for it'
			));
			continue;
		}
		applyEntry(entry, container, root, prop, [...path, prop], opts, ctx, result);
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
	return !!body && Array.isArray(body._computed) && body._computed.length > 0;
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
	const ctx = { dbAccess: dbAccess || null };

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
		const body = { _computed: Object.keys(REGISTRY[step.schema]) };
		applyBody(step.schema, body, container, doc, step.container, opts, ctx, result);
	}
	return result;
}

/**
 * Cross-check the dictionary's `_computed` declarations against the registry,
 * both ways. Returns an array of problem strings (empty = consistent); the CLI
 * prints them as warnings at start-up. Needs dbAccess.listComputedDeclarations
 * (the Node HTTP adapter and the Foxx adapter have it); otherwise returns [].
 */
function checkComputeRegistry(dbAccess) {
	if (!dbAccess || typeof dbAccess.listComputedDeclarations !== 'function') return [];
	const declared = new Set();
	const problems = [];
	for (const row of dbAccess.listComputedDeclarations() || []) {
		for (const prop of row.computed || []) {
			declared.add(row.gid + '.' + prop);
			if (!lookup(row.gid, prop)) problems.push(row.gid + '.' + prop + ' is declared _computed but the registry has no function for it');
		}
	}
	for (const d of declarations()) {
		if (!declared.has(d.schema + '.' + d.property)) problems.push(d.schema + '.' + d.property + ' has a compute function but no schema body declares it _computed');
	}
	return problems;
}

// ── Historical entry points, kept as wrappers over the fallback layout ───────

function computeTermCode(doc, opts) { return applyComputed(doc, '_term', null, opts); }
function computeEdgeKey(doc, opts)  { return applyComputed(doc, '_edge', null, opts); }
function computeBlobKey(doc, opts)  { return applyComputed(doc, '_blob', null, opts); }

module.exports = { applyComputed, checkComputeRegistry, computeTermCode, computeEdgeKey, computeBlobKey };
