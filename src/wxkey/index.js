import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { discoverDataRoots, discoverWxAccounts, getWeixinProcesses } from '../wxenv/discovery.js';
import { imageKeyValidationCount } from '../wxdb/image-dat.js';

const READ_ACCESS = 0x0010;
const QUERY_ACCESS = 0x0400;
const SAFE_ACCESS = READ_ACCESS | QUERY_ACCESS;
const MEM_COMMIT = 0x1000;
const MEM_PRIVATE = 0x20000;
const MEM_MAPPED = 0x40000;
const MEM_IMAGE = 0x1000000;
const PAGE_READWRITE = 0x04;
const PAGE_WRITECOPY = 0x08;
const PAGE_READONLY = 0x02;
const PAGE_EXECUTE_READ = 0x20;
const PAGE_EXECUTE_READWRITE = 0x40;
const PAGE_EXECUTE_WRITECOPY = 0x80;
const PAGE_GUARD = 0x100;
const PAGE_NOACCESS = 0x01;
const DEFAULT_SCAN_LIMIT_BYTES = 512 * 1024 * 1024;
const DEFAULT_IMAGE_SCAN_LIMIT_BYTES = 1024 * 1024 * 1024;
const DEFAULT_REGION_LIMIT_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const RAW_KEY_TEXT_CARRY_CHARS = 512;
const MAX_RAW_KEY_CANDIDATES = 512;
const MAX_SALT_KEY_CANDIDATES = 4096;
const MAX_SALT_KEY_CANDIDATES_HARD_LIMIT = 65536;
const SALT_NEIGHBOR_BYTES = 160;
const ANCHOR_NEIGHBOR_BYTES = 256;
const SALT_POINTER_NEIGHBOR_BYTES = 96;
const POINTER_TARGET_NEIGHBOR_BYTES = 160;
const REVERSE_POINTER_NEIGHBOR_BYTES = 512;
const MAX_REVERSE_POINTER_TARGETS = 256;
const MAX_REVERSE_POINTER_HITS = 2048;
const REVERSE_POINTER_LAYOUT_WINDOW_BYTES = 96;
const REVERSE_POINTER_LAYOUT_MAX_HITS = 160;
const REVERSE_POINTER_LAYOUT_MAX_HITS_PER_LABEL = 32;
const REVERSE_POINTER_LAYOUT_MAX_POINTER_READS = 384;
const REVERSE_POINTER_HIGH_ENTROPY_TARGET_MAX_READS = 1024;
const REVERSE_POINTER_HIGH_ENTROPY_TARGET_WINDOW_BYTES = 128;
const REVERSE_POINTER_HIGH_ENTROPY_TARGET_OFFSETS = [0, 8, 16, 24, 32, 48, 64, 96];
const REVERSE_POINTER_HIGH_ENTROPY_WINDOW_MAX_CANDIDATES = 2048;
const REVERSE_POINTER_HIGH_ENTROPY_POINTER_TABLE_MAX_READS = 512;
const REVERSE_POINTER_HIGH_ENTROPY_POINTER_TABLE_MAX_POINTERS = 6;
const REVERSE_POINTER_CRYPTO_OBJECT_SWEEP_MAX_CANDIDATES = 2048;
const REVERSE_POINTER_CRYPTO_OBJECT_SWEEP_STEP_BYTES = 4;
const REVERSE_POINTER_SECOND_HOP_TARGET_RANGE_BYTES = 128;
const WEIXIN_V4_KEY_POINTER_PATTERN = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x2f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const LOCAL_KEY_SCAN_MAX_FILES = 2000;
const LOCAL_KEY_SCAN_MAX_FILE_BYTES = 4 * 1024 * 1024;
const LOCAL_KEY_SCAN_CACHE_MS = 5 * 60 * 1000;
const LOCAL_KEY_SCAN_ALLOWED_EXTENSIONS = new Set(['', '.ini', '.json', '.xml', '.txt', '.log', '.cfg', '.conf', '.config', '.dat', '.mmkv', '.db-shm', '.db-wal']);
const LOCAL_KEY_SCAN_SKIP_DIRS = /^(cache|image|video|file|attach|voice|audio|cdn|thumb|log)$/i;

let localKeyScanCache = { at: 0, signature: '', result: null };

let ffi = null;

async function loadKernel32() {
  if (ffi) return ffi;
  if (process.platform !== 'win32') throw new Error('wxkey only runs on Windows');
  const koffi = (await import('koffi')).default;
  const kernel32 = koffi.load('kernel32.dll');
  const MemoryInfo = koffi.struct('MEMORY_BASIC_INFORMATION', {
    BaseAddress: 'uint64',
    AllocationBase: 'uint64',
    AllocationProtect: 'uint32',
    PartitionId: 'uint16',
    RegionSize: 'uint64',
    State: 'uint32',
    Protect: 'uint32',
    Type: 'uint32',
  });
  ffi = {
    koffi,
    MemoryInfo,
    OpenProcess: kernel32.func('void* __stdcall OpenProcess(uint32, bool, uint32)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(void*)'),
    GetLastError: kernel32.func('uint32 __stdcall GetLastError()'),
    VirtualQueryEx: kernel32.func('size_t __stdcall VirtualQueryEx(void*, void*, _Out_ MEMORY_BASIC_INFORMATION *lpBuffer, size_t)'),
    ReadProcessMemory: kernel32.func('bool __stdcall ReadProcessMemory(void*, void*, _Out_ uint8_t *lpBuffer, size_t, _Out_ size_t *lpNumberOfBytesRead)'),
  };
  return ffi;
}

function openReadOnlyProcess(api, pid) {
  const handle = api.OpenProcess(SAFE_ACCESS, false, Number(pid));
  if (!handle) {
    const err = new Error(`OpenProcess failed with ${api.GetLastError()}`);
    err.status = 500;
    throw err;
  }
  return handle;
}

export async function probeWxKey({
  scan = false,
  include_raw = false,
  scan_max_bytes = 0,
  scan_max_region_bytes = 0,
  scan_include_mapped = false,
  scan_writable_only = true,
  v4_pointer_max_candidates = 0,
  scan_all_processes = false,
  scan_db_salts = [],
  include_db_raw = false,
  db_scan_max_bytes = 0,
  db_scan_max_region_bytes = 0,
  db_scan_max_candidates = 0,
  db_reverse_pointer_scan = false,
  db_reverse_pointer_max_bytes = 0,
  db_reverse_pointer_max_hits = 0,
  scan_memory_anchors = [],
  include_anchor_raw = false,
  anchor_scan_max_bytes = 0,
  anchor_scan_max_region_bytes = 0,
  anchor_scan_max_candidates = 0,
  anchor_direct_max_candidates = 0,
  anchor_follow_local_pointers = true,
  anchor_reverse_pointer_scan = false,
  anchor_reverse_pointer_max_bytes = 0,
  anchor_reverse_pointer_max_hits = 0,
  scan_anchor_addresses = [],
  include_anchor_address_raw = false,
  anchor_address_scan_max_bytes = 0,
  anchor_address_scan_max_candidates = 0,
  anchor_address_reverse_pointer_max_hits = 0,
  anchor_address_target_range_bytes = 0,
  anchor_address_reverse_pointer_direct_max_distance = 0,
  anchor_address_reverse_pointer_layout_sample = false,
  anchor_address_reverse_pointer_high_entropy_targets = false,
  anchor_address_second_hop_reverse_pointers = false,
  scan_codec_salts = [],
  include_codec_raw = false,
  codec_scan_max_bytes = 0,
  codec_scan_max_region_bytes = 0,
  codec_scan_max_candidates = 0,
  codec_scan_include_mapped = false,
  codec_scan_writable_only = true,
  scan_image = false,
  image_samples = [],
  include_image_raw = false,
  image_scan_max_bytes = 0,
  image_scan_max_ms = 0,
  image_include_mapped = false,
} = {}) {
  const processes = await getWeixinProcesses();
  const main = processes.find(p => p.is_main);
  if (!main) {
    return {
      ok: false,
      stage: 'process',
      reason: processes.length ? '未识别到主 Weixin.exe 进程。' : '未检测到 Weixin.exe，请先登录微信。',
      process_count: processes.length,
    };
  }

  const targets = scan_all_processes ? orderedWeixinScanProcesses(processes, main) : [main];
  const accessibleTargets = [];
  const accessErrors = [];
  for (const target of targets) {
    const access = await verifyReadOnlyProcessAccess(target.pid);
    if (access.ok) accessibleTargets.push(target);
    else accessErrors.push({ pid: target.pid, type: weixinProcessType(target), error: access.error || 'open failed' });
  }
  if (!accessibleTargets.some(p => p.pid === main.pid)) {
    return {
      ok: false,
      stage: 'open_process',
      process: { pid: main.pid, path: main.path },
      process_count: processes.length,
      scan_process_count: accessibleTargets.length,
      access_errors: accessErrors,
      reason: accessErrors.find(e => e.pid === main.pid)?.error || '只读打开 Weixin.exe 失败。',
    };
  }

  const result = {
    ok: false,
    stage: 'read_only_handle',
    process: { pid: main.pid, path: main.path },
    process_count: processes.length,
    scan_all_processes: !!scan_all_processes,
    scan_process_count: accessibleTargets.length,
    scan_processes: accessibleTargets.map(redactProcessForDiagnostics),
    ...(accessErrors.length ? { access_errors: accessErrors } : {}),
    access_mask: `0x${SAFE_ACCESS.toString(16)}`,
    read_only_handle_ok: true,
    candidate_count: 0,
    reason: scan_all_processes ? '已验证可用只读权限打开 Weixin 进程。' : '已验证可用只读权限打开主进程。',
  };
  if (scan) {
    const aggregate = createScanAggregate();
    const perProcess = [];
    for (const target of accessibleTargets) {
      const scanResult = await scanProcessForRawKeyCandidates(target.pid, {
        include_raw,
        max_bytes: scan_max_bytes || undefined,
        max_region_bytes: scan_max_region_bytes || undefined,
        include_mapped: scan_include_mapped === true,
        writable_only: scan_writable_only !== false,
        v4_pointer_max_candidates: v4_pointer_max_candidates || undefined,
      });
      mergeScanAggregate(aggregate, scanResult);
      perProcess.push(processScanSummary(target, scanResult));
    }
    result.stage = 'scan';
    result.scan_mode = { ...(perProcess[0]?.scan_mode || {}), process_count: accessibleTargets.length };
    result.raw_scan_processes = perProcess;
    result.candidate_count = aggregate.candidate_count;
    result.unique_candidate_count = aggregate.uniqueCount();
    result.scanned_bytes = aggregate.scanned_bytes;
    result.region_count = aggregate.region_count;
    result.candidate_hashes = aggregate.hashes();
    if (include_raw) result._raw_candidates = aggregate.raws();
    result.reason = result.unique_candidate_count
      ? '已找到 raw key 形态候选；仍需 SQLCipher 验证以匹配数据库。'
      : '未找到 raw key 形态候选。';
  }
  if (scan_db_salts?.length) {
    const aggregate = createScanAggregate();
    const perProcess = [];
    let saltHitCount = 0;
    for (const target of accessibleTargets) {
      const dbKeyResult = await scanProcessForDbSaltKeyCandidates(target.pid, {
        db_salts: scan_db_salts,
        include_raw: include_db_raw,
        max_bytes: db_scan_max_bytes || undefined,
        max_region_bytes: db_scan_max_region_bytes || undefined,
        max_candidates: db_scan_max_candidates || undefined,
        reverse_pointer_scan: db_reverse_pointer_scan,
        reverse_pointer_max_bytes: db_reverse_pointer_max_bytes || undefined,
        reverse_pointer_max_hits: db_reverse_pointer_max_hits || undefined,
        include_mapped: true,
        writable_only: false,
      });
      saltHitCount += Number(dbKeyResult.salt_hit_count || 0);
      mergeScanAggregate(aggregate, dbKeyResult);
      perProcess.push(processScanSummary(target, dbKeyResult, { salt_hit_count: dbKeyResult.salt_hit_count || 0 }));
    }
    result.stage = 'scan';
    result.db_salt_scan_mode = { ...(perProcess[0]?.scan_mode || {}), process_count: accessibleTargets.length };
    result.db_salt_scan_processes = perProcess;
    result.db_salt_hit_count = saltHitCount;
    result.db_salt_candidate_count = aggregate.candidate_count;
    result.db_salt_unique_candidate_count = aggregate.uniqueCount();
    result.db_salt_scanned_bytes = aggregate.scanned_bytes;
    result.db_salt_region_count = aggregate.region_count;
    result.db_salt_candidate_hashes = aggregate.hashes();
    result.db_salt_reverse_pointer_hit_count = perProcess.reduce((sum, p) => sum + Number(p.reverse_pointer_hit_count || 0), 0);
    result.db_salt_reverse_pointer_scanned_bytes = perProcess.reduce((sum, p) => sum + Number(p.reverse_pointer_scanned_bytes || 0), 0);
    if (include_db_raw) result._raw_db_salt_candidates = aggregate.raws();
    if (result.db_salt_unique_candidate_count) result.reason = '已找到数据库 salt 附近的二进制 key 候选；仍需 SQLCipher 验证。';
  }
  if (scan_memory_anchors?.length) {
    const aggregate = createScanAggregate();
    const perProcess = [];
    let anchorHitCount = 0;
    for (const target of accessibleTargets) {
      const anchorResult = await scanProcessForAnchorKeyCandidates(target.pid, {
        anchors: scan_memory_anchors,
        include_raw: include_anchor_raw,
        max_bytes: anchor_scan_max_bytes || undefined,
        max_region_bytes: anchor_scan_max_region_bytes || undefined,
        max_candidates: anchor_scan_max_candidates || undefined,
        direct_max_candidates: anchor_direct_max_candidates || undefined,
        follow_local_pointers: anchor_follow_local_pointers,
        reverse_pointer_scan: anchor_reverse_pointer_scan,
        reverse_pointer_max_bytes: anchor_reverse_pointer_max_bytes || undefined,
        reverse_pointer_max_hits: anchor_reverse_pointer_max_hits || undefined,
        include_mapped: true,
        writable_only: false,
      });
      anchorHitCount += Number(anchorResult.anchor_hit_count || 0);
      mergeScanAggregate(aggregate, anchorResult);
      perProcess.push(processScanSummary(target, anchorResult, {
        anchor_hit_count: anchorResult.anchor_hit_count || 0,
        anchor_direct_candidate_count: anchorResult.direct_candidate_count || 0,
        anchor_reference_address_count: anchorResult.reference_address_count || 0,
      }));
    }
    result.stage = 'scan';
    result.anchor_scan_mode = { ...(perProcess[0]?.scan_mode || {}), process_count: accessibleTargets.length };
    result.anchor_scan_processes = perProcess;
    result.anchor_hit_count = anchorHitCount;
    result.anchor_candidate_count = aggregate.candidate_count;
    result.anchor_unique_candidate_count = aggregate.uniqueCount();
    result.anchor_scanned_bytes = aggregate.scanned_bytes;
    result.anchor_region_count = aggregate.region_count;
    result.anchor_candidate_hashes = aggregate.hashes();
    result.anchor_reverse_pointer_hit_count = perProcess.reduce((sum, p) => sum + Number(p.reverse_pointer_hit_count || 0), 0);
    result.anchor_reverse_pointer_scanned_bytes = perProcess.reduce((sum, p) => sum + Number(p.reverse_pointer_scanned_bytes || 0), 0);
    if (include_anchor_raw) result._raw_anchor_candidates = aggregate.raws();
    if (result.anchor_unique_candidate_count) result.reason = '已找到内存结构锚点附近的二进制 key 候选；仍需 SQLCipher 验证。';
  }
  if (scan_anchor_addresses?.length) {
    const addressTargets = normalizePointerAddressItems(scan_anchor_addresses);
    if (addressTargets.length) {
      const aggregate = createScanAggregate();
      const perProcess = [];
      for (const target of accessibleTargets.filter(p => p.pid === main.pid)) {
        const addressResult = await scanProcessForPointerTargetKeyCandidates(target.pid, {
          target_addresses: addressTargets,
          include_raw: include_anchor_address_raw,
          max_bytes: anchor_address_scan_max_bytes || anchor_reverse_pointer_max_bytes || undefined,
          max_candidates: anchor_address_scan_max_candidates || anchor_scan_max_candidates || undefined,
          reverse_pointer_max_hits: anchor_address_reverse_pointer_max_hits || anchor_reverse_pointer_max_hits || undefined,
          target_range_bytes: anchor_address_target_range_bytes || undefined,
          reverse_pointer_direct_max_distance: anchor_address_reverse_pointer_direct_max_distance || undefined,
          reverse_pointer_layout_sample: anchor_address_reverse_pointer_layout_sample,
          reverse_pointer_high_entropy_targets: anchor_address_reverse_pointer_high_entropy_targets,
          second_hop_reverse_pointers: anchor_address_second_hop_reverse_pointers,
          include_mapped: true,
        });
        mergeScanAggregate(aggregate, addressResult);
        perProcess.push(processScanSummary(target, addressResult, {
          anchor_address_target_count: addressResult.target_address_count || 0,
        }));
      }
      result.stage = 'scan';
      result.anchor_address_scan_mode = { ...(perProcess[0]?.scan_mode || {}), process_count: perProcess.length };
      result.anchor_address_scan_processes = perProcess;
      result.anchor_address_target_count = addressTargets.length;
      result.anchor_address_candidate_count = aggregate.candidate_count;
      result.anchor_address_unique_candidate_count = aggregate.uniqueCount();
      result.anchor_address_scanned_bytes = aggregate.scanned_bytes;
      result.anchor_address_region_count = aggregate.region_count;
      result.anchor_address_candidate_hashes = aggregate.hashes();
      result.anchor_address_reverse_pointer_hit_count = perProcess.reduce((sum, p) => sum + Number(p.reverse_pointer_hit_count || 0), 0);
      if (include_anchor_address_raw) result._raw_anchor_address_candidates = aggregate.raws();
      if (result.anchor_address_unique_candidate_count) result.reason = '已从指向模块静态字符串地址的对象附近找到 key 候选；仍需 SQLCipher 验证。';
    }
  }
  if (scan_codec_salts?.length) {
    const aggregate = createScanAggregate();
    const perProcess = [];
    let codecContextHitCount = 0;
    let codecSaltMatchCount = 0;
    for (const target of accessibleTargets) {
      const codecResult = await scanProcessForCodecContextKeyCandidates(target.pid, {
        db_salts: scan_codec_salts,
        include_raw: include_codec_raw,
        max_bytes: codec_scan_max_bytes || undefined,
        max_region_bytes: codec_scan_max_region_bytes || undefined,
        max_candidates: codec_scan_max_candidates || undefined,
        include_mapped: codec_scan_include_mapped === true,
        writable_only: codec_scan_writable_only !== false,
      });
      codecContextHitCount += Number(codecResult.codec_context_hit_count || 0);
      codecSaltMatchCount += Number(codecResult.codec_context_salt_match_count || 0);
      mergeScanAggregate(aggregate, codecResult);
      perProcess.push(processScanSummary(target, codecResult, {
        codec_context_hit_count: codecResult.codec_context_hit_count || 0,
        codec_context_salt_match_count: codecResult.codec_context_salt_match_count || 0,
        codec_pass_read_count: codecResult.codec_pass_read_count || 0,
        codec_pass_candidate_count: codecResult.codec_pass_candidate_count || 0,
        codec_key_pointer_read_count: codecResult.codec_key_pointer_read_count || 0,
        codec_key_pointer_candidate_count: codecResult.codec_key_pointer_candidate_count || 0,
      }));
    }
    result.stage = 'scan';
    result.codec_context_scan_mode = { ...(perProcess[0]?.scan_mode || {}), process_count: accessibleTargets.length };
    result.codec_context_scan_processes = perProcess;
    result.codec_context_hit_count = codecContextHitCount;
    result.codec_context_salt_match_count = codecSaltMatchCount;
    result.codec_context_candidate_count = aggregate.candidate_count;
    result.codec_context_unique_candidate_count = aggregate.uniqueCount();
    result.codec_context_scanned_bytes = aggregate.scanned_bytes;
    result.codec_context_region_count = aggregate.region_count;
    result.codec_context_candidate_hashes = aggregate.hashes();
    if (include_codec_raw) result._raw_codec_candidates = aggregate.raws();
    if (result.codec_context_unique_candidate_count) result.reason = '已从 SQLCipher codec_ctx/cipher_ctx 结构附近找到 key 候选；仍需 SQLCipher 验证。';
  }
  if (scan_image) {
    const aggregate = createScanAggregate();
    const perProcess = [];
    for (const target of accessibleTargets) {
      const imageResult = await scanProcessForImageKeyCandidates(target.pid, {
        validation_samples: image_samples,
        include_raw: include_image_raw,
        max_bytes: image_scan_max_bytes || undefined,
        max_ms: image_scan_max_ms || undefined,
        include_mapped: image_include_mapped,
        stop_after_found: true,
      });
      mergeScanAggregate(aggregate, imageResult);
      perProcess.push(processScanSummary(target, imageResult));
      if (imageResult.unique_candidate_count && image_samples?.length) break;
    }
    result.stage = 'scan';
    result.image_scan_processes = perProcess;
    result.image_candidate_count = aggregate.candidate_count;
    result.image_unique_candidate_count = aggregate.uniqueCount();
    result.image_scanned_bytes = aggregate.scanned_bytes;
    result.image_region_count = aggregate.region_count;
    result.image_key_hashes = aggregate.hashes();
    if (include_image_raw) result._raw_image_keys = aggregate.raws();
    if (result.image_unique_candidate_count) result.reason = '已找到可解开图片样本的图片 key 候选。';
  }
  return result;
}

