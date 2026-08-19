import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const sideEffectGuardStart = mainSource.indexOf('function sideEffectGetRequiresFreshFrontendAsset(');
const sideEffectGuardEnd = mainSource.indexOf('\n}', sideEffectGuardStart);
const sideEffectGuardSource = mainSource.slice(sideEffectGuardStart, sideEffectGuardEnd + 2);

assert.ok(
  mainSource.includes("pathname.startsWith('/api/history-item-status/')")
    && sideEffectGuardSource.includes("pathname.startsWith('/api/history-item-status/')")
    && mainSource.includes('findHistoryItemWithStatus(settings, lookup.digest_id, lookup')
    && mainSource.includes('{ ok: true, item: publicOutputItem(item) }'),
  'the server must expose a lightweight exact history-artifact status endpoint',
);

console.log('history external revalidation contract passed');
