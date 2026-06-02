import crypto from 'node:crypto';

const V4_FORMAT1 = Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]);
const V4_FORMAT2 = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]);
const V4_FORMAT1_AES_KEY = Buffer.from('cfcd208495d565ef', 'ascii');
const V4_DEFAULT_XOR_KEY = 0x37;
const V4_DATA_OFFSET = 15;

export function extractPlainImage(buffer, imageKeyCandidates = []) {
  const direct = completeImageBytes(buffer);
  if (direct) return direct;
  for (let offset = 0; offset < Math.min(128, buffer.length); offset++) {
    const sliced = buffer.subarray(offset);
    const complete = completeImageBytes(sliced);
    if (complete) return complete;
  }
  return decodeWeChatV4ImageDat(buffer, imageKeyCandidates) || tryDecodeXorImage(buffer);
}

export function decodeWeChatV4ImageDat(buffer, imageKeyCandidates = []) {
  if (!Buffer.isBuffer(buffer) || buffer.length < V4_DATA_OFFSET + 16) return null;
  const format = detectWeChatV4Format(buffer);
  if (!format) return null;

  const aesSize = buffer.readUInt32LE(6);
  const xorSize = buffer.readUInt32LE(10);
  const fileData = buffer.subarray(V4_DATA_OFFSET);
  const alignedAesSize = alignedPkcs7Size(aesSize);
  if (aesSize <= 0 || alignedAesSize > fileData.length || xorSize > fileData.length - alignedAesSize) return null;

  const encryptedAes = fileData.subarray(0, alignedAesSize);
  const middleEnd = fileData.length - xorSize;
  const middle = fileData.subarray(alignedAesSize, middleEnd);
  const xorTail = fileData.subarray(middleEnd);
  const keys = format === 1 ? [V4_FORMAT1_AES_KEY] : normalizeImageKeys(imageKeyCandidates);

  for (const key of keys) {
    const decryptedHead = decryptAesEcbPkcs7(encryptedAes, key);
    if (!decryptedHead || decryptedHead.length !== aesSize) continue;
    if (!detectImageMime(decryptedHead) && !looksLikeSupportedImagePrefix(decryptedHead)) continue;

    const xorKeys = inferXorKeys(xorTail, decryptedHead);
    for (const xorKey of xorKeys) {
      const tail = xorTail.length ? xorBuffer(xorTail, xorKey) : xorTail;
      const bytes = Buffer.concat([decryptedHead, middle, tail]);
      const complete = completeImageBytes(bytes);
      if (complete) return complete;
      const wxgfMime = detectWxgfMime(bytes);
      if (wxgfMime) return { mime: wxgfMime, bytes };
    }
  }
  return null;
}

export function isWeChatV4Format2(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= V4_FORMAT2.length && buffer.subarray(0, V4_FORMAT2.length).equals(V4_FORMAT2);
}

export function weChatV4ValidationSample(buffer) {
  if (!isWeChatV4Format2(buffer) || buffer.length < V4_DATA_OFFSET + 16) return null;
  return buffer.subarray(V4_DATA_OFFSET, V4_DATA_OFFSET + 16);
}

export function validateImageKeyCandidate(candidate, samples) {
  return imageKeyValidationCount(candidate, samples) > 0;
}

export function imageKeyValidationCount(candidate, samples) {
  const list = Array.isArray(samples) ? samples : [];
  let best = 0;
  for (const key of possibleImageKeys(candidate)) {
    let count = 0;
    for (const sample of list) {
      if (!Buffer.isBuffer(sample) || sample.length < 16) continue;
      const plaintext = decryptAesEcbNoPadding(sample.subarray(0, 16), key);
      if (looksLikeSupportedImagePrefix(plaintext)) count++;
    }
    best = Math.max(best, count);
  }
  return best;
}

export function normalizeImageKeys(candidates) {
  const out = [];
  const seen = new Set();
  for (const item of candidates || []) {
    const key = normalizeImageKey(item);
    if (!key) continue;
    const hex = key.toString('hex');
    if (!seen.has(hex)) {
      seen.add(hex);
      out.push(key);
    }
  }
  return out;
}

export function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

export function completeImageBytes(buffer) {
  const mime = detectImageMime(buffer);
  if (!mime) return null;
  if (mime === 'image/jpeg') {
    const end = lastIndexOfBuffer(buffer, Buffer.from([0xff, 0xd9]));
    return end > 2 ? { mime, bytes: buffer.subarray(0, end + 2) } : null;
  }
  if (mime === 'image/png') {
    const end = buffer.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
    return end >= 8 ? { mime, bytes: buffer.subarray(0, end + 12) } : null;
  }
  if (mime === 'image/gif') {
    const end = buffer.lastIndexOf(0x3b);
    return end > 6 ? { mime, bytes: buffer.subarray(0, end + 1) } : null;
  }
  if (mime === 'image/webp') {
    if (buffer.length < 12) return null;
    const size = buffer.readUInt32LE(4) + 8;
    return size >= 12 && size <= buffer.length ? { mime, bytes: buffer.subarray(0, size) } : null;
  }
  return null;
}

