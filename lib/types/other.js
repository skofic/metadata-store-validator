'use strict';

/**
 * types/other.js — Validators for _handle, _timestamp, _scope_enum, _scope_target, _scope_object.
 *
 * _handle      : ArangoDB document handle — <collection>/<key>
 * _timestamp   : Unix timestamp — integer (seconds since 1970-01-01 UTC)
 *                Accepts _range_valid and _range_normal companions.
 * _scope_enum  : Enumeration scope string — either a plain enum root _gid, or a
 *                compound "root.node" string (split at the first dot). The root
 *                must be an enum root; the node must be either an element of the
 *                root's enumeration (linked via _predicate_enum-of) or a branch
 *                within it (linked via _predicate_section-of OR _predicate_bridge-of).
 *                Sections and bridges are valid scope branches even though they
 *                are not selectable enum members themselves.
 * _scope_target: Target scope string — compound "<handle>.<property>" (split at the
 *                last dot). The handle part must be a valid ArangoDB handle.
 * _scope_object: Object property reference string — top-level property name
 *                ("_min-inclusive") or dotted path into a nested property
 *                ("_range._min-inclusive"). Each segment must be non-empty and
 *                contain no dots. Pure structural check; no DB lookup. Used by
 *                the _objects shape's _unique and _ordered cross-element
 *                invariants to address an element-property by name.
 * _scope_sibling: Local descriptor-sibling reference — bare descriptor name
 *                ("_from") or dotted path ("_range._min-inclusive"). Forbids
 *                forward slashes (cross-handle references belong to
 *                _scope_target). Used as the schema-side key type of _keyed,
 *                where each key names a sibling property whose value at
 *                runtime supplies the dict's allowed keys. Static checks:
 *                syntactic validation + (when dbAccess is available) each
 *                segment must be an existing descriptor.
 */

const { ErrorCode, makeError } = require('../errors');
const { checkNumericRange } = require('../ranges');

// ArangoDB handle: collection name followed by / followed by document key.
// Collection names start with a letter or underscore; keys use the allowed character set.
const HANDLE_RE = /^[A-Za-z_][A-Za-z0-9_]*\/[A-Za-z0-9_\-.@()+,=;$!*'%]+$/;

// Recognised data-shape keys come from the _type_shape term, read through
// type-registry.js. That module is a leaf with no load-time requires, so it can
// be imported here without the circular dependency that pulling in validate.js
// would create.
const { shapeKeys } = require('../type-registry');

// Top-level term-document sections. When an _scope_object path's first segment
// is one of these, the path is resolved from the term ROOT (opts.rootObject)
// rather than from the immediate container — used by term-root-relative
// references such as _qualifier ("_domn.ISO_3166_2_type"). Existing
// sibling-relative uses (_location, _unique, _ordered._property) never begin
// with a section name, so their container-relative resolution is unchanged.
const TERM_SECTIONS = new Set(['_code', '_info', '_data', '_domn', '_prop']);

/**
 * Validate a value against the _handle scalar type.
 *
 * @param {*}        value  - The value to validate.
 * @param {Object}   schema - Companion properties (expected to be empty {}).
 * @param {string[]} path   - Current dot-path for error location.
 * @returns {Object[]} Array of error objects (empty = valid).
 */
function validateHandle(value, schema, path) {
	if (typeof value !== 'string' || !HANDLE_RE.test(value)) {
		return [makeError(
			ErrorCode.INVALID_HANDLE, path, value,
			'ArangoDB handle of the form <collection>/<key>',
			`"${value}" is not a valid ArangoDB document handle`
		)];
	}
	return [];
}

/**
 * Validate a value against the _timestamp scalar type.
 *
 * @param {*}        value  - The value to validate.
 * @param {Object}   schema - Companion properties (_range_valid, _range_normal).
 * @param {string[]} path   - Current dot-path for error location.
 * @returns {Object[]} Array of error objects (empty = valid).
 */
function validateTimestamp(value, schema, path) {
	const errors = [];

	if (!Number.isInteger(value)) {
		errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'integer (Unix timestamp in seconds)',
			`Expected an integer Unix timestamp, got ${typeof value}`
		));
		return errors;
	}

	if (schema._range_valid) {
		errors.push(...checkNumericRange(
			value, schema._range_valid,
			[...path, '_range_valid'], ErrorCode.RANGE_VIOLATION
		));
	}
	if (schema._range_normal) {
		errors.push(...checkNumericRange(
			value, schema._range_normal,
			[...path, '_range_normal'], ErrorCode.RANGE_OUTLIER
		));
	}

	return errors;
}

