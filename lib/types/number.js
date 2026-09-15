'use strict';

/**
 * types/number.js — Validators for _number, _number_float, _number_integer.
 *
 * Companion properties accepted by number types:
 *   _unit                            — referenced unit term; its _prop.unit_range (a physical
 *                                      bound) is enforced on top of _range_valid (RANGE_VIOLATION)
 *   _unit_name, _unit_symbol         — literal unit labels (not validated)
 *   _range_valid                     — hard numeric range (RANGE_VIOLATION, an error)
 *   _range_normal                    — expected range (RANGE_OUTLIER, reported as a warning —
 *                                      see WARNING_CODES in errors.js)
 *   _decimals                        — display precision; accepted by _number and _number_float,
 *                                      not _number_integer (not a value check)
 */

const { ErrorCode, makeError } = require('../errors');
const { checkNumericRange }    = require('../ranges');
const { unitRangeOf }          = require('../units');

/**
 * Validate a value against a numeric scalar type.
 *
 * @param {*}        value    - The value to validate.
 * @param {string}   type     - '_number' | '_number_float' | '_number_integer'
 * @param {Object}   schema   - Companion properties (value of the type key in _scalar).
 * @param {string[]} path     - Current dot-path for error location.
 * @param {Object}   dbAccess - DB accessor (may be null — the unit bound is then not checked).
 * @returns {Object[]} Findings (empty = valid). RANGE_OUTLIER entries are warnings;
 *                     the public entry points separate them.
 */
function validateNumber(value, type, schema, path, dbAccess) {
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

	// The unit's physical bound applies in addition to _range_valid; checking
	// both enforces their intersection.
	const unitRange = unitRangeOf(schema._unit, dbAccess);
	if (unitRange) {
		errors.push(...checkNumericRange(
			value, unitRange,
			[...path, 'unit_range'], ErrorCode.RANGE_VIOLATION,
			`physical bound of unit "${schema._unit}"`
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
