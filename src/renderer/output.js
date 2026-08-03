import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { assertRealOutputDir, assertSafeTmpPath, outputDirFromSettings, OUTPUTS_DIR, OUTPUTS_TMP_DIR, PROJECT_ROOT, TMP_DIR, toProjectRelative, isInside, platformPathIdentity } from '../lib/paths.js';
import { readFileHandleBounded } from '../lib/bounded-read.js';
import { ensureDir, readJson, renameAtomicWithRetry, syncDirectory, writeJsonAtomic } from '../lib/json-store.js';
import { preserveInvalidFileBackup } from '../lib/invalid-backup.js';
import { settingsExportPolicyRevision, settingsExportPolicyRevisionMatches } from '../config/settings.js';
import {
  RENDERED_PNG_MAX_BYTES,
  RENDERED_PNG_MAX_RGBA_BYTES,
  RENDERED_PNG_MAX_SIDE,
  pngBufferFromDataUrl as validatedPngBufferFromDataUrl,
  pngBufferFromInput as validatedPngBufferFromInput,
  validatePngBuffer,
  validatePngFile,
  validatePngFileHeaderHandle,
  validatePngFileHandle,
} from './png-validate.js';
import * as DigestView from '../web/public/js/digest-view-model.js';
import { toWellFormedText, truncateUnicodeText, truncateUtf8Text } from '../web/public/js/unicode-text.js';

let historyWriteQueue = Promise.resolve();
const historyWriteLockContext = new AsyncLocalStorage();
const historyPngWriteLocks = new Map();
const LEGACY_HISTORY_INDEX_LIMIT = 200;
const HISTORY_BASE_DISCOVERY_LIMIT = 200;
const HISTORY_PENDING_RECOVERY_DISCOVERY_MAX_PASSES = 64;
const HISTORY_BASE_DISCOVERY_CACHE_MS = 5000;
const HISTORY_BASE_VISITED_DIR_LIMIT = 2000;
const HISTORY_BASE_LOAD_CONCURRENCY = 6;
const HISTORY_COMBINED_CACHE_MS = 2500;
const HISTORY_PAGE_CHECKPOINT_TTL_MS = 5 * 60 * 1000;
const HISTORY_PAGE_CHECKPOINT_LIMIT = 128;
const HISTORY_PAGE_PREFIX_VALIDATION_CONCURRENCY = 12;
const HISTORY_PAGE_STATUS_CONCURRENCY = 6;
const OUTPUT_FILE_VERSION_CACHE_LIMIT = 512;
const HISTORY_SEARCH_TEXT_MAX_CHARS = 6000;
const HISTORY_SEARCH_MARKDOWN_FALLBACK_MAX_BYTES = 8 * 1024 * 1024;
const HISTORY_SEARCH_FALLBACK_MAX_CANDIDATES = 64;
const HISTORY_SEARCH_FALLBACK_MAX_BYTES = 32 * 1024 * 1024;
const HISTORY_SEARCH_SESSION_TTL_MS = 10 * 60 * 1000;
const HISTORY_SEARCH_SESSION_LIMIT = 32;
const HISTORY_SEARCH_HEADLINE_MAX_CHARS = 240;
const HISTORY_SEARCH_QUERY_MAX_CHARS = 500;
const HISTORY_SEARCH_INDEX_VERSION = 3;
const PREVIEW_HISTORY_SOURCE_MAX_ITEMS = 200;
const PREVIEW_HISTORY_SOURCE_ID_MAX_CHARS = 320;
const HISTORY_ACCEPTANCE_FIXTURE_MARKER_FILE = '.wx-summary-acceptance-fixture';
const HISTORY_ACCEPTANCE_FIXTURE_ENV = 'WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURES';
const HISTORY_ACCEPTANCE_FIXTURE_ROOTS_ENV = 'WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS';
const HISTORY_DISCOVERY_TEST_SCOPE_ENV = 'WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE';
const HISTORY_INDEX_JSON_MAX_BYTES = 64 * 1024 * 1024;
const HISTORY_DIGEST_JSON_MAX_BYTES = 8 * 1024 * 1024;
const HISTORY_MARKDOWN_META_MAX_BYTES = 512 * 1024;
const OUTPUT_FILE_DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const OUTPUT_FILE_STREAM_SNAPSHOT_CHUNK_BYTES = 1024 * 1024;
const MEDIA_MODEL_STATUS_MESSAGE_MAX_CHARS = 200;
const HISTORY_ARTIFACT_DIGEST_PNG = 'digest_png';
const HISTORY_ARTIFACT_TEXT_PREVIEW_MD = 'text_preview_md';
const HISTORY_RERENDER_COMMIT_MARKER_VERSION = 1;
const HISTORY_RERENDER_METADATA_SUPERSEDED_LIMIT = 32;
export const HISTORY_RERENDER_SOURCE_MAX_BYTES = 256 * 1024 * 1024;
const HISTORY_SAVE_TRANSACTION_VERSION = 1;
const HISTORY_SAVE_TRANSACTION_SUFFIX = '.save.json';
const HISTORY_ROOT_MARKER_FILE = '.wx-summary-history-root.json';
const HISTORY_ROOT_MARKER_VERSION = 1;
const HISTORY_ROOT_MARKER_MAX_BYTES = 16 * 1024;
const HISTORY_ITEM_KEY_ALIAS_LIMIT = 32;
const OUTPUT_ATOMIC_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RETENTION_RECOVERY_ENTRY_LIMIT = 50_000;
const RETENTION_RECOVERY_DIR_LIMIT = 2_000;
const RETENTION_PENDING_SUFFIX_RE = /\.retention-delete-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pending$/i;
const RETENTION_TRANSACTION_SCHEMA = 'wx-summary.retention-delete.v1';
const RETENTION_TRANSACTION_VERSION = 1;
const RETENTION_TRANSACTION_MAX_BYTES = 64 * 1024;
const RETENTION_TRANSACTION_MANIFEST_SUFFIX = '.transaction.json';
const RETENTION_TRANSACTION_MANIFEST_RE = /\.retention-delete-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.pending\.transaction\.json$/i;
export const OUTPUT_FILE_EXPECTED_MISSING_VERSION = 'missing:v1';
let historyBaseDiscoveryCache = null;
let historyBaseDiscoveryQueue = Promise.resolve();
let historyCombinedStateCache = null;
let historyCombinedStateInFlight = null;
const historyCombinedStateProducers = new Set();
let historyCombinedStateGeneration = 0;
const historyPageCheckpoints = new Map();
const historySearchSessions = new Map();
const HISTORY_SAVE_RECOVERY_COMPLETED_BASE_LIMIT = 32;
const historySaveRecoveryCompletedBases = new Set();
const historySaveRecoveryInFlight = new Map();
const activeDigestSaveTransactionMarkers = new Set();
const pendingHistoryRecoveries = new Map();
const outputFileVersionCache = new Map();
const validatedOutputPngCache = new Map();

async function writeHistoryIndexAtomic(file, items) {
  try {
    await writeJsonAtomic(file, items, { maxBytes: HISTORY_INDEX_JSON_MAX_BYTES });
  } catch (error) {
    if (error?.code !== 'json_payload_too_large') throw error;
    throw Object.assign(new Error('历史索引已达到 64MB 安全上限，未写入可能无法再次读取的索引。请清理旧历史或切换输出目录后重试。'), {
      status: 507,
      code: 'history_index_too_large',
      public_code: 'history_index_too_large',
      max_bytes: HISTORY_INDEX_JSON_MAX_BYTES,
      bytes: Number(error?.bytes || 0) || 0,
      cause: error,
    });
  }
}

export function historyIndexPath(settings) {
  return path.join(outputDirFromSettings(settings), 'index.json');
}

async function outputBaseContext(settings, { ensure = true, allowMissing = false } = {}) {
  const base = outputDirFromSettings(settings);
  const context = await assertRealOutputDir(base, { ensure, allowMissing });
  return { base, ...context };
}

async function safeOutputBase(settings, { ensure = true, allowMissing = false } = {}) {
  return (await outputBaseContext(settings, { ensure, allowMissing })).base;
}

async function safeExistingOutputBase(base = '') {
  const resolved = path.resolve(String(base || ''));
  await assertRealOutputDir(resolved, { ensure: false });
  return resolved;
}

export function historyOutputBaseMatches(left = '', right = '', { platform = process.platform } = {}) {
  return platformPathIdentity(left, { platform }) === platformPathIdentity(right, { platform });
}

function outputDirIdentityForBase(base = '') {
  const rel = toProjectRelative(path.resolve(base || '')).replace(/^\.\/+/, '').replace(/\/+$/, '');
  return rel ? platformPathIdentity(rel, { resolve: false }) : '';
}

async function assertSafeOutputParent(base, targetPath) {
  const parent = path.dirname(path.resolve(targetPath || ''));
  const { realTmp, realBase } = await assertRealOutputDir(base);
  const existingParent = await closestExistingOutputPath(parent);
  await assertOrdinaryOutputAncestorTree(realBase, existingParent || parent);
  const realExistingParent = existingParent ? await fsp.realpath(existingParent).catch(() => '') : '';
  if (!realExistingParent || !isInside(realBase, realExistingParent)) throw outputPathError('target parent ancestor outside output dir');
  if (realTmp && isInside(realTmp, realExistingParent)) throw outputPathError('target parent ancestor inside outputs/.tmp');
  await ensureDir(parent);
  await assertOrdinaryOutputAncestorTree(realBase, parent);
  const realParent = await fsp.realpath(parent).catch(() => '');
  if (!realParent || !isInside(realBase, realParent)) throw outputPathError('target parent outside output dir');
  if (realTmp && isInside(realTmp, realParent)) throw outputPathError('target parent inside outputs/.tmp');
  return realParent;
}

async function closestExistingOutputPath(targetPath = '') {
  let current = path.resolve(targetPath || '');
  while (current) {
    const stat = await fsp.lstat(current).catch(e => {
      if (e?.code === 'ENOENT') return null;
      throw e;
    });
    if (stat) return current;
    const parent = path.dirname(current);
    if (parent === current) return '';
    current = parent;
  }
  return '';
}

async function assertOrdinaryOutputAncestorTree(base, targetPath) {
  const root = path.resolve(base || '');
  const target = path.resolve(targetPath || '');
  if (!root || !target || !isInside(root, target)) throw outputPathError('target parent ancestor outside output dir');
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current).catch(e => {
      if (e?.code === 'ENOENT') return null;
      throw e;
    });
    if (!stat) break;
    if (stat.isSymbolicLink?.()) throw outputPathError('target parent contains a symlink or junction');
    if (!stat.isDirectory?.()) throw outputPathError('target parent ancestor is not a directory');
  }
}

function outputPathError(message) {
  const err = new Error(message);
  err.status = 403;
  err.code = 'UNSAFE_OUTPUT_PATH';
  return err;
}

async function readHistoryIndex(settings, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const base = await safeOutputBase(settings);
  throwIfOutputAborted(signal);
  return readHistoryIndexFromBase(settings, base, { signal });
}

function cleanStoredHistoryOutputIdentity(value = '') {
  const clean = normalizeHistoryRelativePath(value).replace(/\/+$/g, '');
  const outputs = normalizeHistoryRelativePath(toProjectRelative(OUTPUTS_DIR)).replace(/\/+$/g, '');
  if (!clean || !outputs || clean === outputs || !relativePathStartsWithPath(clean, outputs)) return '';
  return clean;
}

async function storedHistoryRootOutputIdentity(base, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const markerPath = path.join(path.resolve(base), HISTORY_ROOT_MARKER_FILE);
  const readable = await assertReadableOutputFile(base, markerPath, { extensions: ['.json'], signal }).catch(error => {
    if (isOutputAbortError(error)) throw error;
    if (error?.code === 'output_file_missing' || error?.status === 404) return '';
    return '';
  });
  if (!readable) return '';
  const { data } = await readOutputFileBuffer(readable, {
    signal,
    max_bytes: HISTORY_ROOT_MARKER_MAX_BYTES,
    missingMessage: '历史根标记已不存在。',
    missingCode: 'history_root_marker_missing',
  }).catch(error => {
    if (isOutputAbortError(error)) throw error;
    return { data: null };
  });
  if (!data) return '';
  try {
    const marker = JSON.parse(data.toString('utf-8'));
    if (marker?.schema !== 'wx-summary.history-root.v1' || Number(marker?.version || 0) !== HISTORY_ROOT_MARKER_VERSION) return '';
    return cleanStoredHistoryOutputIdentity(marker.output_dir_identity);
  } catch {
    return '';
  }
}

async function bindHistoryIndexToStoredRoot(base, items = [], { signal = null } = {}) {
  if (!Array.isArray(items) || !items.length) return items;
  const storedIdentity = await storedHistoryRootOutputIdentity(base, { signal });
  if (!storedIdentity) return items;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    item._history_root_output_dir_identity = storedIdentity;
  }
  return items;
}

async function readHistoryIndexFromBase(settings, base, { repair = true, rebuildMissing = true, writeRepair = true, mergeArtifacts = false, rebuildExcludeBases = [], signal = null } = {}) {
  if (writeRepair && !historyWriteLockHeld()) {
    return withHistoryWriteLock(() => readHistoryIndexFromBase(settings, base, { repair, rebuildMissing, writeRepair, mergeArtifacts, rebuildExcludeBases, signal }));
  }
  throwIfOutputAborted(signal);
  const file = path.join(base, 'index.json');
  let raw = '';
  let parsed = null;
  try {
    const readable = await assertReadableOutputFile(base, file, { extensions: ['.json'], signal }).catch(e => {
      if (e?.code === 'output_file_missing' || e?.status === 404) return '';
      throw e;
    });
    if (!readable) throw Object.assign(new Error('history index missing'), { code: 'ENOENT' });
    const { data } = await readOutputFileBuffer(readable, {
      signal,
      max_bytes: HISTORY_INDEX_JSON_MAX_BYTES,
      missingMessage: '历史索引已不存在，正在尝试重建。',
      missingCode: 'ENOENT',
    });
    raw = data.toString('utf-8');
    throwIfOutputAborted(signal);
  } catch (e) {
    if (isOutputAbortError(e)) throw e;
    if (e?.code === 'ENOENT') {
      if (!rebuildMissing) return [];
      const rebuilt = await rebuildHistoryIndexFromDigests(base, { signal, excludeBases: rebuildExcludeBases });
      if (rebuilt.length && writeRepair) {
        throwIfOutputAborted(signal);
        await assertSafeOutputParent(base, file);
        throwIfOutputAborted(signal);
        await writeHistoryIndexAtomic(file, rebuilt);
        invalidateHistoryCaches();
      }
      return rebuilt;
    }
    throw e;
  }
  try {
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw Object.assign(new Error('history index is not an array'), { code: 'HISTORY_INDEX_INVALID' });
    }
  } catch (e) {
    if (isOutputAbortError(e)) throw e;
    if (!repair) throw e;
    if (!writeRepair) return recoverHistoryIndexReadOnly(settings, e, base, { signal, rebuildExcludeBases });
    return recoverHistoryIndex(settings, file, e, base, { signal, rebuildExcludeBases });
  }
  try {
    const repaired = repair ? await repairLegacyTruncatedHistoryIndex(settings, parsed, base, { write: writeRepair, signal, rebuildExcludeBases }) : parsed;
    const merged = repair && mergeArtifacts ? await mergeHistoryIndexWithArtifactSidecars(settings, repaired, base, { write: writeRepair, signal, rebuildExcludeBases }) : repaired;
    const indexed = await ensureHistorySearchTextIndex(settings, merged, base, { write: repair && writeRepair, recheckIncomplete: mergeArtifacts, signal });
    return bindHistoryIndexToStoredRoot(base, indexed, { signal });
  } catch (e) {
    if (isOutputAbortError(e)) throw e;
    if (!repair) throw e;
    return bindHistoryIndexToStoredRoot(base, preserveHistoryIndexAfterMaintenanceFailure(parsed, e, base), { signal });
  }
}

function preserveHistoryIndexAfterMaintenanceFailure(parsed, cause, base) {
  const warnings = historyIndexWarningsFromList(parsed).slice();
  warnings.push({
    code: 'history_index_maintenance_failed',
    base: toProjectRelative(base),
    reason: String(cause?.code || '').trim(),
    message: '历史索引自动维护未完成，已保留原索引和现有历史记录；刷新历史时会再次尝试。',
  });
  return attachHistoryIndexWarnings(parsed, warnings);
}

function attachHistoryIndexWarnings(list = [], warnings = []) {
  const out = Array.isArray(list) ? list : [];
  const cleanWarnings = (Array.isArray(warnings) ? warnings : []).filter(Boolean);
  if (cleanWarnings.length) {
    Object.defineProperty(out, '__historyWarnings', {
      value: cleanWarnings,
      enumerable: false,
      configurable: true,
    });
  }
  return out;
}

function historyIndexWarningsFromList(list = []) {
  return Array.isArray(list?.__historyWarnings) ? list.__historyWarnings : [];
}

function waitForCombinedHistoryState(promise, signal = null) {
  if (!signal) return promise;
  throwIfOutputAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('请求已取消'), { status: 499, name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function trackCombinedHistoryStateProducer(promise) {
  const tracked = Promise.resolve(promise);
  historyCombinedStateProducers.add(tracked);
  void tracked.then(
    () => historyCombinedStateProducers.delete(tracked),
    () => historyCombinedStateProducers.delete(tracked),
  );
  return tracked;
}

async function readCombinedHistoryState(settings, { signal = null, bypassCache = false, shareInFlight = false, readOnly = false } = {}) {
  throwIfOutputAborted(signal);
  const outputContext = await outputBaseContext(settings, {
    ensure: !readOnly,
    allowMissing: readOnly,
  });
  const currentBase = outputContext.realBase || outputContext.base;
  throwIfOutputAborted(signal);
  const cacheKey = [
    platformPathIdentity(currentBase),
    outputContext.missing === true ? 'missing' : 'present',
    exportPolicyRevisionForSettings(settings),
    readOnly ? 'read-only' : 'repair',
  ].join('|');
  const cacheGeneration = historyCombinedStateGeneration;
  throwIfOutputAborted(signal);
  if (historyCombinedStateCache
    && historyCombinedStateCache.key === cacheKey
    && historyCombinedStateCache.generation === cacheGeneration
    && Date.now() - historyCombinedStateCache.at < HISTORY_COMBINED_CACHE_MS
    && !bypassCache) {
    return cloneCombinedHistoryState(historyCombinedStateCache.state);
  }
  if (historyCombinedStateInFlight?.key === cacheKey
    && historyCombinedStateInFlight.generation === cacheGeneration
    && !bypassCache
    && (!signal || shareInFlight)) {
    const state = await waitForCombinedHistoryState(historyCombinedStateInFlight.promise, signal);
    throwIfOutputAborted(signal);
    return cloneCombinedHistoryState(state);
  }
  if (signal && !shareInFlight) {
    const promise = trackCombinedHistoryStateProducer(buildCombinedHistoryState(settings, currentBase, {
      signal,
      repairArtifacts: bypassCache,
      bypassDiscoveryCache: bypassCache,
      readOnly,
      allowMissingCurrentBase: outputContext.missing === true,
    }));
    const state = await promise;
    throwIfOutputAborted(signal);
    if (historyCombinedStateGeneration === cacheGeneration) {
      historyCombinedStateCache = { key: cacheKey, generation: cacheGeneration, at: Date.now(), state };
    }
    return cloneCombinedHistoryState(state);
  }
  const promise = trackCombinedHistoryStateProducer(buildCombinedHistoryState(settings, currentBase, {
    repairArtifacts: bypassCache,
    bypassDiscoveryCache: bypassCache,
    readOnly,
    allowMissingCurrentBase: outputContext.missing === true,
  }));
  historyCombinedStateInFlight = { key: cacheKey, generation: cacheGeneration, promise };
  void promise.then(state => {
    if (historyCombinedStateGeneration === cacheGeneration
      && historyCombinedStateInFlight?.promise === promise) {
      historyCombinedStateCache = { key: cacheKey, generation: cacheGeneration, at: Date.now(), state };
    }
  }).catch(() => {}).finally(() => {
    if (historyCombinedStateInFlight?.promise === promise) historyCombinedStateInFlight = null;
  });
  const state = await waitForCombinedHistoryState(promise, signal);
  throwIfOutputAborted(signal);
  return cloneCombinedHistoryState(state);
}

async function buildCombinedHistoryState(settings, currentBase, {
  signal = null,
  repairArtifacts = false,
  bypassDiscoveryCache = false,
  discoveryOverride = null,
  readOnly = false,
  allowMissingCurrentBase = false,
} = {}) {
  throwIfOutputAborted(signal);
  const discovery = discoveryOverride
    ? cloneHistoryBaseDiscoveryResult(discoveryOverride)
    : await discoverHistoryBases(currentBase, {
      signal,
      bypassCache: bypassDiscoveryCache,
      allowMissingCurrentBase,
    });
  throwIfOutputAborted(signal);
  const bases = discovery.bases || [];
  const combinedItems = [];
  const warnings = Array.isArray(discovery.warnings)
    ? discovery.warnings.map(warning => {
      const clean = { ...warning };
      delete clean._key;
      return clean;
    })
    : [];
  const baseResults = await mapHistoryItemsWithConcurrency(bases, base => readCombinedHistoryBase(settings, currentBase, base, bases, {
    signal,
    repairArtifacts,
    readOnly,
  }), {
    limit: HISTORY_BASE_LOAD_CONCURRENCY,
    signal,
  });
  for (const result of baseResults) {
    throwIfOutputAborted(signal);
    const { base, current, baseHasIndex, nestedBases, baseItems, warnings: baseWarnings } = result;
    warnings.push(...baseWarnings);
    let foreignItemCount = 0;
    for (const item of baseItems) {
      throwIfOutputAborted(signal);
      const id = String(item?.digest_id || '').trim();
      if (!id) continue;
      if (!current && !looksLikeHistoryIndexItem(item)) continue;
      if (historyItemNestedOwnerBase(base, item, nestedBases)) {
        foreignItemCount += 1;
        continue;
      }
      combinedItems.push(resolveHistoryItemPaths(currentBase, { ...item, _history_base: base, _history_current: current, _history_base_has_index: baseHasIndex }, settings));
    }
    if (foreignItemCount > 0) {
      warnings.push({
        code: 'history_parent_index_foreign_rows',
        base: toProjectRelative(base),
        count: foreignItemCount,
        message: `历史索引中有 ${foreignItemCount} 条记录实际属于更深的独立输出目录，已按最深目录归属显示，避免把旧记录误标为当前记录。`,
      });
    }
  }
  const markdownDependencyItems = combinedItems
    .filter(item => historyItemIsTextPreviewMarkdown(item) && cleanHistoryItemKey(item?.source_history_item_key))
    .map(item => ({ ...item }));
  const externalMarkdownSourceKeys = [...new Set(markdownDependencyItems
    .filter(item => item?._history_current === false)
    .map(item => cleanHistoryItemKey(item?.source_history_item_key))
    .filter(Boolean))];
  const deduped = await dedupeCombinedHistoryArtifacts(combinedItems, currentBase, { signal });
  const historyItems = deduped.items;
  if (deduped.removed > 0) {
    warnings.push({
      code: 'history_duplicate_artifact',
      count: deduped.removed,
      message: `检测到 ${deduped.removed} 条指向同一物理文件的重复历史记录，已保留更可信的索引记录。`,
    });
  }
  const digestCounts = new Map();
  for (const item of historyItems) {
    const id = String(item?.digest_id || '').trim();
    if (!id) continue;
    digestCounts.set(id, (digestCounts.get(id) || 0) + 1);
  }
  const duplicateIds = [...digestCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (duplicateIds.length) {
    for (const item of historyItems) item._history_digest_duplicate = duplicateIds.includes(String(item?.digest_id || '').trim());
    warnings.push({
      code: 'history_duplicate_digest_id',
      count: duplicateIds.length,
      digest_ids: duplicateIds.slice(0, 12),
      message: `检测到 ${duplicateIds.length} 个重复历史编号；页面会使用记录密钥精确操作当前卡片。`,
    });
  }
  if (discovery.limit_reached) {
    warnings.push({
      code: 'history_base_scan_limited',
      limit: discovery.limit,
      discovered_base_count: bases.length,
      pending_dir_count: discovery.pending_dir_count,
      pass_count: discovery.pass_count,
      message: `旧输出目录较多，本轮最多新增 ${discovery.limit} 个历史目录；已累计识别 ${bases.length} 个，可继续扫描剩余目录。`,
    });
  }
  if (discovery.visit_limit_reached) {
    warnings.push({
      code: 'history_base_visit_limited',
      limit: discovery.visit_limit,
      visited_dir_count: discovery.visited_dirs,
      visited_dir_count_this_pass: discovery.visited_dirs_this_pass,
      pending_dir_count: discovery.pending_dir_count,
      pass_count: discovery.pass_count,
      message: `outputs 目录较大，本轮最多扫描 ${discovery.visit_limit} 个目录；已累计扫描 ${discovery.visited_dirs} 个，可继续扫描剩余目录。`,
    });
  }
  return {
    items: historyItems.sort(compareHistoryItemsDesc),
    markdown_dependency_items: markdownDependencyItems,
    external_markdown_source_keys: externalMarkdownSourceKeys,
    warnings,
    history_base_count: bases.length,
    history_base_scan_limit: discovery.limit,
    history_base_scan_limited: !!discovery.limit_reached,
    history_base_visit_limit: discovery.visit_limit,
    history_base_visited_dir_count: discovery.visited_dirs,
    history_base_visit_limited: !!discovery.visit_limit_reached,
    history_base_discovery_complete: discovery.complete === true,
    history_base_pending_dir_count: Math.max(0, Number(discovery.pending_dir_count || 0) || 0),
    history_base_scan_pass_count: Math.max(0, Number(discovery.pass_count || 0) || 0),
    history_base_visited_dir_count_this_pass: Math.max(0, Number(discovery.visited_dirs_this_pass || 0) || 0),
  };
}

async function readCombinedHistoryBase(settings, currentBase, base, bases, { signal = null, repairArtifacts = false, readOnly = false } = {}) {
  throwIfOutputAborted(signal);
  const current = historyOutputBaseMatches(base, currentBase);
  const baseHasIndex = await historyBaseHasIndex(base, { signal });
  const nestedBases = bases.filter(candidate => !historyOutputBaseMatches(candidate, base) && isInside(base, candidate));
  const rebuildExcludeBases = [...new Set([
    ...(current ? [] : [currentBase]),
    ...nestedBases,
  ].map(value => path.resolve(value)))];
  const warnings = [];
  let saveTransactionRecovery = { recovered: 0, removed_stale: 0, needs_index: [], warnings: [] };
  if (current && !readOnly) {
    try {
      saveTransactionRecovery = await recoverPreparedDigestSaveTransactionsOnce(base, {
        signal,
        excludeRoots: rebuildExcludeBases,
        force: repairArtifacts,
      });
      warnings.push(...saveTransactionRecovery.warnings);
      if (saveTransactionRecovery.recovered > 0) {
        warnings.push({
          code: 'history_save_transaction_recovered',
          base: toProjectRelative(base),
          count: saveTransactionRecovery.recovered,
          message: `已恢复 ${saveTransactionRecovery.recovered} 条上次中断的长图保存，文件与历史索引已重新核对。`,
        });
      }
    } catch (error) {
      if (isOutputAbortError(error)) throw error;
      warnings.push({
        code: 'history_save_transaction_recovery_failed',
        base: toProjectRelative(base),
        message: `恢复未完成的长图保存事务失败：${String(error?.message || error || '未知错误')}；已保留现有文件。`,
      });
    }
  }
  let baseItems = [];
  try {
    baseItems = await readHistoryIndexFromBase(settings, base, {
      repair: true,
      rebuildMissing: true,
      writeRepair: current && !readOnly,
      mergeArtifacts: repairArtifacts || (!readOnly && saveTransactionRecovery.needs_index.length > 0),
      rebuildExcludeBases,
      signal,
    });
    throwIfOutputAborted(signal);
    if (current && !readOnly) {
      const previewMarkdownRecovery = await recoverPendingPreviewMarkdownHistory(settings, base, {
        signal,
        excludeRoots: rebuildExcludeBases,
      });
      if (previewMarkdownRecovery.recovered > 0) {
        baseItems = await readHistoryIndexFromBase(settings, base, {
          repair: true,
          rebuildMissing: true,
          writeRepair: true,
          mergeArtifacts: repairArtifacts || saveTransactionRecovery.needs_index.length > 0,
          rebuildExcludeBases,
          signal,
        });
      }
      if (previewMarkdownRecovery.recovered > 0) {
        warnings.push({
          code: 'history_preview_markdown_recovered',
          base: toProjectRelative(base),
          count: previewMarkdownRecovery.recovered,
          message: `已恢复 ${previewMarkdownRecovery.recovered} 条已写入但未入历史的文本预览 MD。`,
        });
      }
      if (previewMarkdownRecovery.failures.length) {
        warnings.push({
          code: 'history_preview_markdown_recovery_failed',
          base: toProjectRelative(base),
          count: previewMarkdownRecovery.failures.length,
          sample: previewMarkdownRecovery.failures[0]?.path || '',
          message: `有 ${previewMarkdownRecovery.failures.length} 条文本预览 MD 未能自动补入历史；已保留原文件，稍后会再次尝试。`,
        });
      }
      if (previewMarkdownRecovery.skipped.length) {
        warnings.push({
          code: 'history_preview_markdown_recovery_skipped',
          base: toProjectRelative(base),
          count: previewMarkdownRecovery.skipped.length,
          sample: previewMarkdownRecovery.skipped[0]?.path || '',
          message: `有 ${previewMarkdownRecovery.skipped.length} 条未完成的文本预览 MD 因文件已变化或元数据不完整，未自动加入历史。`,
        });
      }
    }
    if (current && !readOnly) {
      const markerRepair = await repairIndexedPreviewMarkdownMarkers(base, baseItems, { signal });
      if (markerRepair.failures.length) {
        warnings.push({
          code: 'history_metadata_marker_repair_failed',
          base: toProjectRelative(base),
          count: markerRepair.failures.length,
          sample: markerRepair.failures[0]?.path || '',
          message: `有 ${markerRepair.failures.length} 条已入历史的 MD 完成标记仍未更新；下次读取会再次修复。`,
        });
      }
    }
    if (current && !readOnly && saveTransactionRecovery.needs_index.length > 0) {
      try {
        await markDigestSaveTransactionsIndexed(base, saveTransactionRecovery.needs_index, baseItems, { signal });
      } catch (error) {
        if (isOutputAbortError(error)) throw error;
        warnings.push({
          code: 'history_save_transaction_index_marker_failed',
          base: toProjectRelative(base),
          message: `长图历史已恢复，但事务索引标记未能更新：${String(error?.message || error || '未知错误')}；下次读取历史会再次核对。`,
        });
      }
    }
    for (const warning of historyIndexWarningsFromList(baseItems)) {
      warnings.push({
        ...warning,
        base: warning.base || toProjectRelative(base),
      });
    }
  } catch (error) {
    if (isOutputAbortError(error)) throw error;
    if (current) throw error;
    warnings.push({
      code: 'history_base_unreadable',
      base: toProjectRelative(base),
      message: `旧输出目录 ${toProjectRelative(base)} 的历史索引不可读，且没有可只读重建的摘要 JSON，已跳过。`,
    });
    baseItems = [];
  }
  return { base, current, baseHasIndex, nestedBases, baseItems, warnings };
}

async function recoverCommittedHistoryRerenders(settings, base, { signal = null, excludeRoots = [] } = {}) {
  throwIfOutputAborted(signal);
  const markerFiles = [];
  await collectHistoryRerenderCommitMarkerFiles(base, markerFiles, base, { signal, excludeRoots });
  throwIfOutputAborted(signal);
  if (!markerFiles.length) return { recovered: 0 };
  return withHistoryWriteLock(async () => {
    const indexed = await readHistoryIndexFromBase(settings, base, {
      signal,
      rebuildExcludeBases: excludeRoots,
    });
    const candidateResults = await mapHistoryItemsWithConcurrency(markerFiles, async markerPath => {
      throwIfOutputAborted(signal);
      const paths = historyRerenderCommitArtifactPaths(base, markerPath);
      if (!paths) return null;
      const result = await historyIndexResultFromDigestPath(base, paths.digest_path, {
        signal,
        requireRerenderCommit: true,
      });
      if (!result?.item || result.pngKey !== historyPathDedupeKey(paths.file_path)) return null;
      return result.item;
    }, { signal });
    const candidates = dedupeHistoryRerenderRecords(base, candidateResults.filter(Boolean));
    const indexedByKey = new Map(indexed.map(item => [historyItemKeyForItem(base, item), item]));
    const missing = candidates.filter(candidate => {
      const existing = indexedByKey.get(historyItemKeyForItem(base, candidate));
      return !existing || historyRerenderRecordItemIsNewer(candidate, existing);
    });
    if (!missing.length) return { recovered: 0 };
    const next = dedupeHistoryRerenderRecords(base, [...indexed, ...missing])
      .sort(compareHistoryItemsDesc)
      .map(historyIndexItem);
    const file = path.join(base, 'index.json');
    await assertSafeOutputParent(base, file);
    throwIfOutputAborted(signal);
    await writeHistoryIndexAtomic(file, next);
    invalidateHistoryCaches({ discovery: true });
    return { recovered: missing.length };
  });
}

export async function recoverPendingHistoryWrites(settings, { reason = '', signal = null } = {}) {
  const base = await safeOutputBase(settings);
  throwIfOutputAborted(signal);
  let discovery = await discoverHistoryBases(base, { signal, bypassCache: false });
  for (let pass = 1; !discovery.complete && pass < HISTORY_PENDING_RECOVERY_DISCOVERY_MAX_PASSES; pass += 1) {
    const previousPass = Math.max(0, Number(discovery.pass_count || 0) || 0);
    discovery = await discoverHistoryBases(base, { signal, bypassCache: true });
    throwIfOutputAborted(signal);
    if (Math.max(0, Number(discovery.pass_count || 0) || 0) <= previousPass) break;
  }
  const discoveredBases = Array.isArray(discovery.bases) ? discovery.bases : [base];
  const retentionWarnings = [];
  const retentionRecovery = await withHistoryWriteLock(async () => {
    let restored = 0;
    let finalized = 0;
    let preserved = 0;
    for (const candidate of discoveredBases) {
      throwIfOutputAborted(signal);
      const current = historyOutputBaseMatches(candidate, base);
      if (!current && !await historyBaseHasRootMarker(candidate, { signal })) continue;
      const nestedBases = discoveredBases.filter(other => (
        !historyOutputBaseMatches(other, candidate) && isInside(candidate, other)
      ));
      try {
        const recovered = await recoverInterruptedRetentionCleanup(settings, candidate, {
          excludeRoots: nestedBases,
        });
        restored += Math.max(0, Number(recovered.restored || 0) || 0);
        finalized += Math.max(0, Number(recovered.finalized || 0) || 0);
        preserved += Math.max(0, Number(recovered.preserved || 0) || 0);
      } catch (error) {
        if (isOutputAbortError(error)) throw error;
        retentionWarnings.push({
          code: 'history_retention_transaction_recovery_failed',
          base: toProjectRelative(candidate),
          message: `恢复未完成的历史清理事务失败：${String(error?.message || error || '未知错误')}；已保留现有文件。`,
        });
      }
    }
    return { restored, finalized, preserved };
  });
  throwIfOutputAborted(signal);
  const rerenderWarnings = [];
  const rerenderExcludeRoots = discoveredBases.filter(candidate => (
    !historyOutputBaseMatches(candidate, base) && isInside(base, candidate)
  ));
  let rerenderRecovery = { recovered: 0 };
  try {
    rerenderRecovery = await recoverCommittedHistoryRerenders(settings, base, {
      signal,
      excludeRoots: rerenderExcludeRoots,
    });
    if (rerenderRecovery.recovered > 0) {
      rerenderWarnings.push({
        code: 'history_rerender_commit_recovered',
        base: toProjectRelative(base),
        count: rerenderRecovery.recovered,
        message: `已恢复 ${rerenderRecovery.recovered} 条文件已提交但尚未写入索引的历史重渲染记录。`,
      });
    }
  } catch (error) {
    if (isOutputAbortError(error)) throw error;
    rerenderWarnings.push({
      code: 'history_rerender_commit_recovery_failed',
      base: toProjectRelative(base),
      message: `恢复已提交的历史重渲染记录失败：${String(error?.message || error || '未知错误')}；已保留现有文件，下次启动会再次尝试。`,
    });
  }
  throwIfOutputAborted(signal);
  const recovered = await readCombinedHistoryBase(settings, base, base, [base], {
    signal,
    repairArtifacts: false,
    readOnly: false,
  });
  invalidateHistoryCaches();
  return {
    reason: String(reason || '').trim(),
    base: toProjectRelative(base),
    item_count: recovered.baseItems.length,
    warnings: [...retentionWarnings, ...rerenderWarnings, ...recovered.warnings],
    rerender_recovered: rerenderRecovery.recovered,
    retention_restored: retentionRecovery.restored,
    retention_finalized: retentionRecovery.finalized,
    retention_preserved: retentionRecovery.preserved,
    history_base_count: discoveredBases.length,
    history_base_discovery_complete: discovery.complete === true,
    history_base_pending_dir_count: Math.max(0, Number(discovery.pending_dir_count || 0) || 0),
  };
}

function pendingHistoryRecoveryKey(settings = {}) {
  try {
    return platformPathIdentity(outputDirFromSettings(settings));
  } catch {
    const raw = String(settings?.output?.dir || '').trim();
    return `invalid:${process.platform === 'win32' ? raw.toLowerCase() : raw}`;
  }
}

export function schedulePendingHistoryRecovery(settings, { reason = '', delayMs = 100 } = {}) {
  const key = pendingHistoryRecoveryKey(settings);
  const existing = pendingHistoryRecoveries.get(key);
  if (existing) return existing;
  const delay = Math.max(0, Math.min(5000, Number(delayMs || 0) || 0));
  const run = (async () => {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    return recoverPendingHistoryWrites(settings, { reason });
  })();
  const tracked = run.finally(() => {
    if (pendingHistoryRecoveries.get(key) === tracked) pendingHistoryRecoveries.delete(key);
  });
  pendingHistoryRecoveries.set(key, tracked);
  return tracked;
}

export function waitForPendingHistoryRecovery(settings) {
  return pendingHistoryRecoveries.get(pendingHistoryRecoveryKey(settings)) || Promise.resolve(null);
}

async function historyBaseHasIndex(base, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const stat = await fsp.stat(path.join(base, 'index.json')).catch(() => null);
  throwIfOutputAborted(signal);
  return stat?.isFile?.() === true;
}

async function historyBaseHasRootMarker(base, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const stat = await fsp.lstat(path.join(base, HISTORY_ROOT_MARKER_FILE)).catch(() => null);
  throwIfOutputAborted(signal);
  return stat?.isFile?.() === true && !stat?.isSymbolicLink?.();
}

async function historyBaseHasOwnershipBoundary(base, { signal = null } = {}) {
  return await historyBaseHasIndex(base, { signal }) || await historyBaseHasRootMarker(base, { signal });
}

async function dedupeCombinedHistoryArtifacts(items = [], currentBase, { signal = null } = {}) {
  const byArtifact = new Map();
  const out = [];
  let removed = 0;
  for (const item of Array.isArray(items) ? items : []) {
    throwIfOutputAborted(signal);
    const artifactKey = await historyArtifactPhysicalKey(item, { signal });
    if (!artifactKey) {
      out.push(item);
      continue;
    }
    const previous = byArtifact.get(artifactKey);
    if (!previous) {
      byArtifact.set(artifactKey, { index: out.length, item });
      out.push(item);
      continue;
    }
    removed += 1;
    if (historyArtifactDedupeRank(item, currentBase) > historyArtifactDedupeRank(previous.item, currentBase)) {
      out[previous.index] = item;
      byArtifact.set(artifactKey, { index: previous.index, item });
    }
  }
  return { items: out, removed };
}

async function historyArtifactPhysicalKey(item = {}, { signal = null } = {}) {
  const filePath = String(item.file_path || '').trim();
  const digestPath = String(item.digest_path || '').trim();
  if (!filePath && !digestPath) return '';
  const [fileKey, digestKey] = await Promise.all([
    canonicalHistoryArtifactPath(filePath, { signal }),
    canonicalHistoryArtifactPath(digestPath, { signal }),
  ]);
  throwIfOutputAborted(signal);
  return JSON.stringify([historyArtifactType(item), fileKey, digestKey]);
}

async function canonicalHistoryArtifactPath(file, { signal = null } = {}) {
  const resolved = file ? path.resolve(file) : '';
  if (!resolved) return '';
  const real = await fsp.realpath(resolved).catch(() => resolved);
  throwIfOutputAborted(signal);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function historyArtifactDedupeRank(item = {}, currentBase = '') {
  const itemBase = historyBaseForItem(currentBase, item);
  const rootSpecificity = Math.min(1_000_000, path.resolve(itemBase || '').length * 1_000);
  const indexed = item._history_base_has_index === true ? 100 : 0;
  const current = item._history_current !== false ? 10 : 0;
  return rootSpecificity + indexed + current;
}

function cloneCombinedHistoryState(state = {}) {
  return {
    ...state,
    items: Array.isArray(state.items) ? state.items.map(item => ({ ...item })) : [],
    markdown_dependency_items: Array.isArray(state.markdown_dependency_items)
      ? state.markdown_dependency_items.map(item => ({ ...item }))
      : [],
    external_markdown_source_keys: Array.isArray(state.external_markdown_source_keys)
      ? state.external_markdown_source_keys.slice()
      : [],
    warnings: Array.isArray(state.warnings) ? state.warnings.map(warning => ({ ...warning })) : [],
  };
}

function invalidateHistoryCaches({ discovery = false } = {}) {
  historyCombinedStateGeneration += 1;
  historyCombinedStateCache = null;
  historyCombinedStateInFlight = null;
  historyPageCheckpoints.clear();
  historySearchSessions.clear();
  if (discovery) historyBaseDiscoveryCache = null;
}

function looksLikeHistoryIndexItem(item = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (!String(item.digest_id || '').trim()) return false;
  const hasArtifactPath = !!String(item.file_path || item.relative_path || item.digest_path || item.digest_relative_path || '').trim();
  const hasDigestMeta = !!String(item.created_at || item.group || item.since || item.until || item.model || '').trim();
  return hasArtifactPath && hasDigestMeta;
}

async function readCombinedHistoryIndex(settings, { signal = null, bypassCache = false, shareInFlight = false, readOnly = false } = {}) {
  throwIfOutputAborted(signal);
  return (await readCombinedHistoryState(settings, { signal, bypassCache, shareInFlight, readOnly })).items;
}

function historyDependencyDiscoveryStatus(discovery = {}) {
  const warnings = Array.isArray(discovery.warnings) ? discovery.warnings : [];
  const unreadableWarningCount = warnings.filter(warning => (
    String(warning?.code || '').trim() === 'history_discovery_unreadable'
  )).length;
  return {
    complete: discovery.complete === true && unreadableWarningCount === 0,
    history_base_count: Math.max(0, Number(discovery.bases?.length || 0) || 0),
    history_base_pending_dir_count: Math.max(0, Number(discovery.pending_dir_count || 0) || 0),
    history_base_scan_pass_count: Math.max(0, Number(discovery.pass_count || 0) || 0),
    history_base_visited_dir_count: Math.max(0, Number(discovery.visited_dirs || 0) || 0),
    history_base_discovery_warning_count: unreadableWarningCount,
  };
}

async function readCompleteHistoryDependencyState(settings, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const currentBase = await safeOutputBase(settings);
  throwIfOutputAborted(signal);
  const discovery = await discoverHistoryBases(currentBase, { signal, bypassCache: false });
  throwIfOutputAborted(signal);
  const scan = historyDependencyDiscoveryStatus(discovery);
  if (!scan.complete) return { current_base: currentBase, state: null, ...scan };
  const state = await buildCombinedHistoryState(settings, currentBase, {
    signal,
    repairArtifacts: false,
    discoveryOverride: discovery,
  });
  throwIfOutputAborted(signal);
  const unreadableBaseCount = state.warnings.filter(warning => (
    String(warning?.code || '').trim() === 'history_base_unreadable'
  )).length;
  if (unreadableBaseCount > 0) {
    return {
      current_base: currentBase,
      state: null,
      ...scan,
      complete: false,
      history_base_discovery_warning_count: scan.history_base_discovery_warning_count + unreadableBaseCount,
    };
  }
  return { current_base: currentBase, state, ...scan };
}

function cloneHistoryBaseDiscoveryResult(result = {}) {
  return {
    ...result,
    bases: Array.isArray(result.bases) ? result.bases.slice() : [],
    warnings: Array.isArray(result.warnings) ? result.warnings.map(warning => ({ ...warning })) : [],
  };
}

function historyBaseDiscoveryCacheReady(cache, cacheKey, { bypassCache = false } = {}) {
  if (!cache || cache.key !== cacheKey || bypassCache) return false;
  return Date.now() - Number(cache.at || 0) < HISTORY_BASE_DISCOVERY_CACHE_MS;
}

async function discoverHistoryBases(currentBase, { signal = null, bypassCache = false, allowMissingCurrentBase = false } = {}) {
  throwIfOutputAborted(signal);
  const context = await assertRealOutputDir(currentBase, { allowMissing: allowMissingCurrentBase });
  throwIfOutputAborted(signal);
  const missingCurrentBase = context.missing === true;
  const realBase = context.realBase || path.resolve(currentBase);
  const cacheKey = `${platformPathIdentity(realBase)}:${missingCurrentBase ? 'missing' : 'present'}`;
  if (historyBaseDiscoveryCacheReady(historyBaseDiscoveryCache, cacheKey, { bypassCache })) {
    return cloneHistoryBaseDiscoveryResult(historyBaseDiscoveryCache.result);
  }
  const task = historyBaseDiscoveryQueue.then(() => discoverHistoryBasesLocked({
    ...context,
    realBase,
    includeCurrentBase: !missingCurrentBase,
  }, { signal, bypassCache }));
  historyBaseDiscoveryQueue = task.catch(() => {});
  return waitForCombinedHistoryState(task, signal);
}

async function discoverHistoryBasesLocked({ realOutputs, realTmp, realBase, includeCurrentBase = true }, { signal = null, bypassCache = false } = {}) {
  throwIfOutputAborted(signal);
  const cacheKey = `${platformPathIdentity(realBase)}:${includeCurrentBase ? 'present' : 'missing'}`;
  if (historyBaseDiscoveryCacheReady(historyBaseDiscoveryCache, cacheKey, { bypassCache })) {
    return cloneHistoryBaseDiscoveryResult(historyBaseDiscoveryCache.result);
  }
  const previous = historyBaseDiscoveryCache?.key === cacheKey ? historyBaseDiscoveryCache : null;
  const scan = previous?.scan && previous.scan.complete !== true
    ? cloneHistoryBaseDiscoveryScan(previous.scan)
    : createHistoryBaseDiscoveryScan({
      realOutputs,
      realTmp,
      realBase,
      includeCurrentBase,
      retainedBases: previous?.result?.bases || [],
    });
  scan.limit_reached = false;
  scan.visit_limit_reached = false;
  scan.visited_dirs = 0;
  scan.pass_count = Math.max(0, Number(scan.pass_count || 0) || 0) + 1;
  const candidates = [];
  await collectHistoryIndexDirs(realOutputs, candidates, {
    realOutputs,
    realTmp,
    limit: HISTORY_BASE_DISCOVERY_LIMIT,
    discovery: scan,
    signal,
  });
  throwIfOutputAborted(signal);
  scan.total_visited_dirs = Math.max(0, Number(scan.total_visited_dirs || 0) || 0)
    + Math.max(0, Number(scan.visited_dirs || 0) || 0);
  scan.complete = scan.pending_dirs.length === 0;
  const bases = historyBaseDiscoveryPublishedBases(scan);
  const result = {
    bases,
    limit_reached: !scan.complete && !!scan.limit_reached,
    visit_limit_reached: !scan.complete && !!scan.visit_limit_reached,
    complete: !!scan.complete,
    pending_dir_count: scan.pending_dirs.length,
    pass_count: scan.pass_count,
    limit: HISTORY_BASE_DISCOVERY_LIMIT,
    visit_limit: HISTORY_BASE_VISITED_DIR_LIMIT,
    visited_dirs: scan.total_visited_dirs,
    visited_dirs_this_pass: Math.max(0, Number(scan.visited_dirs || 0) || 0),
    warnings: Array.isArray(scan.warnings) ? scan.warnings.map(warning => ({ ...warning })) : [],
  };
  historyBaseDiscoveryCache = { key: cacheKey, at: Date.now(), result, scan };
  return cloneHistoryBaseDiscoveryResult(result);
}

function createHistoryBaseDiscoveryScan({ realOutputs, realTmp, realBase, retainedBases = [], includeCurrentBase = true } = {}) {
  const resolvedBase = path.resolve(realBase);
  const currentKey = platformPathIdentity(resolvedBase);
  const retained = [];
  const retainedKeys = new Set([currentKey]);
  for (const value of Array.isArray(retainedBases) ? retainedBases : []) {
    const resolved = path.resolve(String(value || ''));
    const key = platformPathIdentity(resolved);
    if (!key || retainedKeys.has(key) || !historyBaseCandidateAllowed(resolved, { realOutputs, realTmp })) continue;
    retainedKeys.add(key);
    retained.push(resolved);
  }
  return {
    real_outputs: path.resolve(realOutputs),
    real_tmp: realTmp ? path.resolve(realTmp) : '',
    real_base: resolvedBase,
    pending_dirs: [{ dir: path.resolve(realOutputs), insideHistoryBase: false }],
    seen_dir_keys: new Set(),
    discovered_bases: includeCurrentBase ? [resolvedBase] : [],
    discovered_base_keys: includeCurrentBase ? new Set([currentKey]) : new Set(),
    retained_bases: retained,
    warnings: [],
    limit: HISTORY_BASE_DISCOVERY_LIMIT,
    visit_limit: HISTORY_BASE_VISITED_DIR_LIMIT,
    visited_dirs: 0,
    total_visited_dirs: 0,
    pass_count: 0,
    complete: false,
    limit_reached: false,
    visit_limit_reached: false,
  };
}

function cloneHistoryBaseDiscoveryScan(scan = {}) {
  return {
    ...scan,
    pending_dirs: Array.isArray(scan.pending_dirs) ? scan.pending_dirs.map(item => ({ ...item })) : [],
    seen_dir_keys: new Set(scan.seen_dir_keys || []),
    discovered_bases: Array.isArray(scan.discovered_bases) ? scan.discovered_bases.slice() : [],
    discovered_base_keys: new Set(scan.discovered_base_keys || []),
    retained_bases: Array.isArray(scan.retained_bases) ? scan.retained_bases.slice() : [],
    warnings: Array.isArray(scan.warnings) ? scan.warnings.map(warning => ({ ...warning })) : [],
  };
}

function historyBaseDiscoveryPublishedBases(scan = {}) {
  const values = scan.complete
    ? scan.discovered_bases
    : [...(scan.discovered_bases || []), ...(scan.retained_bases || [])];
  const bases = [];
  const seen = new Set();
  for (const value of values || []) {
    const resolved = path.resolve(String(value || ''));
    const key = platformPathIdentity(resolved);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    bases.push(resolved);
  }
  return bases;
}

async function collectHistoryIndexDirs(dir, out, { realOutputs, realTmp, limit = HISTORY_BASE_DISCOVERY_LIMIT, discovery = null, signal = null, insideHistoryBase = false } = {}) {
  throwIfOutputAborted(signal);
  if (!discovery || !Array.isArray(discovery.pending_dirs)) return;
  if (!discovery.pending_dirs.length && discovery.complete !== true && discovery.seen_dir_keys?.size === 0) {
    discovery.pending_dirs.push({ dir, insideHistoryBase });
  }
  const baseLimit = Math.max(1, Number(limit || HISTORY_BASE_DISCOVERY_LIMIT) || HISTORY_BASE_DISCOVERY_LIMIT);
  const visitLimit = Math.max(1, Number(discovery.visit_limit || HISTORY_BASE_VISITED_DIR_LIMIT) || HISTORY_BASE_VISITED_DIR_LIMIT);
  while (discovery.pending_dirs.length) {
    throwIfOutputAborted(signal);
    if (out.length >= baseLimit) {
      discovery.limit_reached = true;
      break;
    }
    if (discovery.visited_dirs >= visitLimit) {
      discovery.visit_limit_reached = true;
      break;
    }
    const task = discovery.pending_dirs.pop();
    discovery.visited_dirs += 1;
    const taskDir = String(task?.dir || '');
    if (!taskDir || (realTmp && isInside(realTmp, taskDir))) continue;
    const realDir = await fsp.realpath(taskDir).catch(e => {
      if (e?.code === 'ENOENT') return '';
      recordHistoryDiscoveryWarning(discovery, taskDir, e, 'history_discovery_unreadable');
      return '';
    });
    throwIfOutputAborted(signal);
    if (!realDir || !isInside(realOutputs, realDir) || (realTmp && isInside(realTmp, realDir))) continue;
    if (!historyDiscoveryWithinTestScope(realDir)) continue;
    const realDirKey = platformPathIdentity(realDir);
    if (discovery.seen_dir_keys.has(realDirKey)) continue;
    discovery.seen_dir_keys.add(realDirKey);
    const entries = await fsp.readdir(realDir, { withFileTypes: true }).catch(e => {
      if (e?.code === 'ENOENT') return [];
      recordHistoryDiscoveryWarning(discovery, realDir, e, 'history_discovery_unreadable');
      return [];
    });
    throwIfOutputAborted(signal);
    if (historyDirectoryIsAcceptanceFixture(realDir, entries)) continue;
    const currentLooksLikeHistoryBase = historyBaseCandidateAllowed(realDir, { realOutputs, realTmp })
      && await historyDirectoryLooksLikeBase(realDir, entries, { realOutputs, realTmp, signal, discovery });
    const currentHasOwnIndex = entries.some(entry => entry.isFile() && entry.name === 'index.json');
    const currentHasOwnRootMarker = entries.some(entry => entry.isFile() && entry.name === HISTORY_ROOT_MARKER_FILE);
    const currentIsArtifactDateDir = historyArtifactDateDirectoryName(path.basename(realDir));
    const currentIsHistoryBase = currentLooksLikeHistoryBase
      && (!task.insideHistoryBase || currentHasOwnIndex || currentHasOwnRootMarker || !currentIsArtifactDateDir);
    if (currentIsHistoryBase) {
      const baseKey = platformPathIdentity(realDir);
      if (!discovery.discovered_base_keys.has(baseKey)) {
        discovery.discovered_base_keys.add(baseKey);
        discovery.discovered_bases.push(realDir);
        out.push(realDir);
      }
    }
    const directories = await historyDiscoveryDirectoriesByMtime(realDir, entries, { signal, discovery });
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      const entry = directories[index];
      if (!historyDiscoveryWithinTestScope(entry.path)) continue;
      if (currentIsHistoryBase
        && entry.name.toLowerCase() === 'previews'
        && !await historyBaseHasOwnershipBoundary(entry.path, { signal })) continue;
      if (currentIsHistoryBase
        && historyArtifactDateDirectoryName(entry.name)
        && !await historyBaseHasOwnershipBoundary(entry.path, { signal })) continue;
      discovery.pending_dirs.push({
        dir: entry.path,
        insideHistoryBase: !!task.insideHistoryBase || currentIsHistoryBase,
      });
    }
  }
}

function historyAcceptanceFixtureScopeIncludes(dir = '') {
  const candidate = path.resolve(String(dir || ''));
  if (!candidate) return false;
  return historyEnvironmentPathList(process.env[HISTORY_ACCEPTANCE_FIXTURE_ROOTS_ENV])
    .some(root => candidate === root || isInside(root, candidate));
}

function historyEnvironmentPathList(value = '') {
  return String(value || '')
    .split(path.delimiter)
    .map(entry => String(entry || '').trim())
    .filter(Boolean)
    .map(entry => path.resolve(entry));
}

function historyDiscoveryTestScopes() {
  return historyEnvironmentPathList(process.env[HISTORY_DISCOVERY_TEST_SCOPE_ENV]);
}

function historyDiscoveryWithinTestScope(dir = '') {
  const scopes = historyDiscoveryTestScopes();
  if (!scopes.length) return true;
  const candidate = path.resolve(String(dir || ''));
  if (!candidate) return false;
  return scopes.some(root => candidate === root || isInside(root, candidate) || isInside(candidate, root));
}

function historyDirectoryIsAcceptanceFixture(dir, entries = []) {
  if (process.env[HISTORY_ACCEPTANCE_FIXTURE_ENV] === '1' || historyAcceptanceFixtureScopeIncludes(dir)) return false;
  if (path.basename(String(dir || '')).toLowerCase() === 'acceptance-history-digest-test') return true;
  return entries.some(entry => entry.isFile?.() && entry.name === HISTORY_ACCEPTANCE_FIXTURE_MARKER_FILE);
}

function historyBaseCandidateAllowed(dir, { realOutputs = OUTPUTS_DIR, realTmp = OUTPUTS_TMP_DIR } = {}) {
  const resolved = dir ? path.resolve(dir) : '';
  const outputs = path.resolve(realOutputs || OUTPUTS_DIR);
  const tmp = realTmp ? path.resolve(realTmp) : '';
  return !!resolved
    && resolved !== outputs
    && isInside(outputs, resolved)
    && !(tmp && isInside(tmp, resolved));
}

async function historyDirectoryLooksLikeBase(dir, entries = [], { realOutputs = OUTPUTS_DIR, realTmp = OUTPUTS_TMP_DIR, signal = null, discovery = null } = {}) {
  if (!historyBaseCandidateAllowed(dir, { realOutputs, realTmp })) return false;
  if (entries.some(historyArtifactMarkerEntry)) {
    return true;
  }
  const previewDir = entries.find(entry => entry.isDirectory() && entry.name.toLowerCase() === 'previews');
  if (previewDir && await historyChildDirectoryHasArtifactMarkers(dir, previewDir, { signal, discovery, markdownOnly: true })) return true;
  for (const entry of entries) {
    if (!entry.isDirectory() || !historyArtifactDateDirectoryName(entry.name)) continue;
    if (await historyChildDirectoryHasArtifactMarkers(dir, entry, { signal, discovery })) return true;
  }
  return false;
}

function historyArtifactMarkerEntry(entry = {}) {
  return entry.isFile?.()
    && (entry.name === 'index.json' || entry.name === HISTORY_ROOT_MARKER_FILE || /\.digest\.json$/i.test(entry.name) || /\.md\.meta\.json$/i.test(entry.name) || looksLikeLegacyDigestPngName(entry.name));
}

function historyArtifactDateDirectoryName(value = '') {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

async function historyChildDirectoryHasArtifactMarkers(parent, entry, { signal = null, discovery = null, markdownOnly = false } = {}) {
  const childPath = path.join(parent, entry.name);
  const childStat = await fsp.lstat(childPath).catch(e => {
    if (e?.code === 'ENOENT') return null;
    recordHistoryDiscoveryWarning(discovery, childPath, e, 'history_discovery_unreadable');
    return null;
  });
  throwIfOutputAborted(signal);
  if (!childStat?.isDirectory() || childStat.isSymbolicLink?.()) return false;
  const childEntries = await fsp.readdir(childPath, { withFileTypes: true }).catch(e => {
    if (e?.code === 'ENOENT') return [];
    recordHistoryDiscoveryWarning(discovery, childPath, e, 'history_discovery_unreadable');
    return [];
  });
  throwIfOutputAborted(signal);
  return childEntries.some(child => child.isFile() && (markdownOnly ? /\.md\.meta\.json$/i.test(child.name) : historyArtifactMarkerEntry(child)));
}

async function historyDiscoveryDirectoriesByMtime(parentDir, entries = [], { signal = null, discovery = null } = {}) {
  const dirs = [];
  for (const entry of entries) {
    throwIfOutputAborted(signal);
    if (!entry.isDirectory()) continue;
    const full = path.join(parentDir, entry.name);
    const stat = await fsp.lstat(full).catch(e => {
      if (e?.code === 'ENOENT') return null;
      recordHistoryDiscoveryWarning(discovery, full, e, 'history_discovery_unreadable');
      return null;
    });
    throwIfOutputAborted(signal);
    if (stat?.isSymbolicLink?.()) continue;
    dirs.push({
      path: full,
      name: entry.name,
      mtimeMs: await historyDiscoveryDirectoryMtimeMs(full, stat, { signal }),
    });
  }
  return dirs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

function recordHistoryDiscoveryWarning(discovery = null, targetPath = '', error = null, code = 'history_discovery_unreadable') {
  if (!discovery || !Array.isArray(discovery.warnings)) return;
  const relative = toProjectRelative(targetPath || '');
  const key = `${code}:${relative}`;
  if (discovery.warnings.some(item => item?._key === key)) return;
  discovery.warnings.push({
    _key: key,
    code: code || 'history_discovery_unreadable',
    path: relative,
    error_code: String(error?.code || '').trim(),
    message: `历史扫描跳过了不可读目录 ${relative || path.basename(String(targetPath || '')) || 'unknown'}；请检查权限或文件占用。`,
  });
}

async function historyDiscoveryDirectoryMtimeMs(dir, stat, { signal = null } = {}) {
  let newest = Number(stat?.mtimeMs || 0) || 0;
  const indexStat = await fsp.stat(path.join(dir, 'index.json')).catch(() => null);
  throwIfOutputAborted(signal);
  newest = Math.max(newest, Number(indexStat?.mtimeMs || 0) || 0);
  return newest;
}

async function recoverHistoryIndex(settings, file, cause, base = null, { signal = null, rebuildExcludeBases = [] } = {}) {
  throwIfOutputAborted(signal);
  const safeBase = base ? path.resolve(base) : await safeOutputBase(settings);
  await assertSafeOutputParent(safeBase, file);
  throwIfOutputAborted(signal);
  const preserved = await preserveInvalidFileBackup(file, { maxBytes: HISTORY_INDEX_JSON_MAX_BYTES });
  const backup = preserved.backup_path || preserved.original_path || file;
  throwIfOutputAborted(signal);
  const rebuilt = await rebuildHistoryIndexFromDigests(safeBase, { signal, excludeBases: rebuildExcludeBases });
  throwIfOutputAborted(signal);
  await writeHistoryIndexAtomic(file, rebuilt);
  invalidateHistoryCaches();
  if (!rebuilt.length && cause) {
    const evidence = preserved.backup_available === true
      ? `已按内容备份为 ${toProjectRelative(backup)}`
      : `原索引已保留在 ${toProjectRelative(file)}`;
    return attachHistoryIndexWarnings(rebuilt, [{
      code: 'history_index_reset_empty',
      base: toProjectRelative(safeBase),
      backup: toProjectRelative(backup),
      message: `历史索引损坏，${evidence}；未找到可重建的摘要文件，已重置为空历史。`,
    }]);
  }
  return rebuilt;
}

async function rebuildHistoryIndexFromDigests(base, { signal = null, excludeBases = [] } = {}) {
  throwIfOutputAborted(signal);
  const digestFiles = [];
  const markdownMetaFiles = [];
  const pngFiles = [];
  const excludeRoots = await historyRebuildExcludeRoots(base, excludeBases, { signal });
  await collectDigestJsonFiles(base, digestFiles, base, { signal, excludeRoots });
  await collectPreviewMarkdownMetaFiles(base, markdownMetaFiles, base, { signal, excludeRoots });
  await collectLegacyPngOnlyFiles(base, pngFiles, base, { signal, excludeRoots });
  const digestResults = await mapHistoryItemsWithConcurrency(
    digestFiles,
    digestPath => historyIndexResultFromDigestPath(base, digestPath, { signal }),
    { signal },
  );
  const indexedDigestResults = digestResults.filter(result => result?.item);
  const items = indexedDigestResults.map(result => result.item);
  const digestPngKeys = new Set(indexedDigestResults.map(result => result.pngKey).filter(Boolean));
  const markdownResults = await mapHistoryItemsWithConcurrency(markdownMetaFiles, async metaPath => {
    throwIfOutputAborted(signal);
    const meta = await readJson(metaPath, null, { strict: false, maxBytes: HISTORY_MARKDOWN_META_MAX_BYTES, signal });
    throwIfOutputAborted(signal);
    const stat = await fsp.stat(metaPath).catch(() => null);
    throwIfOutputAborted(signal);
    const resolved = await previewMarkdownMetaItemForHistory(base, metaPath, meta, stat, { signal });
    return resolved.item;
  }, { signal });
  items.push(...markdownResults.filter(Boolean));
  const existingPngKeys = new Set(items
    .map(item => historyPathDedupeKey(item.file_path || item.relative_path || ''))
    .filter(Boolean));
  const legacyPngResults = await mapHistoryItemsWithConcurrency(pngFiles, async pngPath => {
    throwIfOutputAborted(signal);
    const key = historyPathDedupeKey(pngPath);
    if (!key || existingPngKeys.has(key) || digestPngKeys.has(key)) return null;
    if (historyRerenderVersionedPngName(path.basename(pngPath))) return null;
    return legacyPngOnlyHistoryItem(base, pngPath, { signal });
  }, { signal });
  for (const item of legacyPngResults.filter(Boolean)) {
    const key = historyPathDedupeKey(item.file_path || item.relative_path || '');
    if (!key || existingPngKeys.has(key)) continue;
    items.push(item);
    existingPngKeys.add(key);
  }
  return dedupeHistoryRerenderRecords(base, items)
    .sort(compareHistoryItemsDesc)
    .map(historyIndexItem);
}

async function historyIndexResultFromDigestPath(base, digestPath, { signal = null, requireRerenderCommit = false } = {}) {
  throwIfOutputAborted(signal);
  const digest = await readJson(digestPath, null, {
    strict: false,
    maxBytes: HISTORY_DIGEST_JSON_MAX_BYTES,
    signal,
  }).catch(error => {
    if (isOutputAbortError(error)) throw error;
    return null;
  });
  throwIfOutputAborted(signal);
  if (!digest || typeof digest !== 'object' || Array.isArray(digest)) return null;
  const filePath = digestPath.replace(/\.digest\.json$/i, '.png');
  const stat = await fsp.stat(digestPath).catch(() => null);
  throwIfOutputAborted(signal);
  const digestId = String(digest.digest_id || '').trim();
  if (!digestId) return null;
  const rerenderMetadataPresent = Object.hasOwn(digest, '__history_rerender');
  const rerenderMetadata = cleanHistoryRerenderMetadata(digest.__history_rerender);
  if (requireRerenderCommit && !rerenderMetadataPresent) return null;
  let rerenderCommitMarker = null;
  if (rerenderMetadataPresent) {
    if (rerenderMetadata) {
      rerenderCommitMarker = await historyRerenderCommitMarkerValid(base, filePath, digestPath, digestId, rerenderMetadata, { signal });
    }
    if (!rerenderCommitMarker) return null;
  }
  return {
    item: {
      digest_id: digestId,
      group: String(digest.group || '摘要'),
      since: String(digest.since || ''),
      until: String(digest.until || ''),
      file_path: filePath,
      relative_path: toProjectRelative(filePath),
      digest_path: digestPath,
      digest_relative_path: toProjectRelative(digestPath),
      model: String(digest.model || ''),
      message_count: Number(digest.message_count || 0),
      ...(digestRendererVersion(digest) ? { renderer_version: digestRendererVersion(digest) } : {}),
      ...(digestRendererEngine(digest) ? { renderer_engine: digestRendererEngine(digest) } : {}),
      headline: digestHeadlineForHistory(digest),
      search_text: digestSearchTextForHistory(digest),
      ...(rerenderMetadata ? {
        history_record_id: rerenderMetadata.record_id,
        history_item_key_aliases: rerenderMetadata.history_item_key_aliases,
        rerendered_at: rerenderMetadata.rerendered_at,
        saved_file_version: String(rerenderCommitMarker.saved_file_version || '').trim(),
        saved_digest_file_version: String(rerenderCommitMarker.saved_digest_file_version || '').trim(),
        history_rerender: rerenderMetadata,
      } : {}),
      created_at: String(digest.created_at || stat?.mtime?.toISOString?.() || new Date().toISOString()),
    },
    pngKey: historyPathDedupeKey(filePath),
  };
}

async function historyRebuildExcludeRoots(base, excludeBases = [], { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const realBase = await fsp.realpath(base).catch(() => '');
  throwIfOutputAborted(signal);
  if (!realBase) return [];
  const roots = [];
  const seen = new Set();
  for (const excludeBase of Array.isArray(excludeBases) ? excludeBases : []) {
    throwIfOutputAborted(signal);
    const realExclude = await fsp.realpath(excludeBase).catch(() => '');
    throwIfOutputAborted(signal);
    if (!realExclude || !isInside(realBase, realExclude)) continue;
    const key = platformPathIdentity(realExclude);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(realExclude);
  }
  return roots;
}

async function repairLegacyTruncatedHistoryIndex(settings, list, base, { write = true, signal = null, rebuildExcludeBases = [] } = {}) {
  throwIfOutputAborted(signal);
  if (!Array.isArray(list) || list.length !== LEGACY_HISTORY_INDEX_LIMIT) return list;
  const rebuilt = await rebuildHistoryIndexFromDigests(base, { signal, excludeBases: rebuildExcludeBases });
  if (rebuilt.length <= list.length) return list;
  const byKey = new Map();
  for (const item of rebuilt) {
    throwIfOutputAborted(signal);
    if (item?.digest_id) byKey.set(historyItemKeyForItem(base, item), item);
  }
  for (const item of list) {
    throwIfOutputAborted(signal);
    if (!item?.digest_id) continue;
    const key = historyItemKeyForItem(base, item);
    byKey.set(key, { ...(byKey.get(key) || {}), ...item });
  }
  const repaired = dedupeHistoryRerenderRecords(base, [...byKey.values()]).sort(compareHistoryItemsDesc);
  if (!write) return repaired;
  const file = path.join(base, 'index.json');
  await assertSafeOutputParent(base, file);
  throwIfOutputAborted(signal);
  await writeHistoryIndexAtomic(file, repaired);
  invalidateHistoryCaches();
  return repaired;
}

async function mergeHistoryIndexWithArtifactSidecars(settings, list, base, { write = true, signal = null, rebuildExcludeBases = [] } = {}) {
  throwIfOutputAborted(signal);
  const indexed = Array.isArray(list) ? list : [];
  const rebuilt = await rebuildHistoryIndexFromDigests(base, { signal, excludeBases: rebuildExcludeBases });
  throwIfOutputAborted(signal);
  if (!rebuilt.length) return dedupeHistoryRerenderRecords(base, indexed);
  const historyKeys = new Set();
  const artifactKeys = new Set();
  const merged = dedupeHistoryRerenderRecords(base, indexed);
  const removed = indexed.length - merged.length;
  for (const item of merged) {
    throwIfOutputAborted(signal);
    const historyKey = historyIndexMergeHistoryKey(base, item);
    if (historyKey) historyKeys.add(historyKey);
    const artifactKey = await historyIndexMergeArtifactKey(settings, base, item, { signal });
    if (artifactKey) artifactKeys.add(artifactKey);
  }
  let added = 0;
  for (const item of rebuilt) {
    throwIfOutputAborted(signal);
    const historyKey = historyIndexMergeHistoryKey(base, item);
    const artifactKey = await historyIndexMergeArtifactKey(settings, base, item, { signal });
    if ((historyKey && historyKeys.has(historyKey)) || (artifactKey && artifactKeys.has(artifactKey))) continue;
    merged.push(item);
    if (historyKey) historyKeys.add(historyKey);
    if (artifactKey) artifactKeys.add(artifactKey);
    added += 1;
  }
  if (!added && !removed) return indexed;
  const repaired = merged.sort(compareHistoryItemsDesc);
  const warnings = historyIndexWarningsFromList(indexed).slice();
  warnings.push({
    code: 'history_index_missing_artifacts_recovered',
    base: toProjectRelative(base),
    count: added,
    removed,
    persisted: !!write,
    message: `历史索引已从摘要文件自动修复：恢复 ${added} 条，合并 ${removed} 条重复索引记录。`,
  });
  if (write) {
    const file = path.join(base, 'index.json');
    await assertSafeOutputParent(base, file);
    throwIfOutputAborted(signal);
    await writeHistoryIndexAtomic(file, repaired.map(historyIndexItem));
    invalidateHistoryCaches();
  }
  return attachHistoryIndexWarnings(repaired, warnings);
}

function historyIndexMergeHistoryKey(base, item = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  if (!String(item.digest_id || '').trim()) return '';
  return historyItemKeyForItem(base, item);
}

async function historyIndexMergeArtifactKey(settings, base, item = {}, { signal = null } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  const resolved = resolveHistoryItemPaths(base, item, settings);
  return historyArtifactPhysicalKey(resolved, { signal });
}

async function recoverHistoryIndexReadOnly(settings, cause, base, { signal = null, rebuildExcludeBases = [] } = {}) {
  throwIfOutputAborted(signal);
  const rebuilt = await rebuildHistoryIndexFromDigests(base, { signal, excludeBases: rebuildExcludeBases });
  if (!rebuilt.length) {
    const err = new Error(`旧输出目录 ${toProjectRelative(base)} 的历史索引不可读，且未找到可重建的摘要 JSON。`);
    err.status = 500;
    err.code = 'history_index_unreadable';
    err.cause = cause;
    throw err;
  }
  const indexed = await ensureHistorySearchTextIndex(settings, rebuilt, base, { write: false, signal });
  return attachHistoryIndexWarnings(indexed, [{
    code: 'history_index_rebuilt_read_only',
    base: toProjectRelative(base),
    count: indexed.length,
    persisted: false,
    message: `历史索引不可读，当前从 ${indexed.length} 条摘要文件临时展示；未修改 index.json 或历史文件。`,
  }]);
}

async function mapHistoryItemsWithConcurrency(items, worker, { limit = 16, signal = null } = {}) {
  const values = Array.isArray(items) ? items : [];
  const results = new Array(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Number(limit || 1) || 1), values.length);
  const run = async () => {
    while (true) {
      throwIfOutputAborted(signal);
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, run));
  return results;
}

async function ensureHistorySearchTextIndex(settings, list, base, { write = false, recheckIncomplete = false, signal = null } = {}) {
  throwIfOutputAborted(signal);
  if (!Array.isArray(list) || !list.length) return Array.isArray(list) ? list : [];
  const warnings = historyIndexWarningsFromList(list).slice();
  const next = new Array(list.length);
  const pending = [];
  list.forEach((item, index) => {
    throwIfOutputAborted(signal);
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      next[index] = item;
      return;
    }
    const hasSearchText = !!cleanHistorySearchText(item.search_text);
    const hasHeadline = !!cleanHistorySearchText(item.headline);
    const hasCurrentSearchIndex = historySearchTextIndexCurrent(item);
    const metadataOnly = String(item.search_index_status || '').trim() === 'metadata_only';
    if (hasSearchText && hasHeadline && hasCurrentSearchIndex && (!metadataOnly || !recheckIncomplete)) {
      next[index] = item;
      return;
    }
    pending.push({ index, item, hasSearchText, hasHeadline, hasCurrentSearchIndex });
  });
  const repaired = await mapHistoryItemsWithConcurrency(pending, async ({ index, item, hasSearchText, hasHeadline, hasCurrentSearchIndex }) => {
    throwIfOutputAborted(signal);
    const digestPath = resolveDigestPath(base, item);
    let file = '';
    let missingDigestCount = 0;
    let unreadableDigestCount = 0;
    let invalidDigestCount = 0;
    let problemDigest = '';
    if (digestPath) {
      try {
        file = await assertReadableOutputFile(base, digestPath, { extensions: ['.digest.json'], signal });
      } catch (e) {
        if (isOutputAbortError(e)) throw e;
        if (e?.code === 'output_file_missing' || e?.status === 404) missingDigestCount += 1;
        else unreadableDigestCount += 1;
        problemDigest ||= toProjectRelative(digestPath);
      }
    }
    throwIfOutputAborted(signal);
    let digest = null;
    if (file) {
      try {
        digest = await readJson(file, null, { strict: true, maxBytes: HISTORY_DIGEST_JSON_MAX_BYTES, signal });
      } catch (e) {
        if (isOutputAbortError(e)) throw e;
        unreadableDigestCount += 1;
        problemDigest ||= toProjectRelative(file);
      }
    }
    throwIfOutputAborted(signal);
    if (!digest || typeof digest !== 'object' || Array.isArray(digest)) {
      if (file) {
        invalidDigestCount += 1;
        problemDigest ||= toProjectRelative(file);
      }
      const fallback = historyMetadataOnlySearchIndex(item);
      return {
        index,
        item: fallback,
        changed: JSON.stringify(fallback) !== JSON.stringify(item),
        missingDigestCount,
        unreadableDigestCount,
        invalidDigestCount,
        problemDigest,
      };
    }
    const itemId = String(item.digest_id || '').trim();
    const digestId = String(digest.digest_id || '').trim();
    if (itemId && digestId && itemId !== digestId) {
      invalidDigestCount += 1;
      problemDigest ||= toProjectRelative(file || digestPath);
      const fallback = historyMetadataOnlySearchIndex(item);
      return {
        index,
        item: fallback,
        changed: JSON.stringify(fallback) !== JSON.stringify(item),
        missingDigestCount,
        unreadableDigestCount,
        invalidDigestCount,
        problemDigest,
      };
    }
    const updated = {
      ...item,
      headline: hasHeadline ? cleanHistorySearchText(item.headline, HISTORY_SEARCH_HEADLINE_MAX_CHARS) : digestHeadlineForHistory(digest),
      search_text: hasCurrentSearchIndex && hasSearchText ? cleanHistorySearchText(item.search_text, HISTORY_SEARCH_TEXT_MAX_CHARS) : digestSearchTextForHistory(digest),
      search_text_version: HISTORY_SEARCH_INDEX_VERSION,
    };
    delete updated.search_index_status;
    return {
      index,
      item: updated,
      changed: true,
      missingDigestCount,
      unreadableDigestCount,
      invalidDigestCount,
      problemDigest,
    };
  }, { signal });
  let changed = false;
  let missingDigestCount = 0;
  let unreadableDigestCount = 0;
  let invalidDigestCount = 0;
  let firstProblemDigest = '';
  for (const result of repaired) {
    throwIfOutputAborted(signal);
    if (!result) continue;
    next[result.index] = result.item;
    changed ||= result.changed === true;
    missingDigestCount += result.missingDigestCount;
    unreadableDigestCount += result.unreadableDigestCount;
    invalidDigestCount += result.invalidDigestCount;
    firstProblemDigest ||= result.problemDigest;
  }
  if (changed && write) {
    const file = path.join(base, 'index.json');
    await assertSafeOutputParent(base, file);
    throwIfOutputAborted(signal);
    await writeHistoryIndexAtomic(file, next.map(historyIndexItem));
    invalidateHistoryCaches();
  }
  const skipped = missingDigestCount + unreadableDigestCount + invalidDigestCount;
  if (skipped > 0) {
    warnings.push({
      code: 'history_search_index_repair_incomplete',
      base: toProjectRelative(base),
      missing_digest_count: missingDigestCount,
      unreadable_digest_count: unreadableDigestCount,
      invalid_digest_count: invalidDigestCount,
      sample: firstProblemDigest,
      message: `有 ${skipped} 条历史记录的搜索索引无法从摘要 JSON 修复；搜索结果可能不完整，请打开对应历史记录查看文件状态。`,
    });
  }
  return attachHistoryIndexWarnings(next, warnings);
}

function historyMetadataOnlySearchIndex(item = {}) {
  return {
    ...item,
    headline: cleanHistorySearchText(item.headline || item.group || item.digest_id || '历史摘要', HISTORY_SEARCH_HEADLINE_MAX_CHARS),
    search_text: cleanHistorySearchText([
      item.digest_id,
      item.account_label,
      item.account_id,
      item.group_id,
      item.group,
      item.headline,
      item.since,
      item.until,
      item.created_at,
      item.restored_at,
      historySearchArtifactFileName(item.relative_path || item.file_path),
      historySearchArtifactFileName(item.digest_relative_path || item.digest_path),
      item.model,
    ].filter(Boolean).join(' · '), HISTORY_SEARCH_TEXT_MAX_CHARS),
    search_text_version: HISTORY_SEARCH_INDEX_VERSION,
    search_index_status: 'metadata_only',
  };
}

function safeHistorySortTimeMs(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const utc = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/);
  if (utc) return checkedHistoryDateMs(utc, { utc: true });
  const offset = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?([+-])(\d{2}):(\d{2})$/);
  if (offset) return checkedHistoryOffsetDateMs(offset);
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/);
  if (local) return checkedHistoryDateMs(local, { utc: false });
  return 0;
}

function checkedHistoryDateMs(match, { utc = false } = {}) {
  const [, y, mo, d, h, mi, rawSeconds = '0', rawMilliseconds = '0'] = match;
  const ms = Number(String(rawMilliseconds || '0').padEnd(3, '0'));
  const parts = [y, mo, d, h, mi, rawSeconds].map(Number);
  if (parts.some(part => !Number.isInteger(part)) || !Number.isInteger(ms)) return 0;
  const [year, month, day, hour, minute, second] = parts;
  const date = utc
    ? new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms))
    : new Date(year, month - 1, day, hour, minute, second, ms);
  const time = date.getTime();
  if (!Number.isFinite(time)) return 0;
  const valid = utc
    ? date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day
      && date.getUTCHours() === hour
      && date.getUTCMinutes() === minute
      && date.getUTCSeconds() === second
      && date.getUTCMilliseconds() === ms
    : date.getFullYear() === year
      && date.getMonth() === month - 1
      && date.getDate() === day
      && date.getHours() === hour
      && date.getMinutes() === minute
      && date.getSeconds() === second
      && date.getMilliseconds() === ms;
  return valid ? time : 0;
}

function historyItemSortTimeMs(item = {}) {
  const fileTime = Number(item.mtime_ms || item.mtimeMs || 0);
  return Math.max(
    0,
    safeHistorySortTimeMs(item.rerendered_at),
    safeHistorySortTimeMs(item.restored_at),
    safeHistorySortTimeMs(item.created_at),
    Number.isFinite(fileTime) ? fileTime : 0,
  );
}

function checkedHistoryOffsetDateMs(match) {
  const base = checkedHistoryDateMs(match.slice(0, 8), { utc: true });
  if (!base) return 0;
  const sign = match[8] === '-' ? -1 : 1;
  const offsetHour = Number(match[9]);
  const offsetMinute = Number(match[10]);
  if (!Number.isInteger(offsetHour) || offsetHour > 23 || !Number.isInteger(offsetMinute) || offsetMinute > 59) return 0;
  const time = base - sign * (offsetHour * 60 + offsetMinute) * 60 * 1000;
  return Number.isFinite(time) ? time : 0;
}

function historyItemSortTieBreaker(item = {}) {
  const identity = [
    item.history_item_key,
    item.digest_id,
    item.relative_path,
    item.digest_relative_path,
    item.file_path,
    item.digest_path,
  ].map(value => String(value || '')).join('\0');
  return crypto.createHash('sha256').update(identity).digest('hex');
}

function compareHistoryItemsDesc(a = {}, b = {}) {
  const byTime = historyItemSortTimeMs(b) - historyItemSortTimeMs(a);
  if (byTime) return byTime;
  return historyItemSortTieBreaker(a).localeCompare(historyItemSortTieBreaker(b));
}

async function collectDigestJsonFiles(dir, out, root = dir, { signal = null, excludeRoots = [] } = {}) {
  return collectHistorySourceFiles(dir, out, root, /\.digest\.json$/i, { signal, excludeRoots });
}

async function collectHistoryRerenderCommitMarkerFiles(dir, out, root = dir, { signal = null, excludeRoots = [] } = {}) {
  return collectHistorySourceFiles(dir, out, root, /\.digest\.json\.commit\.json$/i, { signal, excludeRoots });
}

async function collectPreviewMarkdownMetaFiles(dir, out, root = dir, { signal = null, excludeRoots = [] } = {}) {
  return collectHistorySourceFiles(dir, out, root, /\.md\.meta\.json$/i, { signal, excludeRoots });
}

async function collectLegacyPngOnlyFiles(dir, out, root = dir, { signal = null, excludeRoots = [] } = {}) {
  return collectHistorySourceFiles(dir, out, root, /\.png$/i, { signal, excludeRoots });
}

function looksLikeLegacyDigestPngName(name = '') {
  const file = String(name || '').trim();
  if (!/\.png$/i.test(file)) return false;
  const stem = file.replace(/\.png$/i, '');
  return /(?:^|__)[A-Za-z0-9]{8}$/.test(stem)
    || /(?:^|__)\d{8}-\d{4}_\d{8}-\d{4}(?:__[A-Za-z0-9]{4,8})?$/.test(stem);
}

async function collectHistorySourceFiles(dir, out, root = dir, filenamePattern = /$^/, { signal = null, excludeRoots = [], cleanupAtomicTemps = true } = {}) {
  throwIfOutputAborted(signal);
  if (isInside(OUTPUTS_TMP_DIR, dir)) return;
  const [realRoot, realDir] = await Promise.all([
    fsp.realpath(root).catch(() => ''),
    fsp.realpath(dir).catch(() => ''),
  ]);
  throwIfOutputAborted(signal);
  if (!realRoot || !realDir || !isInside(realRoot, realDir)) return;
  if ((Array.isArray(excludeRoots) ? excludeRoots : []).some(excludeRoot => excludeRoot && isInside(excludeRoot, realDir))) return;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(e => {
    if (e?.code === 'ENOENT') return [];
    throw e;
  });
  throwIfOutputAborted(signal);
  for (const entry of entries) {
    throwIfOutputAborted(signal);
    const full = path.join(dir, entry.name);
    if (isInside(OUTPUTS_TMP_DIR, full)) continue;
    const stat = await fsp.lstat(full).catch(() => null);
    throwIfOutputAborted(signal);
    if (entry.isSymbolicLink?.() || stat?.isSymbolicLink?.()) continue;
    if (entry.isFile() && isAtomicOutputTempName(entry.name)) {
      if (cleanupAtomicTemps) await removeStaleAtomicOutputTemp(full, stat, { signal });
      continue;
    }
    if (entry.isDirectory()) {
      if (path.resolve(full) !== path.resolve(root) && await historyBaseHasOwnershipBoundary(full, { signal })) continue;
      await collectHistorySourceFiles(full, out, root, filenamePattern, { signal, excludeRoots, cleanupAtomicTemps });
    } else if (entry.isFile() && filenamePattern.test(entry.name)) {
      out.push(full);
    }
  }
}

function historyPathDedupeKey(file = '') {
  const resolved = file ? path.resolve(file) : '';
  return resolved ? (process.platform === 'win32' ? resolved.toLowerCase() : resolved) : '';
}

function historyRerenderVersionedPngName(name = '') {
  return /__rerender_\d{17}_[a-f0-9]{12}\.png$/i.test(String(name || ''));
}

function cleanHistoryRerenderRelativePath(value = '', extension = '') {
  const raw = String(value || '').trim();
  if (!raw || path.isAbsolute(raw)) return '';
  const clean = normalizeHistoryRelativePath(raw);
  if (!clean || clean === '..' || clean.startsWith('../') || clean.split('/').includes('..')) return '';
  const ext = String(extension || '').toLowerCase();
  if (ext && !clean.toLowerCase().endsWith(ext)) return '';
  return clean.slice(0, 1000);
}

function cleanHistoryRerenderArtifact(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const digestId = String(value.digest_id || '').trim().slice(0, 240);
  const relativePath = cleanHistoryRerenderRelativePath(value.relative_path, '.png');
  const digestRelativePath = cleanHistoryRerenderRelativePath(value.digest_relative_path, '.digest.json');
  if (!digestId || !relativePath || !digestRelativePath) return null;
  return {
    digest_id: digestId,
    relative_path: relativePath,
    digest_relative_path: digestRelativePath,
  };
}

function historyRerenderArtifactKey(value = {}) {
  const clean = cleanHistoryRerenderArtifact(value);
  return clean ? JSON.stringify(clean) : '';
}

function cleanHistoryItemKey(value = '') {
  const key = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(key) ? key : '';
}

function cleanHistoryItemKeyAliases(values = []) {
  const aliases = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const key = cleanHistoryItemKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    aliases.push(key);
    if (aliases.length >= HISTORY_ITEM_KEY_ALIAS_LIMIT) break;
  }
  return aliases;
}

function cleanHistoryRerenderMetadata(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Number(value.version || 0) !== HISTORY_RERENDER_COMMIT_MARKER_VERSION) return null;
  const source = cleanHistoryRerenderArtifact(value.source);
  if (!source) return null;
  const recordId = cleanHistoryItemKey(value.record_id);
  if (!recordId) return null;
  const seen = new Set();
  const superseded = [];
  // This bounded list is an index hint only. Retention reconstructs the full
  // chain from every verified commit marker, so repeated rerenders cannot make
  // older artifacts invisible to cleanup.
  for (const candidate of [source, ...(Array.isArray(value.superseded) ? value.superseded : [])]) {
    const clean = cleanHistoryRerenderArtifact(candidate);
    const key = historyRerenderArtifactKey(clean);
    if (!clean || !key || seen.has(key)) continue;
    seen.add(key);
    superseded.push(clean);
    if (superseded.length >= HISTORY_RERENDER_METADATA_SUPERSEDED_LIMIT) break;
  }
  if (!superseded.length) return null;
  const historyItemKeyAliases = cleanHistoryItemKeyAliases([
    recordId,
    ...(Array.isArray(value.history_item_key_aliases) ? value.history_item_key_aliases : []),
  ]);
  return {
    version: HISTORY_RERENDER_COMMIT_MARKER_VERSION,
    record_id: recordId,
    rerendered_at: String(value.rerendered_at || '').trim().slice(0, 80),
    source,
    superseded,
    history_item_key_aliases: historyItemKeyAliases,
  };
}

function historyItemKeyAliases(currentBase, item = {}) {
  const currentKey = historyItemKeyForItem(currentBase, item);
  const rerender = cleanHistoryRerenderMetadata(item.history_rerender || item.__history_rerender);
  return cleanHistoryItemKeyAliases([
    ...(rerender?.history_item_key_aliases || []),
    ...(Array.isArray(item.history_item_key_aliases) ? item.history_item_key_aliases : []),
  ]).filter(key => key !== currentKey);
}

function historyRerenderArtifactForItem(base, item = {}) {
  const filePath = resolveHistoryFilePath(base, item);
  const digestPath = resolveDigestPath(base, item);
  return cleanHistoryRerenderArtifact({
    digest_id: item.digest_id,
    relative_path: relativeInside(base, filePath),
    digest_relative_path: relativeInside(base, digestPath),
  });
}

function dedupeHistoryRerenderRecords(base, items = []) {
  const list = Array.isArray(items) ? items : [];
  const winners = new Map();
  for (const item of list) {
    const key = historyItemKeyForItem(base, item);
    if (!key) continue;
    const current = winners.get(key);
    if (!current || historyRerenderRecordItemIsNewer(item, current)) winners.set(key, item);
  }
  return list.filter(item => {
    const key = historyItemKeyForItem(base, item);
    return !key || winners.get(key) === item;
  });
}

function historyRerenderRecordItemIsNewer(candidate = {}, current = {}) {
  const candidateMetadata = cleanHistoryRerenderMetadata(candidate.history_rerender);
  const currentMetadata = cleanHistoryRerenderMetadata(current.history_rerender);
  if (!!candidateMetadata !== !!currentMetadata) return !!candidateMetadata;
  const candidateTime = safeHistorySortTimeMs(candidate.rerendered_at || candidateMetadata?.rerendered_at);
  const currentTime = safeHistorySortTimeMs(current.rerendered_at || currentMetadata?.rerendered_at);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  const candidatePath = normalizeHistoryRelativePath(candidate.relative_path || candidate.file_path);
  const currentPath = normalizeHistoryRelativePath(current.relative_path || current.file_path);
  return candidatePath.localeCompare(currentPath) > 0;
}

function historyRerenderMetadataForVersion(base, item = {}, rerenderedAt = '') {
  const source = historyRerenderArtifactForItem(base, item);
  if (!source) throw outputPathError('history rerender source is outside output dir');
  const inheritedMetadata = cleanHistoryRerenderMetadata(item.history_rerender);
  const inherited = inheritedMetadata?.superseded || [];
  const existingRecordId = cleanHistoryItemKey(item.history_record_id);
  const sourceItemKey = historyItemKeyForItem(base, item);
  return cleanHistoryRerenderMetadata({
    version: HISTORY_RERENDER_COMMIT_MARKER_VERSION,
    record_id: existingRecordId || sourceItemKey,
    rerendered_at: rerenderedAt,
    source,
    superseded: [...inherited, source],
    history_item_key_aliases: [
      sourceItemKey,
      ...historyItemKeyAliases(base, item),
    ],
  });
}

function historyRerenderCommitMarkerPath(digestPath = '') {
  return digestPath ? `${digestPath}.commit.json` : '';
}

function digestSaveTransactionMarkerPath(digestPath = '') {
  return digestPath ? `${digestPath}${HISTORY_SAVE_TRANSACTION_SUFFIX}` : '';
}

function cleanDigestSaveOperationId(value = '') {
  return String(value || '').trim().slice(0, 240);
}

function digestSaveTransactionPayload(base, {
  operationId = '',
  filePath = '',
  digestPath = '',
  tempPath = '',
  digest = {},
  pngBytes = 0,
  pngSha256 = '',
  state = 'prepared',
  preparedAt = '',
  committedAt = '',
  indexedAt = '',
  savedFileVersion = '',
  savedDigestFileVersion = '',
} = {}) {
  const now = new Date().toISOString();
  return {
    schema: 'wx-summary.digest-save-transaction.v1',
    version: HISTORY_SAVE_TRANSACTION_VERSION,
    state: ['prepared', 'committed', 'indexed'].includes(state) ? state : 'prepared',
    operation_id: cleanDigestSaveOperationId(operationId),
    prepared_at: String(preparedAt || now),
    committed_at: String(committedAt || ''),
    indexed_at: String(indexedAt || ''),
    relative_path: relativeInside(base, filePath),
    digest_relative_path: relativeInside(base, digestPath),
    temp_relative_path: tempPath ? relativeInside(base, tempPath) : '',
    png_bytes: Math.max(0, Number(pngBytes || 0) || 0),
    png_sha256: String(pngSha256 || '').trim().toLowerCase(),
    saved_file_version: String(savedFileVersion || '').trim(),
    saved_digest_file_version: String(savedDigestFileVersion || '').trim(),
    digest: persistedDigest(digest),
  };
}

function digestSaveTransactionMarkerBuffer(payload = {}) {
  const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8');
  const maxBytes = HISTORY_DIGEST_JSON_MAX_BYTES + 64 * 1024;
  if (buffer.length > maxBytes) throw digestJsonTooLargeError(buffer.length, maxBytes, '长图保存事务');
  return buffer;
}

async function readDigestSaveTransactionMarker(base, markerPath, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const marker = path.resolve(String(markerPath || ''));
  if (!marker || !isInside(base, marker) || isInside(OUTPUTS_TMP_DIR, marker)) return null;
  const readable = await assertReadableOutputFile(base, marker, { extensions: ['.json'], signal }).catch(error => {
    if (isOutputAbortError(error)) throw error;
    return '';
  });
  if (!readable) return null;
  let raw = null;
  try {
    const { data } = await readOutputFileBuffer(readable, {
      signal,
      max_bytes: HISTORY_DIGEST_JSON_MAX_BYTES + 64 * 1024,
    });
    raw = JSON.parse(data.toString('utf-8'));
  } catch (error) {
    if (isOutputAbortError(error)) throw error;
    return null;
  }
  const relativePath = cleanHistoryRerenderRelativePath(raw?.relative_path, '.png');
  const digestRelativePath = cleanHistoryRerenderRelativePath(raw?.digest_relative_path, '.digest.json');
  const tempRelativePath = raw?.temp_relative_path
    ? cleanHistoryRerenderRelativePath(raw.temp_relative_path, '.tmp')
    : '';
  const filePath = relativePath ? path.resolve(base, relativePath) : '';
  const digestPath = digestRelativePath ? path.resolve(base, digestRelativePath) : '';
  const tempPath = tempRelativePath ? path.resolve(base, tempRelativePath) : '';
  const normalizedDigest = persistedDigest(raw?.digest || {});
  const expectedMarkerPath = digestSaveTransactionMarkerPath(digestPath);
  const shapeValid = raw?.schema === 'wx-summary.digest-save-transaction.v1'
    && Number(raw?.version || 0) === HISTORY_SAVE_TRANSACTION_VERSION
    && ['prepared', 'committed', 'indexed'].includes(String(raw?.state || ''))
    && !!cleanDigestSaveOperationId(raw?.operation_id)
    && !!relativePath
    && !!digestRelativePath
    && !!filePath
    && !!digestPath
    && isInside(base, filePath)
    && isInside(base, digestPath)
    && (!raw?.temp_relative_path || (
      !!tempRelativePath
      && !!tempPath
      && isInside(base, tempPath)
      && !isInside(OUTPUTS_TMP_DIR, tempPath)
      && isAtomicOutputTempName(path.basename(tempPath))
    ))
    && historyPathDedupeKey(digestJsonPathForPng(filePath)) === historyPathDedupeKey(digestPath)
    && historyPathDedupeKey(expectedMarkerPath) === historyPathDedupeKey(marker)
    && Number(raw?.png_bytes || 0) > 0
    && Number(raw?.png_bytes || 0) <= RENDERED_PNG_MAX_BYTES
    && /^[a-f0-9]{64}$/.test(String(raw?.png_sha256 || '').trim().toLowerCase())
    && !!String(normalizedDigest.digest_id || '').trim()
    && !digestLooksEmptyForHistoryRead(normalizedDigest);
  if (!shapeValid) return null;
  return {
    ...raw,
    operation_id: cleanDigestSaveOperationId(raw.operation_id),
    png_bytes: Number(raw.png_bytes),
    png_sha256: String(raw.png_sha256).trim().toLowerCase(),
    digest: normalizedDigest,
    marker_path: marker,
    file_path: filePath,
    digest_path: digestPath,
    temp_path: tempPath,
  };
}

function historyRerenderCommitMarkerPayload(base, item = {}, metadata = {}, committedAt = '', source = {}) {
  return {
    schema: 'wx-summary.history-rerender-commit.v1',
    version: HISTORY_RERENDER_COMMIT_MARKER_VERSION,
    state: 'committed',
    committed_at: String(committedAt || ''),
    digest_id: String(item.digest_id || ''),
    relative_path: relativeInside(base, item.file_path),
    digest_relative_path: relativeInside(base, item.digest_path),
    saved_file_version: String(item.saved_file_version || ''),
    saved_digest_file_version: String(item.saved_digest_file_version || ''),
    source_file_version: String(source.source_file_version || source.file_version || source.saved_file_version || ''),
    source_digest_file_version: String(source.source_digest_file_version || source.digest_file_version || source.saved_digest_file_version || ''),
    rerender: cleanHistoryRerenderMetadata(metadata),
  };
}

async function readHistoryRerenderCommitMarker(base, digestPath, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const markerPath = historyRerenderCommitMarkerPath(digestPath);
  const readable = await assertReadableOutputFile(base, markerPath, { extensions: ['.json'], signal }).catch(error => {
    if (isOutputAbortError(error)) throw error;
    return '';
  });
  if (!readable) return null;
  try {
    const { data } = await readOutputFileBuffer(readable, { signal, max_bytes: 64 * 1024 });
    return JSON.parse(data.toString('utf-8'));
  } catch (error) {
    if (isOutputAbortError(error)) throw error;
    return null;
  }
}

function historyRerenderCommitMarkerShapeValid(base, filePath, digestPath, digestId, metadata, marker = {}) {
  const markerMetadata = cleanHistoryRerenderMetadata(marker?.rerender);
  const expectedPngVersion = String(marker?.saved_file_version || '').trim();
  const expectedDigestVersion = String(marker?.saved_digest_file_version || '').trim();
  return marker?.schema === 'wx-summary.history-rerender-commit.v1'
    && Number(marker?.version || 0) === HISTORY_RERENDER_COMMIT_MARKER_VERSION
    && marker?.state === 'committed'
    && String(marker?.digest_id || '').trim() === String(digestId || '').trim()
    && cleanHistoryRerenderRelativePath(marker?.relative_path, '.png') === relativeInside(base, filePath)
    && cleanHistoryRerenderRelativePath(marker?.digest_relative_path, '.digest.json') === relativeInside(base, digestPath)
    && outputFileVersionKind(expectedPngVersion) === 'v2'
    && outputFileVersionKind(expectedDigestVersion) === 'v2'
    && JSON.stringify(markerMetadata) === JSON.stringify(cleanHistoryRerenderMetadata(metadata));
}

function historyRerenderSourceArtifactPaths(base, metadata = {}) {
  const source = cleanHistoryRerenderArtifact(metadata?.source);
  if (!source) return null;
  const filePath = path.resolve(base, source.relative_path);
  const digestPath = path.resolve(base, source.digest_relative_path);
  if (!isInside(base, filePath) || !isInside(base, digestPath)) return null;
  return { source, filePath, digestPath };
}

async function historyRerenderCommitMarkerValid(base, filePath, digestPath, digestId, metadata, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const pngReadable = await assertReadableOutputFile(base, filePath, { extensions: ['.png'], signal }).catch(error => {
    if (isOutputAbortError(error)) throw error;
    return '';
  });
  if (!pngReadable) return false;
  const digestReadable = await assertReadableOutputFile(base, digestPath, { extensions: ['.digest.json'], signal }).catch(error => {
    if (isOutputAbortError(error)) throw error;
    return '';
  });
  if (!digestReadable) return false;
  const marker = await readHistoryRerenderCommitMarker(base, digestPath, { signal });
  if (!marker || !historyRerenderCommitMarkerShapeValid(base, filePath, digestPath, digestId, metadata, marker)) return false;
  const expectedPngVersion = String(marker.saved_file_version || '').trim();
  const expectedDigestVersion = String(marker.saved_digest_file_version || '').trim();
  try {
    const currentPngVersion = await outputFileVersion(pngReadable, { signal });
    const currentDigestVersion = await outputFileVersion(digestReadable, { signal });
    const versionsMatch = outputFileVersionMatches(expectedPngVersion, currentPngVersion)
      && outputFileVersionMatches(expectedDigestVersion, currentDigestVersion);
    return versionsMatch ? marker : null;
  } catch (error) {
    if (isOutputAbortError(error)) throw error;
    return false;
  }
}

function persistedDigestsEqual(left = {}, right = {}) {
  return JSON.stringify(persistedDigest(left)) === JSON.stringify(persistedDigest(right));
}

async function inspectDigestSaveTransactionTemp(base, transaction = {}, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const tempPath = path.resolve(String(transaction?.temp_path || ''));
  if (!tempPath
    || !isInside(base, tempPath)
    || isInside(OUTPUTS_TMP_DIR, tempPath)
    || !isAtomicOutputTempName(path.basename(tempPath))) {
    return { present: false, valid: false, path: '' };
  }
  const stat = await fsp.lstat(tempPath).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  throwIfOutputAborted(signal);
  if (!stat) return { present: false, valid: false, path: tempPath };
  if (!stat.isFile?.() || stat.isSymbolicLink?.()) return { present: true, valid: false, path: tempPath };
  if (Number(stat.size || 0) !== Number(transaction.png_bytes || 0)) {
    return { present: true, valid: false, path: tempPath };
  }
  try {
    await validatePngFile(tempPath, { ...outputPngValidationOptions(), signal });
    const version = await outputFileVersion(tempPath, { signal });
    return {
      present: true,
      valid: outputFileVersionHash(version) === transaction.png_sha256,
      path: tempPath,
    };
  } catch (error) {
    if (isOutputAbortError(error)) throw error;
    return { present: true, valid: false, path: tempPath };
  }
}

async function recoverDigestSaveTransactionMarker(base, markerPath, { signal = null, validateIndexed = true } = {}) {
  throwIfOutputAborted(signal);
  const transaction = await readDigestSaveTransactionMarker(base, markerPath, { signal });
  if (!transaction) {
    return {
      invalid: true,
      warning: {
        code: 'history_save_transaction_invalid',
        base: toProjectRelative(base),
        marker: toProjectRelative(markerPath),
        message: `检测到无法校验的长图保存事务 ${toProjectRelative(markerPath)}，已保留文件且停止自动恢复。`,
      },
    };
  }
  if (transaction.state === 'indexed' && !validateIndexed) return { transaction, completed: true };
  const markerStat = await fsp.stat(transaction.marker_path).catch(() => null);
  throwIfOutputAborted(signal);
  const transactionTemp = await inspectDigestSaveTransactionTemp(base, transaction, { signal });
  let pngReadable = await assertReadableOutputFile(base, transaction.file_path, { extensions: ['.png'], signal }).catch(error => {
    if (isOutputAbortError(error)) throw error;
    return '';
  });
  const digestReadable = await assertReadableOutputFile(base, transaction.digest_path, { extensions: ['.digest.json'], signal }).catch(error => {
    if (isOutputAbortError(error)) throw error;
    return '';
  });
  let pngWasRecovered = false;
  if (!pngReadable && transaction.state === 'prepared' && transactionTemp.valid) {
    await assertSafeOutputParent(base, transaction.file_path);
    await linkTempFileToUniqueTarget(transactionTemp.path, transaction.file_path);
    pngReadable = await assertReadableOutputFile(base, transaction.file_path, { extensions: ['.png'], signal }).catch(error => {
      if (isOutputAbortError(error)) throw error;
      return '';
    });
    pngWasRecovered = !!pngReadable;
  }
  if (!pngReadable) {
    if (transaction.state === 'prepared' && transactionTemp.present && !transactionTemp.valid) {
      return {
        transaction,
        warning: {
          code: 'history_save_transaction_temp_invalid',
          base: toProjectRelative(base),
          marker: toProjectRelative(transaction.marker_path),
          message: `长图保存事务 ${toProjectRelative(transaction.marker_path)} 的临时 PNG 无法通过完整性校验，已保留文件且停止自动恢复。`,
        },
      };
    }
    const markerAge = Date.now() - Number(markerStat?.mtimeMs || 0);
    if (!digestReadable
      && transaction.state === 'prepared'
      && Number.isFinite(markerAge)
      && markerAge >= OUTPUT_ATOMIC_TEMP_MAX_AGE_MS) {
      await fsp.rm(transaction.marker_path, { force: true });
      return { transaction, removed_stale: true };
    }
    return {
      transaction,
      pending: !digestReadable,
      warning: digestReadable ? {
        code: 'history_save_transaction_png_missing',
        base: toProjectRelative(base),
        marker: toProjectRelative(transaction.marker_path),
        message: `长图保存事务 ${toProjectRelative(transaction.marker_path)} 的 PNG 已不存在，已保留摘要和事务证据且停止自动恢复。`,
      } : null,
    };
  }
  let pngStat = null;
  let pngVersion = '';
  try {
    await validatePngFile(pngReadable, { ...outputPngValidationOptions(), signal });
    pngStat = await fsp.stat(pngReadable);
    pngVersion = await outputFileVersion(pngReadable, { signal });
  } catch (error) {
    if (isOutputAbortError(error)) throw error;
    return {
      transaction,
      warning: {
        code: 'history_save_transaction_png_invalid',
        base: toProjectRelative(base),
        marker: toProjectRelative(transaction.marker_path),
        message: `长图保存事务 ${toProjectRelative(transaction.marker_path)} 的 PNG 无法通过完整性校验，已保留文件且停止自动恢复。`,
      },
    };
  }
  if (Number(pngStat?.size || 0) !== transaction.png_bytes
    || outputFileVersionHash(pngVersion) !== transaction.png_sha256) {
    return {
      transaction,
      warning: {
        code: 'history_save_transaction_png_changed',
        base: toProjectRelative(base),
        marker: toProjectRelative(transaction.marker_path),
        message: `长图保存事务 ${toProjectRelative(transaction.marker_path)} 的 PNG 内容已变化，已保留文件且拒绝覆盖。`,
      },
    };
  }
  if (transactionTemp.valid) {
    await fsp.rm(transactionTemp.path, { force: true }).catch(() => {});
  }
  let digestWasRecovered = false;
  if (!digestReadable) {
    if (transaction.state !== 'prepared') {
      return {
        transaction,
        warning: {
          code: 'history_save_transaction_digest_missing',
          base: toProjectRelative(base),
          marker: toProjectRelative(transaction.marker_path),
          message: `长图保存事务 ${toProjectRelative(transaction.marker_path)} 已完成，但摘要 JSON 后续被删除；已保留降级状态且不会自动重建。`,
        },
      };
    }
    try {
      await writeDigestJsonExclusive(transaction.digest_path, transaction.digest, { signal });
      digestWasRecovered = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const currentDigest = await readJson(transaction.digest_path, null, {
    strict: false,
    maxBytes: HISTORY_DIGEST_JSON_MAX_BYTES,
    signal,
  });
  throwIfOutputAborted(signal);
  if (!currentDigest || !persistedDigestsEqual(currentDigest, transaction.digest)) {
    return {
      transaction,
      warning: {
        code: 'history_save_transaction_digest_changed',
        base: toProjectRelative(base),
        marker: toProjectRelative(transaction.marker_path),
        message: `长图保存事务 ${toProjectRelative(transaction.marker_path)} 的摘要 JSON 已变化，已保留文件且拒绝覆盖。`,
      },
    };
  }
  const digestVersion = await outputFileVersion(transaction.digest_path, { signal });
  const needsCommit = transaction.state === 'prepared'
    || !outputFileVersionMatches(transaction.saved_file_version, pngVersion)
    || !outputFileVersionMatches(transaction.saved_digest_file_version, digestVersion);
  let committed = transaction;
  if (needsCommit) {
    committed = digestSaveTransactionPayload(base, {
      ...transaction,
      operationId: transaction.operation_id,
      filePath: transaction.file_path,
      digestPath: transaction.digest_path,
      tempPath: transaction.temp_path,
      pngBytes: transaction.png_bytes,
      pngSha256: transaction.png_sha256,
      state: 'committed',
      preparedAt: transaction.prepared_at,
      committedAt: transaction.committed_at || new Date().toISOString(),
      savedFileVersion: pngVersion,
      savedDigestFileVersion: digestVersion,
    });
    await writeBinaryAtomic(transaction.marker_path, digestSaveTransactionMarkerBuffer(committed), { signal });
    committed = { ...committed, marker_path: transaction.marker_path, file_path: transaction.file_path, digest_path: transaction.digest_path };
  }
  return {
    transaction: committed,
    valid_pair: true,
    recovered_png: pngWasRecovered,
    recovered_digest: digestWasRecovered,
    recovered_commit: needsCommit,
    needs_index: committed.state !== 'indexed',
  };
}

async function collectDigestSaveTransactionFiles(dir, out, root = dir, { signal = null, excludeRoots = [] } = {}) {
  return collectHistorySourceFiles(dir, out, root, /\.digest\.json\.save\.json$/i, { signal, excludeRoots, cleanupAtomicTemps: false });
}

async function recoverPreparedDigestSaveTransactions(base, { signal = null, excludeRoots = [] } = {}) {
  throwIfOutputAborted(signal);
  const markers = [];
  await collectDigestSaveTransactionFiles(base, markers, base, { signal, excludeRoots });
  const result = { scanned: markers.length, recovered: 0, removed_stale: 0, completed: 0, needs_index: [], warnings: [] };
  for (const markerPath of markers) {
    throwIfOutputAborted(signal);
    if (activeDigestSaveTransactionMarkers.has(historyPathDedupeKey(markerPath))) continue;
    const recovery = await recoverDigestSaveTransactionMarker(base, markerPath, { signal, validateIndexed: false });
    if (recovery.recovered_png || recovery.recovered_digest || recovery.recovered_commit || recovery.needs_index) result.recovered += 1;
    if (recovery.removed_stale) result.removed_stale += 1;
    if (recovery.completed) result.completed += 1;
    if (recovery.needs_index && recovery.transaction) result.needs_index.push(recovery.transaction);
    if (recovery.warning) result.warnings.push(recovery.warning);
  }
  await collectHistorySourceFiles(base, [], base, /$^/, { signal, excludeRoots, cleanupAtomicTemps: true });
  return result;
}

function emptyDigestSaveTransactionRecovery() {
  return { scanned: 0, recovered: 0, removed_stale: 0, completed: 0, needs_index: [], warnings: [] };
}

function historySaveRecoveryBaseKey(base = '') {
  return platformPathIdentity(path.resolve(String(base || '')));
}

function invalidateHistorySaveRecovery(base = '') {
  const key = historySaveRecoveryBaseKey(base);
  if (key) historySaveRecoveryCompletedBases.delete(key);
}

function historySaveRecoveryAlreadyCompleted(key = '') {
  if (!key || !historySaveRecoveryCompletedBases.has(key)) return false;
  historySaveRecoveryCompletedBases.delete(key);
  historySaveRecoveryCompletedBases.add(key);
  return true;
}

function rememberHistorySaveRecoveryCompleted(key = '') {
  if (!key) return false;
  historySaveRecoveryCompletedBases.delete(key);
  historySaveRecoveryCompletedBases.add(key);
  while (historySaveRecoveryCompletedBases.size > HISTORY_SAVE_RECOVERY_COMPLETED_BASE_LIMIT) {
    const oldest = historySaveRecoveryCompletedBases.values().next().value;
    if (!oldest) break;
    historySaveRecoveryCompletedBases.delete(oldest);
  }
  return true;
}

async function recoverPreparedDigestSaveTransactionsOnce(base, {
  signal = null,
  excludeRoots = [],
  force = false,
} = {}) {
  const key = historySaveRecoveryBaseKey(base);
  if (!key) return emptyDigestSaveTransactionRecovery();
  if (!force && historySaveRecoveryAlreadyCompleted(key)) return emptyDigestSaveTransactionRecovery();
  if (historySaveRecoveryInFlight.has(key)) {
    return waitForCombinedHistoryState(historySaveRecoveryInFlight.get(key), signal);
  }
  const task = recoverPreparedDigestSaveTransactions(base, {
    signal: null,
    excludeRoots,
  }).then(result => {
    rememberHistorySaveRecoveryCompleted(key);
    return result;
  });
  historySaveRecoveryInFlight.set(key, task);
  try {
    return await waitForCombinedHistoryState(task, signal);
  } finally {
    if (historySaveRecoveryInFlight.get(key) === task) historySaveRecoveryInFlight.delete(key);
  }
}

async function markDigestSaveTransactionsIndexed(base, transactions = [], items = [], { signal = null } = {}) {
  const indexedDigestPaths = new Set((Array.isArray(items) ? items : [])
    .map(item => resolveDigestPath(base, item))
    .filter(Boolean)
    .map(historyPathDedupeKey));
  for (const candidate of Array.isArray(transactions) ? transactions : []) {
    throwIfOutputAborted(signal);
    if (!indexedDigestPaths.has(historyPathDedupeKey(candidate.digest_path))) continue;
    const current = await readDigestSaveTransactionMarker(base, candidate.marker_path, { signal });
    if (!current || current.state === 'indexed') continue;
    const indexed = digestSaveTransactionPayload(base, {
      ...current,
      operationId: current.operation_id,
      filePath: current.file_path,
      digestPath: current.digest_path,
      tempPath: current.temp_path,
      pngBytes: current.png_bytes,
      pngSha256: current.png_sha256,
      state: 'indexed',
      preparedAt: current.prepared_at,
      committedAt: current.committed_at,
      indexedAt: new Date().toISOString(),
      savedFileVersion: current.saved_file_version,
      savedDigestFileVersion: current.saved_digest_file_version,
    });
    await writeBinaryAtomic(current.marker_path, digestSaveTransactionMarkerBuffer(indexed), { signal });
  }
}

async function legacyPngOnlyHistoryItem(base, pngPath, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const resolved = path.resolve(pngPath || '');
  if (!resolved || !isInside(base, resolved) || isInside(OUTPUTS_TMP_DIR, resolved)) return null;
  if (path.basename(path.dirname(resolved)).toLowerCase() === 'previews') return null;
  if (!looksLikeLegacyDigestPngName(path.basename(resolved))) return null;
  const inspection = await inspectOutputPngFile(resolved, { signal, validate_inflated: false }).catch(e => {
    if (isOutputAbortError(e)) throw e;
    return null;
  });
  throwIfOutputAborted(signal);
  if (!inspection?.stat?.isFile?.()) return null;
  const stat = inspection.stat;
  const name = path.basename(resolved, path.extname(resolved));
  const digestId = `legacy_png_${crypto.createHash('sha256').update(historyPathDedupeKey(resolved)).digest('hex').slice(0, 24)}`;
  const createdAt = stat.mtime?.toISOString?.() || new Date().toISOString();
  const title = cleanHistorySearchText(name, HISTORY_SEARCH_HEADLINE_MAX_CHARS) || '旧版仅长图';
  return {
    digest_id: digestId,
    group: title,
    since: '',
    until: '',
    file_path: resolved,
    relative_path: toProjectRelative(resolved),
    model: '',
    message_count: 0,
    headline: '旧版仅长图',
    search_text: cleanHistorySearchText(`${title} 旧版仅长图 ${toProjectRelative(resolved)}`, HISTORY_SEARCH_TEXT_MAX_CHARS),
    created_at: createdAt,
    mtime_ms: Number(stat.mtimeMs || 0) || 0,
  };
}

function trustedPngBufferFromValidatedHash(pngBuffer = null, validatedPngSha256 = '') {
  if (!(Buffer.isBuffer(pngBuffer) || pngBuffer instanceof Uint8Array)) return false;
  const expected = String(validatedPngSha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) return false;
  const actual = crypto.createHash('sha256').update(pngBuffer).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

async function runOutputCommitBarrier(commitBarrier, commit) {
  if (typeof commit !== 'function') throw new TypeError('output commit callback is required');
  if (typeof commitBarrier !== 'function') return commit();
  let invoked = false;
  let commitPromise = null;
  const guardedCommit = () => {
    if (!invoked) {
      invoked = true;
      commitPromise = Promise.resolve().then(commit);
    }
    return commitPromise;
  };
  try {
    await commitBarrier(guardedCommit);
    return invoked ? await commitPromise : await commit();
  } catch (error) {
    if (error && typeof error === 'object') error.output_commit_barrier_rejected = true;
    throw error;
  }
}

export async function saveRenderedPng({ settings, digest, png_file = '', png_buffer = null, validated_png_sha256 = '', save_operation_id = '', signal = null, shouldAbort = null, commitBarrier = null, postArtifactCommitBarrier = null, on_commit_phase = null, prepareCommitEvidence = null, finalizeCommitEvidence = null }) {
  throwIfOutputAborted(signal, shouldAbort);
  const assertCommitAllowed = async () => {
    throwIfOutputAborted(signal, shouldAbort);
    if (typeof commitBarrier === 'function') await commitBarrier();
    throwIfOutputAborted(signal, shouldAbort);
  };
  const effectivePostArtifactCommitBarrier = typeof postArtifactCommitBarrier === 'function'
    ? postArtifactCommitBarrier
    : commitBarrier;
  const assertPostArtifactCommitAllowed = async () => {
    throwIfOutputAborted(signal, shouldAbort);
    if (typeof effectivePostArtifactCommitBarrier === 'function') await effectivePostArtifactCommitBarrier();
    throwIfOutputAborted(signal, shouldAbort);
  };
  const base = await safeOutputBase(settings);
  assertDigestHasMessages(digest);
  serializePersistedDigest(digest);
  const bufferedPng = Buffer.isBuffer(png_buffer) || png_buffer instanceof Uint8Array
    ? Buffer.from(png_buffer)
    : null;
  const buffer = bufferedPng;
  if (bufferedPng && !trustedPngBufferFromValidatedHash(bufferedPng, validated_png_sha256)) {
    validatePngBuffer(bufferedPng, outputPngValidationOptions());
  } else if (!bufferedPng) {
    await validatePngFile(png_file, { ...outputPngValidationOptions(), signal });
  }
  await assertCommitAllowed();

  const createdAtMs = safeHistorySortTimeMs(digest.created_at);
  const createdAt = createdAtMs > 0 ? new Date(createdAtMs) : new Date();
  const day = localDate(createdAt);
  const dir = path.join(base, day);
  let filePath = '';
  let digestPath = '';
  let transactionMarkerPath = '';
  let transactionPairOwned = false;
  try {
    await assertSafeOutputParent(base, path.join(dir, 'placeholder.png'));
    await assertCommitAllowed();
    const pair = await runOutputCommitBarrier(commitBarrier, () => writeTransactionalDigestPair({
      base,
      dir,
      filename: buildFilename(digest, settings.output?.filename_pattern),
      digest,
      pngBuffer: buffer,
      pngFile: png_file,
      operationId: save_operation_id,
      signal,
      shouldAbort,
      phaseHook: on_commit_phase,
    }));
    filePath = pair.file_path;
    digestPath = pair.digest_path;
    transactionMarkerPath = pair.marker_path;
    transactionPairOwned = pair.reused !== true;
    await assertPostArtifactCommitAllowed();
  } catch (e) {
    try {
      if (transactionPairOwned) await cleanupRenderedPair(filePath, digestPath, transactionMarkerPath);
    } catch (cleanupError) {
      const err = new Error('长图保存未完成，且部分未提交输出文件无法清理。请检查输出目录后重试。');
      err.status = 500;
      err.code = 'output_save_cleanup_failed';
      err.public_code = 'output_save_cleanup_failed';
      err.original_error = e?.message || String(e || 'save failed');
      err.cleanup_error = cleanupError?.message || String(cleanupError || 'cleanup failed');
      err.cleanup_failed_count = Number(cleanupError?.cleanup_failed_count || 0) || 0;
      invalidateHistorySaveRecovery(base);
      throw err;
    }
    throw e;
  }
  let committedFileVersion = '';
  let committedDigestFileVersion = '';
  let versionError = null;
  try {
    committedFileVersion = await outputFileVersionAfterCommit(filePath);
    committedDigestFileVersion = await outputFileVersionAfterCommit(digestPath);
  } catch (e) {
    versionError = e;
  }
  const sourceSnapshot = cleanSourceSnapshot(digest.source_snapshot);
  const sourceDigestId = String(digest.source_digest_id || '').trim().slice(0, 320);
  const sourceHistoryItemKey = cleanHistoryItemKey(digest.source_history_item_key);
  const sourceExpectedFileVersion = String(digest.source_expected_file_version || '').trim().slice(0, 320);
  const sourceExpectedDigestFileVersion = String(digest.source_expected_digest_file_version || '').trim().slice(0, 320);
  const sourceDigestRevision = cleanHistoryDigestRevision(digest.source_digest_revision);
  const historyRestoreSource = sourceDigestId || sourceHistoryItemKey || sourceExpectedFileVersion || sourceExpectedDigestFileVersion || sourceDigestRevision
    ? {
      source_digest_id: sourceDigestId,
      source_history_item_key: sourceHistoryItemKey,
      source_expected_file_version: sourceExpectedFileVersion,
      source_expected_digest_file_version: sourceExpectedDigestFileVersion,
      source_digest_revision: sourceDigestRevision,
    }
    : null;

  const item = {
    digest_id: digest.digest_id,
    account_id: digest.account_id || '',
    account_identity_id: digest.account_identity_id || '',
    account_label: digest.account_label || '',
    group_id: sourceSnapshot?.group_id || digest.group_id || '',
    group: digest.group,
    since: digest.since,
    until: digest.until,
    file_path: filePath,
    relative_path: toProjectRelative(filePath),
    output_dir_identity: outputDirIdentityForBase(base),
    digest_path: digestPath,
    digest_relative_path: toProjectRelative(digestPath),
    model: digest.model,
    message_count: digest.message_count,
    ...(digestRendererVersion(digest) ? { renderer_version: digestRendererVersion(digest) } : {}),
    ...(digestRendererEngine(digest) ? { renderer_engine: digestRendererEngine(digest) } : {}),
    headline: digestHeadlineForHistory(digest),
    search_text: digestSearchTextForHistory(digest),
    source_snapshot: sourceSnapshot,
    ...(historyRestoreSource ? historyRestoreSource : {}),
    created_at: digest.created_at || new Date().toISOString(),
    ...(digest.restored_at ? { restored_at: String(digest.restored_at) } : {}),
    saved_file_version: committedFileVersion,
    saved_digest_file_version: committedDigestFileVersion,
  };
  if (versionError) {
    invalidateHistorySaveRecovery(base);
    item.history_current = false;
    item.history_commit_failed = true;
    item.local_action_after_commit_reason = 'history_failed_after_commit';
    item.local_action_after_commit_error = versionError?.message || String(versionError || '无法生成文件校验版本，历史索引未写入');
  } else {
    let indexCommitted = false;
    item.history_item_key = historyItemKeyForItem(base, item);
    try {
      await upsertHistory(settings, item, { signal, shouldAbort, commitBarrier: effectivePostArtifactCommitBarrier });
      indexCommitted = true;
      item.history_current = true;
      item.history_commit_failed = false;
    } catch (e) {
      if (historyIndexWriteMayHaveCommitted(e)) {
        invalidateHistorySaveRecovery(base);
        throw e;
      }
      if (isOutputAbortError(e) || e?.output_commit_barrier_rejected === true) {
        try {
          if (transactionPairOwned) await cleanupRenderedPair(filePath, digestPath, transactionMarkerPath);
        } catch (cleanupError) {
          const err = new Error('账号或设置变化后已停止保存，但刚写入的旧摘要文件无法完整清理。请保留输出目录并查看日志后重试。');
          err.status = 500;
          err.code = 'output_save_cleanup_failed';
          err.public_code = 'output_save_cleanup_failed';
          err.original_error = e?.message || String(e || 'commit barrier rejected');
          err.cleanup_error = cleanupError?.message || String(cleanupError || 'cleanup failed');
          err.cleanup_failed_count = Number(cleanupError?.cleanup_failed_count || 0) || 0;
          invalidateHistorySaveRecovery(base);
          throw err;
        }
        throw e;
      }
      invalidateHistorySaveRecovery(base);
      item.history_current = false;
      item.history_commit_failed = true;
      item.local_action_after_commit_reason = e?.code === 'stale_settings'
        ? 'stale_settings_after_commit'
        : (isOutputAbortError(e)
          ? 'cancelled_after_commit'
          : 'history_failed_after_commit');
      item.local_action_after_commit_error = e?.message || String(e || '历史索引写入失败');
    }
    if (indexCommitted) {
      try {
        if (typeof prepareCommitEvidence === 'function') await prepareCommitEvidence(item);
        if (typeof finalizeCommitEvidence === 'function') await finalizeCommitEvidence(item);
      } catch (e) {
        item.local_action_after_commit_reason = isOutputAbortError(e)
          ? 'cancelled_after_commit'
          : 'commit_evidence_persist_failed';
        item.local_action_after_commit_error = e?.message || String(e || '历史已写入，但本地操作确认记录保存失败');
      }
      await runOutputSavePhaseHook(on_commit_phase, 'after_index_commit', {
        file_path: filePath,
        digest_path: digestPath,
        marker_path: transactionMarkerPath,
      });
      const markerIndexed = await markDigestSaveTransactionsIndexed(base, [{
        marker_path: transactionMarkerPath,
        file_path: filePath,
        digest_path: digestPath,
      }], [item], { signal }).then(() => true, () => false);
      if (!markerIndexed) invalidateHistorySaveRecovery(base);
    }
  }
  return {
    ...item,
    history_item_key: historyItemKeyForItem(base, item),
    history_current: item.history_current !== false,
    history_output_relative_path: '',
    file_exists: true,
    file_version: committedFileVersion,
    digest_exists: true,
    digest_invalid: false,
    digest_status: 'ok',
    digest_file_version: committedDigestFileVersion,
  };
}

function historyRestoreToCurrentOutputError(message, code = 'history_restore_source_invalid', status = 409) {
  const err = new Error(message || '这条历史不能恢复到当前输出目录。');
  err.status = status;
  err.code = code;
  err.public_code = code;
  return err;
}

function restoredDigestId({ sourceHistoryItemKey = '', sourceDigestId = '', saveOperationId = '' } = {}) {
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    source_history_item_key: String(sourceHistoryItemKey || '').trim(),
    source_digest_id: String(sourceDigestId || '').trim(),
    save_operation_id: String(saveOperationId || '').trim(),
  })).digest('hex');
  return `history_restore_${hash.slice(0, 32)}`;
}

// Old output roots are read-only provenance. A recovery always creates a new
// artifact in the currently configured output root, never a version beside the old file.
export async function restoreHistoryDigestToCurrentOutput({ settings, item, digest, source_digest_revision = '', png_buffer = null, validated_png_sha256 = '', save_operation_id = '', signal = null, shouldAbort = null, commitBarrier = null, on_commit_phase = null, prepareCommitEvidence = null, finalizeCommitEvidence = null }) {
  throwIfOutputAborted(signal, shouldAbort);
  const sourceItem = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
  const sourceDigest = digest && typeof digest === 'object' && !Array.isArray(digest) ? digest : null;
  if (!sourceItem || !sourceDigest) {
    throw historyRestoreToCurrentOutputError('缺少可恢复的旧历史摘要。');
  }
  const operationId = String(save_operation_id || '').trim();
  if (!operationId) {
    throw historyRestoreToCurrentOutputError('恢复请求缺少稳定操作标识，已停止写入，避免重复生成历史文件。', 'history_restore_operation_required', 428);
  }
  const currentBase = await safeOutputBase(settings);
  const sourceBase = historyBaseForItem(currentBase, sourceItem);
  if (historyOutputBaseMatches(currentBase, sourceBase)) {
    throw historyRestoreToCurrentOutputError('当前输出目录中的历史应使用原地重渲染，不能走旧目录恢复流程。', 'history_restore_source_current');
  }
  await assertHistoryItemOwnedByBase(sourceBase, sourceItem, { signal });
  const sourceHistoryItemKey = historyItemKeyForItem(sourceBase, sourceItem);
  const sourceDigestId = String(sourceDigest.digest_id || sourceItem.digest_id || '').trim();
  if (!sourceHistoryItemKey || !sourceDigestId) {
    throw historyRestoreToCurrentOutputError('旧历史缺少可追溯的摘要标识，已停止恢复。');
  }
  const sourceDigestPath = resolveDigestPath(sourceBase, sourceItem);
  const sourceDigestVersion = String(sourceItem.digest_file_version || sourceItem.saved_digest_file_version || '').trim();
  if (!sourceDigestPath || !sourceDigestVersion) throw historyDigestFileVersionRequiredError();
  const sourceDigestRevision = String(source_digest_revision || '').trim() || digestSemanticRevision(sourceDigest);
  const assertRestoreSourceCurrent = async () => {
    await assertHistoryRerenderDigestMatchesSource(sourceBase, sourceDigestPath, sourceItem, sourceDigest, sourceDigestVersion, { signal, shouldAbort, expectedSourceDigestRevision: sourceDigestRevision });
    if (typeof commitBarrier === 'function') await commitBarrier();
  };
  await assertRestoreSourceCurrent();
  assertDigestHasMessages(sourceDigest);
  const restoredAt = new Date().toISOString();
  const restoredDigest = {
    ...sourceDigest,
    digest_id: restoredDigestId({ sourceHistoryItemKey, sourceDigestId, saveOperationId: operationId }),
    created_at: String(sourceDigest.created_at || sourceItem.created_at || restoredAt),
    restored_at: restoredAt,
    source_digest_id: sourceDigestId,
    source_history_item_key: sourceHistoryItemKey,
    source_expected_file_version: String(sourceItem.rerender_file_version || sourceItem.file_version || '').trim(),
    source_expected_digest_file_version: sourceDigestVersion,
    source_digest_revision: sourceDigestRevision,
  };
  const restored = await saveRenderedPng({
    settings,
    digest: restoredDigest,
    png_buffer,
    validated_png_sha256,
    save_operation_id: operationId,
    signal,
    shouldAbort,
    commitBarrier: assertRestoreSourceCurrent,
    on_commit_phase,
    prepareCommitEvidence,
    finalizeCommitEvidence,
  });
  return {
    ...restored,
    restored_from_old_output: true,
  };
}

export async function copyHistoryDigestPngToCurrentOutput({ settings, item, digest, source_digest_revision = '', save_operation_id = '', signal = null, shouldAbort = null, commitBarrier = null, on_commit_phase = null, prepareCommitEvidence = null, finalizeCommitEvidence = null }) {
  throwIfOutputAborted(signal, shouldAbort);
  const sourceItem = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
  const sourceDigest = digest && typeof digest === 'object' && !Array.isArray(digest) ? digest : null;
  if (!sourceItem || !sourceDigest) {
    throw historyRestoreToCurrentOutputError('缺少可复制的旧历史摘要。', 'history_copy_source_invalid');
  }
  if (historyItemLooksMarkdownOutput(sourceItem)) {
    throw historyRestoreToCurrentOutputError('这条历史是导出的 MD，不能复制为当前目录 PNG。', 'history_item_type_unsupported');
  }
  const operationId = String(save_operation_id || '').trim();
  if (!operationId) {
    throw historyRestoreToCurrentOutputError('复制请求缺少稳定操作标识，已停止写入，避免重复生成历史文件。', 'history_copy_operation_required', 428);
  }
  const currentBase = await safeOutputBase(settings);
  const sourceBase = historyBaseForItem(currentBase, sourceItem);
  if (historyOutputBaseMatches(currentBase, sourceBase)) {
    throw historyRestoreToCurrentOutputError('这条历史已经属于当前输出目录，不需要复制。', 'history_copy_source_current');
  }
  await assertHistoryItemOwnedByBase(sourceBase, sourceItem, { signal });
  const sourceHistoryItemKey = historyItemKeyForItem(sourceBase, sourceItem);
  const sourceDigestId = String(sourceDigest.digest_id || sourceItem.digest_id || '').trim();
  if (!sourceHistoryItemKey || !sourceDigestId) {
    throw historyRestoreToCurrentOutputError('旧历史缺少可追溯的摘要标识，已停止复制。', 'history_copy_source_invalid');
  }
  const sourceFileVersion = String(sourceItem.file_version || sourceItem.saved_file_version || sourceItem.rerender_file_version || '').trim();
  if (!sourceFileVersion) throw historyFileVersionRequiredError();
  const sourceDigestVersion = String(sourceItem.digest_file_version || sourceItem.saved_digest_file_version || '').trim();
  if (!sourceDigestVersion) throw historyDigestFileVersionRequiredError();
  const sourceTarget = resolveHistoryFilePath(sourceBase, sourceItem) || sourceItem.file_path || sourceItem.relative_path || '';
  const sourceFile = await assertReadableOutputFile(sourceBase, sourceTarget, {
    extensions: ['.png'],
    signal,
    shouldAbort,
  });
  const sourceDigestPath = resolveDigestPath(sourceBase, sourceItem);
  if (!sourceDigestPath) throw historyDigestFileVersionRequiredError();
  const sourceDigestRevision = String(source_digest_revision || '').trim() || digestSemanticRevision(sourceDigest);
  const assertCopySourceCurrent = async () => {
    await assertExpectedOutputFileVersion(sourceFile, sourceFileVersion, { signal, shouldAbort, artifact: 'png' });
    await assertHistoryRerenderDigestMatchesSource(sourceBase, sourceDigestPath, sourceItem, sourceDigest, sourceDigestVersion, { signal, shouldAbort, expectedSourceDigestRevision: sourceDigestRevision });
    if (typeof commitBarrier === 'function') await commitBarrier();
  };
  await assertCopySourceCurrent();
  const { data: pngBuffer, file_version: confirmedFileVersion } = await readOutputFileBuffer(sourceFile, {
    signal,
    shouldAbort,
    expected_file_version: sourceFileVersion,
    version_artifact: 'png',
    max_bytes: RENDERED_PNG_MAX_BYTES,
    validate_png: true,
    missingMessage: '旧输出目录中的 PNG 已不存在，不能复制到当前目录。',
    missingCode: 'png_missing',
  });
  const pngSha256 = crypto.createHash('sha256').update(pngBuffer).digest('hex');
  await assertCopySourceCurrent();
  assertDigestHasMessages(sourceDigest);
  const copiedAt = new Date().toISOString();
  const copiedDigest = {
    ...sourceDigest,
    digest_id: restoredDigestId({ sourceHistoryItemKey, sourceDigestId, saveOperationId: operationId }),
    created_at: String(sourceDigest.created_at || sourceItem.created_at || copiedAt),
    restored_at: copiedAt,
    source_digest_id: sourceDigestId,
    source_history_item_key: sourceHistoryItemKey,
    source_expected_file_version: confirmedFileVersion || sourceFileVersion,
    source_expected_digest_file_version: sourceDigestVersion,
    source_digest_revision: sourceDigestRevision,
  };
  const copied = await saveRenderedPng({
    settings,
    digest: copiedDigest,
    png_buffer: pngBuffer,
    validated_png_sha256: pngSha256,
    save_operation_id: operationId,
    signal,
    shouldAbort,
    commitBarrier: assertCopySourceCurrent,
    on_commit_phase,
    prepareCommitEvidence,
    finalizeCommitEvidence,
  });
  return {
    ...copied,
    copied_from_old_output: true,
  };
}

export async function ensureHistoryArtifactIndexed(settings, item = {}, { signal = null, shouldAbort = null, base: recoveryBase = null } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  const base = recoveryBase ? await safeExistingOutputBase(recoveryBase) : await safeOutputBase(settings);
  const normalized = {
    ...item,
    saved_file_version: item.saved_file_version || item.file_version || '',
    saved_digest_file_version: item.saved_digest_file_version || item.digest_file_version || '',
  };
  const filePath = resolveHistoryFilePath(base, normalized, '.png');
  const digestPath = resolveDigestPath(base, normalized);
  if (!filePath || !digestPath) {
    throw historyArtifactUnindexedError('调度摘要文件缺少可恢复的 PNG 或摘要 JSON 路径，本次不会推进游标。');
  }
  await assertReadableOutputFile(base, filePath, { extensions: ['.png'], signal, shouldAbort });
  await assertReadableOutputFile(base, digestPath, { extensions: ['.digest.json'], signal, shouldAbort });
  if (normalized.saved_file_version) {
    await assertExpectedOutputFileVersion(filePath, normalized.saved_file_version, { signal, shouldAbort });
  }
  if (normalized.saved_digest_file_version) {
    await assertExpectedOutputFileVersion(digestPath, normalized.saved_digest_file_version, { signal, shouldAbort });
  }
  const expectedArtifactKey = await historyIndexMergeArtifactKey(settings, base, normalized, { signal });
  if (!expectedArtifactKey) {
    throw historyArtifactUnindexedError('调度摘要文件无法生成稳定历史索引键，本次不会推进游标。');
  }
  const list = await readHistoryIndexFromBase(settings, base, { signal });
  throwIfOutputAborted(signal, shouldAbort);
  for (const existing of Array.isArray(list) ? list : []) {
    throwIfOutputAborted(signal, shouldAbort);
    if (String(existing?.digest_id || '').trim() !== String(normalized.digest_id || '').trim()) continue;
    const artifactKey = await historyIndexMergeArtifactKey(settings, base, existing, { signal });
    if (artifactKey === expectedArtifactKey) return resolveHistoryItemPaths(base, existing, settings);
  }
  await upsertHistory(settings, normalized, { signal, shouldAbort, base });
  const repaired = await readHistoryIndexFromBase(settings, base, { signal });
  throwIfOutputAborted(signal, shouldAbort);
  for (const existing of Array.isArray(repaired) ? repaired : []) {
    throwIfOutputAborted(signal, shouldAbort);
    if (String(existing?.digest_id || '').trim() !== String(normalized.digest_id || '').trim()) continue;
    const artifactKey = await historyIndexMergeArtifactKey(settings, base, existing, { signal });
    if (artifactKey === expectedArtifactKey) return resolveHistoryItemPaths(base, existing, settings);
  }
  throw historyArtifactUnindexedError('调度摘要文件仍在，但历史索引补提交失败；本次不会推进游标。');
}

export async function recoverHistoryArtifactByDigestId(settings, digestId, { signal = null, base: recoveryBase = null } = {}) {
  const id = String(digestId || '').trim();
  if (!id) return null;
  return withHistoryWriteLock(async () => {
    throwIfOutputAborted(signal);
    const base = recoveryBase ? await safeExistingOutputBase(recoveryBase) : await safeOutputBase(settings);
    const list = await readHistoryIndexFromBase(settings, base, {
      mergeArtifacts: true,
      signal,
    });
    throwIfOutputAborted(signal);
    const matches = (Array.isArray(list) ? list : []).filter(item => String(item?.digest_id || '').trim() === id);
    if (!matches.length) return null;
    const lineageIds = new Set(matches
      .map(item => historyRerenderRecordIdForItem(base, item))
      .filter(Boolean));
    if (matches.length > 1 && lineageIds.size !== 1) {
      throw historyArtifactUnindexedError('同一调度摘要编号对应多个历史文件，已停止自动补提交，避免推进错误游标。');
    }
    const preferred = matches.reduce((current, candidate) => (
      !current || historyRerenderRecordItemIsNewer(candidate, current) ? candidate : current
    ), null);
    const item = resolveHistoryItemPaths(base, preferred || matches[0], settings);
    const filePath = resolveHistoryFilePath(base, item, '.png');
    const digestPath = resolveDigestPath(base, item);
    if (!filePath || !digestPath) return null;
    await assertReadableOutputFile(base, filePath, { extensions: ['.png'], signal });
    await assertReadableOutputFile(base, digestPath, { extensions: ['.digest.json'], signal });
    const [fileVersion, digestFileVersion] = await Promise.all([
      outputFileVersion(filePath, { signal }),
      outputFileVersion(digestPath, { signal }),
    ]);
    return {
      ...item,
      file_path: filePath,
      digest_path: digestPath,
      saved_file_version: fileVersion,
      saved_digest_file_version: digestFileVersion,
      file_version: fileVersion,
      digest_file_version: digestFileVersion,
      history_item_key: historyItemKeyForItem(base, item),
      history_current: true,
    };
  });
}

function historyArtifactUnindexedError(message) {
  const err = new Error(message || '历史索引补提交失败。');
  err.status = 500;
  err.code = 'history_artifact_unindexed';
  err.public_code = 'history_artifact_unindexed';
  return err;
}

export async function discardRenderedHistoryItem(settings, item) {
  const base = await safeOutputBase(settings);
  await assertHistoryItemOwnedByBase(base, item);
  const errors = [];
  const digestId = String(item?.digest_id || '');
  let canRemoveFiles = true;
  if (digestId) {
    await removeHistoryItem(settings, digestId, { item }).catch(e => {
      canRemoveFiles = false;
      errors.push(e);
    });
  }
  const filePath = item?.file_path ? path.resolve(item.file_path) : '';
  const digestPath = resolveDigestPath(base, item);
  const targets = [...new Set([
    filePath && path.extname(filePath).toLowerCase() === '.png' ? filePath : '',
    digestPath,
    digestSaveTransactionMarkerPath(digestPath),
    historyRerenderCommitMarkerPath(digestPath),
  ].filter(Boolean))].filter(target => isInside(base, target));
  if (canRemoveFiles) {
    for (const target of targets) {
      await removeOutputFileIfSafe(base, target).catch(e => errors.push(e));
    }
  }
  if (errors.length) {
    const err = new Error(`failed to discard rendered history item: ${errors.map(e => e?.message || String(e)).join('; ')}`);
    err.cause = errors[0];
    throw err;
  }
}

function clampHistoryPageNumber(value, fallback, { min = 0, max = 200 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function historySearchDateVariants(value = '') {
  const text = String(value || '').trim();
  if (!text) return [];
  const digits = text.replace(/\D/g, '');
  return [text, digits.slice(0, 8), digits].filter(Boolean);
}

function historySearchNormalize(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function digestHeadlineForHistory(digest = {}) {
  return cleanHistorySearchText(digest?.headline, HISTORY_SEARCH_HEADLINE_MAX_CHARS);
}

function cleanHistorySearchText(value, maxChars = HISTORY_SEARCH_TEXT_MAX_CHARS) {
  const text = String(value || '')
    .replace(/^data:(?:image|audio|video)\/[^\s]+/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, Math.max(0, Number(maxChars || 0) || 0));
}

function addHistorySearchValue(out, value, maxChars = HISTORY_SEARCH_TEXT_MAX_CHARS) {
  if (value === null || value === undefined || Buffer.isBuffer(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) addHistorySearchValue(out, item, maxChars);
    return;
  }
  if (typeof value === 'object') return;
  const text = cleanHistorySearchText(value, maxChars);
  if (text) out.push(text);
}

export function digestSearchTextForHistory(digest = {}, { maxChars = HISTORY_SEARCH_TEXT_MAX_CHARS } = {}) {
  const persisted = persistedDigest(digest);
  const values = [];
  addHistorySearchValue(values, persisted.headline, maxChars);
  addHistorySearchValue(values, persisted.highlights, maxChars);
  for (const topic of persisted.topics || []) {
    addHistorySearchValue(values, topic.title, maxChars);
    addHistorySearchValue(values, topic.category, maxChars);
    addHistorySearchValue(values, topic.participants, maxChars);
    addHistorySearchValue(values, topic.summary, maxChars);
  }
  for (const todo of persisted.todos || []) {
    addHistorySearchValue(values, todo.owner, maxChars);
    addHistorySearchValue(values, todo.item, maxChars);
    addHistorySearchValue(values, todo.deadline, maxChars);
  }
  for (const link of persisted.links || []) {
    addHistorySearchValue(values, link.title, maxChars);
    addHistorySearchValue(values, link.summary, maxChars);
    addHistorySearchValue(values, link.from, maxChars);
    addHistorySearchValue(values, link.url, maxChars);
  }
  for (const quote of persisted.quotes || []) {
    addHistorySearchValue(values, quote.speaker, maxChars);
    addHistorySearchValue(values, quote.text, maxChars);
    addHistorySearchValue(values, quote.context, maxChars);
  }
  return cleanHistorySearchText(values.join(' · '), maxChars);
}

function cleanPreviewHistoryMetadata(metadata = {}) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const groups = Array.isArray(source.groups)
    ? source.groups.map(item => cleanHistorySearchText(item, 120)).filter(Boolean).slice(0, PREVIEW_HISTORY_SOURCE_MAX_ITEMS)
    : [];
  const digestIds = Array.isArray(source.digest_ids)
    ? source.digest_ids
      .map(item => String(item || '').trim().slice(0, PREVIEW_HISTORY_SOURCE_ID_MAX_CHARS))
      .filter(Boolean)
      .slice(0, PREVIEW_HISTORY_SOURCE_MAX_ITEMS)
    : [];
  const messageCount = Math.max(0, Number(source.message_count || 0) || 0);
  return {
    account_id: cleanHistorySearchText(source.account_id, 160),
    account_label: cleanHistorySearchText(source.account_label, 160),
    group: cleanHistorySearchText(source.group || groups.join('_'), 240),
    groups,
    digest_ids: digestIds,
    since: cleanHistorySearchText(source.since, 64),
    until: cleanHistorySearchText(source.until, 64),
    model: cleanHistorySearchText(source.model, 120),
    message_count: messageCount,
    headline: cleanHistorySearchText(source.headline, HISTORY_SEARCH_HEADLINE_MAX_CHARS),
    search_text: cleanHistorySearchText(source.search_text, HISTORY_SEARCH_TEXT_MAX_CHARS),
    complete: source.complete === true,
    done: Math.max(0, Number(source.done || 0) || 0),
    total: Math.max(0, Number(source.total || 0) || 0),
    ...cleanPreviewHistorySourceReference(source),
    source_snapshot: cleanSourceSnapshot(source.source_snapshot),
  };
}

function cleanPreviewHistorySourceReference(source = {}) {
  const clean = value => String(value || '').trim().slice(0, 320);
  return {
    source_digest_id: clean(source.source_digest_id),
    source_history_item_key: clean(source.source_history_item_key),
    source_expected_file_version: clean(source.source_expected_file_version),
    source_expected_digest_file_version: clean(source.source_expected_digest_file_version),
    source_digest_revision: clean(source.source_digest_revision),
  };
}

export function bindPreviewMarkdownSourceMetadata(metadata = {}, verifiedSource = null) {
  const source = verifiedSource && typeof verifiedSource === 'object' && !Array.isArray(verifiedSource)
    ? verifiedSource
    : null;
  if (!source) return metadata;
  const item = source.item && typeof source.item === 'object' && !Array.isArray(source.item)
    ? source.item
    : {};
  const verified = cleanPreviewHistorySourceReference({
    source_digest_id: item.digest_id,
    source_history_item_key: item.history_item_key,
    source_expected_file_version: item.file_version,
    source_expected_digest_file_version: source.digest_file_version || item.digest_file_version,
    source_digest_revision: source.digest_revision,
  });
  if (!verified.source_digest_id || !verified.source_history_item_key || !verified.source_expected_digest_file_version) {
    throw Object.assign(new Error('已验证的源摘要缺少完整历史身份，已停止导出 MD。'), {
      status: 409,
      code: 'history_md_verified_source_incomplete',
      public_code: 'history_md_verified_source_incomplete',
    });
  }
  const submitted = cleanPreviewHistorySourceReference(metadata);
  const identityFields = [
    'source_digest_id',
    'source_history_item_key',
    'source_expected_digest_file_version',
    'source_digest_revision',
  ];
  for (const field of identityFields) {
    if (!submitted[field] || submitted[field] === verified[field]) continue;
    throw Object.assign(new Error('文本预览中的源摘要身份与已验证历史记录不一致，已停止导出 MD。'), {
      status: 409,
      code: 'history_md_source_metadata_mismatch',
      public_code: 'history_md_source_metadata_mismatch',
      field,
    });
  }
  return {
    ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
    ...verified,
  };
}

function markdownFirstHeading(text = '') {
  const lines = String(text || '').split('\n').slice(0, 80);
  for (const line of lines) {
    const match = line.match(/^#{1,3}\s+(.+)$/);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function previewMarkdownHeadlineForHistory({ title = '', markdown = '', metadata = {} } = {}) {
  return cleanHistorySearchText(
    metadata.headline || markdownFirstHeading(markdown) || title || '文本预览',
    HISTORY_SEARCH_HEADLINE_MAX_CHARS,
  );
}

function previewMarkdownSearchTextForHistory({ title = '', markdown = '', metadata = {} } = {}) {
  const previewText = String(markdown || '')
    .replace(/^data:(?:image|audio|video)\/[^\s]+/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, HISTORY_SEARCH_TEXT_MAX_CHARS);
  return cleanHistorySearchText([
    title,
    metadata.search_text,
    metadata.group,
    ...(metadata.groups || []),
    ...(metadata.digest_ids || []),
    metadata.headline,
    previewText,
  ].filter(Boolean).join(' · '), HISTORY_SEARCH_TEXT_MAX_CHARS);
}

function cleanPreviewMarkdownSaveOperationId(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{15,240}$/.test(clean) ? clean : '';
}

function previewMarkdownOperationFilename(title = '', operationId = '') {
  const fingerprint = crypto.createHash('sha256')
    .update(String(operationId || ''))
    .digest('hex')
    .slice(0, 16);
  return `${sanitizeName(title || '文本预览')}__${fingerprint}.md`;
}

async function writePreviewMarkdownOperationFile(base, dir, filename, text, { signal = null, shouldAbort = null } = {}) {
  const target = path.join(dir, filename);
  const buffer = Buffer.from(text, 'utf-8');
  await assertSafeOutputParent(base, target);
  const tmp = await writeOutputTempFile(target, handle => handle.writeFile(buffer), { signal, shouldAbort });
  try {
    if (await linkTempFileToUniqueTarget(tmp, target)) {
      return { file_path: target, reused: false };
    }
    const existing = await assertReadableOutputFile(base, target, { extensions: ['.md'], signal, shouldAbort });
    const { data } = await readOutputFileBuffer(existing, {
      signal,
      max_bytes: 2 * 1024 * 1024 + 1,
      expected_file_version: '',
    });
    if (!Buffer.from(data).equals(buffer)) {
      throw Object.assign(new Error('同一文本导出操作对应的内容已变化，已停止复用旧文件。'), {
        status: 409,
        code: 'preview_markdown_operation_mismatch',
        public_code: 'preview_markdown_operation_mismatch',
      });
    }
    return { file_path: existing, reused: true };
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

function previewMarkdownHistoryId({ filePath = '', createdAt = '', markdown = '', saveOperationId = '' } = {}) {
  const hash = crypto.createHash('sha256')
    .update(String(filePath || ''))
    .update('\0')
    .update(String(saveOperationId || createdAt || ''))
    .update('\0')
    .update(String(markdown || ''))
    .digest('hex')
    .slice(0, 16);
  return `text-preview-${hash}`;
}

function previewMarkdownMetaPathForMd(filePath = '') {
  return `${filePath}.meta.json`;
}

function previewMarkdownMetaIndexState(meta = {}) {
  if (meta?.index_committed === true) return 'indexed';
  const state = String(meta?.index_state || '').trim();
  if (state === 'indexed') return 'indexed';
  if (state === 'abandoned') return 'abandoned';
  if (state === 'needs_index') return 'needs_index';
  return 'legacy_unindexed';
}

function previewMarkdownMetaPayload(item = {}, { indexCommitted = false, indexState = '' } = {}) {
  const state = indexCommitted === true || indexState === 'indexed'
    ? 'indexed'
    : (indexState === 'abandoned' ? 'abandoned' : 'needs_index');
  const committed = state === 'indexed';
  return {
    schema: 'wx-summary.preview-markdown.v1',
    index_state: state,
    index_state_updated_at: new Date().toISOString(),
    index_committed: committed,
    index_committed_at: committed ? new Date().toISOString() : '',
    item: historyIndexItem(item),
  };
}

async function writePreviewMarkdownMetaAtomic(metaPath, payload) {
  try {
    await writeJsonAtomic(metaPath, payload, { maxBytes: HISTORY_MARKDOWN_META_MAX_BYTES });
  } catch (error) {
    if (error?.code !== 'json_payload_too_large') throw error;
    throw Object.assign(new Error('文本预览历史元数据超过 512KB 安全上限，未写入下次无法读取的记录。请减少一次选择的群数后重试。'), {
      status: 413,
      code: 'preview_markdown_metadata_too_large',
      public_code: 'preview_markdown_metadata_too_large',
      max_bytes: HISTORY_MARKDOWN_META_MAX_BYTES,
      bytes: Number(error?.bytes || 0) || 0,
      cause: error,
    });
  }
}

function historyIndexItemFromPreviewMarkdownMeta(base, metaPath, meta = {}, stat = null) {
  const source = meta?.item && typeof meta.item === 'object' && !Array.isArray(meta.item) ? meta.item : meta;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const filePath = resolveHistoryOutputPath(base, { ...source, file_path: source.file_path || metaPath.replace(/\.meta\.json$/i, '') }, ['relative_path', 'file_path'], '.md')
    || metaPath.replace(/\.meta\.json$/i, '');
  if (!filePath || !isInside(base, filePath) || path.extname(filePath).toLowerCase() !== '.md') return null;
  const digestId = String(source.digest_id || '').trim();
  if (!digestId) return null;
  const cleanMeta = cleanPreviewHistoryMetadata(source);
  return historyIndexItem({
    ...source,
    artifact_type: HISTORY_ARTIFACT_TEXT_PREVIEW_MD,
    file_type: 'markdown',
    digest_id: digestId,
    group: String(source.group || source.title || '文本预览'),
    groups: cleanMeta.groups,
    digest_ids: cleanMeta.digest_ids,
    file_path: filePath,
    relative_path: toProjectRelative(filePath),
    digest_path: '',
    digest_relative_path: '',
    model: String(source.model || ''),
    message_count: Math.max(0, Number(source.message_count || 0) || 0),
    complete: source.complete === true,
    done: Math.max(0, Number(source.done || 0) || 0),
    total: Math.max(0, Number(source.total || 0) || 0),
    headline: source.headline || cleanHistorySearchText(source.title || source.group || '文本预览', HISTORY_SEARCH_HEADLINE_MAX_CHARS),
    search_text: source.search_text || cleanHistorySearchText([source.title, source.group, source.headline].filter(Boolean).join(' · '), HISTORY_SEARCH_TEXT_MAX_CHARS),
    ...cleanPreviewHistorySourceReference(source),
    source_snapshot: cleanSourceSnapshot(source.source_snapshot),
    created_at: String(source.created_at || stat?.mtime?.toISOString?.() || new Date().toISOString()),
  });
}

async function previewMarkdownMetaItemForHistory(base, metaPath, meta = {}, stat = null, { signal = null } = {}) {
  const state = previewMarkdownMetaIndexState(meta);
  if (state === 'abandoned') return { item: null, state, reason: '' };
  const item = historyIndexItemFromPreviewMarkdownMeta(base, metaPath, meta, stat);
  if (!item) return { item: null, state, reason: 'metadata_invalid' };
  if (state === 'indexed') return { item, state, reason: '' };
  const expectedVersion = String(item.saved_file_version || item.file_version || '').trim();
  if (!expectedVersion) return { item: null, state, reason: 'file_version_missing' };
  let readable = '';
  try {
    readable = await assertReadableOutputFile(base, item.file_path, { extensions: ['.md'], signal });
    const currentVersion = await outputFileVersion(readable, { signal });
    if (!outputFileVersionMatches(expectedVersion, currentVersion)) {
      return { item: null, state, reason: 'file_changed' };
    }
  } catch (error) {
    if (isOutputAbortError(error)) throw error;
    return { item: null, state, reason: 'file_unreadable' };
  }
  return { item, state, reason: '' };
}

async function recoverPendingPreviewMarkdownHistory(settings, base, { signal = null, excludeRoots = [] } = {}) {
  return withHistoryWriteLock(async () => {
    throwIfOutputAborted(signal);
    const metaPaths = [];
    await collectPreviewMarkdownMetaFiles(base, metaPaths, base, { signal, excludeRoots });
    let indexed = await readHistoryIndexFromBase(settings, base, { signal, rebuildExcludeBases: excludeRoots });
    const indexedKeys = new Set(indexed.map(item => historyItemKeyForItem(base, item)).filter(Boolean));
    const result = { recovered: 0, marker_repaired: 0, failures: [], skipped: [] };
    for (const metaPath of metaPaths) {
      throwIfOutputAborted(signal);
      const meta = await readJson(metaPath, null, {
        strict: false,
        maxBytes: HISTORY_MARKDOWN_META_MAX_BYTES,
        signal,
      });
      throwIfOutputAborted(signal);
      const state = previewMarkdownMetaIndexState(meta);
      if (state === 'indexed' || state === 'abandoned') continue;
      const stat = await fsp.stat(metaPath).catch(() => null);
      const candidate = await previewMarkdownMetaItemForHistory(base, metaPath, meta, stat, { signal });
      if (!candidate.item) {
        if (candidate.reason) result.skipped.push({ path: toProjectRelative(metaPath), reason: candidate.reason });
        continue;
      }
      const item = candidate.item;
      const itemKey = historyItemKeyForItem(base, item);
      let wasAlreadyIndexed = indexedKeys.has(itemKey);
      if (!wasAlreadyIndexed) {
        try {
          await upsertHistory(settings, item, { base, signal });
          indexed = [item, ...indexed];
          indexedKeys.add(itemKey);
          result.recovered += 1;
        } catch (error) {
          if (isOutputAbortError(error)) throw error;
          result.failures.push({
            path: toProjectRelative(metaPath),
            error: String(error?.message || error || '历史索引写入失败'),
          });
          continue;
        }
      }
      try {
        await writePreviewMarkdownMetaAtomic(metaPath, previewMarkdownMetaPayload(item, { indexCommitted: true }));
        if (wasAlreadyIndexed) result.marker_repaired += 1;
      } catch (error) {
        if (isOutputAbortError(error)) throw error;
        result.failures.push({
          path: toProjectRelative(metaPath),
          error: String(error?.message || error || '历史完成标记写入失败'),
        });
      }
    }
    return result;
  });
}

async function repairIndexedPreviewMarkdownMarkers(base, items = [], { signal = null } = {}) {
  let repaired = 0;
  const failures = [];
  for (const item of Array.isArray(items) ? items : []) {
    throwIfOutputAborted(signal);
    if (!historyItemIsTextPreviewMarkdown(item)) continue;
    const filePath = resolveHistoryFilePath(base, item, '.md');
    if (!filePath) continue;
    const metaPath = previewMarkdownMetaPathForMd(filePath);
    const meta = await readJson(metaPath, null, {
      strict: false,
      maxBytes: HISTORY_MARKDOWN_META_MAX_BYTES,
      signal,
    });
    throwIfOutputAborted(signal);
    if (!meta || previewMarkdownMetaIndexState(meta) === 'indexed') continue;
    const resolved = await previewMarkdownMetaItemForHistory(base, metaPath, meta, null, { signal });
    const metaItem = resolved.item;
    const metaFilePath = metaItem ? resolveHistoryFilePath(base, metaItem, '.md') : '';
    if (!metaItem
      || String(metaItem.digest_id || '').trim() !== String(item.digest_id || '').trim()
      || historyPathDedupeKey(metaFilePath) !== historyPathDedupeKey(filePath)) continue;
    try {
      await writePreviewMarkdownMetaAtomic(metaPath, previewMarkdownMetaPayload(item, { indexCommitted: true }));
      repaired += 1;
    } catch (error) {
      if (isOutputAbortError(error)) throw error;
      failures.push({
        path: toProjectRelative(metaPath),
        error: String(error?.message || error || '未知错误'),
      });
    }
  }
  return { repaired, failures };
}

function historySearchArtifactFileName(value = '') {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized ? cleanHistorySearchText(path.posix.basename(normalized), 320) : '';
}

function historyItemSearchText(item = {}) {
  return [
    item.digest_id,
    item.account_label,
    item.account_id,
    item.group,
    item.headline,
    item.search_text,
    ...historySearchDateVariants(item.since),
    ...historySearchDateVariants(item.until),
    item.created_at,
    item.rerendered_at,
    item.message_count,
    historySearchArtifactFileName(item.relative_path || item.file_path),
    historySearchArtifactFileName(item.digest_relative_path || item.digest_path),
    item.model,
    item.source_label,
    ].map(historySearchNormalize).join(' ');
}

async function readHistoryMarkdownSearchText(base, item = {}, { signal = null, maxBytes = HISTORY_SEARCH_MARKDOWN_FALLBACK_MAX_BYTES } = {}) {
  if (!historyItemIsTextPreviewMarkdown(item)) return { status: 'not_markdown', text: '' };
  const itemBase = historyBaseForItem(base, item);
  const filePath = resolveHistoryFilePath(itemBase, item, '.md');
  if (!filePath) return { status: 'missing_path', text: '' };
  const limit = Math.max(0, Math.min(HISTORY_SEARCH_MARKDOWN_FALLBACK_MAX_BYTES, Number(maxBytes || 0) || 0));
  if (!limit) return { status: 'budget_exhausted', text: '' };
  let handle = null;
  try {
    throwIfOutputAborted(signal);
    handle = await fsp.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat?.isFile?.()) return { status: 'not_file', text: '' };
    if (stat.size > HISTORY_SEARCH_MARKDOWN_FALLBACK_MAX_BYTES) {
      return { status: 'too_large', text: '', size: stat.size };
    }
    if (stat.size > limit) return { status: 'budget_exhausted', text: '', size: stat.size };
    const data = await readFileHandleBounded(handle, limit, {
      chunkBytes: 1024 * 1024,
      checkAbort: () => throwIfOutputAborted(signal),
    });
    throwIfOutputAborted(signal);
    return {
      status: 'ok',
      text: data.toString('utf8'),
      bytes: data.length,
      file_version: outputFileVersionFromStat(stat),
    };
  } catch (error) {
    if (isOutputAbortError(error)) throw error;
    if (error?.code === 'ENOENT') return { status: 'missing', text: '' };
    return { status: 'unreadable', text: '', error: String(error?.message || error || '读取失败') };
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

async function readHistoryDigestSearchText(base, item = {}, { signal = null, maxBytes = HISTORY_DIGEST_JSON_MAX_BYTES } = {}) {
  if (historyItemIsTextPreviewMarkdown(item)) return { status: 'not_digest', text: '' };
  const itemBase = historyBaseForItem(base, item);
  const digestPath = resolveDigestPath(itemBase, item);
  if (!digestPath) return { status: 'missing_path', text: '' };
  const limit = Math.max(0, Math.min(HISTORY_DIGEST_JSON_MAX_BYTES, Number(maxBytes || 0) || 0));
  if (!limit) return { status: 'budget_exhausted', text: '' };
  try {
    throwIfOutputAborted(signal);
    const file = await assertReadableOutputFile(itemBase, digestPath, { extensions: ['.digest.json'], signal });
    const stat = await fsp.stat(file);
    if (!stat?.isFile?.() || stat.size > HISTORY_DIGEST_JSON_MAX_BYTES) {
      return { status: 'too_large', text: '', size: Number(stat?.size || 0) || 0 };
    }
    if (stat.size > limit) return { status: 'budget_exhausted', text: '', size: stat.size };
    const { data } = await readOutputFileBuffer(file, {
      signal,
      max_bytes: limit,
      missingMessage: '原摘要 JSON 已不存在。',
      missingCode: 'digest_json_missing',
    });
    throwIfOutputAborted(signal);
    const digest = JSON.parse(data.toString('utf-8'));
    if (!digest || typeof digest !== 'object' || Array.isArray(digest) || digestLooksEmptyForHistoryRead(digest)) {
      return { status: 'invalid', text: '', bytes: data.length };
    }
    if (historyDigestIdMismatch(digest, item.digest_id)) return { status: 'mismatch', text: '', bytes: data.length };
    return {
      status: 'ok',
      text: digestSearchTextForHistory(digest, { maxChars: HISTORY_DIGEST_JSON_MAX_BYTES }),
      bytes: data.length,
    };
  } catch (error) {
    if (isOutputAbortError(error)) throw error;
    if (error?.code === 'output_file_missing' || error?.code === 'digest_json_missing' || error?.code === 'ENOENT' || error?.status === 404) {
      return { status: 'missing', text: '' };
    }
    return { status: 'unreadable', text: '', error: String(error?.message || error || '读取失败') };
  }
}

function historySearchPhraseMatches(text = '', q = '') {
  const normalized = historySearchNormalize(text);
  return !!q && normalized.includes(q);
}

function historySearchTermsMatch(text = '', terms = []) {
  const normalized = historySearchNormalize(text);
  return Array.isArray(terms) && terms.length > 0 && terms.every(term => normalized.includes(term));
}

function historySearchTextMatches(text = '', q = '', terms = []) {
  return historySearchPhraseMatches(text, q) || historySearchTermsMatch(text, terms);
}

function historySearchTextIndexCurrent(item = {}) {
  return Math.max(0, Number(item?.search_text_version || 0) || 0) >= HISTORY_SEARCH_INDEX_VERSION;
}

function historySearchIndexBounded(item = {}) {
  return historySearchTextIndexCurrent(item)
    && String(item?.search_text || '').length >= HISTORY_SEARCH_TEXT_MAX_CHARS;
}

function historySearchTerms(query = '') {
  return [...new Set(historySearchNormalize(query).trim().split(/\s+/).filter(Boolean))];
}

function pruneHistorySearchSessions(now = Date.now()) {
  for (const [token, session] of historySearchSessions) {
    if (now - Number(session?.at || 0) <= HISTORY_SEARCH_SESSION_TTL_MS) continue;
    historySearchSessions.delete(token);
  }
  while (historySearchSessions.size > HISTORY_SEARCH_SESSION_LIMIT) {
    const oldest = historySearchSessions.keys().next().value;
    if (!oldest) break;
    historySearchSessions.delete(oldest);
  }
}

function historySearchCursorError({ stale = false } = {}) {
  return Object.assign(new Error(stale
    ? '历史全文搜索进度已过期，正在从最新历史重新搜索。'
    : '历史全文搜索游标无效，请重新搜索。'), {
    status: stale ? 409 : 400,
    code: stale ? 'history_search_cursor_stale' : 'history_search_cursor_invalid',
    public_code: stale ? 'history_search_cursor_stale' : 'history_search_cursor_invalid',
  });
}

function historySearchSessionForToken(token = '', { scope = '', revision = '', query = '' } = {}) {
  pruneHistorySearchSessions();
  const cleanToken = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(cleanToken)) throw historySearchCursorError();
  const session = historySearchSessions.get(cleanToken);
  if (!session) throw historySearchCursorError({ stale: true });
  if (String(session.scope || '') !== String(scope || '').trim().toLowerCase()
    || String(session.revision || '') !== String(revision || '').trim().toLowerCase()
    || String(session.query || '') !== historySearchNormalize(query).trim()) {
    throw historySearchCursorError();
  }
  historySearchSessions.delete(cleanToken);
  historySearchSessions.set(cleanToken, { ...session, at: Date.now() });
  return historySearchSessions.get(cleanToken);
}

function createHistorySearchSession(base, items = [], { query = '', terms = [], scope = '', revision = '' } = {}) {
  const entries = (Array.isArray(items) ? items : []).map(item => ({
    item,
    key: historyItemKeyForItem(base, item),
    text: historyItemSearchText(item),
  }));
  const matchRanks = new Map();
  const addMatch = (entry, rank) => {
    if (!entry.key || matchRanks.has(entry.key)) return;
    matchRanks.set(entry.key, Math.max(0, Number(rank || 0) || 0));
  };
  for (const entry of entries) {
    if (historySearchPhraseMatches(entry.text, query)) addMatch(entry, 0);
  }
  for (const entry of entries) {
    if (historySearchTermsMatch(entry.text, terms)) addMatch(entry, 1);
  }
  let boundedIndexCount = 0;
  let legacyIndexCount = 0;
  const candidateKeys = [];
  for (const entry of entries) {
    const bounded = historySearchIndexBounded(entry.item);
    if (bounded) boundedIndexCount += 1;
    else if (!historySearchTextIndexCurrent(entry.item)) legacyIndexCount += 1;
    const markdown = historyItemIsTextPreviewMarkdown(entry.item);
    const needsArtifactFallback = markdown
      ? !historySearchTextIndexCurrent(entry.item) || bounded
      : bounded;
    if (!matchRanks.has(entry.key) && needsArtifactFallback) candidateKeys.push(entry.key);
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const session = {
    token,
    at: Date.now(),
    scope: String(scope || '').trim().toLowerCase(),
    revision: String(revision || '').trim().toLowerCase(),
    query: historySearchNormalize(query).trim(),
    terms: Array.isArray(terms) ? terms.slice() : [],
    match_ranks: matchRanks,
    candidate_keys: candidateKeys,
    next_candidate_index: 0,
    fallback_attempt_count: 0,
    fallback_bytes: 0,
    fallback_incomplete_count: 0,
    bounded_index_count: boundedIndexCount,
    legacy_index_count: legacyIndexCount,
    complete: candidateKeys.length === 0,
  };
  historySearchSessions.set(token, session);
  pruneHistorySearchSessions();
  return session;
}

async function advanceHistorySearchSession(base, items = [], session = {}, { signal = null } = {}) {
  if (session.complete === true) return session;
  const itemsByKey = new Map((Array.isArray(items) ? items : [])
    .map(item => [historyItemKeyForItem(base, item), item])
    .filter(([key]) => !!key));
  let attemptsThisPass = 0;
  let bytesThisPass = 0;
  while (session.next_candidate_index < session.candidate_keys.length
    && attemptsThisPass < HISTORY_SEARCH_FALLBACK_MAX_CANDIDATES
    && bytesThisPass < HISTORY_SEARCH_FALLBACK_MAX_BYTES) {
    throwIfOutputAborted(signal);
    const key = session.candidate_keys[session.next_candidate_index];
    const item = itemsByKey.get(key);
    if (!item) {
      session.next_candidate_index += 1;
      session.fallback_incomplete_count += 1;
      continue;
    }
    const remainingBytes = HISTORY_SEARCH_FALLBACK_MAX_BYTES - bytesThisPass;
    attemptsThisPass += 1;
    const fallback = historyItemIsTextPreviewMarkdown(item)
      ? await readHistoryMarkdownSearchText(base, item, { signal, maxBytes: remainingBytes })
      : await readHistoryDigestSearchText(base, item, { signal, maxBytes: remainingBytes });
    const readBytes = Math.max(0, Number(fallback.bytes || 0) || 0);
    bytesThisPass += readBytes;
    if (fallback.status === 'budget_exhausted' && bytesThisPass > 0) break;
    session.next_candidate_index += 1;
    session.fallback_attempt_count += 1;
    session.fallback_bytes += readBytes;
    if (fallback.status === 'ok') {
      const indexedText = historyItemSearchText(item);
      if (historySearchTextMatches(`${indexedText} ${fallback.text}`, session.query, session.terms)) {
        session.match_ranks.set(key, 2);
      }
    } else {
      session.fallback_incomplete_count += 1;
    }
  }
  session.complete = session.next_candidate_index >= session.candidate_keys.length;
  session.at = Date.now();
  return session;
}

function historySearchSessionItems(base, items = [], session = {}) {
  return (Array.isArray(items) ? items : [])
    .filter(item => session.match_ranks.has(historyItemKeyForItem(base, item)))
    .sort((left, right) => (
      (session.match_ranks.get(historyItemKeyForItem(base, left)) || 0)
      - (session.match_ranks.get(historyItemKeyForItem(base, right)) || 0)
    ));
}

function appendHistorySearchSessionWarnings(warnings = [], session = {}) {
  const total = Math.max(0, Number(session.candidate_keys?.length || 0) || 0);
  const checked = Math.max(0, Number(session.next_candidate_index || 0) || 0);
  if (session.complete !== true) {
    warnings.push({
      code: 'history_search_scan_pending',
      fallback_candidate_count: total,
      fallback_checked_count: checked,
      fallback_remaining_count: Math.max(0, total - checked),
      fallback_candidate_limit: HISTORY_SEARCH_FALLBACK_MAX_CANDIDATES,
      fallback_byte_limit: HISTORY_SEARCH_FALLBACK_MAX_BYTES,
      message: `历史正文正在分批回读，已检查 ${checked}/${total} 条候选；下一批会从当前位置继续。`,
    });
  }
  if (session.fallback_incomplete_count > 0) {
    warnings.push({
      code: 'history_search_index_bounded',
      bounded_count: Math.max(0, Number(session.bounded_index_count || 0) || 0),
      legacy_count: Math.max(0, Number(session.legacy_index_count || 0) || 0),
      fallback_candidate_count: total,
      fallback_attempt_count: Math.max(0, Number(session.fallback_attempt_count || 0) || 0),
      bounded_unverified_count: Math.max(0, Number(session.fallback_incomplete_count || 0) || 0),
      fallback_incomplete_count: Math.max(0, Number(session.fallback_incomplete_count || 0) || 0),
      fallback_bytes: Math.max(0, Number(session.fallback_bytes || 0) || 0),
      message: '部分历史记录的搜索索引只覆盖正文前段，且对应摘要文件无法完成回读；这些文件中的正文后段关键词可能漏检。',
    });
  }
}

function historyResultIncompleteReasons(history = {}, warnings = [], { query = '' } = {}) {
  const reasons = new Set();
  if (history?.history_base_scan_limited) reasons.add('history_base_scan_limited');
  if (history?.history_base_visit_limited) reasons.add('history_base_visit_limited');
  const hasQuery = !!historySearchNormalize(query).trim();
  for (const warning of Array.isArray(warnings) ? warnings : []) {
    const code = String(warning?.code || '').trim();
    if (['history_base_unreadable', 'history_discovery_unreadable'].includes(code)) reasons.add(code);
    if (hasQuery && ['history_search_scan_pending', 'history_search_index_bounded', 'history_search_index_repair_incomplete'].includes(code)) reasons.add(code);
  }
  return [...reasons];
}

export async function listHistory(settings, { offset = 0, limit = 50, cursor = '', searchCursor = '', query = '', filter = 'all', accountId = '', signal = null, bypassCache = false, readOnly = false } = {}) {
  throwIfOutputAborted(signal);
  const q = historySearchNormalize(query).trim();
  if (q.length > HISTORY_SEARCH_QUERY_MAX_CHARS) {
    throw Object.assign(new Error(`历史搜索最多允许 ${HISTORY_SEARCH_QUERY_MAX_CHARS} 个字符，请缩短关键词后重试。`), {
      status: 400,
      code: 'history_search_query_too_long',
      public_code: 'history_search_query_too_long',
      max_chars: HISTORY_SEARCH_QUERY_MAX_CHARS,
    });
  }
  const base = await safeOutputBase(settings, { ensure: !readOnly, allowMissing: readOnly });
  const currentExportPolicyRevision = exportPolicyRevisionForSettings(settings);
  throwIfOutputAborted(signal);
  const history = await readCombinedHistoryState(settings, { signal, bypassCache, shareInFlight: true, readOnly });
  throwIfOutputAborted(signal);
  const requestedAccountId = historyAccountFilterKey(accountId);
  const allHistoryItems = history.items;
  const allItems = requestedAccountId
    ? allHistoryItems.filter(item => historyItemAccountMatches(item, requestedAccountId))
    : allHistoryItems;
  const sameWindowMetadata = historySameWindowRunMetadata(base, allItems);
  for (const item of allItems) {
    const metadata = sameWindowMetadata.get(historyItemKeyForItem(base, item));
    if (metadata) Object.assign(item, metadata);
    else {
      delete item.same_window_run_count;
      delete item.same_window_run_position;
    }
  }
  const warnings = Array.isArray(history.warnings) ? history.warnings.slice() : [];
  if (requestedAccountId) {
    const excludedCount = allHistoryItems.length - allItems.length;
    const excludedUnboundCount = allHistoryItems.filter(item => !String(item?.account_id || '').trim()).length;
    if (excludedCount > 0) {
      warnings.push({
        code: 'history_account_scope_applied',
        account_id: requestedAccountId,
        excluded_count: excludedCount,
        excluded_unbound_count: excludedUnboundCount,
        message: excludedUnboundCount > 0
          ? `当前账号筛选已隐藏 ${excludedCount} 条其他账号或未绑定账号的历史，其中 ${excludedUnboundCount} 条旧记录未绑定账号。切换到“全部账号”可查看。`
          : `当前账号筛选已隐藏 ${excludedCount} 条其他账号的历史；切换到“全部账号”可查看。`,
      });
    }
  }
  const metadataOnlySearchCount = q
    ? allItems.filter(item => String(item?.search_index_status || '').trim() === 'metadata_only').length
    : 0;
  if (metadataOnlySearchCount && !warnings.some(warning => warning?.code === 'history_search_index_repair_incomplete')) {
    warnings.push({
      code: 'history_search_index_repair_incomplete',
      metadata_only_count: metadataOnlySearchCount,
      message: `有 ${metadataOnlySearchCount} 条旧历史缺少摘要 JSON，搜索只使用群名、标题、时间和文件信息；可打开记录查看文件状态。`,
    });
  }
  const terms = historySearchTerms(q);
  const filterMode = String(filter || '').trim() === 'issues' ? 'issues' : (String(filter || '').trim() === 'all' ? 'all' : 'ok');
  const cursorScope = historyPageCursorScope(q, filterMode, requestedAccountId);
  const historyRevision = historyCollectionRevision(base, allItems);
  const safeLimit = clampHistoryPageNumber(limit, 50, { min: 1, max: 200 });
  const rawCursor = String(cursor || '').trim();
  const decodedCursor = decodeHistoryPageCursor(rawCursor, { scope: cursorScope, revision: historyRevision });
  if (rawCursor && !decodedCursor) {
    throw Object.assign(new Error('历史分页游标无效，请刷新历史页后重试。'), {
      status: 400,
      code: 'history_cursor_invalid',
      public_code: 'history_cursor_invalid',
    });
  }
  if (decodedCursor?.stale) throw historyCursorStaleError();
  const rawSearchCursor = String(searchCursor || '').trim();
  if (rawSearchCursor && rawCursor) throw historySearchCursorError();
  if (rawSearchCursor && !terms.length) throw historySearchCursorError();
  let searchSession = null;
  let matchRanks = new Map();
  let filtered = allItems;
  if (terms.length) {
    const sessionToken = rawSearchCursor || String(decodedCursor?.search_session_id || '').trim();
    searchSession = sessionToken
      ? historySearchSessionForToken(sessionToken, { scope: cursorScope, revision: historyRevision, query: q })
      : createHistorySearchSession(base, allItems, { query: q, terms, scope: cursorScope, revision: historyRevision });
    if (!decodedCursor) await advanceHistorySearchSession(base, allItems, searchSession, { signal });
    if (decodedCursor && searchSession.complete !== true) throw historySearchCursorError({ stale: true });
    appendHistorySearchSessionWarnings(warnings, searchSession);
    matchRanks = searchSession.match_ranks;
    filtered = historySearchSessionItems(base, allItems, searchSession);
  } else if (decodedCursor?.search_session_id) {
    throw historyCursorStaleError();
  }
  throwIfOutputAborted(signal);
  const searchSessionId = String(searchSession?.token || '').trim();
  const searchScanHasMore = !!searchSession && searchSession.complete !== true;
  const continuationCheckpoint = decodedCursor ? historyPageCheckpointForCursor(decodedCursor, {
    scope: cursorScope,
    revision: historyRevision,
    filterMode,
    currentExportPolicyRevision,
    searchSessionId,
  }) : null;
  const safeOffset = decodedCursor ? 0 : clampHistoryPageNumber(offset, 0, { min: 0, max: Math.max(0, filtered.length) });
  const sourceItemsByKey = historyItemsByKey(base, allHistoryItems);
  const page = await collectHistoryFilteredPage(base, filtered, {
    filterMode,
    offset: safeOffset,
    limit: safeLimit,
    afterCursor: decodedCursor,
    continuationCheckpoint,
    rankByKey: matchRanks,
    currentExportPolicyRevision,
    sourceItemsByKey,
    signal,
  });
  const items = await attachRelatedMarkdownExports(base, page.pageItems, allHistoryItems, {
    sourceItemsByKey,
    currentExportPolicyRevision,
    signal,
  });
  throwIfOutputAborted(signal);
  const visibleCount = page.returnedVisibleTotal;
  const incompleteReasons = historyResultIncompleteReasons(history, warnings, { query: q });
  const pageHasMore = !searchScanHasMore && page.hasMore;
  const totalExact = !pageHasMore && !searchScanHasMore && incompleteReasons.length === 0;
  const nextCheckpoint = pageHasMore && page.cursorItem && page.checkpoint
    ? rememberHistoryPageCheckpoint({
        ...page.checkpoint,
        scope: cursorScope,
        revision: historyRevision,
        filter_mode: filterMode,
        export_policy_revision: String(currentExportPolicyRevision || '').trim(),
        search_session_id: searchSessionId,
      })
    : '';
  return {
    items,
    total: page.visibleTotal,
    total_exact: totalExact,
    total_lower_bound: page.visibleTotal,
    scanned_total: page.scannedTotal,
    ok_total: page.okTotal,
    issue_total: page.issueTotal,
    ok_total_exact: totalExact,
    issue_total_exact: totalExact,
    incomplete_reasons: incompleteReasons,
    filter: filterMode,
    account_filter: requestedAccountId,
    history_revision: historyRevision,
    offset: safeOffset,
    limit: safeLimit,
    next_offset: visibleCount,
    next_cursor: pageHasMore && page.cursorItem ? encodeHistoryPageCursor(page.cursorItem, {
      rank: page.cursorRank,
      scope: cursorScope,
      revision: historyRevision,
      statusRevision: page.cursorStatusRevision,
      checkpoint: nextCheckpoint,
      searchSessionId,
    }) : '',
    has_more: pageHasMore,
    search_scan_has_more: searchScanHasMore,
    next_search_cursor: searchScanHasMore ? searchSessionId : '',
    search_scan_checked: searchSession ? Math.max(0, Number(searchSession.next_candidate_index || 0) || 0) : 0,
    search_scan_total: searchSession ? Math.max(0, Number(searchSession.candidate_keys?.length || 0) || 0) : 0,
    warnings,
    history_base_count: history.history_base_count,
    history_base_scan_limit: history.history_base_scan_limit,
    history_base_scan_limited: history.history_base_scan_limited,
    history_base_visit_limit: history.history_base_visit_limit,
    history_base_visited_dir_count: history.history_base_visited_dir_count,
    history_base_visit_limited: history.history_base_visit_limited,
    history_base_discovery_complete: history.history_base_discovery_complete === true,
    history_base_pending_dir_count: Math.max(0, Number(history.history_base_pending_dir_count || 0) || 0),
    history_base_scan_pass_count: Math.max(0, Number(history.history_base_scan_pass_count || 0) || 0),
    history_base_visited_dir_count_this_pass: Math.max(0, Number(history.history_base_visited_dir_count_this_pass || 0) || 0),
  };
}

function historySameWindowRunMetadata(base, items = []) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const group = String(item?.group || '').trim();
    const since = String(item?.since || '').trim();
    const until = String(item?.until || '').trim();
    if (!group || (!since && !until)) continue;
    const windowKey = JSON.stringify([
      String(item?.account_id || '').trim(),
      historyArtifactType(item),
      group,
      since,
      until,
    ]);
    const entries = groups.get(windowKey) || [];
    entries.push(item);
    groups.set(windowKey, entries);
  }
  const metadata = new Map();
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    entries.forEach((item, index) => {
      const itemKey = historyItemKeyForItem(base, item);
      if (!itemKey) return;
      metadata.set(itemKey, {
        same_window_run_count: entries.length,
        same_window_run_position: index + 1,
      });
    });
  }
  return metadata;
}

function historyPageRevisionSeed(kind = '') {
  return crypto.createHash('sha256')
    .update(`wx-summary-history-page-${String(kind || '').trim()}-v1\0`)
    .digest('hex');
}

function historyPageRevisionStep(previous = '', payload = null) {
  return crypto.createHash('sha256')
    .update(String(previous || ''))
    .update('\0')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function pruneHistoryPageCheckpoints(now = Date.now()) {
  for (const [token, checkpoint] of historyPageCheckpoints) {
    if (now - Number(checkpoint?.at || 0) <= HISTORY_PAGE_CHECKPOINT_TTL_MS) continue;
    historyPageCheckpoints.delete(token);
  }
  while (historyPageCheckpoints.size > HISTORY_PAGE_CHECKPOINT_LIMIT) {
    const oldest = historyPageCheckpoints.keys().next().value;
    if (!oldest) break;
    historyPageCheckpoints.delete(oldest);
  }
}

function rememberHistoryPageCheckpoint(checkpoint = {}) {
  const token = crypto.randomBytes(24).toString('base64url');
  historyPageCheckpoints.set(token, { ...checkpoint, at: Date.now() });
  pruneHistoryPageCheckpoints();
  return token;
}

function historyPageCheckpointForCursor(cursor = {}, { scope = '', revision = '', filterMode = '', currentExportPolicyRevision = '', searchSessionId = '' } = {}) {
  pruneHistoryPageCheckpoints();
  const token = String(cursor?.checkpoint || '').trim();
  const checkpoint = token ? historyPageCheckpoints.get(token) : null;
  if (!checkpoint) throw historyCursorStaleError('历史分页检查点已过期，正在从最新历史重新加载。');
  const expected = {
    scope: String(scope || '').trim().toLowerCase(),
    revision: String(revision || '').trim().toLowerCase(),
    filter_mode: String(filterMode || '').trim(),
    export_policy_revision: String(currentExportPolicyRevision || '').trim(),
    search_session_id: String(searchSessionId || '').trim(),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (String(checkpoint?.[field] || '').trim() !== value) throw historyCursorStaleError();
  }
  if (Math.max(0, Number(checkpoint.rank || 0) || 0) !== Math.max(0, Number(cursor.rank || 0) || 0)
    || Math.max(0, Number(checkpoint.time || 0) || 0) !== Math.max(0, Number(cursor.time || 0) || 0)
    || String(checkpoint.tie || '') !== String(cursor.tie || '')
    || String(checkpoint.status_revision || '') !== String(cursor.status_revision || '')) {
    throw historyCursorStaleError();
  }
  historyPageCheckpoints.delete(token);
  historyPageCheckpoints.set(token, { ...checkpoint, at: Date.now() });
  return checkpoint;
}

async function historyStatusPathDependency(base, targetPath, extension = '', { signal = null } = {}) {
  if (!targetPath) return ['missing_path', ''];
  const status = await regularFileStatusInside(base, targetPath, extension, { signal });
  if (status.exists !== true || status.readable !== true || !status.file) {
    return [status.exists === true ? 'unreadable' : 'missing', String(status.status || '')];
  }
  const version = await outputFileStatVersion(status.file, { signal }).catch(error => {
    if (isOutputAbortError(error)) throw error;
    return '';
  });
  return ['readable', version || 'stat_unknown'];
}

async function historyItemStatusDependencyRevision(base, item = {}, { sourceItemsByKey = null, signal = null } = {}) {
  const itemBase = historyBaseForItem(base, item);
  const markdown = historyItemIsTextPreviewMarkdown(item);
  const primaryPath = resolveHistoryFilePath(itemBase, item, markdown ? '.md' : '.png');
  const sidecarPath = markdown ? previewMarkdownMetaPathForMd(primaryPath) : resolveDigestPath(itemBase, item);
  const dependencies = [
    ['primary', itemBase, primaryPath, markdown ? '.md' : '.png'],
    ['sidecar', itemBase, sidecarPath, markdown ? '.json' : '.digest.json'],
  ];
  if (markdown && sourceItemsByKey && typeof sourceItemsByKey.get === 'function') {
    const sourceKey = cleanHistoryItemKey(item?.source_history_item_key);
    const sourceItem = sourceKey ? sourceItemsByKey.get(sourceKey) : null;
    if (sourceItem && !historyItemIsTextPreviewMarkdown(sourceItem)) {
      const sourceBase = historyBaseForItem(base, sourceItem);
      dependencies.push(['source_digest', sourceBase, resolveDigestPath(sourceBase, sourceItem), '.digest.json']);
    } else if (sourceKey) {
      dependencies.push(['source_digest', itemBase, '', '.digest.json']);
    }
  }
  const revisions = await Promise.all(dependencies.map(async ([kind, dependencyBase, targetPath, extension]) => [
    kind,
    await historyStatusPathDependency(dependencyBase, targetPath, extension, { signal }),
  ]));
  throwIfOutputAborted(signal);
  return crypto.createHash('sha256').update(JSON.stringify(revisions)).digest('hex');
}

async function validateHistoryPageCheckpointPrefix(base, items = [], checkpoint = {}, { afterCursor = null, rankByKey = null, sourceItemsByKey = null, signal = null } = {}) {
  const nextIndex = Math.max(0, Number(checkpoint?.next_index || 0) || 0);
  if (!nextIndex || nextIndex > items.length) throw historyCursorStaleError();
  const cursorItem = items[nextIndex - 1];
  const cursorRank = historyItemCursorRank(base, cursorItem, rankByKey);
  if (!historyItemMatchesCursor(cursorItem, afterCursor, cursorRank)) throw historyCursorStaleError();
  const dependencies = await mapHistoryItemsWithConcurrency(
    items.slice(0, nextIndex),
    item => historyItemStatusDependencyRevision(base, item, { sourceItemsByKey, signal }),
    { limit: HISTORY_PAGE_PREFIX_VALIDATION_CONCURRENCY, signal },
  );
  let revision = historyPageRevisionSeed('dependency');
  for (let index = 0; index < dependencies.length; index += 1) {
    revision = historyPageRevisionStep(revision, [historyItemKeyForItem(base, items[index]), dependencies[index]]);
  }
  if (revision !== String(checkpoint?.dependency_revision || '')) {
    throw historyCursorStaleError('历史文件状态在分页期间发生变化，正在重新加载正常/异常筛选结果。');
  }
}

async function probeHistoryPageItemStatus(base, item = {}, { wantAll = false, currentExportPolicyRevision = '', sourceItemsByKey = null, signal = null } = {}) {
  const cheapStatusItem = await historyItemWithFileStatus(base, item, {
    signal,
    includeVersions: false,
    validateDigestShape: !wantAll,
    sourceItemsByKey,
  });
  const filterStatusItem = cheapStatusItem.file_version_needs_hash_check === true || cheapStatusItem.digest_version_needs_hash_check === true
    ? await historyItemWithFileStatus(base, item, { signal, includeVersions: true, sourceItemsByKey })
    : cheapStatusItem;
  const issueReason = historyItemBlockingIssueReason(filterStatusItem, currentExportPolicyRevision);
  const itemDependencyRevision = await historyItemStatusDependencyRevision(base, item, { sourceItemsByKey, signal });
  return {
    cheapStatusItem,
    filterStatusItem,
    issueReason,
    hasIssue: !!issueReason,
    itemDependencyRevision,
  };
}

function historyPageProbeNeedsVersionUpgrade(probe = {}) {
  const cheapStatusItem = probe?.cheapStatusItem || {};
  return probe?.filterStatusItem === cheapStatusItem
    && (!cheapStatusItem.file_version
      || (cheapStatusItem.digest_exists !== false && !cheapStatusItem.digest_file_version));
}

async function collectHistoryFilteredPage(base, items = [], { filterMode = 'ok', offset = 0, limit = 50, afterCursor = null, continuationCheckpoint = null, rankByKey = null, currentExportPolicyRevision = '', sourceItemsByKey = null, signal = null } = {}) {
  const wantIssues = filterMode === 'issues';
  const wantAll = filterMode === 'all';
  const safeOffset = Math.max(0, Number(offset || 0) || 0);
  const safeLimit = Math.max(1, Number(limit || 50) || 50);
  const pageItems = [];
  let startIndex = 0;
  let scannedTotal = 0;
  let okTotal = 0;
  let issueTotal = 0;
  let visibleBeforeCursor = 0;
  let visibleSeen = 0;
  let committedScannedTotal = 0;
  let committedOkTotal = 0;
  let committedIssueTotal = 0;
  let cursorItem = null;
  let cursorRank = 0;
  let cursorStatusRevision = '';
  let cursorDependencyRevision = '';
  let cursorNextIndex = 0;
  let hasMore = false;
  let statusRevision = historyPageRevisionSeed('status');
  let dependencyRevision = historyPageRevisionSeed('dependency');
  if (afterCursor) {
    if (!continuationCheckpoint) throw historyCursorStaleError();
    await validateHistoryPageCheckpointPrefix(base, items, continuationCheckpoint, {
      afterCursor,
      rankByKey,
      sourceItemsByKey,
      signal,
    });
    startIndex = Math.max(0, Number(continuationCheckpoint.next_index || 0) || 0);
    scannedTotal = Math.max(0, Number(continuationCheckpoint.scanned_total || 0) || 0);
    okTotal = Math.max(0, Number(continuationCheckpoint.ok_total || 0) || 0);
    issueTotal = Math.max(0, Number(continuationCheckpoint.issue_total || 0) || 0);
    visibleBeforeCursor = Math.max(0, Number(continuationCheckpoint.visible_total || 0) || 0);
    committedScannedTotal = scannedTotal;
    committedOkTotal = okTotal;
    committedIssueTotal = issueTotal;
    statusRevision = String(continuationCheckpoint.status_revision || '');
    dependencyRevision = String(continuationCheckpoint.dependency_revision || '');
  }
  for (let batchStart = startIndex; batchStart < items.length && !hasMore; batchStart += HISTORY_PAGE_STATUS_CONCURRENCY) {
    throwIfOutputAborted(signal);
    const batchItems = items.slice(batchStart, batchStart + HISTORY_PAGE_STATUS_CONCURRENCY);
    const probes = await mapHistoryItemsWithConcurrency(
      batchItems,
      item => probeHistoryPageItemStatus(base, item, {
        wantAll,
        currentExportPolicyRevision,
        sourceItemsByKey,
        signal,
      }),
      { limit: HISTORY_PAGE_STATUS_CONCURRENCY, signal },
    );
    let projectedVisibleSeen = visibleSeen;
    let projectedPageCount = pageItems.length;
    const versionUpgradeEntries = [];
    for (let batchIndex = 0; batchIndex < batchItems.length; batchIndex += 1) {
      const visible = wantAll || (wantIssues ? probes[batchIndex].hasIssue : !probes[batchIndex].hasIssue);
      if (!visible) continue;
      if (projectedVisibleSeen < safeOffset) {
        projectedVisibleSeen += 1;
        continue;
      }
      if (projectedPageCount >= safeLimit) break;
      if (historyPageProbeNeedsVersionUpgrade(probes[batchIndex])) {
        versionUpgradeEntries.push({ batchIndex, item: batchItems[batchIndex] });
      }
      projectedPageCount += 1;
      projectedVisibleSeen += 1;
    }
    const upgradedStatusEntries = await mapHistoryItemsWithConcurrency(
      versionUpgradeEntries,
      async entry => [
        entry.batchIndex,
        await historyItemWithFileStatus(base, entry.item, { signal, includeVersions: true, sourceItemsByKey }),
      ],
      { limit: HISTORY_PAGE_STATUS_CONCURRENCY, signal },
    );
    const upgradedStatuses = new Map(upgradedStatusEntries);
    for (let batchIndex = 0; batchIndex < batchItems.length; batchIndex += 1) {
      const itemIndex = batchStart + batchIndex;
      const item = batchItems[batchIndex];
      const itemRank = historyItemCursorRank(base, item, rankByKey);
      const {
        cheapStatusItem,
        filterStatusItem,
        issueReason,
        hasIssue,
        itemDependencyRevision,
      } = probes[batchIndex];
      const visible = wantAll || (wantIssues ? hasIssue : !hasIssue);
      if (visible && visibleSeen >= safeOffset && pageItems.length >= safeLimit) {
        hasMore = true;
        break;
      }
      const statusItem = upgradedStatuses.get(batchIndex) || filterStatusItem;
      statusRevision = historyPageRevisionStep(statusRevision, [historyItemKeyForItem(base, item), issueReason]);
      dependencyRevision = historyPageRevisionStep(dependencyRevision, [historyItemKeyForItem(base, item), itemDependencyRevision]);
      scannedTotal += 1;
      if (hasIssue) issueTotal += 1;
      else okTotal += 1;
      if (!visible) continue;
      if (visibleSeen < safeOffset) {
        visibleSeen += 1;
        continue;
      }
      if (pageItems.length < safeLimit) {
        pageItems.push({
          ...statusItem,
          has_blocking_issue: hasIssue,
          blocking_issue_reason: issueReason,
          blocking_issue_policy_revision: String(currentExportPolicyRevision || '').trim(),
        });
        cursorItem = item;
        cursorRank = itemRank;
        cursorStatusRevision = statusRevision;
        cursorDependencyRevision = dependencyRevision;
        cursorNextIndex = itemIndex + 1;
        visibleSeen += 1;
        committedScannedTotal = scannedTotal;
        committedOkTotal = okTotal;
        committedIssueTotal = issueTotal;
      }
    }
  }
  if (!hasMore) {
    committedScannedTotal = scannedTotal;
    committedOkTotal = okTotal;
    committedIssueTotal = issueTotal;
  }
  const returnedVisibleTotal = visibleBeforeCursor + safeOffset + pageItems.length;
  return {
    pageItems,
    scannedTotal: committedScannedTotal,
    okTotal: committedOkTotal,
    issueTotal: committedIssueTotal,
    visibleSeen,
    returnedVisibleTotal,
    visibleTotal: returnedVisibleTotal + (hasMore ? 1 : 0),
    cursorItem,
    cursorRank,
    cursorStatusRevision,
    hasMore,
    checkpoint: hasMore && cursorItem ? {
      next_index: cursorNextIndex,
      scanned_total: committedScannedTotal,
      ok_total: committedOkTotal,
      issue_total: committedIssueTotal,
      visible_total: returnedVisibleTotal,
      status_revision: cursorStatusRevision,
      dependency_revision: cursorDependencyRevision,
      rank: cursorRank,
      time: historyItemSortTimeMs(cursorItem),
      tie: historyItemSortTieBreaker(cursorItem),
    } : null,
  };
}

function historyCursorStaleError(message = '历史记录在分页期间发生变化，已停止继续使用旧分页位置；请重新加载历史列表。') {
  return Object.assign(new Error(message), {
    status: 409,
    code: 'history_cursor_stale',
    public_code: 'history_cursor_stale',
  });
}

function historyMarkdownPolicyIssueReason(item = {}, currentExportPolicyRevision = '') {
  if (!historyItemIsTextPreviewMarkdown(item)) return '';
  const target = String(item.relative_path || item.file_path || '').trim();
  const itemRevision = String(item.export_policy_revision || item.export_settings_revision || '').trim();
  const currentRevision = String(currentExportPolicyRevision || '').trim();
  if (target && !itemRevision) return 'export_policy_revision_missing';
  return itemRevision && currentRevision && itemRevision !== currentRevision
    ? 'export_policy_changed'
    : '';
}

function historyItemIdentityIssue(item = {}) {
  if (String(item.history_item_key || '').trim()) return false;
  if (!String(item.digest_id || '').trim()) return true;
  return item.history_digest_duplicate === true || item._history_digest_duplicate === true;
}

function historyItemHasBlockingIssue(item = {}, currentExportPolicyRevision = '') {
  return !!historyItemBlockingIssueReason(item, currentExportPolicyRevision);
}

function historyItemBlockingIssueReason(item = {}, currentExportPolicyRevision = '') {
  if (historyItemIdentityIssue(item)) return 'history_identity_invalid';
  const fileStale = item.file_stale === true || item.file_version_stale === true;
  const fileVersionUnknown = item.file_version_unknown === true;
  const fileStatus = String(item.file_status || '').trim();
  const markdownHistory = historyItemIsTextPreviewMarkdown(item);
  const digestStatus = String(item.digest_status || '').trim();
  if (markdownHistory) {
    if (item.file_exists === false) return 'file_missing';
    if (fileStale) return 'file_changed';
    if (fileVersionUnknown) return 'file_version_unknown';
    if (item.digest_invalid === true) return digestStatus ? `digest_${digestStatus}` : 'digest_invalid';
    return historyMarkdownPolicyIssueReason(item, currentExportPolicyRevision);
  }
  const legacyPngOnly = digestStatus === 'legacy_png_only' || item.digest_missing_reason === 'legacy_png_only';
  if (item.file_exists === false) return 'file_missing';
  if (fileStale) return 'file_changed';
  if (item.file_readable === false) return fileStatus ? `file_${fileStatus}` : 'file_unreadable';
  if (item.file_png_valid === false) return fileStatus ? `file_${fileStatus}` : 'file_png_invalid';
  if (fileVersionUnknown) return 'file_version_unknown';
  if (item.digest_exists === false && !legacyPngOnly) return 'digest_missing';
  if (item.digest_invalid === true) return digestStatus ? `digest_${digestStatus}` : 'digest_invalid';
  return ['invalid', 'unreadable', 'empty', 'mismatch', 'changed'].includes(digestStatus)
    ? `digest_${digestStatus}`
    : '';
}

function historyItemsByKey(base, items = []) {
  const map = new Map();
  const list = (Array.isArray(items) ? items : [])
    .filter(item => item && typeof item === 'object' && !Array.isArray(item));
  const currentKeys = new Set();
  for (const item of list) {
    const key = historyItemKeyForItem(base, item);
    if (!key) continue;
    currentKeys.add(key);
    map.set(key, item);
  }
  const ambiguousAliases = new Set();
  for (const item of list) {
    for (const alias of historyItemKeyAliases(base, item)) {
      if (currentKeys.has(alias) || ambiguousAliases.has(alias)) continue;
      const existing = map.get(alias);
      if (existing && existing !== item) {
        map.delete(alias);
        ambiguousAliases.add(alias);
        continue;
      }
      map.set(alias, item);
    }
  }
  return map;
}

function historyMarkdownExportsBySourceKey(base, items = [], sourceItemsByKey = historyItemsByKey(base, items)) {
  const bySource = new Map();
  const sorted = [...(Array.isArray(items) ? items : [])].sort(compareHistoryItemsDesc);
  for (const item of sorted) {
    if (!historyItemIsTextPreviewMarkdown(item)) continue;
    const sourceReference = cleanHistoryItemKey(item?.source_history_item_key);
    const sourceItem = sourceReference ? sourceItemsByKey.get(sourceReference) : null;
    if (!sourceItem || historyItemIsTextPreviewMarkdown(sourceItem)) continue;
    const sourceKey = historyItemKeyForItem(base, sourceItem);
    if (!sourceKey) continue;
    const candidates = bySource.get(sourceKey) || [];
    if (candidates.length < 16) candidates.push(item);
    bySource.set(sourceKey, candidates);
  }
  return bySource;
}

async function attachRelatedMarkdownExports(base, pageItems = [], allItems = [], { sourceItemsByKey = null, currentExportPolicyRevision = '', signal = null } = {}) {
  const sourceLookup = sourceItemsByKey && typeof sourceItemsByKey.get === 'function'
    ? sourceItemsByKey
    : historyItemsByKey(base, allItems);
  const exportsBySource = historyMarkdownExportsBySourceKey(base, allItems, sourceLookup);
  return mapHistoryItemsWithConcurrency(pageItems, async item => {
    throwIfOutputAborted(signal);
    if (historyItemIsTextPreviewMarkdown(item)) return item;
    const sourceKey = historyItemKeyForItem(base, item);
    const candidates = exportsBySource.get(sourceKey) || [];
    for (const candidate of candidates) {
      const statusItem = await historyItemWithFileStatus(base, candidate, {
        signal,
        includeVersions: true,
        sourceItemsByKey: sourceLookup,
      });
      const issueReason = historyItemBlockingIssueReason(statusItem, currentExportPolicyRevision);
      if (issueReason) continue;
      return {
        ...item,
        related_markdown_export: {
          ...statusItem,
          has_blocking_issue: false,
          blocking_issue_reason: '',
          blocking_issue_policy_revision: String(currentExportPolicyRevision || '').trim(),
        },
      };
    }
    return item;
  }, { limit: 8, signal });
}

function historyItemCursorRank(base, item = {}, rankByKey = null) {
  if (!rankByKey || typeof rankByKey.get !== 'function') return 0;
  return Math.max(0, Number(rankByKey.get(historyItemKeyForItem(base, item)) || 0) || 0);
}

function historyAccountFilterKey(value = '') {
  const normalized = String(value || '').trim().toLowerCase().slice(0, 240);
  return normalized === 'all' ? '' : normalized;
}

function historyItemAccountMatches(item = {}, accountId = '') {
  const requested = historyAccountFilterKey(accountId);
  if (!requested) return true;
  return historyAccountFilterKey(item?.account_id) === requested;
}

function historyPageCursorScope(query = '', filterMode = 'all', accountId = '') {
  return crypto.createHash('sha256')
    .update(JSON.stringify([
      historySearchNormalize(query).trim(),
      String(filterMode || '').trim(),
      historyAccountFilterKey(accountId),
    ]))
    .digest('hex');
}

function historyCollectionRevision(base, items = []) {
  const hash = crypto.createHash('sha256');
  hash.update('wx-summary-history-collection-v2\0');
  for (const item of Array.isArray(items) ? items : []) {
    hash.update('\0');
    hash.update(JSON.stringify([
      historyItemKeyForItem(base, item),
      historyItemSortTimeMs(item),
      historyItemSortTieBreaker(item),
      item?.artifact_type || '',
      item?.file_type || '',
      item?.history_record_id || '',
      item?.digest_id || '',
      item?.account_id || '',
      item?.group_id || '',
      item?.group || '',
      item?.since || '',
      item?.until || '',
      item?.created_at || '',
      item?.rerendered_at || '',
      item?.file_path || item?.relative_path || '',
      item?.digest_path || item?.digest_relative_path || '',
      item?.saved_file_version || '',
      item?.saved_digest_file_version || '',
      item?.message_count || 0,
      item?.headline || '',
      item?.search_text || '',
      item?.search_text_version || 0,
      item?.model || '',
      item?.source_label || '',
    ]));
  }
  return hash.digest('hex');
}

function historyItemMatchesCursor(item = {}, cursor = {}, itemRank = 0) {
  const rank = Math.max(0, Number(itemRank || 0) || 0);
  const cursorRank = Math.max(0, Number(cursor.rank || 0) || 0);
  return rank === cursorRank
    && historyItemSortTimeMs(item) === Math.max(0, Number(cursor.time || 0) || 0)
    && historyItemSortTieBreaker(item) === String(cursor.tie || '');
}

function encodeHistoryPageCursor(item = {}, { rank = 0, scope = '', revision = '', statusRevision = '', checkpoint = '', searchSessionId = '' } = {}) {
  const payload = JSON.stringify({
    v: 7,
    rank: Math.max(0, Number(rank || 0) || 0),
    time: historyItemSortTimeMs(item),
    tie: historyItemSortTieBreaker(item),
    scope: String(scope || '').trim().toLowerCase(),
    revision: String(revision || '').trim().toLowerCase(),
    status_revision: String(statusRevision || '').trim().toLowerCase(),
    checkpoint: String(checkpoint || '').trim(),
    search_session: String(searchSessionId || '').trim(),
  });
  return Buffer.from(payload, 'utf-8').toString('base64url');
}

function decodeHistoryPageCursor(value = '', { scope = '', revision = '' } = {}) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > 768 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf-8'));
    const parsedScope = String(parsed?.scope || '').trim().toLowerCase();
    const expectedScope = String(scope || '').trim().toLowerCase();
    const parsedRevision = String(parsed?.revision || '').trim().toLowerCase();
    const expectedRevision = String(revision || '').trim().toLowerCase();
    const parsedStatusRevision = String(parsed?.status_revision || '').trim().toLowerCase();
    const checkpoint = String(parsed?.checkpoint || '').trim();
    const searchSessionId = String(parsed?.search_session || '').trim();
    const time = Math.max(0, Number(parsed?.time || 0) || 0);
    const tie = String(parsed?.tie || '').trim().toLowerCase();
    if (parsed?.v === 6
      && /^[a-f0-9]{64}$/.test(tie)
      && /^[a-f0-9]{64}$/.test(parsedScope)
      && parsedScope === expectedScope
      && /^[a-f0-9]{64}$/.test(parsedRevision)
      && /^[a-f0-9]{64}$/.test(expectedRevision)
      && /^[a-f0-9]{64}$/.test(parsedStatusRevision)) {
      return { stale: true };
    }
    if (parsed?.v !== 7
      || !/^[a-f0-9]{64}$/.test(tie)
      || !/^[a-f0-9]{64}$/.test(parsedScope)
      || parsedScope !== expectedScope
      || !/^[a-f0-9]{64}$/.test(parsedRevision)
      || !/^[a-f0-9]{64}$/.test(expectedRevision)
      || !/^[a-f0-9]{64}$/.test(parsedStatusRevision)
      || !/^[A-Za-z0-9_-]{20,128}$/.test(checkpoint)
      || (searchSessionId && !/^[A-Za-z0-9_-]{20,128}$/.test(searchSessionId))) return null;
    return {
      stale: parsedRevision !== expectedRevision,
      rank: Math.max(0, Number(parsed.rank || 0) || 0),
      time,
      tie,
      status_revision: parsedStatusRevision,
      checkpoint,
      search_session_id: searchSessionId,
    };
  } catch {
    return null;
  }
}

function historyMarkdownSourceChangedItem(item = {}, message = '源历史摘要已更新，请重新从原摘要导出 MD。', reason = 'history_source_changed_after_commit') {
  return {
    ...item,
    source_stale: true,
    source_stale_reason: item.source_stale_reason || reason,
    source_stale_error: item.source_stale_error || message,
    local_action_after_commit_reason: item.local_action_after_commit_reason || reason,
    local_action_after_commit_error: item.local_action_after_commit_error || message,
  };
}

async function historyMarkdownSourceStatusItem(base, item = {}, sourceItemsByKey = null, { signal = null } = {}) {
  if (!historyItemIsTextPreviewMarkdown(item)) return item;
  if (!sourceItemsByKey || typeof sourceItemsByKey.get !== 'function') return item;
  const sourceDigestId = String(item.source_digest_id || '').trim();
  if (!sourceDigestId) return item;
  const sourceKey = String(item.source_history_item_key || '').trim();
  const expectedDigestVersion = String(item.source_expected_digest_file_version || '').trim();
  const expectedDigestRevision = String(item.source_digest_revision || '').trim();
  if (!sourceKey || (!expectedDigestVersion && !expectedDigestRevision)) return historyMarkdownSourceChangedItem(item, '导出的 MD 缺少源摘要版本绑定，请重新从原摘要导出 MD。');
  const sourceItem = sourceItemsByKey.get(sourceKey);
  if (!sourceItem) return historyMarkdownSourceChangedItem(item, '源历史摘要已不存在，请重新从最新历史记录导出 MD。');
  if (historyItemIsTextPreviewMarkdown(sourceItem)) return historyMarkdownSourceChangedItem(item, '源历史记录不是摘要 PNG，请重新从原摘要导出 MD。');
  const sourceBase = historyBaseForItem(base, sourceItem);
  const digestPath = resolveDigestPath(sourceBase, sourceItem);
  if (expectedDigestRevision) {
    const semanticStatus = await historyDigestSemanticRevisionInside(sourceBase, digestPath, {
      signal,
      expected_digest_id: sourceDigestId,
    });
    if (!semanticStatus.ok || semanticStatus.revision !== expectedDigestRevision) {
      if (await historyMarkdownSourceStrongDigestVersionMatches(sourceBase, digestPath, {
        signal,
        expected_digest_id: sourceDigestId,
        expected_digest_file_version: expectedDigestVersion,
      })) return item;
      if (semanticStatus.missing) {
        return historyMarkdownSourceChangedItem(item, '源历史摘要已不存在，请重新从最新历史记录导出 MD。');
      }
      if (semanticStatus.unreadable) {
        return historyMarkdownSourceChangedItem(item, '源历史摘要暂时无法读取，请刷新历史记录后重试。', 'history_source_unreadable_after_commit');
      }
      return historyMarkdownSourceChangedItem(item, '源历史摘要内容已更新，请重新从原摘要导出 MD。');
    }
    return item;
  }
  const digestStatus = await historyDigestFileStatusInside(sourceBase, digestPath, {
    signal,
    expected_digest_id: sourceDigestId,
    includeVersions: true,
    saved_digest_file_version: expectedDigestVersion,
    validateDigestShape: true,
  }).catch(e => {
    if (isOutputAbortError(e)) throw e;
    return { digest_exists: true, digest_invalid: true, digest_status: 'unreadable', error: e?.message || String(e) };
  });
  if (digestStatus.digest_exists === false) return historyMarkdownSourceChangedItem(item, '源历史摘要已不存在，请重新从最新历史记录导出 MD。');
  if (digestStatus.digest_status === 'unreadable') {
    return historyMarkdownSourceChangedItem(item, '源历史摘要暂时无法读取，请刷新历史记录后重试。', 'history_source_unreadable_after_commit');
  }
  if (digestStatus.digest_invalid || ['invalid', 'unreadable', 'empty', 'mismatch', 'changed'].includes(String(digestStatus.digest_status || '').trim())) {
    return historyMarkdownSourceChangedItem(item, '源历史摘要已更新，请重新从原摘要导出 MD。');
  }
  return item;
}

async function historyMarkdownSourceStrongDigestVersionMatches(base, digestPath, {
  signal = null,
  expected_digest_id = '',
  expected_digest_file_version = '',
} = {}) {
  const expected = String(expected_digest_file_version || '').trim();
  if (outputFileVersionKind(expected) !== 'v2') return false;
  const status = await historyDigestFileStatusInside(base, digestPath, {
    signal,
    expected_digest_id,
    includeVersions: true,
    saved_digest_file_version: expected,
    validateDigestShape: true,
  });
  return status.digest_exists === true
    && status.digest_invalid !== true
    && status.digest_status === 'ok'
    && outputFileVersionMatches(expected, status.digest_file_version);
}

async function historyDigestSemanticRevisionInside(base, digestPath, { signal = null, expected_digest_id = '' } = {}) {
  throwIfOutputAborted(signal);
  let file = '';
  try {
    file = await assertReadableOutputFile(base, digestPath, { extensions: ['.digest.json'], signal });
  } catch (e) {
    if (isOutputAbortError(e)) throw e;
    if (e?.code === 'output_file_missing' || e?.status === 404) return { ok: false, missing: true, revision: '' };
    return { ok: false, missing: false, unreadable: true, revision: '', error: e?.message || String(e) };
  }
  if (!file) return { ok: false, missing: true, revision: '' };
  try {
    const { data } = await readOutputFileBuffer(file, {
      signal,
      max_bytes: HISTORY_DIGEST_JSON_MAX_BYTES,
      missingMessage: '原摘要 JSON 已不存在。',
      missingCode: 'digest_json_missing',
    });
    const digest = JSON.parse(data.toString('utf-8'));
    if (!digest || typeof digest !== 'object' || Array.isArray(digest) || digestLooksEmptyForHistoryRead(digest) || historyDigestIdMismatch(digest, expected_digest_id)) {
      return { ok: false, missing: false, revision: '' };
    }
    return { ok: true, missing: false, revision: digestSemanticRevision(digest) };
  } catch (e) {
    if (isOutputAbortError(e)) throw e;
    if (e?.code === 'ENOENT' || e?.code === 'digest_json_missing' || e?.status === 404) {
      return { ok: false, missing: true, revision: '' };
    }
    return { ok: false, missing: false, unreadable: true, revision: '', error: e?.message || String(e) };
  }
}

async function historyItemWithFileStatus(base, item = {}, { signal = null, includeVersions = true, includeFileVersion = includeVersions, includeDigestVersion = includeVersions, validateDigestShape = includeDigestVersion, sourceItemsByKey = null } = {}) {
  throwIfOutputAborted(signal);
  const itemBase = historyBaseForItem(base, item);
  const markdownHistory = historyItemIsTextPreviewMarkdown(item);
  const filePath = resolveHistoryFilePath(itemBase, item, markdownHistory ? '.md' : '.png');
  const digestPath = resolveDigestPath(itemBase, item);
  const recordedDigestPath = Object.hasOwn(item, '_history_recorded_digest_path')
    ? item._history_recorded_digest_path === true
    : historyItemHasRecordedDigestPath(item);
  const current = item._history_current !== false;
  const savedFileVersion = savedHistoryFileVersion(item);
  const savedDigestFileVersion = savedHistoryDigestFileVersion(item);
  let digestStatus = markdownHistory
    ? await historyMarkdownMetadataFileStatusInside(itemBase, filePath, { signal, includeVersions: includeDigestVersion })
    : await historyDigestFileStatusInside(itemBase, digestPath, { signal, expected_digest_id: item.digest_id, includeVersions: includeDigestVersion, saved_digest_file_version: savedDigestFileVersion, validateDigestShape });
  if (!markdownHistory && digestStatus.digest_exists === false && !recordedDigestPath) {
    digestStatus = {
      ...digestStatus,
      digest_status: 'legacy_png_only',
      digest_missing_reason: 'legacy_png_only',
    };
  }
  throwIfOutputAborted(signal);
  let fileStatus = await regularFileStatusInside(itemBase, filePath, markdownHistory ? '.md' : '.png', { signal });
  const fileExists = fileStatus.exists === true;
  const savedFileVersionKind = outputFileVersionKind(savedFileVersion);
  const savedFileVersionCanUseStatFallback = savedFileVersionKind === 'v1';
  const savedFileVersionHasFingerprint = !!outputFileVersionFingerprint(savedFileVersion);
  const fileCacheState = fileExists && fileStatus.readable
    ? await outputFileCacheState(fileStatus.file || filePath, { signal })
    : { cacheKey: '', statVersion: '', strongVersion: '', pngValidated: false };
  const currentFileStatVersion = fileCacheState.statVersion;
  const currentFileSize = outputFileVersionSize(currentFileStatVersion);
  const savedV2StatMatches = savedFileVersionKind === 'v2'
    && !!currentFileStatVersion
    && (markdownHistory || (currentFileSize > 0 && currentFileSize <= RENDERED_PNG_MAX_BYTES))
    && outputFileVersionStatMatches(savedFileVersion, currentFileStatVersion);
  const fullPngValidationTrusted = fileCacheState.pngValidated;
  if (!markdownHistory && fileExists && fileStatus.readable === true && !fullPngValidationTrusted) {
    try {
      if (savedV2StatMatches) {
        const policyInspection = await inspectOutputPngFileHeader(fileStatus.file || filePath, { signal });
        if (!outputFileVersionStatMatches(savedFileVersion, policyInspection.file_version)) {
          throw outputFileVersionChangedError(savedFileVersion, policyInspection.file_version, { artifact: 'png' });
        }
      } else {
        await inspectOutputPngFile(fileStatus.file || filePath, { signal, validate_inflated: false });
        rememberValidatedOutputPng(fileCacheState.cacheKey);
      }
      fileStatus = { ...fileStatus, png_valid: true };
    } catch (e) {
      if (isOutputAbortError(e)) throw e;
      const status = String(e?.code || 'png_payload_invalid').trim() || 'png_payload_invalid';
      const versionableInvalidPng = ['png_payload_invalid', 'png_payload_dimensions_too_large', 'png_payload_canvas_too_large', 'png_payload_decoded_too_large', 'png_payload_too_many_chunks'].includes(status);
      fileStatus = {
        ...fileStatus,
        readable: versionableInvalidPng,
        png_valid: false,
        status,
      };
    }
  } else if (!markdownHistory && fullPngValidationTrusted) {
    fileStatus = { ...fileStatus, png_valid: true };
  }
  throwIfOutputAborted(signal);
  let fileVersionUnknown = fileExists && fileStatus.readable === false;
  let fileVersionNeedsHashCheck = false;
  const trustedStrongFileVersion = fileStatus.readable === true
    ? (savedV2StatMatches ? savedFileVersion : fileCacheState.strongVersion)
    : '';
  const fileVersion = fileExists
    ? (trustedStrongFileVersion
      ? trustedStrongFileVersion
      : (includeFileVersion && fileStatus.readable ? await outputFileVersion(fileStatus.file || filePath, { signal }).catch(e => {
        if (isOutputAbortError(e)) throw e;
        fileVersionUnknown = true;
        return '';
      }) : ''))
    : '';
  const currentFileVersion = fileVersion || (fileExists && fileStatus.readable && (savedFileVersionCanUseStatFallback || (!includeFileVersion && savedFileVersionHasFingerprint))
    ? (currentFileStatVersion || await outputFileStatVersion(fileStatus.file || filePath, { signal }).catch(() => ''))
    : '');
  if (fileExists && !includeFileVersion && savedFileVersionKind === 'v2' && currentFileVersion && !outputFileVersionStatMatches(savedFileVersion, currentFileVersion)) {
    fileVersionNeedsHashCheck = true;
  }
  const fileVersionStale = fileExists && savedFileVersion && currentFileVersion
    ? (includeFileVersion ? !outputFileVersionMatches(savedFileVersion, currentFileVersion) : !outputFileVersionStatMatches(savedFileVersion, currentFileVersion))
    : false;
  if (fileExists && includeFileVersion && !fileVersion && !fileVersionStale) fileVersionUnknown = true;
  const responseFileVersion = !fileExists
    ? OUTPUT_FILE_EXPECTED_MISSING_VERSION
    : (!includeFileVersion
      && savedFileVersion
      && currentFileVersion
      && outputFileVersionStatMatches(savedFileVersion, currentFileVersion)
      ? savedFileVersion
      : fileVersion);
  // A legacy PNG can be too large to open safely, while its indexed SHA256
  // version still gives the rerender endpoint a safe, stream-verified source.
  // Keep this separate from file_version so normal file actions stay disabled.
  let rerenderFileVersion = '';
  if (!markdownHistory
    && fileExists
    && fileStatus.status === 'png_payload_too_large'
    && savedFileVersionKind === 'v2'
    && fileStatus.file) {
    const statVersion = await outputFileStatVersion(fileStatus.file, { signal });
    if (outputFileVersionStatMatches(savedFileVersion, statVersion)) {
      rerenderFileVersion = savedFileVersion;
    }
  }
  throwIfOutputAborted(signal);
  const statusItem = {
    ...item,
    history_item_key: historyItemKeyForItem(base, item),
    history_digest_duplicate: !!item._history_digest_duplicate,
    history_current: current,
    history_output_relative_path: current ? '' : toProjectRelative(itemBase),
    rerender_disabled_reason: current ? '' : 'old_output_dir',
    file_exists: fileExists,
    file_readable: fileStatus.readable === true,
    file_png_valid: markdownHistory ? undefined : fileStatus.png_valid !== false,
    file_expected_missing: !fileExists,
    file_status: fileStatus.status || '',
    file_version: responseFileVersion,
    rerender_file_version: rerenderFileVersion,
    file_version_unknown: fileVersionUnknown,
    file_version_needs_hash_check: fileVersionNeedsHashCheck,
    file_version_stale: fileVersionStale,
    file_stale: fileVersionStale,
    ...digestStatus,
  };
  return historyMarkdownSourceStatusItem(base, statusItem, sourceItemsByKey, { signal });
}

async function historyMarkdownMetadataFileStatusInside(base, markdownPath, { signal = null, includeVersions = true } = {}) {
  throwIfOutputAborted(signal);
  const metaPath = markdownPath ? previewMarkdownMetaPathForMd(markdownPath) : '';
  const status = await regularFileStatusInside(base, metaPath, '.json', { signal });
  throwIfOutputAborted(signal);
  if (status.exists !== true) {
    return { digest_exists: false, digest_invalid: false, digest_status: 'md_meta_missing', digest_file_version: '', digest_version_needs_hash_check: false };
  }
  if (status.readable !== true || !status.file) {
    return { digest_exists: true, digest_invalid: true, digest_status: 'md_meta_unreadable', digest_file_version: '', digest_version_needs_hash_check: false };
  }
  const digestFileVersion = includeVersions
    ? await outputFileVersion(status.file, { signal }).catch(error => {
        if (isOutputAbortError(error)) throw error;
        return '';
      })
    : '';
  return {
    digest_exists: true,
    digest_invalid: includeVersions && !digestFileVersion,
    digest_status: includeVersions && !digestFileVersion ? 'md_meta_unreadable' : 'md_only',
    digest_file_version: digestFileVersion,
    digest_version_needs_hash_check: false,
  };
}

function historyItemHasRecordedDigestPath(item = {}) {
  return !!String(item.digest_path || item.digest_relative_path || '').trim();
}

async function regularFileExistsInside(base, targetPath, extension = '', { signal = null } = {}) {
  const status = await regularFileStatusInside(base, targetPath, extension, { signal });
  return status.exists === true && status.readable === true;
}

async function regularFileStatusInside(base, targetPath, extension = '', { signal = null } = {}) {
  throwIfOutputAborted(signal);
  try {
    const file = await assertReadableOutputFile(base, targetPath, { extensions: extension ? [extension] : [], signal });
    throwIfOutputAborted(signal);
    return { exists: true, readable: true, status: 'ok', file };
  } catch (e) {
    if (isOutputAbortError(e)) throw e;
    throwIfOutputAborted(signal);
    if (e?.code === 'output_file_missing' || e?.status === 404) {
      return { exists: false, readable: false, status: 'missing', file: '' };
    }
    if (e?.code === 'output_path_outside_dir' || e?.code === 'UNSAFE_OUTPUT_PATH') {
      return { exists: false, readable: false, status: String(e.code || '').trim(), file: '' };
    }
    return {
      exists: true,
      readable: false,
      status: String(e?.code || 'output_file_unreadable').trim() || 'output_file_unreadable',
      file: '',
    };
  }
}

async function historyDigestFileStatusInside(base, digestPath, { signal = null, expected_digest_id = '', includeVersions = true, saved_digest_file_version = '', validateDigestShape = includeVersions } = {}) {
  throwIfOutputAborted(signal);
  let file = '';
  try {
    file = await assertReadableOutputFile(base, digestPath, { extensions: ['.digest.json'], signal });
  } catch (e) {
    if (isOutputAbortError(e)) throw e;
    if (e?.code === 'output_file_missing' || e?.status === 404) {
      return { digest_exists: false, digest_invalid: false, digest_status: '', digest_file_version: '', digest_version_needs_hash_check: false };
    }
    return {
      digest_exists: true,
      digest_invalid: true,
      digest_status: 'unreadable',
      digest_file_version: '',
      digest_version_needs_hash_check: false,
    };
  }
  throwIfOutputAborted(signal);
  if (!file) return { digest_exists: false, digest_invalid: false, digest_status: '', digest_file_version: '', digest_version_needs_hash_check: false };
  let digestFileVersion = '';
  let digestVersionNeedsHashCheck = false;
  try {
    if (!includeVersions && !validateDigestShape) {
      digestFileVersion = saved_digest_file_version ? await outputFileStatVersion(file, { signal }).catch(() => '') : '';
      if (saved_digest_file_version && digestFileVersion && !outputFileVersionStatMatches(saved_digest_file_version, digestFileVersion)) {
        if (outputFileVersionKind(saved_digest_file_version) === 'v2') {
          digestVersionNeedsHashCheck = true;
        } else {
          return { digest_exists: true, digest_invalid: true, digest_status: 'changed', digest_file_version: digestFileVersion, digest_version_needs_hash_check: false };
        }
      }
      if (saved_digest_file_version && digestFileVersion && outputFileVersionStatMatches(saved_digest_file_version, digestFileVersion)) {
        digestFileVersion = saved_digest_file_version;
      }
      return { digest_exists: true, digest_invalid: false, digest_status: 'unchecked', digest_file_version: digestFileVersion, digest_version_needs_hash_check: digestVersionNeedsHashCheck };
    }
    const digestRead = includeVersions
      ? await readOutputFileBuffer(file, {
        signal,
        max_bytes: HISTORY_DIGEST_JSON_MAX_BYTES,
        missingMessage: '原摘要 JSON 已不存在。',
        missingCode: 'digest_json_missing',
      })
      : {
        data: (await readOutputFileBuffer(file, {
          signal,
          max_bytes: HISTORY_DIGEST_JSON_MAX_BYTES,
          missingMessage: '原摘要 JSON 已不存在。',
          missingCode: 'digest_json_missing',
        })).data,
        file_version: saved_digest_file_version ? await outputFileStatVersion(file, { signal }).catch(() => '') : '',
      };
    const data = digestRead.data;
    digestFileVersion = digestRead.file_version || '';
    if (!digestFileVersion && saved_digest_file_version) {
      digestFileVersion = await outputFileStatVersion(file, { signal }).catch(() => '');
    }
    if (saved_digest_file_version && digestFileVersion) {
      if (includeVersions ? !outputFileVersionMatches(saved_digest_file_version, digestFileVersion) : !outputFileVersionStatMatches(saved_digest_file_version, digestFileVersion)) {
        if (!includeVersions && outputFileVersionKind(saved_digest_file_version) === 'v2') {
          digestVersionNeedsHashCheck = true;
        } else {
          return { digest_exists: true, digest_invalid: true, digest_status: 'changed', digest_file_version: digestFileVersion, digest_version_needs_hash_check: false };
        }
      }
    }
    if (!includeVersions
      && saved_digest_file_version
      && digestFileVersion
      && outputFileVersionStatMatches(saved_digest_file_version, digestFileVersion)) {
      digestFileVersion = saved_digest_file_version;
    }
    throwIfOutputAborted(signal);
    const raw = data.toString('utf-8');
    throwIfOutputAborted(signal);
    const digest = JSON.parse(raw);
    throwIfOutputAborted(signal);
    if (digest && typeof digest === 'object' && !Array.isArray(digest)) {
      if (digestLooksEmptyForHistoryRead(digest)) return { digest_exists: true, digest_invalid: true, digest_status: 'empty', digest_file_version: digestFileVersion, digest_version_needs_hash_check: false };
      if (historyDigestIdMismatch(digest, expected_digest_id)) return { digest_exists: true, digest_invalid: true, digest_status: 'mismatch', digest_file_version: digestFileVersion, digest_version_needs_hash_check: false };
      return { digest_exists: true, digest_invalid: false, digest_status: 'ok', digest_file_version: digestFileVersion, digest_version_needs_hash_check: digestVersionNeedsHashCheck };
    }
    return { digest_exists: true, digest_invalid: true, digest_status: 'invalid', digest_file_version: digestFileVersion, digest_version_needs_hash_check: false };
  } catch (e) {
    if (isOutputAbortError(e)) throw e;
    if (e?.code === 'ENOENT' || e?.code === 'digest_json_missing') return { digest_exists: false, digest_invalid: false, digest_status: '', digest_file_version: '', digest_version_needs_hash_check: false };
    if (e?.code === 'history_file_changed') return { digest_exists: true, digest_invalid: true, digest_status: 'changed', digest_file_version: digestFileVersion, digest_version_needs_hash_check: false };
    return {
      digest_exists: true,
      digest_invalid: true,
      digest_status: e instanceof SyntaxError ? 'invalid' : 'unreadable',
      digest_file_version: digestFileVersion,
      digest_version_needs_hash_check: false,
    };
  }
}

function historyBaseForItem(currentBase, item = {}) {
  const explicit = item?._history_base ? path.resolve(item._history_base) : '';
  if (historyBaseCandidateAllowed(explicit)) return explicit;
  return currentBase;
}

function historyItemArtifactPaths(base, item = {}) {
  const markdown = historyItemIsTextPreviewMarkdown(item);
  const primary = resolveHistoryFilePath(base, item, markdown ? '.md' : '.png');
  const sidecar = markdown
    ? (primary ? previewMarkdownMetaPathForMd(primary) : '')
    : resolveDigestPath(base, item);
  const saveMarker = markdown ? '' : digestSaveTransactionMarkerPath(sidecar);
  const rerenderMarker = markdown ? '' : historyRerenderCommitMarkerPath(sidecar);
  return [...new Set([primary, sidecar, saveMarker, rerenderMarker].filter(Boolean).map(value => path.resolve(value)))];
}

function historyItemNestedOwnerBase(base, item = {}, nestedBases = []) {
  const artifacts = historyItemArtifactPaths(base, item);
  return (Array.isArray(nestedBases) ? nestedBases : [])
    .map(value => path.resolve(String(value || '')))
    .filter(nestedBase => nestedBase && artifacts.some(artifact => isInside(nestedBase, artifact)))
    .sort((a, b) => b.length - a.length)[0] || '';
}

function historyArtifactType(item = {}) {
  const artifact = String(item?.artifact_type || '').trim();
  const fileType = String(item?.file_type || '').trim();
  const target = String(item?.file_path || item?.relative_path || '').trim().toLowerCase();
  return artifact === HISTORY_ARTIFACT_TEXT_PREVIEW_MD || fileType === 'markdown' || target.endsWith('.md')
    ? HISTORY_ARTIFACT_TEXT_PREVIEW_MD
    : HISTORY_ARTIFACT_DIGEST_PNG;
}

function historyItemIsTextPreviewMarkdown(item = {}) {
  return historyArtifactType(item) === HISTORY_ARTIFACT_TEXT_PREVIEW_MD;
}

function exportPolicyRevisionForSettings(settings = {}) {
  return String(settings?.export_policy_revision || settingsExportPolicyRevision(settings)).trim();
}

function normalizeHistoryMarkdownExportPolicy(settings = {}, item = {}, itemBase = '') {
  if (!historyItemIsTextPreviewMarkdown(item)) return item;
  const current = exportPolicyRevisionForSettings(settings);
  const itemRevision = String(item.export_policy_revision || item.export_settings_revision || '').trim();
  if (!current || !itemRevision || itemRevision === current) return item;
  if (!settingsExportPolicyRevisionMatches(settings, itemRevision, { outputDir: itemBase })) return item;
  return {
    ...item,
    export_policy_revision: current,
    export_settings_revision: current,
    export_policy_legacy_revision: itemRevision,
  };
}

function isForeignWindowsAbsolutePath(value = '') {
  const raw = String(value || '').trim();
  return process.platform !== 'win32' && !!raw && path.win32.isAbsolute(raw);
}

function relativeInside(base, targetPath) {
  const resolved = targetPath ? path.resolve(targetPath) : '';
  if (!resolved || !isInside(base, resolved)) return '';
  return path.relative(base, resolved).replace(/\\/g, '/');
}

function resolveHistoryItemPaths(currentBase, item = {}, settings = {}) {
  const itemBase = historyBaseForItem(currentBase, item);
  const filePath = resolveHistoryFilePath(itemBase, item);
  const digestPath = resolveDigestPath(itemBase, { ...item, file_path: filePath || item.file_path });
  const recordedDigestPath = historyItemHasRecordedDigestPath(item);
  return normalizeHistoryMarkdownExportPolicy(settings, {
    ...item,
    _history_recorded_digest_path: recordedDigestPath,
    output_dir_identity: outputDirIdentityForBase(itemBase),
    ...(filePath ? { file_path: filePath, relative_path: toProjectRelative(filePath) } : {}),
    ...(digestPath && recordedDigestPath ? { digest_path: digestPath, digest_relative_path: toProjectRelative(digestPath) } : {}),
  }, itemBase);
}

function resolveHistoryFilePath(base, item = {}, extension = '.png') {
  return resolveHistoryOutputPath(base, item, ['relative_path', 'file_path'], extension);
}

function resolveHistoryOutputPath(base, item = {}, fields = [], extension = '') {
  const safeBase = path.resolve(base || '');
  if (!safeBase) return '';
  const ext = String(extension || '').toLowerCase();
  const candidates = [];
  for (const field of fields) {
    const value = String(item?.[field] || '').trim();
    if (!value) continue;
    if (isForeignWindowsAbsolutePath(value)) continue;
    const rebound = historyOutputPathReboundToBase(safeBase, value, item);
    if (rebound) candidates.push({ target: rebound, projectRelative: false });
    if (path.isAbsolute(value)) {
      candidates.push({ target: path.resolve(value), projectRelative: false });
    } else {
      const looksProjectRelative = historyPathLooksProjectRelativeToOutputs(value, safeBase);
      candidates.push({
        target: path.resolve(PROJECT_ROOT, value),
        projectRelative: looksProjectRelative,
      });
      if (!looksProjectRelative) {
        candidates.push({ target: path.resolve(safeBase, value), projectRelative: false });
      }
    }
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const target = path.resolve(candidate.target || '');
    const seenKey = process.platform === 'win32' ? target.toLowerCase() : target;
    if (!target || seen.has(seenKey)) continue;
    seen.add(seenKey);
    if (!historyOutputCandidateAllowed(safeBase, target, candidate.projectRelative)) continue;
    if (ext && !target.toLowerCase().endsWith(ext)) continue;
    return target;
  }
  return '';
}

function historyOutputPathReboundToBase(safeBase, value = '', item = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let projectRelative = '';
  if (path.isAbsolute(raw)) {
    const absolute = path.resolve(raw);
    if (isInside(safeBase, absolute)) return '';
    if (!isInside(PROJECT_ROOT, absolute)) return '';
    projectRelative = normalizeHistoryRelativePath(toProjectRelative(absolute));
  } else {
    projectRelative = normalizeHistoryRelativePath(raw);
    const projectTarget = path.resolve(PROJECT_ROOT, projectRelative);
    if (historyPathLooksProjectRelativeToOutputs(projectRelative, safeBase) && isInside(safeBase, projectTarget)) return '';
  }
  if (!projectRelative || projectRelative.startsWith('../') || projectRelative === '..') return '';
  const identities = [
    item?._history_root_output_dir_identity,
    item?.output_dir_identity,
  ].map(cleanStoredHistoryOutputIdentity).filter(Boolean);
  for (const identity of new Set(identities)) {
    const valueKey = process.platform === 'win32' ? projectRelative.toLowerCase() : projectRelative;
    const identityKey = process.platform === 'win32' ? identity.toLowerCase() : identity;
    if (!valueKey.startsWith(`${identityKey}/`)) continue;
    const suffix = projectRelative.slice(identity.length + 1);
    if (!suffix || suffix.startsWith('../') || suffix === '..') continue;
    const target = path.resolve(safeBase, suffix);
    if (isInside(safeBase, target)) return target;
  }
  return '';
}

function normalizeHistoryRelativePath(value = '') {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function relativePathStartsWithPath(value = '', prefix = '') {
  const cleanValue = normalizeHistoryRelativePath(value);
  const cleanPrefix = normalizeHistoryRelativePath(prefix).replace(/\/+$/g, '');
  return !!cleanValue && !!cleanPrefix && (cleanValue === cleanPrefix || cleanValue.startsWith(`${cleanPrefix}/`));
}

function historyPathLooksProjectRelativeToOutputs(value = '', safeBase = '') {
  const clean = normalizeHistoryRelativePath(value);
  if (!clean || clean.startsWith('../') || clean === '..') return false;
  return relativePathStartsWithPath(clean, toProjectRelative(OUTPUTS_DIR))
    || relativePathStartsWithPath(clean, toProjectRelative(safeBase));
}

function historyOutputCandidateAllowed(safeBase, targetPath, projectRelative = false) {
  if (projectRelative && !isInside(safeBase, targetPath)) return false;
  if (isInside(safeBase, targetPath)) return true;
  return false;
}

export function historyItemKeyForItem(currentBase, item = {}) {
  const itemBase = historyBaseForItem(currentBase, item);
  const recordId = String(item?.history_record_id || '').trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(recordId)) {
    const scopedIdentity = [outputDirIdentityForBase(itemBase), recordId];
    return crypto.createHash('sha256').update(JSON.stringify(scopedIdentity)).digest('hex');
  }
  const filePath = resolveHistoryFilePath(itemBase, item, historyItemIsTextPreviewMarkdown(item) ? '.md' : '.png');
  const digestPath = resolveDigestPath(itemBase, item);
  const identity = [
    toProjectRelative(itemBase).replace(/\\/g, '/'),
    String(item.digest_id || ''),
    relativeInside(itemBase, filePath),
    relativeInside(itemBase, digestPath),
  ];
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function retentionArtifactDescriptors(base, item = {}) {
  const markdownHistory = historyItemIsTextPreviewMarkdown(item);
  const primaryPath = resolveHistoryFilePath(base, item, markdownHistory ? '.md' : '.png');
  const digestPath = resolveDigestPath(base, item);
  const sidecarPath = markdownHistory && primaryPath ? previewMarkdownMetaPathForMd(primaryPath) : digestPath;
  const markerPath = markdownHistory ? '' : historyRerenderCommitMarkerPath(digestPath);
  const saveMarkerPath = markdownHistory ? '' : digestSaveTransactionMarkerPath(digestPath);
  return [
    { role: 'marker', path: markerPath, extension: '.json', expected_version: '' },
    { role: 'save_marker', path: saveMarkerPath, extension: '.json', expected_version: '' },
    { role: 'sidecar', path: sidecarPath, extension: markdownHistory ? '.json' : '.digest.json', expected_version: markdownHistory ? '' : savedHistoryDigestFileVersion(item), version_required: !markdownHistory },
    { role: 'primary', path: primaryPath, extension: markdownHistory ? '.md' : '.png', expected_version: savedHistoryFileVersion(item), version_required: true },
  ].filter(artifact => artifact.path && isInside(base, artifact.path));
}

function historyRerenderRecordIdForItem(base, item = {}) {
  const explicit = cleanHistoryItemKey(item.history_record_id);
  if (explicit) return explicit;
  const metadata = cleanHistoryRerenderMetadata(item.history_rerender || item.__history_rerender);
  return cleanHistoryItemKey(metadata?.record_id) || cleanHistoryItemKey(historyItemKeyForItem(base, item));
}

function mergeRetentionArtifactDescriptors(...lists) {
  const byPath = new Map();
  for (const list of lists) {
    for (const artifact of Array.isArray(list) ? list : []) {
      const target = String(artifact?.path || '').trim();
      const key = target ? platformPathIdentity(target) : '';
      if (!key) continue;
      const current = byPath.get(key);
      if (!current
        || (current.version_required !== true && artifact.version_required === true)
        || (!current.expected_version && artifact.expected_version)) {
        byPath.set(key, artifact);
      }
    }
  }
  return [...byPath.values()];
}

function historyRerenderCommitArtifactPaths(base, markerPath = '') {
  const marker = path.resolve(String(markerPath || ''));
  if (!marker || !isInside(base, marker) || !/\.digest\.json\.commit\.json$/i.test(marker)) return null;
  const digestPath = marker.replace(/\.commit\.json$/i, '');
  const filePath = digestPath.replace(/\.digest\.json$/i, '.png');
  if (!filePath || !digestPath
    || !isInside(base, filePath)
    || !isInside(base, digestPath)
    || historyPathDedupeKey(historyRerenderCommitMarkerPath(digestPath)) !== historyPathDedupeKey(marker)) {
    return null;
  }
  return { marker_path: marker, digest_path: digestPath, file_path: filePath };
}

function historyRerenderRetentionArtifactsForMarker(base, paths = {}, marker = {}, metadata = {}, markerVersion = '') {
  const filePath = String(paths.file_path || '').trim();
  const digestPath = String(paths.digest_path || '').trim();
  const markerPath = String(paths.marker_path || '').trim();
  const expectedPngVersion = String(marker.saved_file_version || '').trim();
  const expectedDigestVersion = String(marker.saved_digest_file_version || '').trim();
  const out = [
    { role: 'marker', path: markerPath, extension: '.json', expected_version: markerVersion, version_required: true },
    { role: 'sidecar', path: digestPath, extension: '.digest.json', expected_version: expectedDigestVersion, version_required: true },
    { role: 'primary', path: filePath, extension: '.png', expected_version: expectedPngVersion, version_required: true },
  ].filter(artifact => artifact.path && outputFileVersionKind(artifact.expected_version) === 'v2');
  const source = historyRerenderSourceArtifactPaths(base, metadata);
  const digestId = String(marker.digest_id || '').trim();
  if (!source || source.source.digest_id !== digestId) return out;
  const sourceFileVersion = String(marker.source_file_version || '').trim();
  const sourceDigestVersion = String(marker.source_digest_file_version || '').trim();
  if (outputFileVersionKind(sourceFileVersion) === 'v2') {
    out.push({ role: 'primary', path: source.filePath, extension: '.png', expected_version: sourceFileVersion, version_required: true });
  }
  if (outputFileVersionKind(sourceDigestVersion) === 'v2') {
    out.push({ role: 'sidecar', path: source.digestPath, extension: '.digest.json', expected_version: sourceDigestVersion, version_required: true });
  }
  return out;
}

async function discoverHistoryRerenderRetentionArtifacts(base, recordIds = new Set(), { signal = null, excludeRoots = [] } = {}) {
  const wanted = new Set([...recordIds].map(cleanHistoryItemKey).filter(Boolean));
  if (!wanted.size) return new Map();
  const markerFiles = [];
  await collectHistoryRerenderCommitMarkerFiles(base, markerFiles, base, { signal, excludeRoots });
  const byRecord = new Map();
  for (const markerPath of markerFiles) {
    throwIfOutputAborted(signal);
    const paths = historyRerenderCommitArtifactPaths(base, markerPath);
    if (!paths) continue;
    const digest = await readJson(paths.digest_path, null, {
      strict: false,
      maxBytes: HISTORY_DIGEST_JSON_MAX_BYTES,
      signal,
    }).catch(error => {
      if (isOutputAbortError(error)) throw error;
      return null;
    });
    const metadata = cleanHistoryRerenderMetadata(digest?.__history_rerender);
    const digestId = String(digest?.digest_id || '').trim();
    const recordId = cleanHistoryItemKey(metadata?.record_id);
    if (!metadata || !digestId || !recordId || !wanted.has(recordId)) continue;
    const marker = await historyRerenderCommitMarkerValid(base, paths.file_path, paths.digest_path, digestId, metadata, { signal });
    if (!marker) continue;
    const markerVersion = await outputFileVersion(paths.marker_path, { signal }).catch(error => {
      if (isOutputAbortError(error)) throw error;
      return '';
    });
    if (outputFileVersionKind(markerVersion) !== 'v2') continue;
    const artifacts = historyRerenderRetentionArtifactsForMarker(base, paths, marker, metadata, markerVersion);
    if (!artifacts.length) continue;
    byRecord.set(recordId, mergeRetentionArtifactDescriptors(byRecord.get(recordId), artifacts));
  }
  return byRecord;
}

async function discoverNestedHistoryBasesForMutation(base, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const { realOutputs, realTmp, realBase } = await assertRealOutputDir(base);
  throwIfOutputAborted(signal);
  const scan = createHistoryBaseDiscoveryScan({ realOutputs, realTmp, realBase });
  scan.pending_dirs = [{ dir: realBase, insideHistoryBase: false }];
  const nestedBases = [];
  await collectHistoryIndexDirs(realBase, nestedBases, {
    realOutputs,
    realTmp,
    limit: HISTORY_BASE_DISCOVERY_LIMIT,
    discovery: scan,
    signal,
  });
  throwIfOutputAborted(signal);
  const incomplete = scan.pending_dirs.length > 0 || scan.limit_reached || scan.visit_limit_reached;
  if (incomplete || scan.warnings.length) {
    throw Object.assign(new Error('历史目录归属扫描未完成，已停止修改文件，避免误操作嵌套旧输出目录。请检查输出目录权限或减少目录层级后重试。'), {
      status: 500,
      code: 'history_ownership_scan_incomplete',
      public_code: 'history_ownership_scan_incomplete',
      pending_dir_count: scan.pending_dirs.length,
      warning_count: scan.warnings.length,
    });
  }
  return historyRebuildExcludeRoots(realBase, nestedBases);
}

async function assertHistoryItemOwnedByBase(base, item, { signal = null } = {}) {
  const nestedBases = await discoverNestedHistoryBasesForMutation(base, { signal });
  if (!historyItemNestedOwnerBase(base, item, nestedBases)) return nestedBases;
  throw Object.assign(new Error('这条历史实际属于嵌套的旧输出目录，已停止修改；请刷新历史页后重试。'), {
    status: 409,
    code: 'history_item_root_changed',
    public_code: 'history_item_root_changed',
  });
}

export async function cleanupOldDigests(settings, { commitBarrier = null } = {}) {
  const days = Number(settings.output?.retention_days || 0);
  return withHistoryWriteLock(async () => {
    const base = await safeOutputBase(settings);
    const nestedBases = await discoverNestedHistoryBasesForMutation(base);
    const recovery = await recoverInterruptedRetentionCleanup(settings, base, { excludeRoots: nestedBases });
    if (!Number.isFinite(days) || days <= 0) {
      return { removed: 0, pruned: 0, detached: 0, blocked: 0, recovered: recovery.restored, finalized: recovery.finalized, preserved: recovery.preserved };
    }
    const dependencyView = await readCompleteHistoryDependencyState(settings);
    if (!dependencyView.complete) {
      return {
        removed: 0,
        pruned: 0,
        detached: 0,
        blocked: 0,
        recovered: recovery.restored,
        finalized: recovery.finalized,
        preserved: recovery.preserved,
        skipped: true,
        skipped_reason: 'history_dependency_scan_incomplete',
        history_base_count: dependencyView.history_base_count,
        history_base_pending_dir_count: dependencyView.history_base_pending_dir_count,
        history_base_scan_pass_count: dependencyView.history_base_scan_pass_count,
        history_base_visited_dir_count: dependencyView.history_base_visited_dir_count,
        history_base_discovery_warning_count: dependencyView.history_base_discovery_warning_count,
      };
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const indexed = await readHistoryIndexFromBase(settings, base, { rebuildExcludeBases: nestedBases });
    const detached = indexed.filter(item => historyItemNestedOwnerBase(base, item, nestedBases)).length;
    const list = indexed.filter(item => !historyItemNestedOwnerBase(base, item, nestedBases));
    const rerenderRecordIds = new Set(list
      .map(item => historyRerenderRecordIdForItem(base, item))
      .filter(Boolean));
    const rerenderArtifactsByRecord = await discoverHistoryRerenderRetentionArtifacts(base, rerenderRecordIds, {
      excludeRoots: nestedBases,
    });
    const entries = (Array.isArray(list) ? list : []).map(item => {
      const created = historyItemSortTimeMs(item);
      const expired = Number.isFinite(created) && created > 0 && created < cutoff;
      const recordId = historyRerenderRecordIdForItem(base, item);
      const artifacts = mergeRetentionArtifactDescriptors(
        retentionArtifactDescriptors(base, item),
        recordId ? rerenderArtifactsByRecord.get(recordId) : [],
      );
      const primary = artifacts.find(artifact => artifact.role === 'primary') || null;
      return { item, created, expired, artifacts, removable: expired && !!primary };
    });
    const retainedMarkdownSourceKeys = new Set([
      ...(dependencyView.state?.external_markdown_source_keys || []),
      ...entries
        .filter(entry => !entry.removable && historyItemIsTextPreviewMarkdown(entry.item))
        .map(entry => cleanHistoryItemKey(entry.item.source_history_item_key))
        .filter(Boolean),
    ]);
    for (const entry of entries) {
      if (!entry.removable || historyItemIsTextPreviewMarkdown(entry.item)) continue;
      const itemKeys = cleanHistoryItemKeyAliases([
        historyItemKeyForItem(base, entry.item),
        ...historyItemKeyAliases(base, entry.item),
      ]);
      if (!itemKeys.some(itemKey => retainedMarkdownSourceKeys.has(itemKey))) continue;
      entry.removable = false;
      entry.retained_by_markdown_dependency = true;
    }
    const retainedArtifactKeys = new Set();
    for (const entry of entries) {
      if (entry.removable) continue;
      for (const artifact of entry.artifacts) retainedArtifactKeys.add(platformPathIdentity(artifact.path));
    }
    const kept = [];
    let pruned = 0;
    let blocked = 0;
    let changed = detached > 0;
    const stagedArtifactsByPath = new Map();

    for (const entry of entries) {
      const { item, created, expired, artifacts, removable } = entry;
      if (!Number.isFinite(created) || created <= 0) {
        blocked++;
        kept.push(item);
        continue;
      }
      if (!expired) {
        kept.push(item);
        continue;
      }
      if (!removable) {
        blocked++;
        kept.push(item);
        continue;
      }
      let stageFailed = false;
      for (const artifact of artifacts) {
        const key = platformPathIdentity(artifact.path);
        if (retainedArtifactKeys.has(key) || stagedArtifactsByPath.has(key)) continue;
        const staged = await stageExpiredHistoryFile(base, artifact.path, artifact.extension, {
          expectedVersion: artifact.expected_version,
          versionRequired: artifact.version_required === true,
          role: artifact.role,
        });
        if (!staged.ready) {
          if (staged.staged_path) stagedArtifactsByPath.set(key, { ...staged, role: artifact.role });
          stageFailed = true;
          break;
        }
        if (staged.staged_path) stagedArtifactsByPath.set(key, { ...staged, role: artifact.role });
      }
      if (stageFailed) {
        const rollbackStages = [];
        for (const artifact of artifacts) {
          const key = platformPathIdentity(artifact.path);
          const staged = stagedArtifactsByPath.get(key);
          if (!staged) continue;
          rollbackStages.push({ key, staged });
        }
        const rollback = await Promise.allSettled(rollbackStages.map(entry => rollbackExpiredHistoryFile(entry.staged)));
        const rollbackFailures = rollback.filter(result => result.status === 'rejected');
        rollback.forEach((result, index) => {
          if (result.status === 'fulfilled' || result.reason?.file_restored === true) {
            stagedArtifactsByPath.delete(rollbackStages[index].key);
          }
        });
        if (rollbackFailures.length) {
          throw Object.assign(new Error(`历史文件暂存失败，且有 ${rollbackFailures.length} 个事务未能完整回滚；索引未修改。`), {
            status: 500,
            code: 'retention_stage_rollback_failed',
            public_code: 'retention_stage_rollback_failed',
            rollback_failed_count: rollbackFailures.length,
          });
        }
        for (const artifact of artifacts) retainedArtifactKeys.add(platformPathIdentity(artifact.path));
        blocked++;
        kept.push(item);
        continue;
      }
      pruned++;
      changed = true;
    }

    const stagedArtifacts = [...stagedArtifactsByPath.values()];
    let removed = 0;
    if (changed) {
      const safeBase = await safeOutputBase(settings);
      const file = path.join(safeBase, 'index.json');
      await assertSafeOutputParent(safeBase, file);
      let indexCommitted = false;
      try {
        const commitIndex = async () => {
          await writeHistoryIndexAtomic(file, kept);
        };
        if (typeof commitBarrier === 'function') await commitBarrier(commitIndex);
        else await commitIndex();
        indexCommitted = true;
      } catch (error) {
        const observed = await retentionIndexCommitObserved(settings, base, {
          committedItems: kept,
          previousItems: indexed,
          stagedArtifacts,
        }).catch(() => null);
        if (observed === true) {
          indexCommitted = true;
        } else if (observed === false) {
          const rollback = await Promise.allSettled(stagedArtifacts.map(rollbackExpiredHistoryFile));
          const rollbackFailures = rollback.filter(result => result.status === 'rejected');
          if (rollbackFailures.length) {
            throw Object.assign(new Error(`历史清理索引写入失败，且有 ${rollbackFailures.length} 个暂存文件未能恢复；已停止继续删除。`), {
              status: 500,
              code: 'retention_cleanup_rollback_failed',
              public_code: 'retention_cleanup_rollback_failed',
              original_error: error?.message || String(error || 'index write failed'),
              rollback_failed_count: rollbackFailures.length,
            });
          }
          throw error;
        } else {
          throw Object.assign(new Error('历史清理索引写入结果无法确认；已保留事务清单和暂存文件，等待下次启动按磁盘索引恢复。'), {
            status: 500,
            code: 'retention_cleanup_commit_unknown',
            public_code: 'retention_cleanup_commit_unknown',
            original_error: error?.message || String(error || 'index write failed'),
            pending_transaction_count: stagedArtifacts.length,
          });
        }
      }
      if (indexCommitted) {
        invalidateHistoryCaches({ discovery: true });
        const finalized = await Promise.allSettled(stagedArtifacts.map(removeStagedExpiredHistoryFile));
        const finalizeFailures = finalized.filter(result => result.status === 'rejected');
        removed = finalized.reduce((count, result, index) => (
          count + (result.status === 'fulfilled' && result.value === true && stagedArtifacts[index]?.role === 'primary' ? 1 : 0)
        ), 0);
        if (finalizeFailures.length) {
          throw Object.assign(new Error(`历史索引已提交，但有 ${finalizeFailures.length} 个清理事务未能完整收尾；未冒充清理成功。`), {
            status: 500,
            code: 'retention_cleanup_finalize_failed',
            public_code: 'retention_cleanup_finalize_failed',
            index_committed: true,
            finalize_failed_count: finalizeFailures.length,
            finalized_primary_count: removed,
          });
        }
      }
    }
    return { removed, pruned, detached, blocked, recovered: recovery.restored, finalized: recovery.finalized, preserved: recovery.preserved };
  });
}

function historyDeleteError(message = '历史记录删除失败。', code = 'history_delete_failed', status = 409, detail = {}) {
  return Object.assign(new Error(message), { status, code, public_code: code, ...detail });
}

function assertHistoryDeleteExpectedVersion(expected = '', actual = '', label = '历史文件') {
  const cleanExpected = String(expected || '').trim();
  const cleanActual = String(actual || '').trim();
  if (!cleanExpected) {
    throw historyDeleteError(`缺少${label}版本，请刷新历史页后重试。`, 'history_delete_version_required', 428);
  }
  if (cleanExpected === OUTPUT_FILE_EXPECTED_MISSING_VERSION) {
    if (cleanActual === OUTPUT_FILE_EXPECTED_MISSING_VERSION) return;
    throw historyDeleteError(`${label}已重新出现，已停止删除；请刷新历史页核对。`, 'history_delete_target_changed');
  }
  if (cleanActual && outputFileVersionMatches(cleanExpected, cleanActual)) return;
  throw historyDeleteError(`${label}已变化，已停止删除；请刷新历史页核对。`, 'history_delete_target_changed');
}

async function rollbackHistoryDeleteStages(stagedArtifacts = [], originalError = null) {
  const rollback = await Promise.allSettled(stagedArtifacts.map(rollbackExpiredHistoryFile));
  const failed = rollback.filter(result => result.status === 'rejected');
  if (!failed.length) return;
  throw historyDeleteError('历史删除未提交，且部分暂存文件未能恢复；索引未修改，请刷新后核对。', 'history_delete_rollback_failed', 500, {
    original_error: originalError?.message || String(originalError || ''),
    rollback_failed_count: failed.length,
  });
}

export async function deleteHistoryItem(settings, digestId, lookup = {}, { signal = null } = {}) {
  return withHistoryWriteLock(async () => {
    throwIfOutputAborted(signal);
    const id = String(digestId || lookup?.digest_id || '').trim();
    const requestedKey = cleanHistoryItemKey(lookup?.history_item_key || lookup?.historyItemKey || lookup?.key);
    if (!id || !requestedKey) {
      throw historyDeleteError('缺少可唯一定位的历史记录，请刷新历史页后重试。', 'history_delete_identity_required', 428);
    }
    const dependencyView = await readCompleteHistoryDependencyState(settings, { signal });
    if (!dependencyView.complete) {
      throw historyDeleteError(
        '历史目录依赖还没有扫描完整，已停止删除，避免误删仍被其他输出目录 MD 引用的摘要。请刷新历史页继续扫描后重试。',
        'history_dependency_scan_incomplete',
        409,
        {
          pending_dir_count: dependencyView.history_base_pending_dir_count,
          scan_pass_count: dependencyView.history_base_scan_pass_count,
          visited_dir_count: dependencyView.history_base_visited_dir_count,
          history_base_count: dependencyView.history_base_count,
          warning_count: dependencyView.history_base_discovery_warning_count,
        },
      );
    }
    const currentBase = dependencyView.current_base;
    const combinedState = dependencyView.state;
    const combined = combinedState.items;
    throwIfOutputAborted(signal);
    const combinedItem = historyItemsByKey(currentBase, combined).get(requestedKey);
    if (!combinedItem || String(combinedItem.digest_id || '').trim() !== id) {
      throw historyDeleteError('这条历史已不存在或列表已变化，请刷新历史页。', 'history_item_missing', 404);
    }
    const base = historyBaseForItem(currentBase, combinedItem);
    const actualOutputIdentity = outputDirIdentityForBase(base);
    const expectedOutputIdentity = String(lookup?.expected_output_dir_identity || lookup?.output_dir_identity || '').trim();
    if (!expectedOutputIdentity) {
      throw historyDeleteError('缺少历史输出目录身份，请刷新历史页后重试。', 'history_delete_output_identity_required', 428);
    }
    if (expectedOutputIdentity !== actualOutputIdentity) {
      throw historyDeleteError('历史输出目录已变化，已停止删除；请刷新历史页核对。', 'history_delete_output_changed');
    }

    const nestedBases = await assertHistoryItemOwnedByBase(base, combinedItem, { signal });
    await recoverInterruptedRetentionCleanup(settings, base, { excludeRoots: nestedBases, signal });
    const indexed = await readHistoryIndexFromBase(settings, base, {
      rebuildExcludeBases: nestedBases,
      signal,
    });
    throwIfOutputAborted(signal);
    const indexedByKey = historyItemsByKey(base, indexed);
    const target = indexedByKey.get(requestedKey);
    if (!target || String(target.digest_id || '').trim() !== id) {
      throw historyDeleteError('这条历史已不存在或索引已变化，请刷新历史页。', 'history_item_missing', 404);
    }
    const targetKey = historyItemKeyForItem(base, target);
    const targetKeyAliases = new Set(historyItemKeyAliases(base, target));
    targetKeyAliases.add(targetKey);
    const sourceDependentsByKey = new Map();
    for (const item of combinedState.markdown_dependency_items) {
      const itemKey = historyItemKeyForItem(currentBase, item);
      if (itemKey === requestedKey || !targetKeyAliases.has(cleanHistoryItemKey(item?.source_history_item_key))) continue;
      sourceDependentsByKey.set(itemKey, item);
    }
    const sourceDependents = [...sourceDependentsByKey.values()];
    if (sourceDependents.length) {
      throw historyDeleteError(`仍有 ${sourceDependents.length} 条导出 MD 引用这条摘要，已停止删除；请先删除对应 MD。`, 'history_delete_has_dependents', 409, {
        dependent_count: sourceDependents.length,
        dependent_items: sourceDependents.slice(0, 20).map(item => ({
          artifact_type: item?.artifact_type,
          file_type: item?.file_type,
          digest_id: item?.digest_id,
          group: item?.group,
          created_at: item?.created_at,
          history_item_key: historyItemKeyForItem(currentBase, item),
          history_current: item?.history_current,
          has_blocking_issue: item?.has_blocking_issue,
          blocking_issue_reason: item?.blocking_issue_reason,
        })),
      });
    }

    const statusItem = await historyItemWithFileStatus(base, target, {
      signal,
      includeVersions: true,
      sourceItemsByKey: historyItemsByKey(currentBase, combined),
    });
    const actualFileVersion = statusItem.file_exists === false
      ? OUTPUT_FILE_EXPECTED_MISSING_VERSION
      : String(statusItem.file_version || '').trim();
    const actualDigestVersion = statusItem.digest_exists === false
      ? OUTPUT_FILE_EXPECTED_MISSING_VERSION
      : String(statusItem.digest_file_version || '').trim();
    assertHistoryDeleteExpectedVersion(lookup?.expected_file_version, actualFileVersion, historyItemIsTextPreviewMarkdown(target) ? 'MD 文件' : 'PNG 文件');
    assertHistoryDeleteExpectedVersion(lookup?.expected_digest_file_version, actualDigestVersion, historyItemIsTextPreviewMarkdown(target) ? 'MD 元数据' : '摘要 JSON');

    const directArtifacts = retentionArtifactDescriptors(base, target).map(artifact => {
      if (artifact.role === 'primary') {
        return { ...artifact, expected_version: String(lookup.expected_file_version || '').trim(), version_required: true };
      }
      if (artifact.role === 'sidecar') {
        return { ...artifact, expected_version: String(lookup.expected_digest_file_version || '').trim(), version_required: true };
      }
      return artifact;
    });
    const rerenderRecordId = historyRerenderRecordIdForItem(base, target);
    const rerenderArtifactsByRecord = rerenderRecordId
      ? await discoverHistoryRerenderRetentionArtifacts(base, new Set([rerenderRecordId]), {
          signal,
          excludeRoots: nestedBases,
        })
      : new Map();
    // A visible rerender row owns its entire verified superseded chain. Leaving
    // an older committed version behind lets index reconstruction resurrect a
    // record the user explicitly deleted. Independently indexed source files
    // remain protected by retainedArtifactKeys below.
    const targetArtifacts = mergeRetentionArtifactDescriptors(
      directArtifacts,
      rerenderRecordId ? rerenderArtifactsByRecord.get(rerenderRecordId) : [],
    );
    const retainedArtifactKeys = new Set();
    for (const item of indexed) {
      if (historyItemKeyForItem(base, item) === targetKey) continue;
      for (const artifact of retentionArtifactDescriptors(base, item)) {
        retainedArtifactKeys.add(platformPathIdentity(artifact.path));
      }
    }

    const stagedArtifacts = [];
    try {
      for (const artifact of targetArtifacts) {
        throwIfOutputAborted(signal);
        if (retainedArtifactKeys.has(platformPathIdentity(artifact.path))) continue;
        const staged = await stageExpiredHistoryFile(base, artifact.path, artifact.extension, {
          expectedVersion: artifact.expected_version,
          versionRequired: artifact.version_required === true,
          role: artifact.role,
        });
        if (!staged.ready) {
          throw staged.error || historyDeleteError('历史文件无法进入安全删除事务。', 'history_delete_stage_failed', 500);
        }
        if (staged.staged_path) stagedArtifacts.push({ ...staged, role: artifact.role });
      }
    } catch (error) {
      await rollbackHistoryDeleteStages(stagedArtifacts, error);
      throw error;
    }

    const kept = indexed.filter(item => historyItemKeyForItem(base, item) !== targetKey);
    const indexFile = path.join(base, 'index.json');
    await assertSafeOutputParent(base, indexFile);
    try {
      await writeHistoryIndexAtomic(indexFile, kept);
    } catch (error) {
      const observed = await retentionIndexCommitObserved(settings, base, {
        committedItems: kept,
        previousItems: indexed,
        stagedArtifacts,
      }).catch(() => null);
      if (observed !== true) {
        if (observed === false) await rollbackHistoryDeleteStages(stagedArtifacts, error);
        throw historyDeleteError(
          observed === false
            ? '历史索引写入失败，文件已恢复，本次没有删除。'
            : '历史索引写入结果无法确认；已保留删除事务，刷新历史页后会自动核对。',
          observed === false ? 'history_delete_index_failed' : 'history_delete_commit_unknown',
          500,
          {
            original_error: error?.message || String(error || ''),
            mutation_outcome_unknown: observed !== false,
          },
        );
      }
    }
    invalidateHistoryCaches({ discovery: true });
    const finalized = await Promise.allSettled(stagedArtifacts.map(removeStagedExpiredHistoryFile));
    const finalizeFailedCount = finalized.filter(result => result.status === 'rejected').length;
    return {
      deleted: true,
      history_item_key: targetKey,
      digest_id: id,
      removed_file_count: finalized.filter(result => result.status === 'fulfilled' && result.value === true).length,
      cleanup_pending: finalizeFailedCount > 0,
      cleanup_pending_count: finalizeFailedCount,
    };
  });
}

export async function findHistoryItem(settings, digestId, lookup = {}, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const id = String(digestId || '').trim();
  if (!id) return null;
  const base = await safeOutputBase(settings);
  throwIfOutputAborted(signal);
  const list = await readCombinedHistoryIndex(settings, { signal, shareInFlight: true });
  throwIfOutputAborted(signal);
  const key = String(lookup?.history_item_key || lookup?.historyItemKey || lookup?.key || '').trim();
  if (key) {
    const indexed = historyItemsByKey(base, list).get(cleanHistoryItemKey(key));
    if (!indexed || indexed.digest_id !== id) return null;
    assertHistoryItemLookupSnapshot(base, indexed, lookup);
    return indexed;
  }
  const matches = list.filter(item => item.digest_id === id);
  if (matches.length > 1 && lookup?.require_history_item_key_for_duplicate) {
    throw Object.assign(new Error('检测到多条同编号历史记录，请刷新页面后从具体历史卡片重新操作。'), {
      status: 409,
      code: 'history_item_key_required',
    });
  }
  return matches[0] || null;
}

function historyItemChangedError(field = '') {
  const labels = {
    relative_path: '文件路径',
    digest_relative_path: '摘要路径',
    history_output_relative_path: '输出目录',
    created_at: '创建时间',
    artifact_type: '记录类型',
    file_type: '文件类型',
    expected_output_dir_identity: '输出目录身份',
  };
  const label = labels[String(field || '').trim()] || '记录身份';
  return Object.assign(new Error(`历史记录的${label}已变化；已停止操作旧页面中的目标，请刷新历史页后重试。`), {
    status: 409,
    code: 'history_item_changed',
    public_code: 'history_item_changed',
    changed_field: String(field || '').trim(),
  });
}

function historyLookupPathIdentity(value = '') {
  const normalized = normalizeHistoryRelativePath(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertHistoryLookupValue(field, expected = '', current = '', { pathValue = false } = {}) {
  const requested = String(expected || '').trim();
  if (!requested) return;
  const actual = String(current || '').trim();
  const requestedIdentity = pathValue ? historyLookupPathIdentity(requested) : requested;
  const actualIdentity = pathValue ? historyLookupPathIdentity(actual) : actual;
  if (!actualIdentity || requestedIdentity !== actualIdentity) throw historyItemChangedError(field);
}

function assertHistoryItemLookupSnapshot(currentBase, item = {}, lookup = {}) {
  const itemBase = historyBaseForItem(currentBase, item);
  const markdown = historyItemIsTextPreviewMarkdown(item);
  const filePath = resolveHistoryFilePath(itemBase, item, markdown ? '.md' : '.png');
  const digestPath = markdown ? '' : resolveDigestPath(itemBase, item);
  const currentRelativePath = filePath ? toProjectRelative(filePath) : String(item.relative_path || '').trim();
  const currentDigestRelativePath = digestPath
    ? toProjectRelative(digestPath)
    : String(item.digest_relative_path || '').trim();
  assertHistoryLookupValue('relative_path', lookup?.relative_path, currentRelativePath, { pathValue: true });
  assertHistoryLookupValue('digest_relative_path', lookup?.digest_relative_path, currentDigestRelativePath, { pathValue: true });
  assertHistoryLookupValue('history_output_relative_path', lookup?.history_output_relative_path, toProjectRelative(itemBase), { pathValue: true });
  assertHistoryLookupValue('created_at', lookup?.created_at, item.created_at);
  if (String(lookup?.artifact_type || '').trim()) {
    assertHistoryLookupValue('artifact_type', lookup.artifact_type, historyArtifactType(item));
  }
  if (String(lookup?.file_type || '').trim()) {
    const currentFileType = markdown ? 'markdown' : 'png';
    assertHistoryLookupValue('file_type', lookup.file_type, currentFileType);
  }
  if (String(lookup?.expected_output_dir_identity || '').trim()) {
    assertHistoryLookupValue(
      'expected_output_dir_identity',
      lookup.expected_output_dir_identity,
      outputDirIdentityForBase(itemBase),
      { pathValue: true },
    );
  }
}

export async function findHistoryItemWithStatus(settings, digestId, lookup = {}, { signal = null } = {}) {
  const item = await findHistoryItem(settings, digestId, lookup, { signal });
  if (!item) return null;
  throwIfOutputAborted(signal);
  const base = await safeOutputBase(settings);
  const allItems = await readCombinedHistoryIndex(settings, { signal, shareInFlight: true });
  throwIfOutputAborted(signal);
  const statusItem = await historyItemWithFileStatus(base, item, {
    signal,
    includeVersions: true,
    sourceItemsByKey: historyItemsByKey(base, allItems),
  });
  const currentExportPolicyRevision = exportPolicyRevisionForSettings(settings);
  const issueReason = historyItemBlockingIssueReason(statusItem, currentExportPolicyRevision);
  return {
    ...statusItem,
    has_blocking_issue: !!issueReason,
    blocking_issue_reason: issueReason,
    blocking_issue_policy_revision: currentExportPolicyRevision,
  };
}

export async function readHistoryDigest(settings, digestId) {
  const result = await readHistoryDigestResult(settings, digestId);
  return result.digest;
}

export function outputFileVersionFromStat(stat = null) {
  if (!stat?.isFile?.()) return '';
  const fingerprint = outputFileStatFingerprint(stat);
  return fingerprint ? `v1:${fingerprint}` : '';
}

function outputFileStatFingerprint(stat = null) {
  if (!stat?.isFile?.()) return '';
  const size = Number(stat.size || 0) || 0;
  const mtime = Math.round((Number(stat.mtimeMs || 0) || 0) * 1000);
  const ctime = Math.round((Number(stat.ctimeMs || 0) || 0) * 1000);
  return `${size}:${mtime}:${ctime}`;
}

function outputFileContentFingerprint(stat = null) {
  if (!stat?.isFile?.()) return '';
  const size = Number(stat.size || 0) || 0;
  const mtime = Math.round((Number(stat.mtimeMs || 0) || 0) * 1000);
  return `${size}:${mtime}`;
}

function outputFileVersionFromHash(stat = null, sha256 = '') {
  const fingerprint = outputFileStatFingerprint(stat);
  const hash = String(sha256 || '').trim().toLowerCase();
  if (!fingerprint || !/^[a-f0-9]{64}$/.test(hash)) return '';
  return `v2:${fingerprint}:${hash}`;
}

function outputFileVersionFromBuffer(stat = null, data = Buffer.alloc(0)) {
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  return outputFileVersionFromHash(stat, hash);
}

function outputFileVersionCacheKey(filePath = '', stat = null) {
  const fingerprint = outputFileStatFingerprint(stat);
  const resolved = String(filePath || '').trim() ? platformPathIdentity(path.resolve(String(filePath))) : '';
  if (!resolved || !fingerprint) return '';
  const device = typeof stat?.dev === 'bigint' ? stat.dev.toString() : String(Number(stat?.dev || 0) || 0);
  const inode = typeof stat?.ino === 'bigint' ? stat.ino.toString() : String(Number(stat?.ino || 0) || 0);
  return `${resolved}\0${device}:${inode}\0${fingerprint}`;
}

function cachedOutputFileVersion(cacheKey = '') {
  const key = String(cacheKey || '');
  if (!key) return '';
  const version = String(outputFileVersionCache.get(key) || '').trim();
  if (outputFileVersionKind(version) !== 'v2') {
    outputFileVersionCache.delete(key);
    return '';
  }
  outputFileVersionCache.delete(key);
  outputFileVersionCache.set(key, version);
  return version;
}

function rememberOutputFileVersion(cacheKey = '', version = '') {
  const key = String(cacheKey || '');
  const cleanVersion = String(version || '').trim();
  if (!key || outputFileVersionKind(cleanVersion) !== 'v2') return cleanVersion;
  outputFileVersionCache.delete(key);
  outputFileVersionCache.set(key, cleanVersion);
  while (outputFileVersionCache.size > OUTPUT_FILE_VERSION_CACHE_LIMIT) {
    outputFileVersionCache.delete(outputFileVersionCache.keys().next().value);
  }
  return cleanVersion;
}

function cachedValidatedOutputPng(cacheKey = '') {
  const key = String(cacheKey || '');
  if (!key || validatedOutputPngCache.get(key) !== true) return false;
  validatedOutputPngCache.delete(key);
  validatedOutputPngCache.set(key, true);
  return true;
}

function rememberValidatedOutputPng(cacheKey = '') {
  const key = String(cacheKey || '');
  if (!key) return false;
  validatedOutputPngCache.delete(key);
  validatedOutputPngCache.set(key, true);
  while (validatedOutputPngCache.size > OUTPUT_FILE_VERSION_CACHE_LIMIT) {
    validatedOutputPngCache.delete(validatedOutputPngCache.keys().next().value);
  }
  return true;
}

async function outputFileCacheState(filePath = '', { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const stat = await fsp.stat(filePath).catch(() => null);
  throwIfOutputAborted(signal);
  const cacheKey = outputFileVersionCacheKey(filePath, stat);
  return {
    cacheKey,
    statVersion: outputFileVersionFromStat(stat),
    strongVersion: cachedOutputFileVersion(cacheKey),
    pngValidated: cachedValidatedOutputPng(cacheKey),
  };
}

function normalizedOutputFileVersionMaxBytes(value = 0) {
  const bytes = Number(value || 0);
  return Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
}

function outputFileVersionTooLargeError(maxBytes = 0, actualBytes = 0, { code = 'output_file_version_too_large', message = '' } = {}) {
  const safeMax = Math.max(0, Number(maxBytes || 0) || 0);
  const safeActual = Math.max(0, Number(actualBytes || 0) || 0);
  const error = new Error(message || `文件超过 ${formatOutputByteSize(safeMax)} 的版本核验上限，已停止读取。`);
  error.status = 413;
  error.code = String(code || 'output_file_version_too_large');
  error.public_code = error.code;
  error.max_bytes = safeMax;
  error.bytes = safeActual;
  return error;
}

function assertOutputFileVersionSize(maxBytes = 0, actualBytes = 0, options = {}) {
  if (!maxBytes || Number(actualBytes || 0) <= maxBytes) return;
  throw outputFileVersionTooLargeError(maxBytes, actualBytes, options);
}

async function hashOutputFileHandle(handle, { signal = null, shouldAbort = null, max_bytes = 0, too_large_code = '', too_large_message = '' } = {}) {
  const maxBytes = normalizedOutputFileVersionMaxBytes(max_bytes);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    throwIfOutputAborted(signal, shouldAbort);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    assertOutputFileVersionSize(maxBytes, position + bytesRead, {
      code: too_large_code,
      message: too_large_message,
    });
    hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  throwIfOutputAborted(signal, shouldAbort);
  return hash.digest('hex');
}

export async function outputFileVersion(filePath, { signal = null, shouldAbort = null, max_bytes = 0, too_large_code = '', too_large_message = '' } = {}) {
  const maxBytes = normalizedOutputFileVersionMaxBytes(max_bytes);
  throwIfOutputAborted(signal, shouldAbort);
  let handle = null;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch (e) {
    if (e?.code === 'ENOENT') return '';
    throw e;
  }
  try {
    throwIfOutputAborted(signal, shouldAbort);
    const beforeStat = await handle.stat();
    if (!beforeStat?.isFile?.()) return '';
    assertOutputFileVersionSize(maxBytes, beforeStat.size, {
      code: too_large_code,
      message: too_large_message,
    });
    const beforeContentFingerprint = outputFileContentFingerprint(beforeStat);
    const sha256 = await hashOutputFileHandle(handle, {
      signal,
      shouldAbort,
      max_bytes: maxBytes,
      too_large_code,
      too_large_message,
    });
    const afterStat = await handle.stat();
    if (!afterStat?.isFile?.()) return '';
    assertOutputFileVersionSize(maxBytes, afterStat.size, {
      code: too_large_code,
      message: too_large_message,
    });
    const afterContentFingerprint = outputFileContentFingerprint(afterStat);
    if (beforeContentFingerprint && afterContentFingerprint && beforeContentFingerprint !== afterContentFingerprint) {
      throw outputFileVersionChangedError(outputFileVersionFromStat(beforeStat), outputFileVersionFromStat(afterStat));
    }
    const version = outputFileVersionFromHash(afterStat, sha256);
    return rememberOutputFileVersion(outputFileVersionCacheKey(filePath, afterStat), version);
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

async function outputFileVersionAfterCommit(filePath) {
  let lastError = null;
  for (const waitMs of [0, 40, 160]) {
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      const version = await outputFileVersion(filePath);
      if (version) return version;
    } catch (e) {
      lastError = e;
    }
  }
  const err = new Error('已写入文件，但无法生成 SHA256 文件版本；历史索引未提交。请稍后刷新历史或重新导出。');
  err.code = 'file_version_missing_after_commit';
  err.public_code = 'file_version_missing_after_commit';
  err.cause = lastError || undefined;
  throw err;
}

async function outputFileStatVersion(filePath, { signal = null, shouldAbort = null } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  const stat = await fsp.stat(filePath).catch(() => null);
  throwIfOutputAborted(signal, shouldAbort);
  return outputFileVersionFromStat(stat);
}

function outputFileVersionFingerprint(version = '') {
  const match = String(version || '').trim().match(/^v[12]:(\d+:\d+:\d+)(?::[a-f0-9]{64})?$/i);
  return match ? match[1] : '';
}

function outputFileVersionSize(version = '') {
  const match = String(version || '').trim().match(/^v[12]:(\d+):\d+:\d+(?::[a-f0-9]{64})?$/i);
  return match ? Number(match[1]) || 0 : 0;
}

function outputFileVersionHash(version = '') {
  const match = String(version || '').trim().match(/^v2:\d+:\d+:\d+:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : '';
}

export function outputFileVersionKind(version = '') {
  const text = String(version || '').trim();
  if (/^v2:\d+:\d+:\d+:[a-f0-9]{64}$/i.test(text)) return 'v2';
  if (/^v1:\d+:\d+:\d+$/i.test(text)) return 'v1';
  return '';
}

export function outputFileVersionMatches(expectedVersion = '', currentVersion = '') {
  const expected = String(expectedVersion || '').trim();
  const current = String(currentVersion || '').trim();
  if (!expected || !current) return false;
  if (expected === current) return true;
  const expectedHash = outputFileVersionHash(expected);
  const currentHash = outputFileVersionHash(current);
  if (expectedHash || currentHash) return !!expectedHash && !!currentHash && expectedHash === currentHash;
  if (outputFileVersionKind(expected) !== 'v1' || outputFileVersionKind(current) !== 'v1') return false;
  const expectedFingerprint = outputFileVersionFingerprint(expected);
  const currentFingerprint = outputFileVersionFingerprint(current);
  return !!expectedFingerprint && expectedFingerprint === currentFingerprint;
}

function outputFileVersionStatMatches(expectedVersion = '', currentStatVersion = '') {
  const expectedFingerprint = outputFileVersionFingerprint(expectedVersion);
  const currentFingerprint = outputFileVersionFingerprint(currentStatVersion);
  return !!expectedFingerprint && !!currentFingerprint && expectedFingerprint === currentFingerprint;
}

export function outputFileVersionChangedError(expectedVersion = '', currentVersion = '', { artifact = '' } = {}) {
  const kind = String(artifact || '').trim().toLowerCase();
  const code = kind === 'png'
    ? 'history_png_changed'
    : (kind === 'digest' ? 'history_digest_changed' : 'history_file_changed');
  const message = kind === 'png'
    ? '历史 PNG 已变化，请刷新历史记录后重新操作。'
    : (kind === 'digest'
        ? '原摘要 JSON 已变化，请刷新历史记录后重新操作。'
        : '历史文件已变化，请刷新历史记录后重新操作。');
  const err = new Error(message);
  err.status = 409;
  err.code = code;
  err.public_code = code;
  err.artifact = kind;
  err.expected_file_version = String(expectedVersion || '').trim();
  err.current_file_version = String(currentVersion || '').trim();
  return err;
}

export async function assertExpectedOutputFileVersion(filePath, expectedVersion = '', { signal = null, shouldAbort = null, artifact = '', max_bytes = 0, too_large_code = '', too_large_message = '' } = {}) {
  const expected = String(expectedVersion || '').trim();
  if (!expected) return '';
  if (expected === OUTPUT_FILE_EXPECTED_MISSING_VERSION) {
    throwIfOutputAborted(signal, shouldAbort);
    const existing = await fsp.lstat(filePath).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    throwIfOutputAborted(signal, shouldAbort);
    if (!existing) return OUTPUT_FILE_EXPECTED_MISSING_VERSION;
    const current = existing.isFile?.()
      ? await outputFileVersion(filePath, { signal, shouldAbort, max_bytes, too_large_code, too_large_message }).catch(() => 'present:file')
      : 'present:not-file';
    throw outputFileVersionChangedError(expected, current, { artifact });
  }
  const current = await outputFileVersion(filePath, { signal, shouldAbort, max_bytes, too_large_code, too_large_message });
  if (outputFileVersionMatches(expected, current)) return current;
  throw outputFileVersionChangedError(expected, current, { artifact });
}

function outputFileMissingError(message = '导出的文件已不存在，请重新导出。', code = 'output_file_missing') {
  const err = new Error(message);
  err.status = 404;
  err.code = code;
  return err;
}

function outputFileNotRegularError() {
  const err = new Error('输出文件不是普通文件，不能打开。');
  err.status = 403;
  err.code = 'output_file_not_regular';
  return err;
}

function outputFileTooLargeError(maxBytes = 0, actualBytes = 0, { png = false } = {}) {
  const err = new Error(png
    ? `历史 PNG 超过安全读取上限 ${Math.round(maxBytes / 1024 / 1024)}MB，已停止读取。`
    : `输出文件超过安全读取上限 ${Math.round(maxBytes / 1024 / 1024)}MB，已停止读取。`);
  err.status = 413;
  err.code = png ? 'png_payload_too_large' : 'output_file_too_large';
  err.public_code = err.code;
  err.max_bytes = maxBytes;
  err.bytes = actualBytes;
  return err;
}

function historyPngValidationOptions() {
  return {
    maxBytes: RENDERED_PNG_MAX_BYTES,
    maxRgbaBytes: RENDERED_PNG_MAX_RGBA_BYTES,
    maxSide: RENDERED_PNG_MAX_SIDE,
    messages: {
      invalidPng: '历史 PNG 数据不完整或已损坏，已停止读取。',
      payloadTooLarge: `历史 PNG 超过安全读取上限 ${Math.round(RENDERED_PNG_MAX_BYTES / 1024 / 1024)}MB，已停止读取。`,
      dimensionsTooLarge: `历史 PNG 宽高超过安全上限 ${RENDERED_PNG_MAX_SIDE}px，已停止读取。`,
      rgbaTooLarge: `历史 PNG 解码内存超过安全上限 ${Math.round(RENDERED_PNG_MAX_RGBA_BYTES / 1024 / 1024)}MB，已停止读取。`,
      decodedTooLarge: `历史 PNG 解压后的像素数据超过安全上限 ${Math.round(RENDERED_PNG_MAX_RGBA_BYTES / 1024 / 1024)}MB，已停止读取。`,
      tooManyChunks: '历史 PNG 数据分块数量超过安全上限，已停止读取。',
    },
  };
}

export async function inspectOutputPngFile(filePath, { signal = null, shouldAbort = null, validate_inflated = true } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  let handle = null;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch (e) {
    if (e?.code === 'ENOENT') throw outputFileMissingError('长图文件已不存在，可能已被移动或删除。', 'png_missing');
    throw e;
  }
  try {
    throwIfOutputAborted(signal, shouldAbort);
    const beforeStat = await handle.stat();
    if (!beforeStat?.isFile?.()) throw outputFileNotRegularError();
    const dimensions = await validatePngFileHandle(handle, {
      ...historyPngValidationOptions(),
      signal,
      validateInflatedPayload: validate_inflated !== false,
    });
    throwIfOutputAborted(signal, shouldAbort);
    const afterStat = await handle.stat();
    if (!afterStat?.isFile?.()) throw outputFileNotRegularError();
    const beforeVersion = outputFileVersionFromStat(beforeStat);
    const afterVersion = outputFileVersionFromStat(afterStat);
    if (beforeVersion && afterVersion && beforeVersion !== afterVersion) {
      throw outputFileVersionChangedError(beforeVersion, afterVersion, { artifact: 'png' });
    }
    return { stat: afterStat, dimensions, file_version: afterVersion || beforeVersion };
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

async function inspectOutputPngFileHeader(filePath, { signal = null, shouldAbort = null } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  let handle = null;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch (e) {
    if (e?.code === 'ENOENT') throw outputFileMissingError('长图文件已不存在，可能已被移动或删除。', 'png_missing');
    throw e;
  }
  try {
    throwIfOutputAborted(signal, shouldAbort);
    const beforeStat = await handle.stat();
    if (!beforeStat?.isFile?.()) throw outputFileNotRegularError();
    const dimensions = await validatePngFileHeaderHandle(handle, {
      ...historyPngValidationOptions(),
      signal,
    });
    throwIfOutputAborted(signal, shouldAbort);
    const afterStat = await handle.stat();
    if (!afterStat?.isFile?.()) throw outputFileNotRegularError();
    const beforeVersion = outputFileVersionFromStat(beforeStat);
    const afterVersion = outputFileVersionFromStat(afterStat);
    if (beforeVersion && afterVersion && beforeVersion !== afterVersion) {
      throw outputFileVersionChangedError(beforeVersion, afterVersion, { artifact: 'png' });
    }
    return { stat: afterStat, dimensions, file_version: afterVersion || beforeVersion };
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

export async function inspectOutputFileVersion(filePath, {
  signal = null,
  shouldAbort = null,
  expected_file_version = '',
  version_artifact = '',
  missingMessage = '导出的文件已不存在，请重新导出。',
  missingCode = 'output_file_missing',
  max_bytes = 0,
  too_large_code = '',
  too_large_message = '',
} = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  const fileVersion = await outputFileVersion(filePath, {
    signal,
    shouldAbort,
    max_bytes,
    too_large_code,
    too_large_message,
  });
  throwIfOutputAborted(signal, shouldAbort);
  if (!fileVersion) {
    const stat = await fsp.lstat(filePath).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) throw outputFileMissingError(missingMessage, missingCode);
    throw outputFileNotRegularError();
  }
  const expected = String(expected_file_version || '').trim();
  if (expected && !outputFileVersionMatches(expected, fileVersion)) {
    throw outputFileVersionChangedError(expected, fileVersion, { artifact: version_artifact });
  }
  return { file_version: fileVersion, size: outputFileVersionSize(fileVersion) };
}

export async function readOutputFileBuffer(filePath, {
  signal = null,
  shouldAbort = null,
  expected_file_version = '',
  version_artifact = '',
  missingMessage = '导出的文件已不存在，请重新导出。',
  missingCode = 'output_file_missing',
  max_bytes = 0,
  validate_png = false,
} = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  let handle = null;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch (e) {
    if (e?.code === 'ENOENT') throw outputFileMissingError(missingMessage, missingCode);
    throw e;
  }
  try {
    throwIfOutputAborted(signal, shouldAbort);
    const beforeStat = await handle.stat();
    if (!beforeStat?.isFile?.()) throw outputFileNotRegularError();
    const requestedMaxBytes = Number(max_bytes || 0) || (validate_png ? RENDERED_PNG_MAX_BYTES : OUTPUT_FILE_DEFAULT_MAX_BYTES);
    const maxBytes = Number.isFinite(requestedMaxBytes) && requestedMaxBytes > 0
      ? Math.floor(requestedMaxBytes)
      : OUTPUT_FILE_DEFAULT_MAX_BYTES;
    if (beforeStat.size > maxBytes) throw outputFileTooLargeError(maxBytes, beforeStat.size, { png: validate_png });
    const beforeVersion = outputFileVersionFromStat(beforeStat);
    if (validate_png) {
      await validatePngFileHandle(handle, {
        ...historyPngValidationOptions(),
        signal,
      });
      throwIfOutputAborted(signal, shouldAbort);
    }
    const data = await readFileHandleBounded(handle, maxBytes, {
      chunkBytes: 1024 * 1024,
      checkAbort: () => throwIfOutputAborted(signal, shouldAbort),
      createTooLargeError: actualBytes => outputFileTooLargeError(maxBytes, actualBytes, { png: validate_png }),
    });
    throwIfOutputAborted(signal, shouldAbort);
    const afterStat = await handle.stat();
    if (!afterStat?.isFile?.()) throw outputFileNotRegularError();
    const afterVersion = outputFileVersionFromStat(afterStat);
    if (beforeVersion && afterVersion && beforeVersion !== afterVersion) {
      throw outputFileVersionChangedError(beforeVersion, afterVersion, { artifact: version_artifact });
    }
    const contentVersion = outputFileVersionFromBuffer(afterStat, data);
    const expected = String(expected_file_version || '').trim();
    if (expected && !outputFileVersionMatches(expected, contentVersion)) throw outputFileVersionChangedError(expected, contentVersion || afterVersion, { artifact: version_artifact });
    return { data, file_version: contentVersion || afterVersion || beforeVersion };
  } finally {
    await handle.close().catch(() => {});
  }
}

function outputFileStreamSnapshotPath() {
  return path.join(
    TMP_DIR,
    'output-streams',
    `${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.snapshot.tmp`,
  );
}

async function cleanupOutputFileStreamSnapshot(snapshotPath = '') {
  const target = String(snapshotPath || '').trim();
  if (!target) return;
  const safe = await assertSafeTmpPath(target, {
    label: 'output stream snapshot',
    requireFile: true,
  }).catch(() => null);
  if (safe?.exists) await fsp.rm(safe.resolved, { force: true }).catch(() => {});
}

async function copyOutputFileHandleToSnapshot(sourceHandle, snapshotHandle, expectedBytes, {
  signal = null,
  shouldAbort = null,
  changedError = null,
} = {}) {
  const size = Number(expectedBytes);
  if (!Number.isSafeInteger(size) || size < 0) throw changedError?.() || outputFileNotRegularError();
  const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(OUTPUT_FILE_STREAM_SNAPSHOT_CHUNK_BYTES, size || 1)));
  const hash = crypto.createHash('sha256');
  let position = 0;
  while (position < size) {
    throwIfOutputAborted(signal, shouldAbort);
    const requested = Math.min(chunk.length, size - position);
    const { bytesRead } = await sourceHandle.read(chunk, 0, requested, position);
    if (!bytesRead) throw changedError?.() || outputFileNotRegularError();
    hash.update(chunk.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      throwIfOutputAborted(signal, shouldAbort);
      const { bytesWritten } = await snapshotHandle.write(chunk, written, bytesRead - written, position + written);
      if (!bytesWritten) throw new Error('输出文件流快照写入失败。');
      written += bytesWritten;
    }
    position += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await sourceHandle.read(extra, 0, 1, position)).bytesRead) {
    throw changedError?.() || outputFileNotRegularError();
  }
  throwIfOutputAborted(signal, shouldAbort);
  return { bytes: position, sha256: hash.digest('hex') };
}

export async function openOutputFileHandleForStableRead(filePath, {
  signal = null,
  shouldAbort = null,
  expected_file_version = '',
  version_artifact = '',
  missingMessage = '导出的文件已不存在，请重新导出。',
  missingCode = 'output_file_missing',
  max_bytes = 0,
  validate_png = false,
} = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  let sourceHandle = null;
  let snapshotHandle = null;
  let snapshotPath = '';
  let completed = false;
  try {
    sourceHandle = await fsp.open(filePath, 'r');
  } catch (e) {
    if (e?.code === 'ENOENT') throw outputFileMissingError(missingMessage, missingCode);
    throw e;
  }
  try {
    throwIfOutputAborted(signal, shouldAbort);
    const beforeStat = await sourceHandle.stat();
    if (!beforeStat?.isFile?.()) throw outputFileNotRegularError();
    const requestedMaxBytes = Number(max_bytes || 0) || (validate_png ? RENDERED_PNG_MAX_BYTES : OUTPUT_FILE_DEFAULT_MAX_BYTES);
    const maxBytes = Number.isFinite(requestedMaxBytes) && requestedMaxBytes > 0
      ? Math.floor(requestedMaxBytes)
      : OUTPUT_FILE_DEFAULT_MAX_BYTES;
    if (beforeStat.size > maxBytes) throw outputFileTooLargeError(maxBytes, beforeStat.size, { png: validate_png });
    const beforeVersion = outputFileVersionFromStat(beforeStat);
    const changedError = () => outputFileVersionChangedError(beforeVersion, '', { artifact: version_artifact });
    snapshotPath = (await assertSafeTmpPath(outputFileStreamSnapshotPath(), {
      label: 'output stream snapshot',
      ensureParent: true,
    })).resolved;
    snapshotHandle = await fsp.open(snapshotPath, 'wx+');
    const copied = await copyOutputFileHandleToSnapshot(sourceHandle, snapshotHandle, beforeStat.size, {
      signal,
      shouldAbort,
      changedError,
    });
    const afterStat = await sourceHandle.stat();
    if (!afterStat?.isFile?.()) throw outputFileNotRegularError();
    if (afterStat.size > maxBytes) throw outputFileTooLargeError(maxBytes, afterStat.size, { png: validate_png });
    const afterVersion = outputFileVersionFromStat(afterStat);
    if (beforeVersion && afterVersion && beforeVersion !== afterVersion) {
      throw outputFileVersionChangedError(beforeVersion, afterVersion, { artifact: version_artifact });
    }
    const snapshotStat = await snapshotHandle.stat();
    if (!snapshotStat?.isFile?.() || Number(snapshotStat.size) !== copied.bytes) throw changedError();
    if (validate_png) {
      await validatePngFileHandle(snapshotHandle, {
        ...historyPngValidationOptions(),
        signal,
      });
      throwIfOutputAborted(signal, shouldAbort);
    }
    const contentVersion = outputFileVersionFromHash(afterStat, copied.sha256);
    const expected = String(expected_file_version || '').trim();
    if (expected && !outputFileVersionMatches(expected, contentVersion)) {
      throw outputFileVersionChangedError(expected, contentVersion || afterVersion, { artifact: version_artifact });
    }
    await sourceHandle.close();
    sourceHandle = null;
    let cleanupPromise = null;
    const cleanup = () => {
      cleanupPromise ||= (async () => {
        await snapshotHandle?.close?.().catch(() => {});
        snapshotHandle = null;
        await cleanupOutputFileStreamSnapshot(snapshotPath);
      })();
      return cleanupPromise;
    };
    completed = true;
    return {
      handle: snapshotHandle,
      stat: afterStat,
      size: copied.bytes,
      file_version: contentVersion || afterVersion || beforeVersion,
      snapshot_path: snapshotPath,
      cleanup,
    };
  } catch (e) {
    throw e;
  } finally {
    await sourceHandle?.close?.().catch(() => {});
    if (!completed) {
      await snapshotHandle?.close?.().catch(() => {});
      await cleanupOutputFileStreamSnapshot(snapshotPath);
    }
  }
}

function historyFileVersionRequiredError() {
  const err = new Error('缺少历史文件版本，请刷新历史记录后从具体卡片重新操作。');
  err.status = 428;
  err.code = 'history_file_version_required';
  err.public_code = 'history_file_version_required';
  return err;
}

function historyPngWriteLockKey(base, item = {}, target = '') {
  return [
    path.resolve(base || ''),
    historyItemKeyForItem(base, item) || '',
    path.resolve(target || ''),
  ].join('|');
}

async function withHistoryPngWriteLock(key, action) {
  const lockKey = String(key || '').trim() || '__default__';
  const previous = historyPngWriteLocks.get(lockKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  historyPngWriteLocks.set(lockKey, current);
  try {
    return await current;
  } finally {
    if (historyPngWriteLocks.get(lockKey) === current) historyPngWriteLocks.delete(lockKey);
  }
}

export async function readHistoryDigestResult(settings, digestId, lookup = {}, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  const item = await findHistoryItem(settings, digestId, lookup, { signal });
  throwIfOutputAborted(signal);
  if (!item) {
    return {
      item: null,
      digest: null,
      status: 404,
      code: 'history_item_missing',
      message: '历史记录已不存在，可能已被清理或输出目录已切换。',
    };
  }
  if (historyItemIsTextPreviewMarkdown(item)) {
    return {
      item,
      digest: null,
      status: 409,
      code: 'history_item_type_unsupported',
      message: '这条历史是导出的 MD，没有原摘要 JSON，不能重新渲染或再次从摘要导出 MD。',
    };
  }
  const base = historyBaseForItem(await safeOutputBase(settings), item);
  throwIfOutputAborted(signal);
  const recordedDigestPath = Object.hasOwn(item, '_history_recorded_digest_path')
    ? item._history_recorded_digest_path === true
    : historyItemHasRecordedDigestPath(item);
  const digestPath = resolveDigestPath(base, item);
  const missingMessage = recordedDigestPath
    ? '原摘要 JSON 已不存在，不能导出 MD 或重新渲染。'
    : '这条旧版历史只保存了 PNG，没有原摘要 JSON；不能导出 MD 或重新渲染，现有 PNG 仍可下载、复制或打开。';
  if (!digestPath) {
    return {
      item,
      digest: null,
      status: 404,
      code: 'digest_json_missing',
      message: missingMessage,
    };
  }
  let readable = '';
  try {
    readable = await assertReadableOutputFile(base, digestPath, { extensions: ['.digest.json'], signal });
  } catch (e) {
    if (isOutputAbortError(e)) throw e;
    if (e?.code !== 'output_file_missing' && e?.status !== 404) {
      return {
        item,
        digest: null,
        status: 500,
        code: 'digest_json_unreadable',
        message: '原摘要 JSON 暂时无法读取，不能导出 MD 或重新渲染；现有 PNG 仍可下载、复制或打开。',
      };
    }
  }
  throwIfOutputAborted(signal);
  if (!readable) {
    return {
      item,
      digest: null,
      status: 404,
      code: 'digest_json_missing',
      message: missingMessage,
    };
  }
  try {
    const { data, file_version: digestFileVersion } = await readOutputFileBuffer(readable, {
      signal,
      max_bytes: HISTORY_DIGEST_JSON_MAX_BYTES,
      expected_file_version: lookup?.expected_digest_file_version || '',
      version_artifact: 'digest',
      missingMessage,
      missingCode: 'digest_json_missing',
    });
    const raw = data.toString('utf-8');
    throwIfOutputAborted(signal);
    const digest = JSON.parse(raw);
    if (digest && typeof digest === 'object' && !Array.isArray(digest)) {
      if (digestLooksEmptyForHistoryRead(digest)) {
        return {
          item,
          digest: null,
          status: 422,
          code: 'digest_json_empty',
          message: '原摘要 JSON 是空摘要，不能重新渲染或导出 MD；现有 PNG 仍可下载、复制或打开。',
        };
      }
      if (historyDigestIdMismatch(digest, item.digest_id)) {
        return {
          item,
          digest: null,
          status: 409,
          code: 'digest_json_mismatch',
          message: '原摘要 JSON 与历史索引不匹配，已停止导出和重渲染以避免覆盖错误摘要。',
        };
      }
      return { item, digest: persistedDigest(digest), status: 200, code: 'ok', message: '', digest_file_version: digestFileVersion || '' };
    }
    return {
      item,
      digest: null,
      status: 422,
      code: 'digest_json_invalid',
          message: '原摘要 JSON 格式不正确，不能导出 MD 或重新渲染；现有 PNG 仍可下载、复制或打开。',
    };
  } catch (e) {
    if (isOutputAbortError(e)) throw e;
    if (e?.code === 'ENOENT') {
      return {
        item,
        digest: null,
        status: 404,
        code: 'digest_json_missing',
        message: missingMessage,
      };
    }
    if (e?.code === 'digest_json_missing' || e?.code === 'history_file_changed' || e?.code === 'history_digest_changed') {
      return {
        item,
        digest: null,
        status: e.status || 409,
        code: e.code,
        message: ['history_file_changed', 'history_digest_changed'].includes(e?.code)
          ? '原摘要 JSON 在读取期间已变化，请刷新历史记录后再操作。'
          : missingMessage,
      };
    }
    const invalid = e instanceof SyntaxError;
    return {
      item,
      digest: null,
      status: invalid ? 422 : 500,
      code: invalid ? 'digest_json_invalid' : 'digest_json_unreadable',
      message: invalid
        ? '原摘要 JSON 已损坏，不能导出 MD 或重新渲染；现有 PNG 仍可下载、复制或打开。'
        : '原摘要 JSON 暂时无法读取，不能导出 MD 或重新渲染；现有 PNG 仍可下载、复制或打开。',
    };
  }
}

export async function overwriteRenderedPng({ settings, item, digest, source_digest_revision = '', png_data_url, png_buffer = null, validated_png_sha256 = '', expected_file_version = '', expected_digest_file_version = '', signal = null, shouldAbort = null, preserveAfterCommit = false, commitBarrier = null, prepareCommitEvidence = null, finalizeCommitEvidence = null }) {
  throwIfOutputAborted(signal, shouldAbort);
  const currentBase = await safeOutputBase(settings);
  const base = historyBaseForItem(currentBase, item);
  await assertHistoryItemOwnedByBase(base, item, { signal });
  const target = await writableHistoryPngTarget(settings, resolveHistoryFilePath(base, item) || item?.file_path || '', { base, signal, shouldAbort });
  const bufferedPng = Buffer.isBuffer(png_buffer) || png_buffer instanceof Uint8Array
    ? Buffer.from(png_buffer)
    : null;
  const buffer = bufferedPng || pngBufferFromInput({ png_data_url, png_buffer });
  if (bufferedPng && !trustedPngBufferFromValidatedHash(bufferedPng, validated_png_sha256)) {
    validatePngBuffer(bufferedPng, outputPngValidationOptions());
  }
  throwIfOutputAborted(signal, shouldAbort);
  const lockKey = historyPngWriteLockKey(base, item, target);
  return withHistoryPngWriteLock(lockKey, () => withHistoryWriteLock(async () => {
    await assertHistoryItemOwnedByBase(base, item, { signal });
    const expected = String(expected_file_version || '').trim();
    const expectedDigest = String(expected_digest_file_version || '').trim();
    if (!expected) throw historyFileVersionRequiredError();
    if (!expectedDigest) throw historyDigestFileVersionRequiredError();
    const sourceDigestRevision = String(source_digest_revision || '').trim() || digestSemanticRevision(digest);
    const sourceDigestPath = resolveDigestPath(base, item) || digestJsonPathForPng(target);
    await assertExpectedOutputFileVersion(target, expected, {
      signal,
      shouldAbort,
      artifact: 'png',
      max_bytes: HISTORY_RERENDER_SOURCE_MAX_BYTES,
      too_large_code: 'history_rerender_source_too_large',
      too_large_message: '历史 PNG 超过可安全核验的重建源文件上限，已停止确认旧版本。请移走该文件或回到总结页重新生成。',
    });
    await assertExpectedOutputFileVersion(sourceDigestPath, expectedDigest, { signal, shouldAbort, artifact: 'digest' });
    await assertHistoryRerenderDigestMatchesSource(base, sourceDigestPath, item, digest, expectedDigest, { signal, shouldAbort, expectedSourceDigestRevision: sourceDigestRevision });
    throwIfOutputAborted(signal, shouldAbort);

    const rerenderedAt = new Date().toISOString();
    const historyRerender = historyRerenderMetadataForVersion(base, item, rerenderedAt);
    const persistedRerenderDigest = historyRerenderDigestWithMessageEvidence(item, digest, historyRerender);
    serializePersistedDigest(persistedRerenderDigest);
    let versioned = null;
    let indexCommitted = false;
    let afterCommitReason = '';
    let afterCommitError = '';
    try {
      await assertExpectedOutputFileVersion(target, expected, {
        signal,
        shouldAbort,
        artifact: 'png',
        max_bytes: HISTORY_RERENDER_SOURCE_MAX_BYTES,
        too_large_code: 'history_rerender_source_too_large',
        too_large_message: '历史 PNG 超过可安全核验的重建源文件上限，已停止确认旧版本。请移走该文件或回到总结页重新生成。',
      });
      await assertExpectedOutputFileVersion(sourceDigestPath, expectedDigest, { signal, shouldAbort, artifact: 'digest' });
      await assertHistoryRerenderDigestMatchesSource(base, sourceDigestPath, item, digest, expectedDigest, { signal, shouldAbort, expectedSourceDigestRevision: sourceDigestRevision });
      versioned = await runOutputCommitBarrier(commitBarrier, () => writeHistoryRerenderVersion(base, target, buffer, persistedRerenderDigest, { signal, shouldAbort }));
      throwIfOutputAborted(signal, shouldAbort);
      const nextFileVersion = await outputFileVersionAfterCommit(versioned.file_path);
      const nextDigestFileVersion = await outputFileVersionAfterCommit(versioned.digest_path);
      throwIfOutputAborted(signal, shouldAbort);
      const next = {
        ...item,
        history_record_id: historyRerender.record_id,
        file_path: versioned.file_path,
        relative_path: toProjectRelative(versioned.file_path),
        output_dir_identity: outputDirIdentityForBase(base),
        digest_path: versioned.digest_path,
        digest_relative_path: toProjectRelative(versioned.digest_path),
        rerendered_at: rerenderedAt,
        history_rerender: historyRerender,
        ...(digestRendererVersion(digest) ? { renderer_version: digestRendererVersion(digest) } : {}),
        ...(digestRendererEngine(digest) ? { renderer_engine: digestRendererEngine(digest) } : {}),
        headline: digestHeadlineForHistory(digest),
        search_text: digestSearchTextForHistory(digest),
        saved_file_version: nextFileVersion,
        saved_digest_file_version: nextDigestFileVersion,
      };
      next.history_item_key = historyItemKeyForItem(base, next);
      next.history_item_key_aliases = historyItemKeyAliases(base, next);
      if (typeof prepareCommitEvidence === 'function') await prepareCommitEvidence(next);
      throwIfOutputAborted(signal, shouldAbort);
      const markerPayload = historyRerenderCommitMarkerPayload(base, next, historyRerender, new Date().toISOString(), {
        source_file_version: expected,
        source_digest_file_version: expectedDigest,
      });
      await runOutputCommitBarrier(commitBarrier, () => writeJsonAtomic(versioned.marker_path, markerPayload));
      throwIfOutputAborted(signal, shouldAbort);
      const committedMarker = await historyRerenderCommitMarkerValid(
        base,
        versioned.file_path,
        versioned.digest_path,
        next.digest_id,
        historyRerender,
        { signal },
      );
      if (!committedMarker) {
        throw Object.assign(new Error('重渲染提交标记写入后校验失败，历史索引未切换。'), {
          code: 'history_rerender_marker_commit_failed',
          public_code: 'history_rerender_marker_commit_failed',
        });
      }
      throwIfOutputAborted(signal, shouldAbort);
      await upsertHistory(settings, next, { signal, shouldAbort, base, commitBarrier });
      indexCommitted = true;
      if (typeof finalizeCommitEvidence === 'function') {
        try {
          await finalizeCommitEvidence(next);
        } catch (error) {
          afterCommitReason = isOutputAbortError(error)
            ? 'cancelled_after_commit'
            : 'commit_evidence_persist_failed';
          afterCommitError = error?.message || String(error || '历史已重渲染，但本地操作确认记录保存失败');
        }
      }

      const cancelledAfterCommit = !!signal?.aborted
        || (typeof shouldAbort === 'function' && shouldAbort())
        || afterCommitReason === 'cancelled_after_commit';
      const current = historyOutputBaseMatches(base, currentBase);
      const preserveCommittedBinding = !cancelledAfterCommit || preserveAfterCommit;
      if (cancelledAfterCommit && !afterCommitReason) afterCommitReason = 'cancelled_after_commit';
      return {
        ...next,
        history_current: current && preserveCommittedBinding,
        history_commit_failed: false,
        history_output_relative_path: current ? '' : toProjectRelative(base),
        file_exists: true,
        file_version: nextFileVersion,
        digest_exists: true,
        digest_invalid: false,
        digest_status: 'ok',
        digest_file_version: nextDigestFileVersion,
        cancelled_after_commit: cancelledAfterCommit,
        ...(afterCommitReason ? { local_action_after_commit_reason: afterCommitReason } : {}),
        ...(afterCommitError ? { local_action_after_commit_error: afterCommitError } : {}),
      };
    } catch (error) {
      if (indexCommitted || historyIndexWriteMayHaveCommitted(error)) {
        invalidateHistoryCaches({ discovery: true });
        throw error;
      }
      if (versioned) {
        try {
          await cleanupRenderedPair(versioned.file_path, versioned.digest_path, versioned.marker_path);
        } catch (cleanupError) {
          error.cleanup_error = cleanupError?.message || String(cleanupError);
          error.cleanup_failed_count = Number(cleanupError?.cleanup_failed_count || 0) || 0;
        }
      }
      throw error;
    }
  }));
}

function historyRerenderDigestWithMessageEvidence(item = {}, digest = {}, historyRerender = null) {
  const next = { ...digest, __history_rerender: historyRerender };
  if (!digestMissingMessageEvidence(digest)) return next;
  const fallbackCount = Math.max(
    0,
    Number(item?.message_count || 0) || 0,
    Number(item?.input_message_count || 0) || 0,
    Number(item?.scanned_message_count || 0) || 0,
  );
  if (!fallbackCount) {
    throw historyRerenderSourceChangedError('原摘要缺少可验证的消息数量，不能保存新的重渲染版本；现有 PNG 仍可下载、复制或打开。');
  }
  next.message_count = fallbackCount;
  next.input_message_count = fallbackCount;
  next.scanned_message_count = fallbackCount;
  return next;
}

function historyRerenderSourceChangedError(message = '重渲染内容与原摘要 JSON 不一致，请刷新历史记录后重新预览。') {
  const err = new Error(message);
  err.status = 409;
  err.code = 'history_source_changed';
  err.public_code = err.code;
  err.artifact = 'digest';
  return err;
}

async function assertHistoryRerenderDigestMatchesSource(base, sourceDigestPath, item, digest, expectedDigestVersion, { signal = null, shouldAbort = null, expectedSourceDigestRevision = '' } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  const expectedDigestId = String(item?.digest_id || '').trim();
  if (!expectedDigestId || historyDigestIdMismatch(digest, expectedDigestId)) {
    throw historyRerenderSourceChangedError('重渲染摘要与所选历史记录不匹配，请刷新历史记录后重新预览。');
  }
  let sourceDigest = null;
  try {
    const readable = await assertReadableOutputFile(base, sourceDigestPath, { extensions: ['.digest.json'], signal, shouldAbort });
    const { data } = await readOutputFileBuffer(readable, {
      signal,
      shouldAbort,
      expected_file_version: expectedDigestVersion,
      version_artifact: 'digest',
      max_bytes: HISTORY_DIGEST_JSON_MAX_BYTES,
      missingMessage: '原摘要 JSON 已不存在，不能保存重渲染版本。',
      missingCode: 'digest_json_missing',
    });
    sourceDigest = JSON.parse(data.toString('utf-8'));
  } catch (error) {
    if (isOutputAbortError(error) || error?.code === 'history_digest_changed') throw error;
    const changed = historyRerenderSourceChangedError(
      error?.code === 'digest_json_missing' || error?.status === 404
        ? '原摘要 JSON 已不存在，不能保存重渲染版本。'
        : '原摘要 JSON 无法完整核验，不能保存重渲染版本；请刷新历史记录后重试。',
    );
    changed.cause_code = String(error?.code || '').trim();
    throw changed;
  }
  const expectedRevision = String(expectedSourceDigestRevision || '').trim() || digestSemanticRevision(digest);
  if (!sourceDigest || typeof sourceDigest !== 'object' || Array.isArray(sourceDigest)
    || digestLooksEmptyForHistoryRead(sourceDigest)
    || historyDigestIdMismatch(sourceDigest, expectedDigestId)
    || digestSemanticRevision(sourceDigest) !== expectedRevision) {
    throw historyRerenderSourceChangedError();
  }
}

async function cleanupPreviewMarkdownFiles(filePath = '', metaPath = '') {
  const failures = [];
  for (const target of [metaPath, filePath].filter(Boolean)) {
    try {
      await fsp.rm(target, { force: true });
    } catch (error) {
      failures.push({ target, error });
    }
  }
  if (!failures.length) return;
  const err = new Error('文本保存未完成，且部分未提交文件无法清理。请检查输出目录后重试。');
  err.status = 500;
  err.code = 'preview_markdown_cleanup_failed';
  err.public_code = 'preview_markdown_cleanup_failed';
  err.cleanup_failed_count = failures.length;
  err.cleanup_error = failures.map(item => item.error?.message || String(item.error || '')).filter(Boolean).join('；');
  throw err;
}

export async function savePreviewMarkdown({ settings, title = '文本预览', markdown, history = false, metadata = null, save_operation_id = '', signal = null, shouldAbort = null, preserveAfterCommit = false, commitBarrier = null, prepareCommitEvidence = null, finalizeCommitEvidence = null } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  const assertCommitAllowed = async () => {
    throwIfOutputAborted(signal, shouldAbort);
    if (typeof commitBarrier === 'function') await commitBarrier();
    throwIfOutputAborted(signal, shouldAbort);
  };
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  if (!text.trim()) {
    const err = new Error('文本预览为空，无法导出。');
    err.status = 400;
    throw err;
  }
  if (Buffer.byteLength(text, 'utf-8') > 2 * 1024 * 1024) {
    const err = new Error('文本预览超过 2MB，请减少选择的群或时间范围后再导出。');
    err.status = 413;
    err.code = 'preview_markdown_too_large';
    err.public_code = 'preview_markdown_too_large';
    throw err;
  }
  const base = await safeOutputBase(settings);
  const dir = path.join(base, 'previews');
  await assertSafeOutputParent(base, path.join(dir, 'placeholder.md'));
  await assertCommitAllowed();
  const saveOperationId = cleanPreviewMarkdownSaveOperationId(save_operation_id);
  const createdAt = new Date();
  let filePath = '';
  let reusedOperationFile = false;
  let operationFileOwned = false;
  try {
    const savedText = text.endsWith('\n') ? text : `${text}\n`;
    if (saveOperationId) {
      const saved = await writePreviewMarkdownOperationFile(
        base,
        dir,
        previewMarkdownOperationFilename(title, saveOperationId),
        savedText,
        { signal, shouldAbort },
      );
      filePath = saved.file_path;
      reusedOperationFile = saved.reused === true;
      operationFileOwned = !reusedOperationFile;
    } else {
      filePath = await writeTextUnique(dir, `${sanitizeName(title || '文本预览')}__${timestampForFilename(createdAt)}.md`, savedText, { signal, shouldAbort });
      operationFileOwned = true;
    }
    await assertCommitAllowed();
  } catch (error) {
    if (operationFileOwned) {
      await cleanupPreviewMarkdownFiles(filePath).catch(cleanupError => {
        cleanupError.original_error = error?.message || String(error || 'save failed');
        throw cleanupError;
      });
    }
    throw error;
  }
  const createdAtIso = createdAt.toISOString();
  const cleanMeta = cleanPreviewHistoryMetadata(metadata || {});
  const exportSettingsRevision = String(settings?.export_policy_revision || settings?.settings_revision || '').trim();
  const shouldIndexHistory = history === true || !!metadata;
  const item = shouldIndexHistory ? {
    artifact_type: HISTORY_ARTIFACT_TEXT_PREVIEW_MD,
    file_type: 'markdown',
    digest_id: previewMarkdownHistoryId({ filePath, createdAt: createdAtIso, markdown: text, saveOperationId }),
    account_id: cleanMeta.account_id,
    account_label: cleanMeta.account_label,
    group: cleanMeta.group || cleanHistorySearchText(title || '文本预览', 240),
    groups: cleanMeta.groups,
    digest_ids: cleanMeta.digest_ids,
    since: cleanMeta.since,
    until: cleanMeta.until,
    file_path: filePath,
    relative_path: toProjectRelative(filePath),
    output_dir_identity: outputDirIdentityForBase(base),
    digest_path: '',
    digest_relative_path: '',
    model: cleanMeta.model,
    message_count: cleanMeta.message_count,
    complete: cleanMeta.complete,
    done: cleanMeta.done,
    total: cleanMeta.total,
    headline: previewMarkdownHeadlineForHistory({ title, markdown: text, metadata: cleanMeta }),
    search_text: previewMarkdownSearchTextForHistory({ title, markdown: text, metadata: cleanMeta }),
    export_settings_revision: exportSettingsRevision,
    export_policy_revision: exportSettingsRevision,
    save_operation_id: saveOperationId,
    source_digest_id: cleanMeta.source_digest_id,
    source_history_item_key: cleanMeta.source_history_item_key,
    source_expected_file_version: cleanMeta.source_expected_file_version,
    source_expected_digest_file_version: cleanMeta.source_expected_digest_file_version,
    source_digest_revision: cleanMeta.source_digest_revision,
    source_snapshot: cleanMeta.source_snapshot,
    created_at: createdAtIso,
  } : null;
  const metaPath = item ? previewMarkdownMetaPathForMd(filePath) : '';
  let cancelledAfterCommit = false;
  let metadataCommitted = false;
  let historyCommitted = false;
  let historyCommitFailed = false;
  let commitEvidencePrepared = false;
  let afterCommitReason = '';
  let afterCommitError = '';
  try {
    if (item) {
      await withHistoryWriteLock(async () => {
        await assertCommitAllowed();
        item.saved_file_version = await outputFileVersionAfterCommit(filePath);
        await assertCommitAllowed();
        await assertSafeOutputParent(base, metaPath);
        await assertCommitAllowed();
        await writePreviewMarkdownMetaAtomic(metaPath, previewMarkdownMetaPayload(item, { indexState: 'needs_index' }));
        metadataCommitted = true;
        item.history_item_key = historyItemKeyForItem(base, item);
        try {
          if (typeof prepareCommitEvidence === 'function') {
            await prepareCommitEvidence(item);
            commitEvidencePrepared = true;
          }
        } catch (error) {
          afterCommitReason ||= isOutputAbortError(error) ? 'cancelled_after_commit' : 'commit_evidence_persist_failed';
          afterCommitError ||= error?.message || String(error || 'MD 已写入，但本地操作提交记录保存失败');
        }
        await assertCommitAllowed();
        await upsertHistory(settings, item, { base, signal, shouldAbort });
        historyCommitted = true;
        await assertCommitAllowed();
        try {
          await writePreviewMarkdownMetaAtomic(metaPath, previewMarkdownMetaPayload(item, { indexCommitted: true }));
        } catch (error) {
          throw Object.assign(
            new Error('MD 已写入并已进入历史索引，但完成标记未能更新；下次读取历史会自动修复。'),
            {
              code: 'history_metadata_marker_failed',
              public_code: 'history_metadata_marker_failed',
              cause: error,
            },
          );
        }
        if (commitEvidencePrepared && typeof finalizeCommitEvidence === 'function') {
          try {
            await finalizeCommitEvidence(item);
          } catch (error) {
            afterCommitReason ||= isOutputAbortError(error) ? 'cancelled_after_commit' : 'commit_evidence_persist_failed';
            afterCommitError ||= error?.message || String(error || 'MD 已写入，但本地操作提交记录完成失败');
          }
        }
      });
    }
  } catch (e) {
    cancelledAfterCommit = isOutputAbortError(e);
    if (!historyCommitted && !metadataCommitted) {
      if (operationFileOwned) {
        await cleanupPreviewMarkdownFiles(filePath, metaPath).catch(cleanupError => {
          cleanupError.original_error = e?.message || String(e || '历史元数据写入失败');
          throw cleanupError;
        });
      }
      throw e;
    }
    if (cancelledAfterCommit && !historyCommitted && (!metadataCommitted || !preserveAfterCommit)) {
      if (metadataCommitted && operationFileOwned) {
        await writePreviewMarkdownMetaAtomic(metaPath, previewMarkdownMetaPayload(item, { indexState: 'abandoned' })).catch(() => {});
      }
      if (operationFileOwned) {
        await cleanupPreviewMarkdownFiles(filePath, metaPath).catch(cleanupError => {
          cleanupError.original_error = e?.message || String(e || 'save cancelled');
          throw cleanupError;
        });
      }
      throw e;
    }
    historyCommitFailed = !historyCommitted;
    afterCommitReason = previewMarkdownAfterCommitReason(e, cancelledAfterCommit);
    afterCommitError = e?.message || String(e || '历史索引写入失败');
    if (historyCommitFailed) {
      invalidateHistoryCaches();
      void schedulePendingHistoryRecovery(settings, { reason: 'preview_markdown_history_commit_failed' }).catch(() => {});
    }
  }
  if (!historyCommitFailed && (signal?.aborted || (typeof shouldAbort === 'function' && shouldAbort()))) {
    cancelledAfterCommit = true;
    afterCommitReason = 'cancelled_after_commit';
  }
  const committedFileVersion = item
    ? (String(item.saved_file_version || '').trim() || await outputFileVersionAfterCommit(filePath).catch(() => ''))
    : '';
  const result = item ? {
    ...item,
    history_item_key: historyItemKeyForItem(base, item),
    history_current: historyCommitted,
    history_commit_failed: historyCommitFailed,
    history_output_relative_path: '',
    file_exists: !!committedFileVersion,
    file_version: committedFileVersion,
    digest_exists: true,
    digest_invalid: false,
    digest_status: 'md_only',
    cancelled_after_commit: cancelledAfterCommit,
    local_action_after_commit_reason: afterCommitReason,
    local_action_after_commit_error: afterCommitError,
  } : {
    artifact_type: HISTORY_ARTIFACT_TEXT_PREVIEW_MD,
    file_type: 'markdown',
    file_path: filePath,
    relative_path: toProjectRelative(filePath),
    output_dir_identity: outputDirIdentityForBase(base),
    export_settings_revision: exportSettingsRevision,
    export_policy_revision: exportSettingsRevision,
    save_operation_id: saveOperationId,
    cancelled_after_commit: cancelledAfterCommit,
  };
  return {
    ...result,
    save_operation_reused: reusedOperationFile,
  };
}

function previewMarkdownAfterCommitReason(error = {}, cancelledAfterCommit = false) {
  if (cancelledAfterCommit) return 'cancelled_after_commit';
  const code = String(error?.public_code || error?.code || '').trim();
  if (code === 'history_metadata_marker_failed') return 'history_metadata_marker_failed';
  if (code === 'output_dir_changed') return 'output_dir_changed_after_commit';
  if (code === 'history_md_source_changed') return 'history_source_changed_after_commit';
  if (code === 'settings_revision_conflict' || code === 'digest_runtime_settings_changed' || code === 'stale_settings') {
    return 'settings_changed_after_commit';
  }
  return 'history_failed_after_commit';
}

export async function assertRevealable(settings, targetPath, { extensions = [], base = null, signal = null, shouldAbort = null } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  const resolvedBase = base ? path.resolve(base) : await safeOutputBase(settings);
  throwIfOutputAborted(signal, shouldAbort);
  return assertReadableOutputFile(resolvedBase, targetPath, { extensions, signal, shouldAbort });
}

export async function assertRevealableTarget(settings, targetPath, { extensions = [], base = null, signal = null, shouldAbort = null } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  const resolvedBase = base ? path.resolve(base) : await safeOutputBase(settings);
  throwIfOutputAborted(signal, shouldAbort);
  return assertOutputTargetPathAllowed(resolvedBase, targetPath, { extensions });
}

function resolveOutputTargetPath(base, targetPath) {
  const raw = String(targetPath || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return path.resolve(raw);
  const projectRelative = path.resolve(PROJECT_ROOT, raw);
  if (isInside(base, projectRelative)) return projectRelative;
  if (outputTargetLooksProjectRelative(raw, base) && isInside(PROJECT_ROOT, projectRelative)) {
    throw outputPathOutsideDirError();
  }
  return path.resolve(base, raw);
}

function outputTargetLooksProjectRelative(raw = '', base = '') {
  const clean = normalizeHistoryRelativePath(raw);
  if (!clean || clean.startsWith('../') || clean === '..') return false;
  return relativePathStartsWithPath(clean, toProjectRelative(OUTPUTS_DIR))
    || relativePathStartsWithPath(clean, toProjectRelative(base));
}

function outputPathOutsideDirError(message = '文件不在当前输出目录内，不能打开。') {
  const err = new Error(message);
  err.status = 403;
  err.code = 'output_path_outside_dir';
  return err;
}

async function assertReadableOutputFile(base, targetPath, { extensions = [], signal = null, shouldAbort = null } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  const resolved = assertOutputTargetPathAllowed(base, targetPath, { extensions });
  const linkStat = await fsp.lstat(resolved).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  throwIfOutputAborted(signal, shouldAbort);
  if (!linkStat) throw outputFileMissingError();
  if (linkStat?.isSymbolicLink?.()) {
    throw outputFileNotRegularError();
  }
  const st = await fsp.stat(resolved).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  throwIfOutputAborted(signal, shouldAbort);
  if (!st) throw outputFileMissingError();
  if (!st.isFile()) throw outputFileNotRegularError();
  const [{ realTmp, realBase }, realTarget] = await Promise.all([
    assertRealOutputDir(base),
    fsp.realpath(resolved).catch(() => ''),
  ]);
  throwIfOutputAborted(signal, shouldAbort);
  if (!realBase || !realTarget || !isInside(realBase, realTarget) || (realTmp && isInside(realTmp, realTarget))) {
    throw outputPathOutsideDirError('文件真实路径不在输出目录内，不能打开。');
  }
  return resolved;
}

function assertOutputTargetPathAllowed(base, targetPath, { extensions = [] } = {}) {
  const resolved = resolveOutputTargetPath(base, targetPath);
  if (!isInside(base, resolved)) {
    throw outputPathOutsideDirError();
  }
  const allowed = Array.isArray(extensions) ? extensions.map(ext => String(ext || '').toLowerCase()).filter(Boolean) : [];
  const resolvedLower = resolved.toLowerCase();
  if (allowed.length && !allowed.some(ext => resolvedLower.endsWith(ext))) {
    const err = new Error(`只能打开 ${allowed.join(' 或 ')} 输出文件。`);
    err.status = 400;
    err.code = 'output_file_type_unsupported';
    throw err;
  }
  return resolved;
}

async function writableHistoryPngTarget(settings, targetPath, { base = null, signal = null, shouldAbort = null } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  const resolvedBase = base ? path.resolve(base) : await safeOutputBase(settings);
  throwIfOutputAborted(signal, shouldAbort);
  const resolved = path.resolve(targetPath || '');
  if (!isInside(resolvedBase, resolved)) {
    const err = new Error('path outside output dir');
    err.status = 403;
    throw err;
  }
  if (path.extname(resolved).toLowerCase() !== '.png') {
    const err = new Error('file must be .png');
    err.status = 400;
    throw err;
  }
  const existing = await fsp.stat(resolved).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  throwIfOutputAborted(signal, shouldAbort);
  if (existing) return assertRevealable(settings, resolved, { extensions: ['.png'], base: resolvedBase, signal, shouldAbort });
  await assertSafeOutputParent(resolvedBase, resolved);
  throwIfOutputAborted(signal, shouldAbort);
  return resolved;
}

function pngBufferFromDataUrl(png_data_url) {
  return validatedPngBufferFromDataUrl(png_data_url, outputPngValidationOptions());
}

function pngBufferFromInput({ png_data_url = '', png_buffer = null } = {}) {
  return validatedPngBufferFromInput({ png_data_url, png_buffer }, outputPngValidationOptions());
}

function outputPngValidationOptions() {
  return {
    maxBytes: RENDERED_PNG_MAX_BYTES,
    maxRgbaBytes: RENDERED_PNG_MAX_RGBA_BYTES,
    maxSide: RENDERED_PNG_MAX_SIDE,
    errorFactory: pngPayloadError,
    messages: {
      dataUrlInvalid: 'png_data_url must be a PNG data URL',
      payloadTooLarge: ({ maxBytes }) => `长图 PNG 超过安全上限 ${formatOutputByteSize(maxBytes)}，已阻止写入历史。请缩短时间范围、减少内容，或改用「生成文本预览」。`,
      invalidPng: '长图 PNG 数据不完整或已损坏，已阻止写入历史。请重新生成长图。',
      dimensionsTooLarge: ({ maxSide }) => `长图 PNG 宽高超过安全上限 ${maxSide}px，已阻止写入历史。请缩短时间范围、减少内容，或改用「生成文本预览」。`,
      rgbaTooLarge: ({ rgbaBytes, maxRgbaBytes }) => `长图 PNG 解码后约 ${formatOutputByteSize(rgbaBytes)}，超过自动保存内存上限 ${formatOutputByteSize(maxRgbaBytes)}；已阻止写入历史。请缩短时间范围、减少内容，或改用「生成文本预览」。`,
      decodedTooLarge: ({ decodedBytes, maxInflatedBytes }) => `长图 PNG 解压后约 ${formatOutputByteSize(decodedBytes)}，超过安全上限 ${formatOutputByteSize(maxInflatedBytes)}；已阻止写入历史。请缩短时间范围、减少内容，或改用「生成文本预览」。`,
    },
  };
}

function pngPayloadError(message, code = 'png_payload_invalid', status = 400) {
  const err = new Error(message || '长图 PNG 数据无效，已阻止写入历史。');
  err.status = status;
  err.code = code;
  err.public_code = code;
  return err;
}

function formatOutputByteSize(bytes = 0) {
  const value = Math.max(0, Number(bytes || 0) || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)}KB`;
  return `${value}B`;
}

function assertDigestHasMessages(digest = {}) {
  if (!digest || typeof digest !== 'object' || Array.isArray(digest) || digestLooksEmpty(digest) || digestMissingMessageEvidence(digest)) {
    const err = new Error('摘要没有可保存的消息，已阻止写入历史。请重新生成，或放宽时间范围和筛选条件。');
    err.status = 400;
    err.code = 'digest_json_empty';
    throw err;
  }
}

function digestLooksEmpty(digest = {}) {
  if (!digest || typeof digest !== 'object' || Array.isArray(digest)) return true;
  if (!Object.hasOwn(digest, 'message_count')) return false;
  const messageCount = Number(digest.message_count || 0);
  const inputCount = Number(digest.input_message_count || 0);
  const scannedCount = Number(digest.scanned_message_count || 0);
  if (Number.isFinite(messageCount) && messageCount > 0) return false;
  if (Number.isFinite(inputCount) && inputCount > 0) return false;
  if (Number.isFinite(scannedCount) && scannedCount > 0) return false;
  return true;
}

function digestLooksEmptyForHistoryRead(digest = {}) {
  return digestLooksEmpty(digest) && !digestHasVisibleSummaryContent(digest);
}

function historyDigestIdMismatch(digest = {}, expectedDigestId = '') {
  const expected = String(expectedDigestId || '').trim();
  if (!expected || !digest || typeof digest !== 'object' || Array.isArray(digest)) return false;
  return String(digest.digest_id || '').trim() !== expected;
}

function digestMissingMessageEvidence(digest = {}) {
  const hasCount = ['message_count', 'input_message_count', 'scanned_message_count']
    .some(key => Object.hasOwn(digest, key));
  return !hasCount && !digestHasVisibleSummaryContent(digest);
}

function digestHasVisibleSummaryContent(digest = {}) {
  return ['highlights', 'topics', 'links', 'quotes', 'todos']
    .some(key => Array.isArray(digest?.[key]) && digest[key].length > 0);
}

function digestJsonPathForPng(filePath) {
  return filePath.replace(/\.png$/i, '.digest.json');
}

function historyRerenderVersionedFilename(target = '') {
  const original = path.basename(String(target || ''), path.extname(String(target || '')));
  const stem = original.replace(/__rerender_\d{17}_[a-f0-9]{12}$/i, '').slice(0, 170) || 'digest';
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17);
  return `${stem}__rerender_${stamp}_${crypto.randomBytes(6).toString('hex')}.png`;
}

async function writeHistoryRerenderVersion(base, sourceTarget, pngBuffer, digest, { signal = null, shouldAbort = null } = {}) {
  const dir = path.dirname(sourceTarget);
  await assertSafeOutputParent(base, path.join(dir, 'placeholder.png'));
  for (let attempt = 0; attempt < 20; attempt++) {
    throwIfOutputAborted(signal, shouldAbort);
    const filePath = path.join(dir, historyRerenderVersionedFilename(sourceTarget));
    const digestPath = digestJsonPathForPng(filePath);
    const markerPath = historyRerenderCommitMarkerPath(digestPath);
    const markerExists = await fsp.lstat(markerPath).then(() => true).catch(error => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (markerExists) continue;
    try {
      await writeBinaryExclusiveAtomic(filePath, pngBuffer, { signal, shouldAbort });
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    try {
      await writeDigestJsonExclusive(digestPath, digest, { signal, shouldAbort });
      return { file_path: filePath, digest_path: digestPath, marker_path: markerPath };
    } catch (error) {
      await fsp.rm(filePath, { force: true }).catch(() => {});
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw Object.assign(new Error('无法创建唯一的重渲染版本文件，请重试。'), { status: 409, code: 'history_rerender_filename_collision' });
}

function throwIfOutputAborted(signal, shouldAbort = null) {
  if (!signal?.aborted && !(typeof shouldAbort === 'function' && shouldAbort())) return;
  throw Object.assign(new Error('请求已取消'), { status: 499, name: 'AbortError' });
}

function isOutputAbortError(error) {
  return error?.status === 499 || error?.name === 'AbortError';
}

async function cleanupRenderedPair(filePath, digestPath, ...extraPaths) {
  const paths = [filePath, digestPath, ...extraPaths].filter(Boolean);
  const results = await Promise.allSettled(paths.map(file => fsp.rm(file, { force: true })));
  const failed = results.filter(result => result.status === 'rejected');
  if (!failed.length) return;
  const err = new Error(`有 ${failed.length} 个未提交输出文件清理失败`);
  err.code = 'output_save_cleanup_incomplete';
  err.cleanup_failed_count = failed.length;
  throw err;
}

async function writeDigestJson(filePath, digest, { signal = null, shouldAbort = null } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  const buffer = serializePersistedDigest(digest);
  await writeBinaryAtomic(filePath, buffer, { signal, shouldAbort });
  throwIfOutputAborted(signal, shouldAbort);
  return buffer;
}

async function writeDigestJsonExclusive(filePath, digest, { signal = null, shouldAbort = null } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  const buffer = serializePersistedDigest(digest);
  await writeBinaryExclusiveAtomic(filePath, buffer, { signal, shouldAbort });
  // The target is published now. Let the caller record ownership before a later
  // cancellation check so rollback cannot strand an unowned digest JSON.
  return buffer;
}

function digestJsonTooLargeError(bytes = 0, maxBytes = HISTORY_DIGEST_JSON_MAX_BYTES, artifactLabel = '摘要 JSON') {
  const err = new Error(`${artifactLabel}约 ${formatOutputByteSize(bytes)}，超过可安全保存并再次读取的 ${formatOutputByteSize(maxBytes)} 上限；未写入历史。请缩短时间范围、减少内容，或改用「生成文本预览」。`);
  err.status = 413;
  err.code = 'digest_json_too_large';
  err.public_code = err.code;
  err.bytes = Math.max(0, Number(bytes || 0) || 0);
  err.max_bytes = Math.max(0, Number(maxBytes || 0) || 0);
  return err;
}

function serializePersistedDigest(digest = {}) {
  const buffer = Buffer.from(JSON.stringify(persistedDigest(digest), null, 2), 'utf-8');
  if (buffer.length > HISTORY_DIGEST_JSON_MAX_BYTES) throw digestJsonTooLargeError(buffer.length);
  return buffer;
}

function cleanHistoryDigestRevision(value = '') {
  const revision = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(revision) ? revision : '';
}

function persistedDigest(digest = {}) {
  const historyRerender = cleanHistoryRerenderMetadata(digest.__history_rerender);
  const sourceDigestId = String(digest.source_digest_id || '').trim().slice(0, 320);
  const sourceHistoryItemKey = cleanHistoryItemKey(digest.source_history_item_key);
  const sourceExpectedFileVersion = String(digest.source_expected_file_version || '').trim().slice(0, 320);
  const sourceExpectedDigestFileVersion = String(digest.source_expected_digest_file_version || '').trim().slice(0, 320);
  const sourceDigestRevision = cleanHistoryDigestRevision(digest.source_digest_revision);
  const historyRestoreSource = sourceDigestId || sourceHistoryItemKey || sourceExpectedFileVersion || sourceExpectedDigestFileVersion || sourceDigestRevision
    ? {
      source_digest_id: sourceDigestId,
      source_history_item_key: sourceHistoryItemKey,
      source_expected_file_version: sourceExpectedFileVersion,
      source_expected_digest_file_version: sourceExpectedDigestFileVersion,
      source_digest_revision: sourceDigestRevision,
    }
    : null;
  return {
    digest_id: String(digest.digest_id || ''),
    account_id: String(digest.account_id || ''),
    account_identity_id: String(digest.account_identity_id || ''),
    account_label: String(digest.account_label || ''),
    group_id: String(digest.group_id || digest.source_snapshot?.group_id || '').trim(),
    group: String(digest.group || ''),
    since: String(digest.since || ''),
    until: String(digest.until || ''),
    message_count: Number(digest.message_count || 0),
    input_message_count: Number(digest.input_message_count || digest.message_count || 0),
    scanned_message_count: Number(digest.scanned_message_count || digest.message_count || 0),
    pre_filter_message_count: Math.max(0, Number(digest.pre_filter_message_count || 0) || 0),
    filtered_out_message_count: Math.max(0, Number(digest.filtered_out_message_count || 0) || 0),
    filter_active: !!digest.filter_active,
    truncated: !!digest.truncated,
    source_label: String(digest.source_label || ''),
    source_snapshot: cleanSourceSnapshot(digest.source_snapshot),
    message_table_time_range: cleanMessageTableTimeRange(digest.message_table_time_range),
    media_status: cleanMediaStatus(digest.media_status),
    media_model_status: cleanMediaModelStatus(digest.media_model_status),
    link_status: cleanLinkStatus(digest.link_status),
    model: String(digest.model || ''),
    headline: String(digest.headline || ''),
    highlights: cleanHighlights(digest.highlights),
    mentions_me: [],
    todos: cleanTodos(digest.todos),
    topics: cleanTopics(digest.topics),
    links: cleanLinks(digest.links),
    quotes: cleanQuotes(digest.quotes),
    __render: cleanRender(digest.__render),
    ...(historyRerender ? { __history_rerender: historyRerender } : {}),
    ...(historyRestoreSource ? historyRestoreSource : {}),
    created_at: String(digest.created_at || ''),
    ...(digest.restored_at ? { restored_at: String(digest.restored_at) } : {}),
  };
}

function historyDigestFileVersionRequiredError() {
  const err = new Error('缺少原摘要 JSON 版本，请刷新历史记录后从具体卡片重新操作。');
  err.status = 428;
  err.code = 'history_digest_version_required';
  err.public_code = 'history_digest_version_required';
  err.artifact = 'digest';
  return err;
}

export function digestSemanticRevision(digest = {}) {
  const semantic = persistedDigest(digest);
  delete semantic.__render;
  delete semantic.__history_rerender;
  return crypto.createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}

function cleanSourceSnapshot(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const cleanSnapshotRef = value => {
    const ref = String(value || '').trim().toLowerCase();
    return /^(?:meta-)?sha256:[a-f0-9]{8,64}$/i.test(ref) ? ref : '';
  };
  const snapshotRefs = [...new Set((Array.isArray(source.snapshot_refs) ? source.snapshot_refs : [])
    .map(cleanSnapshotRef)
    .filter(Boolean))].slice(0, 200);
  const groupIds = [...new Set((Array.isArray(source.group_ids) ? source.group_ids : [])
    .map(item => String(item || '').trim().slice(0, 240))
    .filter(Boolean))].slice(0, 200);
  const out = {
    source: String(source.source || '').trim(),
    scope: String(source.scope || '').trim(),
    account_id: String(source.account_id || '').trim(),
    group_id: String(source.group_id || '').trim(),
    since: String(source.since || '').trim(),
    until: String(source.until || '').trim(),
    snapshot_ref: cleanSnapshotRef(source.snapshot_ref),
    ...(snapshotRefs.length ? { snapshot_refs: snapshotRefs } : {}),
    ...(groupIds.length ? { group_ids: groupIds } : {}),
    digest_count: Math.max(0, Math.min(200, Number(source.digest_count || 0) || 0)),
    mirror_root: String(source.mirror_root || '').trim(),
    source_last_write_time: String(source.source_last_write_time || '').trim(),
    mirror_last_write_time: String(source.mirror_last_write_time || '').trim(),
    mirror_refreshed_at: String(source.mirror_refreshed_at || '').trim(),
    captured_at: String(source.captured_at || '').trim(),
    stale: source.stale === true,
    source_busy: source.source_busy === true,
    offline: source.offline === true,
    source_access: String(source.source_access || '').trim(),
    mirror_refresh_reason: String(source.mirror_refresh_reason || '').trim(),
    mirror_refresh_action: String(source.mirror_refresh_action || '').trim(),
    db_count: Math.max(0, Number(source.db_count || 0) || 0),
    bytes: Math.max(0, Number(source.bytes || 0) || 0),
  };
  return Object.fromEntries(Object.entries(out).filter(([, item]) => item !== '' && item !== 0));
}

function cleanMessageTableTimeRange(value) {
  const range = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!range) return null;
  return {
    row_count: Math.max(0, Number(range.row_count || 0) || 0),
    hit_count: Math.max(0, Number(range.hit_count || 0) || 0),
    create_time_hit_count: Math.max(0, Number(range.create_time_hit_count || 0) || 0),
    sort_seq_hit_count: Math.max(0, Number(range.sort_seq_hit_count || 0) || 0),
    sort_only_hit_count: Math.max(0, Number(range.sort_only_hit_count || 0) || 0),
    fallback_hit_count: Math.max(0, Number(range.fallback_hit_count || 0) || 0),
    shard_count: Math.max(0, Number(range.shard_count || 0) || 0),
    hit_shard_count: Math.max(0, Number(range.hit_shard_count || 0) || 0),
    first_time: String(range.first_time || ''),
    last_time: String(range.last_time || ''),
    sort_first_time: String(range.sort_first_time || ''),
    sort_last_time: String(range.sort_last_time || ''),
  };
}

function cleanMediaStatus(value) {
  const status = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!status) return null;
  const mediaMessages = Math.max(0, Number(status.media_messages || 0) || 0);
  if (!mediaMessages) return null;
  return {
    media_messages: mediaMessages,
    attached: Math.max(0, Number(status.attached || 0) || 0),
    metadata_only: Math.max(0, Number(status.metadata_only || 0) || 0),
    omitted: Math.max(0, Number(status.omitted || 0) || 0),
  };
}

function cleanMediaModelStatus(value) {
  const status = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!status || status.fallback_to_text !== true) return null;
  const imageCount = Math.max(0, Number(status.image_count || 0) || 0);
  const audioCount = Math.max(0, Number(status.audio_count || 0) || 0);
  if (!imageCount && !audioCount) return null;
  return {
    fallback_to_text: true,
    reason: String(status.reason || '').trim().slice(0, 80),
    mode: String(status.mode || '').trim().slice(0, 80),
    image_count: imageCount,
    audio_count: audioCount,
    message: String(status.message || '').trim().slice(0, MEDIA_MODEL_STATUS_MESSAGE_MAX_CHARS),
    error: String(status.error || '').trim().slice(0, 160),
  };
}

function cleanLinkStatus(value) {
  const status = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!status) return null;
  const links = Math.max(0, Number(status.links || 0) || 0);
  if (!links) return null;
  return {
    links,
    processed: Math.max(0, Number(status.processed || 0) || 0),
    succeeded: Math.max(0, Number(status.succeeded || 0) || 0),
    failed: Math.max(0, Number(status.failed || 0) || 0),
    skipped: Math.max(0, Number(status.skipped || 0) || 0),
    ai_research_requested: Math.max(0, Number(status.ai_research_requested || 0) || 0),
    ai_researched: Math.max(0, Number(status.ai_researched || 0) || 0),
    ai_research_failed_batches: Math.max(0, Number(status.ai_research_failed_batches || 0) || 0),
    ai_research_skipped: !!status.ai_research_skipped,
  };
}

function cleanRender(value) {
  const render = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const theme = ['light', 'dark'].includes(render.theme) ? render.theme : '';
  const fontSize = render.font_size === 'large' ? 'large' : render.font_size === 'normal' ? 'normal' : '';
  const accentColor = /^#[0-9a-fA-F]{6}$/.test(String(render.accent_color || '')) ? String(render.accent_color).toUpperCase() : '';
  return {
    theme,
    font_size: fontSize,
    accent_color: accentColor,
    renderer_version: cleanRendererVersion(render.renderer_version),
    renderer_engine: cleanRendererEngine(render.renderer_engine),
  };
}

function cleanRendererVersion(value = 0) {
  const version = Number(value || 0) || 0;
  return Number.isInteger(version) && version > 0 && version <= 9999 ? version : 0;
}

function digestRendererVersion(digest = {}) {
  return cleanRendererVersion(digest?.__render?.renderer_version);
}

function cleanRendererEngine(value = '') {
  const engine = String(value || '').trim();
  return [
    DigestView.DIGEST_RENDERER_ENGINE_BROWSER,
    DigestView.DIGEST_RENDERER_ENGINE_SERVER,
  ].includes(engine) ? engine : '';
}

function digestRendererEngine(digest = {}) {
  return cleanRendererEngine(digest?.__render?.renderer_engine);
}

function cleanTodos(value) {
  return Array.isArray(value) ? value.map(item => ({
    owner: cleanTodoMeta(item?.owner),
    item: String(item?.item || ''),
    deadline: cleanTodoMeta(item?.deadline),
  })).filter(item => item.item && isStrongTodoForRender(item)).slice(0, 20) : [];
}

function cleanTodoMeta(value) {
  const text = String(value || '').trim();
  return /^(待认领|未指定|无|暂无|不明确|待定|未定|待确认)$/.test(text) ? '' : text;
}

function isStrongTodoForRender(todo = {}) {
  const item = String(todo.item || '').trim();
  if (!item) return false;
  if (/持续关注|继续关注|保持关注|观察|对比|评估|确认是否|验证.*稳定性|排查.*原因|优化.*速度|准备.*方案|确定.*路线/.test(item)) return false;
  if (todo.owner || todo.deadline) return true;
  return /报名|付款|提交|联系|交付|报销|补发|回复|注册|开通|关闭|领取|上传|发布|更新|迁移|修复|整理|收集|安排/.test(item)
    && /请|需要|要|待|明天|今天|今晚|本周|下周|尽快|继续|统一|群里|大家|管理员|负责人/.test(item);
}

function cleanHighlights(value) {
  return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean).slice(0, 12) : [];
}

function cleanTopics(value) {
  return Array.isArray(value) ? value.map(item => ({
    title: String(item?.title || ''),
    category: String(item?.category || ''),
    participants: Array.isArray(item?.participants) ? item.participants.map(x => String(x || '')).filter(Boolean).slice(0, 12) : [],
    summary: String(item?.summary || ''),
    need_followup: !!item?.need_followup,
  })).filter(item => item.title || item.summary).slice(0, 100) : [];
}

function cleanQuotes(value) {
  return Array.isArray(value) ? value.map(item => {
    if (typeof item === 'string') return { speaker: '', text: item, context: '' };
    return {
      speaker: String(item?.speaker || item?.from || item?.sender || ''),
      text: String(item?.text || item?.quote || item?.content || ''),
      context: String(item?.context || item?.reason || ''),
    };
  }).filter(item => item.text).slice(0, 20) : [];
}

function cleanLinks(value) {
  return publicDigestLinks(Array.isArray(value) ? value.map(item => ({
    title: String(item?.title || ''),
    url: String(item?.url || ''),
    summary: cleanLinkSummary(item?.summary || ''),
    from: String(item?.from || ''),
    time: String(item?.time || ''),
    preview_status: String(item?.preview_status || ''),
    preview_error: String(item?.preview_error || ''),
  })).filter(item => isAnalyzableWebLinkUrl(item.url)) : []);
}

function cleanLinkSummary(value) {
  return String(value || '').replace(/群内反馈访问时返回\s*HTTP?\s*(\d{3})/gi, '本程序打开该链接时返回 HTTP $1')
    .replace(/群内反馈访问时返回\s*(\d{3})/g, '本程序打开该链接时返回 HTTP $1')
    .replace(/群内反馈访问返回\s*HTTP?\s*(\d{3})/gi, '本程序打开该链接时返回 HTTP $1')
    .replace(/群内反馈访问返回\s*(\d{3})/g, '本程序打开该链接时返回 HTTP $1');
}

const DIRECT_MEDIA_URL_RE = /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp|mp4|m4v|mov|avi|mkv|webm|3gp|mp3|wav|m4a|aac|oga?|flac|amr|silk)(?:$|[?#])/i;

function isAnalyzableWebLinkUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(parsed.protocol) && !DIRECT_MEDIA_URL_RE.test(parsed.href) && !isIgnoredWebLinkUrl(parsed);
  } catch {
    return false;
  }
}

function publicDigestLinks(links, limit = 12) {
  return DigestView.digestLinksForRender({ links }).slice(0, limit);
}

function isIgnoredWebLinkUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  if (host === 'mp.weixin.qq.com' && (pathname.startsWith('/mp/wappoc_appmsgcaptcha') || pathname.startsWith('/mp/waerrpage'))) return true;
  if (host === 'support.weixin.qq.com' && (pathname.startsWith('/cgi-bin/mmsupport-bin/readtemplate') || pathname.startsWith('/update'))) return true;
  if (host === 'wxapp.tenpay.com' && pathname.startsWith('/mmpayhb/')) return true;
  return false;
}

async function writeBinaryAtomic(filePath, buffer, { signal = null, shouldAbort = null } = {}) {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let handle = null;
  try {
    throwIfOutputAborted(signal, shouldAbort);
    handle = await fsp.open(tmp, 'wx');
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    throwIfOutputAborted(signal, shouldAbort);
    await renameAtomicWithRetry(tmp, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (e) {
    await handle?.close?.().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

async function copyOutputSourceToHandle(sourceFile, handle, { signal = null, shouldAbort = null } = {}) {
  const source = await fsp.open(sourceFile, 'r');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let position = 0;
  try {
    while (true) {
      throwIfOutputAborted(signal, shouldAbort);
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      let bytesWritten = 0;
      while (bytesWritten < bytesRead) {
        throwIfOutputAborted(signal, shouldAbort);
        const result = await handle.write(buffer, bytesWritten, bytesRead - bytesWritten, position + bytesWritten);
        if (!result.bytesWritten) {
          throw Object.assign(new Error('输出文件复制写入未取得进展。'), { code: 'output_file_write_stalled' });
        }
        bytesWritten += result.bytesWritten;
      }
      position += bytesRead;
    }
  } finally {
    await source.close().catch(() => {});
  }
}

function outputFilenameCandidates(filename = '') {
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  const candidates = [];
  for (let i = 0; i < 100; i++) candidates.push(i === 0 ? filename : `${stem}_${i + 1}${ext}`);
  candidates.push(`${stem}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`);
  return candidates;
}

async function runOutputSavePhaseHook(hook, phase, detail = {}) {
  if (typeof hook === 'function') await hook(phase, { ...detail });
}

function outputSaveTransactionConflict(message, code = 'output_save_transaction_conflict') {
  return Object.assign(new Error(message), { status: 409, code, public_code: code });
}

async function writeTransactionalDigestPair({
  base,
  dir,
  filename,
  digest,
  pngBuffer = null,
  pngFile = '',
  operationId = '',
  signal = null,
  shouldAbort = null,
  phaseHook = null,
}) {
  const cleanOperationId = cleanDigestSaveOperationId(operationId) || crypto.randomUUID();
  const firstTarget = path.join(dir, filename);
  const tmp = await writeOutputTempFile(firstTarget, handle => (
    pngBuffer
      ? handle.writeFile(pngBuffer)
      : copyOutputSourceToHandle(pngFile, handle, { signal, shouldAbort })
  ), { signal, shouldAbort });
  try {
    const [tmpStat, tmpVersion] = await Promise.all([
      fsp.stat(tmp),
      outputFileVersion(tmp, { signal, shouldAbort }),
    ]);
    const pngBytes = Number(tmpStat?.size || 0);
    const pngSha256 = outputFileVersionHash(tmpVersion);
    if (!pngBytes || !pngSha256) {
      throw Object.assign(new Error('无法为待保存长图生成内容校验值。'), { code: 'output_save_png_fingerprint_failed' });
    }
    for (const candidate of outputFilenameCandidates(filename)) {
      throwIfOutputAborted(signal, shouldAbort);
      const filePath = path.join(dir, candidate);
      const digestPath = digestJsonPathForPng(filePath);
      const markerPath = digestSaveTransactionMarkerPath(digestPath);
      await assertSafeOutputParent(base, filePath);
      await assertSafeOutputParent(base, digestPath);
      await assertSafeOutputParent(base, markerPath);
      const prepared = digestSaveTransactionPayload(base, {
        operationId: cleanOperationId,
        filePath,
        digestPath,
        tempPath: tmp,
        digest,
        pngBytes,
        pngSha256,
        state: 'prepared',
      });
      let markerOwned = false;
      let pngOwned = false;
      let digestOwned = false;
      try {
        try {
          await writeBinaryExclusiveAtomic(markerPath, digestSaveTransactionMarkerBuffer(prepared), { signal, shouldAbort });
          markerOwned = true;
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          const existing = await readDigestSaveTransactionMarker(base, markerPath, { signal });
          if (!existing || existing.operation_id !== cleanOperationId) continue;
          if (existing.png_bytes !== pngBytes
            || existing.png_sha256 !== pngSha256
            || !persistedDigestsEqual(existing.digest, digest)) {
            throw outputSaveTransactionConflict('同一长图保存操作的内容已变化，已停止重试，避免覆盖原文件。', 'output_save_transaction_mismatch');
          }
          const recovery = await recoverDigestSaveTransactionMarker(base, markerPath, { signal });
          if (recovery.valid_pair) {
            return {
              file_path: existing.file_path,
              digest_path: existing.digest_path,
              marker_path: existing.marker_path,
              operation_id: cleanOperationId,
              reused: true,
            };
          }
          if (!recovery.pending || recovery.warning) {
            throw outputSaveTransactionConflict('同一长图保存操作留下的文件无法自动恢复，已停止创建重复文件。');
          }
          markerOwned = true;
        }
        const markerKey = historyPathDedupeKey(markerPath);
        activeDigestSaveTransactionMarkers.add(markerKey);
        try {
          await runOutputSavePhaseHook(phaseHook, 'after_marker_prepare', { file_path: filePath, digest_path: digestPath, marker_path: markerPath });
          if (!await linkTempFileToUniqueTarget(tmp, filePath)) {
            await fsp.rm(markerPath, { force: true });
            markerOwned = false;
            continue;
          }
          pngOwned = true;
          await runOutputSavePhaseHook(phaseHook, 'after_png_publish', { file_path: filePath, digest_path: digestPath, marker_path: markerPath });
          try {
            await writeDigestJsonExclusive(digestPath, digest, { signal, shouldAbort });
            digestOwned = true;
          } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            const existingDigest = await readJson(digestPath, null, { strict: false, maxBytes: HISTORY_DIGEST_JSON_MAX_BYTES, signal });
            if (!existingDigest || !persistedDigestsEqual(existingDigest, digest)) throw error;
          }
          await runOutputSavePhaseHook(phaseHook, 'after_digest_commit', { file_path: filePath, digest_path: digestPath, marker_path: markerPath });
          const [savedFileVersion, savedDigestFileVersion] = await Promise.all([
            outputFileVersionAfterCommit(filePath),
            outputFileVersionAfterCommit(digestPath),
          ]);
          const committed = digestSaveTransactionPayload(base, {
            ...prepared,
            operationId: cleanOperationId,
            filePath,
            digestPath,
            tempPath: tmp,
            digest,
            pngBytes,
            pngSha256,
            state: 'committed',
            preparedAt: prepared.prepared_at,
            committedAt: new Date().toISOString(),
            savedFileVersion,
            savedDigestFileVersion,
          });
          await writeBinaryAtomic(markerPath, digestSaveTransactionMarkerBuffer(committed), { signal, shouldAbort });
          await runOutputSavePhaseHook(phaseHook, 'after_marker_commit', { file_path: filePath, digest_path: digestPath, marker_path: markerPath });
          return {
            file_path: filePath,
            digest_path: digestPath,
            marker_path: markerPath,
            operation_id: cleanOperationId,
            reused: false,
          };
        } finally {
          activeDigestSaveTransactionMarkers.delete(markerKey);
        }
      } catch (error) {
        const cleanupTargets = [
          digestOwned ? digestPath : '',
          pngOwned ? filePath : '',
          markerOwned ? markerPath : '',
        ].filter(Boolean);
        const cleanup = await Promise.allSettled(cleanupTargets.map(target => fsp.rm(target, { force: true })));
        const cleanupFailures = cleanup.filter(result => result.status === 'rejected');
        if (cleanupFailures.length) {
          throw Object.assign(new Error('长图保存未完成，且部分事务文件无法清理。请检查输出目录后重试。'), {
            status: 500,
            code: 'output_save_cleanup_failed',
            public_code: 'output_save_cleanup_failed',
            original_error: error?.message || String(error || 'save failed'),
            cleanup_failed_count: cleanupFailures.length,
          });
        }
        throw error;
      }
    }
    throw Object.assign(new Error('输出文件名冲突，请重试。'), { status: 409, code: 'output_file_exists' });
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

async function writeTextUnique(dir, filename, text, { signal = null, shouldAbort = null } = {}) {
  const buffer = Buffer.from(text, 'utf-8');
  return writeUniqueFile(dir, filename, handle => handle.writeFile(buffer), { signal, shouldAbort });
}

async function writeUniqueFile(dir, filename, writer, { signal = null, shouldAbort = null } = {}) {
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  const firstTarget = path.join(dir, filename);
  const tmp = await writeOutputTempFile(firstTarget, writer, { signal, shouldAbort });
  try {
    for (let i = 0; i < 100; i++) {
      throwIfOutputAborted(signal, shouldAbort);
      const candidate = i === 0 ? filename : `${stem}_${i + 1}${ext}`;
      const target = path.join(dir, candidate);
      if (await linkTempFileToUniqueTarget(tmp, target)) return target;
    }
    const fallback = path.join(dir, `${stem}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`);
    throwIfOutputAborted(signal, shouldAbort);
    if (await linkTempFileToUniqueTarget(tmp, fallback)) return fallback;
    throw Object.assign(new Error('输出文件名冲突，请重试。'), { status: 409, code: 'output_file_exists' });
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

async function writeOutputTempFile(targetPath, writer, { signal = null, shouldAbort = null } = {}) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const tmp = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let handle = null;
    try {
      throwIfOutputAborted(signal, shouldAbort);
      handle = await fsp.open(tmp, 'wx');
      throwIfOutputAborted(signal, shouldAbort);
      await writer(handle);
      await handle.sync();
      throwIfOutputAborted(signal, shouldAbort);
      await handle.close();
      handle = null;
      return tmp;
    } catch (e) {
      if (handle) await handle.close().catch(() => {});
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if (e?.code === 'EEXIST') continue;
      throw e;
    }
  }
  throw Object.assign(new Error('无法创建输出临时文件，请重试。'), { status: 409, code: 'output_temp_collision' });
}

async function linkTempFileToUniqueTarget(tmp, target) {
  try {
    await fsp.link(tmp, target);
    await syncDirectory(path.dirname(target));
    return true;
  } catch (e) {
    if (e?.code === 'EEXIST') return false;
    if (['EPERM', 'EXDEV', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EMLINK', 'EINVAL'].includes(e?.code)) {
      return copyTempFileToUniqueTarget(tmp, target);
    }
    throw e;
  }
}

async function copyTempFileToUniqueTarget(tmp, target) {
  let targetMayBeOwned = false;
  try {
    targetMayBeOwned = true;
    await fsp.copyFile(tmp, target, fsConstants.COPYFILE_EXCL);
    const handle = await fsp.open(target, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(path.dirname(target));
    return true;
  } catch (e) {
    if (e?.code === 'EEXIST') return false;
    if (targetMayBeOwned) await fsp.rm(target, { force: true }).catch(() => {});
    throw e;
  }
}

function isAtomicOutputTempName(name = '') {
  return /\.\d+\.[a-f0-9]{8}\.tmp$/i.test(String(name || ''));
}

async function removeStaleAtomicOutputTemp(filePath, stat, { signal = null } = {}) {
  throwIfOutputAborted(signal);
  if (!stat?.isFile?.()) return false;
  const age = Date.now() - Number(stat.mtimeMs || 0);
  if (!Number.isFinite(age) || age < OUTPUT_ATOMIC_TEMP_MAX_AGE_MS) return false;
  await fsp.rm(filePath, { force: true }).catch(() => {});
  return true;
}

async function removeOutputFileIfSafe(base, targetPath, extension = '') {
  const file = await assertReadableOutputFile(base, targetPath, { extensions: extension ? [extension] : [] });
  await fsp.rm(file, { force: true });
  return true;
}

function retentionTransactionError(message, code = 'retention_transaction_invalid') {
  return Object.assign(new Error(message), { status: 500, code, public_code: code });
}

function cleanRetentionTransactionId(value = '') {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text) ? text : '';
}

function retentionTransactionIdFromPendingPath(value = '') {
  const match = String(value || '').match(/\.retention-delete-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.pending$/i);
  return cleanRetentionTransactionId(match?.[1]);
}

function retentionTransactionManifestPath(stagedPath = '') {
  const staged = String(stagedPath || '').trim();
  return staged ? `${staged}${RETENTION_TRANSACTION_MANIFEST_SUFFIX}` : '';
}

function retentionTransactionRelativePath(base, targetPath) {
  const root = path.resolve(String(base || ''));
  const target = path.resolve(String(targetPath || ''));
  if (!root || !target || !isInside(root, target) || root === target) return '';
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.replace(/\\/g, '/');
}

function retentionTransactionPayload(base, {
  transactionId = '',
  originalPath = '',
  stagedPath = '',
  role = '',
  expectedVersion = '',
  fileVersion = '',
} = {}) {
  const cleanId = cleanRetentionTransactionId(transactionId);
  const originalRelativePath = retentionTransactionRelativePath(base, originalPath);
  const stagedRelativePath = retentionTransactionRelativePath(base, stagedPath);
  const cleanRole = String(role || '').trim();
  const cleanExpectedVersion = String(expectedVersion || '').trim();
  const cleanFileVersion = String(fileVersion || '').trim();
  if (!cleanId || !originalRelativePath || !stagedRelativePath) {
    throw retentionTransactionError('历史清理事务路径无效。');
  }
  if (!['marker', 'save_marker', 'sidecar', 'primary'].includes(cleanRole)) {
    throw retentionTransactionError('历史清理事务文件角色无效。');
  }
  if (outputFileVersionKind(cleanFileVersion) !== 'v2') {
    throw retentionTransactionError('历史清理事务缺少可验证的文件内容版本。');
  }
  if (cleanExpectedVersion && !outputFileVersionKind(cleanExpectedVersion)) {
    throw retentionTransactionError('历史清理事务的索引文件版本无效。');
  }
  return {
    schema: RETENTION_TRANSACTION_SCHEMA,
    version: RETENTION_TRANSACTION_VERSION,
    transaction_id: cleanId,
    output_dir_identity: outputDirIdentityForBase(base),
    original_relative_path: originalRelativePath,
    staged_relative_path: stagedRelativePath,
    role: cleanRole,
    expected_version: cleanExpectedVersion,
    file_version: cleanFileVersion,
    prepared_at: new Date().toISOString(),
  };
}

async function writeRetentionTransactionManifest(base, detail = {}) {
  const payload = retentionTransactionPayload(base, detail);
  const stagedPath = path.resolve(base, payload.staged_relative_path);
  const manifestPath = retentionTransactionManifestPath(stagedPath);
  await assertSafeOutputParent(base, manifestPath);
  await writeBinaryExclusiveAtomic(manifestPath, Buffer.from(JSON.stringify(payload, null, 2), 'utf-8'));
  return { payload, manifest_path: manifestPath };
}

async function removeRetentionTransactionManifest(stage = {}) {
  const manifestPath = String(stage?.manifest_path || '').trim();
  if (!manifestPath) return false;
  await fsp.rm(manifestPath, { force: true });
  await syncDirectory(path.dirname(manifestPath));
  return true;
}

async function stageExpiredHistoryFile(base, targetPath, extension = '', {
  expectedVersion = '',
  versionRequired = false,
  role = '',
} = {}) {
  if (!targetPath) return { ready: true, missing: true, original_path: '', staged_path: '' };
  let file;
  try {
    file = await assertReadableOutputFile(base, targetPath, { extensions: extension ? [extension] : [] });
  } catch (error) {
    if (error?.code === 'output_file_missing' || error?.code === 'ENOENT') {
      return { ready: true, missing: true, original_path: path.resolve(targetPath), staged_path: '' };
    }
    return { ready: false, missing: false, original_path: path.resolve(targetPath), staged_path: '', error };
  }
  const expected = String(expectedVersion || '').trim();
  if (versionRequired && !expected) {
    return {
      ready: false,
      missing: false,
      original_path: file,
      staged_path: '',
      error: Object.assign(new Error('历史文件缺少可校验内容版本，已停止自动删除。'), { code: 'retention_file_version_required' }),
    };
  }
  let beforeVersion = '';
  try {
    beforeVersion = await outputFileVersion(file);
    if (expected && !outputFileVersionMatches(expected, beforeVersion)) {
      return {
        ready: false,
        missing: false,
        original_path: file,
        staged_path: '',
        error: outputFileVersionChangedError(expected, beforeVersion),
      };
    }
  } catch (error) {
    return { ready: false, missing: false, original_path: file, staged_path: '', error };
  }
  await ensureHistoryRootMarker(base);
  const stagedPath = `${file}.retention-delete-${crypto.randomUUID()}.pending`;
  const transactionId = retentionTransactionIdFromPendingPath(stagedPath);
  let manifestPath = '';
  let manifestWritten = false;
  let renamed = false;
  try {
    await assertSafeOutputParent(base, stagedPath);
    const manifest = await writeRetentionTransactionManifest(base, {
      transactionId,
      originalPath: file,
      stagedPath,
      role,
      expectedVersion: expected,
      fileVersion: beforeVersion,
    });
    manifestPath = manifest.manifest_path;
    manifestWritten = true;
    await fsp.rename(file, stagedPath);
    renamed = true;
    const stagedVersion = await outputFileVersion(stagedPath);
    if (!outputFileVersionMatches(beforeVersion, stagedVersion)
      || (expected && !outputFileVersionMatches(expected, stagedVersion))) {
      throw outputFileVersionChangedError(expected || beforeVersion, stagedVersion);
    }
    await syncDirectory(path.dirname(file));
    return {
      ready: true,
      missing: false,
      original_path: file,
      staged_path: stagedPath,
      manifest_path: manifestPath,
      transaction_id: transactionId,
      role: String(role || '').trim(),
      expected_version: expected,
      file_version: stagedVersion,
    };
  } catch (error) {
    if (renamed) {
      try {
        await rollbackExpiredHistoryFile({
          original_path: file,
          staged_path: stagedPath,
          manifest_path: manifestPath,
          file_version: beforeVersion,
        });
      } catch (rollbackError) {
        return {
          ready: false,
          missing: false,
          original_path: file,
          staged_path: stagedPath,
          manifest_path: manifestPath,
          transaction_id: transactionId,
          role: String(role || '').trim(),
          expected_version: expected,
          file_version: beforeVersion,
          error: Object.assign(new Error('历史文件暂存校验失败，且无法恢复原路径；已保留暂存文件并停止继续删除。'), {
            code: 'retention_stage_rollback_failed',
            cause: error,
            rollback_error: rollbackError?.message || String(rollbackError || ''),
          }),
        };
      }
    } else if (manifestWritten) {
      try {
        await removeRetentionTransactionManifest({ manifest_path: manifestPath });
      } catch (manifestError) {
        return {
          ready: false,
          missing: false,
          original_path: file,
          staged_path: '',
          manifest_path: manifestPath,
          transaction_id: transactionId,
          role: String(role || '').trim(),
          expected_version: expected,
          file_version: beforeVersion,
          error: Object.assign(new Error('历史文件未进入暂存状态，但事务清单无法清理；已停止继续删除。'), {
            code: 'retention_manifest_cleanup_failed',
            cause: error,
            manifest_error: manifestError?.message || String(manifestError || ''),
          }),
        };
      }
    }
    return { ready: false, missing: false, original_path: file, staged_path: '', error };
  }
}

async function writeBinaryExclusiveAtomic(filePath, buffer, { signal = null, shouldAbort = null } = {}) {
  const tmp = await writeOutputTempFile(filePath, handle => handle.writeFile(buffer), { signal, shouldAbort });
  try {
    throwIfOutputAborted(signal, shouldAbort);
    if (await linkTempFileToUniqueTarget(tmp, filePath)) return;
    throw Object.assign(new Error('目标文件已存在'), { status: 409, code: 'EEXIST' });
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

async function rollbackExpiredHistoryFile(stage = {}) {
  const original = String(stage?.original_path || '').trim();
  const staged = String(stage?.staged_path || '').trim();
  if (!original || !staged) return false;
  const [originalStat, stagedStat] = await Promise.all([
    fsp.lstat(original).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }),
    fsp.lstat(staged).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }),
  ]);
  if (originalStat && stagedStat) {
    throw retentionTransactionError('历史清理回滚时原路径已被重新占用，已保留暂存文件。', 'retention_rollback_conflict');
  }
  if (originalStat && !stagedStat) {
    await removeRetentionTransactionManifest(stage);
    return false;
  }
  if (!stagedStat?.isFile?.() || stagedStat.isSymbolicLink?.()) {
    throw retentionTransactionError('历史清理回滚暂存文件不存在或不是普通文件。', 'retention_rollback_file_missing');
  }
  const expectedVersion = String(stage?.file_version || '').trim();
  const stagedVersion = await outputFileVersion(staged);
  if (expectedVersion && !outputFileVersionMatches(expectedVersion, stagedVersion)) {
    throw outputFileVersionChangedError(expectedVersion, stagedVersion);
  }
  await fsp.rename(staged, original);
  try {
    await syncDirectory(path.dirname(original));
    await removeRetentionTransactionManifest(stage);
  } catch (error) {
    error.file_restored = true;
    throw error;
  }
  return true;
}

async function removeStagedExpiredHistoryFile(stage = {}) {
  const staged = String(stage?.staged_path || '').trim();
  if (!staged) return false;
  let fileRemoved = false;
  const stat = await fsp.lstat(staged).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (stat) {
    if (!stat.isFile?.() || stat.isSymbolicLink?.()) {
      throw retentionTransactionError('历史清理暂存目标不是普通文件，已停止删除。', 'retention_finalize_file_invalid');
    }
    const expectedVersion = String(stage?.file_version || '').trim();
    const stagedVersion = await outputFileVersion(staged);
    if (!expectedVersion || !outputFileVersionMatches(expectedVersion, stagedVersion)) {
      throw outputFileVersionChangedError(expectedVersion, stagedVersion);
    }
    await fsp.rm(staged, { force: true });
    fileRemoved = true;
  }
  try {
    if (fileRemoved) await syncDirectory(path.dirname(staged));
    await removeRetentionTransactionManifest(stage);
  } catch (error) {
    error.file_removed = fileRemoved;
    throw error;
  }
  return fileRemoved;
}

function retentionPendingOriginalPath(base, stagedPath) {
  const staged = path.resolve(String(stagedPath || ''));
  const original = staged.replace(RETENTION_PENDING_SUFFIX_RE, '');
  return original !== staged && isInside(base, original) ? original : '';
}

async function readRetentionTransactionManifest(base, manifestPath) {
  const readable = await assertReadableOutputFile(base, manifestPath, { extensions: ['.json'] });
  const payload = await readJson(readable, null, {
    strict: true,
    maxBytes: RETENTION_TRANSACTION_MAX_BYTES,
  });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw retentionTransactionError('历史清理事务清单不是有效对象。');
  }
  const transactionId = cleanRetentionTransactionId(payload.transaction_id);
  const role = String(payload.role || '').trim();
  const expectedVersion = String(payload.expected_version || '').trim();
  const fileVersion = String(payload.file_version || '').trim();
  if (payload.schema !== RETENTION_TRANSACTION_SCHEMA
    || Number(payload.version || 0) !== RETENTION_TRANSACTION_VERSION
    || payload.output_dir_identity !== outputDirIdentityForBase(base)
    || !transactionId
    || !['marker', 'save_marker', 'sidecar', 'primary'].includes(role)
    || outputFileVersionKind(fileVersion) !== 'v2'
    || (expectedVersion && !outputFileVersionKind(expectedVersion))) {
    throw retentionTransactionError('历史清理事务清单内容无效。');
  }
  const originalRelativePath = normalizeHistoryRelativePath(payload.original_relative_path);
  const stagedRelativePath = normalizeHistoryRelativePath(payload.staged_relative_path);
  if (!originalRelativePath || !stagedRelativePath
    || originalRelativePath.startsWith('../') || stagedRelativePath.startsWith('../')) {
    throw retentionTransactionError('历史清理事务清单路径无效。');
  }
  const originalPath = path.resolve(base, originalRelativePath);
  const stagedPath = path.resolve(base, stagedRelativePath);
  const expectedStagedPath = `${originalPath}.retention-delete-${transactionId}.pending`;
  const expectedManifestPath = retentionTransactionManifestPath(expectedStagedPath);
  const inferredOriginalPath = retentionPendingOriginalPath(base, stagedPath);
  if (!isInside(base, originalPath)
    || !isInside(base, stagedPath)
    || platformPathIdentity(inferredOriginalPath) !== platformPathIdentity(originalPath)
    || platformPathIdentity(stagedPath) !== platformPathIdentity(expectedStagedPath)
    || platformPathIdentity(readable) !== platformPathIdentity(expectedManifestPath)) {
    throw retentionTransactionError('历史清理事务清单与暂存路径不匹配。');
  }
  return {
    original_path: originalPath,
    staged_path: stagedPath,
    manifest_path: readable,
    transaction_id: transactionId,
    role,
    expected_version: expectedVersion,
    file_version: fileVersion,
  };
}

async function listInterruptedRetentionTransactions(base, { excludeRoots = [] } = {}) {
  const transactions = [];
  let unownedPending = 0;
  const queue = [path.resolve(base)];
  let nextDir = 0;
  let visitedEntries = 0;
  while (nextDir < queue.length) {
    if (nextDir >= RETENTION_RECOVERY_DIR_LIMIT) {
      throw Object.assign(new Error(`历史清理恢复扫描超过 ${RETENTION_RECOVERY_DIR_LIMIT} 个目录，已停止自动清理，避免遗漏文件。`), {
        status: 500,
        code: 'retention_recovery_dir_limit',
      });
    }
    const dir = queue[nextDir++];
    if (excludeRoots.some(excludeRoot => isInside(excludeRoot, dir))) continue;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(error => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      visitedEntries++;
      if (visitedEntries > RETENTION_RECOVERY_ENTRY_LIMIT) {
        throw Object.assign(new Error(`历史清理恢复扫描超过 ${RETENTION_RECOVERY_ENTRY_LIMIT} 个目录项，已停止自动清理，避免遗漏文件。`), {
          status: 500,
          code: 'retention_recovery_entry_limit',
        });
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (RETENTION_TRANSACTION_MANIFEST_RE.test(entry.name)) throw outputPathError('retention recovery manifest is a symlink or junction');
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (RETENTION_PENDING_SUFFIX_RE.test(entry.name)) {
        unownedPending++;
        continue;
      }
      if (!RETENTION_TRANSACTION_MANIFEST_RE.test(entry.name)) continue;
      transactions.push(await readRetentionTransactionManifest(base, full));
    }
  }
  return { transactions, unowned_pending: unownedPending };
}

function retentionReferencedArtifactPaths(base, list = []) {
  const referenced = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    for (const artifact of retentionArtifactDescriptors(base, item)) referenced.add(platformPathIdentity(artifact.path));
  }
  return referenced;
}

function retentionReferencedArtifactVersions(base, list = []) {
  const referenced = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    for (const artifact of retentionArtifactDescriptors(base, item)) {
      const expected = String(artifact.expected_version || '').trim();
      if (!expected) continue;
      const key = platformPathIdentity(artifact.path);
      const versions = referenced.get(key) || new Set();
      versions.add(expected);
      referenced.set(key, versions);
    }
  }
  return referenced;
}

function retentionIndexFingerprint(items = []) {
  if (!Array.isArray(items)) return '';
  const normalized = items.map(historyIndexItem);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function retentionIndexCommitObserved(settings, base, {
  committedItems = [],
  previousItems = [],
  stagedArtifacts = [],
} = {}) {
  const index = await retentionRecoveryIndex(settings, base);
  if (!index.usable) return null;
  const observedFingerprint = retentionIndexFingerprint(index.items);
  const committedFingerprint = retentionIndexFingerprint(committedItems);
  const previousFingerprint = retentionIndexFingerprint(previousItems);
  if (observedFingerprint && observedFingerprint === committedFingerprint) return true;
  if (observedFingerprint && observedFingerprint === previousFingerprint) return false;
  if (!stagedArtifacts.length) return null;
  const referenced = retentionReferencedArtifactPaths(base, index.items);
  const states = stagedArtifacts.map(stage => referenced.has(platformPathIdentity(stage.original_path)));
  if (states.every(value => value === false)) return true;
  if (states.every(value => value === true)) return false;
  return null;
}

async function retentionRecoveryIndex(settings, base) {
  const file = path.join(base, 'index.json');
  const stat = await fsp.lstat(file).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isFile?.() || stat.isSymbolicLink?.()) return { usable: false, items: [] };
  try {
    const items = await readHistoryIndexFromBase(settings, base, {
      repair: false,
      rebuildMissing: false,
      writeRepair: false,
    });
    return { usable: true, items };
  } catch {
    return { usable: false, items: [] };
  }
}

async function recoverInterruptedRetentionCleanup(settings, base, { excludeRoots = [] } = {}) {
  const scan = await listInterruptedRetentionTransactions(base, { excludeRoots });
  const transactions = scan.transactions;
  if (!transactions.length) return { restored: 0, finalized: 0, preserved: scan.unowned_pending };
  const index = await retentionRecoveryIndex(settings, base);
  const referencedPaths = index.usable ? retentionReferencedArtifactPaths(base, index.items) : new Set();
  const referencedVersions = index.usable ? retentionReferencedArtifactVersions(base, index.items) : new Map();
  const byOriginal = new Map();
  for (const transaction of transactions) {
    const key = platformPathIdentity(transaction.original_path);
    const matches = byOriginal.get(key) || [];
    matches.push(transaction);
    byOriginal.set(key, matches);
  }
  for (const matches of byOriginal.values()) {
    if (matches.length <= 1) continue;
    throw Object.assign(new Error('同一历史文件存在多个未完成的清理暂存版本，已停止自动恢复，避免覆盖数据。'), {
      status: 500,
      code: 'retention_recovery_conflict',
    });
  }
  let restored = 0;
  let finalized = 0;
  let preserved = scan.unowned_pending;
  for (const [key, matches] of byOriginal) {
    const stage = matches[0];
    const [originalStat, stagedStat] = await Promise.all([
      fsp.lstat(stage.original_path).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }),
      fsp.lstat(stage.staged_path).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }),
    ]);
    if (originalStat && stagedStat) {
      preserved++;
      continue;
    }
    if (!stagedStat) {
      if (originalStat?.isFile?.() && !originalStat.isSymbolicLink?.()) {
        const originalVersion = await outputFileVersion(stage.original_path).catch(() => '');
        if (originalVersion && outputFileVersionMatches(stage.file_version, originalVersion)) {
          await removeRetentionTransactionManifest(stage);
        } else {
          preserved++;
        }
      } else if (index.usable && !referencedPaths.has(key)) {
        await removeRetentionTransactionManifest(stage);
        finalized++;
      } else {
        preserved++;
      }
      continue;
    }
    if (!stagedStat.isFile?.() || stagedStat.isSymbolicLink?.()) {
      preserved++;
      continue;
    }
    const stagedVersion = await outputFileVersion(stage.staged_path).catch(() => '');
    if (!stagedVersion || !outputFileVersionMatches(stage.file_version, stagedVersion)) {
      preserved++;
      continue;
    }
    const expectedVersions = referencedVersions.get(key) || new Set();
    const referenced = referencedPaths.has(key);
    const referencedVersionMatches = !expectedVersions.size
      || [...expectedVersions].some(expected => outputFileVersionMatches(expected, stagedVersion));
    const shouldRestore = !index.usable || (referenced && referencedVersionMatches);
    if (shouldRestore) {
      await assertSafeOutputParent(base, stage.original_path);
      await rollbackExpiredHistoryFile(stage);
      restored++;
    } else if (index.usable && !referenced) {
      await removeStagedExpiredHistoryFile(stage);
      finalized++;
    } else {
      preserved++;
    }
  }
  if (restored || finalized) invalidateHistoryCaches();
  return { restored, finalized, preserved };
}

function resolveDigestPath(base, item = {}) {
  if (historyItemIsTextPreviewMarkdown(item)) return '';
  const explicit = resolveHistoryOutputPath(base, item, ['digest_relative_path', 'digest_path'], '.digest.json');
  if (explicit) return explicit;
  const pngPath = resolveHistoryFilePath(base, item);
  const inferred = pngPath && isInside(base, pngPath) ? digestJsonPathForPng(pngPath) : '';
  return inferred && isInside(base, inferred) ? inferred : '';
}

async function ensureHistoryRootMarker(base, { signal = null, shouldAbort = null } = {}) {
  throwIfOutputAborted(signal, shouldAbort);
  const file = path.join(path.resolve(base), HISTORY_ROOT_MARKER_FILE);
  const stat = await fsp.lstat(file).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  throwIfOutputAborted(signal, shouldAbort);
  if (stat) {
    if (stat.isFile?.() && !stat.isSymbolicLink?.()) return file;
    throw outputPathError('history root marker must be an ordinary file');
  }
  await assertSafeOutputParent(base, file);
  throwIfOutputAborted(signal, shouldAbort);
  await writeJsonAtomic(file, {
    schema: 'wx-summary.history-root.v1',
    version: HISTORY_ROOT_MARKER_VERSION,
    created_at: new Date().toISOString(),
    output_dir_identity: outputDirIdentityForBase(base),
  });
  return file;
}

async function upsertHistory(settings, item, { signal = null, shouldAbort = null, base = null, commitBarrier = null } = {}) {
  await withHistoryWriteLock(async () => {
    const assertCommitAllowed = async () => {
      try {
        throwIfOutputAborted(signal, shouldAbort);
        if (typeof commitBarrier === 'function') await commitBarrier();
        throwIfOutputAborted(signal, shouldAbort);
      } catch (error) {
        if (error && typeof error === 'object') error.output_commit_barrier_rejected = true;
        throw error;
      }
    };
    await assertCommitAllowed();
    const safeBase = base ? path.resolve(base) : await safeOutputBase(settings);
    const file = path.join(safeBase, 'index.json');
    await assertSafeOutputParent(safeBase, file);
    await ensureHistoryRootMarker(safeBase, { signal, shouldAbort });
    const cleanItem = historyIndexItem(item);
    const list = base
      ? await readHistoryIndexFromBase(settings, safeBase, { signal })
      : await readHistoryIndex(settings, { signal });
    const cleanKey = historyItemKeyForItem(safeBase, cleanItem);
    const next = [
      cleanItem,
      ...list
        .filter(existing => {
          const existingKey = historyItemKeyForItem(safeBase, existing);
          return existingKey !== cleanKey;
        })
        .map(historyIndexItem),
    ];
    await assertCommitAllowed();
    await runOutputCommitBarrier(commitBarrier, () => writeHistoryIndexAtomic(file, next));
    try {
      await assertCommitAllowed();
    } catch (error) {
      try {
        await writeHistoryIndexAtomic(file, list.map(historyIndexItem));
      } catch (rollbackError) {
        const err = new Error('历史索引提交后上下文发生变化，且旧索引恢复失败；已停止报告保存成功，请保留输出目录并查看日志。');
        err.status = 500;
        err.code = 'history_index_rollback_failed';
        err.public_code = 'history_index_rollback_failed';
        err.index_may_have_committed = true;
        err.original_error = error?.message || String(error || 'commit barrier rejected');
        err.rollback_error = rollbackError?.message || String(rollbackError || 'rollback failed');
        throw err;
      }
      throw error;
    }
    invalidateHistoryCaches({ discovery: true });
  });
}

function historyIndexWriteMayHaveCommitted(error = null) {
  return error?.index_may_have_committed === true
    || String(error?.code || error?.public_code || '').trim() === 'history_index_rollback_failed';
}

function historyIndexItem(item = {}) {
  const clean = { ...item };
  const rendererVersion = cleanRendererVersion(clean.renderer_version);
  if (rendererVersion) clean.renderer_version = rendererVersion;
  else delete clean.renderer_version;
  const rendererEngine = cleanRendererEngine(clean.renderer_engine);
  if (rendererEngine) clean.renderer_engine = rendererEngine;
  else delete clean.renderer_engine;
  const historyRecordId = cleanHistoryItemKey(clean.history_record_id);
  if (historyRecordId) clean.history_record_id = historyRecordId;
  else delete clean.history_record_id;
  const historyRerender = cleanHistoryRerenderMetadata(clean.history_rerender);
  if (historyRerender) clean.history_rerender = historyRerender;
  else delete clean.history_rerender;
  const historyItemKeyAliases = cleanHistoryItemKeyAliases([
    ...(historyRerender?.history_item_key_aliases || []),
    ...(Array.isArray(clean.history_item_key_aliases) ? clean.history_item_key_aliases : []),
  ]);
  if (historyItemKeyAliases.length) clean.history_item_key_aliases = historyItemKeyAliases;
  else delete clean.history_item_key_aliases;
  delete clean.__history_rerender;
  if (Object.hasOwn(clean, 'headline')) clean.headline = cleanHistorySearchText(clean.headline, HISTORY_SEARCH_HEADLINE_MAX_CHARS);
  if (Object.hasOwn(clean, 'search_text')) {
    clean.search_text = cleanHistorySearchText(clean.search_text, HISTORY_SEARCH_TEXT_MAX_CHARS);
    if (clean.search_text) clean.search_text_version = HISTORY_SEARCH_INDEX_VERSION;
    else delete clean.search_text_version;
  } else {
    delete clean.search_text_version;
  }
  if (!clean.saved_file_version && clean.file_version) clean.saved_file_version = clean.file_version;
  if (!clean.saved_digest_file_version && clean.digest_file_version) clean.saved_digest_file_version = clean.digest_file_version;
  delete clean._history_base;
  delete clean._history_current;
  delete clean._history_base_has_index;
  delete clean._history_digest_duplicate;
  delete clean._history_recorded_digest_path;
  delete clean._history_root_output_dir_identity;
  delete clean.history_item_key;
  delete clean.history_digest_duplicate;
  delete clean.history_current;
  delete clean.history_output_relative_path;
  delete clean.file_exists;
  delete clean.file_version;
  delete clean.rerender_file_version;
  delete clean.digest_exists;
  delete clean.digest_invalid;
  delete clean.digest_status;
  delete clean.digest_file_version;
  return clean;
}

function savedHistoryFileVersion(item = {}) {
  return String(item.saved_file_version || '').trim();
}

function savedHistoryDigestFileVersion(item = {}) {
  return String(item.saved_digest_file_version || '').trim();
}

async function removeHistoryItem(settings, digestId, lookup = {}) {
  const id = String(digestId || '');
  if (!id) return;
  await withHistoryWriteLock(async () => {
    const base = await safeOutputBase(settings);
    const file = path.join(base, 'index.json');
    await assertSafeOutputParent(base, file);
    const list = await readHistoryIndex(settings);
    const explicitKey = String(lookup.history_item_key || lookup.historyItemKey || lookup.key || '').trim();
    const itemKey = lookup.item ? historyItemKeyForItem(base, lookup.item) : '';
    const targetKey = explicitKey || itemKey;
    const targetItem = targetKey ? historyItemsByKey(base, list).get(cleanHistoryItemKey(targetKey)) : null;
    const next = targetKey
      ? list.filter(item => item !== targetItem || item.digest_id !== id)
      : list.filter(item => item.digest_id !== id);
    if (next.length !== list.length) {
      await writeHistoryIndexAtomic(file, next);
      invalidateHistoryCaches();
    }
  });
}

function withHistoryWriteLock(action) {
  if (historyWriteLockHeld()) return Promise.resolve().then(action);
  const run = historyWriteQueue.then(
    () => runWithHistoryWriteLockContext(action),
    () => runWithHistoryWriteLockContext(action),
  );
  historyWriteQueue = run.catch(() => {});
  return run;
}

export async function waitForHistoryWritesToSettle() {
  if (historyWriteLockHeld()) return;
  while (true) {
    const pending = historyWriteQueue;
    await pending.catch(() => {});
    if (pending === historyWriteQueue) return;
  }
}

function historyWorkProducerSnapshot() {
  return {
    discovery: historyBaseDiscoveryQueue,
    combined: [...historyCombinedStateProducers],
    pendingRecoveries: [...pendingHistoryRecoveries.values()],
    saveRecoveries: [...historySaveRecoveryInFlight.values()],
    pngWrites: [...historyPngWriteLocks.values()],
  };
}

function samePromiseSet(left = [], right = []) {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every(item => expected.has(item));
}

function historyWorkProducerSnapshotMatches(left, right) {
  return left.discovery === right.discovery
    && samePromiseSet(left.combined, right.combined)
    && samePromiseSet(left.pendingRecoveries, right.pendingRecoveries)
    && samePromiseSet(left.saveRecoveries, right.saveRecoveries)
    && samePromiseSet(left.pngWrites, right.pngWrites);
}

export async function waitForHistoryWorkToSettle() {
  if (historyWriteLockHeld()) return;
  while (true) {
    const before = historyWorkProducerSnapshot();
    const producers = [...new Set([
      before.discovery,
      ...before.combined,
      ...before.pendingRecoveries,
      ...before.saveRecoveries,
      ...before.pngWrites,
    ].filter(item => typeof item?.then === 'function'))];
    await Promise.allSettled(producers);
    await waitForHistoryWritesToSettle();
    const after = historyWorkProducerSnapshot();
    if (historyWorkProducerSnapshotMatches(before, after)) return;
  }
}

function historyWriteLockHeld() {
  return historyWriteLockContext.getStore() === true;
}

async function runWithHistoryWriteLockContext(action) {
  return historyWriteLockContext.run(true, action);
}

function buildFilename(digest, pattern = '') {
  const id8 = String(digest.digest_id || '00000000').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || '00000000';
  const tokens = {
    group: sanitizeName(digest.group || 'digest'),
    since: compactTime(digest.since),
    until: compactTime(digest.until),
    id8,
  };
  const rawTemplate = String(pattern || '{group}__{since}_{until}__{id8}.png').trim();
  const template = /\{id8\}/.test(rawTemplate)
    ? rawTemplate
    : rawTemplate.replace(/(?:\.png)?$/i, '__{id8}.png');
  const rendered = template.replace(/\{(group|since|until|id8)\}/g, (_, key) => tokens[key] || '');
  const safe = sanitizeFilename(rendered || `${tokens.group}__${tokens.since}_${tokens.until}__${tokens.id8}.png`, tokens.id8);
  return /\.png$/i.test(safe) ? safe : `${safe}.png`;
}

function sanitizeName(name) {
  const clean = toWellFormedText(name || 'digest')
    .replace(/[^\p{Unified_Ideograph}a-zA-Z0-9_]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return truncateUtf8Text(truncateUnicodeText(clean, 40), 120).replace(/^_+|_+$/g, '') || 'digest';
}

function sanitizeFilename(name, requiredToken = '') {
  const wellFormed = toWellFormedText(name || '');
  const ext = path.extname(wellFormed).toLowerCase() === '.png' ? '.png' : '';
  const cleanedStem = wellFormed
    .replace(/\.[pP][nN][gG]$/, '')
    .replace(/[\\/]+/g, '_')
    .replace(/[<>:"|?*\x00-\x1F]+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const token = String(requiredToken || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  const suffix = token && !cleanedStem.includes(token) ? `__${token}` : '';
  const pointLimit = Math.max(1, 120 - [...suffix].length);
  const byteLimit = Math.max(1, 220 - Buffer.byteLength(suffix, 'utf8'));
  const stem = truncateUtf8Text(truncateUnicodeText(cleanedStem, pointLimit), byteLimit)
    .replace(/^_+|_+$/g, '') || 'digest';
  return `${stem}${suffix}${ext}`;
}

function compactTime(value) {
  if (!value || value === 'now') return formatDate(new Date());
  const time = safeHistorySortTimeMs(value);
  if (time > 0) return formatDate(new Date(time));
  return String(value).replace(/[^\d]/g, '').slice(0, 12) || formatDate(new Date());
}

function localDate(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function formatDate(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

function timestampForFilename(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

async function uniqueFilename(dir, filename) {
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? filename : `${base}_${i + 1}${ext}`;
    try {
      await fsp.access(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
  return `${base}_${Date.now()}${ext}`;
}
