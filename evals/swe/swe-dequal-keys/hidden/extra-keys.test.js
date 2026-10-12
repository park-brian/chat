// dequal 2.0.3's own checks for objects whose second argument has more keys than the first (from its test suite),
// for both modes, plus nested and class-instance cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dequal } from '../src/index.js';
import { dequal as lite } from '../src/lite.js';

for (const [mode, eq] of [['dequal', dequal], ['dequal/lite', lite]]) {
	test(`${mode} :: an extra key on the right is a difference`, () => {
		assert.equal(eq({ a: 1, b: 2 }, { a: 1, b: 2, c: [] }), false);
		assert.equal(eq({}, { a: undefined }), false);
		assert.equal(eq({}, { a: 1 }), false);
		assert.equal(eq({ a: 1 }, { a: 1, b: 2 }), false);
	});

	test(`${mode} :: it is symmetric`, () => {
		const pairs = [[{ a: 1 }, { a: 1, b: 2 }], [{ x: { y: 1 } }, { x: { y: 1, z: 2 } }], [[{ a: 1 }], [{ a: 1, b: 0 }]]];
		for (const [x, y] of pairs) assert.equal(eq(x, y), eq(y, x));
	});

	test(`${mode} :: nested extra keys`, () => {
		assert.equal(eq({ x: { y: 1 } }, { x: { y: 1, z: 2 } }), false);
		assert.equal(eq([{ a: 1 }], [{ a: 1, b: 0 }]), false);
	});

	test(`${mode} :: equal objects are still equal`, () => {
		assert.equal(eq({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
		assert.equal(eq({ a: [{ b: 1 }] }, { a: [{ b: 1 }] }), true);
		assert.equal(eq({}, {}), true);
		assert.equal(eq({ a: undefined }, { b: undefined }), false);
	});
}

test('dequal :: class instances with an extra own key', () => {
	class Point { constructor(x) { this.x = x; } }
	const p = new Point(1), q = new Point(1);
	q.y = 2;
	assert.equal(dequal(p, q), false);
	assert.equal(dequal(p, new Point(1)), true);
});
