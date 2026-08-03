import assert from 'node:assert/strict';

import { __discoveryInternals } from '../src/wxenv/discovery.js';

const groupsScope = __discoveryInternals.mirrorScopeForReason('groups');

assert.equal(groupsScope.key, 'groups');
assert.deepEqual(
  groupsScope.categories,
  ['contact', 'session'],
  'group-list refreshes need contact.db for membership and session.db for recent-message sorting',
);
assert.equal(
  groupsScope.categories.includes('message'),
  false,
  'a normal group-list refresh must not copy message shards',
);
assert.equal(
  typeof __discoveryInternals.mirrorScopeAllowsDbFile,
  'function',
  'the effective group mirror file filter must be covered by the regression test',
);
assert.equal(
  __discoveryInternals.mirrorScopeAllowsDbFile(groupsScope, { category: 'contact', name: 'contact.db' }),
  true,
);
assert.equal(
  __discoveryInternals.mirrorScopeAllowsDbFile(groupsScope, { category: 'session', name: 'session.db' }),
  true,
  'the effective file filter must admit session.db instead of dropping it after scope selection',
);
assert.equal(
  __discoveryInternals.mirrorScopeAllowsDbFile(groupsScope, { category: 'message', name: 'message_0.db' }),
  false,
);

console.log('group mirror session scope checks passed');
