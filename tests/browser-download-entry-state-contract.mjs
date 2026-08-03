import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');
const {
  browserDownloadUnsupportedMessage,
} = await import('../src/web/public/js/browser-download-capability.js');

assert.equal(
  browserDownloadUnsupportedMessage({ artifactLabel: 'PNG' }),
  '当前浏览器不支持可靠的文件下载，已停止准备 PNG。请升级浏览器或改用支持文件下载的浏览器。',
  'the generic error must not promise reveal or copy actions that were never preflighted',
);
assert.match(
  browserDownloadUnsupportedMessage({
    artifactLabel: '已保存 PNG',
    savedArtifact: true,
    revealSupported: true,
  }),
  /“在文件夹中显示”定位已保存 PNG/,
  'a verified saved artifact may offer the supported reveal recovery',
);
assert.doesNotMatch(
  browserDownloadUnsupportedMessage({
    artifactLabel: '未保存 PNG',
    savedArtifact: false,
    revealSupported: true,
  }),
  /在文件夹中显示/,
  'an unsaved preview must never offer a file-manager recovery',
);
assert.match(
  browserDownloadUnsupportedMessage({
    artifactLabel: 'PNG',
    copySupported: true,
    copyLabel: '复制图片',
  }),
  /可改用“复制图片”/,
  'copy recovery should only appear when the caller reports a usable copy path',
);

const previewActionSource = appSource.slice(
  appSource.indexOf('function updateDigestPreviewActionLock'),
  appSource.indexOf('function setDigestRerenderSaving'),
);
const textDownloadSource = appSource.slice(
  appSource.indexOf('function syncTextPreviewDownloadButton'),
  appSource.indexOf('function legacyCopyTextToClipboard'),
);
const historyMarkdownSource = appSource.slice(
  appSource.indexOf('function showHistoryMarkdownModal'),
  appSource.indexOf('function showHistoryModal'),
);
const historyPngSource = appSource.slice(
  appSource.indexOf('function showHistoryModal'),
  appSource.indexOf('function historyImagePath'),
);
const settingsSource = appSource.slice(
  appSource.indexOf('async function renderSettings'),
  appSource.indexOf('function setupAccountRef'),
);

assert.ok(appSource.includes('browserDownloadCapability,'), 'the UI should import the non-throwing capability probe for entry state');
assert.ok(previewActionSource.includes('browserBlobDownloadSupported()'), 'the current PNG preview download button should preflight browser download support');
assert.ok(textDownloadSource.includes('browserBlobDownloadSupported()'), 'the exported Markdown download button should preflight browser download support');
assert.ok(historyMarkdownSource.includes('browserBlobDownloadSupported()'), 'history Markdown download state should preflight browser download support');
assert.ok(historyPngSource.includes('browserBlobDownloadSupported()'), 'history PNG download state should preflight browser download support');
assert.ok(settingsSource.includes("syncBrowserDownloadOnlyButton(exportDiagButton"), 'diagnostic export should be disabled before click when browser downloads are unsupported');
assert.ok(settingsSource.includes("syncBrowserDownloadOnlyButton(exportAcceptanceButton"), 'acceptance export should be disabled before click when browser downloads are unsupported');
assert.ok(appSource.includes('downloadSupported && !actionBusy'), 'batch preview download actions should include capability in their rendered disabled state');

console.log('browser download entry state contract passed');
