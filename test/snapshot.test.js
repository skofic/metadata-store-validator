'use strict';

/**
 * snapshot.test.js — Library tests that need a dictionary but no database.
 *
 * Runs against the hand-built snapshot in fixtures/snapshot.test.json:
 *   - the snapshot dbAccess contract (enum members, sections, rules, misses)
 *   - validateProperties, validateEnvelope, describeEnvelopeNeeds
 *   - createReport counts and shares
 *   - checkUnitBounds
 *   - warnings from validateValue / validateFile
 *
 *   node test/snapshot.test.js
 */

const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const v = require('..');

const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'snapshot.test.json'), 'utf8'));
const access   = v.makeSnapshotDbAccess(snapshot);

let passed = 0;
const failures = [];
function test(name, fn) {
	try {
		fn();
		passed++;
	} catch (err) {
		failures.push({ name, err });
	}
}
const codes = items => items.map(i => i.code).sort();

// ── Snapshot dbAccess contract ────────────────────────────────────────────────

test('enum member directly under the root', () => {
	assert.equal(access.isEnumMember('_TEST_colors_red', ['_TEST_colors']), true);
});
test('enum member through a section', () => {
	assert.equal(access.isEnumMember('_TEST_colors_orange', ['_TEST_colors']), true);
});
test('compound scope: descendant of the named branch only', () => {
	assert.equal(access.isEnumMember('_TEST_colors_orange', ['_TEST_colors._TEST_colors_warm']), true);
	assert.equal(access.isEnumMember('_TEST_colors_red',    ['_TEST_colors._TEST_colors_warm']), false);
});
test('a section is a branch, not a member', () => {
	assert.equal(access.isEnumMember('_TEST_colors_warm', ['_TEST_colors']), false);
	assert.equal(access.isEnumBranch('_TEST_colors_warm', '_TEST_colors'), true);
});
test('isEnumRoot', () => {
	assert.equal(access.isEnumRoot('_TEST_colors'), true);
});
test('rule getters', () => {
	assert.deepEqual(access.getPropertyRules('_TEST_color', 'terms/_TEST_record'),
		{ _object: { _open: { _banned: ['_TEST_label'] } } });
	assert.equal(access.getPropertyRules('_TEST_label', 'terms/_TEST_record'), null);
	assert.equal(access.getValueRules('_TEST_colors_red', '_TEST_color', 'terms/_TEST_record'), null);
	assert.deepEqual(access.getValueRuleTargets('_TEST_colors_red', '_TEST_color', 'terms/_TEST_record'), {});
	assert.equal(access.makeHandle('_TEST_color'), 'terms/_TEST_color');
});
test('a gid never requested throws, naming it', () => {
	assert.throws(() => access.getTerm('_TEST_unrequested'), /_TEST_unrequested/);
});
test("onMiss 'null' treats unrequested gids as absent", () => {
	const lenient = v.makeSnapshotDbAccess(snapshot, { onMiss: 'null' });
	assert.equal(lenient.getTerm('_TEST_unrequested'), null);
	const r = v.validateProperties({ _TEST_unrequested: 1 }, lenient);
	assert.deepEqual(codes(r.errors), ['UNKNOWN_PROPERTY']);
});
test('a snapshot without the anchor terms is refused', () => {
	const broken = JSON.parse(JSON.stringify(snapshot));
	delete broken.terms._type_scalar;
	assert.throws(() => v.makeSnapshotDbAccess(broken), /_type_scalar/);
});
test('the snapshot survives a JSON round trip', () => {
	const copy = v.makeSnapshotDbAccess(JSON.parse(JSON.stringify(snapshot)));
	assert.equal(copy.isEnumMember('_TEST_colors_orange', ['_TEST_colors']), true);
});

// ── validateProperties ────────────────────────────────────────────────────────

