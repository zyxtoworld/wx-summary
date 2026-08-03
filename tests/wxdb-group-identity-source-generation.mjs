import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { __discoveryInternals, isWxDbMirrorIdentityVerified } from '../src/wxenv/discovery.js';

const summaryA = {
  categories: [
    { name: 'message', db_count: 2, bytes: 400, last_write_time: '2026-08-02T01:02:03.000Z' },
    { name: 'contact', db_count: 1, bytes: 100, last_write_time: '2026-08-01T01:02:03.000Z' },
  ],
  db_count: 3,
  bytes: 500,
  last_write_time: '2026-08-02T01:02:03.000Z',
  generation_files: [
    { relative: 'contact/contact.db', kind: 'db', bytes: 100, mtime_ms: 1_754_010_123_000, ctime_ms: 1_754_010_120_000, birthtime_ms: 1_754_000_000_000, dev: '1', ino: '11' },
    { relative: 'message/message_0.db', kind: 'db', bytes: 200, mtime_ms: 1_754_096_523_000, ctime_ms: 1_754_096_520_000, birthtime_ms: 1_754_000_000_000, dev: '1', ino: '21' },
    { relative: 'message/message_1.db', kind: 'db', bytes: 200, mtime_ms: 1_754_096_523_000, ctime_ms: 1_754_096_520_000, birthtime_ms: 1_754_000_000_000, dev: '1', ino: '22' },
  ],
};
const summaryAReordered = {
  ...summaryA,
  categories: [...summaryA.categories].reverse(),
  generation_files: [...summaryA.generation_files].reverse(),
};
const summaryB = {
  ...summaryA,
  categories: summaryA.categories.map(item => item.name === 'message'
    ? { ...item, bytes: item.bytes + 1, last_write_time: '2026-08-02T01:02:04.000Z' }
    : item),
  bytes: 501,
  last_write_time: '2026-08-02T01:02:04.000Z',
  generation_files: summaryA.generation_files.map(item => item.relative === 'message/message_1.db'
    ? { ...item, bytes: item.bytes + 1, mtime_ms: item.mtime_ms + 1_000 }
    : item),
};
const summaryContactChanged = {
  ...summaryA,
  generation_files: summaryA.generation_files.map(item => item.relative === 'contact/contact.db'
    ? { ...item, bytes: item.bytes + 1, mtime_ms: item.mtime_ms + 1_000 }
    : item),
};

const generationA = __discoveryInternals.sourceAccountGenerationHash({ summary: summaryA });
assert.match(generationA, /^[a-f0-9]{64}$/, 'source metadata must produce an opaque generation hash');
assert.equal(
  __discoveryInternals.sourceAccountGenerationHash({ summary: summaryAReordered }),
  generationA,
  'filesystem enumeration order must not change the source generation hash',
);
const generationB = __discoveryInternals.sourceAccountGenerationHash({ summary: summaryB });
assert.equal(generationB, generationA, 'ordinary message writes must not invalidate the account-identity generation');
const contactGeneration = __discoveryInternals.sourceAccountGenerationHash({ summary: summaryContactChanged });
assert.notEqual(contactGeneration, generationA, 'a contact database metadata change must advance the account-identity generation');
assert.equal(
  __discoveryInternals.sourceAccountGenerationHash({ summary: { ...summaryA, generation_files: [] } }),
  '',
  'aggregate category totals must never act as positive account-generation evidence',
);
assert.notEqual(
  __discoveryInternals.sourceAccountGenerationHash({ summary: {
    ...summaryA,
    generation_files: summaryA.generation_files.map(item => item.relative === 'contact/contact.db'
      ? { ...item, relative: 'contact/contact_renamed.db' }
      : item),
  } }),
  generationA,
  'different contact-file identities must not collide merely because category totals match',
);

