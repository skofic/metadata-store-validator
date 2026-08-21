'use strict';

/**
 * conformance.js — Dictionary-conformance validator.
 *
 * validateConformance() mirrors validateData() but adds a dictionary-lookup
 * pass for _object values: each property key is resolved as a dictionary term
 * via dbAccess.getTerm() and the property value is validated against that
 * term's _data section. Recursion follows _object, _array (when the element
 * type is _object), and _dict (when the value type is _object).
 *
 * Rule edges (_predicate_property-of and _predicate_value-of with non-empty
 * _path_data) are applied in the _object pass. Each triggered rule is a full
 * _data section (e.g. { _object: { _open: { _banned: [...] } } }) fetched from
 * the pre-loaded maps in dbAccess. Rules are applied as independent validateData
 * calls — one per triggered rule — and their errors accumulate. Using validateData
 * (not validateConformance) avoids re-triggering rule lookups on the same value.
 *
 * Amendment semantics for _object rules: before the structural check runs,
 * triggered property-of AND value-of rules with _object shape are collected
 * and their _recommended/_required items are merged into the base schema's
 * _closed whitelist. This allows rules to extend a closed schema's permitted
 * set — e.g. the _predicate_property-of meta-edge adds _target to _edge's
 * whitelist so _target-bearing edges pass the structural check. The rule's
 * _required and _banned constraints are still enforced independently.
 * Rules with non-_object shape replace the base schema (future/replacement mode).
 *
 * Target-scoped rules replace dictionary validation: when a value-of rule has
 * a target entry (e.g. _path_data keyed by schemaHandle._path_data), the
 * targeted property is validated against the rule schema only. The base term
 * descriptor lookup for that property is skipped. This allows meta-edges to
 * provide an extended _keyed schema for _path_data without requiring the base
 * _path_data term to list every possible sibling source up front.
 *
 * validateByDictionary() is the public entry point. It fetches the named
 * descriptor from the database and delegates to validateConformance().
 */

const { ErrorCode, makeError }       = require('./errors');
const { validateData }               = require('./validate');
const { buildKeySchemaMap }          = require('./shapes/keyed-by');

const { shapeKeys } = require('./type-registry');

function getShapeKey(schema, dbAccess) {
	if (!schema || typeof schema !== 'object') return null;
	for (const k of shapeKeys(dbAccess)) {
		if (schema[k] !== undefined) return k;
	}
	return null;
}

/**
 * Build an augmented copy of dataSection where the _closed whitelist is extended
 * with _recommended and _required items from the provided amendment rules.
 * Only modifies _closed object schemas; _open schemas need no extension since
 * they already permit any property. Items already in the whitelist are not
 * duplicated. The actual _required/_banned enforcement remains with the
 * independent rule application — this function only widens the permitted set.
 */
function mergeRulesIntoSchema(dataSection, propRules) {
	const objectSchema = dataSection._object;
	if (!objectSchema || !('_closed' in objectSchema)) return dataSection;

	const baseConstraints = objectSchema._closed;
	if (!baseConstraints || typeof baseConstraints !== 'object') return dataSection;

	// Collect property names from amendment rules (_object shape only).
	const extraAllowed = new Set();
	for (const propRule of propRules) {
		const ruleObjSchema = propRule._object;
		if (!ruleObjSchema) continue; // non-_object rule: replacement mode (not yet implemented)
		const rc = ruleObjSchema._open || ruleObjSchema._closed;
		if (!rc) continue;
		for (const r of (rc._recommended || [])) extraAllowed.add(r);
		for (const sel of (rc._required || [])) {
			for (const item of (sel._selection || [])) {
				if (Array.isArray(item)) { for (const s of item) extraAllowed.add(s); }
				else                     extraAllowed.add(item);
			}
		}
	}

	if (extraAllowed.size === 0) return dataSection;

	// Determine existing whitelist to avoid adding duplicates.
	const existingAllowed = new Set([
		...(baseConstraints._recommended || []),
		...(baseConstraints._computed    || []),
		...(baseConstraints._locked      || []),
		...(baseConstraints._immutable   || []),
		...((baseConstraints._required || []).flatMap(function(s) {
			return [].concat(...(s._selection || []).map(function(x) {
				return Array.isArray(x) ? x : [x];
			}));
		})),
	]);

	const newItems = [];
	for (const item of extraAllowed) {
		if (!existingAllowed.has(item)) newItems.push(item);
	}
	if (newItems.length === 0) return dataSection;

	return {
		_object: {
			_closed: Object.assign({}, baseConstraints, {
				_recommended: (baseConstraints._recommended || []).concat(newItems),
			}),
		},
	};
}

