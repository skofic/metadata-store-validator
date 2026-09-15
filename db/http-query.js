'use strict';

/**
 * http-query.js — A dependency-free AQL query function for buildSnapshot().
 *
 * Uses the global `fetch` (Node 18+) against ArangoDB's /_api/cursor endpoint
 * and follows the cursor until every row is read. Consumers that already use
 * arangojs can pass `(q, b) => db.query(q, b).then(c => c.all())` instead.
 *
 *   const query = makeHttpQuery({ host, database, username, password });
 *   const rows  = await query('FOR t IN terms LIMIT 1 RETURN t', {});
 */

/**
 * @param {Object} credentials - { host, database, username, password }.
 * @returns {Function} async (aql, bindVars) → rows[].
 */
function makeHttpQuery(credentials) {
	if (typeof fetch !== 'function') {
		throw new Error('makeHttpQuery: global fetch is not available (Node 18+ required)');
	}
	const c = credentials || {};
	if (!c.host || !c.database) throw new TypeError('makeHttpQuery: credentials need host and database');

	const cursorUrl = c.host.replace(/\/+$/, '') + '/_db/' + encodeURIComponent(c.database) + '/_api/cursor';
	const headers   = { 'Content-Type': 'application/json' };
	if (c.username !== undefined) {
		headers.Authorization = 'Basic ' + Buffer.from(c.username + ':' + (c.password || '')).toString('base64');
	}

	async function call(url, method, body) {
		const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
		let payload;
		try {
			payload = await res.json();
		} catch (e) {
			throw new Error('AQL request failed: HTTP ' + res.status + ' (non-JSON response)');
		}
		if (payload.error) throw new Error('AQL ' + payload.errorNum + ': ' + payload.errorMessage);
		return payload;
	}

	return async function query(aql, bindVars) {
		let cursor = await call(cursorUrl, 'POST', { query: aql, bindVars: bindVars || {}, batchSize: 1000 });
		const rows = cursor.result.slice();
		while (cursor.hasMore) {
			cursor = await call(cursorUrl + '/' + cursor.id, 'PUT');
			for (const row of cursor.result) rows.push(row);
		}
		return rows;
	};
}

module.exports = { makeHttpQuery };
