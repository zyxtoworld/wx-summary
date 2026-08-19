import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

const [source, settingsSource, css] = await Promise.all([
  readFile(new URL('../src/web/public/js/pages/settings/privacy.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/css/settings.css', import.meta.url), 'utf8'),
]);
globalThis.location = new URL('http://wx-summary.test/#/settings');
const loader = createBrowserModuleLoader();
const privacyModule = await loader.load('js/pages/settings/privacy.js');
const diagnosticsContract = await loader.load('js/shared/diagnostics-contract.js');
for (const changed of [false, true]) {
  const payload = { ok: true, reset: { changed, bytes: changed ? 128 : 0 } };
  assert.strictEqual(privacyModule.requireWxdbKeyCacheResetResult(payload), payload.reset,
    '合法缓存重置响应必须返回经过验证的 reset 对象');
}
for (const malformed of [
  null,
  {},
  { ok: false, reset: { changed: true, bytes: 1 } },
  { ok: true, reset: null },
  { ok: true, reset: { changed: 'yes', bytes: 1 } },
  { ok: true, reset: { changed: true, bytes: '1' } },
  { ok: true, reset: { changed: true, bytes: -1 } },
]) {
  assert.throws(
    () => privacyModule.requireWxdbKeyCacheResetResult(malformed),
    error => error?.status === 502 && error?.code === 'wxdb_key_cache_reset_response_invalid',
    '畸形缓存重置响应必须按固定 502 合同拒绝',
  );
}

const lightDiagnostics = {
  ok: true,
  generated_at: '2026-08-12T00:00:00.000Z',
  diagnostic_scope: 'light',
  service: {},
  log_tail: [],
};
assert.strictEqual(
  diagnosticsContract.requireSettingsDiagnosticsResult(lightDiagnostics, 'light'),
  lightDiagnostics,
  '合法诊断响应必须保留经过验证的完整载荷',
);
for (const malformed of [
  null,
  {},
  { ...lightDiagnostics, ok: false },
  { ...lightDiagnostics, generated_at: '' },
  { ...lightDiagnostics, diagnostic_scope: 'full' },
  { ...lightDiagnostics, service: null },
  { ...lightDiagnostics, log_tail: null },
]) {
  assert.throws(
    () => diagnosticsContract.requireSettingsDiagnosticsResult(malformed, 'light'),
    error => error?.status === 502 && error?.code === 'settings_diagnostics_response_invalid',
    '畸形或错 scope 的诊断响应必须按固定 502 合同拒绝',
  );
}

const rawLogs = { ok: true, log_tail: [] };
const summaryLogs = {
  ok: true,
  log_tail: [],
  entries: [],
  service_started_at: '2026-08-12T00:00:00.000Z',
};
assert.strictEqual(privacyModule.requireSettingsLogResult(rawLogs, 'raw'), rawLogs);
assert.strictEqual(privacyModule.requireSettingsLogResult(summaryLogs, 'summary'), summaryLogs);
for (const [payload, view] of [
  [null, 'raw'],
  [{}, 'raw'],
  [{ ok: false, log_tail: [] }, 'raw'],
  [{ ok: true, log_tail: null }, 'raw'],
  [{ ok: true, log_tail: [1] }, 'raw'],
  [{ ok: true, log_tail: [] }, 'summary'],
  [{ ...summaryLogs, entries: null }, 'summary'],
  [{ ...summaryLogs, service_started_at: '' }, 'summary'],
]) {
  assert.throws(
    () => privacyModule.requireSettingsLogResult(payload, view),
    error => error?.status === 502 && error?.code === 'settings_logs_response_invalid',
    '畸形日志响应必须按固定 502 合同拒绝',
  );
}
assert.match(source,
  /import \{ syncFormControlsDisabled \} from '\/js\/shared\/form-busy-controls\.js';/,
  '隐私分区必须使用 shared 表单忙态同步器');
assert.match(source,
  /syncFormControlsDisabled\(\[\s*\.\.\.toggles\.values\(\),\s*keyInput,\s*logView,?\s*\],\s*busy\);/,
  '生产 setBusy 必须锁定脱敏草稿、手动密钥输入和日志视图');
assert.match(source,
  /page\.beginAction\('读取日志', \[logRefreshBtn\], \{ focusCandidates: \[logRefreshBtn, logView\] \}\)/,
  '日志视图 change 触发读取时必须只把下拉框纳入焦点候选，不能提前污染其原始 disabled 状态');
