'use strict';

/**
 * errors.js — Error codes and builder for the validation library.
 *
 * Every validation function returns an array of error objects built with makeError().
 * An empty array means the value is valid.
 */

const ErrorCode = {
	// Type / shape errors
	WRONG_TYPE:          'WRONG_TYPE',          // value is not the expected JS type
	AMBIGUOUS_SHAPE:     'AMBIGUOUS_SHAPE',     // multiple shape keys present in _data or _scalar
	MISSING_SHAPE:       'MISSING_SHAPE',       // no recognisable shape key present
	UNKNOWN_PROPERTY:    'UNKNOWN_PROPERTY',    // closed schema: property not in whitelist

	// Required / banned
	MISSING_REQUIRED:    'MISSING_REQUIRED',    // required property is absent
	BANNED_PROPERTY:     'BANNED_PROPERTY',     // banned property is present
	SELECTION_VIOLATION: 'SELECTION_VIOLATION', // _required selector count not satisfied

	// Value errors
	RANGE_VIOLATION:     'RANGE_VIOLATION',     // value outside _range_valid (hard error)
	RANGE_OUTLIER:       'RANGE_OUTLIER',       // value outside _range_normal (warning)
	REGEXP_MISMATCH:     'REGEXP_MISMATCH',     // string does not match _regexp constraint
	CASE_MISMATCH:       'CASE_MISMATCH',       // string letter case violates the _case constraint
	LENGTH_VIOLATION:    'LENGTH_VIOLATION',    // string length outside the _length bounds
	INVALID_ENUM:        'INVALID_ENUM',        // _enum value is not a member of the vocabulary
	INVALID_ENUM_SCOPE:  'INVALID_ENUM_SCOPE',  // _scope_enum value is not a valid enum root or compound root.node
	INVALID_TARGET_SCOPE:'INVALID_TARGET_SCOPE',// _scope_target value is not a valid handle.property compound string
	INVALID_OBJECT_SCOPE:'INVALID_OBJECT_SCOPE',// _scope_object value is not a valid property reference
	INVALID_SIBLING_SCOPE:'INVALID_SIBLING_SCOPE',// _scope_sibling value is not a valid local sibling reference
	INVALID_SIBLING_TYPE:'INVALID_SIBLING_TYPE', // _scope_sibling leaf descriptor's declared type can never produce string values (dict keys)
	INVALID_TERM_KEY:    'INVALID_TERM_KEY',    // _term_key references an unknown or wrong-role term
	INVALID_HANDLE:      'INVALID_HANDLE',      // _handle is malformed or missing
	INVALID_KEY_TYPE:    'INVALID_KEY_TYPE',    // _dict_key declares a type that _type_key does not list as key-eligible

	// Dictionary / implementation mismatch
	UNIMPLEMENTED_SHAPE: 'UNIMPLEMENTED_SHAPE', // the dictionary declares a shape or scalar type this validator cannot handle

	// Collection size
	MIN_ITEMS:           'MIN_ITEMS',           // array / set has fewer elements than _min-items
	MAX_ITEMS:           'MAX_ITEMS',           // array / set has more elements than _max-items

	// _objects cross-element invariants and positional dispatch
	DUPLICATE_VALUE:        'DUPLICATE_VALUE',        // _unique: a value appears at >1 elements
	ORDERING_VIOLATION:     'ORDERING_VIOLATION',     // _ordered: values are out of order for the declared direction
	NO_SCHEMA_FOR_POSITION: 'NO_SCHEMA_FOR_POSITION', // _objects: element index has no matching slot schema

	// _scope_object target validation
	UNREACHABLE_OBJECT_SCOPE: 'UNREACHABLE_OBJECT_SCOPE', // _scope_object body is non-empty but the referenced sibling is missing from the container

	// _object_GeoJSON type-narrowing and structure
	INVALID_GEOJSON_TYPE:   'INVALID_GEOJSON_TYPE',   // GeoJSON object's `type` field is not in the _type_GeoJSON allowed set
	INVALID_GEOJSON:        'INVALID_GEOJSON',        // GeoJSON structure or coordinates are malformed (RFC 7946 / S2)
	INVALID_GEOJSON_WINDING:'INVALID_GEOJSON_WINDING',// polygon ring winds the wrong way; S2 would index the complement of the intended area

	// Reference errors
	TYPEDEF_NOT_FOUND:   'TYPEDEF_NOT_FOUND',   // _typedef value does not match any term _gid
	INVALID_TYPEDEF:     'INVALID_TYPEDEF',     // the typedef term has no usable _data section

	// Compute errors
	MISSING_FIELD:       'MISSING_FIELD',       // a field required for property computation is absent
	COMPUTE_MISMATCH:    'COMPUTE_MISMATCH',    // existing value differs from the computed value (error)
	COMPUTE_ADDED:       'COMPUTE_ADDED',       // computed _gid was missing from _aid and was added (warning)
};

/**
 * Build an error object.
 *
 * @param {string}          code     - One of the ErrorCode constants.
 * @param {string|string[]} path     - Location of the error: dot-path string or array of segments.
 * @param {*}               value    - The actual value that failed validation.
 * @param {string}          expected - Human-readable description of what was expected.
 * @param {string}          message  - Full human-readable error message.
 * @returns {{ code, path, value, expected, message }}
 */
function makeError(code, path, value, expected, message) {
	return {
		code,
		path:     Array.isArray(path) ? path.join('.') : (path || ''),
		value,
		expected,
		message,
	};
}

module.exports = { ErrorCode, makeError };
