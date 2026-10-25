'use strict';

/**
 * fields.test.js — formFields / checkFields unit tests (no database).
 *
 *   node test/fields.test.js
 */

const assert = require('node:assert/strict');
const { formFields, checkFields, allowedProperties, computedFields, computedEntry } = require('..');

let passed = 0;
const failures = [];
function test(name, fn) {
	try { fn(); passed++; }
	catch (err) { failures.push({ name, err }); }
}

const all = function(selection) { return { _selectors: [{ _all: {} }], _selection: selection }; };

// A body shaped like _code's
const CODE = {
	_required:    [all(['_lid', '_gid', '_aid'])],
	_recommended: ['_nid', '_uri', '_pid', '_name', '_symbol', '_symbol_print', '_regexp', '_emoji'],
	_computed:    [{ _field: '_gid', _compute_kind: '_compute_kind_concat', _compute_from: ['_nid', '_lid'], _compute_separator: '_' },
	               { _field: '_aid', _compute_kind: '_compute_kind_union',  _compute_from: ['_lid'] }],
	_immutable:   ['_nid', '_lid', '_gid'],
	_fields: [
		{ _field: '_nid', _index: '_index_identity' },
		{ _field: '_lid', _index: '_index_identity' },
		{ _field: '_gid', _index: '_index_identity' },
		{ _field: '_aid', _index: '_index_identity' },
		{ _field: '_name', _index: '_index_text' },
		{ _field: '_symbol', _group: '_group_more' },
		{ _field: '_symbol_print', _group: '_group_more' },
		{ _field: '_uri', _group: '_group_more' },
		{ _field: '_pid', _group: '_group_more', _index: '_index_identity' },
		{ _field: '_regexp', _group: '_group_more' },
		{ _field: '_emoji', _group: '_group_more' },
	],
};

// A body shaped like _range's (layered selection, one choice per group)
const RANGE = {
	_required: [{
		_selectors: [{ _all: { '_min-items': 1, '_max-items': 1 } }, { _any: { '_min-items': 1 } }],
		_selection: [['_min-exclusive', '_min-inclusive'], ['_max-exclusive', '_max-inclusive']],
	}],
};

test('formFields follows _fields order and carries the hints', () => {
	const { fallback, fields } = formFields(CODE);
	assert.equal(fallback, false);
	assert.deepEqual(fields.map(f => f.gid), CODE._fields.map(e => e._field));
	assert.equal(fields[0].gid, '_nid');
	assert.equal(fields[0].index, '_index_identity');
	assert.equal(fields[0].group, '_group_main');
	assert.equal(fields[0].immutable, true);
	assert.equal(fields[0].required, false);          // recommended, placed first
	assert.equal(fields[4].index, '_index_text');
	assert.equal(fields[5].group, '_group_more');
});

test('formFields marks unconditional members required and computed ones computed', () => {
	const { fields } = formFields(CODE);
	const lid = fields.find(f => f.gid === '_lid');
	const gid = fields.find(f => f.gid === '_gid');
	assert.equal(lid.required, true);
	assert.equal(lid.selector, null);
	assert.equal(gid.required, true);
	assert.equal(gid.computed, true);
	assert.equal(gid.immutable, true);
});

test('formFields reports a layered choice as a selector, not as required', () => {
	const { fallback, fields } = formFields(RANGE);
	assert.equal(fallback, true);
	assert.deepEqual(fields.map(f => f.gid), ['_min-exclusive', '_min-inclusive', '_max-exclusive', '_max-inclusive']);
	for (const f of fields) {
		assert.equal(f.required, false);
		assert.equal(f.selector.id, 0);
		assert.equal(f.selector.kind, 'all');
		assert.equal(f.selector.min, 1);
		assert.equal(f.selector.max, 1);
	}
	assert.equal(fields[0].selector.group, 0);
	assert.equal(fields[2].selector.group, 1);
});

test('formFields falls back to required-then-recommended without _fields', () => {
	const body = { _required: [all(['b', 'a'])], _recommended: ['d', 'c'] };
	const { fallback, fields } = formFields(body);
	assert.equal(fallback, true);
	assert.deepEqual(fields.map(f => f.gid), ['b', 'a', 'd', 'c']);
});

test('formFields appends members _fields left out; a retired _default-value map is ignored', () => {
	const body = { _required: [all(['a'])], _recommended: ['b', 'c'], '_default-value': { c: 7 },
	               _fields: [{ _field: 'c' }] };
	const { fallback, fields } = formFields(body);
	assert.equal(fallback, false);
	assert.deepEqual(fields.map(f => f.gid), ['c', 'a', 'b']);
	assert.equal(fields[0].default, undefined);
	assert.equal(fields[1].default, undefined);
});

