import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';

const XWECHAT_CONFIG_DIR = path.join(process.env.APPDATA || '', 'Tencent', 'xwechat', 'config');
const XWECHAT_APPDATA_DIR = path.join(process.env.APPDATA || '', 'Tencent', 'xwechat');
const MODULE_DB_PATTERNS = [
  'sqlite',
  'SQLite',
  'SQLCipher',
  'sqlcipher',
  'cipher',
  'cipher_use_hmac',
  'cipher_default_use_hmac',
  'cipher_default_page_size',
  'cipher_default_hmac_algorithm',
  'cipher_default_compatibility',
  'cipher_default_plaintext_header_size',
  'cipher_memory_security',
  'cipher_store_pass',
  'cipher_version',
  'cipher_provider',
  'cipher_salt',
  'WCDB',
  'wcdb',
  'PRAGMA',
  'PRAGMA cipher',
  'cipher_compatibility',
  'cipher_default_kdf_iter',
  'cipher_page_size',
  'cipher_hmac_algorithm',
  'cipher_kdf_algorithm',
  'cipher_plaintext_header_size',
  'cipher_migrate',
  'sqlcipher_export',
  'kdf_iter',
  'HMAC_SHA1',
  'HMAC_SHA256',
  'PBKDF2_HMAC_SHA1',
  'PBKDF2_HMAC_SHA256',
  'setKey',
  'sqlite3_key',
  'sqlite3_rekey',
  'sqlite3_rekey_v2',
  'sqlcipher_codec_ctx',
  'sqlcipher_activate',
  'xwechat',
  'db_storage',
  'message_',
  'contact.db',
  'session.db',
  'hardlink.db',
];
const MAX_MODULE_STRING_ADDRESS_HITS = 2048;
const MODULE_CRYPTO_PATTERNS = [
  'AES',
  'AES-256',
  'BCRYPT_AES_ALGORITHM',
  'BCRYPT_SHA1_ALGORITHM',
  'BCRYPT_SHA256_ALGORITHM',
  'BCryptDecrypt',
  'BCryptDeriveKeyPBKDF2',
  'BCryptEncrypt',
  'BCryptGenerateSymmetricKey',
  'BCryptHashData',
  'BCryptOpenAlgorithmProvider',
  'CALG_AES_256',
  'CryptAcquireContext',
  'CryptDeriveKey',
  'CryptHashData',
  'EVP_Decrypt',
  'EVP_Encrypt',
  'HMAC',
  'HKDF',
  'PBKDF',
  'PBKDF2',
  'SHA1',
  'SHA256',
  'SHA512',
  'SQLITE_HAS_CODEC',
  'SqlCipher',
  'cipher_ctx',
  'codec_ctx',
  'db_key',
  'derive',
  'key derivation',
  'mbedtls_aes',
  'mbedtls_md_hmac',
  'openssl',
  'sqlite3_key',
  'sqlite3_key_v2',
  'wxsqlite',
];
const MAX_MODULE_CRYPTO_ADDRESS_HITS = 1024;
const MAX_IMPORT_DLLS = 96;
const MAX_IMPORT_FUNCTIONS_PER_DLL = 64;
const MAX_INTERESTING_IMPORT_FUNCTIONS_PER_DLL = 32;
const MAX_EXPORT_NAMES = 256;
const MAX_STRING_CLUSTERS = 40;
const MAX_STATIC_STRING_XREF_TARGETS = 1200;
const MAX_STATIC_STRING_XREFS = 12000;
const MAX_STATIC_STRING_XREF_BUCKETS = 80;
const MAX_STATIC_STRING_XREF_PATTERNS = 120;
const MAX_STATIC_XREF_FUNCTIONS = 96;
const MAX_STATIC_XREF_CALL_TARGETS = 160;
const MAX_STATIC_XREF_PRIORITY_GRAPH_FUNCTIONS = 16;
const MAX_STATIC_XREF_PRIORITY_FIRST_HOPS = 24;
const MAX_STATIC_XREF_PRIORITY_SECOND_HOPS = 32;
const MAX_STATIC_XREF_CANDIDATE_REGIONS = 32;
const MAX_STATIC_XREF_CANDIDATE_SOURCE_FUNCTIONS = 12;
const MAX_STATIC_XREF_CANDIDATE_REGION_FUNCTIONS = 12;
const MAX_STATIC_XREF_INCOMING_CALLERS = 8;
const MAX_STATIC_XREF_OUTGOING_REGIONS = 12;
const MAX_STATIC_XREF_CRYPTO_BRIDGE_PATHS = 8;
const MAX_STATIC_XREF_CRYPTO_BRIDGE_DEPTH = 3;
const MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS = 12;
const MAX_STATIC_XREF_BRIDGE_FUNCTION_STARTS = 8;
const MAX_STATIC_XREF_BRIDGE_FUNCTION_TARGETS = 16;
const MAX_STATIC_XREF_FUNCTION_XREF_FUNCTIONS = 8;
const MAX_STATIC_XREF_FUNCTION_XREF_NEIGHBOR_BUCKETS = 8;
const STATIC_XREF_FUNCTION_XREF_NEIGHBOR_RADIUS = 0x600;

const MAC_HOME = process.env.HOME || '';
const MAC_XWECHAT_DATA = path.join(MAC_HOME, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files');
const MAC_CONFIG_INI = path.join(MAC_HOME, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', '.wechat_config.ini');

export async function getWeixinProcesses() {
  if (process.platform === 'darwin') {
    return getMacWeixinProcesses();
  }
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    const out = await execFileText('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; Get-CimInstance Win32_Process -Filter "name = \'Weixin.exe\'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
    ]);
    if (!out.trim()) return [];
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map(p => ({
      pid: Number(p.ProcessId),
      path: p.ExecutablePath || '',
      command_line: p.CommandLine || '',
      is_main: isMainWeixinProcess(p.CommandLine || ''),
    })).filter(p => Number.isInteger(p.pid) && p.pid > 0);
  } catch {
    return [];
  }
}

export function isMainWeixinProcess(commandLine) {
  const text = String(commandLine || '');
  return /Weixin\.exe/i.test(text) && !/--type=/i.test(text);
}

export function isMainMacWeixinProcess(commandLine) {
  const text = String(commandLine || '').trim();
  return /\/WeChat$/i.test(text) && !/Sparkle|Updater|Installer/i.test(text);
}

async function getMacWeixinProcesses() {
  try {
    const out = await execFileText('pgrep', ['-f', '/WeChat$']);
    if (!out.trim()) return [];
    const pids = out.trim().split(/\s+/).map(s => parseInt(s.trim())).filter(n => Number.isFinite(n) && n > 0);
    const results = [];
    for (const pid of pids) {
      try {
        const cmdline = await execFileText('ps', ['-p', String(pid), '-o', 'comm=']);
        const p = cmdline.trim() || '';
        results.push({ pid, path: p, command_line: p, is_main: isMainMacWeixinProcess(p) });
      } catch {}
    }
    return results.filter(p => p.is_main);
  } catch {
    return [];
  }
}

export async function readConfiguredDataRoot() {
  if (process.platform === 'darwin') {
    try {
      const text = await fsp.readFile(MAC_CONFIG_INI, 'utf-8');
      const line = text.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (line && path.isAbsolute(line)) return line;
    } catch {}
    try {
      const st = await fsp.stat(MAC_XWECHAT_DATA);
      if (st.isDirectory()) return MAC_XWECHAT_DATA;
    } catch {}
    return '';
  }
  const candidates = [];
  try {
    const files = await fsp.readdir(XWECHAT_CONFIG_DIR, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.ini')) continue;
      const file = path.join(XWECHAT_CONFIG_DIR, entry.name);
      const text = await fsp.readFile(file, 'utf-8').catch(() => '');
      const line = text.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (line && path.isAbsolute(line)) candidates.push(line);
    }
  } catch {}
  return candidates[0] || '';
}

export async function discoverDataRoots() {
  const roots = [];
  const configured = await readConfiguredDataRoot();
  if (configured) roots.push(configured);
  if (process.platform === 'darwin') {
    roots.push(MAC_XWECHAT_DATA);
  } else {
    roots.push(
      path.join(process.env.APPDATA || '', 'Tencent', 'xwechat'),
      path.join(process.env.USERPROFILE || '', 'Documents', 'WeChat Files'),
    );
  }

  const existing = [];
  const seen = new Set();
  for (const root of roots) {
    if (!root || seen.has(root.toLowerCase())) continue;
    seen.add(root.toLowerCase());
    const st = await fsp.stat(root).catch(() => null);
    if (st?.isDirectory()) existing.push(root);
  }
  return existing;
}

export async function discoverWxAccounts() {
  const dataRoots = await discoverDataRoots();
  const accounts = [];
  for (const root of dataRoots) {
    // On macOS the root itself may be xwechat_files; on Windows it contains xwechat_files/
    let xwechatFiles = path.join(root, 'xwechat_files');
    let st = await fsp.stat(xwechatFiles).catch(() => null);
    if (!st?.isDirectory()) {
      // Try using root directly (macOS layout where root IS xwechat_files)
      xwechatFiles = root;
      st = await fsp.stat(xwechatFiles).catch(() => null);
      if (!st?.isDirectory()) continue;
    }
    const accountDirs = await fsp.readdir(xwechatFiles, { withFileTypes: true }).catch(() => []);
    for (const entry of accountDirs) {
      if (!entry.isDirectory()) continue;
      if (entry.name.toLowerCase() === 'all_users') continue;
      const accountRoot = path.join(xwechatFiles, entry.name);
      const dbStorage = path.join(accountRoot, 'db_storage');
      const dbStat = await fsp.stat(dbStorage).catch(() => null);
      if (!dbStat?.isDirectory()) continue;
      const summary = await summarizeDbStorage(dbStorage);
      accounts.push({
        id: entry.name,
        wxid: accountNameToWxid(entry.name),
        display_name: accountNameToDisplay(entry.name),
        account_root: accountRoot,
        db_storage: dbStorage,
        last_write_time: dbStat.mtime.toISOString(),
        summary,
      });
    }
  }
  accounts.sort((a, b) => new Date(b.summary.last_write_time || b.last_write_time) - new Date(a.summary.last_write_time || a.last_write_time));
  return accounts;
}

