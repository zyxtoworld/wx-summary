export function toWellFormedText(value = '') {
  const text = String(value ?? '');
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += text[index] + text[index + 1];
        index += 1;
      } else {
        out += '\uFFFD';
      }
      continue;
    }
    out += unit >= 0xDC00 && unit <= 0xDFFF ? '\uFFFD' : text[index];
  }
  return out;
}

export function truncateUnicodeText(value = '', maxCodePoints = 0) {
  const limit = Math.max(0, Math.trunc(Number(maxCodePoints) || 0));
  if (!limit) return '';
  return [...toWellFormedText(value)].slice(0, limit).join('');
}

function utf8CodePointBytes(character = '') {
  const codePoint = character.codePointAt(0) || 0;
  if (codePoint <= 0x7F) return 1;
  if (codePoint <= 0x7FF) return 2;
  if (codePoint <= 0xFFFF) return 3;
  return 4;
}

export function truncateUtf8Text(value = '', maxBytes = 0) {
  const limit = Math.max(0, Math.trunc(Number(maxBytes) || 0));
  if (!limit) return '';
  let bytes = 0;
  let out = '';
  for (const character of toWellFormedText(value)) {
    const nextBytes = utf8CodePointBytes(character);
    if (bytes + nextBytes > limit) break;
    out += character;
    bytes += nextBytes;
  }
  return out;
}
