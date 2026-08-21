'use strict';

/**
 * types/boolean.js — Validator for _boolean.
 *
 * _boolean accepts no companion properties.
 */

const { ErrorCode, makeError } = require('../errors');

/**
 * Validate a value against the _boolean scalar type.
 *
 * @param {*}        value  - The value to validate.
 * @param {Object}   schema - Companion properties (expected to be empty {}).
 * @param {string[]} path   - Current dot-path for error location.
 * @returns {Object[]} Array of error objects (empty = valid).
 */
function validateBoolean(value, schema, path) {
	if (typeof value !== 'boolean') {
		return [makeError(
			ErrorCode.WRONG_TYPE, path, value, 'boolean',
			`Expected true or false, got ${typeof value}`
		)];
	}
	return [];
}

module.exports = { validateBoolean };
