import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createSettingsLogViewLifecycle,
  normalizeSettingsLogView,
} from '../src/web/public/js/pages/settings/log-view-lifecycle.js';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/settings');
const browserLoader = createBrowserModuleLoader();
const privacyModule = await browserLoader.load('js/pages/settings/privacy.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing production function: ${marker}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated production function: ${marker}`);
}

function createRefreshLogsHarness(refreshLogsSource) {
  const pending = [];
  const tokens = [];
  let destroyed = false;
  const panel = {
    texts: [],
    replaceChildren(...children) {
      this.texts = children.map(child => String(child?.text || child?.textContent || ''));
    },
  };
  const statuses = [];
  const logView = { value: 'raw' };
  const logRefreshBtn = {};
  const page = {
    beginAction() {
      const token = { active: true };
      tokens.push(token);
      return token;
    },
    alive(token) { return !destroyed && token?.active === true; },
    endAction() {},
    destroy() {
      destroyed = true;
      for (const token of tokens) token.active = false;
    },
  };
  const api = {
    get(path) {
      const request = deferred();
      pending.push({ path, ...request });
      return request.promise;
    },
  };
  const logStatus = {
    set(text, kind = '') { statuses.push({ text: String(text), kind }); },
  };
  const el = (_tag, attrs = {}) => ({ text: String(attrs.text || '') });
  const replaceLogPanelMessage = text => panel.replaceChildren({ text });
  const refreshLogs = new Function(
    'logViewLifecycle',
    'logView',
    'logRefreshBtn',
    'replaceLogPanelMessage',
    'page',
    'api',
    'logStatus',
    'logPanel',
    'el',
    'fmtDateTime',
    'isAbortError',
    'errorText',
    'requireSettingsLogResult',
    `${refreshLogsSource}\nreturn refreshLogs;`,
  )(
    createSettingsLogViewLifecycle(),
    logView,
    logRefreshBtn,
    replaceLogPanelMessage,
    page,
    api,
    logStatus,
    panel,
    el,
    () => 'now',
    error => error?.name === 'AbortError' || error?.status === 499,
    error => String(error?.message || '读取日志失败'),
    privacyModule.requireSettingsLogResult,
  );
  return { api, logView, panel, pending, refreshLogs, statuses, destroy: () => page.destroy() };
}

assert.equal(normalizeSettingsLogView('summary'), 'summary');
assert.equal(normalizeSettingsLogView('raw'), 'raw');
assert.equal(normalizeSettingsLogView('unexpected'), 'raw');

const lifecycle = createSettingsLogViewLifecycle();
assert.equal(lifecycle.isCurrent(null), false, '缺少请求 owner 时必须 fail-closed');

const initialRaw = lifecycle.begin('raw');
assert.deepEqual(initialRaw, { view: 'raw', replaceContent: true, generation: 1 });
lifecycle.commit(initialRaw);
assert.equal(lifecycle.displayedView(), 'raw');

const sameRawRefresh = lifecycle.begin('raw');
assert.equal(sameRawRefresh.replaceContent, false, '刷新当前视图时应保留已经成功显示的内容');
assert.equal(
  lifecycle.shouldReplaceAfterFailure(sameRawRefresh),
  false,
  '当前视图刷新失败时可以保留同一视图的上次成功内容',
);

const summarySwitch = lifecycle.begin('summary');
assert.equal(summarySwitch.replaceContent, true, '切换视图时必须立即替换另一视图的旧内容');
assert.equal(
  lifecycle.shouldReplaceAfterFailure(summarySwitch),
  true,
  '新视图读取失败时不得把上一视图的内容留在选中的新视图下',
);
assert.equal(lifecycle.displayedView(), 'raw', '失败不得把请求视图提交为已显示视图');

lifecycle.commit(summarySwitch);
assert.equal(lifecycle.displayedView(), 'summary');
assert.equal(lifecycle.begin('summary').replaceContent, false);

const privacySource = readFileSync(
  new URL('../src/web/public/js/pages/settings/privacy.js', import.meta.url),
  'utf8',
);
const refreshLogsSource = extractFunction(privacySource, 'async function refreshLogs()');

