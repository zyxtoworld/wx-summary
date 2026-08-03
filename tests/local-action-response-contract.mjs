import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const mainSource = await fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8');

function sliceBetween(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `${startText} source must remain available`);
  return source.slice(start, end);
}

const apiSource = sliceBetween('async function api(', '\nfunction syncAppStateDependentControls(');
const responseValidationIndex = apiSource.indexOf('validateKnownApiResponse(path, method, data);');
const actionValidationIndex = apiSource.indexOf('if (localActionId && !localActionResponseMatchesId(data, localActionId))');
const completeIndex = apiSource.indexOf('completePendingLocalActionAfterResponse(localActionId, data);');
assert.ok(responseValidationIndex >= 0 && actionValidationIndex > responseValidationIndex && completeIndex > actionValidationIndex,
  'a local-action response id must be checked after response-shape validation and before pending recovery state is cleared');
assert.match(apiSource, /throw localActionResponseMismatchError\('本地操作'\);/,
  'a mismatched successful response must be surfaced as an unknown mutation outcome');

const persistenceSource = sliceBetween('function localActionEvidencePersistSuffix(', '\nfunction localActionWindowStatusOwnsAfterCommitMessage(');
assert.match(persistenceSource, /result\?\.browserEvidence/,
  'nested browser clipboard evidence must be inspected for persistence failures');
assert.match(persistenceSource, /candidate\.evidence_persisted === false/,
  'a nested unpersisted evidence record must downgrade the visible result');

const exportSource = sliceBetween('async function exportTextPreviewMarkdown(', '\nasync function downloadTextPreviewMarkdown(');
assert.match(exportSource, /localActionAfterCommitStatus\([\s\S]*?result, '导出 MD'\)/,
  'MD export must not report success when its recovery evidence was not persisted');
