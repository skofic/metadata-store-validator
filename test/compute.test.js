'use strict';

/**
 * compute.test.js — The compute registry and its driver (no database).
 *
 *   node test/compute.test.js
 *
 * Builds a small dictionary snapshot by hand — the three type anchors from the
 * fixture plus _term / _code / _domn / _info bodies, one namespace and one
 * enumeration — so the schema-driven walk can be exercised end to end.
 *
 * The bodies declare `_computed` in the legacy shape (gid strings); the
 * fallback path runs CORE_DECLARATIONS (the new entry objects), so the two
 * shapes are exercised side by side and must agree.
 */

const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const v = require('..');
const { applyComputed, checkComputeRegistry } = v;
const { computeTermCode, computeEdgeKey, computeBlobKey } = v.compute;
const { lookup, computeGid, resolveEntry, CORE_DECLARATIONS } = v.computeRegistry;
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
	assert.ok(problems.some(p => p.startsWith('_code._emoji: ') && p.includes('no function')));
	assert.ok(problems.some(p => p.startsWith('_domn._term_role has a compute function')));
	assert.ok(problems.some(p => p.startsWith('_code: the built-in fallback computes [_aid, _gid] but the dictionary declares [_aid, _emoji, _gid]')));
	assert.ok(problems.some(p => p.startsWith('_edge: the built-in fallback')));
	assert.deepEqual(checkComputeRegistry({}), []);
});

test('checkComputeRegistry accepts the new shape and catches a drifted core entry', () => {
	const rows = Object.keys(CORE_DECLARATIONS).map(gid => ({ gid, computed: CORE_DECLARATIONS[gid] }));
	assert.deepEqual(checkComputeRegistry({ listComputedDeclarations: () => rows }), []);
	const drifted = JSON.parse(JSON.stringify(rows));
	drifted.find(r => r.gid === '_edge').computed[0]._compute_separator = '-';
	const problems = checkComputeRegistry({ listComputedDeclarations: () => drifted });
	assert.equal(problems.length, 1);
	assert.ok(problems[0].startsWith('_edge._key: the built-in fallback'));
	const mixed = rows.map(r => r.gid === '_code' ? { gid: '_code', computed: ['_gid', '_aid'] } : r);   // legacy gids on one body
	assert.deepEqual(checkComputeRegistry({ listComputedDeclarations: () => mixed }), []);
	// ArangoDB returns object keys sorted: key order must not count as a difference
	const sorted = rows.map(r => ({ gid: r.gid, computed: r.computed.map(e => Object.fromEntries(Object.keys(e).sort().map(k => [k, e[k]]))) }));
	assert.deepEqual(checkComputeRegistry({ listComputedDeclarations: () => sorted }), []);
});

// ── the interpreter: entry objects ────────────────────────────────────────────

const run = (schema, entry, container, root, ctx) => {
	const e = resolveEntry(schema, entry);
	if (e.problem) return e.problem;
	return e.compute(container, root || container, ctx || { shadow: {}, containerPath: [] });
};

test('copy reads one container-relative path, dotted paths included', () => {
	assert.equal(run('_term', CORE_DECLARATIONS._term[0], { _code: { _gid: 'ns_item' } }), 'ns_item');
	assert.equal(run('_term', CORE_DECLARATIONS._term[0], { _code: {} }), undefined);
	assert.deepEqual(run('x', { _field: 'b', _compute_kind: '_compute_kind_copy', _compute_from: ['a'] }, { a: { k: [1] } }), { k: [1] });
});

test('concat skips absent parts and keeps an empty-string part', () => {
	const e = CORE_DECLARATIONS._code[0];
	assert.equal(run('_code', e, { _lid: 'ISO' }), 'ISO');
	assert.equal(run('_code', e, { _nid: '', _lid: 'code' }), '_code');
	assert.equal(run('_code', e, { _nid: 'ISO_3166', _lid: 'ITA' }), 'ISO_3166_ITA');
	assert.equal(run('_code', e, {}), undefined);
	assert.equal(run('_code', e, { _nid: { x: 1 }, _lid: 'a' }), undefined);   // a non-scalar part cannot join
});

