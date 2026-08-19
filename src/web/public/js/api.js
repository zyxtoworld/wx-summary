// 统一 fetch 封装:自动带 x-wx-token / x-wx-asset-version,统一错误对象 shape。
// 错误对象:Error & { status, code, payload, responseText, outcomeUnknown? }
// - 409 stale_frontend_asset / service_restart_required → 触发 onStaleAsset(code) 回调后抛出
// - 403 invalid_token → 自动重建会话重试一次,仍失败触发 onSessionInvalid
// - 写操作(非 GET/HEAD)网络层失败(超时/断连)→ error.outcomeUnknown = true,
//   UI 必须表述为"结果未知",绝不说成功,也不自动重试。
import { readResponseTextLimited, readResponseBytesLimited } from '/js/shared/response-reader.js';
import {
  ensureSessionToken,
  currentToken,
  currentServiceInstanceId,
  claimSessionInvalidation,
  sessionInvalidationAlreadyClaimed,
  renewSessionTokenAfterRejection,
} from './session.js';
import { isMutationOutcomeUnknown } from '/js/shared/mutation-outcome.js';
import {
  beginLocalActionRecovery,
  completeLocalActionRecoveryAfterError,
  completeLocalActionRecoveryAfterResponse,
  localActionKindFromRequest,
  localActionTargetFromRequest,
} from '/js/shared/local-action-recovery.js';

export { isMutationOutcomeUnknown } from '/js/shared/mutation-outcome.js';

const JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const ERROR_RESPONSE_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;

function parseErrorPayload(text = '') {
  try { return JSON.parse(text); } catch { return null; }
}

export function errorCodeOf(error) {
  return String(error?.code || '').trim();
}

export function mutationOutcomeUnknown({
  mutation = false,
  requestStarted = false,
  outcomeConfirmed = false,
} = {}) {
  return mutation === true && requestStarted === true && outcomeConfirmed !== true;
}

function buildHttpError(text, status) {
  const parsed = parseErrorPayload(text);
  const rawMessage = parsed?.error?.message || parsed?.error || parsed?.message || parsed?.detail;
  const message = typeof rawMessage === 'string' && rawMessage.trim()
    ? rawMessage.trim()
    : (text.trim() || `请求失败（${status}）`);
  const error = new Error(message);
  error.status = status;
  error.code = String(parsed?.code || parsed?.error?.code || '').trim();
  error.payload = parsed;
  error.responseText = text;
  return error;
}

function localActionIdFromBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  return String(body.local_action_id || body.action_id || '').trim();
}

function localActionResponseMismatchError(expectedId, actualId = '') {
  const error = new Error('本地操作可能已经执行，但服务返回的动作标识与本次请求不一致；请查询动作结果或核对文件后再决定是否重试。');
  error.status = 502;
  error.code = 'local_action_response_id_mismatch';
  error.localActionId = expectedId;
  error.responseLocalActionId = actualId;
  return error;
}

function timeoutError(path, timeoutMs) {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const error = new Error(`本地服务请求超过 ${seconds} 秒没有返回：${path || 'API 请求'}。请稍后重试；如果仍失败，请重启本地服务。`);
  error.name = 'TimeoutError';
  error.status = 504;
  error.code = 'api_timeout';
  return error;
}

function networkError(path, cause) {
  const error = new Error(`无法连接本地服务：${path || 'API 请求'}。请确认本地服务仍在运行。`);
  error.status = 0;
  error.code = 'network_error';
  error.cause = cause;
  return error;
}

function abortFromSignal(signal, fallback = '请求已取消') {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === 'AbortError' && reason.status === 499) {
    return reason;
  }
  const message = reason instanceof Error
    ? (reason.message || fallback)
    : (typeof reason === 'string' && reason ? reason : fallback);
  const error = new Error(message);
  error.name = 'AbortError';
  error.status = 499;
  if (reason instanceof Error && reason.code) error.code = reason.code;
  return error;
}

function throwIfLinkedAborted(linked, path, timeoutMs) {
  if (!linked.signal.aborted) return;
  const reason = linked.signal.reason;
  if (linked.timedOut() || reason?.code === 'api_timeout') {
    throw reason instanceof Error ? reason : timeoutError(path, timeoutMs);
  }
  throw abortFromSignal(linked.signal);
}

// 把外部 signal 和超时合并成一个控制器。
function linkedSignal(signal, timeoutMs, path) {
  const controller = new AbortController();
  let timedOut = false;
  let finished = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError(path, timeoutMs));
    }, timeoutMs)
    : null;
  const onAbort = () => controller.abort(abortFromSignal(signal));
  signal?.addEventListener?.('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done() {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    },
  };
}

