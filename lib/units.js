'use strict';

/**
 * units.js — Physical bounds of units (`unit_range`).
 *
 * A unit term may carry `_prop.unit_range`, a `_range` object stating a bound
 * that no value expressed in that unit can legitimately cross — kelvin ≥ 0,
 * °C ≥ −273.15, percent 0…100. When a numeric descriptor selects such a unit
 * through `_unit`, a value must satisfy BOTH the descriptor's `_range_valid`
 * and the unit's bound: the effective range is their intersection. Checking
 * the two ranges one after the other enforces exactly that (types/number.js).
 *
 * checkUnitBounds() is the authoring-time counterpart: it reports a descriptor
 * whose own declared range reaches beyond its unit's bound. Such a descriptor
 * calls values valid that the unit then rejects, so the contradiction belongs
 * in the dictionary, not in the data.
 */

const { ErrorCode, makeError } = require('./errors');

const NUMBER_TYPES = ['_number', '_number_float', '_number_integer'];

// dbAccess → Map<unitGid, rangeObject | null>. Unit terms are read once per
// accessor, not once per validated value.
const memo = new WeakMap();

/**
 * The `unit_range` of a unit term, or null when there is none to apply.
 *
 * @param {string} unitGid  - The unit term's _gid (a descriptor's `_unit`).
 * @param {Object} dbAccess - DB accessor exposing getTerm(gid). May be null.
 * @returns {Object|null} The `_range` object, or null (no dbAccess, unknown
 *                        unit, or a unit without a physical bound).
 */
function unitRangeOf(unitGid, dbAccess) {
	if (typeof unitGid !== 'string' || unitGid === '') return null;
	if (!dbAccess || typeof dbAccess.getTerm !== 'function') return null;

	let perAccess = memo.get(dbAccess);
	if (!perAccess) {
		perAccess = new Map();
		memo.set(dbAccess, perAccess);
	}
	if (perAccess.has(unitGid)) return perAccess.get(unitGid);

	const term  = dbAccess.getTerm(unitGid);
	const bound = term && term._prop && term._prop.unit_range;
	const range = bound && typeof bound === 'object' && !Array.isArray(bound) ? bound : null;
	perAccess.set(unitGid, range);
	return range;
}

// ── Range comparison ──────────────────────────────────────────────────────────

function lowerOf(range) {
	if ('_min-inclusive' in range) return { value: range['_min-inclusive'], inclusive: true };
	if ('_min-exclusive' in range) return { value: range['_min-exclusive'], inclusive: false };
	return null;
}

function upperOf(range) {
	if ('_max-inclusive' in range) return { value: range['_max-inclusive'], inclusive: true };
	if ('_max-exclusive' in range) return { value: range['_max-exclusive'], inclusive: false };
	return null;
}

/** Human-readable form of a `_range` object, e.g. ">= 0, < 100". */
function formatRange(range) {
	const parts = [];
	if ('_min-inclusive' in range) parts.push('>= ' + range['_min-inclusive']);
	if ('_min-exclusive' in range) parts.push('> '  + range['_min-exclusive']);
	if ('_max-inclusive' in range) parts.push('<= ' + range['_max-inclusive']);
	if ('_max-exclusive' in range) parts.push('< '  + range['_max-exclusive']);
	return parts.join(', ') || 'unbounded';
}

/**
 * How a declared range contradicts a unit's bound, or null when it does not.
 * Only declared bounds are compared: a range left open on one side simply
 * inherits the unit's bound there. An empty intersection is a contradiction
 * too (e.g. `< 0` against a unit bound of `>= 0`).
 */
function contradiction(range, unit) {
	const rLow = lowerOf(range), rHigh = upperOf(range);
	const uLow = lowerOf(unit),  uHigh = upperOf(unit);

	if (rLow && uLow && (rLow.value < uLow.value ||
	    (rLow.value === uLow.value && rLow.inclusive && !uLow.inclusive))) {
		return 'reaches below';
	}
	if (rHigh && uHigh && (rHigh.value > uHigh.value ||
	    (rHigh.value === uHigh.value && rHigh.inclusive && !uHigh.inclusive))) {
		return 'reaches above';
	}

	// Intersection of the two: the tighter bound on each side.
	const low  = !rLow ? uLow : !uLow ? rLow
		: rLow.value > uLow.value ? rLow : uLow.value > rLow.value ? uLow
		: { value: rLow.value, inclusive: rLow.inclusive && uLow.inclusive };
	const high = !rHigh ? uHigh : !uHigh ? rHigh
		: rHigh.value < uHigh.value ? rHigh : uHigh.value < rHigh.value ? uHigh
		: { value: rHigh.value, inclusive: rHigh.inclusive && uHigh.inclusive };
	if (low && high && (low.value > high.value ||
	    (low.value === high.value && !(low.inclusive && high.inclusive)))) {
		return 'does not overlap';
	}
	return null;
}

/** The numeric type bodies of a descriptor's _data, with their paths. */
function numericBodies(data) {
	const bodies = [];
	for (const shape of ['_scalar', '_set', '_nested']) {
		const container = data[shape];
		if (!container || typeof container !== 'object') continue;
		for (const type of NUMBER_TYPES) {
			if (container[type] && typeof container[type] === 'object') {
				bodies.push({ body: container[type], path: ['_data', shape, type] });
			}
		}
	}
	const arrayScalar = data._array && data._array._scalar;
	if (arrayScalar && typeof arrayScalar === 'object') {
		for (const type of NUMBER_TYPES) {
			if (arrayScalar[type] && typeof arrayScalar[type] === 'object') {
				bodies.push({ body: arrayScalar[type], path: ['_data', '_array', '_scalar', type] });
			}
		}
	}
	return bodies;
}

/**
 * Report a descriptor whose declared `_range_valid` or `_range_normal` reaches
 * beyond the physical bound of the unit it selects.
 *
 * @param {Object} term     - A descriptor term document.
 * @param {Object} dbAccess - DB accessor exposing getTerm(gid). Without one,
 *                            nothing can be checked and nothing is reported.
 * @returns {Object[]} UNIT_RANGE_CONFLICT errors (empty = consistent).
 */
function checkUnitBounds(term, dbAccess) {
	const errors = [];
	if (!term || !term._data || typeof term._data !== 'object') return errors;

	for (const { body, path } of numericBodies(term._data)) {
		const unit = unitRangeOf(body._unit, dbAccess);
		if (!unit) continue;
		for (const which of ['_range_valid', '_range_normal']) {
			const range = body[which];
			if (!range || typeof range !== 'object') continue;
			const problem = contradiction(range, unit);
			if (!problem) continue;
			errors.push(makeError(
				ErrorCode.UNIT_RANGE_CONFLICT, [...path, which], range,
				`within the physical bound of unit "${body._unit}" (${formatRange(unit)})`,
				`${which} (${formatRange(range)}) ${problem} the physical bound of unit "${body._unit}" (${formatRange(unit)})`
			));
		}
	}
	return errors;
}

module.exports = { unitRangeOf, checkUnitBounds, formatRange };
