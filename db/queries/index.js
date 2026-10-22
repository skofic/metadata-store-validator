'use strict';

/**
 * queries/index.js — All AQL queries used by the validation workflow.
 *
 * Each function returns { query: string, bindVars: object } ready for
 * submission to ArangoDB's /_api/cursor endpoint. Centralising queries
 * here makes it straightforward to audit DB access patterns and plan
 * indexing strategies.
 *
 * Startup queries (called once, results cached in memory):
 *   enumEdgesQuery       — all enum-of / bridge-of edges
 *   propertyOfRulesQuery — property-of edges with non-empty _path_data
 *   valueOfRulesQuery    — value-of edges with non-empty _path_data
 *
 * Per-request queries (LRU-cached by db-access):
 *   termLookupQuery      — fetch a single term by _key
 */

/**
 * Fetch all enum-of, bridge-of, and section-of edges.
 * Used to pre-load:
 *   - enum membership map (enum-of edges only)
 *   - enum root set (path roots from any of the three predicates)
 *   - parent map for sub-graph ancestry (enum-of edges only)
 *   - section membership map (section-of edges only) — used by _scope_enum
 *     compound validation, where the node after the dot may be a section.
 *
 * Index hint: persistent index on edges._predicate is the primary access path.
 */
function enumEdgesQuery(edgesCol) {
	return {
		query:
			'FOR e IN @@edges' +
			'  FILTER e._predicate IN ["_predicate_enum-of", "_predicate_bridge-of", "_predicate_section-of"]' +
			'  RETURN { f: e._from, t: e._to, p: e._path, pred: e._predicate }',
		bindVars: { '@edges': edgesCol },
	};
}

/**
 * Fetch all property-of edges that carry a non-empty _path_data rule.
 * Used to pre-load conditional rules triggered by property presence.
 *
 * Index hint: persistent index on edges._predicate is the primary access path.
 */
function propertyOfRulesQuery(edgesCol) {
	return {
		query:
			'FOR e IN @@edges' +
			'  FILTER e._predicate == "_predicate_property-of" && LENGTH(e._path_data) > 0' +
			'  RETURN { f: e._from, d: e._path_data }',
		bindVars: { '@edges': edgesCol },
	};
}

/**
 * Fetch all value-of edges that carry a non-empty _path_data rule.
 * Used to pre-load conditional rules triggered by specific property values.
 *
 * Index hint: persistent index on edges._predicate is the primary access path.
 */
function valueOfRulesQuery(edgesCol) {
	return {
		query:
			'FOR e IN @@edges' +
			'  FILTER e._predicate == "_predicate_value-of" && LENGTH(e._path_data) > 0' +
			'  RETURN { f: e._from, t: e._to, d: e._path_data }',
		bindVars: { '@edges': edgesCol },
	};
}

/**
 * Look up a single term by its _key (_gid). Returns the full term document.
 * Results are LRU-cached by db-access; this query fires at most once per term per run.
 *
 * Index hint: primary index on terms._key — no additional index needed.
 */
function termLookupQuery(termsCol, gid) {
	return {
		query: 'FOR t IN @@col FILTER t._key == @gid LIMIT 1 RETURN t',
		bindVars: { '@col': termsCol, gid: gid },
	};
}

/**
 * Fetch several terms by _key in one round trip (snapshot builder).
 * Keys with no document are simply absent from the result.
 *
 * Index hint: primary index on terms._key.
 */
function termsByKeysQuery(termsCol, keys) {
	return {
		query: 'FOR t IN @@col FILTER t._key IN @keys RETURN t',
		bindVars: { '@col': termsCol, keys: keys },
	};
}

/**
 * Fetch the enum-of, bridge-of and section-of edges belonging to the graphs of
 * the given roots — an edge belongs to a graph when the root's handle is in its
 * _path (the same membership test the in-memory maps apply). Snapshot builder.
 *
 * Index hint: persistent index on edges._predicate; the _path test is a scan
 * over those, which is cheap at dictionary scale.
 */
function enumEdgesForRootsQuery(edgesCol, rootHandles) {
	return {
		query:
			'FOR e IN @@edges' +
			'  FILTER e._predicate IN ["_predicate_enum-of", "_predicate_bridge-of", "_predicate_section-of"]' +
			'  FILTER LENGTH(INTERSECTION(e._path, @roots)) > 0' +
			'  RETURN { f: e._from, t: e._to, p: e._path, pred: e._predicate }',
		bindVars: { '@edges': edgesCol, roots: rootHandles },
	};
}

/**
 * The three dictionary-wide facts _term_role is computed from (see
 * lib/compute-registry.js). Each is one query, run once per accessor.
 */
function namespacesQuery(termsCol) {
	return {
		query: 'FOR t IN @@terms FILTER t._code._nid != null AND t._code._nid != "" COLLECT n = t._code._nid RETURN n',
		bindVars: { '@terms': termsCol },
	};
}

/** Every _predicate used by an edge or a link. `linksCol` may be null. */
function predicatesQuery(edgesCol, linksCol) {
	if (!linksCol) {
		return { query: 'FOR e IN @@edges COLLECT p = e._predicate RETURN p', bindVars: { '@edges': edgesCol } };
	}
	return {
		query:
			'LET a = (FOR e IN @@edges COLLECT p = e._predicate RETURN p)' +
			' LET b = (FOR l IN @@links COLLECT p = l._predicate RETURN p)' +
			' FOR p IN UNION_DISTINCT(a, b) RETURN p',
		bindVars: { '@edges': edgesCol, '@links': linksCol },
	};
}

/** The _data section of every descriptor, for collectEnumSources(). */
function dataSectionsQuery(termsCol) {
	return {
		query: 'FOR t IN @@terms FILTER t._data != null RETURN t._data',
		bindVars: { '@terms': termsCol },
	};
}

/**
 * Every schema body that declares computed properties: { gid, computed[] }.
 * Used by the CLI start-up cross-check against the compute registry.
 */
function computedDeclarationsQuery(termsCol) {
	return {
		query:
			'FOR t IN @@terms' +
			'  LET body = t._data._object._closed != null ? t._data._object._closed : t._data._object._open' +
			'  FILTER body != null AND IS_ARRAY(body._computed) AND LENGTH(body._computed) > 0' +
			'  RETURN { gid: t._key, computed: body._computed }',
		bindVars: { '@terms': termsCol },
	};
}

module.exports = {
	namespacesQuery,
	predicatesQuery,
	dataSectionsQuery,
	computedDeclarationsQuery,
	enumEdgesQuery,
	propertyOfRulesQuery,
	valueOfRulesQuery,
	termLookupQuery,
	termsByKeysQuery,
	enumEdgesForRootsQuery,
};
