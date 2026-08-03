import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_FILE = path.join(ROOT, 'package-lock.json');
const STAMP_FILE = path.join(ROOT, 'node_modules', '.wx-summary-install.json');
const WRITE_STAMP = process.argv.includes('--write-stamp');

async function expectedStamp() {
  const lock = await fsp.readFile(LOCK_FILE);
  return {
    v: 1,
    lock_sha256: crypto.createHash('sha256').update(lock).digest('hex'),
    platform: process.platform,
    arch: process.arch,
    node_abi: String(process.versions.modules || ''),
  };
}

function sameStamp(actual, expected) {
  return actual?.v === expected.v
    && actual?.lock_sha256 === expected.lock_sha256
    && actual?.platform === expected.platform
    && actual?.arch === expected.arch
    && actual?.node_abi === expected.node_abi;
}

async function verifyRuntimeDependencies() {
  await import('@signalapp/sqlcipher');
  await import('koffi');
  await import('pngjs');
}

async function writeStamp(stamp) {
  await fsp.mkdir(path.dirname(STAMP_FILE), { recursive: true });
  const tmp = `${STAMP_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(stamp, null, 2)}\n`, 'utf-8');
  await fsp.rename(tmp, STAMP_FILE);
}

async function main() {
  const expected = await expectedStamp();
  if (!WRITE_STAMP) {
    const actual = await fsp.readFile(STAMP_FILE, 'utf-8').then(JSON.parse, () => null);
    if (!sameStamp(actual, expected)) process.exit(1);
  }
  await verifyRuntimeDependencies();
  if (WRITE_STAMP) await writeStamp(expected);
}

main().catch(error => {
  console.error(error?.message || String(error));
  process.exit(1);
});
