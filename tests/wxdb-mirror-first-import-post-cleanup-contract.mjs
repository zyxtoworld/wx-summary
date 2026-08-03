import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/wxenv/discovery.js', import.meta.url), 'utf8');
const firstImportSource = source.slice(
  source.indexOf('async function importWxDbMirrorUnlocked'),
  source.indexOf('async function refreshWxDbMirrorScopeUnlocked'),
);
const postCleanupSource = firstImportSource.slice(
  firstImportSource.indexOf('const targetIdentityState = await mirrorPublishedManifestTargetIdentityState'),
  firstImportSource.indexOf("phase: 'mirror_copy_done'"),
);

assert.ok(postCleanupSource, 'first mirror import must verify the published target after cleanup');
assert.match(
  postCleanupSource,
  /if \(targetIdentityState !== 'current'\) \{\s*throw Object\.assign/,
  'first mirror import must fail closed when cleanup changes the published target identity',
);
assert.match(
  postCleanupSource,
  /code: 'wxdb_mirror_post_cleanup_identity_changed'/,
  'first mirror import must report the stable domain error instead of a runtime ReferenceError',
);
assert.doesNotMatch(
  postCleanupSource,
  /reusedFileCount|rebindPublishedMirrorTargetMetadataAfterCleanup/,
  'first mirror import has no reused project files and must not inherit scoped-refresh ctime rebinding',
);

console.log('wxdb mirror first-import post-cleanup contract checks passed');
