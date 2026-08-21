#!/usr/bin/env node
'use strict';

/**
 * bin/validate.js — CLI entry point for dictionary-conformance validation.
 *
 * Validates JSON files (term, edge, link, blob, or dataset documents) against
 * the loaded ArangoDB dictionary. Validates each document fully before stopping
 * on the first document that has at least one error.
 *
 * Usage:
 *   metadata-validate [options] <path>        (or: node bin/validate.js [options] <path>)
 *
 * <path> may be a single JSON file or a directory (searched recursively).
 * Mode is auto-detected from the filename when not specified:
 *   terms.*.json  → term  (_term descriptor)
 *   edges.*.json  → edge  (_edge descriptor)
 *   links.*.json  → link  (_link descriptor)
 *   blobs.*.json  → blob  (_blob descriptor)
 *
 * Options:
 *   --mode <mode>        term | edge | link | blob | strict | lenient
 *   --descriptor <gid>   Descriptor _gid (required for strict/lenient)
 *   --credentials <path> Path to a credentials file
 *                        (default: $METADATA_VALIDATOR_CREDENTIALS, else
 *                         ./globals/auth/db.credentials.current.json relative to the
 *                         current directory — a JSON pointer { "use": "db.credentials.<name>.json" }
 *                         to the active server; the tool follows one hop to the named sibling)
 *   --cache-size <n>     LRU cache size for term lookups (default: 500)
 *   --strict             UNKNOWN_PROPERTY is an error (default for named modes)
 *   --lenient            UNKNOWN_PROPERTY is a warning
 *   --compute            Fill in _key, _gid, _aid from _nid+_lid; warn when absent
 *   --strict-compute     Absent computed properties are errors instead of warnings
 *   --quiet-compute      Fill in computed properties silently (no warning)
 *   --no-fill            Report absent computed properties without filling them in
 *   --persist            Prepare for DB insert: fill in computed properties silently
 *                        (implies --compute --quiet-compute)
 *   --resolve-handles    Expand bare GIDs to <col>/<key> in _from, _to, _path
 *   --terms-col <n>      Terms collection name (default: terms)
 *   --edges-col <n>      Edges collection name (default: edges)
 *   --links-col <n>      Links collection name (default: links)
 *   --blobs-col <n>      Blobs collection name (default: blobs)
 */

const fs   = require('fs');
const path = require('path');

const makeDbAccess             = require('../db/db-access');
const { ANCHOR }               = require('../lib/type-registry');

/**
 * Warn when a type-vocabulary anchor is not marked with _term_role_authority.
 *
 * ANCHOR (code) and the set of terms carrying _term_role_authority (data) are two
 * statements of the same fact: which terms the validation engine reads by name and
 * consumes as rules. Nothing else would notice them diverging, and the divergence
 * is silent — a missing marker just leaves the term unprotected against deletion.
 *
 * @param {Object} dbAccess - DB accessor exposing getTerm(gid).
 */
function checkAnchorRoles(dbAccess) {
	const problems = [];
	for (const gid of Object.values(ANCHOR)) {
		const term = dbAccess.getTerm(gid);
		if (!term) {
			problems.push(gid + ' (term not found)');
		} else if (!((term._domn || {})._term_role || []).includes('_term_role_authority')) {
			problems.push(gid + ' (missing _term_role_authority)');
		}
	}
	if (problems.length > 0) {
		console.error('WARNING: type-vocabulary anchor(s) not marked as authority terms: ' +
			problems.join(', '));
		console.error('         The validator reads these terms by name; they must carry ' +
			'_term_role_authority so they are protected from deletion.');
	}
}
const { validateByDictionary } = require('../lib');
const { computeTermCode, computeEdgeKey, computeBlobKey } = require('../lib/compute');

