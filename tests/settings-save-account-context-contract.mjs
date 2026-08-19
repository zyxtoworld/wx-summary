import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

globalThis.location = new URL('http://wx-summary.test/');
globalThis.history = { state: null, replaceState() {} };
globalThis.document = { title: '' };
globalThis.sessionStorage = new MemoryStorage();
globalThis.localStorage = new MemoryStorage();

const loader = createBrowserModuleLoader();
const { settingsRequestContext } = await loader.load('js/pages/settings/core.js');
const { wizardAccountRequestContext } = await loader.load('js/pages/setup/state.js');
const {
  createSettingsWriteCoordinator,
  writeSettingsPatch,
} = await loader.load('js/shared/settings-write-coordinator.js');

const projectRoot = path.resolve(import.meta.dirname, '..');
const coreSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'pages', 'settings', 'core.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'pages', 'settings', 'index.js'), 'utf8');
const setupStateSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'pages', 'setup', 'state.js'), 'utf8');
const setupKeySource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'pages', 'setup', 'step-key.js'), 'utf8');
const setupFinishSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'pages', 'setup', 'step-finish.js'), 'utf8');
const privacySource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'pages', 'settings', 'privacy.js'), 'utf8');
const schedulerSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'pages', 'settings', 'scheduler.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(projectRoot, 'src', 'main.js'), 'utf8');

assert.match(coreSource, /export function settingsRequestContext\(account\)[\s\S]*?account_id[\s\S]*?account_aliases[\s\S]*?account_fingerprint[\s\S]*?expected_account_fingerprint/, '设置保存必须携带当前账号及其指纹上下文');
const fingerprint = 'a'.repeat(64);
const account = {
  id: 'wxid-settings-contract',
  account_aliases: ['legacy-settings-contract'],
  manual_key_account_fingerprint: fingerprint,
};
const expectedContext = {
  account_id: account.id,
  account_aliases: [account.id, 'legacy-settings-contract'],
  account_fingerprint: fingerprint,
  expected_account_fingerprint: fingerprint,
};
assert.deepEqual(settingsRequestContext(account), expectedContext, '设置页账号上下文必须包含 ID、别名和精确指纹');
assert.deepEqual(
  wizardAccountRequestContext({ account }).body._request_context,
  expectedContext,
  'Setup 必须生成与 Settings 相同的账号写上下文',
);

let submittedBody = null;
const api = {
  get: async () => ({ settings_revision: 'revision-after-lock' }),
  request: async (_path, options) => {
    submittedBody = options.body;
    return {
      ok: true,
      settings: { settings_revision: 'revision-after-save' },
      settings_revision: 'revision-after-save',
    };
  },
};
await writeSettingsPatch({
  api,
  patch: { privacy: { redact_names: true }, _request_context: expectedContext },
  coordinator: createSettingsWriteCoordinator({ locks: null }),
});
assert.equal(submittedBody.base_settings_revision, 'revision-after-lock', '设置保存必须绑定拿锁后读取的最新 revision');
assert.deepEqual(submittedBody._request_context, expectedContext, '跨标签协调不得丢失账号写上下文');
assert.match(settingsSource, /error\?\.status === 428[\s\S]*?markStale\(\)[\s\S]*?error\?\.status === 409[\s\S]*?markStale\(/, '设置版本冲突必须转为可恢复的过期提示');
assert.match(settingsSource, /adoptSaveResult\(result, ownerToken\)/,
  '设置保存成功后必须采用服务端返回的最新文档并把身份升级绑定原 action owner');
assert.match(settingsSource,
  /const identityUpgrade = token\?\.accountIdentityUpgrade[\s\S]*?const owned = completeSettingsAction\([\s\S]*?if \(owned && identityUpgrade\) void refreshSavedAccountIdentity\(identityUpgrade\)/,
  '账号身份刷新只能在原保存 action 首次真实交还后启动，旧 finally 不得重复或提前刷新');
assert.match(settingsSource,
  /refreshPublicAccountIdentityUpgrade\(result,[\s\S]*?refreshAccounts:\s*ctx\.refreshAccounts/,
  '设置保存返回账号身份升级证明时必须复用共享协调器刷新公开账号快照');
assert.match(mainSource,
  /account_identity_upgrade:\s*settingsIdentityUpgrade[\s\S]*?account_id:\s*responseIdentityUpgradeAccount\?\.account_id[\s\S]*?account_fingerprint:\s*responseIdentityUpgradeAccount\?\.manual_key_account_fingerprint[\s\S]*?account:\s*responseIdentityUpgradeAccount/,
  '设置保存身份升级响应必须回显共享证明校验所需的账号 ID、fingerprint 与公开账号对象');
assert.match(privacySource, /const context = page\.requestContext\(currentAccount\(\)\)[\s\S]*?page\.saveSection\(/, '隐私与手动密钥保存必须使用当前账号上下文');
assert.match(schedulerSource, /const context = page\.requestContext\(currentAccount\(\)\)[\s\S]*?page\.saveSection\(/, '调度保存必须使用当前账号上下文');

assert.match(setupStateSource, /export function wizardAccountRequestContext\(wiz[\s\S]*?account_fingerprint[\s\S]*?expected_account_fingerprint/, '配置向导保存必须生成账号指纹请求上下文');
assert.match(setupKeySource, /wizardAccountRequestContext\(wiz\)[\s\S]*?expected_account_fingerprint/, '向导数据库密钥验证必须绑定账号指纹');
assert.match(setupFinishSource, /const accountId = accountIdOf\(wiz\.account\)[\s\S]*?\/api\/state\?refresh=1[\s\S]*?account=\$\{encodeURIComponent\(accountId\)\}/, '向导完成步骤必须按当前账号复核配置状态');

console.log('settings save account context contract passed');
