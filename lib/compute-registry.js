'use strict';

/**
 * compute-registry.js — How the dictionary's `_computed` declarations are run.
 *
 * A schema body (the content of `_open` or `_closed`) lists its computed
 * properties in `_computed`. Each entry is an OBJECT that declares the kind
 * of computation and its parameters, so the rule lives in the term and this
 * module is an INTERPRETER of eight kinds:
 *
 *     { "_field": "_gid", "_compute_kind": "_compute_kind_concat",
 *       "_compute_from": ["_nid", "_lid"], "_compute_separator": "_" }
 *
 *     kind      parameters                                   present stored value
 *     copy      _compute_from (exactly one path)             replace (mismatch = COMPUTE_MISMATCH)
 *     concat    _compute_from (ordered), _compute_separator  replace; absent parts are skipped
 *     hash      _compute_from, _compute_separator,           replace; any absent part → no value
 *               _compute_digest
 *     union     _compute_from (values added if missing)      merge (stale = COMPUTE_ADDED + fill)
 *     rule      _compute_rule (a named rule of this module)  merge
 *     constant  _compute_value (any JSON)                    fill only when absent, never compared
 *     generate  _compute_generator (key | now)                fill only when absent, never compared;
 *                                                            `now` is produced here in the property's
 *                                                            declared type, `key` by the collection —
 *                                                            an absent key is PENDING, not computed
 *     service   _compute_service (a named process)           nothing is computed or compared here:
 *                                                            an absent value is PENDING for the service
 *
 *   Paths in `_compute_from` are container-relative `_scope_object` strings
 *   (`_lid` inside `_code`, `_code._gid` on the term root), read through the
 *   driver's ctx so a value computed-but-not-filled (noFill) is still visible
 *   to a later entry. Entries apply in list order; the driver computes the
 *   containers of an object before the object itself.
 *
 *   A bare property gid — the shape every body carried before v1.4.0 — is no
 *   longer accepted (v1.5.0): it is reported as INVALID_COMPUTE.
 *
 * CORE_DECLARATIONS holds the six core bodies in the new shape. It is what the
 * driver runs when no dictionary is reachable (the analogue of the shape and
 * type dispatch tables: what the code can run, not a second copy of the data)
 * and it must equal what the dictionary declares — checkComputeRegistry in
 * lib/compute.js compares the two.
 *
 * resolveEntry(schemaGid, entry) turns one entry into a runnable description:
 *   → { field, kind, merge, fillOnly, pending, compute(container, root, ctx) }
 *     `pending`: an absent value the implementation cannot supply is left for
 *     the collection or the named service (the driver reports COMPUTE_PENDING)
 *   → { field, problem: { code, expected, message } }  when the entry cannot run:
 *       NO_COMPUTE_FUNCTION  unknown kind / digest / rule / generator
 *       INVALID_COMPUTE      a parameter is missing or of the wrong type, or the
 *                            entry is not an object
 *       DUPLICATE_VALUE      a path repeats in _compute_from (ordered, unique)
 */

const { md5 }             = require('./md5');
const { readObjectScope } = require('./types/other');

// ── gid rule and the named rule (term roles) ────────────────────────────────

/** `_gid` from `_nid` and `_lid`: absent nid → lid; "" → "_" + lid; else nid + "_" + lid. */
function computeGid(nid, lid) {
	if (nid === undefined) return lid;
	if (nid === '')        return '_' + lid;
	return nid + '_' + lid;
}

/**
 * Roles the Swift `assign-roles` workflow never computes (TermRole.userAssigned
 * in workflows/assign-roles/Sources/assign-roles/Models.swift) — kept as found.
 * `_term_role_system` is provenance (the term's source directory), which the
 * database cannot tell, so it is kept as found too.
 */
const PRESERVED_ROLES = new Set([
	'_term_role_data-type', '_term_role_data-shape', '_term_role_typedef', '_term_role_authority',
	'_term_role_multilingual', '_term_role_range', '_term_role_geographic',
	'_term_role_system',
]);

