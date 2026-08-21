'use strict';

/**
 * coerce.js — Attempt type coercion before strict validation.
 *
 * When coerce mode is enabled, the scalar dispatcher calls tryCoerce() before
 * passing the value to a type validator. On success the coerced value is
 * validated; a coercion record is returned for the caller to collect. On
 * failure null is returned and strict validation runs on the original value,
 * producing a WRONG_TYPE error as normal.
 *
 * Supported coercions:
 *
 *   string  → _number / _number_float / _number_integer   "3.14" → 3.14
 *   float   → _number_integer   (only when exactly integral)  2.0 → 2
 *   boolean → _number*          true → 1, false → 0
 *   number  → _boolean          non-zero → true, zero → false
 *   string  → _boolean          "true"/"1"/"yes" → true, "false"/"0"/"no" → false
 *   number  → _string           42 → "42"
 *   boolean → _string           true → "true"
 *
 * Typed string variants (_string_date, _string_URI, …) are excluded from
 * number/boolean→string coercion because the converted value would not
 * conform to the format anyway.
 *
 * No coercion is attempted for _handle, _enum, _term_key*, _text*, _timestamp.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a string as a finite number. Returns the number or null on failure.
 */
function parseNumericString(s) {
	if (typeof s !== 'string' || s.trim() === '') return null;
	const n = Number(s);
	return isFinite(n) ? n : null;
}

/**
 * Quick check: does the value already satisfy the basic JS type for this
 * scalar type? Used to short-circuit when no coercion is needed.
 */
function isAlreadyCorrectType(value, type) {
	switch (type) {
	case '_number':
	case '_number_float':
		return typeof value === 'number' && isFinite(value);
	case '_number_integer':
		return Number.isInteger(value);
	case '_boolean':
		return typeof value === 'boolean';
	case '_timestamp':
		return Number.isInteger(value);
	default:
		// _string*, _text*, _handle, _enum, _term_key* — checked by their own validators
		return typeof value === 'string';
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to coerce `value` to the scalar `type`.
 *
 * @param {*}      value - Original value from the document.
 * @param {string} type  - Target scalar type key, e.g. '_number_integer'.
 * @returns {{ value, from, rule }|null}
 *   On success: object with the coerced value, original value, and a short
 *   description of the rule applied (for the coercion report).
 *   On failure: null (coercion not possible — strict validation will produce an error).
 */
function tryCoerce(value, type) {
	// Already the right type — nothing to do
	if (isAlreadyCorrectType(value, type)) return null;

	// ── _number / _number_float ─────────────────────────────────────────────
	if (type === '_number' || type === '_number_float') {
		if (typeof value === 'boolean') {
			return { value: value ? 1 : 0, from: value, rule: 'boolean→number' };
		}
		if (typeof value === 'string') {
			const n = parseNumericString(value);
			if (n !== null) return { value: n, from: value, rule: 'string→number' };
		}
		return null;
	}

	// ── _number_integer ─────────────────────────────────────────────────────
	if (type === '_number_integer') {
		if (typeof value === 'boolean') {
			return { value: value ? 1 : 0, from: value, rule: 'boolean→integer' };
		}
		// Finite float that is exactly integral: 2.0 → 2
		if (typeof value === 'number' && isFinite(value)) {
			if (value === Math.trunc(value)) {
				return { value: Math.trunc(value), from: value, rule: 'float→integer' };
			}
			return null; // non-integral float — cannot coerce
		}
		// Numeric string: "2" or "2.0" → 2 (if exactly integral)
		if (typeof value === 'string') {
			const n = parseNumericString(value);
			if (n !== null && n === Math.trunc(n)) {
				return { value: Math.trunc(n), from: value, rule: 'string→integer' };
			}
		}
		return null;
	}

	// ── _boolean ────────────────────────────────────────────────────────────
	if (type === '_boolean') {
		// Number → boolean: non-zero = true, zero = false.
		// Covers both the 1/0 convention and the >0/0 convention for positive data.
		if (typeof value === 'number' && isFinite(value)) {
			return { value: value !== 0, from: value, rule: 'number→boolean' };
		}
		// String → boolean: accept the most common textual representations
		if (typeof value === 'string') {
			const s = value.trim().toLowerCase();
			if (s === 'true'  || s === '1' || s === 'yes') {
				return { value: true,  from: value, rule: 'string→boolean' };
			}
			if (s === 'false' || s === '0' || s === 'no') {
				return { value: false, from: value, rule: 'string→boolean' };
			}
		}
		return null;
	}

	// ── _string (plain only — typed variants excluded) ──────────────────────
	if (type === '_string') {
		if (typeof value === 'number' && isFinite(value)) {
			return { value: String(value), from: value, rule: 'number→string' };
		}
		if (typeof value === 'boolean') {
			return { value: String(value), from: value, rule: 'boolean→string' };
		}
		return null;
	}

	return null;
}

module.exports = { tryCoerce };
