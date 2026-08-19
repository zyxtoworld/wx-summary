import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const testFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(testFile), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const outputBase = path.join(root, 'outputs', '.tmp', 'scheduler-stale-progress-writeback');
const publishedOutput = path.join(root, 'outputs', 'scheduler-stale-progress-writeback');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createFakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay, ...args) {
      const id = nextId++;
      timers.set(id, { callback, delay, args });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    takeNext() {
      const next = timers.keys().next();
      assert.equal(next.done, false, 'fake clock must have a scheduled callback');
      return next.value;
    },
    async fire(id) {
      const timer = timers.get(id);
      assert.ok(timer, `fake clock timer ${id} must still be scheduled`);
      timers.delete(id);
      timer.callback(...timer.args);
      await Promise.resolve();
      await Promise.resolve();
    },
    pendingCount() {
      return timers.size;
    },
  };
}

const account = {
  account_id: 'identity-a',
  identity_id: 'identity-a',
  account_fingerprint: 'fingerprint-a',
  name: 'Account A',
  mirror: { identity_id: 'identity-a' },
};
const accountB = {
  ...account,
  account_fingerprint: 'fingerprint-b',
  name: 'Account B',
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
  output_dir: publishedOutput,
};

const collection = () => ({
  messages: [{ id: 'message-a', time: '2026-08-17 08:00:00', content: 'message' }],
  cursor_messages: [{ id: 'message-a', time: '2026-08-17 08:00:00', content: 'message' }],
  message_count: 1,
  cursor_message_count: 1,
  window_message_count: 1,
  scanned_message_count: 1,
  pre_filter_message_count: 1,
  since: '2026-08-17 00:00:00',
  until: '2026-08-17 23:59:59',
  group_name: 'Group A',
  source_snapshot: { group_id: 'group-a' },
  filter_active: false,
  truncated: false,
  shard_row_positions: {},
  shard_row_positions_initialized: true,
});

let scenario = null;

function newScenario(stage) {
  return {
    stage,
    role: 'A',
    aProgress: null,
    bProgress: null,
    aStageStarted: deferred(),
    releaseA: deferred(),
    aSessionCloseStarted: deferred(),
    releaseASession: deferred(),
    aBatchId: '',
    bCollectStarted: deferred(),
    releaseBCollect: deferred(),
    bPersisted: deferred(),
    bCommitted: deferred(),
    savedCount: 0,
    savedRoles: [],
    cursorWriteCount: 0,
    cursorWriteRoles: [],
    runtimePersistStarted: deferred(),
    releaseRuntimePersist: deferred(),
    runtimePersistPayloads: [],
    accountChanged: false,
    digestId: `digest-${stage}`,
  };
}

const collectorExports = {
  LEGACY_MANUAL_KEY_POLICY: { DENY: 'deny' },
  collectMessages: async options => {
    assert.ok(scenario, 'scheduler caller must be attached to a scenario');
    if (scenario.role === 'A') {
      scenario.aBatchId = options.batch_id;
      scenario.aProgress = options.onProgress;
      if (scenario.stage === 'collect' || scenario.stage === 'account') {
        scenario.aStageStarted.resolve();
        await scenario.releaseA.promise;
      }
      return collection();
    }
    scenario.bProgress = options.onProgress;
    scenario.bCollectStarted.resolve();
    options.onProgress?.({ phase: 'collect', label: 'B current progress', detail: 'current B', group: 'Group B' });
    await scenario.releaseBCollect.promise;
    return collection();
  },
  dbKeyRuntimeStateVersion: () => 'key-runtime-a',
  emptyCollectionMirrorRecheckRecentlyVerified: () => false,
  emptyCollectionMirrorRecheckSummary: () => ({ reason: '' }),
  hasFailedAutoRawKeyScan: async () => false,
  hasVerifiedAutoRawKeys: async () => true,
  listAccounts: async () => [scenario?.stage === 'account' && scenario.accountChanged ? accountB : account],
  listGroups: async () => [group],
  messageCollectionTargetLastMessageEvidence: () => ({}),
  rememberEmptyCollectionMirrorRecheck: () => {},
  shouldRecheckMirrorForEmptyCollection: () => false,
};

const settingsExports = {
  MAX_SCHEDULER_INTERVAL_MS: 24 * 60 * 60 * 1000,
  durationToMs: value => Number(value) || 1000,
  loadSettings: async () => ({ ...settings, groups: { ...settings.groups }, scheduler: { ...settings.scheduler } }),
  manualKeyAccountFingerprint: value => String(value?.account_fingerprint || '').trim(),
  manualKeyVerifiedForAccount: () => true,
  saveSettingsPatchInTransaction: async patch => ({ ...settings, ...patch }),
  withSettingsSaveTransaction: async action => action(),
};

