'use strict';

/**
 * types/string.js — Validators for _string and all _string_* variants.
 *
 * Companion properties:
 *   _string                            : _regexp, _unit*, _range_valid_string, _range_normal_string, _case, _length
 *   _string_YMD, _string_date,
 *   _string_time, _string_date-time    : _range_valid_string, _range_normal_string
 *   _string_HEX                        : _case, _length (case-agnostic type; no _regexp, no lexicographic ranges)
 *   All others (_string_URI, _string_Email, etc.) : no companions
 *   _string_regexp                     : value is itself a regexp pattern (validity checked)
 *
 * Format validation applies the minimum check needed to confirm the declared type.
 * Deep semantic checks (e.g. date rollover, DNS lookup) are out of scope.
 */

const { ErrorCode, makeError } = require('../errors');
const { checkStringRange } = require('../ranges');

// Types that support string range companions (lexicographic bounds). Not
// _string_HEX — hex magnitude is not lexicographic; it uses _length instead.
const RANGE_TYPES = new Set([
	'_string', '_string_YMD', '_string_date', '_string_time',
	'_string_date-time',
]);

// Types that accept _regexp (in addition to their own format constraint).
// Not _string_HEX — _case and _length express its constraints declaratively.
const REGEXP_TYPES = new Set(['_string']);

// Types that accept the _case and _length companions
const CASE_TYPES = new Set(['_string', '_string_HEX']);
const LENGTH_TYPES = new Set(['_string', '_string_HEX']);

// Format validators keyed by type name. Return true if the value is well-formed.
const FORMAT = {
	'_string_URI': function(v) {
		try { new URL(v); return true; } catch (_) { return false; }
	},
	'_string_Email': function(v) {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
	},
	'_string_Hostname': function(v) {
		return /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?$/.test(v);
	},
	'_string_IPv4': function(v) {
		if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return false;
		return v.split('.').every(function(n) { return parseInt(n, 10) <= 255; });
	},
	'_string_IPv6': function(v) {
		return /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|::([0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}|[0-9a-fA-F]{1,4}::([0-9a-fA-F]{1,4}:){0,4}[0-9a-fA-F]{1,4})$/.test(v);
	},
	'_string_YMD': function(v) {
		// YYYYMMDD, YYYYMM, or YYYY — all digits, 4–8 chars
		return /^\d{4}(?:(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])?)?$/.test(v);
	},
	'_string_date': function(v) {
		return /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(v);
	},
	'_string_time': function(v) {
		return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(v);
	},
	'_string_date-time': function(v) {
		return /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d/.test(v);
	},
	'_string_HEX': function(v) {
		// Case-agnostic: hex digits in either case. The _case companion pins
		// lowercase / uppercase when a descriptor requires it; _length bounds
		// the digit count.
		return /^[0-9a-fA-F]*$/.test(v);
	},
	'_string_regexp': function(v) {
		try { new RegExp(v); return true; } catch (_) { return false; }
	},
	// _string_LaTeX: any string is accepted — no practical format check
};

/**
 * Validate a value against a _string* scalar type.
 *
 * @param {*}        value  - The value to validate.
 * @param {string}   type   - One of the _string* type keys.
 * @param {Object}   schema - Companion properties from the schema.
 * @param {string[]} path   - Current dot-path for error location.
 * @returns {Object[]} Array of error objects (empty = valid).
 */
function validateString(value, type, schema, path) {
	const errors = [];

	if (typeof value !== 'string') {
		errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, `string (${type})`,
			`Expected a string for ${type}, got ${typeof value}`
		));
		return errors;
	}

	// Format check for typed variants
	const formatCheck = FORMAT[type];
	if (formatCheck && !formatCheck(value)) {
		errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, type,
			`"${value}" does not conform to the expected format for ${type}`
		));
	}

	// _regexp companion (only _string and _string_HEX)
	if (schema._regexp && REGEXP_TYPES.has(type)) {
		try {
			if (!new RegExp(schema._regexp).test(value)) {
				errors.push(makeError(
					ErrorCode.REGEXP_MISMATCH, path, value, `/${schema._regexp}/`,
					`"${value}" does not match the required pattern /${schema._regexp}/`
				));
			}
		} catch (_) {
			// Malformed regexp in schema — schema error, not a value error; skip silently
		}
	}

	// _case companion (only _string and _string_HEX): the value's cased letters
	// must all be the required case. Case-less characters (digits, symbols) are
	// unaffected — so an all-digit hex passes either case constraint.
	if (schema._case && CASE_TYPES.has(type)) {
		if (schema._case === '_case_lower' && value !== value.toLowerCase()) {
			errors.push(makeError(
				ErrorCode.CASE_MISMATCH, path, value, 'lowercase',
				`"${value}" must be entirely lowercase (_case_lower)`
			));
		} else if (schema._case === '_case_upper' && value !== value.toUpperCase()) {
			errors.push(makeError(
				ErrorCode.CASE_MISMATCH, path, value, 'uppercase',
				`"${value}" must be entirely uppercase (_case_upper)`
			));
		}
	}

	// _length companion (only _string and _string_HEX): the character count must
	// fall within the declared _min-length / _max-length bounds (inclusive).
	if (schema._length && LENGTH_TYPES.has(type)) {
		const min = schema._length['_min-length'];
		const max = schema._length['_max-length'];
		if (typeof min === 'number' && value.length < min) {
			errors.push(makeError(
				ErrorCode.LENGTH_VIOLATION, path, value, `≥ ${min} characters`,
				`"${value}" is ${value.length} characters; minimum is ${min}`
			));
		}
		if (typeof max === 'number' && value.length > max) {
			errors.push(makeError(
				ErrorCode.LENGTH_VIOLATION, path, value, `≤ ${max} characters`,
				`"${value}" is ${value.length} characters; maximum is ${max}`
			));
		}
	}

	// String range companions
	if (RANGE_TYPES.has(type)) {
		if (schema._range_valid_string) {
			errors.push(...checkStringRange(
				value, schema._range_valid_string,
				[...path, '_range_valid_string'], ErrorCode.RANGE_VIOLATION
			));
		}
		if (schema._range_normal_string) {
			errors.push(...checkStringRange(
				value, schema._range_normal_string,
				[...path, '_range_normal_string'], ErrorCode.RANGE_OUTLIER
			));
		}
	}

	return errors;
}

module.exports = { validateString };
