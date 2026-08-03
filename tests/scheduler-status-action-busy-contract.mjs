import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

function sliceBetween(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `${startText} source must remain available`);
  return source.slice(start, end);
}

const descriptorsSource = sliceBetween(
  'function schedulerStatusActionDescriptors(',
  '\n  function syncSchedulerStatusActions(',
);
assert.doesNotMatch(descriptorsSource, /if \(!schedulerStatusActions \|\| schedulerBusy\) return \[\];/,
  'scheduler busy state must not erase dynamic action descriptors and make the action row disappear');

const syncSource = sliceBetween(
  'function syncSchedulerStatusActions(',
  '\n  async function revalidateSchedulerStore(',
);
assert.match(syncSource, /button\.disabled = schedulerBusy \|\| action\.disabled === true;/,
  'scheduler action synchronization must disable every visible action while another scheduler action is running');

const busySource = sliceBetween(
  'function setSchedulerActionBusy(',
  '\n  function startSchedulerRunStatus(',
);
assert.match(busySource, /syncSchedulerStatusActions\(latestSchedulerStatus \|\| \{\}\);/,
  'every scheduler busy transition must immediately repaint actions from the latest status');

console.log('scheduler status action busy contract tests passed');
