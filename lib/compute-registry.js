'use strict';

/**
 * compute-registry.js — How the dictionary's `_computed` declarations are run.
 *
 * A schema body (the content of `_open` or `_closed`) lists its computed
 * properties in `_computed`. Two shapes are accepted while the dictionary
 * migrates from one to the other:
 *
 *   NEW — an entry OBJECT that declares the kind of computation and its
 *   parameters, so the rule lives in the term and this module is an
 *   INTERPRETER of six kinds:
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
 *
 *   Paths in `_compute_from` are container-relative `_scope_object` strings
 *   (`_lid` inside `_code`, `_code._gid` on the term root), read through the
 *   driver's ctx so a value computed-but-not-filled (noFill) is still visible
 *   to a later entry. Entries apply in list order; the driver computes the
 *   containers of an object before the object itself.
 *
 *   LEGACY — a bare property gid (string). The rule is then the function in
 *   REGISTRY[schemaGid][propertyGid], written by hand. Kept until every body
 *   in the dictionary carries object entries; then REGISTRY goes.
 *
 * CORE_DECLARATIONS holds the six core bodies in the new shape. It is what the
 * driver runs when no dictionary is reachable (the analogue of the shape and
 * type dispatch tables: what the code can run, not a second copy of the data)
 * and it must equal what the dictionary declares — checkComputeRegistry in
 * lib/compute.js compares the two.
 *
 * resolveEntry(schemaGid, entry) is the one reader of both shapes:
 *   → { field, kind, merge, fillOnly, compute(container, root, ctx) }
 *   → { field, problem: { code, expected, message } }  when the entry cannot run:
 *       NO_COMPUTE_FUNCTION  unknown kind / digest / rule, or a legacy gid with
 *                            no function
 *       INVALID_COMPUTE      a parameter is missing or of the wrong type
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

function handleHash(doc) {
	if (typeof doc._from !== 'string' || typeof doc._predicate !== 'string' || typeof doc._to !== 'string') return undefined;
	return md5(doc._from + '/' + doc._predicate + '/' + doc._to);
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

// ── the interpreter: six kinds, the digests, the named rules ────────────────

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

// ── legacy: one hand-written function per (schema, property) ────────────────

const REGISTRY = {
	_code: {
		_gid: {
			merge: false,
			compute(container) {
				if (typeof container._lid !== 'string' || container._lid === '') return undefined;
				return computeGid(container._nid, container._lid);
			},
		},
		_aid: {
			merge: true,
			compute(container) {
				if (typeof container._lid !== 'string' || container._lid === '') return undefined;
				const aid = Array.isArray(container._aid) ? container._aid.slice() : [];
				if (!aid.includes(container._lid)) aid.push(container._lid);
				return aid;
			},
		},
	},
	_term: {
		_key: {
			merge: false,
			compute(container) {
				const code = container._code;
				if (!code || typeof code !== 'object') return undefined;
				if (typeof code._gid === 'string' && code._gid !== '') return code._gid;
				if (typeof code._lid !== 'string' || code._lid === '') return undefined;
				return computeGid(code._nid, code._lid);
			},
		},
	},
	_edge: { _key: { merge: false, compute: handleHash } },
	_link: { _key: { merge: false, compute: handleHash } },
	_blob: {
		_key: {
			merge: false,
			compute(doc) {
				const parts = [doc._blob_item, doc._blob_type, doc._blob_kind, doc._blob_identifier];
				if (parts.some(v => typeof v !== 'string')) return undefined;
				return md5(parts.join('/'));
			},
		},
	},
	_domn: { _term_role: { merge: true, compute: computeTermRole } },
};

/** The legacy entry, or undefined. */
function lookup(schemaGid, propertyGid) {
	return REGISTRY[schemaGid] ? REGISTRY[schemaGid][propertyGid] : undefined;
}

/** Every (schema, property) pair the legacy table knows, for the start-up cross-check. */
function declarations() {
	const out = [];
	for (const s of Object.keys(REGISTRY)) for (const p of Object.keys(REGISTRY[s])) out.push({ schema: s, property: p });
	return out;
}

// ── resolveEntry: both shapes → one runnable description ────────────────────

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
		const legacy = lookup(schemaGid, entry);
		if (!legacy) {
			return problem(entry, 'NO_COMPUTE_FUNCTION', 'a registered compute function',
				'"' + schemaGid + '" declares "' + entry + '" as computed but the compute registry has no function for it');
		}
		return { field: entry, kind: null, merge: legacy.merge, fillOnly: false,
			compute: (container, root, ctx) => legacy.compute(container, root, ctx) };
	}
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
		return problem('?', 'INVALID_COMPUTE', 'a property gid or a compute entry object',
			'"' + schemaGid + '" has a _computed entry that is neither a gid nor an entry object');
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
	if (kind.required.includes('_compute_rule') && !RULES[entry._compute_rule]) {
		return problem(field, 'NO_COMPUTE_FUNCTION', 'one of [' + Object.keys(RULES).join(', ') + ']',
			'"' + schemaGid + '"."' + field + '": rule ' + JSON.stringify(entry._compute_rule) + ' is not implemented');
	}
	return { field, kind: kindGid, merge: kind.merge, fillOnly: kind.fillOnly,
		compute: (container, root, ctx) => kind.compute(entry, container, root, ctx) };
}

module.exports = {
	KINDS, RULES, DIGESTS, CORE_DECLARATIONS,
	REGISTRY, lookup, declarations,
	resolveEntry, readPath, computeGid, computeTermRole,
	PRESERVED_ROLES, DERIVED_ROLES,
};
