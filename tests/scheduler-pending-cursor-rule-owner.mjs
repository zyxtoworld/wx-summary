import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputBase = path.join(root, 'outputs', `scheduler-pending-rule-owner-${process.pid}`);
const outputFile = path.join(outputBase, 'pending-rule.png');
const digestFile = path.join(outputBase, 'pending-rule.json');
const account = {
  account_id: 'identity-a',
  account_fingerprint: 'fingerprint-a',
  name: 'Account A',
  mirror: { identity_id: 'identity-a' },
};
const group = { id: 'group-a', name: 'Group A' };
const settings = {
  settings_revision: 'settings-a',
  scheduler_runtime_revision: 'runtime-a',
  scheduler_schedule_revision: 'schedule-a',
  llm: { base_url: 'https://llm.invalid', api_key: 'test-key', api_key_set: true, model: 'test-model' },
  render: {},
  privacy: { attach_media_content: false },
  groups: { whitelist: [{ account_id: 'identity-a', group_id: 'group-a' }] },
  scheduler: {
    enabled: true,
    default_interval: 1000,
    digest_window: 'day',
    min_messages_per_digest: 1,
    per_group: [],
  },
  output_dir: outputBase,
};
const cursorKey = 'identity-a::group-a';
const pendingStoreKey = crypto.createHash('sha256').update(cursorKey).digest('hex');
const pendingCursorState = {
  last_seq: 'cursor-from-unknown-rule',
  seen: ['message-a'],
  rule_fingerprint: 'rule-from-unknown-generation',
  message_count: 1,
};
const pendingEntry = {
  cursor_key: cursorKey,
  cursor_state: pendingCursorState,
  account_id: account.account_id,
  account_identity_id: account.mirror.identity_id,
  group_id: group.id,
  phase: 'saved',
  digest_id: 'digest-from-unknown-rule',
  output_base_relative: path.relative(root, outputBase),
  file_path: outputFile,
  relative_path: 'pending-rule.png',
  file_version: 'file-version-a',
  digest_path: digestFile,
  digest_relative_path: 'pending-rule.json',
  digest_file_version: 'digest-version-a',
  history_item: {
    digest_id: 'digest-from-unknown-rule',
    file_path: outputFile,
    relative_path: 'pending-rule.png',
    output_dir_identity: outputBase,
    digest_path: digestFile,
    digest_relative_path: 'pending-rule.json',
    saved_file_version: 'file-version-a',
    saved_digest_file_version: 'digest-version-a',
    history_item_key: 'history:pending-rule',
  },
};
let pendingStore = { [pendingStoreKey]: pendingEntry };
let cursorWriteCount = 0;
let collectCount = 0;

const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;

