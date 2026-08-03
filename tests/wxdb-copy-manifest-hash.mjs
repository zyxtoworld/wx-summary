import assert from 'node:assert/strict';
import { __wxdbInternals } from '../src/wxdb/index.js';

const published = {
  bytes: 4096,
  mtimeMs: 1000,
  target_ctimeMs: 2000,
  target_birthtimeMs: 500,
  target_dev: 12,
  target_ino: 34,
  sha256: 'a'.repeat(64),
};

const stableStat = {
  size: 4096,
  mtimeMs: 1000,
  ctimeMs: 2000,
  birthtimeMs: 500,
  dev: 12,
  ino: 34,
  isFile: () => true,
  isSymbolicLink: () => false,
};

assert.equal(
  __wxdbInternals.projectMirrorCopyCanTrustPublishedHash(stableStat, published),
  false,
  'project-mirror metadata can prove copy stability but must never replace hashing the copied bytes',
);
assert.equal(
  __wxdbInternals.projectMirrorCopyCanTrustPublishedHash({ ...stableStat }, { ...published }),
  false,
  'same-size same-time metadata must not let replaced content reuse a previously published hash',
);
assert.equal(
  __wxdbInternals.projectMirrorCopyCanTrustPublishedHash({ ...stableStat, ctimeMs: 2003 }, published),
  false,
  'a changed project-mirror file identity must fall back to hashing the temporary copy',
);
assert.equal(
  __wxdbInternals.projectMirrorCopyCanTrustPublishedHash(stableStat, { ...published, target_ino: 0 }),
  false,
  'legacy manifests without a complete target identity must retain the full copied-file hash check',
);
assert.equal(
  __wxdbInternals.projectMirrorCopyCanTrustPublishedHash({ ...stableStat, size: 4095 }, published),
  false,
  'a size mismatch must never reuse a published hash',
);

console.log('wxdb copied-manifest hash reuse tests passed');