test('validateProperties: errors per descriptor, paths start with the gid', () => {
	const r = v.validateProperties({ _TEST_temp_K: -1, _TEST_color: '_TEST_colors_blue', _TEST_int: 5 }, access);
	assert.deepEqual(codes(r.errors), ['INVALID_ENUM', 'RANGE_VIOLATION']);
	for (const e of r.errors) assert.match(e.path, /^_TEST_(temp_K|color)\./);
});
test('validateProperties: an outlier is a warning, not an error', () => {
	const r = v.validateProperties({ _TEST_temp_K: 200 }, access);
	assert.deepEqual(r.errors, []);
	assert.deepEqual(codes(r.warnings), ['RANGE_OUTLIER']);
});
test('validateProperties: non-object input', () => {
	assert.deepEqual(codes(v.validateProperties([1, 2], access).errors), ['WRONG_TYPE']);
});
test('validateProperties requires a dbAccess', () => {
	assert.throws(() => v.validateProperties({}, null), TypeError);
});

// ── checkUnitBounds ───────────────────────────────────────────────────────────

test('checkUnitBounds: valid range wider than the unit bound', () => {
	const r = v.checkUnitBounds(snapshot.terms._TEST_pct, access);
	assert.deepEqual(codes(r), ['UNIT_RANGE_CONFLICT']);
	assert.equal(r[0].path, '_data._scalar._number._range_valid');
	assert.match(r[0].message, /reaches above/);
});
test('checkUnitBounds: consistent descriptors report nothing', () => {
	assert.deepEqual(v.checkUnitBounds(snapshot.terms._TEST_temp_K, access), []);
	assert.deepEqual(v.checkUnitBounds(snapshot.terms._TEST_angle, access), []);
});
test('checkUnitBounds: a range entirely below a lower bound (the water-potential case)', () => {
	const term = { _data: { _scalar: { _number: { _unit: 'unit_Temperature_K', _range_valid: { '_min-exclusive': -5, '_max-exclusive': 0 } } } } };
	assert.match(v.checkUnitBounds(term, access)[0].message, /reaches below/);
});
test('checkUnitBounds: an empty intersection', () => {
	const term = { _data: { _scalar: { _number: { _unit: 'unit_Temperature_K', _range_valid: { '_max-exclusive': 0 } } } } };
	assert.match(v.checkUnitBounds(term, access)[0].message, /does not overlap/);
});
test('checkUnitBounds: set element types are checked too', () => {
	const term = { _data: { _set: { _number: { _unit: 'unit_Percent_pct', _range_normal: { '_max-inclusive': 200 } } } } };
	assert.equal(v.checkUnitBounds(term, access)[0].path, '_data._set._number._range_normal');
});

// ── Envelope ──────────────────────────────────────────────────────────────────

test('describeEnvelopeNeeds', () => {
	const needs = v.describeEnvelopeNeeds(['_TEST_temp_K', '_TEST_color', '_TEST_geom'], access);
	assert.equal(needs._TEST_temp_K.kind, 'number');
	assert.deepEqual(needs._TEST_temp_K.ranges.unit, { '_min-inclusive': 0 });
	assert.deepEqual(needs._TEST_temp_K.ranges.normal, { '_min-inclusive': 250, '_max-inclusive': 320 });
	assert.equal(needs._TEST_color.kind, 'enum');
	assert.equal(needs._TEST_geom.kind, 'other');
});

const envelope = {
	_TEST_temp_K: { count: 1000, min: -3, max: 330, types: ['number'], outOfValid: 2, outOfNormal: 40 },
	_TEST_int:    { count: 10, min: 0, max: 5, types: ['number', 'string'], nonInteger: 1 },
	_TEST_color:  { count: 20, distinct: [{ value: '_TEST_colors_red', count: 15 }, { value: '_TEST_colors_blue', count: 5 }] },
	_TEST_geom:   { count: 3 },
	_TEST_nope:   { count: 1 },
};
const onMissNull = v.makeSnapshotDbAccess(snapshot, { onMiss: 'null' });
const envResult  = v.validateEnvelope(envelope, onMissNull);

