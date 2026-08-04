import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const mainStart = source.indexOf('export async function main()');
const entryStart = source.indexOf("const entry = process.argv[1]", mainStart);
assert.ok(mainStart >= 0 && entryStart > mainStart, 'startup implementation must remain inspectable');

const mainSource = source.slice(mainStart, entryStart);
const entrySource = source.slice(entryStart, source.indexOf('\nexport const __mainInternals', entryStart));

assert.match(
  mainSource,
  /if \(!server\) \{[\s\S]*?throw Object\.assign\([\s\S]*?new Error\([\s\S]*?code:\s*'startup_ports_unavailable'/,
  'port exhaustion must reject through the unified startup failure path',
);
assert.doesNotMatch(mainSource, /process\.exit\(/, 'main must not terminate before the startup failure logger can settle');
assert.match(entrySource, /async function handleStartupFailure\(/, 'startup failures must have one explicit asynchronous handler');
assert.match(entrySource, /if \(!STARTUP_LOGGER_CONFIGURED\) \{[\s\S]*?configureLogger\(runtimeLoggerSettings\(\)\)/, 'failures before settings load must initialize the default or environment-selected logger');
assert.match(entrySource, /logError\('startup_failed'/, 'the startup failure handler must enqueue the durable diagnostic');
assert.match(entrySource, /await waitForLoggerWritesToSettle\(/, 'the startup failure handler must wait for its queued diagnostic');
assert.match(entrySource, /process\.stderr\.write\([\s\S]*?日志写入未完成/, 'an incomplete startup log drain must remain visible on stderr');
assert.ok(
  entrySource.indexOf("logError('startup_failed'") < entrySource.indexOf('await waitForLoggerWritesToSettle(')
    && entrySource.indexOf('await waitForLoggerWritesToSettle(') < entrySource.indexOf('process.exit(1)'),
  'startup failure diagnostics must be queued, drained, and only then followed by process exit',
);
assert.match(entrySource, /main\(\)\.catch\(handleStartupFailure\)/, 'the executable entrypoint must use the unified failure handler');

console.log('startup failure log drain contract passed');
