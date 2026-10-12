// From klona's fix for class instances whose constructor assigns its properties (lukeed/klona#31, 7650274, released
// in 2.0.5), for each mode it touched, plus own properties added after construction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { klona } from '../src/index.js';
import { klona as lite } from '../src/lite.js';
import { klona as full } from '../src/full.js';

for (const [mode, clone] of [['klona', klona], ['klona/lite', lite], ['klona/full', full]]) {
	test(`${mode} :: constructor properties :: Object.assign`, () => {
		class Foobar {
			constructor(data) {
				Object.assign(this, data);
			}
		}
		const input = new Foobar({ test: 123, nested: { list: [1, 2] } });
		const output = clone(input);

		assert.deepEqual(output, input);
		assert.equal(output.constructor, Foobar);
		assert.equal(output.test, 123);
		assert.notEqual(output.nested, input.nested);
		assert.notEqual(output.nested.list, input.nested.list);
		output.nested.list.push(3);
		assert.deepEqual(input.nested.list, [1, 2]);
	});

	test(`${mode} :: own properties set after construction`, () => {
		class Point {
			constructor() { this.x = 0; }
		}
		const input = new Point();
		input.x = 5;
		input.label = { text: 'p' };
		const output = clone(input);

		assert.equal(output.x, 5);
		assert.deepEqual(output.label, { text: 'p' });
		assert.notEqual(output.label, input.label);
		assert.ok(output instanceof Point);
	});

	test(`${mode} :: prototype values are not copied onto the clone`, () => {
		function Test() {}
		Test.prototype.val = 42;
		const output = clone(new Test());
		assert.equal(output.val, 42);
		assert.equal(Object.prototype.hasOwnProperty.call(output, 'val'), false);
	});
}
