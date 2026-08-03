import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

const targetUsableSource = appSource.slice(
  appSource.indexOf('function markdownOutputTargetUsable'),
  appSource.indexOf('function markdownOutputUnusableReasonText'),
);
const blockingReasonSource = appSource.slice(
  appSource.indexOf('function markdownHistoryLookupAfterCommitReasonBlocks'),
  appSource.indexOf('function outputMarkdownShouldUseHistoryLookup'),
);
const historyLookupSource = appSource.slice(
  appSource.indexOf('function outputMarkdownShouldUseHistoryLookup'),
  appSource.indexOf('function outputItemHistoryBound'),
);
const noticeSource = appSource.slice(
  appSource.indexOf('function showTextPreviewExportNotice'),
  appSource.indexOf('function settingsRecoveredFieldPaths'),
);

assert.ok(!historyLookupSource.includes('outputItemHistoryBound(item)'), 'every Markdown item with a digest id must stay on the history-identity API contract even when indexing failed');
assert.ok(blockingReasonSource.includes("'history_failed_after_commit'"), 'history-index failure must block file actions that require a bound history identity');
assert.ok(targetUsableSource.includes('item.history_commit_failed !== true'), 'a failed history commit must not leave direct Markdown actions enabled');
assert.ok(!appSource.includes('可直接显示已写入文件'), 'the UI must not promise a direct Markdown action that the server intentionally rejects');
assert.ok(appSource.includes('应用不能直接下载或显示这份未绑定文件'), 'the committed-unbound message should state the actual security boundary');
assert.ok(noticeSource.includes('data-text-preview-export-open-output'), 'the committed-unbound notice should offer a real output-directory recovery action when the directory identity is still current');
assert.ok(noticeSource.includes("api('/api/open-output'") && noticeSource.includes("settleLocalActionEvidence('open_output'"), 'the recovery action must execute and verify the local output-directory request');
assert.ok(noticeSource.includes('outputItemCurrentOutputDirectoryOpenable(noticeItem)'), 'the recovery action must not open a different current output directory after settings changed');

console.log('markdown unbound recovery contract passed');
