import * as suites from './suites/index.js';
import { klona } from '../src/lite.js';

suites.API(klona);

suites.Strings(klona);
suites.Booleans(klona);
suites.Numbers(klona);
suites.Nully(klona);

suites.Dates(klona);
suites.RegExps(klona);

suites.Objects(klona);
suites.Arrays(klona);

suites.Functions(klona);
suites.Pollutions(klona);
suites.Classes(klona);