mock.module(sourceUrl('src/collector/index.js'), { namedExports: {
  LEGACY_MANUAL_KEY_POLICY: { DENY: 'deny' },
  collectMessages: async () => {
    collectCount += 1;
    return {
      messages: [],
      cursor_messages: [],
      message_count: 0,
      cursor_message_count: 0,
      window_message_count: 0,
      scanned_message_count: 0,
      pre_filter_message_count: 0,
      since: '2026-08-17 00:00:00',
      until: '2026-08-17 23:59:59',
      group_name: group.name,
      source_snapshot: { group_id: group.id },
      filter_active: false,
      truncated: false,
      shard_row_positions: {},
      shard_row_positions_initialized: true,
    };
  },
  dbKeyRuntimeStateVersion: () => 'key-runtime-a',
  emptyCollectionMirrorRecheckRecentlyVerified: () => false,
  emptyCollectionMirrorRecheckSummary: () => ({ reason: '' }),
  hasFailedAutoRawKeyScan: async () => false,
  hasVerifiedAutoRawKeys: async () => true,
  listAccounts: async () => [account],
  listGroups: async () => [group],
  messageCollectionTargetLastMessageEvidence: () => ({}),
  rememberEmptyCollectionMirrorRecheck: () => {},
  shouldRecheckMirrorForEmptyCollection: () => false,
} });
mock.module(sourceUrl('src/config/settings.js'), { namedExports: {
  MAX_SCHEDULER_INTERVAL_MS: 24 * 60 * 60 * 1000,
  durationToMs: value => Number(value) || 1000,
  loadSettings: async () => ({ ...settings, groups: { ...settings.groups }, scheduler: { ...settings.scheduler } }),
  manualKeyAccountFingerprint: value => String(value?.account_fingerprint || '').trim(),
  manualKeyVerifiedForAccount: () => true,
  saveSettingsPatchInTransaction: async patch => ({ ...settings, ...patch }),
  withSettingsSaveTransaction: async action => action(),
} });
mock.module(sourceUrl('src/renderer/output.js'), { namedExports: {
  ensureHistoryArtifactIndexed: async (_settings, item) => item,
  outputFileVersion: async () => 'file-version-a',
  outputFileVersionMatches: () => true,
  recoverHistoryArtifactByDigestId: async () => null,
  saveRenderedPng: async () => { throw new Error('recovery must finish before a new output save'); },
} });
mock.module(sourceUrl('src/renderer/server-png.js'), { namedExports: {
  assertServerPngRenderAvailable: async () => {},
  normalizeRenderOptions: value => value || {},
  renderDigestPngBuffer: async () => Buffer.from('png'),
} });
mock.module(sourceUrl('src/summarizer/llm.js'), { namedExports: {
  summarizeDigest: async () => { throw new Error('recovery must finish before summarization'); },
  sanitizeText: value => String(value ?? ''),
} });
mock.module(sourceUrl('src/store/cursors.js'), { namedExports: {
  assertCursorSeenListFits: () => {},
  getAccountGroupCursorState: async () => ({}),
  getGroupCursorState: async () => ({}),
  setAccountGroupCursorState: async (_identityId, _groupId, nextState) => {
    cursorWriteCount += 1;
    return nextState;
  },
} });
mock.module(sourceUrl('src/lib/logger.js'), { namedExports: { logError: () => {}, logInfo: () => {}, logWarn: () => {} } });
mock.module(sourceUrl('src/lib/paths.js'), { namedExports: {
  DATA_DIR: outputBase,
  OUTPUTS_DIR: path.join(root, 'outputs'),
  OUTPUTS_TMP_DIR: path.join(root, 'outputs', '.tmp'),
  PROJECT_ROOT: root,
  isInside: (parent, candidate) => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  },
  outputDirFromSettings: () => outputBase,
} });
mock.module(sourceUrl('src/lib/json-store.js'), { namedExports: {
  PRIVATE_FILE_MODE: 0o600,
  readJson: async file => String(file).endsWith('scheduler-pending-cursors.json') ? pendingStore : {},
  writeJsonAtomic: async (file, next) => {
    if (String(file).endsWith('scheduler-pending-cursors.json')) pendingStore = next;
  },
} });
mock.module(sourceUrl('src/lib/invalid-backup.js'), { namedExports: {
  preserveInvalidFileBackup: async file => ({ original_path: file, backup_path: '', backup_available: false, original_preserved: true }),
} });
mock.module(sourceUrl('src/lib/message-shard-cursor.js'), { namedExports: {
  MAX_MESSAGE_SHARD_CURSOR_POSITIONS: 128,
  isMessageShardCursorKey: () => false,
  normalizeMessageShardCursorPosition: value => value,
} });
mock.module(sourceUrl('src/wxkey/index.js'), { namedExports: { currentWxKeyProcessGeneration: async () => ({ process_generation: 'key-runtime-a' }) } });
mock.module(sourceUrl('src/wxdb/isolated.js'), { namedExports: { releaseWxDbIsolatedBatchSession: async () => {} } });
mock.module(sourceUrl('src/wxenv/discovery.js'), { namedExports: {
  ensureWxDbMirror: async () => ({ refreshed: false, reused: true }),
  isWxDbMirrorIdentityVerified: () => true,
} });

await fsp.mkdir(outputBase, { recursive: true });
await fsp.writeFile(outputFile, 'pending output', 'utf8');
await fsp.writeFile(digestFile, '{}', 'utf8');
try {
  const scheduler = await import(`${sourceUrl('src/daemon/scheduler.js')}?scheduler-pending-cursor-rule-owner`);
  const result = await scheduler.runSchedulerOnce({ reason: 'pending_cursor_rule_owner', force: true });
  assert.equal(
    cursorWriteCount,
    0,
    'a pending output without a verifiable rule fingerprint must not commit its cursor under the current rule',
  );
  assert.equal(
    result.recovered,
    0,
    'an unverifiable pending rule must not be reported as recovered output',
  );
  assert.ok(
    pendingStore[pendingStoreKey],
    'an unverifiable pending record must remain available for explicit recovery instead of being discarded',
  );
  assert.equal(collectCount, 0, 'an unverifiable recovery must stop before a duplicate current generation');
  console.log('scheduler pending cursor rule-owner tests passed');
} finally {
  await fsp.rm(outputBase, { recursive: true, force: true });
}
