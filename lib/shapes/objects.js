'use strict';

/**
 * shapes/objects.js — Validator for the _objects data shape.
 *
 * _objects is an ordered array of objects with positional element schemas
 * and cross-element invariants. Schema structure:
 *
 *   {
 *     _objects_first: { _open|_closed: { ... } },   // optional — applies to index 0
 *     _objects_list:  { _open|_closed: { ... } },   // optional — applies to middle elements
 *     _objects_last:  { _open|_closed: { ... } },   // optional — applies to index length-1
 *     _elements:      { _min-items: N, _max-items: M },        // optional count constraint
 *     _unique:        "<_scope_object>",                       // optional uniqueness invariant
 *     _ordered:       { _property: "<_scope_object>",
 *                       _direction: "_direction_asc"|"_direction_desc" }   // optional ordering invariant
 *   }
 *
 * Position dispatch precedence:
 *   1. if i == 0           and _objects_first present → _objects_first
 *   2. else if i == length-1 and _objects_last present → _objects_last
 *   3. else if _objects_list present → _objects_list
 *   4. else → NO_SCHEMA_FOR_POSITION error
 *
 * Skip-absent rule: when _unique or _ordered references a property that an
 * element does not carry, that element does not participate in the check.
 * This is essential for head + tail patterns where the head element has a
 * different shape (e.g. _range_thresholds where the first bucket has no
 * _min-inclusive).
 *
 * An empty _objects ({}) means any array of any-shape objects is accepted.
 */

const { ErrorCode, makeError } = require('../errors');
const { readObjectScope }       = require('../types/other');
const { validateObject }        = require('./object');

/**
 * Compare two values using JS native ordering. Returns -1, 0, or +1.
 * Numbers and strings compare with native semantics; mixed/other types
 * fall back to JS comparison rules.
 */
function compareValues(a, b) {
	if (a < b) return -1;
	if (a > b) return  1;
	return 0;
}

/**
 * Validate one element against a positional slot schema.
 *
 * Each slot's value omits the outer _object wrapper — its body is _open or
 * _closed directly. We wrap it so it can be passed to validateObject.
 */
function validateAgainstSlot(elementValue, slotSchema, path) {
	if (!slotSchema || typeof slotSchema !== 'object') {
		// Empty slot schema → accept any object
		return validateObject(elementValue, {}, path);
	}
	return validateObject(elementValue, slotSchema, path);
}

/**
 * Validate a value against an _objects schema.
 *
 * @param {*}        value         - The value to validate.
 * @param {Object}   objectsSchema - The object that is the value of the _objects key.
 * @param {string[]} path          - Current dot-path for error location.
 * @param {Object}   dbAccess      - DB accessor (may be null) — passed through but unused.
 * @param {Object}   opts          - Options.
 * @returns {{ errors: Object[], coercions: Object[] }}
 */
function validateObjects(value, objectsSchema, path, dbAccess, opts) {
	const result = { errors: [], coercions: [] };

	if (!Array.isArray(value)) {
		result.errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'array',
			`Expected an array, got ${typeof value}`
		));
		return result;
	}

	if (!objectsSchema || typeof objectsSchema !== 'object') return result;

	const slotFirst = objectsSchema._objects_first || null;
	const slotList  = objectsSchema._objects_list  || null;
	const slotLast  = objectsSchema._objects_last  || null;

	// Count constraints (_elements)
	const el = objectsSchema._elements;
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

	// Per-element positional dispatch.
	// If no positional slots are declared at all, the shape accepts any array of any-shape
	// objects (parallel to _object: {} meaning "any object"). Skip the element loop entirely.
	const hasAnySlot = !!(slotFirst || slotList || slotLast);
	if (hasAnySlot) {
		for (let i = 0; i < value.length; i++) {
			const elementPath = [...path, '[' + i + ']'];
			let slot     = null;
			let slotName = null;

			if (i === 0 && slotFirst) {
				slot     = slotFirst;
				slotName = '_objects_first';
			} else if (i === value.length - 1 && slotLast) {
				slot     = slotLast;
				slotName = '_objects_last';
			} else if (slotList) {
				slot     = slotList;
				slotName = '_objects_list';
			} else {
				result.errors.push(makeError(
					ErrorCode.NO_SCHEMA_FOR_POSITION, elementPath, undefined,
					'a positional schema (_objects_first / _objects_list / _objects_last) covering this index',
					`No schema defined for element at index ${i}; declare _objects_list (or the appropriate slot)`
				));
				continue;
			}

			const elResult = validateAgainstSlot(value[i], slot, [...elementPath, slotName]);
			result.errors.push(...elResult.errors);
			result.coercions.push(...elResult.coercions);
		}
	}

	// Cross-element invariants — only meaningful if the array is well-formed enough
	// (the per-element checks above will have flagged shape errors; we run these
	// regardless so authors see all violations in one pass).

	// _unique: collect values at the referenced property; flag duplicates
	if (typeof objectsSchema._unique === 'string' && objectsSchema._unique !== '') {
		const propPath = objectsSchema._unique;
		const seen     = new Map(); // value (string-keyed) → first index seen
		for (let i = 0; i < value.length; i++) {
			const propValue = readObjectScope(value[i], propPath);
			if (propValue === undefined) continue; // skip-absent rule
			const key = JSON.stringify(propValue);
			if (seen.has(key)) {
				result.errors.push(makeError(
					ErrorCode.DUPLICATE_VALUE,
					[...path, '[' + i + ']', propPath],
					propValue,
					`distinct values across all elements at "${propPath}"`,
					`Duplicate value ${JSON.stringify(propValue)} at "${propPath}" — first seen at index ${seen.get(key)}, repeated at index ${i}`
				));
			} else {
				seen.set(key, i);
			}
		}
	}

	// _ordered: walk the elements in array order; flag any pair out of order
	if (objectsSchema._ordered && typeof objectsSchema._ordered === 'object') {
		const propPath  = objectsSchema._ordered._property;
		const direction = objectsSchema._ordered._direction || '_direction_asc';

		if (typeof propPath === 'string' && propPath !== '') {
			let prevValue = undefined;
			let prevIndex = -1;
			for (let i = 0; i < value.length; i++) {
				const curValue = readObjectScope(value[i], propPath);
				if (curValue === undefined) continue; // skip-absent rule

				if (prevValue !== undefined) {
					const cmp = compareValues(prevValue, curValue);
					const okAsc  = (direction === '_direction_asc'  && cmp <  0);
					const okDesc = (direction === '_direction_desc' && cmp >  0);
					const inOrder = okAsc || okDesc;
					if (!inOrder) {
						result.errors.push(makeError(
							ErrorCode.ORDERING_VIOLATION,
							[...path, '[' + i + ']', propPath],
							curValue,
							`strictly ${direction === '_direction_desc' ? 'descending' : 'ascending'} sequence at "${propPath}"`,
							`Ordering violation at "${propPath}" — value ${JSON.stringify(curValue)} at index ${i} is not strictly ${direction === '_direction_desc' ? 'less than' : 'greater than'} ${JSON.stringify(prevValue)} at index ${prevIndex}`
						));
					}
				}
				prevValue = curValue;
				prevIndex = i;
			}
		}
	}

	return result;
}

module.exports = { validateObjects };
