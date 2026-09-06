// Container/public-network routing seam. Fetches the actual isolated local
// Authority descriptor, never an AWS/public endpoint. All other URLs refused.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.ECHO_JOURNEY_ROOT;
assert.equal(readFileSync(join(root, 'fixture-owner'), 'utf8'), 'staging-journey-v1\n');
const config = JSON.parse(readFileSync(join(root, 'fixture-runtime.json'), 'utf8')).config;
const localFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  assert.ok(['http://127.0.0.1:39479/v1/authority-descriptor', 'https://authority-staging.echobrain.org/v1/authority-descriptor'].includes(String(url)));
  return localFetch(`http://127.0.0.1:${config.port}/v1/authority-descriptor`, options);
};
