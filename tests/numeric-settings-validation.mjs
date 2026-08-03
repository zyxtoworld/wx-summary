import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { parseStrictIntegerInput } = await import('../src/web/public/js/numeric-input.js');
const { loadSettings, saveSettingsPatch } = await import('../src/config/settings.js');

assert.deepEqual(parseStrictIntegerInput('1e2', { min: 1, max: 8 }), { ok: false, raw: '1e2', reason: 'format' });
assert.deepEqual(parseStrictIntegerInput('1.9', { min: 1, max: 8 }), { ok: false, raw: '1.9', reason: 'format' });
assert.equal(parseStrictIntegerInput('8', { min: 1, max: 8 }).value, 8);
assert.deepEqual(parseStrictIntegerInput('99', { min: 1, max: 8, clamp: true }), {
  ok: true,
  raw: '99',
  value: 8,
  clamped: true,
});
assert.equal(parseStrictIntegerInput('0', { min: 0, max: 3650 }).value, 0);

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-numeric-settings-'));
const settingsFile = path.join(root, 'settings.json');
const secretsFile = path.join(root, 'secrets.bin');

try {
  const before = await loadSettings({ settingsFile, secretsFile });
  await assert.rejects(
    () => saveSettingsPatch({ output: { retention_days: 1.9 } }, { settingsFile, secretsFile }),
    error => error?.code === 'settings_integer_invalid',
    'fractional retention must fail instead of silently becoming one day',
  );
  await assert.rejects(
    () => saveSettingsPatch({ llm: { ai_concurrency: '1e2' } }, { settingsFile, secretsFile }),
    error => error?.code === 'settings_integer_invalid',
    'string/exponent concurrency must fail instead of silently becoming one worker',
  );
  const afterRejected = await loadSettings({ settingsFile, secretsFile });
  assert.equal(afterRejected.output.retention_days, before.output.retention_days);
  assert.equal(afterRejected.llm.ai_concurrency, before.llm.ai_concurrency);

  const saved = await saveSettingsPatch({
    output: { retention_days: 30 },
    llm: { base_url: 'http://127.0.0.1:9999/v1', ai_concurrency: 4 },
  }, { settingsFile, secretsFile });
  assert.equal(saved.output.retention_days, 30);
  assert.equal(saved.llm.ai_concurrency, 4);
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

console.log('numeric settings validation tests passed');
