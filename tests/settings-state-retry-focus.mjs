import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');
const retryUiSource = appSource.slice(
  appSource.indexOf('function ensureRenderStateRetryUi'),
  appSource.indexOf('statePromise.then(result =>'),
);
const retryActionSource = retryUiSource.slice(
  retryUiSource.indexOf('async function retryRenderSettingsState'),
);

assert.ok(
  retryUiSource.includes('function ensureRenderStateRetryUi'),
  'render-state retry must keep a stable message and button DOM instead of rebuilding the focused button',
);
assert.ok(
  retryActionSource.includes('retryHadFocus')
    && retryActionSource.includes("'[data-render-state-retry]'"),
  'retry must remember whether its existing button owned keyboard focus',
);
assert.ok(
  retryActionSource.includes('paintRenderStateRetryStatus(status,')
    && !retryActionSource.includes("status.textContent = '正在重新读取本机状态...'"),
  'retry progress and failure must update the stable retry UI instead of replacing it through textContent',
);
assert.ok(
  retryActionSource.includes('retryButton.focus({ preventScroll: true })'),
  'a failed retry must restore focus to the same retry button for immediate keyboard retry',
);
assert.ok(
  appSource.includes('let renderStateRetryInFlight = false')
    && retryActionSource.includes('if (renderStateRetryInFlight) return')
    && retryActionSource.includes('renderStateRetryInFlight = true')
    && retryActionSource.includes('renderStateRetryInFlight = false'),
  'render-state retry must be single-flight even when form input repaints the warning while the request is pending',
);
assert.ok(
  retryUiSource.includes("retryState: renderStateRetryInFlight ? 'busy' : 'ready'")
    && retryUiSource.includes("text: renderStateRetryInFlight ? '正在重新读取本机状态...' : settingsStateFailureMessage()"),
  'warning repaints during a retry must preserve the busy state and stable button instead of re-enabling a duplicate request',
);

console.log('settings state retry focus contract passed');
