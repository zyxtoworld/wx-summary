import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const fixtureRelative = `outputs/.tmp/digest-terminal-monotonicity-${process.pid}-${Date.now()}`;
const fixturePath = path.resolve(fixtureRelative);

process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = fixtureRelative;

await fs.mkdir(fixturePath, { recursive: true });

try {
  const { __mainInternals } = await import('../src/main.js');
  const batchId = `terminal-monotonic-${process.pid}-${Date.now()}`;
  const ownerHash = 'a'.repeat(64);
  const accountId = 'wxacc-terminal-monotonic';
  const accountFingerprint = 'b'.repeat(64);
  const groupId = 'terminal-monotonic@chatroom';
  const digestId = `terminal-monotonic-digest-${process.pid}`;

  try {
    const first = await __mainInternals.registerDigestTerminalResult({
      batchId,
      batchIndex: 0,
      batchTotal: 1,
      ownerHash,
      accountId,
      accountFingerprint,
      groupId,
      groupName: '终态单调性测试群',
      digest: {
        digest_id: digestId,
        account_id: accountId,
        group_id: groupId,
        group: '终态单调性测试群',
      },
    });
    assert.equal(first.registered, true, 'the first terminal result should be registered');

    const lateFailure = await __mainInternals.registerDigestTerminalResult({
      batchId,
      batchIndex: 0,
      batchTotal: 1,
      ownerHash,
      accountId,
      accountFingerprint,
      groupId,
      groupName: '终态单调性测试群',
      status: 'error',
      error: {
        message: '连接关闭后晚到的取消信号',
        code: 'cancelled',
        status: 499,
      },
    });
    assert.equal(lateFailure.registered, false, 'a duplicate terminal callback should not register a second terminal state');
    assert.equal(lateFailure.preserved, true, 'a duplicate terminal callback should report that the first terminal state won');
    assert.equal(lateFailure.status, 'done', 'the duplicate registration result should expose the preserved status');

    const recovered = __mainInternals.digestTerminalResultForRequest({
      batchId,
      batchIndex: 0,
      ownerHash,
      accountId,
      accountFingerprint,
      groupId,
    });
    assert.equal(recovered.status, 'done', 'a late failure must not overwrite an already completed digest');
    assert.equal(recovered.digest?.digest_id, digestId, 'the first completed digest must remain recoverable');
    assert.equal(recovered.error, null, 'the preserved successful terminal result must not inherit the late error');

    await assert.rejects(
      () => __mainInternals.registerDigestTerminalResult({
        batchId,
        batchIndex: 0,
        batchTotal: 1,
        ownerHash: 'c'.repeat(64),
        accountId,
        accountFingerprint,
        groupId,
        status: 'error',
        error: { message: 'wrong owner' },
      }),
      error => error?.public_code === 'digest_batch_token_invalid',
      'first-terminal-wins must not bypass the original batch owner binding',
    );
  } finally {
    __mainInternals.releaseDigestTerminalResults(batchId);
  }

  console.log('Digest terminal monotonicity tests passed');
} finally {
  await fs.rm(fixturePath, { recursive: true, force: true });
}
