'use strict';

/**
 * envelope.js — Check data too large to validate value by value.
 *
 * A collection of hundreds of millions of documents cannot reasonably be read
 * back through the validator one value at a time. Its "envelope" can: per
 * descriptor, the database computes a handful of aggregates, and those are
 * checked against the dictionary here.
 *
 *   describeEnvelopeNeeds(gids, dbAccess)
 *     What the consumer should aggregate for each gid: the value kind, and the
 *     ranges to count against (the descriptor's valid and normal ranges and the
 *     unit's physical bound), so the aggregation query can count violations.
 *
 *   validateEnvelope(envelope, dbAccess, opts)
 *     envelope: { <gid>: {
 *        count,             // values present
 *        min, max,          // numeric extremes
 *        types,             // distinct AQL TYPENAME()s seen, e.g. ["number"]
 *        nonInteger,        // values with a fractional part (integer / timestamp kinds)
 *        outOfValid,        // values outside the valid range or the unit bound (count)
 *        outOfNormal,       // values outside the normal range (count)
 *        distinct,          // string / enum values: [value] or [{ value, count }]
 *        distinctTruncated  // true when `distinct` is not the complete set
 *     } }   — every field optional except that nothing is checked without data.
 *
 * Counts, when given, make the findings quantitative (a report can show the
 * share of outliers); the extremes are also validated and supply an example.
 * Everything the aggregation query looks like depends on the collection's
 * layout, so it belongs to the consumer, not to this library.
 */

const { ErrorCode, makeError } = require('./errors');
const { validateByDictionary } = require('./conformance');
const { scalarTypes }          = require('./type-registry');
const { unitRangeOf }          = require('./units');

// AQL TYPENAME() values acceptable for each kind of descriptor.
const TYPENAMES = {
	number:    ['number'],
	integer:   ['number'],
	timestamp: ['number'],
	boolean:   ['bool', 'boolean'],
	enum:      ['string'],
	string:    ['string'],
};

function kindOf(type) {
	if (!type) return 'other';
	if (type === '_number' || type === '_number_float') return 'number';
	if (type === '_number_integer') return 'integer';
	if (type === '_timestamp') return 'timestamp';
	if (type === '_boolean') return 'boolean';
	if (type === '_enum') return 'enum';
	if (type.indexOf('_string') === 0 || type.indexOf('_term_key') === 0 ||
	    type.indexOf('_scope_') === 0 || type.indexOf('_handle') === 0) return 'string';
	return 'other';   // _text* (long content) and anything unforeseen
}

/**
 * @param {string[]} gids
 * @param {Object}   dbAccess
 * @returns {Object} { <gid>: { found, kind, type, unit, ranges: { valid, normal, unit } } }
 */
function describeEnvelopeNeeds(gids, dbAccess) {
	if (!dbAccess) throw new TypeError('describeEnvelopeNeeds: a dbAccess is required');
	const known = scalarTypes(dbAccess);
	const needs = {};

	for (const gid of gids || []) {
		const term = dbAccess.getTerm(gid);
		if (!term) {
			needs[gid] = { found: false, kind: 'other', type: null, unit: null, ranges: { valid: null, normal: null, unit: null } };
			continue;
		}

		// One _typedef hop (typedefs never chain).
		let data = term._data;
		if (data && typeof data._typedef === 'string') {
			const typedef = dbAccess.getTerm(data._typedef);
			data = typedef && typedef._data;
		}
		const scalar = data && data._scalar;
		const type   = scalar && typeof scalar === 'object'
			? (Object.keys(scalar).find(k => known.has(k)) || null)
			: null;
		const body   = type ? (scalar[type] || {}) : {};
		const unit   = typeof body._unit === 'string' ? body._unit : null;

		needs[gid] = {
			found:  true,
			kind:   kindOf(type),
			type,
			unit,
			ranges: {
				valid:  body._range_valid  || body._range_valid_string  || null,
				normal: body._range_normal || body._range_normal_string || null,
				unit:   unit ? unitRangeOf(unit, dbAccess) : null,
			},
		};
	}
	return needs;
}

/**
 * @param {Object} envelope - See the module header.
 * @param {Object} dbAccess
 * @param {Object} [opts]   - Passed to validateByDictionary (e.g. { coerce }).
 * @returns {{ errors: Object[], warnings: Object[], skipped: Array<{ gid, reason }> }}
 *          Each finding carries `gid`, `which` ('descriptor' | 'type' | 'integer' |
 *          'count' | 'min' | 'max' | 'distinct') and `count` (number of values
 *          concerned, or null when only an example is known).
 */