/**
 * Validate a value with dictionary conformance checking.
 *
 * @param {*}        value       - The value to validate.
 * @param {Object}   dataSection - The _data section schema (e.g. { _object: { _closed: {...} } }).
 * @param {string[]} path        - Current dot-path for error location.
 * @param {Object}   dbAccess    - DB accessor (may be null — skips conformance pass).
 * @param {Object}   opts        - Options: { coerce, strict }.
 *                                 strict: true → UNKNOWN_PROPERTY is an error (default).
 *                                 strict: false → UNKNOWN_PROPERTY is a warning.
 * @returns {{ errors: Object[], warnings: Object[], coercions: Object[] }}
 */
function validateConformance(value, dataSection, path, dbAccess, opts) {
	const result = { errors: [], warnings: [], coercions: [] };

	if (!dataSection || typeof dataSection !== 'object') return result;

	// Seed the document root once, at the outermost entry. Child recursions carry
	// rootObject forward in their opts copies (childOpts/targetOpts below), so this
	// fires only at the top call and is never overwritten on descent — unlike
	// parentObject, which tracks the immediate containing object. _scope_object
	// resolution uses rootObject for term-root-relative paths (see validateObjectScope).
	if (opts && opts.rootObject === undefined) {
		opts = Object.assign({}, opts, { rootObject: value });
	}

	const shapeKey = getShapeKey(dataSection, dbAccess);

	// For _object shapes: pre-collect triggered property-of and value-of rules and
	// build an augmented schema that extends any _closed whitelist with rule additions.
	// This ensures the structural check does not reject rule-permitted properties
	// as UNKNOWN_PROPERTY before the rules have a chance to apply.
	// Value-of rules are included so that a value like _predicate_property-of can
	// extend the whitelist with _target before the structural check fires.
	let effectiveSchema          = dataSection;
	const triggeredPropertyRules = []; // { key, propRule } pairs

	if (shapeKey === '_object' &&
	    dbAccess &&
	    typeof value === 'object' && value !== null && !Array.isArray(value))
	{
		const schemaHandle = opts && opts.schemaHandle;
		if (schemaHandle) {
			const rulesForMerge = [];
			if (dbAccess.getPropertyRules) {
				for (const key of Object.keys(value)) {
					const propRule = dbAccess.getPropertyRules(key, schemaHandle);
					if (propRule) {
						triggeredPropertyRules.push({ key, propRule });
						rulesForMerge.push(propRule);
					}
				}
			}
			if (dbAccess.getValueRules) {
				for (const key of Object.keys(value)) {
					const val = value[key];
					if (typeof val !== 'string') continue;
					const valueRule = dbAccess.getValueRules(val, key, schemaHandle);
					if (valueRule) rulesForMerge.push(valueRule);
				}
			}
			if (rulesForMerge.length > 0) {
				effectiveSchema = mergeRulesIntoSchema(dataSection, rulesForMerge);
			}
		}
	}

	// Step 1: structural check via the existing shape validator
	const structural = validateData(value, effectiveSchema, path, dbAccess, opts);
	result.errors.push(...structural.errors);
	result.coercions.push(...structural.coercions);

	// No DB → no conformance pass
	if (!dbAccess || typeof value !== 'object' || value === null) return result;

	// Step 2: _object — look up each property key as a dictionary term
	if (shapeKey === '_object' && !Array.isArray(value)) {
		const schemaHandle = opts && opts.schemaHandle;

		// Apply triggered property-of rules independently.
		// Whitelist extension was handled above; this enforces their _required/_banned.
		for (const { propRule } of triggeredPropertyRules) {
			const sub = validateData(value, propRule, path, dbAccess, opts);
			result.errors.push(...sub.errors);
			result.coercions.push(...sub.coercions);
		}

		// Apply value-of rules and target-scoped rules.
		// Target-scoped rules replace dictionary validation for their targeted property:
		// when a rule provides a complete schema for a sub-property (e.g. an extended
		// _keyed schema for _path_data), the dictionary lookup for that property is
		// skipped so the rule schema governs instead of the base term schema.
		const targetScopedProperties = new Set();
		if (schemaHandle) {
			for (const [key, val] of Object.entries(value)) {
				if (typeof val !== 'string') continue;
				if (dbAccess.getValueRules) {
					const valueRule = dbAccess.getValueRules(val, key, schemaHandle);
					if (valueRule) {
						const sub = validateData(value, valueRule, path, dbAccess, opts);
						result.errors.push(...sub.errors);
						result.coercions.push(...sub.coercions);
					}
				}
				// Target-scoped rules: _path_data entries keyed schemaHandle.<prop>
				// validated against the corresponding sub-property of the current object.
				if (dbAccess.getValueRuleTargets) {
					const targets = dbAccess.getValueRuleTargets(val, key, schemaHandle);
					for (const propName in targets) {
						if (propName in value) {
							targetScopedProperties.add(propName);
							const targetOpts = Object.assign({}, opts, { parentObject: value });
							const sub = validateConformance(value[propName], targets[propName], [...path, propName], dbAccess, targetOpts);
							result.errors.push(...sub.errors);
							result.warnings.push(...sub.warnings);
							result.coercions.push(...sub.coercions);
						}
					}
				}
			}
		}

		for (const key of Object.keys(value)) {
			if (targetScopedProperties.has(key)) continue; // schema replaced by target-scoped rule
			const keyPath   = [...path, key];
			const term      = dbAccess.getTerm(key);
			const childOpts = Object.assign({}, opts, {
				parentObject: value,
				schemaHandle: dbAccess.makeHandle ? dbAccess.makeHandle(key) : undefined,
			});

			if (!term) {
				const err = makeError(
					ErrorCode.UNKNOWN_PROPERTY, keyPath, key,
					'dictionary term',
					`"${key}" is not a known dictionary term`
				);
				if (opts.strict !== false) result.errors.push(err);
				else                       result.warnings.push(err);
				continue;
			}

			if (term._data && Object.keys(term._data).length > 0) {
				const sub = validateConformance(value[key], term._data, keyPath, dbAccess, childOpts);
				result.errors.push(...sub.errors);
				result.warnings.push(...sub.warnings);
				result.coercions.push(...sub.coercions);
			}
		}
		return result;
	}

	// Step 3: _typedef — resolve to the typedef term's _data and recurse
	if (shapeKey === '_typedef') {
		const typedefGid  = dataSection._typedef;
		const typedefTerm = dbAccess.getTerm(typedefGid);
		if (typedefTerm && typedefTerm._data && Object.keys(typedefTerm._data).length > 0) {
			const sub = validateConformance(value, typedefTerm._data, path, dbAccess, opts);
			result.errors.push(...sub.errors);
			result.warnings.push(...sub.warnings);
			result.coercions.push(...sub.coercions);
		}
		return result;
	}

	// Step 4: _array — recurse when the element schema is _object
	if (shapeKey === '_array' && Array.isArray(value)) {
		const arraySchema = dataSection._array;
		if (getShapeKey(arraySchema, dbAccess) === '_object') {
			const elemSchema = { _object: arraySchema._object };
			for (let i = 0; i < value.length; i++) {
				const sub = validateConformance(
					value[i], elemSchema, [...path, '[' + i + ']'], dbAccess, opts
				);
				result.errors.push(...sub.errors);
				result.warnings.push(...sub.warnings);
				result.coercions.push(...sub.coercions);
			}
		}
		return result;
	}

	// Step 5: _dict — recurse into values when the value schema is _object
	if (shapeKey === '_dict' && !Array.isArray(value)) {
		const valSchema = dataSection._dict._dict_value;
		if (valSchema && getShapeKey(valSchema, dbAccess) === '_object') {
			for (const [k, v] of Object.entries(value)) {
				const sub = validateConformance(v, valSchema, [...path, k], dbAccess, opts);
				result.errors.push(...sub.errors);
				result.warnings.push(...sub.warnings);
				result.coercions.push(...sub.coercions);
			}
		}
		return result;
	}

	// Step 6: _objects — recurse into each element using its position's slot schema
	if (shapeKey === '_objects' && Array.isArray(value)) {
		const objectsSchema = dataSection._objects;
		const slotFirst = objectsSchema._objects_first || null;
		const slotList  = objectsSchema._objects_list  || null;
		const slotLast  = objectsSchema._objects_last  || null;
		for (let i = 0; i < value.length; i++) {
			let slot = null;
			if (i === 0 && slotFirst)                       slot = slotFirst;
			else if (i === value.length - 1 && slotLast)    slot = slotLast;
			else if (slotList)                              slot = slotList;
			else                                            continue; // structural pass already flagged NO_SCHEMA_FOR_POSITION
			const elemSchema = { _object: slot };
			const sub = validateConformance(
				value[i], elemSchema, [...path, '[' + i + ']'], dbAccess, opts
			);
			result.errors.push(...sub.errors);
			result.warnings.push(...sub.warnings);
			result.coercions.push(...sub.coercions);
		}
		return result;
	}

	// Step 7: _keyed — recurse into each value using the sibling-resolved schema
	if (shapeKey === '_keyed' && !Array.isArray(value)) {
		const keyedSchema  = dataSection._keyed;
		const parentObject = opts && opts.parentObject;
		if (!parentObject || !keyedSchema) return result;

		const keySchemaMap = buildKeySchemaMap(keyedSchema, parentObject);

		for (const [k, v] of Object.entries(value)) {
			const schema = keySchemaMap.get(k);
			if (!schema) continue; // unknown key — already flagged by structural pass

			if (typeof schema === 'object' && Object.keys(schema).length > 0) {
				const sub = validateConformance(v, schema, [...path, k], dbAccess, opts);
				result.errors.push(...sub.errors);
				result.warnings.push(...sub.warnings);
				result.coercions.push(...sub.coercions);
			}
		}
		return result;
	}

	return result;
}

