import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function rememberHistoryMarkdownExportIntent');
const end = source.indexOf('\nfunction historyMarkdownExportVersionedItem', start);
assert.ok(start >= 0 && end > start, 'history Markdown intent implementation must remain available');

const sandbox = {
  Map,
  Math,
  Number,
  String,
  HISTORY_MARKDOWN_EXPORT_INTENT_LIMIT: 80,
  HISTORY_MARKDOWN_EXPORT_INTENTS: new Map(),
  _historyMarkdownExportIntentSeq: 0,
  _historyMarkdownExportVersion: 1,
  historyMarkdownExportCacheKey: item => String(item?.key || ''),
};
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.__begin = beginHistoryMarkdownExportIntent;\nglobalThis.__current = historyMarkdownExportIntentIsCurrent;`, sandbox, { timeout: 1_000 });

const intents = [];
for (let index = 0; index < 85; index += 1) {
  intents.push(sandbox.__begin({ key: `history-${String(index).padStart(3, '0')}` }));
}
assert.equal(sandbox.HISTORY_MARKDOWN_EXPORT_INTENTS.size, 80, 'history Markdown intent tracking must have a hard entry cap');
assert.equal(sandbox.HISTORY_MARKDOWN_EXPORT_INTENTS.has('history-000'), false, 'oldest history Markdown intents should be evicted first');
assert.equal(sandbox.HISTORY_MARKDOWN_EXPORT_INTENTS.has('history-084'), true, 'newest history Markdown intent should remain tracked');
assert.equal(sandbox.__current(intents[0], { key: 'history-000' }), false, 'an evicted old intent must fail closed instead of overwriting a newer export cache');
assert.equal(sandbox.__current(intents.at(-1), { key: 'history-084' }), true, 'the newest tracked intent should remain current');

const replacement = sandbox.__begin({ key: 'history-084' });
assert.equal(sandbox.HISTORY_MARKDOWN_EXPORT_INTENTS.size, 80, 'replacing one intent should not increase the bounded map');
assert.equal(sandbox.__current(intents.at(-1), { key: 'history-084' }), false, 'a newer same-item export must supersede the earlier request');
assert.equal(sandbox.__current(replacement, { key: 'history-084' }), true, 'the replacement intent should be authoritative');

console.log('history Markdown export intent tests passed');
