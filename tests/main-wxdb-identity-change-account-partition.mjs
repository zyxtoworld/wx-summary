import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const fixtureRoot = `outputs/.tmp/main-wxdb-identity-change-account-partition-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = fixtureRoot;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${fixtureRoot}/runtime-tmp/wxdb`;

const [discovery, mainModule] = await Promise.all([
  import('../src/wxenv/discovery.js'),
  import('../src/main.js'),
]);

const accountA = 'wxacc_aaaaaaaaaaaaaaaa';
const accountB = 'wxacc_bbbbbbbbbbbbbbbb';
const fingerprintA = 'a'.repeat(64);
const fingerprintB = 'b'.repeat(64);
try {
  const internals = mainModule.__mainInternals;
  const ticketA = internals.registerDigestSaveTicket({
    digest: { digest_id: 'digest-a', group_id: 'group-a', content: 'account A result' },
    accountId: accountA,
    accountFingerprint: fingerprintA,
    groupId: 'group-a',
  });
  const ticketB = internals.registerDigestSaveTicket({
    digest: { digest_id: 'digest-b', group_id: 'group-b', content: 'account B result' },
    accountId: accountB,
    accountFingerprint: fingerprintB,
    groupId: 'group-b',
  });
  assert.ok(ticketB?.id && ticketB?.token, 'the real save-ticket producer must record account B ownership');

  await internals.handleWxDbMirrorIdentityChanged({
    storage_id: accountA,
    previous_identity_id: `wxacct_${'1'.repeat(24)}`,
    identity_id: `wxacct_${'2'.repeat(24)}`,
    identity_switched: true,
  });

  assert.throws(
    () => internals.claimDigestSaveTicketForRequest({
      generation_id: ticketA.id,
      generation_token: ticketA.token,
      digest_id: 'digest-a',
    }),
    error => error?.public_code === 'digest_generation_proof_expired',
    'an identity change for account A must revoke account A save state',
  );

  const ticketAfterAccountAChange = internals.claimDigestSaveTicketForRequest({
    generation_id: ticketB.id,
    generation_token: ticketB.token,
    digest_id: 'digest-b',
  });
  assert.equal(
    ticketAfterAccountAChange.account_id,
    accountB,
    'an identity change for account A must not clear account B save state',
  );
} finally {
  await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
}

console.log('main wxdb identity-change account partition tests passed');
