'use strict';

/**
 * compute.js — Resolve computed properties in documents before validation.
 *
 * Term documents  — computed: _key (top-level), _code._gid, _code._aid.
 * Edge documents  — computed: _key = MD5(_from + "/" + _predicate + "/" + _to).
 *
 * For each absent computed property the behaviour depends on opts:
 *
 *   Default (no opts)    fill in the computed value + emit COMPUTE_ADDED warning.
 *   strictCompute        fill in the computed value + emit COMPUTE_ADDED error.
 *   quietCompute         fill in the computed value silently (no message).
 *   noFill               do not mutate; emit COMPUTE_ADDED warning (or error if strictCompute).
 *
 * For each present computed property with a wrong value:
 *   Always emit COMPUTE_MISMATCH error regardless of opts. No mutation.
 *
 * NOTE: edge _key depends on _from/_to being fully-qualified handles. Always call
 * applyHandles (--resolve-handles) before computeEdgeKey / applyCompute.
 */

const { md5 }                 = require('./md5');
const { ErrorCode, makeError } = require('./errors');

/**
 * Compute the expected _gid from _nid and _lid.
 *
 * _nid absent       → _gid = _lid
 * _nid === ""       → _gid = "_" + _lid
 * _nid non-empty    → _gid = _nid + "_" + _lid
 */
function computeGid(nid, lid) {
	if (nid === undefined) return lid;
	if (nid === '')        return '_' + lid;
	return nid + '_' + lid;
}

function computeTermCode(doc, opts) {
	const errors        = [];
	const warnings      = [];
	const noFill        = opts && opts.noFill;
	const quietCompute  = opts && opts.quietCompute;
	const strictCompute = opts && opts.strictCompute;
	const code          = doc._code;

	if (!code || typeof code !== 'object') {
		errors.push(makeError(
			ErrorCode.MISSING_FIELD, ['_code'], doc._code,
			'object', 'Term document must have a _code section'
		));
		return { errors, warnings };
	}

	if (typeof code._lid !== 'string' || code._lid === '') {
		errors.push(makeError(
			ErrorCode.MISSING_FIELD, ['_code', '_lid'], code._lid,
			'non-empty string', '_lid is required to compute _gid'
		));
		return { errors, warnings };
	}

	const computed = computeGid(code._nid, code._lid);

	/**
	 * Handle an absent computed scalar property.
	 * Fills in the value (unless noFill) and emits a warning or error (unless quietCompute).
	 */
	function handleAbsent(path, label, value, assign) {
		if (!noFill) assign(value);
		if (!quietCompute) {
			const item = makeError(
				ErrorCode.COMPUTE_ADDED, path, undefined,
				String(value),
				label + ' is absent; computed value is "' + value + '"'
			);
			if (strictCompute) errors.push(item);
			else               warnings.push(item);
		}
	}

	// --- _gid ---
	if (code._gid === undefined) {
		handleAbsent(['_code', '_gid'], '_gid', computed, function(v) { code._gid = v; });
	} else if (code._gid !== computed) {
		errors.push(makeError(
			ErrorCode.COMPUTE_MISMATCH, ['_code', '_gid'], code._gid,
			computed,
			'_gid "' + code._gid + '" does not match computed value "' + computed + '"'
		));
	}

	// --- _key (top-level, must equal _gid) ---
	if (doc._key === undefined) {
		handleAbsent(['_key'], '_key', computed, function(v) { doc._key = v; });
	} else if (doc._key !== computed) {
		errors.push(makeError(
			ErrorCode.COMPUTE_MISMATCH, ['_key'], doc._key,
			computed,
			'_key "' + doc._key + '" does not match computed _gid "' + computed + '"'
		));
	}

	// --- _aid ---
	if (code._aid === undefined) {
		handleAbsent(
			['_code', '_aid'], '_aid',
			'[' + code._lid + ']',
			function() { code._aid = [code._lid]; }
		);
	} else if (Array.isArray(code._aid) && !code._aid.includes(code._lid)) {
		if (!noFill) code._aid.push(code._lid);
		if (!quietCompute) {
			const item = makeError(
				ErrorCode.COMPUTE_ADDED, ['_code', '_aid'], code._aid,
				'includes "' + code._lid + '"',
				'_lid "' + code._lid + '" was not in _aid' + (noFill ? '' : '; added automatically')
			);
			if (strictCompute) errors.push(item);
			else               warnings.push(item);
		}
	}

	return { errors, warnings };
}

