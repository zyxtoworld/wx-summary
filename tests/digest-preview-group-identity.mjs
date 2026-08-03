import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [source, template] = await Promise.all([
  fsp.readFile(path.join(ROOT, 'src', 'web', 'public', 'js', 'app.js'), 'utf8'),
  fsp.readFile(path.join(ROOT, 'src', 'web', 'views', 'index.html'), 'utf8'),
]);

assert.match(template, /<h3 class="card-title">长图预览<\/h3>/);
assert.match(template, /id="preview-identity"[^>]*aria-live="polite"/,
  'the visible canvas needs a persistent group identity next to its heading');

const identityStart = source.indexOf('function syncDigestPreviewIdentity');
const identityEnd = source.indexOf('\n}', identityStart) + 2;
assert.ok(identityStart >= 0 && identityEnd > identityStart, 'preview identity needs a shared synchronizer');
const identitySource = source.slice(identityStart, identityEnd);
assert.match(identitySource, /digestCurrentPreviewGroup\(\)/);
assert.match(identitySource, /digestPreviewProcessingGroup\(stage\)/);
assert.match(identitySource, /当前显示：\$\{previewGroup\}/);
assert.match(identitySource, /正在处理：\$\{processingGroup\}/);
assert.match(identitySource, /canvas\?\.setAttribute\('aria-label'/,
  'the canvas accessible name must identify the group being shown');

const statusHelperStart = source.indexOf('function digestPreviewProgressStatusText');
const statusHelperEnd = source.indexOf('\n}', statusHelperStart) + 2;
const statusHelperSource = source.slice(statusHelperStart, statusHelperEnd);
assert.ok(statusHelperStart >= 0 && statusHelperEnd > statusHelperStart);
assert.match(statusHelperSource, /当前画面仍显示：\$\{previewGroup\}/,
  'progress for group B must explicitly say when the canvas still belongs to group A');

const outputProgressStart = source.indexOf('function updateDigestOutputProgressStatus');
const outputProgressEnd = source.indexOf('\n  function batchProgressDetailFromStage', outputProgressStart);
const outputProgressSource = source.slice(outputProgressStart, outputProgressEnd);
assert.match(outputProgressSource, /syncDigestPreviewIdentity\(stage\)/);
assert.match(outputProgressSource, /digestPreviewProgressStatusText\(stage, text\)/);

assert.match(source, /function updateDigestPreviewActionLock\(\) \{\s*syncDigestPreviewIdentity\(\)/,
  'restores and non-progress preview changes must also refresh the identity');

console.log('digest preview group identity tests passed');
