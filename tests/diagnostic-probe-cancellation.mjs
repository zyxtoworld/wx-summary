import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing production function: ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated production function: ${marker}`);
}

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const runDiagnosticProbe = new Function(
  'throwIfRequestSignalAborted',
  'requestAbortError',
  'requestTimeoutError',
  'logWarn',
  'requestSignalAborted',
  'sanitizeText',
  `${extractFunction(source, 'async function runDiagnosticProbe(')}\nreturn runDiagnosticProbe;`,
)(
  signal => {
    if (signal?.aborted) throw signal.reason;
  },
  message => Object.assign(new Error(message), { name: 'AbortError', status: 499 }),
  message => Object.assign(new Error(message), { name: 'TimeoutError', status: 504 }),
  () => {},
  (signal, error) => !!signal?.aborted || error?.status === 499,
  value => String(value || ''),
);

const outer = new AbortController();
const cancellation = Object.assign(new Error('诊断请求已取消'), {
  name: 'AbortError',
  status: 499,
});
const actionGate = deferred();
let actionStarted = 0;
const pending = runDiagnosticProbe('取消竞态探测', 5000, outer.signal, signal => {
  actionStarted += 1;
  assert.equal(signal.aborted, true, '取消后的探测 action 若被调用也只能看到已取消 signal');
  return actionGate.promise;
});
outer.abort(cancellation);
await assert.rejects(pending, error => error === cancellation,
  '诊断请求取消必须向 caller 投影原始取消原因');
assert.equal(actionStarted, 0,
  'outer request 已取消时不得在排队微任务中启动诊断 action 或子进程');
actionGate.resolve();

console.log('diagnostic probe cancellation tests passed');