/**
 * Resolve _key in an edge document.
 *
 * _key = LOWER(MD5(_from + "/" + _predicate + "/" + _to))
 *
 * Requires _from, _predicate, _to to already be fully-qualified handles.
 * If any of those fields is missing the function returns without acting.
 *
 * @param {Object}  doc
 * @param {Object}  [opts]  — same flags as computeTermCode
 * @returns {{ errors: Object[], warnings: Object[] }}
 */
function computeEdgeKey(doc, opts) {
	const errors        = [];
	const warnings      = [];
	const noFill        = opts && opts.noFill;
	const quietCompute  = opts && opts.quietCompute;
	const strictCompute = opts && opts.strictCompute;

	if (typeof doc._from      !== 'string' ||
	    typeof doc._predicate  !== 'string' ||
	    typeof doc._to         !== 'string') {
		return { errors, warnings };
	}

	const computed = md5(doc._from + '/' + doc._predicate + '/' + doc._to);

	if (doc._key === undefined) {
		if (!noFill) doc._key = computed;
		if (!quietCompute) {
			const item = makeError(
				ErrorCode.COMPUTE_ADDED, ['_key'], undefined,
				computed,
				'_key is absent; computed value is "' + computed + '"'
			);
			if (strictCompute) errors.push(item);
			else               warnings.push(item);
		}
	} else if (doc._key !== computed) {
		errors.push(makeError(
			ErrorCode.COMPUTE_MISMATCH, ['_key'], doc._key,
			computed,
			'_key "' + doc._key + '" does not match MD5(_from/_predicate/_to) "' + computed + '"'
		));
	}

	return { errors, warnings };
}

/**
 * Resolve _key in a blob document.
 *
 * _key = LOWER(MD5(_blob_item + "/" + _blob_type + "/" + _blob_kind + "/" + _blob_identifier))
 *
 * If any of the four identifying fields is missing the function returns without acting.
 *
 * @param {Object}  doc
 * @param {Object}  [opts]  — same flags as computeTermCode
 * @returns {{ errors: Object[], warnings: Object[] }}
 */
function computeBlobKey(doc, opts) {
	const errors        = [];
	const warnings      = [];
	const noFill        = opts && opts.noFill;
	const quietCompute  = opts && opts.quietCompute;
	const strictCompute = opts && opts.strictCompute;

	if (typeof doc._blob_item       !== 'string' ||
	    typeof doc._blob_type        !== 'string' ||
	    typeof doc._blob_kind        !== 'string' ||
	    typeof doc._blob_identifier  !== 'string') {
		return { errors, warnings };
	}

	const computed = md5(doc._blob_item + '/' + doc._blob_type + '/' + doc._blob_kind + '/' + doc._blob_identifier);

	if (doc._key === undefined) {
		if (!noFill) doc._key = computed;
		if (!quietCompute) {
			const item = makeError(
				ErrorCode.COMPUTE_ADDED, ['_key'], undefined,
				computed,
				'_key is absent; computed value is "' + computed + '"'
			);
			if (strictCompute) errors.push(item);
			else               warnings.push(item);
		}
	} else if (doc._key !== computed) {
		errors.push(makeError(
			ErrorCode.COMPUTE_MISMATCH, ['_key'], doc._key,
			computed,
			'_key "' + doc._key + '" does not match MD5 of blob fields "' + computed + '"'
		));
	}

	return { errors, warnings };
}

module.exports = { computeTermCode, computeEdgeKey, computeBlobKey };