export async function summarizeDbStorage(dbStorage) {
  const categories = [];
  let totalBytes = 0;
  let last = 0;
  const dirs = await fsp.readdir(dbStorage, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const full = path.join(dbStorage, dir.name);
    const files = (await fsp.readdir(full, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.db'));
    let categoryBytes = 0;
    let categoryLast = 0;
    for (const file of files) {
      const st = await fsp.stat(path.join(full, file.name)).catch(() => null);
      if (!st) continue;
      categoryBytes += st.size;
      categoryLast = Math.max(categoryLast, st.mtimeMs);
    }
    totalBytes += categoryBytes;
    last = Math.max(last, categoryLast);
    categories.push({
      name: dir.name,
      db_count: files.length,
      bytes: categoryBytes,
      last_write_time: categoryLast ? new Date(categoryLast).toISOString() : null,
    });
  }
  return {
    categories,
    db_count: categories.reduce((sum, c) => sum + c.db_count, 0),
    bytes: totalBytes,
    last_write_time: last ? new Date(last).toISOString() : null,
  };
}

export async function discoverWeixinEnvironment() {
  const [processes, data_roots, accounts] = await Promise.all([
    getWeixinProcesses(),
    discoverDataRoots(),
    discoverWxAccounts(),
  ]);
  const main = processes.find(p => p.is_main) || null;
  return {
    running: processes.length > 0,
    process_count: processes.length,
    main_process: main,
    processes,
    data_roots,
    accounts,
    message: weixinEnvironmentMessage({ processes, accounts }),
  };
}

function weixinProcessLabel() {
  return process.platform === 'darwin' ? 'Mac 微信' : 'Weixin.exe';
}

function weixinEnvironmentMessage({ processes = [], accounts = [] } = {}) {
  const label = weixinProcessLabel();
  if (accounts.length) {
    return processes.length
      ? `已检测到 ${accounts.length} 个微信 v4 数据目录。`
      : `已检测到 ${accounts.length} 个微信 v4 数据目录；当前未检测到正在运行的 ${label}。`;
  }
  if (processes.length) return `已检测到 ${label}，但暂未发现 db_storage 数据目录。`;
  return process.platform === 'darwin'
    ? '未检测到 Mac 微信，也暂未发现微信 v4 数据目录。'
    : '未检测到 Weixin.exe，请先登录微信。';
}

export async function getWeixinBinaryEvidence() {
  const processes = await getWeixinProcesses();
  const main = processes.find(p => p.is_main) || null;
  if (!main?.path) {
    return {
      ok: false,
      running: processes.length > 0,
      process_count: processes.length,
      captured_at: new Date().toISOString(),
      reason: processes.length
        ? (process.platform === 'darwin'
          ? '未识别到主 WeChat 进程路径。'
          : '未识别到主 Weixin.exe 进程路径。')
        : (process.platform === 'darwin'
          ? '未检测到 Mac 微信。'
          : '未检测到 Weixin.exe。'),
    };
  }
  const file = await hashFileSha256(main.path);
  return {
    ok: true,
    running: true,
    process_count: processes.length,
    captured_at: new Date().toISOString(),
    pid: main.pid,
    path: main.path,
    ...file,
  };
}

async function hashFileSha256(file) {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error(`${weixinProcessLabel()} path is not a file`);
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return {
    bytes: st.size,
    modified_at: st.mtime.toISOString(),
    sha256: hash.digest('hex'),
  };
}

export async function getWeixinModuleEvidence() {
  if (process.platform !== 'win32') {
    const processes = await getWeixinProcesses();
    return {
      ok: false,
      running: processes.length > 0,
      process_count: processes.length,
      reason: 'module evidence is only available on Windows',
    };
  }
  const processes = await getWeixinProcesses();
  const main = processes.find(p => p.is_main) || null;
  if (!main?.pid) {
    return {
      ok: false,
      running: processes.length > 0,
      process_count: processes.length,
      captured_at: new Date().toISOString(),
      reason: processes.length ? '未识别到主 Weixin.exe 进程。' : '未检测到 Weixin.exe。',
    };
  }
  try {
    const modules = await listProcessModules(main.pid);
    const installRoot = main.path ? path.dirname(main.path).toLowerCase() : '';
    const weixinModules = modules
      .filter(mod => isWeixinOwnedModule(mod.file_name, installRoot))
      .filter(mod => isInterestingDbModuleName(mod.name))
      .slice(0, 24);
    const scanned = [];
    for (const mod of weixinModules) {
      const hits = await scanModuleDbStringHits(mod.file_name, mod).catch(e => ({ error: e?.message || String(e) }));
      scanned.push({
        ...mod,
        db_string_hit_total: hits.total || 0,
        db_string_hits: hits.hits || {},
        db_string_address_hits: hits.address_hits || [],
        crypto_string_hit_total: hits.crypto_string_hit_total || 0,
        crypto_string_hits: hits.crypto_string_hits || {},
        crypto_string_address_hits: hits.crypto_address_hits || [],
        crypto_string_sections: hits.crypto_string_sections || {},
        pe_import_summary: hits.pe_import_summary || null,
        pe_export_summary: hits.pe_export_summary || null,
        string_cluster_summary: hits.string_cluster_summary || [],
        static_string_xref_summary: hits.static_string_xref_summary || null,
        ...(hits.error ? { scan_error: hits.error } : {}),
      });
    }
    scanned.sort((a, b) => b.db_string_hit_total - a.db_string_hit_total || a.name.localeCompare(b.name));
    return {
      ok: true,
      running: true,
      process_count: processes.length,
      captured_at: new Date().toISOString(),
      main_pid: main.pid,
      main_path: main.path || '',
      module_count: modules.length,
      db_pattern_set: MODULE_DB_PATTERNS,
      db_related_modules: scanned,
    };
  } catch (e) {
    return {
      ok: false,
      running: true,
      process_count: processes.length,
      captured_at: new Date().toISOString(),
      main_pid: main.pid,
      main_path: main.path || '',
      error: e?.message || String(e),
    };
  }
}

async function listProcessModules(pid) {
  const out = await execFileText('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; Get-Process -Id ${Number(pid)} | Select-Object -ExpandProperty Modules | Select-Object ModuleName,FileName,@{Name='BaseAddress';Expression={$_.BaseAddress.ToInt64()}},ModuleMemorySize | ConvertTo-Json -Compress`,
  ]);
  if (!out.trim()) return [];
  const parsed = JSON.parse(out);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map(mod => ({
    name: String(mod.ModuleName || ''),
    file_name: String(mod.FileName || ''),
    base_address: Number(mod.BaseAddress || 0),
    base_address_hex: numberToHex(Number(mod.BaseAddress || 0)),
    module_memory_size: Number(mod.ModuleMemorySize || 0),
  })).filter(mod => mod.name && mod.file_name);
}

function isWeixinOwnedModule(fileName, installRoot) {
  const file = String(fileName || '').toLowerCase();
  if (!file) return false;
  if (installRoot && file.startsWith(installRoot)) return true;
  return /[\\/]weixin[\\/]/i.test(String(fileName || ''));
}

function isInterestingDbModuleName(name) {
  return /weixin|wx|wc|sqlite|sql|cipher|db|storage|mm|owl|ilink/i.test(String(name || ''));
}

async function scanModuleDbStringHits(file, mod = {}) {
  const st = await fsp.stat(file);
  if (!st.isFile()) return { total: 0, hits: {} };
  if (st.size > 260 * 1024 * 1024) return { total: 0, hits: {}, error: 'module_too_large' };
  const buf = await fsp.readFile(file);
  const pe = readPeSections(buf);
  const baseAddress = Number(mod.base_address || 0);
  const hits = {};
  const addressHits = [];
  const cryptoAddressHits = [];
  const cryptoHits = {};
  let total = 0;
  for (const pattern of MODULE_DB_PATTERNS) {
    const asciiOffsets = findBufferPatternOffsets(buf, Buffer.from(pattern, 'ascii'));
    const utf16Offsets = findBufferPatternOffsets(buf, Buffer.from(pattern, 'utf16le'));
    const count = asciiOffsets.length + utf16Offsets.length;
    if (count) {
      const key = pattern.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      hits[key] = (hits[key] || 0) + count;
      total += count;
      for (const offset of asciiOffsets) {
        addModuleStringAddressHit(addressHits, pe, baseAddress, pattern, 'ascii', offset);
      }
      for (const offset of utf16Offsets) {
        addModuleStringAddressHit(addressHits, pe, baseAddress, pattern, 'utf16le', offset);
      }
    }
  }
  let cryptoTotal = 0;
  for (const pattern of MODULE_CRYPTO_PATTERNS) {
    const asciiOffsets = findBufferPatternOffsets(buf, Buffer.from(pattern, 'ascii'));
    const utf16Offsets = findBufferPatternOffsets(buf, Buffer.from(pattern, 'utf16le'));
    const count = asciiOffsets.length + utf16Offsets.length;
    if (!count) continue;
    const key = pattern.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    cryptoHits[key] = (cryptoHits[key] || 0) + count;
    cryptoTotal += count;
    for (const offset of asciiOffsets) {
      addModuleStringAddressHit(cryptoAddressHits, pe, baseAddress, pattern, 'ascii', offset, MAX_MODULE_CRYPTO_ADDRESS_HITS);
    }
    for (const offset of utf16Offsets) {
      addModuleStringAddressHit(cryptoAddressHits, pe, baseAddress, pattern, 'utf16le', offset, MAX_MODULE_CRYPTO_ADDRESS_HITS);
    }
  }
  const importSummary = summarizePeImports(buf, pe);
  const exportSummary = summarizePeExports(buf, pe);
  return {
    total,
    hits,
    address_hits: addressHits,
    crypto_string_hit_total: cryptoTotal,
    crypto_string_hits: cryptoHits,
    crypto_address_hits: cryptoAddressHits,
    crypto_string_sections: summarizeStringSections(cryptoAddressHits),
    pe_import_summary: importSummary,
    pe_export_summary: exportSummary,
    string_cluster_summary: summarizeStringClusters(addressHits, cryptoAddressHits),
    static_string_xref_summary: summarizeStaticStringXrefs(buf, pe, addressHits, cryptoAddressHits),
  };
}

function findBufferPatternOffsets(buf, pattern) {
  const offsets = [];
  if (!pattern.length) return offsets;
  let pos = buf.indexOf(pattern);
  while (pos >= 0) {
    offsets.push(pos);
    pos = buf.indexOf(pattern, pos + 1);
  }
  return offsets;
}

function addModuleStringAddressHit(out, pe, baseAddress, pattern, encoding, fileOffset, limit = MAX_MODULE_STRING_ADDRESS_HITS) {
  if (out.length >= limit) return;
  const mapped = fileOffsetToRva(pe, fileOffset);
  if (!mapped) return;
  const virtualAddress = baseAddress && mapped.rva >= 0 ? baseAddress + mapped.rva : 0;
  out.push({
    pattern,
    encoding,
    file_offset: fileOffset,
    file_offset_hex: numberToHex(fileOffset),
    rva: mapped.rva,
    rva_hex: numberToHex(mapped.rva),
    virtual_address: virtualAddress,
    virtual_address_hex: numberToHex(virtualAddress),
    section: mapped.section,
  });
}

function readPeSections(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x100) return { sections: [], size_of_headers: 0 };
  if (buf.readUInt16LE(0) !== 0x5a4d) return { sections: [], size_of_headers: 0 };
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 0x108 > buf.length) return { sections: [], size_of_headers: 0 };
  if (buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return { sections: [], size_of_headers: 0 };
  const numberOfSections = buf.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = buf.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  const optionalMagic = optionalHeaderOffset + 2 <= buf.length ? buf.readUInt16LE(optionalHeaderOffset) : 0;
  const isPe64 = optionalMagic === 0x20b;
  const sizeOfHeaders = optionalHeaderOffset + 64 <= buf.length ? buf.readUInt32LE(optionalHeaderOffset + 60) : 0;
  const numberOfRvaAndSizesOffset = optionalHeaderOffset + (isPe64 ? 108 : 92);
  const dataDirectoryOffset = optionalHeaderOffset + (isPe64 ? 112 : 96);
  const numberOfRvaAndSizes = numberOfRvaAndSizesOffset + 4 <= buf.length ? buf.readUInt32LE(numberOfRvaAndSizesOffset) : 0;
  const dataDirectories = {};
  const directoryNames = ['export', 'import', 'resource', 'exception', 'certificate', 'base_relocation', 'debug', 'architecture', 'global_ptr', 'tls', 'load_config', 'bound_import', 'iat', 'delay_import', 'clr_runtime'];
  const directoryCount = Math.min(numberOfRvaAndSizes, directoryNames.length);
  for (let i = 0; i < directoryCount; i++) {
    const off = dataDirectoryOffset + i * 8;
    if (off + 8 > buf.length) break;
    const rva = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    dataDirectories[directoryNames[i]] = { rva, size };
  }
  const sectionOffset = optionalHeaderOffset + optionalHeaderSize;
  const sections = [];
  for (let i = 0; i < numberOfSections; i++) {
    const off = sectionOffset + i * 40;
    if (off + 40 > buf.length) break;
    const nul = buf.indexOf(0, off);
    const nameEnd = nul >= off && nul < off + 8 ? nul : off + 8;
    const name = buf.toString('ascii', off, nameEnd);
    const virtual_size = buf.readUInt32LE(off + 8);
    const virtual_address = buf.readUInt32LE(off + 12);
    const size_of_raw_data = buf.readUInt32LE(off + 16);
    const pointer_to_raw_data = buf.readUInt32LE(off + 20);
    const characteristics = buf.readUInt32LE(off + 36);
    sections.push({ name, virtual_size, virtual_address, size_of_raw_data, pointer_to_raw_data, characteristics });
  }
  return { sections, size_of_headers: sizeOfHeaders, is_pe64: isPe64, optional_magic: optionalMagic, data_directories: dataDirectories };
}

function fileOffsetToRva(pe, fileOffset) {
  const offset = Number(fileOffset || 0);
  if (pe?.size_of_headers && offset >= 0 && offset < pe.size_of_headers) {
    return { rva: offset, section: 'headers' };
  }
  for (const section of pe?.sections || []) {
    const rawStart = Number(section.pointer_to_raw_data || 0);
    const rawSize = Number(section.size_of_raw_data || 0);
    if (!rawSize || offset < rawStart || offset >= rawStart + rawSize) continue;
    return {
      rva: Number(section.virtual_address || 0) + (offset - rawStart),
      section: section.name || '',
    };
  }
  return null;
}

function rvaToFileOffset(pe, rva) {
  const value = Number(rva || 0);
  if (!Number.isFinite(value) || value < 0) return -1;
  if (pe?.size_of_headers && value >= 0 && value < pe.size_of_headers) return value;
  for (const section of pe?.sections || []) {
    const virtualStart = Number(section.virtual_address || 0);
    const virtualSize = Math.max(Number(section.virtual_size || 0), Number(section.size_of_raw_data || 0));
    if (!virtualSize || value < virtualStart || value >= virtualStart + virtualSize) continue;
    const rawStart = Number(section.pointer_to_raw_data || 0);
    const rawOffset = rawStart + (value - virtualStart);
    const rawSize = Number(section.size_of_raw_data || 0);
    if (rawOffset < rawStart || rawOffset >= rawStart + rawSize) return -1;
    return rawOffset;
  }
  return -1;
}

function summarizePeImports(buf, pe) {
  const dir = pe?.data_directories?.import;
  const offset = dir?.rva ? rvaToFileOffset(pe, dir.rva) : -1;
  if (offset < 0 || offset + 20 > buf.length) {
    return {
      dll_count: 0,
      function_count: 0,
      interesting_dlls: [],
      interesting_function_total: 0,
      crypto_api_import_count: 0,
      db_api_import_count: 0,
    };
  }
  const dlls = [];
  let dllCount = 0;
  let functionCount = 0;
  let cryptoApiImportCount = 0;
  let dbApiImportCount = 0;
  for (let descriptorOffset = offset, descriptorIndex = 0; descriptorIndex < MAX_IMPORT_DLLS; descriptorIndex++, descriptorOffset += 20) {
    if (descriptorOffset + 20 > buf.length) break;
    const originalFirstThunk = buf.readUInt32LE(descriptorOffset);
    const nameRva = buf.readUInt32LE(descriptorOffset + 12);
    const firstThunk = buf.readUInt32LE(descriptorOffset + 16);
    if (!originalFirstThunk && !nameRva && !firstThunk) break;
    const dllName = readCStringAtRva(buf, pe, nameRva, 160);
    if (!dllName) continue;
    dllCount++;
    const thunkRva = originalFirstThunk || firstThunk;
    const functions = readImportThunkNames(buf, pe, thunkRva);
    functionCount += functions.length;
    const interestingFunctions = functions.filter(name => isInterestingImportOrExportName(name));
    cryptoApiImportCount += functions.filter(name => isCryptoImportOrExportName(name)).length;
    dbApiImportCount += functions.filter(name => isDbImportOrExportName(name)).length;
    if (isInterestingImportDll(dllName) || interestingFunctions.length) {
      dlls.push({
        dll: dllName,
        function_count: functions.length,
        interesting_functions: interestingFunctions.slice(0, MAX_INTERESTING_IMPORT_FUNCTIONS_PER_DLL),
        sample_functions: functions.slice(0, MAX_IMPORT_FUNCTIONS_PER_DLL),
      });
    }
  }
  const interestingFunctionTotal = dlls.reduce((sum, item) => sum + item.interesting_functions.length, 0);
  return {
    dll_count: dllCount,
    interesting_dll_count: dlls.length,
    function_count: functionCount,
    interesting_dlls: dlls,
    interesting_function_total: interestingFunctionTotal,
    crypto_api_import_count: cryptoApiImportCount,
    db_api_import_count: dbApiImportCount,
  };
}

