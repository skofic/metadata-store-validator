'use strict';

/**
 * run.js — Regression test runner for the metadata-store validator.
 *
 * Reads all test/test.*.json files and validates each case against the validator.
 * Each case declares its own _data section (or _descriptor GID), the value under
 * test, and whether the result is expected to pass or fail.
 *
 * Usage:
 *   node run.js [--db <credentials.json>] [--fixtures] [--no-cleanup]
 *               [--filter <name>] [--verbose]
 *
 *   --db <path>      Path to a credentials file (enables DB-backed tests).
 *   --fixtures       Insert test/fixtures/terms.*.json and edges.*.json before
 *                    running, then delete them after (requires --db).
 *   --no-cleanup     Keep fixture documents in the DB after the run.
 *   --filter <name>  Only run test files whose filename contains <name>.
 *   --verbose        Show passing and skipped cases (default: failures only).
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { validateValue, validateConformance, validateByDictionary } = require('..');

// ── CLI parsing ────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
let credPath    = null;
let useFixtures = false;
let noCleanup   = false;
let filter      = null;
let verbose     = false;

for (let i = 0; i < args.length; i++) {
	if      (args[i] === '--db'      && args[i + 1]) { credPath    = args[++i]; }
	else if (args[i] === '--fixtures')               { useFixtures = true; }
	else if (args[i] === '--no-cleanup')             { noCleanup   = true; }
	else if (args[i] === '--filter'  && args[i + 1]) { filter      = args[++i]; }
	else if (args[i] === '--verbose')                { verbose     = true; }
	else if (args[i] === '--help') {
		console.log('Usage: node run.js [--db <creds.json>] [--fixtures] [--no-cleanup] [--filter <name>] [--verbose]');
		process.exit(0);
	}
}

// ── Paths ──────────────────────────────────────────────────────────────────────

const ROOT     = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;

// ── Credentials (parsed early; dbAccess is initialised after fixture loading) ──

let dbAccess    = null;
let credentials = null;

if (credPath) {
	try {
		credentials = JSON.parse(fs.readFileSync(path.resolve(credPath), 'utf8'));
	} catch (err) {
		console.error('Cannot read credentials: ' + err.message);
		process.exit(1);
	}
}

function initDbAccess() {
	if (!credentials || dbAccess) return;
	try {
		const makeDbAccess = require('../db/db-access');
		dbAccess = makeDbAccess(credentials, 500);
	} catch (err) {
		console.error('DB init failed: ' + err.message);
		process.exit(1);
	}
}

// ── Fixture loading / cleanup ──────────────────────────────────────────────────

const fixtureHandles = [];

function httpSync(method, url, body) {
	const sr = require('sync-request');
	const auth = 'Basic ' + Buffer.from(credentials.username + ':' + credentials.password).toString('base64');
	const opts = { headers: { 'Authorization': auth, 'Content-Type': 'application/json' } };
	if (body !== null) opts.body = JSON.stringify(body);
	return JSON.parse(sr(method, url, opts).getBody('utf8'));
}

function docApiUrl(collection, key) {
	const base = credentials.host + '/_db/' + credentials.database + '/_api/document';
	return key ? base + '/' + collection + '/' + key : base + '/' + collection;
}

function loadFixtures() {
	const dir = path.join(TEST_DIR, 'fixtures');
	if (!fs.existsSync(dir)) return;

	const cols = credentials.collections || {};
	const files = fs.readdirSync(dir).filter(f => /^(terms|edges)\..+\.json$/.test(f)).sort();

	for (const file of files) {
		const docs    = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
		const isEdge  = file.startsWith('edges.');
		const col     = isEdge ? (cols.edges || 'edges') : (cols.terms || 'terms');

		for (const doc of docs) {
			const key = isEdge
				? crypto.createHash('md5').update(doc._from + '/' + doc._predicate + '/' + doc._to).digest('hex')
				: (doc._code && doc._code._gid) || doc._gid;  // _gid lives inside _code in term files
			const res = httpSync('POST', docApiUrl(col) + '?overwrite=true', Object.assign({ _key: key }, doc));
			if (res.error) { console.error('  fixture insert error (' + key + '): ' + res.errorMessage); }
			else           { fixtureHandles.push({ col, key }); }
		}
	}

	if (fixtureHandles.length > 0) {
		console.log('Loaded ' + fixtureHandles.length + ' fixture document(s).');
	}
}

function cleanupFixtures() {
	let n = 0;
	for (const { col, key } of fixtureHandles) {
		const res = httpSync('DELETE', docApiUrl(col, key), null);
		if (!res.error) n++;
	}
	console.log('Cleaned up ' + n + '/' + fixtureHandles.length + ' fixture document(s).');
}

// ── Test execution ─────────────────────────────────────────────────────────────

function runFile(filePath) {
	const cases   = JSON.parse(fs.readFileSync(filePath, 'utf8'));
	const results = [];

	for (const tc of cases) {
		const label = tc._label || '(unlabelled)';

		// Skip DB-backed cases when no DB credentials were provided
		if (tc._db && !dbAccess) {
			results.push({ label, status: 'skipped', reason: 'no DB' });
			continue;
		}

		// Resolve the data section to validate against.
		// In conformance mode with _descriptor, validateByDictionary handles the
		// lookup itself — no need to pre-fetch here.
		let dataSection;
		if (tc._conformance && tc._descriptor) {
			dataSection = null; // unused; validateByDictionary does its own lookup
		} else if (tc._data !== undefined) {
			dataSection = tc._data;
		} else if (tc._descriptor) {
			if (!dbAccess) {
				results.push({ label, status: 'skipped', reason: 'no DB (descriptor lookup)' });
				continue;
			}
			const term = dbAccess.getTerm(tc._descriptor);
			if (!term) {
				results.push({ label, status: 'fail', reason: 'descriptor "' + tc._descriptor + '" not found in DB' });
				continue;
			}
			dataSection = term._data || {};
		} else {
			results.push({ label, status: 'fail', reason: 'test case missing _data or _descriptor' });
			continue;
		}

		// Validate — use conformance pass when _conformance: true so that
		// property-of and value-of rule edges are applied from the DB.
		let result;
		if (tc._conformance && dbAccess) {
			result = tc._descriptor
				? validateByDictionary(tc._value, tc._descriptor, dbAccess, {})
				: validateConformance(tc._value, dataSection, [], dbAccess, {});
		} else {
			result = validateValue(tc._value, dataSection, dbAccess, {});
		}
		const errors = result.errors || [];
		const actual = errors.length === 0 ? 'pass' : 'fail';

		if (actual !== tc._expect) {
			const reason = actual === 'pass'
				? 'expected fail but validation passed'
				: 'expected pass but got ' + errors.length + ' error(s): ' + errors.map(e => e.code).join(', ');
			results.push({ label, status: 'fail', reason });
			continue;
		}

		// Optional subset-of-codes check (only for expected failures)
		if (tc._expect === 'fail' && Array.isArray(tc._codes) && tc._codes.length > 0) {
			const actualCodes = new Set(errors.map(e => e.code));
			const missing     = tc._codes.filter(c => !actualCodes.has(c));
			if (missing.length > 0) {
				results.push({
					label,
					status: 'fail',
					reason: 'missing expected error code(s): ' + missing.join(', ') +
					        '  (got: ' + [...actualCodes].join(', ') + ')',
				});
				continue;
			}
		}

		results.push({ label, status: 'pass' });
	}

	return results;
}

// ── Main ───────────────────────────────────────────────────────────────────────

// Fixtures must be loaded BEFORE dbAccess is initialised so that the
// pre-loaded edge maps (enum-of, property-of, value-of) include fixture edges.
if (useFixtures) {
	if (!credentials) { console.error('--fixtures requires --db <credentials>'); process.exit(1); }
	loadFixtures();
}

// Initialise dbAccess now — after fixtures are in the DB.
initDbAccess();

let testFiles = fs.readdirSync(TEST_DIR)
	.filter(f => /^test\..+\.json$/.test(f))
	.sort()
	.map(f => path.join(TEST_DIR, f));

if (filter) testFiles = testFiles.filter(f => path.basename(f).includes(filter));

if (testFiles.length === 0) {
	console.log('No test files found' + (filter ? ' matching "' + filter + '"' : '') + '.');
	process.exit(0);
}

let totalPass = 0, totalFail = 0, totalSkip = 0;
const failures = [];

for (const fp of testFiles) {
	const rel     = path.relative(ROOT, fp);
	const results = runFile(fp);

	let fp_pass = 0, fp_fail = 0, fp_skip = 0;
	for (const r of results) {
		if      (r.status === 'pass')    { totalPass++; fp_pass++; }
		else if (r.status === 'fail')    { totalFail++; fp_fail++; failures.push({ file: rel, label: r.label, reason: r.reason }); }
		else                             { totalSkip++; fp_skip++; }
	}

	if (verbose || fp_fail > 0) {
		const parts = [fp_pass + ' passed'];
		if (fp_fail > 0) parts.push(fp_fail + ' FAILED');
		if (fp_skip > 0) parts.push(fp_skip + ' skipped');
		console.log('\n' + rel + '  —  ' + parts.join(', '));
		for (const r of results) {
			if      (r.status === 'pass'    && verbose) { console.log('  PASS  ' + r.label); }
			else if (r.status === 'fail')               { console.log('  FAIL  ' + r.label + '\n        ' + r.reason); }
			else if (r.status === 'skipped' && verbose) { console.log('  SKIP  ' + r.label + '  (' + r.reason + ')'); }
		}
	}
}

console.log('\n' + '─'.repeat(60));
const summParts = [totalPass + ' passed'];
if (totalFail > 0) summParts.push(totalFail + ' FAILED');
if (totalSkip > 0) summParts.push(totalSkip + ' skipped');
console.log(summParts.join('  ') + '  (' + testFiles.length + ' file' + (testFiles.length !== 1 ? 's' : '') + ')');

if (failures.length > 0 && !verbose) {
	console.log('\nFailed:');
	for (const f of failures) {
		console.log('  ' + f.file + '  —  ' + f.label);
		console.log('    ' + f.reason);
	}
}

if (useFixtures && !noCleanup) cleanupFixtures();

process.exit(totalFail > 0 ? 1 : 0);