test('formFields reports the compute kind and what runs it; _group_hidden passes through', () => {
	const body = {
		_required: [all(['_key', 'code', 'count', 'cols'])], _recommended: ['terms'],
		_computed: [
			{ _field: '_key',  _compute_kind: '_compute_kind_generate', _compute_generator: '_compute_generator_key' },
			{ _field: 'count', _compute_kind: '_compute_kind_service',  _compute_service: '_compute_service_stats' },
			{ _field: 'terms', _compute_kind: '_compute_kind_service',  _compute_service: '_compute_service_stats' },
			{ _field: 'cols',  _compute_kind: '_compute_kind_service',  _compute_service: '_compute_service_insert' },
		],
		_locked: ['_key', 'count', 'cols'], _immutable: ['_key', 'code'],
		_fields: [{ _field: '_key' }, { _field: 'code' }, { _field: 'terms' }, { _field: 'count', _group: '_group_more' }, { _field: 'cols', _group: '_group_hidden' }],
	};
	const { fields } = formFields(body);
	const f = gid => fields.find(x => x.gid === gid);
	assert.deepEqual([f('_key').compute, f('_key').computedBy, f('_key').computed, f('_key').locked], ['_compute_kind_generate', '_compute_generator_key', true, true]);
	assert.deepEqual([f('count').compute, f('count').computedBy, f('count').locked], ['_compute_kind_service', '_compute_service_stats', true]);
	assert.deepEqual([f('terms').compute, f('terms').locked, f('terms').required], ['_compute_kind_service', false, false]);
	assert.deepEqual([f('code').compute, f('code').computedBy, f('code').immutable], [null, null, true]);
	assert.equal(f('cols').group, '_group_hidden');
	const c = formFields(CODE).fields.find(x => x.gid === '_gid');
	assert.deepEqual([c.compute, c.computedBy], ['_compute_kind_concat', null]);
});

test('checkFields passes a complete, admitted list', () => {
	const r = checkFields(CODE, []);
	assert.deepEqual(r.errors, []);
	assert.deepEqual(r.warnings, []);
});

test('checkFields: a property outside the schema is FIELD_NOT_IN_SCHEMA', () => {
	const body = Object.assign({}, CODE, { _fields: CODE._fields.concat([{ _field: '_title' }]) });
	const r = checkFields(body, ['_data', '_object', '_closed']);
	assert.equal(r.errors.length, 1);
	assert.equal(r.errors[0].code, 'FIELD_NOT_IN_SCHEMA');
	assert.equal(r.errors[0].path, '_data._object._closed._fields.[11]._field');
});

test('checkFields: a banned property is FIELD_BANNED', () => {
	const body = Object.assign({}, CODE, { _banned: ['_emoji'] });
	const r = checkFields(body, []);
	assert.equal(r.errors.length, 1);
	assert.equal(r.errors[0].code, 'FIELD_BANNED');
	assert.equal(r.errors[0].value, '_emoji');
});

test('checkFields: a missing recommended property is only FIELDS_INCOMPLETE', () => {
	const body = Object.assign({}, CODE, { _fields: CODE._fields.slice(0, -1) });
	const r = checkFields(body, []);
	assert.deepEqual(r.errors, []);
	assert.equal(r.warnings.length, 1);
	assert.equal(r.warnings[0].code, 'FIELDS_INCOMPLETE');
	assert.deepEqual(r.warnings[0].value, ['_emoji']);
});

test('checkFields: a body without _fields reports nothing', () => {
	const r = checkFields(RANGE, []);
	assert.deepEqual(r, { errors: [], warnings: [] });
});

// ── _computed in the new shape (entry objects) ────────────────────────────────

const CONCAT = { _field: '_gid', _compute_kind: '_compute_kind_concat', _compute_from: ['_nid', '_lid'], _compute_separator: '_' };
const UNION  = { _field: '_aid', _compute_kind: '_compute_kind_union',  _compute_from: ['_lid'] };
const CONST  = { _field: '_emoji', _compute_kind: '_compute_kind_constant', _compute_value: '🏷' };
const CODE2  = Object.assign({}, CODE, { _computed: [CONCAT, UNION, CONST] });

test('computedFields and computedEntry read entry objects and skip everything else', () => {
	assert.deepEqual(computedFields(CODE), ['_gid', '_aid']);
	assert.deepEqual(computedFields(CODE2), ['_gid', '_aid', '_emoji']);
	assert.deepEqual(computedFields({ _computed: ['_a', { _field: '_b' }, 7, {}, null] }), ['_b']);   // '_a' is the retired bare-gid shape
	assert.deepEqual(computedFields({}), []);
	assert.equal(computedEntry(CODE, '_gid'), CODE._computed[0]);
	assert.equal(computedEntry(CODE, '_a'), null);
	assert.equal(computedEntry(CODE2, '_aid'), UNION);
	assert.equal(computedEntry(CODE2, '_nid'), null);
});

test('allowedProperties and checkFields see the _field of an entry object', () => {
	assert.deepEqual([...allowedProperties(CODE2)].sort(), [...allowedProperties(CODE)].sort());
	const r = checkFields(CODE2, []);
	assert.deepEqual(r.errors, []);
	assert.deepEqual(r.warnings, []);
});

test('formFields: a constant entry is a pre-fill the user may change, not a computed field', () => {
	const { fields } = formFields(CODE2);
	const gid = fields.find(f => f.gid === '_gid');
	const emoji = fields.find(f => f.gid === '_emoji');
	assert.equal(gid.computed, true);
	assert.equal(gid.default, undefined);
	assert.equal(emoji.computed, false);
	assert.equal(emoji.default, '🏷');
	// the retired _default-value map is not read any more
	const stale = formFields(Object.assign({}, CODE, { '_default-value': { _emoji: '✨' } }));
	assert.equal(stale.fields.find(f => f.gid === '_emoji').default, undefined);
});

test('allowedProperties is the closed-schema whitelist', () => {
	assert.deepEqual([...allowedProperties(CODE)].sort(),
		['_aid', '_emoji', '_gid', '_lid', '_name', '_nid', '_pid', '_regexp', '_symbol', '_symbol_print', '_uri'].sort());
});

console.log(`fields.test.js: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error('  ✗ ' + f.name + '\n    ' + (f.err && f.err.message));
process.exit(failures.length ? 1 : 0);
