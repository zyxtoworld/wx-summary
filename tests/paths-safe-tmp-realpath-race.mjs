import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputs = path.join(root, 'outputs');
const tmp = path.join(outputs, '.tmp');
const target = path.join(tmp, 'paths-safe-tmp-realpath-race.lock');
const outside = path.join(root, 'data', 'outside-realpath-target');

const directoryStat = {
  isDirectory: () => true,
  isFile: () => false,
  isSymbolicLink: () => false,
};
const ordinaryFileStat = {
  isDirectory: () => false,
  isFile: () => true,
  isSymbolicLink: () => false,
};
const symlinkStat = {
  isDirectory: () => false,
  isFile: () => false,
  isSymbolicLink: () => true,
};
const state = {
  targetStats: [],
  targetRealpaths: [],
};
const enoent = () => Object.assign(new Error('target disappeared during validation'), { code: 'ENOENT' });

const fakeFsPromises = {
  async lstat(value) {
    const resolved = path.resolve(String(value));
    if (resolved === target) return state.targetStats.shift() || null;
    return directoryStat;
  },
  async realpath(value) {
    const resolved = path.resolve(String(value));
    if (resolved === target) {
      const next = state.targetRealpaths.shift();
      if (next instanceof Error) throw next;
      return next || target;
    }
    return resolved;
  },
  async mkdir() {},
};

mock.module('node:fs/promises', { defaultExport: fakeFsPromises });
const { assertSafeTmpPath } = await import(`${pathToFileURL(path.join(root, 'src/lib/paths.js')).href}?realpath-race`);

async function runRace({ targetStats, targetRealpaths, allowMissing = true } = {}) {
  state.targetStats = [...targetStats];
  state.targetRealpaths = [...targetRealpaths];
  return assertSafeTmpPath(target, { label: 'race target', allowMissing });
}

const missing = await runRace({
  targetStats: [ordinaryFileStat, null],
  targetRealpaths: [enoent()],
});
assert.equal(missing.exists, false, 'lstat→realpath ENOENT→missing recheck should be treated as a missing creatable target');

await assert.rejects(
  runRace({
    targetStats: [ordinaryFileStat, null],
    targetRealpaths: [enoent()],
    allowMissing: false,
  }),
  error => error?.code === 'TMP_PATH_MISSING',
  'the same disappearance must remain a missing-path error when allowMissing is false',
);

await assert.rejects(
  runRace({
    targetStats: [ordinaryFileStat, symlinkStat],
    targetRealpaths: [enoent()],
  }),
  error => error?.code === 'TMP_PATH_REPARSE_POINT',
  'a symlink reappearing during the recheck must not be treated as a missing safe target',
);

const replaced = await runRace({
  targetStats: [ordinaryFileStat, ordinaryFileStat],
  targetRealpaths: [enoent(), target],
});
assert.equal(replaced.exists, true, 'an ordinary in-tree replacement must be revalidated as an existing target');
assert.equal(replaced.realTarget, target, 'an ordinary replacement must retain its checked real path');

await assert.rejects(
  runRace({
    targetStats: [ordinaryFileStat, ordinaryFileStat],
    targetRealpaths: [enoent(), outside],
  }),
  error => error?.code === 'TMP_PATH_REALPATH_OUTSIDE',
  'an ordinary replacement resolving outside the checked tmp root must remain rejected',
);

console.log('paths safe tmp realpath race tests passed');
