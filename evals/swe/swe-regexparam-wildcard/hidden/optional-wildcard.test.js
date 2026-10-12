// From regexparam's fix for optional wildcards (lukeed/regexparam#25, 422f630, released in 3.0.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, inject } from '../src/index.js';

function exec(route, url, loose) {
	let i = 0, out = {}, result = parse(route, !!loose);
	let matches = result.pattern.exec(url);
	if (matches === null) return false;
	while (i < result.keys.length) out[result.keys[i]] = matches[++i] || null;
	return out;
}

test('optional wildcard matches the bare prefix', () => {
	assert.deepEqual(exec('/books/*?', '/books'), { wild: null });
	assert.deepEqual(exec('/books/*?', '/books', true), { wild: null });
	assert.deepEqual(exec('/users/*?', '/users'), { wild: null });
	assert.equal(parse('/users/*?').pattern.test('/users'), true);
});

test('optional wildcard still captures the rest', () => {
	assert.deepEqual(exec('/books/*?', '/books/'), { wild: null });
	assert.deepEqual(exec('/books/*?', '/books/world'), { wild: 'world' });
	assert.deepEqual(exec('/books/*?', '/books/world/howdy/'), { wild: 'world/howdy/' });
	assert.deepEqual(exec('/books/*?', '/books/world/howdy', true), { wild: 'world/howdy' });
	assert.deepEqual(exec('/foo/:bar/*?', '/foo/123'), { bar: '123', wild: null });
	assert.deepEqual(exec('/foo/:bar/*?', '/foo/123/aa/bb'), { bar: '123', wild: 'aa/bb' });
});

test('optional wildcard does not match a longer word', () => {
	assert.equal(exec('/books/*?', '/bookshelf'), false);
	assert.equal(exec('/books/*?', '/bookshelf', true), false);
	assert.equal(exec('/books/*?', '/'), false);
});

test('a required wildcard is unchanged', () => {
	assert.equal(exec('/books/*', '/books'), false);
	assert.deepEqual(exec('/books/*', '/books/world'), { wild: 'world' });
	assert.equal(parse('/users/*').pattern.test('/users'), false);
	assert.deepEqual(parse('/books/*').keys, ['wild']);
	assert.deepEqual(parse('/books/*?').keys, ['wild']);
});

test('inject with an optional wildcard', () => {
	assert.equal(inject('/foo/:bar/*?', { bar: '123' }), '/foo/123');
	assert.equal(inject('/foo/:bar/*?', { bar: '123', wild: 'aa/bb/cc' }), '/foo/123/aa/bb/cc');
});
