'use strict';

/**
 * metadata-store-validator — public entry point.
 *
 *   const { validateValue, validateDocument, validateFile,
 *           validateByDictionary, validateConformance } = require('metadata-store-validator');
 *
 * Also exposed for tooling that needs them (loaders, the CLI, Foxx adapters):
 *   compute      — applyComputed / checkComputeRegistry, plus the historical
 *                  computeTermCode / computeEdgeKey / computeBlobKey wrappers
 *   computeRegistry — the per-schema compute functions behind `_computed`
 *   ANCHOR       — the three type-vocabulary anchor GIDs the engine reads by name
 *   errors       — ErrorCode table + makeError
 *   makeDbAccess — the Node (HTTP) dbAccess adapter; requires the optional
 *                  `sync-request` dependency, so it is exported lazily.
 */

const lib      = require('./lib');
const compute  = require('./lib/compute');
const computeRegistry = require('./lib/compute-registry');
const errors   = require('./lib/errors');
const { ANCHOR } = require('./lib/type-registry');

const api = Object.assign({}, lib, { compute, computeRegistry, errors, ANCHOR });

// Lazy: `db/db-access.js` pulls in the optional `sync-request` dependency, which
// Foxx bundles omit. A getter on the exports object keeps it out of the load
// path until a caller actually asks for it. (Not via Object.assign — that
// would read the getter eagerly.)
Object.defineProperty(api, 'makeDbAccess', {
	enumerable: true,
	get() { return require('./db/db-access'); },
});

// Lazy for the same reason: the snapshot builder and the fetch-based query
// function are Node-side tools that Foxx never needs.
Object.defineProperty(api, 'buildSnapshot', {
	enumerable: true,
	get() { return require('./db/snapshot-builder').buildSnapshot; },
});
Object.defineProperty(api, 'makeHttpQuery', {
	enumerable: true,
	get() { return require('./db/http-query').makeHttpQuery; },
});

module.exports = api;