test('hash joins every part with the separator and digests it; a missing part yields nothing', () => {
	const edge = { _from: 'terms/_scale_year', _predicate: '_predicate_enum-of', _to: 'terms/_scale' };
	assert.equal(run('_edge', CORE_DECLARATIONS._edge[0], edge), lookup('_edge', '_key').compute(edge));
	assert.equal(run('_link', CORE_DECLARATIONS._link[0], edge), lookup('_link', '_key').compute(edge));
	assert.equal(run('_edge', CORE_DECLARATIONS._edge[0], { _from: 'terms/a', _to: 'terms/b' }), undefined);
	const blob = { _blob_item: 'flag', _blob_type: '_text_SVG', _blob_kind: '_media_landscape', _blob_identifier: 'ad' };
	assert.equal(run('_blob', CORE_DECLARATIONS._blob[0], blob), '339d23fc1dbffe043bc69d6db95b5912');
});

test('union adds each source value once and says nothing when no source is present', () => {
	const e = CORE_DECLARATIONS._code[1];
	assert.deepEqual(run('_code', e, { _lid: 'it', _aid: ['IT', '380'] }), ['IT', '380', 'it']);
	assert.deepEqual(run('_code', e, { _lid: 'it', _aid: ['it'] }), ['it']);
	assert.deepEqual(run('_code', e, { _lid: 'it' }), ['it']);
	assert.equal(run('_code', e, { _aid: ['it'] }), undefined);
	const multi = { _field: 't', _compute_kind: '_compute_kind_union', _compute_from: ['a', 'b'] };
	assert.deepEqual(run('x', multi, { t: [1], a: [1, 2], b: 3 }), [1, 2, 3]);
});

test('rule runs the named rule with the dbAccess of the context', () => {
	const e = CORE_DECLARATIONS._domn[0];
	assert.equal(run('_domn', e, {}, { _code: { _gid: 'ns_item' } }, { dbAccess: null, shadow: {}, containerPath: [] }), undefined);
	assert.deepEqual(run('_domn', e, {}, { _code: { _gid: 'ns_item' } }, { dbAccess: access(), shadow: {}, containerPath: [] }),
		['_term_role_enum-item']);
});

test('constant fills only an absent property and is never a mismatch', () => {
	const body = { _computed: [{ _field: 'status', _compute_kind: '_compute_kind_constant', _compute_value: { state: 'active' } }] };
	const dict = Object.assign({}, DICT, {
		_term: term('_term', { _object: { _closed: { _required: all(['_key', '_code']), _recommended: ['_info', 'status'],
			_computed: ['_key', body._computed[0]], _immutable: ['_key'] } } }),
		status: term('status', { _object: {} }),
	});
	const acc = v.makeSnapshotDbAccess(Object.assign({ version: 1, termsCol: 'terms', terms: dict, enumEdges: EDGES }, FACTS), { onMiss: 'null' });
	const fresh = { _code: { _nid: 'ns', _lid: 'item' } };
	const r1 = applyComputed(fresh, '_term', acc, {});
	assert.deepEqual(fresh.status, { state: 'active' });
	assert.ok(r1.warnings.some(w => w.path === 'status' && w.code === 'COMPUTE_ADDED'));
	fresh.status.state = 'changed';                                 // the filled value is a copy
	assert.equal(body._computed[0]._compute_value.state, 'active');
	const kept = { _code: { _nid: 'ns', _lid: 'item' }, status: 'anything' };
	const r2 = applyComputed(kept, '_term', acc, {});
	assert.equal(kept.status, 'anything');
	assert.deepEqual(r2.errors, []);
	assert.ok(!r2.warnings.some(w => w.path === 'status'));
});

