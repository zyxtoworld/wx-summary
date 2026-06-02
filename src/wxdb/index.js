import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { TMP_DIR, isInside } from '../lib/paths.js';
import { ensureDir } from '../lib/json-store.js';
import { discoverWxAccounts, getWeixinModuleEvidence, getWeixinProcesses, listDbFiles, pickAccount } from '../wxenv/discovery.js';
import { probeWxKey, scanProcessForVerifiedWeixinV4DbKeys } from '../wxkey/index.js';
import { extractPlainImage, validateImageKeyCandidate, weChatV4ValidationSample } from './image-dat.js';
import { decodeWxgfToImage, extractVideoFrameToImage, transcodeAudioToWav } from './wxgf.js';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');
let SqlCipherDatabase = null;
let sqlcipherLoggerSet = false;
let imageKeyCache = { at: 0, sampleHash: '', keys: [] };
const IMAGE_KEY_CACHE_MS = 10 * 60 * 1000;
const LOCAL_IMAGE_INDEX_MAX_ENTRIES = 50000;
const LOCAL_IMAGE_INDEX_MAX_MS = 5000;
const LOCAL_VOICE_INDEX_MAX_ENTRIES = 20000;
const LOCAL_VOICE_INDEX_MAX_MS = 3000;
const IMAGE_KEY_SCAN_MAX_MS = 12000;
const IMAGE_KEY_WIDE_SCAN_MAX_MS = 15000;
const VOICE_FILE_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.webm', '.flac', '.amr', '.silk', '.aud', '.dat'];
const PINYIN_ANCHORS = Array.from('阿八嚓哒妸发旮哈讥咔垃妈拿噢啪期然撒塌挖昔压匝');
const PINYIN_INITIALS = Array.from('ABCDEFGHJKLMNOPQRSTWXYZ');
const SQLCIPHER_PROFILE_FALLBACK_MAX_KEYS = 2048;
const WEIXIN_V4_PAGE_SIZE = 4096;
const WEIXIN_V4_KEY_BYTES = 32;
const WEIXIN_V4_SALT_BYTES = 16;
const WEIXIN_V4_IV_BYTES = 16;
const WEIXIN_V4_HMAC_BYTES = 64;
const WEIXIN_V4_RESERVED_BYTES = 80;
const WEIXIN_V4_KDF_ITER = 256000;
const WEIXIN_V4_MANUAL_PROFILE = { id: 'weixin_v4_page_hmac_sha512' };
const SQLCIPHER_KEY_PROFILES = [
  { id: 'default', before_key: [], after_key: [] },
  { id: 'compat3', before_key: ['cipher_compatibility = 3'], after_key: [] },
  { id: 'compat4', before_key: ['cipher_compatibility = 4'], after_key: [] },
  {
    id: 'wcdb_legacy_sha1_page4096',
    before_key: [],
    after_key: [
      'cipher_page_size = 4096',
      'kdf_iter = 64000',
      'cipher_hmac_algorithm = HMAC_SHA1',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA1',
    ],
  },
  {
    id: 'sqlcipher4_sha512_page4096',
    before_key: [],
    after_key: [
      'cipher_page_size = 4096',
      'kdf_iter = 256000',
      'cipher_hmac_algorithm = HMAC_SHA512',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA512',
    ],
  },
  {
    id: 'wcdb_sha256_page4096',
    fallback_key_limit: 512,
    before_key: [],
    after_key: [
      'cipher_page_size = 4096',
      'kdf_iter = 64000',
      'cipher_hmac_algorithm = HMAC_SHA256',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA256',
    ],
  },
  {
    id: 'sqlcipher4_sha256_page4096',
    fallback_key_limit: 512,
    before_key: [],
    after_key: [
      'cipher_page_size = 4096',
      'kdf_iter = 256000',
      'cipher_hmac_algorithm = HMAC_SHA256',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA256',
    ],
  },
  {
    id: 'wcdb_legacy_sha1_no_hmac_page4096',
    fallback_key_limit: 512,
    before_key: [],
    after_key: [
      'cipher_page_size = 4096',
      'kdf_iter = 64000',
      'cipher_use_hmac = OFF',
      'cipher_hmac_algorithm = HMAC_SHA1',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA1',
    ],
  },
  {
    id: 'wcdb_sha256_no_hmac_page4096',
    fallback_key_limit: 256,
    before_key: [],
    after_key: [
      'cipher_page_size = 4096',
      'kdf_iter = 64000',
      'cipher_use_hmac = OFF',
      'cipher_hmac_algorithm = HMAC_SHA256',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA256',
    ],
  },
  {
    id: 'sqlcipher3_sha1_page1024',
    before_key: [],
    after_key: [
      'cipher_page_size = 1024',
      'kdf_iter = 64000',
      'cipher_hmac_algorithm = HMAC_SHA1',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA1',
    ],
  },
];

function abortError() {
  return Object.assign(new Error('请求已取消'), { status: 499 });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

export async function probeWxDb(input = '') {
  const accountId = typeof input === 'string' ? input : (input?.account_id || '');
  const rawKeys = typeof input === 'object' && Array.isArray(input.raw_keys) ? input.raw_keys : [];
  const deepScan = typeof input === 'object' && input.deep_scan === true;
  const accounts = await discoverWxAccounts();
  const account = pickAccount(accounts, accountId);
  if (!account) {
    return {
      ok: false,
      stage: 'discover',
      reason: '未发现微信 v4 db_storage 数据目录。',
      accounts: [],
    };
  }

  const files = await listDbFiles(account);
  const session = files.find(f => f.category === 'session' && f.name === 'session.db');
  const message = files.find(f => f.category === 'message' && /^message_\d+\.db$/i.test(f.name));
  const contact = files.find(f => f.category === 'contact' && f.name === 'contact.db');
  const probeFiles = probeDbFiles([contact, session, message, files[0]]);
  const moduleEvidence = deepScan
    ? await getWeixinModuleEvidence().catch(() => null)
    : null;
  let copy = null;
  const dbChecks = [];
  for (const sample of probeFiles) {
    let validation = null;
    let deepScanResult = null;
    copy = await copyDbFile(account, sample);
    if (rawKeys.length) {
      validation = await validateCopiedDbWithRawKeys(copy.target_path, rawKeys);
    }
    if (deepScan && !validation?.ok) {
      const dbSalt = (await readHeader(copy.target_path)).toString('hex');
      const moduleAnchors = moduleStringAddressTargets(moduleEvidence, sample);
      const saltProbe = await probeWxKey({
        scan_all_processes: true,
        scan_db_salts: [dbSalt],
        scan_memory_anchors: dbMemoryAnchors(account, sample),
        scan_anchor_addresses: moduleAnchors.targets,
        scan_codec_salts: [dbSalt],
        include_db_raw: true,
        include_anchor_raw: true,
        include_anchor_address_raw: true,
        include_codec_raw: true,
        db_scan_max_bytes: 1024 * 1024 * 1024,
        db_scan_max_region_bytes: 96 * 1024 * 1024,
        db_scan_max_candidates: 16384,
        db_reverse_pointer_scan: true,
        db_reverse_pointer_max_bytes: 512 * 1024 * 1024,
        db_reverse_pointer_max_hits: 1024,
        anchor_scan_max_bytes: 1024 * 1024 * 1024,
        anchor_scan_max_region_bytes: 96 * 1024 * 1024,
        anchor_scan_max_candidates: 16384,
        anchor_direct_max_candidates: 512,
        anchor_follow_local_pointers: false,
        anchor_reverse_pointer_scan: true,
        anchor_reverse_pointer_max_bytes: 512 * 1024 * 1024,
        anchor_reverse_pointer_max_hits: 1024,
        anchor_address_scan_max_bytes: 512 * 1024 * 1024,
        anchor_address_scan_max_candidates: 16384,
        anchor_address_reverse_pointer_max_hits: 1024,
        anchor_address_target_range_bytes: moduleAnchors.function_target_count > 0 ? 256 : 96,
        anchor_address_reverse_pointer_direct_max_distance: 64,
        anchor_address_reverse_pointer_layout_sample: true,
        anchor_address_reverse_pointer_high_entropy_targets: true,
        anchor_address_second_hop_reverse_pointers: moduleAnchors.function_target_count > 0,
        codec_scan_max_bytes: 1024 * 1024 * 1024,
        codec_scan_max_region_bytes: 96 * 1024 * 1024,
        codec_scan_max_candidates: 4096,
      });
      const saltCandidates = Array.isArray(saltProbe._raw_db_salt_candidates) ? saltProbe._raw_db_salt_candidates : [];
      const anchorCandidates = Array.isArray(saltProbe._raw_anchor_candidates) ? saltProbe._raw_anchor_candidates : [];
      const anchorAddressCandidates = Array.isArray(saltProbe._raw_anchor_address_candidates) ? saltProbe._raw_anchor_address_candidates : [];
      const codecCandidates = Array.isArray(saltProbe._raw_codec_candidates) ? saltProbe._raw_codec_candidates : [];
      deepScanResult = {
        source_category: sample.category,
        source_name: sample.name,
        salt_hit_count: Number(saltProbe.db_salt_hit_count || 0),
        unique_candidate_count: Number(saltProbe.db_salt_unique_candidate_count || 0),
        scanned_bytes: Number(saltProbe.db_salt_scanned_bytes || 0),
        region_count: Number(saltProbe.db_salt_region_count || 0),
        reverse_pointer_hit_count: Number(saltProbe.db_salt_reverse_pointer_hit_count || 0),
        reverse_pointer_scanned_bytes: Number(saltProbe.db_salt_reverse_pointer_scanned_bytes || 0),
        scan_mode: saltProbe.db_salt_scan_mode || null,
        scan_processes: Array.isArray(saltProbe.db_salt_scan_processes) ? saltProbe.db_salt_scan_processes : [],
        anchor_hit_count: Number(saltProbe.anchor_hit_count || 0),
        anchor_unique_candidate_count: Number(saltProbe.anchor_unique_candidate_count || 0),
        anchor_direct_candidate_count: Number(saltProbe.anchor_scan_processes?.reduce?.((sum, p) => sum + Number(p.anchor_direct_candidate_count || 0), 0) || 0),
        anchor_reference_address_count: Number(saltProbe.anchor_scan_processes?.reduce?.((sum, p) => sum + Number(p.anchor_reference_address_count || 0), 0) || 0),
        anchor_scanned_bytes: Number(saltProbe.anchor_scanned_bytes || 0),
        anchor_region_count: Number(saltProbe.anchor_region_count || 0),
        anchor_reverse_pointer_hit_count: Number(saltProbe.anchor_reverse_pointer_hit_count || 0),
        anchor_reverse_pointer_scanned_bytes: Number(saltProbe.anchor_reverse_pointer_scanned_bytes || 0),
        anchor_scan_mode: saltProbe.anchor_scan_mode || null,
        anchor_scan_processes: Array.isArray(saltProbe.anchor_scan_processes) ? saltProbe.anchor_scan_processes : [],
        module_anchor_address_target_count: Number(saltProbe.anchor_address_target_count || 0),
        module_anchor_function_target_count: moduleAnchors.function_target_count || 0,
        module_anchor_address_patterns: moduleAnchors.pattern_counts,
        module_anchor_address_sections: moduleAnchors.section_counts,
        module_anchor_address_modules: moduleAnchors.module_counts,
        module_anchor_address_sources: moduleAnchors.source_counts,
        module_anchor_address_unique_candidate_count: Number(saltProbe.anchor_address_unique_candidate_count || 0),
        module_anchor_address_reverse_pointer_hit_count: Number(saltProbe.anchor_address_reverse_pointer_hit_count || 0),
        module_anchor_address_reverse_pointer_direct_candidate_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_direct_candidate_count || 0), 0) || 0),
        module_anchor_address_reverse_pointer_deferred_target_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_deferred_target_count || 0), 0) || 0),
        module_anchor_address_reverse_pointer_followed_target_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_followed_target_count || 0), 0) || 0),
        module_anchor_address_reverse_pointer_high_entropy_target_read_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_high_entropy_target_read_count || 0), 0) || 0),
        module_anchor_address_reverse_pointer_high_entropy_candidate_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_high_entropy_candidate_count || 0), 0) || 0),
        module_anchor_address_reverse_pointer_high_entropy_window_candidate_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_high_entropy_window_candidate_count || 0), 0) || 0),
        module_anchor_address_reverse_pointer_high_entropy_pointer_table_read_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_high_entropy_pointer_table_read_count || 0), 0) || 0),
        module_anchor_address_reverse_pointer_high_entropy_pointer_table_candidate_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_high_entropy_pointer_table_candidate_count || 0), 0) || 0),
        module_anchor_address_reverse_pointer_crypto_object_sweep_candidate_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_crypto_object_sweep_candidate_count || 0), 0) || 0),
        module_anchor_address_reverse_pointer_second_hop_target_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_second_hop_target_count || 0), 0) || 0),
        module_anchor_address_reverse_pointer_second_hop_hit_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_second_hop_hit_count || 0), 0) || 0),
        module_anchor_address_reverse_pointer_second_hop_candidate_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_second_hop_candidate_count || 0), 0) || 0),
        module_anchor_address_reverse_pointer_layout_summary: summarizeReversePointerLayouts(saltProbe.anchor_address_scan_processes),
        module_anchor_address_scanned_bytes: Number(saltProbe.anchor_address_scanned_bytes || 0),
        module_anchor_address_region_count: Number(saltProbe.anchor_address_region_count || 0),
        module_anchor_address_scan_mode: saltProbe.anchor_address_scan_mode || null,
        module_anchor_address_scan_processes: Array.isArray(saltProbe.anchor_address_scan_processes) ? saltProbe.anchor_address_scan_processes : [],
        codec_context_hit_count: Number(saltProbe.codec_context_hit_count || 0),
        codec_context_salt_match_count: Number(saltProbe.codec_context_salt_match_count || 0),
        codec_context_unique_candidate_count: Number(saltProbe.codec_context_unique_candidate_count || 0),
        codec_context_pass_candidate_count: Number(saltProbe.codec_context_scan_processes?.reduce?.((sum, p) => sum + Number(p.codec_pass_candidate_count || 0), 0) || 0),
        codec_context_key_pointer_candidate_count: Number(saltProbe.codec_context_scan_processes?.reduce?.((sum, p) => sum + Number(p.codec_key_pointer_candidate_count || 0), 0) || 0),
        codec_context_scanned_bytes: Number(saltProbe.codec_context_scanned_bytes || 0),
        codec_context_region_count: Number(saltProbe.codec_context_region_count || 0),
        codec_context_scan_mode: saltProbe.codec_context_scan_mode || null,
        codec_context_scan_processes: Array.isArray(saltProbe.codec_context_scan_processes) ? saltProbe.codec_context_scan_processes : [],
      };
      delete saltProbe._raw_db_salt_candidates;
      delete saltProbe._raw_anchor_candidates;
      delete saltProbe._raw_anchor_address_candidates;
      delete saltProbe._raw_codec_candidates;
      if (saltCandidates.length || anchorCandidates.length || anchorAddressCandidates.length || codecCandidates.length) {
        validation = await validateCopiedDbWithRawKeys(copy.target_path, [...rawKeys, ...saltCandidates, ...anchorCandidates, ...anchorAddressCandidates, ...codecCandidates]);
      }
    }
    const tempRoot = path.dirname(path.dirname(copy.target_path));
    await removeCopiedDb(copy.target_path);
    copy.temp_removed = true;
    delete copy.target_path;
    dbChecks.push({
      source_category: sample.category,
      source_name: sample.name,
      sample_copy: copy,
      decrypted: !!validation?.ok,
      validation,
      deep_scan: deepScanResult,
    });
    if (validation?.ok && !deepScan) break;
  }

  const decrypted = dbChecks.some(check => check.decrypted);
  const firstCheck = dbChecks[0] || {};
  return {
    ok: true,
    stage: 'copied',
    decrypted,
    account: redactAccount(account),
    db_count: files.length,
    categories: account.summary.categories,
    sample_copy: firstCheck.sample_copy || null,
    validation: firstCheck.validation || null,
    deep_scan: firstCheck.deep_scan || null,
    db_checks: dbChecks,
    reason: decrypted
      ? '已用内存候选 key 成功验证 SQLCipher 数据库。'
      : '已能发现并只读复制微信 v4 数据库副本；SQLCipher 解密仍需有效 key 验证。',
  };
}

