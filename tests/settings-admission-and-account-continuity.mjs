import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const settingsModule = await import('../src/config/settings.js');
const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');

const releaseWrite = settingsModule.beginSettingsWriteRequest();
let settledReadStarted = false;
const settledRead = settingsModule.withSettledSettingsWrites(async () => {
  settledReadStarted = true;
  return 'settled';
});
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(settledReadStarted, false, 'a recovery read must wait for a settings request that has started but not entered the save queue');
releaseWrite();
assert.equal(await settledRead, 'settled');

const settingsGetRoute = mainSource.slice(
  mainSource.indexOf("if (pathname === '/api/settings' && req.method === 'GET')"),
  mainSource.indexOf("if (pathname === '/api/settings' && (req.method === 'PUT' || req.method === 'POST'))"),
);
const settingsWriteRoute = mainSource.slice(
  mainSource.indexOf("if (pathname === '/api/settings' && (req.method === 'PUT' || req.method === 'POST'))"),
  mainSource.indexOf("if (pathname === '/api/scheduler/status'"),
);
const wechatStatusRoute = mainSource.slice(
  mainSource.indexOf("if (pathname === '/api/wechat/status' && req.method === 'POST')"),
  mainSource.indexOf("if (pathname === '/api/scheduler/status'", mainSource.indexOf("if (pathname === '/api/wechat/status' && req.method === 'POST')")),
);
assert.match(settingsGetRoute, /withSettledSettingsWrites\(\(\) => publicSettings\(\)\)/, 'wait_for_writes must use the request-admission and save-queue barrier');
assert.match(settingsWriteRoute, /const finishSettingsWriteRequest = beginSettingsWriteRequest\(\)[\s\S]*?finally \{[\s\S]*?finishSettingsWriteRequest\(\)/, 'settings writes must register before request parsing and unregister in finally');
assert.match(wechatStatusRoute, /const finishSettingsWriteRequest = beginSettingsWriteRequest\(\)[\s\S]*?finally \{[\s\S]*?finishSettingsWriteRequest\(\)/, 'manual-key validation requests that may persist verification must join the same admission barrier');

console.log('settings admission and account continuity tests passed');
