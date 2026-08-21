'use strict';

/**
 * shapes/tuple.js — Validator for the _tuple data shape.
 *
 * _tuple is an ordered positional array where each position is defined by
 * a full _data section. The schema is itself an array of _data objects:
 *
 *   "_tuple": [
 *     { "_scalar": { "_string_date": {} } },
 *     { "_scalar": { "_number_float": { "_unit": "_unit_weight_kg" } } },
 *     { "_scalar": { "_enum": { "_enums": ["ISO_639_3"] } } }
 *   ]
 *
 * The number of elements in the value must match the number of positions
 * defined in the schema.
 */

const { ErrorCode, makeError } = require('../errors');

/**
 * Validate a value against a _tuple schema.
 *
 * @param {*}        value       - The value to validate.
 * @param {Array}    tupleSchema - Array of _data section objects, one per position.
 * @param {string[]} path        - Current dot-path for error location.
 * @param {Object}   dbAccess    - DB accessor (may be null).
 * @param {Object}   opts        - Options: { coerce: boolean }.
 * @returns {{ errors: Object[], coercions: Object[] }}
 */
function validateTuple(value, tupleSchema, path, dbAccess, opts) {
	const result = { errors: [], coercions: [] };

	if (!Array.isArray(value)) {
		result.errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'array (tuple)',
			`Expected an array for _tuple, got ${typeof value}`
		));
		return result;
	}

	if (!Array.isArray(tupleSchema) || tupleSchema.length === 0) return result;

	if (value.length !== tupleSchema.length) {
		result.errors.push(makeError(
			ErrorCode.SELECTION_VIOLATION, path, value.length,
			`exactly ${tupleSchema.length} element(s)`,
			`Tuple must have exactly ${tupleSchema.length} element(s); got ${value.length}`
		));
		// Still validate what we can
	}

	const { validateData } = require('../validate'); // lazy require

	const count = Math.min(value.length, tupleSchema.length);
	for (let i = 0; i < count; i++) {
		const elResult = validateData(
			value[i], tupleSchema[i],
			[...path, '[' + i + ']'],
			dbAccess, opts
		);
		result.errors.push(...elResult.errors);
		result.coercions.push(...elResult.coercions);
	}

	return result;
}

module.exports = { validateTuple };