/**
 * Validate a value against the _scope_enum scalar type.
 *
 * Two forms are accepted:
 *   Plain root:     a _gid that is the root of at least one enumeration.
 *   Compound scope: "root.node" — root must be an enum root; node must be
 *                   either an element of that root's enumeration (linked via
 *                   _predicate_enum-of) OR a branch within it (linked via
 *                   _predicate_section-of or _predicate_bridge-of).
 *                   Split at the FIRST dot.
 *
 * @param {*}        value    - The value to validate.
 * @param {Object}   schema   - Companion properties (expected to be empty {}).
 * @param {string[]} path     - Current dot-path for error location.
 * @param {Object}   dbAccess - DB accessor (may be null — skips DB checks).
 * @returns {Object[]} Array of error objects (empty = valid).
 */
function validateEnumScope(value, schema, path, dbAccess) {
	if (typeof value !== 'string' || value === '') {
		return [makeError(
			ErrorCode.WRONG_TYPE, path, value, 'non-empty string (enum scope)',
			`Expected a non-empty string for _scope_enum, got ${typeof value}`
		)];
	}

	if (!dbAccess) return [];

	const dot = value.indexOf('.');
	if (dot === -1) {
		// Plain root form
		if (!dbAccess.isEnumRoot(value)) {
			return [makeError(
				ErrorCode.INVALID_ENUM_SCOPE, path, value,
				'_gid of an enumeration root',
				`"${value}" is not the root of any enumeration`
			)];
		}
	} else {
		// Compound scope: split at first dot
		const root = value.slice(0, dot);
		const node = value.slice(dot + 1);
		if (!dbAccess.isEnumRoot(root)) {
			return [makeError(
				ErrorCode.INVALID_ENUM_SCOPE, path, value,
				'compound scope where the part before the first dot is an enumeration root',
				`"${root}" (from compound scope "${value}") is not the root of any enumeration`
			)];
		}
		// Accept either an enum element or a branch (section / bridge) as the node.
		const isMember = dbAccess.isEnumMember(node, [root]);
		const isBranch = !isMember && typeof dbAccess.isEnumBranch === 'function'
			&& dbAccess.isEnumBranch(node, root);
		if (!isMember && !isBranch) {
			return [makeError(
				ErrorCode.INVALID_ENUM_SCOPE, path, value,
				`compound scope where the part after the first dot is an element or a branch (section / bridge) of the "${root}" enumeration`,
				`"${node}" (from compound scope "${value}") is neither an element nor a branch of the "${root}" enumeration`
			)];
		}
	}

	return [];
}

/**
 * Validate a value against the _scope_target scalar type.
 *
 * The value must be a dot-separated compound string "<handle>.<property>",
 * where the part before the LAST dot is a valid ArangoDB handle and the
 * part after the last dot is a non-empty property name.
 *
 * @param {*}        value  - The value to validate.
 * @param {Object}   schema - Companion properties (expected to be empty {}).
 * @param {string[]} path   - Current dot-path for error location.
 * @returns {Object[]} Array of error objects (empty = valid).
 */
