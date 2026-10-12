import { suite } from './uvu.js';
import * as assert from './uvu-assert.js';
import { dset } from '../src/index.js';

import arrays from './suites/arrays.js';
import assigns from './suites/assigns.js';
import pollution from './suites/pollution.js';
import preserve from './suites/preserve.js';
import objects from './suites/objects.js';
import basics from './suites/basics.js';

// ---

const API = suite('API');

API('should export a function', () => {
	assert.type(dset, 'function');
});

API.run();

// ---

basics(dset);
assigns(dset);
preserve(dset);
pollution(dset);
objects(dset);
arrays(dset);
