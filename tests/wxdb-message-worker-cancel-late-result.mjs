import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerFile = path.join(root, 'src', 'wxdb', 'message-worker.js');

const mockedIndexSource = `
  process.on('message', message => {
    if (message?.type === 'fixture_probe') process.send?.({ type: 'fixture_probe_ack' });
  });
  export async function collectMessagesFromWxDb({ onProgress } = {}) {
    process.send?.({ type: 'fixture_started' });
    await new Promise(resolve => {
      const onMessage = message => {
        if (message?.type !== 'fixture_release') return;
        process.off('message', onMessage);
        resolve();
        queueMicrotask(() => process.send?.({ type: 'fixture_finished' }));
      };
      process.on('message', onMessage);
    });
    onProgress?.({ phase: 'late_progress' });
    process.send?.({ type: 'fixture_about_to_return' });
    return { messages: [{ id: 'late-result' }] };
  }
  export async function extractSelfWxidFromProjectCopy() { return {}; }
  export async function listChatroomsFromWxDb() { return []; }
  export async function probeWxDb() { return {}; }
  export async function releaseWxDbWorkerSessionPlaintextCaches() {}
`;
const mockedIndexUrl = `data:text/javascript;base64,${Buffer.from(mockedIndexSource).toString('base64')}`;
const loaderSource = `
  const mockedIndexUrl = ${JSON.stringify(mockedIndexUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === './index.js' && context.parentURL.endsWith('/src/wxdb/message-worker.js')) {
      return { url: mockedIndexUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`;
const loaderUrl = `data:text/javascript;base64,${Buffer.from(loaderSource).toString('base64')}`;

const worker = fork(workerFile, [], {
  windowsHide: true,
  execArgv: ['--experimental-loader', loaderUrl],
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  env: { ...process.env, WX_SUMMARY_WXDB_PERSISTENT_WORKER: '0' },
});
const received = [];
let startedResolve;
let finishedResolve;
const started = new Promise(resolve => { startedResolve = resolve; });
const finished = new Promise(resolve => { finishedResolve = resolve; });
let probeResolve;
const probed = new Promise(resolve => { probeResolve = resolve; });
let exitedResolve;
const exited = new Promise(resolve => { exitedResolve = resolve; });
worker.on('message', message => {
  received.push(message);
  if (message?.type === 'fixture_started') startedResolve();
  if (message?.type === 'fixture_finished') finishedResolve();
  if (message?.type === 'fixture_probe_ack') probeResolve();
});
worker.once('exit', code => exitedResolve(code));

try {
  worker.send({ type: 'collect', request_id: 'cancel-late-result', payload: {} });
  await started;
  worker.send({ type: 'cancel', request_id: 'cancel-late-result' });
  worker.send({ type: 'fixture_release' });
  await finished;
  if (worker.exitCode === null) {
    worker.send({ type: 'fixture_probe' }, () => {});
    await Promise.race([probed, exited]);
  }

  assert.equal(
    received.some(message => message?.type === 'result'),
    false,
    'caller cancellation must prevent a late worker result from being published',
  );
  assert.equal(
    received.some(message => message?.type === 'progress'),
    false,
    'caller cancellation must prevent late worker progress from being published',
  );
} finally {
  if (worker.connected) worker.send({ type: 'close' }, () => {});
  await exited;
}

console.log('wxdb message worker cancel late-result tests passed');