// Load a credentials file, following a one-hop `use` pointer if present.
// A pointer file is JSON like { "use": "db.credentials.local.json" }; it names a
// sibling credentials file (bare filename only). Returns { path, credentials }
// where `path` is the resolved real file. Exits with a clear message on failure.
function resolveCredentials(credPath) {
	let raw;
	try {
		raw = fs.readFileSync(credPath, 'utf8');
	} catch (e) {
		console.error('Cannot read credentials: ' + credPath);
		process.exit(1);
	}
	let obj;
	try {
		obj = JSON.parse(raw);
	} catch (e) {
		console.error('Malformed credentials JSON: ' + credPath);
		process.exit(1);
	}
	if (obj && typeof obj.use === 'string' && obj.use) {
		if (obj.use.includes('/') || obj.use.includes('\\')) {
			console.error('Invalid "use" in ' + credPath + ': "' + obj.use + '" must be a bare sibling filename (no path separators).');
			process.exit(1);
		}
		const target = path.join(path.dirname(credPath), obj.use);
		let tobj;
		try {
			tobj = JSON.parse(fs.readFileSync(target, 'utf8'));
		} catch (e) {
			console.error('Credentials pointer target missing or unreadable: ' + target + ' (from ' + credPath + ')');
			process.exit(1);
		}
		if (tobj && typeof tobj.use === 'string') {
			console.error('Credentials pointer chain not allowed: ' + credPath + ' → ' + target + ' (only one hop). Set "use" to a real credentials file.');
			process.exit(1);
		}
		return { path: target, credentials: tobj };
	}
	return { path: credPath, credentials: obj };
}

// Named modes → descriptor GIDs
const MODE_DESCRIPTORS = {
	term: '_term',
	edge: '_edge',
	link: '_link',
	blob: '_blob',
};

// Auto-detect validation mode from the JSON filename
function detectMode(filename) {
	const base = path.basename(filename);
	if (/^terms\./.test(base)) return 'term';
	if (/^edges\./.test(base)) return 'edge';
	if (/^links\./.test(base)) return 'link';
	if (/^blobs\./.test(base)) return 'blob';
	return null;
}

// Collect all .json files under a path (recursive for directories)
function collectJsonFiles(target) {
	const stat = fs.statSync(target);
	if (stat.isFile()) {
		return target.endsWith('.json') ? [target] : [];
	}
	return fs.readdirSync(target, { withFileTypes: true })
		.flatMap(function(entry) {
			const full = path.join(target, entry.name);
			if (entry.isDirectory())         return collectJsonFiles(full);
			if (entry.name.endsWith('.json')) return [full];
			return [];
		});
}

// Build an index of { fileLine, offset } for each top-level document in a JSON array.
// Only tracks {} depth (the outer [] is ignored), so depth 0→1 is the start of a document.
function buildDocIndex(content) {
	const index  = [];
	let depth    = 0;
	let inString = false;
	let escaped  = false;
	let lineNum  = 1;

	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		if (ch === '\n') { lineNum++; continue; }
		if (escaped)   { escaped = false; continue; }
		if (inString) {
			if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === '{') {
			depth++;
			if (depth === 1) index.push({ fileLine: lineNum, offset: i });
		} else if (ch === '}') {
			depth--;
		}
	}
	return index;
}

