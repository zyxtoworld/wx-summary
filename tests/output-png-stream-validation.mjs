import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TMP_DIR } from '../src/lib/paths.js';
import {
  inspectOutputFileVersion,
  openOutputFileHandleForStableRead,
  outputFileVersion,
  readOutputFileBuffer,
} from '../src/renderer/output.js';
import { __thumbnailInternals } from '../src/renderer/thumbnail.js';

const TEST_DIR = path.join(TMP_DIR, `output-png-stream-${process.pid}-${Date.now()}`);
const STREAM_SNAPSHOT_DIR = path.join(TMP_DIR, 'output-streams');

async function currentProcessStreamSnapshots() {
  const entries = await fsp.readdir(STREAM_SNAPSHOT_DIR).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter(name => name.startsWith(`${process.pid}.`)).sort();
}

function malformedPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    __thumbnailInternals.pngChunk('IHDR', header),
    __thumbnailInternals.pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x00])),
    __thumbnailInternals.pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  await fsp.mkdir(TEST_DIR, { recursive: true });
  const file = path.join(TEST_DIR, 'malformed.png');
  const data = malformedPng();
  await fsp.writeFile(file, data);
  const version = await outputFileVersion(file);

  assert.deepEqual(
    await inspectOutputFileVersion(file, {
      expected_file_version: version,
      max_bytes: 1024 * 1024,
      missingMessage: 'missing',
      missingCode: 'missing',
      version_artifact: 'png',
    }),
    { file_version: version, size: data.length },
    'download preflight should verify stable bytes without decoding the PNG payload',
  );

  const snapshotsBeforeInvalidOpen = await currentProcessStreamSnapshots();
  await assert.rejects(
    readOutputFileBuffer(file, {
      expected_file_version: version,
      max_bytes: 1024 * 1024,
      validate_png: true,
      version_artifact: 'png',
    }),
    error => error?.code === 'png_payload_invalid',
    'the actual PNG snapshot must still reject malformed zlib data',
  );

  await assert.rejects(
    (async () => {
      const opened = await openOutputFileHandleForStableRead(file, {
        expected_file_version: version,
        max_bytes: 1024 * 1024,
        validate_png: true,
        version_artifact: 'png',
      });
      await opened.handle.close();
    })(),
    error => error?.code === 'png_payload_invalid',
    'the stable streaming handle must validate the PNG before any response body is sent',
  );
  assert.deepEqual(
    await currentProcessStreamSnapshots(),
    snapshotsBeforeInvalidOpen,
    'failed PNG validation must close and remove its stream snapshot',
  );

  const validFile = path.join(TEST_DIR, 'valid.png');
  const validData = __thumbnailInternals.encodeRgbaPng(1, 1, Buffer.from([0, 20, 40, 60, 255]));
  const replacementData = __thumbnailInternals.encodeRgbaPng(1, 1, Buffer.from([200, 180, 160, 140, 255]));
  assert.equal(replacementData.length, validData.length, 'race fixture must preserve the source file size');
  await fsp.writeFile(validFile, validData);
  const validVersion = await outputFileVersion(validFile);
  const opened = await openOutputFileHandleForStableRead(validFile, {
    expected_file_version: validVersion,
    max_bytes: 1024 * 1024,
    validate_png: true,
    version_artifact: 'png',
  });
  try {
    assert.equal(opened.file_version, validVersion);
    assert.equal(opened.size, validData.length);
    assert.ok(opened.snapshot_path, 'streaming admission must expose its owned immutable snapshot for cleanup');
    assert.equal((await fsp.stat(opened.snapshot_path)).isFile(), true);
    await fsp.writeFile(validFile, replacementData);
    const chunks = [];
    for await (const chunk of opened.handle.createReadStream({ start: 0, end: opened.size - 1, autoClose: false })) {
      chunks.push(chunk);
    }
    const streamed = Buffer.concat(chunks);
    assert.deepEqual(streamed, validData, 'source replacement after admission must not alter the version-bound response bytes');
    assert.equal(
      opened.file_version.split(':').at(-1),
      crypto.createHash('sha256').update(streamed).digest('hex'),
      'the strong response version must hash the exact immutable bytes that will be streamed',
    );
  } finally {
    if (typeof opened.cleanup === 'function') await opened.cleanup();
    else await opened.handle.close();
  }
  assert.equal(await fsp.stat(opened.snapshot_path).catch(() => null), null, 'stream snapshot must be removed after cleanup');

  const outputSource = await fsp.readFile(path.join(process.cwd(), 'src', 'renderer', 'output.js'), 'utf8');
  const snapshotSource = outputSource.slice(
    outputSource.indexOf('export async function readOutputFileBuffer'),
    outputSource.indexOf('export async function openOutputFileHandleForStableRead'),
  );
  assert.ok(snapshotSource.includes('await validatePngFileHandle(handle, {'));
  assert.ok(snapshotSource.indexOf('await validatePngFileHandle(handle, {') < snapshotSource.indexOf('await readFileHandleBounded(handle, maxBytes, {'));
  assert.ok(!snapshotSource.includes('validatePngBuffer(data'));

  const openedHandleSource = outputSource.slice(
    outputSource.indexOf('export async function openOutputFileHandleForStableRead'),
    outputSource.indexOf('function historyFileVersionRequiredError'),
  );
  assert.ok(openedHandleSource.includes("snapshotHandle = await fsp.open(snapshotPath, 'wx+')"));
  assert.ok(openedHandleSource.includes('await copyOutputFileHandleToSnapshot(sourceHandle, snapshotHandle, beforeStat.size, {'));
  assert.ok(openedHandleSource.includes('await validatePngFileHandle(snapshotHandle, {'));
  assert.ok(openedHandleSource.indexOf('await copyOutputFileHandleToSnapshot(') < openedHandleSource.indexOf('await validatePngFileHandle(snapshotHandle, {'));
  assert.ok(openedHandleSource.includes('outputFileVersionFromHash(afterStat, copied.sha256)'));
  assert.ok(openedHandleSource.includes('snapshot_path: snapshotPath'));
  assert.ok(openedHandleSource.includes('cleanup,'));
  assert.ok(!openedHandleSource.includes('await hashOutputFileHandle(sourceHandle, {'));

  const mainSource = await fsp.readFile(path.join(process.cwd(), 'src', 'main.js'), 'utf8');
  const routeSource = mainSource.slice(
    mainSource.indexOf("if (pathname.startsWith('/api/digest-file/')"),
    mainSource.indexOf("if (pathname.startsWith('/api/digest-thumb/')"),
  );
  assert.ok(routeSource.includes('const downloadCheck = wantsOutputFileDownloadCheck(parsedUrl);'));
  assert.ok(routeSource.includes('snapshot = await inspectOutputFileVersion(file, {'));
  assert.ok(routeSource.indexOf('if (downloadCheck)') < routeSource.indexOf('releaseSnapshotSlot = await acquireHistoryPngSnapshotSlot'));
  assert.ok(routeSource.includes('openedFile = await openOutputFileHandleForStableRead(file, {'));
  assert.ok(routeSource.includes('await sendOpenedOutputFileStream(res, openedFile, {'));
  assert.ok(!routeSource.includes('readOutputFileBuffer(file, {'));

  const serverRenderSource = await fsp.readFile(path.join(process.cwd(), 'src', 'renderer', 'server-png.js'), 'utf8');
  const serverOutputSource = serverRenderSource.slice(
    serverRenderSource.indexOf('async function readServerRenderOutput'),
    serverRenderSource.indexOf('function windowsPowerShellExecutablePath'),
  );
  const validateServerPngCall = 'await validatePngFileHandle(handle, serverRenderPngValidationOptions({ signal, closeHandle }));';
  assert.ok(serverOutputSource.includes(validateServerPngCall));
  assert.ok(serverOutputSource.indexOf(validateServerPngCall) < serverOutputSource.indexOf('await readFileHandleBounded(handle, SERVER_RENDER_OUTPUT_MAX_PNG_BYTES, {'));
  assert.ok(!serverOutputSource.includes('validateServerRenderPngBuffer(buffer)'));

  console.log('output PNG streaming validation tests passed');
}

try {
  await main();
} finally {
  await fsp.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
}
