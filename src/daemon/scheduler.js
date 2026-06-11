import crypto from 'node:crypto';
import { collectMessages, listAccounts, listGroups } from '../collector/index.js';
import { durationToMs, loadSettings } from '../config/settings.js';
import { discardRenderedHistoryItem, saveRenderedPng } from '../renderer/output.js';
import { renderDigestPngDataUrl } from '../renderer/server-png.js';
import { summarizeDigest, sanitizeText } from '../summarizer/llm.js';
import { getGroupCursorState, setGroupCursorState } from '../store/cursors.js';
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
let activeRunPromise = null;
const MAX_CURSOR_SEEN_MESSAGES = 20000;

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

export async function stopScheduler({ wait = false, timeout_ms = 30000 } = {}) {
  if (timer) clearTimeout(timer);
  timer = null;
  state.timer_active = false;
  state.next_run_at = '';
  logInfo('scheduler_stopped');
  if (wait && activeRunPromise) {
    await waitForSchedulerRun(activeRunPromise, timeout_ms).catch(e => {
      logWarn('scheduler_stop_wait_failed', { error: sanitizeText(e?.message || String(e)) });
    });
  }
}

export function getSchedulerStatus() {
  return { ...state, last_result: state.last_result ? { ...state.last_result } : null };
}

export async function runSchedulerOnce({ reason = 'manual', force = false } = {}) {
  if (state.running) {
    logWarn('scheduler_skipped', { reason, detail: 'already_running' });
    return { ok: true, skipped: true, reason, detail: 'already_running', at: new Date().toISOString() };
  }
  state.running = true;
  const runPromise = (async () => {
    state.last_started_at = new Date().toISOString();
    state.last_error = '';
    logInfo('scheduler_run_started', { reason });
    try {
      const result = await executeSchedulerTick({ reason, force });
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
  })();
  activeRunPromise = runPromise;
  try {
    return await runPromise;
  } finally {
    if (activeRunPromise === runPromise) activeRunPromise = null;
  }
}

function waitForSchedulerRun(runPromise, timeoutMs) {
  const timeout = Math.max(1000, Number(timeoutMs || 30000));
  return Promise.race([
    runPromise.catch(() => {}),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`scheduler run did not finish within ${timeout}ms`)), timeout)),
  ]);
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

async function executeSchedulerTick({ reason, force = false }) {
  const settings = await loadSettings({ includeSecrets: true });
  state.enabled = !!settings.scheduler.enabled;
  state.interval_ms = durationToMs(settings.scheduler.default_interval);
  if (!settings.scheduler.enabled && !force) return { ok: true, reason, skipped: true, detail: 'scheduler_disabled', at: new Date().toISOString() };
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
  const accountEntries = [];
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
    accountEntries.push({ account, groups });
  }
  const allGroups = schedulerGroupUniverse(accountEntries);
  const ambiguousRefs = ambiguousSchedulerRefs([
    ...(Array.isArray(settings.groups?.whitelist) ? settings.groups.whitelist : []),
    ...(Array.isArray(settings.scheduler?.per_group) ? settings.scheduler.per_group : []),
  ], allGroups);
  if (ambiguousRefs.length) {
    result.ambiguous_refs = ambiguousRefs;
    logWarn('scheduler_ambiguous_group_refs', { refs: ambiguousRefs });
  }
  for (const { account, groups } of accountEntries) {
    const accountId = accountIdentity(account);
    const targets = selectScheduledGroups(groups, settings.groups?.whitelist || [], account, { allGroups });
    for (const group of targets) {
      result.checked++;
      const item = await runGroupDigestWithRetry({ settings, account, group, window, attempts: 2, allGroups });
      result.items.push(item);
      if (item.generated) result.generated++;
      else if (item.error) result.failed++;
      else result.skipped++;
      if (item.generated) logInfo('scheduler_group_generated', { account_id: accountId, group_id: group.id, group: group.name, digest_id: item.digest_id, message_count: item.message_count });
      else if (item.error) logError('scheduler_group_failed', { account_id: accountId, group_id: group.id, group: group.name, error: item.error, attempts: item.attempts });
      else logInfo('scheduler_group_skipped', { account_id: accountId, group_id: group.id, group: group.name, detail: item.detail, message_count: item.message_count });
    }
  }
  if (!result.checked && !result.failed) {
    return { ...result, skipped: true, detail: ambiguousRefs.length ? 'ambiguous_group_refs' : 'no_whitelisted_groups' };
  }
  return result;
}

