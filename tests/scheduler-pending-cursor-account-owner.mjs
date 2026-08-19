import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const outputBase = path.join(root, 'outputs', `scheduler-pending-account-owner-${process.pid}`);

const accountA = {
  account_id: 'stable-mirror-identity',
  identity_id: 'stable-mirror-identity',
  account_fingerprint: 'fingerprint-a',
  name: 'Account A',
  mirror: { identity_id: 'stable-mirror-identity' },
};
const accountB = {
  ...accountA,
  account_fingerprint: 'fingerprint-b',
  name: 'Account B',
};
const group = { id: 'scheduler-account-group', name: 'Scheduler account group' };
const settings = {
  settings_revision: 'scheduler-account-owner-settings',
  scheduler_runtime_revision: 'scheduler-account-owner-runtime',
  scheduler_schedule_revision: 'scheduler-account-owner-schedule',
  llm: { base_url: 'https://llm.invalid', api_key: 'test-key', api_key_set: true, model: 'test-model' },
  render: {},
  privacy: { attach_media_content: false },
  groups: { whitelist: [{ account_id: accountB.identity_id, group_id: group.id }] },
  scheduler: {
    enabled: true,
    default_interval: 1000,
    digest_window: 'day',
    min_messages_per_digest: 1,
    per_group: [],
  },
  output_dir: outputBase,
};
const cursorKey = `${accountB.account_id}::${group.id}`;
const pendingStoreKey = crypto.createHash('sha256').update(cursorKey).digest('hex');
const pendingEntry = {
  cursor_key: cursorKey,
  cursor_state: {
    last_seq: 'pending-from-account-a',
    seen: ['message-a'],
    rule_fingerprint: '',
    message_count: 1,
  },
  settings_revision: settings.settings_revision,
  rule_fingerprint: '',
  account_id: accountA.account_id,
  account_identity_id: accountA.identity_id,
  account_fingerprint: accountA.account_fingerprint,
  group_id: group.id,
  group: group.name,
  phase: 'saved',
  digest_id: 'pending-account-a-digest',
  output_base_relative: path.relative(root, outputBase),
  file_path: '',
  relative_path: '',
  file_version: '',
  digest_path: '',
  digest_relative_path: '',
  digest_file_version: '',
  history_item_key: 'history:pending-account-a-digest',
  history_item: {
    digest_id: 'pending-account-a-digest',
    history_item_key: 'history:pending-account-a-digest',
    output_dir_identity: outputBase,
    file_path: '',
    digest_path: '',
  },
};
let pendingStore = { [pendingStoreKey]: pendingEntry };
let cursorWrites = 0;
let collectCalls = 0;

const collection = {
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

const collectorExports = {
  LEGACY_MANUAL_KEY_POLICY: { DENY: 'deny' },
  collectMessages: async () => {
    collectCalls++;
    return collection;
  },
  dbKeyRuntimeStateVersion: () => 'key-runtime',
  emptyCollectionMirrorRecheckRecentlyVerified: () => false,
  emptyCollectionMirrorRecheckSummary: () => ({ reason: '' }),
  hasFailedAutoRawKeyScan: async () => false,
  hasVerifiedAutoRawKeys: async () => true,
  listAccounts: async () => [accountB],
  listGroups: async () => [group],
  messageCollectionTargetLastMessageEvidence: () => ({}),
  rememberEmptyCollectionMirrorRecheck: () => {},
  shouldRecheckMirrorForEmptyCollection: () => false,
};
const settingsExports = {
  MAX_SCHEDULER_INTERVAL_MS: 24 * 60 * 60 * 1000,
  durationToMs: value => Number(value) || 1000,
  loadSettings: async () => ({
    ...settings,
    groups: { ...settings.groups },
    scheduler: { ...settings.scheduler },
  }),
  manualKeyAccountFingerprint: value => String(value?.account_fingerprint || '').trim(),
  manualKeyVerifiedForAccount: () => true,
  saveSettingsPatchInTransaction: async patch => ({ ...settings, ...patch }),
  withSettingsSaveTransaction: async action => action(),
};
const outputExports = {
  ensureHistoryArtifactIndexed: async (_settings, item) => item,
  outputFileVersion: async () => 'file-version',
  outputFileVersionMatches: () => true,
  recoverHistoryArtifactByDigestId: async () => pendingEntry.history_item,
  saveRenderedPng: async () => {
    throw new Error('account-owner recovery must finish before a duplicate output save');
  },
};
const renderExports = {
  assertServerPngRenderAvailable: async () => {},
  normalizeRenderOptions: value => value || {},
  renderDigestPngBuffer: async () => Buffer.from('png'),
};
const summarizerExports = {
  summarizeDigest: async () => {
    throw new Error('account-owner recovery must finish before summarization');
  },
  sanitizeText: value => String(value ?? ''),
};
const cursorExports = {
  assertCursorSeenListFits: () => {},
  getAccountGroupCursorState: async () => ({}),
  getGroupCursorState: async () => ({}),
  setAccountGroupCursorState: async (_identityId, _groupId, nextState) => {
    cursorWrites++;
    return nextState;
  },
};
const loggerExports = { logError: () => {}, logInfo: () => {}, logWarn: () => {} };
const pathsExports = {
  DATA_DIR: outputBase,
  OUTPUTS_DIR: path.join(root, 'outputs'),
  OUTPUTS_TMP_DIR: path.join(root, 'outputs', '.tmp'),
  PROJECT_ROOT: root,
  isInside: (parent, candidate) => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  },
  outputDirFromSettings: () => outputBase,
};
const jsonStoreExports = {
  PRIVATE_FILE_MODE: 0o600,
  readJson: async file => String(file).endsWith('scheduler-pending-cursors.json') ? pendingStore : {},
  writeJsonAtomic: async (file, next) => {
    if (String(file).endsWith('scheduler-pending-cursors.json')) pendingStore = next;
  },
};
const invalidBackupExports = {
  preserveInvalidFileBackup: async () => ({ backup_path: '', original_path: '', backup_available: false }),
};
const messageCursorExports = {
  MAX_MESSAGE_SHARD_CURSOR_POSITIONS: 128,
  isMessageShardCursorKey: () => false,
  normalizeMessageShardCursorPosition: value => value,
};
const wxKeyExports = { currentWxKeyProcessGeneration: async () => ({ process_generation: 'key-runtime' }) };
const wxdbExports = { releaseWxDbIsolatedBatchSession: async () => {} };
const wxenvExports = {
  ensureWxDbMirror: async () => ({ refreshed: false, reused: true }),
  isWxDbMirrorIdentityVerified: () => true,
};

