import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';
import { findHistoryItem, listHistory } from '../src/renderer/output.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `history-path-portability-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const DIGEST_ID = `portable-history-${crypto.randomUUID()}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

function settingsFor(base) {
  return { output: { dir: `./${toProjectRelative(base)}`, retention_days: 0 } };
}

const source = await fsp.readFile(new URL('../src/renderer/output.js', import.meta.url), 'utf8');
const foreignPathStart = source.indexOf('function isForeignWindowsAbsolutePath(');
const foreignPathEnd = source.indexOf('\nfunction relativeInside(', foreignPathStart);
assert.ok(foreignPathStart >= 0 && foreignPathEnd > foreignPathStart, 'history path resolver must explicitly recognize foreign Windows absolute paths');
const foreignPathSandbox = { String, process: { platform: 'linux' }, path: { win32: path.win32 } };
vm.runInNewContext(`${source.slice(foreignPathStart, foreignPathEnd)}\nglobalThis.__foreign = isForeignWindowsAbsolutePath;`, foreignPathSandbox, { timeout: 1000 });
assert.equal(foreignPathSandbox.__foreign('C:\\old-machine\\outputs\\digest.png'), true, 'a Windows drive path must not become a POSIX relative output filename');
assert.equal(foreignPathSandbox.__foreign('\\\\server\\share\\digest.png'), true, 'a Windows UNC path must not become a POSIX relative output filename');
assert.equal(foreignPathSandbox.__foreign('2026-07-30/digest.png'), false, 'portable relative history paths must remain valid');

const priorScope = process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE;
process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = TEST_ROOT;
try {
  await fsp.mkdir(TEST_ROOT, { recursive: true });
  const portablePng = path.join(TEST_ROOT, 'portable.png');
  const stalePng = path.join(TEST_ROOT, 'stale.png');
  const portableDigest = path.join(TEST_ROOT, 'portable.digest.json');
  const staleDigest = path.join(TEST_ROOT, 'stale.digest.json');
  const digest = {
    digest_id: DIGEST_ID,
    group: '路径迁移回归群',
    since: '2026-07-30 09:00:00',
    until: '2026-07-30 10:00:00',
    message_count: 1,
    headline: '相对路径必须优先',
    highlights: ['旧绝对路径不能盖过可迁移路径'],
    topics: [],
    created_at: '2026-07-30T01:00:00.000Z',
  };
  await Promise.all([
    fsp.writeFile(portablePng, PNG),
    fsp.writeFile(stalePng, PNG),
    fsp.writeFile(portableDigest, `${JSON.stringify(digest, null, 2)}\n`, 'utf8'),
    fsp.writeFile(staleDigest, `${JSON.stringify({ ...digest, digest_id: `stale-${DIGEST_ID}` }, null, 2)}\n`, 'utf8'),
  ]);
  await fsp.writeFile(path.join(TEST_ROOT, 'index.json'), JSON.stringify([{
    digest_id: DIGEST_ID,
    group: digest.group,
    since: digest.since,
    until: digest.until,
    created_at: digest.created_at,
    file_path: stalePng,
    relative_path: 'portable.png',
    digest_path: staleDigest,
    digest_relative_path: 'portable.digest.json',
  }], null, 2));

  const listed = await listHistory(settingsFor(TEST_ROOT), { limit: 10, bypassCache: true });
  const item = listed.items.find(candidate => candidate.digest_id === DIGEST_ID);
  assert.ok(item?.history_item_key, 'the portable history fixture must remain addressable by its opaque key');
  const found = await findHistoryItem(settingsFor(TEST_ROOT), DIGEST_ID, { history_item_key: item.history_item_key });
  assert.equal(path.basename(found?.file_path || ''), 'portable.png', 'relative PNG path must win over a stale absolute path');
  assert.equal(path.basename(found?.digest_path || ''), 'portable.digest.json', 'relative digest path must win over a stale absolute path');
} finally {
  if (priorScope === undefined) delete process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE;
  else process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = priorScope;
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
}

console.log('history path portability tests passed');