function validateEnvelope(envelope, dbAccess, opts) {
	if (!dbAccess) throw new TypeError('validateEnvelope: a dbAccess is required');
	const out   = { errors: [], warnings: [], skipped: [] };
	const gids  = Object.keys(envelope || {});
	const needs = describeEnvelopeNeeds(gids, dbAccess);

	function push(bucket, gid, finding, which, count) {
		out[bucket].push(Object.assign({}, finding, {
			gid,
			which,
			count: typeof count === 'number' ? count : null,
			path:  finding.path ? gid + '.' + finding.path : gid,
		}));
	}

	for (const gid of gids) {
		const e    = envelope[gid] || {};
		const need = needs[gid];

		if (!need.found) {
			push('errors', gid, makeError(
				ErrorCode.UNKNOWN_PROPERTY, [], gid, 'dictionary term',
				`"${gid}" is not a known dictionary term`
			), 'descriptor', e.count);
			continue;
		}
		if (need.kind === 'other') {
			out.skipped.push({ gid, reason: `${need.type || 'non-scalar'} values are not checked by envelope; validate them in-process` });
			continue;
		}

		// Types seen in the data against the declared type.
		if (Array.isArray(e.types)) {
			const allowed = TYPENAMES[need.kind];
			const bad     = e.types.filter(t => allowed.indexOf(t) === -1);
			if (bad.length > 0) {
				push('errors', gid, makeError(
					ErrorCode.WRONG_TYPE, [], bad, allowed.join(' | '),
					`"${gid}" holds values of type ${bad.join(', ')}; its descriptor declares ${need.type}`
				), 'type', null);
			}
		}
		if ((need.kind === 'integer' || need.kind === 'timestamp') && e.nonInteger > 0) {
			push('errors', gid, makeError(
				ErrorCode.WRONG_TYPE, [], null, 'integer',
				`${e.nonInteger} value(s) of "${gid}" have a fractional part; its descriptor declares ${need.type}`
			), 'integer', e.nonInteger);
		}

		// Range counts, when the aggregation provided them.
		const extremes = { min: e.min, max: e.max };
		if (typeof e.outOfValid === 'number' && e.outOfValid > 0) {
			push('errors', gid, makeError(
				ErrorCode.RANGE_VIOLATION, [], extremes, 'within the valid range and the unit bound',
				`${e.outOfValid} value(s) of "${gid}" lie outside its valid range (observed ${e.min} … ${e.max})`
			), 'count', e.outOfValid);
		}
		if (typeof e.outOfNormal === 'number' && e.outOfNormal > 0) {
			push('warnings', gid, makeError(
				ErrorCode.RANGE_OUTLIER, [], extremes, 'within the normal range',
				`${e.outOfNormal} value(s) of "${gid}" lie outside its normal range (observed ${e.min} … ${e.max})`
			), 'count', e.outOfNormal);
		}

		// The extremes themselves. Range findings already counted above are not
		// repeated; anything else they reveal is reported with the example value.
		for (const which of ['min', 'max']) {
			if (typeof e[which] !== 'number') continue;
			const r = validateByDictionary(e[which], gid, dbAccess, opts);
			for (const f of r.errors) {
				if (f.code === ErrorCode.RANGE_VIOLATION && typeof e.outOfValid === 'number') continue;
				push('errors', gid, f, which, null);
			}
			for (const f of r.warnings) {
				if (f.code === ErrorCode.RANGE_OUTLIER && typeof e.outOfNormal === 'number') continue;
				push('warnings', gid, f, which, null);
			}
		}

		// Distinct values of string-like descriptors (enumeration membership,
		// formats, string ranges).
		if (Array.isArray(e.distinct) && (need.kind === 'string' || need.kind === 'enum' || need.kind === 'boolean')) {
			for (const item of e.distinct) {
				const isPair = item !== null && typeof item === 'object' && 'value' in item;
				const value  = isPair ? item.value : item;
				const count  = isPair && typeof item.count === 'number' ? item.count : null;
				const r      = validateByDictionary(value, gid, dbAccess, opts);
				for (const f of r.errors)   push('errors',   gid, f, 'distinct', count);
				for (const f of r.warnings) push('warnings', gid, f, 'distinct', count);
			}
			if (e.distinctTruncated) {
				out.skipped.push({ gid, reason: 'distinct values truncated: only the listed values were checked' });
			}
		}
	}

	return out;
}

module.exports = { describeEnvelopeNeeds, validateEnvelope };
