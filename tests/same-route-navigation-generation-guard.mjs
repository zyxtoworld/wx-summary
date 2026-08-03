import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function navigateTo(');
const end = source.indexOf('\nconst SETTINGS_SECTION_KEYS', start);
assert.ok(start >= 0 && end > start, 'navigateTo source must be inspectable');

const sandbox = {
  location: { hash: '#/digest' },
  confirmChoice: false,
  confirmCalls: 0,
  cancelCalls: 0,
  routeCalls: [],
  canonicalRouteHash: value => String(value || '#/digest'),
  replaceRouteHistoryState() {},
  hasUnsavedChanges: () => false,
  confirmDiscardDirtyChanges: async () => true,
  hasActiveDigestGeneration: () => true,
  async confirmActiveDigestReload() {
    sandbox.confirmCalls += 1;
    return sandbox.confirmChoice;
  },
  cancelDigestGeneration() {
    sandbox.cancelCalls += 1;
  },
  async route(options) {
    sandbox.routeCalls.push(options);
    return true;
  },
};
vm.runInNewContext(`
  let _routeHistoryIndex = 0;
  let _routeIntentSeq = 0;
  let _pendingDirtyBypassHash = '';
  let _pendingRouteHistoryIndex = null;
  let _pendingRouteIntent = null;
  ${source.slice(start, end)}
  globalThis.__navigateTo = navigateTo;
`, sandbox, { timeout: 1000 });

const rejected = await sandbox.__navigateTo('#/digest', { routeIfSame: true });
assert.equal(rejected, false, 'rejecting the warning must keep the current digest route alive');
assert.equal(sandbox.confirmCalls, 1, 'same-route teardown must ask before cancelling an active generation');
assert.equal(sandbox.cancelCalls, 0, 'a rejected same-route navigation must not cancel generation');
assert.equal(sandbox.routeCalls.length, 0, 'a rejected same-route navigation must not run route cleanup');

sandbox.confirmChoice = true;
const accepted = await sandbox.__navigateTo('#/digest', { routeIfSame: true });
assert.equal(accepted, true);
assert.equal(sandbox.confirmCalls, 2);
assert.equal(sandbox.cancelCalls, 1, 'accepted navigation must cancel the active generation exactly once');
assert.equal(sandbox.routeCalls.length, 1, 'accepted navigation may rebuild the current route once');
assert.equal(sandbox.routeCalls[0].bypassDirty, true, 'the accepted warning must not be shown again inside route()');

console.log('same-route active-generation navigation guard tests passed');