export async function verifyReadOnlyProcessAccess(pid) {
  let api;
  try {
    api = await loadKernel32();
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  try {
    const handle = openReadOnlyProcess(api, pid);
    api.CloseHandle(handle);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function scanLocalWeixinKeyCandidates({
  include_raw = false,
  max_files = LOCAL_KEY_SCAN_MAX_FILES,
  max_file_bytes = LOCAL_KEY_SCAN_MAX_FILE_BYTES,
  cache = true,
} = {}) {
  const roots = await localKeyCandidateRoots();
  const signature = JSON.stringify({ roots, max_files: Number(max_files || 0), max_file_bytes: Number(max_file_bytes || 0) });
  if (cache && localKeyScanCache.result && localKeyScanCache.signature === signature && Date.now() - localKeyScanCache.at < LOCAL_KEY_SCAN_CACHE_MS) {
    return include_raw ? localKeyScanCache.result : publicLocalKeyScanResult(localKeyScanCache.result);
  }
  const rawSet = new Set();
  const fileStats = {
    scanned: 0,
    skipped_large: 0,
    skipped_ext: 0,
    read_errors: 0,
    with_candidates: 0,
  };
  const byExt = {};
  const seenFiles = new Set();
  for (const root of roots) {
    await scanLocalKeyRoot(root, rawSet, fileStats, byExt, seenFiles, {
      max_files: normalizePositiveLimit(max_files, LOCAL_KEY_SCAN_MAX_FILES),
      max_file_bytes: normalizePositiveLimit(max_file_bytes, LOCAL_KEY_SCAN_MAX_FILE_BYTES),
    });
    if (fileStats.scanned >= normalizePositiveLimit(max_files, LOCAL_KEY_SCAN_MAX_FILES)) break;
  }
  const result = {
    ok: true,
    stage: 'local_key_scan',
    root_count: roots.length,
    file_stats: fileStats,
    by_ext: byExt,
    candidate_count: rawSet.size,
    unique_candidate_count: rawSet.size,
    candidate_hashes: [...rawSet].slice(0, 64).map(raw => crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)),
    ...(include_raw ? { raw_candidates: [...rawSet] } : {}),
  };
  localKeyScanCache = {
    at: Date.now(),
    signature,
    result: { ...result, raw_candidates: [...rawSet] },
  };
  return include_raw ? result : publicLocalKeyScanResult(result);
}

async function localKeyCandidateRoots() {
  const roots = [];
  const dataRoots = await discoverDataRoots().catch(() => []);
  for (const root of dataRoots || []) roots.push(path.join(root, 'xwechat_files', 'all_users'));
  const accounts = await discoverWxAccounts().catch(() => []);
  for (const account of accounts || []) {
    if (account?.account_root) roots.push(account.account_root);
  }
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Tencent', 'xwechat', 'config'));
  const out = [];
  const seen = new Set();
  for (const root of roots.filter(Boolean)) {
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const st = await fsp.stat(root).catch(() => null);
    if (st?.isDirectory()) out.push(root);
  }
  return out;
}

async function scanLocalKeyRoot(root, rawSet, fileStats, byExt, seenFiles, options) {
  const stack = [root];
  while (stack.length && fileStats.scanned < options.max_files) {
    const dir = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (LOCAL_KEY_SCAN_SKIP_DIRS.test(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      await scanLocalKeyFile(full, rawSet, fileStats, byExt, seenFiles, options);
      if (fileStats.scanned >= options.max_files) break;
    }
  }
}

async function scanLocalKeyFile(file, rawSet, fileStats, byExt, seenFiles, options) {
  const key = file.toLowerCase();
  if (seenFiles.has(key)) return;
  seenFiles.add(key);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.db' || ext === '.sqlite' || ext === '.sqlite3' || !LOCAL_KEY_SCAN_ALLOWED_EXTENSIONS.has(ext)) {
    fileStats.skipped_ext++;
    return;
  }
  const st = await fsp.stat(file).catch(() => null);
  if (!st?.isFile()) return;
  if (st.size > options.max_file_bytes) {
    fileStats.skipped_large++;
    return;
  }
  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch {
    fileStats.read_errors++;
    return;
  }
  fileStats.scanned++;
  byExt[ext || '<none>'] = (byExt[ext || '<none>'] || 0) + 1;
  const before = rawSet.size;
  addLocalKeyCandidatesFromText(rawSet, buf.toString('latin1'));
  if (rawSet.size > before) fileStats.with_candidates++;
}

function addLocalKeyCandidatesFromText(rawSet, text) {
  for (const raw of findRawKeyCandidates(text)) rawSet.add(raw);
  if (text.includes('\0')) {
    for (const raw of findRawKeyCandidates(text.replace(/\0/g, ''))) rawSet.add(raw);
  }
}

function publicLocalKeyScanResult(result) {
  const { raw_candidates, ...publicResult } = result || {};
  return publicResult;
}

function normalizePositiveLimit(value, fallback) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.floor(n));
}

function orderedWeixinScanProcesses(processes, main) {
  const out = [];
  const seen = new Set();
  const add = (process) => {
    if (!process?.pid || seen.has(process.pid)) return;
    seen.add(process.pid);
    out.push(process);
  };
  add(main);
  for (const process of processes || []) add(process);
  return out;
}

function redactProcessForDiagnostics(process) {
  return {
    pid: Number(process?.pid || 0),
    type: weixinProcessType(process),
    is_main: !!process?.is_main,
  };
}

