'use strict';

/**
 * compute.test.js — The compute registry and its driver (no database).
 *
 *   node test/compute.test.js
 *
 * Builds a small dictionary snapshot by hand — the three type anchors from the
 * fixture plus _term / _code / _domn / _info bodies, one namespace and one
 * enumeration — so the schema-driven walk can be exercised end to end.
 */

const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const v = require('..');
const { applyComputed, checkComputeRegistry } = v;
const { computeTermCode, computeEdgeKey, computeBlobKey } = v.compute;
const { lookup, computeGid } = v.computeRegistry;
const { collectEnumSources } = require('../lib/edge-index');

let passed = 0;
const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (err) { failures.push({ name, err }); } }

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'snapshot.test.json'), 'utf8'));
const anchors = {};
for (const g of Object.values(v.ANCHOR)) anchors[g] = fixture.terms[g];

const all = sel => [{ _selectors: [{ _all: {} }], _selection: sel }];
function term(gid, data, roles) {
	const nidLid = gid.startsWith('_') ? ['', gid.slice(1)] : [undefined, gid];
	const t = { _key: gid, _code: { _lid: nidLid[1], _gid: gid, _aid: [nidLid[1]] }, _info: { _title: { ISO_639_3_eng: gid } } };
	if (nidLid[0] !== undefined) t._code._nid = nidLid[0];
	if (data) t._data = data;
	if (roles) t._domn = { _term_role: roles };
	return t;
}
const DICT = Object.assign({}, anchors, {
	_term: term('_term', { _object: { _closed: {
		_required: all(['_key', '_code']), _recommended: ['_info', '_data', '_domn'],
		_computed: ['_key'], _immutable: ['_key'], _locked: ['_id', '_rev'] } } }),
	_code: term('_code', { _object: { _closed: {
		_required: all(['_lid', '_gid', '_aid']), _recommended: ['_nid', '_emoji'],
		_computed: ['_gid', '_aid'], _immutable: ['_nid', '_lid', '_gid'] } } }),
	_domn: term('_domn', { _object: { _open: { _recommended: ['_term_role'], _computed: ['_term_role'] } } }),
	_info: term('_info', { _object: { _closed: { _required: all(['_title']) } } }),
	_key: term('_key', { _scalar: { _string: {} } }), _lid: term('_lid', { _scalar: { _string: {} } }),
	_gid: term('_gid', { _scalar: { _string: {} } }), _aid: term('_aid', { _set: { _string: {} } }),
	_nid: term('_nid', { _scalar: { _term_key: {} } }), _emoji: term('_emoji', { _scalar: { _string: {} } }),
	_title: term('_title', { _scalar: { _string: {} } }), _term_role: term('_term_role', { _set: { _enum: {} } }),
	ns:       term('ns', null, ['_term_role_namespace']),
	ns_root:  term('ns_root', { _scalar: { _enum: { _enums: ['ns_root'] } } }, ['_term_role_descriptor', '_term_role_enum-root', '_term_role_enum-source']),
	ns_item:  term('ns_item', null, ['_term_role_enum-item']),
});
const EDGES = [{ f: 'terms/ns_item', t: 'terms/ns_root', p: ['terms/ns_root'], pred: '_predicate_enum-of' }];
const FACTS = { namespaces: ['ns'], predicates: ['_predicate_enum-of'], enumSources: collectEnumSources([DICT.ns_root._data]) };

function access(extra) {
	return v.makeSnapshotDbAccess(Object.assign({ version: 1, termsCol: 'terms', terms: DICT, enumEdges: EDGES }, FACTS, extra || {}), { onMiss: 'null' });
}

// ── registry rules ────────────────────────────────────────────────────────────

test('computeGid: absent nid, empty nid, namespaced', () => {
	assert.equal(computeGid(undefined, 'ISO'), 'ISO');
	assert.equal(computeGid('', 'code'), '_code');
	assert.equal(computeGid('ISO_3166', 'ITA'), 'ISO_3166_ITA');
});

test('_code._aid merges the local identifier into an existing list', () => {
	assert.deepEqual(lookup('_code', '_aid').compute({ _lid: 'it', _aid: ['IT', '380'] }), ['IT', '380', 'it']);
	assert.deepEqual(lookup('_code', '_aid').compute({ _lid: 'it', _aid: ['it'] }), ['it']);
	assert.equal(lookup('_code', '_aid').compute({}), undefined);
});

