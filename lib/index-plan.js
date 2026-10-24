'use strict';

/**
 * index-plan.js — What a collection index must cover, read from the dictionary.
 *
 * A schema body (the content of `_open` or `_closed`) says how its properties
 * are indexed in the collection holding the object:
 *
 *   - on a `_fields` entry, `_index` indexes that one property with an intent:
 *       _index_identity  the whole value is one token (exact match; a facet
 *                        when the type is an enumeration)
 *       _index_text      analysed text, one field per configured language on a
 *                        multilingual value
 *       _index_segment   the value split on the `_` namespace separator (the
 *                        `_gid` index)
 *   - on the body itself, `_index` indexes EVERY property the container holds,
 *     listed or not — the open container's answer to properties no list names
 *     (`_domn`). Entries may still refine single properties.
 *
 * indexPlan(rootGid, dbAccess, opts) walks the root schema through its
 * containers and returns the abstract plan: which paths, with which intent,
 * of which leaf type. It names no analyzer, no index name and no database
 * feature — the service that owns the collection maps the plan to its index
 * (lib/index-gen.js in metadata-store-service) and compares the result with
 * the live index. The same plan serves a form or a search page asking "which
 * properties of this object are indexed, and how".
 *
 *   indexPlan('_term', dbAccess, { languages: ['ISO_639_3_eng'] })
 *   → { root: '_term', languages: [...],
 *       containers: [ { path: '_domn', intent: '_index_identity' } ],
 *       fields: [
 *         { path: '_code._gid',   gid: '_gid',   intent: '_index_segment',  leaf: '_string', shape: '_scalar' },
 *         { path: '_info._title', gid: '_title', intent: '_index_text',     leaf: '_text',   shape: '_dict',
 *           multilingual: true, languages: ['ISO_639_3_eng'] },
 *         { path: '_domn._term_role', gid: '_term_role', intent: '_index_identity', leaf: '_enum',
 *           shape: '_set', enums: ['_term_role'], single: false },
 *         ... ],
 *       problems: [ { path, code, message } ] }
 *
 * Problems are warnings about the declarations, never thrown:
 *   UNKNOWN_TERM          a `_field` names no term
 *   HINT_ON_CONTAINER     an `_index` hint on an entry whose property is an
 *                         object schema (hints belong on the leaves inside it,
 *                         or on that body)
 *   UNINDEXABLE_SHAPE     a hint on an `_objects`, `_tuple`, `_keyed` or
 *                         GeoJSON property
 *   SEGMENT_ON_NON_STRING `_index_segment` on a leaf that is not a string type
 *   TEXT_ON_TOKEN         `_index_text` on an identifier, enumeration, number
 *                         or boolean leaf (it would be lower-cased and stemmed)
 *   IDENTITY_ON_TEXT      `_index_identity` on a text leaf (exact match on a
 *                         paragraph matches nothing)
 *   TOO_DEEP              containers nested beyond MAX_DEPTH
 *
 * Multilingual values: a `_dict` keyed by the `ISO_639_3` enumeration, or a
 * typedef / term carrying `_term_role_multilingual`, is one value in many
 * languages. The plan marks the field `multilingual: true` and carries the
 * configured languages; the service expands the path once per language
 * (`_info._title.ISO_639_3_eng`). Any other `_dict` is marked `dict: true`:
 * its keys are data, so the service indexes everything under the path.
 */

const INTENTS = ['_index_identity', '_index_text', '_index_segment'];
const DEFAULT_LANGUAGES = ['ISO_639_3_eng'];
const LANGUAGE_ENUM = 'ISO_639_3';
const MULTILINGUAL_ROLE = '_term_role_multilingual';
const MAX_DEPTH = 8;

