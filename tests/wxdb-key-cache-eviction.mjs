import assert from 'node:assert/strict';
import { __wxdbKeyCacheInternals } from '../src/config/wxdb-key-cache.js';

const accounts = {};
for (let index = 0; index < 31; index += 1) {
  accounts[`verified-${String(index).padStart(2, '0')}`] = {
    verified_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  };
}
accounts['identity-recent'] = {
  verified_at: '',
  identity_evidence_updated_at: '2026-08-01T12:00:00.000Z',
};
accounts.keep = {
  verified_at: '2026-08-01T12:01:00.000Z',
};

__wxdbKeyCacheInternals.pruneAccounts(accounts, 'keep');

assert.equal(Object.keys(accounts).length, 32, 'key cache must retain its account cap');
assert.equal(Object.hasOwn(accounts, 'identity-recent'), true, 'recent identity-only evidence must not be evicted as if it had no activity time');
assert.equal(Object.hasOwn(accounts, 'verified-00'), false, 'the actually oldest account must be evicted');

const tied = {
  zebra: { verified_at: '2026-01-01T00:00:00.000Z' },
  alpha: { identity_evidence_updated_at: '2026-01-01T00:00:00.000Z' },
  keep: { verified_at: '2026-08-01T00:00:00.000Z' },
};
__wxdbKeyCacheInternals.pruneAccounts(tied, 'keep', 2);
assert.equal(Object.hasOwn(tied, 'alpha'), false, 'equal activity timestamps must evict by deterministic account id');

console.log('wxdb key cache eviction tests passed');