function probeDbFiles(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.path) continue;
    const key = item.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 3) break;
  }
  return out;
}

function dbMemoryAnchors(account, sample) {
  const category = String(sample?.category || '').trim();
  const name = String(sample?.name || path.basename(sample?.path || '')).trim();
  const relative = category && name ? `${category}/${name}` : '';
  const storageRelative = relative ? `db_storage/${relative}` : '';
  // WeChat 4.1.x appears to associate per-db keys with db_storage-relative
  // paths. Keep noisy full account paths out, but include stable relative forms.
  // The wxkey anchor scan caps direct-neighbor candidates so these longer
  // anchors mainly feed reverse-pointer object diagnostics.
  return uniqueStrings([
    name,
    relative,
    relative.replace(/\//g, '\\'),
    storageRelative,
    storageRelative.replace(/\//g, '\\'),
    'session.db',
    'contact.db',
    'hardlink.db',
  ]);
}

function moduleStringAddressTargets(moduleEvidence, sample) {
  const category = String(sample?.category || '').toLowerCase();
  const name = String(sample?.name || path.basename(sample?.path || '')).toLowerCase();
  const wanted = moduleAnchorPatternWeights(category, name);
  const items = [];
  for (const mod of moduleEvidence?.db_related_modules || []) {
    const moduleName = String(mod.name || '').toLowerCase();
    const moduleScore = moduleAnchorModuleWeight(moduleName);
    const addHit = (hit, source) => {
      const address = Number(hit.virtual_address || 0);
      if (!Number.isFinite(address) || address <= 0) return;
      const pattern = String(hit.pattern || '').toLowerCase();
      const patternScore = wanted.get(pattern) || 0;
      if (source === 'crypto' && !patternScore) return;
      if (source !== 'crypto' && !patternScore && moduleScore < 100) return;
      const section = String(hit.section || '').toLowerCase();
      items.push({
        address,
        pattern,
        module: moduleName,
        section,
        source,
        score: moduleScore
          + patternScore
          + moduleAnchorSectionWeight(section)
          + (hit.encoding === 'utf16le' ? 6 : 0)
          + (source === 'crypto' ? 4 : 0),
        rva: Number(hit.rva || 0),
      });
    };
    for (const hit of mod.db_string_address_hits || []) addHit(hit, 'db');
    for (const hit of mod.crypto_string_address_hits || []) addHit(hit, 'crypto');
  }
  items.push(...moduleFunctionAddressTargetItems(moduleEvidence));
  items.sort((a, b) => b.score - a.score || a.rva - b.rva || a.address - b.address);
  const targets = [];
  const seenTargets = new Set();
  const patternCounts = {};
  const sectionCounts = {};
  const moduleCounts = {};
  const sourceCounts = {};
  let functionTargetCount = 0;
  for (const item of items) {
    if (targets.length >= 256) break;
    const key = String(item.address);
    if (seenTargets.has(key)) continue;
    const cap = moduleAnchorPatternCap(item.pattern || 'unknown');
    if ((patternCounts[item.pattern || 'unknown'] || 0) >= cap) continue;
    seenTargets.add(key);
    targets.push({
      address: item.address,
      pattern: item.pattern || 'unknown',
      module: item.module || 'unknown',
      section: item.section || 'unknown',
      source: item.source || 'db',
    });
    incrementCounter(patternCounts, item.pattern || 'unknown');
    incrementCounter(sectionCounts, item.section || 'unknown');
    incrementCounter(moduleCounts, item.module || 'unknown');
    incrementCounter(sourceCounts, item.source || 'db');
    if (item.source === 'function') functionTargetCount++;
  }
  return {
    targets,
    pattern_counts: patternCounts,
    section_counts: sectionCounts,
    module_counts: moduleCounts,
    source_counts: sourceCounts,
    function_target_count: functionTargetCount,
  };
}

function moduleFunctionAddressTargetItems(moduleEvidence) {
  const items = [];
  const seen = new Set();
  for (const mod of moduleEvidence?.db_related_modules || []) {
    const moduleName = String(mod.name || '').toLowerCase();
    const moduleScore = moduleAnchorModuleWeight(moduleName);
    const baseAddress = Number(mod.base_address || 0);
    if (!baseAddress || moduleScore < 100) continue;
    const regions = mod.static_string_xref_summary?.function_summary?.priority_call_graph?.candidate_key_derivation_regions || [];
    for (const region of regions.slice(0, 12)) {
      const regionScore = Math.min(Number(region.priority_score || 0) / 24, 220);
      const paths = region.candidate_bridge_resolved_function_paths || [];
      for (const bridge of paths.slice(0, 6)) {
        const pattern = bridgeFunctionTargetPattern(bridge, region);
        const continuityScore = bridge.is_fully_function_continuous ? 60 : Number(bridge.continuous_function_hop_count || 0) * 20;
        for (const bucket of uniqueStrings([
          ...(bridge.path_function_buckets || []),
          ...(bridge.source_function_buckets || []),
          ...(bridge.target_function_buckets || []),
        ]).slice(0, 12)) {
          const rva = parseHexNumber(bucket);
          if (!rva) continue;
          const key = `${moduleName}:${rva}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({
            address: baseAddress + rva,
            pattern,
            module: moduleName,
            section: '.text',
            source: 'function',
            score: moduleScore + 180 + regionScore + continuityScore + bridgeFunctionPatternScore(bridge),
            rva,
          });
          if (items.length >= 96) return items;
        }
      }
    }
  }
  return items;
}

function bridgeFunctionTargetPattern(bridge, region) {
  const text = [
    ...(bridge?.terminal_patterns || []),
    ...(region?.target_patterns || []),
    ...(bridge?.path_function_xref_summary?.target_patterns || []),
  ].join(' ').toLowerCase();
  if (/sqlcipher|cipher|wcdb|sqlite3_key|pbkdf|kdf/.test(text)) return 'function_bridge_sqlcipher';
  if (/hkdf|hmac|sha256|evp/.test(text)) return 'function_bridge_hmac_sha256';
  if (/aes|sha1/.test(text)) return 'function_bridge_aes_sha1';
  return 'function_bridge_crypto';
}

function bridgeFunctionPatternScore(bridge) {
  let score = 0;
  const xrefSummary = bridge?.path_function_xref_summary || {};
  const text = [...(bridge?.terminal_patterns || []), ...(xrefSummary.target_patterns || [])].join(' ').toLowerCase();
  if (/hkdf|hmac|sha256|evp/.test(text)) score += 80;
  if (/aes|sha1/.test(text)) score += 48;
  if (/sqlcipher|cipher|wcdb|sqlite3_key|pbkdf|kdf/.test(text)) score += 96;
  score += Math.min(Number(bridge?.terminal_region_crypto_xref_count || 0), 64) * 2;
  score += Math.min(Number(bridge?.terminal_function_crypto_xref_count || 0), 32) * 4;
  score += Math.min(Number(xrefSummary.db_xref_count || 0), 32) * 8;
  score += Math.min(Number(xrefSummary.crypto_xref_count || 0), 24) * 6;
  score += Math.min(Number(xrefSummary.sqlcipher_pattern_count || 0), 12) * 24;
  score += Math.min(Number(xrefSummary.crypto_pattern_count || 0), 12) * 12;
  return score;
}

function parseHexNumber(value) {
  const text = String(value || '').trim();
  if (!/^0x[0-9a-f]+$/i.test(text)) return 0;
  const n = Number.parseInt(text.slice(2), 16);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function moduleAnchorPatternWeights(category, name) {
  const weights = new Map([
    ['cipher_compatibility', 96],
    ['cipher_default_kdf_iter', 94],
    ['cipher_page_size', 94],
    ['cipher_hmac_algorithm', 94],
    ['cipher_kdf_algorithm', 94],
    ['cipher_use_hmac', 92],
    ['cipher_default_use_hmac', 92],
    ['cipher_default_page_size', 92],
    ['cipher_default_hmac_algorithm', 92],
    ['cipher_default_compatibility', 92],
    ['cipher_default_plaintext_header_size', 90],
    ['cipher_plaintext_header_size', 90],
    ['cipher_migrate', 82],
    ['cipher_memory_security', 80],
    ['cipher_store_pass', 80],
    ['cipher_version', 80],
    ['cipher_provider', 80],
    ['cipher_salt', 80],
    ['sqlcipher_export', 82],
    ['sqlcipher_codec_ctx', 82],
    ['sqlcipher_activate', 82],
    ['sqlite3_key', 78],
    ['sqlite3_key_v2', 78],
    ['sqlite3_rekey', 78],
    ['sqlite3_rekey_v2', 78],
    ['sqlite_has_codec', 78],
    ['db_key', 76],
    ['codec_ctx', 74],
    ['cipher_ctx', 74],
    ['pragma cipher', 78],
    ['kdf_iter', 76],
    ['key derivation', 74],
    ['pbkdf2_hmac_sha1', 74],
    ['pbkdf2_hmac_sha256', 74],
    ['pbkdf2', 70],
    ['pbkdf', 68],
    ['hmac_sha1', 72],
    ['hmac_sha256', 72],
    ['hmac', 66],
    ['setkey', 70],
    ['derive', 66],
    ['function_bridge_hmac_sha256', 118],
    ['function_bridge_sqlcipher', 116],
    ['function_bridge_aes_sha1', 96],
    ['function_bridge_crypto', 88],
    ['aes-256', 52],
    ['aes', 46],
    ['sha256', 44],
    ['sha1', 40],
    ['wcdb', 44],
    ['sqlcipher', 44],
    ['cipher', 38],
    ['sqlite', 36],
    ['pragma', 32],
    ['db_storage', 28],
    ['xwechat', 20],
  ]);
  if (name) weights.set(name, 120);
  if (category) weights.set(category, Math.max(weights.get(category) || 0, 70));
  if (/^message_\d+\.db$/i.test(name)) weights.set('message_', 110);
  if (name === 'contact.db') weights.set('contact.db', 120);
  if (name === 'session.db') weights.set('session.db', 120);
  weights.set('hardlink.db', Math.max(weights.get('hardlink.db') || 0, 20));
  return weights;
}

function moduleAnchorPatternCap(pattern) {
  switch (String(pattern || '').toLowerCase()) {
    case 'cipher':
      return 20;
    case 'sqlite':
      return 20;
    case 'pragma':
      return 16;
    case 'wcdb':
      return 24;
    case 'sqlcipher':
      return 24;
    case 'xwechat':
      return 16;
    case 'db_storage':
      return 16;
    case 'message_':
      return 24;
    case 'contact.db':
    case 'session.db':
      return 16;
    case 'hardlink.db':
      return 8;
    case 'pragma cipher':
      return 12;
    case 'kdf_iter':
      return 12;
    case 'hmac_sha1':
    case 'hmac_sha256':
    case 'pbkdf2_hmac_sha1':
    case 'pbkdf2_hmac_sha256':
      return 8;
    case 'cipher_compatibility':
    case 'cipher_default_kdf_iter':
    case 'cipher_page_size':
    case 'cipher_hmac_algorithm':
    case 'cipher_kdf_algorithm':
    case 'cipher_use_hmac':
    case 'cipher_default_use_hmac':
    case 'cipher_default_page_size':
    case 'cipher_default_hmac_algorithm':
    case 'cipher_default_compatibility':
    case 'cipher_default_plaintext_header_size':
    case 'cipher_plaintext_header_size':
    case 'cipher_migrate':
    case 'cipher_memory_security':
    case 'cipher_store_pass':
    case 'cipher_version':
    case 'cipher_provider':
    case 'cipher_salt':
    case 'sqlcipher_export':
    case 'sqlcipher_codec_ctx':
    case 'sqlcipher_activate':
    case 'sqlite3_key':
    case 'sqlite3_key_v2':
    case 'sqlite3_rekey':
    case 'sqlite3_rekey_v2':
    case 'sqlite_has_codec':
    case 'db_key':
    case 'codec_ctx':
    case 'cipher_ctx':
    case 'setkey':
      return 12;
    case 'key derivation':
    case 'pbkdf2':
    case 'pbkdf':
    case 'hmac':
    case 'derive':
      return 8;
    case 'function_bridge_hmac_sha256':
    case 'function_bridge_sqlcipher':
    case 'function_bridge_aes_sha1':
    case 'function_bridge_crypto':
      return 64;
    case 'aes-256':
    case 'aes':
    case 'sha256':
    case 'sha1':
      return 6;
    default:
      return 16;
  }
}

function moduleAnchorModuleWeight(moduleName) {
  if (moduleName === 'weixin.dll') return 120;
  if (moduleName.includes('weixin')) return 70;
  if (/wcdb|sqlite|sql|cipher|db/i.test(moduleName)) return 48;
  return 0;
}

function moduleAnchorSectionWeight(section) {
  if (section === '.rdata' || section === 'rdata') return 34;
  if (section === '.data' || section === 'data') return 28;
  if (section === '.mrdata' || section === 'mrdata') return 24;
  if (section.includes('rdata')) return 20;
  if (section.includes('data')) return 16;
  if (section === '.text' || section === 'text') return 4;
  if (section === '.rsrc' || section === 'rsrc') return -20;
  return 0;
}

function summarizeReversePointerLayouts(processes = []) {
  const summaries = (Array.isArray(processes) ? processes : [])
    .map(process => process?.reverse_pointer_layout_summary)
    .filter(Boolean);
  if (!summaries.length) return null;
  const merged = {
    sampled_hit_count: 0,
    pointer_target_reads: 0,
    pointer_field_offsets: {},
    target_pointer_offsets: {},
    zero_field_offsets: {},
    small_uint32_offsets: {},
    length_like_offsets: {},
    pointer_target_kinds: {},
    target_anchor_labels: {},
  };
  const labelLayouts = {};
  let fieldWindowBytes = 0;
  for (const summary of summaries) {
    merged.sampled_hit_count += Number(summary.sampled_hit_count || 0);
    merged.pointer_target_reads += Number(summary.pointer_target_reads || 0);
    fieldWindowBytes = Math.max(fieldWindowBytes, Number(summary.field_window_bytes || 0));
    mergeLayoutCounterList(merged.pointer_field_offsets, summary.pointer_field_offsets);
    mergeLayoutCounterList(merged.target_pointer_offsets, summary.target_pointer_offsets);
    mergeLayoutCounterList(merged.zero_field_offsets, summary.zero_field_offsets);
    mergeLayoutCounterList(merged.small_uint32_offsets, summary.small_uint32_offsets);
    mergeLayoutCounterList(merged.length_like_offsets, summary.length_like_offsets);
    mergeLayoutCounterList(merged.pointer_target_kinds, summary.pointer_target_kinds);
    mergeLayoutCounterList(merged.target_anchor_labels, summary.target_anchor_labels);
    mergeAnchorLabelLayoutList(labelLayouts, summary.anchor_label_layouts);
  }
  return {
    sampled_hit_count: merged.sampled_hit_count,
    field_window_bytes: fieldWindowBytes,
    pointer_target_reads: merged.pointer_target_reads,
    pointer_field_offsets: topLayoutCounterObject(merged.pointer_field_offsets),
    target_pointer_offsets: topLayoutCounterObject(merged.target_pointer_offsets),
    zero_field_offsets: topLayoutCounterObject(merged.zero_field_offsets),
    small_uint32_offsets: topLayoutCounterObject(merged.small_uint32_offsets),
    length_like_offsets: topLayoutCounterObject(merged.length_like_offsets),
    pointer_target_kinds: topLayoutCounterObject(merged.pointer_target_kinds, 8),
    target_anchor_labels: topLayoutCounterObject(merged.target_anchor_labels, 12),
    anchor_label_layouts: summarizeMergedAnchorLabelLayouts(labelLayouts),
  };
}

function mergeLayoutCounterList(target, items = []) {
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item.key ?? '');
    if (!key) continue;
    target[key] = (target[key] || 0) + Number(item.count || 0);
  }
}

function topLayoutCounterObject(map, limit = 12) {
  return Object.entries(map || {})
    .map(([key, count]) => ({ key, count: Number(count || 0) }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count || Math.abs(Number(a.key) || 0) - Math.abs(Number(b.key) || 0))
    .slice(0, limit);
}

function mergeAnchorLabelLayoutList(target, items = []) {
  for (const item of Array.isArray(items) ? items : []) {
    const label = String(item.label || '').slice(0, 80);
    if (!label) continue;
    if (!target[label]) {
      target[label] = {
        label,
        sampled_hit_count: 0,
        pointer_target_reads: 0,
        pointer_field_offsets: {},
        target_pointer_offsets: {},
        small_uint32_offsets: {},
        length_like_offsets: {},
        pointer_target_kinds: {},
      };
    }
    const state = target[label];
    state.sampled_hit_count += Number(item.sampled_hit_count || 0);
    state.pointer_target_reads += Number(item.pointer_target_reads || 0);
    mergeLayoutCounterList(state.pointer_field_offsets, item.pointer_field_offsets);
    mergeLayoutCounterList(state.target_pointer_offsets, item.target_pointer_offsets);
    mergeLayoutCounterList(state.small_uint32_offsets, item.small_uint32_offsets);
    mergeLayoutCounterList(state.length_like_offsets, item.length_like_offsets);
    mergeLayoutCounterList(state.pointer_target_kinds, item.pointer_target_kinds);
  }
}

function summarizeMergedAnchorLabelLayouts(map, limit = 8) {
  return Object.values(map || {})
    .sort((a, b) => b.sampled_hit_count - a.sampled_hit_count || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map(item => ({
      label: item.label,
      sampled_hit_count: item.sampled_hit_count,
      pointer_target_reads: item.pointer_target_reads,
      pointer_field_offsets: topLayoutCounterObject(item.pointer_field_offsets, 6),
      target_pointer_offsets: topLayoutCounterObject(item.target_pointer_offsets, 6),
      small_uint32_offsets: topLayoutCounterObject(item.small_uint32_offsets, 6),
      length_like_offsets: topLayoutCounterObject(item.length_like_offsets, 6),
      pointer_target_kinds: topLayoutCounterObject(item.pointer_target_kinds, 6),
    }));
}

function incrementCounter(target, key) {
  target[key] = (target[key] || 0) + 1;
}

export async function copyDbFile(account, dbFile) {
  const source = typeof dbFile === 'string' ? dbFile : dbFile.path;
  if (!source || !isInside(account.db_storage, source)) {
    const err = new Error('db path is outside selected account db_storage');
    err.status = 403;
    throw err;
  }
  const st = await fsp.stat(source);
  if (!st.isFile()) {
    const err = new Error('db path is not a file');
    err.status = 400;
    throw err;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const category = path.basename(path.dirname(source));
  const targetDir = path.join(TMP_DIR, 'db', account.id, timestamp, category);
  await ensureDir(targetDir);
  const target = path.join(targetDir, path.basename(source));
  await fsp.copyFile(source, target);
  const copied = await fsp.stat(target);
  const header = await readHeader(target);
  return {
    source_category: category,
    source_name: path.basename(source),
    target_path: target,
    bytes: copied.size,
    sha256_16: await sha256Prefix(target),
    encrypted_like: !header.equals(SQLITE_HEADER),
    sqlite_header: header.equals(SQLITE_HEADER),
  };
}

export async function readDbInventory(accountId = '') {
  const accounts = await discoverWxAccounts();
  const account = pickAccount(accounts, accountId);
  if (!account) return { accounts: [], files: [] };
  const files = await listDbFiles(account);
  return {
    account: redactAccount(account),
    files: files.map(f => ({
      category: f.category,
      name: f.name,
      bytes: f.bytes,
      last_write_time: f.last_write_time,
    })),
  };
}

export async function listChatroomsFromWxDb({ account_id = '', raw_keys = [] } = {}) {
  const accounts = await discoverWxAccounts();
  const account = pickAccount(accounts, account_id);
  if (!account) return [];

  const contactFile = path.join(account.db_storage, 'contact', 'contact.db');
  const sessionFile = path.join(account.db_storage, 'session', 'session.db');
  const contact = await openCopiedSqlCipherDb(account, contactFile, raw_keys);
  const session = await openCopiedSqlCipherDb(account, sessionFile, raw_keys).catch(() => null);
  try {
    const rows = contact.db.prepare(`
      select
        c.username as id,
        coalesce(nullif(c.nick_name, ''), c.username) as name,
        c.quan_pin as quan_pin,
        c.pin_yin_initial as pin_yin_initial,
        c.chat_room_type as chat_room_type,
        count(cm.member_id) as members
      from contact c
      left join chatroom_member cm on cm.room_id = c.id
      where c.username like '%@chatroom' and coalesce(c.delete_flag, 0) = 0
      group by c.id
      order by c.username
    `).all();

    const sessionRows = session?.db.prepare(`
      select username, last_timestamp, sort_timestamp, summary, unread_count, last_msg_type
      from SessionTable
    `).all() || [];
    const sessions = new Map(sessionRows.map(row => [row.username, row]));

    return rows.map(row => {
      const s = sessions.get(row.id) || {};
      const ts = Number(s.sort_timestamp || s.last_timestamp || 0);
      const name = String(row.name || row.id);
      const search = groupSearchFields(name, row.quan_pin, row.pin_yin_initial);
      return {
        id: String(row.id),
        name,
        members: Number(row.members || 0),
        last_msg_at: normalizeWxTimestamp(ts),
        pinyin: search.pinyin,
        pinyin_initial: search.pinyin_initial,
        source: 'wxdb',
        unread_count: Number(s.unread_count || 0),
      };
    }).sort((a, b) => (b.last_msg_at || 0) - (a.last_msg_at || 0));
  } finally {
    await contact.close();
    if (session) await session.close();
  }
}

export async function collectMessagesFromWxDb({ account_id = '', group_id, since, until, raw_keys = [], signal } = {}) {
  throwIfAborted(signal);
  if (!group_id) return null;
  const accounts = await discoverWxAccounts();
  throwIfAborted(signal);
  const account = pickAccount(accounts, account_id);
  if (!account) return null;

  const tableName = `Msg_${crypto.createHash('md5').update(group_id).digest('hex')}`;
  const dbFiles = (await listDbFiles(account, 'message'))
    .filter(f => /^message_\d+\.db$/i.test(f.name))
    .sort((a, b) => new Date(b.last_write_time) - new Date(a.last_write_time));
  throwIfAborted(signal);
  const sinceTs = toUnixSeconds(since, 0);
  const untilTs = toUnixSeconds(until, Math.floor(Date.now() / 1000));
  const out = [];

  for (const file of dbFiles) {
    throwIfAborted(signal);
    let opened = null;
    try {
      opened = await openCopiedSqlCipherDb(account, file.path, raw_keys);
      throwIfAborted(signal);
      const exists = opened.db.prepare('select name from sqlite_master where type = ? and name = ?').get(['table', tableName]);
      if (!exists) continue;
      const rows = opened.db.prepare(`
        select local_id, server_id, local_type, sort_seq, real_sender_id, create_time,
               message_content, compress_content, packed_info_data
        from ${tableName}
        where create_time >= ? and create_time <= ?
        order by create_time asc
      `).all([sinceTs, untilTs]);
      throwIfAborted(signal);
      if (!rows.length) continue;

      const senderIds = [...new Set(rows.map(r => Number(r.real_sender_id || 0)).filter(Boolean))];
      const senderMap = new Map();
      const stmt = opened.db.prepare('select rowid, user_name from Name2Id where rowid = ?');
      for (const id of senderIds) {
        throwIfAborted(signal);
        const sender = stmt.get([id]);
        if (sender?.user_name) senderMap.set(id, String(sender.user_name));
      }

      for (const row of rows) {
        throwIfAborted(signal);
        const normalized = normalizeMessageContent(row.message_content, row.local_type, {
          compress_content: row.compress_content,
          packed_info_data: row.packed_info_data,
        });
        const sender = normalized.sender || senderMap.get(Number(row.real_sender_id || 0)) || '未知成员';
        out.push({
          id: `${file.name}:${row.local_id}`,
          local_id: Number(row.local_id),
          server_id: String(row.server_id || ''),
          sort_seq: Number(row.sort_seq || 0),
          time: formatMessageTime(Number(row.create_time || 0)),
          timestamp: Number(row.create_time || 0) * 1000,
          sender,
          type: normalized.type,
          content: normalized.content,
          media: normalized.media,
          raw_type: Number(row.local_type || 0),
          group: group_id,
        });
      }
    } catch {
      // Some message shards may not have a matching key candidate yet.
    } finally {
      if (opened) await opened.close();
    }
  }

  out.sort((a, b) => a.timestamp - b.timestamp || a.sort_seq - b.sort_seq || a.local_id - b.local_id || String(a.id || '').localeCompare(String(b.id || '')));
  throwIfAborted(signal);
  await hydrateSenderNames(account, raw_keys, out, group_id, signal);
  throwIfAborted(signal);
  await enrichMessageMedia(account, raw_keys, out, signal);
  throwIfAborted(signal);
  const scannedCount = out.length;
  return {
    source: 'wxdb',
    account: redactAccount(account),
    group_id,
    table: tableName,
    messages: out,
    scanned_message_count: scannedCount,
    truncated: false,
  };
}

async function hydrateSenderNames(account, rawKeys, messages, groupId = '', signal) {
  throwIfAborted(signal);
  const usernames = [...new Set(messages.map(m => m.sender).filter(Boolean))];
  if (!usernames.length) return;
  let contact = null;
  try {
    contact = await openCopiedSqlCipherDb(account, path.join(account.db_storage, 'contact', 'contact.db'), rawKeys);
    throwIfAborted(signal);
    const stmt = contact.db.prepare(`
      select coalesce(nullif(nick_name, ''), username) as name
      from contact
      where username = ?
      limit 1
    `);
    const roomMemberNames = readRoomMemberNames(contact.db, groupId);
    const map = new Map();
    for (const username of usernames) {
      throwIfAborted(signal);
      if (roomMemberNames.has(username)) {
        map.set(username, roomMemberNames.get(username));
        continue;
      }
      const row = stmt.get([username]);
      if (row?.name) map.set(username, String(row.name));
    }
    for (const msg of messages) {
      throwIfAborted(signal);
      if (map.has(msg.sender)) msg.sender = map.get(msg.sender);
    }
  } catch {
    // Sender display names are an enhancement; raw usernames are still usable.
  } finally {
    if (contact) await contact.close();
  }
}

function readRoomMemberNames(db, groupId) {
  const map = new Map();
  if (!groupId || !String(groupId).includes('@chatroom')) return map;
  try {
    const room = db.prepare('select id, ext_buffer from chat_room where username = ? limit 1').get([groupId]);
    for (const item of parseChatRoomMemberBuffer(room?.ext_buffer)) {
      if (item.username && item.display_name) map.set(item.username, item.display_name);
    }
  } catch {
    // Group-specific member cards vary across WeChat v4 builds; contact nicknames are the fallback.
  }
  return map;
}

function parseChatRoomMemberBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return [];
  const out = [];
  for (const field of readProtoFields(buffer)) {
    if (field.field !== 1 || !Buffer.isBuffer(field.value)) continue;
    const member = {};
    for (const sub of readProtoFields(field.value)) {
      if (sub.field === 1 && Buffer.isBuffer(sub.value)) member.username = cleanDecodedString(sub.value.toString('utf-8'));
      if (sub.field === 2 && Buffer.isBuffer(sub.value)) member.display_name = cleanDecodedString(sub.value.toString('utf-8'));
    }
    if (member.username && member.display_name) out.push(member);
  }
  return out;
}

function groupSearchFields(name, quanPin = '', pinYinInitial = '') {
  const pinyin = normalizeSearchToken(quanPin);
  const pinyinInitial = normalizeSearchToken(pinYinInitial) || groupPinyinInitial(name);
  return {
    pinyin: pinyin || pinyinInitial,
    pinyin_initial: pinyinInitial,
  };
}

function groupPinyinInitial(text) {
  return Array.from(String(text || ''))
    .map(ch => pinyinInitialForChar(ch))
    .join('')
    .toLowerCase();
}

function pinyinInitialForChar(ch) {
  const normalized = String(ch || '').normalize('NFKC');
  if (/^[a-z0-9]$/i.test(normalized)) return normalized.toUpperCase();
  if (!/[\u3400-\u9fff]/u.test(normalized)) return '';
  for (let i = 0; i < PINYIN_ANCHORS.length; i++) {
    if (normalized.localeCompare(PINYIN_ANCHORS[i], 'zh-Hans-CN-u-co-pinyin') < 0) {
      return PINYIN_INITIALS[Math.max(0, i - 1)] || '';
    }
  }
  return 'Z';
}

function normalizeSearchToken(value) {
  return String(value || '').normalize('NFKC').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

async function enrichMessageMedia(account, rawKeys, messages, signal) {
  throwIfAborted(signal);
  const mediaMessages = messages.filter(m => m.media && (m.media.md5 || m.media.file_key || m.media.file_name || ['voice', 'video'].includes(m.type)));
  if (!mediaMessages.length) return;
  let hardlink = null;
  try {
    const dirCache = new Map();
    let dirStmt = null;
    let imageStmt = null;
    let fileByMd5Stmt = null;
    let fileByNameStmt = null;
    let imageByNameStmt = null;
    try {
      hardlink = await openCopiedSqlCipherDb(account, path.join(account.db_storage, 'hardlink', 'hardlink.db'), rawKeys);
      dirStmt = hardlink.db.prepare('select username from dir2id where rowid = ? limit 1');
      imageStmt = hardlink.db.prepare(`
        select md5, type, file_name, file_size, modify_time, dir1, dir2
        from image_hardlink_info_v4
        where md5 = ?
        order by file_size desc
        limit 1
      `);
      fileByMd5Stmt = hardlink.db.prepare(`
        select md5, type, file_name, file_size, modify_time, dir1, dir2
        from file_hardlink_info_v4
        where md5 = ?
        order by file_size desc
        limit 1
      `);
      fileByNameStmt = hardlink.db.prepare(`
        select md5, type, file_name, file_size, modify_time, dir1, dir2
        from file_hardlink_info_v4
        where file_name = ?
        order by file_size desc
        limit 1
      `);
      imageByNameStmt = hardlink.db.prepare(`
        select md5, type, file_name, file_size, modify_time, dir1, dir2
        from image_hardlink_info_v4
        where file_name = ?
        order by file_size desc
        limit 1
      `);
    } catch {
      hardlink = null;
    }

    const dirName = (id) => {
      const n = Number(id || 0);
      if (!n || !dirStmt) return '';
      if (!dirCache.has(n)) dirCache.set(n, String(dirStmt.get([n])?.username || ''));
      return dirCache.get(n);
    };

    const imageJobs = [];
    const videoJobs = [];
    const audioJobs = [];
    const imageSamples = [];
    const localImageSearch = { index: null };

    for (const msg of mediaMessages) {
      throwIfAborted(signal);
      if (msg.type === 'image' && msg.media.md5) {
        const row = (imageStmt ? imageStmt.get([msg.media.md5]) : null) || findImageByFileKey(imageByNameStmt, msg.media.file_key);
        let localPath = '';
        if (row) {
          msg.media.file_name = msg.media.file_name || String(row.file_name || '');
          msg.media.size = msg.media.size || Number(row.file_size || 0);
          const d1 = dirName(row.dir1);
          const d2 = dirName(row.dir2);
          localPath = d1 && d2 && row.file_name
            ? path.join(account.account_root, 'msg', 'attach', d1, d2, 'Img', String(row.file_name))
            : '';
        }
        if (!localPath && msg.media.file_key) {
          localPath = await findLocalImagePathByFileKey(account, msg.media.file_key, localImageSearch, msg);
          if (localPath) {
            msg.media.file_name = msg.media.file_name || path.basename(localPath);
            const st = await fsp.stat(localPath).catch(() => null);
            if (st?.isFile()) msg.media.size = msg.media.size || st.size;
          }
        }
        if (localPath) {
          msg.media.local_available = await exists(localPath);
          if (msg.media.local_available) {
            imageJobs.push({ msg, localPath });
            imageSamples.push(...await readImageValidationSamples(localPath));
          }
        }
      } else if (msg.type === 'file') {
        const row = (fileByMd5Stmt && msg.media.md5 ? fileByMd5Stmt.get([msg.media.md5]) : null)
          || (fileByNameStmt && msg.media.file_name ? fileByNameStmt.get([msg.media.file_name]) : null);
        if (row) {
          msg.media.file_name = msg.media.file_name || String(row.file_name || '');
          msg.media.size = msg.media.size || Number(row.file_size || 0);
          const localPath = await resolveAttachPath(account, dirName(row.dir1), dirName(row.dir2), row.file_name, ['File', 'Video', 'Audio'])
            || await findLocalMessageFilePath(account, row.file_name, msg);
          if (localPath) {
            msg.media.local_available = true;
            msg.media.local_path_hint = path.basename(localPath);
            msg.media.ext = msg.media.ext || path.extname(localPath).slice(1).toLowerCase();
            if (isVideoLike(msg.media)) videoJobs.push({ msg, localPath });
            else if (isAudioLike(msg.media)) audioJobs.push({ msg, localPath });
          }
        } else if (msg.media.file_name) {
          const localPath = await findLocalMessageFilePath(account, msg.media.file_name, msg);
          if (localPath) {
            msg.media.local_available = true;
            msg.media.local_path_hint = path.basename(localPath);
            msg.media.ext = msg.media.ext || path.extname(localPath).slice(1).toLowerCase();
            const st = await fsp.stat(localPath).catch(() => null);
            if (st?.isFile()) msg.media.size = msg.media.size || st.size;
            if (isVideoLike(msg.media)) videoJobs.push({ msg, localPath });
            else if (isAudioLike(msg.media)) audioJobs.push({ msg, localPath });
          }
        }
        msg.content = formatFileContent(msg.media);
      } else if (msg.type === 'video') {
        const row = (fileByMd5Stmt && msg.media.md5 ? fileByMd5Stmt.get([msg.media.md5]) : null)
          || (fileByNameStmt && msg.media.file_name ? fileByNameStmt.get([msg.media.file_name]) : null);
        let localPath = '';
        if (row) {
          msg.media.file_name = msg.media.file_name || String(row.file_name || '');
          msg.media.size = msg.media.size || Number(row.file_size || 0);
          localPath = await resolveAttachPath(account, dirName(row.dir1), dirName(row.dir2), row.file_name, ['Video', 'File'])
            || await findLocalMessageFilePath(account, row.file_name, msg);
        }
        if (!localPath && msg.media.file_key) {
          localPath = await findLocalVideoPathByFileKey(account, msg.media.file_key, msg);
          if (localPath) {
            msg.media.file_name = msg.media.file_name || path.basename(localPath);
            const st = await fsp.stat(localPath).catch(() => null);
            if (st?.isFile()) msg.media.size = msg.media.size || st.size;
          }
        }
        if (localPath) {
          msg.media.local_available = true;
          msg.media.local_path_hint = path.basename(localPath);
          videoJobs.push({ msg, localPath });
        }
        msg.content = formatVideoContent(msg.media);
      } else if (msg.type === 'voice') {
        const row = (fileByMd5Stmt && msg.media.md5 ? fileByMd5Stmt.get([msg.media.md5]) : null)
          || (fileByNameStmt && msg.media.file_name ? fileByNameStmt.get([msg.media.file_name]) : null)
          || findFileByFileKey(fileByNameStmt, msg.media.file_key, VOICE_FILE_EXTENSIONS);
        let localPath = '';
        if (row) {
          msg.media.file_name = msg.media.file_name || String(row.file_name || '');
          msg.media.size = msg.media.size || Number(row.file_size || 0);
          localPath = await resolveAttachPath(account, dirName(row.dir1), dirName(row.dir2), row.file_name, ['Voice', 'Audio', 'File'])
            || await findLocalVoicePathByFileName(account, row.file_name, msg);
        }
        if (!localPath && msg.media.file_name) {
          localPath = await findLocalVoicePathByFileName(account, msg.media.file_name, msg);
        }
        if (!localPath && msg.media.file_key) {
          localPath = await findLocalVoicePathByFileKey(account, msg.media.file_key, msg);
        }
        if (localPath) {
          msg.media.local_available = true;
          msg.media.local_path_hint = path.basename(localPath);
          msg.media.file_name = msg.media.file_name || path.basename(localPath);
          msg.media.ext = msg.media.ext || path.extname(localPath).slice(1).toLowerCase();
          const st = await fsp.stat(localPath).catch(() => null);
          if (st?.isFile()) msg.media.size = msg.media.size || st.size;
          audioJobs.push({ msg, localPath });
        }
        msg.content = formatVoiceContent(msg.media);
      }
    }

    const imageKeys = await getImageKeyCandidatesForSamples(imageSamples);
    for (const job of imageJobs) {
      throwIfAborted(signal);
      const data = await readImageDataUrlIfUsable(job.localPath, imageKeys);
      if (data) Object.assign(job.msg.media, data);
      job.msg.content = formatImageContent(job.msg.media);
    }
    for (const job of videoJobs) {
      throwIfAborted(signal);
      const frame = await readVideoFrameDataUrlIfUsable(job.localPath);
      if (frame) Object.assign(job.msg.media, { frame_data_url: frame.data_url, frame_mime: frame.mime });
      job.msg.content = job.msg.type === 'file' ? formatFileContent(job.msg.media) : formatVideoContent(job.msg.media);
    }
    for (const job of audioJobs) {
      throwIfAborted(signal);
      const audio = await readAudioDataUrlIfUsable(job.localPath);
      if (audio) Object.assign(job.msg.media, audio);
      job.msg.content = job.msg.type === 'voice' ? formatVoiceContent(job.msg.media) : formatFileContent(job.msg.media);
    }
  } catch {
    // Media enrichment is best-effort; XML metadata is still useful for the summary prompt.
  } finally {
    if (hardlink) await hardlink.close();
  }
}

export async function validateCopiedDbWithRawKeys(dbPath, rawKeys) {
  const Database = await loadSqlCipher();
  const dbSalt = (await readHeader(dbPath)).toString('hex');
  const orderedKeys = orderedRawKeyCandidates(rawKeys, dbSalt);
  let attempts = 0;
  for (const { raw, profile } of sqlCipherValidationAttempts(orderedKeys)) {
    attempts++;
    let db;
    try {
      db = new Database(dbPath);
      applySqlCipherKeyProfile(db, raw, profile);
      const row = db.prepare('select count(*) as c from sqlite_master').get();
      const tables = db.prepare("select name from sqlite_master where type = 'table' order by name limit 20").all();
      return {
        ok: true,
        attempts,
        key_profile: profile.id,
        profile_count: SQLCIPHER_KEY_PROFILES.length,
        key_hash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12),
        table_count: Number(row?.c || 0),
        tables: tables.map(t => String(t.name || '')).filter(Boolean),
      };
    } catch {
      // Keep trying candidates; SQLCipher errors are intentionally not surfaced with key data.
    } finally {
      try { db?.close(); } catch {}
    }
  }
  const manual = await validateCopiedDbWithWeixinV4PageKeys(dbPath, orderedKeys);
  if (manual?.ok) {
    return {
      ok: true,
      attempts: attempts + manual.attempts,
      key_profile: manual.key_profile,
      profile_count: SQLCIPHER_KEY_PROFILES.length + 1,
      key_hash: manual.key_hash,
      table_count: manual.table_count,
      tables: manual.tables,
      manual_page_validation_attempts: manual.attempts,
    };
  }
  return {
    ok: false,
    attempts,
    profile_count: SQLCIPHER_KEY_PROFILES.length,
    profile_fallback_key_limit: SQLCIPHER_PROFILE_FALLBACK_MAX_KEYS,
    profile_fallback_limits: sqlCipherProfileFallbackLimits(),
    manual_page_validation_attempts: manual?.attempts || 0,
    error: 'no candidate key opened sample database',
  };
}

export async function cleanupCopiedDbs(keep = false) {
  if (keep) return;
  await fsp.rm(path.join(TMP_DIR, 'db'), { recursive: true, force: true }).catch(() => {});
}

function redactAccount(account) {
  return {
    id: account.id,
    wxid: account.wxid,
    display_name: account.display_name,
    account_root: account.account_root,
    db_storage: account.db_storage,
    last_write_time: account.last_write_time,
    summary: account.summary,
  };
}

async function readHeader(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(16);
    await handle.read(buf, 0, buf.length, 0);
    return buf;
  } finally {
    await handle.close();
  }
}

async function sha256Prefix(file) {
  const handle = await fsp.open(file, 'r');
  const hash = crypto.createHash('sha256');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let read = 0;
    while (read < 4 * 1024 * 1024) {
      const res = await handle.read(buf, 0, Math.min(buf.length, 4 * 1024 * 1024 - read), read);
      if (!res.bytesRead) break;
      hash.update(buf.subarray(0, res.bytesRead));
      read += res.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex').slice(0, 16);
}

async function loadSqlCipher() {
  if (SqlCipherDatabase) return SqlCipherDatabase;
  const mod = await import('@signalapp/sqlcipher');
  if (!sqlcipherLoggerSet && typeof mod.setLogger === 'function') {
    mod.setLogger(() => {});
    sqlcipherLoggerSet = true;
  }
  SqlCipherDatabase = mod.default || mod.Database;
  if (!SqlCipherDatabase) throw new Error('SQLCipher module is unavailable');
  return SqlCipherDatabase;
}

async function openCopiedSqlCipherDb(account, source, rawKeys) {
  const copied = await copyDbFile(account, source);
  const found = await findRawKeyForCopiedDb(copied.target_path, rawKeys);
  const Database = await loadSqlCipher();
  if (found?.raw) {
    const db = new Database(copied.target_path);
    try {
      applySqlCipherKeyProfile(db, found.raw, found.profile);
      db.prepare('select count(*) as c from sqlite_master').get();
    } catch (e) {
      try { db.close(); } catch {}
      await removeCopiedDb(copied.target_path);
      throw e;
    }
    return {
      db,
      key_hash: crypto.createHash('sha256').update(found.raw).digest('hex').slice(0, 12),
      key_profile: found.profile.id,
      copied,
      close() {
        try { db.close(); } catch {}
        return removeCopiedDb(copied.target_path);
      },
    };
  }
  const verified = await scanVerifiedWeixinV4KeysForCopiedDb(copied.target_path);
  if (verified.raw_keys.length) {
    const manual = await openWeixinV4DecryptedDb(copied.target_path, [...verified.raw_keys, ...rawKeys], Database);
    if (manual?.db) {
      return {
        db: manual.db,
        key_hash: manual.key_hash,
        key_profile: `${manual.key_profile}:verified_memory_hmac`,
        copied,
        close() {
          try { manual.db.close(); } catch {}
          return removeCopiedDb(copied.target_path);
        },
      };
    }
  }
  const manual = await openWeixinV4DecryptedDb(copied.target_path, rawKeys, Database);
  if (manual?.db) {
    return {
      db: manual.db,
      key_hash: manual.key_hash,
      key_profile: manual.key_profile,
      copied,
      close() {
        try { manual.db.close(); } catch {}
        return removeCopiedDb(copied.target_path);
      },
    };
  }
  await removeCopiedDb(copied.target_path);
  throw new Error(`no raw key matched ${path.basename(source)}`);
}

async function scanVerifiedWeixinV4KeysForCopiedDb(dbPath) {
  const page = await readFirstPage(dbPath).catch(() => null);
  if (!page || page.length < WEIXIN_V4_PAGE_SIZE) return { raw_keys: [], scan_process_count: 0 };
  const processes = await getWeixinProcesses().catch(() => []);
  const ordered = [...processes].sort((a, b) => Number(b.is_main === true) - Number(a.is_main === true));
  const raw = [];
  const summaries = [];
  for (const process of ordered) {
    const result = await scanProcessForVerifiedWeixinV4DbKeys(process.pid, {
      db_pages: [page],
      include_raw: true,
      include_mapped: true,
      writable_only: false,
      max_bytes: 1024 * 1024 * 1024,
      max_region_bytes: 128 * 1024 * 1024,
    }).catch(e => ({ error: e?.message || String(e), raw_candidates: [] }));
    summaries.push({
      pid: process.pid,
      type: process.is_main ? 'main' : 'helper',
      unique_candidate_count: Number(result.unique_candidate_count || 0),
      matched_salt_count: Number(result.matched_salt_count || 0),
      hex_pattern_count: Number(result.hex_pattern_count || 0),
      scanned_bytes: Number(result.scanned_bytes || 0),
      error: result.error ? String(result.error) : '',
    });
    for (const item of result.raw_candidates || []) raw.push(item);
    if (Number(result.matched_salt_count || 0) > 0) break;
  }
  return {
    raw_keys: uniqueStrings(raw),
    scan_process_count: summaries.length,
    scan_processes: summaries,
  };
}

async function findRawKeyForCopiedDb(dbPath, rawKeys) {
  const salt = (await readHeader(dbPath)).toString('hex');
  const orderedKeys = orderedRawKeyCandidates(rawKeys, salt);
  const Database = await loadSqlCipher();
  for (const { raw, profile } of sqlCipherValidationAttempts(orderedKeys)) {
    let db;
    try {
      db = new Database(dbPath);
      applySqlCipherKeyProfile(db, raw, profile);
      db.prepare('select count(*) as c from sqlite_master').get();
      return { raw, profile };
    } catch {
      // Keep trying candidates; invalid key errors are expected for broad memory scans.
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return null;
}

async function validateCopiedDbWithWeixinV4PageKeys(dbPath, orderedKeys) {
  const found = await findWeixinV4PageKeyForCopiedDb(dbPath, orderedKeys);
  if (!found?.raw) return found;
  const Database = await loadSqlCipher();
  const plainPath = await decryptWeixinV4DbToPlaintext(dbPath, found.raw);
  let db;
  try {
    db = new Database(plainPath);
    const row = db.prepare('select count(*) as c from sqlite_master').get();
    const tables = db.prepare("select name from sqlite_master where type = 'table' order by name limit 20").all();
    return {
      ok: true,
      attempts: found.attempts,
      key_profile: WEIXIN_V4_MANUAL_PROFILE.id,
      key_hash: crypto.createHash('sha256').update(found.raw).digest('hex').slice(0, 12),
      table_count: Number(row?.c || 0),
      tables: tables.map(t => String(t.name || '')).filter(Boolean),
    };
  } catch {
    return { ok: false, attempts: found.attempts };
  } finally {
    try { db?.close(); } catch {}
    await fsp.rm(plainPath, { force: true }).catch(() => {});
  }
}

async function openWeixinV4DecryptedDb(dbPath, rawKeys, Database) {
  const salt = (await readHeader(dbPath)).toString('hex');
  const orderedKeys = orderedRawKeyCandidates(rawKeys, salt);
  const found = await findWeixinV4PageKeyForCopiedDb(dbPath, orderedKeys);
  if (!found?.raw) return null;
  const plainPath = await decryptWeixinV4DbToPlaintext(dbPath, found.raw);
  let db;
  try {
    db = new Database(plainPath);
    db.prepare('select count(*) as c from sqlite_master').get();
    return {
      db,
      plain_path: plainPath,
      key_hash: crypto.createHash('sha256').update(found.raw).digest('hex').slice(0, 12),
      key_profile: WEIXIN_V4_MANUAL_PROFILE.id,
    };
  } catch (e) {
    try { db?.close(); } catch {}
    await fsp.rm(plainPath, { force: true }).catch(() => {});
    throw e;
  }
}

async function findWeixinV4PageKeyForCopiedDb(dbPath, rawKeys, options = {}) {
  const page = await readFirstPage(dbPath);
  if (page.length < WEIXIN_V4_PAGE_SIZE) return { ok: false, attempts: 0 };
  const salt = page.subarray(0, WEIXIN_V4_SALT_BYTES);
  const candidateKeys = weixinV4KeyCandidates(rawKeys);
  let attempts = 0;
  for (const raw of candidateKeys) {
    attempts++;
    if (validateWeixinV4PageHmac(page, raw, 1)) return { ok: true, raw, attempts, key_kind: 'enc_key' };
    if (options.derive_passphrase_keys === true) {
      const derived = deriveWeixinV4PassphrasePageKey(raw, salt);
      attempts++;
      if (derived && validateWeixinV4PageHmac(page, derived, 1)) return { ok: true, raw: derived, attempts, key_kind: 'passphrase_derived' };
    }
  }
  return { ok: false, attempts };
}

function weixinV4KeyCandidates(rawKeys) {
  const out = [];
  const seen = new Set();
  for (const value of rawKeys || []) {
    const raw = String(value || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64,160}$/.test(raw)) continue;
    for (const key of [raw.slice(0, 64), raw.length >= 128 ? raw.slice(64, 128) : '']) {
      if (!/^[a-f0-9]{64}$/.test(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

async function readFirstPage(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(WEIXIN_V4_PAGE_SIZE);
    const res = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, res.bytesRead);
  } finally {
    await handle.close();
  }
}

function validateWeixinV4PageHmac(page, keyHex, pageNumber) {
  const material = deriveWeixinV4PageKeys(keyHex, page.subarray(0, WEIXIN_V4_SALT_BYTES));
  return validateWeixinV4PageHmacWithMacKey(page, material.macKey, pageNumber);
}

function validateWeixinV4PageHmacWithMacKey(page, macKey, pageNumber) {
  const hmacRange = weixinV4PageHmacRange(page, pageNumber === 1);
  if (!hmacRange) return false;
  const hmac = crypto.createHmac('sha512', macKey);
  hmac.update(hmacRange.signed);
  const pageNo = Buffer.alloc(4);
  pageNo.writeUInt32LE(pageNumber, 0);
  hmac.update(pageNo);
  return crypto.timingSafeEqual(hmac.digest(), hmacRange.stored);
}

function weixinV4PageHmacRange(page, isFirstPage) {
  if (page.length < WEIXIN_V4_PAGE_SIZE) return null;
  const offset = isFirstPage ? WEIXIN_V4_SALT_BYTES : 0;
  const hmacOffset = WEIXIN_V4_PAGE_SIZE - WEIXIN_V4_HMAC_BYTES;
  const signedEnd = WEIXIN_V4_PAGE_SIZE - WEIXIN_V4_HMAC_BYTES;
  if (offset >= signedEnd || hmacOffset + WEIXIN_V4_HMAC_BYTES > page.length) return null;
  return {
    signed: page.subarray(offset, signedEnd),
    stored: page.subarray(hmacOffset, hmacOffset + WEIXIN_V4_HMAC_BYTES),
  };
}

function deriveWeixinV4PageKeys(keyHex, salt) {
  const key = Buffer.from(keyHex, 'hex');
  const encKey = key;
  const macSalt = Buffer.from(salt.map(byte => byte ^ 0x3a));
  const macKey = crypto.pbkdf2Sync(key, macSalt, 2, WEIXIN_V4_KEY_BYTES, 'sha512');
  return { encKey, macKey };
}

function deriveWeixinV4PassphrasePageKey(keyHex, salt) {
  if (!/^[a-f0-9]{64}$/.test(String(keyHex || '')) || !Buffer.isBuffer(salt) || salt.length !== WEIXIN_V4_SALT_BYTES) return '';
  return crypto.pbkdf2Sync(Buffer.from(keyHex, 'hex'), salt, WEIXIN_V4_KDF_ITER, WEIXIN_V4_KEY_BYTES, 'sha512').toString('hex');
}

async function decryptWeixinV4DbToPlaintext(dbPath, keyHex) {
  const source = await fsp.readFile(dbPath);
  if (source.length < WEIXIN_V4_PAGE_SIZE) throw new Error('database file is too small for Weixin v4 page decrypt');
  const salt = source.subarray(0, WEIXIN_V4_SALT_BYTES);
  const material = deriveWeixinV4PageKeys(keyHex, salt);
  const pages = [];
  const pageCount = Math.floor(source.length / WEIXIN_V4_PAGE_SIZE);
  for (let i = 0; i < pageCount; i++) {
    const page = source.subarray(i * WEIXIN_V4_PAGE_SIZE, (i + 1) * WEIXIN_V4_PAGE_SIZE);
    pages.push(decryptWeixinV4Page(page, material, i + 1));
  }
  const remainder = source.subarray(pageCount * WEIXIN_V4_PAGE_SIZE);
  if (remainder.length) pages.push(remainder);
  const target = `${dbPath}.weixin-v4-plain.db`;
  await fsp.writeFile(target, Buffer.concat(pages));
  return target;
}

function decryptWeixinV4Page(page, material, pageNumber) {
  if (page.every(byte => byte === 0)) return Buffer.from(page);
  if (!validateWeixinV4PageHmacWithMacKey(page, material.macKey, pageNumber)) throw new Error('Weixin v4 page hmac mismatch');
  const offset = pageNumber === 1 ? WEIXIN_V4_SALT_BYTES : 0;
  const cipherEnd = WEIXIN_V4_PAGE_SIZE - WEIXIN_V4_RESERVED_BYTES;
  const iv = page.subarray(cipherEnd, cipherEnd + WEIXIN_V4_IV_BYTES);
  const encrypted = page.subarray(offset, cipherEnd);
  const decipher = crypto.createDecipheriv('aes-256-cbc', material.encKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const reserve = Buffer.alloc(WEIXIN_V4_RESERVED_BYTES);
  return pageNumber === 1
    ? Buffer.concat([SQLITE_HEADER, decrypted, reserve])
    : Buffer.concat([decrypted, reserve]);
}

function silenceSqlCipherNoise(db) {
  for (const pragma of ['cipher_log = off', 'cipher_log_level = NONE']) {
    try { db.pragma(pragma); } catch {}
  }
}

function applySqlCipherKeyProfile(db, raw, profile = SQLCIPHER_KEY_PROFILES[0]) {
  silenceSqlCipherNoise(db);
  for (const pragma of profile.before_key || []) {
    try { db.pragma(pragma); } catch {}
  }
  db.pragma(`key = "x'${raw}'"`);
  for (const pragma of profile.after_key || []) {
    try { db.pragma(pragma); } catch {}
  }
}

function orderedRawKeyCandidates(rawKeys, salt = '') {
  const normalized = normalizeRawKeyCandidates(rawKeys, salt);
  return [
    ...normalized.filter(raw => rawKeySalt(raw) === salt),
    ...normalized.filter(raw => rawKeySalt(raw) !== salt),
  ];
}

function rawKeySalt(raw) {
  const text = String(raw || '').toLowerCase();
  if (/^[a-f0-9]{160}$/.test(text)) return text.slice(128);
  if (/^[a-f0-9]{96}$/.test(text)) return text.slice(64);
  return '';
}

function sqlCipherValidationAttempts(orderedKeys) {
  const defaultProfile = SQLCIPHER_KEY_PROFILES[0];
  const extraProfiles = SQLCIPHER_KEY_PROFILES.slice(1);
  const attempts = orderedKeys.map(raw => ({ raw, profile: defaultProfile }));
  for (const profile of extraProfiles) {
    const fallbackKeys = orderedKeys.slice(0, sqlCipherProfileFallbackLimit(profile));
    for (const raw of fallbackKeys) attempts.push({ raw, profile });
  }
  return attempts;
}

function sqlCipherProfileFallbackLimit(profile = {}) {
  const n = Number(profile.fallback_key_limit || 0);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), SQLCIPHER_PROFILE_FALLBACK_MAX_KEYS);
  return SQLCIPHER_PROFILE_FALLBACK_MAX_KEYS;
}

function sqlCipherProfileFallbackLimits() {
  return Object.fromEntries(SQLCIPHER_KEY_PROFILES.slice(1).map(profile => [profile.id, sqlCipherProfileFallbackLimit(profile)]));
}

function normalizeRawKeyCandidates(rawKeys, salt = '') {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  for (const value of rawKeys || []) {
    const raw = String(value || '').trim().toLowerCase();
    if (/^[a-f0-9]{160}$/.test(raw)) {
      add(raw);
      const keyAndHmac = raw.slice(0, 128);
      const keyHalf = raw.slice(0, 64);
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${keyAndHmac}${salt}`);
      add(`${keyHalf}${raw.slice(128)}`);
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${keyHalf}${salt}`);
      add(keyHalf);
    } else if (/^[a-f0-9]{128}$/.test(raw)) {
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${raw}${salt}`);
      const keyHalf = raw.slice(0, 64);
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${keyHalf}${salt}`);
      add(keyHalf);
    } else if (/^[a-f0-9]{96}$/.test(raw)) {
      add(raw);
      const keyHalf = raw.slice(0, 64);
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${keyHalf}${salt}`);
      add(keyHalf);
    } else if (/^[a-f0-9]{64}$/.test(raw)) {
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${raw}${salt}`);
      add(raw);
    }
  }
  return out;
}

async function removeCopiedDb(targetPath) {
  const tempRoot = path.dirname(path.dirname(targetPath));
  await rmWithRetry(tempRoot);
  await removeEmptyCopiedDbParents(tempRoot);
}

async function rmWithRetry(target) {
  for (let i = 0; i < 8; i++) {
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    const stillThere = await exists(target);
    if (!stillThere) return;
    await new Promise(resolve => setTimeout(resolve, 50 * (i + 1)));
  }
}

async function removeEmptyCopiedDbParents(tempRoot) {
  const dbRoot = path.join(TMP_DIR, 'db');
  let current = path.dirname(tempRoot);
  while (isInside(dbRoot, current) && path.resolve(current) !== path.resolve(TMP_DIR)) {
    try {
      await fsp.rmdir(current);
    } catch {
      return;
    }
    if (path.resolve(current) === path.resolve(dbRoot)) return;
    current = path.dirname(current);
  }
}

function normalizeWxTimestamp(value) {
  if (!value) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n > 10_000_000_000 ? n : n * 1000;
}

function toUnixSeconds(value, fallback) {
  if (!value || value === 'now') return fallback;
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return fallback;
  return Math.floor(date.getTime() / 1000);
}

function formatMessageTime(seconds) {
  const date = new Date(seconds * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function normalizeMessageContent(value, localType, extra = {}) {
  const decoded = decodeMessagePayload(value);
  const split = splitSenderPrefix(decoded);
  const body = split.body.trim();
  const typeCode = baseLocalType(localType);

  if (typeCode === 1 && body) {
    return { type: 'text', sender: split.sender, content: body || '[空文本]' };
  }
  if (typeCode === 3) {
    const media = parseImageMedia(body, extra.packed_info_data);
    return { type: 'image', sender: split.sender, content: formatImageContent(media), media };
  }
  if (typeCode === 34) {
    const media = parseVoiceMedia(body, extra.packed_info_data);
    return { type: 'voice', sender: split.sender, content: formatVoiceContent(media), media };
  }
  if (typeCode === 43) {
    const media = parseVideoMedia(body, extra.packed_info_data);
    return { type: 'video', sender: split.sender, content: formatVideoContent(media), media };
  }
  if (typeCode === 47) {
    const media = parseEmojiMedia(body);
    return { type: 'emoji', sender: split.sender, content: formatEmojiContent(media), media };
  }
  if (typeCode === 49) {
    const parsed = parseAppMessage(body, extra.packed_info_data);
    return { type: parsed.type, sender: split.sender, content: parsed.content, media: parsed.media };
  }
  if (typeCode === 10000) {
    const content = extractTag(body, 'content') || body.replace(/<[^>]+>/g, '').trim();
    return { type: 'system', sender: split.sender, content: content || '[系统消息]' };
  }
  if (body) return { type: 'other', sender: split.sender, content: body.slice(0, 1000) };
  return { type: 'other', sender: split.sender, content: `[非文本消息 type=${Number(localType || 0)}]` };
}

function decodeMessagePayload(value) {
  if (typeof value === 'string') return value;
  if (!Buffer.isBuffer(value)) return '';
  let buf = value;
  if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd && typeof zlib.zstdDecompressSync === 'function') {
    try {
      buf = zlib.zstdDecompressSync(buf);
    } catch {
      // Leave undecoded payload as-is; callers will fall back to placeholders.
    }
  }
  return cleanDecodedString(buf.toString('utf-8'));
}

function cleanDecodedString(text) {
  return String(text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

function splitSenderPrefix(text) {
  const value = String(text || '');
  const splitAt = value.indexOf(':\n');
  if (splitAt > 0 && splitAt < 100) {
    return { sender: value.slice(0, splitAt).trim(), body: value.slice(splitAt + 2) };
  }
  return { sender: '', body: value };
}

function baseLocalType(localType) {
  const n = BigInt(Math.trunc(Number(localType || 0)));
  return Number(n & 0xffffffffn);
}

function parseImageMedia(xml, packedInfoData) {
  const media = {
    kind: 'image',
    md5: xmlAttr(xml, 'img', 'md5'),
    aeskey: xmlAttr(xml, 'img', 'aeskey'),
    size: numberAttr(xml, 'img', 'length') || numberAttr(xml, 'img', 'hdlength') || numberAttr(xml, 'img', 'hevc_mid_size'),
    width: firstNumber([
      xmlAttr(xml, 'img', 'width'),
      xmlAttr(xml, 'img', 'cdnmidwidth'),
      xmlAttr(xml, 'img', 'cdnhdwidth'),
      xmlAttr(xml, 'img', 'cdnthumbwidth'),
    ]),
    height: firstNumber([
      xmlAttr(xml, 'img', 'height'),
      xmlAttr(xml, 'img', 'cdnmidheight'),
      xmlAttr(xml, 'img', 'cdnhdheight'),
      xmlAttr(xml, 'img', 'cdnthumbheight'),
    ]),
    file_key: firstHex(decodeMessagePayload(packedInfoData), 32, { requireBoundary: false }),
  };
  return compactObject(media);
}

function parseVoiceMedia(xml, packedInfoData) {
  const media = {
    kind: 'voice',
    md5: xmlAttr(xml, 'voicemsg', 'md5') || extractTag(xml, 'md5'),
    file_name: decodeXmlEntities(xmlAttr(xml, 'voicemsg', 'filename') || extractTag(xml, 'filename')),
    duration_ms: firstNumber([
      xmlAttr(xml, 'voicemsg', 'voicelength'),
      xmlAttr(xml, 'voicemsg', 'length'),
      extractTag(xml, 'voicelength'),
    ]),
    size: firstNumber([
      xmlAttr(xml, 'voicemsg', 'bufsize'),
      xmlAttr(xml, 'voicemsg', 'length'),
      extractTag(xml, 'bufsize'),
    ]),
    format: decodeXmlEntities(xmlAttr(xml, 'voicemsg', 'voiceformat') || extractTag(xml, 'voiceformat')),
    file_key: firstHex(decodeMessagePayload(packedInfoData), 32, { requireBoundary: false }),
  };
  return compactObject(media);
}

function parseVideoMedia(xml, packedInfoData) {
  const media = {
    kind: 'video',
    md5: xmlAttr(xml, 'videomsg', 'md5') || extractTag(xml, 'md5'),
    file_name: decodeXmlEntities(xmlAttr(xml, 'videomsg', 'filename') || extractTag(xml, 'filename')),
    size: firstNumber([
      xmlAttr(xml, 'videomsg', 'length'),
      xmlAttr(xml, 'videomsg', 'rawlength'),
      extractTag(xml, 'length'),
    ]),
    duration_s: firstNumber([
      xmlAttr(xml, 'videomsg', 'playlength'),
      extractTag(xml, 'playlength'),
    ]),
    width: firstNumber([xmlAttr(xml, 'videomsg', 'width'), extractTag(xml, 'width')]),
    height: firstNumber([xmlAttr(xml, 'videomsg', 'height'), extractTag(xml, 'height')]),
    url: decodeXmlEntities(xmlAttr(xml, 'videomsg', 'cdnvideourl') || extractTag(xml, 'cdnvideourl')),
    file_key: firstHex(decodeMessagePayload(packedInfoData), 32, { requireBoundary: false }),
  };
  return compactObject(media);
}

function parseEmojiMedia(xml) {
  return compactObject({
    kind: 'emoji',
    md5: xmlAttr(xml, 'emoji', 'md5'),
    width: numberAttr(xml, 'emoji', 'width'),
    height: numberAttr(xml, 'emoji', 'height'),
    size: numberAttr(xml, 'emoji', 'len') || numberAttr(xml, 'emoji', 'androidlen'),
    desc: decodeXmlEntities(xmlAttr(xml, 'emoji', 'desc')),
  });
}

function parseAppMessage(xml, packedInfoData) {
  const appType = Number(extractTag(xml, 'type') || 0);
  const title = decodeXmlEntities(extractTag(xml, 'title') || '');
  const url = decodeXmlEntities(extractTag(xml, 'url') || '');
  const md5 = extractTag(xml, 'md5') || extractTag(xml, 'filemd5') || firstHex(decodeMessagePayload(packedInfoData), 32);
  const quote = parseQuoteMedia(xml);
  if (appType === 57 || quote) {
    const media = compactObject({ kind: 'quote', title, quote });
    return { type: 'quote', content: formatQuoteContent(title, quote), media };
  }
  const media = compactObject({
    kind: appType === 6 ? 'file' : 'app',
    file_name: title,
    md5,
    size: Number(extractTag(xml, 'totallen') || extractTag(xml, 'filetotallen') || 0) || undefined,
    ext: decodeXmlEntities(extractTag(xml, 'fileext') || ''),
    url,
  });
  if (appType === 6 || /<appattach[\s>]/i.test(xml) || looksLikeFilename(title)) {
    return { type: 'file', content: formatFileContent(media), media };
  }
  if (appType === 5 || url) {
    return { type: 'link', content: title ? `[链接] ${title}${url ? ` ${url}` : ''}` : `[链接] ${url}`, media };
  }
  return { type: 'file', content: title ? `[文件/小程序] ${title}` : '[文件/链接]', media };
}

function parseQuoteMedia(xml) {
  const referXml = String(xml || '').match(/<refermsg\b[^>]*>[\s\S]*?<\/refermsg>/i)?.[0] || '';
  if (!referXml) return null;
  const rawContent = cleanQuoteText(extractTag(referXml, 'content'));
  const split = splitSenderPrefix(rawContent);
  const displayName = cleanQuoteText(extractTag(referXml, 'displayname'));
  return compactObject({
    from: displayName || split.sender || cleanQuoteText(extractTag(referXml, 'fromusr')),
    content: split.body ? cleanQuoteText(split.body) : rawContent,
    type: cleanQuoteText(extractTag(referXml, 'type')),
    server_id: cleanQuoteText(extractTag(referXml, 'svrid')),
    create_time: cleanQuoteText(extractTag(referXml, 'createtime')),
  });
}

function cleanQuoteText(text) {
  return decodeXmlEntities(String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function formatImageContent(media = {}) {
  const bits = [];
  if (media.width && media.height) bits.push(`${media.width}x${media.height}`);
  if (media.size) bits.push(formatBytes(media.size));
  if (media.md5) bits.push(`md5=${String(media.md5).slice(0, 8)}`);
  if (media.data_url) bits.push('已附图');
  else if (media.local_available) bits.push('本地文件待解封');
  return `[图片${bits.length ? ' ' + bits.join(' · ') : ''}]`;
}

function formatVoiceContent(media = {}) {
  const bits = [];
  if (media.duration_ms) bits.push(`${Math.round(Number(media.duration_ms) / 1000)}秒`);
  if (media.file_name) bits.push(`文件=${media.file_name}`);
  if (media.size) bits.push(formatBytes(media.size));
  if (media.format) bits.push(`格式=${media.format}`);
  if (media.audio_data_url) bits.push('已附音频');
  else if (media.local_available) bits.push('本地语音已定位');
  return `[语音${bits.length ? ' ' + bits.join(' · ') : ''}]`;
}

function formatVideoContent(media = {}) {
  const bits = [];
  if (media.width && media.height) bits.push(`${media.width}x${media.height}`);
  if (media.duration_s) bits.push(`${media.duration_s}秒`);
  if (media.size) bits.push(formatBytes(media.size));
  if (media.frame_data_url) bits.push('已附关键帧');
  else if (media.local_available) bits.push('本地视频已定位');
  return `[视频${bits.length ? ' ' + bits.join(' · ') : ''}]`;
}

function formatEmojiContent(media = {}) {
  const desc = media.desc ? ` ${media.desc}` : '';
  return `[表情${desc}]`;
}

function formatFileContent(media = {}) {
  const name = media.file_name || '未命名文件';
  const bits = [];
  if (media.ext) bits.push(media.ext);
  if (media.size) bits.push(formatBytes(media.size));
  if (media.frame_data_url) bits.push('已附视频关键帧');
  if (media.audio_data_url) bits.push('已附音频');
  return `[文件] ${name}${bits.length ? ` (${bits.join(' · ')})` : ''}`;
}

function formatQuoteContent(title = '', quote = {}) {
  const reply = cleanQuoteText(title);
  const from = quote?.from ? `${quote.from}: ` : '';
  const quoted = quote?.content ? `${from}${quote.content}` : '未识别引用内容';
  return `[引用] ${reply || '（无回复正文）'}；原文：${quoted}`;
}

function xmlAttr(xml, tag, attr) {
  const match = String(xml || '').match(new RegExp(`<${tag}\\b[^>]*\\s${attr}\\s*=\\s*([\"'])(.*?)\\1`, 'i'));
  return match ? decodeXmlEntities(match[2]) : '';
}

function numberAttr(xml, tag, attr) {
  const n = Number(xmlAttr(xml, tag, attr));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function extractTag(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeXmlEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()) : '';
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function firstNumber(values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function firstHex(text, length, { requireBoundary = true } = {}) {
  const pattern = requireBoundary ? `\\b[a-fA-F0-9]{${length}}\\b` : `[a-fA-F0-9]{${length}}`;
  return String(text || '').match(new RegExp(pattern))?.[0]?.toLowerCase() || '';
}

function findImageByFileKey(stmt, fileKey) {
  const key = String(fileKey || '').trim().toLowerCase();
  if (!stmt || !/^[a-f0-9]{32}$/.test(key)) return null;
  for (const suffix of ['.dat', '_h.dat', '_t.dat']) {
    const row = stmt.get([`${key}${suffix}`]);
    if (row) return row;
  }
  return null;
}

function findFileByFileKey(stmt, fileKey, extensions = []) {
  const key = String(fileKey || '').trim().toLowerCase();
  if (!stmt || !/^[a-f0-9]{32}$/.test(key)) return null;
  for (const suffix of uniqueStrings(['', ...extensions])) {
    const row = stmt.get([`${key}${suffix}`]);
    if (row) return row;
  }
  return null;
}

async function findLocalImagePathByFileKey(account, fileKey, cache = {}, msg = null) {
  const key = String(fileKey || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(key)) return '';
  const direct = await findLocalImagePathByConversation(account, key, msg);
  if (direct) return direct;
  if (!cache.index) cache.index = await buildLocalImageFileIndex(account);
  return cache.index.get(key) || '';
}

async function findLocalImagePathByConversation(account, key, msg) {
  const conversationDir = conversationStorageDir(msg?.group || msg?.sender);
  const monthDir = messageMonthDir(msg);
  if (!conversationDir || !monthDir) return '';
  const dir = path.join(account.account_root, 'msg', 'attach', conversationDir, monthDir, 'Img');
  for (const suffix of ['_h.dat', '.dat', '_t.dat']) {
    const candidate = path.join(dir, `${key}${suffix}`);
    if (await exists(candidate)) return candidate;
  }
  return '';
}

async function buildLocalImageFileIndex(account) {
  const index = new Map();
  const root = path.join(account.account_root, 'msg', 'attach');
  const stack = [root];
  let visited = 0;
  const deadline = Date.now() + LOCAL_IMAGE_INDEX_MAX_MS;
  while (stack.length && visited < LOCAL_IMAGE_INDEX_MAX_ENTRIES && Date.now() < deadline) {
    const dir = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      visited++;
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (entry.isFile()) {
        const match = entry.name.toLowerCase().match(/^([a-f0-9]{32})(?:_[ht])?\.dat$/);
        if (!match) continue;
        const key = match[1];
        const file = path.join(dir, entry.name);
        const prev = index.get(key);
        if (!prev || imageFilePriority(file) < imageFilePriority(prev)) index.set(key, file);
      }
    }
  }
  return index;
}

function imageFilePriority(file) {
  const name = path.basename(file).toLowerCase();
  if (name.endsWith('_h.dat')) return 0;
  if (name.endsWith('.dat') && !name.endsWith('_t.dat')) return 1;
  return 2;
}

async function findLocalVoicePathByFileName(account, fileName, msg) {
  const safeName = safeLocalFileName(fileName);
  if (!safeName) return '';
  const monthDir = messageMonthDir(msg);
  if (!monthDir) return '';
  for (const dir of voiceSearchDirs(account, msg)) {
    const candidate = path.join(dir, safeName);
    if (await exists(candidate)) return candidate;
  }
  return await findLocalVoicePathByBoundedIndex(account, name => name.toLowerCase() === safeName.toLowerCase(), msg);
}

async function findLocalVoicePathByFileKey(account, fileKey, msg) {
  const key = String(fileKey || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(key)) return '';
  for (const dir of voiceSearchDirs(account, msg)) {
    for (const name of voiceCandidateNames(key)) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return await findLocalVoicePathByBoundedIndex(account, name => {
    const lower = name.toLowerCase();
    return lower === key || VOICE_FILE_EXTENSIONS.some(ext => lower === `${key}${ext}`);
  }, msg);
}

function voiceSearchDirs(account, msg) {
  const monthDir = messageMonthDir(msg);
  if (!monthDir) return [];
  const dirs = [
    path.join(account.account_root, 'msg', 'file', monthDir),
    path.join(account.account_root, 'msg', 'voice', monthDir),
    path.join(account.account_root, 'msg', 'audio', monthDir),
  ];
  const conversationDir = conversationStorageDir(msg?.group || msg?.sender);
  if (conversationDir) {
    for (const subdir of ['Voice', 'Audio', 'File']) {
      dirs.push(path.join(account.account_root, 'msg', 'attach', conversationDir, monthDir, subdir));
    }
  }
  return uniqueStrings(dirs);
}

function voiceCandidateNames(key) {
  return uniqueStrings([key, ...VOICE_FILE_EXTENSIONS.map(ext => `${key}${ext}`)]);
}

async function findLocalVoicePathByBoundedIndex(account, predicate, msg) {
  const monthDir = messageMonthDir(msg);
  if (!monthDir) return '';
  const roots = [
    path.join(account.account_root, 'msg', 'file', monthDir),
    path.join(account.account_root, 'msg', 'attach'),
  ];
  const stack = uniqueStrings(roots);
  let visited = 0;
  const deadline = Date.now() + LOCAL_VOICE_INDEX_MAX_MS;
  while (stack.length && visited < LOCAL_VOICE_INDEX_MAX_ENTRIES && Date.now() < deadline) {
    const dir = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      visited++;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (entry.name === monthDir || /^[a-f0-9]{32}$/i.test(entry.name) || ['voice', 'audio', 'file'].includes(lower)) stack.push(full);
      } else if (entry.isFile() && predicate(entry.name)) {
        return full;
      }
      if (visited >= LOCAL_VOICE_INDEX_MAX_ENTRIES || Date.now() >= deadline) break;
    }
  }
  return '';
}

function safeLocalFileName(fileName) {
  return path.basename(String(fileName || '').replace(/\\/g, '/')).trim();
}

function looksLikeFilename(value) {
  return /\.[a-z0-9]{1,12}$/i.test(String(value || ''));
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== '' && value !== undefined && value !== null));
}

async function exists(file) {
  return !!(await fsp.stat(file).catch(() => null));
}

async function readImageDataUrlIfUsable(file, imageKeyCandidates = []) {
  const seen = new Set();
  for (const candidate of [file, ...imageDatSiblingCandidates(file)]) {
    const lower = candidate.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const st = await fsp.stat(candidate).catch(() => null);
    if (!st?.isFile() || st.size > 3 * 1024 * 1024) continue;
    const raw = await fsp.readFile(candidate);
    const decoded = await materializeDecodedImage(extractPlainImage(raw, imageKeyCandidates));
    if (!decoded) continue;
    return {
      mime: decoded.mime,
      data_url: `data:${decoded.mime};base64,${decoded.bytes.toString('base64')}`,
    };
  }
  return null;
}

async function readVideoFrameDataUrlIfUsable(file) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st?.isFile() || st.size > 512 * 1024 * 1024) return null;
  const raw = st.size <= 16 * 1024 * 1024 ? await fsp.readFile(file).catch(() => null) : null;
  const image = raw ? extractPlainImage(raw) : null;
  if (image) {
    return {
      mime: image.mime,
      data_url: `data:${image.mime};base64,${image.bytes.toString('base64')}`,
    };
  }
  const frame = await extractVideoFrameToImage(file);
  if (!frame) return null;
  return {
    mime: frame.mime,
    data_url: `data:${frame.mime};base64,${frame.bytes.toString('base64')}`,
  };
}

async function readAudioDataUrlIfUsable(file) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st?.isFile() || st.size > 8 * 1024 * 1024) return null;
  const mime = audioMimeFromPath(file);
  if (mime === 'audio/mpeg' || mime === 'audio/wav') {
    const raw = await fsp.readFile(file);
    return {
      mime,
      audio_data_url: `data:${mime};base64,${raw.toString('base64')}`,
    };
  }
  const wav = await transcodeAudioToWav(file);
  if (wav && wav.bytes.length <= 8 * 1024 * 1024) {
    return {
      mime: wav.mime,
      converted_from_mime: mime || '',
      audio_data_url: `data:${wav.mime};base64,${wav.bytes.toString('base64')}`,
    };
  }
  if (!mime) return null;
  const raw = await fsp.readFile(file);
  return {
    mime,
    audio_data_url: `data:${mime};base64,${raw.toString('base64')}`,
  };
}