// Build a map from dot-path to { fileLine, docLine } for every key in one document.
// fileLine counts from the start of the file; docLine counts from the document's opening {.
// Array elements use [N] notation; object keys use dot notation.
// Paths that don't match (e.g. because the file is minified) simply won't be in the map.
function buildPathLineMap(content, startOffset, startFileLine) {
	const map = new Map();
	let pos      = startOffset;
	let fileLine = startFileLine;
	let docLine  = 1;

	function skipWS() {
		while (pos < content.length) {
			const c = content[pos];
			if      (c === '\n')                     { fileLine++; docLine++; pos++; }
			else if (c === ' ' || c === '\t' || c === '\r') pos++;
			else break;
		}
	}

	function readStr() {
		pos++; // skip opening "
		let s = '';
		while (pos < content.length) {
			const c = content[pos++];
			if (c === '\\') { pos++; continue; } // skip escaped character
			if (c === '"') break;
			if (c === '\n') { fileLine++; docLine++; }
			s += c;
		}
		return s;
	}

	function parseVal(dotPath) {
		skipWS();
		if (pos >= content.length) return;
		const c = content[pos];
		if      (c === '{') parseObj(dotPath);
		else if (c === '[') parseArr(dotPath);
		else if (c === '"') readStr();
		else { while (pos < content.length && !/[\s,}\]]/.test(content[pos])) pos++; }
	}

	function parseObj(dotPath) {
		pos++; skipWS();
		while (pos < content.length && content[pos] !== '}') {
			if (content[pos] === ',') { pos++; skipWS(); continue; }
			const kfl  = fileLine;
			const kdl  = docLine;
			const key  = readStr();
			const child = dotPath ? dotPath + '.' + key : key;
			map.set(child, { fileLine: kfl, docLine: kdl });
			skipWS();
			if (content[pos] === ':') pos++;
			parseVal(child);
			skipWS();
		}
		if (pos < content.length) pos++; // skip }
	}

	function parseArr(dotPath) {
		pos++; skipWS();
		let idx = 0;
		while (pos < content.length && content[pos] !== ']') {
			if (content[pos] === ',') { pos++; idx++; skipWS(); continue; }
			parseVal(dotPath + '[' + idx + ']');
			skipWS();
		}
		if (pos < content.length) pos++; // skip ]
	}

	parseVal('');
	return map;
}

function parseArgs(argv) {
	const args = {
		mode:           null,
		descriptor:     null,
		credentials:    null,
		cacheSize:      500,
		strict:         null,
		compute:        false,
		strictCompute:  false,
		quietCompute:   false,
		noFill:         false,
		persist:        false,
		resolveHandles: false,
		quiet:          false,
		errorsOnly:     false,
		termsCol:       null,
		edgesCol:       null,
		linksCol:       null,
		blobsCol:       null,
		target:         null,
	};
	let i = 2;
	while (i < argv.length) {
		switch (argv[i]) {
		case '--mode':            args.mode           = argv[++i]; break;
		case '--descriptor':      args.descriptor     = argv[++i]; break;
		case '--credentials':     args.credentials    = argv[++i]; break;
		case '--cache-size':      args.cacheSize      = parseInt(argv[++i], 10); break;
		case '--strict':         args.strict        = true;  break;
		case '--lenient':        args.strict        = false; break;
		case '--compute':        args.compute       = true;  break;
		case '--strict-compute': args.strictCompute = true;  break;
		case '--quiet-compute':  args.quietCompute  = true;  break;
		case '--no-fill':        args.noFill        = true;  break;
		case '--persist':        args.persist       = true;  break;
		case '--resolve-handles': args.resolveHandles = true;      break;
		case '--quiet':           args.quiet          = true;      break;
		case '--errors-only':     args.errorsOnly     = true;      break;
		case '--terms-col':       args.termsCol       = argv[++i]; break;
		case '--edges-col':       args.edgesCol       = argv[++i]; break;
		case '--links-col':       args.linksCol       = argv[++i]; break;
		case '--blobs-col':       args.blobsCol       = argv[++i]; break;
		default:
			if (!argv[i].startsWith('--')) args.target = argv[i];
		}
		i++;
	}
	return args;
}

// Apply compute phase: verify / fill computed properties.
// Terms  → _key, _gid, _aid (from _nid+_lid).
// Edges  → _key (from MD5 of _from/_predicate/_to; handles must be resolved first).
// Returns { errors, warnings }, or empty arrays for unrecognised doc types.
function applyCompute(doc, opts) {
	if (doc && doc._code)       return computeTermCode(doc, opts);
	if (doc && doc._predicate)  return computeEdgeKey(doc, opts);
	if (doc && doc._blob_item)  return computeBlobKey(doc, opts);
	return { errors: [], warnings: [] };
}

