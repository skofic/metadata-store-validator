'use strict';

/**
 * types/text.js — Validators for _text, _text_HTML, _text_Markdown, _text_SVG.
 *
 * Text types are non-comparable long-form content. All are stored as strings.
 * No companion properties are accepted. The format (HTML/Markdown/SVG) is
 * declared by the type key itself; deep format validation is out of scope.
 */

const { ErrorCode, makeError } = require('../errors');

/**
 * Validate a value against any _text* scalar type.
 *
 * @param {*}        value  - The value to validate.
 * @param {string}   type   - '_text' | '_text_HTML' | '_text_Markdown' | '_text_SVG'
 * @param {Object}   schema - Companion properties (expected to be empty {}).
 * @param {string[]} path   - Current dot-path for error location.
 * @returns {Object[]} Array of error objects (empty = valid).
 */
function validateText(value, type, schema, path) {
	if (typeof value !== 'string') {
		return [makeError(
			ErrorCode.WRONG_TYPE, path, value, `string (${type})`,
			`Expected a string for ${type}, got ${typeof value}`
		)];
	}
	return [];
}

module.exports = { validateText };
