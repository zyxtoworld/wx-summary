import assert from 'node:assert/strict';
import { __wxdbInternals } from '../src/wxdb/index.js';

const {
  messageShardCursorState,
  messageShardGenerationFingerprint,
  projectMirrorDbFilesFromManifest,
  projectMirrorManifestMap,
} = __wxdbInternals;

function shard(index, overrides = {}) {
  return {
    category: 'message',
    name: `message_${index}.db`,
    bytes: 4096,
    mtimeMs: 1000,
    ctimeMs: 1001,
    birthtimeMs: 500,
    dev: 12,
    ino: 100 + index,
    sha256: String(index % 10).repeat(64),
    sidecars: [],
    ...overrides,
  };
}

const original = shard(7);
const appended = shard(7, {
  bytes: 8192,
  mtimeMs: 2000,
  ctimeMs: 2001,
  sha256: 'a'.repeat(64),
});
const replacedWithSameSizeAndTime = shard(7, {
  ino: 999,
  sha256: 'b'.repeat(64),
});

assert.equal(
  messageShardGenerationFingerprint(appended),
  messageShardGenerationFingerprint(original),
  'ordinary writes on the same source file identity must retain the rowid generation',
);
assert.notEqual(
  messageShardGenerationFingerprint(replacedWithSameSizeAndTime),
  messageShardGenerationFingerprint(original),
  'a same-size same-time file replacement must create a new rowid generation',
);

const firstState = messageShardCursorState(original, {});
assert.equal(firstState.key, 'message_7.db', 'structured cursor records must stay keyed by the real shard name');
const originalGeneration = messageShardGenerationFingerprint(original);
const emptyBaseline = {
  row_id: 0,
  generation: originalGeneration,
  anchor_hash: '',
};
const sameGenerationState = messageShardCursorState(appended, { [firstState.key]: emptyBaseline });
assert.equal(sameGenerationState.has_previous, true);
assert.equal(sameGenerationState.previous_row_id, 0, 'an append on the same generation may retain a verified empty baseline');
const replacedState = messageShardCursorState(replacedWithSameSizeAndTime, { [firstState.key]: emptyBaseline });
assert.equal(replacedState.has_previous, false, 'a replacement generation must not inherit the old rowid');
assert.equal(replacedState.previous_row_id, 0);

const walOriginal = shard(8, {
  sidecars: [{
    name: 'message_8.db-wal',
    suffix: '-wal',
    bytes: 1024,
    mtimeMs: 1000,
    ctimeMs: 1001,
    birthtimeMs: 600,
    dev: 12,
    ino: 208,
    sha256: 'c'.repeat(64),
  }],
});
const walAppended = shard(8, {
  sidecars: [{
    ...walOriginal.sidecars[0],
    bytes: 2048,
    mtimeMs: 2000,
    ctimeMs: 2001,
    sha256: 'd'.repeat(64),
  }],
});
const walRotated = shard(8, {
  sidecars: [{
    ...walAppended.sidecars[0],
    birthtimeMs: 700,
    ino: 308,
  }],
});
assert.equal(
  messageShardGenerationFingerprint(walAppended),
  messageShardGenerationFingerprint(walOriginal),
  'appending to the same WAL identity must not reset the rowid cursor',
);
assert.equal(
  messageShardGenerationFingerprint(walRotated),
  messageShardGenerationFingerprint(walOriginal),
  'WAL checkpoint rotation must not masquerade as replacement of the message shard main database',
);

const newShardState = messageShardCursorState(shard(9), { [firstState.key]: emptyBaseline });
assert.equal(newShardState.has_previous, false, 'a newly added shard must start without another shard\'s rowid');

const manifestAccount = {
  db_storage: 'E:/project-mirror/db_storage',
  mirror: {
    source_scopes: {
      digest: {
        source_snapshot: {
          target_content_hash_alg: 'sha256',
          files: [
            {
              ...original,
              relative: 'message/message_7.db',
              kind: 'db',
              target_ctimeMs: 3001,
              target_birthtimeMs: 3002,
              target_dev: 32,
              target_ino: 307,
            },
            {
              ...walOriginal.sidecars[0],
              relative: 'message/message_7.db-wal',
              kind: 'sidecar',
              target_ctimeMs: 4001,
              target_birthtimeMs: 4002,
              target_dev: 42,
              target_ino: 407,
            },
          ],
        },
      },
    },
  },
};
const manifest = projectMirrorManifestMap(manifestAccount, 'digest');
const [manifestShard] = projectMirrorDbFilesFromManifest(manifestAccount, manifest, 'message');
assert.equal(manifestShard.birthtimeMs, original.birthtimeMs, 'project-mirror enumeration must retain source DB identity');
assert.match(messageShardGenerationFingerprint(manifestShard), /^[a-f0-9]{64}$/, 'the production manifest path must yield a verifiable shard generation');

console.log('wxdb shard cursor integrity tests passed');
