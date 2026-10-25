'use strict';

/**
 * subset.test.js — the `_subset-of` companion of _set and _array (no database).
 *
 *   node test/subset.test.js
 */

const assert = require('node:assert/strict');
const v = require('..');
const { DICT, term, all, access } = require('./fixtures/mini-dict');

let passed = 0;
const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (err) { failures.push({ name, err }); } }

const T = Object.assign({}, DICT, {
	rec:       term('rec', { _object: { _closed: { _required: all(['rec_terms']), _recommended: ['rec_summary', 'rec_order', 'rec_pick', 'rec_absent'] } } }),
	rec_terms:   term('rec_terms',   { _set:   { _string: {} } }),
	rec_summary: term('rec_summary', { _set:   { _string: {}, '_subset-of': 'rec_terms' } }),
	rec_order:   term('rec_order',   { _array: { _scalar: { _string: {} }, '_subset-of': 'rec_terms' } }),
	rec_pick:    term('rec_pick',    { _set:   { _string: {}, '_subset-of': 'rec_absent' } }),
	rec_absent:  term('rec_absent',  { _scalar: { _string: {} } }),
});
const db = () => access({ terms: T });
const codes = r => r.errors.map(e => e.code + ':' + e.path).sort();

test('a set drawn from a sibling set: members pass, a stranger fails at its index', () => {
	const ok  = v.validateByDictionary({ rec_terms: ['a', 'b', 'c'], rec_summary: ['a', 'c'] }, 'rec', db(), {});
	assert.deepEqual(ok.errors, []);
	const bad = v.validateByDictionary({ rec_terms: ['a', 'b', 'c'], rec_summary: ['a', 'z'] }, 'rec', db(), {});
	assert.deepEqual(codes(bad), ['NOT_IN_SIBLING:rec_summary.[1]']);
});

test('an array drawn from a sibling: order and repetition are the array\'s business, membership is the sibling\'s', () => {
	const ok  = v.validateByDictionary({ rec_terms: ['a', 'b'], rec_order: ['b', 'a', 'b'] }, 'rec', db(), {});
	assert.deepEqual(ok.errors, []);
	const bad = v.validateByDictionary({ rec_terms: ['a', 'b'], rec_order: ['b', 'q'] }, 'rec', db(), {});
	assert.deepEqual(codes(bad), ['NOT_IN_SIBLING:rec_order.[1]']);
});

test('an absent sibling imposes nothing; a scalar sibling is a one-element set', () => {
	const ok = v.validateByDictionary({ rec_terms: ['a'], rec_pick: ['anything'] }, 'rec', db(), {});
	assert.deepEqual(ok.errors, []);
	const one = v.validateByDictionary({ rec_terms: ['a'], rec_pick: ['x'], rec_absent: 'x' }, 'rec', db(), {});
	assert.deepEqual(one.errors, []);
	const no  = v.validateByDictionary({ rec_terms: ['a'], rec_pick: ['y'], rec_absent: 'x' }, 'rec', db(), {});
	assert.deepEqual(codes(no), ['NOT_IN_SIBLING:rec_pick.[0]']);
});

test('the element type still applies, and the companion never leaks into the type schema', () => {
	const bad = v.validateByDictionary({ rec_terms: ['a'], rec_summary: [42] }, 'rec', db(), {});
	assert.ok(bad.errors.some(e => e.code === 'WRONG_TYPE'));
	assert.ok(!bad.errors.some(e => e.code === 'UNKNOWN_PROPERTY'));
	// A bare container validated alone has no containing object: nothing to check.
	const alone = v.validateValue(['zzz'], T.rec_summary._data, db(), {});
	assert.deepEqual(alone.errors, []);
});

console.log(`subset.test.js: ${passed} passed, ${failures.length} failed`);
for (const f of failures) { console.log('  ✗ ' + f.name); console.log('    ' + (f.err.message || f.err)); }
if (failures.length) process.exit(1);
