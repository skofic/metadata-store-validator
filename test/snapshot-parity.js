'use strict';

/**
 * snapshot-parity.js — A snapshot must validate exactly like the live adapter.
 *
 * Builds a snapshot from the database with buildSnapshot() + makeHttpQuery(),
 * then validates the same records through the live Node adapter
 * (makeDbAccess) and through makeSnapshotDbAccess(), and requires identical
 * errors and warnings. Needs a localhost `metadata` database.
 *
 *   node test/snapshot-parity.js --db ../metadata-store/globals/auth/db.credentials.local.json
 */

const fs   = require('fs');
const path = require('path');

const v = require('..');

const args = process.argv.slice(2);
const i    = args.indexOf('--db');
if (i === -1 || !args[i + 1]) {
	console.error('Usage: node test/snapshot-parity.js --db <credentials.json>');
	process.exit(1);
}
const credentials = JSON.parse(fs.readFileSync(path.resolve(args[i + 1]), 'utf8'));

// Representative descriptors: a unit bound (°C), a percent bound, a normal
// range, an enumeration, a negative water potential, a descriptor without
// ranges — and one record key that is not in the dictionary.
const GIDS = ['env_climate_bio01', 'env_climate_hurs_mean', 'env_climate_spi3', 'env_climate_cdi', 'chr_P50', 'geo_resolution-d'];

const RECORDS = [
	{ env_climate_bio01: 12.4, env_climate_hurs_mean: 55, env_climate_spi3: 0.3, env_climate_cdi: 'env_climate_cdi_1' },
	{ env_climate_bio01: -300, env_climate_hurs_mean: 120, env_climate_spi3: 3.2, env_climate_cdi: 'not_a_class' },
	{ chr_P50: -3.5, 'geo_resolution-d': 0.25 },
	{ chr_P50: 'wet', 'geo_resolution-d': -1 },
	{ env_climate_bio01: '12' },
];

function normalise(result) {
	const pick = f => f.code + ' ' + f.path + ' ' + f.message;
	return { errors: result.errors.map(pick).sort(), warnings: result.warnings.map(pick).sort() };
}

(async function main() {
	const query    = v.makeHttpQuery(credentials);
	const snapshot = await v.buildSnapshot({ gids: GIDS, query, source: { host: credentials.host, database: credentials.database } });
	if (snapshot.missing.length > 0) {
		console.error('snapshot-parity: gids missing from the dictionary: ' + snapshot.missing.join(', '));
		process.exit(1);
	}

	const live = v.makeDbAccess(credentials, 500);
	const snap = v.makeSnapshotDbAccess(JSON.parse(JSON.stringify(snapshot)));

	let failed = 0;
	RECORDS.forEach((record, n) => {
		const a = normalise(v.validateProperties(record, live));
		const b = normalise(v.validateProperties(record, snap));
		const same = JSON.stringify(a) === JSON.stringify(b);
		if (!same) {
			failed++;
			console.log('DIFFER  record ' + n + '\n  live:     ' + JSON.stringify(a) + '\n  snapshot: ' + JSON.stringify(b));
		}
	});

	console.log('snapshot-parity: ' + Object.keys(snapshot.terms).length + ' terms, ' +
		snapshot.enumEdges.length + ' enum edges; ' + (RECORDS.length - failed) + '/' + RECORDS.length + ' records identical');
	process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
	console.error('snapshot-parity: ' + (err && err.stack || err));
	process.exit(1);
});
