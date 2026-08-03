import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const definition = source.match(/const HISTORY_FOCUS_ACTION_ATTRIBUTES = Object\.freeze\(\[([\s\S]*?)\]\);/);
assert.ok(definition, 'history focus actions must have one shared definition');

for (const attribute of [
  'data-history-open',
  'data-history-open-image',
  'data-history-export-md',
  'data-history-delete',
  'data-history-open-md-source',
  'data-history-regenerate-preview',
]) {
  assert.ok(definition[1].includes(`'${attribute}'`), `${attribute} must survive history rerenders and route restoration`);
}

assert.ok((source.match(/normalizeHistoryFocusAction\(/g) || []).length >= 3, 'persisted history focus validation must use the shared action definition');
assert.ok((source.match(/historyFocusActionAttribute\(/g) || []).length >= 3, 'history list and card rerenders must use the shared action definition');
assert.equal(source.includes("['data-history-open', 'data-history-open-image', 'data-history-export-md', 'data-history-delete']"), false, 'partial duplicate focus-action lists must not remain');

console.log('app history focus-action tests passed');
