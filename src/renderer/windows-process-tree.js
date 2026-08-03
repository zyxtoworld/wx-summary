import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import koffi from 'koffi';

const WINDOWS_TASKKILL_TIMEOUT_MS = 5000;
const WINDOWS_PROCESS_CLEANUP = Symbol('wx-summary.windows-process-cleanup');
const WINDOWS_PROCESS_SYNCHRONIZE = 0x00100000;
const WINDOWS_WAIT_TIMEOUT = 0x00000102;
const WINDOWS_PROCESS_IDENTITY_API = loadWindowsProcessIdentityApi();

export async function terminateWindowsProcessTree(child, {
  isClosed = () => false,
  retryMs = 2000,
  pollMs = 50,
  responseWaitMs = 5000,
  openProcessIdentity = openWindowsProcessIdentity,
  processIdentityAlive = windowsProcessIdentityAlive,
  closeProcessIdentity = closeWindowsProcessIdentity,
  killTree = runWindowsTaskkill,
  wait = waitForProcessPoll,
} = {}) {
  const pid = Number(child?.pid || 0);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { pid: 0, terminated: true, cleanup: Promise.resolve() };
  }
  let identity = null;
  try { identity = await openProcessIdentity(pid); } catch {}
  const cleanup = (identity
    ? terminateUntilGone(child, {
      pid,
      identity,
      isClosed,
      processIdentityAlive,
      killTree,
      wait,
      retryMs: Math.max(250, Number(retryMs || 0) || 2000),
      pollMs: Math.max(25, Number(pollMs || 0) || 50),
    })
    : terminateWithoutReusablePid(child, {
      isClosed,
      wait,
      pollMs: Math.max(25, Number(pollMs || 0) || 50),
    }))
    .catch(() => {})
    .finally(() => Promise.resolve(identity ? closeProcessIdentity(identity) : undefined).catch(() => {}));
  const terminated = await Promise.race([
    cleanup.then(() => true),
    wait(Math.max(250, Number(responseWaitMs || 0) || 5000)).then(() => false),
  ]);
  return { pid, terminated, cleanup, identity_bound: !!identity };
}

export function attachWindowsProcessCleanup(error, cleanup) {
  if (!error || typeof error !== 'object' || typeof cleanup?.then !== 'function') return error;
  Object.defineProperty(error, WINDOWS_PROCESS_CLEANUP, {
    value: cleanup,
    enumerable: false,
    configurable: false,
  });
  return error;
}

export function windowsProcessCleanupForError(error) {
  const cleanup = error?.[WINDOWS_PROCESS_CLEANUP];
  return typeof cleanup?.then === 'function' ? cleanup : null;
}

async function terminateUntilGone(child, {
  pid,
  identity,
  isClosed,
  processIdentityAlive,
  killTree,
  wait,
  retryMs,
  pollMs,
}) {
  let nextKillAt = 0;
  while (true) {
    if (isClosed() || !(await processIdentityAlive(identity))) return;
    const now = Date.now();
    if (now >= nextKillAt) {
      const treeKillConfirmed = await killTree(pid);
      if (!treeKillConfirmed && !isClosed() && await processIdentityAlive(identity)) {
        try { child.kill('SIGKILL'); } catch {}
      }
      nextKillAt = Date.now() + retryMs;
      continue;
    }
    await wait(Math.min(pollMs, Math.max(1, nextKillAt - now)));
  }
}

async function terminateWithoutReusablePid(child, { isClosed, wait, pollMs }) {
  try { child.kill('SIGKILL'); } catch {}
  while (!isClosed() && child?.exitCode === null && child?.signalCode === null) {
    await wait(pollMs);
  }
}

function loadWindowsProcessIdentityApi() {
  if (process.platform !== 'win32') return null;
  try {
    const kernel32 = koffi.load('kernel32.dll');
    return {
      OpenProcess: kernel32.func('void* __stdcall OpenProcess(uint32, bool, uint32)'),
      WaitForSingleObject: kernel32.func('uint32 __stdcall WaitForSingleObject(void*, uint32)'),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(void*)'),
    };
  } catch {
    return null;
  }
}

function openWindowsProcessIdentity(pid) {
  const api = WINDOWS_PROCESS_IDENTITY_API;
  if (!api) return null;
  const handle = api.OpenProcess(WINDOWS_PROCESS_SYNCHRONIZE, false, Number(pid));
  return handle ? { api, handle, pid: Number(pid) } : null;
}

function windowsProcessIdentityAlive(identity) {
  if (!identity?.api || !identity?.handle) return false;
  try {
    return identity.api.WaitForSingleObject(identity.handle, 0) === WINDOWS_WAIT_TIMEOUT;
  } catch {
    return false;
  }
}

function closeWindowsProcessIdentity(identity) {
  if (!identity?.api || !identity?.handle) return;
  try { identity.api.CloseHandle(identity.handle); } catch {}
}

function windowsTaskkillExecutablePath() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidate = path.join(root, 'System32', 'taskkill.exe');
  try {
    return fs.existsSync(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

function runWindowsTaskkill(pid) {
  const taskkillPath = windowsTaskkillExecutablePath();
  if (!taskkillPath) return Promise.resolve(false);
  return new Promise(resolve => {
    let killer;
    try {
      killer = spawn(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { killer.kill('SIGKILL'); } catch {}
      finish(false);
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    timer.unref?.();
    killer.once('error', () => finish(false));
    killer.once('close', code => finish(code === 0));
  });
}

function waitForProcessPoll(timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
}