async function materializeDecodedImage(decoded) {
  if (!decoded) return null;
  if (decoded.mime === 'application/x-wxgf') return decodeWxgfToImage(decoded.bytes);
  return decoded;
}

async function findLocalMessageFilePath(account, fileName, msg) {
  const safeName = safeLocalFileName(fileName);
  const monthDir = messageMonthDir(msg);
  if (!safeName || !monthDir) return '';
  const dirs = [
    path.join(account.account_root, 'msg', 'file', monthDir),
    path.join(account.account_root, 'msg', 'video', monthDir),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, safeName);
    if (await exists(candidate)) return candidate;
  }
  return '';
}

async function resolveAttachPath(account, d1, d2, fileName, subdirs = []) {
  if (!d1 || !d2 || !fileName) return '';
  for (const subdir of subdirs) {
    const candidate = path.join(account.account_root, 'msg', 'attach', d1, d2, subdir, String(fileName));
    if (await exists(candidate)) return candidate;
  }
  const direct = path.join(account.account_root, 'msg', 'attach', d1, d2, String(fileName));
  return await exists(direct) ? direct : '';
}

async function findLocalVideoPathByFileKey(account, fileKey, msg) {
  const key = String(fileKey || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(key)) return '';
  const monthDir = messageMonthDir(msg);
  if (!monthDir) return '';
  const dir = path.join(account.account_root, 'msg', 'video', monthDir);
  const candidates = [
    `${key}.mp4`,
    `${key}.mov`,
    `${key}.m4v`,
    `${key}.dat`,
    `${key}_thumb.jpg`,
    `${key}_thumb.jpeg`,
    `${key}_thumb.png`,
  ].map(name => path.join(dir, name));
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return '';
}

