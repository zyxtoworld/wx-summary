import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, DEFAULT_DIGESTS_DIR, OUTPUTS_DIR, PROJECT_ROOT, TMP_DIR, outputDirFromSettings, resolveInsideTmp } from '../lib/paths.js';
import { cloneJson, deepMerge, ensureDir, readJson, writeJsonAtomic } from '../lib/json-store.js';
import { protectText, unprotectToText } from './dpapi.js';

export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const SECRETS_FILE = path.join(DATA_DIR, 'secrets.bin');
export const CURSORS_FILE = path.join(DATA_DIR, 'cursors.json');
const DEFAULT_LOG_FILE = './outputs/.tmp/wx-summary.log';
let SETTINGS_SAVE_QUEUE = Promise.resolve();

export function defaultSettings() {
  return {
    llm: {
      provider: 'openai',
      base_url: '',
      model: '',
      long_context_model: '',
      available_models: [],
      models_fetched_at: null,
      capabilities: {},
      temperature: 0.3,
      timeout_ms: 120000,
      max_input_chars: 60000,
      max_messages_per_call: 800,
      max_image_chars_per_call: 300000,
      ai_concurrency: 2,
      custom_model: false,
      custom_long_context_model: false,
    },
    privacy: { redact_phone: true, redact_id_card: true, redact_bank_card: true, redact_email: false },
    link_preview: { enabled: true, ai_web_search: true, max_links: 0, allow_private_networks: false, timeout_ms: 8000, max_bytes: 262144, max_chars_per_link: 2000, max_related_links: 3, max_related_bytes: 98304, max_related_chars: 800 },
    groups: { whitelist: [], overrides: [], recent: [] },
    scheduler: { enabled: false, default_interval: '30m', digest_window: '4h', min_messages_per_digest: 30, per_group: [] },
    output: { dir: './outputs/digests', retention_days: 0, filename_pattern: '{group}__{since}_{until}__{id8}.png' },
    render: { default_theme: 'auto', default_font_size: 'normal', width_px: 1080, dpi_scale: 2 },
    web: { host: '127.0.0.1', port: 7788, open_browser: true },
    cache: { decrypted_db_dir: './outputs/.tmp/db', keep_decrypted_copy: false },
    wechat: { manual_key_set: false },
    logging: { level: 'info', file: DEFAULT_LOG_FILE, max_mb: 50 },
  };
}

export async function ensureRuntimeDirs(settings = defaultSettings()) {
  await ensureDir(DATA_DIR);
  await ensureDir(OUTPUTS_DIR);
  await ensureDir(TMP_DIR);
  await ensureDir(DEFAULT_DIGESTS_DIR);
  await ensureDir(outputDirFromSettings(settings));
}

export async function clearTmpDir() {
  await ensureDir(TMP_DIR);
  const entries = await fsp.readdir(TMP_DIR, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async entry => {
    const full = path.join(TMP_DIR, entry.name);
    await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
  }));
  await ensureDir(TMP_DIR);
}

export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  const tail = s.slice(-4);
  return `${s.startsWith('sk-') ? 'sk-' : ''}…${tail}`;
}

export function splitManualKeys(value) {
  return [...new Set(String(value || '')
    .split(/[\s,，;；]+/)
    .map(item => item.trim().toLowerCase())
    .filter(Boolean))];
}

export function normalizeManualKeysText(value) {
  const keys = splitManualKeys(value);
  const invalid = keys.filter(key => !/^(?:[a-f0-9]{64}|[a-f0-9]{96})$/.test(key));
  if (invalid.length) {
    const err = new Error('manual_key entries must be 64 or 96 hex chars');
    err.status = 400;
    throw err;
  }
  return keys.join('\n');
}

function stripSensitive(settings) {
  const clean = cloneJson(settings);
  delete clean.llm.api_key;
  delete clean.llm.api_key_set;
  delete clean.llm.api_key_display;
  delete clean.llm.clear_api_key;
  delete clean.wechat.manual_key;
  delete clean.wechat.manual_key_set;
  delete clean.wechat.clear_manual_key;
  delete clean._secrets_invalid;
  return clean;
}

