// 摘要批次执行器:严格按服务端协议驱动
//   digest-batch-start → 逐群 /api/digest(SSE)→ 心跳续租 → finish / cancel。
// 断流时用 digest-result 确定性恢复终态;进度通过回调透出,UI 不感知协议细节。
import { isMutationOutcomeUnknown } from '/js/api.js';
import {
  digestTerminalRecoveryMetadata,
  pollDigestTerminalResult,
} from './recovery.js';

export const SSE_IDLE_TIMEOUT_MS = 60 * 1000;
export const BATCH_HEARTBEAT_INTERVAL_MS = 15 * 1000;

// 只有完整摘要会在页面上继续使用批次凭据进行保存/导出。
// 全部失败、跳过或取消后继续持有批次只会造成错误的账号切换阻塞。
export function digestBatchHasUsableResult(results = []) {
  return Array.isArray(results)
    && results.some(item => item?.outcome === 'done' && item?.digest);
}

// 只有写请求结果未知时需要保留批次给确定性恢复。
export function digestBatchFailureNeedsRecovery(error) {
  // api.js 会为已发出的 POST 取消同时保留 outcomeUnknown 证据；但页面已经
  // 通过同一批次凭据执行幂等 cancel/finish。若仍把明确取消归为恢复态，
  // 一个没有可用结果的 cancel-only owner 会永久阻止账号切换。
  if (error?.name === 'AbortError' || error?.status === 499) return false;
  return isMutationOutcomeUnknown(error);
}

export function digestBatchFinishConfirmed(value) {
  return !!value
    && typeof value === 'object'
    && value.ok === true
    && value.settled === true
    && value.pending !== true;
}

// 取消请求的 ok 只表示服务端接受了取消。只有租约也已释放，页面才
// 能删除本地恢复 marker 或把 active owner 当成已收尾。
export function digestBatchCancelConfirmed(value) {
  return !!value
    && typeof value === 'object'
    && value.ok === true
    && value.lease_released === true;
}

// start 的 200 响应是后续批次写入的唯一协议闸门。只取指纹会把 null、
// 错批次或错服务响应当成成功，随后让 SSE 在未确认的凭据下继续写入。
export function requireDigestBatchStartResult(value, {
  batchId = '',
  serviceInstanceId = '',
  accountId = '',
  accountFingerprint = '',
} = {}) {
  const expectedBatchId = String(batchId || '').trim();
  const expectedServiceInstanceId = String(serviceInstanceId || '').trim();
  const expectedAccountId = String(accountId || '').trim();
  const expectedAccountFingerprint = String(accountFingerprint || '').trim().toLowerCase();
  const actualBatchId = String(value?.batch_id || '').trim();
  const actualServiceInstanceId = String(value?.service_instance_id || '').trim();
  const actualAccountId = String(value?.account_id || '').trim();
  const actualFingerprint = String(value?.account_fingerprint || '').trim().toLowerCase();
  const valid = value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.ok === true
    && expectedBatchId
    && actualBatchId === expectedBatchId
    && expectedServiceInstanceId
    && actualServiceInstanceId === expectedServiceInstanceId
    && expectedAccountId
    && actualAccountId === expectedAccountId
    && /^[a-f0-9]{64}$/.test(actualFingerprint)
    && (!expectedAccountFingerprint || actualFingerprint === expectedAccountFingerprint);
  if (!valid) {
    const error = new Error('摘要批次创建响应无效；本次结果可能已经开始，请通过恢复记录核对后再重试。');
    error.status = 502;
    error.code = 'digest_batch_start_response_invalid';
    error.outcomeUnknown = true;
    error.mutation_outcome_unknown = true;
    throw error;
  }
  return value;
}

export function createDigestBatchId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(24);
  try { globalThis.crypto?.getRandomValues?.(bytes); } catch {}
  const random = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  if (random && !/^0+$/.test(random)) return `batch-${random}`;
  return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
}