assert.match(settingsSource,
  /function beginAction\(label, buttons = \[\], \{ focusCandidates = buttons \} = \{\}\)[\s\S]*?captureActionFocus\(focusCandidates,/,
  '设置页 action 必须把手动禁用按钮与焦点候选分离');
assert.match(css,
  /\.settings-status\s*\{[\s\S]*?max-height:\s*min\(32vh,\s*160px\);[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto;[\s\S]*?overflow-wrap:\s*anywhere;/,
  '设置页长错误必须在有界状态区内滚动，不能无限拉长整张设置卡');
assert.match(css,
  /\.settings-validation\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-x:\s*hidden;[\s\S]*?\}\s*\.settings-validation \.settings-progress-text\s*\{[\s\S]*?max-height:\s*min\(24vh,\s*120px\);[\s\S]*?overflow-y:\s*auto;[\s\S]*?overflow-wrap:\s*anywhere;/,
  '手动验证和自动扫描的长进度必须断行并限制高度，不能把窄屏内容裁掉');

function extractFunction(moduleSource, marker) {
  const start = moduleSource.indexOf(marker);
  assert.ok(start >= 0, `隐私分区必须包含 ${marker}`);
  const signatureEnd = moduleSource.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位的函数体`);
  const open = moduleSource.indexOf('{', signatureEnd + 2);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < moduleSource.length; index += 1) {
    const char = moduleSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '`' || char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return moduleSource.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

{
  const resetKeyCacheSource = extractFunction(source, 'async function resetKeyCache(');
  const statusEvents = [];
  let paints = 0;
  let response = null;
  const token = { signal: new AbortController().signal };
  const resetKeyCache = new Function(
    'ui',
    'page',
    'resetCacheBtn',
    'toolStatus',
    'api',
    'paintKeyState',
    'isAbortError',
    'errorText',
    'requireWxdbKeyCacheResetResult',
    `${resetKeyCacheSource}; return resetKeyCache;`,
  )(
    { async confirmDialog() { return true; } },
    {
      beginAction() { return token; },
      alive(candidate) { return candidate === token; },
      endAction(candidate) { return candidate === token; },
    },
    { disabled: false },
    { set(message, kind) { statusEvents.push({ message, kind }); } },
    { async post() { return response; } },
    () => { paints += 1; },
    () => false,
    (error, fallback) => error?.message || fallback,
    privacyModule.requireWxdbKeyCacheResetResult,
  );

  await resetKeyCache();
  assert.notEqual(statusEvents.at(-1)?.kind, 'ok',
    '重置缓存接口的 200 + null 不得误报“自动密钥缓存已重置”');
  assert.match(statusEvents.at(-1)?.message || '', /响应无效|确认/,
    '畸形重置响应必须提示结果需要确认，避免用户立即重复执行');
  assert.equal(paints, 0, '畸形重置响应不得用旧页面 state 重画密钥状态');

  response = { ok: true, reset: { changed: false, bytes: 0 } };
  await resetKeyCache();
  assert.equal(statusEvents.at(-1)?.kind, 'ok');
  assert.match(statusEvents.at(-1)?.message || '', /原本就没有/,
    '合法 changed=false 必须保留幂等成功提示');
  assert.equal(paints, 1);

  response = { ok: true, reset: { changed: true, bytes: 64 } };
  await resetKeyCache();
  assert.equal(statusEvents.at(-1)?.kind, 'ok');
  assert.equal(statusEvents.at(-1)?.message, '自动密钥缓存已重置。');
  assert.equal(paints, 2, '只有经过验证的成功响应才允许重画密钥状态');
}

{
  const downloadDiagnosticsSource = extractFunction(source, 'async function downloadDiagnostics(');
  const statusEvents = [];
  const downloads = [];
  let response = null;
  const token = { signal: new AbortController().signal };
  const downloadDiagnostics = new Function(
    'page',
    'diagLightBtn',
    'diagFullBtn',
    'toolStatus',
    'assertBrowserDownloadSupported',
    'api',
    'downloadTextFile',
    'isAbortError',
    'errorText',
    'requireSettingsDiagnosticsResult',
    `${downloadDiagnosticsSource}; return downloadDiagnostics;`,
  )(
    {
      beginAction() { return token; },
      alive(candidate) { return candidate === token; },
      endAction(candidate) { return candidate === token; },
    },
    {},
    {},
    { set(message, kind) { statusEvents.push({ message, kind }); } },
    () => {},
    { async get() { return response; } },
    (name, text) => { downloads.push({ name, text }); },
    () => false,
    (error, fallback) => error?.message || fallback,
    diagnosticsContract.requireSettingsDiagnosticsResult,
  );

  await downloadDiagnostics('light');
  assert.equal(downloads.length, 0, '诊断接口的 200 + null 不得下载内容为 null 的文件');
  assert.equal(statusEvents.at(-1)?.kind, 'err', '畸形诊断响应不得误报下载成功');
  assert.match(statusEvents.at(-1)?.message || '', /响应无效/);

  response = lightDiagnostics;
  await downloadDiagnostics('light');
  assert.equal(downloads.length, 1, '只有经过合同验证的诊断载荷才允许下载');
  assert.match(downloads[0].text, /"diagnostic_scope": "light"/);
  assert.equal(statusEvents.at(-1)?.kind, 'ok');
}

{
  // 真实 downloadDiagnostics caller 的 owner 合同：账号上下文换代后，
  // API 即使忽略 abort 仍晚到 resolve/reject，也不能触碰新 owner 的下载或状态。
  const downloadDiagnosticsSource = extractFunction(source, 'async function downloadDiagnostics(');
  const responseGate = {};
  responseGate.promise = new Promise((resolve, reject) => {
    responseGate.resolve = resolve;
    responseGate.reject = reject;
  });
  let currentToken = null;
  let tokenSequence = 0;
  let downloads = 0;
  const statuses = [];
  const page = {
    beginAction() {
      const token = { id: ++tokenSequence, signal: new AbortController().signal };
      currentToken = token;
      return token;
    },
    alive(token) { return token === currentToken; },
    endAction(token) {
      if (token === currentToken) currentToken = null;
    },
    invalidateActions() { currentToken = null; },
  };
  const downloadDiagnostics = new Function(
    'page',
    'diagLightBtn',
    'diagFullBtn',
    'toolStatus',
    'assertBrowserDownloadSupported',
    'api',
    'downloadTextFile',
    'isAbortError',
    'errorText',
    'requireSettingsDiagnosticsResult',
    `${downloadDiagnosticsSource}; return downloadDiagnostics;`,
  )(
    page,
    {},
    {},
    { set(message, kind) { statuses.push({ message, kind }); } },
    () => {},
    { get() { return responseGate.promise; } },
    () => { downloads += 1; },
    () => false,
    (error, fallback) => error?.message || fallback,
    diagnosticsContract.requireSettingsDiagnosticsResult,
  );

  const lateResolve = downloadDiagnostics('light');
  await Promise.resolve();
  page.invalidateActions();
  const replacementToken = page.beginAction('replacement');
  responseGate.resolve(lightDiagnostics);
  await lateResolve;
  assert.equal(downloads, 0, 'A 诊断响应晚到时不得在 B owner 下下载文件');
  assert.equal(statuses.length, 1, 'A 晚到成功不得写入 B 的状态行');
  assert.strictEqual(currentToken, replacementToken, 'A finally 不得清掉 B owner');

  const rejectGate = {};
  rejectGate.promise = new Promise((resolve, reject) => {
    rejectGate.resolve = resolve;
    rejectGate.reject = reject;
  });
  const rejectingDownload = new Function(
    'page', 'diagLightBtn', 'diagFullBtn', 'toolStatus',
    'assertBrowserDownloadSupported', 'api', 'downloadTextFile',
    'isAbortError', 'errorText', 'requireSettingsDiagnosticsResult',
    `${downloadDiagnosticsSource}; return downloadDiagnostics;`,
  )(
    page,
    {},
    {},
    { set(message, kind) { statuses.push({ message, kind }); } },
    () => {},
    { get() { return rejectGate.promise; } },
    () => { downloads += 1; },
    () => false,
    (error, fallback) => error?.message || fallback,
    diagnosticsContract.requireSettingsDiagnosticsResult,
  );
  page.invalidateActions();
  const statusCountBeforeReject = statuses.length;
  const lateReject = rejectingDownload('light');
  await Promise.resolve();
  page.invalidateActions();
  const secondReplacement = page.beginAction('second-replacement');
  rejectGate.reject(new Error('A late diagnostic failure'));
  await lateReject;
  assert.equal(downloads, 0, 'A 诊断错误晚到时不得触发下载副作用');
  assert.equal(statuses.length, statusCountBeforeReject + 1,
    'A 晚到错误不得在动作初始状态之外给 B 投影失败状态');
  assert.strictEqual(currentToken, secondReplacement, 'A 错误 finally 不得清掉新的 owner');
}

console.log('web settings privacy busy controls tests passed');
