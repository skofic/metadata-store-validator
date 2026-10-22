'use strict';

/**
 * md5.js — MD5 hex digest, portable across Node and ArangoDB Foxx.
 *
 * compute-registry.js derives edge, link and blob `_key` values as
 * LOWER(MD5(...)), matching the AQL the loader uses. Node provides `crypto`
 * with createHash; Foxx resolves `require('crypto')` too, but to a module
 * WITHOUT createHash — so the test is on the function, not on the require —
 * and exposes the same digest through `@arangodb/crypto`. This is the only
 * place the two runtimes differ, so it is isolated here.
 *
 * @param {string} s
 * @returns {string} lowercase hex MD5 of `s`
 */

let md5 = null;
try {
	const crypto = require('crypto');
	if (crypto && typeof crypto.createHash === 'function') {
		md5 = function (s) { return crypto.createHash('md5').update(s).digest('hex'); };
	}
} catch (_) { /* no Node crypto */ }
if (!md5) {
	const acrypto = require('@arangodb/crypto');
	md5 = function (s) { return String(acrypto.md5(s)).toLowerCase(); };
}

module.exports = { md5 };
