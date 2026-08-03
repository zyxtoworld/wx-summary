import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LEGACY_MANUAL_KEY_POLICY,
  __collectorInternals,
} from '../src/collector/index.js';

const scoped = 'a'.repeat(64);
const configuredLegacy = 'b'.repeat(64);
const requestedLegacy = 'c'.repeat(64);
const candidates = __collectorInternals.legacyManualKeysForPolicy;

assert.equal(typeof candidates, 'function');
assert.deepEqual(candidates({
  policy: LEGACY_MANUAL_KEY_POLICY.DENY,
  configuredText: configuredLegacy,
}), [], 'strict callers must never receive an unbound configured legacy key');
assert.throws(
  () => candidates({
    policy: LEGACY_MANUAL_KEY_POLICY.DENY,
    requestedText: requestedLegacy,
  }),
  error => error?.code === 'legacy_manual_key_policy_forbidden',
  'a caller must not be able to smuggle an explicit legacy key through the strict policy',
);
assert.deepEqual(candidates({
  policy: LEGACY_MANUAL_KEY_POLICY.ALLOW_VERIFIED_MIGRATION,
  configuredText: configuredLegacy,
  requestedText: requestedLegacy,
}), [configuredLegacy, requestedLegacy]);
assert.deepEqual(candidates({
  policy: LEGACY_MANUAL_KEY_POLICY.ALLOW_VERIFIED_MIGRATION,
  configuredText: configuredLegacy,
  requestedText: requestedLegacy,
  hasTemporaryManualKey: true,
}), [], 'a request-scoped temporary key must remain isolated from every legacy candidate');
assert.throws(
  () => candidates({ policy: 'surprise-policy', configuredText: scoped }),
  error => error?.code === 'legacy_manual_key_policy_invalid',
  'unknown policy values must fail closed',
);

const collectorSource = fs.readFileSync(new URL('../src/collector/index.js', import.meta.url), 'utf8');
const schedulerSource = fs.readFileSync(new URL('../src/daemon/scheduler.js', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const runWithDbKeysSource = collectorSource.slice(
  collectorSource.indexOf('async function runWithDbKeys('),
  collectorSource.indexOf('async function verifyKeysWithStandardDbScan('),
);
assert.doesNotMatch(runWithDbKeysSource, /initialKeyBundle/, 'strict policy must not have a prebuilt candidate-bundle bypass');
assert.ok(
  (runWithDbKeysSource.match(/legacy_manual_key_policy:\s*legacyManualKeyPolicy/g) || []).length >= 2,
  'quick and full candidate scans must use the same validated legacy-key policy',
);
const groupCacheSource = collectorSource.slice(
  collectorSource.indexOf('function groupCacheKey('),
  collectorSource.indexOf('function groupCacheEntryFresh('),
);
assert.match(groupCacheSource, /legacy_manual_key_policy:\s*legacyManualKeyPolicy/);
assert.ok(
  (schedulerSource.match(/legacy_manual_key_policy:\s*LEGACY_MANUAL_KEY_POLICY\.DENY/g) || []).length >= 3,
  'scheduled preview, group reads, and message reads must all explicitly deny legacy global keys',
);
assert.ok(
  (mainSource.match(/legacy_manual_key_policy:\s*LEGACY_MANUAL_KEY_POLICY\.ALLOW_VERIFIED_MIGRATION/g) || []).length >= 5,
  'interactive group, message, and explicit validation paths must opt into verified migration on the server',
);

console.log('collector legacy manual-key policy tests passed');
