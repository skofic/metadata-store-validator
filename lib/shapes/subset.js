'use strict';

/**
 * shapes/subset.js — the `_subset-of` companion of _set and _array.
 *
 * `_subset-of` names, as a `_scope_object` path resolved from the CONTAINING
 * object (opts.parentObject — set by validateDocument for depth-1 and by
 * validateConformance on every descent), a sibling property whose value
 * supplies the allowed elements: an array or set as it is, a scalar as a
 * one-element set. Every element of the validated container must be one of
 * them; a miss is NOT_IN_SIBLING at the element's path. An absent sibling, or
 * no containing object at all, imposes no constraint (skip-absent, the rule
 * every sibling reference follows).
 */

const { ErrorCode, makeError } = require('../errors');
const { readObjectScope }      = require('../types/other');

function sameItem(a, b) {
	if (a === b) return true;
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {Array}   value   - The validated container (already known to be an array).
 * @param {string}  ref     - The `_subset-of` value (a property name or dotted path).
 * @param {string[]} path   - Dot-path of the container, for error locations.
 * @param {Object}  opts    - Validation options; `parentObject` is the containing object.
 * @returns {Object[]} errors
 */
function checkSubsetOf(value, ref, path, opts) {
	const errors = [];
	if (typeof ref !== 'string' || ref === '') return errors;
	const container = opts && opts.parentObject;
	if (!container || typeof container !== 'object') return errors;
	const allowed = readObjectScope(container, ref);
	if (allowed === undefined) return errors;                       // skip-absent
	const pool = Array.isArray(allowed) ? allowed : [allowed];
	for (let i = 0; i < value.length; i++) {
		if (!pool.some(x => sameItem(x, value[i]))) {
			errors.push(makeError(
				ErrorCode.NOT_IN_SIBLING, [...path, '[' + i + ']'], value[i],
				'a value of ' + ref,
				'Element ' + JSON.stringify(value[i]) + ' is not among the values of ' + ref + ' in the containing object'
			));
		}
	}
	return errors;
}

module.exports = { checkSubsetOf };