function raceRequestWithLinkedSignal(promise, linked, path, timeoutMs, markUnknown = null) {
  if (!linked?.signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => linked.signal.removeEventListener?.('abort', onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      const error = linked.timedOut()
        ? timeoutError(path, timeoutMs)
        : abortFromSignal(linked.signal);
      if (typeof markUnknown === 'function') markUnknown(error);
      if (linked.timedOut()) {
        linked.done();
        finish(reject, error);
        return;
      }
      linked.done();
      finish(reject, error);
    };
    if (linked.signal.aborted) {
      onAbort();
      return;
    }
    linked.signal.addEventListener?.('abort', onAbort, { once: true });
    promise.then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

export function createApi({ assetVersion = '', onStaleAsset = null, onSessionInvalid = null } = {}) {
  const version = String(assetVersion || '').trim();

  async function request(path, {
    method = 'GET',
    body = undefined,
    headers = {},
    signal = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    rawBody = false,
    expect = 'json',
    maxBytes = JSON_RESPONSE_MAX_BYTES,
    localActionId = '',
    localActionTarget = null,
  } = {}) {
    const verb = String(method || 'GET').toUpperCase();
    const mutation = !['GET', 'HEAD'].includes(verb);
    const expectedLocalActionId = String(localActionId || localActionIdFromBody(body)).trim();
    const linked = linkedSignal(signal, timeoutMs, path);
    let mutationRequestStarted = false;
    let mutationOutcomeConfirmed = false;
    const performRequest = async () => {
    let sessionRetryAvailable = true;
    const localActionKind = expectedLocalActionId
      ? localActionKindFromRequest(path, expectedLocalActionId, body)
      : '';
    let localActionRecoveryStarted = false;
    try {
      if (expectedLocalActionId && localActionKind) {
        beginLocalActionRecovery({
          actionId: expectedLocalActionId,
          kind: localActionKind,
          target: localActionTarget || localActionTargetFromRequest(body),
        });
        localActionRecoveryStarted = true;
      }
      while (true) {
        mutationRequestStarted = false;
        mutationOutcomeConfirmed = false;
        try {
          await ensureSessionToken({ signal: linked.signal, assetVersion: version });
        } catch (error) {
          // 会话握手会把调用者 signal 的取消统一投影为 499;但这里若是
          // API 自己的 timeout 已触发,必须保留本次请求的 504/api_timeout 合同。
          if (linked.timedOut()) throw timeoutError(path, timeoutMs);
          throw error;
        }
        throwIfLinkedAborted(linked, path, timeoutMs);
        const requestToken = currentToken();
        const finalHeaders = { 'X-WX-Token': requestToken, ...headers };
        if (version) finalHeaders['X-WX-Asset-Version'] = version;
        let payload = body;
        if (body !== undefined && body !== null && !rawBody && !(body instanceof Blob)
            && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && typeof body !== 'string') {
          payload = JSON.stringify(body);
          finalHeaders['Content-Type'] = 'application/json';
        }
        let response;
        try {
          const pending = fetch(path, {
            method: verb,
            headers: finalHeaders,
            body: payload,
            signal: linked.signal,
            cache: 'no-store',
          });
          mutationRequestStarted = mutation;
          response = await pending;
        } catch (error) {
          if (linked.signal.aborted) {
            throwIfLinkedAborted(linked, path, timeoutMs);
          }
          throw networkError(path, error);
        }

        if (!response.ok) {
          const text = await readResponseTextLimited(response, {
            maxBytes: ERROR_RESPONSE_MAX_BYTES,
            signal: linked.signal,
          });
          throwIfLinkedAborted(linked, path, timeoutMs);
          const httpError = buildHttpError(text, response.status);
          mutationOutcomeConfirmed = mutation;
          // token 失效:重建会话后原样重试一次。
          if (response.status === 403
              && (httpError.code === 'invalid_token' || text.includes('invalid token'))) {
            if (sessionRetryAvailable) {
              let renewed = false;
              if (!sessionInvalidationAlreadyClaimed(requestToken)) {
                try {
                  renewed = await renewSessionTokenAfterRejection(requestToken, {
                    signal: linked.signal,
                    assetVersion: version,
                  });
                } catch (error) {
                  // renewal 同样会经过 session 的调用者取消投影;若是本请求
                  // 自有 timeout 触发,这里必须恢复 API 公开的 504 合同。
                  if (linked.timedOut()) throw timeoutError(path, timeoutMs);
                  throw error;
                }
              }
              if (renewed) {
                sessionRetryAvailable = false;
                continue;
              }
            }
            if (claimSessionInvalidation(requestToken)) {
              try { onSessionInvalid?.(httpError); } catch {}
            }
            if (localActionRecoveryStarted) {
              try {
                completeLocalActionRecoveryAfterError(expectedLocalActionId, httpError, {
                  kind: localActionKind,
                });
              } catch {}
            }
            throw httpError;
          }
          if (localActionRecoveryStarted) {
            try {
              completeLocalActionRecoveryAfterError(expectedLocalActionId, httpError, {
                kind: localActionKind,
              });
            } catch {}
          }
          // 版本闸门:页面资产过期或服务需要重启。
          if (response.status === 409
              && (httpError.code === 'stale_frontend_asset' || httpError.code === 'service_restart_required')) {
            try { onStaleAsset?.(httpError.code, httpError); } catch {}
            throw httpError;
          }
          throw httpError;
        }

        if (expect === 'bytes') {
          const bytes = await readResponseBytesLimited(response, { maxBytes, signal: linked.signal });
          throwIfLinkedAborted(linked, path, timeoutMs);
          mutationOutcomeConfirmed = mutation;
          return bytes;
        }
        if (expect === 'stream') {
          throwIfLinkedAborted(linked, path, timeoutMs);
          mutationOutcomeConfirmed = mutation;
          return response;
        }
        const text = await readResponseTextLimited(response, { maxBytes, signal: linked.signal });
        throwIfLinkedAborted(linked, path, timeoutMs);
        try {
          const parsed = JSON.parse(text);
          if (expectedLocalActionId) {
            const responseLocalActionId = String(parsed?.local_action_id || '').trim();
            if (responseLocalActionId !== expectedLocalActionId) {
              throw localActionResponseMismatchError(expectedLocalActionId, responseLocalActionId);
            }
          }
          mutationOutcomeConfirmed = mutation;
          if (localActionRecoveryStarted) {
            try {
              completeLocalActionRecoveryAfterResponse(expectedLocalActionId, parsed, {
                kind: localActionKind,
              });
            } catch {
              // 副作用响应已验证,但浏览器 marker 未清理时,不能让页面把
              // 同一响应继续投影为 fully verified;保留记录供恢复核对。
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                parsed.local_action_recovery_cleanup_failed = true;
              }
            }
          }
          return parsed;
        } catch (cause) {
          if (cause?.code === 'local_action_response_id_mismatch') throw cause;
          const error = new Error(`本地服务返回了无法解析的响应：${verb} ${path}`);
          error.status = 502;
          error.code = 'api_response_invalid_json';
          error.cause = cause;
          throw error;
        }
      }
    } catch (error) {
      if (localActionRecoveryStarted
          && !mutationOutcomeUnknown({
            mutation,
            requestStarted: mutationRequestStarted,
            outcomeConfirmed: mutationOutcomeConfirmed,
          })) {
        try {
          completeLocalActionRecoveryAfterError(expectedLocalActionId, error, {
            kind: localActionKind,
          });
        } catch {}
      }
      if (mutationOutcomeUnknown({
        mutation,
        requestStarted: mutationRequestStarted,
        outcomeConfirmed: mutationOutcomeConfirmed,
      })) {
        error.outcomeUnknown = true;
      }
      throw error;
    } finally {
      linked.done();
    }
    };
    return raceRequestWithLinkedSignal(
      performRequest(),
      linked,
      path,
      timeoutMs,
      error => {
        if (mutationOutcomeUnknown({
          mutation,
          requestStarted: mutationRequestStarted,
          outcomeConfirmed: mutationOutcomeConfirmed,
        })) {
          error.outcomeUnknown = true;
        }
      },
    );
  }

  return {
    assetVersion: version,
    getServiceInstanceId: () => currentServiceInstanceId(),
    get: (path, options = {}) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options = {}) => request(path, { ...options, method: 'POST', body }),
    // 原始字节 POST(如 save-render 的 PNG):headers 里放元数据头。
    postRaw: (path, bytes, headers = {}, options = {}) => request(path, {
      ...options,
      method: 'POST',
      body: bytes,
      headers,
      rawBody: true,
    }),
    // SSE 等流式响应:调用方自行处理 response.body。
    postStream: (path, body, options = {}) => request(path, {
      ...options,
      method: 'POST',
      body,
      expect: 'stream',
      // SSE 长跑,默认超时交由调用方通过 signal 控制。
      timeoutMs: options.timeoutMs ?? 0,
    }),
    request,
  };
}