function validateTargetScope(value, schema, path) {
	if (typeof value !== 'string' || value === '') {
		return [makeError(
			ErrorCode.WRONG_TYPE, path, value, 'non-empty string (target scope)',
			`Expected a non-empty string for _scope_target, got ${typeof value}`
		)];
	}

	const lastDot = value.lastIndexOf('.');
	if (lastDot === -1) {
		return [makeError(
			ErrorCode.INVALID_TARGET_SCOPE, path, value,
			'dot-separated string of the form <handle>.<property>',
			`"${value}" is not a valid target scope — no dot separator found`
		)];
	}

	const handle = value.slice(0, lastDot);
	const prop   = value.slice(lastDot + 1);

	if (!HANDLE_RE.test(handle)) {
		return [makeError(
			ErrorCode.INVALID_TARGET_SCOPE, path, value,
			'target scope where the part before the last dot is an ArangoDB handle (<collection>/<key>)',
			`"${handle}" (from target scope "${value}") is not a valid ArangoDB document handle`
		)];
	}

	if (prop === '') {
		return [makeError(
			ErrorCode.INVALID_TARGET_SCOPE, path, value,
			'target scope with a non-empty property name after the last dot',
			`"${value}" has an empty property name after the last dot`
		)];
	}

	return [];
}

/**
 * Validate a value against the _scope_object scalar type.
 *
 * Three checks run in order:
 *
 *   1. String syntax — the value must be a non-empty string of one or more
 *      dot-separated segments, each segment being non-empty. Always runs.
 *
 *   2. Body shape — when the body (schema) is non-empty AND dbAccess is
 *      available, the body is validated as a _type_shape value: it must
 *      contain at most one of the recognised shape keys and no unknown
 *      properties. This is a STATIC structural check — it does not require
 *      a container and fires both during descriptor validation and during
 *      data-instance validation. Catches malformed bodies like
 *      `_scope_object: {_garbage_shape: {}}` at descriptor-definition time
 *      rather than silently accepting them.
 *
 *   3. Body-against-target — when the body is non-empty AND a container is
 *      provided, the target property is fetched via readObjectScope (walking
 *      the dotted path from the container root) and its stored value is
 *      validated against the body. When the target is absent (skip-absent
 *      rule), no error is raised — this permits rule-edge schema dynamism
 *      where banned/absent properties don't count against the constraint.
 *      When no container is available, this check silently skips while the
 *      body-shape check above still fires.
 *
 * @param {*}        value     - The value to validate (property reference string).
 * @param {Object}   schema    - Body: a _type_shape value (may be empty {}).
 * @param {string[]} path      - Current dot-path for error location.
 * @param {Object}   container - Object holding the target property (may be null).
 * @param {Object}   dbAccess  - DB accessor for recursive validation (may be null).
 * @param {Object}   opts      - Options for recursive validation.
 * @returns {Object[]} Array of error objects (empty = valid).
 */
