'use strict';

/**
 * shapes/keyed-by.js — Validator for the _keyed data shape.
 *
 * _keyed is a dictionary whose allowed keys are determined at runtime from
 * sibling property values in the same containing object. Schema structure:
 *
 *   {
 *     "_from": { <_data section> },
 *     "_to":   { <_data section> },
 *     "_path": { <_data section> }
 *   }
 *
 * Each key in the schema is a sibling property name. The allowed keys in the
 * validated value are the string value(s) contributed by each named sibling:
 *   - scalar sibling → contributes its string value as one allowed key
 *   - array sibling  → each element contributes one allowed key
 *   - absent sibling → contributes nothing (not an error)
 *
 * When the same key string is contributed by multiple siblings, the schema from
 * the first matching entry (JSON key order) applies.
 *
 * Runtime keys with no matching sibling value are silently ignored (lenient
 * mode). Matched keys whose values fail their entry's _data check still error.
 *
 * opts.parentObject must be set to the object that contains the _keyed value.
 * Without it, only a type check is performed (key/value validation is skipped).
 */

const { ErrorCode, makeError } = require('../errors');
const { validateScopeSibling } = require('../types/other');

/**
 * Build a Map<string, dataSection> from sibling property values.
 * Exported so conformance.js can reuse it without duplicating the logic.
 *
 * @param {Object} keyedSchema  - The _keyed schema (sibling name → _data section).
 * @param {Object} parentObject - The object that contains the _keyed-typed property.
 * @returns {Map<string, Object>}
 */
function buildKeySchemaMap(keyedSchema, parentObject) {
	const map = new Map();
	for (const [siblingName, dataSection] of Object.entries(keyedSchema)) {
		const siblingValue = parentObject[siblingName];
		if (Array.isArray(siblingValue)) {
			for (const elem of siblingValue) {
				if (typeof elem === 'string' && !map.has(elem)) {
					map.set(elem, dataSection);
				}
			}
		} else if (typeof siblingValue === 'string') {
			if (!map.has(siblingValue)) {
				map.set(siblingValue, dataSection);
			}
		}
	}
	return map;
}

/**
 * Validate a value against a _keyed schema.
 *
 * @param {*}        value       - The value to validate.
 * @param {Object}   keyedSchema - The object that is the value of the _keyed key.
 * @param {string[]} path        - Current dot-path for error location.
 * @param {Object}   dbAccess    - DB accessor (may be null).
 * @param {Object}   opts        - Options: { coerce, parentObject }.
 * @returns {{ errors: Object[], coercions: Object[] }}
 */
function validateKeyedBy(value, keyedSchema, path, dbAccess, opts) {
	const result = { errors: [], coercions: [] };

	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		result.errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'object (keyed)',
			`Expected an object for _keyed, got ${Array.isArray(value) ? 'array' : typeof value}`
		));
		return result;
	}

	// Schema-side key validation: each key in keyedSchema must be a valid
	// _scope_sibling value (the _dict_key type declared by the _keyed term's
	// own _data). Runs independent of parentObject — this catches malformed
	// schema-side keys at descriptor-definition time.
	if (keyedSchema && typeof keyedSchema === 'object') {
		for (const schemaKey of Object.keys(keyedSchema)) {
			const keyErrors = validateScopeSibling(
				schemaKey, {}, [...path, schemaKey, '(schema-key)'], dbAccess
			);
			result.errors.push(...keyErrors);
		}
	}

	const parentObject = opts && opts.parentObject;
	if (!parentObject || !keyedSchema) return result;

	const keySchemaMap         = buildKeySchemaMap(keyedSchema, parentObject);
	const { validateData }     = require('../validate');

	for (const [k, v] of Object.entries(value)) {
		const schema = keySchemaMap.get(k);
		if (schema === undefined) continue;   // lenient: ignore extra keys
		if (schema && typeof schema === 'object' && Object.keys(schema).length > 0) {
			const sub = validateData(v, schema, [...path, k], dbAccess, opts);
			result.errors.push(...sub.errors);
			result.coercions.push(...sub.coercions);
		}
	}

	return result;
}

module.exports = { validateKeyedBy, buildKeySchemaMap };
