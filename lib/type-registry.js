'use strict';

/**
 * type-registry.js — Reads the validator's type vocabularies from the dictionary.
 *
 * The dictionary is self-describing: which data shapes exist, which scalar types
 * exist, and which of those types may serve as dictionary keys are all declared
 * by terms, not by code. This module reads those declarations so that adding or
 * removing a shape or a type is a data edit with no corresponding code change.
 *
 * The ONLY thing fixed in code is which terms hold those declarations — the
 * three anchors below. Everything else is read from them.
 *
 *   _type_shape   → the data-shape keys accepted inside a _data section
 *   _type_scalar  → the scalar type keys accepted inside _scalar / _set / …
 *   _type_key     → the subset of scalar types eligible as _dict_key types
 *
 * Each anchor declares its list the same way, as a closed object schema whose
 * _required selector enumerates the permitted keys:
 *
 *   _data._object._closed._required[*]._selection
 *
 * ── Fallback when there is no DB ──────────────────────────────────────────────
 * dbAccess may be null (offline runs, the DB-less unit tests). There is then no
 * dictionary to read, so we fall back to what the validator can actually
 * validate — the keys of the dispatch tables in validate.js and shapes/scalar.js.
 * That set has to exist regardless (every shape needs an implementation), so it
 * is not a second copy of the vocabulary; it is a different fact about the code.
 *
 * The fallbacks are pulled in by lazy require() inside the functions rather than
 * at module load. That keeps this module a leaf with no load-time dependencies,
 * which is what allows types/other.js to use it — that file cannot require
 * validate.js at load time without a circular dependency.
 *
 * ── Caching ───────────────────────────────────────────────────────────────────
 * Resolution is memoised per dbAccess instance, because these lookups happen
 * once per validated value (and therefore once per array element). The cache
 * lives for the lifetime of the dbAccess object; a long-running host that edits
 * a _type_* term must build a fresh dbAccess to pick the change up. This matches
 * the existing behaviour of dbAccess.getTerm(), which is itself LRU-cached.
 */

// The one external rule: which terms represent the type building blocks.
const ANCHOR = {
	shape:  '_type_shape',
	scalar: '_type_scalar',
	key:    '_type_key',
};

const cache     = new WeakMap(); // dbAccess object → resolved lists
let   nullCache = null;          // resolved lists for the dbAccess === null case

/**
 * Collect every string in a (possibly nested) _selection value.
 * _selection is flat on all three anchors today; the pipeline form nests one
 * level deeper, so this flattens recursively rather than assuming depth.
 *
 * @param {*}        sel - A _selection value: string, or array of these.
 * @param {string[]} out - Accumulator.
 */
function flattenSelection(sel, out) {
	if (typeof sel === 'string') {
		out.push(sel);
	} else if (Array.isArray(sel)) {
		for (const item of sel) flattenSelection(item, out);
	}
}

/**
 * Read one anchor term's declared key list from the dictionary.
 *
 * @param {Object} dbAccess - DB accessor exposing getTerm(gid). May be null.
 * @param {string} gid      - The anchor term's _gid.
 * @returns {string[]|null} The declared keys in declaration order, or null when
 *                          the term is unreadable, absent, or declares nothing.
 */
function readAnchor(dbAccess, gid) {
	if (!dbAccess || typeof dbAccess.getTerm !== 'function') return null;

	let term;
	try {
		term = dbAccess.getTerm(gid);
	} catch (e) {
		return null; // DB unreachable — fall back rather than abort validation
	}
	if (!term || !term._data || typeof term._data !== 'object') return null;

	const object = term._data._object;
	if (!object || typeof object !== 'object') return null;

	const rule = object._closed || object._open;
	if (!rule || !Array.isArray(rule._required)) return null;

	const keys = [];
	for (const entry of rule._required) {
		if (entry && typeof entry === 'object') flattenSelection(entry._selection, keys);
	}

	// Never return an empty list: at every call site an empty vocabulary reads as
	// "no key recognised", which in turn reads as "accept anything". A malformed
	// or half-loaded anchor term must degrade to the implemented set, not to
	// silently disabling validation.
	return keys.length > 0 ? keys : null;
}

/** The shape keys this validator has an implementation for. */
function implementedShapes() {
	return Object.keys(require('./validate').SHAPE_VALIDATORS);
}

/** The scalar type keys this validator has an implementation for. */
function implementedScalarTypes() {
	return Object.keys(require('./shapes/scalar').TYPE_VALIDATORS);
}

/**
 * Resolve (and memoise) all three vocabularies for a given dbAccess.
 *
 * @param {Object} dbAccess - DB accessor. May be null.
 * @returns {{ shape: string[], scalar: Set<string>, key: Set<string>|null }}
 */
function resolve(dbAccess) {
	const cached = dbAccess ? cache.get(dbAccess) : nullCache;
	if (cached) return cached;

	const shape  = readAnchor(dbAccess, ANCHOR.shape)  || implementedShapes();
	const scalar = readAnchor(dbAccess, ANCHOR.scalar) || implementedScalarTypes();

	// _type_key has no code-side counterpart: "which types may be dictionary
	// keys" is a dictionary decision with no bearing on what the validator can
	// parse. Without the dictionary we do not know it, so we say so with null
	// and the caller skips the check rather than guessing.
	const keyList = readAnchor(dbAccess, ANCHOR.key);

	const lists = {
		shape,
		scalar: new Set(scalar),
		key:    keyList ? new Set(keyList) : null,
	};

	if (dbAccess) cache.set(dbAccess, lists);
	else          nullCache = lists;

	return lists;
}

/**
 * The data-shape keys accepted inside a _data section, in declaration order.
 * Order is significant where a caller takes the first match.
 *
 * @param {Object} dbAccess - DB accessor. May be null.
 * @returns {string[]}
 */
function shapeKeys(dbAccess) {
	return resolve(dbAccess).shape;
}

/**
 * The scalar type keys accepted inside a _scalar (or set / nested element) body.
 *
 * @param {Object} dbAccess - DB accessor. May be null.
 * @returns {Set<string>}
 */
function scalarTypes(dbAccess) {
	return resolve(dbAccess).scalar;
}

/**
 * The scalar types eligible as _dict_key types.
 *
 * @param {Object} dbAccess - DB accessor. May be null.
 * @returns {Set<string>|null} null when undeterminable (no DB) — do not narrow.
 */
function keyTypes(dbAccess) {
	return resolve(dbAccess).key;
}

module.exports = { ANCHOR, shapeKeys, scalarTypes, keyTypes };
