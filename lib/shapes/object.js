'use strict';

/**
 * shapes/object.js — Validator for the _object data shape.
 *
 * Three forms:
 *   {}                  — any object, no constraints
 *   { _open: {...} }    — open schema: listed constraints apply; extra properties allowed
 *   { _closed: {...} }  — closed schema: only whitelisted properties allowed
 *
 * Schema constraints in _open / _closed:
 *   _required   — array of selector objects (mandatory/count rules)
 *   _recommended — set of _gids (whitelist tier in closed schema; advisory in open)
 *   _banned     — set of _gids (unconditional; takes precedence over everything)
 *   _computed   — set of _gids (auto-filled by system; counted as allowed in closed)
 *   _locked     — set of _gids (system-managed; counted as allowed in closed)
 *   _immutable  — set of _gids (immutable once set; counted as allowed in closed)
 */

const { ErrorCode, makeError } = require('../errors');

// ── Selector logic ────────────────────────────────────────────────────────────

/**
 * Apply a single selector rule's min/max constraints to a count.
 * groupLabel is used in error messages.
 */
function applyCountRule(rule, count, label, path, errors) {
	if ('_all' in rule) {
		const c   = rule._all || {};
		const min = c['_min-items'];
		const max = c['_max-items'];
		if (min === undefined && max === undefined) return; // handled separately
		if (min !== undefined && count < min) {
			errors.push(makeError(
				ErrorCode.SELECTION_VIOLATION, path, count,
				`at least ${min} of ${label}`,
				`At least ${min} of ${label} must be present; found ${count}`
			));
		}
		if (max !== undefined && count > max) {
			errors.push(makeError(
				ErrorCode.SELECTION_VIOLATION, path, count,
				`at most ${max} of ${label}`,
				`At most ${max} of ${label} may be present; found ${count}`
			));
		}
	}
	if ('_any' in rule) {
		const c   = rule._any || {};
		const min = c['_min-items'];
		const max = c['_max-items'];
		if (min !== undefined && count < min) {
			errors.push(makeError(
				ErrorCode.SELECTION_VIOLATION, path, count,
				`at least ${min} of ${label}`,
				`At least ${min} of ${label} must be present; found ${count}`
			));
		}
		if (max !== undefined && count > max) {
			errors.push(makeError(
				ErrorCode.SELECTION_VIOLATION, path, count,
				`at most ${max} of ${label}`,
				`At most ${max} of ${label} may be present; found ${count}`
			));
		}
	}
}

/**
 * Evaluate a single { _selectors, _selection } object against the document.
 * Returns an array of SELECTION_VIOLATION / MISSING_REQUIRED errors.
 *
 * When _selection contains subarrays and _selectors has more than one entry,
 * a layered evaluation is performed:
 *   - _selectors[0] (inner) is applied to each leaf group independently.
 *     Its _max-items enforces mutual exclusion within the group.
 *   - _selectors[1] (outer) is applied to the count of groups that contribute
 *     at least one property. Its _min-items / _max-items controls how many
 *     groups must be represented.
 *
 * Flat _selection (no subarrays) uses all selectors against the flat candidate
 * list, preserving the original single-level behaviour.
 */
