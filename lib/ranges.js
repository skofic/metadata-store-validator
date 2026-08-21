'use strict';

/**
 * ranges.js — Shared numeric and string range validation.
 *
 * Used by number types (_number, _number_float, _number_integer, _timestamp)
 * and string types (_string, _string_YMD, _string_date, etc.).
 *
 * Numeric range keys: _min-inclusive, _min-exclusive, _max-inclusive, _max-exclusive
 * String range keys:  _string_min-inclusive, _string_min-exclusive,
 *                     _string_max-inclusive, _string_max-exclusive
 */

const { makeError } = require('./errors');

/**
 * Validate a numeric value against a range object.
 *
 * @param {number}   value     - The numeric value to check.
 * @param {Object}   rangeObj  - Range constraint object from the schema.
 * @param {string[]} path      - Current dot-path (for error location).
 * @param {string}   errorCode - ErrorCode.RANGE_VIOLATION or ErrorCode.RANGE_OUTLIER.
 * @returns {Object[]} Array of error objects (empty = within range).
 */
function checkNumericRange(value, rangeObj, path, errorCode) {
	const errors = [];
	if (!rangeObj || typeof rangeObj !== 'object') return errors;

	if ('_min-inclusive' in rangeObj && value < rangeObj['_min-inclusive']) {
		errors.push(makeError(
			errorCode, path, value,
			`>= ${rangeObj['_min-inclusive']}`,
			`Value ${value} is below the minimum of ${rangeObj['_min-inclusive']} (inclusive)`
		));
	}
	if ('_min-exclusive' in rangeObj && value <= rangeObj['_min-exclusive']) {
		errors.push(makeError(
			errorCode, path, value,
			`> ${rangeObj['_min-exclusive']}`,
			`Value ${value} must be greater than ${rangeObj['_min-exclusive']} (exclusive)`
		));
	}
	if ('_max-inclusive' in rangeObj && value > rangeObj['_max-inclusive']) {
		errors.push(makeError(
			errorCode, path, value,
			`<= ${rangeObj['_max-inclusive']}`,
			`Value ${value} exceeds the maximum of ${rangeObj['_max-inclusive']} (inclusive)`
		));
	}
	if ('_max-exclusive' in rangeObj && value >= rangeObj['_max-exclusive']) {
		errors.push(makeError(
			errorCode, path, value,
			`< ${rangeObj['_max-exclusive']}`,
			`Value ${value} must be less than ${rangeObj['_max-exclusive']} (exclusive)`
		));
	}

	return errors;
}

/**
 * Validate a string value against a string range object (lexicographic comparison).
 *
 * @param {string}   value     - The string value to check.
 * @param {Object}   rangeObj  - Range constraint object from the schema.
 * @param {string[]} path      - Current dot-path (for error location).
 * @param {string}   errorCode - ErrorCode.RANGE_VIOLATION or ErrorCode.RANGE_OUTLIER.
 * @returns {Object[]} Array of error objects (empty = within range).
 */
function checkStringRange(value, rangeObj, path, errorCode) {
	const errors = [];
	if (!rangeObj || typeof rangeObj !== 'object') return errors;

	if ('_string_min-inclusive' in rangeObj && value < rangeObj['_string_min-inclusive']) {
		errors.push(makeError(
			errorCode, path, value,
			`>= "${rangeObj['_string_min-inclusive']}"`,
			`"${value}" is below the minimum "${rangeObj['_string_min-inclusive']}" (inclusive)`
		));
	}
	if ('_string_min-exclusive' in rangeObj && value <= rangeObj['_string_min-exclusive']) {
		errors.push(makeError(
			errorCode, path, value,
			`> "${rangeObj['_string_min-exclusive']}"`,
			`"${value}" must be greater than "${rangeObj['_string_min-exclusive']}" (exclusive)`
		));
	}
	if ('_string_max-inclusive' in rangeObj && value > rangeObj['_string_max-inclusive']) {
		errors.push(makeError(
			errorCode, path, value,
			`<= "${rangeObj['_string_max-inclusive']}"`,
			`"${value}" exceeds the maximum "${rangeObj['_string_max-inclusive']}" (inclusive)`
		));
	}
	if ('_string_max-exclusive' in rangeObj && value >= rangeObj['_string_max-exclusive']) {
		errors.push(makeError(
			errorCode, path, value,
			`< "${rangeObj['_string_max-exclusive']}"`,
			`"${value}" must be less than "${rangeObj['_string_max-exclusive']}" (exclusive)`
		));
	}

	return errors;
}

module.exports = { checkNumericRange, checkStringRange };
