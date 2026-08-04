import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

function sliceBetween(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `missing source range: ${start}`);
  return source.slice(startIndex, endIndex);
}

const setupSyncSource = sliceBetween(
  '  function syncSetupNavigationButtons()',
  '\n  const onGlobalSetupPendingWorkChanged',
);
assert.match(setupSyncSource, /setButtonKeepDisabled\(\$back, busy \|\| setupNextBusy \|\| staleRevision \|\| step <= 1\)/,
  'setup back state must survive generic busy-button cleanup');
assert.match(setupSyncSource, /setButtonKeepDisabled\(\$next, busy \|\| setupNextBusy \|\| staleRevision\)/,
  'setup next state must survive background settings reconciliation');
assert.match(setupSyncSource, /setButtonKeepDisabled\(clearButton, busy \|\| staleRevision \|\| accountBlocked\)/,
  'manual-key clear state must survive its generic busy-button cleanup');
assert.match(setupSyncSource, /setButtonKeepDisabled\(clearLegacyButton, busy \|\| staleRevision\)/,
  'legacy manual-key clear state must survive its generic busy-button cleanup');

const setupPaintSource = sliceBetween(
  '  function paint() {',
  '\n  function focusSetupStepContent()',
);
assert.match(source, /let setupGroupListBusy = false;/,
  'setup group loading must have explicit state instead of relying on a one-off disabled assignment');
assert.match(setupPaintSource, /setupGroupListBusy = true;[\s\S]*?syncSetupNavigationButtons\(\);/,
  'starting setup group loading must flow through the authoritative navigation sync');
assert.match(setupPaintSource, /setupGroupListBusy = false;[\s\S]*?syncSetupNavigationButtons\(\);/,
  'settling setup group loading must recompute navigation against any background write lock');
assert.doesNotMatch(setupPaintSource, /\$next\.disabled = (?:true|false)/,
  'async setup painting must not overwrite the navigation lock with a direct assignment');

const setupNextSource = sliceBetween(
  "  $next.addEventListener('click', async () => {",
  '\n  });\n}',
);
assert.match(setupNextSource, /setupNextBusy = true;[\s\S]*?syncSetupNavigationButtons\(\);/,
  'starting a setup navigation action must lock every setup navigation control');
assert.match(setupNextSource, /setupNextBusy = false;[\s\S]*?syncSetupNavigationButtons\(\);/,
  'finishing setup navigation must recompute controls from the authoritative busy state');
assert.doesNotMatch(setupNextSource, /\$next\.disabled = false/,
  'setup error branches must not visibly enable next while background reconciliation still owns the write lock');

const noticeSource = sliceBetween(
  'function showSettingsSaveNotice(',
  '\nlet localActionNoticeSeq',
);
assert.equal((noticeSource.match(/notice\.innerHTML\s*=/g) || []).length, 1,
  'the reusable settings notice must build its controls only once');
assert.match(noticeSource, /notice\._settingsSaveTarget = \{ section, focusSelector \}/,
  'the stable open button must read the latest settings target without being replaced');
assert.match(noticeSource, /titleElement\.textContent = String\(title \|\| ''\)/,
  'settings notice updates must mutate stable text nodes');
assert.match(noticeSource, /messageElement\.textContent = cleanMessage/,
  'settings notice retries must update the stable message node');

const revalidateSource = sliceBetween(
  '  async function revalidateSchedulerStore(',
  '\n  async function revealSchedulerArtifact(',
);
assert.match(revalidateSource, /e\?\.mutation_outcome_unknown === true/,
  'scheduler store revalidation must classify an unconfirmed mutation outcome explicitly');
assert.match(revalidateSource, /文件和自动调度状态可能已经变化/,
  'an unconfirmed revalidation must not claim the store is still invalid or the scheduler is stopped');
assert.match(revalidateSource, /showSettingsSaveNotice\(/,
  'an unconfirmed revalidation must remain visible if the user already left settings');

console.log('frontend settings recovery UX contract tests passed');
