import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const appSource = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

const panelStart = appSource.indexOf('function showDigestRerenderPanel(');
const panelEnd = appSource.indexOf('\nfunction ensureKeyboardShortcuts()', panelStart);
assert.ok(panelStart >= 0 && panelEnd > panelStart, 'render panel source must be bounded');
const panelSource = appSource.slice(panelStart, panelEnd);
assert.ok(
  panelSource.includes('const reconcileRequired = result?.reconcile_required === true')
    && panelSource.includes('if (!saveConfirmed && reconcileRequired)')
    && panelSource.includes('invalidatePanel(result?.message'),
  'an unconfirmed rerender save must invalidate its save credential instead of enabling a duplicate submission',
);

const modalStart = appSource.indexOf('function showHistoryModal(');
const modalEnd = appSource.indexOf('\nfunction historyImagePath(', modalStart);
const modalSource = appSource.slice(modalStart, modalEnd);
assert.ok(
  modalSource.includes('reconcile_required: true')
    && modalSource.includes('notifyHistoryListNeedsReload()'),
  'an unconfirmed history rerender must force list reconciliation and tell the panel to remain locked',
);
assert.ok(
  modalSource.includes('modal.id = `${titleId}-root`')
    && modalSource.includes('data-busy-focus-key="history-download"')
    && modalSource.includes('data-busy-focus-key="history-reveal"'),
  'history modal actions must have a stable focus scope and action keys',
);
assert.ok(
  appSource.includes("replacement?.closest?.('[data-settings-section], .modal-backdrop, .card')")
    && appSource.includes("focusedButton.closest?.('[data-settings-section], .modal-backdrop, .card')")
    && appSource.includes("section?.querySelector?.('[data-close]:not(:disabled), button:not(:disabled)')"),
  'busy-button focus recovery must include modal fallbacks after a focused action becomes disabled',
);

console.log('history rerender reconcile and modal focus contract passed');
