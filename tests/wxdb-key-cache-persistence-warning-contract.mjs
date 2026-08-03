import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const collector = await fsp.readFile(new URL('../src/collector/index.js', import.meta.url), 'utf8');
const main = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const app = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

assert.match(collector, /function verifiedKeyCachePersistenceNotice\(/, 'collector must normalize key-cache persistence failures into stable metadata');
assert.match(collector, /Object\.defineProperty\(groups, '__key_cache_persistence'/, 'group-list results must retain key-cache persistence warnings after progress completes');
assert.match(collector, /key_cache_persistence:\s*keyCachePersistence/, 'message collection results must retain key-cache persistence warnings');

assert.match(main, /key_cache_persistence:\s*groupResult\.key_cache_persistence/, 'group API must return the stable key-cache persistence warning');
assert.match(main, /digest\.key_cache_persistence\s*=\s*collection\.key_cache_persistence/, 'digest results must return the stable key-cache persistence warning');

assert.match(app, /function digestKeyCachePersistenceWarning\(/, 'frontend must render stable key-cache persistence metadata');
assert.match(app, /keyCachePersistenceWarnings\s*=\s*new Map\(\)/, 'batch completion must retain warnings after transient stages are replaced');
assert.match(app, /keyCachePersistence:\s*null/, 'group cache must retain the warning for later rerenders');

console.log('wxdb key cache persistence warning contract tests passed');
