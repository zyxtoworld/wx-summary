import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TMP_DIR, toProjectRelative } from '../src/lib/paths.js';
import { configureLogger, logInfo } from '../src/lib/logger.js';

const root = path.join(TMP_DIR, `logger-sanitize-${process.pid}-${crypto.randomUUID()}`);
const file = path.join(root, 'legacy.log');
const secret = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';

try {
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(file, [
    `2026-01-01T00:00:00.000Z INFO legacy_event {"api_key":"${secret}","error":"group secret"}`,
    ...Array.from({ length: 4000 }, () => '2026-01-01T00:00:01.000Z INFO legacy_event {"count":1}'),
  ].join('\n') + '\n', 'utf8');
  configureLogger({ file: `./${toProjectRelative(file)}`, max_mb: 1 });
  logInfo('logger_sanitization_complete', { ok: true });

  let text = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    text = await fsp.readFile(file, 'utf8');
    if (text.includes('logger_sanitization_complete')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(text, /logger_sanitization_complete/, 'logger should append after sanitizing an existing log');
  assert.equal(text.includes(secret), false, 'existing API-key-shaped values must be redacted before append');
  assert.match(text, /"api_key":"\[redacted\]"/, 'structured secret fields should retain their redacted shape');
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

console.log('logger existing-log sanitization test passed');