function weixinProcessType(process) {
  const text = String(process?.command_line || '');
  const type = text.match(/--type=([^\s"]+)/i)?.[1];
  return type || 'main';
}

function createScanAggregate() {
  const hashSet = new Set();
  const rawSet = new Set();
  return {
    candidate_count: 0,
    scanned_bytes: 0,
    region_count: 0,
    addHash(value) {
      const text = String(value || '').trim();
      if (text) hashSet.add(text);
    },
    addRaw(value) {
      const text = String(value || '').trim().toLowerCase();
      if (!text || rawSet.has(text)) return;
      rawSet.add(text);
      hashSet.add(crypto.createHash('sha256').update(text).digest('hex').slice(0, 12));
    },
    uniqueCount() {
      return rawSet.size || hashSet.size;
    },
    hashes() {
      return [...hashSet].slice(0, 64);
    },
    raws() {
      return [...rawSet];
    },
  };
}

function mergeScanAggregate(aggregate, scanResult = {}) {
  aggregate.candidate_count += Number(scanResult.candidate_count || 0);
  aggregate.scanned_bytes += Number(scanResult.scanned_bytes || 0);
  aggregate.region_count += Number(scanResult.region_count || 0);
  for (const hash of scanResult.candidate_hashes || []) aggregate.addHash(hash);
  for (const raw of scanResult.raw_candidates || []) aggregate.addRaw(raw);
}

function processScanSummary(process, scanResult = {}, extra = {}) {
  return {
    ...redactProcessForDiagnostics(process),
    candidate_count: Number(scanResult.candidate_count || 0),
    unique_candidate_count: Number(scanResult.unique_candidate_count || 0),
    v4_pointer_pattern_hit_count: Number(scanResult.v4_pointer_pattern_hit_count || 0),
    v4_pointer_pattern_candidate_count: Number(scanResult.v4_pointer_pattern_candidate_count || 0),
    scanned_bytes: Number(scanResult.scanned_bytes || 0),
    region_count: Number(scanResult.region_count || 0),
    reverse_pointer_hit_count: Number(scanResult.reverse_pointer_hit_count || 0),
    reverse_pointer_scanned_bytes: Number(scanResult.reverse_pointer_scanned_bytes || 0),
    reverse_pointer_direct_candidate_count: Number(scanResult.reverse_pointer_direct_candidate_count || 0),
    reverse_pointer_deferred_target_count: Number(scanResult.reverse_pointer_deferred_target_count || 0),
    reverse_pointer_followed_target_count: Number(scanResult.reverse_pointer_followed_target_count || 0),
    reverse_pointer_high_entropy_target_read_count: Number(scanResult.reverse_pointer_high_entropy_target_read_count || 0),
    reverse_pointer_high_entropy_candidate_count: Number(scanResult.reverse_pointer_high_entropy_candidate_count || 0),
    reverse_pointer_high_entropy_window_candidate_count: Number(scanResult.reverse_pointer_high_entropy_window_candidate_count || 0),
    reverse_pointer_high_entropy_pointer_table_read_count: Number(scanResult.reverse_pointer_high_entropy_pointer_table_read_count || 0),
    reverse_pointer_high_entropy_pointer_table_candidate_count: Number(scanResult.reverse_pointer_high_entropy_pointer_table_candidate_count || 0),
    reverse_pointer_crypto_object_sweep_candidate_count: Number(scanResult.reverse_pointer_crypto_object_sweep_candidate_count || 0),
    reverse_pointer_second_hop_target_count: Number(scanResult.reverse_pointer_second_hop_target_count || 0),
    reverse_pointer_second_hop_hit_count: Number(scanResult.reverse_pointer_second_hop_hit_count || 0),
    reverse_pointer_second_hop_candidate_count: Number(scanResult.reverse_pointer_second_hop_candidate_count || 0),
    ...(scanResult.reverse_pointer_layout_summary ? { reverse_pointer_layout_summary: scanResult.reverse_pointer_layout_summary } : {}),
    scan_mode: scanResult.scan_mode || null,
    ...extra,
  };
}

export function findRawKeyCandidates(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer || '');
  const candidates = new Map();
  addRawKeyMatches(candidates, text);
  if (text.includes('\0')) addRawKeyMatches(candidates, text.replace(/\0/g, ''));
  // Some recent Weixin builds keep only the SQLCipher key half as a plain hex
  // string in memory. The DB salt is added later by wxdb normalization.
  addBareHexMatches(candidates, text, 160);
  addBareHexMatches(candidates, text, 128);
  addBareHexMatches(candidates, text, 96);
  addBareHexMatches(candidates, text, 64);
  if (text.includes('\0')) {
    const compact = text.replace(/\0/g, '');
    addBareHexMatches(candidates, compact, 160);
    addBareHexMatches(candidates, compact, 128);
    addBareHexMatches(candidates, compact, 96);
    addBareHexMatches(candidates, compact, 64);
  }
  return [...candidates.values()].slice(0, MAX_RAW_KEY_CANDIDATES);
}

function addRawKeyMatches(candidates, text) {
  const re = /x'([a-fA-F0-9]{64,192})'/g;
  let match;
  while ((match = re.exec(text))) addRawKeyHexCandidates(candidates, match[1], 'raw-x');
}

function addRawKeyHexCandidates(candidates, value, kind) {
  const raw = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64,192}$/.test(raw) || raw.length % 2 !== 0) return;
  if (raw.length === 64 || raw.length === 96 || raw.length === 128 || raw.length === 160) {
    addCandidate(candidates, raw, kind);
  }
  // Some Weixin v4 builds keep an expanded SQLCipher raw-key blob in memory.
  // The usable form may be either key+salt or key+hmac_key+salt.
  addCandidate(candidates, raw.slice(0, 64) + raw.slice(-32), `${kind}-derived96`);
  if (raw.length >= 160) addCandidate(candidates, raw.slice(0, 128) + raw.slice(-32), `${kind}-derived160`);
  addCandidate(candidates, raw.slice(0, 64), `${kind}-key64`);
}

function addBareHexMatches(candidates, text, size) {
  const re = new RegExp(`[a-fA-F0-9]{${size}}`, 'g');
  let match;
  while ((match = re.exec(text))) {
    const start = match.index;
    const end = start + size;
    const before = start > 0 ? text.charCodeAt(start - 1) : 0;
    const after = end < text.length ? text.charCodeAt(end) : 0;
    if (isHexCode(before) || isHexCode(after)) continue;
    addCandidate(candidates, match[0], `hex${size}`);
    if (candidates.size >= MAX_RAW_KEY_CANDIDATES) return;
  }
}

function addCandidate(candidates, value, kind) {
  const raw = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}(?:[a-f0-9]{32}|[a-f0-9]{64}|[a-f0-9]{96})?$/.test(raw)) return;
  if (!candidates.has(raw)) candidates.set(raw, raw);
}

function isHexCode(code) {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x46)
    || (code >= 0x61 && code <= 0x66);
}

export function findImageKeyCandidates(buffer, validationSamples = []) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'latin1');
  const candidates = new Map();
  for (const raw of scanAsciiImageKeyStrings(bytes)) {
    addValidatedImageKey(candidates, raw, validationSamples);
  }
  for (const raw of scanUtf16LeImageKeyStrings(bytes)) {
    addValidatedImageKey(candidates, raw, validationSamples);
  }
  return [...candidates.values()];
}

export function findDbSaltNeighborKeyCandidates(buffer, dbSalts = [], neighborBytes = SALT_NEIGHBOR_BYTES) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'latin1');
  const salts = normalizeDbSaltBuffers(dbSalts);
  const candidates = new Map();
  const maxCandidates = MAX_SALT_KEY_CANDIDATES;
  let saltHitCount = 0;
  const saltOffsets = [];
  for (const salt of salts) {
    let pos = bytes.indexOf(salt);
    while (pos >= 0) {
      saltHitCount++;
      saltOffsets.push(pos);
      addSaltNeighborCandidates(candidates, bytes, pos, salt.length, neighborBytes, maxCandidates);
      if (candidates.size >= maxCandidates) break;
      pos = bytes.indexOf(salt, pos + 1);
    }
    if (candidates.size >= maxCandidates) break;
  }
  return {
    salt_hit_count: saltHitCount,
    salt_offsets: saltOffsets,
    candidates: [...candidates.values()],
  };
}

export function findAnchorNeighborKeyCandidates(buffer, anchors = [], neighborBytes = ANCHOR_NEIGHBOR_BYTES) {
  return findAnchorNeighborKeyCandidatesWithLimit(buffer, anchors, neighborBytes, MAX_SALT_KEY_CANDIDATES);
}

function findAnchorNeighborKeyCandidatesWithLimit(buffer, anchors = [], neighborBytes = ANCHOR_NEIGHBOR_BYTES, maxCandidates = MAX_SALT_KEY_CANDIDATES) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'latin1');
  const patterns = normalizeAnchorBuffers(anchors);
  const candidates = new Map();
  const candidateLimit = Math.max(0, Number(maxCandidates || 0));
  let anchorHitCount = 0;
  const anchorOffsets = [];
  for (const pattern of patterns) {
    let pos = bytes.indexOf(pattern);
    while (pos >= 0) {
      anchorHitCount++;
      anchorOffsets.push(pos);
      if (candidateLimit > 0) addAnchorNeighborCandidates(candidates, bytes, pos, pattern.length, neighborBytes, candidateLimit);
      if (candidateLimit > 0 && candidates.size >= candidateLimit) break;
      pos = bytes.indexOf(pattern, pos + 1);
    }
    if (candidateLimit > 0 && candidates.size >= candidateLimit) break;
  }
  return {
    anchor_hit_count: anchorHitCount,
    anchor_offsets: anchorOffsets,
    candidates: [...candidates.values()],
  };
}

export async function scanProcessForDbSaltKeyCandidates(pid, options = {}) {
  const salts = normalizeDbSaltBuffers(options.db_salts || []);
  if (!salts.length) {
    return { candidate_count: 0, unique_candidate_count: 0, salt_hit_count: 0, scanned_bytes: 0, region_count: 0, candidate_hashes: [] };
  }
  const api = await loadKernel32();
  const handle = openReadOnlyProcess(api, pid);
  try {
    const writableOnly = options.writable_only === true;
    const includeMapped = options.include_mapped !== false;
    const regions = enumerateCandidateRegions(api, handle, { writableOnly, includeMapped });
    const scanLimit = BigInt(options.max_bytes || DEFAULT_IMAGE_SCAN_LIMIT_BYTES);
    const regionLimit = BigInt(options.max_region_bytes || DEFAULT_REGION_LIMIT_BYTES);
    const neighborBytes = Number(options.neighbor_bytes || SALT_NEIGHBOR_BYTES);
    const maxCandidates = normalizeMaxSaltCandidates(options.max_candidates);
    const carryBytes = Math.max(...salts.map(s => s.length)) + neighborBytes * 2 + 64;
    const candidates = new Map();
    const hitAddresses = [];
    const hitAddressSet = new Set();
    let scanned = 0n;
    let saltHitCount = 0;
    let carry = Buffer.alloc(0);

    for (const region of regions) {
      if (scanned >= scanLimit || candidates.size >= maxCandidates) break;
      const toScan = region.size > regionLimit ? regionLimit : region.size;
      for (let offset = 0n; offset < toScan && scanned < scanLimit; offset += BigInt(CHUNK_BYTES)) {
        if (candidates.size >= maxCandidates) break;
        const len = Number(minBigInt(BigInt(CHUNK_BYTES), toScan - offset, scanLimit - scanned));
        if (len <= 0) break;
        const buf = Buffer.allocUnsafe(len);
        const readOut = [0n];
        const ok = api.ReadProcessMemory(handle, region.base + offset, buf, BigInt(len), readOut);
        const read = Number(readOut[0] || 0n);
        if (!ok || read <= 0) continue;
        scanned += BigInt(read);
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, read)]) : buf.subarray(0, read);
        const found = findDbSaltNeighborKeyCandidates(chunk, salts, neighborBytes);
        saltHitCount += found.salt_hit_count;
        for (const item of found.candidates) {
          if (!candidates.has(item.hash)) candidates.set(item.hash, item);
        }
        const chunkBase = region.base + offset - BigInt(carry.length);
        for (const saltOffset of found.salt_offsets || []) {
          if (candidates.size >= maxCandidates) break;
          const hitAddress = chunkBase + BigInt(saltOffset);
          addHitAddress(hitAddresses, hitAddressSet, hitAddress);
          const pointerTargets = findSaltNeighborPointers(chunk, saltOffset, neighborBytes, 16);
          for (const target of pointerTargets) {
            if (candidates.size >= maxCandidates) break;
            await addAnchorPointerTargetCandidates(api, handle, regions, target, candidates, maxCandidates);
          }
          const directTarget = chunkBase + BigInt(saltOffset);
          await addAnchorPointerTargetCandidates(api, handle, regions, directTarget, candidates, maxCandidates);
        }
        carry = chunk.subarray(Math.max(0, chunk.length - carryBytes));
      }
      carry = Buffer.alloc(0);
    }
    const reverse = options.reverse_pointer_scan && hitAddresses.length && candidates.size < maxCandidates
      ? await scanReversePointersForCandidates(api, handle, regions, hitAddresses, candidates, {
          max_candidates: maxCandidates,
          max_bytes: options.reverse_pointer_max_bytes || Number(scanLimit),
          max_hits: options.reverse_pointer_max_hits,
        })
      : { pointer_hit_count: 0, scanned_bytes: 0 };

    return {
      scan_mode: {
        writable_only: writableOnly,
        include_mapped: includeMapped,
        max_bytes: Number(scanLimit),
        max_region_bytes: Number(regionLimit),
        max_candidates: maxCandidates,
        reverse_pointer_scan: !!options.reverse_pointer_scan,
        reverse_pointer_max_bytes: Number(options.reverse_pointer_max_bytes || scanLimit),
        reverse_pointer_max_hits: normalizeMaxReversePointerHits(options.reverse_pointer_max_hits),
      },
      candidate_count: saltHitCount ? candidates.size : 0,
      unique_candidate_count: candidates.size,
      salt_hit_count: saltHitCount,
      reverse_pointer_hit_count: reverse.pointer_hit_count,
      reverse_pointer_scanned_bytes: reverse.scanned_bytes,
      scanned_bytes: Number(scanned),
      region_count: regions.length,
      candidate_hashes: [...candidates.values()].map(c => c.hash.slice(0, 12)),
      ...(options.include_raw ? { raw_candidates: [...candidates.values()].map(c => c.raw) } : {}),
    };
  } finally {
    api.CloseHandle(handle);
  }
}

