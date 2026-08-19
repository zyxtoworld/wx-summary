import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const source = await readFile(
  new URL('../src/wxdb/index.js', import.meta.url),
  'utf8',
);

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `必须能定位生产函数 ${marker}`);
  const signatureEnd = sourceText.indexOf(') {', start + marker.length);
  const open = signatureEnd + 2;
  assert.ok(signatureEnd >= 0, `${marker} 必须能定位函数签名结束`);
  assert.ok(open >= 0, `${marker} 必须有函数体`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      return sourceText.slice(start, index + 1);
    }
  }
  throw new Error(`${marker} 函数体未闭合`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const cleanupFunctionSource = extractFunction(
  source,
  'async function settleMediaEnrichmentCleanup',
);
const functionSource = `${cleanupFunctionSource}\n${extractFunction(
  source,
  'async function enrichMessageMedia',
)}`;
assert.match(functionSource, /await readImageDataUrlIfUsable\(job\.localPath, imageKeys, \{ signal \}\)/,
  '夹具必须执行生产图片解码 await');

const dependencies = {
  MEDIA_ENRICHMENT_MAX_MS: 60000,
  MEDIA_DECODE_MAX_ITEMS_PER_KIND: 16,
  VOICE_FILE_EXTENSIONS: ['.aud'],
  path,
  throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError', status: 499 });
  },
  notifyProgress(_onProgress, progress) { _onProgress?.(progress); },
  markMediaPayloadMissing() {},
  markMediaEnrichmentFailure() {},
  openCopiedSqlCipherDb: async () => ({
    raw_key: '',
    db: { prepare: () => ({ get: () => null }) },
  }),
  prioritizeRawKeyCandidate() {},
  throwIfMirrorReadGenerationChanged() {},
  findImageByFileKey: () => null,
  findImageByFileName: () => null,
  findLocalImagePathByFileKey: async () => 'C:/fixture/source-image.dat',
  findLocalImagePathByFileName: async () => '',
  safeMediaSourceFileStat: async () => ({ isFile: () => true, size: 1 }),
  mediaFileExists: async () => true,
  copyMediaFileForRead: async () => ({
    target_path: 'C:/fixture/copied-image.dat',
    temp_root: 'C:/fixture/media-root',
  }),
  readImageValidationSamples: async () => [],
  readImageDataUrlIfUsable: null,
  readVideoFrameDataUrlIfUsable: null,
  readAudioDataUrlIfUsable: null,
  getImageKeyCandidatesForSamples: async () => [],
  closeCopiedDbHandle: async () => {},
  removeCopiedMediaRoots: async () => {},
  mediaPath: () => '',
  resolveAttachPath: async () => '',
  findLocalMessageFilePath: async () => '',
  isVideoLike: () => false,
  isAudioLike: () => false,
  findLocalVideoPathByFileKey: async () => '',
  findLocalVoicePathByFileName: async () => '',
  findLocalVoicePathByFileKey: async () => '',
  findFileByFileKey: () => null,
  formatFileContent: () => '',
  formatVideoContent: () => '',
  formatVoiceContent: () => '',
  formatImageContent: media => `image:${media.data_url || ''}`,
};

const saved = new Map();
for (const [key, value] of Object.entries(dependencies)) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  globalThis[key] = value;
}

