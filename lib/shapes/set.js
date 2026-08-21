'use strict';

/**
 * shapes/set.js — Validator for the _set data shape.
 *
 * _set is an unordered array of unique, comparable elements. Schema structure:
 *   {
 *     <type-key>: { ...companions },  // element type (same keys as _scalar)
 *     _elements: { _min-items: N, _max-items: M }  // optional
 *   }
 *
 * An empty _set ({}) means any set (array of comparable values) is accepted.
 * Uniqueness is enforced by JSON-serialising each element.
 */

const { ErrorCode, makeError } = require('../errors');
const { validateScalar }       = require('./scalar');

/**
 * Validate a value against a _set schema.
 *
 * @param {*}        value     - The value to validate.
 * @param {Object}   setSchema - The object that is the value of the _set key.
 * @param {string[]} path      - Current dot-path for error location.
 * @param {Object}   dbAccess  - DB accessor (may be null).
 * @param {Object}   opts      - Options: { coerce: boolean }.
 * @returns {{ errors: Object[], coercions: Object[] }}
 */
function validateSet(value, setSchema, path, dbAccess, opts) {
	const result = { errors: [], coercions: [] };

	if (!Array.isArray(value)) {
		result.errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'array (set)',
			`Expected an array for _set, got ${typeof value}`
		));
		return result;
	}

	// Separate container-level companions (_elements, _layout_list) from the
	// element type schema. _layout_list is a shape-level display hint, not the
	// element type — leaving it in would put a non-type key in the type schema.
	const el         = setSchema ? setSchema._elements : null;
	const typeSchema = {};
	for (const key of Object.keys(setSchema || {})) {
		if (key !== '_elements' && key !== '_layout_list') typeSchema[key] = setSchema[key];
	}

	// Size constraints
	if (el) {
		if (el['_min-items'] !== undefined && value.length < el['_min-items']) {
			result.errors.push(makeError(
				ErrorCode.MIN_ITEMS, path, value.length,
				`>= ${el['_min-items']} items`,
				`Set has ${value.length} element(s); minimum is ${el['_min-items']}`
			));
		}
		if (el['_max-items'] !== undefined && value.length > el['_max-items']) {
			result.errors.push(makeError(
				ErrorCode.MAX_ITEMS, path, value.length,
				`<= ${el['_max-items']} items`,
				`Set has ${value.length} element(s); maximum is ${el['_max-items']}`
			));
		}
	}

	// Uniqueness check — sets are by definition unordered collections of
	// distinct elements. Reports each duplicate with the position of the
	// first earlier occurrence so the author can see which pairs collide.
	const seen = Object.create(null);
	for (let i = 0; i < value.length; i++) {
		const key = JSON.stringify(value[i]);
		if (key in seen) {
			result.errors.push(makeError(
				ErrorCode.DUPLICATE_VALUE, [...path, '[' + i + ']'], value[i],
				'unique value',
				`Duplicate element at index ${i}: ${key} (first seen at index ${seen[key]})`
			));
		} else {
			seen[key] = i;
		}
	}

	// Element type validation (reuse scalar dispatcher)
	if (Object.keys(typeSchema).length > 0) {
		for (let i = 0; i < value.length; i++) {
			const elResult = validateScalar(
				value[i], typeSchema,
				[...path, '[' + i + ']'],
				dbAccess, opts
			);
			result.errors.push(...elResult.errors);
			result.coercions.push(...elResult.coercions);
		}
	}

	return result;
}

module.exports = { validateSet };
