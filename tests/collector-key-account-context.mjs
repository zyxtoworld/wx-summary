import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { __collectorInternals } from '../src/collector/index.js';
import { __wxdbInternals } from '../src/wxdb/index.js';

const fallback = 'a'.repeat(64);
const verifiedWxid = 'wxid_example';
const redactedVerifiedAccount = {
  account_id: 'wx-account-1',
  id: 'wx-account-1',
  identity_id: `wxacct_${crypto.createHash('sha256').update(verifiedWxid).digest('hex').slice(0, 24)}`,
  identity_status: 'verified',
  identity_generation_status: 'verified',
  verified_self_wxid: verifiedWxid,
  wxid: verifiedWxid,
};

assert.equal(
  __collectorInternals.verifiedResultAccountFingerprint(
    { account: redactedVerifiedAccount },
    fallback,
    'wx-account-1',
  ),
  '',
  'a verified but path-redacted worker account must not reuse a pre-verification parent fingerprint',
);

const authoritativeVerifiedAccount = {
  ...redactedVerifiedAccount,
  source_db_storage: 'C:\\wx-summary-fixture\\db_storage',
  source_account_root: 'C:\\wx-summary-fixture',
};
const authoritativeFingerprint = __collectorInternals.verifiedResultAccountFingerprint(
  { account: authoritativeVerifiedAccount },
  fallback,
  'wx-account-1',
);
assert.match(authoritativeFingerprint, /^[a-f0-9]{64}$/, 'a fully identified verified worker account should derive its current fingerprint');
assert.notEqual(authoritativeFingerprint, fallback, 'the current verified identity fingerprint must replace the pre-verification fallback');

const authoritativeMirrorAccount = {
  ...authoritativeVerifiedAccount,
  source: 'project-mirror',
  mirror: {
    relative_root: 'data/wxdb-mirror/wxacc_fixture',
    identity_id: authoritativeVerifiedAccount.identity_id,
    identity_status: 'verified',
    identity_generation_status: 'verified',
    verified_self_wxid: verifiedWxid,
  },
};
const verifiedKeyBinding = __collectorInternals.verifiedKeyAccountBindingFromAccounts(
  redactedVerifiedAccount,
  authoritativeMirrorAccount,
  'wx-account-1',
);
assert.ok(verifiedKeyBinding, 'a redacted worker identity proof should bind through the freshly read project-mirror account');
assert.equal(verifiedKeyBinding.account, authoritativeMirrorAccount, 'the cache binding must retain the authoritative mirror account, not the path-redacted worker object');
assert.equal(verifiedKeyBinding.account_fingerprint, authoritativeFingerprint, 'the persisted fingerprint must come from the authoritative mirror record');
assert.match(verifiedKeyBinding.account_signature, /wx-summary-fixture/i, 'the runtime signature must include the authoritative source binding');

const previousWxid = 'wxid_previous';
const previousIdentityId = `wxacct_${crypto.createHash('sha256').update(previousWxid).digest('hex').slice(0, 24)}`;
assert.equal(
  __collectorInternals.verifiedKeyAccountBindingFromAccounts(
    redactedVerifiedAccount,
    {
      ...authoritativeMirrorAccount,
      identity_id: previousIdentityId,
      verified_self_wxid: previousWxid,
      wxid: previousWxid,
      mirror: {
        ...authoritativeMirrorAccount.mirror,
        identity_id: previousIdentityId,
        verified_self_wxid: previousWxid,
      },
    },
    'wx-account-1',
  ),
  null,
  'a same-path account record with the previous verified identity must not receive the new account key',
);

assert.equal(
  __collectorInternals.verifiedKeyAccountBindingFromAccounts(
    redactedVerifiedAccount,
    {
      ...authoritativeMirrorAccount,
      identity_generation_status: 'pending_validation',
      mirror: {
        ...authoritativeMirrorAccount.mirror,
        identity_generation_status: 'pending_validation',
      },
    },
    'wx-account-1',
  ),
  null,
  'an authoritative mirror generation that is not verified must fail closed',
);

