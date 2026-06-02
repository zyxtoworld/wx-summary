import { collectMessages, listAccounts, listGroups } from '../collector/index.js';
import { durationToMs, loadSettings } from '../config/settings.js';
import { saveRenderedPng } from '../renderer/output.js';
import { renderDigestPngDataUrl } from '../renderer/server-png.js';
import { summarizeDigest, sanitizeText } from '../summarizer/llm.js';
import { getGroupCursor, setGroupCursor } from '../store/cursors.js';
import { logError, logInfo, logWarn } from '../lib/logger.js';

const state = {
  enabled: false,
  running: false,
  timer_active: false,
  interval_ms: 0,
  next_run_at: '',
  last_started_at: '',
  last_finished_at: '',
  last_error: '',
  last_result: null,
};

let timer = null;

export async function startScheduler({ immediate = false } = {}) {
  stopScheduler();
  const settings = await loadSettings({ includeSecrets: true });
  state.enabled = !!settings.scheduler.enabled;
  state.interval_ms = durationToMs(settings.scheduler.default_interval);
  state.timer_active = false;
  state.next_run_at = '';
  state.last_error = '';
  if (!state.enabled) {
    logInfo('scheduler_disabled');
    return getSchedulerStatus();
  }
  scheduleNext(settings, immediate ? 0 : state.interval_ms);
  logInfo('scheduler_started', { interval_ms: state.interval_ms, next_run_at: state.next_run_at });
  return getSchedulerStatus();
}

export async function restartScheduler() {
  return startScheduler();
}

export function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
  state.timer_active = false;
  state.next_run_at = '';
  logInfo('scheduler_stopped');
}

export function getSchedulerStatus() {
  return { ...state, last_result: state.last_result ? { ...state.last_result } : null };
}

export async function runSchedulerOnce({ reason = 'manual' } = {}) {
  if (state.running) {
    logWarn('scheduler_skipped', { reason, detail: 'already_running' });
    return { skipped: true, reason: 'already_running' };
  }
  state.running = true;
  state.last_started_at = new Date().toISOString();
  state.last_error = '';
  logInfo('scheduler_run_started', { reason });
  try {
    const result = await executeSchedulerTick({ reason });
    state.last_result = result;
    logInfo('scheduler_run_finished', {
      reason,
      ok: result.ok,
      accounts: result.accounts || 0,
      checked: result.checked || 0,
      generated: result.generated || 0,
      skipped: result.skipped || 0,
      failed: result.failed || 0,
      detail: result.detail || '',
    });
    return result;
  } catch (e) {
    const message = sanitizeText(e?.message || String(e));
    state.last_error = message;
    state.last_result = { ok: false, reason, error: message, at: new Date().toISOString() };
    logError('scheduler_run_failed', { reason, error: message });
    throw e;
  } finally {
    state.running = false;
    state.last_finished_at = new Date().toISOString();
  }
}

function scheduleNext(settings, delayMs) {
  const delay = Math.max(1000, Number(delayMs || 0));
  state.timer_active = true;
  state.next_run_at = new Date(Date.now() + delay).toISOString();
  timer = setTimeout(async () => {
    timer = null;
    try {
      await runSchedulerOnce({ reason: 'timer' });
    } catch {
      // Keep the daemon alive; status carries the sanitized failure.
    } finally {
      const latest = await loadSettings({ includeSecrets: true }).catch(() => settings);
      if (latest.scheduler?.enabled) scheduleNext(latest, durationToMs(latest.scheduler.default_interval));
      else {
        state.enabled = false;
        state.timer_active = false;
        state.next_run_at = '';
      }
    }
  }, delay);
}

