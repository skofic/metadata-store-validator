'use strict';

/**
 * db-access.js — Synchronous ArangoDB accessor with LRU cache.
 *
 * Uses sync-request to make blocking HTTP calls to ArangoDB's /_api/cursor
 * endpoint. Each term is fetched at most once per run; subsequent lookups hit
 * the in-process LRU cache. Not-found terms are cached as null so that missing
 * dictionary entries don't trigger repeated DB queries.
 *
 * The enumeration and rule edges are pre-loaded at startup (three AQL queries)
 * and handed to lib/edge-index.js, which implements every edge-based method as
 * an in-memory lookup — the same code the snapshot accessor (lib/snapshot.js)
 * uses, so live and snapshot validation cannot disagree.
 */

const request                  = require('sync-request');
const LRUCache                 = require('./lru-cache');
const queries                  = require('./queries');
const { makeEdgeBackedAccess,
        collectEnumSources }   = require('../lib/edge-index');

/**
 * Build a synchronous dbAccess object.
 *
 * @param {Object} credentials  - Contents of the credentials file.
 * @param {number} cacheSize    - Maximum number of terms to keep in memory.
 * @param {Object} collections  - Optional collection name overrides:
 *                                { terms, edges, links, blobs }.
 *                                Takes precedence over credentials.collections.
 */
function makeDbAccess(credentials, cacheSize, collections) {
	const baseUrl  = credentials.host;
	const database = credentials.database;
	const auth     = 'Basic ' + Buffer.from(
		credentials.username + ':' + credentials.password
	).toString('base64');

	const credCols = credentials.collections || {};
	const cols     = Object.assign({}, credCols, collections || {});
	const termsCol = cols.terms || 'terms';
	const edgesCol = cols.edges || 'edges';
	const linksCol = cols.links || 'links';

	const termCache = new LRUCache(cacheSize || 500);

	function aqlQuery(queryObj) {
		const cursorUrl = baseUrl + '/_db/' + database + '/_api/cursor';
		const headers = { 'Authorization': auth, 'Content-Type': 'application/json' };
		const res = request('POST', cursorUrl, {
			headers: headers,
			body: JSON.stringify({ query: queryObj.query, bindVars: queryObj.bindVars || {}, batchSize: 1000 }),
		});
		const body = JSON.parse(res.getBody('utf8'));
		if (body.error) throw new Error('AQL ' + body.errorNum + ': ' + body.errorMessage);
		const result = body.result;
		let cursor = body;
		while (cursor.hasMore) {
			const next = request('PUT', cursorUrl + '/' + cursor.id, { headers: headers });
			cursor = JSON.parse(next.getBody('utf8'));
			if (cursor.error) throw new Error('AQL cursor ' + cursor.errorNum + ': ' + cursor.errorMessage);
			for (let i = 0; i < cursor.result.length; i++) result.push(cursor.result[i]);
		}
		return result;
	}

	// The links collection is optional (a database may carry only edges).
	function predicatesIncludingLinks() {
		try { return aqlQuery(queries.predicatesQuery(edgesCol, linksCol)); }
		catch (_) { return aqlQuery(queries.predicatesQuery(edgesCol, null)); }
	}

	return makeEdgeBackedAccess({
		termsCol,
		enumEdges:       aqlQuery(queries.enumEdgesQuery(edgesCol)),
		propertyOfRules: aqlQuery(queries.propertyOfRulesQuery(edgesCol)),
		valueOfRules:    aqlQuery(queries.valueOfRulesQuery(edgesCol)),
		// The three dictionary-wide facts behind _domn._term_role (one query each).
		namespaces:      aqlQuery(queries.namespacesQuery(termsCol)),
		predicates:      predicatesIncludingLinks(),
		enumSources:     collectEnumSources(aqlQuery(queries.dataSectionsQuery(termsCol))),

		/** Every schema body declaring computed properties — for the CLI's registry cross-check. */
		listComputedDeclarations: function() {
			return aqlQuery(queries.computedDeclarationsQuery(termsCol));
		},

		/**
		 * Returns the full term document for the given _gid, or null if not found.
		 * Results are cached; null is also cached to avoid repeated DB queries.
		 */
		getTerm: function(gid) {
			if (termCache.has(gid)) return termCache.get(gid);
			const results = aqlQuery(queries.termLookupQuery(termsCol, gid));
			const term = results.length > 0 ? results[0] : null;
			termCache.set(gid, term);
			return term;
		},
	});
}

module.exports = makeDbAccess;