test('edge, link and blob keys are the loader\'s hashes', () => {
	const e = { _from: 'terms/_scale_year', _predicate: '_predicate_enum-of', _to: 'terms/_scale' };
	assert.equal(lookup('_edge', '_key').compute(e), lookup('_link', '_key').compute(e));
	assert.match(lookup('_edge', '_key').compute(e), /^[0-9a-f]{32}$/);
	assert.equal(lookup('_blob', '_key').compute({ _blob_item: 'flag', _blob_type: '_text_SVG', _blob_kind: '_media_landscape', _blob_identifier: 'ad' }),
		'339d23fc1dbffe043bc69d6db95b5912');   // the Andorra landscape flag, as documented
});

// ── fallback path (no database) — the historical wrappers ────────────────────

test('computeTermCode fills _gid, _aid and _key with warnings', () => {
	const doc = { _code: { _nid: '', _lid: 'code' } };
	const r = computeTermCode(doc);
	assert.deepEqual(r.errors, []);
	assert.deepEqual(r.warnings.map(w => w.path), ['_code._gid', '_code._aid', '_key']);
	assert.deepEqual(doc, { _code: { _nid: '', _lid: 'code', _gid: '_code', _aid: ['code'] }, _key: '_code' });
});

test('computeTermCode: missing _code / _lid is MISSING_FIELD', () => {
	assert.equal(computeTermCode({}).errors[0].code, 'MISSING_FIELD');
	assert.equal(computeTermCode({ _code: {} }).errors[0].code, 'MISSING_FIELD');
});

test('a wrong _key is COMPUTE_MISMATCH and is not repaired', () => {
	const doc = { _code: { _nid: '', _lid: 'code', _gid: '_code', _aid: ['code'] }, _key: 'wrong' };
	const r = computeTermCode(doc);
	assert.equal(r.errors.length, 1);
	assert.equal(r.errors[0].code, 'COMPUTE_MISMATCH');
	assert.equal(doc._key, 'wrong');
	const e = { _from: 'terms/a', _predicate: 'p', _to: 'terms/b', _key: 'bad' };
	assert.equal(computeEdgeKey(e).errors[0].code, 'COMPUTE_MISMATCH');
});

test('opts: strictCompute → errors; quietCompute → silent; noFill → no mutation', () => {
	assert.equal(computeTermCode({ _code: { _lid: 'x' } }, { strictCompute: true }).errors.length, 3);
	const q = computeTermCode({ _code: { _lid: 'x' } }, { quietCompute: true });
	assert.deepEqual([q.errors, q.warnings], [[], []]);
	assert.equal(q.computed.length, 3);
	const doc = { _blob_item: 'flag', _blob_type: '_text_SVG', _blob_kind: '_media_square', _blob_identifier: 'it' };
	const n = computeBlobKey(doc, { noFill: true });
	assert.equal(doc._key, undefined);
	assert.equal(n.warnings[0].code, 'COMPUTE_ADDED');
});

test('fallback detects the layout by shape when no descriptor is given', () => {
	const e = { _from: 'terms/a', _predicate: 'p', _to: 'terms/b' };
	applyComputed(e, null, null, { quietCompute: true });
	assert.match(e._key, /^[0-9a-f]{32}$/);
});

// ── schema-driven path ────────────────────────────────────────────────────────

test('schema-driven: a new term gets _gid, _aid, _key and a _domn with its roles', () => {
	const doc = { _code: { _nid: 'ns', _lid: 'item' }, _info: { _title: { ISO_639_3_eng: 'Item' } }, _data: {} };
	const r = applyComputed(doc, '_term', access(), { quietCompute: true });
	assert.deepEqual(r.errors, []);
	assert.equal(doc._code._gid, 'ns_item');
	assert.deepEqual(doc._code._aid, ['item']);
	assert.equal(doc._key, 'ns_item');
	assert.deepEqual(doc._domn, { _term_role: ['_term_role_descriptor', '_term_role_enum-item'] });
	assert.deepEqual(r.computed.map(c => c.path), ['_code._gid', '_code._aid', '_domn._term_role', '_key']);
});

