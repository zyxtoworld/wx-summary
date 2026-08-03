import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const collector = await fsp.readFile(new URL('../src/collector/index.js', import.meta.url), 'utf8');
const app = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

assert.match(collector, /verifiedWxdbKeyCacheInvalidInfo/, 'candidate collection must consume encrypted-cache recovery state');
assert.match(collector, /persistent_verified_key_cache_recovery_status/, 'key diagnostics must retain the cache recovery status');
assert.match(collector, /persistent_verified_key_cache_backup_relative_path/, 'key diagnostics must retain the safe backup path');
assert.match(app, /自动密钥缓存损坏/, 'group and digest failures must explain recovered key-cache corruption');
assert.match(app, /原文件已备份到/, 'group and digest failures must expose the preserved cache path when available');
assert.match(app, /persistent_verified_key_cache_backup_relative_path/, 'frontend failure text must use the server-provided safe backup path');

console.log('wxdb key cache diagnostics contract tests passed');