export async function scanProcessForAnchorKeyCandidates(pid, options = {}) {
  const anchors = normalizeAnchorBuffers(options.anchors || []);
  if (!anchors.length) {
    return { candidate_count: 0, unique_candidate_count: 0, anchor_hit_count: 0, scanned_bytes: 0, region_count: 0, candidate_hashes: [] };
  }
  const api = await loadKernel32();
  const handle = openReadOnlyProcess(api, pid);
  try {
    const writableOnly = options.writable_only === true;
    const includeMapped = options.include_mapped !== false;
    const regions = enumerateCandidateRegions(api, handle, { writableOnly, includeMapped });
    const scanLimit = BigInt(options.max_bytes || DEFAULT_IMAGE_SCAN_LIMIT_BYTES);
    const regionLimit = BigInt(options.max_region_bytes || DEFAULT_REGION_LIMIT_BYTES);
    const neighborBytes = Number(options.neighbor_bytes || ANCHOR_NEIGHBOR_BYTES);
    const maxCandidates = normalizeMaxSaltCandidates(options.max_candidates);
    const directCandidateLimit = normalizeAnchorDirectCandidateLimit(options.direct_max_candidates, maxCandidates, options.reverse_pointer_scan);
    const followLocalPointers = options.follow_local_pointers !== false;
    const carryBytes = Math.max(...anchors.map(s => s.length)) + neighborBytes * 2 + 64;
    const candidates = new Map();
    const hitAddresses = [];
    const hitAddressSet = new Set();
    let directCandidateCount = 0;
    let scanned = 0n;
    let anchorHitCount = 0;
    let carry = Buffer.alloc(0);

    for (const region of regions) {
      if (scanned >= scanLimit || (candidates.size >= maxCandidates && hitAddresses.length >= MAX_REVERSE_POINTER_TARGETS)) break;
      const toScan = region.size > regionLimit ? regionLimit : region.size;
      for (let offset = 0n; offset < toScan && scanned < scanLimit; offset += BigInt(CHUNK_BYTES)) {
        if (candidates.size >= maxCandidates && hitAddresses.length >= MAX_REVERSE_POINTER_TARGETS) break;
        const len = Number(minBigInt(BigInt(CHUNK_BYTES), toScan - offset, scanLimit - scanned));
        if (len <= 0) break;
        const buf = Buffer.allocUnsafe(len);
        const readOut = [0n];
        const ok = api.ReadProcessMemory(handle, region.base + offset, buf, BigInt(len), readOut);
        const read = Number(readOut[0] || 0n);
        if (!ok || read <= 0) continue;
        scanned += BigInt(read);
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, read)]) : buf.subarray(0, read);
        const remainingDirect = Math.max(0, directCandidateLimit - directCandidateCount);
        const found = findAnchorNeighborKeyCandidatesWithLimit(chunk, anchors, neighborBytes, remainingDirect);
        anchorHitCount += found.anchor_hit_count;
        for (const item of found.candidates) {
          if (directCandidateCount >= directCandidateLimit) break;
          if (!candidates.has(item.hash)) candidates.set(item.hash, item);
          directCandidateCount++;
        }
        const chunkBase = region.base + offset - BigInt(carry.length);
        for (const anchorOffset of found.anchor_offsets || []) {
          const hitAddress = chunkBase + BigInt(anchorOffset);
          addHitAddress(hitAddresses, hitAddressSet, hitAddress);
          if (followLocalPointers && candidates.size < maxCandidates) {
            const pointerTargets = findSaltNeighborPointers(chunk, anchorOffset, neighborBytes, 1);
            for (const target of pointerTargets) {
              if (candidates.size >= maxCandidates) break;
              await addPointerTargetCandidates(api, handle, regions, target, candidates, maxCandidates);
            }
            const directTarget = chunkBase + BigInt(anchorOffset);
            await addPointerTargetCandidates(api, handle, regions, directTarget, candidates, maxCandidates);
          }
        }
        carry = chunk.subarray(Math.max(0, chunk.length - carryBytes));
      }
      carry = Buffer.alloc(0);
    }
    const reverse = options.reverse_pointer_scan && hitAddresses.length && candidates.size < maxCandidates
      ? await scanReversePointersForCandidates(api, handle, regions, hitAddresses, candidates, {
          max_candidates: maxCandidates,
          max_bytes: options.reverse_pointer_max_bytes || Number(scanLimit),
          max_hits: options.reverse_pointer_max_hits,
        })
      : { pointer_hit_count: 0, scanned_bytes: 0 };

    return {
      scan_mode: {
        writable_only: writableOnly,
        include_mapped: includeMapped,
        max_bytes: Number(scanLimit),
        max_region_bytes: Number(regionLimit),
        max_candidates: maxCandidates,
        direct_max_candidates: directCandidateLimit,
        follow_local_pointers: followLocalPointers,
        anchor_count: anchors.length,
        reverse_pointer_scan: !!options.reverse_pointer_scan,
        reverse_pointer_max_bytes: Number(options.reverse_pointer_max_bytes || scanLimit),
        reverse_pointer_max_hits: normalizeMaxReversePointerHits(options.reverse_pointer_max_hits),
      },
      candidate_count: anchorHitCount ? candidates.size : 0,
      unique_candidate_count: candidates.size,
      anchor_hit_count: anchorHitCount,
      direct_candidate_count: directCandidateCount,
      reference_address_count: hitAddresses.length,
      reverse_pointer_hit_count: reverse.pointer_hit_count,
      reverse_pointer_scanned_bytes: reverse.scanned_bytes,
      scanned_bytes: Number(scanned),
      region_count: regions.length,
      candidate_hashes: [...candidates.values()].map(c => c.hash.slice(0, 12)),
      ...(options.include_raw ? { raw_candidates: [...candidates.values()].map(c => c.raw) } : {}),
    };
  } finally {
    api.CloseHandle(handle);
  }
}

export async function scanProcessForRawKeyCandidates(pid, options = {}) {
  const api = await loadKernel32();
  const handle = openReadOnlyProcess(api, pid);
  try {
    const writableOnly = options.writable_only !== false;
    const includeMapped = options.include_mapped === true;
    const regions = enumerateCandidateRegions(api, handle, { writableOnly, includeMapped });
    const readRegions = enumerateCandidateRegions(api, handle, { writableOnly: false, includeMapped: true });
    const scanLimit = BigInt(options.max_bytes || DEFAULT_SCAN_LIMIT_BYTES);
    const regionLimit = BigInt(options.max_region_bytes || DEFAULT_REGION_LIMIT_BYTES);
    const v4PointerMaxCandidates = normalizeMaxSaltCandidates(options.v4_pointer_max_candidates || MAX_RAW_KEY_CANDIDATES);
    const candidates = new Map();
    let candidateCount = 0;
    let v4PointerPatternHitCount = 0;
    let v4PointerPatternCandidateCount = 0;
    let scanned = 0n;

    for (const region of regions) {
      if (scanned >= scanLimit) break;
      const toScan = region.size > regionLimit ? regionLimit : region.size;
      let carry = '';
      let byteCarry = Buffer.alloc(0);
      for (let offset = 0n; offset < toScan && scanned < scanLimit; offset += BigInt(CHUNK_BYTES)) {
        const len = Number(minBigInt(BigInt(CHUNK_BYTES), toScan - offset, scanLimit - scanned));
        if (len <= 0) break;
        const buf = Buffer.allocUnsafe(len);
        const readOut = [0n];
        const ok = api.ReadProcessMemory(handle, region.base + offset, buf, BigInt(len), readOut);
        const read = Number(readOut[0] || 0n);
        if (!ok || read <= 0) continue;
        scanned += BigInt(read);
        const chunk = byteCarry.length ? Buffer.concat([byteCarry, buf.subarray(0, read)]) : buf.subarray(0, read);
        const v4Stats = addWeixinV4PatternPointerCandidates(candidates, chunk, api, handle, readRegions, v4PointerMaxCandidates);
        v4PointerPatternHitCount += v4Stats.hit_count;
        v4PointerPatternCandidateCount += v4Stats.candidate_count;
        const text = carry + buf.subarray(0, read).toString('latin1');
        const found = findRawKeyCandidates(text);
        candidateCount += found.length;
        for (const raw of found) {
          const hash = crypto.createHash('sha256').update(raw).digest('hex');
          if (!candidates.has(hash)) candidates.set(hash, { raw, hash });
        }
        carry = text.slice(-RAW_KEY_TEXT_CARRY_CHARS);
        byteCarry = chunk.subarray(Math.max(0, chunk.length - (WEIXIN_V4_KEY_POINTER_PATTERN.length + 8 - 1)));
      }
    }

    return {
      scan_mode: {
        writable_only: writableOnly,
        include_mapped: includeMapped,
        max_bytes: Number(scanLimit),
        max_region_bytes: Number(regionLimit),
        v4_pointer_pattern: true,
        v4_pointer_max_candidates: v4PointerMaxCandidates,
      },
      candidate_count: candidateCount + v4PointerPatternCandidateCount,
      unique_candidate_count: candidates.size,
      v4_pointer_pattern_hit_count: v4PointerPatternHitCount,
      v4_pointer_pattern_candidate_count: v4PointerPatternCandidateCount,
      scanned_bytes: Number(scanned),
      region_count: regions.length,
      candidate_hashes: [...candidates.values()].map(c => c.hash.slice(0, 12)),
      ...(options.include_raw ? { raw_candidates: [...candidates.values()].map(c => c.raw) } : {}),
    };
  } finally {
    api.CloseHandle(handle);
  }
}

export async function scanProcessForVerifiedWeixinV4DbKeys(pid, options = {}) {
  const pages = normalizeVerifiedDbPages(options.db_pages || []);
  if (!pages.length) {
    return { candidate_count: 0, unique_candidate_count: 0, matched_salt_count: 0, hex_pattern_count: 0, scanned_bytes: 0, region_count: 0, candidate_hashes: [] };
  }
  const api = await loadKernel32();
  const handle = openReadOnlyProcess(api, pid);
  try {
    const writableOnly = options.writable_only === true;
    const includeMapped = options.include_mapped !== false;
    const regions = enumerateCandidateRegions(api, handle, { writableOnly, includeMapped });
    const scanLimit = BigInt(options.max_bytes || DEFAULT_SCAN_LIMIT_BYTES);
    const regionLimit = BigInt(options.max_region_bytes || DEFAULT_REGION_LIMIT_BYTES);
    const found = new Map();
    const matchedSalts = new Set();
    const seenHex = new Set();
    let scanned = 0n;
    let hexPatternCount = 0;

    for (const region of regions) {
      if (scanned >= scanLimit || matchedSalts.size >= pages.length) break;
      const toScan = region.size > regionLimit ? regionLimit : region.size;
      let carry = '';
      for (let offset = 0n; offset < toScan && scanned < scanLimit; offset += BigInt(CHUNK_BYTES)) {
        if (matchedSalts.size >= pages.length) break;
        const len = Number(minBigInt(BigInt(CHUNK_BYTES), toScan - offset, scanLimit - scanned));
        if (len <= 0) break;
        const buf = Buffer.allocUnsafe(len);
        const readOut = [0n];
        const ok = api.ReadProcessMemory(handle, region.base + offset, buf, BigInt(len), readOut);
        const read = Number(readOut[0] || 0n);
        if (!ok || read <= 0) continue;
        scanned += BigInt(read);
        const text = carry + buf.subarray(0, read).toString('latin1');
        const stats = addVerifiedWeixinV4RawKeyMatches(found, matchedSalts, seenHex, text, pages, {
          includeBareHex: options.include_bare_hex === true,
        });
        hexPatternCount += stats.hex_pattern_count;
        carry = text.slice(-RAW_KEY_TEXT_CARRY_CHARS);
      }
    }

    return {
      candidate_count: found.size,
      unique_candidate_count: found.size,
      matched_salt_count: matchedSalts.size,
      hex_pattern_count: hexPatternCount,
      scanned_bytes: Number(scanned),
      region_count: regions.length,
      scan_mode: {
        writable_only: writableOnly,
        include_mapped: includeMapped,
        max_bytes: Number(scanLimit),
        max_region_bytes: Number(regionLimit),
        verified_weixin_v4_hmac: true,
        include_bare_hex: options.include_bare_hex === true,
      },
      candidate_hashes: [...found.values()].map(c => c.hash.slice(0, 12)),
      ...(options.include_raw ? { raw_candidates: [...found.values()].map(c => c.raw) } : {}),
    };
  } finally {
    api.CloseHandle(handle);
  }
}

export async function scanProcessForCodecContextKeyCandidates(pid, options = {}) {
  const salts = normalizeDbSaltBuffers(options.db_salts || []);
  if (!salts.length) {
    return { candidate_count: 0, unique_candidate_count: 0, codec_context_hit_count: 0, codec_context_salt_match_count: 0, scanned_bytes: 0, region_count: 0, candidate_hashes: [] };
  }
  const saltSet = new Set(salts.map(salt => salt.toString('hex')));
  const api = await loadKernel32();
  const handle = openReadOnlyProcess(api, pid);
  try {
    const writableOnly = options.writable_only !== false;
    const includeMapped = options.include_mapped === true;
    const scanRegions = enumerateCandidateRegions(api, handle, { writableOnly, includeMapped });
    const readRegions = enumerateCandidateRegions(api, handle, { writableOnly: false, includeMapped: true });
    const scanLimit = BigInt(options.max_bytes || DEFAULT_SCAN_LIMIT_BYTES);
    const regionLimit = BigInt(options.max_region_bytes || DEFAULT_REGION_LIMIT_BYTES);
    const maxCandidates = normalizeMaxSaltCandidates(options.max_candidates);
    const candidates = new Map();
    let scanned = 0n;
    let codecContextHitCount = 0;
    let codecContextSaltMatchCount = 0;
    let codecPassReadCount = 0;
    let codecPassCandidateCount = 0;
    let codecKeyPointerReadCount = 0;
    let codecKeyPointerCandidateCount = 0;
    const seenCodecAddresses = new Set();
    let carry = Buffer.alloc(0);
    const carryBytes = 128;

    for (const region of scanRegions) {
      if (scanned >= scanLimit || candidates.size >= maxCandidates) break;
      const toScan = region.size > regionLimit ? regionLimit : region.size;
      for (let offset = 0n; offset < toScan && scanned < scanLimit; offset += BigInt(CHUNK_BYTES)) {
        if (candidates.size >= maxCandidates) break;
        const len = Number(minBigInt(BigInt(CHUNK_BYTES), toScan - offset, scanLimit - scanned));
        if (len <= 0) break;
        const buf = Buffer.allocUnsafe(len);
        const readOut = [0n];
        const ok = api.ReadProcessMemory(handle, region.base + offset, buf, BigInt(len), readOut);
        const read = Number(readOut[0] || 0n);
        if (!ok || read <= 0) continue;
        scanned += BigInt(read);
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, read)]) : buf.subarray(0, read);
        const chunkBase = region.base + offset - BigInt(carry.length);
        const alignedFrom = Number((8n - (chunkBase % 8n)) % 8n);
        for (let pos = alignedFrom; pos <= chunk.length - 128; pos += 8) {
          if (candidates.size >= maxCandidates) break;
          const address = chunkBase + BigInt(pos);
          const addressKey = address.toString();
          if (seenCodecAddresses.has(addressKey)) continue;
          const codec = readSqlCipherCodecContextCandidate(chunk, pos);
          if (!codec) continue;
          seenCodecAddresses.add(addressKey);
          codecContextHitCount++;
          const salt = readProcessBytes(api, handle, readRegions, codec.kdf_salt, 16);
          const saltHex = salt?.length === 16 ? salt.toString('hex') : '';
          if (!saltSet.has(saltHex)) continue;
          codecContextSaltMatchCount++;
          for (const cipherCtx of [codec.read_ctx, codec.write_ctx]) {
            const stats = addCodecCipherContextCandidates(api, handle, readRegions, cipherCtx, saltHex, candidates, maxCandidates);
            codecPassReadCount += stats.pass_read_count;
            codecPassCandidateCount += stats.pass_candidate_count;
            codecKeyPointerReadCount += stats.key_pointer_read_count;
            codecKeyPointerCandidateCount += stats.key_pointer_candidate_count;
          }
        }
        carry = chunk.subarray(Math.max(0, chunk.length - carryBytes));
      }
      carry = Buffer.alloc(0);
    }

    return {
      scan_mode: {
        include_mapped: includeMapped,
        writable_only: writableOnly,
        read_include_mapped: true,
        max_bytes: Number(scanLimit),
        max_region_bytes: Number(regionLimit),
        max_candidates: maxCandidates,
        db_salt_count: salts.length,
      },
      candidate_count: candidates.size,
      unique_candidate_count: candidates.size,
      codec_context_hit_count: codecContextHitCount,
      codec_context_salt_match_count: codecContextSaltMatchCount,
      codec_pass_read_count: codecPassReadCount,
      codec_pass_candidate_count: codecPassCandidateCount,
      codec_key_pointer_read_count: codecKeyPointerReadCount,
      codec_key_pointer_candidate_count: codecKeyPointerCandidateCount,
      scanned_bytes: Number(scanned),
      region_count: scanRegions.length,
      candidate_hashes: [...candidates.values()].map(c => c.hash.slice(0, 12)),
      ...(options.include_raw ? { raw_candidates: [...candidates.values()].map(c => c.raw) } : {}),
    };
  } finally {
    api.CloseHandle(handle);
  }
}

