function responseLimitError(errorFactory, details) {
  const error = typeof errorFactory === 'function'
    ? errorFactory(details)
    : new Error(`响应内容超过安全读取上限 ${details.maxBytes} 字节`);
  if (error instanceof Error) return error;
  return new Error(String(error || '响应内容超过安全读取上限'));
}

function declaredResponseBytes(response) {
  const raw = String(response?.headers?.get?.('Content-Length') || '').trim();
  if (!/^\d+$/.test(raw)) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function abortError(signal, fallback = '响应读取已取消') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal?.reason === 'string' && signal.reason ? signal.reason : fallback);
  error.name = 'AbortError';
  return error;
}

const RESPONSE_CANCEL_GRACE_MS = 100;

async function cancelStreamBestEffort(stream, reason, timeoutMs = RESPONSE_CANCEL_GRACE_MS) {
  let cancellation = null;
  try {
    cancellation = stream?.cancel?.(reason);
  } catch {
    return;
  }
  if (!cancellation || typeof cancellation.then !== 'function') return;
  const observed = Promise.resolve(cancellation).catch(() => undefined);
  let timer = null;
  try {
    await Promise.race([
      observed,
      new Promise(resolve => {
        timer = setTimeout(resolve, Math.max(1, Number(timeoutMs || 0) || RESPONSE_CANCEL_GRACE_MS));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function cancelResponseReader(reader, reason = null, options = {}) {
  await cancelStreamBestEffort(reader, reason, options.timeoutMs);
}

async function readReaderChunk(reader, signal) {
  if (signal?.aborted) throw abortError(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      const error = abortError(signal);
      finish(reject, error);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => {
        if (signal?.aborted) throw abortError(signal);
        return reader.read();
      })
      .then(value => finish(resolve, value), error => finish(reject, error));
  });
}

export async function cancelResponseBody(response, reason = null) {
  if (!response?.body || response.bodyUsed) return;
  await cancelStreamBestEffort(response.body, reason);
}

export async function readResponseChunksLimited(response, {
  maxBytes,
  signal = null,
  errorFactory = null,
} = {}) {
  const limit = Math.max(0, Number(maxBytes || 0) || 0);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('maxBytes 必须是正整数');
  if (signal?.aborted) {
    const error = abortError(signal);
    await cancelResponseBody(response, error);
    throw error;
  }
  const declaredBytes = declaredResponseBytes(response);
  if (declaredBytes > limit) {
    const error = responseLimitError(errorFactory, { maxBytes: limit, declaredBytes, totalBytes: 0 });
    await cancelResponseBody(response, error);
    throw error;
  }

  const reader = response?.body?.getReader?.();
  if (!reader) {
    const error = Object.assign(new Error('当前浏览器不能对响应进行安全的流式读取，已停止下载。'), {
      status: 502,
      code: 'response_stream_unavailable',
    });
    await cancelResponseBody(response, error);
    throw error;
  }

  const chunks = [];
  let totalBytes = 0;
  let completed = false;
  let failure = null;
  try {
    while (true) {
      const { done, value } = await readReaderChunk(reader, signal);
      // readReaderChunk 解决 promise 后，取消仍可能在外层 await 恢复前到达；
      // 尤其是最后一个 done=true 读取，不能让已取消的写请求伪装成成功。
      if (signal?.aborted) throw abortError(signal);
      if (done) {
        completed = true;
        break;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
      totalBytes += chunk.byteLength;
      if (totalBytes > limit) {
        throw responseLimitError(errorFactory, { maxBytes: limit, declaredBytes, totalBytes });
      }
      if (chunk.byteLength) chunks.push(chunk);
    }
    return { chunks, totalBytes, declaredBytes };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (!completed) await cancelResponseReader(reader, failure || abortError(signal));
    try { reader.releaseLock?.(); } catch {}
  }
}

export async function readResponseBytesLimited(response, options = {}) {
  const { chunks, totalBytes } = await readResponseChunksLimited(response, options);
  if (chunks.length === 1 && chunks[0].byteLength === totalBytes) return chunks[0];
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readResponseTextLimited(response, options = {}) {
  const { chunks } = await readResponseChunksLimited(response, options);
  const decoder = new TextDecoder();
  const parts = [];
  for (const chunk of chunks) parts.push(decoder.decode(chunk, { stream: true }));
  parts.push(decoder.decode());
  return parts.join('');
}

export async function readResponseBlobLimited(response, options = {}) {
  const { chunks, totalBytes, declaredBytes } = await readResponseChunksLimited(response, options);
  return {
    blob: new Blob(chunks, { type: String(response?.headers?.get?.('Content-Type') || '') }),
    totalBytes,
    declaredBytes,
  };
}
