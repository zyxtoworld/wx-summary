import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  clearCursorRecoveryInfo,
  getCursorRecoveryInfo,
  loadCursors,
  revalidateCursorStore,
} from '../src/store/cursors.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const caseDir = await fsp.mkdtemp(path.join(projectRoot, '.local', 'codex', 'tmp', 'cursor-recovery-project-root-'));
const syntheticProjectRoot = path.join(caseDir, 'synthetic-project-root');
const externalStoreDir = path.join(caseDir, 'external-store');
const cursorFile = path.join(externalStoreDir, 'cursors.json');
const corruptStore = JSON.stringify({ 'wxid_bad::group@chatroom': { seen: ['m.1'] } });

await fsp.mkdir(syntheticProjectRoot, { recursive: true });
await fsp.mkdir(externalStoreDir, { recursive: true });

try {
  await fsp.writeFile(cursorFile, corruptStore, 'utf8');
  await assert.rejects(
    () => loadCursors({ file: cursorFile, defaultStore: true, projectRoot: syntheticProjectRoot }),
    error => error?.code === 'CURSORS_INVALID',
    'the initial corrupt default store should enter recovery state',
  );

  await fsp.writeFile(cursorFile, corruptStore, 'utf8');
  await assert.rejects(
    () => revalidateCursorStore(),
    error => error?.code === 'CURSORS_INVALID',
    'revalidation must remain fail-closed when the repaired file is still corrupt',
  );
  const recoveryInfo = getCursorRecoveryInfo();
  assert.ok(recoveryInfo, 'failed revalidation must retain recovery state');
  assert.equal(
    recoveryInfo.backup_relative_path,
    path.basename(recoveryInfo.backup_relative_path),
    'failed revalidation must preserve the original synthetic recovery boundary',
  );
  assert.equal(
    JSON.stringify(recoveryInfo).includes(path.resolve(syntheticProjectRoot)),
    false,
    'failed revalidation must not expose the synthetic project root',
  );
} finally {
  clearCursorRecoveryInfo();
  await fsp.rm(caseDir, { recursive: true, force: true });
}

console.log('cursor recovery project-root boundary tests passed');