export async function scanProcessForImageKeyCandidates(pid, options = {}) {
  const samples = (options.validation_samples || [])
    .map(sample => Buffer.isBuffer(sample) ? sample : Buffer.from(String(sample || ''), 'base64'))
    .filter(sample => sample.length >= 16)
    .slice(0, 32);
  if (!samples.length) {
    return { candidate_count: 0, unique_candidate_count: 0, scanned_bytes: 0, region_count: 0, candidate_hashes: [] };
  }

  const api = await loadKernel32();
  const handle = openReadOnlyProcess(api, pid);
  try {
    const regions = enumerateCandidateRegions(api, handle, { writableOnly: false, includeMapped: options.include_mapped === true });
    const scanLimit = BigInt(options.max_bytes || DEFAULT_IMAGE_SCAN_LIMIT_BYTES);
    const regionLimit = BigInt(options.max_region_bytes || DEFAULT_REGION_LIMIT_BYTES);
    const deadline = options.max_ms ? Date.now() + Math.max(1000, Number(options.max_ms)) : 0;
    const candidates = new Map();
    const stopAfter = options.stop_after_found === false ? Infinity : 1;
    let candidateCount = 0;
    let scanned = 0n;
    let carry = Buffer.alloc(0);

    for (const region of regions) {
      if (deadline && Date.now() >= deadline) break;
      if (scanned >= scanLimit || candidates.size >= stopAfter) break;
      const toScan = region.size > regionLimit ? regionLimit : region.size;
      for (let offset = 0n; offset < toScan && scanned < scanLimit; offset += BigInt(CHUNK_BYTES)) {
        if (deadline && Date.now() >= deadline) break;
        if (candidates.size >= stopAfter) break;
        const len = Number(minBigInt(BigInt(CHUNK_BYTES), toScan - offset, scanLimit - scanned));
        if (len <= 0) break;
        const buf = Buffer.allocUnsafe(len);
        const readOut = [0n];
        const ok = api.ReadProcessMemory(handle, region.base + offset, buf, BigInt(len), readOut);
        const read = Number(readOut[0] || 0n);
        if (!ok || read <= 0) continue;
        scanned += BigInt(read);
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, read)]) : buf.subarray(0, read);
        const found = findImageKeyCandidates(chunk, samples);
        candidateCount += found.length;
        for (const item of found) {
          if (!candidates.has(item.hash)) candidates.set(item.hash, item);
        }
        carry = chunk.subarray(Math.max(0, chunk.length - 64));
      }
      carry = Buffer.alloc(0);
    }

    return {
      candidate_count: candidateCount,
      unique_candidate_count: candidates.size,
      scanned_bytes: Number(scanned),
      region_count: regions.length,
      candidate_hashes: [...candidates.values()].map(c => c.hash.slice(0, 12)),
      ...(options.include_raw ? { raw_candidates: [...candidates.values()].map(c => c.raw) } : {}),
    };
  } finally {
    api.CloseHandle(handle);
  }
}

function enumerateCandidateRegions(api, handle, { writableOnly = true, includeMapped = false } = {}) {
  const regions = [];
  let address = 0n;
  const mbiSize = api.koffi.sizeof(api.MemoryInfo);
  for (let i = 0; i < 200000; i++) {
    const info = {};
    const ret = api.VirtualQueryEx(handle, address, info, mbiSize);
    if (!ret) break;
    const base = BigInt(info.BaseAddress || 0);
    const size = BigInt(info.RegionSize || 0);
    if (
      info.State === MEM_COMMIT &&
      (info.Type === MEM_PRIVATE || (includeMapped && (info.Type === MEM_MAPPED || info.Type === MEM_IMAGE))) &&
      isReadableProtect(info.Protect, writableOnly) &&
      size > 0n
    ) {
      regions.push({ base, size, protect: info.Protect });
    }
    const next = base + size;
    if (next <= address || next > 0x7ffffffffffffffen) break;
    address = next;
  }
  return regions;
}

function isReadableProtect(protect, writableOnly) {
  if (protect & (PAGE_GUARD | PAGE_NOACCESS)) return false;
  const mask = writableOnly
    ? (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)
    : (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY);
  return !!(protect & mask);
}

function normalizeDbSaltBuffers(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    let buf = Buffer.isBuffer(value) ? value : null;
    if (!buf) {
      const text = String(value || '').trim();
      if (/^[a-fA-F0-9]{32}$/.test(text)) buf = Buffer.from(text, 'hex');
    }
    if (!buf || buf.length !== 16) continue;
    const hex = buf.toString('hex');
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push(buf);
  }
  return out;
}

function normalizeAnchorBuffers(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || '').trim();
    if (text.length < 4 || text.length > 260) continue;
    for (const buf of [Buffer.from(text, 'utf-8'), Buffer.from(text, 'utf16le')]) {
      if (buf.length < 4) continue;
      const hex = buf.toString('hex');
      if (seen.has(hex)) continue;
      seen.add(hex);
      out.push(buf);
    }
  }
  return out.sort((a, b) => b.length - a.length).slice(0, 64);
}

function normalizePointerAddressValues(values = []) {
  return normalizePointerAddressItems(values).map(item => item.address);
}

function normalizePointerAddressItems(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    let address = 0n;
    let label = 'unknown';
    if (typeof value === 'bigint') {
      address = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      address = BigInt(Math.trunc(value));
    } else if (typeof value === 'string') {
      const text = value.trim();
      if (/^0x[0-9a-fA-F]+$/.test(text)) address = BigInt(text);
      else if (/^\d+$/.test(text)) address = BigInt(text);
    } else if (value && typeof value === 'object') {
      const rawAddress = value.address ?? value.virtual_address ?? value.target ?? value.value;
      if (typeof rawAddress === 'bigint') address = rawAddress;
      else if (typeof rawAddress === 'number' && Number.isFinite(rawAddress)) address = BigInt(Math.trunc(rawAddress));
      else if (typeof rawAddress === 'string') {
        const text = rawAddress.trim();
        if (/^0x[0-9a-fA-F]+$/.test(text)) address = BigInt(text);
        else if (/^\d+$/.test(text)) address = BigInt(text);
      }
      label = normalizeAnchorAddressLabel(value.label || value.pattern || value.name || 'unknown');
    }
    if (!looksLikeUserAddress(address)) continue;
    const key = address.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address, label });
    if (out.length >= MAX_REVERSE_POINTER_TARGETS) break;
  }
  return out;
}

function normalizeAnchorAddressLabel(value) {
  const text = String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return text || 'unknown';
}

function addSaltNeighborCandidates(candidates, bytes, saltStart, saltLength, neighborBytes, maxCandidates = MAX_SALT_KEY_CANDIDATES) {
  const saltEnd = saltStart + saltLength;
  const directBefore = saltStart - 32;
  const directAfter = saltEnd;
  addBinaryKeyCandidate(candidates, bytes, directBefore, maxCandidates);
  addBinaryKeyCandidate(candidates, bytes, directAfter, maxCandidates);
  const from = Math.max(0, saltStart - neighborBytes);
  const to = Math.min(bytes.length - 32, saltEnd + neighborBytes);
  for (let pos = from; pos <= to; pos++) {
    if (pos < saltEnd && pos + 32 > saltStart) continue;
    addBinaryKeyCandidate(candidates, bytes, pos, maxCandidates);
    if (candidates.size >= maxCandidates) return;
  }
}

function addAnchorNeighborCandidates(candidates, bytes, anchorStart, anchorLength, neighborBytes, maxCandidates = MAX_SALT_KEY_CANDIDATES) {
  const anchorEnd = anchorStart + anchorLength;
  const distances = [0, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256].filter(v => v <= neighborBytes);
  for (const distance of distances) {
    addBinaryKeyCandidate(candidates, bytes, anchorStart - 32 - distance, maxCandidates);
    if (candidates.size >= maxCandidates) return;
    addBinaryKeyCandidate(candidates, bytes, anchorEnd + distance, maxCandidates);
    if (candidates.size >= maxCandidates) return;
  }
}

function findSaltNeighborPointers(bytes, saltStart, neighborBytes = SALT_POINTER_NEIGHBOR_BYTES, maxPointers = 16) {
  return findSaltNeighborPointerInfos(bytes, saltStart, neighborBytes, maxPointers).map(item => item.value);
}

function findSaltNeighborPointerInfos(bytes, saltStart, neighborBytes = SALT_POINTER_NEIGHBOR_BYTES, maxPointers = 16) {
  const out = [];
  const from = Math.max(0, saltStart - neighborBytes);
  const to = Math.min(bytes.length - 8, saltStart + neighborBytes);
  const alignedFrom = from + ((8 - (from % 8)) % 8);
  const seen = new Set();
  for (let pos = alignedFrom; pos <= to; pos += 8) {
    const value = bytes.readBigUInt64LE(pos);
    if (!looksLikeUserPointer(value)) continue;
    const key = value.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value, distance: Math.abs(pos - saltStart), pos });
  }
  return out
    .sort((a, b) => a.distance - b.distance || a.pos - b.pos)
    .slice(0, Math.max(0, Number(maxPointers || 0)));
}

function addHitAddress(out, seen, address) {
  if (!looksLikeUserAddress(address) || out.length >= MAX_REVERSE_POINTER_TARGETS) return;
  const key = address.toString();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(address);
}

async function scanReversePointersForCandidates(api, handle, regions, targetAddresses, candidates, options = {}) {
  const targetWindow = expandedPointerTargetWindow(options.target_items || targetAddresses, options.target_range_bytes);
  if (!targetWindow.targets.length || candidates.size >= options.max_candidates) return { pointer_hit_count: 0, scanned_bytes: 0 };
  const { targetSet, targetLabelMap, minTarget, maxTarget } = targetWindow;
  const scanLimit = BigInt(options.max_bytes || DEFAULT_SCAN_LIMIT_BYTES);
  const maxCandidates = normalizeMaxSaltCandidates(options.max_candidates);
  const maxHits = normalizeMaxReversePointerHits(options.max_hits);
  const layoutSampler = createReversePointerLayoutSampler(api, handle, regions, {
    enabled: options.layout_sample === true,
  });
  const highEntropyTargetState = createHighEntropyPointerTargetState({
    enabled: options.high_entropy_targets === true,
  });
  const carryBytes = 8 + REVERSE_POINTER_NEIGHBOR_BYTES * 2 + 64;
  const deferredPointerTargets = [];
  const deferredPointerTargetSet = new Set();
  const secondHopTargets = [];
  const secondHopTargetSet = new Set();
  let scanned = 0n;
  let pointerHitCount = 0;
  let carry = Buffer.alloc(0);
  let directCandidateCount = 0;
  let followedPointerTargetCount = 0;

  for (const region of regions) {
    if (scanned >= scanLimit || pointerHitCount >= maxHits) break;
    const toScan = region.size;
    for (let offset = 0n; offset < toScan && scanned < scanLimit; offset += BigInt(CHUNK_BYTES)) {
      if (pointerHitCount >= maxHits) break;
      const len = Number(minBigInt(BigInt(CHUNK_BYTES), toScan - offset, scanLimit - scanned));
      if (len <= 0) break;
      const buf = Buffer.allocUnsafe(len);
      const readOut = [0n];
      const ok = api.ReadProcessMemory(handle, region.base + offset, buf, BigInt(len), readOut);
      const read = Number(readOut[0] || 0n);
      if (!ok || read <= 0) continue;
      scanned += BigInt(read);
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, read)]) : buf.subarray(0, read);
      const chunkBase = region.base + offset - BigInt(carry.length);
      const alignedFrom = Number((8n - (chunkBase % 8n)) % 8n);
      for (let pos = alignedFrom; pos <= chunk.length - 8; pos += 8) {
        if (pointerHitCount >= maxHits) break;
        const value = chunk.readBigUInt64LE(pos);
        if (value < minTarget || value > maxTarget) continue;
        if (!targetSet.has(value.toString())) continue;
        const anchorLabel = targetLabelMap.get(value.toString()) || 'unknown';
        pointerHitCount++;
        if (options.second_hop_reverse_pointers) {
          addHitAddress(secondHopTargets, secondHopTargetSet, chunkBase + BigInt(pos));
        }
        layoutSampler.sample(chunk, pos, targetSet, anchorLabel);
        addReversePointerObjectCandidates(candidates, chunk, pos, maxCandidates, options.direct_max_distance);
        addCryptoLabelObjectSweepCandidates(chunk, pos, anchorLabel, candidates, maxCandidates, highEntropyTargetState);
        directCandidateCount = Math.max(directCandidateCount, candidates.size);
        await addHighEntropyPointerTargetCandidates(api, handle, regions, chunk, pos, candidates, maxCandidates, highEntropyTargetState);
        const pointerTargets = findSaltNeighborPointerInfos(chunk, pos, REVERSE_POINTER_NEIGHBOR_BYTES, 6);
        for (const target of pointerTargets) {
          const key = target.value.toString();
          if (deferredPointerTargetSet.has(key)) continue;
          deferredPointerTargetSet.add(key);
          deferredPointerTargets.push(target);
        }
      }
      carry = chunk.subarray(Math.max(0, chunk.length - carryBytes));
    }
    carry = Buffer.alloc(0);
  }
  const secondHopCandidateCountBefore = candidates.size;
  const secondHop = options.second_hop_reverse_pointers && secondHopTargets.length && candidates.size < maxCandidates
    ? await scanReversePointersForCandidates(api, handle, regions, secondHopTargets, candidates, {
        max_candidates: maxCandidates,
        max_bytes: options.second_hop_max_bytes || options.max_bytes,
        max_hits: options.second_hop_max_hits || Math.min(maxHits, 512),
        target_range_bytes: options.second_hop_target_range_bytes || REVERSE_POINTER_SECOND_HOP_TARGET_RANGE_BYTES,
        direct_max_distance: options.direct_max_distance,
        layout_sample: false,
        high_entropy_targets: options.high_entropy_targets,
        second_hop_reverse_pointers: false,
      })
    : { pointer_hit_count: 0, scanned_bytes: 0 };
  const secondHopCandidateCount = Math.max(0, candidates.size - secondHopCandidateCountBefore);
  deferredPointerTargets.sort((a, b) => a.distance - b.distance || a.pos - b.pos);
  for (const target of deferredPointerTargets) {
    if (candidates.size >= maxCandidates) break;
    await addPointerTargetCandidates(api, handle, regions, target.value, candidates, maxCandidates);
    followedPointerTargetCount++;
  }
  return {
    pointer_hit_count: pointerHitCount,
    scanned_bytes: Number(scanned),
    direct_candidate_count: directCandidateCount,
    deferred_pointer_target_count: deferredPointerTargets.length,
    followed_pointer_target_count: followedPointerTargetCount,
    high_entropy_target_read_count: highEntropyTargetState.read_count,
    high_entropy_candidate_count: highEntropyTargetState.candidate_count,
    high_entropy_window_candidate_count: highEntropyTargetState.window_candidate_count,
    high_entropy_pointer_table_read_count: highEntropyTargetState.pointer_table_read_count,
    high_entropy_pointer_table_candidate_count: highEntropyTargetState.pointer_table_candidate_count,
    crypto_object_sweep_hit_count: highEntropyTargetState.crypto_object_sweep_hit_count,
    crypto_object_sweep_candidate_count: highEntropyTargetState.crypto_object_sweep_candidate_count,
    second_hop_target_count: secondHopTargets.length,
    second_hop_pointer_hit_count: secondHop.pointer_hit_count || 0,
    second_hop_candidate_count: secondHopCandidateCount,
    second_hop_scanned_bytes: secondHop.scanned_bytes || 0,
    ...(layoutSampler.enabled ? { layout_summary: layoutSampler.summary() } : {}),
  };
}

