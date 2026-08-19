import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const testFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(testFile), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const outputBase = path.join(root, 'outputs', '.tmp', `scheduler-post-commit-settings-owner-${process.pid}`);
const outputDir = path.join(root, 'outputs', 'scheduler-post-commit-settings-owner');

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

const account = {
  account_id: 'scheduler-owner-identity',
  identity_id: 'scheduler-owner-identity',
  account_fingerprint: 'scheduler-owner-fingerprint',
  name: 'Scheduler owner account',
  mirror: { identity_id: 'scheduler-owner-identity' },
};
const group = { id: 'scheduler-owner-group', name: 'Scheduler owner group' };
const settingsA = {
  settings_revision: 'settings-a',
  scheduler_runtime_revision: 'runtime-a',
  scheduler_schedule_revision: 'schedule-a',
  llm: { base_url: 'https://llm.invalid', api_key: 'test-key', api_key_set: true, model: 'model-a' },
  render: {},
  privacy: { attach_media_content: false },
  groups: { whitelist: [{ account_id: account.account_id, group_id: group.id }] },
  scheduler: {
    enabled: true,
    default_interval: 1000,
    digest_window: 'day',
    min_messages_per_digest: 1,
    per_group: [],
  },
  output_dir: outputDir,
};
const settingsB = {
  ...settingsA,
  settings_revision: 'settings-b',
  scheduler_runtime_revision: 'runtime-b',
  llm: { ...settingsA.llm, model: 'model-b' },
};
const collection = {
  messages: [{ id: 'scheduler-owner-message', time: '2026-08-17 08:00:00', content: 'message' }],
  cursor_messages: [{ id: 'scheduler-owner-message', time: '2026-08-17 08:00:00', content: 'message' }],
  message_count: 1,
  cursor_message_count: 1,
  window_message_count: 1,
  scanned_message_count: 1,
  pre_filter_message_count: 1,
  since: '2026-08-17 00:00:00',
  until: '2026-08-17 23:59:59',
  group_name: group.name,
  source_snapshot: { group_id: group.id },
  filter_active: false,
  truncated: false,
  shard_row_positions: {},
  shard_row_positions_initialized: true,
};

const scenario = {
  settings: settingsA,
  flipAt: 'post',
  saveCalls: 0,
  cursorWrites: 0,
  postBarrierReached: deferred(),
};

const collectorExports = {
  LEGACY_MANUAL_KEY_POLICY: { DENY: 'deny' },
  collectMessages: async () => collection,
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
};

const settingsExports = {
  MAX_SCHEDULER_INTERVAL_MS: 24 * 60 * 60 * 1000,
  durationToMs: value => Number(value) || 1000,
  loadSettings: async () => ({
    ...(scenario.settings === settingsA ? settingsA : settingsB),
    groups: { ...(scenario.settings === settingsA ? settingsA : settingsB).groups },
    scheduler: { ...(scenario.settings === settingsA ? settingsA : settingsB).scheduler },
  }),
  manualKeyAccountFingerprint: value => String(value?.account_fingerprint || '').trim(),
  manualKeyVerifiedForAccount: () => true,
  saveSettingsPatchInTransaction: async patch => ({ ...settingsA, ...patch }),
  withSettingsSaveTransaction: async action => {
    if (scenario.flipAt === 'cursor') scenario.settings = settingsB;
    return action();
  },
};

const outputExports = {
  ensureHistoryArtifactIndexed: async (_settings, item) => item,
  outputFileVersion: async () => 'file-version-a',
  outputFileVersionMatches: () => true,
  recoverHistoryArtifactByDigestId: async () => null,
  saveRenderedPng: async options => {
    scenario.saveCalls++;
    await options.commitBarrier?.();
    if (scenario.flipAt === 'post') scenario.settings = settingsB;
    scenario.postBarrierReached.resolve();
    try {
      await options.postArtifactCommitBarrier?.();
    } catch (error) {
      error.output_commit_barrier_rejected = true;
      throw error;
    }
    const digest = options.digest;
    return {
      digest_id: digest.digest_id,
      file_path: path.join(outputDir, `${digest.digest_id}.png`),
      digest_path: path.join(outputDir, `${digest.digest_id}.json`),
      relative_path: `${digest.digest_id}.png`,
      digest_relative_path: `${digest.digest_id}.json`,
      file_version: 'file-version-a',
      digest_file_version: 'digest-version-a',
      history_item_key: `history:${digest.digest_id}`,
      output_dir_identity: outputDir,
      history_current: true,
    };
  },
};

