'use strict';

/**
 * Simple LRU cache backed by a Map (insertion-ordered).
 *
 * On get: move the entry to the end (most recently used).
 * On set: insert at the end; evict the oldest (first) entry when over capacity.
 */
class LRUCache {
	constructor(maxSize) {
		this.maxSize = maxSize || 500;
		this.cache   = new Map();
	}

	has(key) {
		return this.cache.has(key);
	}

	get(key) {
		if (!this.cache.has(key)) return undefined;
		const value = this.cache.get(key);
		this.cache.delete(key);
		this.cache.set(key, value);
		return value;
	}

	set(key, value) {
		if (this.cache.has(key)) this.cache.delete(key);
		this.cache.set(key, value);
		if (this.cache.size > this.maxSize) {
			this.cache.delete(this.cache.keys().next().value);
		}
	}

	get size() {
		return this.cache.size;
	}
}

module.exports = LRUCache;
