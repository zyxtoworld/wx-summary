import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  isConfirmedMainWeixinProcess,
  normalizeWindowsWeixinProcesses,
  preferredWeixinProcess,
} from '../src/wxenv/discovery.js';
import { __wxkeyInternals } from '../src/wxkey/index.js';

const wxdbSource = await fs.readFile(new URL('../src/wxdb/index.js', import.meta.url), 'utf8');

const getProcessOnly = normalizeWindowsWeixinProcesses([
  {
    ProcessId: 101,
    Path: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
    StartTime: '2026-07-31T01:00:00.000Z',
    CommandLine: '',
    WorkingSet64: 100,
    PrivateMemorySize64: 120,
  },
  {
    ProcessId: 102,
    Path: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
    StartTime: '2026-07-31T01:00:01.000Z',
    CommandLine: '',
    WorkingSet64: 900,
    PrivateMemorySize64: 950,
  },
], { commandLineUnavailable: true });

assert.equal(getProcessOnly.some(process => process.is_main), false, 'Get-Process rows without command lines must not fabricate a main process');
assert.equal(preferredWeixinProcess(getProcessOnly)?.pid, 102, 'an unclassified process set should prefer the largest working set');
assert.deepEqual(
  __wxkeyInternals.orderWeixinProcessesForKeyScan(getProcessOnly).map(process => process.pid),
  [102, 101],
  'unclassified Weixin processes should be scanned by working set like the public reference scanner',
);
assert.equal(
  __wxkeyInternals.shouldPrioritizeWeixinProcessScan(getProcessOnly[0]),
  false,
  'an unclassified first process must not consume the confirmed-main budget share',
);
assert.equal(
  __wxkeyInternals.allocateSharedProcessScanMs(30_000, 2, {
    priority: __wxkeyInternals.shouldPrioritizeWeixinProcessScan(getProcessOnly[0]),
  }),
  15_000,
  'unclassified processes should split the remaining scan budget fairly',
);

const explicitMain = normalizeWindowsWeixinProcesses([
  {
    ProcessId: 201,
    ExecutablePath: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
    CommandLine: '"C:\\Program Files\\Tencent\\Weixin\\Weixin.exe"',
    WorkingSetSize: 100,
  },
  {
    ProcessId: 202,
    ExecutablePath: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
    CommandLine: '"C:\\Program Files\\Tencent\\Weixin\\Weixin.exe" --type=utility',
    WorkingSetSize: 900,
  },
]);

assert.equal(isConfirmedMainWeixinProcess(explicitMain[0]), true, 'a command-line-confirmed main process should remain eligible for priority scanning');
assert.deepEqual(
  __wxkeyInternals.orderWeixinProcessesForKeyScan(explicitMain).map(process => process.pid),
  [201, 202],
  'an explicitly confirmed main process should be scanned before helpers',
);
assert.equal(__wxkeyInternals.shouldPrioritizeWeixinProcessScan(explicitMain[0]), true);

const legacyHeuristic = [
  { pid: 301, is_main: true, main_process_confidence: 'heuristic', working_set_bytes: 100 },
  { pid: 302, is_main: false, main_process_confidence: 'unknown', working_set_bytes: 900 },
];
assert.deepEqual(
  __wxkeyInternals.orderWeixinProcessesForKeyScan(legacyHeuristic).map(process => process.pid),
  [302, 301],
  'legacy heuristic main flags must not override stronger working-set evidence',
);
assert.doesNotMatch(
  wxdbSource,
  /process\.is_main\s*\?\s*'（主进程）'\s*:\s*'（辅助进程）'/,
  'progress must not label every unconfirmed Weixin process as an auxiliary process',
);
assert.doesNotMatch(
  wxdbSource,
  /已优先检查主进程并为辅助进程保留时间/,
  'timeout guidance must not claim that an unconfirmed main process was prioritized',
);

console.log('Weixin key process priority tests passed');
