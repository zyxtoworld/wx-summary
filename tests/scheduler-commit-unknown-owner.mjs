import assert from 'node:assert/strict';

process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_NO_RUNTIME_FILE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = `outputs/.tmp/scheduler-commit-unknown-owner-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR}/runtime-tmp/wxdb`;

const { __schedulerInternals } = await import('../src/daemon/scheduler.js');
const mayHaveCommitted = __schedulerInternals.schedulerSaveFailureMayHaveCommittedOutput;

assert.equal(mayHaveCommitted({ code: 'EIO', index_may_have_committed: true }), true,
  'scheduler must retain pending cursor recovery when the history index may already be committed');
assert.equal(mayHaveCommitted({ code: 'EIO', atomic_write_may_have_committed: true }), true,
  'scheduler must retain pending cursor recovery for any output atomic write with unknown outcome');
assert.equal(mayHaveCommitted({ code: 'EIO' }), false,
  'a pre-commit write failure without an uncertainty marker may still be cleared normally');

console.log('scheduler commit-unknown owner tests passed');