function conversationStorageDir(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return crypto.createHash('md5').update(text).digest('hex');
}

function messageMonthDir(msg) {
  const time = Number(msg?.timestamp || 0);
  const date = Number.isFinite(time) && time > 0 ? new Date(time) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function isVideoLike(media = {}) {
  const name = String(media.file_name || '').toLowerCase();
  const ext = String(media.ext || path.extname(name).slice(1)).toLowerCase();
  return ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', '3gp'].includes(ext);
}

function isAudioLike(media = {}) {
  const name = String(media.file_name || '').toLowerCase();
  const ext = String(media.ext || path.extname(name).slice(1)).toLowerCase();
  return ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'webm', 'flac', 'amr', 'silk', 'aud'].includes(ext);
}

function audioMimeFromPath(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.ogg' || ext === '.oga') return 'audio/ogg';
  if (ext === '.webm') return 'audio/webm';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.amr') return 'audio/amr';
  if (ext === '.silk') return 'audio/silk';
  if (ext === '.aud') return 'audio/x-wx-voice';
  return '';
}

async function readImageValidationSamples(file) {
  const samples = [];
  const seen = new Set();
  for (const candidate of imageDatSiblingCandidates(file)) {
    const lower = candidate.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const prefix = await readPrefix(candidate, 64);
    const sample = weChatV4ValidationSample(prefix);
    if (sample) samples.push(sample);
  }
  return samples;
}

