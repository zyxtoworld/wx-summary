import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const modalStart = source.indexOf('function showHistoryModal(');
const modalEnd = source.indexOf('\nfunction historyImagePath(', modalStart);
assert.ok(modalStart >= 0 && modalEnd > modalStart, 'history PNG modal source must remain available');
const modalSource = source.slice(modalStart, modalEnd);
const stateHandlerStart = modalSource.indexOf('const onHistoryAppStateUpdated = event => {');
const stateHandlerEnd = modalSource.indexOf('\n  };', stateHandlerStart);
assert.ok(stateHandlerStart >= 0 && stateHandlerEnd > stateHandlerStart, 'history PNG modal App State handler must remain available');
const stateHandler = modalSource.slice(stateHandlerStart, stateHandlerEnd);

assert.doesNotMatch(modalSource, /const historyModalTracksCurrentOutput =/);
assert.match(stateHandler, /event\?\.detail\?\.output_dir_identity_changed === true/);
assert.match(stateHandler, /notifyHistoryListNeedsReload\(\)/);
assert.match(stateHandler, /closeModal\(\)/);
assert.match(stateHandler, /showLocalActionNotice\(/);
assert.match(modalSource, /const notifyHistoryListNeedsReload = \(\) => \{[\s\S]*?reload_history_only: true/);

console.log('history modal output identity contract tests passed');