export async function scanProcessForPointerTargetKeyCandidates(pid, options = {}) {
  const targetItems = normalizePointerAddressItems(options.target_addresses || []);
  const targets = targetItems.map(item => item.address);
  if (!targets.length) {
    return { candidate_count: 0, unique_candidate_count: 0, target_address_count: 0, scanned_bytes: 0, region_count: 0, candidate_hashes: [] };
  }
  const api = await loadKernel32();
  const handle = openReadOnlyProcess(api, pid);
  try {
    const writableOnly = options.writable_only === true;
    const includeMapped = options.include_mapped !== false;
    const regions = enumerateCandidateRegions(api, handle, { writableOnly, includeMapped });
    const maxCandidates = normalizeMaxSaltCandidates(options.max_candidates);
    const candidates = new Map();
    const reverse = await scanReversePointersForCandidates(api, handle, regions, targets, candidates, {
      max_candidates: maxCandidates,
      max_bytes: options.max_bytes || DEFAULT_SCAN_LIMIT_BYTES,
      max_hits: options.reverse_pointer_max_hits,
      target_range_bytes: options.target_range_bytes,
      direct_max_distance: options.reverse_pointer_direct_max_distance,
      layout_sample: options.reverse_pointer_layout_sample,
      high_entropy_targets: options.reverse_pointer_high_entropy_targets,
      second_hop_reverse_pointers: options.second_hop_reverse_pointers,
      target_items: targetItems,
    });
    return {
      scan_mode: {
        writable_only: writableOnly,
        include_mapped: includeMapped,
        target_address_count: targets.length,
        max_bytes: Number(options.max_bytes || DEFAULT_SCAN_LIMIT_BYTES),
        max_candidates: maxCandidates,
        target_range_bytes: normalizePointerTargetRangeBytes(options.target_range_bytes),
        defer_pointer_follow: true,
        direct_max_distance: normalizeReversePointerDirectDistance(options.reverse_pointer_direct_max_distance),
        reverse_pointer_max_hits: normalizeMaxReversePointerHits(options.reverse_pointer_max_hits),
        reverse_pointer_layout_sample: options.reverse_pointer_layout_sample === true,
        reverse_pointer_high_entropy_targets: options.reverse_pointer_high_entropy_targets === true,
        second_hop_reverse_pointers: options.second_hop_reverse_pointers === true,
      },
      candidate_count: candidates.size,
      unique_candidate_count: candidates.size,
      target_address_count: targets.length,
      reverse_pointer_hit_count: reverse.pointer_hit_count,
      reverse_pointer_scanned_bytes: reverse.scanned_bytes,
      reverse_pointer_direct_candidate_count: reverse.direct_candidate_count,
      reverse_pointer_deferred_target_count: reverse.deferred_pointer_target_count,
      reverse_pointer_followed_target_count: reverse.followed_pointer_target_count,
      reverse_pointer_high_entropy_target_read_count: reverse.high_entropy_target_read_count,
      reverse_pointer_high_entropy_candidate_count: reverse.high_entropy_candidate_count,
      reverse_pointer_high_entropy_window_candidate_count: reverse.high_entropy_window_candidate_count,
      reverse_pointer_high_entropy_pointer_table_read_count: reverse.high_entropy_pointer_table_read_count,
      reverse_pointer_high_entropy_pointer_table_candidate_count: reverse.high_entropy_pointer_table_candidate_count,
      reverse_pointer_crypto_object_sweep_hit_count: reverse.crypto_object_sweep_hit_count,
      reverse_pointer_crypto_object_sweep_candidate_count: reverse.crypto_object_sweep_candidate_count,
      reverse_pointer_second_hop_target_count: reverse.second_hop_target_count,
      reverse_pointer_second_hop_hit_count: reverse.second_hop_pointer_hit_count,
      reverse_pointer_second_hop_candidate_count: reverse.second_hop_candidate_count,
      reverse_pointer_second_hop_scanned_bytes: reverse.second_hop_scanned_bytes,
      reverse_pointer_layout_summary: reverse.layout_summary || null,
      scanned_bytes: reverse.scanned_bytes,
      region_count: regions.length,
      candidate_hashes: [...candidates.values()].map(c => c.hash.slice(0, 12)),
      ...(options.include_raw ? { raw_candidates: [...candidates.values()].map(c => c.raw) } : {}),
    };
  } finally {
    api.CloseHandle(handle);
  }
}

function createReversePointerLayoutSampler(api, handle, regions, options = {}) {
  const enabled = options.enabled === true;
  const pointerFieldOffsets = {};
  const targetPointerOffsets = {};
  const zeroFieldOffsets = {};
  const smallUint32Offsets = {};
  const lengthLikeOffsets = {};
  const pointerTargetKinds = {};
  const pointerTargetKindOffsets = {};
  const targetAnchorLabels = {};
  const anchorLabelStates = {};
  let sampledHitCount = 0;
  let pointerTargetReads = 0;

  function sample(bytes, pointerOffset, targetSet, anchorLabel = 'unknown') {
    if (!enabled || sampledHitCount >= REVERSE_POINTER_LAYOUT_MAX_HITS) return;
    const label = normalizeAnchorAddressLabel(anchorLabel);
    const labelState = getAnchorLabelLayoutState(anchorLabelStates, label);
    if (labelState.sampledHitCount >= REVERSE_POINTER_LAYOUT_MAX_HITS_PER_LABEL) return;
    addLayoutCounter(targetAnchorLabels, label);
    sampledHitCount++;
    labelState.sampledHitCount++;
    const windowBytes = REVERSE_POINTER_LAYOUT_WINDOW_BYTES;
    for (let rel = -windowBytes; rel <= windowBytes; rel += 8) {
      const pos = pointerOffset + rel;
      if (pos < 0 || pos + 8 > bytes.length) continue;
      const value = bytes.readBigUInt64LE(pos);
      if (value === 0n) {
        addLayoutCounter(zeroFieldOffsets, rel);
        addLayoutCounter(labelState.zeroFieldOffsets, rel);
      } else if (looksLikeUserPointer(value)) {
        addLayoutCounter(pointerFieldOffsets, rel);
        addLayoutCounter(labelState.pointerFieldOffsets, rel);
        if (targetSet?.has?.(value.toString())) {
          addLayoutCounter(targetPointerOffsets, rel);
          addLayoutCounter(labelState.targetPointerOffsets, rel);
        }
        if (pointerTargetReads < REVERSE_POINTER_LAYOUT_MAX_POINTER_READS) {
          const kind = classifyPointerTargetKind(api, handle, regions, value);
          pointerTargetReads++;
          labelState.pointerTargetReads++;
          addLayoutCounter(pointerTargetKinds, kind);
          addLayoutCounter(labelState.pointerTargetKinds, kind);
          addNestedLayoutCounter(pointerTargetKindOffsets, kind, rel);
        }
      }
      if (value > 0n && value <= 0x100000n) {
        addLayoutCounter(lengthLikeOffsets, rel);
        addLayoutCounter(labelState.lengthLikeOffsets, rel);
      }
    }
    for (let rel = -windowBytes; rel <= windowBytes; rel += 4) {
      const pos = pointerOffset + rel;
      if (pos < 0 || pos + 4 > bytes.length) continue;
      const value = bytes.readUInt32LE(pos);
      if (value > 0 && value <= 0x100000) {
        addLayoutCounter(smallUint32Offsets, rel);
        addLayoutCounter(labelState.smallUint32Offsets, rel);
      }
    }
  }

  return {
    enabled,
    sample,
    summary() {
      return {
        sampled_hit_count: sampledHitCount,
        field_window_bytes: REVERSE_POINTER_LAYOUT_WINDOW_BYTES,
        pointer_target_reads: pointerTargetReads,
        pointer_field_offsets: topLayoutCounters(pointerFieldOffsets),
        target_pointer_offsets: topLayoutCounters(targetPointerOffsets),
        zero_field_offsets: topLayoutCounters(zeroFieldOffsets),
        small_uint32_offsets: topLayoutCounters(smallUint32Offsets),
        length_like_offsets: topLayoutCounters(lengthLikeOffsets),
        pointer_target_kinds: topLayoutCounters(pointerTargetKinds, 8),
        pointer_target_kind_offsets: summarizeNestedLayoutCounters(pointerTargetKindOffsets),
        target_anchor_labels: topLayoutCounters(targetAnchorLabels, 12),
        anchor_label_layouts: summarizeAnchorLabelLayouts(anchorLabelStates),
      };
    },
  };
}

function getAnchorLabelLayoutState(states, label) {
  if (!states[label]) {
    states[label] = {
      label,
      sampledHitCount: 0,
      pointerTargetReads: 0,
      pointerFieldOffsets: {},
      targetPointerOffsets: {},
      zeroFieldOffsets: {},
      smallUint32Offsets: {},
      lengthLikeOffsets: {},
      pointerTargetKinds: {},
    };
  }
  return states[label];
}