const outputExports = {
  ensureHistoryArtifactIndexed: async (_settings, item) => item,
  outputFileVersion: async () => 'file-version-a',
  outputFileVersionMatches: () => true,
  recoverHistoryArtifactByDigestId: async () => null,
  saveRenderedPng: async options => {
    assert.ok(scenario, 'save caller must be attached to a scenario');
    scenario.savedCount++;
    scenario.savedRoles.push(scenario.role);
    if (scenario.role === 'A' && scenario.stage === 'save') {
      scenario.aStageStarted.resolve();
      await scenario.releaseA.promise;
    }
    const digest = options.digest;
    scenario.bPersisted.resolve();
    return {
      digest_id: digest.digest_id,
      file_path: path.join(publishedOutput, `${digest.digest_id}.png`),
      digest_path: path.join(publishedOutput, `${digest.digest_id}.json`),
      relative_path: `${digest.digest_id}.png`,
      digest_relative_path: `${digest.digest_id}.json`,
      file_version: 'file-version-a',
      digest_file_version: 'digest-version-a',
      history_item_key: `history:${digest.digest_id}`,
      output_dir_identity: publishedOutput,
      history_current: true,
    };
  },
};

const renderExports = {
  assertServerPngRenderAvailable: async () => {},
  normalizeRenderOptions: value => value || {},
  renderDigestPngBuffer: async () => {
    if (scenario?.role === 'A' && scenario.stage === 'render') {
      scenario.aStageStarted.resolve();
      await scenario.releaseA.promise;
    }
    return Buffer.from('png');
  },
};

const summarizerExports = {
  summarizeDigest: async options => {
    if (scenario?.role === 'A' && scenario.stage === 'summarize') {
      scenario.aProgress = options.onProgress;
      scenario.aStageStarted.resolve();
      await scenario.releaseA.promise;
    }
    return {
      digest_id: scenario?.digestId || 'digest-a',
      headline: 'headline',
      topics: [],
      todos: [],
      links: [],
    };
  },
  sanitizeText: value => String(value ?? ''),
};

const cursorExports = {
  assertCursorSeenListFits: () => {},
  getAccountGroupCursorState: async () => ({}),
  getGroupCursorState: async () => ({}),
  setAccountGroupCursorState: async (_identityId, _groupId, nextState) => {
    assert.ok(scenario, 'cursor caller must be attached to a scenario');
    scenario.cursorWriteCount++;
    scenario.cursorWriteRoles.push(scenario.role);
    scenario.bCommitted.resolve();
    return nextState;
  },
};

const loggerExports = {
  logError: () => {},
  logInfo: () => {},
  logWarn: () => {},
};

const pathsExports = {
  DATA_DIR: outputBase,
  OUTPUTS_DIR: path.join(root, 'outputs'),
  OUTPUTS_TMP_DIR: path.join(root, 'outputs', '.tmp'),
  PROJECT_ROOT: root,
  isInside: (parent, candidate) => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  },
  outputDirFromSettings: () => publishedOutput,
};

