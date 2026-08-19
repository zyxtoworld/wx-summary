import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { saveLegacyManualKeyForAccount } from '../src/config/settings.js';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/setup');
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
const { manualKeyInvalidMessage, normalizeManualKeysText } = await createBrowserModuleLoader().load('js/pages/setup/state.js');

const projectRoot = path.resolve(import.meta.dirname, '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'src', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

const migrationStart = mainSource.indexOf('} else if (legacyManualCandidateVerified && !savedManualCandidateVerified) {');
const fullCoverageStart = mainSource.indexOf('if (messageDbVerified) {', migrationStart);
const migrationEnd = mainSource.indexOf('} else {', fullCoverageStart);
const migrationBranch = mainSource.slice(migrationStart, migrationEnd);
const sampleOnlyBranch = mainSource.slice(mainSource.indexOf('if (!messageDbVerified)', migrationStart), fullCoverageStart);

assert.ok(migrationBranch.includes('if (!messageDbVerified)'), 'legacy key migration must branch on full message-shard coverage before any settings write');
assert.ok(migrationBranch.includes('manual_key_legacy_migration_deferred'), 'sample-only validation should report that migration was deliberately deferred');
assert.ok(!sampleOnlyBranch.includes('saveLegacyManualKeyForAccount'), 'the sample-only branch must not persist or scope the legacy key');
assert.ok(mainSource.includes('if (messageDbVerified) {\n              verifiedManualKeySettings = await saveLegacyManualKeyForAccount({'), 'the settings mutation must only run inside the full-coverage branch');
const normalized = normalizeManualKeysText(`无效候选\n${'b'.repeat(64)}`);
assert.deepEqual(normalized.keys, ['b'.repeat(64)]);
assert.match(manualKeyInvalidMessage({ invalid: ['无效候选'] }), /不会回显原文/,
  'the setup UI must report invalid manual-key fragments without leaking their contents');

const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wx-summary-legacy-key-transaction-'));
try {
  await assert.rejects(
    () => saveLegacyManualKeyForAccount({
      account_id: 'wxacc_sample_only',
      account_fingerprint: 'a'.repeat(64),
      expected_manual_key_text: 'b'.repeat(64),
      message_db_verified: false,
      settingsFile: path.join(tempDir, 'settings.json'),
      secretsFile: path.join(tempDir, 'secrets.enc.json'),
    }),
    error => error?.status === 428 && error?.code === 'manual_key_full_validation_required',
    'the persistence API itself must reject sample-only migration even if a future caller bypasses the route guard',
  );
  assert.equal(fs.existsSync(path.join(tempDir, 'settings.json')), false, 'rejected sample-only migration must not create settings files');
  assert.equal(fs.existsSync(path.join(tempDir, 'secrets.enc.json')), false, 'rejected sample-only migration must not create secret files');
} finally {
  await fs.promises.rm(tempDir, { recursive: true, force: true });
}

console.log('legacy manual key migration transaction contract passed');
