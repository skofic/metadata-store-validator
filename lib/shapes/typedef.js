'use strict';

/**
 * shapes/typedef.js — Validator for the _typedef data shape.
 *
 * _typedef holds the _gid of a typedef term. The validator fetches that
 * term from the DB, reads its _data section, and validates recursively.
 *
 * Typedef chaining (_typedef referencing another _typedef) is prohibited
 * by the data model and is not followed here — one level of lookup only.
 *
 * DB access: required. The dbAccess object must implement:
 *   getTerm(gid) → { _data: {...} } | null
 */

const { ErrorCode, makeError } = require('../errors');

/**
 * Validate a value against a _typedef schema.
 *
 * @param {*}        value      - The value to validate.
 * @param {string}   typedefGid - The _gid of the typedef term.
 * @param {string[]} path       - Current dot-path for error location.
 * @param {Object}   dbAccess   - DB accessor (may be null — skips check).
 * @param {Object}   opts       - Options: { coerce: boolean }.
 * @returns {{ errors: Object[], coercions: Object[] }}
 */
function validateTypedef(value, typedefGid, path, dbAccess, opts) {
	if (!dbAccess) {
		// Cannot resolve without DB — skip silently
		return { errors: [], coercions: [] };
	}

	if (typeof typedefGid !== 'string' || typedefGid === '') {
		return {
			errors: [makeError(
				ErrorCode.INVALID_TYPEDEF, path, typedefGid, 'non-empty string (_gid)',
				'_typedef value must be a non-empty string'
			)],
			coercions: [],
		};
	}

	const term = dbAccess.getTerm(typedefGid);
	if (!term) {
		return {
			errors: [makeError(
				ErrorCode.TYPEDEF_NOT_FOUND, path, typedefGid, 'existing term _gid',
				`Typedef term "${typedefGid}" was not found in the dictionary`
			)],
			coercions: [],
		};
	}

	if (!term._data || typeof term._data !== 'object') {
		return {
			errors: [makeError(
				ErrorCode.INVALID_TYPEDEF, path, typedefGid, 'term with a _data section',
				`Typedef term "${typedefGid}" has no usable _data section`
			)],
			coercions: [],
		};
	}

	// One level only — validate against the typedef's own _data section
	const { validateData } = require('../validate'); // lazy require
	return validateData(value, term._data, path, dbAccess, opts);
}

module.exports = { validateTypedef };
