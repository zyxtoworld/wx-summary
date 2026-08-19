export const BROWSER_PNG_OPERATION_TIMEOUT_MS = 120 * 1000;

function canvasAbortError(signal, fallbackMessage = '已取消浏览器 PNG 编码') {
  const reason = signal?.reason;
  if (reason?.name === 'AbortError' && Number(reason.status) === 499) return reason;
  const message = reason instanceof Error
    ? reason.message
    : String(reason || fallbackMessage);
  const error = new Error(message || fallbackMessage);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  error.status = 499;
  if (reason instanceof Error) error.cause = reason;
  return error;
}

function canvasTimeoutError() {
  const error = new Error('浏览器编码 PNG 超过 120 秒没有完成，已停止等待。请缩短时间范围、减少内容，或改用“生成文本预览”。');
  error.name = 'TimeoutError';
  error.code = 'browser_png_timeout';
  return error;
}

// Canvas 没有中止进行中 toBlob 的接口；调用方取消后仍须占住槽位，直到原生回调返回。
let canvasPngEncodeTail = Promise.resolve();

function reserveCanvasPngEncodeSlot() {
  const previous = canvasPngEncodeTail.catch(() => {});
  let released = false;
  let release = null;
  const completed = new Promise(resolve => {
    release = () => {
      if (released) return;
      released = true;
      resolve();
    };
  });
  canvasPngEncodeTail = previous.then(() => completed);
  return { previous, release };
}

export function canvasToPngBlob(canvas, {
  timeoutMs = BROWSER_PNG_OPERATION_TIMEOUT_MS,
  signal = null,
} = {}) {
  if (!canvas?.width || !canvas?.height) {
    return Promise.reject(new Error('长图还没有渲染完成。'));
  }

  const slot = reserveCanvasPngEncodeSlot();
  return new Promise((resolve, reject) => {
    let callerSettled = false;
    let encodingStarted = false;
    let timer = null;

    const releaseSlot = () => slot.release();
    const removeAbortListener = () => signal?.removeEventListener?.('abort', onAbort);
    const finish = (callback, value) => {
      if (callerSettled) return;
      callerSettled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      removeAbortListener();
      callback(value);
    };
    const onAbort = () => {
      if (!encodingStarted) releaseSlot();
      finish(reject, canvasAbortError(signal));
    };

    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    timer = setTimeout(() => {
      if (!encodingStarted) releaseSlot();
      finish(reject, canvasTimeoutError());
    }, Math.max(1, Number(timeoutMs || 0) || BROWSER_PNG_OPERATION_TIMEOUT_MS));

    void (async () => {
      try {
        await slot.previous;
        if (callerSettled || signal?.aborted) {
          releaseSlot();
          if (!callerSettled) onAbort();
          return;
        }
        encodingStarted = true;
        canvas.toBlob(blob => {
          releaseSlot();
          if (blob) finish(resolve, blob);
          else finish(reject, new Error('浏览器未能导出这张长图，可能是内容过长或画布尺寸超过限制。'));
        }, 'image/png');
      } catch (error) {
        releaseSlot();
        finish(reject, error);
      }
    })();
  });
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPlausiblePng(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return false;
  }
  const tail = bytes.length - 8;
  return bytes[tail] === 0x49
    && bytes[tail + 1] === 0x45
    && bytes[tail + 2] === 0x4e
    && bytes[tail + 3] === 0x44;
}

export async function canvasToValidatedPngBytes(canvas, {
  invalidMessage = '浏览器导出的 PNG 未通过完整性校验,已停止保存。',
  ...encodeOptions
} = {}) {
  const blob = await canvasToPngBlob(canvas, encodeOptions);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (encodeOptions.signal?.aborted) throw canvasAbortError(encodeOptions.signal);
  if (!isPlausiblePng(bytes)) throw new Error(invalidMessage);
  return bytes;
}
