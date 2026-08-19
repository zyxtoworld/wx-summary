import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const outputSource = await fsp.readFile(new URL('../src/renderer/output.js', import.meta.url), 'utf8');

const deleteStart = outputSource.indexOf('export async function deleteHistoryItem(');
const deleteEnd = outputSource.indexOf('\nexport async function findHistoryItem(', deleteStart);
assert.ok(deleteStart >= 0 && deleteEnd > deleteStart, 'history delete implementation must remain available');
const deleteSource = outputSource.slice(deleteStart, deleteEnd);
assert.match(
  deleteSource,
  /history_delete_commit_unknown[\s\S]*?mutation_outcome_unknown:\s*observed\s*!==\s*false/,
  'an indeterminate history index commit must be marked as an unknown mutation outcome',
);

console.log('history delete outcome tests passed');
