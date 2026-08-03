import assert from 'node:assert/strict';
import createBrowserClipboardJournal, {
  BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES,
  BROWSER_CLIPBOARD_JOURNAL_MAX_ENTRIES,
  BROWSER_CLIPBOARD_JOURNAL_STORAGE_KEY,
  BROWSER_CLIPBOARD_JOURNAL_TTL_MS,
} from '../src/web/public/js/browser-clipboard-journal.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.failWrites = false;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.failWrites) throw new Error('quota denied');
    this.values.set(key, String(value));
  }
}

function input(actionId, target = { digest_id: 'digest-1' }) {
  return {
    action_id: actionId,
    kind: 'clipboard_copy',
    target,
    clipboard: { width: 1200, height: 800 },
  };
}

function textInput(actionId, target = { purpose: 'preview_markdown', content_bytes: 42 }) {
  return {
    action_id: actionId,
    kind: 'text_clipboard_copy',
    target,
  };
}

function persistedEntries(storage) {
  return JSON.parse(storage.getItem(BROWSER_CLIPBOARD_JOURNAL_STORAGE_KEY)).entries;
}

function verifyWriteFailureDoesNotAdvanceMemory() {
  const storage = new MemoryStorage();
  let now = 1000;
  const journal = createBrowserClipboardJournal({ storage, now: () => now });
  storage.failWrites = true;
  assert.throws(
    () => journal.prepare(input('write-fails')),
    error => error?.code === BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.storageWriteFailed
      && error?.name === 'BrowserClipboardJournalStorageError'
      && error?.status === 500,
  );
  assert.deepEqual(journal.list(), []);
  assert.equal(storage.getItem(BROWSER_CLIPBOARD_JOURNAL_STORAGE_KEY), null);

  storage.failWrites = false;
  const prepared = journal.prepare(input('commit-write-fails'));
  now += 1;
  storage.failWrites = true;
  assert.throws(
    () => journal.markBrowserCommitted('commit-write-fails'),
    error => error?.code === BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.storageWriteFailed,
  );
  assert.equal(journal.get('commit-write-fails').phase, 'prepared');
  assert.deepEqual(persistedEntries(storage), [prepared]);
}

function verifyPreparedToCommitted() {
  const storage = new MemoryStorage();
  let now = 10_000;
  const journal = createBrowserClipboardJournal({ storage, now: () => now });
  const prepared = journal.prepare(input('phase-change', {
    digest_id: 'digest-1',
    page: 2,
    ignored: true,
    nested: { unsafe: true },
    infinite: Infinity,
  }));
  assert.equal(prepared.phase, 'prepared');
  assert.deepEqual(prepared.target, { digest_id: 'digest-1', page: 2 });
  assert.equal(prepared.at, new Date(now).toISOString());
  assert.equal(prepared.updated_at, prepared.at);

  now += 250;
  const committed = journal.markCommitted('phase-change');
  assert.equal(committed.phase, 'browser_committed');
  assert.equal(committed.at, prepared.at);
  assert.equal(committed.updated_at, new Date(now).toISOString());
  assert.deepEqual(persistedEntries(storage), [committed]);
}

function verifyPreparedWithoutClipboardSize() {
  const storage = new MemoryStorage();
  let now = 15_000;
  const journal = createBrowserClipboardJournal({ storage, now: () => now });
  const prepared = journal.prepare(textInput('text-phase'));
  assert.equal(prepared.phase, 'prepared');
  assert.equal(prepared.clipboard, null);

  now += 10;
  const committed = journal.markBrowserCommitted('text-phase');
  assert.equal(committed.phase, 'browser_committed');
  assert.equal(committed.clipboard, null);

  const imagePrepared = journal.prepare({ ...input('late-size'), clipboard: null });
  assert.equal(imagePrepared.clipboard, null);
  now += 10;
  const imageCommitted = journal.markBrowserCommitted('late-size', { clipboard: { width: 640, height: 480 } });
  assert.deepEqual(imageCommitted.clipboard, { width: 640, height: 480 });
  assert.throws(
    () => journal.markBrowserCommitted('late-size', { clipboard: { width: 641, height: 480 } }),
    error => error?.code === BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.clipboardConflict,
  );
}

function verifyRestoreAcrossReconstruction() {
  const storage = new MemoryStorage();
  let now = 20_000;
  const first = createBrowserClipboardJournal({ storage, now: () => now });
  first.prepare(input('restored', 'preview:digest-1'));
  now += 10;
  first.markBrowserCommitted('restored');

  const second = createBrowserClipboardJournal({ storage, now: () => now });
  assert.deepEqual(second.list(), first.list());
  assert.equal(second.get('restored').phase, 'browser_committed');
}

