import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fsp.readFile(path.join(ROOT, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

const recoveryStart = source.indexOf('function backgroundInterruptedDigestBatchRecovery');
const recoveryEnd = source.indexOf('function scheduleInterruptedDigestBatchRecoveryFromStorage', recoveryStart);
const recoverySource = source.slice(recoveryStart, recoveryEnd);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, 'interrupted-batch recovery needs an explicit background transition');
assert.match(recoverySource, /_digestBatchRecoveryBackgrounded = true/);
assert.doesNotMatch(recoverySource, /\.abort\(/, 'backgrounding recovery must not abort the lease confirmation request');

const settlementStart = source.indexOf('function backgroundDigestBatchSettlement');
const settlementEnd = source.indexOf('function cancelActiveDigestFromUser', settlementStart);
const settlementSource = source.slice(settlementStart, settlementEnd);
assert.ok(settlementStart >= 0 && settlementEnd > settlementStart, 'batch settlement needs an explicit background transition');
assert.match(settlementSource, /_state_digest\.settlementBackgrounded = true/);
assert.doesNotMatch(settlementSource, /settlementWaitController\?\.abort|abortActiveDigest/, 'backgrounding settlement must retain the existing server-settlement loop');

assert.match(source, /if \(digestBatchSettlementPending\(\)\) return backgroundDigestBatchSettlement\(/);
assert.match(source, /if \(!_state_digest\.generating && _digestBatchRecoveryPending\) \{\s*return backgroundInterruptedDigestBatchRecovery\(/);
assert.match(source, /digestBatchSettlementPending\(\) \? '转后台确认'/);
assert.match(source, /if \(settlementBackgrounded \|\| recoveryBackgrounded\) cancel\.disabled = true/);
assert.match(source, /const disabled = [^;]*settlementPending[^;]*_digestBatchRecoveryPending/);

console.log('digest settlement background lock tests passed');