try {
  const { settleMediaEnrichmentCleanup, enrichMessageMedia } = new Function(
    `${functionSource}; return { settleMediaEnrichmentCleanup, enrichMessageMedia };`,
  )();

  const closeStarted = deferred();
  const removeStarted = deferred();
  const releaseClose = deferred();
  const releaseRemove = deferred();
  let closeCalls = 0;
  let removeCalls = 0;
  let removeFinished = false;
  const cleanupCloseError = new Error('close copied db failed');
  globalThis.closeCopiedDbHandle = async handle => {
    closeCalls += 1;
    closeStarted.resolve(handle);
    await releaseClose.promise;
  };
  globalThis.removeCopiedMediaRoots = async roots => {
    removeCalls += 1;
    removeStarted.resolve(roots);
    await releaseRemove.promise;
    removeFinished = true;
  };
  const cleanupController = new AbortController();
  const cleanupCancellation = Object.assign(new Error('cleanup caller cancelled'), {
    name: 'AbortError',
    status: 499,
  });
  const cleanupPending = settleMediaEnrichmentCleanup(
    { id: 'copied-db-handle' },
    new Set(['C:/fixture/media-root']),
    { signal: cleanupController.signal },
  );
  await Promise.all([closeStarted.promise, removeStarted.promise]);
  let cleanupSettled = false;
  cleanupPending.then(
    () => { cleanupSettled = true; },
    () => { cleanupSettled = true; },
  );
  cleanupController.abort(cleanupCancellation);
  await Promise.resolve();
  assert.equal(cleanupSettled, false,
    'abort 后必须等待句柄关闭和媒体目录删除完成，不能 detach cleanup');
  releaseClose.reject(cleanupCloseError);
  await Promise.resolve();
  assert.equal(cleanupSettled, false,
    '一个 cleanup 失败时仍必须等待另一个 cleanup 完成');
  releaseRemove.resolve();
  await assert.rejects(
    cleanupPending,
    error => error === cleanupCancellation,
    'abort 时 cleanup 错误不能覆盖 caller cancellation',
  );
  assert.equal(closeCalls, 1, '句柄 cleanup 必须只调用一次');
  assert.equal(removeCalls, 1, '目录 cleanup 必须只调用一次');
  assert.equal(removeFinished, true, '句柄失败不得阻断目录 cleanup');
  globalThis.closeCopiedDbHandle = async () => {};
  globalThis.removeCopiedMediaRoots = async () => {};

  for (const scenario of [
    {
      label: '图片',
      type: 'image',
      path: 'C:/fixture/source-image.dat',
      outputKey: 'data_url',
      phase: 'fetch_media_images_done',
      decoder: 'readImageDataUrlIfUsable',
      result: { data_url: 'data:image/png;base64,late', mime: 'image/png' },
    },
    {
      label: '视频',
      type: 'video',
      path: 'C:/fixture/source-video.mp4',
      outputKey: 'frame_data_url',
      phase: 'fetch_media_videos_done',
      decoder: 'readVideoFrameDataUrlIfUsable',
      result: { data_url: 'data:image/jpeg;base64,late', mime: 'image/jpeg' },
    },
    {
      label: '音频',
      type: 'voice',
      path: 'C:/fixture/source-voice.aud',
      outputKey: 'data_url',
      phase: 'fetch_media_audio_done',
      decoder: 'readAudioDataUrlIfUsable',
      result: { data_url: 'data:audio/wav;base64,late', mime: 'audio/wav' },
    },
  ]) {
    const decode = deferred();
    const decodeStarted = deferred();
    globalThis[scenario.decoder] = async () => {
      decodeStarted.resolve();
      return decode.promise;
    };
    globalThis.findLocalImagePathByFileKey = async () => scenario.type === 'image' ? scenario.path : '';
    globalThis.findLocalVideoPathByFileKey = async () => scenario.type === 'video' ? scenario.path : '';
    globalThis.findLocalVoicePathByFileKey = async () => scenario.type === 'voice' ? scenario.path : '';
    const controller = new AbortController();
    const progress = [];
    const message = {
      type: scenario.type,
      timestamp: Date.now(),
      sender: 'wxid_sender',
      media: { file_key: 'a'.repeat(32), file_name: path.basename(scenario.path) },
      content: '原始媒体元信息',
    };
    const pending = enrichMessageMedia(
      { account_id: 'wxacc_abcdef0123456789', db_storage: 'C:/fixture/db' },
      [],
      [message],
      { signal: controller.signal, onProgress: value => progress.push(value) },
    );
    await decodeStarted.promise;
    controller.abort(new Error(`${scenario.label} owner cancelled`));
    decode.resolve(scenario.result);

    await assert.rejects(
      pending,
      error => error?.message === `${scenario.label} owner cancelled`,
      `${scenario.label}解码期间取消必须结束当前 owner`,
    );
    assert.equal(message.media[scenario.outputKey], undefined,
      `忽略 abort 的迟到${scenario.label}解码不得写入已取消的消息结果`);
    assert.equal(progress.some(item => item.phase === scenario.phase), false,
      `忽略 abort 的迟到${scenario.label}解码不得投影完成进度`);
  }

  const copyStartedAfterResolve = deferred();
  const releaseCopyAfterResolve = deferred();
  let cleanupRootsAfterCopyAbort = null;
  globalThis.findLocalImagePathByFileKey = async () => 'C:/fixture/source-image.dat';
  globalThis.findLocalVideoPathByFileKey = async () => '';
  globalThis.findLocalVoicePathByFileKey = async () => '';
  globalThis.copyMediaFileForRead = async () => {
    copyStartedAfterResolve.resolve();
    return releaseCopyAfterResolve.promise;
  };
  globalThis.removeCopiedMediaRoots = async roots => {
    cleanupRootsAfterCopyAbort = [...roots];
  };
  const copyAbortController = new AbortController();
  const copyCancellation = Object.assign(new Error('复制完成后取消'), { name: 'AbortError', status: 499 });
  const copyAbortMessage = {
    type: 'image',
    timestamp: Date.now(),
    sender: 'wxid_sender',
    media: { file_key: 'd'.repeat(32), file_name: 'source-image.dat' },
    content: '原始媒体元信息',
  };
  const copyAbortPending = enrichMessageMedia(
    { account_id: 'wxacc_abcdef0123456789', db_storage: 'C:/fixture/db' },
    [],
    [copyAbortMessage],
    { signal: copyAbortController.signal },
  );
  await copyStartedAfterResolve.promise;
  releaseCopyAfterResolve.resolve({
    target_path: 'C:/fixture/copied-image-late-abort.dat',
    temp_root: 'C:/fixture/media-root-late-abort',
  });
  copyAbortController.abort(copyCancellation);
  await assert.rejects(
    copyAbortPending,
    error => error === copyCancellation,
    '复制 Promise 已 resolve 后取消仍必须结束当前媒体 owner',
  );
  assert.deepEqual(
    cleanupRootsAfterCopyAbort,
    ['C:/fixture/media-root-late-abort'],
    '复制完成后取消必须先登记返回的临时根目录，再执行 abort cleanup',
  );

  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const decode = deferred();
  const decodeStarted = deferred();
  globalThis.findLocalImagePathByFileKey = async () => 'C:/fixture/source-image.dat';
  globalThis.findLocalVideoPathByFileKey = async () => '';
  globalThis.findLocalVoicePathByFileKey = async () => '';
  globalThis.readImageDataUrlIfUsable = async () => {
    decodeStarted.resolve();
    return decode.promise;
  };
  globalThis.removeCopiedMediaRoots = async roots => {
    cleanupStarted.resolve(roots);
    await releaseCleanup.promise;
  };
  const controller = new AbortController();
  const cancellation = Object.assign(new Error('媒体 cleanup owner cancelled'), { name: 'AbortError', status: 499 });
  const message = {
    type: 'image',
    timestamp: Date.now(),
    sender: 'wxid_sender',
    media: { file_key: 'b'.repeat(32), file_name: 'source-image.dat' },
    content: '原始媒体元信息',
  };
  const pending = enrichMessageMedia(
    { account_id: 'wxacc_abcdef0123456789', db_storage: 'C:/fixture/db' },
    [],
    [message],
    { signal: controller.signal },
  );
  try {
    await decodeStarted.promise;
    controller.abort(cancellation);
    decode.resolve({ data_url: 'data:image/png;base64,late-cleanup', mime: 'image/png' });
    await cleanupStarted.promise;
    const outcome = await Promise.race([
      pending.then(() => 'settled', () => 'settled'),
      new Promise(resolve => setImmediate(() => resolve('pending'))),
    ]);
    assert.equal(
      outcome,
      'pending',
      '媒体 owner 取消后必须等待临时目录清理完成，不能把 cleanup detach 到后台',
    );
  } finally {
    releaseCleanup.resolve();
  }
  await assert.rejects(
    pending,
    error => error === cancellation,
    '媒体 cleanup pending 时仍必须向 caller 投影原始取消原因',
  );

  const cleanupStartedAfterSuccess = deferred();
  const releaseCleanupAfterSuccess = deferred();
  globalThis.readImageDataUrlIfUsable = async () => ({
    data_url: 'data:image/png;base64,cleanup-race',
    mime: 'image/png',
  });
  globalThis.removeCopiedMediaRoots = async roots => {
    cleanupStartedAfterSuccess.resolve(roots);
    await releaseCleanupAfterSuccess.promise;
  };
  const lateCleanupController = new AbortController();
  const lateCleanupCancellation = Object.assign(new Error('媒体 post-read cleanup cancelled'), { name: 'AbortError', status: 499 });
  const lateCleanupMessage = {
    type: 'image',
    timestamp: Date.now(),
    sender: 'wxid_sender',
    media: { file_key: 'c'.repeat(32), file_name: 'source-image.dat' },
    content: '原始媒体元信息',
  };
  const lateCleanupPending = enrichMessageMedia(
    { account_id: 'wxacc_abcdef0123456789', db_storage: 'C:/fixture/db' },
    [],
    [lateCleanupMessage],
    { signal: lateCleanupController.signal },
  );
  try {
    await cleanupStartedAfterSuccess.promise;
    lateCleanupController.abort(lateCleanupCancellation);
    const outcome = await Promise.race([
      lateCleanupPending.then(() => 'settled', () => 'settled'),
      new Promise(resolve => setImmediate(() => resolve('pending'))),
    ]);
    assert.equal(
      outcome,
      'pending',
      '清理已开始后再取消也必须等待该 cleanup 完成',
    );
  } finally {
    releaseCleanupAfterSuccess.resolve();
  }
  await assert.rejects(
    lateCleanupPending,
    error => error === lateCleanupCancellation,
    '清理已开始后的取消仍必须投影原始 caller cancellation',
  );
} finally {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

console.log('wxdb media abort late-decode tests passed');