export async function loadSecrets({ file = SECRETS_FILE } = {}) {
  try {
    const encrypted = await fsp.readFile(file);
    const text = await unprotectToText(encrypted);
    const parsed = JSON.parse(text || '{}');
    return { secrets: { api_key: parsed.api_key || '', manual_key: parsed.manual_key || '' }, invalid: false };
  } catch (e) {
    if (e?.code === 'ENOENT') return { secrets: { api_key: '', manual_key: '' }, invalid: false };
    await fsp.rm(file, { force: true }).catch(() => {});
    return { secrets: { api_key: '', manual_key: '' }, invalid: true, error: e?.message || String(e) };
  }
}

export async function saveSecrets(secrets) {
  await ensureDir(DATA_DIR);
  const filtered = {
    api_key: secrets.api_key || '',
    manual_key: secrets.manual_key || '',
  };
  const encrypted = await protectText(JSON.stringify(filtered));
  const tmp = path.join(DATA_DIR, `secrets.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, encrypted);
    await fsp.rename(tmp, SECRETS_FILE);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export async function loadSettings({ includeSecrets = false } = {}) {
  const raw = await readJson(SETTINGS_FILE, {}, { strict: true });
  const merged = normalizeSettings(deepMerge(defaultSettings(), raw));
  const secretState = await loadSecrets();
  merged.llm.api_key_set = !!secretState.secrets.api_key;
  merged.llm.api_key_display = maskSecret(secretState.secrets.api_key);
  merged.wechat.manual_key_set = !!secretState.secrets.manual_key;
  merged._secrets_invalid = !!secretState.invalid;
  if (includeSecrets) {
    merged.llm.api_key = secretState.secrets.api_key;
    merged.wechat.manual_key = secretState.secrets.manual_key;
  }
  return merged;
}

export async function publicSettings() {
  return stripRuntime(await loadSettings());
}

export function stripRuntime(settings) {
  const s = cloneJson(settings);
  delete s.llm.api_key;
  delete s.wechat.manual_key;
  return s;
}

export function normalizeSettings(settings) {
  const s = cloneJson(settings);
  const defaults = defaultSettings();
  s.llm = plainObject(s.llm) ? s.llm : cloneJson(defaults.llm);
  s.privacy = plainObject(s.privacy) ? s.privacy : cloneJson(defaults.privacy);
  s.link_preview = plainObject(s.link_preview) ? s.link_preview : cloneJson(defaults.link_preview);
  s.groups = plainObject(s.groups) ? s.groups : cloneJson(defaults.groups);
  s.scheduler = plainObject(s.scheduler) ? s.scheduler : cloneJson(defaults.scheduler);
  s.output = plainObject(s.output) ? s.output : cloneJson(defaults.output);
  s.render = plainObject(s.render) ? s.render : cloneJson(defaults.render);
  s.web = plainObject(s.web) ? s.web : cloneJson(defaults.web);
  s.cache = plainObject(s.cache) ? s.cache : cloneJson(defaults.cache);
  s.wechat = plainObject(s.wechat) ? s.wechat : cloneJson(defaults.wechat);
  s.logging = plainObject(s.logging) ? s.logging : cloneJson(defaults.logging);
  if (s.llm) delete s.llm.clear_api_key;
  if (s.wechat) delete s.wechat.clear_manual_key;
  if (s.wechat) delete s.wechat.data_source;
  s.llm.provider = ['openai', 'anthropic'].includes(s.llm.provider) ? s.llm.provider : 'openai';
  s.llm.base_url = normalizeBaseUrl(s.llm.base_url);
  s.llm.temperature = finiteNumber(s.llm.temperature, 0.3, 0, 2);
  s.llm.timeout_ms = finiteInteger(s.llm.timeout_ms, 120000, 1000, 600000);
  s.llm.max_input_chars = finiteInteger(s.llm.max_input_chars, 60000, 1000, 1000000);
  s.llm.max_messages_per_call = finiteInteger(s.llm.max_messages_per_call, 800, 1, 20000);
  s.llm.max_image_chars_per_call = finiteInteger(s.llm.max_image_chars_per_call, 300000, 100000, 2 * 1024 * 1024);
  s.llm.ai_concurrency = finiteInteger(s.llm.ai_concurrency, 2, 1, Number.MAX_SAFE_INTEGER);
  s.llm.capabilities = normalizeLlmCapabilities(s.llm.capabilities);
  s.link_preview = s.link_preview && typeof s.link_preview === 'object' ? s.link_preview : {};
  s.link_preview.enabled = true;
  s.link_preview.ai_web_search = s.link_preview.ai_web_search !== false;
  s.link_preview.max_links = 0;
  s.link_preview.allow_private_networks = s.link_preview.allow_private_networks === true;
  s.link_preview.timeout_ms = finiteInteger(s.link_preview.timeout_ms, 8000, 1000, 60000);
  s.link_preview.max_bytes = finiteInteger(s.link_preview.max_bytes, 262144, 8192, 2 * 1024 * 1024);
  s.link_preview.max_chars_per_link = finiteInteger(s.link_preview.max_chars_per_link, 2000, 200, 10000);
  s.link_preview.max_related_links = finiteInteger(s.link_preview.max_related_links, 3, 0, 10);
  s.link_preview.max_related_bytes = finiteInteger(s.link_preview.max_related_bytes, 98304, 8192, 1024 * 1024);
  s.link_preview.max_related_chars = finiteInteger(s.link_preview.max_related_chars, 800, 200, 5000);
  s.groups = s.groups && typeof s.groups === 'object' ? s.groups : {};
  s.groups.whitelist = normalizeGroupRefs(s.groups.whitelist, 500);
  s.groups.overrides = Array.isArray(s.groups.overrides) ? s.groups.overrides : [];
  s.groups.recent = normalizeGroupRefs(s.groups.recent, 5);
  s.scheduler = s.scheduler && typeof s.scheduler === 'object' ? s.scheduler : {};
  s.scheduler.enabled = !!s.scheduler.enabled;
  s.scheduler.default_interval = normalizeDurationText(s.scheduler.default_interval, '30m');
  s.scheduler.digest_window = normalizeDurationText(s.scheduler.digest_window, '4h');
  s.scheduler.min_messages_per_digest = finiteInteger(s.scheduler.min_messages_per_digest, 30, 1, 10000);
  s.scheduler.per_group = normalizePerGroupOverrides([
    ...(Array.isArray(s.scheduler.per_group) ? s.scheduler.per_group : []),
    ...(Array.isArray(s.groups.overrides) ? s.groups.overrides : []),
  ]);
  s.groups.overrides = [];
  if (!outputDirIsSafe(s.output.dir)) s.output.dir = defaults.output.dir;
  s.output.retention_days = finiteInteger(s.output.retention_days, 0, 0, 3650);
  s.output.filename_pattern = normalizeFilenamePattern(s.output.filename_pattern, defaults.output.filename_pattern);
  s.render.width_px = finiteInteger(s.render.width_px, 1080, 320, 2160);
  s.render.dpi_scale = finiteInteger(s.render.dpi_scale, 2, 1, 4);
  s.web.host = '127.0.0.1';
  s.web.port = finiteInteger(s.web.port, 7788, 1024, 65535);
  s.web.open_browser = s.web.open_browser !== false;
  s.logging = s.logging && typeof s.logging === 'object' ? s.logging : {};
  s.logging.level = ['debug', 'info', 'warn', 'error'].includes(s.logging.level) ? s.logging.level : 'info';
  s.logging.max_mb = finiteInteger(s.logging.max_mb, 50, 1, 500);
  try {
    resolveInsideTmp(s.logging.file || DEFAULT_LOG_FILE, 'logging.file');
    s.logging.file = String(s.logging.file || DEFAULT_LOG_FILE);
  } catch {
    s.logging.file = DEFAULT_LOG_FILE;
  }
  return s;
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringList(value, limit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))].slice(0, limit);
}

function normalizeGroupRefs(value, limit) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const ref = normalizeGroupRef(item);
    if (!ref) continue;
    const key = typeof ref === 'string'
      ? `legacy:${ref}`
      : `ref:${ref.account_id || '*'}:${ref.group_id || ref.group_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeGroupRef(item) {
  if (typeof item === 'string') {
    const legacy = item.trim();
    return legacy || null;
  }
  if (!plainObject(item)) return null;
  const accountId = String(item.account_id || item.account || '').trim();
  const groupId = String(item.group_id || item.id || '').trim();
  const groupName = String(item.group_name || item.name || '').trim();
  const legacyGroup = String(item.group || '').trim();
  if (!groupId && !groupName && legacyGroup) {
    if (!accountId) return legacyGroup;
    return {
      account_id: accountId.slice(0, 200),
      group_name: legacyGroup.slice(0, 300),
    };
  }
  if (!groupId && !groupName) return null;
  const ref = {};
  if (accountId) ref.account_id = accountId.slice(0, 200);
  if (groupId) ref.group_id = groupId.slice(0, 300);
  if (groupName) ref.group_name = groupName.slice(0, 300);
  return ref;
}

function normalizePerGroupOverrides(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      const accountId = String(item?.account_id || item?.account || '').trim();
      const groupId = String(item?.group_id || item?.id || '').trim();
      const groupName = String(item?.group_name || item?.name || '').trim();
      const group = String(item?.group || groupId || groupName || '').trim();
      const keywords = Array.isArray(item?.keywords)
        ? item.keywords.map(x => String(x || '').trim()).filter(Boolean)
        : String(item?.keywords || '').split(/[,，]/).map(x => x.trim()).filter(Boolean);
      const min = finiteInteger(item?.min_messages ?? item?.min_messages_per_digest, 0, 0, 10000);
      if (!group && !groupId && !groupName) return null;
      const out = {
        group: group || groupId || groupName,
        keywords: [...new Set(keywords)].slice(0, 20),
        min_messages: min,
      };
      if (accountId) out.account_id = accountId.slice(0, 200);
      if (groupId) out.group_id = groupId.slice(0, 300);
      if (groupName) out.group_name = groupName.slice(0, 300);
      return out;
    })
    .filter(item => item && (item.keywords.length || item.min_messages > 0))
    .slice(0, 200);
}

function normalizeLlmCapabilities(value) {
  if (!plainObject(value)) return {};
  const out = {};
  const provider = String(value.provider || '').trim();
  if (['openai', 'anthropic'].includes(provider)) out.provider = provider;
  const baseUrl = normalizeBaseUrl(value.base_url || '');
  if (baseUrl) out.base_url = baseUrl;
  const model = String(value.model || '').trim();
  if (model) out.model = model.slice(0, 200);
  const longContextModel = String(value.long_context_model || value.long_context?.model || '').trim();
  if (longContextModel) out.long_context_model = longContextModel.slice(0, 200);
  const checkedAt = String(value.checked_at || '').trim();
  if (checkedAt && !Number.isNaN(Date.parse(checkedAt))) out.checked_at = new Date(checkedAt).toISOString();
  copyLlmCapabilityItems(value, out);
  const longContext = normalizeLlmCapabilityGroup(value.long_context);
  if (Object.keys(longContext).length) {
    if (!longContext.model && out.long_context_model) longContext.model = out.long_context_model;
    out.long_context = longContext;
  }
  return out;
}

function normalizeLlmCapabilityGroup(value) {
  if (!plainObject(value)) return {};
  const out = {};
  const model = String(value.model || '').trim();
  if (model) out.model = model.slice(0, 200);
  const checkedAt = String(value.checked_at || '').trim();
  if (checkedAt && !Number.isNaN(Date.parse(checkedAt))) out.checked_at = new Date(checkedAt).toISOString();
  copyLlmCapabilityItems(value, out);
  return out;
}

function copyLlmCapabilityItems(source, out) {
  for (const key of ['chat', 'responses', 'responses_web_search', 'messages']) {
    const value = source || {};
    const item = value[key];
    if (!plainObject(item) || typeof item.ok !== 'boolean') continue;
    out[key] = {
      ok: !!item.ok,
      latency_ms: finiteInteger(item.latency_ms, 0, 0, 600000),
    };
    const error = String(item.error || '').trim();
    if (error && !item.ok) out[key].error = error.slice(0, 300);
  }
}

function finiteNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function finiteInteger(value, fallback, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function durationToMs(value) {
  const match = String(value || '').trim().match(/^(\d+)\s*([mhd])$/i);
  if (!match) return 0;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = match[2].toLowerCase();
  const scale = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * scale;
}

function normalizeDurationText(value, fallback) {
  const raw = String(value || '').trim().toLowerCase();
  return durationToMs(raw) ? raw : fallback;
}

function outputDirIsSafe(value) {
  try {
    outputDirFromSettings({ output: { dir: value } });
    return true;
  } catch {
    return false;
  }
}

function normalizeFilenamePattern(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 160) return fallback;
  if (/[\\/]|(?:^|[.])\.(?:[.]|$)|[<>:"|?*\x00-\x1F]/.test(raw)) return fallback;
  if (!/\{id8\}|\{group\}|\{since\}|\{until\}/.test(raw)) return fallback;
  return /\.png$/i.test(raw) ? raw : `${raw}.png`;
}

export function validateSettingsObject(settings, { requireBaseUrl = false } = {}) {
  const errors = [];
  if (!['openai', 'anthropic'].includes(settings.llm.provider)) errors.push('llm.provider must be openai or anthropic');
  if (settings.llm.base_url || requireBaseUrl) {
    try {
      const u = new URL(settings.llm.base_url);
      if (!['http:', 'https:'].includes(u.protocol)) errors.push('llm.base_url must be http(s)');
    } catch {
      errors.push('llm.base_url must be a valid URL');
    }
  }
  if (!outputDirIsSafe(settings.output?.dir)) {
    errors.push('output.dir must stay inside outputs/ and outside outputs/.tmp');
  }
  if (settings.web.host !== '127.0.0.1') errors.push('web.host is locked to 127.0.0.1');
  if (!durationToMs(settings.scheduler.default_interval)) errors.push('scheduler.default_interval must look like 30m, 4h, or 1d');
  if (!durationToMs(settings.scheduler.digest_window)) errors.push('scheduler.digest_window must look like 30m, 4h, or 1d');
  return errors;
}

export async function saveSettingsPatch(patch) {
  return withSettingsSaveLock(() => saveSettingsPatchUnlocked(patch));
}

async function withSettingsSaveLock(action) {
  const run = SETTINGS_SAVE_QUEUE.then(action, action);
  SETTINGS_SAVE_QUEUE = run.catch(() => {});
  return run;
}

async function saveSettingsPatchUnlocked(patch) {
  const current = await loadSettings({ includeSecrets: true });
  const nextPatch = cloneJson(patch || {});
  const nextSecrets = {
    api_key: current.llm.api_key || '',
    manual_key: current.wechat.manual_key || '',
  };
  let secretsChanged = false;

  if (nextPatch.llm && Object.hasOwn(nextPatch.llm, 'api_key')) {
    const value = String(nextPatch.llm.api_key || '');
    if (value) {
      nextSecrets.api_key = value;
      secretsChanged = true;
    }
    delete nextPatch.llm.api_key;
  }
  if (nextPatch.llm?.clear_api_key) {
    nextSecrets.api_key = '';
    secretsChanged = true;
    delete nextPatch.llm.clear_api_key;
  }
  if (nextPatch.wechat && Object.hasOwn(nextPatch.wechat, 'manual_key')) {
    const value = normalizeManualKeysText(nextPatch.wechat.manual_key);
    if (value) {
      nextSecrets.manual_key = value;
      secretsChanged = true;
    }
    delete nextPatch.wechat.manual_key;
  }
  if (nextPatch.wechat?.clear_manual_key) {
    nextSecrets.manual_key = '';
    secretsChanged = true;
    delete nextPatch.wechat.clear_manual_key;
  }

  if (nextPatch.output && Object.hasOwn(nextPatch.output, 'dir') && !outputDirIsSafe(nextPatch.output.dir)) {
    const err = new Error('output.dir must stay inside outputs/ and outside outputs/.tmp');
    err.status = 400;
    throw err;
  }
  const merged = normalizeSettings(deepMerge(stripSensitive(current), nextPatch));
  const validationErrors = validateSettingsObject(merged, { requireBaseUrl: !!nextPatch.llm });
  if (validationErrors.length) {
    const err = new Error(validationErrors.join('; '));
    err.status = 400;
    throw err;
  }

  await ensureRuntimeDirs(merged);
  await writeJsonAtomic(SETTINGS_FILE, stripSensitive(merged));
  if (secretsChanged) await saveSecrets(nextSecrets);
  return publicSettings();
}

export async function rememberModels({ provider, base_url, models }) {
  const ids = Array.isArray(models) ? models.map(m => (typeof m === 'string' ? { id: m } : m)).filter(m => m?.id) : [];
  const current = await loadSettings();
  if (current.llm.provider !== provider || current.llm.base_url !== normalizeBaseUrl(base_url)) return publicSettings();
  return saveSettingsPatch({
    llm: {
      available_models: ids,
      models_fetched_at: new Date().toISOString(),
      model: current.llm.model || ids[0]?.id || '',
      long_context_model: current.llm.long_context_model || ids[0]?.id || '',
    },
  });
}

export function projectRoot() {
  return PROJECT_ROOT;
}
