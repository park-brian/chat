import { suite } from '../uvu.js';
import * as assert from 'node:assert';

export default function (klona) {
	const Strings = suite('String');

	Strings('string', () => {
		let input = 'hello';
		let output = klona(input);

		assert.equal(input, output);

		output += ' world';
		assert.equal(input, 'hello');

		input += '123';
		assert.equal(output, 'hello world');
	});

	Strings.run();
}
