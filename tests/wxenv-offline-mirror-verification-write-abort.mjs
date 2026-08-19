import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/wxenv/discovery.js', import.meta.url), 'utf8');
const start = source.indexOf('async function rememberOfflineMirrorContentVerification(');
const end = source.indexOf('\nfunction wxDbMirrorIdentityProofSufficient(', start);
assert.ok(start >= 0 && end > start, 'offline mirror verification writer must remain inspectable');
const verifyOfflineStart = source.indexOf('async function verifyOfflineMirrorContent(');
const verifyOfflineEnd = source.indexOf('\nfunction offlineMirrorVerificationError(', verifyOfflineStart);
assert.ok(verifyOfflineStart >= 0 && verifyOfflineEnd > verifyOfflineStart, 'real offline mirror verification caller must remain inspectable');
assert.match(
  source.slice(verifyOfflineStart, verifyOfflineEnd),
  /await rememberOfflineMirrorContentVerification\(/,
  'real offline mirror verification must submit through the production writer',
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadWriter({ readIndex, writeJsonAtomic }) {
  const writer = new Function(
    'throwIfDiscoveryAborted',
    'runWithWxDbMirrorIndexWriteLock',
    'readMirrorIndex',
    'plainObject',
    'wxDbMirrorScopeRecordsForRead',
    'mirrorSnapshotPayloadMetaHash',
    'readMirrorIndexForMutation',
    'writeJsonAtomic',
    'WXDB_MIRROR_INDEX',
    `${source.slice(start, end)}\nreturn rememberOfflineMirrorContentVerification;`,
  );
  return writer(
    signal => { if (signal?.aborted) throw signal.reason; },
    action => action(),
    readIndex,
    value => !!value && typeof value === 'object' && !Array.isArray(value),
    previous => Object.values(previous?.source_scopes || {}).map(record => ({ record })),
    () => 'snapshot-hash',
    async signal => {
      if (signal?.aborted) throw signal.reason;
      const index = await readIndex();
      if (signal?.aborted) throw signal.reason;
      return index;
    },
    writeJsonAtomic,
    'mirror-index.json',
  );
}

{
  const snapshot = { hash: 'snapshot-hash' };
  const index = {
    accounts: {
      account_a: {
        source_scopes: {
          full: { source_snapshot: snapshot },
        },
      },
    },
  };
  const writeStarted = deferred();
  const writeGate = deferred();
  const controller = new AbortController();
  const cancellation = Object.assign(new Error('offline verification write cancelled'), { status: 499 });
  const writer = loadWriter({
    readIndex: async () => index,
    writeJsonAtomic: async () => {
      writeStarted.resolve();
      await writeGate.promise;
    },
  });
  const pending = writer('account_a', { key: 'full' }, snapshot, [{ relative: 'message.db' }], '2026-08-18T00:00:00.000Z', { signal: controller.signal });
  await writeStarted.promise;
  controller.abort(cancellation);
  writeGate.resolve();
  await assert.rejects(pending, error => error === cancellation, 'offline verification must project cancellation after the atomic index write settles');
}

{
  const snapshot = { hash: 'snapshot-hash' };
  const index = {
    accounts: {
      account_a: {
        source_scopes: {
          full: { source_snapshot: snapshot },
        },
      },
    },
  };
  const readStarted = deferred();
  const readGate = deferred();
  const controller = new AbortController();
  const cancellation = Object.assign(new Error('offline verification read cancelled'), { status: 499 });
  let writes = 0;
  const writer = loadWriter({
    readIndex: async () => {
      readStarted.resolve();
      await readGate.promise;
      return index;
    },
    writeJsonAtomic: async () => { writes += 1; },
  });
  const pending = writer('account_a', { key: 'full' }, snapshot, [{ relative: 'message.db' }], '2026-08-18T00:00:00.000Z', { signal: controller.signal });
  await readStarted.promise;
  controller.abort(cancellation);
  readGate.resolve();
  await assert.rejects(
    pending,
    error => error === cancellation,
    'cancellation during the mirror-index read must project the caller reason',
  );
  assert.equal(writes, 0, 'cancellation during the mirror-index read must not write an offline verification marker');
}

{
  const snapshot = { hash: 'snapshot-hash' };
  const index = {
    accounts: {
      account_a: {
        source_scopes: {
          full: { source_snapshot: snapshot },
        },
      },
    },
  };
  let writes = 0;
  const writer = loadWriter({
    readIndex: async () => index,
    writeJsonAtomic: async () => { writes += 1; },
  });
  await writer('account_a', { key: 'full' }, snapshot, [{ relative: 'message.db' }], '2026-08-18T00:00:00.000Z');
  assert.equal(writes, 1, 'a completed offline verification must persist exactly once');
}

console.log('wxenv offline mirror verification write-abort tests passed');
