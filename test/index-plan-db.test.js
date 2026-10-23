'use strict';

/**
 * index-plan-db.test.js — The plan of `_term` against the live dictionary.
 *
 * The parity proof of round 3b: before any service generates an index from
 * the hints, the plan computed from the live terms must name exactly the
 * fields the hand-written `idx_search` carried (plus `_gid` as segments,
 * which that index already applied without the hint saying so). If a hint
 * changes in the dictionary this test moves with it — that is the point.
 *
 *   node test/index-plan-db.test.js --db ../metadata-store/globals/auth/db.credentials.local.json
 */

const fs   = require('fs');
const path = require('path');
const v    = require('..');

const args = process.argv.slice(2);
const i    = args.indexOf('--db');
if (i === -1 || !args[i + 1]) { console.error('Usage: node test/index-plan-db.test.js --db <credentials.json>'); process.exit(1); }
const credentials = JSON.parse(fs.readFileSync(path.resolve(args[i + 1]), 'utf8'));
const dbAccess = v.makeDbAccess(credentials, 2000);

const plan = v.indexPlan('_term', dbAccess);

// Expand multilingual fields the way the service does, so the comparison is
// against concrete index paths.
const paths = plan.fields.flatMap(f => f.multilingual ? f.languages.map(l => f.path + '.' + l) : [f.path]).sort();

const expected = [
	'_code._aid', '_code._gid', '_code._lid', '_code._name', '_code._nid', '_code._pid',
	'_info._definition.ISO_639_3_eng', '_info._description.ISO_639_3_eng', '_info._examples.ISO_639_3_eng',
	'_info._issues.ISO_639_3_eng', '_info._methods.ISO_639_3_eng', '_info._references._citation',
	'_info._references._provider', '_info._references._url', '_info._story.ISO_639_3_eng',
	'_info._title.ISO_639_3_eng', '_info._uses.ISO_639_3_eng',
	'_domn._category', '_domn._class', '_domn._domain', '_domn._list', '_domn._options',
	'_domn._subject', '_domn._tag', '_domn._term_role', '_domn._usage',
].sort();

const failures = [];
function check(name, ok, detail) { if (!ok) failures.push(name + (detail ? ': ' + detail : '')); }

check('field paths equal the idx_search set plus the _domn facets', JSON.stringify(paths) === JSON.stringify(expected),
	'\n  plan:     ' + paths.join(', ') + '\n  expected: ' + expected.join(', '));
check('_domn indexes everything it holds', JSON.stringify(plan.containers) === JSON.stringify([{ path: '_domn', gid: '_domn', intent: '_index_identity' }]), JSON.stringify(plan.containers));
check('_gid is indexed by segments', (plan.fields.find(f => f.path === '_code._gid') || {}).intent === '_index_segment');
check('_name is the one _code field indexed as text', plan.fields.filter(f => f.path.startsWith('_code.') && f.intent === '_index_text').map(f => f.path).join() === '_code._name');
check('every _info field is text', plan.fields.filter(f => f.path.startsWith('_info.')).every(f => f.intent === '_index_text'));
check('the facets are the _enum leaves of _domn, _class and _subject single-valued',
	JSON.stringify(plan.fields.filter(f => f.leaf === '_enum' && f.single).map(f => f.gid).sort()) === JSON.stringify(['_class', '_subject']));
check('no declaration problem', plan.problems.length === 0, JSON.stringify(plan.problems));

console.log('index-plan-db: ' + plan.fields.length + ' fields, ' + plan.containers.length + ' index-all container(s), ' + plan.problems.length + ' problems');
for (const f of failures) console.error('  ✗ ' + f);
if (failures.length) process.exit(1);
console.log('index-plan-db: all checks pass');
