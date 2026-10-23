'use strict';

/**
 * index-plan.test.js — indexPlan over the hand-built mini dictionary (no database).
 *
 *   node test/index-plan.test.js
 *
 * The mini dictionary is extended here with `_fields` hints, a multilingual
 * typedef, a nested `_references` container and a body-level `_index` on
 * `_domn`, so the walk, the expansion and every problem code are exercised.
 */

const assert = require('node:assert/strict');
const v = require('..');
const { DICT, EDGES, FACTS, term, all } = require('./fixtures/mini-dict');
const { indexPlan } = v;
const { CORE_DECLARATIONS } = v.computeRegistry;

let passed = 0;
const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (err) { failures.push({ name, err }); } }

const fields = (...entries) => entries;
const F = (gid, index, group) => Object.assign({ _field: gid }, index ? { _index: index } : {}, group ? { _group: group } : {});

const multilingualString = { _dict: { _dict_key: { _enum: { _enums: ['ISO_639_3'] } }, _dict_value: { _scalar: { _text: {} } } } };

const BASE = Object.assign({}, DICT, {
	_term: term('_term', { _object: { _closed: {
		_required: all(['_key', '_code']), _recommended: ['_info', '_data', '_domn'],
		_computed: CORE_DECLARATIONS._term, _immutable: ['_key'], _locked: ['_id', '_rev'],
		_fields: fields(F('_code'), F('_info'), F('_domn'), F('_key')) } } }),
	_code: term('_code', { _object: { _closed: {
		_required: all(['_lid', '_gid', '_aid']), _recommended: ['_nid', '_emoji'],
		_computed: CORE_DECLARATIONS._code, _immutable: ['_nid', '_lid', '_gid'],
		_fields: fields(F('_nid', '_index_identity'), F('_lid', '_index_identity'), F('_gid', '_index_segment'),
			F('_aid', '_index_identity'), F('_emoji', null, '_group_more')) } } }),
	_info: term('_info', { _object: { _closed: {
		_required: all(['_title']), _recommended: ['_notes', '_references', '_examples'],
		_fields: fields(F('_title', '_index_text'), F('_references'), F('_notes'), F('_examples', '_index_text')) } } }),
	_references: term('_references', { _object: { _closed: {
		_recommended: ['_citation'], _fields: fields(F('_citation', '_index_text')) } } }),
	_citation: term('_citation', { _array: { _scalar: { _text_Markdown: {} } } }),
	_info_string: term('_info_string', multilingualString, ['_term_role_descriptor', '_term_role_multilingual', '_term_role_typedef']),
	_title:    term('_title',    { _typedef: '_info_string' }),
	_notes:    term('_notes',    { _typedef: '_info_string' }),
	_examples: term('_examples', { _array: { _typedef: '_info_string' } }),
	_domn: term('_domn', { _object: { _open: {
		_index: '_index_identity',
		_recommended: ['_term_role', '_class'], _computed: CORE_DECLARATIONS._domn,
		_fields: fields(F('_term_role', '_index_identity'), F('_class', '_index_identity')) } } }),
	_class: term('_class', { _scalar: { _enum: { _enums: ['_class'] } } }),
	_term_role: term('_term_role', { _set: { _enum: { _enums: ['_term_role'] } } }),
});

function access(dict) {
	return v.makeSnapshotDbAccess(Object.assign({ version: 1, termsCol: 'terms', terms: dict, enumEdges: EDGES }, FACTS), { onMiss: 'null' });
}

test('the plan walks the root through its containers in _fields order', () => {
	const p = indexPlan('_term', access(BASE));
	assert.equal(p.root, '_term');
	assert.deepEqual(p.languages, ['ISO_639_3_eng']);
	assert.deepEqual(p.fields.map(f => f.path), [
		'_code._nid', '_code._lid', '_code._gid', '_code._aid',
		'_info._title', '_info._references._citation', '_info._examples',
		'_domn._term_role', '_domn._class',
	]);
	assert.deepEqual(p.problems, []);
});

test('intents, leaf types and shapes are reported per field', () => {
	const p = indexPlan('_term', access(BASE));
	const by = Object.fromEntries(p.fields.map(f => [f.path, f]));
	assert.deepEqual(by['_code._gid'], { path: '_code._gid', gid: '_gid', intent: '_index_segment', leaf: '_string', shape: '_scalar' });
	assert.deepEqual(by['_code._aid'], { path: '_code._aid', gid: '_aid', intent: '_index_identity', leaf: '_string', shape: '_set' });
	assert.deepEqual(by['_info._references._citation'], { path: '_info._references._citation', gid: '_citation', intent: '_index_text', leaf: '_text_Markdown', shape: '_array' });
});

test('a multilingual value is marked and carries the configured languages; a typedef inside an array counts', () => {
	const p = indexPlan('_term', access(BASE), { languages: ['ISO_639_3_eng', 'ISO_639_3_ita'] });
	const by = Object.fromEntries(p.fields.map(f => [f.path, f]));
	assert.deepEqual(by['_info._title'], { path: '_info._title', gid: '_title', intent: '_index_text', leaf: '_text', shape: '_dict', multilingual: true, languages: ['ISO_639_3_eng', 'ISO_639_3_ita'] });
	assert.equal(by['_info._examples'].multilingual, true);
	assert.equal(by['_info._examples'].shape, '_array');
	assert.equal(by['_info._references._citation'].multilingual, undefined);       // a plain array of Markdown strings
});