function imageDatSiblingCandidates(file) {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const root = name.replace(/(?:_[ht])?\.dat$/i, '');
  return [
    path.join(dir, `${root}_t.dat`),
    path.join(dir, `${root}.dat`),
    path.join(dir, `${root}_h.dat`),
    file,
  ];
}

async function readPrefix(file, bytes) {
  const handle = await fsp.open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buf = Buffer.alloc(bytes);
    const res = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, res.bytesRead);
  } finally {
    await handle.close();
  }
}

async function getImageKeyCandidatesForSamples(samples) {
  const unique = [];
  const seen = new Set();
  for (const sample of samples) {
    if (!Buffer.isBuffer(sample) || sample.length < 16) continue;
    const hex = sample.subarray(0, 16).toString('hex');
    if (seen.has(hex)) continue;
    seen.add(hex);
    unique.push(sample.subarray(0, 16));
  }
  if (!unique.length) return [];
  const sampleHash = crypto.createHash('sha256').update(Buffer.concat(unique)).digest('hex');
  if (imageKeyCache.keys.length && Date.now() - imageKeyCache.at < IMAGE_KEY_CACHE_MS && unique.some(sample => imageKeyCache.keys.some(key => validateImageKeyCandidate(key, [sample])))) {
    return imageKeyCache.keys;
  }
  // Message/image bytes always come from local DB/file copies; this memory scan only finds AES key material.
  try {
    const keys = await scanImageKeysForValidationSamples(unique);
    imageKeyCache = { at: Date.now(), sampleHash, keys };
    return keys;
  } catch {
    return [];
  }
}

