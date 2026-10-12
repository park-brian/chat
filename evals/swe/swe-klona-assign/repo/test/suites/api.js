import { suite } from '../uvu.js';
import * as assert from '../uvu-assert.js';

export default function (klona) {
	const API = suite('exports');

	API('should export a function', () => {
		assert.type(klona, 'function');
	});

	API.run();
}