function verifyTargetConflict() {
  const storage = new MemoryStorage();
  const journal = createBrowserClipboardJournal({ storage, now: () => 30_000 });
  const prepared = journal.prepare(input('conflict', { digest_id: 'digest-a' }));
  assert.throws(
    () => journal.prepare(input('conflict', { digest_id: 'digest-b' })),
    error => error?.code === BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.targetConflict
      && error?.name === 'BrowserClipboardJournalConflictError'
      && error?.status === 409
      && error?.action_id === 'conflict',
  );
  assert.deepEqual(journal.list(), [prepared]);
  assert.deepEqual(persistedEntries(storage), [prepared]);
}

function verifyTtlAndCapacityRestore() {
  const storage = new MemoryStorage();
  const now = BROWSER_CLIPBOARD_JOURNAL_TTL_MS + 100_000;
  const entries = Array.from(
    { length: BROWSER_CLIPBOARD_JOURNAL_MAX_ENTRIES + 2 },
    (_, index) => {
      const timestamp = new Date(now - 42_000 + index * 1000).toISOString();
      return {
        ...input(`capacity-${String(index).padStart(2, '0')}`),
        phase: 'prepared',
        at: timestamp,
        updated_at: timestamp,
      };
    },
  );
  entries.push({
    ...input('expired'),
    phase: 'prepared',
    at: new Date(now - BROWSER_CLIPBOARD_JOURNAL_TTL_MS - 1).toISOString(),
    updated_at: new Date(now - BROWSER_CLIPBOARD_JOURNAL_TTL_MS - 1).toISOString(),
  });
  entries.push({
    ...input('malformed'),
    clipboard: { width: 0, height: 10 },
    phase: 'prepared',
    at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  });
  storage.setItem(BROWSER_CLIPBOARD_JOURNAL_STORAGE_KEY, JSON.stringify({ version: 1, entries }));

  const restored = createBrowserClipboardJournal({ storage, now: () => now });
  const expectedIds = Array.from(
    { length: BROWSER_CLIPBOARD_JOURNAL_MAX_ENTRIES },
    (_, index) => `capacity-${String(index + 2).padStart(2, '0')}`,
  );
  assert.deepEqual(restored.list().map(entry => entry.action_id), expectedIds);
  assert.deepEqual(persistedEntries(storage).map(entry => entry.action_id), expectedIds);
}

function verifyRemovePersists() {
  const storage = new MemoryStorage();
  const journal = createBrowserClipboardJournal({ storage, now: () => 40_000 });
  journal.prepare(input('remove-me'));
  assert.equal(journal.remove('remove-me'), true);
  assert.equal(journal.remove('remove-me'), false);
  assert.deepEqual(journal.list(), []);
  assert.deepEqual(persistedEntries(storage), []);
}

function verifyConcurrentInstancesMergeFreshStorage() {
  const storage = new MemoryStorage();
  let now = 50_000;
  const first = createBrowserClipboardJournal({ storage, now: () => now });
  const second = createBrowserClipboardJournal({ storage, now: () => now });

  first.prepare(input('tab-a', { digest_id: 'digest-a' }));
  now += 1;
  second.prepare(input('tab-b', { digest_id: 'digest-b' }));
  assert.deepEqual(first.list().map(entry => entry.action_id), ['tab-a', 'tab-b']);
  assert.deepEqual(second.list().map(entry => entry.action_id), ['tab-a', 'tab-b']);

  now += 1;
  first.markBrowserSubmitted('tab-a');
  assert.throws(
    () => second.markBrowserSubmitted('tab-b'),
    error => error?.code === BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.writePending
      && error?.pending_action_id === 'tab-a',
  );
  assert.throws(
    () => second.assertWriteIdle(),
    error => error?.code === BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.writePending,
  );
  first.markBrowserCommitted('tab-a');
  assert.doesNotThrow(() => second.assertWriteIdle());
  second.markBrowserSubmitted('tab-b');
  assert.equal(first.get('tab-b').phase, 'browser_submitted');
  assert.equal(second.releaseBrowserSubmitted('tab-b'), true);
  assert.equal(first.get('tab-b').phase, 'prepared');
  assert.equal(second.get('tab-a').phase, 'browser_committed');
  assert.equal(second.remove('tab-b'), true);
  assert.deepEqual(persistedEntries(storage).map(entry => [entry.action_id, entry.phase]), [
    ['tab-a', 'browser_committed'],
  ]);

  assert.throws(
    () => second.prepare(input('tab-a', { digest_id: 'different-target' })),
    error => error?.code === BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.targetConflict,
  );
  assert.deepEqual(first.list().map(entry => entry.action_id), ['tab-a']);
}

verifyWriteFailureDoesNotAdvanceMemory();
verifyPreparedToCommitted();
verifyPreparedWithoutClipboardSize();
verifyRestoreAcrossReconstruction();
verifyTargetConflict();
verifyTtlAndCapacityRestore();
verifyRemovePersists();
verifyConcurrentInstancesMergeFreshStorage();
console.log('browser clipboard journal tests passed');