mock.module(sourceUrl('src/collector/index.js'), { namedExports: collectorExports });
mock.module(sourceUrl('src/config/settings.js'), { namedExports: settingsExports });
mock.module(sourceUrl('src/renderer/output.js'), { namedExports: outputExports });
mock.module(sourceUrl('src/renderer/server-png.js'), { namedExports: renderExports });
mock.module(sourceUrl('src/summarizer/llm.js'), { namedExports: summarizerExports });
mock.module(sourceUrl('src/store/cursors.js'), { namedExports: cursorExports });
mock.module(sourceUrl('src/lib/logger.js'), { namedExports: loggerExports });
mock.module(sourceUrl('src/lib/paths.js'), { namedExports: pathsExports });
mock.module(sourceUrl('src/lib/json-store.js'), { namedExports: jsonStoreExports });
mock.module(sourceUrl('src/lib/invalid-backup.js'), { namedExports: invalidBackupExports });
mock.module(sourceUrl('src/lib/message-shard-cursor.js'), { namedExports: messageCursorExports });
mock.module(sourceUrl('src/wxkey/index.js'), { namedExports: wxKeyExports });
mock.module(sourceUrl('src/wxdb/isolated.js'), { namedExports: wxdbExports });
mock.module(sourceUrl('src/wxenv/discovery.js'), { namedExports: wxenvExports });

const scheduler = await import(`${sourceUrl('src/daemon/scheduler.js')}?scheduler-pending-cursor-account-owner`);
const ruleFingerprint = scheduler.__schedulerInternals.schedulerRuleFingerprint({
  digest_window: settings.scheduler.digest_window,
  keywords: [],
  min_messages: settings.scheduler.min_messages_per_digest,
});
pendingStore[pendingStoreKey].cursor_state.rule_fingerprint = ruleFingerprint;
pendingStore[pendingStoreKey].rule_fingerprint = ruleFingerprint;

await fsp.mkdir(outputBase, { recursive: true });
const result = await scheduler.runSchedulerOnce({
  reason: 'scheduler_pending_cursor_account_owner',
  force: true,
});

assert.equal(
  cursorWrites,
  0,
  'a pending cursor from fingerprint A must not advance the same-ID fingerprint B account',
);
assert.equal(collectCalls, 0, 'an account-owner mismatch must stop before a duplicate collection');
assert.equal(result.items?.[0]?.detail, 'pending_history_recovery_failed', 'the mismatch must remain an explicit recoverable failure');
assert.match(result.items?.[0]?.error || '', /另一数据指纹/, 'the failure must explain the account fingerprint mismatch');
assert.ok(pendingStore[pendingStoreKey], 'the mismatched pending record must remain for the correct account context');

delete pendingStore[pendingStoreKey].account_fingerprint;
const missingFingerprintResult = await scheduler.runSchedulerOnce({
  reason: 'scheduler_pending_cursor_account_owner_missing_fingerprint',
  force: true,
});
assert.equal(cursorWrites, 0, 'a legacy pending record without a fingerprint must remain blocked');
assert.match(missingFingerprintResult.items?.[0]?.error || '', /缺少账号数据指纹/, 'a missing fingerprint must be explicit and fail closed');
pendingStore[pendingStoreKey].account_fingerprint = accountA.account_fingerprint;
accountB.account_fingerprint = accountA.account_fingerprint;
const sameFingerprintResult = await scheduler.runSchedulerOnce({
  reason: 'scheduler_pending_cursor_account_owner_same_fingerprint',
  force: true,
});
assert.equal(cursorWrites, 1, 'the same account fingerprint may recover and commit the pending cursor');
assert.equal(sameFingerprintResult.recovered, 1, 'the matching account context must report one recovered pending cursor');
assert.equal(collectCalls, 0, 'a matching pending recovery must still avoid duplicate collection');
assert.equal(pendingStore[pendingStoreKey], undefined, 'a confirmed matching recovery must consume its pending record');
await fsp.rm(outputBase, { recursive: true, force: true });

console.log('scheduler pending cursor account-owner tests passed');