assert.match(exportSource, /showTextPreviewExportNotice\([\s\S]*?result,/,
  'an export notice shown after navigation must retain the evidence persistence warning');

const copyTextSource = sliceBetween('async function copyTextPreviewMarkdown(', '\nasync function revealTextPreviewMarkdown(');
assert.match(copyTextSource, /clipboardWrite\?\.browserEvidence \|\| clipboardWrite, '复制文本'/,
  'text clipboard readback success must still be downgraded when browser evidence persistence failed');

const copyPathSource = sliceBetween('async function copyVerifiedFilePath(', '\nfunction restoreDigestOutputs(');
const deferredPathInitStart = copyPathSource.indexOf('if (deferredBrowserTextClipboardSupported())');
const pathValidationStart = copyPathSource.indexOf("validated = await api('/api/copy-path'", deferredPathInitStart);
assert.ok(deferredPathInitStart >= 0 && pathValidationStart > deferredPathInitStart,
  'path clipboard copy must retain its deferred browser-write initialization before server validation');
const deferredPathInitSource = copyPathSource.slice(deferredPathInitStart, pathValidationStart);
assert.match(deferredPathInitSource, /catch \(error\) \{[\s\S]*?if \(browserClipboardWriteBlocksFallback\(error\)\) throw error;/,
  'path clipboard initialization must not swallow a pending or outcome-unknown browser write and fall through to a system clipboard overwrite');
assert.match(copyPathSource, /clipboard\?\.browserEvidence \|\| clipboard\?\.evidence \|\| result/,
  'path clipboard status must use browser evidence when the browser performed the write');
assert.match(copyPathSource, /localActionAfterCommitStatus\(baseStatus, actionEvidence, '复制路径'\)/,
  'path clipboard UI must surface unresolved local-action evidence instead of unconditional success');

const directMarkdownModalSource = sliceBetween('function showHistoryMarkdownModal(', '\nfunction showHistoryModal(');
const directMarkdownRevealSync = directMarkdownModalSource.slice(
  directMarkdownModalSource.indexOf('const syncMarkdownRevealAction ='),
  directMarkdownModalSource.indexOf('const markMarkdownMissing ='),
);
assert.match(directMarkdownRevealSync, /const revealHardUnavailable = localRevealHardUnavailable\(\);/,
  'the standalone Markdown modal must distinguish a permanently unavailable desktop reveal capability from a retryable probe');
assert.match(directMarkdownRevealSync, /setButtonKeepDisabled\(revealMdButton, revealHardUnavailable\);/,
  'the standalone Markdown modal must disable reveal when the desktop capability is permanently unavailable');
assert.match(directMarkdownRevealSync, /revealMdButton\.setAttribute\('aria-disabled', revealHardUnavailable \? 'true' : 'false'\);/,
  'the standalone Markdown modal must expose its permanently disabled reveal state to assistive technology');

const historyModalSource = source.slice(source.indexOf('function showHistoryModal('));
const historyMarkdownButtonsSource = historyModalSource.slice(
  historyModalSource.indexOf('const syncHistoryMarkdownButtons ='),
  historyModalSource.indexOf('modal._syncAfterBusyButtons ='),
);
assert.match(historyMarkdownButtonsSource, /const revealDisabled = !targetUsable \|\| historyMarkdownExportInFlight \|\| localRevealHardUnavailable\(\);/,
  'the PNG history modal Markdown reveal action must share the same permanently-unavailable capability gate');
assert.match(historyMarkdownButtonsSource, /revealMdButton\.setAttribute\('aria-disabled', revealDisabled \? 'true' : 'false'\);/,
  'the PNG history modal must expose the Markdown reveal disabled state to assistive technology');

const digestPreviewSavedStateSource = sliceBetween('function updatePreviewSavedRenderState(', '\nasync function copyDigestSavedPngPath(');
assert.match(digestPreviewSavedStateSource, /const revealDisabled = [^;]*localRevealHardUnavailable\(\);/,
  'the saved digest PNG reveal action must include permanently unavailable desktop capability in its disabled state');
assert.match(digestPreviewSavedStateSource, /setButtonKeepDisabled\(revealButton, revealDisabled\);/,
  'the saved digest PNG reveal action must preserve its capability gate across busy-button restoration');
assert.match(digestPreviewSavedStateSource, /revealButton\.setAttribute\('aria-disabled', revealDisabled \? 'true' : 'false'\);/,
  'the saved digest PNG reveal action must expose its capability gate to assistive technology');

const digestBatchRevealGateSource = sliceBetween('function digestBatchResultRevealCanRun(', '\nfunction digestBatchResultCopyPathCanRun(');
assert.match(digestBatchRevealGateSource, /digestBatchResultFileTargetUsable\(result\) && !localRevealHardUnavailable\(\)/,
  'batch result reveal actions must not remain clickable when desktop reveal is permanently unavailable');

const openOutputCapabilitySource = sliceBetween('function localOpenOutputHardUnavailable(', '\nfunction localRevealUnavailableMessage(');
assert.match(openOutputCapabilitySource, /localActionCapability\('open_output'\)/,
  'open-output must classify the open_output capability itself instead of borrowing reveal state');
assert.match(openOutputCapabilitySource, /capability\?\.supported === false && !localCapabilityRetryable\(capability\)/,
  'open-output must distinguish permanently unavailable desktop sessions from retryable probes');

const settingsOpenOutputGateSource = sliceBetween('function syncOpenOutdirCapabilityHint(', '\n  function applySettingsRuntimeState(');
assert.match(settingsOpenOutputGateSource, /const hardUnavailable = localOpenOutputHardUnavailable\(\);/,
  'settings must read the permanent open-output capability state before painting the button');
assert.match(settingsOpenOutputGateSource, /setButtonKeepDisabled\(openOutdirButton, [^;]*hardUnavailable\);/,
  'settings must keep the open-output button disabled when no desktop opener can become available');
assert.match(settingsOpenOutputGateSource, /openOutdirButton\.setAttribute\('aria-disabled', openOutdirButton\.disabled \? 'true' : 'false'\);/,
  'settings must expose the permanent open-output gate to assistive technology');

const markdownDownloadNoticeSource = sliceBetween('function showMarkdownDownloadNotice(', '\nfunction shouldClearMarkdownRevealTarget(');
const historyExportNoticeSource = sliceBetween('function showHistoryExportNotice(', '\nfunction showTextPreviewExportNotice(');
const textPreviewExportNoticeSource = sliceBetween('function showTextPreviewExportNotice(', '\nfunction settingsRecoveredFieldPaths(');
for (const [label, noticeSource] of [
  ['downloaded Markdown', markdownDownloadNoticeSource],
  ['history export', historyExportNoticeSource],
  ['text preview export', textPreviewExportNoticeSource],
]) {
  assert.match(noticeSource, /syncFloatingRevealCapabilityButton\([^;]+\);/,
    `${label} floating notices must synchronize reveal capability before accepting clicks and after actions settle`);
}
assert.match(textPreviewExportNoticeSource, /syncFloatingOpenOutputCapabilityButton\([^;]+\);/,
  'the text-preview export notice must synchronize open-output capability before accepting clicks and after the action settles');

const schedulerRevealActionSource = source.slice(
  source.indexOf('async function revealSchedulerArtifact('),
  source.indexOf('async function clearUnverifiedLegacySchedulerCursors('),
);
assert.match(schedulerRevealActionSource, /button\.disabled = localRevealHardUnavailable\(\);/,
  'scheduler artifact reveal must remain disabled after an unsupported capability refresh instead of being unconditionally unlocked');

const copyPathRouteStart = mainSource.indexOf("pathname === '/api/copy-path'");
const copyPathRouteEnd = mainSource.indexOf("pathname === '/api/copy-image'", copyPathRouteStart);
assert.ok(copyPathRouteStart >= 0 && copyPathRouteEnd > copyPathRouteStart,
  'copy-path backend route must remain available');
const copyPathRoute = mainSource.slice(copyPathRouteStart, copyPathRouteEnd);
const unavailableClipboardStart = copyPathRoute.indexOf('if (clipboardCapability?.supported !== true) {');
const unavailableClipboardEnd = copyPathRoute.indexOf("localActionLease = beginLocalAction(body, '复制文件路径')", unavailableClipboardStart);
assert.ok(unavailableClipboardStart >= 0 && unavailableClipboardEnd > unavailableClipboardStart,
  'copy-path backend must retain an explicit system-clipboard-unavailable branch');
const unavailableClipboardResponse = copyPathRoute.slice(unavailableClipboardStart, unavailableClipboardEnd);
assert.match(copyPathRoute, /const requestedLocalActionId = requireLocalActionId\(body, '复制文件路径'\)/,
  'copy-path must validate the requested action id before returning a non-committing capability response');
assert.match(unavailableClipboardResponse, /local_action_id: requestedLocalActionId/,
  'a non-committing system-clipboard response must echo the validated action id so the frontend can continue browser fallback');
assert.match(unavailableClipboardResponse, /local_action_committed: false/,
  'a system-clipboard capability miss must explicitly report that no local action committed');
assert.match(unavailableClipboardResponse, /clipboard_attempted: false/,
  'a system-clipboard capability miss must explicitly report that clipboard mutation was not attempted');

console.log('local action response contract tests passed');
