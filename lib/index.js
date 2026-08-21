'use strict';

/**
 * index.js — Public API for the metadata-store validation library.
 *
 * Three entry points at different granularities:
 *
 *   validateValue(value, dataSection, dbAccess, opts)
 *     Validate a single value against a _data section. For real-time UI field
 *     validation where the descriptor is already known.
 *
 *   validateDocument(doc, descriptor, dbAccess, opts)
 *     Compute properties then validate a single document. For term insertion
 *     and UI confirmation flows.
 *
 *   validateFile(docs, getDescriptor, dbAccess, opts)
 *     Batch validation of an array of documents. Stops collecting failures
 *     after opts.maxErrors documents have failed (default: 10).
 *
 * ── dbAccess interface ──────────────────────────────────────────────────────
 *
 * Pass null to skip all DB-dependent checks (_enum, _term_key*, _typedef).
 * When provided, the object must implement:
 *
 *   isEnumMember(value, roots)  → boolean
 *     True if the term with _gid `value` is reachable via _predicate_enum-of
 *     from at least one of the `roots` (array of root _gids).
 *
 *   termExists(gid)  → boolean
 *     True if a term with the given _gid exists in the dictionary.
 *
 *   termHasRole(gid, role)  → boolean
 *     True if the term has `role` in its _domn._term_role array.
 *
 *   getTerm(gid)  → Object | null
 *     Returns the full term document (must include _data) or null.
 *
 *   isEnumBranch(node, root)  → boolean   (optional)
 *     True if `node` is a valid branch in the graph rooted at `root` —
 *     i.e. linked into root via _predicate_section-of (a section grouping)
 *     or _predicate_bridge-of (a bridge into another enumeration). Consulted
 *     only by _scope_enum compound validation, which accepts elements OR
 *     branches as the node. If the dbAccess implementation omits this
 *     method, _scope_enum nodes fall back to elements-only.
 *
 * ── opts ────────────────────────────────────────────────────────────────────
 *
 *   coerce    {boolean} — attempt type coercion before strict validation.
 *                         Coerced values are reported in result.coercions.
 *   maxErrors {number}  — (validateFile only) stop after this many failed
 *                         documents. Default: 10. Set to 0 for unlimited.
 */

const { computeTermCode }                        = require('./compute');
const { validateData }                           = require('./validate');
const { validateByDictionary, validateConformance } = require('./conformance');

// ── helpers ───────────────────────────────────────────────────────────────────

function emptyResult() {
	return { errors: [], coercions: [] };
}

function mergeInto(target, source) {
	target.errors.push(...source.errors);
	target.coercions.push(...source.coercions);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a single scalar or structured value against a _data section.
 * Returns { errors, coercions }.
 */
function validateValue(value, dataSection, dbAccess, opts) {
	return validateData(value, dataSection || {}, [], dbAccess, opts || {});
}

/**
 * Compute properties then validate a single term document against a descriptor.
 * Returns { errors, coercions }.
 *
 * @param {Object} doc        - Term document (mutated in place for computed props).
 * @param {Object} descriptor - Descriptor term whose _data section defines the schema.
 *                              Pass null to skip data validation (compute only).
 * @param {Object} dbAccess   - DB accessor (may be null).
 * @param {Object} opts       - Options: { coerce }.
 */
function validateDocument(doc, descriptor, dbAccess, opts) {
	const result = emptyResult();

	// Resolve computed properties first
	const computeErrors = computeTermCode(doc);
	result.errors.push(...computeErrors);
	if (computeErrors.length > 0) return result;

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
 * Validate an array of documents (batch file import flow).
 *
 * @param {Object[]} docs          - Array of documents to validate.
 * @param {Function} getDescriptor - Called with each doc; returns its descriptor term
 *                                   or null (skip data validation for that doc).
 * @param {Object}   dbAccess      - DB accessor (may be null).
 * @param {Object}   opts          - Options: { coerce, maxErrors }.
 * @returns {{
 *   passed:    number,
 *   failed:    number,
 *   truncated: boolean,
 *   errors:    Array<{ index, doc, errors }>,
 *   coercions: Array<{ index, path, from, to, rule }>
 * }}
 */
function validateFile(docs, getDescriptor, dbAccess, opts) {
	const options   = Object.assign({ maxErrors: 10, coerce: false }, opts || {});
	const report    = { passed: 0, failed: 0, truncated: false, errors: [], coercions: [] };

	for (let i = 0; i < docs.length; i++) {
		const doc        = docs[i];
		const descriptor = getDescriptor ? getDescriptor(doc) : null;

		// Compute
		const computeErrors = computeTermCode(doc);
		if (computeErrors.length > 0) {
			report.failed++;
			report.errors.push({ index: i, doc: doc, errors: computeErrors });
			if (options.maxErrors > 0 && report.failed >= options.maxErrors) {
				report.truncated = true;
				break;
			}
			continue;
		}

		// Validate
		const dataSection = (descriptor && descriptor._data) ? descriptor._data : {};
		const result      = validateData(doc, dataSection, [], dbAccess, options);

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

		for (const c of result.coercions) {
			report.coercions.push({ index: i, path: c.path, from: c.from, to: c.to, rule: c.rule });
		}
	}

	return report;
}

module.exports = { validateValue, validateDocument, validateFile, validateByDictionary, validateConformance };
