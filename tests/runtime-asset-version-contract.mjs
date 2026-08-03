import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const mainSource = await fsp.readFile(path.join(ROOT, 'src', 'main.js'), 'utf8');
const { __mainInternals } = await import('../src/main.js');

const runtimeFiles = (await __mainInternals.sourceAssetFilesForVersion())
  .map(file => path.relative(ROOT, file).replace(/\\/g, '/'));

assert.ok(runtimeFiles.includes('package.json'), 'runtime version must include package.json');
assert.ok(runtimeFiles.includes('package-lock.json'), 'runtime version must include the dependency lockfile');
assert.match(mainSource, /hash\.update\(`node:\$\{process\.versions\.node\}`\)/, 'runtime version must include the active Node.js version');

const publicFiles = (await __mainInternals.sourceAssetFilesForVersion(path.join(ROOT, 'src', 'web', 'public')))
  .map(file => path.relative(ROOT, file).replace(/\\/g, '/'));
assert.equal(publicFiles.includes('package.json'), false, 'static asset preloading must remain scoped to the requested public directory');

console.log('runtime asset version contract tests passed');
