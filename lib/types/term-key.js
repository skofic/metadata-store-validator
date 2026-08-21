'use strict';

/**
 * types/term-key.js — Validators for _term_key and _term_key_* variants.
 *
 * _term_key            : value must be the _gid of any existing term.
 * _term_key_enum-root  : term must be a root of at least one enumeration
 *                        (its handle appears in the _path of a _predicate_enum-of edge).
 * _term_key_enum-item  : term must have role _term_role_enum-item.
 * _term_key_descriptor : term must have role _term_role_descriptor.
 *
 * DB access: required for all existence and role checks. The dbAccess object
 * must implement:
 *   termExists(gid)         → boolean
 *   isEnumRoot(gid)         → boolean  (graph-based; replaces termHasRole for enum-root)
 *   termHasRole(gid, role)  → boolean
 */

const { ErrorCode, makeError } = require('../errors');

const ROLE_CONSTRAINTS = {
	'_term_key_enum-root':   '_term_role_enum-root',
	'_term_key_enum-item':   '_term_role_enum-item',
	'_term_key_descriptor':  '_term_role_descriptor',
};

/**
 * Validate a value against a _term_key* scalar type.
 *
 * @param {*}        value    - The value to validate.
 * @param {string}   type     - '_term_key' or one of the _term_key_* variants.
 * @param {Object}   schema   - Companion properties (expected to be empty {}).
 * @param {string[]} path     - Current dot-path for error location.
 * @param {Object}   dbAccess - DB accessor (may be null — skips DB checks).
 * @returns {Object[]} Array of error objects (empty = valid).
 */
function validateTermKey(value, type, schema, path, dbAccess) {
	const errors = [];

	if (typeof value !== 'string') {
		errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'non-empty string (term _gid)',
			`Expected a non-empty string (term _gid) for ${type}, got ${typeof value}`
		));
		return errors;
	}
	if (value === '') return errors; // "" = default namespace sentinel (_nid: ""); valid by design

	if (!dbAccess) return errors;

	if (!dbAccess.termExists(value)) {
		errors.push(makeError(
			ErrorCode.INVALID_TERM_KEY, path, value, 'existing term _gid',
			`No term with _gid "${value}" exists in the dictionary`
		));
		return errors;
	}

	if (type === '_term_key_enum-root') {
		if (!dbAccess.isEnumRoot(value)) {
			errors.push(makeError(
				ErrorCode.INVALID_TERM_KEY, path, value,
				'enumeration root (handle in _path of a _predicate_enum-of edge)',
				`Term "${value}" is not the root of any enumeration`
			));
		}
		return errors;
	}

	const requiredRole = ROLE_CONSTRAINTS[type];
	if (requiredRole && !dbAccess.termHasRole(value, requiredRole)) {
		errors.push(makeError(
			ErrorCode.INVALID_TERM_KEY, path, value,
			`term with role ${requiredRole}`,
			`Term "${value}" does not have the required role ${requiredRole}`
		));
	}

	return errors;
}

module.exports = { validateTermKey };