function checkSelector(obj, selectorDef, path) {
	const errors    = [];
	const selectors = selectorDef._selectors || [];
	const selection = selectorDef._selection || [];

	const hasGroups = selection.some(function(x) { return Array.isArray(x); });

	if (hasGroups && selectors.length >= 2) {
		// Layered evaluation: inner selector per leaf group, outer selector for group count
		const innerRule  = selectors[0];
		const outerRules = selectors.slice(1);

		const groups = selection.map(function(x) { return Array.isArray(x) ? x : [x]; });
		let groupsContributing = 0;

		for (const leafCandidates of groups) {
			const leafPresent = leafCandidates.filter(function(k) { return k in obj; });
			const groupLabel  = '[' + leafCandidates.join(', ') + ']';

			// Inner selector: only enforce _max-items within the group.
			// _min-items is satisfied implicitly when the group contributes,
			// and its absence is governed by the outer selector.
			if ('_all' in innerRule) {
				const max = (innerRule._all || {})['_max-items'];
				if (max !== undefined && leafPresent.length > max) {
					errors.push(makeError(
						ErrorCode.SELECTION_VIOLATION, path, leafPresent.length,
						`at most ${max} of ${groupLabel}`,
						`At most ${max} of ${groupLabel} may be present; found ${leafPresent.length}`
					));
				}
			} else if ('_any' in innerRule) {
				const max = (innerRule._any || {})['_max-items'];
				if (max !== undefined && leafPresent.length > max) {
					errors.push(makeError(
						ErrorCode.SELECTION_VIOLATION, path, leafPresent.length,
						`at most ${max} of ${groupLabel}`,
						`At most ${max} of ${groupLabel} may be present; found ${leafPresent.length}`
					));
				}
			}

			if (leafPresent.length > 0) groupsContributing++;
		}

		// Outer selectors: applied to the count of contributing groups
		const groupsLabel = '[' + groups.map(function(g) { return '[' + g.join(', ') + ']'; }).join(', ') + ']';
		for (const rule of outerRules) {
			applyCountRule(rule, groupsContributing, groupsLabel, path, errors);
		}

		return errors;
	}

	// Flat selection: apply all selectors to the flat candidate list
	const candidates = [].concat(...selection.map(function(x) {
		return Array.isArray(x) ? x : [x];
	}));
	const present = candidates.filter(function(k) { return k in obj; });
	const label   = '[' + candidates.join(', ') + ']';

	for (const rule of selectors) {
		if ('_all' in rule) {
			const c   = rule._all || {};
			const min = c['_min-items'];
			const max = c['_max-items'];

			if (min === undefined && max === undefined) {
				// All candidates must be present
				const missing = candidates.filter(function(k) { return !(k in obj); });
				for (const k of missing) {
					errors.push(makeError(
						ErrorCode.MISSING_REQUIRED, [...path, k], undefined,
						'present', `Required property "${k}" is missing`
					));
				}
			} else {
				applyCountRule(rule, present.length, label, path, errors);
			}
		} else if ('_any' in rule) {
			applyCountRule(rule, present.length, label, path, errors);
		}
	}

	return errors;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Validate a value against an _object schema.
 *
 * @param {*}        value        - The value to validate.
 * @param {Object}   objectSchema - The object that is the value of the _object key.
 * @param {string[]} path         - Current dot-path for error location.
 * @returns {{ errors: Object[], coercions: Object[] }}
 *
 * Note: this validator checks structural constraints only (required/banned/unknown).
 * It does not recursively validate the values of individual properties against
 * their descriptor _data sections — that requires a descriptor lookup (DB access)
 * and is handled at a higher level.
 */
function validateObject(value, objectSchema, path) {
	const result = { errors: [], coercions: [] };

	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		result.errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'object',
			`Expected an object, got ${Array.isArray(value) ? 'array' : typeof value}`
		));
		return result;
	}

	// {} = any struct, no constraints
	const hasOpen   = '_open'   in objectSchema;
	const hasClosed = '_closed' in objectSchema;
	if (!hasOpen && !hasClosed) return result;

	const isClosed = hasClosed;
	const schema   = isClosed ? objectSchema._closed : objectSchema._open;
	if (!schema || typeof schema !== 'object') return result;

	// _banned: unconditional — takes precedence over everything
	const banned = schema._banned || [];
	for (const key of banned) {
		if (key in value) {
			result.errors.push(makeError(
				ErrorCode.BANNED_PROPERTY, [...path, key], value[key],
				'absent',
				`Property "${key}" is banned and must not be present`
			));
		}
	}

	// Closed schema: check for properties outside the whitelist
	if (isClosed) {
		const required    = (schema._required || []).flatMap(function(s) {
			return [].concat(...(s._selection || []).map(function(x) { return Array.isArray(x) ? x : [x]; }));
		});
		const recommended = schema._recommended || [];
		const computed    = schema._computed    || [];
		const locked      = schema._locked      || [];
		const immutable   = schema._immutable   || [];
		const allowed = new Set([...required, ...recommended, ...computed, ...locked, ...immutable]);

		for (const key of Object.keys(value)) {
			if (!allowed.has(key)) {
				result.errors.push(makeError(
					ErrorCode.UNKNOWN_PROPERTY, [...path, key], value[key],
					`one of [${[...allowed].join(', ')}]`,
					`Property "${key}" is not permitted in this closed schema`
				));
			}
		}
	}

	// _required selectors
	for (const selectorDef of (schema._required || [])) {
		result.errors.push(...checkSelector(value, selectorDef, path));
	}

	return result;
}

module.exports = { validateObject };