function validateObjectScope(value, schema, path, container, dbAccess, opts) {
	// Check 1: string syntax
	if (typeof value !== 'string' || value === '') {
		return [makeError(
			ErrorCode.WRONG_TYPE, path, value, 'non-empty string (object scope)',
			`Expected a non-empty string for _scope_object, got ${typeof value}`
		)];
	}

	const segments = value.split('.');
	for (let i = 0; i < segments.length; i++) {
		if (segments[i] === '') {
			return [makeError(
				ErrorCode.INVALID_OBJECT_SCOPE, path, value,
				'object scope with non-empty dot-separated segments (e.g. "_min-inclusive" or "_range._min-inclusive")',
				`"${value}" has an empty segment at position ${i} — leading, trailing, or consecutive dots are not allowed`
			)];
		}
	}

	const hasBody = schema && typeof schema === 'object' && Object.keys(schema).length > 0;
	if (!hasBody) return [];

	const errors = [];

	// Check 2: body shape — purely structural validation that the body is a
	// well-formed _type_shape value: at most one of the recognised shape keys
	// is present, and no unknown keys appear. Independent of container or DB —
	// the body's well-formedness is static, knowable at descriptor time.
	const known         = new Set(shapeKeys(dbAccess));
	const bodyKeys      = Object.keys(schema);
	const presentShapes = bodyKeys.filter(k => known.has(k));
	const unknownKeys   = bodyKeys.filter(k => !known.has(k));

	if (presentShapes.length > 1) {
		errors.push(makeError(
			ErrorCode.AMBIGUOUS_SHAPE, path, presentShapes,
			'_scope_object body with at most one shape key (a _type_shape value)',
			`_scope_object body has multiple shape keys: ${presentShapes.join(', ')}. A _type_shape value carries exactly one shape key.`
		));
	}
	for (const key of unknownKeys) {
		errors.push(makeError(
			ErrorCode.UNKNOWN_PROPERTY, [...path, key], key,
			'a recognised data-shape key (a _type_shape value)',
			`"${key}" is not a recognised shape key. _scope_object body must be a _type_shape value (one of: ${[...known].join(', ')}).`
		));
	}

	// Check 3: body-against-target — validates the referenced property's value
	// against the body shape. The resolution base depends on the path's first
	// segment: a term-section prefix (_domn, _prop, …) is resolved from the term
	// ROOT (opts.rootObject); anything else is resolved from the immediate
	// container, as before. Skip-absent is intentional and preserved in both
	// branches: rule edges may legitimately ban the target property, and a
	// term-root reference may point at a section absent from the document.
	// Only runs when the body shape itself is well-formed — otherwise the
	// downstream validateData call would produce cascade errors.
	if (errors.length === 0) {
		const useRoot = TERM_SECTIONS.has(segments[0]);
		const base    = useRoot ? (opts && opts.rootObject) : container;
		if (base) {
			const target = readObjectScope(base, value);
			if (target !== undefined) {
				const { validateData } = require('../validate'); // lazy require
				const sub = validateData(target, schema, [...path, `→ ${value}`], dbAccess, opts);
				errors.push(...sub.errors);
			}
		}
	}

	return errors;
}

/**
 * Validate a value against the _scope_sibling scalar type.
 *
 * The value must be a string referencing a descriptor sibling of the containing
 * object — either a bare descriptor name ("_from") or a dotted path into a
 * nested sub-property ("_range._min-inclusive"). Forward slashes are forbidden
 * (cross-handle references are the role of _scope_target).
 *
 * Three checks run:
 *
 *   1. Syntactic check (always): non-empty string, no forward slashes, no
 *      empty dotted segments.
 *
 *   2. Descriptor-existence check (DB-backed, when dbAccess is available):
 *      each dotted segment must be an existing descriptor (carrying
 *      _term_role_descriptor in its _domn._term_role).
 *
 *   3. Leaf-type check (DB-backed): the LEAF segment's descriptor must declare
 *      a string-valued comparable type — its instances are strings, so they
 *      can become dictionary keys (the whole point of naming a sibling in a
 *      _keyed schema). Stance: provably wrong → INVALID_SIBLING_TYPE; unknown
 *      (_data: {}, _scalar: {}, unrecognised type key) → pass. Sets / arrays
 *      are allowed — the ELEMENT type is what is checked (e.g. _path, a set of
 *      _handle; _target, a set of _scope_target — both pass). One _typedef hop
 *      is resolved per the dictionary's no-chaining rule.
 *
 * The runtime check — that actual dict keys in instances of a _keyed shape
 * match values of the named sibling properties — is performed by the _keyed
 * shape validator (validator/shapes/keyed-by.js), not by this type. Sibling
 * properties absent from a particular instance are skipped silently there,
 * mirroring _scope_object's skip-absent rule.
 *
 * @param {*}        value    - The value to validate.
 * @param {Object}   schema   - Companion properties (expected to be empty {}).
 * @param {string[]} path     - Current dot-path for error location.
 * @param {Object}   dbAccess - DB accessor (may be null — skips DB checks).
 * @returns {Object[]} Array of error objects (empty = valid).
 */