const lateResolve = createRefreshLogsHarness(refreshLogsSource);
const staleRaw = lateResolve.refreshLogs();
lateResolve.logView.value = 'summary';
const currentSummary = lateResolve.refreshLogs();
if (lateResolve.pending.length !== 2) await Promise.all([staleRaw, currentSummary]);
assert.equal(lateResolve.pending.length, 2, '切换日志视图必须允许新视图立即发起自己的请求');
lateResolve.pending[1].resolve({
  ok: true,
  log_tail: [],
  entries: [{ at: 'new', level: 'info', event: 'current-summary' }],
  service_started_at: '2026-08-12T00:00:00.000Z',
});
await currentSummary;
assert.match(lateResolve.panel.texts.join('\n'), /current-summary/, '新视图响应应先显示');
lateResolve.pending[0].resolve({ ok: true, log_tail: ['stale-raw'] });
await staleRaw;
assert.match(lateResolve.panel.texts.join('\n'), /current-summary/,
  '旧视图 late resolve 不得覆盖当前日志视图');
assert.doesNotMatch(lateResolve.panel.texts.join('\n'), /stale-raw/);

const lateReject = createRefreshLogsHarness(refreshLogsSource);
const rejectedRaw = lateReject.refreshLogs();
lateReject.logView.value = 'summary';
const stableSummary = lateReject.refreshLogs();
lateReject.pending[1].resolve({
  ok: true,
  log_tail: [],
  entries: [{ at: 'new', level: 'info', event: 'stable-summary' }],
  service_started_at: '2026-08-12T00:00:00.000Z',
});
await stableSummary;
lateReject.pending[0].reject(new Error('stale raw failed'));
await rejectedRaw;
assert.match(lateReject.panel.texts.join('\n'), /stable-summary/,
  '旧视图 late reject 不得把当前日志视图替换成旧请求错误');
assert.equal(lateReject.statuses.some(item => item.text.includes('stale raw failed')), false,
  '旧视图 late reject 不得把错误状态投影到当前页面');

const lateAfterDestroy = createRefreshLogsHarness(refreshLogsSource);
const destroyedRequest = lateAfterDestroy.refreshLogs();
assert.equal(lateAfterDestroy.pending.length, 1);
const panelBeforeDestroy = [...lateAfterDestroy.panel.texts];
const statusesBeforeDestroy = [...lateAfterDestroy.statuses];
lateAfterDestroy.destroy();
lateAfterDestroy.pending[0].resolve({ ok: true, log_tail: ['late-after-destroy'] });
await destroyedRequest;
assert.deepEqual(lateAfterDestroy.panel.texts, panelBeforeDestroy,
  '页面卸载后迟到日志响应不得再写入日志面板');
assert.deepEqual(lateAfterDestroy.statuses, statusesBeforeDestroy,
  '页面卸载后迟到日志响应不得再写入状态行');

const malformed = createRefreshLogsHarness(refreshLogsSource);
const malformedRaw = malformed.refreshLogs();
malformed.pending[0].resolve(null);
await malformedRaw;
assert.deepEqual(malformed.panel.texts, ['(原始日志读取失败，请重试。)'],
  '200 + null 必须进入可重试错误态，不能伪装成暂无日志');
assert.equal(malformed.statuses.at(-1)?.kind, 'err', '畸形日志响应不得误报已更新');
assert.match(malformed.statuses.at(-1)?.text || '', /响应无效/);

assert.match(privacySource, /createSettingsLogViewLifecycle/, '设置页必须实例化日志视图生命周期');
assert.match(privacySource, /logViewLifecycle\.begin\(/, '每次日志请求必须先声明目标视图');
assert.match(privacySource, /logViewLifecycle\.commit\(/, '只有成功响应才能提交已显示视图');
assert.match(
  privacySource,
  /logViewLifecycle\.shouldReplaceAfterFailure\(/,
  '读取失败必须按当前显示身份决定是否替换内容',
);

console.log('web settings log view lifecycle tests passed');