// Apply --resolve-handles: expand bare GIDs to <termsCol>/<gid> in _from, _to, _path,
// and rename matching keys in _path_data to their handle form (mutates in place).
function applyHandles(doc, termsCol) {
	const col = termsCol || 'terms';
	function expand(v) { return (typeof v === 'string' && !v.includes('/')) ? col + '/' + v : v; }

	// Collect bare→handle mapping before expanding, so we can rename _path_data keys.
	const bareToHandle = new Map();
	function record(v) { if (typeof v === 'string' && !v.includes('/')) bareToHandle.set(v, col + '/' + v); }
	record(doc._from);
	record(doc._to);
	if (Array.isArray(doc._path)) doc._path.forEach(record);

	if (typeof doc._from === 'string') doc._from = expand(doc._from);
	if (typeof doc._to   === 'string') doc._to   = expand(doc._to);
	if (Array.isArray(doc._path))      doc._path = doc._path.map(expand);

	// Rename _path_data keys that were bare GIDs matching _from, _to, or _path elements.
	if (doc._path_data && typeof doc._path_data === 'object') {
		for (const [bare, handle] of bareToHandle) {
			if (Object.prototype.hasOwnProperty.call(doc._path_data, bare)) {
				doc._path_data[handle] = doc._path_data[bare];
				delete doc._path_data[bare];
			}
		}
	}
}

function usage() {
	console.error([
		'Usage: metadata-validate [options] <path>',
		'',
		'Arguments:',
		'  <path>                  JSON file or directory to validate',
		'',
		'Options:',
		'  --mode <mode>           term | edge | link | blob | strict | lenient',
		'                          Auto-detected from filename when omitted.',
		'  --descriptor <gid>      Descriptor _gid (required for strict/lenient modes).',
		'  --credentials <path>    Path to a credentials file',
		'                          (default: $METADATA_VALIDATOR_CREDENTIALS, else',
		'                           ./globals/auth/db.credentials.current.json under the current directory —',
		'                           a JSON pointer { "use": "db.credentials.<name>.json" } to the active server)',
		'  --cache-size <n>        LRU cache size for term lookups (default: 500)',
		'  --strict                UNKNOWN_PROPERTY is an error (default for named modes)',
		'  --lenient               UNKNOWN_PROPERTY is a warning',
		'  --compute               Fill _key, _gid, _aid from _nid+_lid; warn when absent',
		'  --strict-compute        Absent computed properties are errors, not warnings',
		'  --quiet-compute         Fill in computed properties silently (no warning)',
		'  --no-fill               Report absent computed properties without filling them in',
		'  --persist               Prepare for DB insert: fill silently (implies --compute)',
		'  --resolve-handles       Expand bare GIDs to <col>/<key> in _from, _to, _path',
		'  --quiet                 Suppress per-file progress; show only errors and warnings',
		'  --errors-only           Suppress warnings; show only errors',
		'  --terms-col <n>         Terms collection name (default: terms)',
		'  --edges-col <n>         Edges collection name (default: edges)',
		'  --links-col <n>         Links collection name (default: links)',
		'  --blobs-col <n>         Blobs collection name (default: blobs)',
		'',
		'Examples:',
		'  node index.js ../../data/core/',
		'  node index.js --compute ../../data/core/',
		'  node index.js --compute --resolve-handles ../../data/core/',
		'  node index.js --mode term ../../data/core/terms.scalar.json',
		'  node index.js --mode lenient --descriptor my_dataset ../../data/eufgis/',
	].join('\n'));
}

