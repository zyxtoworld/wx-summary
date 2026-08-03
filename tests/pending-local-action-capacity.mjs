import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

assert.match(
  source,
  /const LOCAL_ACTION_PENDING_STORAGE_LIMIT = 200;/,
  'browser recovery capacity must match the server evidence capacity',
);

const functionsStart = source.indexOf('function pendingLocalActionStorageKeys(');
const functionsEnd = source.indexOf('\nfunction restorePendingLocalActions(', functionsStart);
assert.ok(functionsStart >= 0 && functionsEnd > functionsStart, 'pending local-action storage helpers must remain available');

const storage = new Map();
const localStorage = {
  get length() { return storage.size; },
  key(index) { return [...storage.keys()][index] ?? null; },
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(String(key), String(value)); },
  removeItem(key) { storage.delete(String(key)); },
};
const expectedTargets = new Map();
const sandbox = {
  Date,
  Error,
  JSON,
  Math,
  Map,
  Object,
  String,
  localStorage,
  LOCAL_ACTION_EXPECTED_TARGETS: expectedTargets,
  LOCAL_ACTION_PENDING_STORAGE_PREFIX: 'pending:',
  LOCAL_ACTION_PENDING_STORAGE_LIMIT: 200,
  LOCAL_ACTION_PENDING_RECORD_MAX_CHARS: 64 * 1024,
  normalizePendingLocalActionRecord(value) {
    if (!value?.action_id || !value?.kind || !value?.at) return null;
    return { action_id: value.action_id, kind: value.kind, target: value.target || null, at: value.at };
  },
  pendingLocalActionStorageKey(actionId) { return actionId ? `pending:${actionId}` : ''; },
};

vm.runInNewContext(
  `${source.slice(functionsStart, functionsEnd)}\n`
    + 'globalThis.__cleanup = cleanupPendingLocalActionStorage;\n'
    + 'globalThis.__assertCapacity = assertPendingLocalActionCapacity;',
  sandbox,
  { timeout: 1_000 },
);

for (let index = 0; index < 201; index += 1) {
  const actionId = `action_${String(index).padStart(3, '0')}`;
  localStorage.setItem(`pending:${actionId}`, JSON.stringify({
    action_id: actionId,
    kind: 'reveal',
    target: { relative_path: `outputs/${index}.png` },
    at: 1_000 + index,
  }));
}

const records = sandbox.__cleanup(10_000);
assert.equal(records.length, 201, 'cleanup must return every still-valid unresolved action');
assert.equal(storage.size, 201, 'cleanup must never silently evict a valid unresolved action');

const fullRecords = records.slice(0, 200);
assert.throws(
  () => sandbox.__assertCapacity('new_action', fullRecords),
  error => error?.code === 'local_action_recovery_capacity_reached' && error?.status === 429,
  'a new local action must be rejected before sending when recovery storage is full',
);
assert.doesNotThrow(
  () => sandbox.__assertCapacity(fullRecords[0].action_id, fullRecords),
  'a retry using an already-recorded action id must not consume another capacity slot',
);
assert.throws(
  () => sandbox.__assertCapacity('new_action', records, { recordAlreadyPersisted: true }),
  error => error?.code === 'local_action_recovery_capacity_reached',
  'a cross-tab race that exceeds capacity after persistence must reject the new action instead of evicting an old one',
);

console.log('pending local action capacity tests passed');
