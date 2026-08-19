// 会话握手:在当前 origin 的 sessionStorage 中保存会话与服务实例身份。
// 流程:URL ?bootstrap= → 记住 bootstrap → GET /api/session → 记住 token + service_instance_id。
import { readResponseTextLimited } from '/js/shared/response-reader.js';

const SESSION_TOKEN_STORAGE_KEY = `wx-summary:session-token:${location.origin}`;
const SERVICE_INSTANCE_STORAGE_KEY = `wx-summary:service-instance:${location.origin}`;
const BOOTSTRAP_TOKEN_STORAGE_KEY = `wx-summary:bootstrap-token:${location.origin}`;

const SESSION_BOOTSTRAP_TIMEOUT_MS = 10 * 1000;
const SESSION_ERROR_MAX_BYTES = 256 * 1024;

let TOKEN = '';
let SERVICE_INSTANCE_ID = '';
let sessionBootstrapPromise = null;
let sessionInvalidationOwnerToken = null;

export function normalizeServiceInstanceId(value = '') {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{16,128}$/.test(id) ? id : '';
}

function safeGet(storage, key) {
  try { return String(storage.getItem(key) || '').trim(); } catch { return ''; }
}

function safeSet(storage, key, value) {
  try {
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
  } catch {}
}

export function storedSessionToken() {
  return safeGet(sessionStorage, SESSION_TOKEN_STORAGE_KEY);
}

export function storedServiceInstanceId() {
  return normalizeServiceInstanceId(safeGet(sessionStorage, SERVICE_INSTANCE_STORAGE_KEY));
}

export function storedBootstrapToken() {
  return safeGet(sessionStorage, BOOTSTRAP_TOKEN_STORAGE_KEY);
}

export function rememberSessionToken(token = '') {
  const clean = String(token || '').trim();
  TOKEN = clean;
  // 新 token 开启新的会话代际;同一旧 token 的并发失效仍共用一次
  // 全局终态处理,不能因每个请求都调用 clear/renew 而重复提示。
  if (clean && clean !== sessionInvalidationOwnerToken) {
    sessionInvalidationOwnerToken = null;
  }
  safeSet(sessionStorage, SESSION_TOKEN_STORAGE_KEY, clean);
}

export function rememberServiceInstanceId(value = '') {
  const clean = normalizeServiceInstanceId(value);
  SERVICE_INSTANCE_ID = clean;
  safeSet(sessionStorage, SERVICE_INSTANCE_STORAGE_KEY, clean);
  return clean;
}

export function rememberBootstrapToken(token = '') {
  safeSet(sessionStorage, BOOTSTRAP_TOKEN_STORAGE_KEY, String(token || '').trim());
}

export function clearSessionToken() {
  rememberSessionToken('');
  rememberServiceInstanceId('');
}

export function currentToken() {
  return TOKEN;
}

export function currentServiceInstanceId() {
  return SERVICE_INSTANCE_ID;
}

// 认领当前旧 token 的全局失效处理。续租握手本身虽可共享,但多个请求
// 仍可能同时观察到失败;只有一个请求可以把该事实投影为致命会话提示。
export function claimSessionInvalidation(rejectedToken = '') {
  const token = String(rejectedToken || '').trim();
  if (sessionInvalidationOwnerToken === token) return false;
  sessionInvalidationOwnerToken = token;
  return true;
}

export function sessionInvalidationAlreadyClaimed(rejectedToken = '') {
  return sessionInvalidationOwnerToken === String(rejectedToken || '').trim();
}

export function bootstrapTokenFromLocation() {
  try {
    return String(new URL(location.href).searchParams.get('bootstrap') || '').trim();
  } catch {
    return '';
  }
}

export function removeBootstrapTokenFromLocation() {
  try {
    const next = new URL(location.href);
    if (!next.searchParams.has('bootstrap')) return;
    next.searchParams.delete('bootstrap');
    history.replaceState(history.state, document.title, `${next.pathname}${next.search}${next.hash}`);
  } catch {}
}

function sessionError(message, status = 403, code = 'SESSION_BOOTSTRAP_FAILED') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.sessionFatal = true;
  return error;
}

function throwIfSessionBootstrapAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error('会话建立超时');
}

function parseErrorPayload(text = '') {
  try { return JSON.parse(text); } catch { return null; }
}

function sessionWaitAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === 'AbortError' && reason.status === 499) {
    return reason;
  }
  const message = reason instanceof Error
    ? (reason.message || '会话建立已取消')
    : (typeof reason === 'string' && reason ? reason : '会话建立已取消');
  const error = new Error(message);
  error.name = 'AbortError';
  error.status = 499;
  if (reason instanceof Error && reason.code) error.code = reason.code;
  return error;
}

// 握手 Promise 可以被多个页面请求复用,但每个调用者只能取消自己的等待。
function waitForSessionBootstrap(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(sessionWaitAbortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener?.('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(sessionWaitAbortError(signal));
    };
    signal.addEventListener?.('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}

// 建立(或复用)会话。assetVersion 用于让服务端识别过期的页面版本。
export async function ensureSessionToken({ signal = null, assetVersion = '' } = {}) {
  if (signal?.aborted) throw sessionWaitAbortError(signal);
  if (TOKEN) return TOKEN;
  const locationBootstrapToken = bootstrapTokenFromLocation();
  if (locationBootstrapToken) rememberBootstrapToken(locationBootstrapToken);
  const bootstrapToken = locationBootstrapToken || storedBootstrapToken();
  if (!locationBootstrapToken) {
    const stored = storedSessionToken();
    if (stored) {
      TOKEN = stored;
      SERVICE_INSTANCE_ID = storedServiceInstanceId() || SERVICE_INSTANCE_ID;
      return TOKEN;
    }
  }
  if (!sessionBootstrapPromise) {
    sessionBootstrapPromise = (async () => {
      const sessionPath = bootstrapToken
        ? `/api/session?bootstrap=${encodeURIComponent(bootstrapToken)}`
        : '/api/session';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('会话建立超时')), SESSION_BOOTSTRAP_TIMEOUT_MS);
      try {
        const response = await fetch(sessionPath, {
          headers: assetVersion ? { 'X-WX-Asset-Version': assetVersion } : {},
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          const text = await readResponseTextLimited(response, {
            maxBytes: SESSION_ERROR_MAX_BYTES,
            signal: controller.signal,
          });
          throwIfSessionBootstrapAborted(controller.signal);
          const parsed = parseErrorPayload(text);
          const code = String(parsed?.code || '').trim();
          clearSessionToken();
          if (code === 'invalid_bootstrap_token') {
            rememberBootstrapToken('');
            removeBootstrapTokenFromLocation();
          }
          const message = typeof parsed?.error === 'string' && parsed.error.trim()
            ? parsed.error.trim()
            : '启动会话凭据无效，请从本地启动器重新打开页面。';
          throw sessionError(message, response.status || 403);
        }
        let data;
        try {
          const text = await readResponseTextLimited(response, {
            maxBytes: SESSION_ERROR_MAX_BYTES,
            signal: controller.signal,
          });
          throwIfSessionBootstrapAborted(controller.signal);
          data = JSON.parse(text);
        } catch (error) {
          if (error?.code) throw error;
          throw sessionError('本地服务返回的会话数据无法解析，请重启本地服务后再试。', 502);
        }
        const token = String(data?.token || '').trim();
        const serviceInstanceId = normalizeServiceInstanceId(data?.service_instance_id || '');
        if (!token || !serviceInstanceId) {
          throw sessionError('本地服务没有返回完整会话信息，请重启服务后再试。', 403);
        }
        rememberSessionToken(token);
        rememberServiceInstanceId(serviceInstanceId);
        removeBootstrapTokenFromLocation();
        return TOKEN;
      } catch (error) {
        // 只有内部 controller 的超时回调可以 abort;fetch 可能按 signal.reason
        // 抛普通 Error,不能依赖错误 name 判断是否为握手超时。
        if (controller.signal.aborted) {
          throw sessionError('建立本地服务会话超过 10 秒，请确认本地服务仍在运行后刷新重试。', 504, 'session_bootstrap_timeout');
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      sessionBootstrapPromise = null;
    });
  }
  return waitForSessionBootstrap(sessionBootstrapPromise, signal);
}

// token 被拒后尝试重建会话;成功且换了新 token 返回 true。
export async function renewSessionTokenAfterRejection(rejectedToken = '', { signal = null, assetVersion = '' } = {}) {
  const rejected = String(rejectedToken || '').trim();
  if (!TOKEN || TOKEN === rejected) clearSessionToken();
  try {
    await ensureSessionToken({ signal, assetVersion });
    return !!TOKEN && TOKEN !== rejected;
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.status === 499) throw error;
    return false;
  }
}

// 页面卸载或确认服务重启后,清掉本地凭据。
export function resetSessionForReload() {
  clearSessionToken();
}