test('an _enum leaf records its roots and whether it is single-valued (scalar) or multi-valued (set)', () => {
	const by = Object.fromEntries(indexPlan('_term', access(BASE)).fields.map(f => [f.path, f]));
	assert.deepEqual(by['_domn._class'], { path: '_domn._class', gid: '_class', intent: '_index_identity', leaf: '_enum', shape: '_scalar', enums: ['_class'], single: true });
	assert.deepEqual(by['_domn._term_role'], { path: '_domn._term_role', gid: '_term_role', intent: '_index_identity', leaf: '_enum', shape: '_set', enums: ['_term_role'], single: false });
});

test('a body-level _index becomes a container entry; entries without a hint stay out of fields', () => {
	const p = indexPlan('_term', access(BASE));
	assert.deepEqual(p.containers, [{ path: '_domn', gid: '_domn', intent: '_index_identity' }]);
	assert.ok(!p.fields.some(f => f.path === '_info._notes'));
	assert.ok(!p.fields.some(f => f.path === '_code._emoji'));
	assert.ok(!p.fields.some(f => f.path === '_key'));                        // a leaf entry with no hint on the root
});

test('a non-multilingual _dict is marked dict, so the service indexes everything under its path', () => {
	const dict = Object.assign({}, BASE, {
		_code: term('_code', { _object: { _closed: { _required: all(['_lid']), _recommended: ['_extra'], _fields: fields(F('_extra', '_index_identity')) } } }),
		_extra: term('_extra', { _dict: { _dict_key: { _string: {} }, _dict_value: { _scalar: { _string: {} } } } }),
	});
	const p = indexPlan('_term', access(dict));
	const f = p.fields.find(x => x.path === '_code._extra');
	assert.equal(f.dict, true);
	assert.equal(f.multilingual, undefined);
	assert.equal(f.leaf, '_string');
});

test('problems: unknown term, hint on a container, unindexable shape, wrong intent for the leaf, unknown intent', () => {
	const dict = Object.assign({}, BASE, {
		_code: term('_code', { _object: { _closed: { _required: all(['_lid']),
			_recommended: ['_nope', '_bucket', '_count', '_class', '_notes'],
			_fields: fields(F('_nope', '_index_identity'), F('_bucket', '_index_text'), F('_count', '_index_segment'),
				F('_class', '_index_text'), F('_notes', '_index_identity'), F('_lid', '_index_sideways')) } } }),
		_term: term('_term', { _object: { _closed: { _required: all(['_code']), _recommended: ['_info'],
			_fields: fields(F('_code'), F('_info', '_index_text')) } } }),
		_bucket: term('_bucket', { _objects: { _objects_list: { _closed: {} } } }),
		_count:  term('_count',  { _scalar: { _number_integer: {} } }),
	});
	const p = indexPlan('_term', access(dict));
	const codes = Object.fromEntries(p.problems.map(x => [x.path, x.code]));
	assert.equal(codes['_code._nope'],   'UNKNOWN_TERM');
	assert.equal(codes['_info'],         'HINT_ON_CONTAINER');
	assert.equal(codes['_code._bucket'], 'UNINDEXABLE_SHAPE');
	assert.equal(codes['_code._count'],  'SEGMENT_ON_NON_STRING');
	assert.equal(codes['_code._class'],  'TEXT_ON_TOKEN');
	assert.equal(codes['_code._notes'],  'IDENTITY_ON_TEXT');
	assert.equal(codes['_code._lid'],    'UNKNOWN_INTENT');
	// the container with the misplaced hint is still walked, and the flagged leaves still planned (the problem is advice)
	assert.ok(p.fields.some(f => f.path === '_info._title'));
	assert.ok(p.fields.some(f => f.path === '_code._count'));
	assert.ok(!p.fields.some(f => f.path === '_code._bucket'));
	assert.ok(!p.fields.some(f => f.path === '_code._lid'));
});

test('a root that is not an object schema plans nothing; an unknown root is one problem', () => {
	assert.deepEqual(indexPlan('_lid', access(BASE)).fields, []);
	const p = indexPlan('_nothing', access(BASE));
	assert.deepEqual(p.fields, []);
	assert.deepEqual(p.problems.map(x => x.code), ['UNKNOWN_TERM']);
});

test('formFields reports the body-level _index on entries that carry none of their own', () => {
	const { fields: ff } = v.formFields(BASE._domn._data._object._open);
	assert.equal(ff.find(f => f.gid === '_term_role').index, '_index_identity');
	const open = v.formFields({ _index: '_index_text', _recommended: ['_a', '_b'], _fields: [{ _field: '_a', _index: '_index_identity' }] });
	assert.equal(open.fields.find(f => f.gid === '_a').index, '_index_identity');   // the entry wins
	assert.equal(open.fields.find(f => f.gid === '_b').index, '_index_text');       // the body's intent
	assert.equal(v.formFields({ _recommended: ['_c'] }).fields[0].index, null);
});

for (const f of failures) {
	console.error('  ✗ ' + f.name);
	console.error('    ' + String(f.err.message).split('\n').join('\n    '));
}
console.log('index-plan.test.js: ' + passed + ' passed' + (failures.length ? ', ' + failures.length + ' failed' : ''));
if (failures.length) process.exit(1);
