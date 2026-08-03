import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { toWellFormedText, truncateUnicodeText, truncateUtf8Text } from '../src/web/public/js/unicode-text.js';
import { __mainInternals } from '../src/main.js';

function hasLoneSurrogate(value = '') {
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        index += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xDC00 && unit <= 0xDFFF) return true;
  }
  return false;
}

assert.equal(toWellFormedText(`a\uD840b\uDC00c`), 'a\uFFFDb\uFFFDc');
assert.equal(truncateUnicodeText(`${'a'.repeat(119)}𠀀`, 120), `${'a'.repeat(119)}𠀀`);
assert.equal(hasLoneSurrogate(truncateUnicodeText(`${'a'.repeat(119)}𠀀`, 120)), false);
assert.ok(Buffer.byteLength(truncateUtf8Text('𠀀'.repeat(120), 220), 'utf8') <= 220);

const disposition = __mainInternals.attachmentDisposition(`${'a'.repeat(119)}\uD840.png`);
assert.match(disposition, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
assert.equal(hasLoneSurrogate(disposition), false);
assert.doesNotThrow(() => decodeURIComponent(disposition.split("UTF-8''")[1]));

const outputSource = await fs.readFile(new URL('../src/renderer/output.js', import.meta.url), 'utf8');
const filenameSource = outputSource.slice(outputSource.indexOf('function sanitizeName'), outputSource.indexOf('function compactTime'));
assert.ok(filenameSource.includes('truncateUnicodeText'));
assert.ok(filenameSource.includes('truncateUtf8Text'));
assert.equal(filenameSource.includes('.slice(0, 120)'), false);
const outputSandbox = { path, Buffer, toWellFormedText, truncateUnicodeText, truncateUtf8Text };
vm.runInNewContext(`${filenameSource}\nglobalThis.__sanitizeFilename = sanitizeFilename;`, outputSandbox);
const outputName = outputSandbox.__sanitizeFilename(`${'a'.repeat(119)}𠀀.png`, 'deadbeef');
assert.equal(hasLoneSurrogate(outputName), false);
assert.match(outputName, /__deadbeef\.png$/);
assert.ok(Buffer.byteLength(outputName, 'utf8') <= 224);

const appSource = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const downloadNameSource = appSource.slice(appSource.indexOf('function safePngDownloadFilename'), appSource.indexOf('async function downloadCanvas'));
assert.ok(downloadNameSource.includes('truncateUnicodeText'));
assert.ok(downloadNameSource.includes('truncateUtf8Text'));
assert.equal(downloadNameSource.includes('.slice(0, 140)'), false);
const appSandbox = { Date, String, truncateUnicodeText, truncateUtf8Text };
vm.runInNewContext(`${downloadNameSource}\nglobalThis.__safePngDownloadFilename = safePngDownloadFilename;`, appSandbox);
const downloadName = appSandbox.__safePngDownloadFilename({
  group: `${'a'.repeat(139)}𠀀`,
  digest_id: 'digest-id',
});
assert.equal(hasLoneSurrogate(downloadName), false);
assert.ok(Buffer.byteLength(downloadName, 'utf8') <= 220);

console.log('unicode filename safety tests passed');
