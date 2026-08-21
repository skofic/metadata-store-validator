'use strict';

/**
 * db-access.js — Synchronous ArangoDB accessor with LRU cache.
 *
 * Uses sync-request to make blocking HTTP calls to ArangoDB's /_api/cursor
 * endpoint. Each term is fetched at most once per run; subsequent lookups hit
 * the in-process LRU cache. Not-found terms are cached as null so that missing
 * dictionary entries don't trigger repeated DB queries.
 *
 * Enum membership is pre-loaded into memory at startup (one AQL query that
 * fetches all _predicate_enum-of edges). isEnumMember() is then a pure O(1)
 * Map/Set lookup with no further DB calls.
 *
 * All four dbAccess methods required by the validator are implemented:
 *   getTerm(gid)               → term document | null
 *   termExists(gid)            → boolean
 *   termHasRole(gid, role)     → boolean
 *   isEnumMember(value, roots) → boolean
 */

const request  = require('sync-request');
const LRUCache = require('./lru-cache');
const queries  = require('./queries');

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

	// Pre-load all enum-of, bridge-of, and section-of edges:
	//   enumFromMap:   fromHandle → Set<pathHandle>  (member lookup; enum-of only)
	//   enumRootSet:   all handles that appear as a path root in any of the three predicates
	//   parentMap:     fromHandle → Map<rootHandle, Set<toHandle>>  (parent lookup for sub-graph checks; enum-of only)
	//   branchFromMap: fromHandle → Set<pathHandle>  (valid branch terms in the root's graph;
	//                                                 section-of OR bridge-of edges, used by
	//                                                 isEnumBranch for _scope_enum compounds)
	// One AQL query at startup; isEnumMember(), isEnumRoot(), and isEnumBranch()
	// never touch the DB again.
	const enumFromMap   = new Map();
	const enumRootSet   = new Set();
	const parentMap     = new Map();
	const branchFromMap = new Map();
	(function() {
		const rows = aqlQuery(queries.enumEdgesQuery(edgesCol));
		for (let i = 0; i < rows.length; i++) {
			const p = rows[i].p;
			for (let j = 0; j < p.length; j++) enumRootSet.add(p[j]);
			// Only enum-of edges contribute to member lookup (bridge nodes are not members)
			if (rows[i].pred === '_predicate_enum-of') {
				const f = rows[i].f;
				const t = rows[i].t;
				if (!enumFromMap.has(f)) {
					enumFromMap.set(f, new Set(p));
				} else {
					const s = enumFromMap.get(f);
					for (let j = 0; j < p.length; j++) s.add(p[j]);
				}
				// Record direct parent per root graph for sub-graph membership checks.
				if (!parentMap.has(f)) parentMap.set(f, new Map());
				const fParents = parentMap.get(f);
				for (let j = 0; j < p.length; j++) {
					if (!fParents.has(p[j])) fParents.set(p[j], new Set());
					fParents.get(p[j]).add(t);
				}
			} else if (rows[i].pred === '_predicate_section-of' || rows[i].pred === '_predicate_bridge-of') {
				// Both sections and bridges are valid branches for _scope_enum
				// compound values: a section groups elements under a heading; a
				// bridge points into another graph whose elements are reachable
				// through the root. Neither is a selectable enum member itself,
				// but both can name a sub-scope inside the enumeration.
				const f = rows[i].f;
				if (!branchFromMap.has(f)) {
					branchFromMap.set(f, new Set(p));
				} else {
					const s = branchFromMap.get(f);
					for (let j = 0; j < p.length; j++) s.add(p[j]);
				}
			}
		}
	})();

	// Returns true if elementHandle is a descendant of ancestorHandle within
	// the graph rooted at rootHandle. Walks upward via parentMap using BFS.
	function isDescendantOf(element, ancestor, root) {
		const visited = new Set();
		const queue   = [element];
		while (queue.length > 0) {
			const cur = queue.shift();
			if (cur === ancestor) return true;
			if (visited.has(cur)) continue;
			visited.add(cur);
			const rootParents = parentMap.has(cur) ? parentMap.get(cur).get(root) : undefined;
			if (rootParents) for (const p of rootParents) queue.push(p);
		}
		return false;
	}

	// Pre-load property-of rules (non-empty _path_data only): fromHandle → edge data array.
	// getPropertyRules() fires when a property is present in the validated object.
	const propertyOfRules = new Map();
	(function() {
		const rows = aqlQuery(queries.propertyOfRulesQuery(edgesCol));
		for (let i = 0; i < rows.length; i++) {
			const f = rows[i].f;
			if (!propertyOfRules.has(f)) {
				propertyOfRules.set(f, [rows[i]]);
			} else {
				propertyOfRules.get(f).push(rows[i]);
			}
		}
	})();

	// Pre-load value-of rules (non-empty _path_data only): fromHandle+"|"+toHandle → edge data array.
	// getValueRules() fires when a property holds a specific term-GID value.
	const valueOfRules = new Map();
	(function() {
		const rows = aqlQuery(queries.valueOfRulesQuery(edgesCol));
		for (let i = 0; i < rows.length; i++) {
			const key = rows[i].f + '|' + rows[i].t;
			if (!valueOfRules.has(key)) {
				valueOfRules.set(key, [rows[i]]);
			} else {
				valueOfRules.get(key).push(rows[i]);
			}
		}
	})();

	return {
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

		/** Returns true if a term with the given _gid exists in the dictionary. */
		termExists: function(gid) {
			return this.getTerm(gid) !== null;
		},

		/** Returns true if the term has `role` in its _domn._term_role array. */
		termHasRole: function(gid, role) {
			const term = this.getTerm(gid);
			if (!term || !term._domn || !Array.isArray(term._domn._term_role)) return false;
			return term._domn._term_role.indexOf(role) !== -1;
		},

		/**
		 * Returns true if `value` (_gid) is a valid enum element for the given roots.
		 * Each element of `roots` is either:
		 *   - A plain root GID (e.g. "ISO_639_3"): any descendant of that root is valid.
		 *   - A compound scope (e.g. "_predicate._predicate_structural"): the part before
		 *     the first dot is the root, the part after is a node within that root.
		 *     Only descendants of the named node are valid.
		 * Uses pre-loaded in-memory maps — no DB call.
		 */
		isEnumMember: function(value, roots) {
			if (!roots || roots.length === 0) return true;
			const fromHandle = termsCol + '/' + value;
			const pathSet = enumFromMap.get(fromHandle);
			if (!pathSet) return false;
			for (let i = 0; i < roots.length; i++) {
				const dot = roots[i].indexOf('.');
				if (dot === -1) {
					// Plain root: existing behavior
					if (pathSet.has(termsCol + '/' + roots[i])) return true;
				} else {
					// Compound scope: check root membership then sub-graph ancestry
					const rootHandle = termsCol + '/' + roots[i].slice(0, dot);
					const nodeHandle = termsCol + '/' + roots[i].slice(dot + 1);
					if (!pathSet.has(rootHandle)) continue;
					if (isDescendantOf(fromHandle, nodeHandle, rootHandle)) return true;
				}
			}
			return false;
		},

		/**
		 * Returns true if `gid` is a root of any enumeration. Checks the pre-loaded
		 * edge-derived set first (_term_role_enum-root semantics — has elements); falls
		 * back to _term_role_enum-source for enumerations that have been declared but
		 * not yet populated with any members.
		 */
		isEnumRoot: function(gid) {
			return enumRootSet.has(termsCol + '/' + gid) || this.termHasRole(gid, '_term_role_enum-source');
		},

		/**
		 * Returns true if `node` is a valid branch in the enumeration graph rooted
		 * at `root` — i.e. there is a `_predicate_section-of` or `_predicate_bridge-of`
		 * edge with _from = node whose _path includes the root handle. Used by
		 * `_scope_enum` compound validation to accept `<root>.<branch>` where the
		 * branch is a section grouping or a bridge into another enumeration.
		 * Elements (the leaf-level enum members) are checked via isEnumMember.
		 */
		isEnumBranch: function(node, root) {
			const pathSet = branchFromMap.get(termsCol + '/' + node);
			return pathSet ? pathSet.has(termsCol + '/' + root) : false;
		},

		/**
		 * Returns the constraint object from _path_data[schemaHandle] for the
		 * first property-of edge whose _from matches propGid, or null.
		 * schemaHandle is the full ArangoDB handle of the containing schema term.
		 */
		getPropertyRules: function(propGid, schemaHandle) {
			const edges = propertyOfRules.get(termsCol + '/' + propGid);
			if (!edges) return null;
			for (let i = 0; i < edges.length; i++) {
				const rule = edges[i].d[schemaHandle];
				if (rule) return rule;
			}
			return null;
		},

		/**
		 * Returns the constraint object from _path_data[schemaHandle] for the
		 * first value-of edge where _from = valueGid and _to = propGid, or null.
		 */
		getValueRules: function(valueGid, propGid, schemaHandle) {
			const mapKey = termsCol + '/' + valueGid + '|' + termsCol + '/' + propGid;
			const edges  = valueOfRules.get(mapKey);
			if (!edges) return null;
			for (let i = 0; i < edges.length; i++) {
				const rule = edges[i].d[schemaHandle];
				if (rule) return rule;
			}
			return null;
		},

		/**
		 * Returns a map of { propertyName → rule } for _path_data entries whose
		 * key matches schemaHandle + ".<propertyName>" (target-scoped rules).
		 * Used to apply sub-property rules activated by a _predicate_value-of trigger.
		 */
		getValueRuleTargets: function(valueGid, propGid, schemaHandle) {
			const mapKey = termsCol + '/' + valueGid + '|' + termsCol + '/' + propGid;
			const edges  = valueOfRules.get(mapKey);
			const targets = {};
			if (!edges) return targets;
			const prefix = schemaHandle + '.';
			for (let i = 0; i < edges.length; i++) {
				for (const k in edges[i].d) {
					if (k.indexOf(prefix) === 0) {
						const propName = k.slice(prefix.length);
						if (!targets[propName]) targets[propName] = edges[i].d[k];
					}
				}
			}
			return targets;
		},

		/** Returns the full ArangoDB handle (collection/gid) for a term GID. */
		makeHandle: function(gid) {
			return termsCol + '/' + gid;
		},
	};
}

module.exports = makeDbAccess;
