'use strict';

/**
 * properties.js — Validate a data record's values.
 *
 * Data documents keep their values in an object keyed by descriptor _gids
 * (`{ env_climate_bio01: 12.3, chr_DomLeafType: "chr_DomLeafType_1" }`). Each
 * key is looked up in the dictionary and its value is checked against that
 * descriptor's _data section: type, valid range and the unit's physical bound
 * (errors), normal range (warnings), enumeration membership, string formats,
 * GeoJSON, and so on.
 *
 * Paths in the findings start with the descriptor gid, so a report can group
 * them by descriptor (see report.js).
 */

const { ErrorCode, makeError }                    = require('./errors');
const { validateConformance, deduplicateErrors }  = require('./conformance');

const OPEN_OBJECT = { _object: { _open: {} } };

/**
 * @param {Object} properties - Object keyed by descriptor _gid.
 * @param {Object} dbAccess   - DB accessor (required: the check IS the dictionary lookup).
 * @param {Object} [opts]     - { strict = true, coerce = false }. strict: an unknown
 *                              gid is an error (false → warning).
 * @returns {{ errors: Object[], warnings: Object[], coercions: Object[] }}
 */
function validateProperties(properties, dbAccess, opts) {
	if (!dbAccess) {
		throw new TypeError('validateProperties: a dbAccess is required — the values are checked against their descriptors');
	}
	if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
		return {
			errors: [makeError(
				ErrorCode.WRONG_TYPE, [], properties, 'object keyed by descriptor _gid',
				'Expected an object whose keys are descriptor _gids, got ' +
					(Array.isArray(properties) ? 'array' : properties === null ? 'null' : typeof properties)
			)],
			warnings:  [],
			coercions: [],
		};
	}

	const options = Object.assign({ strict: true, coerce: false }, opts || {});
	const raw     = validateConformance(properties, OPEN_OBJECT, [], dbAccess, options);
	return {
		errors:    deduplicateErrors(raw.errors),
		warnings:  deduplicateErrors(raw.warnings),
		coercions: raw.coercions,
	};
}

module.exports = { validateProperties };