function readImportThunkNames(buf, pe, thunkRva) {
  const out = [];
  const entrySize = pe?.is_pe64 ? 8 : 4;
  const ordinalFlag = pe?.is_pe64 ? 0x8000000000000000n : 0x80000000n;
  let off = rvaToFileOffset(pe, thunkRva);
  if (off < 0) return out;
  for (let i = 0; i < 4096; i++, off += entrySize) {
    if (off + entrySize > buf.length) break;
    const value = pe?.is_pe64 ? buf.readBigUInt64LE(off) : BigInt(buf.readUInt32LE(off));
    if (value === 0n) break;
    if ((value & ordinalFlag) !== 0n) {
      out.push(`#${Number(value & 0xffffn)}`);
      continue;
    }
    const nameOffset = rvaToFileOffset(pe, Number(value));
    if (nameOffset < 0 || nameOffset + 2 >= buf.length) continue;
    const name = readCString(buf, nameOffset + 2, 240);
    if (name) out.push(name);
  }
  return out;
}

function summarizePeExports(buf, pe) {
  const dir = pe?.data_directories?.export;
  const offset = dir?.rva ? rvaToFileOffset(pe, dir.rva) : -1;
  if (offset < 0 || offset + 40 > buf.length) {
    return {
      named_export_count: 0,
      interesting_export_count: 0,
      interesting_export_names: [],
    };
  }
  const numberOfNames = buf.readUInt32LE(offset + 24);
  const addressOfNamesRva = buf.readUInt32LE(offset + 32);
  const namesOffset = rvaToFileOffset(pe, addressOfNamesRva);
  if (namesOffset < 0) {
    return {
      named_export_count: 0,
      interesting_export_count: 0,
      interesting_export_names: [],
    };
  }
  const names = [];
  for (let i = 0; i < Math.min(numberOfNames, MAX_EXPORT_NAMES); i++) {
    const nameRvaOffset = namesOffset + i * 4;
    if (nameRvaOffset + 4 > buf.length) break;
    const name = readCStringAtRva(buf, pe, buf.readUInt32LE(nameRvaOffset), 240);
    if (name && isInterestingImportOrExportName(name)) names.push(name);
  }
  return {
    named_export_count: numberOfNames,
    interesting_export_count: names.length,
    interesting_export_names: names,
  };
}

function readCStringAtRva(buf, pe, rva, maxBytes = 256) {
  const offset = rvaToFileOffset(pe, rva);
  return offset >= 0 ? readCString(buf, offset, maxBytes) : '';
}

function readCString(buf, offset, maxBytes = 256) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= buf.length) return '';
  const endLimit = Math.min(buf.length, offset + maxBytes);
  let end = offset;
  while (end < endLimit && buf[end] !== 0) end++;
  if (end === offset) return '';
  return buf.toString('utf-8', offset, end).replace(/[^\x20-\x7E]/g, '').trim();
}

function isInterestingImportDll(name) {
  return /bcrypt|crypt|ncrypt|advapi|sqlite|sqlcipher|wcdb|crypto|ssl|openssl|libsodium|mbedtls/i.test(String(name || ''));
}

function isInterestingImportOrExportName(name) {
  return isCryptoImportOrExportName(name) || isDbImportOrExportName(name);
}

function isCryptoImportOrExportName(name) {
  return /bcrypt|crypt|aes|sha1|sha256|sha512|hmac|pbkdf|hkdf|derive|decrypt|encrypt|evp|mbedtls|openssl|sodium/i.test(String(name || ''));
}

function isDbImportOrExportName(name) {
  return /sqlite|sqlcipher|wcdb|codec|cipher|rekey|sqlite3_key|xwechat|db_storage/i.test(String(name || ''));
}

function summarizeStringSections(addressHits) {
  const sections = {};
  for (const hit of addressHits || []) {
    const key = hit.section || 'unknown';
    sections[key] = (sections[key] || 0) + 1;
  }
  return sections;
}

function summarizeStringClusters(dbAddressHits, cryptoAddressHits) {
  const buckets = new Map();
  for (const hit of dbAddressHits || []) addStringClusterHit(buckets, hit, 'db');
  for (const hit of cryptoAddressHits || []) addStringClusterHit(buckets, hit, 'crypto');
  return [...buckets.values()]
    .map(item => ({
      section: item.section,
      rva_bucket_hex: numberToHex(item.rva_bucket),
      hit_count: item.hit_count,
      db_hit_count: item.db_hit_count,
      crypto_hit_count: item.crypto_hit_count,
      patterns: [...item.patterns].sort().slice(0, 24),
      db_patterns: [...item.db_patterns].sort().slice(0, 16),
      crypto_patterns: [...item.crypto_patterns].sort().slice(0, 16),
    }))
    .filter(item => item.db_hit_count > 0 && item.crypto_hit_count > 0)
    .sort((a, b) => b.crypto_hit_count - a.crypto_hit_count || b.db_hit_count - a.db_hit_count || b.hit_count - a.hit_count)
    .slice(0, MAX_STRING_CLUSTERS);
}

function summarizeStaticStringXrefs(buf, pe, dbAddressHits, cryptoAddressHits) {
  const targets = buildStaticStringXrefTargets(dbAddressHits, cryptoAddressHits);
  if (!targets.length) {
    return {
      scan_mode: 'best_effort_x64_rip_relative',
      source_bucket_bytes: 0x1000,
      source_region_bytes: 0x10000,
      target_count: 0,
      xref_count: 0,
      executable_section_count: executablePeSections(pe).length,
      source_buckets: [],
      source_regions: [],
      function_summary: null,
      target_patterns: [],
      mixed_source_buckets: [],
      mixed_source_regions: [],
    };
  }
  const targetBuckets = bucketStaticStringTargets(targets);
  const xrefs = [];
  for (const section of executablePeSections(pe)) {
    if (xrefs.length >= MAX_STATIC_STRING_XREFS) break;
    const rawStart = Number(section.pointer_to_raw_data || 0);
    const rawSize = Number(section.size_of_raw_data || 0);
    const rawEnd = Math.min(buf.length, rawStart + rawSize);
    if (!rawSize || rawStart < 0 || rawStart >= buf.length) continue;
    const sectionRva = Number(section.virtual_address || 0);
    for (let raw = rawStart; raw + 7 <= rawEnd && xrefs.length < MAX_STATIC_STRING_XREFS; raw++) {
      const sourceRva = sectionRva + (raw - rawStart);
      const targetRva = decodeRipRelativeTargetRva(buf, raw, sourceRva);
      if (!targetRva) continue;
      const target = findStaticStringTarget(targetBuckets, targetRva);
      if (!target) continue;
      xrefs.push({
        source_section: section.name || 'unknown',
        source_rva: sourceRva,
        source_raw_offset: raw,
        source_rva_bucket: Math.floor(sourceRva / 0x1000) * 0x1000,
        target_rva_bucket: Math.floor(target.start / 0x1000) * 0x1000,
        target_section: target.section || 'unknown',
        pattern: target.pattern,
        kind: target.kind,
      });
    }
  }
  return summarizeStaticStringXrefHits(buf, pe, targets, xrefs, executablePeSections(pe).length);
}

function buildStaticStringXrefTargets(dbAddressHits, cryptoAddressHits) {
  const dbMap = new Map();
  const cryptoMap = new Map();
  for (const hit of dbAddressHits || []) addStaticStringTarget(dbMap, hit, 'db');
  for (const hit of cryptoAddressHits || []) addStaticStringTarget(cryptoMap, hit, 'crypto');
  const sortTargets = targets => [...targets.values()]
    .sort((a, b) => patternXrefWeight(b.pattern) - patternXrefWeight(a.pattern) || a.start - b.start);
  const dbTargets = sortTargets(dbMap);
  const cryptoTargets = sortTargets(cryptoMap);
  const dbLimit = Math.min(dbTargets.length, Math.ceil(MAX_STATIC_STRING_XREF_TARGETS * 0.58));
  const cryptoLimit = Math.min(cryptoTargets.length, MAX_STATIC_STRING_XREF_TARGETS - dbLimit);
  const selected = [...dbTargets.slice(0, dbLimit), ...cryptoTargets.slice(0, cryptoLimit)];
  if (selected.length < MAX_STATIC_STRING_XREF_TARGETS) {
    const used = new Set(selected.map(target => `${target.kind}:${target.start}:${target.pattern}:${target.encoding}`));
    for (const target of [...dbTargets.slice(dbLimit), ...cryptoTargets.slice(cryptoLimit)]) {
      const key = `${target.kind}:${target.start}:${target.pattern}:${target.encoding}`;
      if (used.has(key)) continue;
      selected.push(target);
      used.add(key);
      if (selected.length >= MAX_STATIC_STRING_XREF_TARGETS) break;
    }
  }
  return selected;
}

function addStaticStringTarget(map, hit, kind) {
  const start = Number(hit?.rva || 0);
  if (!Number.isFinite(start) || start <= 0) return;
  const pattern = String(hit.pattern || '').slice(0, 96);
  const encoding = hit.encoding === 'utf16le' ? 'utf16le' : 'ascii';
  const byteLength = encoding === 'utf16le' ? pattern.length * 2 : pattern.length;
  const end = start + Math.max(2, Math.min(192, byteLength + 2));
  const key = `${start}:${kind}:${pattern}:${encoding}`;
  if (map.has(key)) return;
  map.set(key, {
    start,
    end,
    section: hit.section || 'unknown',
    pattern,
    encoding,
    kind,
  });
}

function bucketStaticStringTargets(targets) {
  const buckets = new Map();
  for (const target of targets) {
    const startBucket = Math.floor(target.start / 0x1000);
    const endBucket = Math.floor(Math.max(target.start, target.end - 1) / 0x1000);
    for (let bucket = startBucket; bucket <= endBucket; bucket++) {
      const list = buckets.get(bucket) || [];
      list.push(target);
      buckets.set(bucket, list);
    }
  }
  return buckets;
}

function findStaticStringTarget(targetBuckets, rva) {
  const bucket = Math.floor(Number(rva || 0) / 0x1000);
  for (const target of targetBuckets.get(bucket) || []) {
    if (rva >= target.start && rva < target.end) return target;
  }
  return null;
}

function executablePeSections(pe) {
  return (pe?.sections || []).filter(section => {
    const characteristics = Number(section.characteristics || 0);
    return (characteristics & 0x20000000) !== 0 || /^\.text/i.test(String(section.name || ''));
  });
}

function decodeRipRelativeTargetRva(buf, rawOffset, sourceRva) {
  let i = rawOffset;
  let prefixCount = 0;
  while (i < buf.length && prefixCount < 4 && isInstructionPrefix(buf[i])) {
    i++;
    prefixCount++;
  }
  if (i + 6 > buf.length) return 0;
  const opcode = buf[i];
  if (isSimpleRipRelativeOpcode(opcode)) {
    return decodeRipRelativeModRmTarget(buf, i + 1, sourceRva, (i - rawOffset) + 2 + 4);
  }
  if (opcode === 0x0f && i + 7 <= buf.length && isTwoByteRipRelativeOpcode(buf[i + 1])) {
    return decodeRipRelativeModRmTarget(buf, i + 2, sourceRva, (i - rawOffset) + 3 + 4);
  }
  return 0;
}

function decodeRipRelativeModRmTarget(buf, modRmOffset, sourceRva, instrLen) {
  if (modRmOffset + 5 > buf.length) return 0;
  const modrm = buf[modRmOffset];
  if ((modrm & 0xc7) !== 0x05) return 0;
  const disp = buf.readInt32LE(modRmOffset + 1);
  const target = Number(sourceRva || 0) + Number(instrLen || 0) + disp;
  return target > 0 ? target : 0;
}

function isInstructionPrefix(value) {
  return (value >= 0x40 && value <= 0x4f)
    || value === 0x66
    || value === 0x67
    || value === 0x2e
    || value === 0x36
    || value === 0x3e
    || value === 0x26
    || value === 0x64
    || value === 0x65;
}

function isSimpleRipRelativeOpcode(opcode) {
  return opcode === 0x8d
    || opcode === 0x8b
    || opcode === 0x8a
    || opcode === 0x39
    || opcode === 0x3b
    || opcode === 0x85
    || opcode === 0x89
    || opcode === 0x88;
}

function isTwoByteRipRelativeOpcode(opcode) {
  return opcode === 0xb6
    || opcode === 0xb7
    || opcode === 0xbe
    || opcode === 0xbf
    || opcode === 0x84
    || opcode === 0x85;
}

