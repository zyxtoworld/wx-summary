import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  prepareAtomicProcessLock,
  readAtomicProcessLockFile,
  releaseAtomicProcessLockFile,
} from '../src/lib/atomic-process-lock.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-lock-release-race-'));
const lockPath = path.join(root, 'shared.lock');
const firstToken = crypto.randomUUID();
const replacementToken = crypto.randomUUID();

async function publishOwner(token, generation) {
  return prepareAtomicProcessLock({
    lockPath,
    owner: {
      version: 1,
      pid: process.pid,
      process_start_id: `release-race:${generation}`,
      token,
      created_at: new Date().toISOString(),
    },
  }).then(prepared => prepared.publish());
}

let replacement = null;
try {
  const first = await publishOwner(firstToken, 'first');
  await first.handle.close();

  let initialReadCount = 0;
  let releaseInitialReads;
  const bothInitialReads = new Promise(resolve => { releaseInitialReads = resolve; });
  const gatedReadLock = () => {
    let initialReadDone = false;
    return async target => {
      const observed = await readAtomicProcessLockFile(target);
      if (!initialReadDone && path.resolve(target) === path.resolve(lockPath)) {
        initialReadDone = true;
        initialReadCount += 1;
        if (initialReadCount === 2) releaseInitialReads();
        await bothInitialReads;
      }
      return observed;
    };
  };

  let unlinkCalls = 0;
  let resolveReplacementPublished;
  const replacementPublished = new Promise(resolve => { resolveReplacementPublished = resolve; });
  const racingUnlink = async target => {
    unlinkCalls += 1;
    if (unlinkCalls === 1) {
      await fsp.unlink(target);
      replacement = await publishOwner(replacementToken, 'replacement');
      await replacement.handle.close();
      resolveReplacementPublished();
      return;
    }
    await replacementPublished;
    await fsp.unlink(target);
  };

  const results = await Promise.all([
    releaseAtomicProcessLockFile(lockPath, firstToken, {
      readLock: gatedReadLock(),
      unlink: racingUnlink,
      retryDelaysMs: [],
    }),
    releaseAtomicProcessLockFile(lockPath, firstToken, {
      readLock: gatedReadLock(),
      unlink: racingUnlink,
      retryDelaysMs: [],
    }),
  ]);

  assert.equal(unlinkCalls, 1, 'concurrent releases of one owner must share one exclusive claim before unlinking');
  assert.equal(results.filter(Boolean).length, 1, 'only the release holding the exclusive owner claim may report success');
  assert.equal(
    (await readAtomicProcessLockFile(lockPath))?.owner?.token,
    replacementToken,
    'a replacement owner published after the first unlink must not be removed by a stale concurrent release',
  );
} finally {
  await releaseAtomicProcessLockFile(lockPath, replacementToken).catch(() => false);
  await fsp.rm(root, { recursive: true, force: true });
}

console.log('atomic process lock concurrent release race test passed');
