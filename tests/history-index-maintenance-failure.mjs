import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const dataDirRelative = `outputs/.tmp/history-index-maintenance-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = dataDirRelative;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${dataDirRelative}/runtime-tmp/wxdb`;
process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = '';

const { OUTPUTS_DIR, toProjectRelative } = await import(sourceUrl('src/lib/paths.js'));
const testRoot = path.join(OUTPUTS_DIR, `history-index-maintenance-${process.pid}-${Date.now()}`);
const indexPath = path.join(testRoot, 'index.json');
const previousScope = process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE;
const previousFixtureRoots = process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS;
process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = testRoot;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = testRoot;

const jsonStore = await import(sourceUrl('src/lib/json-store.js'));
mock.module(sourceUrl('src/lib/json-store.js'), {
  namedExports: {
    ...jsonStore,
    writeJsonAtomic: async (file, ...args) => {
      if (path.resolve(String(file || '')) === path.resolve(indexPath)) {
        throw Object.assign(new Error('index write denied for maintenance contract'), { code: 'EACCES' });
      }
      return jsonStore.writeJsonAtomic(file, ...args);
    },
  },
});

const { listHistory } = await import(`${sourceUrl('src/renderer/output.js')}?history-index-maintenance-${process.pid}`);
const settings = {
  output: { dir: `./${toProjectRelative(testRoot)}`, retention_days: 0 },
  settings_revision: 'history-index-maintenance-settings',
  export_policy_revision: 'history-index-maintenance-policy',
};
const originalIndex = [{
  digest_id: 'history-maintenance-warning',
  group: 'history maintenance warning fixture',
  title: 'retained index entry',
  created_at: '2026-08-17T08:00:00.000Z',
  relative_path: 'missing.png',
  digest_relative_path: 'missing.digest.json',
}];

try {
  await fsp.mkdir(testRoot, { recursive: true });
  await fsp.writeFile(indexPath, `${JSON.stringify(originalIndex, null, 2)}\n`, 'utf8');

  const result = await listHistory(settings, { limit: 10, bypassCache: true });
  const warning = result.warnings?.find(item => item?.code === 'history_index_maintenance_failed');
  assert.ok(warning, 'history API must expose a maintenance warning when search-index repair cannot persist');
  assert.equal(result.items?.length, 1, 'maintenance failure must retain the original history item');
  assert.equal(result.items?.[0]?.digest_id, originalIndex[0].digest_id, 'maintenance failure must not drop the retained index entry');
  assert.deepEqual(JSON.parse(await fsp.readFile(indexPath, 'utf8')), originalIndex, 'maintenance failure must leave index.json unchanged for a later retry');
} finally {
  await fsp.rm(testRoot, { recursive: true, force: true });
  if (previousScope === undefined) delete process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE;
  else process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = previousScope;
  if (previousFixtureRoots === undefined) delete process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS;
  else process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = previousFixtureRoots;
}

console.log('history index maintenance failure tests passed');
