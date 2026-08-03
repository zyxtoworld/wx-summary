import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');
const normalizeSource = appSource.slice(appSource.indexOf('function normalizePersistedHistoryViewState'), appSource.indexOf('function restorePersistedHistoryViewState'));
const persistenceSource = appSource.slice(appSource.indexOf('function persistHistoryViewState'), appSource.indexOf('const HISTORY_MARKDOWN_EXPORT_CACHE_LIMIT'));
const routeSource = appSource.slice(appSource.indexOf('async function route'), appSource.indexOf('function focusRouteHeading'));
const renderHistorySource = appSource.slice(appSource.indexOf('async function renderHistory()'), appSource.indexOf('function historyCardActionsHtml'));
const captureSource = renderHistorySource.slice(renderHistorySource.indexOf('function captureCurrentHistoryView'), renderHistorySource.indexOf('function clearHistoryPersistenceTimer'));

assert.ok(appSource.includes('wx-summary:history-view:v3:'), 'history view persistence must use a new schema key when focus identity is added');
assert.ok(normalizeSource.includes('Number(value.version) !== 3'), 'history focus snapshots must be versioned');
assert.ok(normalizeSource.includes('focusKey:') && normalizeSource.includes('focusAction,'), 'persisted history state must normalize the focused card key and action');
assert.ok(persistenceSource.includes('focus_key:') && persistenceSource.includes('focus_action:'), 'history persistence must write the focused card key and action');
assert.ok(captureSource.includes('const focusSnapshot = historyListFocusSnapshot()')
  && captureSource.includes('_state_history.focusKey')
  && captureSource.includes('_state_history.focusAction'), 'leaving or scrolling the history page must capture its focused card action');
assert.ok(routeSource.includes("targetHash === '#/history'")
  && routeSource.includes('_historyRouteFocusRestorePending'), 'route heading focus must wait while a persisted history-card focus is being restored');
assert.ok(renderHistorySource.includes('restorePersistedHistoryListFocus')
  && renderHistorySource.includes('while (initialHistoryLoaded')
  && renderHistorySource.lastIndexOf('restorePersistedHistoryListFocus();') > renderHistorySource.indexOf('while (initialHistoryLoaded'), 'history-card focus must restore after the saved pagination window has loaded');
assert.ok(renderHistorySource.includes('focusRouteHeading()'), 'a missing or deleted persisted target must fall back to the history page heading');

console.log('history view focus persistence contract passed');
