// From ms's fix for negative decimals below -10 (vercel/ms#111, 2669f23, released in 2.1.2), plus the same case in
// the other units and spellings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ms from '../index.js';

test('negative decimals less than -10', () => {
	assert.equal(ms('-10.5h'), -37800000);
	assert.equal(ms('-10.5 hours'), -37800000);
	assert.equal(ms('-12.25d'), -1058400000);
	assert.equal(ms('-100.5ms'), -100.5);
	assert.equal(ms('-99.5 seconds'), -99500);
});

test('the cases that already worked still do', () => {
	assert.equal(ms('-1.5h'), -5400000);
	assert.equal(ms('-.5h'), -1800000);
	assert.equal(ms('-100ms'), -100);
	assert.equal(ms('10.5h'), 37800000);
	assert.equal(ms('1.5h'), 5400000);
	assert.equal(ms('100'), 100);
	assert.ok(isNaN(ms('☃')));
});