async function executeSchedulerTick({ reason }) {
  const settings = await loadSettings({ includeSecrets: true });
  state.enabled = !!settings.scheduler.enabled;
  state.interval_ms = durationToMs(settings.scheduler.default_interval);
  if (!settings.scheduler.enabled) return { ok: true, reason, skipped: true, detail: 'scheduler_disabled', at: new Date().toISOString() };
  if (!settings.llm.api_key || !settings.llm.base_url || !settings.llm.model) {
    logWarn('scheduler_skipped', { reason, detail: 'llm_not_configured' });
    return { ok: false, reason, skipped: true, detail: 'llm_not_configured', at: new Date().toISOString() };
  }

  const window = schedulerWindow(settings.scheduler.digest_window);
  const result = {
    ok: true,
    reason,
    at: new Date().toISOString(),
    since: window.since,
    until: window.until,
    accounts: 0,
    checked: 0,
    generated: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };

  const accounts = await listAccounts();
  for (const account of accounts) {
    result.accounts++;
    const accountId = accountIdentity(account);
    let groups = [];
    try {
      groups = await listGroups({ account_id: accountId });
    } catch (e) {
      const message = sanitizeText(e?.message || String(e));
      result.failed++;
      result.items.push({ account_id: accountId, account: account.name || accountId, generated: false, detail: 'account_groups_failed', error: message });
      logError('scheduler_account_failed', { account_id: accountId, error: message });
      continue;
    }
    const targets = selectScheduledGroups(groups, settings.groups?.whitelist || []);
    for (const group of targets) {
      result.checked++;
      const item = await runGroupDigestWithRetry({ settings, account, group, window, attempts: 2 });
      result.items.push(item);
      if (item.generated) result.generated++;
      else if (item.error) result.failed++;
      else result.skipped++;
      if (item.generated) logInfo('scheduler_group_generated', { account_id: accountId, group_id: group.id, group: group.name, digest_id: item.digest_id, message_count: item.message_count });
      else if (item.error) logError('scheduler_group_failed', { account_id: accountId, group_id: group.id, group: group.name, error: item.error, attempts: item.attempts });
      else logInfo('scheduler_group_skipped', { account_id: accountId, group_id: group.id, group: group.name, detail: item.detail, message_count: item.message_count });
    }
  }
  if (!result.checked && !result.failed) return { ...result, skipped: true, detail: 'no_whitelisted_groups' };
  return result;
}

async function runGroupDigestWithRetry({ attempts = 2, ...args }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const item = await runGroupDigest(args);
      return { ...item, attempts: attempt };
    } catch (e) {
      lastError = e;
      if (attempt < attempts) await sleep(1000 * attempt);
    }
  }
  const accountId = accountIdentity(args.account);
  return {
    account_id: accountId,
    account: args.account?.name || accountId,
    group_id: args.group?.id || '',
    group: args.group?.name || args.group?.id || '',
    generated: false,
    detail: 'error',
    attempts,
    error: sanitizeText(lastError?.message || String(lastError)),
  };
}

async function runGroupDigest({ settings, account, group, window }) {
  const override = schedulerOverrideForGroup(settings.scheduler?.per_group, group);
  const minMessages = override?.min_messages || settings.scheduler.min_messages_per_digest;
  const collection = await collectMessages({
    account_id: accountIdentity(account),
    group_id: group.id,
    group_name: group.name,
    since: window.since,
    until: window.until,
    filters: override?.keywords?.length ? { keywords: override.keywords } : {},
    min_messages: minMessages,
  });
  if (collection.below_minimum || !collection.message_count) {
    return {
      account_id: accountIdentity(account),
      account: account.name || accountIdentity(account),
      group_id: group.id,
      group: group.name,
      generated: false,
      message_count: collection.message_count || 0,
      detail: 'below_minimum',
      min_messages: minMessages,
      keyword_override: override?.keywords || [],
    };
  }
  const cursorKey = groupCursorKey(account, group);
  const latestCursor = latestMessageCursor(collection.messages);
  const previousCursor = await getGroupCursor(cursorKey);
  if (shouldSkipUnchangedCursor(previousCursor, latestCursor)) {
    return {
      account_id: accountIdentity(account),
      account: account.name || accountIdentity(account),
      group_id: group.id,
      group: group.name,
      generated: false,
      message_count: collection.message_count,
      detail: 'no_new_messages',
      cursor: latestCursor,
    };
  }
  const digest = await summarizeDigest({
    settings,
    groupName: collection.group_name,
    since: collection.since,
    until: collection.until,
    messages: collection.messages,
  });
  digest.input_message_count = collection.message_count;
  digest.scanned_message_count = collection.scanned_message_count || collection.message_count;
  digest.truncated = !!collection.truncated;
  digest.source_label = collection.source_label;
  const pngDataUrl = await renderDigestPngDataUrl(digest, settings.render);
  const saved = await saveRenderedPng({ settings, digest, png_data_url: pngDataUrl });
  const cursor = latestCursor || String(Date.now());
  await setGroupCursor(cursorKey, cursor);
  return {
    account_id: accountIdentity(account),
    account: account.name || accountIdentity(account),
    group_id: group.id,
    group: group.name,
    generated: true,
    message_count: collection.message_count,
    digest_id: digest.digest_id,
    file_path: saved.file_path,
    cursor,
    cursor_key: cursorKey,
    min_messages: minMessages,
    keyword_override: override?.keywords || [],
  };
}

