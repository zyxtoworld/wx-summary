import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8');

const payloadStart = source.indexOf('function systemClipboardEvidencePayload(');
const payloadEnd = source.indexOf('\nfunction prepareSystemClipboardEvidence(', payloadStart);
assert.ok(payloadStart >= 0 && payloadEnd > payloadStart, 'system clipboard evidence payload builder must remain available');

const sandbox = {
  Math,
  Number,
  String,
  Date,
  process: { platform: 'win32' },
  SYSTEM_TEXT_CLIPBOARD_MAX_BYTES: 256 * 1024,
  normalizeLocalActionId: value => String(value || '').trim(),
  normalizeOutputDirRequestIdentity: value => String(value || '').trim(),
  localActionEvidenceRef: value => `ref:${String(value || '')}`,
  localActionCommitEvidenceStoredPath: value => String(value || '').trim(),
  sanitizeText: value => String(value || ''),
};
vm.runInNewContext(
  `${source.slice(payloadStart, payloadEnd)}\nglobalThis.__payload = systemClipboardEvidencePayload;`,
  sandbox,
  { timeout: 1_000 },
);

const textPayload = sandbox.__payload('text_clipboard_copy', 'clipboard_action_1', {
  purpose: 'text',
  content_bytes: 42,
  text: 'must never be persisted',
}, { commitEvidencePath: 'C:/safe/local-action-commit.json' });
assert.equal(textPayload.action_state, 'prepared');
assert.equal(textPayload.local_action_committed, false);
assert.equal(textPayload.verification_pending, true);
assert.equal(textPayload.content_bytes, 42);
assert.equal(Object.hasOwn(textPayload, 'text'), false, 'prepared clipboard evidence must never persist clipboard text');
assert.equal(textPayload._commit_evidence_path, 'C:/safe/local-action-commit.json');

const pathPayload = sandbox.__payload('text_clipboard_copy', 'clipboard_action_2', {
  purpose: 'file_path',
  relative_path: 'outputs\\digests\\example.png',
  absolute_path: 'C:/private/example.png',
  digest_id: 'digest-1',
  history_item_key: 'history-1',
  file_version: 'version-1',
});
assert.equal(pathPayload.relative_path, 'outputs/digests/example.png');
assert.equal(Object.hasOwn(pathPayload, 'absolute_path'), false, 'prepared path-copy evidence must not persist absolute paths');

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const ordinaryEnd = source.indexOf(`\nfunction ${nextName}(`, start);
  const asyncEnd = source.indexOf(`\nasync function ${nextName}(`, start);
  const end = [ordinaryEnd, asyncEnd].filter(value => value > start).sort((a, b) => a - b)[0] ?? -1;
  assert.ok(start >= 0 && end > start, `${name} source must remain available`);
  return source.slice(start, end);
}

const copyPngSource = functionSource('copyPngToClipboard', 'macDesktopSessionProbeState');
const copyTextSource = functionSource('copyTextToClipboard', 'parseClipboardImageSize');
assert.match(copyPngSource, /commitEvidencePath/);
assert.match(copyPngSource, /commitEvidenceContext/);
assert.match(copyPngSource, /onCommitted/);
assert.match(copyTextSource, /commitEvidencePath/);
assert.match(copyTextSource, /commitEvidenceContext/);
assert.match(copyTextSource, /onCommitted/);

function routeSource(route, nextRoute) {
  const start = source.indexOf(`if (pathname === '${route}'`);
  const end = source.indexOf(`if (pathname === '${nextRoute}'`, start);
  assert.ok(start >= 0 && end > start, `${route} route must remain available`);
  return source.slice(start, end);
}

for (const [route, nextRoute, mutation] of [
  ['/api/copy-text', '/api/copy-path', 'copyTextToClipboard'],
  ['/api/copy-path', '/api/copy-image', 'copyTextToClipboard'],
  ['/api/copy-image', '/api/browser-clipboard-action', 'copyPngToClipboard'],
]) {
  const routeBody = routeSource(route, nextRoute);
  const prepareIndex = routeBody.indexOf('prepareSystemClipboardEvidence(');
  const persistIndex = routeBody.indexOf('persistPreparedSystemClipboardEvidence(');
  const mutationIndex = routeBody.indexOf(`${mutation}(`);
  assert.ok(prepareIndex >= 0 && persistIndex > prepareIndex && mutationIndex > persistIndex, `${route} must durably prepare evidence before the system clipboard mutation`);
}

const patternSource = functionSource('localActionCommitEvidencePatternForKind', 'historyRerenderItemFromActionCommitEvidence');
assert.match(patternSource, /text_clipboard_copy/);
assert.match(patternSource, /clipboard_copy/);
assert.match(patternSource, /clipboard-text/);
assert.match(patternSource, /clipboard/);

console.log('system clipboard evidence contract tests passed');
