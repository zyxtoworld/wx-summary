import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fsp.readFile(path.join(ROOT, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

assert.match(source, /function textPreviewExportPending\(\) \{\s*return !!_state_digest\?\.textExportInFlight;\s*\}/,
  'MD export needs one shared pending-state predicate');

const renderStart = source.indexOf('async function renderDigest()');
const renderEnd = source.indexOf('\nasync function ', renderStart + 1);
const renderSource = source.slice(renderStart, renderEnd > renderStart ? renderEnd : undefined);
assert.match(renderSource, /setActiveDirtyProvider\(digestDirtyProvider\)/,
  'digest route must register a leave guard for an active MD export');
assert.match(renderSource, /blocking: true/);
assert.match(renderSource, /MD 正在写入本机文件/);
assert.match(renderSource, /clearActiveDirtyProvider\(digestDirtyProvider\)/,
  'digest leave guard must be scoped to the digest route');

const inputLockStart = source.indexOf('function digestInputsLockState()');
const inputLockEnd = source.indexOf('\n}', inputLockStart) + 2;
assert.match(source.slice(inputLockStart, inputLockEnd), /textPreviewExportPending\(\)/,
  'input changes must be locked while the submitted MD snapshot is being saved');

const buttonSyncStart = source.indexOf('function syncDigestGenerateButtons()');
const buttonSyncEnd = source.indexOf('\n}', buttonSyncStart) + 2;
const buttonSyncSource = source.slice(buttonSyncStart, buttonSyncEnd);
assert.match(buttonSyncSource, /textPreviewExportPending\(\)/,
  'new generation buttons must remain disabled until MD export settles');
assert.match(buttonSyncSource, /正在导出 MD/);

const generationStart = source.indexOf('async function generateDigest');
const generationGuard = source.indexOf('if (textPreviewExportPending())', generationStart);
const pendingChipCommit = source.indexOf('commitPendingChipInputs()', generationStart);
assert.ok(generationGuard > generationStart && generationGuard < pendingChipCommit,
  'programmatic generation must reject before mutating pending inputs during MD export');

const beforeUnloadStart = source.indexOf("window.addEventListener('beforeunload', e => {");
const beforeUnloadEnd = source.indexOf('\n});', beforeUnloadStart) + 4;
assert.match(source.slice(beforeUnloadStart, beforeUnloadEnd), /textPreviewExportPending\(\)/,
  'browser refresh/close must warn while MD export may still commit');

const exportStart = source.indexOf('async function exportTextPreviewMarkdown');
const exportEnd = source.indexOf('\nasync function downloadTextPreviewMarkdown', exportStart);
const exportSource = source.slice(exportStart, exportEnd);
assert.match(exportSource, /_state_digest\.textExportInFlight = true;\s*updateDigestSelectionLock\(\)/,
  'starting export must immediately apply global input/generation locks');
assert.match(exportSource, /_state_digest\.textExportInFlight = false;[\s\S]*?updateDigestSelectionLock\(\)/,
  'settling export must release global input/generation locks');

console.log('text preview export global lock tests passed');