assert.equal(
  __discoveryInternals.mirrorIdentitySourceGenerationCurrent({ identity_source_generation_hash: generationA }, generationA),
  true,
  'only the exact generation bound by the last identity proof may reuse a groups-only mirror',
);
assert.equal(
  __discoveryInternals.mirrorIdentitySourceGenerationCurrent({ identity_source_generation_hash: generationA }, generationB),
  true,
  'a message-only source change must retain groups-only identity reuse',
);
assert.equal(
  __discoveryInternals.mirrorIdentitySourceGenerationCurrent({ identity_source_generation_hash: generationA }, contactGeneration),
  false,
  'a contact source change must invalidate groups-only identity reuse',
);
assert.equal(
  __discoveryInternals.mirrorIdentitySourceGenerationCurrent({}, generationA),
  false,
  'legacy mirrors without a generation binding must fail closed once and revalidate identity',
);

const verifiedSelfWxid = 'wxid_source_generation_guard';
const verifiedIdentity = `wxacct_${crypto.createHash('sha256').update(verifiedSelfWxid).digest('hex').slice(0, 24)}`;
const verifiedAccount = {
  identity_id: verifiedIdentity,
  verified_self_wxid: verifiedSelfWxid,
  identity_status: 'verified',
  identity_generation_status: 'verified',
  identity_source_generation_hash: generationA,
  source_generation_hash: contactGeneration,
  mirror: {
    identity_id: verifiedIdentity,
    verified_self_wxid: verifiedSelfWxid,
    identity_status: 'verified',
    identity_generation_status: 'verified',
    identity_source_generation_hash: generationA,
    source_generation_hash: contactGeneration,
    source_available: true,
  },
};
assert.equal(isWxDbMirrorIdentityVerified(verifiedAccount), false, 'an online contact-generation mismatch must be exposed as pending before group reads or settings can trust it');
assert.equal(isWxDbMirrorIdentityVerified({ ...verifiedAccount, mirror: { ...verifiedAccount.mirror, source_available: false } }), true, 'an offline fully verified project copy must not fail merely because live source metadata is unavailable');

const projectRoot = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(projectRoot, 'src', 'wxenv', 'discovery.js'), 'utf8');
const collectorSource = fs.readFileSync(path.join(projectRoot, 'src', 'collector', 'index.js'), 'utf8');
const ensureStart = source.indexOf('async function ensureWxDbMirrorTracked');
const ensureEnd = source.indexOf('async function mirrorPublishedTargetIdentityMatches', ensureStart);
const ensureSource = source.slice(ensureStart, ensureEnd);
assert.ok(ensureSource.includes("phase: 'groups_source_generation_changed'"), 'groups refresh must expose the automatic identity-upgrade progress step');
assert.ok(ensureSource.includes("scope = mirrorScopeForReason('identity')"), 'a stale groups identity generation must upgrade to the bounded identity scope');
assert.ok(ensureSource.includes('readSourceAccountGenerationHash(source'), 'groups reuse must recapture source metadata after the narrow snapshot check');
assert.ok(source.includes("file.relative.split('/')[0] === 'contact'"), 'account identity generation must be derived only from contact database files, not ordinary message/session writes');
assert.equal(ensureSource.includes('for (let generationAttempt = 0; generationAttempt < 3; generationAttempt += 1)'), false, 'unrelated live message writes must not starve identity preparation behind a global-generation stability loop');
assert.ok(collectorSource.includes('const groupsOnlyMirror = hasWxDbMirrorIdentityAnchor(groupAccount);'), 'an existing message-verified identity anchor must enter the narrow group continuity check even while a legacy generation binding is pending migration');

const identityStart = source.indexOf('export async function recordWxDbMirrorAccountIdentity');
const identityEnd = source.indexOf('async function recordWxDbMirrorReuse', identityStart);
const identitySource = source.slice(identityStart, identityEnd);
assert.ok(identitySource.includes('identity_source_generation_hash: currentSourceGenerationHash'), 'message-backed identity proof must bind the current source generation');
assert.ok(identitySource.includes('expected_source_generation_hash') && identitySource.includes('expected_identity_snapshot_hash'), 'identity persistence must compare both source generation and identity-scope snapshot under the index lock');

console.log('wxdb group identity source generation contract passed');
