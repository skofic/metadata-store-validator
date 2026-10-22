'use strict';

/**
 * compute-registry.js — The compute functions behind the dictionary's `_computed`
 * declarations, keyed the way the dictionary declares them: by the schema term
 * whose body lists the property, then by the property.
 *
 *   REGISTRY[schemaGid][propertyGid] = {
 *     after:   [...],                        // properties of the SAME body computed first
 *     merge:   bool,                         // the value is derived from the existing one:
 *                                            //   a stale present value is filled + warned
 *                                            //   (COMPUTE_ADDED), never a COMPUTE_MISMATCH
 *     compute: (container, root, ctx) => value | undefined
 *   }
 *
 *   container  the object that carries the property (the _code section, the edge
 *              document, the _domn section, …)
 *   root       the whole document being validated
 *   ctx        { dbAccess, path }  dbAccess may be null
 *
 * `undefined` means "cannot compute here" (an input is missing, or a dictionary
 * fact the accessor cannot answer): the driver reports nothing and leaves the
 * property as found; `_required` reports the absence if it matters.
 *
 * The dictionary is the authority: a body may declare a computed property this
 * table does not know (→ NO_COMPUTE_FUNCTION, raised by the driver), and the CLI
 * cross-checks the table against every `_computed` declaration at start-up.
 * Adding a computed property = declare it in the term AND add one entry here.
 */

const { md5 } = require('./md5');

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

const REGISTRY = {
	_code: {
		_gid: {
			after: [], merge: false,
			compute(container) {
				if (typeof container._lid !== 'string' || container._lid === '') return undefined;
				return computeGid(container._nid, container._lid);
			},
		},
		_aid: {
			after: [], merge: true,
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
			after: [], merge: false,
			// The _key is the _gid; derived again from _nid + _lid when _gid is not
			// (yet) present, so a noFill run still reports what _key would be.
			compute(container) {
				const code = container._code;
				if (!code || typeof code !== 'object') return undefined;
				if (typeof code._gid === 'string' && code._gid !== '') return code._gid;
				if (typeof code._lid !== 'string' || code._lid === '') return undefined;
				return computeGid(code._nid, code._lid);
			},
		},
	},
	_edge: { _key: { after: [], merge: false, compute: handleHash } },
	_link: { _key: { after: [], merge: false, compute: handleHash } },
	_blob: {
		_key: {
			after: [], merge: false,
			compute(doc) {
				const parts = [doc._blob_item, doc._blob_type, doc._blob_kind, doc._blob_identifier];
				if (parts.some(v => typeof v !== 'string')) return undefined;
				return md5(parts.join('/'));
			},
		},
	},
	_domn: { _term_role: { after: [], merge: true, compute: computeTermRole } },
};

/** The registered entry, or undefined. */
function lookup(schemaGid, propertyGid) {
	return REGISTRY[schemaGid] ? REGISTRY[schemaGid][propertyGid] : undefined;
}

/** Every (schema, property) pair the registry knows, for the start-up cross-check. */
function declarations() {
	const out = [];
	for (const s of Object.keys(REGISTRY)) for (const p of Object.keys(REGISTRY[s])) out.push({ schema: s, property: p });
	return out;
}

module.exports = { REGISTRY, lookup, declarations, computeGid, PRESERVED_ROLES, DERIVED_ROLES };
