import assert from 'node:assert/strict';
import realFsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const fixtureRoot = path.join(root, 'outputs', '.tmp', `json-store-commit-unknown-${process.pid}-${Date.now()}`);
const target = path.join(fixtureRoot, 'state.json');
const realOpen = realFsp.open.bind(realFsp);

await realFsp.mkdir(fixtureRoot, { recursive: true });
mock.module('node:fs/promises', {
  defaultExport: {
    ...realFsp,
    open: async (file, flags, mode) => {
      if (String(flags) === 'r' && path.resolve(String(file)) === path.resolve(fixtureRoot)) {
        return {
          async sync() {
            throw Object.assign(new Error('directory sync failed after rename'), { code: 'EIO' });
          },
          async close() {},
        };
      }
      return realOpen(file, flags, mode);
    },
  },
});

try {
  const { writeFileAtomic } = await import(`${sourceUrl('src/lib/json-store.js')}?write-commit-unknown`);
  const error = await writeFileAtomic(target, '{"generation":"B"}', { encoding: 'utf8' }).then(
    () => null,
    cause => cause,
  );
  assert.ok(error, 'a post-rename directory sync failure must reject the write');
  assert.equal(error.code, 'EIO');
  assert.equal(error.atomic_write_may_have_committed, true,
    'a failure after rename must carry an explicit commit-unknown marker');
  assert.deepEqual(JSON.parse(await realFsp.readFile(target, 'utf8')), { generation: 'B' },
    'the target must remain the newly renamed payload when the directory sync fails');
} finally {
  await realFsp.rm(fixtureRoot, { recursive: true, force: true });
}

console.log('json-store write commit-unknown tests passed');