function summarizeAnchorLabelLayouts(states, limit = 8) {
  return Object.values(states || {})
    .sort((a, b) => b.sampledHitCount - a.sampledHitCount || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map(state => ({
      label: state.label,
      sampled_hit_count: state.sampledHitCount,
      pointer_target_reads: state.pointerTargetReads,
      pointer_field_offsets: topLayoutCounters(state.pointerFieldOffsets, 6),
      target_pointer_offsets: topLayoutCounters(state.targetPointerOffsets, 6),
      small_uint32_offsets: topLayoutCounters(state.smallUint32Offsets, 6),
      length_like_offsets: topLayoutCounters(state.lengthLikeOffsets, 6),
      pointer_target_kinds: topLayoutCounters(state.pointerTargetKinds, 6),
    }));
}

function classifyPointerTargetKind(api, handle, regions, address) {
  const region = findRegionForAddress(regions, address);
  if (!region) return 'outside_candidate_regions';
  const maxLen = Number(minBigInt(128n, region.base + region.size - address));
  if (maxLen < 16) return 'too_small';
  const buf = Buffer.allocUnsafe(maxLen);
  const readOut = [0n];
  const ok = api.ReadProcessMemory(handle, address, buf, BigInt(maxLen), readOut);
  const read = Number(readOut[0] || 0n);
  if (!ok || read < 16) return 'unreadable';
  const bytes = buf.subarray(0, read);
  if (looksLikeUtf16LeString(bytes)) return 'utf16_string';
  if (looksLikeAsciiString(bytes)) return 'ascii_string';
  if (looksLikePointerTable(bytes)) return 'pointer_table';
  if (bytes.length >= 32 && !looksLowEntropy(bytes.subarray(0, 32))) return 'high_entropy_32';
  return 'readable_other';
}

function looksLikeAsciiString(bytes) {
  let printable = 0;
  let total = 0;
  for (let i = 0; i < bytes.length && i < 96; i++) {
    const byte = bytes[i];
    if (byte === 0) break;
    total++;
    if ((byte >= 0x20 && byte <= 0x7e) || byte >= 0x80) printable++;
  }
  return total >= 6 && printable / total >= 0.82;
}

function looksLikeUtf16LeString(bytes) {
  let chars = 0;
  let printable = 0;
  for (let i = 0; i + 1 < bytes.length && i < 96; i += 2) {
    const lo = bytes[i];
    const hi = bytes[i + 1];
    if (lo === 0 && hi === 0) break;
    chars++;
    if (hi === 0 && ((lo >= 0x20 && lo <= 0x7e) || lo >= 0x80)) printable++;
  }
  return chars >= 4 && printable / chars >= 0.82;
}

function looksLikePointerTable(bytes) {
  let pointerCount = 0;
  let slots = 0;
  for (let i = 0; i + 8 <= bytes.length && i < 64; i += 8) {
    slots++;
    if (looksLikeUserPointer(bytes.readBigUInt64LE(i))) pointerCount++;
  }
  return slots >= 4 && pointerCount >= 3;
}

function addLayoutCounter(target, key) {
  const safeKey = String(key);
  target[safeKey] = (target[safeKey] || 0) + 1;
}

function addNestedLayoutCounter(target, outer, inner) {
  const safeOuter = String(outer || 'unknown');
  if (!target[safeOuter]) target[safeOuter] = {};
  addLayoutCounter(target[safeOuter], inner);
}

function topLayoutCounters(map, limit = 12) {
  return Object.entries(map || {})
    .map(([key, count]) => ({ key, count: Number(count || 0) }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count || layoutCounterSortValue(a.key) - layoutCounterSortValue(b.key))
    .slice(0, limit);
}

function summarizeNestedLayoutCounters(map, limit = 6) {
  return Object.fromEntries(
    Object.entries(map || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([key, counters]) => [key, topLayoutCounters(counters, 6)])
  );
}

function layoutCounterSortValue(key) {
  const n = Number(key);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function createHighEntropyPointerTargetState(options = {}) {
  return {
    enabled: options.enabled === true,
    seen: new Set(),
    pointer_table_seen: new Set(),
    read_count: 0,
    candidate_count: 0,
    window_candidate_count: 0,
    pointer_table_read_count: 0,
    pointer_table_target_read_count: 0,
    pointer_table_candidate_count: 0,
    crypto_object_sweep_hit_count: 0,
    crypto_object_sweep_candidate_count: 0,
  };
}

async function addHighEntropyPointerTargetCandidates(api, handle, regions, bytes, pointerOffset, candidates, maxCandidates, state) {
  if (!state?.enabled || candidates.size >= maxCandidates || state.read_count >= REVERSE_POINTER_HIGH_ENTROPY_TARGET_MAX_READS) return;
  const from = Math.max(0, pointerOffset - REVERSE_POINTER_LAYOUT_WINDOW_BYTES);
  const to = Math.min(bytes.length - 8, pointerOffset + REVERSE_POINTER_LAYOUT_WINDOW_BYTES);
  const alignedFrom = from + ((8 - (from % 8)) % 8);
  for (let pos = alignedFrom; pos <= to; pos += 8) {
    if (candidates.size >= maxCandidates || state.read_count >= REVERSE_POINTER_HIGH_ENTROPY_TARGET_MAX_READS) return;
    const address = bytes.readBigUInt64LE(pos);
    if (!looksLikeUserPointer(address)) continue;
    const key = address.toString();
    if (state.seen.has(key)) continue;
    state.seen.add(key);
    state.read_count++;
    await addPointerTargetWindowKeyCandidates(api, handle, regions, address, candidates, maxCandidates, state);
  }
}

async function addPointerTargetKeyCandidate(api, handle, regions, target, candidates, maxCandidates) {
  const region = findRegionForAddress(regions, target);
  if (!region || target + 32n > region.base + region.size) return false;
  const buf = Buffer.allocUnsafe(32);
  const readOut = [0n];
  const ok = api.ReadProcessMemory(handle, target, buf, 32n, readOut);
  const read = Number(readOut[0] || 0n);
  if (!ok || read < 32) return false;
  return addBinaryKeyCandidate(candidates, buf, 0, maxCandidates);
}

async function addPointerTargetWindowKeyCandidates(api, handle, regions, target, candidates, maxCandidates, state) {
  const region = findRegionForAddress(regions, target);
  if (!region) return;
  const maxLen = Number(minBigInt(
    BigInt(REVERSE_POINTER_HIGH_ENTROPY_TARGET_WINDOW_BYTES),
    region.base + region.size - target
  ));
  if (maxLen < 32) return;
  const buf = Buffer.allocUnsafe(maxLen);
  const readOut = [0n];
  const ok = api.ReadProcessMemory(handle, target, buf, BigInt(maxLen), readOut);
  const read = Number(readOut[0] || 0n);
  if (!ok || read < 32) return;
  const bytes = buf.subarray(0, read);

  for (const offset of REVERSE_POINTER_HIGH_ENTROPY_TARGET_OFFSETS) {
    if (state.window_candidate_count >= REVERSE_POINTER_HIGH_ENTROPY_WINDOW_MAX_CANDIDATES) break;
    if (offset + 32 > bytes.length) continue;
    if (addBinaryKeyCandidate(candidates, bytes, offset, maxCandidates)) {
      state.candidate_count++;
      state.window_candidate_count++;
    }
  }

  if (!looksLikePointerTable(bytes) || state.pointer_table_read_count >= REVERSE_POINTER_HIGH_ENTROPY_POINTER_TABLE_MAX_READS) return;
  state.pointer_table_read_count++;
  for (const nestedTarget of pointerTableTargets(bytes, REVERSE_POINTER_HIGH_ENTROPY_POINTER_TABLE_MAX_POINTERS)) {
    if (state.pointer_table_target_read_count >= REVERSE_POINTER_HIGH_ENTROPY_POINTER_TABLE_MAX_READS) break;
    const key = nestedTarget.toString();
    if (state.pointer_table_seen.has(key)) continue;
    state.pointer_table_seen.add(key);
    state.pointer_table_target_read_count++;
    if (await addPointerTargetKeyCandidate(api, handle, regions, nestedTarget, candidates, maxCandidates)) {
      state.candidate_count++;
      state.pointer_table_candidate_count++;
    }
  }
}

function pointerTableTargets(bytes, limit = REVERSE_POINTER_HIGH_ENTROPY_POINTER_TABLE_MAX_POINTERS) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i + 8 <= bytes.length && i < 96; i += 8) {
    const value = bytes.readBigUInt64LE(i);
    if (!looksLikeUserPointer(value)) continue;
    const key = value.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function addCryptoLabelObjectSweepCandidates(bytes, pointerOffset, anchorLabel, candidates, maxCandidates, state) {
  if (!state?.enabled || !isCryptoAnchorLabel(anchorLabel)) return;
  if (state.crypto_object_sweep_candidate_count >= REVERSE_POINTER_CRYPTO_OBJECT_SWEEP_MAX_CANDIDATES) return;
  state.crypto_object_sweep_hit_count++;
  const from = Math.max(0, pointerOffset - REVERSE_POINTER_LAYOUT_WINDOW_BYTES);
  const to = Math.min(bytes.length - 32, pointerOffset + REVERSE_POINTER_LAYOUT_WINDOW_BYTES);
  for (let pos = from; pos <= to; pos += REVERSE_POINTER_CRYPTO_OBJECT_SWEEP_STEP_BYTES) {
    if (state.crypto_object_sweep_candidate_count >= REVERSE_POINTER_CRYPTO_OBJECT_SWEEP_MAX_CANDIDATES) return;
    if (pos < pointerOffset + 8 && pos + 32 > pointerOffset) continue;
    if (addBinaryKeyCandidate(candidates, bytes, pos, maxCandidates)) {
      state.candidate_count++;
      state.crypto_object_sweep_candidate_count++;
    }
  }
}

function isCryptoAnchorLabel(label) {
  return /cipher|wcdb|kdf|hmac|sqlite3_key|rekey|setkey|pragma cipher|sqlcipher/i.test(String(label || ''));
}

function uniquePointerTargets(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (!looksLikeUserAddress(value)) continue;
    const key = value.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_REVERSE_POINTER_TARGETS) break;
  }
  return out;
}

function expandedPointerTargetWindow(values = [], rangeBytes = 0) {
  const targetItems = normalizePointerAddressItems(values);
  const targets = uniquePointerTargets(targetItems.map(item => item.address));
  const range = normalizePointerTargetRangeBytes(rangeBytes);
  const targetSet = new Set();
  const targetLabelMap = new Map();
  const labelByAddress = new Map(targetItems.map(item => [item.address.toString(), item.label]));
  let minTarget = targets[0] || 0n;
  let maxTarget = targets[0] || 0n;
  for (const target of targets) {
    const label = labelByAddress.get(target.toString()) || 'unknown';
    const from = target > BigInt(range) ? target - BigInt(range) : target;
    const to = target + BigInt(range);
    if (from < minTarget) minTarget = from;
    if (to > maxTarget) maxTarget = to;
    for (let offset = -range; offset <= range; offset++) {
      const value = target + BigInt(offset);
      if (looksLikeUserAddress(value)) {
        const key = value.toString();
        targetSet.add(key);
        if (!targetLabelMap.has(key)) targetLabelMap.set(key, label);
      }
    }
  }
  return { targets, targetSet, targetLabelMap, minTarget, maxTarget, range_bytes: range };
}

function addReversePointerObjectCandidates(candidates, bytes, pointerOffset, maxCandidates = MAX_SALT_KEY_CANDIDATES, directMaxDistance = REVERSE_POINTER_NEIGHBOR_BYTES) {
  const maxDistance = normalizeReversePointerDirectDistance(directMaxDistance);
  const distances = [0, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512]
    .filter(value => value <= maxDistance);
  for (const distance of distances) {
    addBinaryKeyCandidate(candidates, bytes, pointerOffset - 32 - distance, maxCandidates);
    if (candidates.size >= maxCandidates) return;
    addBinaryKeyCandidate(candidates, bytes, pointerOffset + 8 + distance, maxCandidates);
    if (candidates.size >= maxCandidates) return;
  }
}

async function addPointerTargetCandidates(api, handle, regions, target, candidates, maxCandidates = MAX_SALT_KEY_CANDIDATES) {
  const region = findRegionForAddress(regions, target);
  if (!region) return;
  const start = target > BigInt(POINTER_TARGET_NEIGHBOR_BYTES)
    ? target - BigInt(POINTER_TARGET_NEIGHBOR_BYTES)
    : target;
  const end = target + BigInt(POINTER_TARGET_NEIGHBOR_BYTES + 32);
  const safeStart = start < region.base ? region.base : start;
  const safeEnd = end > region.base + region.size ? region.base + region.size : end;
  const len = Number(safeEnd - safeStart);
  if (len < 32 || len > 4096) return;
  const buf = Buffer.allocUnsafe(len);
  const readOut = [0n];
  const ok = api.ReadProcessMemory(handle, safeStart, buf, BigInt(len), readOut);
  const read = Number(readOut[0] || 0n);
  if (!ok || read < 32) return;
  addSaltNeighborCandidates(candidates, buf.subarray(0, read), Number(target - safeStart), 0, POINTER_TARGET_NEIGHBOR_BYTES, maxCandidates);
}

async function addAnchorPointerTargetCandidates(api, handle, regions, target, candidates, maxCandidates = MAX_SALT_KEY_CANDIDATES) {
  const region = findRegionForAddress(regions, target);
  if (!region) return;
  const start = target > BigInt(POINTER_TARGET_NEIGHBOR_BYTES)
    ? target - BigInt(POINTER_TARGET_NEIGHBOR_BYTES)
    : target;
  const end = target + BigInt(POINTER_TARGET_NEIGHBOR_BYTES + 32);
  const safeStart = start < region.base ? region.base : start;
  const safeEnd = end > region.base + region.size ? region.base + region.size : end;
  const len = Number(safeEnd - safeStart);
  if (len < 32 || len > 4096) return;
  const buf = Buffer.allocUnsafe(len);
  const readOut = [0n];
  const ok = api.ReadProcessMemory(handle, safeStart, buf, BigInt(len), readOut);
  const read = Number(readOut[0] || 0n);
  if (!ok || read < 32) return;
  const local = Number(target - safeStart);
  for (const pos of [local - 64, local - 40, local - 32, local, local + 8, local + 16, local + 32, local + 64]) {
    addBinaryKeyCandidate(candidates, buf.subarray(0, read), pos, maxCandidates);
    if (candidates.size >= maxCandidates) return;
  }
}

function readSqlCipherCodecContextCandidate(bytes, pos) {
  if (pos < 0 || pos + 128 > bytes.length) return null;
  const storePass = bytes.readInt32LE(pos);
  const kdfIter = bytes.readInt32LE(pos + 4);
  const fastKdfIter = bytes.readInt32LE(pos + 8);
  const kdfSaltSz = bytes.readInt32LE(pos + 12);
  const keySz = bytes.readInt32LE(pos + 16);
  const ivSz = bytes.readInt32LE(pos + 20);
  const blockSz = bytes.readInt32LE(pos + 24);
  const pageSz = bytes.readInt32LE(pos + 28);
  const reserveSz = bytes.readInt32LE(pos + 32);
  const hmacSz = bytes.readInt32LE(pos + 36);
  const plaintextHeaderSz = bytes.readInt32LE(pos + 40);
  const hmacAlgorithm = bytes.readInt32LE(pos + 44);
  const kdfAlgorithm = bytes.readInt32LE(pos + 48);
  const error = bytes.readInt32LE(pos + 52);
  const flags = bytes.readUInt32LE(pos + 56);
  if (storePass < 0 || storePass > 4) return null;
  if (![64000, 256000].includes(kdfIter)) return null;
  if (fastKdfIter !== 2) return null;
  if (kdfSaltSz !== 16 || keySz !== 32 || ivSz !== 16 || blockSz !== 16) return null;
  if (![1024, 4096].includes(pageSz)) return null;
  if (![48, 80].includes(reserveSz)) return null;
  if (![20, 32, 64].includes(hmacSz)) return null;
  if (plaintextHeaderSz < 0 || plaintextHeaderSz > pageSz) return null;
  if (hmacAlgorithm < 0 || hmacAlgorithm > 32 || kdfAlgorithm < 0 || kdfAlgorithm > 32) return null;
  if (error < 0 || error > 1024) return null;
  if ((flags & 0xffff0000) !== 0) return null;
  const kdfSalt = bytes.readBigUInt64LE(pos + 64);
  const hmacKdfSalt = bytes.readBigUInt64LE(pos + 72);
  const readCtx = bytes.readBigUInt64LE(pos + 96);
  const writeCtx = bytes.readBigUInt64LE(pos + 104);
  const provider = bytes.readBigUInt64LE(pos + 112);
  if (!looksLikeUserPointer(kdfSalt) || !looksLikeUserPointer(hmacKdfSalt)) return null;
  if (!looksLikeUserPointer(readCtx) || !looksLikeUserPointer(writeCtx)) return null;
  if (provider !== 0n && !looksLikeUserPointer(provider)) return null;
  return {
    kdf_salt: kdfSalt,
    hmac_kdf_salt: hmacKdfSalt,
    read_ctx: readCtx,
    write_ctx: writeCtx,
  };
}

function addCodecCipherContextCandidates(api, handle, regions, address, saltHex, candidates, maxCandidates) {
  const stats = {
    pass_read_count: 0,
    pass_candidate_count: 0,
    key_pointer_read_count: 0,
    key_pointer_candidate_count: 0,
  };
  const ctx = readProcessBytes(api, handle, regions, address, 32);
  if (!ctx || ctx.length < 32) return stats;
  const deriveKey = ctx.readInt32LE(0);
  const passSz = ctx.readInt32LE(4);
  const keyPtr = ctx.readBigUInt64LE(8);
  const hmacPtr = ctx.readBigUInt64LE(16);
  const passPtr = ctx.readBigUInt64LE(24);
  if (![0, 1].includes(deriveKey)) return stats;
  if (passSz > 0 && passSz <= 256 && looksLikeUserPointer(passPtr)) {
    const pass = readProcessBytes(api, handle, regions, passPtr, passSz);
    if (pass?.length === passSz) {
      stats.pass_read_count++;
      stats.pass_candidate_count += addCodecPassCandidates(candidates, pass, saltHex, maxCandidates);
    }
  }
  const key = looksLikeUserPointer(keyPtr) ? readProcessBytes(api, handle, regions, keyPtr, 32) : null;
  const hmac = looksLikeUserPointer(hmacPtr) ? readProcessBytes(api, handle, regions, hmacPtr, 32) : null;
  if (key?.length === 32) {
    stats.key_pointer_read_count++;
    const before = candidates.size;
    if (!looksLowEntropy(key)) {
      const keyHex = key.toString('hex');
      addRawStringCandidate(candidates, keyHex, maxCandidates);
      addRawStringCandidate(candidates, `${keyHex}${saltHex}`, maxCandidates);
      if (hmac?.length === 32 && !looksLowEntropy(hmac)) {
        addRawStringCandidate(candidates, `${keyHex}${hmac.toString('hex')}${saltHex}`, maxCandidates);
      }
    }
    stats.key_pointer_candidate_count += Math.max(0, candidates.size - before);
  }
  return stats;
}

function addCodecPassCandidates(candidates, pass, saltHex, maxCandidates) {
  const before = candidates.size;
  for (const raw of findRawKeyCandidates(pass)) addRawStringCandidate(candidates, raw, maxCandidates);
  if ([32, 48, 64, 80].includes(pass.length) && !looksLowEntropy(pass.subarray(0, Math.min(32, pass.length)))) {
    const hex = pass.toString('hex');
    if (pass.length === 32) {
      addRawStringCandidate(candidates, hex, maxCandidates);
      addRawStringCandidate(candidates, `${hex}${saltHex}`, maxCandidates);
    } else if (pass.length === 48 || pass.length === 64 || pass.length === 80) {
      addRawStringCandidate(candidates, hex, maxCandidates);
      if (pass.length === 64) addRawStringCandidate(candidates, `${hex}${saltHex}`, maxCandidates);
    }
  }
  return Math.max(0, candidates.size - before);
}

function normalizeVerifiedDbPages(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const page = Buffer.isBuffer(value) ? value : Buffer.isBuffer(value?.page) ? value.page : null;
    if (!page || page.length < 4096) continue;
    const page1 = page.subarray(0, 4096);
    const salt = page1.subarray(0, 16).toString('hex');
    if (!/^[a-f0-9]{32}$/.test(salt) || seen.has(salt)) continue;
    seen.add(salt);
    out.push({ salt, page: page1 });
  }
  return out;
}

