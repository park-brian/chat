// From dset's fix for CVE-2022-25645 (lukeed/dset#34 and #38, released in 3.1.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dset, merge } from '../src/merge.js';

test('should ignore JSON.parse crafted object with "__proto__" key', () => {
	let a = { b: { c: 1 } };
	assert.equal(a.polluted, undefined);
	assert.equal({}.polluted, undefined);
	dset(a, 'b', JSON.parse('{"__proto__":{"polluted":"Yes!"}}'));
	assert.equal(a.polluted, undefined);
	assert.equal({}.polluted, undefined);
	assert.equal(Object.prototype.polluted, undefined);
});

test('should ignore a nested "__proto__" key in the value', () => {
	let a = { b: { c: { d: 1 } } };
	dset(a, 'b', JSON.parse('{"c":{"__proto__":{"nested":"Yes!"}}}'));
	assert.equal({}.nested, undefined);
	assert.equal(a.b.c.d, 1);
});

test('should ignore "constructor.prototype" in the value', () => {
	let a = { b: {} };
	dset(a, 'b', JSON.parse('{"constructor":{"prototype":{"viaCtor":"Yes!"}}}'));
	assert.equal({}.viaCtor, undefined);
	assert.equal(Object.prototype.viaCtor, undefined);
});

test('merge() itself ignores "__proto__" keys', () => {
	let out = merge({ x: 1 }, JSON.parse('{"__proto__":{"viaMerge":"Yes!"},"y":2}'));
	assert.equal({}.viaMerge, undefined);
	assert.equal(out.x, 1);
});