async function runGroupDigestWithRetry({ attempts = 2, ...args }) {
  let lastError;
  let usedAttempts = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    usedAttempts = attempt;
    try {
      const item = await runGroupDigest(args);
      return { ...item, attempts: attempt };
    } catch (e) {
      lastError = e;
      if (e?.scheduler_no_retry) break;
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
    attempts: usedAttempts || attempts,
    error: sanitizeText(lastError?.message || String(lastError)),
  };
}

async function runGroupDigest({ settings, account, group, window, allGroups = [] }) {
  const override = schedulerOverrideForGroup(settings.scheduler?.per_group, group, account, { allGroups });
  const minMessages = override?.min_messages || settings.scheduler.min_messages_per_digest;
  let collection = await collectMessages({
    account_id: accountIdentity(account),
    group_id: group.id,
    group_name: group.name,
    since: window.since,
    until: window.until,
    filters: override?.keywords?.length ? { keywords: override.keywords } : {},
    min_messages: minMessages,
  });
  const cursorKey = groupCursorKey(account, group);
  const cursorState = await getGroupCursorState(cursorKey);
  const previousCursor = cursorState.last_seq;
  const previousSeen = new Set(Array.isArray(cursorState.seen) ? cursorState.seen : []);
  const windowMessageCount = collection.message_count || 0;
  const windowMessages = Array.isArray(collection.messages) ? collection.messages : [];
  const latestWindowCursor = latestMessageCursor(windowMessages);
  if ((cursorState.seen || []).length || previousCursor) {
    const newMessages = newMessagesForCursorState(windowMessages, cursorState);
    if (!newMessages.length && windowMessageCount) {
      await setGroupCursorState(cursorKey, schedulerCursorState({
        cursor: latestWindowCursor || previousCursor,
        messages: windowMessages,
        window,
      }));
      return {
        account_id: accountIdentity(account),
        account: account.name || accountIdentity(account),
        group_id: group.id,
        group: group.name,
        generated: false,
        message_count: 0,
        window_message_count: windowMessageCount,
        detail: 'no_new_messages',
        cursor: latestWindowCursor || previousCursor,
      };
    }
    collection = {
      ...collection,
      messages: newMessages,
      message_count: newMessages.length,
      window_message_count: windowMessageCount,
      since: newMessages[0]?.time || collection.since,
    };
  }
  if (!collection.message_count || collection.message_count < Number(minMessages || 0)) {
    const detail = collection.no_matching_filters ? 'no_matching_filters' : 'below_minimum';
    return {
      account_id: accountIdentity(account),
      account: account.name || accountIdentity(account),
      group_id: group.id,
      group: group.name,
      generated: false,
      message_count: collection.message_count || 0,
      pre_filter_message_count: collection.pre_filter_message_count || 0,
      window_message_count: collection.window_message_count || windowMessageCount,
      detail,
      min_messages: minMessages,
      keyword_override: override?.keywords || [],
    };
  }
  const latestCursor = latestMessageCursor(collection.messages);
  if (!previousSeen.size && shouldSkipUnchangedCursor(previousCursor, latestCursor)) {
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
  digest.media_status = collection.media_status || null;
  const pngDataUrl = await renderDigestPngDataUrl(digest, settings.render);
  const saved = await saveRenderedPng({ settings, digest, png_data_url: pngDataUrl });
  const cursor = latestWindowCursor || latestCursor || String(Date.now());
  try {
    await setGroupCursorState(cursorKey, schedulerCursorState({
      cursor,
      messages: windowMessages,
      window,
    }));
  } catch (e) {
    const message = sanitizeText(e?.message || String(e));
    await discardRenderedHistoryItem(settings, saved).catch(cleanupError => {
      e.cleanup_error = sanitizeText(cleanupError?.message || String(cleanupError));
      logWarn('scheduler_saved_digest_cleanup_failed', {
        account_id: accountIdentity(account),
        group_id: group.id,
        group: group.name,
        digest_id: digest.digest_id,
        error: e.cleanup_error,
      });
    });
    e.scheduler_no_retry = true;
    logError('scheduler_cursor_save_failed', {
      account_id: accountIdentity(account),
      group_id: group.id,
      group: group.name,
      digest_id: digest.digest_id,
      cursor_key: cursorKey,
      error: message,
    });
    throw e;
  }
  return {
    account_id: accountIdentity(account),
    account: account.name || accountIdentity(account),
    group_id: group.id,
    group: group.name,
    generated: true,
    message_count: collection.message_count,
    window_message_count: collection.window_message_count || windowMessageCount,
    digest_id: digest.digest_id,
    file_path: saved.file_path,
    cursor,
    cursor_key: cursorKey,
    min_messages: minMessages,
    keyword_override: override?.keywords || [],
  };
}

function accountIdentity(account = {}) {
  return String(account.account_id || account.id || account.wxid || account.account || '').trim();
}

function groupCursorKey(account = {}, group = {}) {
  const accountId = accountIdentity(account);
  const groupId = String(group.id || group.group_id || '').trim();
  return accountId ? `${accountId}::${groupId}` : groupId;
}

function shouldSkipUnchangedCursor(previousCursor, latestCursor) {
  return !!previousCursor && !!latestCursor && previousCursor === latestCursor;
}

function selectScheduledGroups(groups, whitelist, account = {}, { allGroups = [] } = {}) {
  const refs = Array.isArray(whitelist) ? whitelist : [];
  if (!refs.length) return [];
  return (groups || []).filter(group => refs.some(ref => groupRefMatches(ref, group, account, { allGroups })));
}

function schedulerOverrideForGroup(overrides = [], group = {}, account = {}, { allGroups = [] } = {}) {
  let best = null;
  let bestScore = 0;
  for (const item of Array.isArray(overrides) ? overrides : []) {
    const score = groupRefMatchScore(item, group, account, {
      legacyKeys: [item?.group, item?.group_id, item?.group_name, item?.name],
      allGroups,
    });
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function groupRefMatches(ref, group = {}, account = {}, { legacyKeys = [], allGroups = [] } = {}) {
  return groupRefMatchScore(ref, group, account, { legacyKeys, allGroups }) > 0;
}

function groupRefMatchScore(ref, group = {}, account = {}, { legacyKeys = [], allGroups = [] } = {}) {
  const accountId = accountIdentity(account);
  const groupId = String(group.id || group.group_id || '').trim();
  const groupName = String(group.name || group.group_name || '').trim();
  if (typeof ref === 'string') {
    const legacy = ref.trim();
    if (!legacy || (legacy !== groupId && legacy !== groupName)) return 0;
    return groupRefAmbiguousAcrossAccounts(legacy, group, account, allGroups) ? 0 : 1;
  }
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return 0;
  const refAccountId = String(ref.account_id || ref.account || '').trim();
  if (refAccountId && refAccountId !== accountId) return 0;
  const refGroupId = String(ref.group_id || ref.id || '').trim();
  if (refGroupId) {
    if (refGroupId !== groupId) return 0;
    if (!refAccountId && groupRefAmbiguousAcrossAccounts(refGroupId, group, account, allGroups)) return 0;
    return refAccountId ? 4 : 3;
  }
  const refGroupName = String(ref.group_name || ref.name || '').trim();
  if (refGroupName) {
    if (refGroupName !== groupName) return 0;
    if (!refAccountId && groupRefAmbiguousAcrossAccounts(refGroupName, group, account, allGroups)) return 0;
    return refAccountId ? 2 : 1;
  }
  const refLegacyGroup = String(ref.group || '').trim();
  if (refLegacyGroup) {
    if (refLegacyGroup !== groupId && refLegacyGroup !== groupName) return 0;
    return (!refAccountId && groupRefAmbiguousAcrossAccounts(refLegacyGroup, group, account, allGroups)) ? 0 : 1;
  }
  const legacy = legacyKeys.map(key => String(key || '').trim()).filter(Boolean);
  const matched = legacy.find(key => key === groupId || key === groupName);
  if (!matched) return 0;
  return groupRefAmbiguousAcrossAccounts(matched, group, account, allGroups) ? 0 : 1;
}

function schedulerGroupUniverse(accountEntries = []) {
  return (Array.isArray(accountEntries) ? accountEntries : []).flatMap(entry => {
    const account = entry?.account || {};
    return (Array.isArray(entry?.groups) ? entry.groups : []).map(group => ({ account, group }));
  });
}

function groupRefAmbiguousAcrossAccounts(value, group = {}, account = {}, allGroups = []) {
  const needle = String(value || '').trim();
  if (!needle || !Array.isArray(allGroups) || allGroups.length <= 1) return false;
  const matches = new Set();
  for (const entry of allGroups) {
    const candidateAccount = entry?.account || {};
    const candidateGroup = entry?.group || entry || {};
    const candidateAccountId = accountIdentity(candidateAccount);
    const candidateGroupId = String(candidateGroup.id || candidateGroup.group_id || '').trim();
    const candidateGroupName = String(candidateGroup.name || candidateGroup.group_name || '').trim();
    if (needle !== candidateGroupId && needle !== candidateGroupName) continue;
    matches.add(`${candidateAccountId}::${candidateGroupId || candidateGroupName}`);
  }
  if (matches.size <= 1) return false;
  const current = `${accountIdentity(account)}::${String(group.id || group.group_id || group.name || group.group_name || '').trim()}`;
  return matches.has(current) || matches.size > 1;
}

function ambiguousSchedulerRefs(refs = [], allGroups = []) {
  if (!Array.isArray(refs) || !Array.isArray(allGroups) || allGroups.length <= 1) return [];
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    for (const value of accountlessGroupRefValues(ref)) {
      const matches = matchingSchedulerGroupKeys(value, allGroups);
      if (matches.length <= 1) continue;
      const key = `${value}:${matches.join('|')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref: value, matches });
    }
  }
  return out.slice(0, 50);
}

function accountlessGroupRefValues(ref) {
  if (typeof ref === 'string') return ref.trim() ? [ref.trim()] : [];
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return [];
  const accountId = String(ref.account_id || ref.account || '').trim();
  if (accountId) return [];
  return [
    ref.group_id,
    ref.id,
    ref.group_name,
    ref.name,
    ref.group,
  ].map(value => String(value || '').trim()).filter(Boolean);
}

function matchingSchedulerGroupKeys(value, allGroups = []) {
  const needle = String(value || '').trim();
  if (!needle) return [];
  const matches = new Set();
  for (const entry of allGroups) {
    const account = entry?.account || {};
    const group = entry?.group || entry || {};
    const groupId = String(group.id || group.group_id || '').trim();
    const groupName = String(group.name || group.group_name || '').trim();
    if (needle !== groupId && needle !== groupName) continue;
    matches.add(`${accountIdentity(account)}::${groupId || groupName}`);
  }
  return [...matches].sort();
}

function schedulerWindow(value, now = new Date()) {
  const ms = durationToMs(value) || durationToMs('4h');
  return {
    since: formatLocalDateTime(new Date(now.getTime() - ms), { includeSeconds: true }),
    until: formatLocalDateTime(now, { includeSeconds: true }),
  };
}

function latestMessageCursor(messages = []) {
  const latest = [...messages].sort((a, b) => compareMessageCursor(b, a))[0];
  return latest ? messageCursor(latest) : '';
}

function messageCursor(message = {}) {
  const timestamp = normalizeCursorNumber(message.timestamp);
  const sortSeq = normalizeCursorNumber(message.sort_seq);
  const localId = normalizeCursorNumber(message.local_id);
  const serverId = cursorComponent(message.server_id);
  const messageId = cursorComponent(message.id);
  const parts = [
    timestamp ? `ts.${timestamp}` : '',
    sortSeq ? `seq.${sortSeq}` : '',
    localId ? `lid.${localId}` : '',
    serverId ? `sid.${serverId}` : '',
    messageId ? `id.${messageId}` : '',
  ].filter(Boolean);
  return parts.join(':') || cursorComponent(message.server_id || message.local_id || message.timestamp);
}

function messagesAfterCursor(messages = [], previousCursor = '') {
  const cursor = cursorObjectFromValue(previousCursor);
  if (!cursor) return Array.isArray(messages) ? messages : [];
  return (Array.isArray(messages) ? messages : []).filter(message => {
    const current = messageCursor(message);
    if (current && current === previousCursor) return false;
    return compareMessageCursor(message, cursor) > 0;
  });
}

function messagesNotSeen(messages = [], seen = new Set()) {
  return (Array.isArray(messages) ? messages : []).filter(message => !seen.has(messageIdentity(message)));
}

function newMessagesForCursorState(messages = [], cursorState = {}) {
  const previousCursor = cursorState.last_seq || '';
  const previousSeen = new Set(Array.isArray(cursorState.seen) ? cursorState.seen : []);
  if (!previousSeen.size) return messagesAfterCursor(messages, previousCursor);
  if (previousSeen.size >= MAX_CURSOR_SEEN_MESSAGES && previousCursor) {
    return messagesNotSeen(messagesAfterCursor(messages, previousCursor), previousSeen);
  }
  return messagesNotSeen(messages, previousSeen);
}

function schedulerCursorState({ cursor, messages = [], window = {} } = {}) {
  return {
    last_seq: cursor || latestMessageCursor(messages),
    seen: messageIdentityList(messages),
    window_since: window.since || '',
    window_until: window.until || '',
    message_count: Array.isArray(messages) ? messages.length : 0,
  };
}

function messageIdentityList(messages = []) {
  const ordered = [...(Array.isArray(messages) ? messages : [])].sort(compareMessageCursor);
  const recent = ordered.slice(Math.max(0, ordered.length - MAX_CURSOR_SEEN_MESSAGES));
  return [...new Set(recent.map(messageIdentity).filter(Boolean))];
}

function messageIdentity(message = {}) {
  const raw = JSON.stringify([
    normalizeCursorNumber(message.timestamp),
    normalizeCursorNumber(message.sort_seq),
    normalizeCursorNumber(message.local_id),
    String(message.server_id || ''),
    String(message.id || ''),
    String(message.sender || ''),
    String(message.type || ''),
    String(message.content || '').slice(0, 500),
  ]);
  return `m.${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

function cursorObjectFromValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const out = {};
  for (const part of text.split(':')) {
    const [key, ...rest] = part.split('.');
    const raw = rest.join('.');
    if (!key || !raw) continue;
    if (key === 'ts') out.timestamp = normalizeCursorNumber(raw);
    else if (key === 'seq') out.sort_seq = normalizeCursorNumber(raw);
    else if (key === 'lid') out.local_id = normalizeCursorNumber(raw);
    else if (key === 'sid') out.server_id = raw;
    else if (key === 'id') out.id = raw;
  }
  return Object.keys(out).length ? out : null;
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

function formatLocalDateTime(date, { includeSeconds = false } = {}) {
  const p = n => String(n).padStart(2, '0');
  const base = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
  return includeSeconds ? `${base}:${p(date.getSeconds())}` : base;
}

export const __schedulerInternals = {
  schedulerWindow,
  selectScheduledGroups,
  latestMessageCursor,
  messagesAfterCursor,
  messagesNotSeen,
  newMessagesForCursorState,
  messageIdentity,
  schedulerCursorState,
  accountIdentity,
  groupCursorKey,
  shouldSkipUnchangedCursor,
  schedulerOverrideForGroup,
  groupRefMatches,
  ambiguousSchedulerRefs,
};
