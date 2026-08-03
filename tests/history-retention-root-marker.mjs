import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const outputSource = await fsp.readFile(new URL('../src/renderer/output.js', import.meta.url), 'utf8');
const stageStart = outputSource.indexOf('async function stageExpiredHistoryFile(');
const stageEnd = outputSource.indexOf('\nasync function rollbackExpiredHistoryFile(', stageStart);

assert.ok(stageStart >= 0 && stageEnd > stageStart, 'history retention staging source must be bounded');
const stageSource = outputSource.slice(stageStart, stageEnd);
const markerIndex = stageSource.indexOf('await ensureHistoryRootMarker(base)');
const manifestIndex = stageSource.indexOf('await writeRetentionTransactionManifest(base');
const renameIndex = stageSource.indexOf('await fsp.rename(file, stagedPath)');

assert.ok(markerIndex >= 0, 'every retention transaction must establish an owned history root first');
assert.ok(
  markerIndex < manifestIndex && markerIndex < renameIndex,
  'the history root marker must be durable before a transaction manifest or artifact rename can survive a crash',
);

console.log('history retention root marker contract passed');
