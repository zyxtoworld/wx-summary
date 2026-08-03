import { collectMessagesFromWxDb, extractSelfWxidFromProjectCopy, listChatroomsFromWxDb, probeWxDb, releaseWxDbWorkerSessionPlaintextCaches } from './index.js';

const WORKER_DISCONNECT_EXIT_GRACE_MS = 1000;

function normalizeFilterTerm(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase().trim();
}

function preMediaFilterFromSpec(spec = null) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const senders = [...new Set((Array.isArray(spec.senders) ? spec.senders : []).map(normalizeFilterTerm).filter(Boolean))];
  const excluded = new Set(Array.isArray(spec.exclude_types) ? spec.exclude_types.map(value => String(value || '').trim()).filter(Boolean) : []);
  if (!senders.length && !excluded.size) return null;
  return message => {
    if (excluded.has(String(message?.type || '').trim())) return false;
    if (!senders.length) return true;
    const values = [message?.sender, message?.sender_username, message?.sender_display_name]
      .map(normalizeFilterTerm)
      .filter(Boolean);
    return senders.some(term => values.some(value => value === term || value.includes(term)));
  };
}

function serializableError(error = {}) {
  const out = { message: String(error?.message || error || '独立数据库读取失败。') };
  for (const key of [
    'name',
    'status',
    'code',
    'public_code',
    'wxdb_diagnostics',
    'key_diagnostics',
    'key_scan_diagnostics',
    'digest_diagnostics',
    'min_messages',
  ]) {
    if (error?.[key] !== undefined) out[key] = error[key];
  }
  return out;
}

function safeIdentityChange(change = null) {
  const value = change && typeof change === 'object' && !Array.isArray(change) ? change : {};
  const storageId = String(value.storage_id || '').trim().toLowerCase();
  const previousIdentityId = String(value.previous_identity_id || '').trim().toLowerCase();
  const identityId = String(value.identity_id || '').trim().toLowerCase();
  if (value.identity_switched !== true
    || !/^wxacc_[a-f0-9]{16}$/.test(storageId)
    || !/^wxacct_[a-f0-9]{24}$/.test(identityId)
    || (previousIdentityId && !/^wxacct_[a-f0-9]{24}$/.test(previousIdentityId))) {
    return null;
  }
  return {
    storage_id: storageId,
    previous_identity_id: previousIdentityId,
    identity_id: identityId,
    identity_switched: true,
  };
}

const persistentWorker = process.env.WX_SUMMARY_WXDB_PERSISTENT_WORKER === '1';
let acceptedOneShot = false;
let activeAbortController = null;
let activeRequestId = '';
let shutdownRequested = false;
let shutdownPromise = null;

function sendWorkerMessage(message, { exitCode = null } = {}) {
  if (!process.connected) {
    if (exitCode !== null && !persistentWorker) void shutdownWorker(exitCode);
    return;
  }
  process.send?.(message, error => {
    if (!error || exitCode === null || persistentWorker) return;
    void shutdownWorker(exitCode);
  });
}

function shutdownWorker(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shutdownRequested = true;
  shutdownPromise = (async () => {
    await releaseWxDbWorkerSessionPlaintextCaches().catch(() => {});
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

process.on('message', async message => {
  if (message?.type === 'cancel') {
    const requestId = String(message.request_id || '').trim();
    if (requestId && requestId !== activeRequestId) return;
    activeAbortController?.abort?.(Object.assign(new Error('数据库读取已取消。'), { name: 'AbortError', status: 499 }));
    return;
  }
  if (message?.type === 'close') {
    shutdownRequested = true;
    activeAbortController?.abort?.(Object.assign(new Error('数据库读取会话已结束。'), { name: 'AbortError', status: 499 }));
    if (!activeAbortController) await shutdownWorker(0);
    return;
  }
  if (shutdownRequested || activeAbortController || (!persistentWorker && acceptedOneShot) || !['collect', 'groups', 'probe', 'identity'].includes(message?.type)) return;
  acceptedOneShot = true;
  const requestId = String(message.request_id || '').trim();
  const abortController = new AbortController();
  activeAbortController = abortController;
  activeRequestId = requestId;
  const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
  try {
    const onProgress = progress => {
      if (!process.connected) return;
      const value = progress && typeof progress === 'object' && !Array.isArray(progress) ? progress : {};
      const identityChange = safeIdentityChange(value.identity_change);
      if (identityChange) sendWorkerMessage({ type: 'identity_change', request_id: requestId, change: identityChange });
      const { identity_change: _identityChange, ...publicProgress } = value;
      sendWorkerMessage({ type: 'progress', request_id: requestId, progress: publicProgress });
    };
    let result;
    if (message.type === 'probe') {
      result = await probeWxDb({ ...payload, signal: abortController.signal, onProgress });
    } else if (message.type === 'identity') {
      result = await extractSelfWxidFromProjectCopy({ ...payload, signal: abortController.signal, onProgress });
    } else if (message.type === 'groups') {
      result = await listChatroomsFromWxDb({ ...payload, signal: abortController.signal, onProgress });
    } else {
      result = await collectMessagesFromWxDb({
          ...payload,
          signal: abortController.signal,
          pre_media_filter: preMediaFilterFromSpec(payload.pre_media_filter_spec),
          onProgress,
        });
    }
    if (!process.connected) return;
    sendWorkerMessage({
      type: 'result',
      request_id: requestId,
      result,
      verified_raw_keys: Array.isArray(result?.__verified_raw_keys) ? result.__verified_raw_keys : [],
      verified_account: result?.__verified_account || result?.account || null,
      identity_shard_evidence_cache_entries: Array.isArray(result?.__identity_shard_evidence_cache_entries)
        ? result.__identity_shard_evidence_cache_entries
        : [],
    }, { exitCode: 0 });
  } catch (error) {
    if (!process.connected) return;
    sendWorkerMessage({
      type: 'error',
      request_id: requestId,
      error: serializableError(error),
      identity_shard_evidence_cache_entries: Array.isArray(error?.__identity_shard_evidence_cache_entries)
        ? error.__identity_shard_evidence_cache_entries
        : [],
    }, { exitCode: 1 });
  } finally {
    if (activeAbortController === abortController) {
      activeAbortController = null;
      activeRequestId = '';
    }
    if (shutdownRequested) await shutdownWorker(0);
  }
});

process.once('disconnect', () => {
  shutdownRequested = true;
  activeAbortController?.abort?.(Object.assign(new Error('数据库读取主服务已断开。'), { name: 'AbortError', status: 499 }));
  if (!activeAbortController) void shutdownWorker(0);
  setTimeout(() => { void shutdownWorker(0); }, WORKER_DISCONNECT_EXIT_GRACE_MS);
});
