'use strict';

/**
 * snapshot-builder.js — Fetch a dictionary snapshot for a set of descriptors.
 *
 * Asynchronous and client-agnostic: it takes a `query(aql, bindVars)` function
 * that returns the result rows, so it works with arangojs, with the dependency-
 * free makeHttpQuery() (db/http-query.js), or with anything else that can run
 * AQL. The result is plain JSON for makeSnapshotDbAccess() (lib/snapshot.js).
 *
 *   const { buildSnapshot, makeSnapshotDbAccess } = require('metadata-store-validator');
 *   const snapshot = await buildSnapshot({
 *     gids:  ['env_climate_bio01', 'chr_DomLeafType'],
 *     query: (q, b) => db.query(q, b).then(cursor => cursor.all()),   // arangojs
 *   });
 *   const dbAccess = makeSnapshotDbAccess(snapshot);
 *
 * What is fetched:
 *   - the three type-vocabulary anchor terms (always);
 *   - the requested terms;
 *   - every term those terms' _data sections refer to, followed until nothing
 *     new turns up: `_typedef` targets, `_unit` terms (for their physical
 *     bound), `_enums` roots, the property gids an object schema lists
 *     (`_required` selections, `_recommended`, `_banned`, `_computed` — the
 *     `_field` of each entry — `_locked`, `_immutable`) and `_keyed` schema keys;
 *   - the enumeration edges of every `_enums` root found;
 *   - all property-of and value-of rule edges (a small, whole-collection set).
 *
 * The anchors' own _data is not followed: it lists every scalar type, and the
 * validator reads those lists without looking the types up.
 *
 * A failed query rejects; no partial snapshot is ever returned. Requested gids
 * with no term are recorded in `missing` — the caller decides whether that is
 * fatal.
 */

const { collectEnumSources } = require('../lib/edge-index');
const { computedFields }     = require('../lib/fields');
const queries    = require('./queries');
const { ANCHOR } = require('../lib/type-registry');

const SCHEMA_LISTS = new Set(['_recommended', '_banned', '_locked', '_immutable', '_selection']);

function flattenStrings(value, out) {
	if (typeof value === 'string') out.push(value);
	else if (Array.isArray(value)) for (const item of value) flattenStrings(item, out);
	return out;
}

// Walk a _data section collecting the term gids and enumeration roots it refers to.
function collectRefs(node, addTerm, addRoot) {
	if (Array.isArray(node)) {
		for (const item of node) collectRefs(item, addTerm, addRoot);
		return;
	}
	if (!node || typeof node !== 'object') return;

	for (const key of Object.keys(node)) {
		const value = node[key];
		if (key === '_typedef' || key === '_unit') {
			if (typeof value === 'string' && value) addTerm(value);
		} else if (key === '_enums') {
			for (const scope of flattenStrings(value, [])) {
				const root = scope.split('.')[0];
				if (root) { addTerm(root); addRoot(root); }
			}
		} else if (SCHEMA_LISTS.has(key)) {
			for (const gid of flattenStrings(value, [])) if (gid) addTerm(gid);
		} else if (key === '_computed') {
			// legacy gid strings, or entry objects naming the property in _field
			for (const gid of computedFields({ _computed: value })) addTerm(gid);
		} else if (key === '_keyed' && value && typeof value === 'object' && !Array.isArray(value)) {
			for (const sibling of Object.keys(value)) addTerm(sibling);
		}
		collectRefs(value, addTerm, addRoot);
	}
}

/**
 * @param {Object}   params
 * @param {string[]} params.gids        - The descriptor gids the run will validate.
 * @param {Function} params.query       - async (aql, bindVars) → rows[].
 * @param {string}   [params.termsCol]  - Terms collection (default 'terms').
 * @param {string}   [params.edgesCol]  - Edges collection (default 'edges').
 * @param {number}   [params.maxTerms]  - Safety cap on fetched terms (default 5000).
 * @param {Object}   [params.source]    - Informative { host, database } recorded in the snapshot.
 * @param {number}   [params.batchSize] - Terms fetched per query (default 500).
 * @returns {Promise<Object>} A version-1 snapshot.
 */
async function buildSnapshot(params) {
	const p = params || {};
	if (!Array.isArray(p.gids)) throw new TypeError('buildSnapshot: params.gids must be an array of term gids');
	if (typeof p.query !== 'function') throw new TypeError('buildSnapshot: params.query must be a function (aql, bindVars) => Promise<rows>');

	const termsCol  = p.termsCol  || 'terms';
	const edgesCol  = p.edgesCol  || 'edges';
	const maxTerms  = p.maxTerms  || 5000;
	const batchSize = p.batchSize || 500;
	const run       = (q) => p.query(q.query, q.bindVars);

	const anchors   = Object.values(ANCHOR);
	const requested = [...new Set(p.gids.filter(g => typeof g === 'string' && g))];
	const terms     = {};
	const roots     = new Set();
	let pending     = new Set([...anchors, ...requested]);

	while (pending.size > 0) {
		const wanted = [...pending].filter(g => !Object.prototype.hasOwnProperty.call(terms, g));
		pending = new Set();
		if (wanted.length === 0) break;
		if (Object.keys(terms).length + wanted.length > maxTerms) {
			throw new Error('buildSnapshot: more than ' + maxTerms + ' terms referenced; raise params.maxTerms if this is expected');
		}

		for (let i = 0; i < wanted.length; i += batchSize) {
			const batch = wanted.slice(i, i + batchSize);
			const rows  = await run(queries.termsByKeysQuery(termsCol, batch));
			const byKey = new Map(rows.map(t => [t._key, t]));
			for (const gid of batch) {
				const term = byKey.get(gid) || null;
				terms[gid] = term;
				if (!term || anchors.includes(gid) || !term._data) continue;
				collectRefs(
					term._data,
					ref => { if (!Object.prototype.hasOwnProperty.call(terms, ref)) pending.add(ref); },
					root => roots.add(root)
				);
			}
		}
	}

	const rootHandles = [...roots].map(r => termsCol + '/' + r);
	const enumEdges   = rootHandles.length > 0
		? await run(queries.enumEdgesForRootsQuery(edgesCol, rootHandles))
		: [];
	const propertyOfRules = await run(queries.propertyOfRulesQuery(edgesCol));
	const valueOfRules    = await run(queries.valueOfRulesQuery(edgesCol));

	// The dictionary-wide facts _domn._term_role is computed from. Cheap (one
	// query each, a few hundred rows), and without them a snapshot accessor
	// answers null and the roles are simply not recomputed.
	const linksCol    = p.linksCol || 'links';
	const namespaces  = await run(queries.namespacesQuery(termsCol));
	let predicates;
	try { predicates = await run(queries.predicatesQuery(edgesCol, linksCol)); }
	catch (_) { predicates = await run(queries.predicatesQuery(edgesCol, null)); }
	const enumSources = collectEnumSources(await run(queries.dataSectionsQuery(termsCol)));

	// Every schema body declaring computed properties, so checkComputeRegistry
	// can run against the snapshot (one query, a handful of rows).
	const computedDeclarations = await run(queries.computedDeclarationsQuery(termsCol));

	return {
		version:  1,
		termsCol,
		source:   p.source || null,
		builtAt:  new Date().toISOString(),
		terms,
		missing:  [...anchors, ...requested].filter(g => terms[g] === null),
		enumEdges,
		propertyOfRules,
		valueOfRules,
		namespaces,
		predicates,
		enumSources,
		computedDeclarations,
	};
}

module.exports = { buildSnapshot };
