'use strict';

/**
 * fields.test.js — formFields / checkFields unit tests (no database).
 *
 *   node test/fields.test.js
 */

const assert = require('node:assert/strict');
const { formFields, checkFields, allowedProperties } = require('..');

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
	_computed:    ['_gid', '_aid'],
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

test('formFields appends members _fields left out, and applies _default-value', () => {
	const body = { _required: [all(['a'])], _recommended: ['b', 'c'], '_default-value': { c: 7 },
	               _fields: [{ _field: 'c' }] };
	const { fallback, fields } = formFields(body);
	assert.equal(fallback, false);
	assert.deepEqual(fields.map(f => f.gid), ['c', 'a', 'b']);
	assert.equal(fields[0].default, 7);
	assert.equal(fields[1].default, undefined);
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

test('allowedProperties is the closed-schema whitelist', () => {
	assert.deepEqual([...allowedProperties(CODE)].sort(),
		['_aid', '_emoji', '_gid', '_lid', '_name', '_nid', '_pid', '_regexp', '_symbol', '_symbol_print', '_uri'].sort());
});

console.log(`fields.test.js: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error('  ✗ ' + f.name + '\n    ' + (f.err && f.err.message));
process.exit(failures.length ? 1 : 0);
