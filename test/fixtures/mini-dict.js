'use strict';

/**
 * mini-dict.js — A small dictionary built by hand for the no-database tests:
 * the three type anchors from the snapshot fixture plus _term / _code / _domn /
 * _info bodies (with the CORE_DECLARATIONS `_computed` entries), one namespace
 * and one enumeration — enough for the schema-driven compute walk and the
 * index plan to be exercised end to end.
 *
 *   const { DICT, EDGES, FACTS, term, all, access } = require('./fixtures/mini-dict');
 */

const fs   = require('fs');
const path = require('path');
const v    = require('../..');
const { CORE_DECLARATIONS } = v.computeRegistry;
const { collectEnumSources } = require('../../lib/edge-index');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'snapshot.test.json'), 'utf8'));
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
		_computed: CORE_DECLARATIONS._term, _immutable: ['_key'], _locked: ['_id', '_rev'] } } }),
	_code: term('_code', { _object: { _closed: {
		_required: all(['_lid', '_gid', '_aid']), _recommended: ['_nid', '_emoji'],
		_computed: CORE_DECLARATIONS._code, _immutable: ['_nid', '_lid', '_gid'] } } }),
	_domn: term('_domn', { _object: { _open: { _recommended: ['_term_role'], _computed: CORE_DECLARATIONS._domn } } }),
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


module.exports = { DICT, EDGES, FACTS, term, all, access, anchors };
