import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const route = source.slice(
  source.indexOf("pathname === '/api/export-preview'"),
  source.indexOf("pathname === '/api/output-file'"),
);

assert.match(route, /const usesDigestBatchPreview = !!requestedExportBatchId/);
assert.match(route, /const settings = await loadSettings\(\);/);
assert.match(route, /assertPreviewExportContext\(settings, body\);/);
assert.doesNotMatch(
  route,
  /loadDigestBatchSettings\(requestedExportBatchId\)/,
  'an owner-bound server preview should not require the unrelated in-memory AI/key settings snapshot after restart',
);
assert.match(route, /const batchPreview = !historyDigest && usesDigestBatchPreview/);
assert.match(route, /loadDigestBatchPreviewMarkdown\(requestedExportBatchId/);
assert.match(route, /commitBarrier: async \(\) => \{[\s\S]*?const latest = await loadSettings\(\)[\s\S]*?assertPreviewExportContext\(latest, body\)/);
assert.match(route, /markDigestRuntimeChangedAfterLocalCommit\(settings, latestSettings, item, \{[\s\S]*?exportOnly: true/);
assert.match(route, /digestRuntimeSettingsChanged\(settings, latestSettings, \{ exportOnly: true \}\)/);

console.log('Text preview export policy contract tests passed');
