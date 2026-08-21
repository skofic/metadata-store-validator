'use strict';

/**
 * shapes/scalar.js — Dispatcher for the _scalar data shape.
 *
 * Identifies the single type key inside the _scalar object, optionally
 * coerces the value, then delegates to the appropriate type validator.
 * Returns { errors, coercions } so coercion records propagate upward.
 *
 * Which scalar types exist is declared by the _type_scalar term, not by this
 * file — see type-registry.js. TYPE_VALIDATORS below records only which of them
 * this build can handle; a type the dictionary declares but the code cannot
 * validate raises UNIMPLEMENTED_SHAPE rather than passing silently.
 *
 * An empty _scalar ({}) means any scalar value is accepted.
 */

const { ErrorCode, makeError } = require('../errors');
const { tryCoerce }            = require('../coerce');
const { validateNumber }       = require('../types/number');
const { validateBoolean }      = require('../types/boolean');
const { validateString }       = require('../types/string');
const { validateText }         = require('../types/text');
const { validateHandle,
        validateTimestamp,
        validateEnumScope,
        validateTargetScope,
        validateObjectScope,
        validateScopeSibling } = require('../types/other');
const { validateEnum }         = require('../types/enum');
const { validateTermKey }      = require('../types/term-key');
const { scalarTypes }          = require('../type-registry');

// ── Dispatch table ────────────────────────────────────────────────────────────

// Adapters over a single call context, so every type can share one signature.
// `container` and `opts` reach the validators that need cross-property context —
// currently only validateObjectScope, which dereferences a sibling property when
// its body declares a target type.
const num    = c => validateNumber      (c.value, c.type, c.schema, c.path);
const str    = c => validateString      (c.value, c.type, c.schema, c.path);
const txt    = c => validateText        (c.value, c.type, c.schema, c.path);
const key    = c => validateTermKey     (c.value, c.type, c.schema, c.path, c.dbAccess);
const bool   = c => validateBoolean     (c.value, c.schema, c.path);
const hnd    = c => validateHandle      (c.value, c.schema, c.path);
const stamp  = c => validateTimestamp   (c.value, c.schema, c.path);
const enm    = c => validateEnum        (c.value, c.schema, c.path, c.dbAccess);
const scEnum = c => validateEnumScope   (c.value, c.schema, c.path, c.dbAccess);
const scTgt  = c => validateTargetScope (c.value, c.schema, c.path);
const scObj  = c => validateObjectScope (c.value, c.schema, c.path, c.container, c.dbAccess, c.opts);
const scSib  = c => validateScopeSibling(c.value, c.schema, c.path, c.dbAccess);

// The scalar types this validator can handle, and the handler for each. This
// table is NOT the vocabulary — which types exist is declared by the
// _type_scalar term and read via scalarTypes(dbAccess). This is the separate
// fact of which of them the code has an implementation for; type-registry.js
// falls back to its keys when there is no dictionary to consult.
//
// Enumerated one key per line rather than matched by prefix: a prefix test
// silently swallows any type it fails to match (that is how _handle_SVG went
// unvalidated), and it cannot be read back as a list.
const TYPE_VALIDATORS = {
	_number:                num,
	_number_float:          num,
	_number_integer:        num,

	_string:                str,
	_string_URI:            str,
	_string_Email:          str,
	_string_Hostname:       str,
	_string_IPv4:           str,
	_string_IPv6:           str,
	_string_YMD:            str,
	_string_date:           str,
	_string_time:           str,
	'_string_date-time':    str,
	_string_LaTeX:          str,
	_string_HEX:            str,
	_string_regexp:         str,

	_text:                  txt,
	_text_HTML:             txt,
	_text_Markdown:         txt,
	_text_SVG:              txt,

	_term_key:              key,
	'_term_key_enum-root':  key,
	'_term_key_enum-item':  key,
	_term_key_descriptor:   key,

	_handle:                hnd,
	_handle_SVG:            hnd, // a handle like any other; the blob it points at carries the SVG
	_timestamp:             stamp,
	_boolean:               bool,
	_enum:                  enm,

	_scope_enum:            scEnum,
	_scope_target:          scTgt,
	_scope_object:          scObj,
	_scope_sibling:         scSib,
};

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Validate a value against a _scalar schema object.
 *
 * @param {*}        value       - The value to validate.
 * @param {Object}   scalarSchema - The object that is the value of the _scalar key.
 * @param {string[]} path        - Current dot-path for error location.
 * @param {Object}   dbAccess    - DB accessor (may be null).
 * @param {Object}   opts        - Options: { coerce: boolean }.
 * @returns {{ errors: Object[], coercions: Object[] }}
 */
function validateScalar(value, scalarSchema, path, dbAccess, opts) {
	// Empty _scalar: any scalar value is accepted
	if (!scalarSchema || typeof scalarSchema !== 'object') {
		return { errors: [], coercions: [] };
	}

	const known    = scalarTypes(dbAccess);
	const typeKeys = Object.keys(scalarSchema).filter(k => known.has(k));

	if (typeKeys.length > 1) {
		return {
			errors: [makeError(
				ErrorCode.AMBIGUOUS_SHAPE, path, typeKeys, 'exactly 1 type key',
				`_scalar must contain exactly one type key; found: ${typeKeys.join(', ')}`
			)],
			coercions: [],
		};
	}

	// Empty schema or no recognised type key → accept any scalar
	if (typeKeys.length === 0) {
		return { errors: [], coercions: [] };
	}

	const type   = typeKeys[0];
	const schema = scalarSchema[type] || {};

	// Attempt coercion if enabled
	let actualValue = value;
	const coercions = [];
	if (opts && opts.coerce) {
		const result = tryCoerce(value, type);
		if (result) {
			actualValue = result.value;
			coercions.push({
				path:  path.join('.'),
				from:  result.from,
				to:    result.value,
				rule:  result.rule,
			});
		}
	}

	// `parentObject` is set by validateConformance when recursing into a child
	// property, giving cross-property validators (e.g. _scope_object) access to
	// the containing object so they can dereference sibling references.
	const container = opts && opts.parentObject;

	const handler = TYPE_VALIDATORS[type];

	// The dictionary declares a scalar type this build cannot validate. Say so
	// loudly: falling through silently would report the value as clean.
	if (!handler) {
		return {
			errors: [makeError(
				ErrorCode.UNIMPLEMENTED_SHAPE, path, type, 'a scalar type this validator implements',
				`Scalar type "${type}" is declared by _type_scalar but this validator has no implementation for it`
			)],
			coercions,
		};
	}

	const errors = handler({
		value: actualValue, type, schema, path: [...path, type], dbAccess, container, opts,
	});
	return { errors, coercions };
}

module.exports = { validateScalar, TYPE_VALIDATORS };
