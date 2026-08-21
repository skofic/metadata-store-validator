'use strict';

/**
 * metadata-store-validator — public entry point.
 *
 *   const { validateValue, validateDocument, validateFile,
 *           validateByDictionary, validateConformance } = require('metadata-store-validator');
 *
 * Also exposed for tooling that needs them (loaders, the CLI, Foxx adapters):
 *   compute      — computeTermCode / computeEdgeKey / computeBlobKey / applyCompute …
 *   ANCHOR       — the three type-vocabulary anchor GIDs the engine reads by name
 *   errors       — ErrorCode table + makeError
 *   makeDbAccess — the Node (HTTP) dbAccess adapter; requires the optional
 *                  `sync-request` dependency, so it is exported lazily.
 */

const lib      = require('./lib');
const compute  = require('./lib/compute');
const errors   = require('./lib/errors');
const { ANCHOR } = require('./lib/type-registry');

module.exports = Object.assign({}, lib, {
	compute,
	errors,
	ANCHOR,
	get makeDbAccess() { return require('./db/db-access'); },
});
