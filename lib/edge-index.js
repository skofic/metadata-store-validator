'use strict';

/**
 * edge-index.js — The in-memory half of a dbAccess: enumeration and rule-edge
 * lookups over pre-loaded edge rows.
 *
 * Pure (no network, no file system). Both Node adapters build on it:
 *   - db/db-access.js     fetches the rows live at startup (sync-request),
 *   - lib/snapshot.js     takes them from a pre-built dictionary snapshot,
 * so the two can never disagree on what membership or a rule means.
 *
 * Input rows keep the shapes returned by db/queries:
 *   enumEdges        [{ f, t, p, pred }]   _predicate_enum-of / bridge-of / section-of
 *   propertyOfRules  [{ f, d }]            property-of edges with non-empty _path_data
 *   valueOfRules     [{ f, t, d }]         value-of edges with non-empty _path_data
 */

/**
 * Build a dbAccess from a term lookup and pre-loaded edge rows.
 *
 * @param {Object}   parts
 * @param {Function} parts.getTerm          - gid → term document | null (may throw).
 * @param {Object[]} parts.enumEdges        - enum-of / bridge-of / section-of rows.
 * @param {Object[]} parts.propertyOfRules  - property-of rule rows.
 * @param {Object[]} parts.valueOfRules     - value-of rule rows.
 * @param {string}   [parts.termsCol]       - Terms collection name (default 'terms').
 * @returns {Object} A dbAccess implementing the full contract.
 */
function makeEdgeBackedAccess(parts) {
	const getTerm  = parts.getTerm;
	const termsCol = parts.termsCol || 'terms';

	// Enumeration maps:
	//   enumFromMap:   fromHandle → Set<pathHandle>  (member lookup; enum-of only)
	//   enumRootSet:   all handles that appear as a path root in any of the three predicates
	//   parentMap:     fromHandle → Map<rootHandle, Set<toHandle>>  (parent lookup for sub-graph checks; enum-of only)
	//   branchFromMap: fromHandle → Set<pathHandle>  (valid branch terms in the root's graph;
	//                                                 section-of OR bridge-of edges, used by
	//                                                 isEnumBranch for _scope_enum compounds)
	const enumFromMap   = new Map();
	const enumRootSet   = new Set();
	const parentMap     = new Map();
	const branchFromMap = new Map();

	for (const row of parts.enumEdges || []) {
		const p = row.p || [];
		for (let j = 0; j < p.length; j++) enumRootSet.add(p[j]);
		// Only enum-of edges contribute to member lookup (bridge nodes are not members)
		if (row.pred === '_predicate_enum-of') {
			const f = row.f;
			const t = row.t;
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
		} else if (row.pred === '_predicate_section-of' || row.pred === '_predicate_bridge-of') {
			// Both sections and bridges are valid branches for _scope_enum
			// compound values: a section groups elements under a heading; a
			// bridge points into another graph whose elements are reachable
			// through the root. Neither is a selectable enum member itself,
			// but both can name a sub-scope inside the enumeration.
			const f = row.f;
			if (!branchFromMap.has(f)) {
				branchFromMap.set(f, new Set(p));
			} else {
				const s = branchFromMap.get(f);
				for (let j = 0; j < p.length; j++) s.add(p[j]);
			}
		}
	}

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

	// Property-of rules: fromHandle → edge data array.
	const propertyOfRules = new Map();
	for (const row of parts.propertyOfRules || []) {
		if (!propertyOfRules.has(row.f)) propertyOfRules.set(row.f, [row]);
		else                             propertyOfRules.get(row.f).push(row);
	}

	// Value-of rules: fromHandle + "|" + toHandle → edge data array.
	const valueOfRules = new Map();
	for (const row of parts.valueOfRules || []) {
		const key = row.f + '|' + row.t;
		if (!valueOfRules.has(key)) valueOfRules.set(key, [row]);
		else                        valueOfRules.get(key).push(row);
	}

	const access = {
		/** Returns the full term document for the given _gid, or null if not found. */
		getTerm: getTerm,

		/** Returns true if a term with the given _gid exists in the dictionary. */
		termExists: function(gid) {
			return access.getTerm(gid) !== null;
		},

		/** Returns true if the term has `role` in its _domn._term_role array. */
		termHasRole: function(gid, role) {
			const term = access.getTerm(gid);
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
		 */
		isEnumMember: function(value, roots) {
			if (!roots || roots.length === 0) return true;
			const fromHandle = termsCol + '/' + value;
			const pathSet = enumFromMap.get(fromHandle);
			if (!pathSet) return false;
			for (let i = 0; i < roots.length; i++) {
				const dot = roots[i].indexOf('.');
				if (dot === -1) {
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
			return enumRootSet.has(termsCol + '/' + gid) || access.termHasRole(gid, '_term_role_enum-source');
		},

		/**
		 * Returns true if `node` is a valid branch in the enumeration graph rooted
		 * at `root` — i.e. there is a `_predicate_section-of` or `_predicate_bridge-of`
		 * edge with _from = node whose _path includes the root handle.
		 */
		isEnumBranch: function(node, root) {
			const pathSet = branchFromMap.get(termsCol + '/' + node);
			return pathSet ? pathSet.has(termsCol + '/' + root) : false;
		},

		/**
		 * Returns the constraint object from _path_data[schemaHandle] for the
		 * first property-of edge whose _from matches propGid, or null.
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
			const edges = valueOfRules.get(termsCol + '/' + valueGid + '|' + termsCol + '/' + propGid);
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
		 */
		getValueRuleTargets: function(valueGid, propGid, schemaHandle) {
			const edges   = valueOfRules.get(termsCol + '/' + valueGid + '|' + termsCol + '/' + propGid);
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

	return access;
}

module.exports = { makeEdgeBackedAccess };
