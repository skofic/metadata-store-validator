'use strict';

/**
 * shapes/nested.js — Validator for the _nested data shape.
 *
 * _nested is a recursively nested array whose leaves are comparable scalar
 * values (set semantics — comparable types only). The schema contains a
 * single type key exactly as in _scalar:
 *
 *   "_nested": { "_string": {} }
 *
 * The validator descends into every array element. Non-array elements are
 * treated as leaf values and validated against the scalar type.
 */

const { ErrorCode, makeError } = require('../errors');
const { validateScalar }       = require('./scalar');

/**
 * Validate a value against a _nested schema.
 *
 * @param {*}        value        - The value to validate.
 * @param {Object}   nestedSchema - The object that is the value of the _nested key.
 * @param {string[]} path         - Current dot-path for error location.
 * @param {Object}   dbAccess     - DB accessor (may be null).
 * @param {Object}   opts         - Options: { coerce: boolean }.
 * @returns {{ errors: Object[], coercions: Object[] }}
 */
function validateNested(value, nestedSchema, path, dbAccess, opts) {
	const result = { errors: [], coercions: [] };

	if (!Array.isArray(value)) {
		result.errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'array (nested)',
			`Expected an array for _nested, got ${typeof value}`
		));
		return result;
	}

	for (let i = 0; i < value.length; i++) {
		const item    = value[i];
		const itemPath = [...path, '[' + i + ']'];

		if (Array.isArray(item)) {
			// Recurse into nested array
			const subResult = validateNested(item, nestedSchema, itemPath, dbAccess, opts);
			result.errors.push(...subResult.errors);
			result.coercions.push(...subResult.coercions);
		} else {
			// Leaf: validate as scalar
			const leafResult = validateScalar(item, nestedSchema, itemPath, dbAccess, opts);
			result.errors.push(...leafResult.errors);
			result.coercions.push(...leafResult.coercions);
		}
	}

	return result;
}

module.exports = { validateNested };
