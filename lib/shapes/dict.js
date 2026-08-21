'use strict';

/**
 * shapes/dict.js — Validator for the _dict data shape.
 *
 * _dict is a key/value dictionary. Schema structure:
 *   {
 *     _dict_key:   { <type-key>: { ...companions } },  // key type (comparable types only)
 *     _dict_value: { <shape-key>: { ... } }            // value type (any _data section)
 *   }
 *
 * Both _dict_key and _dict_value must be present in a well-formed schema.
 * An empty _dict_value ({}) means values may be of any type.
 */

const { ErrorCode, makeError } = require('../errors');
const { validateScalar }       = require('./scalar');
const { keyTypes }             = require('../type-registry');

/**
 * Check that the type declared in _dict_key is one the dictionary lists as
 * key-eligible. This is a schema-side check — it faults the descriptor, not the
 * data — so it runs once per _dict rather than once per key.
 *
 * The eligible set comes from the _type_key term. It is deliberately narrower
 * than _type_scalar: numbers, booleans, timestamps, patterns and the text family
 * are all valid scalars but cannot serve as dictionary keys.
 *
 * @param {Object}   keySchema - The _dict_key body, e.g. { _string: {} }.
 * @param {string[]} path      - Current dot-path for error location.
 * @param {Object}   dbAccess  - DB accessor (may be null).
 * @returns {Object[]} errors
 */
function checkKeyType(keySchema, path, dbAccess) {
	const eligible = keyTypes(dbAccess);

	// Without the dictionary we cannot know which types are key-eligible —
	// that is a dictionary decision, not something the code can infer. Skip
	// rather than guess.
	if (!eligible) return [];

	const errors = [];
	for (const declared of Object.keys(keySchema)) {
		if (eligible.has(declared)) continue;
		errors.push(makeError(
			ErrorCode.INVALID_KEY_TYPE, [...path, '_dict_key'], declared,
			'a key-eligible scalar type',
			`"${declared}" cannot be a dictionary key type. _type_key lists the eligible types; ` +
			`numbers, booleans, timestamps, patterns and the text family are excluded.`
		));
	}
	return errors;
}

/**
 * Validate a value against a _dict schema.
 *
 * @param {*}        value      - The value to validate.
 * @param {Object}   dictSchema - The object that is the value of the _dict key.
 * @param {string[]} path       - Current dot-path for error location.
 * @param {Object}   dbAccess   - DB accessor (may be null).
 * @param {Object}   opts       - Options: { coerce: boolean }.
 * @returns {{ errors: Object[], coercions: Object[] }}
 */
function validateDict(value, dictSchema, path, dbAccess, opts) {
	const result = { errors: [], coercions: [] };

	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		result.errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'object (dict)',
			`Expected an object for _dict, got ${Array.isArray(value) ? 'array' : typeof value}`
		));
		return result;
	}

	if (!dictSchema) return result;

	const keySchema   = dictSchema._dict_key;
	const valueSchema = dictSchema._dict_value;
	const { validateData } = require('../validate'); // lazy require

	if (keySchema && typeof keySchema === 'object') {
		result.errors.push(...checkKeyType(keySchema, path, dbAccess));
	}

	for (const [k, v] of Object.entries(value)) {
		// Validate key type
		if (keySchema && typeof keySchema === 'object') {
			const keyResult = validateScalar(k, keySchema, [...path, k, '(key)'], dbAccess, opts);
			result.errors.push(...keyResult.errors);
			result.coercions.push(...keyResult.coercions);
		}

		// Validate value type
		if (valueSchema && typeof valueSchema === 'object' && Object.keys(valueSchema).length > 0) {
			const valResult = validateData(v, valueSchema, [...path, k], dbAccess, opts);
			result.errors.push(...valResult.errors);
			result.coercions.push(...valResult.coercions);
		}
	}

	return result;
}

module.exports = { validateDict };
