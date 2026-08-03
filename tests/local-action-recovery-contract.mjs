import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

const resultStart = source.indexOf('function localActionResultFromEvidence(');
const resultEnd = source.indexOf('\nfunction startStagedLocalActionProgress(', resultStart);
const settledStart = source.indexOf('function localActionEvidenceSettled(');
const settledEnd = source.indexOf('\nasync function recoverLocalActionAfterAbort(', settledStart);
assert.ok(resultStart >= 0 && resultEnd > resultStart, 'local action result recovery implementation must remain available');
assert.ok(settledStart >= 0 && settledEnd > settledStart, 'local action settlement implementation must remain available');

const sandbox = {
  Math,
  Number,
  String,
  _appState: { platform: 'win32' },
};
vm.runInNewContext(
  `${source.slice(resultStart, resultEnd)}\n${source.slice(settledStart, settledEnd)}\n`
    + 'globalThis.__result = localActionResultFromEvidence;\n'
    + 'globalThis.__settled = localActionEvidenceSettled;',
  sandbox,
  { timeout: 1_000 },
);

const systemTextEvidence = {
  kind: 'text_clipboard_copy',
  action_id: 'clipboard_text_action_1',
  purpose: 'file_path',
  method: 'windows_powershell_sta_text',
  local_action_committed: true,
  clipboard_verified: true,
  evidence_verified: true,
  evidence_persisted: true,
  relative_path: 'outputs/digests/example.png',
};
assert.equal(
  sandbox.__settled('text_clipboard_copy', systemTextEvidence),
  true,
  'durably persisted system clipboard evidence must settle without browser phase versions',
);
assert.equal(
  sandbox.__settled('text_clipboard_copy', { ...systemTextEvidence, local_action_committed: false }),
  false,
  'prepared system clipboard evidence must not be reported as committed',
);
assert.equal(
  sandbox.__settled('text_clipboard_copy', { ...systemTextEvidence, evidence_persisted: false }),
  false,
  'unpersisted system clipboard evidence must remain unsettled',
);
assert.equal(
  sandbox.__settled('text_clipboard_copy', {
    ...systemTextEvidence,
    local_action_committed: false,
    action_state: 'outcome_unknown',
  }),
  true,
  'a durable system clipboard unknown outcome must settle without being misreported as committed',
);

assert.equal(
  sandbox.__settled('text_clipboard_copy', {
    kind: 'text_clipboard_copy',
    browser_clipboard_phase: 'prepared',
    state_version: 1,
    persisted_state_version: 1,
    evidence_persisted: true,
  }),
  false,
  'a browser clipboard prepared record is not a final outcome',
);
assert.equal(
  sandbox.__settled('text_clipboard_copy', {
    kind: 'text_clipboard_copy',
    browser_clipboard_phase: 'browser_committed',
    state_version: 2,
    persisted_state_version: 2,
    evidence_persisted: true,
  }),
  true,
  'browser clipboard evidence still requires its durable final phase',
);

const recovered = sandbox.__result(systemTextEvidence);
assert.equal(recovered.purpose, 'file_path', 'text clipboard recovery must preserve its purpose');
assert.equal(recovered.method, 'windows_powershell_sta_text', 'text clipboard recovery must preserve the system method');
assert.equal(recovered.clipboard_verified, true, 'text clipboard recovery must preserve readback verification');
assert.equal(recovered.evidence_verified, true, 'text clipboard recovery must preserve evidence verification');
assert.equal(recovered.relative_path, 'outputs/digests/example.png', 'text clipboard recovery must preserve the safe relative target');

console.log('local action recovery contract tests passed');
