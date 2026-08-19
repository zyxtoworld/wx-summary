import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isLoopbackPortUnavailableError } from '../src/lib/loopback-listen.js';

assert.equal(
  isLoopbackPortUnavailableError({ code: 'EADDRINUSE' }, { platform: 'linux' }),
  true,
  '各平台的地址占用都必须换用下一个候选端口',
);
assert.equal(
  isLoopbackPortUnavailableError({ code: 'EACCES' }, { platform: 'win32' }),
  true,
  'Windows 独占或保留 loopback 端口可能返回 EACCES，必须按候选不可用处理',
);
assert.equal(
  isLoopbackPortUnavailableError({ code: 'EACCES' }, { platform: 'linux' }),
  false,
  '非 Windows 权限错误不能伪装成普通端口冲突',
);
assert.equal(
  isLoopbackPortUnavailableError({ code: 'EMFILE' }, { platform: 'win32' }),
  false,
  '资源耗尽等非端口冲突错误必须继续抛出',
);
assert.equal(isLoopbackPortUnavailableError(null, { platform: 'win32' }), false);

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const tryListenStart = mainSource.indexOf('function tryListen(');
const tryListenEnd = mainSource.indexOf('function candidatePorts(', tryListenStart);
assert.ok(tryListenStart >= 0 && tryListenEnd > tryListenStart,
  '必须能定位生产 loopback 监听函数');
const tryListenSource = mainSource.slice(tryListenStart, tryListenEnd);

function productionTryListenWith(errorCode) {
  const fakeHttp = {
    createServer() {
      const listeners = new Map();
      return {
        on(name, listener) {
          listeners.set(name, listener);
          return this;
        },
        once(name, listener) {
          listeners.set(name, listener);
          return this;
        },
        listen() {
          queueMicrotask(() => listeners.get('error')?.(Object.assign(new Error(errorCode), {
            code: errorCode,
          })));
        },
      };
    },
  };
  return new Function(
    'http',
    'handle',
    'ACTIVE_SOCKETS',
    'HOST',
    'isLoopbackPortUnavailableError',
    `${tryListenSource}; return tryListen;`,
  )(fakeHttp, () => {}, new Set(), '127.0.0.1', error => (
    isLoopbackPortUnavailableError(error, { platform: 'win32' })
  ));
}

assert.equal(await productionTryListenWith('EACCES')(49786), null,
  '生产监听遇到 Windows EACCES 必须返回候选不可用，让 main 尝试下一端口');
await assert.rejects(
  () => productionTryListenWith('EMFILE')(49786),
  error => error?.code === 'EMFILE',
  '生产监听遇到非端口冲突错误必须继续失败，不能掩盖资源耗尽',
);

const staticSource = await readFile(
  new URL('./acceptance/static-checks.mjs', import.meta.url),
  'utf8',
);
assert.match(staticSource, /if \(!isLoopbackPortUnavailableError\(e\)\) throw e;/,
  '完整验收的随机 loopback server 必须复用同一 Windows 端口冲突合同');

console.log('loopback listen error contract passed');
