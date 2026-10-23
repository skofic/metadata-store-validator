'use strict';

/**
 * fields.js — The `_fields` presentation list of a schema body.
 *
 * A schema body (the content of `_open` or `_closed`, typed by `_rule`) may
 * carry `_fields`: an ordered `_objects` array with one entry per property,
 * stating the order in which a form presents the properties, the panel each
 * belongs to (`_group`) and whether the property is indexed in the collection
 * holding the object (`_index`). The presence rules and qualifiers of the body
 * are untouched by it; `_fields` only adds presentation.
 *
 * Two functions:
 *
 *   checkFields(body, path)
 *     Authoring check, run by the conformance validator whenever a validated
 *     object carries a `_fields` property (i.e. whenever a schema body is
 *     validated against `_rule`):
 *       FIELD_NOT_IN_SCHEMA  error    — `_field` is not in the body's
 *                                        _required ∪ _recommended ∪ _computed
 *                                        ∪ _locked ∪ _immutable
 *       FIELD_BANNED         error    — `_field` is in the body's _banned
 *       FIELDS_INCOMPLETE    warning  — a member of _required ∪ _recommended
 *                                        is not listed
 *     The structural checks (entry shape, `_field` a descriptor, no duplicate
 *     `_field`) are the ordinary `_objects` validation of the `_fields` term.
 *
 *   formFields(body)
 *     The ordered field list a form builder, the `/fields/:gid` route and an
 *     index generator all consume — ONE implementation of the order rule:
 *       `_fields` order first, then any member of _required ∪ _recommended it
 *       left out, in required-then-recommended order; without `_fields` the
 *       whole list is the fallback (`fallback: true`).
 *     Each entry: { gid, group, index, required, selector, computed, locked,
 *                   immutable, default }.
 *       computed  the property is derived by the system (a `_computed` entry of
 *                 any kind but constant): hidden on creation, read-only after
 *       group     `_group_main` when the entry carries no `_group`
 *       index     the `_index` member or null
 *       required  true only for a member of an unconditional `_all {}`
 *                 selector — a property that must simply be present
 *       selector  { id, kind: 'all'|'any', min, max, group? } when the
 *                 property belongs to a `_required` selector; `group` is the
 *                 inner group index of a layered (pipeline) selection. A form
 *                 renders the members of one selector together as one choice.
 *       default   the pre-fill: the `_compute_value` of a constant-kind
 *                 `_computed` entry (reported with computed: false — the user
 *                 may change it)
 *
 *   computedFields(body) / computedEntry(body, gid)
 *     The one reader of `_computed` (entry objects naming the property in
 *     `_field`); used by every consumer of the list.
 */

const { ErrorCode, makeError } = require('./errors');

/**
 * The computed-property gids of a body: the `_field` of each `_computed` entry.
 * Malformed entries (including the bare gid strings retired in v1.5.0) are
 * skipped here — the compute driver reports them.
 */
function computedFields(body) {
	const list = body && Array.isArray(body._computed) ? body._computed : [];
	const out = [];
	for (const e of list) {
		if (e && typeof e === 'object' && typeof e._field === 'string') out.push(e._field);
	}
	return out;
}

/** The `_computed` entry object that declares `gid`, or null. */
function computedEntry(body, gid) {
	const list = body && Array.isArray(body._computed) ? body._computed : [];
	for (const e of list) {
		if (e && typeof e === 'object' && e._field === gid) return e;
	}
	return null;
}

/** Flatten a `_selection` (strings, or arrays of strings for a layered selection). */
function selectionGids(selection) {
	const out = [];
	for (const item of (selection || [])) {
		if (Array.isArray(item)) out.push(...selectionGids(item));
		else if (typeof item === 'string') out.push(item);
	}
	return out;
}

/** The property gids named by the body's `_required` selectors, in declaration order. */
function requiredGids(body) {
	return (body._required || []).flatMap(function(sel) {
		return selectionGids(sel && sel._selection);
	});
}

/**
 * The set of properties a body admits: _required ∪ _recommended ∪ _computed
 * ∪ _locked ∪ _immutable. This is the closed-schema whitelist (object.js uses
 * the same union) and the set a `_fields` entry may name.
 */
function allowedProperties(body) {
	return new Set([
		...requiredGids(body),
		...(body._recommended || []),
		...computedFields(body),
		...(body._locked      || []),
		...(body._immutable   || []),
	]);
}

function describeSelector(def) {
	if (!def || typeof def !== 'object') return null;
	const kind = '_all' in def ? 'all' : ('_any' in def ? 'any' : null);
	if (!kind) return null;
	const rule = def['_' + kind] || {};
	return { kind, min: rule['_min-items'], max: rule['_max-items'] };
}

