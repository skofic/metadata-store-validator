'use strict';

/**
 * index.js — Public API for the metadata-store validation library.
 *
 * Entry points at different granularities:
 *
 *   validateValue(value, dataSection, dbAccess, opts)
 *     Validate a single value against a _data section. For real-time UI field
 *     validation where the descriptor is already known.
 *
 *   validateDocument(doc, descriptor, dbAccess, opts)
 *     Compute properties then validate a single document (term, edge, link,
 *     blob, or any object whose descriptor declares `_computed`).
 *
 *   validateFile(docs, getDescriptor, dbAccess, opts)
 *     Batch validation of an array of term documents. Stops collecting failures
 *     after opts.maxErrors documents have failed (default: 10).
 *
 *   validateByDictionary(doc, descriptorGid, dbAccess, opts)
 *   validateConformance(value, dataSection, path, dbAccess, opts)
 *     Dictionary-conformance validation (see conformance.js).
 *
 *   validateProperties(properties, dbAccess, opts)
 *     A flat object keyed by descriptor _gids — a data record's values.
 *
 *   describeEnvelopeNeeds(gids, dbAccess) / validateEnvelope(envelope, dbAccess, opts)
 *     Check per-descriptor aggregates (min, max, types, distinct values, counts)
 *     computed in the database, for data too large to validate value by value.
 *
 *   createReport(options)
 *     Tally findings across many validations: counts per code and descriptor,
 *     as a share of the values checked, printed once at the end.
 *
 *   checkUnitBounds(term, dbAccess)
 *     Authoring check: a descriptor whose declared range reaches beyond its
 *     unit's physical bound.
 *
 *   makeSnapshotDbAccess(snapshot, options)
 *     A synchronous dbAccess over a pre-fetched dictionary snapshot (no network).
 *
 *   applyComputed(doc, descriptorGid, dbAccess, opts) / checkComputeRegistry(dbAccess)
 *     Fill or verify every computed property a document's schema declares,
 *     through the compute registry; cross-check the registry against the
 *     dictionary's `_computed` declarations.
 *
 *   formFields(body) / checkFields(body, path)
 *     The ordered presentation list of a schema body (`_fields`, with the
 *     required-then-recommended fallback) and its authoring check — see fields.js.
 *
 * Every entry point reports `errors` and `warnings` separately. Only hard
 * constraints produce errors; a value outside `_range_normal` is a warning
 * (RANGE_OUTLIER — see WARNING_CODES in errors.js).
 *
 * ── dbAccess interface ──────────────────────────────────────────────────────
 *
 * Pass null to skip all DB-dependent checks (_enum, _term_key*, _typedef, unit
 * bounds). The full contract is documented in README.md; the core methods:
 *
 *   isEnumMember(value, roots) → boolean
 *   termExists(gid)            → boolean
 *   termHasRole(gid, role)     → boolean
 *   getTerm(gid)               → Object | null
 *   isEnumBranch(node, root)   → boolean   (optional)
 *
 * ── opts ────────────────────────────────────────────────────────────────────
 *
 *   coerce    {boolean} — attempt type coercion before strict validation.
 *                         Coerced values are reported in result.coercions.
 *   maxErrors {number}  — (validateFile only) stop after this many failed
 *                         documents. Default: 10. Set to 0 for unlimited.
 */

const { applyComputed,
        checkComputeRegistry }   = require('./compute');
const { validateData }           = require('./validate');
const { partitionFindings }      = require('./errors');
const { validateByDictionary,
        validateConformance }    = require('./conformance');
const { validateProperties }     = require('./properties');
const { describeEnvelopeNeeds,
        validateEnvelope }       = require('./envelope');
const { createReport }           = require('./report');
const { checkUnitBounds }        = require('./units');
const { makeSnapshotDbAccess }   = require('./snapshot');
const { formFields, checkFields,
        allowedProperties }      = require('./fields');

// ── helpers ───────────────────────────────────────────────────────────────────

function emptyResult() {
	return { errors: [], warnings: [], coercions: [] };
}