test('schema-driven: roles — namespace, enum-root, enum-source; preserved roles kept', () => {
	const doc = { _code: { _lid: 'ns_root', _gid: 'ns_root', _aid: ['ns_root'] }, _data: DICT.ns_root._data,
	              _domn: { _term_role: ['_term_role_multilingual', '_term_role_system', '_term_role_namespace'] } };
	const r = applyComputed(doc, '_term', access(), {});
	assert.equal(r.warnings.filter(w => w.path === '_domn._term_role').length, 1);   // stale: namespace dropped, others added
	assert.deepEqual(doc._domn._term_role,
		['_term_role_descriptor', '_term_role_enum-root', '_term_role_enum-source', '_term_role_multilingual', '_term_role_system']);
	const ns = { _code: { _lid: 'ns', _gid: 'ns', _aid: ['ns'] }, _domn: { _term_role: ['_term_role_namespace'] } };
	const r2 = applyComputed(ns, '_term', access(), {});
	assert.deepEqual(r2.warnings.filter(w => w.path === '_domn._term_role'), []);   // already right: nothing to say
});

test('schema-driven: an empty new _domn is not left behind when roles cannot be computed', () => {
	const doc = { _code: { _nid: 'ns', _lid: 'item' } };
	applyComputed(doc, '_term', access({ namespaces: undefined, predicates: undefined, enumSources: undefined }), { quietCompute: true });
	assert.equal(doc._domn, undefined);
	assert.equal(doc._key, 'ns_item');
});

test('schema-driven: a snapshot without the role facts leaves a stored _term_role untouched', () => {
	const doc = { _code: { _lid: 'ns_item', _gid: 'ns_item', _aid: ['ns_item'] }, _domn: { _term_role: ['_term_role_typedef'] } };
	const r = applyComputed(doc, '_term', access({ namespaces: undefined, predicates: undefined, enumSources: undefined }), {});
	assert.deepEqual(r.warnings.filter(w => w.path.startsWith('_domn')), []);
	assert.deepEqual(doc._domn._term_role, ['_term_role_typedef']);
});

test('schema-driven: noFill reports without touching the document', () => {
	const doc = { _code: { _nid: 'ns', _lid: 'item' } };
	const r = applyComputed(doc, '_term', access(), { noFill: true });
	assert.deepEqual(doc, { _code: { _nid: 'ns', _lid: 'item' } });
	assert.deepEqual(r.warnings.map(w => w.path), ['_code._gid', '_code._aid', '_key']);
});

test('a declared computed property with no function is NO_COMPUTE_FUNCTION', () => {
	const dict = Object.assign({}, DICT, { _code: term('_code', { _object: { _closed: {
		_required: all(['_lid', '_gid', '_aid']), _recommended: ['_nid', '_emoji'], _computed: ['_gid', '_aid', '_emoji'] } } }) });
	const acc = v.makeSnapshotDbAccess(Object.assign({ version: 1, termsCol: 'terms', terms: dict, enumEdges: EDGES }, FACTS), { onMiss: 'null' });
	const r = applyComputed({ _code: { _nid: 'ns', _lid: 'item' } }, '_term', acc, { quietCompute: true });
	assert.equal(r.errors.length, 1);
	assert.equal(r.errors[0].code, 'NO_COMPUTE_FUNCTION');
	assert.equal(r.errors[0].path, '_code._emoji');
});

test('checkComputeRegistry reports both directions', () => {
	const ok = { listComputedDeclarations: () => [
		{ gid: '_term', computed: ['_key'] }, { gid: '_code', computed: ['_gid', '_aid'] }, { gid: '_domn', computed: ['_term_role'] },
		{ gid: '_edge', computed: ['_key'] }, { gid: '_link', computed: ['_key'] }, { gid: '_blob', computed: ['_key'] } ] };
	assert.deepEqual(checkComputeRegistry(ok), []);
	const off = { listComputedDeclarations: () => [{ gid: '_term', computed: ['_key'] }, { gid: '_code', computed: ['_gid', '_aid', '_emoji'] }] };
	const problems = checkComputeRegistry(off);
	assert.ok(problems.some(p => p.startsWith('_code._emoji is declared')));
	assert.ok(problems.some(p => p.startsWith('_domn._term_role has a compute function')));
	assert.deepEqual(checkComputeRegistry({}), []);
});

test('validateDocument runs the schema-driven compute and reports fills', () => {
	const doc = { _code: { _nid: 'ns', _lid: 'item' }, _info: { _title: { ISO_639_3_eng: 'Item' } } };
	const r = v.validateDocument(doc, DICT._term, access(), { quietCompute: true });
	assert.equal(doc._key, 'ns_item');
	assert.ok(Array.isArray(r.computed) && r.computed.length >= 3);
});

console.log(`compute.test.js: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error('  ✗ ' + f.name + '\n    ' + (f.err && f.err.message));
process.exit(failures.length ? 1 : 0);