const directGroupResult = [];
Object.defineProperty(directGroupResult, '__verified_account', {
  value: authoritativeVerifiedAccount,
  enumerable: false,
});
assert.equal(
  __collectorInternals.verifiedAccountFromResult(directGroupResult),
  authoritativeVerifiedAccount,
  'a direct group read must retain its non-enumerable verified account metadata',
);
assert.equal(
  __collectorInternals.verifiedResultAccountFingerprint(
    directGroupResult,
    fallback,
    'wx-account-1',
  ),
  authoritativeFingerprint,
  'direct and isolated group reads must authorize the same account-scoped key cache fingerprint',
);

assert.equal(
  __collectorInternals.dbKeyAccountCandidateBindingComplete({
    ...authoritativeVerifiedAccount,
    mirror_relative_root: 'wxdb-mirror/wxacc_fixture',
  }),
  true,
  'a prior verified key may be reconsidered only when account id, source DB, and project-copy root remain bound',
);
assert.equal(
  __collectorInternals.dbKeyAccountCandidateBindingComplete({
    ...authoritativeVerifiedAccount,
    source_db_storage: '',
    mirror_relative_root: 'wxdb-mirror/wxacc_fixture',
  }),
  false,
  'a missing source DB binding must exclude prior verified keys even from candidate revalidation',
);
assert.equal(
  __collectorInternals.dbKeyAccountCandidateBindingComplete(authoritativeVerifiedAccount),
  false,
  'a missing project-copy root must exclude prior verified keys even from candidate revalidation',
);

const unverifiedBoundAccount = {
  ...authoritativeVerifiedAccount,
  identity_id: '',
  identity_status: 'unverified',
  identity_generation_status: 'unverified',
  verified_self_wxid: '',
  mirror_relative_root: 'wxdb-mirror/wxacc_fixture',
};
assert.equal(
  __collectorInternals.dbKeyAccountCandidateRevalidationAllowed(unverifiedBoundAccount),
  true,
  'a lost identity anchor may reuse strongly account/path-bound encrypted keys only as candidates for full identity recovery',
);
assert.equal(
  __collectorInternals.dbKeyAccountCandidateRevalidationAllowed({
    ...unverifiedBoundAccount,
    source_db_storage: '',
  }),
  false,
  'identity recovery must not reuse cached candidates without the original source DB binding',
);
assert.equal(
  __collectorInternals.dbKeyAccountCandidateRevalidationAllowed({
    ...authoritativeVerifiedAccount,
    mirror_relative_root: 'wxdb-mirror/wxacc_fixture',
  }),
  false,
  'a fully verified current generation does not need candidate-only identity recovery',
);

assert.equal(
  __collectorInternals.persistentVerifiedKeyCacheAccountId(
    { account_id: 'wx-account-authoritative' },
    'wx-account-legacy-alias',
  ),
  'wx-account-authoritative',
  'persistent verified-key lookup must use the authoritative account id resolved from a unique alias',
);
assert.equal(
  __collectorInternals.persistentVerifiedKeyCacheAccountId({}, 'wx-account-requested'),
  'wx-account-requested',
  'persistent verified-key lookup may fall back to the requested id only when no authoritative account id exists',
);

const explicitStartMs = Date.UTC(2026, 6, 22, 16, 0, 0);
const explicitEndMs = Date.UTC(2026, 6, 23, 15, 59, 59);
const explicitRange = __collectorInternals.validateMessageTimeRange(
  '2026-07-23 00:00:00',
  '2026-07-23 23:59:59',
  { since_ms: explicitStartMs, until_ms: explicitEndMs },
);
assert.equal(explicitRange.start.getTime(), explicitStartMs, 'explicit browser epoch must define the start instant');
assert.equal(explicitRange.end.getTime(), explicitEndMs, 'explicit browser epoch must define the end instant');

assert.equal(
  __collectorInternals.verifiedResultAccountFingerprint(
    { account: redactedVerifiedAccount },
    fallback,
    'another-account',
  ),
  '',
  'worker identity proof must never authorize a fingerprint from another account',
);

