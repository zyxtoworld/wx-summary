import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const holdMatch = source.match(/const WINDOWS_EXPLORER_TOPMOST_HOLD_MS = ([\d_]+);/);

assert.ok(holdMatch, 'Explorer topmost hold budget must be explicit');
const holdMs = Number(holdMatch[1].replaceAll('_', ''));
assert.ok(holdMs >= 3_000 && holdMs <= 8_000, 'Explorer must remain visible briefly without staying topmost for the full verifier deadline');
assert.match(
  source,
  /const WINDOWS_EXPLORER_NATIVE_TOPMOST_HOLD_MS = WINDOWS_EXPLORER_TOPMOST_HOLD_MS;/,
  'native and fallback Explorer launchers must share one topmost budget',
);
assert.match(
  source,
  /WINDOWS_EXPLORER_TOPMOST_HOLD_MS < WINDOW_ACTION_VERIFICATION_TIMEOUT_MS/,
  'startup must reject a topmost budget that is coupled to the longer verification window',
);

console.log('Explorer topmost budget tests passed');