test('validateEnvelope: counted range findings replace per-extreme ones', () => {
	const rv = envResult.errors.filter(e => e.gid === '_TEST_temp_K');
	assert.equal(rv.length, 1);
	assert.equal(rv[0].code, 'RANGE_VIOLATION');
	assert.equal(rv[0].count, 2);
	const out = envResult.warnings.filter(w => w.gid === '_TEST_temp_K');
	assert.equal(out.length, 1);
	assert.equal(out[0].count, 40);
});
test('validateEnvelope: types and integer-ness', () => {
	const ints = envResult.errors.filter(e => e.gid === '_TEST_int').map(e => e.which).sort();
	assert.deepEqual(ints, ['integer', 'type']);
});
test('validateEnvelope: distinct values carry their counts', () => {
	const bad = envResult.errors.filter(e => e.gid === '_TEST_color');
	assert.equal(bad.length, 1);
	assert.equal(bad[0].code, 'INVALID_ENUM');
	assert.equal(bad[0].count, 5);
});
test('validateEnvelope: unknown descriptors and unsupported kinds', () => {
	assert.ok(envResult.errors.some(e => e.gid === '_TEST_nope' && e.code === 'UNKNOWN_PROPERTY'));
	assert.ok(envResult.skipped.some(s => s.gid === '_TEST_geom'));
});
test('validateEnvelope: extremes are validated when no counts are given', () => {
	const r = v.validateEnvelope({ _TEST_temp_K: { count: 5, min: -1, max: 300 } }, access);
	assert.equal(r.errors.length, 1);
	assert.equal(r.errors[0].which, 'min');
	assert.equal(r.errors[0].count, null);
});

// ── Report ────────────────────────────────────────────────────────────────────

test('createReport: counts and shares per descriptor', () => {
	const report  = v.createReport();
	const records = [
		{ _TEST_temp_K: 200, _TEST_int: 1 },
		{ _TEST_temp_K: 300, _TEST_int: 2 },
		{ _TEST_temp_K: 290, _TEST_int: 101 },
		{ _TEST_temp_K: 310 },
	];
	for (const rec of records) report.add(v.validateProperties(rec, access), { properties: rec });
	const s = report.summary();
	assert.equal(s.documents, 4);
	assert.equal(s.documentsWithErrors, 1);
	assert.equal(s.documentsWithWarnings, 1);
	assert.equal(s.values._TEST_temp_K, 4);
	assert.equal(s.warnings.byDescriptor._TEST_temp_K.RANGE_OUTLIER.count, 1);
	assert.equal(s.warnings.byDescriptor._TEST_temp_K.RANGE_OUTLIER.share, 0.25);
	assert.equal(s.errors.byDescriptor._TEST_int.RANGE_VIOLATION.share, 1 / 3);
	const text = report.format();
	assert.match(text, /_TEST_temp_K\s+RANGE_OUTLIER\s+1 \/ 4 \(25\.0%\)/);
});
test('createReport: envelope results use the aggregated counts', () => {
	const report = v.createReport().addEnvelope(envResult, envelope);
	const s = report.summary();
	assert.equal(s.warnings.byDescriptor._TEST_temp_K.RANGE_OUTLIER.count, 40);
	assert.equal(s.warnings.byDescriptor._TEST_temp_K.RANGE_OUTLIER.share, 0.04);
	assert.match(report.format(), /40 \/ 1,000 \(4\.00%\)/);
});

// ── Warnings in the other entry points ────────────────────────────────────────

test('validateValue separates warnings', () => {
	const r = v.validateValue(150, { _scalar: { _number: { _range_normal: { '_max-inclusive': 100 } } } }, null);
	assert.deepEqual(r.errors, []);
	assert.deepEqual(codes(r.warnings), ['RANGE_OUTLIER']);
});
test('validateFile: compute runs, a warning-only document passes', () => {
	const descriptor = { _data: { _object: { _open: {} } } };
	const report = v.validateFile([{ _code: { _nid: '', _lid: 'x' } }], () => descriptor, null);
	assert.equal(report.passed, 1);
	assert.equal(report.failed, 0);
	assert.equal(typeof report.warned, 'number');
});

// ── Result ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
	for (const f of failures) {
		console.log('FAIL  ' + f.name);
		console.log('      ' + (f.err && f.err.message ? f.err.message.split('\n').join('\n      ') : f.err));
	}
}
console.log('snapshot.test.js: ' + passed + ' passed' + (failures.length ? ', ' + failures.length + ' FAILED' : ''));
process.exit(failures.length > 0 ? 1 : 0);