const STRING_LEAVES = new Set([
	'_string', '_string_URI', '_string_Email', '_string_Hostname', '_string_IPv4', '_string_IPv6',
	'_string_YMD', '_string_date', '_string_time', '_string_date-time', '_string_LaTeX', '_string_HEX',
	'_string_regexp', '_term_key', '_term_key_enum-root', '_term_key_enum-item', '_term_key_descriptor',
	'_handle', '_handle_SVG', '_enum', '_scope_enum', '_scope_object', '_scope_sibling', '_scope_target',
]);
const TEXT_LEAVES  = new Set(['_text', '_text_HTML', '_text_Markdown', '_text_SVG']);
const TOKEN_LEAVES = new Set([
	'_term_key', '_term_key_enum-root', '_term_key_enum-item', '_term_key_descriptor', '_enum',
	'_number', '_number_float', '_number_integer', '_boolean', '_timestamp', '_handle', '_handle_SVG',
]);
const UNINDEXABLE  = new Set(['_objects', '_tuple', '_keyed', '_object_GeoJSON']);
const CONTAINER_COMPANIONS = new Set(['_elements', '_layout_list']);

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** The schema body (_open or _closed content) of a term, through one _typedef hop; null when the term is not an object schema. */
function bodyOf(term, dbAccess) {
	if (!term || !isObj(term._data)) return null;
	let data = term._data;
	if (typeof data._typedef === 'string') {
		const t = dbAccess.getTerm(data._typedef);
		if (!t || !isObj(t._data)) return null;
		data = t._data;
	}
	const obj = data._object;
	if (!isObj(obj)) return null;
	return obj._closed || obj._open || null;
}

function roles(term) {
	const r = term && term._domn && term._domn._term_role;
	return Array.isArray(r) ? r : [];
}

/** The element key of a container shape body (the type or shape key beside _elements / _layout_list). */
function elementKey(shapeBody) {
	return Object.keys(shapeBody || {}).find(k => !CONTAINER_COMPANIONS.has(k)) || null;
}

/**
 * Resolve a `_data` section to its terminal shape and leaf type, unwrapping
 * `_array` / `_set` / `_nested` and following `_typedef` (one hop at each
 * level, as the dictionary allows it inside an array). Returns
 * { shape, leaf, body, multilingual, enums }:
 *   shape        the outermost shape key of `data` (`_scalar`, `_set`, `_dict`, `_array`, ...)
 *   leaf         the scalar type at the bottom, or null
 *   body         the leaf type's companion body (for `_enums`)
 *   multilingual true when a `_dict` keyed by ISO_639_3 or a multilingual typedef is met
 *   dict         true when a non-multilingual `_dict` is met
 */
function resolve(data, dbAccess, hops) {
	const out = { shape: null, leaf: null, body: null, multilingual: false, dict: false, terminal: null };
	let cur = data, first = true;
	for (let guard = 0; guard < 8 && isObj(cur); guard++) {
		if (typeof cur._typedef === 'string') {
			if (hops > 1) break;
			const t = dbAccess.getTerm(cur._typedef);
			if (roles(t).includes(MULTILINGUAL_ROLE)) out.multilingual = true;
			if (!t || !isObj(t._data)) break;
			cur = t._data; hops++;
			continue;
		}
		const shape = Object.keys(cur).find(k => k.startsWith('_') && !CONTAINER_COMPANIONS.has(k)) || null;
		if (first) { out.shape = shape; first = false; }
		out.terminal = shape;
		if (shape === '_scalar') {
			const type = Object.keys(cur._scalar || {})[0] || null;
			out.leaf = type; out.body = type ? cur._scalar[type] : null;
			return out;
		}
		if (shape === '_set' || shape === '_nested') {
			const type = elementKey(cur[shape]);
			out.leaf = type; out.body = type ? cur[shape][type] : null;
			return out;
		}
		if (shape === '_array') {
			const key = elementKey(cur._array);
			if (!key) return out;
			cur = { [key]: cur._array[key] };
			continue;
		}
		if (shape === '_dict') {
			const keyBody = cur._dict && cur._dict._dict_key;
			const keyEnums = keyBody && keyBody._enum && Array.isArray(keyBody._enum._enums) ? keyBody._enum._enums : [];
			if (keyEnums.includes(LANGUAGE_ENUM)) out.multilingual = true;
			else if (!out.multilingual) out.dict = true;
			cur = cur._dict ? cur._dict._dict_value : null;
			continue;
		}
		return out;                                       // _object, _objects, _tuple, _keyed, GeoJSON, or {}
	}
	return out;
}

