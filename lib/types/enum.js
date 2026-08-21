'use strict';

/**
 * types/enum.js — Validator for the _enum scalar type.
 *
 * _enum expects a string value that is the _gid of an enumeration element.
 * The _enums companion property (array of root _gids) restricts which
 * controlled vocabularies the value may belong to.
 *
 * DB access: required when _enums is present. The dbAccess object must
 * implement isEnumMember(value, roots) → boolean.
 */

const { ErrorCode, makeError } = require('../errors');

/**
 * Validate a value against the _enum scalar type.
 *
 * @param {*}        value    - The value to validate.
 * @param {Object}   schema   - Companion properties ({ _enums: [...] }).
 * @param {string[]} path     - Current dot-path for error location.
 * @param {Object}   dbAccess - DB accessor (may be null in dry-run or test contexts).
 * @returns {Object[]} Array of error objects (empty = valid).
 */
function validateEnum(value, schema, path, dbAccess) {
	const errors = [];

	if (typeof value !== 'string' || value === '') {
		errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'non-empty string (_gid)',
			`Expected a non-empty string (term _gid) for _enum, got ${typeof value}`
		));
		return errors;
	}

	// Schema-author guard: _enums must be an array of enumeration root _gid
	// strings. Catching this here gives a clear message instead of crashing
	// later on schema._enums.join() / .length.
	if (schema._enums !== undefined && !Array.isArray(schema._enums)) {
		errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value,
			'array of enumeration root _gid strings in schema._enums',
			`Schema error: _enums must be an array, got ${typeof schema._enums} (${JSON.stringify(schema._enums)}). Wrap a single root in brackets, e.g. ["ISO_3166_1"].`
		));
		return errors;
	}

	// Skip vocabulary check when no constraint or no DB access
	if (!schema._enums || schema._enums.length === 0 || !dbAccess) return errors;

	if (!dbAccess.isEnumMember(value, schema._enums)) {
		errors.push(makeError(
			ErrorCode.INVALID_ENUM, path, value,
			`member of [${schema._enums.join(', ')}]`,
			`"${value}" is not a member of the expected controlled vocabular${schema._enums.length === 1 ? 'y' : 'ies'}: ${schema._enums.join(', ')}`
		));
	}

	return errors;
}

module.exports = { validateEnum };
