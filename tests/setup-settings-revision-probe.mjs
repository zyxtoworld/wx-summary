import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const appSource = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const setupStart = appSource.indexOf('async function renderSetup()');
const setupEnd = appSource.length;
assert.ok(setupStart >= 0 && setupEnd > setupStart, 'setup route source must be bounded');
const setupSource = appSource.slice(setupStart, setupEnd);

assert.ok(
  setupSource.includes('createLatestSettingsRevisionProbe({')
    && setupSource.includes("fetchAppState({ refresh: true, signal: setupRevisionProbeAbort.signal })"),
  'setup must force a latest server snapshot through a coalescing revision probe',
);
assert.ok(
  setupSource.includes("window.addEventListener('focus', requestSetupRevisionProbe)")
    && setupSource.includes("document.addEventListener('visibilitychange', onSetupVisibilityChange)"),
  'setup must probe when another window can have changed settings',
);
assert.ok(
  setupSource.includes("window.removeEventListener('focus', requestSetupRevisionProbe)")
    && setupSource.includes("document.removeEventListener('visibilitychange', onSetupVisibilityChange)")
    && setupSource.includes('setupRevisionProbe.dispose()')
    && setupSource.includes('setupRevisionProbeAbort.abort('),
  'setup revision probe listeners and requests must be cleaned up with the route',
);
assert.ok(
  setupSource.includes('if (!wasStale && setupActive() && !setupSaveBusy()) paint();'),
  'a newly observed conflicting settings revision must immediately paint the stale-draft recovery screen',
);

console.log('setup settings revision probe contract passed');
