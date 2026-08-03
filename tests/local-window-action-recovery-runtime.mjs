import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const appSource = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const recoverySource = appSource.slice(
  appSource.indexOf('function compactLocalActionExpectedTarget('),
  appSource.indexOf('function pendingLocalActionCapacityError('),
);

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
  };
}

const localStorage = memoryStorage();
const { persistPendingLocalActionRecord, cleanupPendingLocalActionStorage, localWindowActionInFlight } = new Function(
  'localStorage',
  'LOCAL_ACTION_PENDING_STORAGE_PREFIX',
  'LOCAL_ACTION_PENDING_KINDS',
  'LOCAL_ACTION_EXPECTED_TARGET_TTL_MS',
  'LOCAL_ACTION_PENDING_RECORD_MAX_CHARS',
  'LOCAL_ACTION_EXPECTED_TARGETS',
  'LOCAL_WINDOW_ACTION_KINDS',
  'LOCAL_ACTION_RECOVERY_TIMEOUT_MS',
  `${recoverySource}\nreturn { persistPendingLocalActionRecord, cleanupPendingLocalActionStorage, localWindowActionInFlight };`,
)(
  localStorage,
  'pending:v2:',
  new Set(['reveal', 'open_output']),
  10 * 60 * 1000,
  64 * 1024,
  new Map(),
  new Set(['reveal', 'open_output']),
  38_000,
);

const now = Date.now();
persistPendingLocalActionRecord('reveal_123456', { kind: 'reveal', at: now - 37_000 });
assert.equal(localWindowActionInFlight('', now), true, 'a recent unresolved Explorer request should still block a duplicate click');

persistPendingLocalActionRecord('reveal_123456', { kind: 'reveal', at: now - 39_000 });
assert.equal(cleanupPendingLocalActionStorage(now).length, 1, 'the recovery journal should survive after the foreground exclusion window');
assert.equal(localWindowActionInFlight('', now), false, 'an old recovery journal must not remain a ten-minute Explorer mutex');

console.log('local window action recovery runtime tests passed');
