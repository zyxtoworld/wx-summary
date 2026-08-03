import { parentPort, workerData } from 'node:worker_threads';
import { renderPortableThumbnailPng } from './thumbnail.js';

function workerErrorPayload(error = {}) {
  return {
    message: error?.message || String(error || '缩略图生成失败；请点开查看原图。'),
    code: error?.public_code || error?.code || 'thumbnail_failed',
    status: Math.max(400, Number(error?.status || 500) || 500),
  };
}

try {
  await renderPortableThumbnailPng(workerData.source, workerData.output, {
    width: workerData.width,
    height: workerData.height,
  });
  parentPort?.postMessage({ ok: true });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: workerErrorPayload(error) });
}
