import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = `outputs/.tmp/digest-sse-disconnect-grace-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR}/runtime-tmp/wxdb`;

const { __mainInternals } = await import('../src/main.js');
const source = (await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const runSseSource = source.slice(source.indexOf('async function runDigestSSE'), source.indexOf('function handle(req, res)'));

assert.equal(__mainInternals.digestSseRecoveryDeadlineAt(1_000, 0), 46_000);
assert.equal(__mainInternals.digestSseRecoveryDeadlineAt(1_000, 50_000), 95_000, 'a recovery heartbeat observed later must renew the deadline');
assert.equal(__mainInternals.digestSseRecoveryDeadlineAt(80_000, 50_000), 125_000, 'a later disconnect timestamp must remain the deadline base');
assert.equal(__mainInternals.digestSseRecoveryDeadlineAt(1_000, 50_000, 750), 50_750);
assert.equal(__mainInternals.digestSseRecoveryDeadlineAt(0, 0, 750), 750);

assert.equal(runSseSource.includes('digestSseRecoveryDeadlineAt(sseDisconnectedAt, observedRecoveryAt)'), true);
assert.equal(runSseSource.includes('digestSseRecoveryDeadlineAt(sseDisconnectedAt)'), true);
assert.equal(runSseSource.includes('Math.max(sseDisconnectedAt, observedRecoveryAt) + DIGEST_SSE_DISCONNECT_GRACE_MS'), false);

console.log('digest SSE disconnect grace contract passed');