/** Roles derived from the term and the graph — the five assign-roles rules. */
const DERIVED_ROLES = [
	'_term_role_descriptor', '_term_role_namespace', '_term_role_predicate',
	'_term_role_enum-root', '_term_role_enum-item', '_term_role_enum-source',
];

/**
 * _domn._term_role — RoleAssigner.swift's computeRoles() in JavaScript.
 * Needs five optional dbAccess facts — isPathRoot (the handle sits in the
 * _path of an enum-of / section-of / bridge-of edge; NOT isEnumRoot, which also
 * accepts a declared-but-empty enumeration), isNamespace, isPredicate,
 * isEnumSource, isEnumItem. When any is missing or answers null the roles
 * cannot be recomputed and the function returns undefined.
 */
function computeTermRole(container, root, ctx) {
	const db  = ctx && ctx.dbAccess;
	const gid = root && root._code && root._code._gid;
	if (!db || typeof gid !== 'string' || gid === '') return undefined;
	for (const m of ['isPathRoot', 'isNamespace', 'isPredicate', 'isEnumSource', 'isEnumItem']) {
		if (typeof db[m] !== 'function') return undefined;
	}
	const facts = {
		namespace:  db.isNamespace(gid),
		predicate:  db.isPredicate(gid),
		pathRoot:   db.isPathRoot(gid),
		enumSource: db.isEnumSource(gid),
		enumItem:   db.isEnumItem(gid),
	};
	for (const k in facts) if (facts[k] === null || facts[k] === undefined) return undefined;

	const roles = new Set();
	const existing = Array.isArray(container._term_role) ? container._term_role : [];
	for (const r of existing) if (PRESERVED_ROLES.has(r)) roles.add(r);

	// A _data section of any content, even `{}` ("any value"), makes a descriptor — RoleAssigner's hasData.
	if (root._data && typeof root._data === 'object') roles.add('_term_role_descriptor');
	if (facts.namespace)  roles.add('_term_role_namespace');
	if (facts.predicate)  roles.add('_term_role_predicate');
	if (facts.pathRoot)   roles.add('_term_role_enum-root');
	if (facts.enumSource) roles.add('_term_role_enum-source');
	if (facts.enumItem)   roles.add('_term_role_enum-item');
	return [...roles].sort();
}

// ── the generators of a `_compute_kind_generate` entry ──────────────────────

const SCALE_ORDER = ['_scale_year', '_scale_month', '_scale_day', '_scale_hour', '_scale_minute', '_scale_second', '_scale_millisecond'];

/** The scalar type and companion body of the property `gid`, through one _typedef hop; null when unknown. */
function leafOf(gid, ctx) {
	const db = ctx && ctx.dbAccess;
	if (!db || typeof db.getTerm !== 'function') return null;
	let t = db.getTerm(gid);
	let data = t && t._data;
	if (data && typeof data._typedef === 'string') { t = db.getTerm(data._typedef); data = t && t._data; }
	const scalar = data && data._scalar;
	if (!scalar || typeof scalar !== 'object') return null;
	const type = Object.keys(scalar)[0];
	return type ? { type, body: scalar[type] || {} } : null;
}

const pad = (n, w) => String(n).padStart(w || 2, '0');

/**
 * The moment `at` (a Date, UTC) written in the form a time type declares,
 * truncated to `scale` (a _scale_time member) when one is given: the components
 * finer than the scale are dropped, never rounded.
 */