test('entries apply in list order and noFill still sees an unwritten value through the shadow', () => {
	const doc = { _code: { _nid: 'ns', _lid: 'item' } };
	const r = computeTermCode(doc, { noFill: true });                 // fallback = CORE_DECLARATIONS
	assert.deepEqual(doc, { _code: { _nid: 'ns', _lid: 'item' } });
	assert.deepEqual(r.computed.map(c => c.path + '=' + JSON.stringify(c.value)), ['_code._gid="ns_item"', '_code._aid=["item"]', '_key="ns_item"']);
});

test('a mixed body — one legacy gid, one entry object — runs both', () => {
	const dict = Object.assign({}, DICT, { _code: term('_code', { _object: { _closed: {
		_required: all(['_lid', '_gid', '_aid']), _recommended: ['_nid', '_emoji'],
		_computed: ['_gid', CORE_DECLARATIONS._code[1]] } } }) });
	const acc = v.makeSnapshotDbAccess(Object.assign({ version: 1, termsCol: 'terms', terms: dict, enumEdges: EDGES }, FACTS), { onMiss: 'null' });
	const doc = { _code: { _nid: 'ns', _lid: 'item' } };
	const r = applyComputed(doc, '_term', acc, { quietCompute: true });
	assert.deepEqual(r.errors, []);
	assert.deepEqual(doc._code, { _nid: 'ns', _lid: 'item', _gid: 'ns_item', _aid: ['item'] });
});

test('malformed entries: INVALID_COMPUTE, DUPLICATE_VALUE, NO_COMPUTE_FUNCTION', () => {
	const bad = (entry) => resolveEntry('_code', entry).problem;
	assert.equal(bad({ _field: '_gid', _compute_kind: '_compute_kind_concat', _compute_from: ['_nid', '_lid'] }).code, 'INVALID_COMPUTE');   // no separator
	assert.equal(bad({ _field: '_gid', _compute_kind: '_compute_kind_concat', _compute_from: [], _compute_separator: '_' }).code, 'INVALID_COMPUTE');
	assert.equal(bad({ _field: '_gid', _compute_kind: '_compute_kind_copy', _compute_from: ['a', 'b'] }).code, 'INVALID_COMPUTE');
	assert.equal(bad({ _compute_kind: '_compute_kind_copy', _compute_from: ['a'] }).code, 'INVALID_COMPUTE');                                  // no _field
	assert.equal(bad({ _field: '_gid', _compute_kind: '_compute_kind_concat', _compute_from: ['_lid', '_lid'], _compute_separator: '_' }).code, 'DUPLICATE_VALUE');
	assert.equal(bad({ _field: '_gid', _compute_kind: '_compute_kind_sha', _compute_from: ['_lid'] }).code, 'NO_COMPUTE_FUNCTION');
	assert.equal(bad({ _field: '_key', _compute_kind: '_compute_kind_hash', _compute_from: ['a'], _compute_separator: '/', _compute_digest: '_compute_digest_sha1' }).code, 'NO_COMPUTE_FUNCTION');
	assert.equal(bad({ _field: '_term_role', _compute_kind: '_compute_kind_rule', _compute_rule: '_compute_rule_nope' }).code, 'NO_COMPUTE_FUNCTION');
	assert.equal(bad('_emoji').code, 'NO_COMPUTE_FUNCTION');
	assert.equal(resolveEntry('_code', '_gid').problem, undefined);
	// through the driver the problem lands at the property's path
	const dict = Object.assign({}, DICT, { _code: term('_code', { _object: { _closed: {
		_required: all(['_lid', '_gid', '_aid']),
		_computed: [{ _field: '_gid', _compute_kind: '_compute_kind_concat', _compute_from: ['_nid', '_nid'], _compute_separator: '_' }] } } }) });
	const acc = v.makeSnapshotDbAccess(Object.assign({ version: 1, termsCol: 'terms', terms: dict, enumEdges: EDGES }, FACTS), { onMiss: 'null' });
	const r = applyComputed({ _code: { _nid: 'ns', _lid: 'item' } }, '_term', acc, { quietCompute: true });
	assert.deepEqual(r.errors.map(e => e.code + ' ' + e.path), ['DUPLICATE_VALUE _code._gid']);
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
