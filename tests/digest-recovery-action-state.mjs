import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSource = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const recoveryStateSource = appSource.slice(
  appSource.indexOf('function digestProgressRecoveryActionId'),
  appSource.indexOf('function setProgressStaleAccountRecovery'),
);

assert.ok(
  appSource.includes('recoveryActionLocks: {}')
    && appSource.includes('recoveryCooldownUntil: {}')
    && recoveryStateSource.includes('function beginDigestProgressRecoveryAction')
    && recoveryStateSource.includes('function endDigestProgressRecoveryAction')
    && recoveryStateSource.includes('function syncDigestProgressRecoveryButtons')
    && recoveryStateSource.includes("button.setAttribute('aria-busy', 'true')")
    && recoveryStateSource.includes('snapshot.recoveryActionLocks[id]')
    && recoveryStateSource.includes('delete snapshot.recoveryActionLocks[id]'),
  'progress recovery locks must live in the progress snapshot and repaint onto replacement buttons',
);

assert.ok(
  appSource.includes('syncDigestProgressRecoveryButtons(tools);')
    && (appSource.match(/beginDigestProgressRecoveryAction\(/g) || []).length >= 5
    && (appSource.match(/endDigestProgressRecoveryAction\(/g) || []).length >= 5,
  'all long-running progress recovery requests must use the persistent action lock across heartbeat repaints',
);

const cooldownSource = appSource.slice(
  appSource.indexOf('function armProgressRetryCooldown'),
  appSource.indexOf('function progressReloadButton'),
);
assert.ok(
  cooldownSource.includes('snapshot.recoveryCooldownUntil[id]')
    && cooldownSource.includes('const existingReadyAt =')
    && !cooldownSource.includes('delete snapshot.recoveryCooldownUntil[id]'),
  'Retry-After countdowns must retain one absolute deadline across progress-card repaints',
);

console.log('digest recovery action state tests passed');
