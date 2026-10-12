// Removing a handler while its event is being emitted must not skip the handlers after it: the bug mitt fixed in
// 1.1.3 (developit/mitt#65) by emitting over a copy of the handler list, reintroduced here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mitt from '../src/index.js';

const once = (emitter, type, fn) => {
	const wrapped = evt => { emitter.off(type, wrapped); fn(evt); };
	emitter.on(type, wrapped);
};

test('a handler that removes itself does not skip the next one', () => {
	const inst = mitt();
	const calls = [];
	once(inst, 'save', () => calls.push('once'));
	inst.on('save', () => calls.push('second'));
	inst.on('save', () => calls.push('third'));

	inst.emit('save');
	assert.deepEqual(calls, ['once', 'second', 'third']);

	inst.emit('save');
	assert.deepEqual(calls, ['once', 'second', 'third', 'second', 'third']);
});

test('several once handlers in a row all run, once each', () => {
	const inst = mitt();
	const calls = [];
	for (const n of [1, 2, 3]) once(inst, 'ready', () => calls.push(n));
	inst.emit('ready');
	inst.emit('ready');
	assert.deepEqual(calls, [1, 2, 3]);
	assert.deepEqual(inst.all.get('ready'), []);
});

test('a wildcard handler that removes itself does not skip the next one', () => {
	const inst = mitt();
	const calls = [];
	const first = type => { inst.off('*', first); calls.push('first:' + type); };
	inst.on('*', first);
	inst.on('*', type => calls.push('second:' + type));
	inst.emit('a');
	inst.emit('b');
	assert.deepEqual(calls, ['first:a', 'second:a', 'second:b']);
});

test('a handler added during emit runs from the next emit on', () => {
	const inst = mitt();
	const calls = [];
	inst.on('tick', () => {
		calls.push('outer');
		if (calls.length === 1) inst.on('tick', () => calls.push('inner'));
	});
	inst.emit('tick');
	assert.deepEqual(calls, ['outer']);
	inst.emit('tick');
	assert.deepEqual(calls, ['outer', 'outer', 'inner']);
});

test('off("type") during emit still lets that emit finish', () => {
	const inst = mitt();
	const calls = [];
	inst.on('x', () => { calls.push(1); inst.off('x'); });
	inst.on('x', () => calls.push(2));
	inst.emit('x');
	assert.deepEqual(calls, [1, 2]);
	inst.emit('x');
	assert.deepEqual(calls, [1, 2]);
});
