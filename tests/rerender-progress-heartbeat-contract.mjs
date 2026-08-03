import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');
const panelSource = appSource.slice(
  appSource.indexOf('function showDigestRerenderPanel('),
  appSource.indexOf('function ensureKeyboardShortcuts()'),
);

assert.ok(panelSource.includes('let previewElapsedTimer = null;'), 'rerender previews should own an elapsed-time heartbeat timer');
assert.ok(panelSource.includes('const startPreviewElapsedTicker = controller => {'), 'rerender previews should start a controller-bound elapsed-time ticker');
assert.ok(panelSource.includes('formatDigestElapsedDetail(panelBase, startedAt)'), 'the rerender panel should expose continuously updated elapsed time');
assert.ok(panelSource.includes('formatDigestElapsedDetail(targetBase, startedAt)'), 'the parent preview status should expose the same elapsed time');
assert.ok(panelSource.includes('stopPreviewElapsedTicker(controller);'), 'rerender preview completion and cancellation should stop only the matching ticker');
assert.ok(panelSource.includes('startPreviewElapsedTicker(controller);'), 'manual rerender preview requests should start the elapsed-time heartbeat before awaiting the server');
assert.ok(panelSource.includes("const previewWasRunning = panel.dataset.previewing === '1';"), 'closing a rerender panel should remember whether a preview was still running');
assert.ok(panelSource.includes('正在生成的预览已取消；原图未改写。'), 'closing an active preview should replace the stale running status with an explicit cancelled state');

console.log('rerender progress heartbeat contract passed');
