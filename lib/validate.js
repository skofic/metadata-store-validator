'use strict';

/**
 * validate.js — Main shape dispatcher.
 *
 * validateData() is the single recursive entry point for validating any value
 * against any _data section. It identifies the active shape key and delegates
 * to the appropriate shape validator.
 *
 * Which shape keys exist is declared by the _type_shape term, not by this file —
 * see type-registry.js. SHAPE_VALIDATORS below records only which of them this
 * build can handle; a shape the dictionary declares but the code cannot validate
 * raises UNIMPLEMENTED_SHAPE rather than passing silently.
 *
 * All shape validators return { errors: [], coercions: [] }.
 * An empty _data section ({}) means any value is accepted.
 */

const { ErrorCode, makeError } = require('./errors');
const { validateScalar }       = require('./shapes/scalar');
const { validateObject }       = require('./shapes/object');
const { validateGeoJSON }      = require('./shapes/geojson');
const { validateObjects }      = require('./shapes/objects');
const { validateArray }        = require('./shapes/array');
const { validateSet }          = require('./shapes/set');
const { validateDict }         = require('./shapes/dict');
const { validateKeyedBy }      = require('./shapes/keyed-by');
const { validateTuple }        = require('./shapes/tuple');
const { validateNested }       = require('./shapes/nested');
const { validateTypedef }      = require('./shapes/typedef');

const { shapeKeys } = require('./type-registry');

// The shapes this validator can handle, and the handler for each. This table is
// NOT the vocabulary — which shapes exist is declared by the _type_shape term
// and read via shapeKeys(dbAccess). This is the separate fact of which of them
// the code has an implementation for; type-registry.js falls back to its keys
// when there is no dictionary to consult.
const SHAPE_VALIDATORS = {
	_scalar:         validateScalar,
	_object:         validateObject,
	_object_GeoJSON: validateGeoJSON,
	_objects:        validateObjects,
	_array:          validateArray,
	_set:            validateSet,
	_dict:           validateDict,
	_keyed:          validateKeyedBy,
	_tuple:          validateTuple,
	_nested:         validateNested,
	_typedef:        validateTypedef,
};

/**
 * Validate a value against a _data section.
 *
 * @param {*}        value      - The value to validate.
 * @param {Object}   dataSection - A term's _data section (or a nested shape object).
 * @param {string[]} path       - Current dot-path for error location.
 * @param {Object}   dbAccess   - DB accessor (may be null).
 * @param {Object}   opts       - Options: { coerce: boolean }.
 * @returns {{ errors: Object[], coercions: Object[] }}
 */
function validateData(value, dataSection, path, dbAccess, opts) {
	// Empty or missing _data: any value is accepted
	if (!dataSection || typeof dataSection !== 'object') {
		return { errors: [], coercions: [] };
	}

	const known   = shapeKeys(dbAccess);
	const present = Object.keys(dataSection).filter(function(k) {
		return known.indexOf(k) !== -1;
	});

	if (present.length > 1) {
		return {
			errors: [makeError(
				ErrorCode.AMBIGUOUS_SHAPE, path, present, 'exactly 1 shape key',
				`_data must contain at most one shape key; found: ${present.join(', ')}`
			)],
			coercions: [],
		};
	}

	if (present.length === 0) {
		return { errors: [], coercions: [] };
	}

	const shapeKey    = present[0];
	const shapeSchema = dataSection[shapeKey];
	const handler     = SHAPE_VALIDATORS[shapeKey];

	// The dictionary declares a shape this build cannot validate. Say so loudly:
	// falling through silently would report the value as clean.
	if (!handler) {
		return {
			errors: [makeError(
				ErrorCode.UNIMPLEMENTED_SHAPE, path, shapeKey, 'a shape this validator implements',
				`Shape "${shapeKey}" is declared by _type_shape but this validator has no implementation for it`
			)],
			coercions: [],
		};
	}

	return handler(value, shapeSchema, path, dbAccess, opts);
}

module.exports = { validateData, SHAPE_VALIDATORS };
