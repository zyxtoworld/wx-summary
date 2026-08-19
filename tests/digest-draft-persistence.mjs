import assert from 'node:assert/strict';
import {
  DIGEST_DRAFT_MAX_AGE_MS,
  digestDraftHasMeaningfulInput,
  readDigestDraftSnapshot,
  writeDigestDraftSnapshot,
} from '../src/web/public/js/shared/digest-draft-store.js';

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }
}

const storage = new MemoryStorage();
const storageKey = 'digest-draft-test';
const now = Date.UTC(2026, 6, 29, 4, 30, 0);
const scopeA = 'project-a\naccount-a';
const scopeB = 'project-a\naccount-b';
const draftA = {
  selected_group_ids: ['group-a', 'group-b', 'group-a'],
  range_key: 'custom',
  custom_since: '2026-07-28 08:00',
  custom_until: '2026-07-29 09:30:59',
  filters: {
    senders: ['张三', '李四'],
    keywords: ['发布', '故障'],
    exclude_types: ['image', 'file', 'unknown'],
    pending_senders: '王五',
    pending_keywords: '回归 测试',
  },
  min_messages: 8,
  render_options: {
    theme: 'dark',
    font_size: 'large',
  },
};

assert.equal(writeDigestDraftSnapshot(storage, storageKey, scopeA, draftA, {
  accountFingerprint: 'fingerprint-a',
  now,
}), true, 'a valid digest draft should persist');
assert.equal(writeDigestDraftSnapshot(storage, storageKey, scopeB, {
  selected_group_ids: ['group-c'],
  range_key: 'today',
  min_messages: 2,
  render_options: {
    theme: 'light',
    font_size: 'normal',
  },
}, {
  accountFingerprint: 'fingerprint-b',
  now: now + 1,
}), true, 'a second account draft should persist without replacing the first account');

const restoredA = readDigestDraftSnapshot(storage, storageKey, scopeA, {
  accountFingerprint: 'fingerprint-a',
  now: now + 2,
});
assert.equal(restoredA.ok, true);
assert.deepEqual(restoredA.draft.selected_group_ids, ['group-a', 'group-b']);
assert.equal(restoredA.draft.range_key, 'custom');
assert.equal(restoredA.draft.custom_since, '2026-07-28 08:00');
assert.equal(restoredA.draft.custom_until, '2026-07-29 09:30:59');
assert.deepEqual(restoredA.draft.filters.senders, ['张三', '李四']);
assert.deepEqual(restoredA.draft.filters.exclude_types, ['image', 'file']);
assert.equal(restoredA.draft.filters.pending_senders, '王五');
assert.equal(restoredA.draft.filters.pending_keywords, '回归 测试');
assert.equal(restoredA.draft.min_messages, 8);
assert.deepEqual(restoredA.draft.render_options, {
  theme: 'dark',
  font_size: 'large',
}, 'render choices must persist with the account-scoped digest draft');

const restoredB = readDigestDraftSnapshot(storage, storageKey, scopeB, {
  accountFingerprint: 'fingerprint-b',
  now: now + 2,
});
assert.deepEqual(restoredB.draft.selected_group_ids, ['group-c'], 'drafts must stay isolated by account scope');
assert.equal(restoredB.draft.range_key, 'today');
assert.equal(restoredB.draft.min_messages, 2);
assert.deepEqual(restoredB.draft.render_options, {
  theme: 'light',
  font_size: 'normal',
}, 'switching accounts must restore the target account render choices');

const invalidRenderScope = 'project-a\naccount-invalid-render';
assert.equal(writeDigestDraftSnapshot(storage, storageKey, invalidRenderScope, {
  render_options: { theme: 'system', font_size: 'huge' },
}, { now }), true);
assert.deepEqual(
  readDigestDraftSnapshot(storage, storageKey, invalidRenderScope, { now }).draft.render_options,
  { theme: 'auto', font_size: 'normal' },
  'unsupported render choices must normalize to the safe defaults',
);

const sameTimestampStorage = new MemoryStorage();
assert.equal(writeDigestDraftSnapshot(sameTimestampStorage, storageKey, scopeA, { min_messages: 2 }, { now }), true);
assert.equal(writeDigestDraftSnapshot(sameTimestampStorage, storageKey, scopeA, { min_messages: 9 }, { now }), true);
assert.equal(
  readDigestDraftSnapshot(sameTimestampStorage, storageKey, scopeA, { now }).draft.min_messages,
  9,
  'multiple input events in the same millisecond must keep the latest draft rather than the first write',
);