/**
 * Map each required property to its selector description.
 * Flat selection: { id, kind, min, max }.
 * Layered selection (e.g. _range): the FIRST selector applies within each inner
 * group → { id, kind, min, max, group }.
 */
function selectorMap(body) {
	const map = new Map();
	(body._required || []).forEach(function(sel, id) {
		if (!sel || typeof sel !== 'object') return;
		const first = describeSelector((sel._selectors || [])[0]);
		const selection = sel._selection || [];
		const layered = selection.some(Array.isArray);
		if (layered) {
			selection.forEach(function(group, g) {
				for (const gid of selectionGids(Array.isArray(group) ? group : [group])) {
					if (!map.has(gid)) map.set(gid, Object.assign({ id }, first || { kind: 'all' }, { group: g }));
				}
			});
		} else {
			for (const gid of selectionGids(selection)) {
				if (!map.has(gid)) map.set(gid, Object.assign({ id }, first || { kind: 'all' }));
			}
		}
	});
	return map;
}

/** True when the selector leaves no choice: an `_all` with no count limits. */
function isUnconditional(sel) {
	return !!sel && sel.kind === 'all' && sel.min === undefined && sel.max === undefined;
}

/**
 * Check a body's `_fields` list against the body's own rule lists.
 * Returns { errors, warnings } (already separated). A body without `_fields`
 * yields nothing.
 */
function checkFields(body, path) {
	const errors = [], warnings = [];
	const list = body && body._fields;
	if (!Array.isArray(list)) return { errors, warnings };

	const base    = Array.isArray(path) ? path : (path ? [path] : []);
	const allowed = allowedProperties(body);
	const banned  = new Set(body._banned || []);
	const listed  = new Set();

	list.forEach(function(entry, i) {
		const gid = entry && entry._field;
		if (typeof gid !== 'string') return;           // shape errors are reported by _objects
		listed.add(gid);
		const at = [...base, '_fields', '[' + i + ']', '_field'];
		if (banned.has(gid)) {
			errors.push(makeError(
				ErrorCode.FIELD_BANNED, at, gid, 'a property not in _banned',
				`_fields places "${gid}", which the schema bans`
			));
		} else if (!allowed.has(gid)) {
			errors.push(makeError(
				ErrorCode.FIELD_NOT_IN_SCHEMA, at, gid,
				`one of [${[...allowed].join(', ')}]`,
				`_fields places "${gid}", which the schema does not admit (not in _required, _recommended, _computed, _locked or _immutable)`
			));
		}
	});

	const expected = [];
	for (const gid of [...requiredGids(body), ...(body._recommended || [])]) {
		if (!listed.has(gid) && !expected.includes(gid)) expected.push(gid);
	}
	if (expected.length > 0) {
		warnings.push(makeError(
			ErrorCode.FIELDS_INCOMPLETE, [...base, '_fields'], expected,
			'every _required and _recommended property listed',
			`_fields does not place: ${expected.join(', ')} (they are presented last, in required-then-recommended order)`
		));
	}
	return { errors, warnings };
}

/**
 * The ordered field list of a schema body.
 * Returns { fallback, fields }.
 */
function formFields(body) {
	body = body && typeof body === 'object' ? body : {};
	const list      = Array.isArray(body._fields) ? body._fields : null;
	const selectors = selectorMap(body);
	const locked    = new Set(body._locked    || []);
	const immutable = new Set(body._immutable || []);

	const order = [];                       // [{ gid, entry }]
	const seen  = new Set();
	for (const entry of (list || [])) {
		const gid = entry && entry._field;
		if (typeof gid !== 'string' || seen.has(gid)) continue;
		seen.add(gid); order.push({ gid, entry });
	}
	for (const gid of [...requiredGids(body), ...(body._recommended || [])]) {
		if (seen.has(gid)) continue;
		seen.add(gid); order.push({ gid, entry: null });
	}

	const fields = order.map(function({ gid, entry }) {
		const sel = selectors.get(gid) || null;
		// A constant-kind computed property is a pre-fill the user may change:
		// reported as `default`, not as `computed`.
		const centry   = computedEntry(body, gid);
		const constant = centry && typeof centry === 'object' && centry._compute_kind === '_compute_kind_constant';
		return {
			gid,
			group:     (entry && entry._group) || '_group_main',
			index:     (entry && entry._index) || null,
			required:  isUnconditional(sel),
			selector:  sel && !isUnconditional(sel) ? sel : null,
			computed:  centry !== null && !constant,
			locked:    locked.has(gid),
			immutable: immutable.has(gid),
			default:   constant ? centry._compute_value : undefined,
		};
	});
	return { fallback: list === null, fields };
}

module.exports = { checkFields, formFields, allowedProperties, requiredGids, computedFields, computedEntry };
