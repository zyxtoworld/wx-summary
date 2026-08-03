import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const startupStart = mainSource.indexOf('WEIXIN_BINARY_BASELINE = await getWeixinBinaryEvidence()');
const startupEnd = mainSource.indexOf("logWarn('startup_wechat_initialization_failed'", startupStart);

assert.ok(startupStart >= 0 && startupEnd > startupStart, 'startup WeChat initialization source must be bounded');
const startupSource = mainSource.slice(startupStart, startupEnd);

assert.ok(
  startupSource.includes('const wx = await detectWeixin().catch(e => {')
    && startupSource.includes("logWarn('startup_wechat_probe_failed'")
    && startupSource.includes('后台会继续重试'),
  'a one-off startup WeChat probe failure must be converted into a recoverable status',
);
assert.ok(
  startupSource.indexOf('const wx = await detectWeixin().catch(e => {')
    < startupSource.indexOf('await startScheduler().catch(e => {'),
  'scheduler startup must run after the isolated WeChat probe regardless of probe success',
);

console.log('scheduler startup probe isolation contract passed');
