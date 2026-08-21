'use strict';

/**
 * types/number.js — Validators for _number, _number_float, _number_integer.
 *
 * Companion properties accepted by number types:
 *   _unit, _unit_name, _unit_symbol  — referenced unit term (not validated here)
 *   _range_valid                     — hard numeric range (RANGE_VIOLATION on breach)
 *   _range_normal                    — expected range (RANGE_OUTLIER on breach)
 *   _decimals                        — accepted by _number and _number_float, not _number_integer
 */

const { ErrorCode, makeError } = require('../errors');
const { checkNumericRange } = require('../ranges');

/**
 * Validate a value against a numeric scalar type.
 *
 * @param {*}        value  - The value to validate.
 * @param {string}   type   - '_number' | '_number_float' | '_number_integer'
 * @param {Object}   schema - Companion properties (value of the type key in _scalar).
 * @param {string[]} path   - Current dot-path for error location.
 * @returns {Object[]} Array of error objects (empty = valid).
 */
function validateNumber(value, type, schema, path) {
	const errors = [];

	if (typeof value !== 'number' || !isFinite(value)) {
		errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'finite number',
			`Expected a finite number, got ${typeof value === 'number' ? 'non-finite number' : typeof value}`
		));
		return errors;
	}

	if (type === '_number_integer' && !Number.isInteger(value)) {
		errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'integer',
			`Expected an integer, got ${value}`
		));
	}

	if (schema._range_valid) {
		errors.push(...checkNumericRange(
			value, schema._range_valid,
			[...path, '_range_valid'], ErrorCode.RANGE_VIOLATION
		));
	}
	if (schema._range_normal) {
		errors.push(...checkNumericRange(
			value, schema._range_normal,
			[...path, '_range_normal'], ErrorCode.RANGE_OUTLIER
		));
	}

	return errors;
}

module.exports = { validateNumber };