function addVerifiedWeixinV4RawKeyMatches(found, matchedSalts, seenHex, text, pages, options = {}) {
  const re = /x'([a-fA-F0-9]{64,192})'/g;
  let match;
  let hexPatternCount = 0;
  while ((match = re.exec(text))) {
    const hex = String(match[1] || '').toLowerCase();
    if (hex.length % 2 !== 0 || seenHex.has(hex)) continue;
    seenHex.add(hex);
    hexPatternCount++;
    verifyWeixinV4KeyHexAgainstPages(found, matchedSalts, hex, pages);
  }
  if (options.includeBareHex === true) {
    for (const size of [160, 128, 96, 64]) {
      hexPatternCount += addVerifiedBareWeixinV4HexMatches(found, matchedSalts, seenHex, text, pages, size);
    }
    if (text.includes('\0')) {
      const compact = text.replace(/\0/g, '');
      for (const size of [160, 128, 96, 64]) {
        hexPatternCount += addVerifiedBareWeixinV4HexMatches(found, matchedSalts, seenHex, compact, pages, size);
      }
    }
  }
  return { hex_pattern_count: hexPatternCount };
}

function addVerifiedBareWeixinV4HexMatches(found, matchedSalts, seenHex, text, pages, size) {
  const re = new RegExp(`[a-fA-F0-9]{${size}}`, 'g');
  let match;
  let count = 0;
  while ((match = re.exec(text))) {
    const start = match.index;
    const end = start + size;
    const before = start > 0 ? text.charCodeAt(start - 1) : 0;
    const after = end < text.length ? text.charCodeAt(end) : 0;
    if (isHexCode(before) || isHexCode(after)) continue;
    const hex = match[0].toLowerCase();
    if (seenHex.has(hex)) continue;
    seenHex.add(hex);
    count++;
    verifyWeixinV4KeyHexAgainstPages(found, matchedSalts, hex, pages);
    if (matchedSalts.size >= pages.length) break;
  }
  return count;
}

function verifyWeixinV4KeyHexAgainstPages(found, matchedSalts, hex, pages) {
  for (const keyHex of verifiedWeixinV4KeyHexCandidates(hex)) {
    if (!/^[a-f0-9]{64}$/.test(keyHex)) continue;
    const key = Buffer.from(keyHex, 'hex');
    for (const item of pages) {
      if (matchedSalts.has(item.salt)) continue;
      if (!verifyWeixinV4EncKeyForPage(key, item.page)) continue;
      matchedSalts.add(item.salt);
      addRawStringCandidate(found, keyHex, MAX_SALT_KEY_CANDIDATES_HARD_LIMIT);
      addRawStringCandidate(found, `${keyHex}${item.salt}`, MAX_SALT_KEY_CANDIDATES_HARD_LIMIT);
    }
  }
}

function verifiedWeixinV4KeyHexCandidates(hex) {
  const candidates = [];
  const add = (value) => {
    if (/^[a-f0-9]{64}$/.test(value) && !candidates.includes(value)) candidates.push(value);
  };
  if (hex.length === 64) {
    add(hex);
  } else if (hex.length >= 96) {
    add(hex.slice(0, 64));
    if (hex.length >= 128) add(hex.slice(64, 128));
  }
  return candidates;
}

function verifyWeixinV4EncKeyForPage(encKey, page) {
  if (!Buffer.isBuffer(encKey) || encKey.length !== 32 || !Buffer.isBuffer(page) || page.length < 4096) return false;
  const salt = page.subarray(0, 16);
  const macSalt = Buffer.from(salt.map(byte => byte ^ 0x3a));
  const macKey = crypto.pbkdf2Sync(encKey, macSalt, 2, 32, 'sha512');
  const hmac = crypto.createHmac('sha512', macKey);
  hmac.update(page.subarray(16, 4096 - 80 + 16));
  const pageNo = Buffer.alloc(4);
  pageNo.writeUInt32LE(1, 0);
  hmac.update(pageNo);
  const digest = hmac.digest();
  const stored = page.subarray(4096 - 64, 4096);
  return stored.length === digest.length && crypto.timingSafeEqual(digest, stored);
}

function findRegionForAddress(regions, address) {
  return regions.find(region => address >= region.base && address < region.base + region.size) || null;
}

function readProcessBytes(api, handle, regions, address, length) {
  if (!looksLikeUserAddress(address) || !Number.isFinite(length) || length <= 0 || length > 4096) return null;
  const region = findRegionForAddress(regions, address);
  if (!region || address + BigInt(length) > region.base + region.size) return null;
  const buf = Buffer.allocUnsafe(length);
  const readOut = [0n];
  const ok = api.ReadProcessMemory(handle, address, buf, BigInt(length), readOut);
  const read = Number(readOut[0] || 0n);
  if (!ok || read < length) return null;
  return buf.subarray(0, read);
}

function addRawStringCandidate(candidates, raw, maxCandidates = MAX_SALT_KEY_CANDIDATES) {
  if (candidates.size >= maxCandidates) return false;
  const text = String(raw || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}(?:[a-f0-9]{32}|[a-f0-9]{64}|[a-f0-9]{96})?$/.test(text)) return false;
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  if (candidates.has(hash)) return false;
  candidates.set(hash, { raw: text, hash });
  return true;
}

function addWeixinV4PatternPointerCandidates(candidates, bytes, api, handle, readRegions, maxCandidates = MAX_RAW_KEY_CANDIDATES) {
  let hitCount = 0;
  let candidateCount = 0;
  let pos = bytes.lastIndexOf(WEIXIN_V4_KEY_POINTER_PATTERN);
  while (pos >= 8) {
    hitCount++;
    if (candidates.size < maxCandidates) {
      const address = bytes.readBigUInt64LE(pos - 8);
      if (looksLikeUserAddress(address)) {
        const key = readProcessBytes(api, handle, readRegions, address, 32);
        if (key?.length === 32 && addWeixinV4PointerKeyCandidate(candidates, key, maxCandidates)) {
          candidateCount++;
        }
      }
    }
    pos = bytes.lastIndexOf(WEIXIN_V4_KEY_POINTER_PATTERN, pos - 1);
  }
  return { hit_count: hitCount, candidate_count: candidateCount };
}

function addWeixinV4PointerKeyCandidate(candidates, key, maxCandidates = MAX_RAW_KEY_CANDIDATES) {
  if (candidates.size >= maxCandidates || !Buffer.isBuffer(key) || key.length !== 32) return false;
  if (looksStructuredV4PointerKey(key)) return false;
  return addRawStringCandidate(candidates, key.toString('hex'), maxCandidates);
}

function looksStructuredV4PointerKey(buffer) {
  const unique = new Set(buffer).size;
  if (unique <= 2) return true;
  let zero = 0;
  for (const byte of buffer) if (byte === 0) zero++;
  return zero >= 16;
}

function addBinaryKeyCandidate(candidates, bytes, pos, maxCandidates = MAX_SALT_KEY_CANDIDATES) {
  if (candidates.size >= maxCandidates) return false;
  if (pos < 0 || pos + 32 > bytes.length) return false;
  const key = bytes.subarray(pos, pos + 32);
  if (looksLowEntropy(key)) return false;
  const raw = key.toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  let added = false;
  if (!candidates.has(hash)) {
    candidates.set(hash, { raw, hash });
    added = true;
  }
  if (pos + 64 <= bytes.length && candidates.size < maxCandidates) {
    const hmacKey = bytes.subarray(pos + 32, pos + 64);
    if (!looksLowEntropy(hmacKey)) {
      added = addRawStringCandidate(candidates, bytes.subarray(pos, pos + 64).toString('hex'), maxCandidates) || added;
      if (pos + 80 <= bytes.length && candidates.size < maxCandidates) {
        added = addRawStringCandidate(candidates, bytes.subarray(pos, pos + 80).toString('hex'), maxCandidates) || added;
      }
    }
  }
  return added;
}

function normalizeMaxSaltCandidates(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return MAX_SALT_KEY_CANDIDATES;
  return Math.max(1, Math.min(Math.floor(n), MAX_SALT_KEY_CANDIDATES_HARD_LIMIT));
}

function normalizeAnchorDirectCandidateLimit(value, maxCandidates, reversePointerScan = false) {
  const cap = Math.max(1, Math.min(Number(maxCandidates || MAX_SALT_KEY_CANDIDATES), MAX_SALT_KEY_CANDIDATES_HARD_LIMIT));
  const n = Number(value || 0);
  if (Number.isFinite(n) && n > 0) return Math.max(1, Math.min(Math.floor(n), cap));
  return reversePointerScan ? Math.min(512, cap) : cap;
}

function normalizeMaxReversePointerHits(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return MAX_REVERSE_POINTER_HITS;
  return Math.max(1, Math.min(Math.floor(n), MAX_REVERSE_POINTER_HITS));
}

function normalizePointerTargetRangeBytes(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(n), 256));
}

function normalizeReversePointerDirectDistance(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return REVERSE_POINTER_NEIGHBOR_BYTES;
  return Math.max(0, Math.min(Math.floor(n), REVERSE_POINTER_NEIGHBOR_BYTES));
}

function looksLikeUserPointer(value) {
  return looksLikeUserAddress(value) && value % 8n === 0n;
}

function looksLikeUserAddress(value) {
  return value >= 0x10000n && value <= 0x00007ffffffffffen;
}

function looksLowEntropy(buffer) {
  const unique = new Set(buffer).size;
  if (unique <= 4) return true;
  let zero = 0;
  let printable = 0;
  for (const byte of buffer) {
    if (byte === 0) zero++;
    if (byte >= 0x20 && byte <= 0x7e) printable++;
  }
  // A random 32-byte SQLCipher key almost never contains this many NUL bytes.
  // Rejecting sparse structured memory keeps anchor scans from being flooded by
  // UTF-16 strings, pointer tables and zero-padded structs near common labels.
  if (zero >= 8) return true;
  return printable >= 30;
}

function addValidatedImageKey(candidates, raw, validationSamples) {
  if (!raw || raw.length < 16) return;
  const key = Buffer.from(raw.slice(0, 16), 'ascii');
  const requiredMatches = validationSamples.length > 1 ? 2 : 1;
  if (validationSamples.length && imageKeyValidationCount(key, validationSamples) < requiredMatches) return;
  const keyHex = key.toString('hex');
  const hash = crypto.createHash('sha256').update(keyHex).digest('hex');
  if (!candidates.has(hash)) candidates.set(hash, { raw: keyHex, hash });
}

function scanAsciiImageKeyStrings(bytes) {
  const out = [];
  for (let i = 0; i <= bytes.length - 16; i++) {
    if (!isKeyChar(bytes[i])) continue;
    let len = 1;
    while (i + len < bytes.length && isKeyChar(bytes[i + len]) && len < 64) len++;
    const before = i > 0 ? bytes[i - 1] : 0;
    const after = i + len < bytes.length ? bytes[i + len] : 0;
    if (!isKeyChar(before) && !isKeyChar(after) && len >= 16) {
      const run = bytes.subarray(i, i + len).toString('ascii');
      out.push(...keyWindows(run));
    }
    i += Math.max(0, len - 1);
  }
  return out;
}

function scanUtf16LeImageKeyStrings(bytes) {
  const out = [];
  for (let i = 0; i <= bytes.length - 32; i++) {
    if (!isKeyChar(bytes[i]) || bytes[i + 1] !== 0) continue;
    let chars = '';
    let pos = i;
    while (pos + 1 < bytes.length && isKeyChar(bytes[pos]) && bytes[pos + 1] === 0 && chars.length < 64) {
      chars += String.fromCharCode(bytes[pos]);
      pos += 2;
    }
    const before = i >= 2 ? bytes[i - 2] : 0;
    const beforeNull = i >= 1 ? bytes[i - 1] : 1;
    const after = pos < bytes.length ? bytes[pos] : 0;
    const afterNull = pos + 1 < bytes.length ? bytes[pos + 1] : 1;
    if (!(isKeyChar(before) && beforeNull === 0) && !(isKeyChar(after) && afterNull === 0) && chars.length >= 16) {
      out.push(...keyWindows(chars));
    }
    i = Math.max(i, pos - 1);
  }
  return out;
}

function keyWindows(text) {
  const out = [];
  const value = String(text || '');
  for (const size of [16, 32]) {
    if (value.length < size) continue;
    if (value.length > 256) continue;
    for (let i = 0; i <= value.length - size; i++) out.push(value.slice(i, i + size));
  }
  return out;
}

function isKeyChar(byte) {
  return (byte >= 0x30 && byte <= 0x39)
    || (byte >= 0x41 && byte <= 0x5a)
    || (byte >= 0x61 && byte <= 0x7a)
    || byte === 0x5f
    || byte === 0x2d;
}

function minBigInt(...values) {
  return values.reduce((min, value) => value < min ? value : min);
}

export const WXKEY_SAFE_ACCESS_MASK = SAFE_ACCESS;
