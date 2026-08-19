import assert from 'node:assert/strict';

import { __wxdbInternals } from '../src/wxdb/index.js';

const salt = 'a'.repeat(32);
const page = Buffer.alloc(4096);
Buffer.from(salt, 'hex').copy(page, 0);

assert.deepEqual(
  __wxdbInternals.weixinV4ScanPageCoverage(
    [{ page, name: 'message_0.db' }],
    [],
    new Set([salt]),
  ),
  {
    requested_salt_count: 1,
    matched_salt_count: 1,
    matched_salts: [salt],
  },
  'page coverage must accept the Set used by the process scan accumulator',
);

console.log('wxdb scan page coverage tests passed');