const mismatchedIdentity = readDigestDraftSnapshot(storage, storageKey, scopeA, {
  accountFingerprint: 'different-account-fingerprint',
  now: now + 2,
});
assert.equal(mismatchedIdentity.ok, true);
assert.equal(mismatchedIdentity.draft, null, 'a confirmed account fingerprint mismatch must not restore another account draft');

const missingFingerprintScope = 'project-a\naccount-missing-fingerprint';
assert.equal(writeDigestDraftSnapshot(storage, storageKey, missingFingerprintScope, {
  selected_group_ids: ['legacy-no-fingerprint'],
}, { now }), true);
const missingFingerprintForCurrent = readDigestDraftSnapshot(storage, storageKey, missingFingerprintScope, {
  accountFingerprint: 'fingerprint-b',
  now: now + 1,
});
assert.equal(missingFingerprintForCurrent.draft, null,
  '缺少 fingerprint 的旧草稿不得在精确账号上下文变化后跨账号恢复');
const fingerprintForUnbound = `${missingFingerprintScope}-nonempty`;
assert.equal(writeDigestDraftSnapshot(storage, storageKey, fingerprintForUnbound, {
  selected_group_ids: ['bound-fingerprint'],
}, { accountFingerprint: 'fingerprint-b', now }), true);
const nonemptyForEmpty = readDigestDraftSnapshot(storage, storageKey, fingerprintForUnbound, {
  accountFingerprint: '',
  now: now + 1,
});
assert.equal(nonemptyForEmpty.draft, null,
  '有 fingerprint 的草稿不得恢复到 fingerprint 为空的账号上下文');

const expired = readDigestDraftSnapshot(storage, storageKey, scopeA, {
  accountFingerprint: 'fingerprint-a',
  now: now + DIGEST_DRAFT_MAX_AGE_MS + 1,
});
assert.equal(expired.ok, true);
assert.equal(expired.draft, null, 'stale tab drafts should not live forever');

const invalidRangeScope = 'project-a\naccount-invalid-range';
assert.equal(writeDigestDraftSnapshot(storage, storageKey, invalidRangeScope, {
  range_key: 'custom',
  custom_since: 'not-a-date',
  custom_until: '2026-02-31 99:99',
}, { now }), true);
const invalidRange = readDigestDraftSnapshot(storage, storageKey, invalidRangeScope, { now }).draft;
assert.equal(invalidRange.custom_since, '', 'corrupt custom start times must not be restored into the digest request');
assert.equal(invalidRange.custom_until, '', 'impossible custom end times must not be restored into the digest request');

const oversizedScope = 'x'.repeat(3000);
assert.equal(writeDigestDraftSnapshot(storage, storageKey, oversizedScope, draftA, { now }), false, 'oversized scope identities must be rejected rather than truncated into a collision');
assert.deepEqual(readDigestDraftSnapshot(storage, storageKey, oversizedScope, { now }), { ok: true, draft: null });

assert.equal(digestDraftHasMeaningfulInput({
  selected_group_ids: [],
  range_key: 'yesterdayToday',
  filters: {},
  min_messages: 1,
}), false, 'the untouched default digest form should not trigger data-loss protection');
assert.equal(digestDraftHasMeaningfulInput({
  selected_group_ids: [],
  range_key: 'last4h',
  filters: {},
  min_messages: 1,
}), true, 'a changed time range is meaningful draft input');
assert.equal(digestDraftHasMeaningfulInput({
  selected_group_ids: [],
  range_key: 'yesterdayToday',
  filters: { pending_keywords: '尚未按回车的关键词' },
  min_messages: 1,
}), true, 'uncommitted chip text must count as meaningful draft input');
assert.equal(digestDraftHasMeaningfulInput({
  selected_group_ids: [],
  range_key: 'yesterdayToday',
  filters: {},
  min_messages: 1,
  render_options: { theme: 'dark', font_size: 'normal' },
}), true, 'a non-default render choice must count as meaningful draft input');

const throwingStorage = {
  getItem() { throw new Error('storage unavailable'); },
  setItem() { throw new Error('storage unavailable'); },
  removeItem() { throw new Error('storage unavailable'); },
};
assert.equal(writeDigestDraftSnapshot(throwingStorage, storageKey, scopeA, draftA, { now }), false, 'storage failures must be reported to the page so unload protection can activate');
assert.deepEqual(readDigestDraftSnapshot(throwingStorage, storageKey, scopeA, { now }), { ok: false, draft: null }, 'storage read failures must not look like an empty successful restore');

console.log('digest draft persistence tests passed');
