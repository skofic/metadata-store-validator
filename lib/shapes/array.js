'use strict';

/**
 * shapes/array.js — Validator for the _array data shape.
 *
 * _array is an ordered list of same-type elements. Schema structure:
 *   {
 *     _elements: { _min-items: N, _max-items: M },  // optional size constraint
 *     <shape-key>: { ... }                          // element type (one shape key)
 *   }
 *
 * The element may take ANY data shape. Which shapes exist is not decided here —
 * it is read from the _type_shape term via type-registry.js, the same source the
 * _array term's own _required selection is kept in step with.
 *
 * An empty _array ({}) means any array is accepted.
 */

const { ErrorCode, makeError } = require('../errors');
const { shapeKeys }            = require('../type-registry');

/**
 * Validate a value against an _array schema.
 *
 * @param {*}        value       - The value to validate.
 * @param {Object}   arraySchema - The object that is the value of the _array key.
 * @param {string[]} path        - Current dot-path for error location.
 * @param {Object}   dbAccess    - DB accessor (may be null).
 * @param {Object}   opts        - Options: { coerce: boolean }.
 * @returns {{ errors: Object[], coercions: Object[] }}
 */
function validateArray(value, arraySchema, path, dbAccess, opts) {
	const result = { errors: [], coercions: [] };

	if (!Array.isArray(value)) {
		result.errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'array',
			`Expected an array, got ${typeof value}`
		));
		return result;
	}

	if (!arraySchema || typeof arraySchema !== 'object') return result;

	// Size constraints
	const el = arraySchema._elements;
	if (el) {
		if (el['_min-items'] !== undefined && value.length < el['_min-items']) {
			result.errors.push(makeError(
				ErrorCode.MIN_ITEMS, path, value.length,
				`>= ${el['_min-items']} items`,
				`Array has ${value.length} element(s); minimum is ${el['_min-items']}`
			));
		}
		if (el['_max-items'] !== undefined && value.length > el['_max-items']) {
			result.errors.push(makeError(
				ErrorCode.MAX_ITEMS, path, value.length,
				`<= ${el['_max-items']} items`,
				`Array has ${value.length} element(s); maximum is ${el['_max-items']}`
			));
		}
	}

	// Identify element shape key
	const shapeKey = shapeKeys(dbAccess).find(function(k) { return k in arraySchema; });
	if (!shapeKey) return result; // empty → any element type accepted

	const elementSchema = arraySchema[shapeKey];
	const { validateData } = require('../validate'); // lazy require — avoids circular dep

	for (let i = 0; i < value.length; i++) {
		const elResult = validateData(
			value[i],
			{ [shapeKey]: elementSchema },
			[...path, '[' + i + ']'],
			dbAccess, opts
		);
		result.errors.push(...elResult.errors);
		result.coercions.push(...elResult.coercions);
	}

	return result;
}

module.exports = { validateArray };
