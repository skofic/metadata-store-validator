'use strict';

/**
 * md5.js — MD5 hex digest, portable across Node and ArangoDB Foxx.
 *
 * compute.js derives edge and blob `_key` values as LOWER(MD5(...)), matching
 * the AQL the loader uses. Node provides `crypto`; Foxx does not, but exposes
 * the same digest through `@arangodb/crypto`. This is the only place the two
 * runtimes differ, so it is isolated here.
 *
 * @param {string} s
 * @returns {string} lowercase hex MD5 of `s`
 */

let md5;
try {
	const crypto = require('crypto');
	md5 = function (s) { return crypto.createHash('md5').update(s).digest('hex'); };
} catch (_) {
	const acrypto = require('@arangodb/crypto');
	md5 = function (s) { return String(acrypto.md5(s)).toLowerCase(); };
}

module.exports = { md5 };
