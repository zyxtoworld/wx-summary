import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { OUTPUTS_TMP_DIR } from '../src/lib/paths.js';
import { outputFileVersion } from '../src/renderer/output.js';

const file = path.join(OUTPUTS_TMP_DIR, `output-version-cache-${process.pid}-${Date.now()}-${crypto.randomUUID()}.bin`);
const originalOpen = fsp.open;
let bytesRead = 0;

try {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.alloc(2 * 1024 * 1024, 0x41));
  fsp.open = async function countedVersionOpen(target, ...args) {
    const handle = await originalOpen.call(this, target, ...args);
    if (path.resolve(String(target)).toLowerCase() !== path.resolve(file).toLowerCase()) return handle;
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      bytesRead += Number(result?.bytesRead || 0) || 0;
      return result;
    };
    return handle;
  };

  const first = await outputFileVersion(file);
  assert.match(first, /^v2:/);
  assert.ok(bytesRead >= 2 * 1024 * 1024, 'the first version calculation must hash the file contents');

  bytesRead = 0;
  const second = await outputFileVersion(file);
  assert.equal(second, first);
  assert.ok(
    bytesRead >= 2 * 1024 * 1024,
    'canonical strong-version reads must rehash unchanged files because Windows replacements can preserve the cache-key metadata',
  );

  await new Promise(resolve => setTimeout(resolve, 20));
  await fsp.writeFile(file, Buffer.alloc(2 * 1024 * 1024, 0x42));
  bytesRead = 0;
  const changed = await outputFileVersion(file);
  assert.notEqual(changed, first, 'rewriting the file must invalidate the cached strong version');
  assert.ok(bytesRead >= 2 * 1024 * 1024, 'a changed file must be hashed again');
} finally {
  fsp.open = originalOpen;
  await fsp.rm(file, { force: true });
}

console.log('output file version cache tests passed');