function validateScopeSibling(value, schema, path, dbAccess) {
	// Check 1: string syntax
	if (typeof value !== 'string' || value === '') {
		return [makeError(
			ErrorCode.WRONG_TYPE, path, value, 'non-empty string (sibling scope)',
			`Expected a non-empty string for _scope_sibling, got ${typeof value}`
		)];
	}

	if (value.indexOf('/') !== -1) {
		return [makeError(
			ErrorCode.INVALID_SIBLING_SCOPE, path, value,
			'local sibling reference without forward slashes (use _scope_target for compound <handle>.<property> references)',
			`"${value}" contains a forward slash — _scope_sibling is a LOCAL reference to a property of the current object`
		)];
	}

	const segments = value.split('.');
	for (let i = 0; i < segments.length; i++) {
		if (segments[i] === '') {
			return [makeError(
				ErrorCode.INVALID_SIBLING_SCOPE, path, value,
				'sibling scope with non-empty dot-separated segments (e.g. "_from" or "_range._min-inclusive")',
				`"${value}" has an empty segment at position ${i} — leading, trailing, or consecutive dots are not allowed`
			)];
		}
	}

	// Check 2: descriptor-existence (DB-backed)
	if (!dbAccess) return [];

	for (const segment of segments) {
		if (typeof dbAccess.termHasRole !== 'function') break;
		if (!dbAccess.termHasRole(segment, '_term_role_descriptor')) {
			return [makeError(
				ErrorCode.INVALID_SIBLING_SCOPE, path, value,
				'sibling scope where every segment names an existing descriptor (_term_role_descriptor)',
				`"${segment}" (from sibling scope "${value}") is not an existing descriptor in the dictionary`
			)];
		}
	}

	// Check 3: leaf-type check (DB-backed) — the leaf descriptor's declared
	// type must be able to produce string values (dictionary keys).
	if (typeof dbAccess.getTerm === 'function') {
		const leaf = segments[segments.length - 1];
		const verdict = siblingLeafTypeVerdict(leaf, dbAccess);
		if (verdict !== null) {
			return [makeError(
				ErrorCode.INVALID_SIBLING_TYPE, path, value,
				'sibling scope whose leaf descriptor declares a string-valued comparable type (its values become dictionary keys)',
				`"${leaf}" (from sibling scope "${value}") declares ${verdict} — its values can never be strings, so they can never serve as dictionary keys`
			)];
		}
	}

	return [];
}

// Scalar types whose stored values are strings AND comparable — the only
// types whose instances can serve as dictionary keys contributed by a
// _scope_sibling-named sibling. Deliberately WIDER than _type_key:
// _scope_target IS included because _path_data's _target set legitimately
// supplies compound <handle>.<property> keys (Layer 4), and _string_regexp /
// the _scope_* family are strings capability-wise even where dotted/slashed
// forms are not _type_key material by intent.
const STRING_VALUED_TYPES = new Set([
	'_string', '_string_URI', '_string_Email', '_string_Hostname',
	'_string_IPv4', '_string_IPv6', '_string_YMD', '_string_date',
	'_string_time', '_string_date-time', '_string_LaTeX', '_string_HEX',
	'_string_regexp',
	'_term_key', '_term_key_enum-root', '_term_key_enum-item', '_term_key_descriptor',
	'_enum', '_handle', '_handle_SVG',
	'_scope_enum', '_scope_object', '_scope_sibling', '_scope_target'
]);

// Scalar types that provably never store strings.
const NON_STRING_SCALAR_TYPES = new Set([
	'_number', '_number_float', '_number_integer',
	'_timestamp', '_boolean',
	'_text', '_text_HTML', '_text_Markdown', '_text_SVG'
]);

