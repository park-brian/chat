// From mri's fix for default value types not reaching aliases (lukeed/mri#10, 5437ea5, released in 1.1.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fn from '../lib/index.js';

test('flag default string w/ alias', () => {
	assert.deepEqual(fn(['--arg', '01'], { alias: { a: ['arg'] }, default: { arg: '' } }), { _: [], arg: '01', a: '01' });
	assert.deepEqual(fn(['-a', '01'], { alias: { a: ['arg'] }, default: { arg: '' } }), { _: [], arg: '01', a: '01' });
	assert.deepEqual(fn(['-a', '01'], { alias: { arg: ['a'] }, default: { a: '' } }), { _: [], arg: '01', a: '01' });
	assert.deepEqual(fn(['--arg', '01'], { alias: { arg: ['a'] }, default: { a: '' } }), { _: [], arg: '01', a: '01' });
	assert.deepEqual(fn(['-a', '01'], { alias: { arg: ['a'] }, default: { arg: '' } }), { _: [], arg: '01', a: '01' });
});

test('flag default boolean w/ alias', () => {
	assert.deepEqual(fn(['-v', 'file.txt'], { alias: { v: ['verbose'] }, default: { verbose: false } }), { _: ['file.txt'], v: true, verbose: true });
	assert.deepEqual(fn(['--verbose', 'file.txt'], { alias: { v: ['verbose'] }, default: { verbose: false } }), { _: ['file.txt'], v: true, verbose: true });
});

test('defaults without a flag still apply to the alias', () => {
	assert.deepEqual(fn([], { alias: { a: ['arg'] }, default: { arg: 'x' } }), { _: [], arg: 'x', a: 'x' });
	assert.deepEqual(fn(['--port', '8080'], { alias: { p: 'port' }, default: { port: 3000 } }), { _: [], port: 8080, p: 8080 });
});
