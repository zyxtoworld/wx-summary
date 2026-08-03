import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { __collectorInternals, legacyManualKeyBindingFromResult } from '../src/collector/index.js';
import { __mainInternals } from '../src/main.js';

const ROOT = process.cwd();

function runtimeSettings() {
  return {
    llm: {
      provider: 'openai',
      base_url: 'https://example.invalid/v1',
      model: 'model-a',
      api_key: 'api-key',
      temperature: 0.2,
    },
    wechat: {
      manual_key_set: true,
      manual_key_legacy_set: true,
      manual_key: 'a'.repeat(64),
      manual_key_account_ids: [],
      manual_key_verified_account_ids: [],
      manual_keys_by_account: {},
      manual_key_verified_account_fingerprints_by_account: {},
    },
    privacy: {},
    link_preview: {},
    render: {},
    output: {},
  };
}

async function main() {
  const before = runtimeSettings();
  const migrated = structuredClone(before);
  migrated.wechat.manual_keys_by_account.account_a = before.wechat.manual_key;
  migrated.wechat.manual_key_account_ids = ['account_a'];
  migrated.wechat.manual_key_verified_account_ids = ['account_a'];
  migrated.wechat.manual_key_verified_account_fingerprints_by_account.account_a = 'f'.repeat(64);
  assert.equal(
    __mainInternals.digestRuntimeSettingsChanged(before, migrated),
    false,
    'moving an already-used access key into account-scoped storage must not invalidate generated output',
  );

  const changedModel = structuredClone(before);
  changedModel.llm.model = 'model-b';
  assert.equal(__mainInternals.digestRuntimeSettingsChanged(before, changedModel), true);

  const legacyCandidateCapability = __mainInternals.wechatKeyCapability(before, {
    accountId: 'account_a',
    platform: 'darwin',
  });
  assert.equal(legacyCandidateCapability.manual_key_legacy_candidate_available, true);
  assert.equal(legacyCandidateCapability.manual_key_required, false, 'a legacy candidate should be tried automatically before asking the user to re-enter it');

  const collectorSource = await fsp.readFile(path.join(ROOT, 'src', 'collector', 'index.js'), 'utf8');
  assert.ok(!collectorSource.includes('saveLegacyManualKeyForAccount'));
  assert.ok(collectorSource.includes('legacyManualKeyBindingAfterVerifiedUse'));
  assert.ok(collectorSource.includes('attachLegacyManualKeyBinding(result, binding)'));
  assert.ok(collectorSource.includes('export function legacyManualKeyBindingFromResult'));

  const rawKeyText = 'b'.repeat(64);
  const collection = { messages: [] };
  __collectorInternals.attachLegacyManualKeyBinding(collection, {
    account_id: 'account_a',
    account_aliases: ['account_a'],
    account_fingerprint: 'f'.repeat(64),
    expected_manual_key_text: rawKeyText,
    message_db_verified: true,
    message_db_checked_count: 2,
    message_db_total_count: 2,
  });
  assert.equal(legacyManualKeyBindingFromResult(collection)?.expected_manual_key_text, rawKeyText);
  assert.equal(Object.keys(collection).includes('__legacy_manual_key_binding'), false);
  assert.equal(JSON.stringify(collection).includes(rawKeyText), false, 'deferred key bindings must never leak through API/log serialization');

  const mainSource = await fsp.readFile(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const runtimePayloadSource = mainSource.slice(
    mainSource.indexOf('function digestRuntimeSettingsPayload'),
    mainSource.indexOf('function exportPolicySettingsPayload'),
  );
  assert.ok(!runtimePayloadSource.includes('wechat:'));
  assert.ok(mainSource.includes('registerDigestBatchLegacyManualKeyBinding(batchId, collection)'));
  const finishRoute = mainSource.slice(
    mainSource.indexOf("if (pathname === '/api/digest-batch-finish'"),
    mainSource.indexOf("if (pathname === '/api/digest-batch-heartbeat'"),
  );
  assert.ok(finishRoute.includes('await commitDigestBatchLegacyManualKeyBindings(batchId)'));
  assert.ok(finishRoute.indexOf('await commitDigestBatchLegacyManualKeyBindings(batchId)') < finishRoute.indexOf('releaseFinishedDigestBatchLease(batchId)'));

  assert.ok(mainSource.includes("pathname === '/api/wechat/status' && req.method === 'POST'"));
  assert.ok(!mainSource.includes("pathname === '/api/wechat/status' && (req.method === 'GET' || req.method === 'POST')"));
  const sideEffectGetSource = mainSource.slice(
    mainSource.indexOf('function sideEffectGetRequiresFreshFrontendAsset'),
    mainSource.indexOf('async function assertFreshFrontendAsset'),
  );
  assert.ok(!sideEffectGetSource.includes("'/api/wechat/status'"));

  const appSource = await fsp.readFile(path.join(ROOT, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(appSource.includes("pathname === '/api/wechat/status' && requestMethod === 'POST'"));
  assert.ok(!appSource.includes("pathname === '/api/wechat/status' && ['GET', 'POST'].includes(requestMethod)"));
  const statusCallCount = (appSource.match(/api\(`\/api\/wechat\/status\?\$\{query\.toString\(\)\}`,/g) || []).length;
  const statusPostCallCount = (appSource.match(/api\(`\/api\/wechat\/status\?\$\{query\.toString\(\)\}`,\s*\{\s*method: 'POST'/g) || []).length;
  assert.ok(statusCallCount >= 5, 'all automatic, settings, and setup key-verification calls should be covered');
  assert.equal(statusPostCallCount, statusCallCount, 'every key-verification request must be tracked as a mutation');
  assert.ok(appSource.includes('验证只在自动准备的项目副本上进行'));
  assert.ok(!appSource.includes('它不会自动绑定当前账号，当前账号读取依赖自动扫描'));

  console.log('legacy key batch migration contract tests passed');
}

await main();
