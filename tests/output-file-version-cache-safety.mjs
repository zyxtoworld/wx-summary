import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

const runId = `${process.pid}-${Date.now()}`;
const fixtureRelative = `outputs/.tmp/output-file-version-cache-safety-${runId}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = `${fixtureRelative}/data`;

const { outputFileVersion } = await import('../src/renderer/output.js');
const fixture = path.resolve(fixtureRelative);
const file = path.join(fixture, 'same-metadata.json');

try {
  await fsp.mkdir(fixture, { recursive: true });
  await fsp.writeFile(file, '{"a":1}', 'utf8');
  const first = await outputFileVersion(file);
  await fsp.writeFile(file, '{"b":2}', 'utf8');
  const second = await outputFileVersion(file);

  assert.match(first, /^v2:/);
  assert.match(second, /^v2:/);
  assert.notEqual(
    first.split(':').at(-1),
    second.split(':').at(-1),
    'same-length replacements must never reuse a cached content hash',
  );

  const source = await fsp.readFile(new URL('../src/renderer/output.js', import.meta.url), 'utf8');
  const versionSource = source.slice(
    source.indexOf('export async function outputFileVersion('),
    source.indexOf('\nasync function outputFileVersionAfterCommit'),
  );
  assert.doesNotMatch(
    versionSource,
    /cachedOutputFileVersion/,
    'the canonical content-version API must hash the opened file instead of trusting a stat-keyed cache',
  );
} finally {
  await fsp.rm(fixture, { recursive: true, force: true }).catch(() => {});
}

console.log('output file version cache safety passed');
