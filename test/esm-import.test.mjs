// esm-import.test.mjs — the package is CommonJS; ESM consumers (such as
// metadata-external-databases) load it with createRequire or a default import.
// Named imports (`import { validateProperties } from …`) are NOT supported: the
// entry point builds its exports dynamically.
//
//   node test/esm-import.test.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import pkg from '../index.js';

const require = createRequire(import.meta.url);
const viaRequire = require('../index.js');

for (const api of [viaRequire, pkg]) {
	for (const name of [
		'validateValue', 'validateByDictionary', 'validateProperties',
		'describeEnvelopeNeeds', 'validateEnvelope', 'createReport',
		'checkUnitBounds', 'makeSnapshotDbAccess', 'buildSnapshot', 'makeHttpQuery',
	]) {
		assert.equal(typeof api[name], 'function', name + ' is exported');
	}
}

console.log('esm-import.test.mjs: createRequire and default import both work');
