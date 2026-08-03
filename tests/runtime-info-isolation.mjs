import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const previousAcceptanceMode = process.env.WX_SUMMARY_ACCEPTANCE_MODE;
const previousNoRuntimeFile = process.env.WX_SUMMARY_NO_RUNTIME_FILE;
const runId = `${process.pid}-${Date.now()}`;

process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = `outputs/.tmp/runtime-info-isolation-${runId}`;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `outputs/.tmp/runtime-info-isolation-${runId}/runtime-tmp/wxdb`;
delete process.env.WX_SUMMARY_NO_RUNTIME_FILE;

try {
  const { __mainInternals } = await import('../src/main.js');
  const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const runtimeInfoStart = mainSource.indexOf('function runtimeInfoEnabled()');
  const runtimeInfoEnd = mainSource.indexOf('\nfunction sameProjectRoot(', runtimeInfoStart);
  const runtimeInfoSource = mainSource.slice(runtimeInfoStart, runtimeInfoEnd);

  assert.equal(__mainInternals.runtimeInfoEnabled(), false, 'acceptance mode must disable shared runtime info even without a second environment flag');
  process.env.WX_SUMMARY_ACCEPTANCE_MODE = '0';
  assert.equal(__mainInternals.runtimeInfoEnabled(), true, 'ordinary service mode should retain runtime info management by default');
  process.env.WX_SUMMARY_NO_RUNTIME_FILE = '1';
  assert.equal(__mainInternals.runtimeInfoEnabled(), false, 'explicit runtime-file suppression must still work outside acceptance mode');
  assert.match(runtimeInfoSource, /if \(!runtimeInfoEnabled\(\)\) return false;/, 'runtime info writes must check the shared runtime-info gate');
  assert.match(runtimeInfoSource, /Number\(info\?\.pid \|\| 0\) !== process\.pid/, 'runtime info cleanup must verify the owning process');
  assert.match(runtimeInfoSource, /service_instance_id.*SERVICE_INSTANCE_ID/, 'runtime info cleanup must verify the owning service instance');
} finally {
  if (previousAcceptanceMode === undefined) delete process.env.WX_SUMMARY_ACCEPTANCE_MODE;
  else process.env.WX_SUMMARY_ACCEPTANCE_MODE = previousAcceptanceMode;
  if (previousNoRuntimeFile === undefined) delete process.env.WX_SUMMARY_NO_RUNTIME_FILE;
  else process.env.WX_SUMMARY_NO_RUNTIME_FILE = previousNoRuntimeFile;
}

console.log('runtime info isolation tests passed');