function summarizeStaticStringXrefHits(buf, pe, targets, xrefs, executableSectionCount) {
  const sourceBuckets = new Map();
  const patternBuckets = new Map();
  for (const xref of xrefs) {
    const sourceKey = `${xref.source_section}:${xref.source_rva_bucket}`;
    let source = sourceBuckets.get(sourceKey);
    if (!source) {
      source = {
        source_section: xref.source_section,
        source_rva_bucket: xref.source_rva_bucket,
        xref_count: 0,
        db_xref_count: 0,
        crypto_xref_count: 0,
        target_patterns: new Set(),
        target_sections: new Set(),
        target_rva_buckets: new Set(),
      };
      sourceBuckets.set(sourceKey, source);
    }
    source.xref_count++;
    if (xref.kind === 'crypto') source.crypto_xref_count++;
    else source.db_xref_count++;
    source.target_patterns.add(`${xref.kind}:${xref.pattern}`);
    source.target_sections.add(xref.target_section);
    source.target_rva_buckets.add(xref.target_rva_bucket);

    const patternKey = `${xref.kind}:${xref.pattern}`;
    let pattern = patternBuckets.get(patternKey);
    if (!pattern) {
      pattern = {
        kind: xref.kind,
        pattern: xref.pattern,
        xref_count: 0,
        source_sections: new Set(),
        source_rva_buckets: new Set(),
        target_rva_buckets: new Set(),
      };
      patternBuckets.set(patternKey, pattern);
    }
    pattern.xref_count++;
    pattern.source_sections.add(xref.source_section);
    pattern.source_rva_buckets.add(xref.source_rva_bucket);
    pattern.target_rva_buckets.add(xref.target_rva_bucket);
  }
  const buckets = [...sourceBuckets.values()]
    .map(item => ({
      source_section: item.source_section,
      source_rva_bucket_hex: numberToHex(item.source_rva_bucket),
      xref_count: item.xref_count,
      db_xref_count: item.db_xref_count,
      crypto_xref_count: item.crypto_xref_count,
      target_patterns: [...item.target_patterns].sort().slice(0, 24),
      target_sections: [...item.target_sections].sort(),
      target_rva_buckets: [...item.target_rva_buckets].sort((a, b) => a - b).slice(0, 16).map(numberToHex),
    }))
    .sort((a, b) => b.xref_count - a.xref_count || b.crypto_xref_count - a.crypto_xref_count)
    .slice(0, MAX_STATIC_STRING_XREF_BUCKETS);
  const patterns = [...patternBuckets.values()]
    .map(item => ({
      kind: item.kind,
      pattern: item.pattern,
      xref_count: item.xref_count,
      source_sections: [...item.source_sections].sort(),
      source_bucket_count: item.source_rva_buckets.size,
      target_bucket_count: item.target_rva_buckets.size,
    }))
    .sort((a, b) => b.xref_count - a.xref_count || targetKindWeight(b.kind) - targetKindWeight(a.kind) || patternXrefWeight(b.pattern) - patternXrefWeight(a.pattern))
    .slice(0, MAX_STATIC_STRING_XREF_PATTERNS);
  return {
    scan_mode: 'best_effort_x64_rip_relative',
    source_bucket_bytes: 0x1000,
    source_region_bytes: 0x10000,
    target_count: targets.length,
    xref_count: xrefs.length,
    executable_section_count: executableSectionCount,
    source_buckets: buckets,
    source_regions: summarizeStaticStringXrefRegions(xrefs),
    function_summary: summarizeStaticXrefFunctions(buf, pe, xrefs),
    target_patterns: patterns,
    mixed_source_buckets: buckets.filter(item => item.db_xref_count > 0 && item.crypto_xref_count > 0).slice(0, 24),
    mixed_source_regions: summarizeStaticStringXrefRegions(xrefs).filter(item => item.db_xref_count > 0 && item.crypto_xref_count > 0).slice(0, 24),
  };
}

function summarizeStaticStringXrefRegions(xrefs) {
  const regions = new Map();
  for (const xref of xrefs) {
    const sourceRegion = Math.floor(Number(xref.source_rva || 0) / 0x10000) * 0x10000;
    const key = `${xref.source_section}:${sourceRegion}`;
    let region = regions.get(key);
    if (!region) {
      region = {
        source_section: xref.source_section,
        source_rva_region: sourceRegion,
        xref_count: 0,
        db_xref_count: 0,
        crypto_xref_count: 0,
        target_patterns: new Set(),
        source_bucket_count: new Set(),
      };
      regions.set(key, region);
    }
    region.xref_count++;
    if (xref.kind === 'crypto') region.crypto_xref_count++;
    else region.db_xref_count++;
    region.target_patterns.add(`${xref.kind}:${xref.pattern}`);
    region.source_bucket_count.add(xref.source_rva_bucket);
  }
  return [...regions.values()]
    .map(item => ({
      source_section: item.source_section,
      source_rva_region_hex: numberToHex(item.source_rva_region),
      xref_count: item.xref_count,
      db_xref_count: item.db_xref_count,
      crypto_xref_count: item.crypto_xref_count,
      source_bucket_count: item.source_bucket_count.size,
      target_patterns: [...item.target_patterns].sort().slice(0, 32),
    }))
    .sort((a, b) => b.xref_count - a.xref_count || b.crypto_xref_count - a.crypto_xref_count)
    .slice(0, MAX_STATIC_STRING_XREF_BUCKETS);
}

function summarizeStaticXrefFunctions(buf, pe, xrefs) {
  const functions = new Map();
  const directCallTargets = new Map();
  const functionCallCache = new Map();
  for (const xref of xrefs || []) {
    const sourceRaw = Number(xref.source_raw_offset || -1);
    const sourceRva = Number(xref.source_rva || 0);
    if (sourceRaw < 0 || !sourceRva) continue;
    const fn = findNearestX64FunctionStart(buf, pe, sourceRaw, sourceRva);
    const fnRva = fn?.rva || Math.floor(sourceRva / 0x1000) * 0x1000;
    const fnKey = `${xref.source_section}:${Math.floor(fnRva / 0x100) * 0x100}`;
    let item = functions.get(fnKey);
    if (!item) {
      item = {
        source_section: xref.source_section,
        function_rva_bucket: Math.floor(fnRva / 0x100) * 0x100,
        function_rva_region: Math.floor(fnRva / 0x10000) * 0x10000,
        xref_count: 0,
        db_xref_count: 0,
        crypto_xref_count: 0,
        target_patterns: new Set(),
        direct_call_target_regions: new Set(),
        direct_call_target_count: 0,
      };
      functions.set(fnKey, item);
      const callTargets = scanDirectCallTargetsNearXref(buf, pe, sourceRaw, sourceRva, fn);
      functionCallCache.set(fnKey, callTargets);
      for (const target of callTargets) {
        const targetRegion = Math.floor(target / 0x10000) * 0x10000;
        if (targetRegion <= 0) continue;
        item.direct_call_target_regions.add(targetRegion);
        item.direct_call_target_count++;
        const callKey = numberToHex(targetRegion);
        const existing = directCallTargets.get(callKey) || { target_rva_region: targetRegion, call_count: 0, source_function_count: new Set(), source_patterns: new Set() };
        existing.call_count++;
        existing.source_function_count.add(fnKey);
        directCallTargets.set(callKey, existing);
      }
    }
    item.xref_count++;
    if (xref.kind === 'crypto') item.crypto_xref_count++;
    else item.db_xref_count++;
    item.target_patterns.add(`${xref.kind}:${xref.pattern}`);
    for (const target of functionCallCache.get(fnKey) || []) {
      const targetRegion = Math.floor(target / 0x10000) * 0x10000;
      if (targetRegion <= 0) continue;
      const callKey = numberToHex(targetRegion);
      const existing = directCallTargets.get(callKey);
      if (existing) existing.source_patterns.add(`${xref.kind}:${xref.pattern}`);
    }
  }
  const functionList = [...functions.values()]
    .map(item => ({
      source_section: item.source_section,
      function_rva_bucket_hex: numberToHex(item.function_rva_bucket),
      function_rva_region_hex: numberToHex(item.function_rva_region),
      xref_count: item.xref_count,
      db_xref_count: item.db_xref_count,
      crypto_xref_count: item.crypto_xref_count,
      direct_call_target_count: item.direct_call_target_count,
      direct_call_target_regions: [...item.direct_call_target_regions].sort((a, b) => a - b).slice(0, 16).map(numberToHex),
      target_patterns: [...item.target_patterns].sort().slice(0, 24),
    }))
    .sort((a, b) => b.xref_count - a.xref_count || b.crypto_xref_count - a.crypto_xref_count || b.direct_call_target_count - a.direct_call_target_count)
    .slice(0, MAX_STATIC_XREF_FUNCTIONS);
  const callTargetList = [...directCallTargets.values()]
    .map(item => ({
      target_rva_region_hex: numberToHex(item.target_rva_region),
      call_count: item.call_count,
      source_function_count: item.source_function_count.size,
      source_patterns: [...item.source_patterns].sort().slice(0, 24),
    }))
    .sort((a, b) => b.call_count - a.call_count || b.source_function_count - a.source_function_count)
    .slice(0, MAX_STATIC_XREF_CALL_TARGETS);
  return {
    scan_mode: 'heuristic_x64_prologue_and_rel32_calls',
    function_count: functions.size,
    direct_call_target_region_count: directCallTargets.size,
    functions: functionList,
    direct_call_target_regions: callTargetList,
    priority_call_graph: summarizePriorityStaticCallGraph(buf, pe, functions, functionCallCache, xrefs),
    mixed_functions: functionList.filter(item => item.db_xref_count > 0 && item.crypto_xref_count > 0).slice(0, 24),
  };
}

function summarizePriorityStaticCallGraph(buf, pe, functions, functionCallCache, xrefs) {
  const sourceRegionPatterns = summarizeXrefPatternsBySourceRegion(xrefs);
  const sourceBucketPatterns = summarizeXrefPatternsBySourceBucket(xrefs);
  const rel32CallIndex = buildStaticRel32CallIndex(buf, pe);
  const regionFunctionMap = summarizeStaticFunctionsByRegion(functions, rel32CallIndex);
  const secondHopCache = new Map();
  const sharedFirstHopRegions = new Map();
  const sharedSecondHopRegions = new Map();
  const priorityFunctions = [...functions.entries()]
    .map(([key, item]) => ({ key, item, score: staticFunctionPriorityScore(item) }))
    .filter(entry => entry.item.db_xref_count > 0 || hasSqlCipherPattern(entry.item.target_patterns))
    .sort((a, b) => b.score - a.score || b.item.xref_count - a.item.xref_count)
    .slice(0, MAX_STATIC_XREF_PRIORITY_GRAPH_FUNCTIONS);
  const graphFunctions = [];
  for (const { key, item } of priorityFunctions) {
    const firstHopRegions = new Map();
    const secondHopRegions = new Map();
    const directTargets = (functionCallCache.get(key) || []).filter(target => Number(target || 0) > 0);
    for (const targetRva of directTargets) {
      const firstRegion = Math.floor(targetRva / 0x10000) * 0x10000;
      if (firstRegion <= 0) continue;
      addCallGraphRegion(firstHopRegions, firstRegion, key, 1, sourceRegionPatterns);
      addCallGraphRegion(sharedFirstHopRegions, firstRegion, key, 1, sourceRegionPatterns);
      const secondTargets = getSecondHopTargetsForRva(buf, pe, targetRva, secondHopCache);
      for (const secondTarget of secondTargets) {
        const secondRegion = Math.floor(secondTarget / 0x10000) * 0x10000;
        if (secondRegion <= 0) continue;
        addCallGraphRegion(secondHopRegions, secondRegion, key, 1, sourceRegionPatterns);
        addCallGraphRegion(sharedSecondHopRegions, secondRegion, key, 1, sourceRegionPatterns);
      }
    }
    graphFunctions.push({
      source_section: item.source_section,
      function_rva_bucket_hex: numberToHex(item.function_rva_bucket),
      function_rva_region_hex: numberToHex(item.function_rva_region),
      xref_count: item.xref_count,
      db_xref_count: item.db_xref_count,
      crypto_xref_count: item.crypto_xref_count,
      target_patterns: [...item.target_patterns].sort().slice(0, 24),
      first_hop_target_regions: formatCallGraphRegions(firstHopRegions, MAX_STATIC_XREF_PRIORITY_FIRST_HOPS),
      second_hop_target_regions: formatCallGraphRegions(secondHopRegions, MAX_STATIC_XREF_PRIORITY_SECOND_HOPS),
    });
  }
  return {
    scan_mode: 'heuristic_two_hop_rel32_call_graph',
    priority_function_count: graphFunctions.length,
    first_hop_region_count: sharedFirstHopRegions.size,
    second_hop_region_count: sharedSecondHopRegions.size,
    functions: graphFunctions,
    shared_first_hop_target_regions: formatCallGraphRegions(sharedFirstHopRegions, MAX_STATIC_XREF_PRIORITY_FIRST_HOPS),
    shared_second_hop_target_regions: formatCallGraphRegions(sharedSecondHopRegions, MAX_STATIC_XREF_PRIORITY_SECOND_HOPS),
    rel32_call_index_summary: {
      scan_mode: rel32CallIndex.scan_mode,
      call_count: rel32CallIndex.call_count,
      source_region_count: rel32CallIndex.by_source_region.size,
      source_bucket_count: rel32CallIndex.by_source_bucket.size,
      target_region_count: rel32CallIndex.by_target_region.size,
      target_bucket_count: rel32CallIndex.by_target_bucket.size,
    },
    candidate_key_derivation_regions: rankCandidateKeyDerivationRegions(sharedFirstHopRegions, sharedSecondHopRegions, regionFunctionMap, rel32CallIndex, sourceRegionPatterns, sourceBucketPatterns, buf, pe, functionCallCache),
  };
}

function summarizeXrefPatternsBySourceRegion(xrefs) {
  const regions = new Map();
  for (const xref of xrefs || []) {
    const sourceRegion = Math.floor(Number(xref.source_rva || 0) / 0x10000) * 0x10000;
    if (sourceRegion <= 0) continue;
    const key = numberToHex(sourceRegion);
    let item = regions.get(key);
    if (!item) {
      item = {
        db_xref_count: 0,
        crypto_xref_count: 0,
        target_patterns: new Set(),
      };
      regions.set(key, item);
    }
    if (xref.kind === 'crypto') item.crypto_xref_count++;
    else item.db_xref_count++;
    item.target_patterns.add(`${xref.kind}:${xref.pattern}`);
  }
  return regions;
}