function nowFor(type, scale, at) {
	const d = new Date(at.getTime());
	const level = SCALE_ORDER.indexOf(scale);                     // -1 = no scale: keep everything
	if (level >= 0) {
		if (level < 6) d.setUTCMilliseconds(0);
		if (level < 5) d.setUTCSeconds(0);
		if (level < 4) d.setUTCMinutes(0);
		if (level < 3) d.setUTCHours(0);
		if (level < 2) d.setUTCDate(1);
		if (level < 1) d.setUTCMonth(0);
	}
	const Y = d.getUTCFullYear(), M = pad(d.getUTCMonth() + 1), D = pad(d.getUTCDate());
	const h = pad(d.getUTCHours()), m = pad(d.getUTCMinutes()), s = pad(d.getUTCSeconds());
	switch (type) {
		case '_string_YMD':       return level === 0 ? String(Y) : level === 1 ? Y + M : Y + M + D;
		case '_string_date':      return Y + '-' + M + '-' + D;
		case '_string_time':      return h + ':' + m + ':' + s;
		case '_string_date-time': return Y + '-' + M + '-' + D + 'T' + h + ':' + m + ':' + s + 'Z';
		case '_timestamp':        return Math.floor(d.getTime() / 1000);
		default:                  return undefined;                // not a time type: nothing to generate
	}
}

/**
 * The generators a `_compute_kind_generate` entry may select. Each returns the
 * value to fill, or undefined when the value is not this implementation's to
 * produce (the driver then reports the absent property as pending).
 */
const GENERATORS = {
	// The collection's key generator assigns it at insertion: nothing is produced here.
	'_compute_generator_key': function() { return undefined; },
	// The current date and time, in the property's declared type, truncated to its _scale_time.
	'_compute_generator_now': function(entry, container, root, ctx) {
		const leaf = leafOf(entry._field, ctx);
		if (!leaf) return undefined;                                  // no dictionary: the type is unknown
		return nowFor(leaf.type, leaf.body._scale_time, (ctx && ctx.now) || new Date());
	},
};

// ── the interpreter: eight kinds, the digests, the generators, the named rules ─

/** The named rules a `_compute_kind_rule` entry may select. */
const RULES = {
	'_compute_rule_term-role': computeTermRole,
};

/** The digests a `_compute_kind_hash` entry may select: string → lowercase hex. */
const DIGESTS = {
	'_compute_digest_md5': md5,
};

/**
 * Read a container-relative path. `ctx.shadow` holds the values the driver
 * computed but did not write (noFill), keyed by absolute document path, so a
 * later entry (`_term._key` copying `_code._gid`) still sees them.
 */
function readPath(container, rel, ctx) {
	const v = readObjectScope(container, rel);
	if (v !== undefined) return v;
	if (ctx && ctx.shadow) {
		const key = [...(ctx.containerPath || []), ...rel.split('.')].join('.');
		if (Object.prototype.hasOwnProperty.call(ctx.shadow, key)) return ctx.shadow[key];
	}
	return undefined;
}

