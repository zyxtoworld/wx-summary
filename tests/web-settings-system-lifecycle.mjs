import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSettingsSystemOperation } from '../src/web/public/js/pages/settings/system-operation.js';
import { requireSettingsDiagnosticsResult } from '../src/web/public/js/shared/diagnostics-contract.js';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `生产本机状态分区必须包含 ${marker}`);
  const signatureEnd = source.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位的函数体`);
  const open = source.indexOf('{', signatureEnd + 2);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
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
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

const acceptanceDiagnostics = Object.freeze({
  ok: true,
  generated_at: '2026-08-12T02:00:00.000Z',
  diagnostic_scope: 'acceptance',
  service: {},
  log_tail: [],
  acceptance_manual_checks: [],
  capabilities: {},
  platform_limitations: {},
});

const operation = createSettingsSystemOperation();
const firstGate = deferred();
let requestCount = 0;
const first = operation.run(() => {
  requestCount += 1;
  return firstGate.promise;
});
const joined = operation.run(() => {
  requestCount += 1;
  return Promise.resolve('duplicate');
});

assert.equal(joined, first, '分区重激活必须复用正在进行的诊断请求');
assert.equal(requestCount, 1, '同一时刻只能发起一次诊断请求');
firstGate.resolve('current');
assert.equal(await first, 'current');

const second = operation.run(() => {
  requestCount += 1;
  return Promise.resolve('next');
});
assert.notEqual(second, first, '前一次完成后必须允许显式刷新');
assert.equal(await second, 'next');
assert.equal(requestCount, 2);

const failure = new Error('synthetic failure');
await assert.rejects(operation.run(() => Promise.reject(failure)), error => error === failure);
assert.equal(await operation.run(() => Promise.resolve('recovered')), 'recovered',
  '请求失败后不得把协调器永久卡在忙态');

{
  const operation = createSettingsSystemOperation();
  const stale = deferred();
  const current = deferred();
  let requestCount = 0;
  const staleRun = operation.run(() => {
    requestCount += 1;
    return stale.promise;
  });
  assert.equal(operation.invalidate(), true,
    '账号上下文换代必须立即释放旧诊断请求的单飞归属');
  const currentRun = operation.run(() => {
    requestCount += 1;
    return current.promise;
  });
  assert.notStrictEqual(currentRun, staleRun,
    'B 刷新不得继续加入已失效的 A 诊断 Promise');
  assert.equal(requestCount, 2, 'A 在途时失效后，B 必须立即发起第二个诊断请求');
  stale.resolve('stale-a');
  assert.equal(await staleRun, 'stale-a');
  assert.strictEqual(operation.run(() => {
    requestCount += 1;
    return Promise.resolve('unexpected-third');
  }), currentRun, 'A 的晚到 finally 不得清掉 B 当前单飞 owner');
  assert.equal(requestCount, 2);
  current.resolve('current-b');
  assert.equal(await currentRun, 'current-b');
  assert.equal(operation.invalidate(), false, '空闲协调器重复失效必须幂等');
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || '').toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.classList = {
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (force) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(' ');
      },
    };
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value ?? ''));
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...children) {
    this.children.push(...children.flat(Infinity).filter(Boolean));
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = children.flat(Infinity).filter(Boolean);
  }
}

function findElement(root, predicate) {
  if (!root || typeof root !== 'object') return null;
  if (predicate(root)) return root;
  for (const child of root.children || []) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

{
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  globalThis.location = new URL('http://wx-summary.test/#/settings');
  globalThis.document = {
    body: new FakeElement('body'),
    createElement(tagName) { return new FakeElement(tagName); },
  };
  try {
    const loader = createBrowserModuleLoader();
    const systemModule = await loader.load('js/pages/settings/system.js');
    const coreModule = await loader.load('js/pages/settings/core.js');

    {
      const originalCreateElement = document.createElement;
      const originalUrl = globalThis.URL;
      const originalSetTimeout = globalThis.setTimeout;
      let anchorRemoved = false;
      let revoked = 0;
      let timers = 0;
      globalThis.URL = {
        createObjectURL() { return 'blob:settings-diagnostics'; },
        revokeObjectURL() { revoked += 1; },
      };
      globalThis.setTimeout = callback => {
        timers += 1;
        callback();
        return timers;
      };
      document.createElement = tagName => {
        const node = originalCreateElement.call(document, tagName);
        if (tagName === 'a') {
          node.click = () => { throw new Error('浏览器拒绝触发下载'); };
          node.remove = () => { anchorRemoved = true; };
        }
        return node;
      };
      try {
        assert.throws(
          () => coreModule.downloadTextFile('diagnostics.md', '# fixture', 'text/markdown'),
          /浏览器拒绝触发下载/,
        );
        assert.equal(anchorRemoved, true,
          '诊断下载失败时共享 helper 必须移除临时 anchor');
        assert.equal(timers, 1,
          '诊断下载失败时共享 helper 仍必须安排一次 ObjectURL 清理');
        assert.equal(revoked, 1,
          '诊断下载失败时共享 helper 必须恰好 revoke 一次 ObjectURL');
      } finally {
        document.createElement = originalCreateElement;
        globalThis.URL = originalUrl;
        globalThis.setTimeout = originalSetTimeout;
      }
    }

    const responses = [];
    let currentToken = null;
    let revision = 0;
    const page = {
      api: {
        get() {
          const response = deferred();
          responses.push(response);
          return response.promise;
        },
      },
      ui: {},
      beginAction() {
        const controller = new AbortController();
        const token = { revision: ++revision, controller, signal: controller.signal };
        currentToken = token;
        return token;
      },
      alive(token) {
        return currentToken === token;
      },
      endAction(token) {
        if (currentToken !== token) return false;
        currentToken = null;
        return true;
      },
    };
    const section = systemModule.createSystemSection(page);
    const status = findElement(section.el, element => (
      element.className.split(/\s+/).includes('settings-status')
    ));
    assert.ok(status, '真实本机状态分区必须创建状态行');

    section.onActivated();
    assert.equal(responses.length, 1, '激活空本机状态分区必须发起 A 诊断请求');
    const tokenA = currentToken;
    tokenA.controller.abort(new Error('账号上下文已变化'));
    currentToken = null;
    assert.equal(typeof section.onAccountChanged, 'function',
      '生产本机状态分区必须响应账号上下文换代');
    section.onAccountChanged();
    assert.equal(responses.length, 2,
      'A 请求忽略 abort 在途时，当前可见分区必须立即为 B 重发诊断请求');
    const tokenB = currentToken;
    assert.notStrictEqual(tokenB, tokenA);

    responses[0].resolve({ generated_at: '2026-08-12T01:00:00.000Z' });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(currentToken, tokenB,
      'A 晚到 finally 不得结束 B 当前 action token');
    assert.equal(status.textContent, '正在读取本机状态…',
      'A 晚到不得把旧诊断结果投影到 B 状态行');

    responses[1].resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(currentToken, null, 'B 的畸形响应也必须只释放 B 自己的 action token');
    assert.match(status.textContent, /响应无效/,
      '200 + null 必须进入可重试错误态，不能误报本机状态已更新');

    section.onActivated();
    assert.equal(responses.length, 3, '畸形响应不得提交 lastDiag，重新激活必须允许重试');
    const accountADiagnostics = {
      ...acceptanceDiagnostics,
      acceptance_manual_checks: [{
        id: 'account-a-only',
        title: 'A 账号诊断',
        status: 'passed',
        software_evidence_status: 'passed',
      }],
    };
    responses[2].resolve(accountADiagnostics);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(currentToken, null, '当前合法诊断完成必须释放自己的 action token');
    assert.match(status.textContent, /^已更新\(/,
      '经过合同验证的当前诊断结果必须恢复正常状态投影');
    assert.ok(findElement(section.el, element => element.textContent.includes('A 账号诊断')),
      '测试前置必须已把 A 账号诊断绘制到当前分区');

    section.onAccountChanged();
    assert.equal(findElement(section.el, element => element.textContent.includes('A 账号诊断')), null,
      '空闲状态切换到 B 时必须立即清除 A 的诊断快照');
    assert.equal(responses.length, 4,
      '空闲状态切换账号时，当前可见分区也必须立即请求 B 诊断');
    assert.ok(currentToken, 'B 诊断请求必须持有新的 action token');
    responses[3].resolve(acceptanceDiagnostics);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(currentToken, null, 'B 诊断完成必须释放自己的 action token');

  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
}

const [settingsSource, systemSource, aboutSource] = await Promise.all([
  readFile(new URL('../src/web/public/js/pages/settings/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/system.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/about.js', import.meta.url), 'utf8'),
]);

{
  const exportSource = extractFunction(systemSource, 'async function performExportMarkdown()');
  const token = { signal: new AbortController().signal };
  let response = null;
  let downloads = 0;
  let paints = 0;
  const statuses = [];
  const performExportMarkdown = new Function(
    'page',
    'exportBtn',
    'refreshBtn',
    'status',
    'assertBrowserDownloadSupported',
    'api',
    'paint',
    'acceptanceMarkdown',
    'downloadTextFile',
    'isAbortError',
    'errorText',
    'requireSettingsDiagnosticsResult',
    `${exportSource}; return performExportMarkdown;`,
  )(
    {
      beginAction() { return token; },
      alive(candidate) { return candidate === token; },
      endAction(candidate) { return candidate === token; },
    },
    {},
    {},
    { set(message, kind) { statuses.push({ message, kind }); } },
    () => {},
    { async get() { return response; } },
    () => { paints += 1; },
    () => '# fixture',
    () => { downloads += 1; },
    () => false,
    (error, fallback) => error?.message || fallback,
    requireSettingsDiagnosticsResult,
  );

  await performExportMarkdown();
  assert.equal(downloads, 0, '验收诊断接口的 200 + null 不得下载空壳 Markdown');
  assert.equal(paints, 0, '畸形诊断响应不得覆盖当前本机状态展示');
  assert.equal(statuses.at(-1)?.kind, 'err', '畸形诊断响应不得误报导出成功');

  response = acceptanceDiagnostics;
  await performExportMarkdown();
  assert.equal(downloads, 1, '合法 acceptance 诊断载荷必须保留 Markdown 下载');
  assert.equal(paints, 1);
  assert.equal(statuses.at(-1)?.kind, 'ok');

  const staleResponse = deferred();
  const staleToken = { signal: new AbortController().signal };
  let staleAlive = true;
  let staleDownloads = 0;
  let stalePaints = 0;
  let staleEndCalls = 0;
  const performStaleExport = new Function(
    'page',
    'exportBtn',
    'refreshBtn',
    'status',
    'assertBrowserDownloadSupported',
    'api',
    'paint',
    'acceptanceMarkdown',
    'downloadTextFile',
    'isAbortError',
    'errorText',
    'requireSettingsDiagnosticsResult',
    `${exportSource}; return performExportMarkdown;`,
  )(
    {
      beginAction() { return staleToken; },
      alive() { return staleAlive; },
      endAction() { staleEndCalls += 1; },
    },
    {},
    {},
    { set() {} },
    () => {},
    { async get() { return staleResponse.promise; } },
    () => { stalePaints += 1; },
    () => '# stale fixture',
    () => { staleDownloads += 1; },
    () => false,
    (error, fallback) => error?.message || fallback,
    requireSettingsDiagnosticsResult,
  );
  const staleRun = performStaleExport();
  staleAlive = false;
  staleResponse.resolve(acceptanceDiagnostics);
  await staleRun;
  assert.equal(staleDownloads, 0,
    '页面换代后迟到诊断响应不得触发 Markdown 下载');
  assert.equal(stalePaints, 0,
    '页面换代后迟到诊断响应不得重绘本机状态');
  assert.equal(staleEndCalls, 1,
    '迟到导出仍必须只结束自己持有的 action');
}

assert.match(systemSource, /createSettingsSystemOperation\(\)/,
  '本机状态生产分区必须实例化请求协调器');
assert.match(systemSource, /function refresh\(\)\s*\{\s*return diagnosticsOperation\.run\(performRefresh\);\s*\}/,
  '自动刷新与用户刷新必须经过同一个生产协调器');
assert.match(systemSource, /onAccountChanged\(\)[\s\S]*?diagnosticsOperation\.invalidate\(\)/,
  '账号上下文变化必须使生产本机状态单飞请求失效');
assert.match(settingsSource, /unsubscribeState:\s*null/,
  '设置页必须持有 state 订阅的释放函数');
assert.match(settingsSource,
  /store\.subscribe\('state', \(nextState\) => \{[\s\S]*?notifySettingsSectionsStateChanged\(sections, nextState\)/,
  '服务状态延迟到达时必须通过隔离 fan-out 通知各设置分区');
assert.match(settingsSource, /page\.destroy = async[\s\S]*?state\.unsubscribeState\?\.\(\)/,
  '页面销毁必须解除 state 订阅');
assert.match(aboutSource, /onStateChanged\(\)\s*\{\s*paint\(\);\s*\}/,
  '关于分区必须在服务状态到达时重绘');

console.log('web settings system lifecycle tests passed');