function summarizeXrefPatternsBySourceBucket(xrefs) {
  const buckets = new Map();
  for (const xref of xrefs || []) {
    const sourceBucket = Math.floor(Number(xref.source_rva || 0) / 0x100) * 0x100;
    if (sourceBucket <= 0) continue;
    const key = numberToHex(sourceBucket);
    let item = buckets.get(key);
    if (!item) {
      item = {
        db_xref_count: 0,
        crypto_xref_count: 0,
        target_patterns: new Set(),
      };
      buckets.set(key, item);
    }
    if (xref.kind === 'crypto') item.crypto_xref_count++;
    else item.db_xref_count++;
    item.target_patterns.add(`${xref.kind}:${xref.pattern}`);
  }
  return buckets;
}

function addCallGraphRegion(regions, regionRva, sourceFunctionKey, callCount, sourceRegionPatterns) {
  const key = numberToHex(regionRva);
  if (!key) return;
  let item = regions.get(key);
  if (!item) {
    const patterns = sourceRegionPatterns.get(key) || null;
    item = {
      target_rva_region: regionRva,
      call_count: 0,
      source_functions: new Set(),
      target_db_xref_count: patterns?.db_xref_count || 0,
      target_crypto_xref_count: patterns?.crypto_xref_count || 0,
      target_patterns: new Set(patterns ? [...patterns.target_patterns] : []),
    };
    regions.set(key, item);
  }
  item.call_count += callCount;
  item.source_functions.add(sourceFunctionKey);
}

function formatCallGraphRegions(regions, limit) {
  return [...regions.values()]
    .map(item => ({
      target_rva_region_hex: numberToHex(item.target_rva_region),
      call_count: item.call_count,
      source_function_count: item.source_functions.size,
      target_db_xref_count: item.target_db_xref_count,
      target_crypto_xref_count: item.target_crypto_xref_count,
      target_patterns: [...item.target_patterns].sort().slice(0, 20),
    }))
    .sort((a, b) => b.call_count - a.call_count || b.source_function_count - a.source_function_count || b.target_db_xref_count - a.target_db_xref_count || b.target_crypto_xref_count - a.target_crypto_xref_count)
    .slice(0, limit);
}

function summarizeStaticFunctionsByRegion(functions, rel32CallIndex) {
  const regions = new Map();
  for (const item of functions.values()) {
    const regionKey = numberToHex(item.function_rva_region);
    if (!regionKey) continue;
    const list = regions.get(regionKey) || [];
    list.push({
      source_section: item.source_section,
      function_rva_bucket_hex: numberToHex(item.function_rva_bucket),
      xref_count: item.xref_count,
      db_xref_count: item.db_xref_count,
      crypto_xref_count: item.crypto_xref_count,
      direct_call_target_count: item.direct_call_target_count,
      direct_call_target_regions: [...item.direct_call_target_regions].sort((a, b) => a - b).slice(0, 8).map(numberToHex),
      target_patterns: [...item.target_patterns].sort().slice(0, 18),
      incoming_call_summary: formatIncomingCallSummary(rel32CallIndex.by_target_bucket.get(numberToHex(item.function_rva_bucket)), MAX_STATIC_XREF_INCOMING_CALLERS),
    });
    regions.set(regionKey, list);
  }
  for (const [key, list] of regions) {
    regions.set(key, list.sort((a, b) => b.xref_count - a.xref_count || b.db_xref_count - a.db_xref_count || b.crypto_xref_count - a.crypto_xref_count).slice(0, MAX_STATIC_XREF_CANDIDATE_REGION_FUNCTIONS));
  }
  return regions;
}

function rankCandidateKeyDerivationRegions(firstHopRegions, secondHopRegions, regionFunctionMap, rel32CallIndex, sourceRegionPatterns, sourceBucketPatterns, buf, pe, functionCallCache) {
  const keys = new Set([...firstHopRegions.keys(), ...secondHopRegions.keys()]);
  return [...keys].map(key => {
    const first = firstHopRegions.get(key) || null;
    const second = secondHopRegions.get(key) || null;
    const targetPatterns = new Set([...(first?.target_patterns || []), ...(second?.target_patterns || [])]);
    const targetDbXrefs = Math.max(Number(first?.target_db_xref_count || 0), Number(second?.target_db_xref_count || 0));
    const targetCryptoXrefs = Math.max(Number(first?.target_crypto_xref_count || 0), Number(second?.target_crypto_xref_count || 0));
    const score = candidateKeyRegionScore({ first, second, targetDbXrefs, targetCryptoXrefs, targetPatterns });
    const regionFunctions = regionFunctionMap.get(key) || [];
    const cryptoBridgePaths = findCryptoBridgePaths(key, rel32CallIndex, sourceRegionPatterns);
    const candidateBridgeCallsitePaths = findCandidateBridgeCallsitePaths(cryptoBridgePaths, rel32CallIndex, sourceRegionPatterns, sourceBucketPatterns);
    return {
      target_rva_region_hex: key,
      priority_score: score,
      first_hop_call_count: Number(first?.call_count || 0),
      first_hop_source_function_count: first?.source_functions?.size || 0,
      second_hop_call_count: Number(second?.call_count || 0),
      second_hop_source_function_count: second?.source_functions?.size || 0,
      target_db_xref_count: targetDbXrefs,
      target_crypto_xref_count: targetCryptoXrefs,
      target_patterns: [...targetPatterns].sort().slice(0, 24),
      selection_reasons: candidateKeyRegionReasons({ first, second, targetDbXrefs, targetCryptoXrefs, targetPatterns }),
      first_hop_source_functions: formatSourceFunctionRefs(first?.source_functions, MAX_STATIC_XREF_CANDIDATE_SOURCE_FUNCTIONS),
      second_hop_source_functions: formatSourceFunctionRefs(second?.source_functions, MAX_STATIC_XREF_CANDIDATE_SOURCE_FUNCTIONS),
      incoming_call_summary: formatIncomingCallSummary(rel32CallIndex.by_target_region.get(key), MAX_STATIC_XREF_INCOMING_CALLERS),
      outgoing_call_summary: formatOutgoingCallSummary(rel32CallIndex.by_source_region.get(key), MAX_STATIC_XREF_OUTGOING_REGIONS, sourceRegionPatterns),
      crypto_bridge_paths: cryptoBridgePaths,
      candidate_bridge_callsite_paths: candidateBridgeCallsitePaths,
      candidate_bridge_resolved_function_paths: resolveCandidateBridgeCallsiteFunctionPaths(candidateBridgeCallsitePaths, buf, pe, sourceBucketPatterns, sourceRegionPatterns),
      candidate_bridge_function_paths: findCandidateBridgeFunctionPaths(regionFunctions, cryptoBridgePaths, rel32CallIndex, buf, pe, functionCallCache, sourceRegionPatterns, sourceBucketPatterns),
      region_functions: regionFunctions,
    };
  })
    .filter(item => item.priority_score > 0)
    .sort((a, b) => b.priority_score - a.priority_score || b.second_hop_source_function_count - a.second_hop_source_function_count || b.first_hop_source_function_count - a.first_hop_source_function_count)
    .slice(0, MAX_STATIC_XREF_CANDIDATE_REGIONS);
}

function candidateKeyRegionScore({ first, second, targetDbXrefs, targetCryptoXrefs, targetPatterns }) {
  let score = 0;
  score += Number(first?.call_count || 0) * 6;
  score += Number(second?.call_count || 0) * 3;
  score += (first?.source_functions?.size || 0) * 20;
  score += (second?.source_functions?.size || 0) * 12;
  score += Math.min(targetDbXrefs, 240) * 5;
  score += Math.min(targetCryptoXrefs, 160) * 4;
  for (const pattern of targetPatterns || []) {
    const weight = patternXrefWeight(pattern);
    if (weight >= 100) score += 160;
    else if (weight >= 70) score += 90;
    else if (weight >= 40) score += 35;
  }
  return score;
}

function candidateKeyRegionReasons({ first, second, targetDbXrefs, targetCryptoXrefs, targetPatterns }) {
  const reasons = [];
  if (first?.call_count) reasons.push('first_hop');
  if (second?.call_count) reasons.push('second_hop');
  if ((first?.source_functions?.size || 0) + (second?.source_functions?.size || 0) >= 8) reasons.push('shared_by_many_priority_functions');
  if (targetDbXrefs > 0) reasons.push('db_xref_region');
  if (targetCryptoXrefs > 0) reasons.push('crypto_xref_region');
  if (hasSqlCipherPattern(targetPatterns)) reasons.push('sqlcipher_or_wcdb_patterns');
  return reasons;
}

function formatSourceFunctionRefs(functionKeys, limit) {
  return [...(functionKeys || [])]
    .map(parseSourceFunctionKey)
    .filter(Boolean)
    .sort((a, b) => a.function_rva_bucket - b.function_rva_bucket)
    .slice(0, limit)
    .map(item => ({
      source_section: item.source_section,
      function_rva_bucket_hex: numberToHex(item.function_rva_bucket),
    }));
}

function parseSourceFunctionKey(key) {
  const value = String(key || '');
  const idx = value.lastIndexOf(':');
  if (idx <= 0) return null;
  const bucket = Number(value.slice(idx + 1));
  if (!Number.isFinite(bucket) || bucket <= 0) return null;
  return {
    source_section: value.slice(0, idx) || 'unknown',
    function_rva_bucket: bucket,
  };
}

function buildStaticRel32CallIndex(buf, pe) {
  const bySourceBucket = new Map();
  const bySourceRegionBuckets = new Map();
  const byTargetRegion = new Map();
  const byTargetBucket = new Map();
  const bySourceRegion = new Map();
  let callCount = 0;
  for (const section of executablePeSections(pe)) {
    const rawStart = Number(section.pointer_to_raw_data || 0);
    const rawSize = Number(section.size_of_raw_data || 0);
    const rawEnd = Math.min(buf.length, rawStart + rawSize);
    if (!rawSize || rawStart < 0 || rawStart >= buf.length) continue;
    const sectionRva = Number(section.virtual_address || 0);
    const sourceSection = section.name || 'unknown';
    for (let raw = rawStart; raw + 5 <= rawEnd; raw++) {
      if (buf[raw] !== 0xe8 && buf[raw] !== 0xe9) continue;
      const rel = buf.readInt32LE(raw + 1);
      const sourceRva = sectionRva + (raw - rawStart);
      const targetRva = sourceRva + 5 + rel;
      if (targetRva <= 0 || !isRvaInExecutableSection(pe, targetRva)) continue;
      callCount++;
      const sourceBucket = Math.floor(sourceRva / 0x100) * 0x100;
      const sourceRegion = Math.floor(sourceRva / 0x10000) * 0x10000;
      const targetBucket = Math.floor(targetRva / 0x100) * 0x100;
      const targetRegion = Math.floor(targetRva / 0x10000) * 0x10000;
      addIncomingCallIndex(byTargetBucket, numberToHex(targetBucket), sourceSection, sourceBucket, sourceRegion);
      addIncomingCallIndex(byTargetRegion, numberToHex(targetRegion), sourceSection, sourceBucket, sourceRegion);
      addOutgoingCallIndex(bySourceRegion, numberToHex(sourceRegion), targetRegion);
      addOutgoingBucketCallIndex(bySourceBucket, sourceSection, sourceBucket, sourceRegion, targetBucket, targetRegion);
      addSourceBucketRegionIndex(bySourceRegionBuckets, sourceRegion, sourceBucket);
    }
  }
  return {
    scan_mode: 'whole_module_rel32_callsite_buckets',
    call_count: callCount,
    by_source_bucket: bySourceBucket,
    by_source_region_buckets: bySourceRegionBuckets,
    by_source_region: bySourceRegion,
    by_target_region: byTargetRegion,
    by_target_bucket: byTargetBucket,
  };
}

function addIncomingCallIndex(map, targetKey, sourceSection, sourceBucket, sourceRegion) {
  if (!targetKey) return;
  let item = map.get(targetKey);
  if (!item) {
    item = { call_count: 0, caller_buckets: new Map(), caller_regions: new Map() };
    map.set(targetKey, item);
  }
  item.call_count++;
  addIncomingCaller(item.caller_buckets, `${sourceSection}:${sourceBucket}`, sourceSection, sourceBucket, 'bucket');
  addIncomingCaller(item.caller_regions, `${sourceSection}:${sourceRegion}`, sourceSection, sourceRegion, 'region');
}

function addIncomingCaller(map, key, sourceSection, sourceRva, kind) {
  let item = map.get(key);
  if (!item) {
    item = {
      source_section: sourceSection || 'unknown',
      source_rva: sourceRva,
      call_count: 0,
      kind,
    };
    map.set(key, item);
  }
  item.call_count++;
}

function addOutgoingCallIndex(map, sourceKey, targetRegion) {
  if (!sourceKey) return;
  let item = map.get(sourceKey);
  if (!item) {
    item = { call_count: 0, target_regions: new Map() };
    map.set(sourceKey, item);
  }
  item.call_count++;
  const targetKey = numberToHex(targetRegion);
  if (!targetKey) return;
  let target = item.target_regions.get(targetKey);
  if (!target) {
    target = { target_rva_region: targetRegion, call_count: 0 };
    item.target_regions.set(targetKey, target);
  }
  target.call_count++;
}

function addOutgoingBucketCallIndex(map, sourceSection, sourceBucket, sourceRegion, targetBucket, targetRegion) {
  const sourceKey = numberToHex(sourceBucket);
  if (!sourceKey) return;
  let item = map.get(sourceKey);
  if (!item) {
    item = {
      source_section: sourceSection || 'unknown',
      source_rva_bucket: sourceBucket,
      source_rva_region: sourceRegion,
      call_count: 0,
      target_buckets: new Map(),
      target_regions: new Map(),
    };
    map.set(sourceKey, item);
  }
  item.call_count++;
  const targetBucketKey = numberToHex(targetBucket);
  if (targetBucketKey) {
    let target = item.target_buckets.get(targetBucketKey);
    if (!target) {
      target = { target_rva_bucket: targetBucket, target_rva_region: targetRegion, call_count: 0 };
      item.target_buckets.set(targetBucketKey, target);
    }
    target.call_count++;
  }
  const targetRegionKey = numberToHex(targetRegion);
  if (targetRegionKey) {
    let region = item.target_regions.get(targetRegionKey);
    if (!region) {
      region = { target_rva_region: targetRegion, call_count: 0 };
      item.target_regions.set(targetRegionKey, region);
    }
    region.call_count++;
  }
}