/**
 * Remove duplicate entries from an error/warning array.
 * Two items are considered duplicates when their code, path, and message are identical.
 * The first occurrence is kept; subsequent ones are dropped.
 */
function deduplicateErrors(items) {
	const seen = new Set();
	return items.filter(function(item) {
		const key = item.code + '\0' + item.path + '\0' + item.message;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Validate a document against the dictionary using a named descriptor.
 *
 * Fetches the descriptor from the database, then runs validateConformance()
 * against its _data section.
 *
 * @param {Object} doc           - Document to validate.
 * @param {string} descriptorGid - _gid of the descriptor term that defines the schema.
 * @param {Object} dbAccess      - DB accessor (required; null skips all checks).
 * @param {Object} opts          - Options: { coerce, strict }.
 * @returns {{ errors: Object[], warnings: Object[], coercions: Object[] }}
 */
function validateByDictionary(doc, descriptorGid, dbAccess, opts) {
	if (!dbAccess) return { errors: [], warnings: [], coercions: [] };

	const options = Object.assign({ strict: true, coerce: false }, opts || {});
	if (dbAccess.makeHandle) {
		options.schemaHandle = dbAccess.makeHandle(descriptorGid);
	}

	const descriptor = dbAccess.getTerm(descriptorGid);
	if (!descriptor) {
		return {
			errors: [makeError(
				ErrorCode.TYPEDEF_NOT_FOUND, [], descriptorGid,
				'existing term _gid',
				`Descriptor "${descriptorGid}" not found in dictionary`
			)],
			warnings:   [],
			coercions:  [],
		};
	}

	if (!descriptor._data || Object.keys(descriptor._data).length === 0) {
		return { errors: [], warnings: [], coercions: [] };
	}

	const raw = validateConformance(doc, descriptor._data, [], dbAccess, options);
	return {
		errors:    deduplicateErrors(raw.errors),
		warnings:  deduplicateErrors(raw.warnings),
		coercions: raw.coercions,
	};
}

module.exports = { validateByDictionary, validateConformance };
