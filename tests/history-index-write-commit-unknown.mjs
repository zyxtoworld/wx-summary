import assert from 'node:assert/strict';
import realFsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const fixtureRoot = path.join(root, 'outputs', `history-index-commit-unknown-${process.pid}-${Date.now()}`);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const realJsonStore = await import(sourceUrl('src/lib/json-store.js'));
let indexFailureInjected = false;

mock.module(sourceUrl('src/lib/json-store.js'), {
  namedExports: {
    ...realJsonStore,
    writeJsonAtomic: async (file, data, options) => {
      await realJsonStore.writeJsonAtomic(file, data, options);
      if (path.basename(String(file)) === 'index.json' && !indexFailureInjected) {
        indexFailureInjected = true;
        throw Object.assign(new Error('directory sync failed after index rename'), {
          code: 'EIO',
          atomic_write_may_have_committed: true,
        });
      }
    },
  },
});

await realFsp.mkdir(fixtureRoot, { recursive: true });
try {
  const { toProjectRelative } = await import(sourceUrl('src/lib/paths.js'));
  const { saveRenderedPng } = await import(`${sourceUrl('src/renderer/output.js')}?history-index-commit-unknown`);
  const settings = {
    output: {
      dir: `./${toProjectRelative(fixtureRoot)}`,
      retention_days: 0,
    },
  };
  const error = await saveRenderedPng({
    settings,
    digest: {
      digest_id: 'history-index-commit-unknown',
      group: 'history commit unknown fixture',
      since: '2026-08-19 00:00:00',
      until: '2026-08-19 01:00:00',
      message_count: 1,
      model: 'test-model',
      headline: 'history index commit unknown fixture',
      topics: [{ title: 'fixture', participants: [], summary: 'fixture', need_followup: false }],
      created_at: '2026-08-19T00:00:00.000Z',
    },
    png_buffer: PNG,
    save_operation_id: 'history-index-commit-unknown-operation',
  }).then(
    () => null,
    cause => cause,
  );
  assert.ok(error, 'a history index write whose directory sync failed after rename must not resolve as an ordinary save result');
  assert.equal(error.index_may_have_committed, true,
    `history save must retain the commit-unknown owner when index.json may already be replaced (code=${error?.code || ''}, public=${error?.public_code || ''}, atomic=${error?.atomic_write_may_have_committed}, message=${error?.message || ''})`);
  const indexPath = path.join(fixtureRoot, 'index.json');
  const index = JSON.parse(await realFsp.readFile(indexPath, 'utf8'));
  assert.equal(index.some(item => item.digest_id === 'history-index-commit-unknown'), true,
    'the committed index row must remain discoverable for recovery');
} finally {
  await realFsp.rm(fixtureRoot, { recursive: true, force: true });
}

console.log('history index write commit-unknown tests passed');