/**
 * @param {string} rootGid  - The schema term of the collection's objects (`_term`, `std_dataset`, ...).
 * @param {Object} dbAccess - Needs getTerm(gid).
 * @param {Object} [opts]   - { languages: ['ISO_639_3_eng'] }
 */
function indexPlan(rootGid, dbAccess, opts) {
	const languages = (opts && Array.isArray(opts.languages) && opts.languages.length) ? opts.languages.slice() : DEFAULT_LANGUAGES.slice();
	const plan = { root: rootGid, languages, containers: [], fields: [], problems: [] };
	const problem = (path, code, message) => plan.problems.push({ path, code, message });

	function walk(gid, prefix, depth) {
		const term = dbAccess.getTerm(gid);
		if (!term) { problem(prefix.join('.'), 'UNKNOWN_TERM', '"' + gid + '" is not a term'); return; }
		const body = bodyOf(term, dbAccess);
		if (!body) return;
		if (depth > MAX_DEPTH) { problem(prefix.join('.'), 'TOO_DEEP', 'containers nested beyond ' + MAX_DEPTH + ' levels under "' + rootGid + '"'); return; }

		if (typeof body._index === 'string') {
			if (INTENTS.includes(body._index)) plan.containers.push({ path: prefix.join('.'), gid, intent: body._index });
			else problem(prefix.join('.'), 'UNKNOWN_INTENT', '"' + gid + '" declares _index ' + JSON.stringify(body._index) + ' on its body');
		}

		for (const entry of (Array.isArray(body._fields) ? body._fields : [])) {
			if (!isObj(entry) || typeof entry._field !== 'string') continue;
			const field = entry._field;
			const path  = prefix.concat(field);
			const at    = path.join('.');
			const pterm = dbAccess.getTerm(field);
			if (!pterm) { problem(at, 'UNKNOWN_TERM', '"' + field + '" is not a term'); continue; }

			const sub = bodyOf(pterm, dbAccess);
			if (sub) {
				if (entry._index) problem(at, 'HINT_ON_CONTAINER', '"' + field + '" is an object schema; put _index on its body or on its own _fields entries');
				walk(field, path, depth + 1);
				continue;
			}
			const intent = entry._index;
			if (intent === undefined) continue;
			if (!INTENTS.includes(intent)) { problem(at, 'UNKNOWN_INTENT', '"' + field + '" is hinted ' + JSON.stringify(intent)); continue; }

			const r = resolve(pterm._data || {}, dbAccess, 0);
			if (roles(pterm).includes(MULTILINGUAL_ROLE)) r.multilingual = true;
			if (UNINDEXABLE.has(r.terminal)) { problem(at, 'UNINDEXABLE_SHAPE', '"' + field + '" is a ' + r.terminal + ' and cannot be indexed as one field'); continue; }

			const f = { path: at, gid: field, intent, leaf: r.leaf, shape: r.shape };
			if (r.multilingual) { f.multilingual = true; f.languages = languages.slice(); }
			else if (r.dict) f.dict = true;
			if (r.leaf === '_enum') {
				f.enums  = r.body && Array.isArray(r.body._enums) ? r.body._enums.slice() : [];
				f.single = r.shape === '_scalar';
			}
			if (intent === '_index_segment' && r.leaf && !STRING_LEAVES.has(r.leaf)) problem(at, 'SEGMENT_ON_NON_STRING', '"' + field + '" is a ' + r.leaf + '; _index_segment applies to string identifiers');
			if (intent === '_index_text' && r.leaf && TOKEN_LEAVES.has(r.leaf)) problem(at, 'TEXT_ON_TOKEN', '"' + field + '" is a ' + r.leaf + '; analysed text would lower-case and stem it');
			if (intent === '_index_identity' && r.leaf && TEXT_LEAVES.has(r.leaf)) problem(at, 'IDENTITY_ON_TEXT', '"' + field + '" is a ' + r.leaf + '; an exact match on a text matches nothing');
			plan.fields.push(f);
		}
	}

	walk(rootGid, [], 0);
	return plan;
}

module.exports = { indexPlan, bodyOf, INTENTS, DEFAULT_LANGUAGES, MAX_DEPTH };
