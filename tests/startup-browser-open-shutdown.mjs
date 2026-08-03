import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const source = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('function cancelScheduledBrowserOpen(');
const end = source.indexOf('\nfunction normalizeExpectedAccountFingerprint(', start);
assert.ok(start >= 0 && end > start, 'startup browser timer helpers must be inspectable');

let nextTimerId = 0;
const callbacks = new Map();
const cleared = [];
let openCalls = 0;
const sandbox = {
  setTimeout(callback) {
    const id = ++nextTimerId;
    callbacks.set(id, callback);
    return id;
  },
  clearTimeout(id) {
    cleared.push(id);
    callbacks.delete(id);
  },
  openInBrowser() {
    openCalls += 1;
  },
};
vm.runInNewContext(`
  let STARTUP_BROWSER_OPEN_TIMER = null;
  let SHUTDOWN_REQUESTED = false;
  let SHUTTING_DOWN = false;
  ${source.slice(start, end)}
  globalThis.__schedule = scheduleStartupBrowserOpen;
  globalThis.__cancel = cancelScheduledBrowserOpen;
  globalThis.__setShutdown = value => { SHUTDOWN_REQUESTED = value; };
`, sandbox, { timeout: 1000 });

assert.equal(sandbox.__schedule('http://127.0.0.1:7788', {}, 300), true);
const firstTimer = nextTimerId;
assert.equal(sandbox.__cancel(), true);
assert.deepEqual(cleared, [firstTimer]);

assert.equal(sandbox.__schedule('http://127.0.0.1:7788', {}, 300), true);
const shutdownTimer = nextTimerId;
sandbox.__setShutdown(true);
callbacks.get(shutdownTimer)();
assert.equal(openCalls, 0, 'a timer that races with shutdown must not open the browser');

sandbox.__setShutdown(false);
assert.equal(sandbox.__schedule('http://127.0.0.1:7788', {}, 300), true);
callbacks.get(nextTimerId)();
assert.equal(openCalls, 1);

console.log('startup browser-open shutdown lifecycle tests passed');
