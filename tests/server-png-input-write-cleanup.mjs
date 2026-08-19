import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

const runRoot = `outputs/.tmp/server-png-input-write-cleanup-${process.pid}-${Date.now()}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = runRoot;

const paths = await import('../src/lib/paths.js');
const serverPng = await import('../src/renderer/server-png.js');
const originalWriteFile = fsp.writeFile;
let failedInput = '';
let inputStillExists = null;

try {
  fsp.writeFile = async (file, data, options) => {
    const name = path.basename(String(file));
    if (/^render-[a-f0-9]+\.json$/i.test(name)) {
      failedInput = String(file);
      await originalWriteFile(file, String(data).slice(0, 32), options);
      throw Object.assign(new Error('simulated input write failure'), { code: 'ENOSPC' });
    }
    return originalWriteFile(file, data, options);
  };

  await assert.rejects(
    serverPng.renderDigestPngBuffer({ headline: 'write failure', topics: [], todos: [], links: [] }),
    error => error?.code === 'ENOSPC',
    'a partial renderer input write failure should reach the caller',
  );
} finally {
  fsp.writeFile = originalWriteFile;
  inputStillExists = await fsp.stat(failedInput).then(() => true, () => false);
  await fsp.rm(paths.DATA_DIR, { recursive: true, force: true });
}

assert.ok(failedInput, 'the renderer test must reach its input JSON write');
assert.equal(inputStillExists, false,
  'a failed renderer input write must not leave a partial render JSON file');

console.log('server PNG input write cleanup test passed');
