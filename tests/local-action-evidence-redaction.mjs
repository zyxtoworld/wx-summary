import assert from 'node:assert/strict';
import fs from 'node:fs';
import { __mainInternals } from '../src/main.js';

const mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const loggerSource = fs.readFileSync(new URL('../src/lib/logger.js', import.meta.url), 'utf8');

assert.ok(
  loggerSource.includes("import { renameAtomicWithRetry } from './json-store.js';")
    && loggerSource.includes('await renameAtomicWithRetry(temporarySafe.resolved, current.resolved)'),
  'existing-log sanitization must retry transient Windows rename locks before appending new log lines',
);

const recordClipboardEvidenceSource = mainSource.slice(
  mainSource.indexOf('function recordClipboardCopyEvidence'),
  mainSource.indexOf('function recordTextClipboardCopyEvidence'),
);
assert.ok(
  recordClipboardEvidenceSource.includes("local_action_after_commit_error: sanitizeLocalActionUserError(copied?.local_action_after_commit_error || evidence.local_action_after_commit_error || '')"),
  'clipboard evidence must sanitize after-commit process details before persistence',
);

const copyImageApiSource = mainSource.slice(
  mainSource.indexOf("if (pathname === '/api/copy-image'"),
  mainSource.indexOf("if (pathname === '/api/browser-clipboard-action'"),
);
assert.ok(
  copyImageApiSource.includes("local_action_after_commit_error: evidence.local_action_after_commit_error || ''")
    && !copyImageApiSource.includes("local_action_after_commit_error: copied?.local_action_after_commit_error || ''"),
  'copy-image responses must expose only the sanitized evidence error, never raw process output',
);

const localActionRecoveryApiSource = mainSource.slice(
  mainSource.indexOf("if (pathname === '/api/local-action-evidence'"),
  mainSource.indexOf("if (pathname === '/api/scheduler/run-once'"),
);
assert.ok(
  localActionRecoveryApiSource.includes('publicLocalActionEvidence(evidence)')
    && !localActionRecoveryApiSource.includes('evidence ? { ...evidence'),
  'local-action recovery responses must use the public evidence projection and never spread internal absolute paths',
);
assert.ok(
  localActionRecoveryApiSource.includes('publicLocalActionEvidencePersistenceStatus()')
    && !localActionRecoveryApiSource.includes('persistence: localActionEvidencePersistenceStatus()'),
  'local-action recovery responses must expose stable public persistence state instead of raw I/O errors',
);

const freshEvidenceSlotsSource = mainSource.slice(
  mainSource.indexOf('function freshLocalActionEvidenceSlots()'),
  mainSource.indexOf('function localActionEvidenceSnapshotItems()'),
);
assert.ok(
  freshEvidenceSlotsSource.includes('persistence: publicLocalActionEvidencePersistenceStatus()'),
  'the state API must use the same redacted persistence projection as the recovery API',
);

const uncDiagnostic = String.raw`目录 \\nas01\Users\Alice\xwechat_files 不可读`;
const redactedUncDiagnostic = __mainInternals.redactSensitiveFreeText(uncDiagnostic);
assert.equal(redactedUncDiagnostic.includes('nas01'), false, 'diagnostic text must redact UNC server names');
assert.equal(redactedUncDiagnostic.includes('Alice'), false, 'diagnostic text must redact UNC user paths');
assert.match(redactedUncDiagnostic, /\[redacted-path\]/, 'diagnostic text should retain a stable UNC path placeholder');

for (const windowsPath of [
  String.raw`\\?\C:\Users\Alice\messages.db`,
  String.raw`\\?\UNC\nas01\share\Alice\messages.db`,
  String.raw`//nas01/share/Alice/messages.db`,
]) {
  const redacted = __mainInternals.redactSensitiveFreeText(`目录 ${windowsPath} 不可读`);
  assert.equal(redacted.includes('Alice'), false, `diagnostic text must redact Windows namespace/network path: ${windowsPath}`);
  assert.match(redacted, /\[redacted-path\]/);
}

for (const diagnostic of [
  String.raw`path:\\?\C:\Users\Alice\messages.db`,
  String.raw`路径：\\?\UNC\nas01\share\Alice\messages.db`,
  String.raw`路径：//nas01/share/Alice/messages.db`,
]) {
  const redacted = __mainInternals.redactSensitiveFreeText(diagnostic);
  assert.equal(redacted.includes('Alice'), false, `punctuation-adjacent Windows path must be redacted: ${diagnostic}`);
  assert.match(redacted, /\[redacted-path\]/);
}
assert.equal(
  __mainInternals.redactSensitiveFreeText('endpoint=https://example.com/api/models'),
  'endpoint=[redacted-url]',
  'forward-slash UNC redaction must not consume URL schemes',
);

console.log('local action evidence redaction tests passed');
