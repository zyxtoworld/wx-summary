import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSettingsDraftState } from '../src/web/public/js/pages/settings/draft-state.js';
import { restoreSettingsTransientFocus } from '../src/web/public/js/pages/settings/focus.js';

const dirtyChanges = [];
const drafts = createSettingsDraftState({
  onDirtyChange: sectionId => dirtyChanges.push(sectionId),
});

assert.equal(drafts.hasUnsaved(), false);
drafts.markDirty('ai', true);
assert.equal(drafts.hasUnsaved(), true);
assert.equal(drafts.dirtyCount(), 1);
assert.equal(drafts.isDirty('ai'), true);
drafts.markAccountScoped('manual-key', true);
assert.equal(drafts.accountScopedCount(), 1);
drafts.markDirty('ai', false);
assert.equal(drafts.hasUnsaved(), true, '账号级密钥草稿必须独立保持整页脏态');
assert.deepEqual(dirtyChanges, ['ai', 'ai']);
drafts.clear();
assert.equal(drafts.hasUnsaved(), false, '显式放弃并刷新必须清空普通草稿与账号级草稿');
assert.equal(drafts.accountScopedCount(), 0);

const body = { id: 'body' };
const owner = { id: 'transient-action' };
const explicit = { id: 'other-control', isConnected: true };
const focusCalls = [];
const heading = {
  isConnected: true,
  disabled: false,
  focus(options) { focusCalls.push(options); },
};

assert.equal(restoreSettingsTransientFocus({
  shouldRestore: true,
  owner,
  fallback: heading,
  activeElement: explicit,
  body,
}), false, '用户已主动移动焦点时不得抢回');
assert.equal(restoreSettingsTransientFocus({
  shouldRestore: true,
  owner,
  fallback: heading,
  activeElement: body,
  body,
}), true, '临时按钮消失导致焦点回到 body 时必须聚焦稳定标题');
assert.deepEqual(focusCalls, [{ preventScroll: true }]);

const focusCallsBeforeInactive = focusCalls.length;
assert.equal(restoreSettingsTransientFocus({
  shouldRestore: true,
  owner,
  fallback: heading,
  activeElement: body,
  body,
  isActive: () => false,
}), false, '页面卸载后不得把焦点恢复到仍连接的旧设置标题');
assert.equal(focusCalls.length, focusCallsBeforeInactive,
  '非活跃设置页不得产生焦点写入');

const [settingsSource, privacySource] = await Promise.all([
  readFile(new URL('../src/web/public/js/pages/settings/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/privacy.js', import.meta.url), 'utf8'),
]);

assert.match(settingsSource, /drafts:\s*createSettingsDraftState\(/,
  '设置页生产状态必须接入统一草稿生命周期');
assert.doesNotMatch(settingsSource, /state\.(?:dirty|accountDrafts)/,
  '跨标签同步、离开与账号切换不得再维护两套散落草稿判断');
assert.ok((settingsSource.match(/hasUnsavedDrafts\(\)/g) || []).length >= 6,
  '跨标签探测、通知、刷新、离开和账号切换必须共享同一脏态判断');
assert.match(settingsSource, /if \(!preserveDirty\)[\s\S]*?state\.drafts\.clear\(\)/,
  '明确采用服务端文档时必须统一清空草稿登记');
assert.match(privacySource, /function discardManualKeyDraft\([\s\S]*?keyInput\.value = ''[\s\S]*?validatedKey = null[\s\S]*?markAccountScopedDraft/,
  '明确放弃草稿时必须同时清空手动密钥输入、验证结果和账号级登记');
assert.match(settingsSource, /restoreSettingsTransientFocus\(\{[\s\S]*?fallback: pageTitle/,
  '首次重试和通知条刷新移除临时按钮后必须通过稳定标题恢复焦点');
assert.match(settingsSource, /restoreSettingsTransientFocus\(\{[\s\S]*?fallback: pageTitle[\s\S]*?isActive: \(\) => !state\.destroyed/,
  '设置页焦点回调必须绑定页面活跃状态,避免卸载后回焦旧标题');
assert.match(settingsSource, /finally \{[\s\S]*?endAction\(token\);[\s\S]*?trigger\.disabled = isBusy\(\);[\s\S]*?restoreActionFocus\(token\.focusTarget/,
  '页外重试与通知按钮必须在动作结束后按剩余忙态重新启用，失败时恢复到原按钮');

console.log('web settings cross-tab draft lifecycle tests passed');
