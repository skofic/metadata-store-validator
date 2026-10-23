'use strict';

/**
 * compute-db.test.js — _term_role parity with the Swift assign-roles workflow.
 *
 * The roles stored on every term of the live dictionary were written by
 * `assign-roles` (workflows/assign-roles in metadata-store). Recomputing them
 * through the compute registry over the Node HTTP adapter must give the same
 * answer on every term — otherwise the two implementations disagree and one
 * of them is wrong. Also recomputes _code._gid / _aid and _key and expects no
 * mismatch anywhere. The registry cross-check (checkComputeRegistry) must run
 * for real: the HTTP adapter has to expose listComputedDeclarations — it did
 * not until v1.4.0, so the check silently passed.
 *
 *   node test/compute-db.test.js --db ../metadata-store/globals/auth/db.credentials.local.json
 */

const fs   = require('fs');
const path = require('path');
const v    = require('..');

const args = process.argv.slice(2);
const i    = args.indexOf('--db');
if (i === -1 || !args[i + 1]) { console.error('Usage: node test/compute-db.test.js --db <credentials.json>'); process.exit(1); }
const credentials = JSON.parse(fs.readFileSync(path.resolve(args[i + 1]), 'utf8'));

const dbAccess = v.makeDbAccess(credentials, 2000);
const query    = v.makeHttpQuery(credentials);
const termsCol = (credentials.collections || {}).terms || 'terms';

(async () => {
	const terms = await query('FOR t IN @@c RETURN { _key: t._key, _code: t._code, _data: t._data, _domn: t._domn }', { '@c': termsCol });
	let checked = 0, roleDiffs = [], otherFindings = [];
	for (const stored of terms) {
		const doc = JSON.parse(JSON.stringify(stored));
		const r = v.applyComputed(doc, '_term', dbAccess, { noFill: true });
		checked++;
		for (const f of r.errors.concat(r.warnings)) {
			if (f.path === '_domn._term_role') roleDiffs.push({ gid: stored._key, stored: (stored._domn || {})._term_role || [], computed: JSON.parse(f.expected) });
			else if (f.code !== 'COMPUTE_ADDED' || f.path !== '_code._aid') otherFindings.push({ gid: stored._key, code: f.code, path: f.path });
		}
	}
	if (typeof dbAccess.listComputedDeclarations !== 'function') { console.error('compute-db: the HTTP adapter does not expose listComputedDeclarations — the cross-check cannot run'); process.exit(1); }
	const problems = v.checkComputeRegistry(dbAccess);
	console.log(`compute-db: ${checked} terms; _term_role differences: ${roleDiffs.length}; other findings: ${otherFindings.length}; registry cross-check problems: ${problems.length}`);
	for (const d of roleDiffs.slice(0, 20)) console.log('  ', d.gid, 'stored', JSON.stringify(d.stored), 'computed', JSON.stringify(d.computed));
	for (const f of otherFindings.slice(0, 20)) console.log('  ', f.gid, f.code, f.path);
	for (const p of problems) console.log('   registry:', p);
	process.exit(roleDiffs.length || otherFindings.length || problems.length ? 1 : 0);
})().catch(err => { console.error(err.message); process.exit(1); });