async function scanImageKeysForValidationSamples(samples) {
  const keys = [];
  const samplePlan = pickImageKeyValidationSamples(samples);

  addUniqueStrings(keys, await probeImageKeys(samplePlan, false));
  if (!keys.length) addUniqueStrings(keys, await probeImageKeys(samplePlan, true));

  for (const sample of samplePlan) {
    if (keys.some(key => validateImageKeyCandidate(key, [sample]))) continue;
    addUniqueStrings(keys, await probeImageKeys([sample], false));
    if (keys.some(key => validateImageKeyCandidate(key, [sample]))) continue;
    addUniqueStrings(keys, await probeImageKeys([sample], true));
  }
  return keys;
}

async function probeImageKeys(validationSamples, wide) {
  if (!validationSamples.length) return [];
  const result = await probeWxKey({
    scan_all_processes: true,
    scan_image: true,
    image_samples: validationSamples,
    include_image_raw: true,
    ...(wide ? {
      image_include_mapped: true,
      image_scan_max_bytes: 512 * 1024 * 1024,
      image_scan_max_ms: IMAGE_KEY_WIDE_SCAN_MAX_MS,
    } : {
      image_scan_max_ms: IMAGE_KEY_SCAN_MAX_MS,
    }),
  });
  return uniqueStrings(result._raw_image_keys || []);
}

