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

module.exports = { enumEdgesQuery, propertyOfRulesQuery, valueOfRulesQuery, termLookupQuery };