const jsonStoreExports = {
  PRIVATE_FILE_MODE: 0o600,
  readJson: async () => ({}),
  writeJsonAtomic: async (file, payload) => {
    if (scenario?.stage === 'runtime' && String(file).endsWith('scheduler-runtime.json')) {
      scenario.runtimePersistStarted.resolve();
      await scenario.releaseRuntimePersist.promise;
      scenario.runtimePersistPayloads.push(payload);
    }
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

const wxKeyExports = {
  currentWxKeyProcessGeneration: async () => ({ process_generation: 'key-runtime-a' }),
};

const wxdbExports = {
  releaseWxDbIsolatedBatchSession: async batchId => {
    if (scenario?.stage === 'collect' && batchId === scenario.aBatchId) {
      scenario.aSessionCloseStarted.resolve();
      await scenario.releaseASession.promise;
    }
  },
};

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

const fakeClock = createFakeClock();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = fakeClock.setTimeout;
globalThis.clearTimeout = fakeClock.clearTimeout;

try {
  const scheduler = await import(`${sourceUrl('src/daemon/scheduler.js')}?scheduler-stale-progress-writeback`);
  const { getSchedulerStatus, startScheduler, stopScheduler } = scheduler;
  const staleProgress = { phase: 'late', label: 'A late progress', detail: 'stale A', group: 'Group A' };

  for (const stage of ['collect', 'summarize', 'render', 'save']) {
    scenario = newScenario(stage);
    await startScheduler({ immediate: true });
    await fakeClock.fire(fakeClock.takeNext());
    await scenario.aStageStarted.promise;

    const stopA = await stopScheduler({ wait: false, reason: `stale_progress_stop_A_${stage}` });
    assert.equal(stopA.stopped, false, `stop must report deferred A ${stage} work is still draining`);
    scenario.releaseA.resolve();

    scenario.role = 'B';
    const restartB = startScheduler({ immediate: true });
    if (stage === 'collect') {
      await scenario.aSessionCloseStarted.promise;
      const bStartedBeforeSessionReleased = await Promise.race([
        scenario.bCollectStarted.promise.then(() => true),
        new Promise(resolve => setImmediate(() => resolve(false))),
      ]);
      assert.equal(
        bStartedBeforeSessionReleased,
        false,
        'restart must wait for the old collector batch session to release before a new run can start',
      );
      scenario.releaseASession.resolve();
    }
    if (stage === 'save') {
      const bStartedBeforeAReleased = await Promise.race([
        scenario.bCollectStarted.promise.then(() => true),
        new Promise(resolve => setImmediate(() => resolve(false))),
      ]);
      assert.equal(
        bStartedBeforeAReleased,
        false,
        'restart must wait for an in-flight output save to settle before a new scheduler run can start',
      );
    }
    await restartB;
    await fakeClock.fire(fakeClock.takeNext());
    await scenario.bCollectStarted.promise;
    scenario.aProgress?.(staleProgress);
    assert.equal(
      getSchedulerStatus().active_progress?.label,
      'B current progress',
      `stale A ${stage} progress must not overwrite current B progress`,
    );

    scenario.releaseBCollect.resolve();
    await scenario.bPersisted.promise;
    await scenario.bCommitted.promise;
    await stopScheduler({ wait: true, timeout_ms: 5000, reason: `stale_progress_stop_B_${stage}` });
    if (stage === 'save') {
      assert.deepEqual(
        scenario.savedRoles,
        ['A', 'B'],
        'an A output already admitted before stop may finish its own commit, but restart must then admit exactly one B output',
      );
    } else {
      assert.equal(scenario.savedCount, 1, `only current B ${stage} run should persist one output`);
    }
    assert.equal(scenario.cursorWriteCount, 1, `only current B ${stage} run should commit one cursor`);
    assert.deepEqual(
      scenario.cursorWriteRoles,
      ['B'],
      `stale A ${stage} completion must not commit the cursor owned by B`,
    );
    assert.equal(fakeClock.pendingCount(), 0, `stop must drain the ${stage} scheduler timer`);
  }

  scenario = newScenario('account');
  const accountRun = scheduler.runSchedulerOnce({ reason: 'stale_account_fingerprint_writeback' });
  await scenario.aStageStarted.promise;
  scenario.accountChanged = true;
  scenario.releaseA.resolve();
  const accountResult = await accountRun;
  assert.equal(accountResult.ok, false, 'a same-ID account fingerprint change must fail the old scheduler item');
  assert.equal(
    accountResult.items?.[0]?.error_code,
    'scheduler_account_identity_changed',
    'the old item must expose the account identity change instead of a generic save failure',
  );
  assert.equal(scenario.savedCount, 0, 'a stale account result must not save output');
  assert.equal(scenario.cursorWriteCount, 0, 'a stale account result must not advance the cursor');
  await scheduler.stopScheduler({ wait: true, timeout_ms: 5000, reason: 'stale_account_fingerprint_cleanup' });
  assert.equal(fakeClock.pendingCount(), 0, 'account identity cleanup must not leave a scheduler timer');

  scenario = newScenario('runtime');
  const startWithPendingRuntimeWrite = startScheduler({ immediate: true });
  await scenario.runtimePersistStarted.promise;
  const generationBeforeRuntimeStop = scheduler.__schedulerInternals.schedulerGenerationValue();
  const stopDuringRuntimeWrite = stopScheduler({ wait: false, reason: 'stale_runtime_state_write' });
  assert.ok(
    scheduler.__schedulerInternals.schedulerGenerationValue() > generationBeforeRuntimeStop,
    'stopping while scheduleNext persists must advance the scheduler generation synchronously',
  );
  scenario.releaseRuntimePersist.resolve();
  await startWithPendingRuntimeWrite;
  await stopDuringRuntimeWrite;
  assert.equal(getSchedulerStatus().timer_active, false, 'a cancelled start must not leave a timer active');
  assert.equal(getSchedulerStatus().next_run_at, '', 'a cancelled start must not leave a next-run timestamp');
  assert.equal(fakeClock.pendingCount(), 0, 'a cancelled start must not leave a scheduled callback');
  assert.equal(scenario.runtimePersistPayloads.length, 1, 'the deferred runtime persistence must settle exactly once');
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

console.log('scheduler stale-progress writeback tests passed');
