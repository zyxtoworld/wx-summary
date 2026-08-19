import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const dataDir = path.join(root, 'outputs', '.tmp', `scheduler-png-capability-${process.pid}`);

process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = path.relative(root, dataDir);
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = path.relative(root, path.join(dataDir, 'runtime-tmp', 'wxdb'));
process.env.WX_SUMMARY_NO_RUNTIME_FILE = '1';

const account = {
  account_id: 'scheduler-png-account',
  identity_id: 'scheduler-png-account',
  account_fingerprint: 'a'.repeat(64),
  name: 'Scheduler PNG account',
  mirror: { identity_id: 'scheduler-png-account' },
};
const group = { id: 'scheduler-png-group', name: 'Scheduler PNG group' };
const settings = {
  settings_revision: 'scheduler-png-settings',
  scheduler_runtime_revision: 'scheduler-png-runtime',
  scheduler_schedule_revision: 'scheduler-png-schedule',
  llm: { base_url: 'https://llm.invalid', api_key: 'test-key', api_key_set: true, model: 'test-model' },
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
  output_dir: dataDir,
};

let summarizeCalls = 0;
let saveCalls = 0;
let renderCalls = 0;

const collection = {
  messages: [{ id: 'scheduler-png-message', time: '2026-08-17 08:00:00', content: 'message' }],
  cursor_messages: [{ id: 'scheduler-png-message', time: '2026-08-17 08:00:00', content: 'message' }],
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

const collectorExports = {
  LEGACY_MANUAL_KEY_POLICY: { DENY: 'deny' },
  collectMessages: async () => collection,
  dbKeyRuntimeStateVersion: () => 'scheduler-png-key-runtime',
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
  loadSettings: async () => structuredClone(settings),
  manualKeyAccountFingerprint: value => String(value?.account_fingerprint || '').trim().toLowerCase(),
  manualKeyVerifiedForAccount: () => true,
  saveSettingsPatchInTransaction: async patch => ({ ...settings, ...patch }),
  withSettingsSaveTransaction: async action => action(),
};
const outputExports = {
  ensureHistoryArtifactIndexed: async (_settings, item) => item,
  outputFileVersion: async () => 'file-version',
  outputFileVersionMatches: () => true,
  recoverHistoryArtifactByDigestId: async () => null,
  saveRenderedPng: async () => {
    saveCalls++;
    return { ok: true };
  },
};
const renderExports = {
  assertServerPngRenderAvailable: async () => {
    throw Object.assign(new Error('缺少 render-digest.ps1'), {
      status: 501,
      code: 'server_render_script_missing',
      public_code: 'server_render_script_missing',
    });
  },
  normalizeRenderOptions: value => value || {},
  renderDigestPngBuffer: async () => {
    renderCalls++;
    return Buffer.from('png');
  },
};
const summarizerExports = {
  summarizeDigest: async () => {
    summarizeCalls++;
    return { digest_id: 'scheduler-png-digest', headline: 'should not run' };
  },
  sanitizeText: value => String(value ?? ''),
};
const cursorExports = {
  assertCursorSeenListFits: () => {},
  getAccountGroupCursorState: async () => ({}),
  getGroupCursorState: async () => ({}),
  setAccountGroupCursorState: async (_accountId, _groupId, nextState) => nextState,
};
const loggerExports = { logError: () => {}, logInfo: () => {}, logWarn: () => {} };
const pathsExports = {
  DATA_DIR: dataDir,
  OUTPUTS_DIR: path.join(root, 'outputs'),
  OUTPUTS_TMP_DIR: path.join(root, 'outputs', '.tmp'),
  PROJECT_ROOT: root,
  isInside: (parent, candidate) => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  },
  outputDirFromSettings: () => dataDir,
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
const wxKeyExports = { currentWxKeyProcessGeneration: async () => ({ process_generation: 'scheduler-png-key-runtime' }) };
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

const { runSchedulerOnce } = await import(`${sourceUrl('src/daemon/scheduler.js')}?scheduler-png-capability-${process.pid}`);
const result = await runSchedulerOnce({ reason: 'scheduler_png_capability_contract', force: true });

assert.equal(result.ok, false, 'a missing scheduler PNG prerequisite must fail the scheduled run');
assert.equal(result.failed, 1, 'the unavailable PNG target must be reported as one failed target');
assert.equal(result.items?.[0]?.detail, 'scheduler_png_render_unavailable', 'PNG capability failure must use the stable no-retry detail');
assert.equal(result.items?.[0]?.error_code, 'server_render_script_missing', 'the public item must retain the actionable server-render code');
assert.equal(result.items?.[0]?.attempts, 1, 'a capability failure must not enter per-target retry');
assert.equal(summarizeCalls, 0, 'the scheduler must reject before calling the LLM');
assert.equal(renderCalls, 0, 'the scheduler must reject before starting PNG rendering');
assert.equal(saveCalls, 0, 'the scheduler must reject before publishing output');

console.log('scheduler PNG capability contract passed');
