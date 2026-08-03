import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSource = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const busyButtonsSource = appSource.slice(
  appSource.indexOf('function busyButtonFocusSnapshot'),
  appSource.indexOf('function markInvalidFormFields'),
);
const batchResultsSource = appSource.slice(
  appSource.indexOf('function digestBatchResultsTitleText'),
  appSource.indexOf('async function copyDigestBatchResultPaths'),
);

assert.ok(
  appSource.includes('function busyButtonFocusSnapshot(button)')
    && appSource.includes('function resolveBusyButtonFocusTarget(snapshot)')
    && appSource.includes('function busyButtonOwnsFallbackFocus(snapshot, active)')
    && busyButtonsSource.includes('const focusSnapshot = focusedButton ? busyButtonFocusSnapshot(focusedButton) : null')
    && busyButtonsSource.includes('resolveBusyButtonFocusTarget(focusSnapshot)')
    && busyButtonsSource.includes('busyFallbackFocused'),
  'busy actions must recover focus through a stable action identity after their original button is replaced',
);

assert.ok(
  batchResultsSource.includes('function captureDigestBatchResultsFocus(host)')
    && batchResultsSource.includes('function restoreDigestBatchResultsFocus(host, snapshot)')
    && batchResultsSource.includes('const focusSnapshot = captureDigestBatchResultsFocus(host)')
    && batchResultsSource.includes('data-batch-result-index=')
    && batchResultsSource.includes('restoreDigestBatchResultsFocus(host, focusSnapshot)')
    && batchResultsSource.indexOf('restoreDigestBatchResultsFocus(host, focusSnapshot)')
      > batchResultsSource.indexOf("host.querySelectorAll('[data-batch-copy-path]')"),
  'batch-result repaints must restore the same logical control only after replacement controls are fully bound',
);

console.log('digest batch focus tests passed');