function addSourceBucketRegionIndex(map, sourceRegion, sourceBucket) {
  const regionKey = numberToHex(sourceRegion);
  const bucketKey = numberToHex(sourceBucket);
  if (!regionKey || !bucketKey) return;
  let buckets = map.get(regionKey);
  if (!buckets) {
    buckets = new Set();
    map.set(regionKey, buckets);
  }
  buckets.add(bucketKey);
}

function formatIncomingCallSummary(item, limit) {
  if (!item) return null;
  return {
    call_count: item.call_count,
    caller_bucket_count: item.caller_buckets.size,
    caller_region_count: item.caller_regions.size,
    caller_buckets: formatIncomingCallers(item.caller_buckets, limit, 'caller_rva_bucket_hex'),
    caller_regions: formatIncomingCallers(item.caller_regions, limit, 'caller_rva_region_hex'),
  };
}

function formatIncomingCallers(map, limit, rvaField) {
  return [...map.values()]
    .map(item => ({
      source_section: item.source_section,
      [rvaField]: numberToHex(item.source_rva),
      call_count: item.call_count,
    }))
    .sort((a, b) => b.call_count - a.call_count || String(a[rvaField]).localeCompare(String(b[rvaField])))
    .slice(0, limit);
}

function formatOutgoingCallSummary(item, limit, sourceRegionPatterns) {
  if (!item) return null;
  return {
    call_count: item.call_count,
    target_region_count: item.target_regions.size,
    target_regions: [...item.target_regions.values()]
      .map(target => {
        const key = numberToHex(target.target_rva_region);
        const patterns = sourceRegionPatterns.get(key) || null;
        return {
          target_rva_region_hex: key,
          call_count: target.call_count,
          target_db_xref_count: patterns?.db_xref_count || 0,
          target_crypto_xref_count: patterns?.crypto_xref_count || 0,
          target_patterns: patterns ? [...patterns.target_patterns].sort().slice(0, 12) : [],
        };
      })
      .sort((a, b) => b.call_count - a.call_count || b.target_crypto_xref_count - a.target_crypto_xref_count || b.target_db_xref_count - a.target_db_xref_count)
      .slice(0, limit),
  };
}

function findCryptoBridgePaths(startRegionKey, rel32CallIndex, sourceRegionPatterns) {
  if (!startRegionKey || !rel32CallIndex?.by_source_region?.has(startRegionKey)) return [];
  const paths = [];
  const queue = [{ region: startRegionKey, path: [startRegionKey], edgeCounts: [], minEdgeCallCount: Infinity }];
  const bestDepth = new Map([[startRegionKey, 0]]);
  while (queue.length && paths.length < MAX_STATIC_XREF_CRYPTO_BRIDGE_PATHS * 4) {
    const current = queue.shift();
    const depth = current.path.length - 1;
    if (depth > 0 && isCryptoXrefRegion(current.region, sourceRegionPatterns)) {
      paths.push(formatCryptoBridgePath(current, sourceRegionPatterns));
      continue;
    }
    if (depth >= MAX_STATIC_XREF_CRYPTO_BRIDGE_DEPTH) continue;
    const outgoing = rel32CallIndex.by_source_region.get(current.region);
    if (!outgoing) continue;
    const nextTargets = [...outgoing.target_regions.values()]
      .sort((a, b) => b.call_count - a.call_count)
      .slice(0, MAX_STATIC_XREF_OUTGOING_REGIONS * 2);
    for (const target of nextTargets) {
      const nextKey = numberToHex(target.target_rva_region);
      if (!nextKey || current.path.includes(nextKey)) continue;
      const nextDepth = depth + 1;
      const knownDepth = bestDepth.get(nextKey);
      if (knownDepth !== undefined && knownDepth <= nextDepth && !isCryptoXrefRegion(nextKey, sourceRegionPatterns)) continue;
      bestDepth.set(nextKey, nextDepth);
      queue.push({
        region: nextKey,
        path: [...current.path, nextKey],
        edgeCounts: [...current.edgeCounts, target.call_count],
        minEdgeCallCount: Math.min(current.minEdgeCallCount, target.call_count),
      });
    }
  }
  return paths
    .sort((a, b) => b.terminal_crypto_xref_count - a.terminal_crypto_xref_count || b.min_edge_call_count - a.min_edge_call_count || a.hop_count - b.hop_count)
    .slice(0, MAX_STATIC_XREF_CRYPTO_BRIDGE_PATHS);
}

function findCandidateBridgeCallsitePaths(regionBridgePaths, rel32CallIndex, sourceRegionPatterns, sourceBucketPatterns) {
  if (!regionBridgePaths?.length || !rel32CallIndex?.by_source_bucket) return [];
  const paths = [];
  for (const bridge of regionBridgePaths.slice(0, MAX_STATIC_XREF_CRYPTO_BRIDGE_PATHS)) {
    const regions = Array.isArray(bridge.path_regions) ? bridge.path_regions.filter(Boolean) : [];
    if (regions.length < 2) continue;
    const edgeChoices = [];
    for (let i = 0; i < regions.length - 1; i++) {
      const choices = bridgeCallsiteEdgeChoices(regions[i], regions[i + 1], rel32CallIndex, sourceBucketPatterns);
      if (!choices.length) {
        edgeChoices.length = 0;
        break;
      }
      edgeChoices.push(choices.slice(0, 4));
    }
    if (!edgeChoices.length) continue;
    const combos = combineBridgeCallsiteEdges(edgeChoices, MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS * 2);
    for (const combo of combos) {
      const terminalRegionKey = regions[regions.length - 1];
      const terminalRegion = sourceRegionPatterns.get(terminalRegionKey) || null;
      paths.push({
        hop_count: regions.length - 1,
        path_regions: regions,
        edge_source_callsite_buckets: combo.map(edge => edge.source_bucket_hex),
        edge_target_buckets: combo.map(edge => edge.target_bucket_hex),
        edge_call_counts: combo.map(edge => edge.call_count),
        min_edge_call_count: Math.min(...combo.map(edge => edge.call_count)),
        terminal_region_db_xref_count: terminalRegion?.db_xref_count || 0,
        terminal_region_crypto_xref_count: terminalRegion?.crypto_xref_count || 0,
        terminal_patterns: terminalRegion ? [...terminalRegion.target_patterns].sort().slice(0, 18) : [],
      });
    }
  }
  return paths
    .sort((a, b) => b.terminal_region_crypto_xref_count - a.terminal_region_crypto_xref_count
      || b.min_edge_call_count - a.min_edge_call_count
      || a.hop_count - b.hop_count
      || String(a.edge_source_callsite_buckets?.[0] || '').localeCompare(String(b.edge_source_callsite_buckets?.[0] || '')))
    .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS);
}

function bridgeCallsiteEdgeChoices(sourceRegionKey, targetRegionKey, rel32CallIndex, sourceBucketPatterns) {
  const bucketKeys = rel32CallIndex.by_source_region_buckets?.get(sourceRegionKey) || [];
  const choices = [];
  for (const bucketKey of bucketKeys) {
    const source = rel32CallIndex.by_source_bucket.get(bucketKey);
    if (!source) continue;
    const targetRegion = source.target_regions.get(targetRegionKey);
    if (!targetRegion?.call_count) continue;
    const targetBuckets = [...source.target_buckets.values()]
      .filter(target => numberToHex(target.target_rva_region) === targetRegionKey)
      .sort((a, b) => b.call_count - a.call_count || a.target_rva_bucket - b.target_rva_bucket);
    const topTarget = targetBuckets[0];
    if (!topTarget) continue;
    const patterns = sourceBucketPatterns.get(bucketKey) || null;
    choices.push({
      source_bucket_hex: bucketKey,
      target_bucket_hex: numberToHex(topTarget.target_rva_bucket),
      call_count: targetRegion.call_count,
      source_db_xref_count: patterns?.db_xref_count || 0,
      source_crypto_xref_count: patterns?.crypto_xref_count || 0,
    });
  }
  return choices.sort((a, b) => b.call_count - a.call_count
    || b.source_db_xref_count - a.source_db_xref_count
    || b.source_crypto_xref_count - a.source_crypto_xref_count
    || String(a.source_bucket_hex).localeCompare(String(b.source_bucket_hex)));
}

function combineBridgeCallsiteEdges(edgeChoices, limit) {
  let combos = [[]];
  for (const choices of edgeChoices) {
    const next = [];
    for (const combo of combos) {
      for (const choice of choices) next.push([...combo, choice]);
    }
    combos = next
      .sort((a, b) => Math.min(...b.map(item => item.call_count)) - Math.min(...a.map(item => item.call_count)))
      .slice(0, limit);
  }
  return combos.slice(0, limit);
}

function resolveCandidateBridgeCallsiteFunctionPaths(callsitePaths, buf, pe, sourceBucketPatterns, sourceRegionPatterns) {
  if (!callsitePaths?.length || !buf || !pe) return [];
  const out = [];
  for (const path of callsitePaths.slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS * 2)) {
    const sourceBuckets = Array.isArray(path.edge_source_callsite_buckets) ? path.edge_source_callsite_buckets : [];
    const targetBuckets = Array.isArray(path.edge_target_buckets) ? path.edge_target_buckets : [];
    if (!sourceBuckets.length || sourceBuckets.length !== targetBuckets.length) continue;
    const sourceFunctions = sourceBuckets.map(bucket => resolveEnclosingFunctionBucket(buf, pe, bucket));
    const targetFunctions = targetBuckets.map(bucket => resolveTargetFunctionBucket(buf, pe, bucket));
    const pathFunctionBuckets = [sourceFunctions[0], ...targetFunctions].filter(Boolean);
    if (pathFunctionBuckets.length < 2) continue;
    let continuous = 0;
    for (let i = 0; i + 1 < targetFunctions.length; i++) {
      if (targetFunctions[i] && sourceFunctions[i + 1] && targetFunctions[i] === sourceFunctions[i + 1]) continuous++;
    }
    const terminalFunction = targetFunctions[targetFunctions.length - 1] || '';
    const terminalRegion = path.path_regions?.[path.path_regions.length - 1] || bucketRegionKey(terminalFunction);
    const terminalFunctionPatterns = sourceBucketPatterns.get(terminalFunction) || null;
    const terminalRegionPatterns = sourceRegionPatterns.get(terminalRegion) || null;
    out.push({
      hop_count: sourceBuckets.length,
      path_regions: path.path_regions || [],
      path_function_buckets: pathFunctionBuckets,
      source_function_buckets: sourceFunctions,
      target_function_buckets: targetFunctions,
      edge_source_callsite_buckets: sourceBuckets,
      edge_target_buckets: targetBuckets,
      edge_call_counts: path.edge_call_counts || [],
      continuous_function_hop_count: continuous,
      is_fully_function_continuous: continuous === Math.max(0, sourceBuckets.length - 1),
      terminal_function_db_xref_count: terminalFunctionPatterns?.db_xref_count || 0,
      terminal_function_crypto_xref_count: terminalFunctionPatterns?.crypto_xref_count || 0,
      terminal_region_db_xref_count: terminalRegionPatterns?.db_xref_count || path.terminal_region_db_xref_count || 0,
      terminal_region_crypto_xref_count: terminalRegionPatterns?.crypto_xref_count || path.terminal_region_crypto_xref_count || 0,
      terminal_patterns: [...new Set([...(terminalFunctionPatterns?.target_patterns || []), ...(terminalRegionPatterns?.target_patterns || [])])].sort().slice(0, 18),
      path_function_xref_summary: summarizePathFunctionXrefs(pathFunctionBuckets, sourceBucketPatterns),
    });
  }
  return out
    .sort((a, b) => Number(b.is_fully_function_continuous) - Number(a.is_fully_function_continuous)
      || b.continuous_function_hop_count - a.continuous_function_hop_count
      || b.terminal_function_crypto_xref_count - a.terminal_function_crypto_xref_count
      || b.terminal_region_crypto_xref_count - a.terminal_region_crypto_xref_count
      || b.hop_count - a.hop_count
      || String(a.path_function_buckets?.[0] || '').localeCompare(String(b.path_function_buckets?.[0] || '')))
    .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS);
}

function resolveEnclosingFunctionBucket(buf, pe, bucketHex) {
  const bucket = parseHexRva(bucketHex);
  if (!bucket) return '';
  const section = findPeSectionByRva(pe, bucket);
  if (!section) return bucketHex || '';
  const probeRva = bucket + 0x80;
  const raw = rvaToRawInSection(section, probeRva) || rvaToRawInSection(section, bucket);
  if (!raw) return bucketHex || '';
  const fn = findNearestX64FunctionStart(buf, pe, raw, probeRva) || null;
  if (!fn?.rva) return bucketHex || '';
  return numberToHex(Math.floor(Number(fn.rva) / 0x100) * 0x100);
}

function resolveTargetFunctionBucket(buf, pe, bucketHex) {
  const bucket = parseHexRva(bucketHex);
  if (!bucket) return '';
  const section = findPeSectionByRva(pe, bucket);
  if (!section) return bucketHex || '';
  const rawStart = rvaToRawInSection(section, bucket);
  const rawEnd = rvaToRawInSection(section, bucket + 0xff);
  if (rawStart && rawEnd && rawEnd >= rawStart) {
    for (let raw = rawStart; raw <= rawEnd && raw + 8 < buf.length; raw++) {
      if (!looksLikeX64FunctionPrologue(buf, raw)) continue;
      const rva = rawToRvaInSection(section, raw);
      if (rva) return numberToHex(Math.floor(rva / 0x100) * 0x100);
    }
  }
  return resolveEnclosingFunctionBucket(buf, pe, bucketHex);
}