export function createDigestBatchToken() {
  const bytes = new Uint8Array(32);
  try { globalThis.crypto?.getRandomValues?.(bytes); } catch {}
  const random = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  if (random && !/^0+$/.test(random)) return random;
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.${Math.random().toString(36).slice(2)}`;
}

function abortError(message = '已取消') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.status = 499;
  return error;
}

function normalizedAbortError(signal, error = null) {
  const cancelled = signal?.aborted || error?.name === 'AbortError' || error?.status === 499;
  if (!cancelled) return null;
  if (error?.name === 'AbortError') return error;
  const reason = signal?.reason;
  const message = signal?.aborted
    ? (reason?.message || error?.message || '生成已取消')
    : (error?.message || reason?.message || '生成已取消');
  const normalized = abortError(message);
  if (error instanceof Error) normalized.cause = error;
  else if (reason instanceof Error) normalized.cause = reason;
  return normalized;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw normalizedAbortError(signal, signal.reason);
  }
}

function requireDigestSsePayload(value) {
  const valid = value
    && typeof value === 'object'
    && !Array.isArray(value)
    && String(value.digest_id || '').trim();
  if (valid) return value;
  const error = new Error('摘要流返回的摘要结构无效，正在查询服务端终态。');
  error.status = 502;
  error.code = 'digest_sse_payload_invalid';
  error.outcomeUnknown = true;
  error.mutation_outcome_unknown = true;
  throw error;
}

// 解析 SSE 字节流:`event: <名>\ndata: <JSON>\n\n`,忽略 `: ping` 注释心跳。
async function consumeSseStream(response, { signal, onEvent, idleTimeoutMs = SSE_IDLE_TIMEOUT_MS }) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const error = new Error('当前浏览器不能对响应进行流式读取。');
    error.code = 'response_stream_unavailable';
    throw error;
  }
  const cancelReaderOnAbort = () => {
    try {
      const cancellation = reader.cancel(signal?.reason);
      cancellation?.catch?.(() => {});
    } catch {}
  };
  signal?.addEventListener?.('abort', cancelReaderOnAbort, { once: true });
  if (signal?.aborted) cancelReaderOnAbort();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines = [];
  let terminalEvent = null;

  const flushFrame = () => {
    if (!dataLines.length) {
      eventName = '';
      return;
    }
    const name = eventName || 'message';
    const raw = dataLines.join('\n');
    eventName = '';
    dataLines = [];
    let payload = null;
    try { payload = JSON.parse(raw); } catch { payload = { raw }; }
    if (['digest', 'done', 'error', 'skipped'].includes(name)) terminalEvent = { name, data: payload };
    onEvent?.(name, payload);
  };

  const processBuffer = () => {
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!line) {
        flushFrame();
        continue;
      }
      if (line.startsWith(':')) continue; // 注释心跳
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
  };

  let idleTimer = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    const timer = setTimeout(() => {
      if (idleTimer !== timer) return;
      idleTimer = null;
      const error = new Error('生成进度超过 60 秒没有更新,连接已断开;正在尝试恢复结果。');
      error.code = 'digest_sse_idle_timeout';
      try { reader.cancel(error); } catch {}
    }, idleTimeoutMs);
    idleTimer = timer;
  };

  resetIdleTimer();
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      // reader.cancel() 不是强保证；底层实现可能忽略取消并让挂起的 read
      // 晚到返回。解析任何字节或投影事件前，取消必须再次胜出。
      throwIfAborted(signal);
      if (done) break;
      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      processBuffer();
      if (terminalEvent) {
        // 收到终态帧即可结束;无需等服务端关闭连接。
        try { await reader.cancel('terminal event received'); } catch {}
        throwIfAborted(signal);
        return terminalEvent;
      }
    }
    buffer += decoder.decode();
    processBuffer();
    flushFrame();
    if (terminalEvent) return terminalEvent;
    const error = new Error('连接在终态之前中断;正在尝试恢复结果。');
    error.code = 'digest_sse_truncated';
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    signal?.removeEventListener?.('abort', cancelReaderOnAbort);
    try { reader.releaseLock?.(); } catch {}
  }
}

// 单群生成:返回 { outcome: 'done'|'error'|'skipped', digest?, error? }。
async function generateOneGroup(api, {
  batch,
  target,
  batchIndex,
  batchTotal,
  accountId,
  accountFingerprint,
  previewText,
  minMessages,
  filters,
  signal,
  onStage,
}) {
  const body = {
    batch_id: batch.batch_id,
    batch_token: batch.batch_token,
    batch_index: batchIndex,
    batch_total: batchTotal,
    service_instance_id: batch.service_instance_id,
    account_id: accountId,
    group_id: target.group_id,
    group_name: target.group_name,
    since: target.since,
    until: target.until,
    min_messages: minMessages,
    preview_text: previewText === true,
  };
  if (accountFingerprint) body.expected_account_fingerprint = accountFingerprint;
  if (filters && (filters.senders?.length || filters.keywords?.length || filters.exclude_types?.length)) {
    body.filters = {
      senders: [...(filters.senders || [])],
      keywords: [...(filters.keywords || [])],
      exclude_types: [...(filters.exclude_types || [])],
    };
  }
  if (minMessages >= 100) body.high_min_messages_confirmation = minMessages;

  const recoveryBody = {
    batch_id: batch.batch_id,
    batch_token: batch.batch_token,
    batch_index: batchIndex,
    batch_total: batchTotal,
    service_instance_id: batch.service_instance_id,
    account_id: accountId,
    group_id: target.group_id,
  };
  if (accountFingerprint) recoveryBody.expected_account_fingerprint = accountFingerprint;

  const recoveryPendingError = cause => {
    const error = new Error(cause?.message || '摘要请求结果尚未确认;请通过恢复记录查询终态。', {
      cause: cause instanceof Error ? cause : undefined,
    });
    error.code = 'digest_terminal_results_pending_recovery';
    error.status = Number(cause?.status || 0) || 0;
    error.outcomeUnknown = true;
    error.digestRecovery = Object.freeze({
      phase: 'terminal_results_pending_recovery',
      batch_id: batch.batch_id,
      batch_index: batchIndex,
      batch_total: batchTotal,
      account_id: accountId,
      account_fingerprint: accountFingerprint,
      group_id: target.group_id,
    });
    return error;
  };

  const recoverFromTerminal = async cause => {
    // 断流/空闲超时后:用 digest-result 做确定性恢复。
    const result = await pollDigestTerminalResult(api, recoveryBody, { signal });
    const status = String(result?.status || '').trim();
    if (status === 'done') {
      return {
        outcome: 'done',
        digest: result.digest,
        recovered: true,
        ...digestTerminalRecoveryMetadata(result),
      };
    }
    if (status === 'saved') {
      return {
        outcome: 'done',
        digest: result.item?.digest || result.item || null,
        savedItem: result.item,
        recovered: true,
        ...digestTerminalRecoveryMetadata(result),
      };
    }
    if (status === 'skipped') {
      return {
        outcome: 'skipped',
        error: result.error || { message: '已跳过' },
        recovered: true,
        ...digestTerminalRecoveryMetadata(result),
      };
    }
    if (status === 'error') {
      return {
        outcome: 'error',
        error: result.error || { message: '生成失败' },
        recovered: true,
        ...digestTerminalRecoveryMetadata(result),
      };
    }
    // missing:服务端没有该 index 的记录,原错误更准确。
    if (cause) throw cause;
    return { outcome: 'error', error: { message: '服务端没有该群的生成记录。' }, recovered: true };
  };

  const recoverUnknownOutcome = async cause => {
    const pendingError = recoveryPendingError(cause);
    try {
      return await recoverFromTerminal(pendingError);
    } catch (error) {
      const cancellation = normalizedAbortError(signal, error);
      if (cancellation) throw cancellation;
      throw pendingError;
    }
  };

  let response;
  try {
    response = await api.postStream('/api/digest', body, { signal });
  } catch (error) {
    const cancellation = normalizedAbortError(signal, error);
    if (cancellation) throw cancellation;
    if (isMutationOutcomeUnknown(error)) return recoverUnknownOutcome(error);
    // 明确未发送或已确认的 HTTP 拒绝不需要查询终态。
    throw error;
  }

  let terminal;
  try {
    terminal = await consumeSseStream(response, {
      signal,
      idleTimeoutMs: SSE_IDLE_TIMEOUT_MS,
      onEvent: (name, data) => {
        if (name === 'stage') onStage?.(data);
      },
    });
  } catch (error) {
    const cancellation = normalizedAbortError(signal, error);
    if (cancellation) throw cancellation;
    // POST 已被服务端接受；任何未收到终态的读取/解析失败都只能查询 digest-result。
    return recoverUnknownOutcome(error);
  }

  if (!terminal) return recoverFromTerminal(null);
  if (terminal.name === 'digest') {
    try {
      const digest = requireDigestSsePayload(terminal.data);
      return {
        outcome: 'done',
        digest,
        ...digestTerminalRecoveryMetadata(terminal.data),
      };
    } catch (error) {
      return recoverUnknownOutcome(error);
    }
  }
  if (terminal.name === 'done') {
    // done 帧不带完整 digest 时用 digest-result 取回。
    let result;
    try {
      result = await pollDigestTerminalResult(api, recoveryBody, { signal, maxWaitMs: 30 * 1000 });
    } catch (error) {
      const cancellation = normalizedAbortError(signal, error);
      if (cancellation) throw cancellation;
      throw recoveryPendingError(error);
    }
    if (String(result?.status || '') === 'done') {
      return {
        outcome: 'done',
        digest: result.digest,
        ...digestTerminalRecoveryMetadata(result),
      };
    }
    if (String(result?.status || '') === 'saved') {
      return {
        outcome: 'done',
        digest: result.item || null,
        savedItem: result.item,
        ...digestTerminalRecoveryMetadata(result),
      };
    }
    if (String(result?.status || '') === 'skipped') {
      return {
        outcome: 'skipped',
        error: result.error || { message: '已跳过' },
        ...digestTerminalRecoveryMetadata(result),
      };
    }
    if (String(result?.status || '') === 'error') {
      return {
        outcome: 'error',
        error: result.error || { message: '生成失败' },
        ...digestTerminalRecoveryMetadata(result),
      };
    }
    throw recoveryPendingError(new Error('服务端已报告摘要完成，但终态记录暂时不可用。'));
  }
  if (terminal.name === 'skipped') {
    return {
      outcome: 'skipped',
      error: terminal.data,
      ...digestTerminalRecoveryMetadata(terminal.data),
    };
  }
  return {
    outcome: 'error',
    error: terminal.data,
    ...digestTerminalRecoveryMetadata(terminal.data),
  };
}

// 运行整批。
// targets: [{ group_id, group_name, since, until }]
// callbacks: onStage(stage, { index, target }), onGroupStart({ index, target }),
//            onGroupResult({ index, target, outcome, digest?, error? }),
//            onRecoveryPending({ batch, index, target, phase, ...identity }),
//            onBatchCreated(batch), onBatchStart(payload), onProgress({ done, total })
export async function runDigestBatch(api, {
  accountId = '',
  accountFingerprint = '',
  targets = [],
  previewText = false,
  minMessages = 1,
  filters = null,
  allowStaleAccount = false,
  signal = null,
  onStage = null,
  onGroupStart = null,
  onGroupResult = null,
  onRecoveryPending = null,
  onBatchCreated = null,
  onBatchStart = null,
  onProgress = null,
} = {}) {
  const batchTotal = targets.length;
  if (!batchTotal) throw new Error('请先选择至少一个群。');
  const serviceInstanceId = api.getServiceInstanceId();
  const batch = {
    batch_id: createDigestBatchId(),
    batch_token: createDigestBatchToken(),
    service_instance_id: serviceInstanceId,
  };
  // 批次标识创建后立即透出(取消/中断登记需要在 start 之前就拿到)。
  onBatchCreated?.(batch);

  const startBody = {
    batch_id: batch.batch_id,
    batch_token: batch.batch_token,
    batch_total: batchTotal,
    preview_text: previewText === true,
    service_instance_id: serviceInstanceId,
    account_id: accountId,
  };
  if (accountFingerprint) startBody.expected_account_fingerprint = accountFingerprint;
  if (allowStaleAccount) startBody.allow_stale_account = true;

  let started;
  try {
    started = await api.post('/api/digest-batch-start', startBody, { signal });
  } catch (error) {
    const cancellation = normalizedAbortError(signal, error);
    if (cancellation) throw cancellation;
    throw error;
  }
  throwIfAborted(signal);
  started = requireDigestBatchStartResult(started, {
    batchId: batch.batch_id,
    serviceInstanceId,
    accountId,
    accountFingerprint,
  });
  onBatchStart?.(started);

  const fingerprint = String(started?.account_fingerprint || accountFingerprint || '').trim().toLowerCase();

  // 心跳续租:服务端租约 3 分钟,这里 15 秒一次。
  let heartbeatTimer = null;
  let heartbeatInFlight = false;
  const heartbeatController = new AbortController();
  let heartbeatOwnerAttached = false;
  const detachHeartbeatOwner = () => {
    if (!heartbeatOwnerAttached) return;
    heartbeatOwnerAttached = false;
    signal?.removeEventListener?.('abort', onHeartbeatOwnerAbort);
  };
  const heartbeatLease = { active: true };
  const stopHeartbeat = () => {
    heartbeatLease.active = false;
    if (heartbeatTimer !== null && heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    detachHeartbeatOwner();
    if (!heartbeatController.signal.aborted) {
      heartbeatController.abort(signal?.reason || Object.assign(new Error('批次 heartbeat 已停止'), {
        name: 'AbortError',
        status: 499,
      }));
    }
  };
  const onHeartbeatOwnerAbort = () => stopHeartbeat();
  if (signal?.aborted) stopHeartbeat();
  else if (typeof signal?.addEventListener === 'function') {
    signal.addEventListener('abort', onHeartbeatOwnerAbort, { once: true });
    heartbeatOwnerAttached = true;
  }
  if (heartbeatLease.active) {
    heartbeatTimer = setInterval(() => {
      if (!heartbeatLease.active || heartbeatInFlight || signal?.aborted) return;
      heartbeatInFlight = true;
      api.post('/api/digest-batch-heartbeat', {
        batch_id: batch.batch_id,
        batch_token: batch.batch_token,
        service_instance_id: serviceInstanceId,
      }, { signal: heartbeatController.signal }).catch(() => {}).finally(() => {
        heartbeatInFlight = false;
      });
    }, BATCH_HEARTBEAT_INTERVAL_MS);
  }

  // 手动收尾:保存 PNG / 导出 MD 依赖未 finish 的批次,
  // 正常跑完后由调用方决定何时 finish(本模块不再自动 finish)。
  let finishedSent = false;
  let finishInFlight = null;
  const finish = async ({ releasePreview = true, releaseTerminalResults = true } = {}) => {
    if (finishedSent) return null;
    if (finishInFlight) return finishInFlight;
    finishInFlight = (async () => {
      try {
        const response = await api.post('/api/digest-batch-finish', {
          batch_id: batch.batch_id,
          batch_token: batch.batch_token,
          service_instance_id: serviceInstanceId,
          release_preview: releasePreview,
          release_terminal_results: releaseTerminalResults,
        }, { timeoutMs: 15000 });
        if (!digestBatchFinishConfirmed(response)) return null;
        finishedSent = true;
        stopHeartbeat();
        return response;
      } catch {
        return null;
      } finally {
        finishInFlight = null;
      }
    })();
    return finishInFlight;
  };

  const results = [];
  let finished = false;
  let recoveryPending = false;
  try {
    // 服务端 digest 槽位为 1,逐群串行。
    for (let index = 0; index < batchTotal; index += 1) {
      throwIfAborted(signal);
      const target = targets[index];
      onGroupStart?.({ index, target });
      let outcome;
      try {
        outcome = await generateOneGroup(api, {
          batch,
          target,
          batchIndex: index,
          batchTotal,
          accountId,
          accountFingerprint: fingerprint,
          previewText,
          minMessages,
          filters,
          signal,
          onStage: stage => onStage?.(stage, { index, target }),
        });
      } catch (error) {
        const cancellation = normalizedAbortError(signal, error);
        if (cancellation) {
          const cancelledOutcome = {
            outcome: 'cancelled',
            error: {
              message: cancellation.message || '已取消生成',
              code: 'digest_batch_cancelled',
              status: 499,
              cancelled: true,
            },
          };
          results[index] = { target, ...cancelledOutcome };
          try { onGroupResult?.({ index, target, ...cancelledOutcome }); } catch {}
          try { onProgress?.({ done: results.filter(Boolean).length, total: batchTotal }); } catch {}
          throw cancellation;
        }
        if (isMutationOutcomeUnknown(error)) {
          recoveryPending = true;
          try {
            onRecoveryPending?.({
              batch,
              index,
              target,
              phase: 'terminal_results_pending_recovery',
              accountId,
              accountFingerprint: fingerprint,
              error,
            });
          } catch {}
          throw error;
        }
        outcome = {
          outcome: 'error',
          error: {
            message: error?.message || '生成失败',
            code: error?.code || '',
            status: error?.status || 0,
          },
        };
      }
      results[index] = { target, ...outcome };
      onGroupResult?.({ index, target, ...outcome });
      onProgress?.({ done: results.filter(Boolean).length, total: batchTotal });
    }
    finished = true;
    // 正常完成:保留心跳由调用方继续持有批次(调用方负责 finish)。
    return { batch, started, results, account_fingerprint: fingerprint, finish, stopHeartbeat };
  } finally {
    if (!finished) {
      if (recoveryPending) {
        // 写请求可能仍在服务端执行；只停本页心跳，保留批次给确定性恢复。
        stopHeartbeat();
      } else {
        // 明确取消/失败:尽力 finish,释放服务端批次资源。
        await finish({ releasePreview: false, releaseTerminalResults: false });
      }
    }
  }
}

// 取消进行中的批次(尽力而为,不抛错)。
export async function cancelDigestBatch(api, batch, {
  reason = 'user_cancelled',
  abortSaves = true,
  signal = null,
} = {}) {
  if (!batch?.batch_id) return null;
  try {
    return await api.post('/api/digest-cancel', {
      batch_id: batch.batch_id,
      batch_token: batch.batch_token,
      service_instance_id: batch.service_instance_id || api.getServiceInstanceId(),
      reason: String(reason || 'user_cancelled').slice(0, 120),
      abort_saves: abortSaves,
      preserve_completed_results: true,
    }, { timeoutMs: 10000, signal });
  } catch {
    return null;
  }
}
