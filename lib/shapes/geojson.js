'use strict';

/**
 * shapes/geojson.js — Validator for the _object_GeoJSON data shape.
 *
 * A top-level data shape (sibling to _object, _objects, _scalar, …) marking a
 * value as a GeoJSON geometry. Unlike _object, its contents are NOT described
 * by the dictionary's rule language — validation is delegated entirely to this
 * dedicated handler.
 *
 * Schema body (optional companion):
 *   { _type_GeoJSON: ["_type_GeoJSON_Point", ...] }
 *     — narrows the allowed `type` field. Each value is a `_type_GeoJSON_*`
 *       enum-member gid; the leaf (after stripping `_type_GeoJSON_`) IS the
 *       bare GeoJSON `type` string. Absent → any geometry type accepted.
 *
 * Structural validation (RFC 7946 + the Google S2 constraints ArangoDB's geo
 * index imposes) is delegated to the geojson-s2 package. That library is shared
 * rather than local because the same checks are needed wherever geometry enters
 * the system — notably the external-data loader — and because ArangoDB itself
 * validates none of it: a malformed polygon inserts silently and fails later, at
 * query time, or not at all.
 *
 * Severity: the library distinguishes faults that break ArangoDB from faults it
 * tolerates (a counter-clockwise hole, which it silently inverts). The dictionary
 * reports BOTH as errors — it defines a metadata standard, so RFC 7946
 * conformance is the point, not merely surviving the database.
 */

const { ErrorCode, makeError } = require('../errors');
const { validateGeometry }     = require('geojson-s2');

// Issues about ring winding get their own error code: unlike every other fault
// here, a clockwise exterior ring is accepted by S2 and indexed as the complement
// of the intended region, so it is silent corruption rather than a failure.
const WINDING_ISSUES = new Set(['EXTERIOR_NOT_CCW', 'HOLE_NOT_CW']);

/**
 * Validate a value against an _object_GeoJSON shape body.
 *
 * @param {*}        value    - The value to validate (must be a plain object).
 * @param {Object}   geoSchema - The _object_GeoJSON body (e.g. { _type_GeoJSON: [...] }).
 * @param {string[]} path     - Current dot-path for error location.
 * @returns {{ errors: Object[], coercions: Object[] }}
 */
function validateGeoJSON(value, geoSchema, path) {
	const result = { errors: [], coercions: [] };

	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		result.errors.push(makeError(
			ErrorCode.WRONG_TYPE, path, value, 'object',
			`Expected a GeoJSON object, got ${Array.isArray(value) ? 'array' : typeof value}`
		));
		return result;
	}

	// Optional `_type_GeoJSON` companion narrows the allowed geometry types.
	const allowed = (geoSchema || {})._type_GeoJSON;
	if (Array.isArray(allowed) && allowed.length > 0) {
		const allowedLeaves = allowed.map(function(gid) {
			return String(gid).replace(/^_type_GeoJSON_/, '');
		});
		const actual = typeof value.type === 'string' ? value.type : null;
		if (!actual || allowedLeaves.indexOf(actual) === -1) {
			result.errors.push(makeError(
				ErrorCode.INVALID_GEOJSON_TYPE, [...path, 'type'], actual,
				`one of [${allowedLeaves.join(', ')}]`,
				`GeoJSON object's "type" field is "${actual}"; expected one of [${allowedLeaves.join(', ')}]`
			));
		}
	}

	// Structural + S2 validation. Runs regardless of whether _type_GeoJSON is
	// declared: the narrowing above only constrains which geometry types are
	// allowed, not whether the geometry itself is well formed.
	const { issues } = validateGeometry(value, { warningsAsErrors: true });
	for (const i of issues) {
		result.errors.push(makeError(
			WINDING_ISSUES.has(i.code) ? ErrorCode.INVALID_GEOJSON_WINDING : ErrorCode.INVALID_GEOJSON,
			i.path ? [...path, i.path] : path,
			i.code,
			'a GeoJSON geometry valid under RFC 7946 and Google S2',
			i.message
		));
	}

	return result;
}

module.exports = { validateGeoJSON };