function detectWeChatV4Format(buffer) {
  if (buffer.subarray(0, V4_FORMAT1.length).equals(V4_FORMAT1)) return 1;
  if (buffer.subarray(0, V4_FORMAT2.length).equals(V4_FORMAT2)) return 2;
  return 0;
}

function normalizeImageKey(candidate) {
  if (Buffer.isBuffer(candidate)) {
    if (candidate.length >= 16) return candidate.subarray(0, 16);
    return null;
  }
  const text = String(candidate || '');
  if (/^[a-f0-9]{32}$/i.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9_-]{22,}={0,2}$/.test(text)) {
    const raw = Buffer.from(text, 'base64');
    if (raw.length >= 16) return raw.subarray(0, 16);
  }
  if (text.length >= 16) return Buffer.from(text.slice(0, 16), 'ascii');
  return null;
}

function possibleImageKeys(candidate) {
  const keys = [];
  const first = normalizeImageKey(candidate);
  if (first) keys.push(first);
  if (typeof candidate === 'string' && candidate.length >= 16) {
    keys.push(Buffer.from(candidate.slice(0, 16), 'ascii'));
  }
  const seen = new Set();
  return keys.filter(key => {
    if (!key || key.length !== 16) return false;
    const hex = key.toString('hex');
    if (seen.has(hex)) return false;
    seen.add(hex);
    return true;
  });
}

function alignedPkcs7Size(size) {
  const n = Number(size || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n + (16 - (n % 16));
}

function decryptAesEcbPkcs7(encrypted, key) {
  const plaintext = decryptAesEcbNoPadding(encrypted, key);
  if (!plaintext) return null;
  return stripPkcs7(plaintext);
}

function decryptAesEcbNoPadding(encrypted, key) {
  if (!Buffer.isBuffer(encrypted) || encrypted.length < 16 || encrypted.length % 16 !== 0 || !Buffer.isBuffer(key) || key.length !== 16) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    return null;
  }
}

function stripPkcs7(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  const pad = buffer[buffer.length - 1];
  if (pad < 1 || pad > 16 || pad > buffer.length) return null;
  for (let i = buffer.length - pad; i < buffer.length; i++) {
    if (buffer[i] !== pad) return null;
  }
  return buffer.subarray(0, buffer.length - pad);
}

function inferXorKeys(xorTail, decryptedHead = null) {
  const keys = [];
  if (Buffer.isBuffer(xorTail) && xorTail.length) {
    const mime = detectImageMime(decryptedHead);
    const trailers = mime ? imageTrailersForMime(mime) : [];
    for (const trailer of trailers) {
      const key = inferSingleByteXorKeyFromTrailer(xorTail, trailer);
      if (key !== null) keys.push(key);
    }
  }
  keys.push(V4_DEFAULT_XOR_KEY, 0x00);
  return [...new Set(keys.filter(k => Number.isInteger(k) && k >= 0 && k <= 0xff))];
}

function imageTrailersForMime(mime) {
  if (mime === 'image/jpeg') return [Buffer.from([0xff, 0xd9])];
  if (mime === 'image/png') {
    return [
      Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
      Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
    ];
  }
  if (mime === 'image/gif') return [Buffer.from([0x3b])];
  return [];
}

function inferSingleByteXorKeyFromTrailer(buffer, trailer) {
  if (!Buffer.isBuffer(buffer) || !Buffer.isBuffer(trailer) || buffer.length < trailer.length || !trailer.length) return null;
  const offset = buffer.length - trailer.length;
  const key = buffer[offset] ^ trailer[0];
  for (let i = 1; i < trailer.length; i++) {
    if ((buffer[offset + i] ^ trailer[i]) !== key) return null;
  }
  return key;
}

function xorBuffer(buffer, key) {
  const out = Buffer.allocUnsafe(buffer.length);
  for (let i = 0; i < buffer.length; i++) out[i] = buffer[i] ^ key;
  return out;
}

function tryDecodeXorImage(buffer) {
  const signatures = [
    { mime: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff]) },
    { mime: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { mime: 'image/gif', bytes: Buffer.from('GIF8') },
    { mime: 'image/webp', bytes: Buffer.from('RIFF') },
  ];
  for (let offset = 0; offset < Math.min(128, buffer.length); offset++) {
    for (const sig of signatures) {
      const key = buffer[offset] ^ sig.bytes[0];
      let ok = true;
      for (let i = 1; i < sig.bytes.length; i++) {
        if ((buffer[offset + i] ^ key) !== sig.bytes[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const bytes = Buffer.alloc(buffer.length - offset);
      for (let i = offset; i < buffer.length; i++) bytes[i - offset] = buffer[i] ^ key;
      const complete = completeImageBytes(bytes);
      if (complete) return complete;
    }
  }
  return null;
}

function lastIndexOfBuffer(buffer, needle) {
  for (let i = buffer.length - needle.length; i >= 0; i--) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (buffer[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function looksLikeSupportedImagePrefix(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  return detectImageMime(Buffer.concat([buffer, Buffer.alloc(Math.max(0, 12 - buffer.length))]))
    || buffer.subarray(0, 4).toString('ascii').toLowerCase() === 'wxgf';
}

function detectWxgfMime(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 16 && buffer.subarray(0, 4).toString('ascii') === 'wxgf'
    ? 'application/x-wxgf'
    : '';
}