// Strip the last path segment (.key or [N]) — used to find the parent location
// when the exact path has a synthetic type-key suffix not present in the JSON.
function stripLastSegment(p) {
	return p.replace(/(\.[^.\[]+|\[\d+\])$/, '');
}

// Format a result item for console output.
// When pathMap is provided, appends doc:N  file:N after the path when the path is found.
// Falls back to the parent path when the exact path has a synthetic type-key suffix.
function fmtItem(item, label, pathMap) {
	let lineInfo = '';
	if (pathMap && item.path) {
		const entry = pathMap.get(item.path) || pathMap.get(stripLastSegment(item.path));
		if (entry) lineInfo = '  doc:' + entry.docLine + '  file:' + entry.fileLine;
	}
	return '    ' + label + '  ' + (item.path || '(root)') + lineInfo + '\n' +
	       '      code:     ' + item.code + '\n' +
	       '      value:    ' + JSON.stringify(item.value) + '\n' +
	       '      expected: ' + item.expected + '\n' +
	       '      message:  ' + item.message;
}

function main() {
	const args = parseArgs(process.argv);

	if (!args.target) { usage(); process.exit(1); }

	// --persist implies --compute + --quiet-compute
	if (args.persist) {
		args.compute      = true;
		args.quietCompute = true;
	}

	if (args.noFill && args.persist) {
		console.error('ERROR: --no-fill and --persist are mutually exclusive');
		process.exit(1);
	}

	if ((args.strictCompute || args.quietCompute || args.noFill) && !args.compute) {
		console.warn('WARNING: --strict-compute / --quiet-compute / --no-fill have no effect without --compute or --persist');
	}

	// Load credentials
	const credPath = args.credentials
		? path.resolve(args.credentials)
		: process.env.METADATA_VALIDATOR_CREDENTIALS
			? path.resolve(process.env.METADATA_VALIDATOR_CREDENTIALS)
			: path.resolve(process.cwd(), 'globals/auth/db.credentials.current.json');

	const { path: resolvedCredPath, credentials } = resolveCredentials(credPath);

	// Announce the target server so it is always clear which database was validated.
	console.error('Validating against ' + credentials.host + '/' + credentials.database +
		'  (creds: ' + resolvedCredPath + ')');

	const cols = {};
	if (args.termsCol) cols.terms = args.termsCol;
	if (args.edgesCol) cols.edges = args.edgesCol;
	if (args.linksCol) cols.links = args.linksCol;
	if (args.blobsCol) cols.blobs = args.blobsCol;
	const effectiveTermsCol = args.termsCol || 'terms';

	const dbAccess = makeDbAccess(credentials, args.cacheSize, cols);

	checkAnchorRoles(dbAccess);

	const files    = collectJsonFiles(path.resolve(args.target));

	if (files.length === 0) {
		console.error('No JSON files found at: ' + args.target);
		process.exit(1);
	}

	let totalDocs   = 0;
	let totalPassed = 0;
	let totalWarn   = 0;

	for (const file of files) {
		let docs;
		let raw;
		let docIndex;
		try {
			raw      = fs.readFileSync(file, 'utf8');
			docs     = JSON.parse(raw);
			docIndex = buildDocIndex(raw);
		} catch (e) {
			console.error('PARSE ERROR  ' + file);
			console.error('  ' + e.message);
			process.exit(1);
		}

		if (!Array.isArray(docs)) {
			if (!args.quiet) console.log('SKIP  ' + file + '  (not an array)');
			continue;
		}
		if (docs.length === 0) {
			if (!args.quiet) console.log('SKIP  ' + file + '  (empty array)');
			continue;
		}

		// Resolve mode and descriptor for this file
		let mode       = args.mode || detectMode(file);
		let descriptor = args.descriptor;
		let strict     = args.strict;

		if (!mode) {
			if (!args.quiet) console.log('SKIP  ' + file + '  (unknown type — use --mode)');
			continue;
		}

		if (mode === 'strict' || mode === 'lenient') {
			if (!descriptor) {
				console.error('ERROR  --descriptor required for mode "' + mode + '"');
				process.exit(1);
			}
			if (strict === null) strict = (mode === 'strict');
		} else {
			if (!MODE_DESCRIPTORS[mode]) {
				console.error('ERROR  Unknown mode: ' + mode);
				process.exit(1);
			}
			descriptor = MODE_DESCRIPTORS[mode];
			if (strict === null) strict = true;
		}

		// In quiet mode the file header is printed lazily, only when a problem is found.
		let fileHeaderPrinted = args.quiet;
		function printFileHeader() {
			if (fileHeaderPrinted) return;
			fileHeaderPrinted = true;
			console.log('');
			console.log('FILE  ' + file);
			console.log('      mode=' + mode + '  descriptor=' + descriptor +
			            '  docs=' + docs.length);
		}

		if (!args.quiet) {
			console.log('');
			console.log('FILE  ' + file);
			console.log('      mode=' + mode + '  descriptor=' + descriptor +
			            '  docs=' + docs.length);
		}

		for (let i = 0; i < docs.length; i++) {
			totalDocs++;
			const doc      = docs[i];
			const gid      = (doc._code && doc._code._gid) || (doc._gid) || ('#' + i);
			const docEntry = docIndex[i];
			const lineNum  = docEntry ? ' line ' + docEntry.fileLine : '';
			const docRef   = '[' + i + ']' + lineNum;

			// Apply pre-validation transforms (mutate doc in place).
			// Handles must be resolved before compute so edge _key MD5 uses full handles.
			if (args.resolveHandles) applyHandles(doc, effectiveTermsCol);
			const computeResult = args.compute
				? applyCompute(doc, {
					noFill:        args.noFill,
					quietCompute:  args.quietCompute,
					strictCompute: args.strictCompute,
				})
				: { errors: [], warnings: [] };

			let result;
			try {
				result = validateByDictionary(doc, descriptor, dbAccess, { strict: strict });
			} catch (e) {
				printFileHeader();
				console.error('  ' + docRef + ' EXCEPTION  ' + gid);
				console.error('    ' + e.message);
				process.exit(1);
			}

			// Prepend compute errors/warnings so they appear before schema errors.
			if (computeResult.errors.length > 0)
				result.errors = computeResult.errors.concat(result.errors);
			if (computeResult.warnings.length > 0)
				result.warnings = computeResult.warnings.concat(result.warnings);

			const hasErrors   = result.errors.length > 0;
			const hasWarnings = result.warnings.length > 0;

			// Build path→line map lazily — only when there is something to report
			const needMap = hasErrors || (hasWarnings && !args.errorsOnly);
			let pathMap = null;
			if (needMap && docEntry) {
				pathMap = buildPathLineMap(raw, docEntry.offset, docEntry.fileLine);
			}

			if (hasWarnings && !hasErrors && !args.errorsOnly) {
				totalWarn++;
				printFileHeader();
				console.warn('  ' + docRef + ' WARN  ' + gid);
				for (const w of result.warnings) {
					console.warn(fmtItem(w, 'WARN', pathMap));
				}
			}

			if (hasErrors) {
				printFileHeader();
				console.error('  ' + docRef + ' FAIL  ' + gid);
				for (const e of result.errors) {
					console.error(fmtItem(e, 'ERR ', pathMap));
				}
				if (hasWarnings && !args.errorsOnly) {
					for (const w of result.warnings) {
						console.warn(fmtItem(w, 'WARN', pathMap));
					}
				}
				console.error('');
				console.error('Stopped at first failure.');
				console.error('  Passed: ' + totalPassed +
				              '  Warned: ' + totalWarn +
				              '  Validated: ' + totalDocs);
				process.exit(1);
			}

			totalPassed++;
		}

		if (!args.quiet) console.log('  OK  ' + docs.length + ' documents passed');
	}

	console.log('');
	console.log('All documents passed.');
	console.log('  Passed: ' + totalPassed +
	            '  Warned: ' + totalWarn +
	            '  Total:  ' + totalDocs);
}

main();