function isScalar(v) { return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'; }

function deepCopy(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function sameItem(a, b) {
	if (isScalar(a) && isScalar(b)) return a === b;
	return JSON.stringify(a) === JSON.stringify(b);
}

const KINDS = {
	'_compute_kind_copy': {
		merge: false, fillOnly: false, required: ['_compute_from'], single: true,
		compute(entry, container, root, ctx) {
			return deepCopy(readPath(container, entry._compute_from[0], ctx));
		},
	},
	'_compute_kind_concat': {
		merge: false, fillOnly: false, required: ['_compute_from', '_compute_separator'],
		compute(entry, container, root, ctx) {
			const parts = [];
			for (const p of entry._compute_from) {
				const v = readPath(container, p, ctx);
				if (v === undefined) continue;                 // an absent part is skipped; "" is present
				if (!isScalar(v)) return undefined;            // not something that joins into a string
				parts.push(String(v));
			}
			return parts.length === 0 ? undefined : parts.join(entry._compute_separator);
		},
	},
	'_compute_kind_hash': {
		merge: false, fillOnly: false, required: ['_compute_from', '_compute_separator', '_compute_digest'],
		compute(entry, container, root, ctx) {
			const parts = [];
			for (const p of entry._compute_from) {
				const v = readPath(container, p, ctx);
				if (!isScalar(v)) return undefined;            // never hash a partial key
				parts.push(String(v));
			}
			return DIGESTS[entry._compute_digest](parts.join(entry._compute_separator));
		},
	},
	'_compute_kind_union': {
		merge: true, fillOnly: false, required: ['_compute_from'],
		compute(entry, container, root, ctx) {
			const out = Array.isArray(container[entry._field]) ? container[entry._field].slice() : [];
			let contributed = false;
			for (const p of entry._compute_from) {
				const v = readPath(container, p, ctx);
				if (v === undefined) continue;
				contributed = true;
				for (const item of (Array.isArray(v) ? v : [v])) {
					if (!out.some(x => sameItem(x, item))) out.push(deepCopy(item));
				}
			}
			return contributed ? out : undefined;              // nothing to add → nothing to say
		},
	},
	'_compute_kind_rule': {
		merge: true, fillOnly: false, required: ['_compute_rule'],
		compute(entry, container, root, ctx) {
			return RULES[entry._compute_rule](container, root, ctx);
		},
	},
	'_compute_kind_constant': {
		merge: false, fillOnly: true, required: ['_compute_value'],
		compute(entry) {
			return deepCopy(entry._compute_value);
		},
	},
	'_compute_kind_generate': {
		merge: false, fillOnly: true, pending: true, required: ['_compute_generator'],
		compute(entry, container, root, ctx) {
			return GENERATORS[entry._compute_generator](entry, container, root, ctx);
		},
	},
	'_compute_kind_service': {
		merge: false, fillOnly: true, pending: true, required: ['_compute_service'],
		compute() {
			return undefined;                                  // a process outside the dictionary fills it
		},
	},
};

/**
 * The six core bodies in the new shape — what the dictionary declares on
 * _term, _code, _edge, _link, _blob and _domn, byte for byte. The driver runs
 * these when no dictionary is reachable; checkComputeRegistry reports any
 * difference between them and the live declarations.
 */
const CORE_DECLARATIONS = {
	_code: [
		{ _field: '_gid', _compute_kind: '_compute_kind_concat', _compute_from: ['_nid', '_lid'], _compute_separator: '_' },
		{ _field: '_aid', _compute_kind: '_compute_kind_union',  _compute_from: ['_lid'] },
	],
	_term: [
		{ _field: '_key', _compute_kind: '_compute_kind_copy', _compute_from: ['_code._gid'] },
	],
	_edge: [
		{ _field: '_key', _compute_kind: '_compute_kind_hash', _compute_from: ['_from', '_predicate', '_to'],
		  _compute_separator: '/', _compute_digest: '_compute_digest_md5' },
	],
	_link: [
		{ _field: '_key', _compute_kind: '_compute_kind_hash', _compute_from: ['_from', '_predicate', '_to'],
		  _compute_separator: '/', _compute_digest: '_compute_digest_md5' },
	],
	_blob: [
		{ _field: '_key', _compute_kind: '_compute_kind_hash',
		  _compute_from: ['_blob_item', '_blob_type', '_blob_kind', '_blob_identifier'],
		  _compute_separator: '/', _compute_digest: '_compute_digest_md5' },
	],
	_domn: [
		{ _field: '_term_role', _compute_kind: '_compute_kind_rule', _compute_rule: '_compute_rule_term-role' },
	],
};

// ── resolveEntry: an entry → one runnable description ───────────────────────

function problem(field, code, expected, message) {
	return { field, problem: { code, expected, message } };
}

/**
 * @param {string}        schemaGid - The schema term whose body declares the entry.
 * @param {string|Object} entry     - A `_computed` list element.
 * @returns {{field, kind, merge, fillOnly, compute}} or {{field, problem}}.
 */
function resolveEntry(schemaGid, entry) {
	if (typeof entry === 'string') {
		return problem(entry, 'INVALID_COMPUTE', 'a compute entry object',
			'"' + schemaGid + '" declares "' + entry + '" as a bare gid — the shape retired in v1.5.0; declare { _field, _compute_kind, … }');
	}
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
		return problem('?', 'INVALID_COMPUTE', 'a compute entry object',
			'"' + schemaGid + '" has a _computed entry that is not an entry object');
	}
	const field = entry._field;
	if (typeof field !== 'string' || field === '') {
		return problem('?', 'INVALID_COMPUTE', 'a _field naming the computed property',
			'"' + schemaGid + '" has a _computed entry without a _field');
	}
	const kindGid = entry._compute_kind;
	const kind = KINDS[kindGid];
	if (!kind) {
		return problem(field, 'NO_COMPUTE_FUNCTION', 'one of [' + Object.keys(KINDS).join(', ') + ']',
			'"' + schemaGid + '" declares "' + field + '" computed by ' + JSON.stringify(kindGid) + ', a kind the interpreter does not implement');
	}
	for (const p of kind.required) {
		if (!Object.prototype.hasOwnProperty.call(entry, p)) {
			return problem(field, 'INVALID_COMPUTE', p + ' on a ' + kindGid + ' entry',
				'"' + schemaGid + '"."' + field + '" (' + kindGid + ') lacks ' + p);
		}
	}
	if (kind.required.includes('_compute_from')) {
		const from = entry._compute_from;
		if (!Array.isArray(from) || from.length === 0 || from.some(p => typeof p !== 'string' || p === '')) {
			return problem(field, 'INVALID_COMPUTE', 'a non-empty array of property paths',
				'"' + schemaGid + '"."' + field + '": _compute_from must be a non-empty array of property paths');
		}
		if (kind.single && from.length !== 1) {
			return problem(field, 'INVALID_COMPUTE', 'exactly one path',
				'"' + schemaGid + '"."' + field + '": a ' + kindGid + ' entry takes exactly one _compute_from path');
		}
		const seen = new Set();
		for (const p of from) {
			if (seen.has(p)) {
				return problem(field, 'DUPLICATE_VALUE', 'unique paths in _compute_from',
					'"' + schemaGid + '"."' + field + '": _compute_from repeats "' + p + '"');
			}
			seen.add(p);
		}
	}
	if (kind.required.includes('_compute_separator') && typeof entry._compute_separator !== 'string') {
		return problem(field, 'INVALID_COMPUTE', 'a string _compute_separator',
			'"' + schemaGid + '"."' + field + '": _compute_separator must be a string');
	}
	if (kind.required.includes('_compute_digest') && !DIGESTS[entry._compute_digest]) {
		return problem(field, 'NO_COMPUTE_FUNCTION', 'one of [' + Object.keys(DIGESTS).join(', ') + ']',
			'"' + schemaGid + '"."' + field + '": digest ' + JSON.stringify(entry._compute_digest) + ' is not implemented');
	}
	if (kind.required.includes('_compute_generator') && !GENERATORS[entry._compute_generator]) {
		return problem(field, 'NO_COMPUTE_FUNCTION', 'one of [' + Object.keys(GENERATORS).join(', ') + ']',
			'"' + schemaGid + '"."' + field + '": generator ' + JSON.stringify(entry._compute_generator) + ' is not implemented');
	}
	if (kind.required.includes('_compute_service') && (typeof entry._compute_service !== 'string' || entry._compute_service === '')) {
		return problem(field, 'INVALID_COMPUTE', 'the gid of the service that derives the property',
			'"' + schemaGid + '"."' + field + '": _compute_service must name the service as a non-empty string');
	}
	if (kind.required.includes('_compute_rule') && !RULES[entry._compute_rule]) {
		return problem(field, 'NO_COMPUTE_FUNCTION', 'one of [' + Object.keys(RULES).join(', ') + ']',
			'"' + schemaGid + '"."' + field + '": rule ' + JSON.stringify(entry._compute_rule) + ' is not implemented');
	}
	return { field, kind: kindGid, merge: kind.merge, fillOnly: kind.fillOnly, pending: kind.pending === true,
		compute: (container, root, ctx) => kind.compute(entry, container, root, ctx) };
}

module.exports = {
	KINDS, RULES, DIGESTS, GENERATORS, CORE_DECLARATIONS, nowFor,
	resolveEntry, readPath, computeGid, computeTermRole,
	PRESERVED_ROLES, DERIVED_ROLES,
};