function addUniqueStrings(target, items) {
  const seen = new Set(target);
  for (const item of items || []) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    target.push(item);
  }
}

function pickImageKeyValidationSamples(samples) {
  if (samples.length <= 2) return samples;
  return uniqueBuffers([
    samples[0],
    samples[Math.floor(samples.length / 2)],
    samples[samples.length - 1],
  ]);
}

function uniqueBuffers(buffers) {
  const out = [];
  const seen = new Set();
  for (const item of buffers) {
    if (!Buffer.isBuffer(item)) continue;
    const hex = item.toString('hex');
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push(item);
  }
  return out;
}

function uniqueStrings(items) {
  return [...new Set(items.map(item => String(item || '')).filter(Boolean))];
}

function readProtoFields(buffer) {
  const fields = [];
  let pos = 0;
  while (pos < buffer.length) {
    const tag = readVarint(buffer, pos);
    if (!tag) break;
    pos = tag.next;
    const field = tag.value >> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const value = readVarint(buffer, pos);
      if (!value) break;
      fields.push({ field, wire, value: value.value });
      pos = value.next;
    } else if (wire === 2) {
      const len = readVarint(buffer, pos);
      if (!len) break;
      pos = len.next;
      fields.push({ field, wire, value: buffer.subarray(pos, pos + len.value) });
      pos += len.value;
    } else if (wire === 5) {
      if (pos + 4 > buffer.length) break;
      fields.push({ field, wire, value: buffer.readUInt32LE(pos) });
      pos += 4;
    } else if (wire === 1) {
      if (pos + 8 > buffer.length) break;
      fields.push({ field, wire, value: Number(buffer.readBigUInt64LE(pos)) });
      pos += 8;
    } else {
      break;
    }
  }
  return fields;
}

function readVarint(buffer, pos) {
  let value = 0;
  let shift = 0;
  while (pos < buffer.length && shift < 53) {
    const byte = buffer[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return { value, next: pos };
    shift += 7;
  }
  return null;
}

export const __wxdbInternals = {
  normalizeMessageContent,
  decodeMessagePayload,
  parseChatRoomMemberBuffer,
  readImageDataUrlIfUsable,
  normalizeRawKeyCandidates,
  orderedRawKeyCandidates,
  sqlCipherValidationAttempts,
  validateWeixinV4PageHmac,
  decryptWeixinV4DbToPlaintext,
  weixinV4KeyCandidates,
  formatMessageTime,
  groupPinyinInitial,
  groupSearchFields,
};