function accountIdentity(account = {}) {
  return String(account.id || account.wxid || '').trim();
}

function groupCursorKey(account = {}, group = {}) {
  const accountId = accountIdentity(account);
  const groupId = String(group.id || group.group_id || '').trim();
  return accountId ? `${accountId}::${groupId}` : groupId;
}

function shouldSkipUnchangedCursor(previousCursor, latestCursor) {
  return !!previousCursor && !!latestCursor && previousCursor === latestCursor;
}

function selectScheduledGroups(groups, whitelist) {
  const wanted = new Set((whitelist || []).map(x => String(x || '').trim()).filter(Boolean));
  if (!wanted.size) return [];
  return (groups || []).filter(group => wanted.has(group.name) || wanted.has(group.id));
}

function schedulerOverrideForGroup(overrides = [], group = {}) {
  const groupId = String(group.id || '').trim();
  const groupName = String(group.name || '').trim();
  return (Array.isArray(overrides) ? overrides : []).find(item => {
    const key = String(item?.group || item?.group_id || '').trim();
    return key && (key === groupId || key === groupName);
  }) || null;
}

function schedulerWindow(value, now = new Date()) {
  const ms = durationToMs(value) || durationToMs('4h');
  return {
    since: formatLocalDateTime(new Date(now.getTime() - ms)),
    until: formatLocalDateTime(now),
  };
}

function latestMessageCursor(messages = []) {
  const latest = [...messages].sort((a, b) => compareMessageCursor(b, a))[0];
  if (!latest) return '';
  const timestamp = normalizeCursorNumber(latest.timestamp);
  const sortSeq = normalizeCursorNumber(latest.sort_seq);
  const localId = normalizeCursorNumber(latest.local_id);
  const serverId = cursorComponent(latest.server_id);
  const messageId = cursorComponent(latest.id);
  const parts = [
    timestamp ? `ts.${timestamp}` : '',
    sortSeq ? `seq.${sortSeq}` : '',
    localId ? `lid.${localId}` : '',
    serverId ? `sid.${serverId}` : '',
    messageId ? `id.${messageId}` : '',
  ].filter(Boolean);
  return parts.join(':') || cursorComponent(latest.server_id || latest.local_id || latest.timestamp);
}

function compareMessageCursor(a = {}, b = {}) {
  return normalizeCursorNumber(a.timestamp) - normalizeCursorNumber(b.timestamp)
    || normalizeCursorNumber(a.sort_seq) - normalizeCursorNumber(b.sort_seq)
    || normalizeCursorNumber(a.local_id) - normalizeCursorNumber(b.local_id)
    || String(a.id || a.server_id || '').localeCompare(String(b.id || b.server_id || ''));
}

function normalizeCursorNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function cursorComponent(value) {
  return String(value || '').trim().replace(/[^\w:.-]/g, '.').slice(0, 48);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatLocalDateTime(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

export const __schedulerInternals = {
  schedulerWindow,
  selectScheduledGroups,
  latestMessageCursor,
  accountIdentity,
  groupCursorKey,
  shouldSkipUnchangedCursor,
  schedulerOverrideForGroup,
};