const renderExports = {
  assertServerPngRenderAvailable: async () => {},
  normalizeRenderOptions: value => value || {},
  renderDigestPngBuffer: async () => Buffer.from('png'),
};

const summarizerExports = {
  summarizeDigest: async () => ({
    digest_id: 'scheduler-owner-digest',
    headline: 'headline',
    topics: [],
    todos: [],
    links: [],
  }),
  sanitizeText: value => String(value ?? ''),
};

const cursorExports = {
  assertCursorSeenListFits: () => {},
  getAccountGroupCursorState: async () => ({}),
  getGroupCursorState: async () => ({}),
  setAccountGroupCursorState: async (_accountId, _groupId, nextState) => {
    scenario.cursorWrites++;
    return nextState;
  },
};

const loggerExports = { logError: () => {}, logInfo: () => {}, logWarn: () => {} };
const pathsExports = {
  DATA_DIR: outputBase,
  OUTPUTS_DIR: path.join(root, 'outputs'),
  OUTPUTS_TMP_DIR: path.join(root, 'outputs', '.tmp'),
  PROJECT_ROOT: root,
  isInside: () => true,
  outputDirFromSettings: () => outputDir,
};
const jsonStoreExports = {
  PRIVATE_FILE_MODE: 0o600,
  readJson: async () => ({}),
  writeJsonAtomic: async () => {},
};
const invalidBackupExports = {
  preserveInvalidFileBackup: async () => ({ backup_path: '', original_path: '', backup_available: false }),
};
const messageCursorExports = {
  MAX_MESSAGE_SHARD_CURSOR_POSITIONS: 128,
  isMessageShardCursorKey: () => false,
  normalizeMessageShardCursorPosition: value => value,
};
const wxKeyExports = { currentWxKeyProcessGeneration: async () => ({ process_generation: 'key-runtime-a' }) };
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

const scheduler = await import(`${sourceUrl('src/daemon/scheduler.js')}?scheduler-post-commit-settings-owner`);
const result = await scheduler.runSchedulerOnce({ reason: 'scheduler_post_commit_settings_owner' });
await scenario.postBarrierReached.promise;

assert.equal(scenario.saveCalls, 1, 'the run must reach the output commit caller');
assert.equal(
  scenario.cursorWrites,
  0,
  'a settings revision change after output commit must not advance the old rule cursor',
);
assert.equal(result.ok, false, 'the old settings result must be rejected after the post-commit revision change');
assert.equal(result.items?.[0]?.detail, 'stale_settings_before_save', 'the caller must expose a stale-settings result');

scenario.settings = settingsA;
scenario.flipAt = 'cursor';
scenario.saveCalls = 0;
scenario.cursorWrites = 0;
scenario.postBarrierReached = deferred();
const cursorLateResult = await scheduler.runSchedulerOnce({ reason: 'scheduler_cursor_settings_owner' });
await scenario.postBarrierReached.promise;
assert.equal(scenario.saveCalls, 1, 'the cursor-window run must reach the output commit caller');
assert.equal(
  scenario.cursorWrites,
  0,
  'a settings revision change after history commit must not advance the old rule cursor',
);
assert.equal(cursorLateResult.ok, false, 'the cursor-window run must remain a failed stale-settings result');
assert.equal(cursorLateResult.items?.[0]?.cursor_commit_failed, true, 'the caller must retain the pending cursor recovery state');

console.log('scheduler post-commit settings owner tests passed');