// Data shapes whose instances are never strings (objects, dicts, tuples,
// nested arrays-of-arrays — none of these can contribute key strings, not
// even as set/array elements).
const NON_STRING_SHAPES = new Set([
	'_object', '_object_GeoJSON', '_objects', '_dict', '_keyed', '_tuple', '_nested'
]);

/**
 * Decide whether a sibling leaf descriptor's declared type is acceptable.
 *
 * Returns null when acceptable (string-valued, or unknowable — benefit of
 * the doubt), or a short human-readable description of the offending
 * declaration for the error message.
 *
 * @param {string} leafGid  - The leaf segment's descriptor gid.
 * @param {Object} dbAccess - DB accessor exposing getTerm(gid).
 * @returns {string|null} Offence description, or null = pass.
 */
function siblingLeafTypeVerdict(leafGid, dbAccess) {
	const term = dbAccess.getTerm(leafGid);
	let data = term && term._data;
	if (!data || typeof data !== 'object') return null;

	// One _typedef hop (chaining is prohibited by the dictionary).
	if (typeof data._typedef === 'string') {
		const tdef = dbAccess.getTerm(data._typedef);
		data = tdef && tdef._data;
		if (!data || typeof data !== 'object') return null;
	}

	// Scalar: the type key inside _scalar decides. Empty _scalar = unknown.
	if (data._scalar && typeof data._scalar === 'object') {
		return scalarTypeVerdict(data._scalar, 'a scalar of type');
	}

	// Set / array: the ELEMENT type decides. _set carries the type key
	// directly; _array nests a shape sub-property.
	if (data._set && typeof data._set === 'object') {
		return scalarTypeVerdict(data._set, 'a set whose elements are of type');
	}
	if (data._array && typeof data._array === 'object') {
		const body = data._array;
		if (body._scalar && typeof body._scalar === 'object') {
			return scalarTypeVerdict(body._scalar, 'an array whose elements are of type');
		}
		for (const key of Object.keys(body)) {
			if (NON_STRING_SHAPES.has(key)) {
				return `an array of ${key} elements`;
			}
		}
		return null; // empty / unrecognised array body — unknown
	}

	// Top-level non-string shapes are provably wrong.
	for (const key of Object.keys(data)) {
		if (NON_STRING_SHAPES.has(key)) {
			return `the ${key} shape`;
		}
	}

	return null; // _data: {} or unrecognised — benefit of the doubt
}

/**
 * Verdict for a type-keyed body (as found inside _scalar / _set): null when
 * the type is string-valued or unknown, an offence description otherwise.
 */
function scalarTypeVerdict(body, prefix) {
	for (const key of Object.keys(body)) {
		if (key === '_elements') continue;
		if (STRING_VALUED_TYPES.has(key)) return null;
		if (NON_STRING_SCALAR_TYPES.has(key)) return `${prefix} ${key}`;
	}
	return null; // no type key / unrecognised — unknown
}

/**
 * Read a property from an object, walking a dotted path.
 *
 * Used by _objects' _unique and _ordered invariants to dereference an
 * _scope_object reference against an element. Returns undefined if any
 * intermediate segment is missing or not an object.
 *
 * @param {Object} obj  - The element to read from.
 * @param {string} path - An _scope_object value: top-level name or dotted path.
 * @returns {*} The property value, or undefined if not present along the full path.
 */
function readObjectScope(obj, path) {
	if (obj === null || typeof obj !== 'object') return undefined;
	const segments = path.split('.');
	let cursor = obj;
	for (let i = 0; i < segments.length; i++) {
		if (cursor === null || typeof cursor !== 'object' || !(segments[i] in cursor)) {
			return undefined;
		}
		cursor = cursor[segments[i]];
	}
	return cursor;
}

module.exports = { validateHandle, validateTimestamp, validateEnumScope, validateTargetScope, validateObjectScope, validateScopeSibling, readObjectScope };
