import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStore } from '../src/web/public/js/store.js';
import {
  createSettingsAccountContextTracker,
  notifySettingsSectionsAccountChanged,
  notifySettingsSectionsStateChanged,
} from '../src/web/public/js/pages/settings/account-context.js';
import { requireSettingsDocument } from '../src/web/public/js/shared/settings-document.js';

const fingerprintA = 'a'.repeat(64);
const fingerprintB = 'b'.repeat(64);
const accountA = { id: 'account-a', manual_key_account_fingerprint: fingerprintA, display_name: 'A' };
const store = createStore({ account: accountA });
const tracker = createSettingsAccountContextTracker(accountA);
const changes = [];

store.subscribe('account', (account, previous) => {
  const change = tracker.update(account);
  if (change.changed) changes.push({ account, previous, change });
});

store.set('account', { ...accountA, display_name: 'A refreshed' });
assert.equal(changes.length, 0,
  '同账号、同 fingerprint 的新对象快照不得被当成账号切换');

store.set('account', {
  ...accountA,
  display_name: 'A refreshed again',
  account_aliases: ['account-a-alias'],
});
assert.equal(changes.length, 0,
  '展示名或别名刷新不得擦除当前账号草稿');

store.set('account', { ...accountA, manual_key_account_fingerprint: fingerprintB });
assert.equal(changes.length, 1,
  '同一账号 ID 的数据库 fingerprint 变化必须建立新安全上下文');
assert.equal(changes[0].change.previousIdentity, `id:account-a|fingerprint:${fingerprintA}`);
assert.equal(changes[0].change.identity, `id:account-a|fingerprint:${fingerprintB}`);

store.set('account', { id: 'account-b', manual_key_account_fingerprint: fingerprintB });
assert.equal(changes.length, 2, '账号 ID 变化必须广播一次真实切换');

const hookError = new Error('scheduler repaint failed');
const notifiedSections = [];
assert.throws(
  () => notifySettingsSectionsAccountChanged([
    { id: 'groups', onAccountChanged() { notifiedSections.push('groups'); throw hookError; } },
    { id: 'privacy', onAccountChanged() { notifiedSections.push('privacy'); } },
    { id: 'system', onAccountChanged() { notifiedSections.push('system'); } },
  ], accountA, null, changes[0].change),
  error => error === hookError,
  '账号分区异常必须继续上抛给 store 的既有错误边界',
);
assert.deepEqual(notifiedSections, ['groups', 'privacy', 'system'],
  '前一分区重绘失败时，后续隐私分区仍必须清理来源账号敏感草稿');

const stateHookError = new Error('privacy state repaint failed');
const notifiedStateSections = [];
assert.throws(
  () => notifySettingsSectionsStateChanged([
    { id: 'privacy', onStateChanged() { notifiedStateSections.push('privacy'); throw stateHookError; } },
    { id: 'about', onStateChanged() { notifiedStateSections.push('about'); } },
    { id: 'system', onStateChanged() { notifiedStateSections.push('system'); } },
  ], { account_id: 'account-b', output_dir_identity: 'output-b' }),
  error => error === stateHookError,
  '状态分区异常必须继续上抛给 store 的既有错误边界',
);
assert.deepEqual(notifiedStateSections, ['privacy', 'about', 'system'],
  '状态重绘失败时，后续分区仍必须收到目标账号状态通知');

const stateStore = createStore({ state: { revision: 'state-a' } });
const laterStoreListeners = [];
const stateDiagnostics = [];
const originalConsoleError = console.error;
console.error = (...args) => stateDiagnostics.push(args);
try {
  stateStore.subscribe('state', nextState => {
    notifySettingsSectionsStateChanged([
      { onStateChanged() { throw stateHookError; } },
      { onStateChanged() { laterStoreListeners.push(nextState.revision); } },
    ], nextState);
  });
  stateStore.subscribe('state', nextState => laterStoreListeners.push(`store:${nextState.revision}`));
  stateStore.set('state', { revision: 'state-b' });
} finally {
  console.error = originalConsoleError;
}
assert.deepEqual(laterStoreListeners, ['state-b', 'store:state-b'],
  'state subscriber 抛错后，分区 fan-out 与后续 store listener 都必须继续');
assert.equal(stateDiagnostics.length, 1,
  'state subscriber 首个异常必须沿 store 错误边界留下可观测诊断');

const [settingsSource, privacySource] = await Promise.all([
  readFile(new URL('../src/web/public/js/pages/settings/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/privacy.js', import.meta.url), 'utf8'),
]);

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `生产设置页必须包含 ${marker}`);
  const signatureEnd = source.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位的函数签名`);
  const open = signatureEnd + 2;
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

// 设置文档采用也是生产分区 fan-out:首个分区抛错时,后续分区仍必须收到同一
// 文档,但错误要继续返回给初始化/重试边界,不能静默吞掉。
{
  const applySettingsToSectionsSource = extractFunction(
    settingsSource,
    'function applySettingsToSections(',
  );
  const adoptSource = extractFunction(settingsSource, 'function adoptSettingsDocument(');
  const state = {
    settings: null,
    baseRevision: '',
    revisionEpoch: 0,
    drafts: { clear() {} },
  };
  const firstError = new Error('groups repaint failed');
  const applied = [];
  const sections = [
    {
      applySettings(document, options) {
        applied.push(['groups', document.settings_revision, options.preserveDirty]);
        throw firstError;
      },
    },
    {
      applySettings(document, options) {
        applied.push(['privacy', document.settings_revision, options.preserveDirty]);
      },
    },
  ];
  const adoptSettingsDocument = new Function(
    'state', 'sections', 'requireSettingsDocument',
    `${applySettingsToSectionsSource}\n${adoptSource}; return adoptSettingsDocument;`,
  )(state, sections, requireSettingsDocument);

  assert.throws(
    () => adoptSettingsDocument({ settings_revision: 'fanout-revision' }, { preserveDirty: true }),
    error => error === firstError,
    '分区 repaint 异常必须继续交给初始化/重试错误边界',
  );
  assert.deepEqual(applied, [
    ['groups', 'fanout-revision', true],
    ['privacy', 'fanout-revision', true],
  ], '首个分区 repaint 失败时后续分区仍必须收到文档与选项');
}

assert.match(settingsSource,
  /accountContext:\s*createSettingsAccountContextTracker\(store\.get\('account'\)\)/,
  '设置页必须从挂载时账号初始化稳定上下文跟踪器');
assert.match(settingsSource,
  /store\.subscribe\('account', \(account, previous\) => \{[\s\S]*?const change = state\.accountContext\.update\(account\);[\s\S]*?if \(!change\.changed\) return;[\s\S]*?notifySettingsSectionsAccountChanged\(sections, account, previous, change\)/,
  '生产订阅必须过滤同上下文对象刷新，只把真实切换通知分区');
assert.match(settingsSource,
  /store\.subscribe\('state', \(nextState\) => \{[\s\S]*?notifySettingsSectionsStateChanged\(sections, nextState\)/,
  '生产 state subscriber 必须通过隔离 fan-out 通知各设置分区');
assert.match(privacySource,
  /onAccountChanged\(\) \{[\s\S]*?discardManualKeyDraft\(\);[\s\S]*?scanStatus\.clear\(\);[\s\S]*?paintKeyState\(\);/,
  '真实账号切换必须统一清除手动密钥草稿和来源账号扫描状态');
assert.match(privacySource,
  /onStateChanged\(\) \{\s*paintKeyState\(\);\s*\}/,
  '目标账号 state 异步到达后必须重绘密钥与自动扫描状态');

console.log('web settings account context notification tests passed');