function findCandidateBridgeFunctionPaths(regionFunctions, regionBridgePaths, rel32CallIndex, buf, pe, functionCallCache, sourceRegionPatterns, sourceBucketPatterns) {
  if (!regionFunctions?.length || !regionBridgePaths?.length || !buf || !pe) return [];
  const paths = [];
  const starts = [...regionFunctions]
    .map(item => ({
      item,
      bucket_rva: parseHexRva(item.function_rva_bucket_hex),
      score: bridgeFunctionStartScore(item),
    }))
    .filter(entry => entry.bucket_rva > 0)
    .sort((a, b) => b.score - a.score || a.bucket_rva - b.bucket_rva)
    .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_STARTS);
  for (const bridge of regionBridgePaths.slice(0, MAX_STATIC_XREF_CRYPTO_BRIDGE_PATHS)) {
    const bridgeRegions = Array.isArray(bridge.path_regions) ? bridge.path_regions.filter(Boolean) : [];
    if (bridgeRegions.length < 2) continue;
    const indexedStarts = bridgeStartBucketsForRegionPath(bridgeRegions, starts, rel32CallIndex, sourceBucketPatterns);
    for (const start of indexedStarts) {
      const startBucketKey = start.source_bucket_hex;
      let states = [{
        current_bucket: startBucketKey,
        path_buckets: [startBucketKey],
        path_regions: [bridgeRegions[0]],
        edge_counts: [],
      }];
      for (let hop = 1; hop < bridgeRegions.length && states.length; hop++) {
        const nextRegion = bridgeRegions[hop];
        const nextStates = [];
        for (const state of states) {
          const sourceBucket = rel32CallIndex?.by_source_bucket?.get(state.current_bucket);
          const targets = sortBridgeBucketTargets(sourceBucket?.target_buckets?.values?.() ? [...sourceBucket.target_buckets.values()] : [], sourceRegionPatterns, sourceBucketPatterns)
            .filter(target => numberToHex(target.target_rva_region) === nextRegion)
            .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_TARGETS);
          for (const target of targets) {
            const targetBucket = numberToHex(target.target_rva_bucket);
            if (!targetBucket || state.path_buckets.includes(targetBucket)) continue;
            nextStates.push({
              current_bucket: targetBucket,
              path_buckets: [...state.path_buckets, targetBucket],
              path_regions: [...state.path_regions, nextRegion],
              edge_counts: [...state.edge_counts, target.call_count],
            });
          }
        }
        states = nextStates.slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_TARGETS * 2);
      }
      for (const state of states) {
        const terminalBucket = state.path_buckets[state.path_buckets.length - 1];
        const terminalRegion = state.path_regions[state.path_regions.length - 1];
        if (!isCryptoXrefFunctionOrRegion(terminalBucket, terminalRegion, sourceBucketPatterns, sourceRegionPatterns)) continue;
        paths.push(formatCandidateBridgeFunctionPath(state, sourceBucketPatterns, sourceRegionPatterns));
        if (paths.length >= MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS * 4) break;
      }
      if (paths.length >= MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS * 4) break;
    }
    if (paths.length >= MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS * 4) break;
  }
  if (paths.length) {
    return paths
      .sort((a, b) => b.terminal_function_crypto_xref_count - a.terminal_function_crypto_xref_count
        || b.terminal_region_crypto_xref_count - a.terminal_region_crypto_xref_count
        || a.hop_count - b.hop_count
        || String(a.path_function_buckets?.[0] || '').localeCompare(String(b.path_function_buckets?.[0] || '')))
      .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS);
  }
  for (const start of starts) {
    const startKey = sourceFunctionKeyFromSummary(start.item);
    const startBucketKey = numberToHex(start.bucket_rva);
    const startRegionKey = bucketRegionKey(startBucketKey);
    const directTargets = directTargetsForFunctionSummary(start.item, buf, pe, functionCallCache);
    const sortedDirectTargets = sortBridgeTargets(directTargets, sourceRegionPatterns, sourceBucketPatterns)
      .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_TARGETS);
    const queue = sortedDirectTargets.map(targetRva => {
      const targetBucket = numberToHex(Math.floor(targetRva / 0x100) * 0x100);
      const targetRegion = bucketRegionKey(targetBucket);
      return {
        current_rva: targetRva,
        path_buckets: [startBucketKey, targetBucket],
        path_regions: [startRegionKey, targetRegion],
        edge_counts: [1],
      };
    });
    const seen = new Set(queue.map(item => `${startKey}:${item.path_buckets.join('>')}`));
    while (queue.length && paths.length < MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS * 4) {
      const current = queue.shift();
      const terminalBucket = current.path_buckets[current.path_buckets.length - 1];
      const terminalRegion = current.path_regions[current.path_regions.length - 1];
      const depth = current.path_buckets.length - 1;
      if (depth > 0 && isCryptoXrefFunctionOrRegion(terminalBucket, terminalRegion, sourceBucketPatterns, sourceRegionPatterns)) {
        paths.push(formatCandidateBridgeFunctionPath(current, sourceBucketPatterns, sourceRegionPatterns));
        continue;
      }
      if (depth >= MAX_STATIC_XREF_CRYPTO_BRIDGE_DEPTH) continue;
      const nextTargets = sortBridgeTargets(getSecondHopTargetsForRva(buf, pe, current.current_rva, functionCallCache), sourceRegionPatterns, sourceBucketPatterns)
        .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_TARGETS);
      for (const targetRva of nextTargets) {
        const targetBucket = numberToHex(Math.floor(targetRva / 0x100) * 0x100);
        const targetRegion = bucketRegionKey(targetBucket);
        if (!targetBucket || current.path_buckets.includes(targetBucket)) continue;
        const key = `${startKey}:${[...current.path_buckets, targetBucket].join('>')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({
          current_rva: targetRva,
          path_buckets: [...current.path_buckets, targetBucket],
          path_regions: [...current.path_regions, targetRegion],
          edge_counts: [...current.edge_counts, 1],
        });
      }
    }
  }
  return paths
    .sort((a, b) => b.terminal_function_crypto_xref_count - a.terminal_function_crypto_xref_count
      || b.terminal_region_crypto_xref_count - a.terminal_region_crypto_xref_count
      || a.hop_count - b.hop_count
      || String(a.path_function_buckets?.[0] || '').localeCompare(String(b.path_function_buckets?.[0] || '')))
    .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS);
}

function bridgeFunctionStartScore(item) {
  let score = Number(item?.xref_count || 0) * 2 + Number(item?.db_xref_count || 0) * 6 + Number(item?.crypto_xref_count || 0) * 3 + Number(item?.direct_call_target_count || 0);
  if (hasSqlCipherPattern(item?.target_patterns || [])) score += 120;
  return score;
}

function bridgeStartBucketsForRegionPath(bridgeRegions, priorityStarts, rel32CallIndex, sourceBucketPatterns) {
  const startRegion = bridgeRegions[0];
  const nextRegion = bridgeRegions[1];
  const priorityBuckets = new Set(priorityStarts.map(item => numberToHex(item.bucket_rva)).filter(Boolean));
  const starts = [];
  for (const item of rel32CallIndex?.by_source_bucket?.values?.() || []) {
    if (numberToHex(item.source_rva_region) !== startRegion) continue;
    let callsToNextRegion = 0;
    for (const target of item.target_regions.values()) {
      if (numberToHex(target.target_rva_region) === nextRegion) callsToNextRegion += target.call_count;
    }
    if (!callsToNextRegion) continue;
    const bucketKey = numberToHex(item.source_rva_bucket);
    const patterns = sourceBucketPatterns.get(bucketKey) || null;
    starts.push({
      source_bucket_hex: bucketKey,
      calls_to_next_region: callsToNextRegion,
      is_priority_xref_bucket: priorityBuckets.has(bucketKey),
      db_xref_count: patterns?.db_xref_count || 0,
      crypto_xref_count: patterns?.crypto_xref_count || 0,
    });
  }
  return starts
    .sort((a, b) => Number(b.is_priority_xref_bucket) - Number(a.is_priority_xref_bucket)
      || b.calls_to_next_region - a.calls_to_next_region
      || b.db_xref_count - a.db_xref_count
      || b.crypto_xref_count - a.crypto_xref_count
      || String(a.source_bucket_hex).localeCompare(String(b.source_bucket_hex)))
    .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_STARTS);
}

function sourceFunctionKeyFromSummary(item) {
  const bucket = parseHexRva(item?.function_rva_bucket_hex);
  if (!bucket) return '';
  return `${item?.source_section || 'unknown'}:${bucket}`;
}

function directTargetsForFunctionSummary(item, buf, pe, functionCallCache) {
  const key = sourceFunctionKeyFromSummary(item);
  if (key && functionCallCache?.has(key)) return functionCallCache.get(key) || [];
  const bucket = parseHexRva(item?.function_rva_bucket_hex);
  if (!bucket) return [];
  const section = findPeSectionByRva(pe, bucket);
  if (!section) return [];
  const raw = rvaToRawInSection(section, bucket);
  if (!raw) return [];
  const targets = scanDirectCallTargetsForFunction(buf, pe, { raw, rva: bucket });
  if (key && functionCallCache) functionCallCache.set(key, targets);
  return targets;
}

function sortBridgeTargets(targets, sourceRegionPatterns, sourceBucketPatterns) {
  return [...new Set((targets || []).filter(target => Number(target || 0) > 0))]
    .sort((a, b) => bridgeTargetScore(b, sourceRegionPatterns, sourceBucketPatterns) - bridgeTargetScore(a, sourceRegionPatterns, sourceBucketPatterns) || a - b);
}

function sortBridgeBucketTargets(targets, sourceRegionPatterns, sourceBucketPatterns) {
  return [...(targets || [])]
    .filter(target => Number(target?.target_rva_bucket || 0) > 0)
    .sort((a, b) => Number(b.call_count || 0) - Number(a.call_count || 0)
      || bridgeTargetScore(Number(b.target_rva_bucket || 0), sourceRegionPatterns, sourceBucketPatterns) - bridgeTargetScore(Number(a.target_rva_bucket || 0), sourceRegionPatterns, sourceBucketPatterns)
      || Number(a.target_rva_bucket || 0) - Number(b.target_rva_bucket || 0));
}

function bridgeTargetScore(targetRva, sourceRegionPatterns, sourceBucketPatterns) {
  const bucketKey = numberToHex(Math.floor(Number(targetRva || 0) / 0x100) * 0x100);
  const regionKey = bucketRegionKey(bucketKey);
  const bucket = sourceBucketPatterns.get(bucketKey) || null;
  const region = sourceRegionPatterns.get(regionKey) || null;
  let score = 1;
  score += Number(bucket?.crypto_xref_count || 0) * 120;
  score += Number(region?.crypto_xref_count || 0) * 80;
  score += Number(bucket?.db_xref_count || 0) * 24;
  score += Number(region?.db_xref_count || 0) * 12;
  for (const pattern of [...(bucket?.target_patterns || []), ...(region?.target_patterns || [])]) {
    const weight = patternXrefWeight(pattern);
    if (weight >= 100) score += 80;
    else if (weight >= 70) score += 40;
    else if (weight >= 40) score += 24;
  }
  return score;
}

function isCryptoXrefFunctionOrRegion(bucketKey, regionKey, sourceBucketPatterns, sourceRegionPatterns) {
  const bucket = sourceBucketPatterns.get(bucketKey);
  if (Number(bucket?.crypto_xref_count || 0) > 0) return true;
  return isCryptoXrefRegion(regionKey, sourceRegionPatterns);
}

function formatCandidateBridgeFunctionPath(path, sourceBucketPatterns, sourceRegionPatterns) {
  const terminalBucketKey = path.path_buckets[path.path_buckets.length - 1];
  const terminalRegionKey = path.path_regions[path.path_regions.length - 1];
  const terminalBucket = sourceBucketPatterns.get(terminalBucketKey) || null;
  const terminalRegion = sourceRegionPatterns.get(terminalRegionKey) || null;
  return {
    hop_count: path.path_buckets.length - 1,
    path_function_buckets: path.path_buckets,
    path_regions: path.path_regions,
    edge_observed_counts: path.edge_counts,
    terminal_function_db_xref_count: terminalBucket?.db_xref_count || 0,
    terminal_function_crypto_xref_count: terminalBucket?.crypto_xref_count || 0,
    terminal_region_db_xref_count: terminalRegion?.db_xref_count || 0,
    terminal_region_crypto_xref_count: terminalRegion?.crypto_xref_count || 0,
    terminal_patterns: [...new Set([...(terminalBucket?.target_patterns || []), ...(terminalRegion?.target_patterns || [])])].sort().slice(0, 18),
    path_function_xref_summary: summarizePathFunctionXrefs(path.path_buckets, sourceBucketPatterns),
  };
}

function summarizePathFunctionXrefs(functionBuckets, sourceBucketPatterns) {
  const functions = uniqueHexBucketList(functionBuckets).slice(0, MAX_STATIC_XREF_FUNCTION_XREF_FUNCTIONS);
  const aggregate = new Map();
  const functionSummaries = [];
  for (const functionBucket of functions) {
    const functionRva = parseHexRva(functionBucket);
    if (!functionRva) continue;
    const nearby = [];
    for (const [bucketKey, patterns] of sourceBucketPatterns || []) {
      const bucketRva = parseHexRva(bucketKey);
      if (!bucketRva) continue;
      const distance = Math.abs(bucketRva - functionRva);
      if (distance > STATIC_XREF_FUNCTION_XREF_NEIGHBOR_RADIUS) continue;
      nearby.push({ bucketKey, bucketRva, distance, patterns });
      if (!aggregate.has(bucketKey)) aggregate.set(bucketKey, patterns);
    }
    nearby.sort((a, b) => a.distance - b.distance
      || patternSetScore(b.patterns?.target_patterns) - patternSetScore(a.patterns?.target_patterns)
      || String(a.bucketKey).localeCompare(String(b.bucketKey)));
    functionSummaries.push({
      function_rva_bucket_hex: functionBucket,
      nearby_xref_bucket_count: nearby.length,
      nearest_xref_buckets: nearby.slice(0, MAX_STATIC_XREF_FUNCTION_XREF_NEIGHBOR_BUCKETS).map(item => ({
        source_rva_bucket_hex: item.bucketKey,
        distance_bytes: item.distance,
        db_xref_count: item.patterns?.db_xref_count || 0,
        crypto_xref_count: item.patterns?.crypto_xref_count || 0,
        target_patterns: sortXrefPatternList(item.patterns?.target_patterns, 10),
      })),
    });
  }
  const targetPatterns = new Set();
  let dbXrefCount = 0;
  let cryptoXrefCount = 0;
  for (const patterns of aggregate.values()) {
    dbXrefCount += Number(patterns?.db_xref_count || 0);
    cryptoXrefCount += Number(patterns?.crypto_xref_count || 0);
    for (const pattern of patterns?.target_patterns || []) targetPatterns.add(pattern);
  }
  return {
    function_bucket_count: functions.length,
    nearby_xref_bucket_count: aggregate.size,
    db_xref_count: dbXrefCount,
    crypto_xref_count: cryptoXrefCount,
    sqlcipher_pattern_count: [...targetPatterns].filter(pattern => patternXrefWeight(pattern) >= 70).length,
    crypto_pattern_count: [...targetPatterns].filter(pattern => /aes|hmac|sha|hkdf|derive|encrypt|decrypt/i.test(String(pattern || ''))).length,
    target_patterns: sortXrefPatternList(targetPatterns, 18),
    functions: functionSummaries.filter(item => item.nearby_xref_bucket_count > 0).slice(0, MAX_STATIC_XREF_FUNCTION_XREF_FUNCTIONS),
  };
}

function uniqueHexBucketList(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const rva = parseHexRva(value);
    if (!rva) continue;
    const key = numberToHex(rva);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function sortXrefPatternList(patterns, limit) {
  return [...(patterns || [])]
    .sort((a, b) => patternXrefWeight(b) - patternXrefWeight(a) || String(a).localeCompare(String(b)))
    .slice(0, limit);
}

function patternSetScore(patterns) {
  let score = 0;
  for (const pattern of patterns || []) score += patternXrefWeight(pattern);
  return score;
}

function bucketRegionKey(bucketKey) {
  const bucket = parseHexRva(bucketKey);
  return bucket > 0 ? numberToHex(Math.floor(bucket / 0x10000) * 0x10000) : '';
}

function isCryptoXrefRegion(regionKey, sourceRegionPatterns) {
  const patterns = sourceRegionPatterns.get(regionKey);
  return Number(patterns?.crypto_xref_count || 0) > 0;
}

function formatCryptoBridgePath(path, sourceRegionPatterns) {
  const terminal = sourceRegionPatterns.get(path.region) || null;
  return {
    hop_count: path.path.length - 1,
    path_regions: path.path,
    edge_call_counts: path.edgeCounts,
    min_edge_call_count: Number.isFinite(path.minEdgeCallCount) ? path.minEdgeCallCount : 0,
    terminal_db_xref_count: terminal?.db_xref_count || 0,
    terminal_crypto_xref_count: terminal?.crypto_xref_count || 0,
    terminal_patterns: terminal ? [...terminal.target_patterns].sort().slice(0, 16) : [],
  };
}

function getSecondHopTargetsForRva(buf, pe, targetRva, cache) {
  const section = findPeSectionByRva(pe, targetRva);
  if (!section) return [];
  const targetRaw = rvaToRawInSection(section, targetRva);
  if (!targetRaw) return [];
  const fn = findNearestX64FunctionStart(buf, pe, targetRaw, targetRva) || { raw: targetRaw, rva: targetRva };
  const key = `${section.name || 'unknown'}:${Math.floor(Number(fn.rva || targetRva) / 0x100) * 0x100}`;
  if (!cache.has(key)) cache.set(key, scanDirectCallTargetsForFunction(buf, pe, fn));
  return cache.get(key) || [];
}

function scanDirectCallTargetsForFunction(buf, pe, fn) {
  const sourceRva = Number(fn?.rva || 0);
  const sourceRaw = Number(fn?.raw || -1);
  if (sourceRaw < 0 || sourceRva <= 0) return [];
  const section = findPeSectionByRva(pe, sourceRva);
  if (!section) return [];
  const rawStart = Number(section.pointer_to_raw_data || 0);
  const rawEnd = Math.min(buf.length, rawStart + Number(section.size_of_raw_data || 0));
  const start = Math.max(rawStart, sourceRaw);
  const end = Math.min(rawEnd, start + 0x900);
  const sectionRva = Number(section.virtual_address || 0);
  return scanDirectCallTargetsInRange(buf, pe, start, end, rawStart, sectionRva);
}

function scanDirectCallTargetsInRange(buf, pe, start, end, sectionRawStart, sectionRva) {
  const targets = new Set();
  for (let raw = start; raw + 5 <= end; raw++) {
    if (buf[raw] !== 0xe8 && buf[raw] !== 0xe9) continue;
    const rel = buf.readInt32LE(raw + 1);
    const callSourceRva = sectionRva + (raw - sectionRawStart);
    const target = callSourceRva + 5 + rel;
    if (target <= 0 || !isRvaInExecutableSection(pe, target)) continue;
    targets.add(target);
  }
  return [...targets];
}

function staticFunctionPriorityScore(item) {
  let score = Number(item.xref_count || 0) * 2 + Number(item.db_xref_count || 0) * 4 + Number(item.crypto_xref_count || 0) * 3 + Number(item.direct_call_target_count || 0);
  for (const pattern of item.target_patterns || []) score += patternXrefWeight(pattern) >= 70 ? 20 : patternXrefWeight(pattern) >= 40 ? 8 : 0;
  return score;
}

function hasSqlCipherPattern(patterns) {
  for (const pattern of patterns || []) {
    if (/sqlcipher|cipher|wcdb|pbkdf|hmac_sha|sqlite3_key|kdf_iter/i.test(String(pattern || ''))) return true;
  }
  return false;
}

function findNearestX64FunctionStart(buf, pe, sourceRaw, sourceRva) {
  const section = findPeSectionByRva(pe, sourceRva);
  const minRaw = section ? Number(section.pointer_to_raw_data || 0) : Math.max(0, sourceRaw - 0x800);
  const start = Math.max(minRaw, sourceRaw - 0x800);
  let best = null;
  for (let raw = sourceRaw; raw >= start; raw--) {
    if (!looksLikeX64FunctionPrologue(buf, raw)) continue;
    const rva = rawToRvaInSection(section, raw);
    if (!rva) continue;
    best = { raw, rva };
    break;
  }
  return best;
}

function findPeSectionByRva(pe, rva) {
  const value = Number(rva || 0);
  for (const section of pe?.sections || []) {
    const start = Number(section.virtual_address || 0);
    const size = Math.max(Number(section.virtual_size || 0), Number(section.size_of_raw_data || 0));
    if (size && value >= start && value < start + size) return section;
  }
  return null;
}

function rawToRvaInSection(section, raw) {
  if (!section) return 0;
  const rawStart = Number(section.pointer_to_raw_data || 0);
  const rawSize = Number(section.size_of_raw_data || 0);
  if (!rawSize || raw < rawStart || raw >= rawStart + rawSize) return 0;
  return Number(section.virtual_address || 0) + (raw - rawStart);
}

function rvaToRawInSection(section, rva) {
  if (!section) return 0;
  const sectionRva = Number(section.virtual_address || 0);
  const rawStart = Number(section.pointer_to_raw_data || 0);
  const rawSize = Number(section.size_of_raw_data || 0);
  const virtualSize = Number(section.virtual_size || rawSize || 0);
  const size = Math.max(rawSize, virtualSize);
  if (!size || rva < sectionRva || rva >= sectionRva + size) return 0;
  const raw = rawStart + (rva - sectionRva);
  return raw >= rawStart && raw < rawStart + rawSize ? raw : 0;
}

function looksLikeX64FunctionPrologue(buf, raw) {
  if (raw < 0 || raw + 8 >= buf.length) return false;
  const b0 = buf[raw];
  const b1 = buf[raw + 1];
  const b2 = buf[raw + 2];
  const b3 = buf[raw + 3];
  const b4 = buf[raw + 4];
  if (b0 === 0x40 && (b1 === 0x53 || b1 === 0x55 || b1 === 0x56 || b1 === 0x57)) return true;
  if (b0 === 0x48 && b1 === 0x83 && b2 === 0xec) return true;
  if (b0 === 0x48 && b1 === 0x81 && b2 === 0xec) return true;
  if (b0 === 0x48 && b1 === 0x89 && (b2 === 0x5c || b2 === 0x6c || b2 === 0x74 || b2 === 0x7c)) return true;
  if (b0 === 0x48 && b1 === 0x8b && b2 === 0xc4) return true;
  if (b0 === 0x4c && b1 === 0x8b && b2 === 0xdc) return true;
  if (b0 === 0x55 && b1 === 0x48 && b2 === 0x8b && b3 === 0xec) return true;
  if (b0 === 0x55 && b1 === 0x56 && b2 === 0x57) return true;
  if (b0 === 0x48 && b1 === 0x89 && b2 === 0x4c && b3 === 0x24 && b4 <= 0x78) return true;
  return false;
}

function scanDirectCallTargetsNearXref(buf, pe, sourceRaw, sourceRva, fn) {
  const section = findPeSectionByRva(pe, sourceRva);
  const rawStart = section ? Number(section.pointer_to_raw_data || 0) : Math.max(0, sourceRaw - 0x400);
  const rawEnd = section ? rawStart + Number(section.size_of_raw_data || 0) : Math.min(buf.length, sourceRaw + 0x400);
  const start = Math.max(rawStart, fn?.raw ? fn.raw : sourceRaw - 0x260);
  const end = Math.min(rawEnd, sourceRaw + 0x300, start + 0x900);
  const sectionRva = section ? Number(section.virtual_address || 0) : sourceRva - (sourceRaw - rawStart);
  return scanDirectCallTargetsInRange(buf, pe, start, end, rawStart, sectionRva);
}

function isRvaInExecutableSection(pe, rva) {
  const section = findPeSectionByRva(pe, rva);
  if (!section) return false;
  return executablePeSections(pe).includes(section);
}

function targetKindWeight(kind) {
  return kind === 'db' ? 2 : 1;
}

function patternXrefWeight(pattern) {
  const text = String(pattern || '').toLowerCase();
  if (/sqlcipher|sqlite3_key|cipher_page_size|cipher_hmac|cipher_kdf|pbkdf|hmac_sha|wcdb/.test(text)) return 100;
  if (/sqlite|pragma|cipher|db_storage|xwechat|message_|contact\.db|session\.db/.test(text)) return 70;
  if (/aes|hmac|sha|hkdf|derive|encrypt|decrypt/.test(text)) return 40;
  return 1;
}

function addStringClusterHit(buckets, hit, kind) {
  const rva = Number(hit?.rva || 0);
  if (!Number.isFinite(rva) || rva <= 0) return;
  const section = hit.section || 'unknown';
  const bucketRva = Math.floor(rva / 0x1000) * 0x1000;
  const key = `${section}:${bucketRva}`;
  let item = buckets.get(key);
  if (!item) {
    item = {
      section,
      rva_bucket: bucketRva,
      hit_count: 0,
      db_hit_count: 0,
      crypto_hit_count: 0,
      patterns: new Set(),
      db_patterns: new Set(),
      crypto_patterns: new Set(),
    };
    buckets.set(key, item);
  }
  item.hit_count++;
  const pattern = String(hit.pattern || '').slice(0, 80);
  if (pattern) item.patterns.add(pattern);
  if (kind === 'crypto') {
    item.crypto_hit_count++;
    if (pattern) item.crypto_patterns.add(pattern);
  } else {
    item.db_hit_count++;
    if (pattern) item.db_patterns.add(pattern);
  }
}

function numberToHex(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `0x${Math.trunc(n).toString(16)}`;
}

function parseHexRva(value) {
  const text = String(value || '').trim();
  if (!/^0x[0-9a-f]+$/i.test(text)) return 0;
  const n = Number.parseInt(text.slice(2), 16);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function pickAccount(accounts, accountId = '') {
  if (!accounts?.length) return null;
  if (accountId) {
    const found = accounts.find(a => a.id === accountId || a.wxid === accountId);
    if (found) return found;
  }
  return accounts[0];
}

export async function listDbFiles(account, category = '') {
  if (!account?.db_storage) return [];
  const roots = [];
  if (category) roots.push(path.join(account.db_storage, category));
  else {
    const dirs = await fsp.readdir(account.db_storage, { withFileTypes: true }).catch(() => []);
    for (const entry of dirs) if (entry.isDirectory()) roots.push(path.join(account.db_storage, entry.name));
  }
  const files = [];
  for (const root of roots) {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.db')) continue;
      const full = path.join(root, entry.name);
      const st = await fsp.stat(full).catch(() => null);
      if (!st) continue;
      files.push({
        path: full,
        category: path.basename(root),
        name: entry.name,
        bytes: st.size,
        last_write_time: st.mtime.toISOString(),
      });
    }
  }
  files.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return files;
}

export function existsSyncSafe(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function accountNameToWxid(name) {
  return String(name || '').replace(/_[0-9a-f]{4}$/i, '');
}

function accountNameToDisplay(name) {
  return accountNameToWxid(name).replace(/^wxid_/, 'wxid_');
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(stdout || stderr || '');
    });
  });
}