// Merge a validateData() result (one mixed findings array) into `target`.
function mergeInto(target, source) {
	const { errors, warnings } = partitionFindings(source.errors);
	target.errors.push(...errors);
	target.warnings.push(...warnings);
	target.coercions.push(...source.coercions);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a single scalar or structured value against a _data section.
 * Returns { errors, warnings, coercions }.
 */
function validateValue(value, dataSection, dbAccess, opts) {
	const result = emptyResult();
	mergeInto(result, validateData(value, dataSection || {}, [], dbAccess, opts || {}));
	return result;
}

/**
 * Compute properties then validate a single term document against a descriptor.
 * Returns { errors, warnings, coercions }.
 *
 * @param {Object} doc        - Term document (mutated in place for computed props).
 * @param {Object} descriptor - Descriptor term whose _data section defines the schema.
 *                              Pass null to skip data validation (compute only).
 * @param {Object} dbAccess   - DB accessor (may be null).
 * @param {Object} opts       - Options: { coerce } plus the compute flags
 *                              { noFill, quietCompute, strictCompute }.
 */
function validateDocument(doc, descriptor, dbAccess, opts) {
	const result = emptyResult();

	// Resolve computed properties first
	// Schema-driven when a dictionary is available (every `_computed`
	// declaration of the descriptor's bodies, through lib/compute-registry.js),
	// else the fixed core layout.
	const descriptorGid = descriptor && descriptor._code && descriptor._code._gid;
	const computed = applyComputed(doc, descriptorGid || null, dbAccess || null, opts);
	result.errors.push(...computed.errors);
	result.warnings.push(...computed.warnings);
	result.computed = computed.computed;
	if (computed.errors.length > 0) return result;

	// Validate against descriptor's _data section.
	// `parentObject` is initialised to `doc` so any _scope_object value sitting
	// at depth-1 in the document can resolve its path against the document root.
	// Deeper nesting still relies on validateConformance (which updates
	// parentObject on descent) — validateData does not maintain it.
	if (descriptor && descriptor._data) {
		const dataOpts = Object.assign({}, opts || {}, { parentObject: doc, rootObject: doc });
		mergeInto(result, validateData(doc, descriptor._data, [], dbAccess, dataOpts));
	}

	return result;
}

/**
 * Validate an array of term documents (batch file import flow).
 *
 * A document with warnings but no errors counts as passed.
 *
 * @param {Object[]} docs          - Array of documents to validate.
 * @param {Function} getDescriptor - Called with each doc; returns its descriptor term
 *                                   or null (skip data validation for that doc).
 * @param {Object}   dbAccess      - DB accessor (may be null).
 * @param {Object}   opts          - Options: { coerce, maxErrors }.
 * @returns {{
 *   passed:    number,
 *   failed:    number,
 *   warned:    number,
 *   truncated: boolean,
 *   errors:    Array<{ index, doc, errors }>,
 *   warnings:  Array<{ index, path, code, value, expected, message }>,
 *   coercions: Array<{ index, path, from, to, rule }>
 * }}
 */
function validateFile(docs, getDescriptor, dbAccess, opts) {
	const options = Object.assign({ maxErrors: 10, coerce: false }, opts || {});
	const report  = {
		passed: 0, failed: 0, warned: 0, truncated: false,
		errors: [], warnings: [], coercions: [],
	};

	for (let i = 0; i < docs.length; i++) {
		const doc        = docs[i];
		const descriptor = getDescriptor ? getDescriptor(doc) : null;
		const result     = validateDocument(doc, descriptor, dbAccess, options);

		for (const c of result.coercions) {
			report.coercions.push({ index: i, path: c.path, from: c.from, to: c.to, rule: c.rule });
		}
		if (result.warnings.length > 0) {
			report.warned++;
			for (const w of result.warnings) {
				report.warnings.push({ index: i, path: w.path, code: w.code, value: w.value, expected: w.expected, message: w.message });
			}
		}

		if (result.errors.length > 0) {
			report.failed++;
			report.errors.push({ index: i, doc: doc, errors: result.errors });
			if (options.maxErrors > 0 && report.failed >= options.maxErrors) {
				report.truncated = true;
				break;
			}
		} else {
			report.passed++;
		}
	}

	return report;
}

module.exports = {
	validateValue,
	validateDocument,
	validateFile,
	validateByDictionary,
	validateConformance,
	validateProperties,
	describeEnvelopeNeeds,
	validateEnvelope,
	createReport,
	checkUnitBounds,
	makeSnapshotDbAccess,
	formFields,
	checkFields,
	allowedProperties,
	applyComputed,
	checkComputeRegistry,
};