assert.equal(
  __collectorInternals.verifiedResultAccountFingerprint(
    { account: { ...redactedVerifiedAccount, identity_status: 'pending_validation' } },
    fallback,
    'wx-account-1',
  ),
  '',
  'an unverified worker account must not authorize key persistence',
);

const candidateHex = (label, length) => {
  let out = '';
  for (let index = 0; out.length < length; index += 1) {
    out += crypto.createHash('sha256').update(`${label}:${index}`).digest('hex');
  }
  return out.slice(0, length);
};
const compatibilitySalt = candidateHex('compatibility-salt', 32);
const compatibilitySources = {
  manual: [candidateHex('manual-192', 192), candidateHex('manual-160', 160), candidateHex('manual-96', 96)],
  verified: [candidateHex('verified-192', 192), candidateHex('verified-160', 160), candidateHex('verified-96', 96)],
  memory_pointer: [candidateHex('memory-pointer-192', 192)],
  memory: [candidateHex('generic-memory-160', 160)],
  local: Array.from({ length: 20 }, (_, index) => candidateHex(`local-${index}`, 64)),
};
const compatibilityComposition = __collectorInternals.composeDbRawKeyCandidates(compatibilitySources);
const reservedRawPrefix = [
  ...compatibilitySources.manual,
  ...compatibilitySources.verified,
  ...compatibilitySources.memory_pointer,
  ...compatibilitySources.memory,
];
assert.deepEqual(
  compatibilityComposition.rawKeys.slice(0, 8),
  reservedRawPrefix,
  'the raw compatibility prefix must reserve manual 3, verified 3, memory pointer 1, and generic memory 1',
);
const reservedNormalizedPrefix = reservedRawPrefix.map(raw => (
  __wxdbInternals.orderedRawKeyCandidates([raw], compatibilitySalt)[0]
));
const orderedCompatibilityCandidates = __wxdbInternals.orderedRawKeyCandidates(
  compatibilityComposition.rawKeys,
  compatibilitySalt,
);
assert.deepEqual(
  orderedCompatibilityCandidates.slice(0, 8),
  reservedNormalizedPrefix,
  '96/160/192-character candidates must not expand ahead of the other reserved compatibility sources',
);
const validationAttempts = __wxdbInternals.sqlCipherValidationAttempts(orderedCompatibilityCandidates);
for (const profileId of new Set(validationAttempts.map(attempt => attempt.profile.id))) {
  assert.deepEqual(
    validationAttempts.filter(attempt => attempt.profile.id === profileId).slice(0, 8).map(attempt => attempt.raw),
    reservedNormalizedPrefix,
    `SQLCipher profile ${profileId} must retain the complete 3/3/1/1 compatibility prefix`,
  );
}
assert.ok(
  __wxdbInternals.weixinV4KeyCandidates(compatibilityComposition.rawKeys, compatibilitySalt)
    .includes(compatibilitySources.local.at(-1)),
  'compatibility prefix reservation must not truncate later modern WeChat v4 candidates',
);

for (const codeField of ['code', 'public_code']) {
  for (const code of ['wxdb_mirror_manifest_changed', 'wxdb_mirror_readiness_changed']) {
    const error = Object.assign(new Error(code), { [codeField]: code });
    assert.throws(
      () => __wxdbInternals.throwIfMirrorReadGenerationChanged(error),
      thrown => thrown === error,
      `${codeField}=${code} must escape optional database-read fallbacks unchanged`,
    );
  }
}
assert.doesNotThrow(
  () => __wxdbInternals.throwIfMirrorReadGenerationChanged(Object.assign(new Error('optional db missing'), { code: 'ENOENT' })),
  'ordinary optional database errors must remain degradable',
);
const wxdbSource = await readFile(new URL('../src/wxdb/index.js', import.meta.url), 'utf8');
assert.equal(
  [...wxdbSource.matchAll(/throwIfMirrorReadGenerationChanged\(e\);/g)].length,
  3,
  'session.db, sender hydration, and hardlink.db fallbacks must all propagate mirror-generation changes',
);

console.log('collector key account context checks passed');
