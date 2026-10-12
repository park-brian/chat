// mitt's test/index_test.ts at 3.0.1, on node:test: chai's expect became node:assert, sinon's spy a small one below.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mitt from '../src/index.js';

function spy() {
	const fn = (...args) => { fn.calls.push(args); };
	fn.calls = [];
	return fn;
}

describe('mitt', () => {
	it('should default export be a function', () => {
		assert.equal(typeof mitt, 'function');
	});

	it('should accept an optional event handler map', () => {
		assert.doesNotThrow(() => mitt(new Map()));
		const map = new Map();
		const a = spy();
		const b = spy();
		map.set('foo', [a, b]);
		const events = mitt(map);
		events.emit('foo');
		assert.equal(a.calls.length, 1);
		assert.equal(b.calls.length, 1);
	});
});

describe('mitt#', () => {
	const eventType = Symbol('eventType');
	let events, inst;

	beforeEach(() => {
		events = new Map();
		inst = mitt(events);
	});

	describe('properties', () => {
		it('should expose the event handler map', () => {
			assert.ok(inst.all instanceof Map);
		});
	});

	describe('on()', () => {
		it('should be a function', () => {
			assert.equal(typeof inst.on, 'function');
		});

		it('should register handler for new type', () => {
			const foo = () => {};
			inst.on('foo', foo);

			assert.deepEqual(events.get('foo'), [foo]);
		});

		it('should register handlers for any type strings', () => {
			const foo = () => {};
			inst.on('constructor', foo);

			assert.deepEqual(events.get('constructor'), [foo]);
		});

		it('should append handler for existing type', () => {
			const foo = () => {};
			const bar = () => {};
			inst.on('foo', foo);
			inst.on('foo', bar);

			assert.deepEqual(events.get('foo'), [foo, bar]);
		});

		it('should NOT normalize case', () => {
			const foo = () => {};
			inst.on('FOO', foo);
			inst.on('Bar', foo);
			inst.on('baz:baT!', foo);

			assert.deepEqual(events.get('FOO'), [foo]);
			assert.equal(events.has('foo'), false);
			assert.deepEqual(events.get('Bar'), [foo]);
			assert.equal(events.has('bar'), false);
			assert.deepEqual(events.get('baz:baT!'), [foo]);
		});

		it('can take symbols for event types', () => {
			const foo = () => {};
			inst.on(eventType, foo);
			assert.deepEqual(events.get(eventType), [foo]);
		});

		// Adding the same listener multiple times should register it multiple times.
		// See https://nodejs.org/api/events.html#events_emitter_on_eventname_listener
		it('should add duplicate listeners', () => {
			const foo = () => {};
			inst.on('foo', foo);
			inst.on('foo', foo);
			assert.deepEqual(events.get('foo'), [foo, foo]);
		});
	});

	describe('off()', () => {
		it('should be a function', () => {
			assert.equal(typeof inst.off, 'function');
		});

		it('should remove handler for type', () => {
			const foo = () => {};
			inst.on('foo', foo);
			inst.off('foo', foo);

			assert.equal(events.get('foo').length, 0);
		});

		it('should NOT normalize case', () => {
			const foo = () => {};
			inst.on('FOO', foo);
			inst.on('Bar', foo);
			inst.on('baz:bat!', foo);

			inst.off('FOO', foo);
			inst.off('Bar', foo);
			inst.off('baz:baT!', foo);

			assert.equal(events.get('FOO').length, 0);
			assert.equal(events.has('foo'), false);
			assert.equal(events.get('Bar').length, 0);
			assert.equal(events.has('bar'), false);
			assert.equal(events.get('baz:bat!').length, 1);
		});

		it('should remove only the first matching listener', () => {
			const foo = () => {};
			inst.on('foo', foo);
			inst.on('foo', foo);
			inst.off('foo', foo);
			assert.deepEqual(events.get('foo'), [foo]);
			inst.off('foo', foo);
			assert.deepEqual(events.get('foo'), []);
		});

		it('off("type") should remove all handlers of the given type', () => {
			inst.on('foo', () => {});
			inst.on('foo', () => {});
			inst.on('bar', () => {});
			inst.off('foo');
			assert.deepEqual(events.get('foo'), []);
			assert.equal(events.get('bar').length, 1);
			inst.off('bar');
			assert.deepEqual(events.get('bar'), []);
		});
	});

	describe('emit()', () => {
		it('should be a function', () => {
			assert.equal(typeof inst.emit, 'function');
		});

		it('should invoke handler for type', () => {
			const event = { a: 'b' };
			let called = 0;

			inst.on('foo', (one, two) => {
				called++;
				assert.deepEqual(one, event);
				assert.equal(two, undefined);
			});

			inst.emit('foo', event);
			assert.equal(called, 1);
		});

		it('should NOT ignore case', () => {
			const onFoo = spy(),
				onFOO = spy();
			events.set('Foo', [onFoo]);
			events.set('FOO', [onFOO]);

			inst.emit('Foo', 'Foo arg');
			inst.emit('FOO', 'FOO arg');

			assert.deepEqual(onFoo.calls, [['Foo arg']]);
			assert.deepEqual(onFOO.calls, [['FOO arg']]);
		});

		it('should invoke * handlers', () => {
			const star = spy(),
				ea = { a: 'a' },
				eb = { b: 'b' };

			events.set('*', [star]);

			inst.emit('foo', ea);
			assert.deepEqual(star.calls, [['foo', ea]]);
			star.calls.length = 0;

			inst.emit('bar', eb);
			assert.deepEqual(star.calls, [['bar', eb]]);
		});
	});
});
