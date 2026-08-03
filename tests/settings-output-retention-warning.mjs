import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf("saveRenderButton.addEventListener('click'");
const end = source.indexOf('\n  syncOpenOutdirCapabilityHint();', start);
assert.ok(start >= 0 && end > start, 'render/output save handler must remain available');
const handler = source.slice(start, end);
assert.match(
  handler,
  /outputDirChangedFromSaved\(outDir\)[\s\S]*?nextRetentionDays\s*>\s*0[\s\S]*?新目录[\s\S]*?早于[^\n]+历史/,
  'switching output directories under an existing retention policy must warn about cleanup of old files already in the new directory',
);

console.log('settings output retention warning test passed');
