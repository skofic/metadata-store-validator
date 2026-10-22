'use strict';

/**
 * snapshot.js — A synchronous dbAccess over a pre-fetched dictionary snapshot.
 *
 * For bulk validation (data pipelines) the live Node adapter is the wrong tool:
 * it makes a blocking HTTP call per new term. A snapshot holds just the terms
 * and edges a run needs, fetched once (db/snapshot-builder.js), and answers
 * every lookup from memory. It is plain JSON, so a run can also keep it as the
 * record of the dictionary its data was checked against.
 *
 * Snapshot shape (version 1):
 *
 *   {
 *     version: 1,
 *     termsCol: 'terms',
 *     source:  { host, database },      // informative
 *     builtAt: '2026-09-15T…Z',         // informative
 *     terms:   { <gid>: termDoc | null },   // null = looked up, not in the dictionary
 *     missing: [ <gid>, … ],                 // requested gids with no term
 *     enumEdges:       [ { f, t, p, pred } ],
 *     propertyOfRules: [ { f, d } ],
 *     valueOfRules:    [ { f, t, d } ]
 *   }
 *
 * A lookup for a gid that was never requested THROWS by default: a snapshot
 * that silently answered "not found" would make an incomplete snapshot look like
 * bad data (or, for the type vocabularies, quietly narrow what is checked).
 * `{ onMiss: 'null' }` opts into treating unknown gids as absent terms.
 *
 * Pure: no network, no file system.
 */

const { makeEdgeBackedAccess } = require('./edge-index');
const { ANCHOR }               = require('./type-registry');

/**
 * @param {Object} snapshot           - A snapshot object (see above).
 * @param {Object} [options]
 * @param {string} [options.onMiss]   - 'throw' (default) or 'null'.
 * @returns {Object} A dbAccess implementing the full contract.
 */
function makeSnapshotDbAccess(snapshot, options) {
	if (!snapshot || typeof snapshot !== 'object' || !snapshot.terms || typeof snapshot.terms !== 'object') {
		throw new TypeError('makeSnapshotDbAccess: expected a snapshot object with a `terms` map');
	}
	if (snapshot.version !== undefined && snapshot.version !== 1) {
		throw new Error('makeSnapshotDbAccess: unsupported snapshot version ' + snapshot.version);
	}
	const onMiss = (options && options.onMiss) || 'throw';
	if (onMiss !== 'throw' && onMiss !== 'null') {
		throw new TypeError("makeSnapshotDbAccess: options.onMiss must be 'throw' or 'null'");
	}

	const terms = snapshot.terms;

	// The type vocabularies are read from these terms. Were one absent, the
	// registry would quietly fall back to the code's built-in lists.
	for (const gid of Object.values(ANCHOR)) {
		if (!terms[gid]) {
			throw new Error('makeSnapshotDbAccess: the snapshot lacks the type-vocabulary anchor term "' + gid +
				'"; build it with buildSnapshot(), which always includes the anchors');
		}
	}

	function getTerm(gid) {
		if (Object.prototype.hasOwnProperty.call(terms, gid)) return terms[gid];
		if (onMiss === 'null') return null;
		throw new Error('Dictionary snapshot has no entry for "' + gid + '": it was not among the terms ' +
			'requested when the snapshot was built. Add it to the gids given to buildSnapshot(), or create ' +
			"the accessor with { onMiss: 'null' } to treat unknown gids as absent terms.");
	}

	return makeEdgeBackedAccess({
		getTerm,
		termsCol:        snapshot.termsCol || 'terms',
		enumEdges:       snapshot.enumEdges || [],
		propertyOfRules: snapshot.propertyOfRules || [],
		valueOfRules:    snapshot.valueOfRules || [],
		// Optional (snapshots built before v1.3.0 lack them): without them the
		// accessor answers null to the _term_role facts and roles stay as stored.
		namespaces:      snapshot.namespaces,
		predicates:      snapshot.predicates,
		enumSources:     snapshot.enumSources,
	});
}

module.exports = { makeSnapshotDbAccess };
