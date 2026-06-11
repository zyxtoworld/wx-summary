// wx-summary UI 脚本
// 模块化：路由 + 4 个页面渲染 + Canvas 长图绘制 + API 调用封装

const TOKEN = window.__WX_TOKEN__;
const $app = document.getElementById('app');
let _appState = null;
let _keyboardShortcutsAttached = false;
let _routeSeq = 0;
let _customRangeOutsideClickAttached = false;

function selectedAccountId() {
  return document.getElementById('account-switcher')?.value || '';
}

function wechatAppLabel(platform = _appState?.platform) {
  return platform === 'darwin' ? 'Mac 微信' : 'Weixin.exe';
}

function supportsServerRerender(platform = _appState?.platform) {
  return platform === 'win32';
}

// ---------- API 封装 ----------
function parseHttpErrorMessage(text, status = '') {
  const raw = String(text || '').trim();
  if (!raw) return status ? `请求失败（${status}）` : '请求失败';
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message || parsed?.error || parsed?.message || parsed?.detail;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch {}
  return raw;
}

async function api(path, opts = {}) {
  const headers = { 'X-WX-Token': TOKEN, ...(opts.headers || {}) };
  if (opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, { ...opts, headers });
  if (!r.ok) {
    const text = await r.text();
    if (r.status === 403 && text.includes('invalid token')) {
      location.reload();
      return await new Promise(() => {});
    }
    throw new Error(parseHttpErrorMessage(text, r.status));
  }
  return r.json();
}

// ---------- 主题 ----------
function effectiveAppTheme() {
  const selected = document.documentElement.dataset.theme;
  if (selected === 'dark' || selected === 'light') return selected;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function paintThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = effectiveAppTheme() === 'dark' ? '🌙' : '☀';
}

function applySystemTheme() {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.body.classList.toggle('is-dark', isDark);
  paintThemeToggle();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySystemTheme);
applySystemTheme();

document.getElementById('theme-toggle').addEventListener('click', () => {
  document.documentElement.dataset.theme = effectiveAppTheme() === 'dark' ? 'light' : 'dark';
  paintThemeToggle();
});

// ---------- 路由 ----------
const routes = {
  '/digest': renderDigest,
  '/history': renderHistory,
  '/settings': renderSettings,
  '/setup': renderSetup,
};

async function route() {
  const routeSeq = ++_routeSeq;
  const rawHash = location.hash.replace(/^#/, '') || '/digest';
  const hash = rawHash.split('?')[0] || '/digest';
  const fn = routes[hash] || renderDigest;
  closeTransientOverlays();
  // 设置导航 active
  document.querySelectorAll('.nav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + hash);
  });
  $app.innerHTML = '';
  try {
    await fn();
  } catch (e) {
    if (routeSeq === _routeSeq) renderRouteError(e);
  }
}

window.addEventListener('hashchange', route);

function closeTransientOverlays() {
  document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
  closeRerenderPanels();
}

function renderRouteError(error) {
  $app.innerHTML = `
    <section class="page">
      <section class="notice-card">
        <strong>页面加载失败</strong>
        <span>${escapeHtml(error?.message || '未知错误')}</span>
        <button class="link-btn" id="route-retry" type="button">重试</button>
      </section>
    </section>`;
  document.getElementById('route-retry')?.addEventListener('click', route);
}

function renderBootstrapError(error) {
  $app.innerHTML = `
    <section class="page">
      <section class="notice-card">
        <strong>启动检查失败</strong>
        <span>${escapeHtml(error?.message || '无法读取本机状态')}</span>
        <button class="link-btn" id="bootstrap-retry" type="button">重试</button>
      </section>
    </section>`;
  document.getElementById('bootstrap-retry')?.addEventListener('click', () => location.reload());
}

function handleAccountSwitch() {
  abortActiveDigest('切换账号');
  _state_digest.selectedGroups.clear();
  _state_digest.lastDigest = null;
  _state_digest.lastSavedItem = null;
  _state_digest.lastTextMarkdown = '';
  _state_digest.lastTextTitle = '';
  _state_digest.lastTextComplete = false;
  _state_digest.lastTextDone = 0;
  _state_digest.lastTextTotal = 0;
  _state_digest.lastTextPartialReason = '';
  _state_digest.progress = null;
  stopDigestProgressPaintTimer();
  route();
}

function abortActiveDigest(reason = '取消') {
  if (!_state_digest.abortController) return false;
  const batchId = _state_digest.activeBatchId;
  if (batchId) {
    void api('/api/digest-cancel', { method: 'POST', body: { batch_id: batchId, reason } }).catch(() => {});
  }
  _state_digest.abortReason = reason;
  _state_digest.abortController.abort();
  updateDigestCancelButton();
  return true;
}

async function bootstrap() {
  const accountsPromise = api('/api/accounts').then(
    accounts => ({ accounts }),
    error => ({ error }),
  );
  const statePromise = api('/api/state').then(
    state => ({ state }),
    error => ({ error }),
  );

  const accountResult = await accountsPromise;
  const sel = document.getElementById('account-switcher');
  if (sel) {
    if (accountResult.error) {
      sel.innerHTML = `<option value="">账号读取失败：${escapeHtml(accountResult.error.message || '未知错误')}</option>`;
      sel.disabled = true;
    } else {
      const accounts = accountResult.accounts || [];
      const previousValue = sel.value;
      const hadListener = sel.dataset.bound === '1';
      if (hadListener) sel.removeEventListener('change', handleAccountSwitch);
      sel.innerHTML = accounts.length
        ? accounts.map(a => `<option value="${escapeHtml(a.id || a.wxid)}">${escapeHtml(a.name)} (${escapeHtml(a.wxid)})</option>`).join('')
        : '<option value="">未检测到微信账号</option>';
      if (previousValue && accounts.some(a => (a.id || a.wxid) === previousValue)) sel.value = previousValue;
      sel.disabled = !accounts.length;
      sel.addEventListener('change', handleAccountSwitch);
      sel.dataset.bound = '1';
    }
  }

  const stateResult = await statePromise;
  if (stateResult.error) {
    renderBootstrapError(stateResult.error);
    return;
  }
  const state = stateResult.state;
  _appState = state;
  if (state.need_setup && !location.hash.includes('/setup')) {
    location.hash = '#/setup';
    return;
  }
  if (!location.hash) {
    location.hash = '#/digest';
    return;
  }
  await route();
}
bootstrap();

async function refreshTopbarAccounts() {
  try {
    const accounts = await api('/api/accounts');
    const sel = document.getElementById('account-switcher');
    sel.innerHTML = accounts.length
      ? accounts.map(a => `<option value="${escapeHtml(a.id || a.wxid)}">${escapeHtml(a.name)} (${escapeHtml(a.wxid)})</option>`).join('')
      : '<option value="">未检测到微信账号</option>';
    sel.disabled = !accounts.length;
    if (sel.dataset.bound !== '1') {
      sel.addEventListener('change', handleAccountSwitch);
      sel.dataset.bound = '1';
    }
    return accounts;
  } catch (e) {
    const sel = document.getElementById('account-switcher');
    if (sel) {
      sel.innerHTML = `<option value="">账号读取失败：${escapeHtml(e.message || '未知错误')}</option>`;
      sel.disabled = true;
    }
    return [];
  }
}

async function refreshAppStateSilently() {
  try {
    _appState = await api('/api/state');
    return _appState;
  } catch {
    return null;
  }
}

// ---------- 工具 ----------
function tplOf(id) {
  const tpl = document.getElementById(id);
  return tpl.content.cloneNode(true);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function splitManualKeysText(value) {
  return [...new Set(String(value || '')
    .split(/[\s,，;；]+/)
    .map(item => item.trim().toLowerCase())
    .filter(Boolean))];
}

function normalizeManualKeysText(value) {
  const keys = splitManualKeysText(value);
  const invalid = keys.filter(key => !/^(?:[a-f0-9]{64}|[a-f0-9]{96})$/.test(key));
  return { keys, invalid, text: keys.join('\n') };
}

function fmtTimeAgo(ts) {
  const value = Number(ts || 0);
  if (!Number.isFinite(value) || value < 946684800000) return '无近期消息';
  const d = Math.max(0, Date.now() - value);
  const m = Math.floor(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

const QUICK_RANGE_LABELS = {
  today: '今天',
  yesterday: '昨天',
  last4h: '最近 4h',
  last12h: '最近 12h',
  last1d: '最近 1d',
  thisweek: '本周',
  custom: '自定义',
};

function quickRangeToDates(key) {
  const now = new Date();
  const since = new Date(now);
  let includeSeconds = true;
  if (key === 'today') since.setHours(0, 0, 0, 0);
  else if (key === 'yesterday') {
    since.setDate(since.getDate() - 1);
    since.setHours(0, 0, 0, 0);
    now.setTime(since.getTime());
    now.setHours(23, 59, 59, 0);
  } else if (key === 'last4h') since.setHours(now.getHours() - 4);
  else if (key === 'last12h') since.setHours(now.getHours() - 12);
  else if (key === 'last1d') since.setDate(now.getDate() - 1);
  else if (key === 'thisweek') {
    const day = now.getDay() || 7;
    since.setDate(now.getDate() - (day - 1));
    since.setHours(0, 0, 0, 0);
  }
  return { since: fmtDateTime(since, { includeSeconds }), until: fmtDateTime(now, { includeSeconds }) };
}

function digestRangeLabel(key = _state_digest.rangeKey) {
  return QUICK_RANGE_LABELS[key] || QUICK_RANGE_LABELS.last1d;
}

function currentDigestRange() {
  if (_state_digest.rangeKey === 'custom') {
    ensureCustomRangeDefaults();
    return { since: _state_digest.customSince, until: _state_digest.customUntil || 'now' };
  }
  return quickRangeToDates(_state_digest.rangeKey);
}

function updateDigestRangeSummary() {
  const el = document.getElementById('range-summary');
  if (!el) return;
  const range = currentDigestRange();
  el.textContent = `${digestRangeLabel()}：${range.since} ~ ${range.until}`;
}

function fmtDateTime(d, { includeSeconds = false } = {}) {
  const pad = n => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return includeSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

const SUPERSCRIPT_RENDER_MAP = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  'ᴬ': 'A', 'ᴮ': 'B', 'ᴰ': 'D', 'ᴱ': 'E', 'ᴳ': 'G', 'ᴴ': 'H', 'ᴵ': 'I', 'ᴶ': 'J', 'ᴷ': 'K', 'ᴸ': 'L',
  'ᴹ': 'M', 'ᴺ': 'N', 'ᴼ': 'O', 'ᴾ': 'P', 'ᴿ': 'R', 'ᵀ': 'T', 'ᵁ': 'U', 'ⱽ': 'V', 'ᵂ': 'W',
  'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵉ': 'e', 'ᶠ': 'f', 'ᵍ': 'g', 'ʰ': 'h', 'ⁱ': 'i', 'ʲ': 'j',
  'ᵏ': 'k', 'ˡ': 'l', 'ᵐ': 'm', 'ⁿ': 'n', 'ᵒ': 'o', 'ᵖ': 'p', 'ʳ': 'r', 'ˢ': 's', 'ᵗ': 't', 'ᵘ': 'u',
  'ᵛ': 'v', 'ʷ': 'w', 'ˣ': 'x', 'ʸ': 'y', 'ᶻ': 'z',
};

function normalizeDecorativeGlyph(ch) {
  if (!ch || typeof ch.normalize !== 'function') return ch;
  const normalized = ch.normalize('NFKC');
  return normalized !== ch && /^[A-Za-z0-9 ()+./_-]+$/.test(normalized) ? normalized : ch;
}

function renderSafeText(text) {
  return String(text ?? '')
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ch => String.fromCharCode(ch.codePointAt(0) - 0x1F1E6 + 65))
    .replace(/([0-9#*])\uFE0F?\u20E3/g, '$1')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹ᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ]/g, ch => SUPERSCRIPT_RENDER_MAP[ch] || ch)
    .replace(/[\u{1D400}-\u{1D7FF}\u{2100}-\u{214F}\u{2460}-\u{24FF}]/gu, normalizeDecorativeGlyph)
    .replace(/\u1BE4/g, '')
    .replace(/\uFE0F/g, '')
    .replace(/(?<![A-Za-z])(?:[A-Z]\s+){2,}[A-Z](?![A-Za-z])/g, m => m.replace(/\s+/g, ''));
}

const GRAPHEME_SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('zh-Hans', { granularity: 'grapheme' })
  : null;

function splitGraphemes(text) {
  const value = String(text ?? '');
  if (!GRAPHEME_SEGMENTER) return Array.from(value);
  return Array.from(GRAPHEME_SEGMENTER.segment(value), item => item.segment);
}

function parseLocalDateTime(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '0'] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDurationParts(value, fallback = '30m') {
  const raw = String(value || fallback || '').trim().toLowerCase();
  const match = raw.match(/^(\d+)\s*([mhd])$/);
  if (!match) return parseDurationParts(fallback === raw ? '30m' : fallback, '30m');
  const amount = Math.max(1, Math.min(999, parseInt(match[1], 10) || 1));
  return { amount, unit: match[2] };
}

function setDurationControl(fieldId, value, fallback) {
  const parts = parseDurationParts(value, fallback);
  const hidden = document.getElementById(fieldId);
  const amount = document.getElementById(`${fieldId}-value`);
  const unit = document.getElementById(`${fieldId}-unit`);
  if (hidden) hidden.value = `${parts.amount}${parts.unit}`;
  if (amount) amount.value = parts.amount;
  if (unit) unit.value = parts.unit;
}

function getDurationControlValue(fieldId, fallback) {
  const fallbackParts = parseDurationParts(fallback);
  const amount = Math.max(1, Math.min(999, parseInt(document.getElementById(`${fieldId}-value`)?.value || '', 10) || fallbackParts.amount));
  const unit = ['m', 'h', 'd'].includes(document.getElementById(`${fieldId}-unit`)?.value)
    ? document.getElementById(`${fieldId}-unit`).value
    : fallbackParts.unit;
  const value = `${amount}${unit}`;
  const hidden = document.getElementById(fieldId);
  if (hidden) hidden.value = value;
  return value;
}

async function withBusyButtons(buttons, action) {
  const items = (Array.isArray(buttons) ? buttons : [buttons]).filter(Boolean);
  if (items.some(button => button.dataset.busy === '1')) return undefined;
  const previous = items.map(button => ({ button, disabled: button.disabled }));
  for (const { button } of previous) {
    button.dataset.busy = '1';
    button.disabled = true;
  }
  try {
    return await action();
  } finally {
    for (const { button, disabled } of previous) {
      delete button.dataset.busy;
      if (button.isConnected) button.disabled = disabled;
    }
  }
}

function normalizeAiConcurrency(value) {
  return Math.max(1, parseInt(value ?? '2', 10) || 2);
}

function fmtMonthTitle(date) {
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

function sameDay(a, b) {
  return a && b
    && a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function setupCustomRangePicker() {
  const startButton = document.getElementById('range-start');
  const endButton = document.getElementById('range-end');
  const popover = document.getElementById('range-popover');
  if (!startButton || !endButton || !popover) return;

  const hour = document.getElementById('range-hour');
  const minute = document.getElementById('range-minute');
  hour.innerHTML = Array.from({ length: 24 }, (_, i) => `<option value="${String(i).padStart(2, '0')}">${String(i).padStart(2, '0')}</option>`).join('');
  minute.innerHTML = Array.from({ length: 12 }, (_, i) => {
    const value = String(i * 5).padStart(2, '0');
    return `<option value="${value}">${value}</option>`;
  }).join('');

  function open(side) {
    ensureCustomRangeDefaults();
    _state_digest.customRangeSide = side;
    const selected = parseLocalDateTime(side === 'since' ? _state_digest.customSince : _state_digest.customUntil) || new Date();
    _state_digest.customRangeMonth = monthKey(selected);
    popover.classList.remove('hidden');
    paintCustomRangeFields();
    paintRangeCalendar();
  }

  startButton.addEventListener('click', () => open('since'));
  endButton.addEventListener('click', () => open('until'));
  document.getElementById('range-prev-month').addEventListener('click', () => shiftRangeMonth(-1));
  document.getElementById('range-next-month').addEventListener('click', () => shiftRangeMonth(1));
  hour.addEventListener('change', updateCustomRangeTime);
  minute.addEventListener('change', updateCustomRangeTime);
  ensureCustomRangeOutsideClick();
}

function ensureCustomRangeOutsideClick() {
  if (_customRangeOutsideClickAttached) return;
  document.addEventListener('click', e => {
    const popover = document.getElementById('range-popover');
    if (!popover || popover.classList.contains('hidden')) return;
    if (document.getElementById('range-picker')?.contains(e.target)) return;
    popover.classList.add('hidden');
    document.getElementById('range-start')?.classList.remove('active');
    document.getElementById('range-end')?.classList.remove('active');
  });
  _customRangeOutsideClickAttached = true;
}

function ensureCustomRangeDefaults() {
  if (_state_digest.customSince && _state_digest.customUntil) return;
  const r = quickRangeToDates('last1d');
  _state_digest.customSince = _state_digest.customSince || r.since;
  _state_digest.customUntil = _state_digest.customUntil || r.until;
}

function normalizeCustomRangeMinutes() {
  const since = parseLocalDateTime(_state_digest.customSince);
  if (since) {
    since.setMinutes(Math.floor(since.getMinutes() / 5) * 5, 0, 0);
    _state_digest.customSince = fmtDateTime(since);
  }
  const until = parseLocalDateTime(_state_digest.customUntil);
  if (until) {
    until.setMinutes(Math.floor(until.getMinutes() / 5) * 5, 59, 0);
    _state_digest.customUntil = fmtDateTime(until, { includeSeconds: true });
  }
}

function paintCustomRangeFields() {
  const start = document.getElementById('range-start-text');
  const end = document.getElementById('range-end-text');
  if (start) start.textContent = _state_digest.customSince || '';
  if (end) end.textContent = _state_digest.customUntil || '';
  document.getElementById('range-start')?.classList.toggle('active', _state_digest.customRangeSide === 'since' && !document.getElementById('range-popover')?.classList.contains('hidden'));
  document.getElementById('range-end')?.classList.toggle('active', _state_digest.customRangeSide === 'until' && !document.getElementById('range-popover')?.classList.contains('hidden'));
}

function shiftRangeMonth(delta) {
  const base = rangeCalendarMonth();
  base.setMonth(base.getMonth() + delta);
  _state_digest.customRangeMonth = monthKey(base);
  paintRangeCalendar();
}

function rangeCalendarMonth() {
  if (_state_digest.customRangeMonth) {
    const [y, m] = _state_digest.customRangeMonth.split('-').map(Number);
    if (y && m) return new Date(y, m - 1, 1);
  }
  return new Date(new Date().getFullYear(), new Date().getMonth(), 1);
}

function paintRangeCalendar() {
  const grid = document.getElementById('range-calendar');
  const title = document.getElementById('range-month-title');
  if (!grid || !title) return;
  const month = rangeCalendarMonth();
  title.textContent = fmtMonthTitle(month);
  const startDate = parseLocalDateTime(_state_digest.customSince);
  const endDate = parseLocalDateTime(_state_digest.customUntil);
  const sideDate = parseLocalDateTime(_state_digest.customRangeSide === 'since' ? _state_digest.customSince : _state_digest.customUntil) || new Date();
  document.getElementById('range-hour').value = String(sideDate.getHours()).padStart(2, '0');
  document.getElementById('range-minute').value = String(Math.floor(sideDate.getMinutes() / 5) * 5).padStart(2, '0');

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const firstCell = new Date(first);
  firstCell.setDate(first.getDate() - offset);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(firstCell);
    date.setDate(firstCell.getDate() + i);
    const muted = date.getMonth() !== month.getMonth();
    const selected = sameDay(date, startDate) || sameDay(date, endDate);
    const inRange = startDate && endDate && date >= stripTime(startDate) && date <= stripTime(endDate);
    cells.push(`<button type="button" data-date="${fmtDateOnly(date)}" class="${[
      muted ? 'muted-day' : '',
      selected ? 'selected' : '',
      inRange && !selected ? 'in-range' : '',
    ].filter(Boolean).join(' ')}">${date.getDate()}</button>`);
  }
  grid.innerHTML = cells.join('');
  grid.querySelectorAll('button[data-date]').forEach(button => {
    button.addEventListener('click', () => updateCustomRangeDate(button.dataset.date));
  });
  paintCustomRangeFields();
}

function stripTime(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function fmtDateOnly(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalizePathForUi(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function normalizeRelativePathForUi(value) {
  return normalizePathForUi(value).replace(/^\.\/+/, '');
}

function isAbsolutePathForUi(value) {
  const s = String(value || '').trim();
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\\\');
}

function outputDirLooksInsideProject(dir, projectRoot) {
  const raw = String(dir || '').trim();
  if (!raw) return false;
  const normalized = normalizePathForUi(raw);
  if (!isAbsolutePathForUi(raw)) {
    const rel = normalizeRelativePathForUi(raw).toLowerCase();
    return (rel === 'outputs' || rel.startsWith('outputs/'))
      && !rel.split('/').includes('..')
      && rel !== 'outputs/.tmp'
      && !rel.startsWith('outputs/.tmp/');
  }
  const root = normalizePathForUi(projectRoot).toLowerCase();
  const full = normalizePathForUi(raw).toLowerCase();
  const outputs = root ? `${root}/outputs` : '';
  const tmp = root ? `${root}/outputs/.tmp` : '';
  return !!root && (full === outputs || full.startsWith(`${outputs}/`)) && full !== tmp && !full.startsWith(`${tmp}/`);
}

function updateCustomRangeDate(dateText) {
  const current = parseLocalDateTime(_state_digest.customRangeSide === 'since' ? _state_digest.customSince : _state_digest.customUntil) || new Date();
  const [y, m, d] = String(dateText).split('-').map(Number);
  const minute = Math.floor(current.getMinutes() / 5) * 5;
  const seconds = _state_digest.customRangeSide === 'until' ? 59 : 0;
  const next = new Date(y, m - 1, d, current.getHours(), minute, seconds, 0);
  commitCustomRangeSide(next);
}

function updateCustomRangeTime() {
  const current = parseLocalDateTime(_state_digest.customRangeSide === 'since' ? _state_digest.customSince : _state_digest.customUntil) || new Date();
  current.setHours(Number(document.getElementById('range-hour').value || 0));
  current.setMinutes(Number(document.getElementById('range-minute').value || 0));
  commitCustomRangeSide(current);
}

function commitCustomRangeSide(date) {
  if (_state_digest.customRangeSide === 'since') {
    const start = new Date(date);
    start.setSeconds(0, 0);
    _state_digest.customSince = fmtDateTime(start);
  } else {
    const end = new Date(date);
    end.setSeconds(59, 0);
    _state_digest.customUntil = fmtDateTime(end, { includeSeconds: true });
  }
  const sinceDate = parseLocalDateTime(_state_digest.customSince);
  const untilDate = parseLocalDateTime(_state_digest.customUntil);
  if (sinceDate && untilDate && sinceDate > untilDate) {
    if (_state_digest.customRangeSide === 'since') {
      const end = new Date(sinceDate.getTime() + 60 * 60 * 1000);
      end.setSeconds(59, 0);
      _state_digest.customUntil = fmtDateTime(end, { includeSeconds: true });
    } else {
      const start = new Date(untilDate.getTime() - 60 * 60 * 1000);
      start.setSeconds(0, 0);
      _state_digest.customSince = fmtDateTime(start);
    }
  }
  paintCustomRangeFields();
  paintRangeCalendar();
  updateDigestRangeSummary();
}

// ---------- Digest 主页 ----------
let _state_digest = {
  selectedGroups: new Set(),
  rangeKey: 'last1d',
  customSince: '',
  customUntil: '',
  customRangeSide: 'since',
  customRangeMonth: '',
  filters: { senders: [], keywords: [], excludeTypes: new Set() },
  minMessages: 5,
  theme: 'auto',
  fontsize: 'normal',
  accent: 'green',
  lastDigest: null,
  lastSavedItem: null,
  lastTextMarkdown: '',
  lastTextTitle: '',
  lastTextComplete: false,
  lastTextDone: 0,
  lastTextTotal: 0,
  lastTextPartialReason: '',
  generating: false,
  abortController: null,
  activeBatchId: '',
  abortReason: '',
  progress: null,
};

let _digestProgressPaintTimer = null;

let _state_settings = {
  acceptanceDiagnostics: null,
};

const DIGEST_ACCENTS = [
  { id: 'green', label: '绿色', light: '#10B981', dark: '#34D399' },
  { id: 'blue', label: '蓝色', light: '#2563EB', dark: '#60A5FA' },
  { id: 'amber', label: '琥珀色', light: '#D97706', dark: '#FBBF24' },
  { id: 'rose', label: '玫红色', light: '#E11D48', dark: '#FB7185' },
];
const DIGEST_GROUP_CACHE_TTL_MS = 30 * 1000;
const DIGEST_GROUP_CACHE = new Map();

function digestGroupCacheKey(accountId = selectedAccountId()) {
  return accountId || '__default__';
}

function getDigestGroupCache(accountId = selectedAccountId()) {
  const key = digestGroupCacheKey(accountId);
  if (!DIGEST_GROUP_CACHE.has(key)) {
    DIGEST_GROUP_CACHE.set(key, { groups: [], fetchedAt: 0, promise: null });
  }
  return DIGEST_GROUP_CACHE.get(key);
}

function digestGroupCacheFresh(cache) {
  return Number(cache?.fetchedAt || 0) > 0 && Date.now() - Number(cache.fetchedAt || 0) < DIGEST_GROUP_CACHE_TTL_MS;
}

function digestGroupCacheHasData(cache) {
  return Array.isArray(cache?.groups) && cache.groups.length > 0;
}

async function fetchDigestGroups(accountId = selectedAccountId(), { force = false } = {}) {
  const cache = getDigestGroupCache(accountId);
  if (!force && digestGroupCacheFresh(cache)) return cache.groups;
  if (cache.promise) return cache.promise;
  cache.promise = api(`/api/groups?account=${encodeURIComponent(accountId || '')}`)
    .then(groups => {
      cache.groups = Array.isArray(groups) ? groups : [];
      cache.fetchedAt = Date.now();
      return cache.groups;
    })
    .finally(() => {
      cache.promise = null;
    });
  return cache.promise;
}

function groupRefForPayload(group = {}, accountId = selectedAccountId()) {
  return {
    account_id: String(accountId || '').trim(),
    group_id: String(group.id || group.group_id || '').trim(),
    group_name: String(group.name || group.group_name || group.id || '').trim(),
  };
}

function groupRefMatches(ref, group = {}, accountId = selectedAccountId()) {
  const groupId = String(group.id || group.group_id || '').trim();
  const groupName = String(group.name || group.group_name || '').trim();
  if (typeof ref === 'string') {
    const legacy = ref.trim();
    return !!legacy && (legacy === groupId || legacy === groupName);
  }
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return false;
  const refAccountId = String(ref.account_id || ref.account || '').trim();
  if (refAccountId && refAccountId !== String(accountId || '').trim()) return false;
  const refGroupId = String(ref.group_id || ref.id || '').trim();
  if (refGroupId) return refGroupId === groupId;
  const refGroupName = String(ref.group_name || ref.name || '').trim();
  if (refGroupName) return refGroupName === groupName;
  const refLegacyGroup = String(ref.group || '').trim();
  return !!refLegacyGroup && (refLegacyGroup === groupId || refLegacyGroup === groupName);
}

function groupRefKey(ref) {
  if (typeof ref === 'string') return `legacy:${ref.trim()}`;
  const accountId = String(ref?.account_id || ref?.account || '').trim();
  const groupId = String(ref?.group_id || ref?.id || '').trim();
  const groupName = String(ref?.group_name || ref?.name || ref?.group || '').trim();
  return `${accountId || '*'}::${groupId || groupName}`;
}

function mergeGroupRefs(refs = []) {
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const key = groupRefKey(ref);
    if (!key || key === '*::' || seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function groupLabelFromRef(ref) {
  if (typeof ref === 'string') return ref;
  return ref?.group_name || ref?.group || ref?.group_id || ref?.name || '';
}

function decorateDigestGroups(groups, digestSettings = {}, accountId = selectedAccountId()) {
  const whitelistRefs = Array.isArray(digestSettings.groups?.whitelist) ? digestSettings.groups.whitelist : [];
  const hasCurrentWhitelist = (Array.isArray(groups) ? groups : [])
    .some(group => whitelistRefs.some(ref => groupRefMatches(ref, group, accountId)));
  const recentRefs = Array.isArray(digestSettings.groups?.recent) ? digestSettings.groups.recent : [];
  return (Array.isArray(groups) ? groups : [])
    .map(group => {
      const recentIndex = recentRefs.findIndex(ref => groupRefMatches(ref, group, accountId));
      const rank = recentIndex >= 0 ? recentIndex : Number.POSITIVE_INFINITY;
      const starred = Number.isFinite(rank);
      const nonWhitelist = hasCurrentWhitelist && !whitelistRefs.some(ref => groupRefMatches(ref, group, accountId));
      return { ...group, starred, non_whitelist: nonWhitelist, recent_rank: starred ? rank : 9999 };
    })
    .sort((a, b) => (a.recent_rank - b.recent_rank) || ((b.last_msg_at || 0) - (a.last_msg_at || 0)));
}

async function renderDigest() {
  $app.appendChild(tplOf('tpl-digest'));
  const routeSeq = _routeSeq;
  const accountId = selectedAccountId();
  const state = _appState || await api('/api/state');
  const digestSettings = await api('/api/settings').catch(() => ({}));
  if (routeSeq !== _routeSeq) return;
  applyDigestRenderDefaults(digestSettings.render || {});
  const whitelistRefs = Array.isArray(digestSettings.groups?.whitelist) ? digestSettings.groups.whitelist : [];
  const notice = document.getElementById('wechat-notice');
  if (state.data_mode !== 'wxdb' || state.wechat?.running === false) {
    const hasWxData = state.data_mode === 'wxdb';
    const label = wechatAppLabel(state.platform);
    notice.classList.remove('hidden');
    notice.innerHTML = `
      <strong>${hasWxData ? `未检测到正在运行的 ${label}` : (state.wechat?.running ? '未找到可读取的微信数据' : `未检测到 ${label}`)}</strong>
      <span>${escapeHtml(state.wechat?.message || '当前只读取本机微信数据库副本。')} ${hasWxData ? '已发现本机数据库，仍会尝试读取；如 key 未命中，可以填写手动密钥或导入本地 key 缓存。' : '未检测到微信数据或读取失败时不会显示演示群，也不会生成伪摘要。'}</span>
      <button class="link-btn" id="wechat-retry">重试检测</button>
      <button class="link-btn" id="wechat-manual-key">填写手动密钥</button>`;
    document.getElementById('wechat-retry').addEventListener('click', async () => {
      _appState = await api('/api/state?refresh=true');
      route();
    });
    document.getElementById('wechat-manual-key').addEventListener('click', () => { location.hash = '#/settings'; });
  }

  // 群列表
  let groups = [];
  let groupStatusText = '';
  const groupCache = getDigestGroupCache(accountId);
  const cacheHasGroups = digestGroupCacheHasData(groupCache);
  const cacheIsFresh = digestGroupCacheFresh(groupCache);
  try {
    const rawGroups = cacheHasGroups ? groupCache.groups : await fetchDigestGroups(accountId, { force: true });
    if (routeSeq !== _routeSeq) return;
    groups = decorateDigestGroups(rawGroups, digestSettings, accountId);
  } catch (e) {
    if (routeSeq !== _routeSeq) return;
    notice.classList.remove('hidden');
    notice.innerHTML = `
      <strong>读取群列表失败</strong>
      <span>${escapeHtml(e.message || '无法读取本机微信群列表。')} 如果自动密钥提取失败，可以到设置页填写一条或多条 64/96 位手动密钥。</span>
      <button class="link-btn" id="wechat-retry">重试检测</button>
      <button class="link-btn" id="wechat-manual-key">填写手动密钥</button>`;
    document.getElementById('wechat-retry').addEventListener('click', async () => {
      _appState = await api('/api/state?refresh=true');
      route();
    });
    document.getElementById('wechat-manual-key').addEventListener('click', () => { location.hash = '#/settings'; });
  }
  const $list = document.getElementById('group-list');
  const isCurrentDigestView = () => routeSeq === _routeSeq && document.getElementById('group-list') === $list;
  function setGroupStatus(text) {
    groupStatusText = text || '';
    updateSelectedCount();
  }
  function paint(filter = '') {
    const f = filter.trim().toLowerCase();
    const visibleGroups = groups.filter(g => {
        if (!f) return true;
        return [g.name, g.pinyin, g.pinyin_initial, g.id].some(v => String(v || '').toLowerCase().includes(f));
      });
    if (!visibleGroups.length) {
      $list.innerHTML = `<li class="loading">${groups.length ? '没有匹配的群。' : '本机没有可显示的群。'}</li>`;
      updateSelectedCount();
      return;
    }
    $list.innerHTML = visibleGroups
      .map(g => `
        <li data-id="${escapeHtml(g.id)}" class="${[
          _state_digest.selectedGroups.has(g.id) ? 'selected' : '',
          g.non_whitelist ? 'non-whitelist' : '',
        ].filter(Boolean).join(' ')}">
          <input type="checkbox" ${_state_digest.selectedGroups.has(g.id) ? 'checked' : ''} ${_state_digest.generating ? 'disabled' : ''} />
          ${g.starred ? '<span class="star">★</span>' : ''}
          <span class="gname">${escapeHtml(g.name)}</span>
          <span class="meta">${fmtTimeAgo(g.last_msg_at)}</span>
        </li>`).join('');
    document.querySelectorAll('#group-list li').forEach(li => {
      li.addEventListener('click', e => {
        if (_state_digest.generating) return;
        const cb = li.querySelector('input');
        if (e.target.tagName !== 'INPUT') cb.checked = !cb.checked;
        const id = li.dataset.id;
        if (cb.checked) _state_digest.selectedGroups.add(id);
        else _state_digest.selectedGroups.delete(id);
        li.classList.toggle('selected', cb.checked);
        updateSelectedCount();
      });
    });
    updateDigestSelectionLock();
    updateSelectedCount();
  }
  function updateSelectedCount() {
    document.getElementById('selected-count').textContent = `已选 ${_state_digest.selectedGroups.size} 个${groupStatusText ? ` · ${groupStatusText}` : ''}`;
    const disabled = _state_digest.selectedGroups.size === 0 || _state_digest.generating;
    document.getElementById('btn-generate').disabled = disabled;
    document.getElementById('btn-preview-text').disabled = disabled;
  }
  const whitelistButton = document.getElementById('select-whitelist');
  function updateWhitelistButton() {
    if (!whitelistButton) return;
    const currentWhitelistCount = groups.filter(g => whitelistRefs.some(ref => groupRefMatches(ref, g, accountId))).length;
    whitelistButton.dataset.hasWhitelist = currentWhitelistCount ? '1' : '0';
    updateDigestSelectionLock();
  }
  paint();
  updateWhitelistButton();
  document.getElementById('group-search').addEventListener('input', e => paint(e.target.value));
  if (cacheHasGroups && !cacheIsFresh) {
    setGroupStatus('后台更新中');
    fetchDigestGroups(accountId, { force: true })
      .then(rawGroups => {
        if (!isCurrentDigestView()) return;
        groups = decorateDigestGroups(rawGroups, digestSettings, accountId);
        setGroupStatus('');
        paint(document.getElementById('group-search')?.value || '');
        updateWhitelistButton();
      })
      .catch(e => {
        if (!isCurrentDigestView()) return;
        setGroupStatus(`后台更新失败：${e.message || '未知错误'}`);
        if (!groups.length) {
          notice.classList.remove('hidden');
          notice.innerHTML = `<strong>读取群列表失败</strong><span>${escapeHtml(e.message || '无法读取本机微信群列表。')}</span>`;
        }
      });
  }
  document.getElementById('select-whitelist').addEventListener('click', () => {
    if (_state_digest.generating) return;
    groups.filter(g => whitelistRefs.some(ref => groupRefMatches(ref, g, accountId))).forEach(g => _state_digest.selectedGroups.add(g.id));
    paint(document.getElementById('group-search').value);
  });

  // 时间范围
  const $qr = document.getElementById('quick-range');
  const $cr = document.getElementById('custom-range');
  setupCustomRangePicker();
  syncDigestControlsFromState();
  $qr.addEventListener('click', e => {
    const btn = e.target.closest('button[data-range]');
    if (!btn) return;
    $qr.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    _state_digest.rangeKey = btn.dataset.range;
    if (_state_digest.rangeKey === 'custom') {
      $cr.classList.remove('hidden');
      ensureCustomRangeDefaults();
      paintCustomRangeFields();
    } else {
      $cr.classList.add('hidden');
    }
    updateDigestRangeSummary();
  });

  // chip 输入
  document.querySelectorAll('.chip-input').forEach(box => {
    const name = box.dataset.name;
    const inp = box.querySelector('input');
    function removeChip(span, value) {
      _state_digest.filters[name] = _state_digest.filters[name].filter(x => x !== value);
      span.remove();
    }
    function renderChip(value) {
      const span = document.createElement('span');
      span.className = 'chip';
      span.append(document.createTextNode(value + ' '));
      const close = document.createElement('span');
      close.className = 'x';
      close.textContent = '×';
      span.append(close);
      close.addEventListener('click', () => removeChip(span, value));
      box.insertBefore(span, inp);
    }
    function addChip(v, { syncState = true } = {}) {
      v = v.trim();
      if (!v) return;
      if (_state_digest.filters[name].includes(v)) return;
      if (syncState) _state_digest.filters[name].push(v);
      renderChip(v);
    }
    (_state_digest.filters[name] || []).forEach(v => renderChip(v));
    box._commitPendingChip = () => {
      const value = inp.value.trim();
      if (!value) return;
      addChip(value);
      inp.value = '';
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        box._commitPendingChip();
      } else if (e.key === 'Backspace' && !inp.value) {
        const last = box.querySelectorAll('.chip');
        if (last.length) {
          const v = last[last.length - 1].textContent.trim().replace(/×$/, '').trim();
          removeChip(last[last.length - 1], v);
        }
      }
    });
  });

  // 排除类型
  document.querySelectorAll('input[name="ex"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) _state_digest.filters.excludeTypes.add(cb.value);
      else _state_digest.filters.excludeTypes.delete(cb.value);
    });
  });
  document.getElementById('min-messages')?.addEventListener('change', e => {
    _state_digest.minMessages = Math.max(1, parseInt(e.target.value || '5', 10) || 5);
    e.target.value = _state_digest.minMessages;
  });

  // 生成按钮
  bindDigestRenderOptions();
  document.getElementById('btn-generate').addEventListener('click', () => generateDigest({ previewText: false }));
  document.getElementById('btn-preview-text').addEventListener('click', () => generateDigest({ previewText: true }));
  document.getElementById('btn-cancel-digest').addEventListener('click', () => abortActiveDigest('用户取消'));
  document.getElementById('btn-export-md').addEventListener('click', exportTextPreviewMarkdown);
  document.getElementById('progress-log-toggle').addEventListener('click', toggleProgressLog);
  document.getElementById('btn-rerender').addEventListener('click', e => {
    if (!_state_digest.lastDigest) return;
    showDigestRerenderPanel({
      anchor: e.currentTarget,
      statusTarget: document.getElementById('preview-status'),
      initial: currentDigestRenderSelection(),
      onPreview: selection => {
        applyDigestRenderSelection(selection);
        drawDigestCanvas(_state_digest.lastDigest);
      },
      onSave: async selection => {
        applyDigestRenderSelection(selection);
        drawDigestCanvas(_state_digest.lastDigest);
        if (!_state_digest.lastSavedItem?.digest_id) return { previewOnly: true };
        const r = await api('/api/rerender-history', {
          method: 'POST',
          body: {
            digest_id: _state_digest.lastSavedItem.digest_id,
            render: digestRenderPayload(selection),
          },
        });
        _state_digest.lastSavedItem = r.item || _state_digest.lastSavedItem;
        return r;
      },
    });
  });
  document.getElementById('btn-download').addEventListener('click', downloadCanvas);
  const previewCopyButton = document.getElementById('btn-copy');
  previewCopyButton.addEventListener('click', () => withBusyButtons(previewCopyButton, copyCanvas));
  document.getElementById('digest-canvas').addEventListener('click', () => {
    const canvas = document.getElementById('digest-canvas');
    if (!canvas.width || !canvas.height) return;
    showImageZoomModal({
      title: _state_digest.lastDigest?.group || '长图预览',
      src: canvas.toDataURL('image/png'),
    });
  });
  const previewRevealButton = document.getElementById('btn-reveal');
  previewRevealButton.addEventListener('click', () => withBusyButtons(previewRevealButton, async () => {
    const item = _state_digest.lastSavedItem;
    if (!item) return;
    const status = document.getElementById('preview-status');
    if (status) {
      status.className = 'status';
      status.textContent = '正在打开文件夹...';
    }
    try {
      await api('/api/reveal', { method: 'POST', body: { digest_id: item.digest_id } });
      if (status) {
        status.className = 'status ok';
        status.textContent = '✓ 已请求系统打开并选中文件';
      }
    } catch (e) {
      if (status) {
        status.className = 'status err';
        status.textContent = `打开失败：${e.message || '未知错误'}`;
      }
    }
  }));

  restoreDigestOutputs();
  paintDigestProgressSnapshot();
  ensureKeyboardShortcuts();
}

function syncDigestControlsFromState() {
  const activeRange = document.querySelector(`#quick-range button[data-range="${_state_digest.rangeKey}"]`)
    || document.querySelector('#quick-range button[data-range="last1d"]');
  if (activeRange) {
    document.querySelectorAll('#quick-range button[data-range]').forEach(button => {
      button.classList.toggle('active', button === activeRange);
    });
    _state_digest.rangeKey = activeRange.dataset.range || 'last1d';
  }
  const customRange = document.getElementById('custom-range');
  if (_state_digest.rangeKey === 'custom') {
    customRange?.classList.remove('hidden');
    ensureCustomRangeDefaults();
    normalizeCustomRangeMinutes();
    paintCustomRangeFields();
  } else {
    customRange?.classList.add('hidden');
  }
  updateDigestRangeSummary();
  document.querySelectorAll('input[name="ex"]').forEach(cb => {
    cb.checked = _state_digest.filters.excludeTypes.has(cb.value);
  });
  const minMessages = document.getElementById('min-messages');
  if (minMessages) minMessages.value = _state_digest.minMessages;
}

function applyDigestRenderDefaults(renderSettings = {}) {
  _state_digest.theme = normalizeDigestTheme(renderSettings.default_theme || _state_digest.theme);
  _state_digest.fontsize = normalizeDigestFontSize(renderSettings.default_font_size || _state_digest.fontsize);
  _state_digest.accent = normalizeDigestAccent(renderSettings.default_accent || _state_digest.accent);
  syncDigestRenderControls();
}

function syncDigestRenderControls() {
  const themeRadio = document.querySelector(`input[name="theme"][value="${_state_digest.theme}"]`);
  const fontRadio = document.querySelector(`input[name="fontsize"][value="${_state_digest.fontsize}"]`);
  if (themeRadio) themeRadio.checked = true;
  if (fontRadio) fontRadio.checked = true;
}

function bindDigestRenderOptions() {
  document.querySelectorAll('input[name="theme"]').forEach(radio => {
    radio.addEventListener('change', () => {
      _state_digest.theme = normalizeDigestTheme(radio.value);
      if (_state_digest.lastDigest && !document.getElementById('preview-card')?.classList.contains('hidden')) {
        drawDigestCanvas(_state_digest.lastDigest);
      }
    });
  });
  document.querySelectorAll('input[name="fontsize"]').forEach(radio => {
    radio.addEventListener('change', () => {
      _state_digest.fontsize = normalizeDigestFontSize(radio.value);
      if (_state_digest.lastDigest && !document.getElementById('preview-card')?.classList.contains('hidden')) {
        drawDigestCanvas(_state_digest.lastDigest);
      }
    });
  });
}

function normalizeDigestTheme(value) {
  return ['auto', 'light', 'dark'].includes(value) ? value : 'auto';
}

function normalizeDigestFontSize(value) {
  return value === 'large' ? 'large' : 'normal';
}

function normalizeDigestAccent(value) {
  return DIGEST_ACCENTS.some(item => item.id === value) ? value : 'green';
}

function digestAccentColor(value, isDark) {
  const accent = DIGEST_ACCENTS.find(item => item.id === normalizeDigestAccent(value)) || DIGEST_ACCENTS[0];
  return isDark ? accent.dark : accent.light;
}

function effectiveDigestTheme(theme = _state_digest.theme) {
  const normalized = normalizeDigestTheme(theme);
  if (normalized === 'auto') {
    return document.body.classList.contains('is-dark') || document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }
  return normalized;
}

function currentDigestRenderSelection() {
  return {
    theme: normalizeDigestTheme(_state_digest.theme),
    fontsize: normalizeDigestFontSize(_state_digest.fontsize),
    accent: normalizeDigestAccent(_state_digest.accent),
  };
}

function applyDigestRenderSelection(selection = {}) {
  _state_digest.theme = normalizeDigestTheme(selection.theme);
  _state_digest.fontsize = normalizeDigestFontSize(selection.fontsize);
  _state_digest.accent = normalizeDigestAccent(selection.accent);
  syncDigestRenderControls();
}

function digestRenderPayload(selection = currentDigestRenderSelection()) {
  const theme = effectiveDigestTheme(selection.theme);
  return {
    theme,
    font_size: normalizeDigestFontSize(selection.fontsize),
    accent_color: digestAccentColor(selection.accent, theme === 'dark'),
  };
}

function digestRenderSelectionFromSaved(render = {}, fallback = currentDigestRenderSelection()) {
  const saved = render && typeof render === 'object' && !Array.isArray(render) ? render : {};
  const theme = ['light', 'dark'].includes(saved.theme) ? saved.theme : normalizeDigestTheme(fallback.theme);
  const fontSize = saved.font_size === 'large' ? 'large' : saved.font_size === 'normal' ? 'normal' : normalizeDigestFontSize(fallback.fontsize);
  const accentColor = String(saved.accent_color || '').toUpperCase();
  const matchedAccent = DIGEST_ACCENTS.find(item =>
    item.light.toUpperCase() === accentColor || item.dark.toUpperCase() === accentColor
  );
  return {
    theme,
    fontsize: fontSize,
    accent: matchedAccent?.id || normalizeDigestAccent(fallback.accent),
  };
}

function closeRerenderPanels() {
  document.querySelectorAll('.rerender-popover').forEach(el => el.remove());
}

function showDigestRerenderPanel({ anchor, statusTarget, initial = currentDigestRenderSelection(), onPreview, onSave }) {
  closeRerenderPanels();
  const selection = {
    theme: normalizeDigestTheme(initial.theme),
    fontsize: normalizeDigestFontSize(initial.fontsize),
    accent: normalizeDigestAccent(initial.accent),
  };
  const id = `rerender-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const panel = document.createElement('div');
  panel.className = 'rerender-popover';
  panel.innerHTML = `
    <div class="rerender-head">
      <strong>重新渲染</strong>
      <button class="icon-btn" type="button" data-close title="关闭">×</button>
    </div>
    <div class="rerender-grid">
      <div class="rerender-field">
        <label>主题</label>
        <div class="radio-row">
          <label><input type="radio" name="${id}-theme" value="auto" ${selection.theme === 'auto' ? 'checked' : ''} /> 跟随系统</label>
          <label><input type="radio" name="${id}-theme" value="light" ${selection.theme === 'light' ? 'checked' : ''} /> 浅色</label>
          <label><input type="radio" name="${id}-theme" value="dark" ${selection.theme === 'dark' ? 'checked' : ''} /> 暗色</label>
        </div>
      </div>
      <div class="rerender-field">
        <label>字号</label>
        <div class="radio-row">
          <label><input type="radio" name="${id}-fontsize" value="normal" ${selection.fontsize === 'normal' ? 'checked' : ''} /> 标准</label>
          <label><input type="radio" name="${id}-fontsize" value="large" ${selection.fontsize === 'large' ? 'checked' : ''} /> 大号</label>
        </div>
      </div>
      <div class="rerender-field">
        <label>强调色</label>
        <div class="swatch-row">
          ${DIGEST_ACCENTS.map(item => `<button class="color-swatch ${selection.accent === item.id ? 'selected' : ''}" type="button" data-accent="${item.id}" title="${item.label}" style="--swatch:${item.light}"></button>`).join('')}
        </div>
      </div>
    </div>
    <div class="rerender-actions">
      <button class="btn btn-primary" type="button" data-save>保存重渲染</button>
      <span class="status" data-status></span>
    </div>`;
  const host = anchor?.closest('.preview-actions') || anchor?.parentElement;
  if (host) host.insertAdjacentElement('afterend', panel);
  else document.body.appendChild(panel);

  const panelStatus = panel.querySelector('[data-status]');
  const syncSwatches = () => {
    panel.querySelectorAll('[data-accent]').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.accent === selection.accent);
    });
  };
  const preview = () => {
    syncSwatches();
    const hasLivePreview = typeof onPreview === 'function';
    if (hasLivePreview) onPreview({ ...selection });
    if (statusTarget && hasLivePreview) {
      statusTarget.className = 'status';
      statusTarget.textContent = '已更新预览';
    }
  };
  panel.querySelector('[data-close]').addEventListener('click', () => panel.remove());
  panel.querySelectorAll(`input[name="${id}-theme"]`).forEach(input => {
    input.addEventListener('change', () => {
      selection.theme = normalizeDigestTheme(input.value);
      preview();
    });
  });
  panel.querySelectorAll(`input[name="${id}-fontsize"]`).forEach(input => {
    input.addEventListener('change', () => {
      selection.fontsize = normalizeDigestFontSize(input.value);
      preview();
    });
  });
  panel.querySelectorAll('[data-accent]').forEach(btn => {
    btn.addEventListener('click', () => {
      selection.accent = normalizeDigestAccent(btn.dataset.accent);
      preview();
    });
  });
  const saveButton = panel.querySelector('[data-save]');
  saveButton.addEventListener('click', async () => {
    if (saveButton.disabled) return;
    saveButton.disabled = true;
    panelStatus.className = 'status';
    panelStatus.textContent = '保存中...';
    try {
      const result = typeof onSave === 'function' ? await onSave({ ...selection }) : null;
      panelStatus.className = 'status ok';
      panelStatus.textContent = result?.previewOnly ? '✓ 已更新当前预览，未写入历史' : (result ? '✓ 已重新渲染' : '✓ 已更新预览');
      if (statusTarget) {
        statusTarget.className = 'status ok';
        statusTarget.textContent = panelStatus.textContent;
      }
    } catch (e) {
      panelStatus.className = 'status err';
      panelStatus.textContent = e.message || '重渲染失败';
      if (statusTarget) {
        statusTarget.className = 'status err';
        statusTarget.textContent = '重渲染失败：' + (e.message || '未知错误');
      }
    } finally {
      saveButton.disabled = false;
    }
  });
  preview();
}

function ensureKeyboardShortcuts() {
  if (_keyboardShortcutsAttached) return;
  document.addEventListener('keydown', kbd);
  _keyboardShortcutsAttached = true;
}

function kbd(e) {
  const active = document.activeElement;
  const isTyping = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
  if (e.ctrlKey && e.key === 'Enter') {
    const btn = document.getElementById('btn-generate');
    if (btn && !btn.disabled) btn.click();
  } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 's') {
    const btn = document.getElementById('btn-download');
    if (btn && !btn.closest('.hidden')) {
      e.preventDefault();
      btn.click();
    }
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
    const btn = document.getElementById('btn-copy');
    if (btn && !btn.closest('.hidden')) {
      e.preventDefault();
      btn.click();
    }
  } else if (!isTyping && e.key === '/') {
    const search = document.getElementById('group-search');
    if (search) {
      e.preventDefault();
      search.focus();
    }
  } else if (e.key === 'Escape' && _state_digest.abortController) {
    abortActiveDigest('用户取消');
  }
}

function commitPendingChipInputs() {
  document.querySelectorAll('.chip-input').forEach(box => {
    if (typeof box._commitPendingChip === 'function') box._commitPendingChip();
  });
}

function stripDigestElapsedDetail(detail = '') {
  return String(detail || '')
    .trim()
    .replace(/\s*·?\s*仍在处理[，,]?\s*已用时\s*\d+分\d{1,2}秒\s*$/u, '')
    .replace(/\s*·?\s*仍在处理[，,]?\s*已用时\s*\d+秒\s*$/u, '')
    .replace(/\s*·?\s*已用时\s*\d+分\d{1,2}秒\s*$/u, '')
    .replace(/\s*·?\s*已用时\s*\d+秒\s*$/u, '')
    .trim();
}

function formatDigestElapsedDetail(baseDetail, startedAt) {
  const elapsedSeconds = Math.max(1, Math.floor((Date.now() - Number(startedAt || Date.now())) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsed = minutes ? `已用时 ${minutes}分${String(seconds).padStart(2, '0')}秒` : `已用时 ${seconds}秒`;
  return baseDetail ? `${baseDetail} · ${elapsed}` : elapsed;
}

function resetDigestProgressSnapshot({ previewText = false } = {}) {
  _state_digest.progress = {
    visible: true,
    previewText: !!previewText,
    fill: '0%',
    stages: [],
    logVisible: false,
    logSummary: '',
    logText: '',
    logStatusClass: 'status',
    logStatusText: '',
  };
  paintDigestProgressSnapshot();
}

function setDigestProgressFill(width) {
  if (!_state_digest.progress) return;
  _state_digest.progress.fill = width || '0%';
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = _state_digest.progress.fill;
}

function setDigestProgressStages(stages = []) {
  if (!_state_digest.progress) resetDigestProgressSnapshot();
  _state_digest.progress.stages = stages.map(stage => ({ ...stage }));
  paintDigestProgressSnapshot();
}

function setDigestProgressLogPrompt(summary = '') {
  if (!_state_digest.progress) resetDigestProgressSnapshot();
  const cleanSummary = compactErrorSummary(summary);
  _state_digest.progress.logSummary = cleanSummary;
  _state_digest.progress.logStatusClass = 'status err';
  _state_digest.progress.logStatusText = cleanSummary ? `错误摘要：${cleanSummary}` : '生成失败';
  paintDigestProgressSnapshot();
}

function paintDigestProgressSnapshot() {
  const snapshot = _state_digest.progress;
  const card = document.getElementById('progress-card');
  const stages = document.getElementById('progress-stages');
  const fill = document.getElementById('progress-fill');
  const tools = document.getElementById('progress-log-tools');
  const log = document.getElementById('progress-log');
  const status = document.getElementById('progress-log-status');
  if (!card || !stages || !fill) return;
  if (!snapshot?.visible) {
    card.classList.add('hidden');
    updateDigestCancelButton();
    stopDigestProgressPaintTimer();
    return;
  }
  card.classList.remove('hidden');
  fill.style.width = snapshot.fill || '0%';
  stages.innerHTML = '';
  for (const stage of snapshot.stages || []) {
    const li = document.createElement('li');
    li.className = stage.status || '';
    li.dataset.stageName = stage.stageName || stage.name || '';
    li.textContent = digestStageText(stage);
    stages.appendChild(li);
  }
  if (tools && status && log) {
    const hasLog = !!(snapshot.logSummary || snapshot.logText || snapshot.logStatusText);
    tools.classList.toggle('hidden', !hasLog);
    status.className = snapshot.logStatusClass || 'status';
    status.textContent = snapshot.logStatusText || '';
    log.textContent = snapshot.logText || '';
    log.classList.toggle('hidden', !snapshot.logVisible);
  }
  updateDigestCancelButton();
  if (_state_digest.generating && (snapshot.stages || []).some(stage => stage.status === 'running')) startDigestProgressPaintTimer();
  else stopDigestProgressPaintTimer();
}

function updateDigestCancelButton() {
  const button = document.getElementById('btn-cancel-digest');
  if (!button) return;
  const active = !!_state_digest.abortController && _state_digest.generating;
  button.classList.toggle('hidden', !active);
  button.disabled = !active || !!_state_digest.abortController?.signal?.aborted;
  button.textContent = _state_digest.abortController?.signal?.aborted ? '正在取消...' : '取消生成';
}

function updateDigestSelectionLock() {
  const locked = !!_state_digest.generating;
  document.getElementById('group-list')?.classList.toggle('locked', locked);
  document.querySelectorAll('#group-list input[type="checkbox"]').forEach(input => {
    input.disabled = locked;
  });
  const whitelistButton = document.getElementById('select-whitelist');
  if (whitelistButton) {
    const hasWhitelist = whitelistButton.dataset.hasWhitelist === '1';
    whitelistButton.disabled = locked || !hasWhitelist;
    whitelistButton.title = locked
      ? '生成中不能修改群选择'
      : (hasWhitelist ? '选择设置页白名单里的群' : '当前账号尚未配置白名单');
  }
}

function digestStageText(stage = {}) {
  const icon = stage.status === 'done' ? '✓' : stage.status === 'running' ? '⟳' : stage.status === 'error' ? '✗' : '·';
  const detail = stage.status === 'running'
    ? formatDigestElapsedDetail(stage.baseDetail || '', stage.startedAt)
    : (stage.detail || '');
  return `${icon} ${stage.label || ''}${detail ? ' (' + detail + ')' : ''}`;
}

function startDigestProgressPaintTimer() {
  if (_digestProgressPaintTimer) return;
  _digestProgressPaintTimer = setInterval(() => {
    if (!_state_digest.generating) {
      stopDigestProgressPaintTimer();
      return;
    }
    paintDigestProgressSnapshot();
  }, 1000);
}

function stopDigestProgressPaintTimer() {
  if (!_digestProgressPaintTimer) return;
  clearInterval(_digestProgressPaintTimer);
  _digestProgressPaintTimer = null;
}

// ---------- 生成（SSE） ----------
async function generateDigest({ previewText = false } = {}) {
  commitPendingChipInputs();
  if (_state_digest.selectedGroups.size === 0) return;
  if (_state_digest.generating) return;
  _state_digest.generating = true;
  _state_digest.abortReason = '';
  const controller = new AbortController();
  const batchId = createDigestBatchId();
  _state_digest.abortController = controller;
  _state_digest.activeBatchId = batchId;
  const accountId = selectedAccountId();
  const generateButton = document.getElementById('btn-generate');
  const previewButton = document.getElementById('btn-preview-text');
  if (generateButton) generateButton.disabled = true;
  if (previewButton) previewButton.disabled = true;
  updateDigestCancelButton();
  updateDigestSelectionLock();
  const $progress = document.getElementById('progress-card');
  const $stages = document.getElementById('progress-stages');
  const $fill = document.getElementById('progress-fill');
  const $logTools = document.getElementById('progress-log-tools');
  const $log = document.getElementById('progress-log');
  const $logStatus = document.getElementById('progress-log-status');
  const $previewCard = document.getElementById('preview-card');
  const $textPreviewCard = document.getElementById('text-preview-card');
  const $exportMd = document.getElementById('btn-export-md');
  const $textPreviewStatus = document.getElementById('text-preview-status');
  const $revealButton = document.getElementById('btn-reveal');
  resetDigestProgressSnapshot({ previewText });
  setDigestProgressStages([{
    key: 'prepare',
    name: 'prepare',
    stageName: 'prepare',
    label: '准备生成 · 读取群列表',
    status: 'running',
    startedAt: Date.now(),
    baseDetail: '',
  }]);
  $progress.classList.remove('hidden');
  $stages.innerHTML = `<li class="running">⟳ 准备生成 · 读取群列表</li>`;
  $fill.style.width = '2%';
  setDigestProgressFill('2%');
  $logTools.classList.add('hidden');
  $log.classList.add('hidden');
  $log.textContent = '';
  $logStatus.textContent = '';
  $previewCard.classList.add('hidden');
  $textPreviewCard.classList.add('hidden');
  $exportMd.disabled = true;
  $textPreviewStatus.textContent = '';
  $revealButton.disabled = true;
  $revealButton.title = '保存后可用';
  _state_digest.lastDigest = null;
  _state_digest.lastSavedItem = null;
  _state_digest.lastTextMarkdown = '';
  _state_digest.lastTextTitle = '';
  _state_digest.lastTextComplete = false;
  _state_digest.lastTextDone = 0;
  _state_digest.lastTextTotal = 0;
  _state_digest.lastTextPartialReason = '';
  scrollDigestWorkIntoView($progress);
  const selectedIds = [..._state_digest.selectedGroups];
  let groups;
  try {
    const cache = getDigestGroupCache(accountId);
    groups = digestGroupCacheHasData(cache) ? cache.groups : await fetchDigestGroups(accountId, { force: true });
    if (controller.signal.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
  } catch (e) {
    const abortReason = _state_digest.abortReason;
    if (_state_digest.abortController === controller) {
      _state_digest.generating = false;
      _state_digest.abortController = null;
      _state_digest.activeBatchId = '';
      _state_digest.abortReason = '';
      updateDigestCancelButton();
      updateDigestSelectionLock();
    }
    if (generateButton) generateButton.disabled = false;
    if (previewButton) previewButton.disabled = false;
    if ($progress && $stages && $fill) {
      $progress.classList.remove('hidden');
      $fill.style.width = '0%';
      setDigestProgressFill('0%');
      const aborted = controller.signal.aborted;
      const message = aborted ? (abortReason || '已取消') : (e.message || '未知错误');
      $stages.innerHTML = `<li class="${aborted ? 'done' : 'error'}">${aborted ? '✓ 已取消' : `✗ 读取群列表失败：${escapeHtml(message)}`}</li>`;
      setDigestProgressStages([{ key: 'error', name: 'error', stageName: 'error', label: aborted ? '已取消' : `读取群列表失败：${message}`, status: aborted ? 'done' : 'error' }]);
      if (!aborted) showProgressLogPrompt(message || '读取群列表失败');
      scrollDigestWorkIntoView($progress);
    }
    return;
  }
  const targets = selectedIds.map(id => {
    const group = groups.find(g => g.id === id) || {};
    return { id, name: group.name || id || '未命名会话', last_msg_at: Number(group.last_msg_at || 0) || 0 };
  });
  rememberRecentGroups(targets, groups, accountId, controller.signal).catch(() => {});

  const range = currentDigestRange();
  const since = range.since;
  const until = range.until;

  $progress.classList.remove('hidden');
  $stages.innerHTML = '';
  $fill.style.width = '0%';
  setDigestProgressFill('0%');
  setDigestProgressStages([]);
  $logTools.classList.add('hidden');
  $log.classList.add('hidden');
  $log.textContent = '';
  $logStatus.textContent = '';

  const stageMap = {};
  const stageSnapshots = new Map();
  const stagesOrder = previewText ? ['fetching', 'summarizing', 'rendering'] : ['fetching', 'summarizing', 'rendering', 'saving'];
  function stripElapsedDetail(detail = '') {
    return stripDigestElapsedDetail(detail);
  }
  function formatElapsedDetail(baseDetail, startedAt) {
    return formatDigestElapsedDetail(baseDetail, startedAt);
  }
  function writeStageText(li, stage, detail = stage.detail || '') {
    const icon = stage.status === 'done' ? '✓' : stage.status === 'running' ? '⟳' : stage.status === 'error' ? '✗' : '·';
    li.textContent = `${icon} ${stage.label}${detail ? ' (' + detail + ')' : ''}`;
  }
  function renderRunningStage(li) {
    const stage = li._runningStage;
    if (!stage) return;
    writeStageText(li, stage, formatElapsedDetail(stage.baseDetail, stage.startedAt));
  }
  function clearRunningStage(li) {
    if (!li?._runningStage) return;
    if (li._runningStage.timer) clearInterval(li._runningStage.timer);
    li._runningStage = null;
  }
  function clearAllRunningStages() {
    Object.values(stageMap).forEach(clearRunningStage);
  }
  function markGroupRunningStages(index, status, detail) {
    const prefix = `group-${index}:`;
    Object.entries(stageMap).forEach(([key, li]) => {
      if (!key.startsWith(prefix) || !li._runningStage) return;
      const runningStage = li._runningStage;
      clearRunningStage(li);
      li.className = status;
      writeStageText(li, { ...runningStage, status, detail });
      stageSnapshots.set(key, {
        ...runningStage,
        key,
        status,
        detail,
        startedAt: runningStage.startedAt,
        baseDetail: runningStage.baseDetail || '',
      });
    });
    setDigestProgressStages([...stageSnapshots.values()]);
  }
  function upsertStage(s) {
    const key = s.key || s.name;
    let li = stageMap[key];
    if (!li) {
      li = document.createElement('li');
      stageMap[key] = li;
      $stages.appendChild(li);
    }
    li.className = s.status;
    li.dataset.stageName = s.stageName || s.name || '';
    if (s.status === 'running') {
      const previous = li._runningStage;
      const nextDetail = stripElapsedDetail(s.detail);
      li._runningStage = {
        ...s,
        startedAt: previous?.startedAt || Date.now(),
        baseDetail: s.detail == null ? (previous?.baseDetail || '') : nextDetail,
        timer: previous?.timer || null,
      };
      if (!li._runningStage.timer) {
        li._runningStage.timer = setInterval(() => renderRunningStage(li), 1000);
      }
      renderRunningStage(li);
      stageSnapshots.set(key, {
        ...s,
        key,
        stageName: s.stageName || s.name || '',
        status: 'running',
        startedAt: li._runningStage.startedAt,
        baseDetail: li._runningStage.baseDetail || '',
      });
    } else {
      clearRunningStage(li);
      writeStageText(li, s);
      stageSnapshots.set(key, {
        ...s,
        key,
        stageName: s.stageName || s.name || '',
        detail: s.detail || '',
      });
    }
    const doneStageCount = Object.values(stageMap).filter(item => stagesOrder.includes(item.dataset.stageName) && item.classList.contains('done')).length;
    const totalSteps = Math.max(1, targets.length * stagesOrder.length);
    const fillWidth = Math.min(100, (doneStageCount / totalSteps * 100)) + '%';
    $fill.style.width = fillWidth;
    setDigestProgressStages([...stageSnapshots.values()]);
    setDigestProgressFill(fillWidth);
  }
  function groupStage(index, stage) {
    return {
      ...stage,
      key: `group-${index}:${stage.name}`,
      stageName: stage.name,
      label: `[${index + 1}/${targets.length}] ${targets[index].name} · ${stage.label}`,
    };
  }

  // 用 fetch + ReadableStream 解析 SSE（不用 EventSource 是为了带 X-WX-Token）
  try {
    const digests = new Array(targets.length);
    const failures = [];
    const prepareConcurrency = digestPrepareConcurrency(targets.length);
    let renderQueue = Promise.resolve();
    const enqueueRender = task => {
      const run = renderQueue.then(task, task);
      renderQueue = run.catch(() => {});
      return run;
    };
    upsertStage({
      key: 'batch',
      name: 'batch',
      stageName: 'batch',
      label: `并行准备 ${targets.length} 个群`,
      status: 'running',
      detail: `准备并发 ${prepareConcurrency} 路；AI 队列按服务端限流`,
    });

    await runClientPool(targets, prepareConcurrency, async (target, i) => {
      if (controller.signal.aborted) return;
      upsertStage(groupStage(i, { name: 'fetching', label: '拉取消息/解析媒体', status: 'running' }));
      try {
        const digest = await runSingleDigestRequest({
          target,
          accountId,
          since,
          until,
          batchId,
          previewText,
          signal: controller.signal,
          onStage: stage => upsertStage({
            ...groupStage(i, stage),
          }),
        });
        digests[i] = digest;
        if (previewText) {
          renderTextPreviews(digests.filter(Boolean), { complete: false, total: targets.length });
        } else {
          await enqueueRender(async () => {
            if (controller.signal.aborted) return;
            const livePreviewCard = document.getElementById('preview-card');
            if (livePreviewCard) livePreviewCard.classList.remove('hidden');
            _state_digest.lastDigest = digest;
            _state_digest.lastSavedItem = null;
            const revealButton = document.getElementById('btn-reveal');
            if (revealButton) {
              revealButton.disabled = true;
              revealButton.title = '保存后可用';
            }
            const canvas = drawDigestCanvas(digest);
            if (controller.signal.aborted) return;
            upsertStage(groupStage(i, { name: 'saving', label: '保存长图', status: 'running' }));
            try {
              const saved = await saveRenderedCanvas(digest, canvas, { signal: controller.signal, batchId });
              if (controller.signal.aborted) return;
              _state_digest.lastSavedItem = saved.item;
              digest.file_path = saved.item.file_path;
              if (revealButton) {
                revealButton.disabled = false;
                revealButton.title = '在文件夹中显示最后一张';
              }
              upsertStage(groupStage(i, { name: 'saving', label: '保存长图', status: 'done', detail: saved.item.relative_path }));
              scrollDigestWorkIntoView(document.getElementById('preview-card'));
            } catch (e) {
              if (e?.name === 'AbortError' || controller.signal.aborted) {
                upsertStage(groupStage(i, { name: 'saving', label: '保存长图', status: 'done', detail: '已取消' }));
                return;
              }
              failures.push({ group: target.name, error: e.message });
              upsertStage(groupStage(i, { name: 'saving', label: `保存失败：${e.message}`, status: 'error' }));
              showProgressLogPrompt(e.message);
            }
          });
        }
      } catch (e) {
        const aborted = e?.name === 'AbortError';
        const message = aborted ? '已取消' : digestClientErrorMessage(e.message, target, since, until);
        failures.push({ group: target.name, error: message });
        markGroupRunningStages(i, aborted ? 'done' : 'error', aborted ? '已取消' : '已失败');
        upsertStage(groupStage(i, { name: 'error', label: aborted ? '已取消' : `失败：${message}`, status: aborted ? 'done' : 'error' }));
        if (!aborted) showProgressLogPrompt(message);
      }
    }, controller.signal);
    await renderQueue;

    const doneDigests = digests.filter(Boolean);
    if (previewText && doneDigests.length) {
      const complete = !controller.signal.aborted && !failures.length && doneDigests.length === targets.length;
      renderTextPreviews(doneDigests, {
        complete,
        total: targets.length,
        partialReason: complete ? '' : (controller.signal.aborted ? 'cancelled' : 'partial'),
      });
    }
    if (controller.signal.aborted) {
      const reason = _state_digest.abortReason || '已取消';
      upsertStage({
        key: 'batch',
        name: 'batch',
        stageName: 'batch',
        label: doneDigests.length ? `已取消，已完成 ${doneDigests.length} 个群` : '已取消',
        status: 'done',
        detail: reason,
      });
      setDigestProgressFill(doneDigests.length ? Math.max(10, Number.parseFloat($fill.style.width) || 10) + '%' : '0%');
    } else if (failures.length && doneDigests.length) {
      upsertStage({ key: 'batch', name: 'batch', stageName: 'batch', label: `已完成 ${doneDigests.length} 个，失败 ${failures.length} 个`, status: 'error', detail: failures.map(f => f.group).join('、') });
      setDigestProgressFill('100%');
      showProgressLogPrompt(failures.map(f => `${f.group}: ${f.error}`).join('；'));
    } else if (failures.length) {
      upsertStage({ key: 'batch', name: 'batch', stageName: 'batch', label: `全部失败 ${failures.length} 个群`, status: 'error', detail: failures.map(f => f.group).join('、') });
      setDigestProgressFill('100%');
      if (!failures.every(f => f.error === '已取消')) showProgressLogPrompt(failures.map(f => `${f.group}: ${f.error}`).join('；'));
    } else if (doneDigests.length === targets.length) {
      upsertStage({ key: 'batch', name: 'batch', stageName: 'batch', label: `已完成 ${doneDigests.length} 个群`, status: 'done' });
      setDigestProgressFill('100%');
    }
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    upsertStage({ name: 'error', label: aborted ? '已取消' : '失败：' + e.message, status: aborted ? 'done' : 'error' });
    if (!aborted) showProgressLogPrompt(e.message);
  } finally {
    clearAllRunningStages();
    if (_state_digest.abortController === controller) {
      _state_digest.abortController = null;
      _state_digest.activeBatchId = '';
      _state_digest.abortReason = '';
      _state_digest.generating = false;
      updateDigestCancelButton();
    }
    restoreDigestOutputs();
    const finalGenerateButton = document.getElementById('btn-generate');
    const finalPreviewButton = document.getElementById('btn-preview-text');
    if (finalGenerateButton) finalGenerateButton.disabled = _state_digest.selectedGroups.size === 0;
    if (finalPreviewButton) finalPreviewButton.disabled = _state_digest.selectedGroups.size === 0;
    updateDigestSelectionLock();
    paintDigestProgressSnapshot();
  }
}

function digestPrepareConcurrency(total) {
  const cores = Number(window.navigator?.hardwareConcurrency || 4);
  const estimated = cores >= 12 ? 4 : cores >= 8 ? 3 : cores >= 4 ? 2 : 1;
  return Math.max(1, Math.min(Number(total || 1), estimated));
}

function createDigestBatchId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function runClientPool(items, concurrency, worker, signal = null) {
  let cursor = 0;
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length && !signal?.aborted) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function scrollDigestWorkIntoView(element) {
  if (!element || !element.isConnected) return;
  requestAnimationFrame(() => {
    try {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      element.scrollIntoView();
    }
  });
}

function showProgressLogPrompt(summary = '') {
  const tools = document.getElementById('progress-log-tools');
  const status = document.getElementById('progress-log-status');
  const cleanSummary = compactErrorSummary(summary);
  setDigestProgressLogPrompt(cleanSummary);
  if (!tools || !status) return;
  tools.classList.remove('hidden');
  status.className = 'status err';
  status.textContent = cleanSummary ? `错误摘要：${cleanSummary}` : '生成失败';
}

function compactErrorSummary(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/<(?:!doctype|html|head|body|title)\b/i.test(text)) {
    const title = (text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const code = text.match(/\bError code\s*(\d{3})\b/i)?.[1] || title.match(/\b(\d{3})\b/)?.[1] || '';
    const phrase = /bad gateway/i.test(text) ? 'Bad gateway'
      : /service unavailable/i.test(text) ? 'Service unavailable'
        : /gateway timeout/i.test(text) ? 'Gateway timeout'
          : title.replace(/^.*?\|\s*/, '').replace(/\b\d{3}\s*:\s*/g, '').trim();
    const host = title.includes('|') ? title.split('|')[0].trim() : 'AI 端点/代理';
    text = `${host} 返回${code ? ' ' + code : ''}${phrase ? ' ' + phrase : ''}，这是 AI 端点或代理网关错误。`;
  }
  return text.length > 360 ? `${text.slice(0, 360)}...` : text;
}

function digestClientErrorMessage(value, target = {}, since = '', until = '') {
  const text = compactErrorSummary(value);
  if (!isDigestNoMessagesError(text)) return text;
  return [
    text,
    text.includes('本次范围') ? `当前范围按钮：${digestRangeLabel()}` : `本次请求范围：${since || '未知'} ~ ${until || 'now'}（${digestRangeLabel()}）`,
    digestTargetLastMessageHint(target, since, until),
  ].filter(Boolean).join('；');
}

function isDigestNoMessagesError(value) {
  return /所选时间范围内(?:没有可总结的消息|读取到 \d+ 条消息，但被.*筛选条件全部过滤掉了)/.test(String(value || ''));
}

function digestTargetLastMessageHint(target = {}, since = '', until = '') {
  const ts = Number(target.last_msg_at || 0);
  if (!Number.isFinite(ts) || ts < 946684800000) return '';
  const last = new Date(ts);
  const sinceDate = parseLocalDateTime(since);
  const untilDate = parseLocalDateTime(until);
  const inRange = sinceDate && untilDate && last >= sinceDate && last <= untilDate;
  return `群列表最后消息：${fmtDateTime(last, { includeSeconds: true })}${inRange ? '，落在本次范围内，可能是微信会话列表与消息分片尚未同步或会话表不一致' : '，不在本次范围内'}`;
}

async function toggleProgressLog() {
  const log = document.getElementById('progress-log');
  const status = document.getElementById('progress-log-status');
  if (!log || !status) return;
  if (!log.classList.contains('hidden')) {
    log.classList.add('hidden');
    if (_state_digest.progress) {
      _state_digest.progress.logVisible = false;
      paintDigestProgressSnapshot();
    }
    return;
  }
  status.className = 'status';
  status.textContent = '正在读取日志...';
  if (_state_digest.progress) {
    _state_digest.progress.logStatusClass = 'status';
    _state_digest.progress.logStatusText = '正在读取日志...';
    paintDigestProgressSnapshot();
  }
  try {
    const result = await api('/api/logs?limit=80');
    const lines = Array.isArray(result.log_tail) ? result.log_tail.slice(-80) : [];
    log.textContent = lines.length ? lines.join('\n') : '暂无可显示的运行日志。';
    log.classList.remove('hidden');
    status.className = 'status';
    status.textContent = '已显示最近日志';
    if (_state_digest.progress) {
      _state_digest.progress.logVisible = true;
      _state_digest.progress.logText = log.textContent;
      _state_digest.progress.logStatusClass = 'status';
      _state_digest.progress.logStatusText = '已显示最近日志';
      paintDigestProgressSnapshot();
    }
  } catch (e) {
    status.className = 'status err';
    status.textContent = `日志读取失败：${e.message || '未知错误'}`;
    if (_state_digest.progress) {
      _state_digest.progress.logStatusClass = 'status err';
      _state_digest.progress.logStatusText = `日志读取失败：${e.message || '未知错误'}`;
      paintDigestProgressSnapshot();
    }
  }
}

async function rememberRecentGroups(targets, allGroups, accountId = selectedAccountId(), signal = null) {
  if (signal?.aborted) return;
  const current = await api('/api/settings').catch(() => ({}));
  if (signal?.aborted) return;
  const previous = Array.isArray(current.groups?.recent) ? current.groups.recent : [];
  const selectedRefs = targets
    .map(target => {
      const group = allGroups.find(g => g.id === target.id || g.name === target.name);
      return groupRefForPayload(group || { id: target.id, name: target.name }, accountId);
    })
    .filter(ref => ref.group_id || ref.group_name);
  const nextRecentGroups = mergeGroupRefs([...selectedRefs, ...previous]).slice(0, 5);
  if (!nextRecentGroups.length || JSON.stringify(nextRecentGroups) === JSON.stringify(previous.slice(0, 5))) return;
  if (signal?.aborted) return;
  await api('/api/settings', { method: 'PUT', signal, body: { groups: { recent: nextRecentGroups } } });
}

async function runSingleDigestRequest({ target, accountId, since, until, batchId, previewText, signal, onStage }) {
  let digest = null;
  let modelError = null;
  const resp = await fetch('/api/digest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WX-Token': TOKEN },
    signal,
    body: JSON.stringify({
      group_id: target.id,
      group_name: target.name,
      batch_id: batchId,
      account_id: accountId,
      since,
      until,
      preview_text: previewText,
      filters: {
        senders: _state_digest.filters.senders,
        keywords: _state_digest.filters.keywords,
        exclude_types: [..._state_digest.filters.excludeTypes],
      },
      min_messages: parseInt(document.getElementById('min-messages').value || '5', 10),
    }),
  });
  if (!resp.ok) throw new Error(parseHttpErrorMessage(await resp.text(), resp.status));
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const lines = block.split('\n');
      let event = 'message', data = '';
      for (const ln of lines) {
        if (ln.startsWith('event:')) event = ln.slice(6).trim();
        else if (ln.startsWith('data:')) data += ln.slice(5).trim();
      }
      if (!data) continue;
      const obj = JSON.parse(data);
      if (event === 'stage') onStage(obj);
      else if (event === 'digest') digest = obj;
      else if (event === 'error') modelError = compactErrorSummary(obj.message || '未知错误');
    }
  }
  if (modelError) throw new Error(compactErrorSummary(modelError));
  if (!digest) throw new Error('未收到摘要结果');
  return digest;
}

function digestTopicCategory(topic = {}) {
  const explicit = String(topic.category || '').trim();
  if (explicit && explicit.length <= 16) return explicit;
  const haystack = `${topic.title || ''} ${topic.summary || ''}`;
  if (/github|文档|教程|链接|仓库|资料|入口|官网|下载/.test(haystack)) return '资源分享';
  if (/观点|理念|趋势|行业|能力|效率|未来|职业|工作流|认知|思考|争议|看法/.test(haystack)) return '观点讨论';
  if (/确认|跟进|修复|处理|任务|目标|goal|迁移|发布|上线|测试|排查|付款|领取|结果|待确认/.test(haystack)) return '后续讨论';
  return '聊天主线';
}

function groupedDigestTopics(topics = []) {
  const sections = [];
  const byLabel = new Map();
  for (const topic of topics || []) {
    const label = digestTopicCategory(topic);
    if (!byLabel.has(label)) {
      byLabel.set(label, []);
      sections.push({ label, topics: byLabel.get(label) });
    }
    byLabel.get(label).push(topic);
  }
  return sections.filter(section => section.topics.length);
}

function digestHighlightsForRender(d = {}) {
  const fromDigest = Array.isArray(d.highlights) ? d.highlights : [];
  const fallback = [
    d.headline,
    ...(Array.isArray(d.topics) ? d.topics.map(topic => firstDigestSentence(topic.summary || topic.title)) : []),
  ];
  const out = [];
  for (const value of [...fromDigest, ...fallback]) {
    const text = String(value || '').trim();
    if (!text || out.includes(text)) continue;
    out.push(text.length > 90 ? `${text.slice(0, 89)}…` : text);
    if (out.length >= 6) break;
  }
  return out;
}

function firstDigestSentence(value = '') {
  const text = String(value || '').trim();
  const match = text.match(/^(.{8,90}?[。！？；;]|.{8,90})(?:\s|$)/);
  return (match?.[1] || text.slice(0, 90)).trim();
}

function digestQuotesForRender(d = {}) {
  return (Array.isArray(d.quotes) ? d.quotes : [])
    .map(item => {
      if (typeof item === 'string') return { speaker: '', text: item, context: '' };
      return {
        speaker: String(item?.speaker || item?.from || item?.sender || '').trim(),
        text: String(item?.text || item?.quote || item?.content || '').trim(),
        context: String(item?.context || item?.reason || '').trim(),
      };
    })
    .filter(item => item.text)
    .slice(0, 8);
}

function digestLinksForRender(d = {}) {
  const links = Array.isArray(d.links) ? d.links : [];
  return links
    .filter(link => link && isSuccessfulDigestLink(link) && isRenderableDigestUrl(link.url))
    .sort((a, b) => digestLinkScore(b) - digestLinkScore(a))
    .slice(0, 12);
}

function isSuccessfulDigestLink(link = {}) {
  const status = String(link.preview_status || link.status || '').trim().toLowerCase();
  return !status || status === 'ok';
}

function digestLinkScore(link = {}) {
  const summary = String(link.summary || '');
  let score = 0;
  if (!isSuccessfulDigestLink(link)) score -= 20;
  if (/群里|群聊|聊天|上下文|前文|后文|发来|发出|发送|询问|讨论|针对|回应/.test(summary)) score += 8;
  if (/本程序打开该链接时返回|打开超时|加载中|环境异常|没有可靠中文摘要|分段模型失败|聊天上下文不足/.test(summary)) score -= 5;
  if (/报价|文档|官网|仓库|注册|入口|教程|新闻|快讯|公告|优惠|充值|支付|模型|API|代码|下载/.test(`${link.title || ''} ${summary}`)) score += 3;
  if (/^https?:\/\//i.test(String(link.title || '').trim())) score -= 2;
  return score;
}

function isRenderableDigestUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (host === 'mp.weixin.qq.com' && (pathname.startsWith('/mp/wappoc_appmsgcaptcha') || pathname.startsWith('/mp/waerrpage'))) return false;
    if (host === 'support.weixin.qq.com' && (pathname.startsWith('/cgi-bin/mmsupport-bin/readtemplate') || pathname.startsWith('/update'))) return false;
    if (host === 'wxapp.tenpay.com' && pathname.startsWith('/mmpayhb/')) return false;
    return true;
  } catch {
    return false;
  }
}

function compactDigestUrl(value, maxChars = 130) {
  const text = String(value || '').trim();
  if (text.length <= maxChars) return text;
  try {
    const parsed = new URL(text);
    const short = `${parsed.origin}${parsed.pathname}${parsed.search ? '?...' : ''}`;
    return short.length <= maxChars ? short : `${short.slice(0, maxChars - 1)}…`;
  } catch {
    return `${text.slice(0, maxChars - 1)}…`;
  }
}

function digestLinkTitle(link = {}) {
  const title = String(link.title || '').trim();
  if (title && !/^https?:\/\//i.test(title)) return title.length > 90 ? `${title.slice(0, 89)}…` : title;
  return compactDigestUrl(link.url || link.summary || '', 90);
}

function digestDataRows(d = {}) {
  const renderedLinks = digestLinksForRender(d);
  const renderedTodos = digestTodosForRender(d);
  const mediaRow = digestMediaStatusRow(d.media_status);
  const linkRow = digestLinkStatusRow(d.link_status);
  return [
    `时间：${d.since || '未知'} ~ ${d.until || 'now'}`,
    `消息：${d.message_count || 0} 条${d.truncated ? `；已从 ${d.scanned_message_count || d.message_count || 0} 条中截取 ${d.input_message_count || d.message_count || 0} 条` : ''}`,
    mediaRow,
    linkRow,
    `内容：${d.topics?.length || 0} 条聊天主线，${renderedLinks.length} 个链接资料，${renderedTodos.length} 个后续关注，${digestQuotesForRender(d).length} 条群里金句`,
    `来源：${d.source_label || '本机数据'}；模型：${d.model || '未记录'}`,
  ].filter(Boolean);
}

function digestMediaStatusRow(mediaStatus = null) {
  if (!mediaStatus || typeof mediaStatus !== 'object') return '';
  const mediaMessages = Number(mediaStatus.media_messages || 0);
  const metadataOnly = Number(mediaStatus.metadata_only || 0);
  const attached = Number(mediaStatus.attached || 0);
  if (!mediaMessages) return '';
  return metadataOnly
    ? `媒体：${mediaMessages} 条，其中 ${metadataOnly} 条仅按元信息总结${attached ? `，${attached} 条已附给 AI` : ''}`
    : `媒体：${mediaMessages} 条，均已附给 AI 或按可用内容处理`;
}

function digestLinkStatusRow(linkStatus = null) {
  if (!linkStatus || typeof linkStatus !== 'object') return '';
  const links = Number(linkStatus.links || 0);
  if (!links) return '';
  const parts = [
    `链接：处理 ${Number(linkStatus.processed || 0)}/${links}`,
    `成功 ${Number(linkStatus.succeeded || 0)}`,
  ];
  const failed = Number(linkStatus.failed || 0);
  const skipped = Number(linkStatus.skipped || 0);
  if (failed) parts.push(`失败 ${failed}`);
  if (skipped) parts.push(`跳过 ${skipped}`);
  const aiRequested = Number(linkStatus.ai_research_requested || 0);
  if (aiRequested) parts.push(`AI 查链 ${Number(linkStatus.ai_researched || 0)}/${aiRequested}`);
  if (linkStatus.ai_research_skipped) parts.push('AI 查链已跳过');
  const failedBatches = Number(linkStatus.ai_research_failed_batches || 0);
  if (failedBatches) parts.push(`AI 查链失败 ${failedBatches} 批`);
  return parts.join('，');
}

function digestTodosForRender(d = {}) {
  const todos = Array.isArray(d.todos) ? d.todos : [];
  return todos.filter(t => isStrongTodoForRender(t)).slice(0, 5);
}

function cleanTodoMetaForRender(value) {
  const text = String(value || '').trim();
  return /^(待认领|未指定|无|暂无|不明确|待定|未定|待确认)$/.test(text) ? '' : text;
}

function isStrongTodoForRender(todo = {}) {
  const item = String(todo.item || '').trim();
  if (!item) return false;
  if (/持续关注|继续关注|保持关注|观察|对比|评估|确认是否|验证.*稳定性|排查.*原因|优化.*速度|准备.*方案|确定.*路线/.test(item)) return false;
  const owner = cleanTodoMetaForRender(todo.owner);
  const deadline = cleanTodoMetaForRender(todo.deadline);
  if (owner || deadline) return true;
  return /报名|付款|提交|联系|交付|报销|补发|回复|注册|开通|关闭|领取|上传|发布|更新|迁移|修复|整理|收集|安排/.test(item)
    && /请|需要|要|待|明天|今天|今晚|本周|下周|尽快|继续|统一|群里|大家|管理员|负责人/.test(item);
}

// ---------- Canvas 长图渲染（前端预览，1080×N） ----------
function drawDigestCanvas(d, targetCanvas = null) {
  const W = 1080;
  const padding = 16;
  const cardInset = 16;
  const bodyIndent = 28;
  const metaIndent = 30;
  const renderTheme = normalizeDigestTheme(_state_digest.theme);
  const isDark = renderTheme === 'dark' || (renderTheme === 'auto' && (document.body.classList.contains('is-dark') || document.documentElement.dataset.theme === 'dark'));
  const fontScale = _state_digest.fontsize === 'large' ? 1.14 : 1;
  const s = value => Math.round(value * fontScale);
  const primary = digestAccentColor(_state_digest.accent, isDark);
  const COLORS = isDark
    ? { bg: '#0E0E10', card: '#1A1A1D', border: '#2A2A2E', hairline: '#34343A', text: '#EDEDED', muted: '#9CA3AF', meta: '#D1D5DB', primary, warnBg: '#3F2D00', warnFg: '#FDE68A', dangerBg: '#3F1414', dangerFg: '#FCA5A5' }
    : { bg: '#FAFAFA', card: '#FFFFFF', border: '#E5E5E5', hairline: '#E5E7EB', text: '#111111', muted: '#6B7280', meta: '#374151', primary, warnBg: '#FEF3C7', warnFg: '#92400E', dangerBg: '#FEE2E2', dangerFg: '#991B1B' };
  const FONT_STACK = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI Emoji", "Segoe UI Symbol", Arial, sans-serif';
  const font = (weight, size) => `${weight} ${s(size)}px ${FONT_STACK}`;

  // 第一遍测算，第二遍真画
  const canvas = targetCanvas || document.getElementById('digest-canvas') || document.createElement('canvas');
  const dpr = 2;

  function measure(ctx) { return draw(ctx, true); }
  function draw(ctx, dryRun) {
    let y = padding;

    // 顶部条
    if (!dryRun) {
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, W, canvas.height / dpr);
    }
    if (!dryRun) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = font(500, 14);
      ctx.fillText('wx-summary · 群消息总结', padding, y);
    }
    y += s(26);
    if (!dryRun) {
      ctx.fillStyle = COLORS.text;
      ctx.font = font(700, 28);
    }
    const groupLines = wrapText(ctx, d.group, W - padding * 2, font(700, 28));
    for (const ln of groupLines) {
      if (!dryRun) ctx.fillText(ln, padding, y);
      y += s(44);
    }
    y += s(14);
    if (!dryRun) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = font(400, 14);
    }
    const sourceSuffix = d.truncated ? ` · 已从 ${d.scanned_message_count || d.message_count} 条中截取 ${d.input_message_count || d.message_count} 条` : '';
    const sourceText = d.source_label || d.truncated ? `    ${d.source_label || '本机数据'}${sourceSuffix}` : '';
    const metaLines = wrapText(ctx, `${d.since} ~ ${d.until}    ${d.message_count} 条消息    ${d.model}${sourceText}`, W - padding * 2, font(400, 14));
    for (const ln of metaLines) {
      if (!dryRun) ctx.fillText(ln, padding, y);
      y += s(24);
    }
    y += s(10);

    // first-screen highlights
    y = drawCard(ctx, y, COLORS, dryRun, c => {
      c.fillStyle = COLORS.primary;
      c.font = font(600, 14);
      c.fillText('群聊速览', padding + cardInset, y + s(10));
      c.fillStyle = COLORS.text;
      let yy = y + s(35);
      c.font = font(600, 24);
      const headlineLines = wrapText(c, d.headline, W - padding * 2 - cardInset * 2, font(600, 24));
      for (const ln of headlineLines) { c.fillText(ln, padding + cardInset, yy); yy += s(38); }
      const highlights = digestHighlightsForRender(d).filter(item => item !== d.headline).slice(0, 5);
      if (highlights.length) {
        yy += s(8);
        c.font = font(400, 17);
        for (const item of highlights) {
          const lines = wrapText(c, `• ${item}`, W - padding * 2 - cardInset * 2, font(400, 17));
          for (const ln of lines) { c.fillText(renderSafeText(ln), padding + cardInset, yy); yy += s(31); }
          yy += s(4);
        }
      }
      return yy + s(10) - y;
    });
    y += s(6);

    // topic sections
    const topicSections = groupedDigestTopics(d.topics || []);
    for (const section of topicSections) {
      y = drawCard(ctx, y, COLORS, dryRun, c => {
        c.fillStyle = COLORS.primary;
        c.font = font(600, 20);
        c.fillText(`${section.label}`, padding + cardInset, y + s(10));
        let yy = y + s(50);
        const topicTitleLineHeight = s(34);
        const topicTitleGap = s(10);
        const topicNoParticipantGap = s(12);
        const participantLineHeight = s(24);
        const participantSummaryGap = s(16);
        const summaryLineHeight = s(31);
        const topicAfterSummaryGap = s(14);
        const topicSeparatorGap = s(18);
        for (let i = 0; i < section.topics.length; i++) {
          const t = section.topics[i];
          c.fillStyle = COLORS.text;
          c.font = font(600, 20);
          const titleLines = wrapText(c, `${i + 1}. ${t.title}`, W - padding * 2 - cardInset * 2, font(600, 20));
          for (const ln of titleLines) { c.fillText(ln, padding + cardInset, yy); yy += topicTitleLineHeight; }
          yy += t.participants?.length ? topicTitleGap : topicNoParticipantGap;
          if (t.participants?.length) {
            c.fillStyle = COLORS.meta;
            c.font = font(500, 14);
            const participantLines = wrapText(c, `参与：${t.participants.join('、')}`, W - padding * 2 - metaIndent - cardInset, font(500, 14));
            const participantTop = yy;
            const participantHeight = Math.max(s(18), participantLines.length * participantLineHeight - s(4));
            c.fillStyle = COLORS.primary;
            c.fillRect(padding + cardInset, participantTop + s(2), 3, participantHeight);
            c.fillStyle = COLORS.meta;
            for (const ln of participantLines) { c.fillText(ln, padding + metaIndent, yy); yy += participantLineHeight; }
            yy += participantSummaryGap;
          }
          c.fillStyle = COLORS.text;
          c.font = font(400, 17);
          const lines = wrapText(c, t.summary, W - padding * 2 - cardInset * 2, font(400, 17));
          for (const ln of lines) { c.fillText(ln, padding + cardInset, yy); yy += summaryLineHeight; }
          if (i < section.topics.length - 1) {
            yy += topicAfterSummaryGap;
            c.strokeStyle = COLORS.hairline;
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(padding + cardInset, yy);
            c.lineTo(W - padding - cardInset, yy);
            c.stroke();
            yy += topicSeparatorGap;
          } else {
            yy += s(6);
          }
        }
        return yy - y + s(6);
      });
      y += s(6);
    }

    // links
    const links = digestLinksForRender(d);
    if (links.length) {
      y = drawCard(ctx, y, COLORS, dryRun, c => {
        c.fillStyle = COLORS.primary;
        c.font = font(600, 20);
        c.fillText('链接资料', padding + cardInset, y + s(10));
        let yy = y + s(50);
        for (let i = 0; i < links.length; i++) {
          const l = links[i];
          if (i > 0) {
            yy += s(10);
            c.strokeStyle = COLORS.hairline;
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(padding + metaIndent, yy);
            c.lineTo(W - padding - metaIndent, yy);
            c.stroke();
            yy += s(16);
          }
          c.fillStyle = COLORS.text;
          c.font = font(600, 17);
          const titleLines = wrapText(c, `• ${digestLinkTitle(l)}`, W - padding * 2 - cardInset * 2, font(600, 17));
          for (const ln of titleLines) { c.fillText(ln, padding + cardInset, yy); yy += s(31); }
          if (l.summary) {
            yy += s(6);
            c.fillStyle = COLORS.text;
            c.font = font(400, 17);
            const summaryLines = wrapText(c, l.summary, W - padding * 2 - bodyIndent - cardInset, font(400, 17));
            for (const ln of summaryLines) { c.fillText(ln, padding + bodyIndent, yy); yy += s(31); }
          }
          c.fillStyle = COLORS.meta;
          c.font = font(400, 12);
          if (l.url) {
            const urlLines = wrapText(c, compactDigestUrl(l.url), W - padding * 2 - bodyIndent - cardInset, font(400, 12));
            for (const ln of urlLines) { c.fillText(ln, padding + bodyIndent, yy); yy += s(22); }
          }
          const source = [
            l.from ? `发送人：${l.from}` : '',
            l.time ? `时间：${l.time}` : '',
          ].filter(Boolean).join(' · ');
          if (source) {
            const sourceLines = wrapText(c, source, W - padding * 2 - bodyIndent - cardInset, font(400, 12));
            for (const ln of sourceLines) { c.fillText(ln, padding + bodyIndent, yy); yy += s(22); }
          }
          yy += s(12);
        }
        return yy - y + s(6);
      });
      y += s(6);
    }

    const quotes = digestQuotesForRender(d);
    if (quotes.length) {
      y = drawCard(ctx, y, COLORS, dryRun, c => {
        c.fillStyle = COLORS.primary;
        c.font = font(600, 20);
        c.fillText('群里金句', padding + cardInset, y + s(10));
        let yy = y + s(50);
        for (let i = 0; i < quotes.length; i++) {
          const q = quotes[i];
          c.fillStyle = COLORS.text;
          c.font = font(500, 17);
          const quoteLines = wrapText(c, `“${q.text}”`, W - padding * 2 - cardInset * 2, font(500, 17));
          for (const ln of quoteLines) { c.fillText(renderSafeText(ln), padding + cardInset, yy); yy += s(31); }
          const meta = [q.speaker, q.context].filter(Boolean).join(' · ');
          if (meta) {
            c.fillStyle = COLORS.meta;
            c.font = font(400, 13);
            const metaLines = wrapText(c, meta, W - padding * 2 - bodyIndent - cardInset, font(400, 13));
            for (const ln of metaLines) { c.fillText(renderSafeText(ln), padding + bodyIndent, yy); yy += s(22); }
          }
          yy += i < quotes.length - 1 ? s(14) : s(4);
        }
        return yy - y + s(8);
      });
      y += s(6);
    }

    // 后续关注
    const todos = digestTodosForRender(d);
    if (todos.length) {
      y = drawCard(ctx, y, COLORS, dryRun, c => {
        c.fillStyle = COLORS.primary;
        c.font = font(600, 20);
        c.fillText(`后续关注（${todos.length}）`, padding + cardInset, y + s(10));
        let yy = y + s(44);
        for (const t of todos) {
          c.fillStyle = COLORS.text;
          c.font = font(500, 17);
          const itemLines = wrapText(c, `• ${t.item}`, W - padding * 2 - cardInset * 2, font(500, 17));
          for (const ln of itemLines) { c.fillText(renderSafeText(ln), padding + cardInset, yy); yy += s(31); }
          const meta = [cleanTodoMetaForRender(t.owner), cleanTodoMetaForRender(t.deadline)].filter(Boolean).join(' · ');
          if (meta) {
            c.fillStyle = COLORS.meta;
            c.font = font(400, 14);
            const metaLines = wrapText(c, meta, W - padding * 2 - bodyIndent - cardInset, font(400, 14));
            for (const ln of metaLines) { c.fillText(renderSafeText(ln), padding + bodyIndent, yy); yy += s(24); }
          }
          yy += s(10);
        }
        return yy - y + s(6);
      });
      y += s(6);
    }

    y = drawCard(ctx, y, COLORS, dryRun, c => {
      c.fillStyle = COLORS.primary;
      c.font = font(600, 20);
      c.fillText('数据概览', padding + cardInset, y + s(10));
      let yy = y + s(50);
      c.fillStyle = COLORS.text;
      c.font = font(400, 16);
      for (const row of digestDataRows(d)) {
        const lines = wrapText(c, `• ${row}`, W - padding * 2 - cardInset * 2, font(400, 16));
        for (const ln of lines) { c.fillText(renderSafeText(ln), padding + cardInset, yy); yy += s(29); }
        yy += s(5);
      }
      return yy - y + s(8);
    });
    y += s(6);

    // 底部
    y += s(1);
    const footer = `生成于 ${new Date(d.created_at).toLocaleString()}    本地读取 · 智能汇总`;
    const footerLines = wrapText(ctx, footer, W - padding * 2, font(400, 14));
    if (!dryRun) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = font(400, 14);
    }
    for (const ln of footerLines) {
      if (!dryRun) ctx.fillText(ln, padding, y);
      y += s(24);
    }
    y += s(6);
    return y;
  }

  // 第一遍测高度
  const tmp = document.createElement('canvas').getContext('2d');
  const totalH = draw(tmp, true);

  canvas.width = W * dpr;
  canvas.height = totalH * dpr;
  canvas.style.width = '540px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'top';
  draw(ctx, false);
  return canvas;
}

async function saveRenderedCanvas(digest, renderedCanvas = null, { signal = null, batchId = '' } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
  const canvas = renderedCanvas || document.getElementById('digest-canvas') || drawDigestCanvas(digest);
  const png_data_url = canvas.toDataURL('image/png');
  if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
  return api('/api/save-render', { method: 'POST', signal, body: { batch_id: batchId, digest: { ...digest, __render: digestRenderPayload() }, png_data_url } });
}

function renderTextPreview(d) {
  renderTextPreviews([d], { complete: true, total: 1 });
}

function renderTextPreviews(digests, { complete = true, total = null, partialReason = '' } = {}) {
  const cleanDigests = (digests || []).filter(Boolean);
  const markdown = cleanDigests.map(d => {
    const topicSections = groupedDigestTopics(d.topics || []);
    const quotes = digestQuotesForRender(d);
    const highlights = digestHighlightsForRender(d);
    const links = digestLinksForRender(d);
    const todos = digestTodosForRender(d);
    return [
      `# ${d.group}`,
      '',
      `${d.since} ~ ${d.until} · ${d.message_count} 条消息 · ${d.model}`,
      d.source_label ? `${d.source_label}${d.truncated ? ` · 已从 ${d.scanned_message_count || d.message_count} 条中截取 ${d.input_message_count || d.message_count} 条` : ''}` : '',
      '',
      `## 群聊速览`,
      [d.headline, ...highlights.filter(item => item !== d.headline).map(item => `- ${item}`)].join('\n'),
      '',
      ...topicSections.map(section => `## ${section.label}\n${section.topics.map((t, i) => `${i + 1}. ${t.title}\n   ${(t.participants || []).length ? `参与：${(t.participants || []).join('、')}\n   ` : ''}${t.summary}`).join('\n\n')}`),
      links.length ? `## 链接资料\n${links.map(l => `- ${digestLinkTitle(l)}${l.summary ? `：${l.summary}` : ''}${l.url ? ` <${compactDigestUrl(l.url)}>` : ''}${l.from ? ` 发送人：${l.from}` : ''}${l.time ? ` 时间：${l.time}` : ''}`).join('\n')}` : '',
      quotes.length ? `## 群里金句\n${quotes.map(q => `- ${q.speaker ? `${q.speaker}：` : ''}${q.text}${q.context ? `（${q.context}）` : ''}`).join('\n')}` : '',
      todos.length ? `## 后续关注\n${todos.map(t => {
        const owner = cleanTodoMetaForRender(t.owner);
        const deadline = cleanTodoMetaForRender(t.deadline);
        return `- ${owner ? `${owner}：` : ''}${t.item}${deadline ? `（${deadline}）` : ''}`;
      }).join('\n')}` : '',
      `## 数据概览\n${digestDataRows(d).map(row => `- ${row}`).join('\n')}`,
    ].filter(Boolean).join('\n\n');
  }).join('\n\n---\n\n');
  _state_digest.lastTextMarkdown = markdown;
  _state_digest.lastTextTitle = cleanDigests.map(d => d.group).filter(Boolean).join('_') || '文本预览';
  _state_digest.lastTextDone = cleanDigests.length;
  _state_digest.lastTextTotal = Math.max(cleanDigests.length, Number(total || cleanDigests.length) || 0);
  _state_digest.lastTextComplete = !!complete;
  _state_digest.lastTextPartialReason = complete ? '' : String(partialReason || 'partial');
  paintTextPreviewMarkdown(markdown);
}

function paintTextPreviewMarkdown(markdown = _state_digest.lastTextMarkdown || '') {
  const card = document.getElementById('text-preview-card');
  const pre = document.getElementById('text-preview');
  if (!card || !pre) return;
  card.classList.remove('hidden');
  pre.textContent = markdown;
  const exportButton = document.getElementById('btn-export-md');
  const status = document.getElementById('text-preview-status');
  const hasMarkdown = !!markdown.trim();
  const waitingForGeneration = hasMarkdown && _state_digest.generating && !_state_digest.lastTextComplete;
  if (exportButton) exportButton.disabled = !hasMarkdown || waitingForGeneration;
  if (status) {
    status.className = hasMarkdown && !_state_digest.lastTextComplete && !waitingForGeneration ? 'status warn' : 'status';
    if (waitingForGeneration) {
      status.textContent = `已完成 ${_state_digest.lastTextDone}/${_state_digest.lastTextTotal || _state_digest.lastTextDone}，生成完成后可导出`;
    } else if (hasMarkdown && !_state_digest.lastTextComplete) {
      const prefix = _state_digest.lastTextPartialReason === 'cancelled' ? '已取消' : '未完整生成';
      status.textContent = `${prefix}，保留已完成 ${_state_digest.lastTextDone}/${_state_digest.lastTextTotal || _state_digest.lastTextDone}；可导出已完成部分`;
    } else if (hasMarkdown && _state_digest.lastTextTotal > 1) {
      status.textContent = `已完成 ${_state_digest.lastTextDone}/${_state_digest.lastTextTotal}`;
    } else {
      status.textContent = '';
    }
  }
}

function restoreDigestOutputs() {
  if (_state_digest.lastDigest) {
    const previewCard = document.getElementById('preview-card');
    const canvas = document.getElementById('digest-canvas');
    if (previewCard && canvas) {
      previewCard.classList.remove('hidden');
      drawDigestCanvas(_state_digest.lastDigest, canvas);
      document.getElementById('btn-download')?.removeAttribute('disabled');
      document.getElementById('btn-copy')?.removeAttribute('disabled');
      document.getElementById('btn-rerender')?.removeAttribute('disabled');
      const revealButton = document.getElementById('btn-reveal');
      if (revealButton) {
        revealButton.disabled = !_state_digest.lastSavedItem;
        revealButton.title = _state_digest.lastSavedItem ? '在文件夹中显示最后一张' : '保存后可用';
      }
    }
  }
  if (_state_digest.lastTextMarkdown?.trim()) {
    paintTextPreviewMarkdown(_state_digest.lastTextMarkdown);
  }
}

async function exportTextPreviewMarkdown() {
  const status = document.getElementById('text-preview-status');
  const button = document.getElementById('btn-export-md');
  if (!_state_digest.lastTextMarkdown?.trim()) return;
  if (_state_digest.generating && !_state_digest.lastTextComplete) {
    if (status) {
      status.className = 'status warn';
      status.textContent = '文本预览仍在生成，完成后再导出。';
    }
    if (button) button.disabled = true;
    return;
  }
  if (status) {
    status.className = _state_digest.lastTextComplete ? 'status' : 'status warn';
    status.textContent = _state_digest.lastTextComplete ? '正在导出...' : '正在导出已完成部分...';
  }
  if (button) button.disabled = true;
  try {
    const r = await api('/api/export-preview', {
      method: 'POST',
      body: {
        title: _state_digest.lastTextTitle || '文本预览',
        markdown: _state_digest.lastTextMarkdown,
      },
    });
    if (status) {
      status.className = 'status ok';
      status.textContent = `✓ 已导出 ${r.item?.relative_path || ''}`.trim();
    }
  } catch (e) {
    if (status) {
      status.className = 'status err';
      status.textContent = `导出失败：${e.message || '未知错误'}`;
    }
  } finally {
    if (button) button.disabled = !_state_digest.lastTextMarkdown?.trim() || (_state_digest.generating && !_state_digest.lastTextComplete);
  }
}

function drawCard(ctx, y, COLORS, dryRun, contentFn) {
  const W = 1080, padding = 16, x = padding, w = W - padding * 2;
  // 测高
  const dummy = document.createElement('canvas').getContext('2d');
  dummy.textBaseline = 'top';
  const h = contentFn(dummy);
  if (!dryRun) {
    ctx.fillStyle = COLORS.card;
    roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 8);
    ctx.stroke();
    contentFn(ctx);
  }
  return y + h;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth, font) {
  ctx.font = font;
  const lines = [];
  const hangingPunctuation = new Set('、，。；：？！）》】」』,.;:?!)]'.split(''));
  for (const para of renderSafeText(text).split('\n')) {
    let line = '';
    for (const ch of splitGraphemes(para)) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth) {
        if (line && hangingPunctuation.has(ch)) {
          lines.push(test);
          line = '';
        } else {
          const wordSplit = splitAsciiWordOverflow(line, ch);
          if (wordSplit) {
            if (wordSplit.head) lines.push(wordSplit.head);
            line = wordSplit.tail;
          } else {
            if (line) lines.push(line);
            line = ch;
          }
        }
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function splitAsciiWordOverflow(line, ch) {
  if (!line || !/^[A-Za-z0-9]$/.test(ch)) return null;
  const match = line.match(/([A-Za-z0-9][A-Za-z0-9_+./-]*)$/);
  if (!match || !match.index) return null;
  const head = line.slice(0, match.index).trimEnd();
  if (!head) return null;
  return { head, tail: match[1] + ch };
}

function downloadCanvas() {
  const c = document.getElementById('digest-canvas');
  c.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wx-summary_${(_state_digest.lastDigest?.group || 'digest').replace(/[^\w一-龥]/g, '_')}_${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

function imageSizeLabel(size) {
  const width = Number(size?.width || 0);
  const height = Number(size?.height || 0);
  return width > 0 && height > 0 ? `${width}×${height}` : '';
}

async function recordBrowserClipboardCopy({ digestId, clipboard } = {}) {
  if (!digestId) return null;
  return api('/api/record-clipboard-copy', {
    method: 'POST',
    body: {
      digest_id: digestId,
      clipboard,
      method: 'browser_clipboard',
    },
  }).catch(() => null);
}

async function copyCanvas() {
  const c = document.getElementById('digest-canvas');
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const canvasSize = { width: c.width, height: c.height };
  const btn = document.getElementById('btn-copy');
  const status = document.getElementById('preview-status');
  const old = btn.textContent;
  try {
    if (status) {
      status.className = 'status';
      status.textContent = '复制中...';
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    void recordBrowserClipboardCopy({ digestId: _state_digest.lastSavedItem?.digest_id, clipboard: canvasSize });
    btn.textContent = '✓ 已复制';
    if (status) {
      status.className = 'status ok';
      const size = imageSizeLabel(canvasSize);
      status.textContent = size ? `✓ 已复制到剪贴板（${size}）` : '✓ 已复制到剪贴板';
    }
    setTimeout(() => btn.textContent = old, 1500);
  } catch (e) {
    const digestId = _state_digest.lastSavedItem?.digest_id;
    const browserError = compactErrorSummary(e?.message || '');
    let systemError = '';
    if (digestId) {
      try {
        const copied = await api('/api/copy-image', { method: 'POST', body: { digest_id: digestId } });
        btn.textContent = '✓ 已复制';
        if (status) {
          status.className = 'status ok';
          const size = imageSizeLabel(copied.clipboard || canvasSize);
          status.textContent = size ? `✓ 已通过系统剪贴板复制（${size}）` : '✓ 已通过系统剪贴板复制';
        }
        setTimeout(() => btn.textContent = old, 1500);
        return;
      } catch (fallbackError) {
        systemError = compactErrorSummary(fallbackError?.message || '');
      }
    }
    if (status) {
      status.className = 'status err';
      const details = [browserError && `浏览器：${browserError}`, systemError && `系统：${systemError}`].filter(Boolean).join('；');
      status.textContent = details
        ? `复制失败：${details}。请改用「下载 PNG」。`
        : '复制失败：浏览器和系统剪贴板都拒绝写入，请改用「下载 PNG」。';
    }
  }
}

// ---------- 历史页 ----------
async function renderHistory() {
  $app.appendChild(tplOf('tpl-history'));
  const historyRouteSeq = _routeSeq;
  const $grid = document.getElementById('history-grid');
  const $empty = document.getElementById('history-empty');
  const $search = document.getElementById('history-search');
  $empty.textContent = '正在读取历史摘要...';
  $empty.classList.remove('hidden');
  $search.disabled = true;
  let list = [];
  try {
    list = await api('/api/history');
  } catch (e) {
    if (historyRouteSeq !== _routeSeq) return;
    $empty.innerHTML = `读取历史摘要失败：${escapeHtml(e.message || '未知错误')} <button class="link-btn" id="history-retry" type="button">重试</button>`;
    document.getElementById('history-retry')?.addEventListener('click', route);
    return;
  } finally {
    if (historyRouteSeq === _routeSeq) $search.disabled = false;
  }
  if (historyRouteSeq !== _routeSeq) return;
  if (!list.length) {
    $empty.textContent = '还没有摘要记录。回到「总结」页生成一个吧。';
    $empty.classList.remove('hidden');
    return;
  }
  $empty.classList.add('hidden');
  const itemById = new Map(list.map(item => [String(item.digest_id || ''), item]));
  const searchById = new Map(list.map(item => [String(item.digest_id || ''), historySearchText(item)]));
  $grid.innerHTML = list.map(it => historyCardHtml(it)).join('');
  document.querySelectorAll('.history-thumb img').forEach(watchHistoryThumbnailImage);
  const historyCards = [...document.querySelectorAll('.history-item')];
  historyCards.forEach(el => {
    el.addEventListener('click', () => {
      const item = itemById.get(String(el.dataset.id || ''));
      if (item) showHistoryModal(item);
    });
  });
  function paint(filter = '') {
    const f = filter.trim().toLowerCase();
    let visible = 0;
    historyCards.forEach(el => {
      const matched = !f || (searchById.get(String(el.dataset.id || '')) || '').includes(f);
      el.classList.toggle('hidden', !matched);
      if (matched) visible++;
    });
    $empty.classList.toggle('hidden', visible > 0);
    $empty.textContent = visible ? '' : (f ? '没有匹配的历史摘要。' : '还没有摘要记录。回到「总结」页生成一个吧。');
  }
  paint($search?.value || '');
  $search?.addEventListener('input', e => paint(e.target.value));
}

function historySearchText(item = {}) {
  return [
    item.group,
    item.since,
    item.until,
    item.created_at,
    item.model,
  ].map(x => String(x || '').toLowerCase()).join(' ');
}

function historyItemCacheBust(item = {}) {
  return item.rerendered_at || item.created_at || item.file_path || item.digest_id || '';
}

function historyArtifactState(item = {}) {
  return {
    fileMissing: item.file_exists === false,
    digestMissing: item.digest_exists === false,
  };
}

function historyMetaStatusHtml(item = {}) {
  const { fileMissing, digestMissing } = historyArtifactState(item);
  const bits = [`${Number(item.message_count || 0) || 0} 条`];
  if (fileMissing) bits.push('长图缺失');
  if (digestMissing) bits.push('原摘要缺失');
  const model = String(item.model || '').trim();
  return `${model ? `${escapeHtml(model)} · ` : ''}${bits.map(escapeHtml).join(' · ')}`;
}

function historyThumbHtml(item = {}, version = historyItemCacheBust(item)) {
  const { fileMissing } = historyArtifactState(item);
  if (fileMissing) return '<span class="history-missing-label">长图文件缺失</span>';
  return `<img loading="lazy" decoding="async" src="${historyThumbUrl(item.digest_id, version)}" alt="${escapeHtml(item.group)}" />`;
}

function historyCardHtml(item = {}) {
  const { fileMissing, digestMissing } = historyArtifactState(item);
  return `
        <div class="history-item ${fileMissing ? 'file-missing' : ''} ${digestMissing ? 'digest-missing' : ''}" data-id="${escapeHtml(item.digest_id)}">
          <div class="history-thumb">${historyThumbHtml(item)}</div>
          <div class="history-meta">
            <div class="gname">${escapeHtml(item.group)}</div>
            <div class="time">${escapeHtml(item.since)} ~ ${escapeHtml(item.until)}</div>
            <div class="time muted" data-history-status>${historyMetaStatusHtml(item)}</div>
          </div>
        </div>`;
}

function watchHistoryThumbnailImage(img) {
  const thumb = img?.closest?.('.history-thumb');
  if (!img || !thumb) return;
  const markLoaded = () => thumb.classList.add('loaded');
  const markError = () => thumb.classList.add('error');
  img.addEventListener('load', markLoaded, { once: true });
  img.addEventListener('error', markError, { once: true });
  if (img.complete && img.naturalWidth > 0) markLoaded();
  else if (img.complete) markError();
}

function updateHistoryCardItem(item = {}) {
  const card = [...document.querySelectorAll('.history-item')]
    .find(el => String(el.dataset.id || '') === String(item.digest_id || ''));
  if (!card) return;
  const { fileMissing, digestMissing } = historyArtifactState(item);
  card.classList.toggle('file-missing', fileMissing);
  card.classList.toggle('digest-missing', digestMissing);
  const thumb = card.querySelector('.history-thumb');
  if (thumb) {
    thumb.classList.remove('loaded', 'error');
    thumb.innerHTML = historyThumbHtml(item, Date.now());
    const img = thumb.querySelector('img');
    if (img) watchHistoryThumbnailImage(img);
  }
  const meta = card.querySelector('[data-history-status]');
  if (meta) meta.innerHTML = historyMetaStatusHtml(item);
}

function historyArtifactNote(item = {}) {
  const { fileMissing, digestMissing } = historyArtifactState(item);
  if (fileMissing && digestMissing) return '长图文件和原摘要 JSON 均已不存在，无法重新渲染；请回到总结页重新生成。';
  if (fileMissing) return '长图文件已不存在，可以重新渲染或回到总结页重新生成。';
  if (digestMissing) return '原摘要 JSON 已不存在，不能重新渲染；现有 PNG 仍可下载、复制或打开。';
  return '';
}

function showHistoryModal(item) {
  const imageUrl = historyImageUrl(item.digest_id, historyItemCacheBust(item));
  const serverRerenderSupported = supportsServerRerender();
  const { fileMissing, digestMissing } = historyArtifactState(item);
  const canRerender = serverRerenderSupported && !digestMissing;
  const rerenderTitle = !serverRerenderSupported
      ? '当前系统不支持历史重新渲染；请回到总结页重新生成摘要长图'
      : (digestMissing ? '原摘要 JSON 已不存在，不能重新渲染；现有 PNG 可继续下载、复制或打开' : '');
  const artifactNote = historyArtifactNote(item);
  const artifactNoteHtml = artifactNote
    ? `<div class="missing-image-note ${fileMissing ? '' : 'warning'}">${escapeHtml(artifactNote)}</div>`
    : '';
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="image-modal">
      <div class="modal-head">
        <strong>${escapeHtml(item.group)}</strong>
        <button class="icon-btn" data-close>×</button>
      </div>
      <div class="modal-body ${artifactNote ? 'has-note' : ''}">
        ${artifactNoteHtml}
        ${fileMissing ? '' : `<img data-zoomable src="${imageUrl}" alt="${escapeHtml(item.group)}" title="点击查看 100%" />`}
      </div>
      <div class="preview-actions">
        <a class="btn" data-download href="${imageUrl}" download>⬇ 下载 PNG</a>
        <button class="btn" data-copy>📋 复制到剪贴板</button>
        <button class="btn" data-reveal>📁 在文件夹中显示</button>
        <button class="btn btn-ghost" data-rerender ${canRerender ? '' : `disabled title="${escapeHtml(rerenderTitle)}"`}>🔄 重新渲染</button>
        <span class="status" data-status></span>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('[data-close]').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  const status = modal.querySelector('[data-status]');
  let image = modal.querySelector('[data-zoomable]');
  const modalBody = modal.querySelector('.modal-body');
  const downloadButton = modal.querySelector('[data-download]');
  const copyButton = modal.querySelector('[data-copy]');
  const revealButton = modal.querySelector('[data-reveal]');
  const restoreImageActions = () => {
    copyButton.disabled = false;
    revealButton.disabled = false;
    downloadButton.classList.remove('disabled');
    downloadButton.href = historyImageUrl(item.digest_id, historyItemCacheBust(item) || Date.now());
    downloadButton.setAttribute('download', '');
  };
  const disableImageActions = () => {
    copyButton.disabled = true;
    revealButton.disabled = true;
    downloadButton.classList.add('disabled');
    downloadButton.removeAttribute('href');
    downloadButton.removeAttribute('download');
    status.className = 'status err';
    status.textContent = '长图加载失败：文件可能已被移动或删除。';
  };
  const watchHistoryImage = () => {
    if (!image) return;
    image.addEventListener('load', restoreImageActions, { once: true });
    image.addEventListener('error', disableImageActions, { once: true });
  };
  watchHistoryImage();
  if (fileMissing) disableImageActions();
  if (image?.complete && image.naturalWidth === 0) disableImageActions();
  image?.addEventListener('click', () => {
    if (!image.complete || image.naturalWidth === 0) return;
    showImageZoomModal({ title: item.group, src: historyImageUrl(item.digest_id, historyItemCacheBust(item) || Date.now()) });
  });
  const ensureHistoryModalImage = src => {
    if (image) return image;
    modalBody.innerHTML = `<img data-zoomable src="${src}" alt="${escapeHtml(item.group)}" title="点击查看 100%" />`;
    image = modalBody.querySelector('[data-zoomable]');
    image?.addEventListener('click', () => {
      if (!image.complete || image.naturalWidth === 0) return;
      showImageZoomModal({ title: item.group, src: historyImageUrl(item.digest_id, historyItemCacheBust(item) || Date.now()) });
    });
    return image;
  };
  revealButton.addEventListener('click', () => withBusyButtons(revealButton, async () => {
    status.className = 'status';
    status.textContent = '正在打开文件夹...';
    try {
      await api('/api/reveal', { method: 'POST', body: { digest_id: item.digest_id } });
      status.className = 'status ok';
      status.textContent = '✓ 已请求系统打开并选中文件';
    } catch (e) {
      status.className = 'status err';
      status.textContent = `打开失败：${e.message || '未知错误'}`;
    }
  }));
  copyButton.addEventListener('click', () => withBusyButtons(copyButton, async () => {
    status.className = 'status';
    status.textContent = '复制中...';
    try {
      const copied = await copyImageUrlToClipboard(historyImageUrl(item.digest_id, Date.now()));
      void recordBrowserClipboardCopy({ digestId: item.digest_id, clipboard: copied });
      status.className = 'status ok';
      const size = imageSizeLabel(copied);
      status.textContent = size ? `✓ 已复制到剪贴板（${size}）` : '✓ 已复制到剪贴板';
    } catch (browserError) {
      try {
        const copied = await api('/api/copy-image', { method: 'POST', body: { digest_id: item.digest_id } });
        status.className = 'status ok';
        const size = imageSizeLabel(copied.clipboard);
        status.textContent = size ? `✓ 已通过系统剪贴板复制（${size}）` : '✓ 已通过系统剪贴板复制';
      } catch (e) {
        status.className = 'status err';
        const details = [
          browserError?.message && `浏览器：${compactErrorSummary(browserError.message)}`,
          e?.message && `系统：${compactErrorSummary(e.message)}`,
        ].filter(Boolean).join('；');
        status.textContent = details ? `复制失败：${details}。请下载 PNG。` : '复制失败，请下载 PNG。';
      }
    }
  }));
  const rerenderButton = modal.querySelector('[data-rerender]');
  rerenderButton.addEventListener('click', async e => {
    if (rerenderButton.disabled) return;
    rerenderButton.disabled = true;
    status.className = 'status';
    status.textContent = '正在读取原渲染设置...';
    try {
      const saved = await api(`/api/history-digest/${encodeURIComponent(item.digest_id)}`);
      const initial = digestRenderSelectionFromSaved(saved.digest?.__render);
      status.textContent = '';
      showDigestRerenderPanel({
        anchor: e.currentTarget,
        statusTarget: status,
        initial,
        onSave: async selection => {
          const r = await api('/api/rerender-history', {
            method: 'POST',
            body: { digest_id: item.digest_id, render: digestRenderPayload(selection) },
          });
          Object.assign(item, r.item || {});
          const freshUrl = historyImageUrl(item.digest_id, Date.now());
          item.file_exists = true;
          item.digest_exists = true;
          ensureHistoryModalImage(freshUrl);
          watchHistoryImage();
          if (image) image.src = freshUrl;
          downloadButton.href = freshUrl;
          downloadButton.setAttribute('download', '');
          downloadButton.classList.remove('disabled');
          restoreImageActions();
          modalBody.classList.remove('has-note');
          updateHistoryCardItem(item);
          return r;
        },
      });
    } catch (err) {
      status.className = 'status err';
      status.textContent = `读取原渲染设置失败：${err.message || '未知错误'}`;
    } finally {
      rerenderButton.disabled = !canRerender;
    }
  });
}

function historyImageUrl(digestId, cacheBust = '') {
  const url = `/api/digest-file/${encodeURIComponent(digestId)}?token=${encodeURIComponent(TOKEN)}`;
  return cacheBust ? `${url}&t=${encodeURIComponent(cacheBust)}` : url;
}

function historyThumbUrl(digestId, cacheBust = '') {
  const url = `/api/digest-thumb/${encodeURIComponent(digestId)}?token=${encodeURIComponent(TOKEN)}`;
  return cacheBust ? `${url}&t=${encodeURIComponent(cacheBust)}` : url;
}

async function copyImageUrlToClipboard(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(parseHttpErrorMessage(await res.text(), res.status));
  const blob = await res.blob();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (bitmap) {
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    }
  }
  return null;
}

function showImageZoomModal({ title, src }) {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop zoom-backdrop';
  modal.innerHTML = `
    <div class="image-modal zoom-modal">
      <div class="modal-head">
        <strong>${escapeHtml(title || '长图')}</strong>
        <button class="icon-btn" data-close>×</button>
      </div>
      <div class="modal-body zoom-body">
        <img src="${src}" alt="${escapeHtml(title || '长图')}" />
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('[data-close]').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ---------- 设置页 ----------
async function renderSettings() {
  $app.appendChild(tplOf('tpl-settings'));
  const settingsRouteSeq = _routeSeq;
  const s = await api('/api/settings');
  if (settingsRouteSeq !== _routeSeq) return;
  const settingsAccountId = selectedAccountId();
  const statePromise = api('/api/state').catch(() => ({ platform: '', project_root: '' }));
  let settingsState = _appState || { platform: '', project_root: '' };

  // AI
  let availableModels = Array.isArray(s.llm.available_models) ? s.llm.available_models : [];
  let pendingUnlistedModelConfirm = '';
  let lastLlmCapabilitySnapshot = null;
  document.querySelectorAll('input[name="s-provider"]').forEach(r => {
    r.checked = r.value === (s.llm.provider || 'openai');
  });
  document.getElementById('s-baseurl').value = s.llm.base_url || '';
  document.getElementById('s-apikey').value = '';
  document.getElementById('s-apikey-mask').textContent = s.llm.api_key_set ? `已保存 (${s.llm.api_key_display})` : '尚未保存';
  document.getElementById('s-model').value = s.llm.model || '';
  document.getElementById('s-model-long').value = s.llm.long_context_model || '';
  document.getElementById('s-ai-concurrency').value = normalizeAiConcurrency(s.llm.ai_concurrency);

  function selectedProvider() {
    return document.querySelector('input[name="s-provider"]:checked')?.value || 'openai';
  }
  function normalizeSettingsBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }
  function currentLlmIdentity() {
    const customModel = document.getElementById('s-model-custom')?.checked;
    const customLongModel = document.getElementById('s-model-long-custom')?.checked;
    const model = customModel ? document.getElementById('s-model').value.trim() : document.getElementById('s-model-select').value;
    const longModel = customLongModel ? document.getElementById('s-model-long').value.trim() : document.getElementById('s-model-long-select').value;
    return {
      provider: selectedProvider(),
      base_url: normalizeSettingsBaseUrl(document.getElementById('s-baseurl').value),
      model,
      long_context_model: longModel || model,
    };
  }
  function currentModelRequestIdentity() {
    return {
      provider: selectedProvider(),
      base_url: normalizeSettingsBaseUrl(document.getElementById('s-baseurl').value),
      api_key: document.getElementById('s-apikey').value.trim(),
    };
  }
  function currentModelListIdentity() {
    const identity = currentModelRequestIdentity();
    return {
      ...identity,
      api_key: identity.api_key ? `typed:${identity.api_key}` : (s.llm.api_key_set ? 'saved' : ''),
    };
  }
  function sameLlmIdentity(a, b) {
    return JSON.stringify(a || {}) === JSON.stringify(b || {});
  }
  function clearLlmCapabilitySnapshot() {
    lastLlmCapabilitySnapshot = null;
  }
  function capabilitySnapshotMatches(snapshot, identity = currentLlmIdentity()) {
    const snapshotLongModel = snapshot?.long_context_model || snapshot?.long_context?.model || snapshot?.model;
    return !!snapshot
      && snapshot.provider === identity.provider
      && normalizeSettingsBaseUrl(snapshot.base_url) === identity.base_url
      && snapshot.model === identity.model
      && snapshotLongModel === identity.long_context_model
      && (!identity.long_context_model || identity.long_context_model === identity.model || snapshot.long_context?.model === identity.long_context_model);
  }
  function addCapabilityItems(target, items = []) {
    for (const item of Array.isArray(items) ? items : []) {
      if (!item?.name) continue;
      target[item.name] = {
        ok: !!item.ok,
        latency_ms: Number(item.latency_ms || 0) || 0,
      };
      if (!item.ok && item.error) target[item.name].error = String(item.error).slice(0, 300);
    }
  }
  function capabilitySnapshotFromTest(result = {}) {
    const identity = currentLlmIdentity();
    const modelResults = Array.isArray(result.model_results) && result.model_results.length
      ? result.model_results
      : [{ role: 'model', model: result.model, checked_at: result.checked_at, capabilities: result.capabilities || [] }];
    const baseResult = modelResults.find(item => item.role === 'model') || modelResults[0] || {};
    const longResult = modelResults.find(item => item.role === 'long_context');
    const snapshot = {
      provider: result.provider || selectedProvider(),
      base_url: normalizeSettingsBaseUrl(result.base_url || document.getElementById('s-baseurl').value),
      model: baseResult.model || result.model || identity.model,
      long_context_model: identity.long_context_model,
      checked_at: result.checked_at || baseResult.checked_at || new Date().toISOString(),
    };
    addCapabilityItems(snapshot, baseResult.capabilities || result.capabilities || []);
    if (identity.long_context_model && identity.long_context_model !== identity.model) {
      snapshot.long_context = {
        model: longResult?.model || identity.long_context_model,
        checked_at: longResult?.checked_at || result.checked_at || new Date().toISOString(),
      };
      addCapabilityItems(snapshot.long_context, longResult?.capabilities || []);
    }
    return snapshot;
  }
  function currentCapabilitySnapshotForSave() {
    const identity = currentLlmIdentity();
    return capabilitySnapshotMatches(lastLlmCapabilitySnapshot, identity) ? lastLlmCapabilitySnapshot : null;
  }
  function fillModelSelects() {
    const modelIds = new Set(availableModels.map(m => m.id));
    const modelOptions = [...availableModels];
    if (s.llm.model && !modelIds.has(s.llm.model)) modelOptions.unshift({ id: s.llm.model, unlisted: true });
    const longModelIds = new Set(availableModels.map(m => m.id));
    const longModelOptions = [...availableModels];
    if (s.llm.long_context_model && !longModelIds.has(s.llm.long_context_model)) longModelOptions.unshift({ id: s.llm.long_context_model, unlisted: true });
    const optionHtml = items => items.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}${m.unlisted ? '（未在列表）' : ''}</option>`).join('');
    const modelSelect = document.getElementById('s-model-select');
    const longSelect = document.getElementById('s-model-long-select');
    modelSelect.innerHTML = optionHtml(modelOptions) || '<option value="">先获取模型</option>';
    longSelect.innerHTML = optionHtml(longModelOptions) || '<option value="">先获取模型</option>';
    if (s.llm.model) modelSelect.value = s.llm.model;
    if (s.llm.long_context_model) longSelect.value = s.llm.long_context_model;
    if (!modelSelect.value && availableModels[0]) modelSelect.value = availableModels[0].id;
    if (!longSelect.value && availableModels[0]) longSelect.value = availableModels[0].id;
  }
  function syncCustomModel(which, { copyFromSelect = false } = {}) {
    const isLong = which === 'long';
    const cb = document.getElementById(isLong ? 's-model-long-custom' : 's-model-custom');
    const select = document.getElementById(isLong ? 's-model-long-select' : 's-model-select');
    const input = document.getElementById(isLong ? 's-model-long' : 's-model');
    if (copyFromSelect && cb.checked && select.value) input.value = select.value;
    select.classList.toggle('hidden', cb.checked);
    input.classList.toggle('hidden', !cb.checked);
  }
  function applySavedLlmSettings(saved) {
    if (!saved?.llm) return;
    Object.assign(s.llm, saved.llm);
    availableModels = Array.isArray(s.llm.available_models) ? s.llm.available_models : [];
    document.getElementById('s-apikey').value = '';
    document.getElementById('s-apikey').type = 'password';
    document.getElementById('s-apikey-mask').textContent = s.llm.api_key_set ? `已保存 (${s.llm.api_key_display})` : '尚未保存';
    document.getElementById('s-model').value = s.llm.model || '';
    document.getElementById('s-model-long').value = s.llm.long_context_model || '';
    document.getElementById('s-ai-concurrency').value = normalizeAiConcurrency(s.llm.ai_concurrency);
    document.getElementById('s-model-custom').checked = !!s.llm.custom_model;
    document.getElementById('s-model-long-custom').checked = !!s.llm.custom_long_context_model;
    fillModelSelects();
    syncCustomModel('model');
    syncCustomModel('long');
    modelListIdentity = currentModelListIdentity();
  }
  let modelListIdentity = currentModelListIdentity();
  fillModelSelects();
  document.getElementById('s-model-custom').checked = !!s.llm.custom_model;
  document.getElementById('s-model-long-custom').checked = !!s.llm.custom_long_context_model;
  syncCustomModel('model');
  syncCustomModel('long');
  document.getElementById('s-model-custom').addEventListener('change', () => { syncCustomModel('model', { copyFromSelect: true }); clearLlmCapabilitySnapshot(); });
  document.getElementById('s-model-long-custom').addEventListener('change', () => { syncCustomModel('long', { copyFromSelect: true }); clearLlmCapabilitySnapshot(); });
  const llmEndpointInputs = [
    ...document.querySelectorAll('input[name="s-provider"]'),
    document.getElementById('s-baseurl'),
    document.getElementById('s-apikey'),
  ];
  const llmIdentityInputs = [
    ...llmEndpointInputs,
    document.getElementById('s-model'),
    document.getElementById('s-model-select'),
    document.getElementById('s-model-long'),
    document.getElementById('s-model-long-select'),
  ];
  llmIdentityInputs.forEach(input => {
    input?.addEventListener('input', clearLlmCapabilitySnapshot);
    input?.addEventListener('change', clearLlmCapabilitySnapshot);
  });
  function markModelListMaybeStale() {
    pendingUnlistedModelConfirm = '';
    clearLlmCapabilitySnapshot();
    const status = document.getElementById('s-model-status');
    if (availableModels.length && !sameLlmIdentity(modelListIdentity, currentModelListIdentity()) && status) {
      status.className = 'status warn';
      status.textContent = '端点或密钥已变化，请重新获取模型列表。';
    }
  }
  llmEndpointInputs.forEach(input => {
    input?.addEventListener('input', markModelListMaybeStale);
    input?.addEventListener('change', markModelListMaybeStale);
  });

  document.getElementById('s-apikey-toggle').addEventListener('click', () => {
    const inp = document.getElementById('s-apikey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  const llmActionButtons = [
    document.getElementById('s-list-models'),
    document.getElementById('s-test-llm'),
    document.getElementById('s-save-llm'),
  ];
  function requireCurrentLlmEndpoint(statusEl) {
    const baseUrl = normalizeSettingsBaseUrl(document.getElementById('s-baseurl').value);
    const apiKey = document.getElementById('s-apikey').value.trim();
    if (!baseUrl) {
      statusEl.className = 'status err';
      statusEl.textContent = '✗ 请填写 Base URL';
      return false;
    }
    if (!apiKey && !s.llm.api_key_set) {
      statusEl.className = 'status err';
      statusEl.textContent = '✗ 请填写 API Key';
      return false;
    }
    return true;
  }
  function currentLlmFormModels() {
    const customModel = document.getElementById('s-model-custom').checked;
    const customLongModel = document.getElementById('s-model-long-custom').checked;
    const model = customModel ? document.getElementById('s-model').value.trim() : document.getElementById('s-model-select').value;
    const longModel = customLongModel ? document.getElementById('s-model-long').value.trim() : document.getElementById('s-model-long-select').value;
    return { customModel, customLongModel, model, longModel };
  }
  document.getElementById('s-list-models').addEventListener('click', () => withBusyButtons(llmActionButtons, async () => {
    const $st = document.getElementById('s-model-status');
    if (!requireCurrentLlmEndpoint($st)) return;
    $st.className = 'status';
    $st.textContent = '获取中...';
    try {
      const requestIdentity = currentModelRequestIdentity();
      const payload = { provider: requestIdentity.provider, base_url: requestIdentity.base_url, persist: true };
      if (requestIdentity.api_key) payload.api_key = requestIdentity.api_key;
      const r = await api('/api/list-models', { method: 'POST', body: payload });
      if (!sameLlmIdentity(currentModelRequestIdentity(), requestIdentity)) {
        $st.className = 'status warn';
        $st.textContent = '端点或密钥已变化，旧模型列表结果已忽略。';
        return;
      }
      availableModels = r.models || [];
      modelListIdentity = currentModelListIdentity();
      clearLlmCapabilitySnapshot();
      fillModelSelects();
      $st.className = 'status ok';
      $st.textContent = `✓ 已获取 ${availableModels.length} 个模型`;
    } catch (e) {
      $st.className = 'status err';
      $st.textContent = '✗ ' + e.message;
    }
  }));
  document.getElementById('s-test-llm').addEventListener('click', () => withBusyButtons(llmActionButtons, async () => {
    const $st = document.getElementById('s-llm-status');
    if (!requireCurrentLlmEndpoint($st)) return;
    const { customModel, customLongModel, model, longModel } = currentLlmFormModels();
    if (!model) {
      $st.className = 'status err';
      $st.textContent = customModel ? '✗ 请填写自定义模型' : '✗ 请先选择模型';
      return;
    }
    if (customLongModel && !longModel) {
      $st.className = 'status err';
      $st.textContent = '✗ 请填写自定义长上下文模型，或关闭自定义';
      return;
    }
    $st.className = 'status'; $st.textContent = '测试中...';
    try {
      const key = document.getElementById('s-apikey').value.trim();
      const payload = { provider: selectedProvider(), base_url: document.getElementById('s-baseurl').value, model, long_context_model: longModel || model };
      if (key) payload.api_key = key;
      const r = await api('/api/test-llm', {
        method: 'POST',
        body: payload,
      });
      lastLlmCapabilitySnapshot = capabilitySnapshotFromTest(r);
      const modelResults = Array.isArray(r.model_results) && r.model_results.length
        ? r.model_results
        : [{ role: 'model', model: r.model, ok: r.ok, capabilities: r.capabilities || [] }];
      const resultText = modelResults.map(formatModelConnectivityResult).join('；');
      const hasCapabilityFailures = modelResults.some(result => (result.capabilities || []).some(item => !item.ok));
      $st.className = r.ok ? (hasCapabilityFailures ? 'status warn' : 'status ok') : (r.partial_ok ? 'status warn' : 'status err');
      $st.textContent = `${r.ok ? '✓' : (r.partial_ok ? '⚠' : '✗')} 连通测试 ${r.latency_ms}ms：${resultText || '无结果'}`;
    } catch (e) {
      $st.className = 'status err'; $st.textContent = '✗ 失败：' + e.message;
    }
  }));
  document.getElementById('s-save-llm').addEventListener('click', () => withBusyButtons(llmActionButtons, async () => {
    const $st = document.getElementById('s-llm-status');
    const apiKey = document.getElementById('s-apikey').value.trim();
    const { customModel, customLongModel, model, longModel } = currentLlmFormModels();
    const baseUrl = document.getElementById('s-baseurl').value.trim();
    const aiConcurrency = normalizeAiConcurrency(document.getElementById('s-ai-concurrency').value);
    if (!baseUrl) {
      $st.className = 'status err';
      $st.textContent = '✗ 请填写 Base URL';
      return;
    }
    if (!apiKey && !s.llm.api_key_set) {
      $st.className = 'status err';
      $st.textContent = '✗ 请填写 API Key';
      return;
    }
    if (!model) {
      $st.className = 'status err';
      $st.textContent = '✗ 请选择或填写模型';
      return;
    }
    const availableIds = new Set(availableModels.map(m => m.id));
    const modelListCurrent = sameLlmIdentity(modelListIdentity, currentModelListIdentity());
    const staleModelList = availableModels.length && !modelListCurrent;
    if (staleModelList && (!customModel || (longModel && !customLongModel))) {
      $st.className = 'status warn';
      $st.textContent = '⚠ 端点或密钥已变化，请重新获取模型列表后保存；如果确认模型可用，可以开启自定义模型后保存。';
      return;
    }
    const unlisted = [];
    if (availableIds.size && !customModel && !availableIds.has(model)) unlisted.push(model);
    if (availableIds.size && longModel && !customLongModel && !availableIds.has(longModel)) unlisted.push(longModel);
    const unlistedKey = [...new Set(unlisted)].join('|');
    if (unlistedKey && pendingUnlistedModelConfirm !== unlistedKey) {
      pendingUnlistedModelConfirm = unlistedKey;
      $st.className = 'status warn';
      $st.textContent = `⚠ 模型未在端点列表中：${[...new Set(unlisted)].join('、')}。确认可用请再点一次保存，或开启自定义模型。`;
      return;
    }
    pendingUnlistedModelConfirm = '';
    const payload = {
      llm: {
        provider: selectedProvider(),
        base_url: baseUrl,
        model,
        long_context_model: longModel || model,
        custom_model: customModel,
        custom_long_context_model: customLongModel,
        ai_concurrency: aiConcurrency,
        available_models: modelListCurrent ? availableModels : [],
      },
    };
    const capabilities = currentCapabilitySnapshotForSave();
    payload.llm.capabilities = capabilities || null;
    if (apiKey) payload.llm.api_key = apiKey;
    $st.className = 'status';
    $st.textContent = '保存中...';
    try {
      const r = await api('/api/settings', { method: 'PUT', body: payload });
      applySavedLlmSettings(r.settings);
      refreshAppStateSilently();
      const warnings = Array.isArray(r.warnings) ? r.warnings : [];
      if (warnings.length) {
        $st.className = 'status warn';
        $st.textContent = '⚠ 已保存；' + warnings.map(w => w.message || w).join('；');
      } else {
        $st.className = 'status ok';
        $st.textContent = capabilities ? '✓ 已保存，已记录连通能力' : '✓ 已保存';
      }
    } catch (e) {
      $st.className = 'status err';
      $st.textContent = '✗ 保存失败：' + e.message;
    }
  }));
  llmActionButtons.forEach(button => { button.disabled = false; });

  // 群与调度
  const $wl = document.getElementById('s-whitelist');
  let groups = [];
  let groupsLoaded = false;
  let groupsLoadError = null;
  let schedulerOverrides = Array.isArray(s.scheduler.per_group) ? s.scheduler.per_group.map(item => ({
    account_id: item.account_id || '',
    group_id: item.group_id || '',
    group_name: item.group_name || item.name || '',
    group: item.group || item.group_name || item.group_id || '',
    keywords: Array.isArray(item.keywords) ? item.keywords : String(item.keywords || '').split(/[,，]/).map(x => x.trim()).filter(Boolean),
    min_messages: Number(item.min_messages || item.min_messages_per_digest || 0) || 0,
  })).filter(item => item.group && (item.keywords.length || item.min_messages)) : [];
  $wl.innerHTML = '<p class="empty">正在后台读取本机微信群列表...</p>';
  function paintWl() {
    if (!groups.length) {
      if (groupsLoadError) {
        $wl.innerHTML = `<p class="empty">读取本机微信群列表失败：${escapeHtml(groupsLoadError.message || '未知错误')}。保存调度设置时会保留原白名单，不会清空。</p>`;
      } else if (!groupsLoaded) {
        $wl.innerHTML = '<p class="empty">正在后台读取本机微信群列表...</p>';
      } else {
        $wl.innerHTML = '<p class="empty">本机没有可显示的微信群。保存调度设置时会保留原白名单。</p>';
      }
      return;
    }
    $wl.innerHTML = groups.map(g => {
      const checked = (s.groups.whitelist || []).some(ref => groupRefMatches(ref, g, settingsAccountId));
      return `<label class="chip"><input type="checkbox" ${checked ? 'checked' : ''} value="${escapeHtml(g.id)}" data-group-name="${escapeHtml(g.name)}" /> ${escapeHtml(g.name)}</label>`;
    }).join('');
  }
  function paintOverrideEditor() {
    const groupSelect = document.getElementById('s-override-group');
    const list = document.getElementById('s-overrides');
    if (!groupSelect || !list) return;
    groupSelect.innerHTML = groups.length
      ? groups.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name || g.id)}</option>`).join('')
      : groupsLoadError
        ? '<option value="">群列表不可用</option>'
        : groupsLoaded
          ? '<option value="">没有可选群</option>'
          : '<option value="">群列表读取中...</option>';
    document.getElementById('s-add-override').disabled = !groups.length;
    list.innerHTML = schedulerOverrides.length
      ? schedulerOverrides.map((item, index) => `
        <div class="override-item" data-index="${index}">
          <strong>${escapeHtml(groupLabelFromRef(item) || item.group)}</strong>
          <span class="muted">${escapeHtml(item.keywords?.length ? item.keywords.join('、') : '不过滤关键词')}</span>
          <span>${item.min_messages ? `${item.min_messages} 条` : '用全局'}</span>
          <button class="link-btn" type="button" data-remove-override="${index}">删除</button>
        </div>`).join('')
      : '<p class="empty">暂无覆盖规则。</p>';
    list.querySelectorAll('[data-remove-override]').forEach(button => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.removeOverride);
        schedulerOverrides.splice(index, 1);
        paintOverrideEditor();
      });
    });
  }
  async function loadSettingsGroupsInBackground() {
    groupsLoadError = null;
    groupsLoaded = false;
    paintWl();
    paintOverrideEditor();
    try {
      const loaded = await api(`/api/groups?account=${encodeURIComponent(settingsAccountId)}`);
      if (settingsRouteSeq !== _routeSeq || !document.getElementById('s-whitelist')) return;
      groups = Array.isArray(loaded) ? loaded : [];
      groupsLoaded = true;
      groupsLoadError = null;
    } catch (e) {
      if (settingsRouteSeq !== _routeSeq || !document.getElementById('s-whitelist')) return;
      groups = [];
      groupsLoaded = false;
      groupsLoadError = e;
    }
    paintWl();
    paintOverrideEditor();
  }
  paintWl();
  paintOverrideEditor();
  document.getElementById('s-add-override')?.addEventListener('click', () => {
    const groupId = document.getElementById('s-override-group').value;
    const group = groups.find(item => item.id === groupId) || {};
    const keywords = document.getElementById('s-override-keywords').value
      .split(/[,，]/)
      .map(x => x.trim())
      .filter(Boolean);
    const minMessages = parseInt(document.getElementById('s-override-min').value || '0', 10) || 0;
    if (!groupId || (!keywords.length && !minMessages)) return;
    const ref = groupRefForPayload({ id: groupId, name: group.name || groupId }, settingsAccountId);
    schedulerOverrides = schedulerOverrides.filter(item => groupRefKey(item) !== groupRefKey(ref));
    schedulerOverrides.push({ ...ref, group: ref.group_name || ref.group_id, keywords, min_messages: minMessages });
    document.getElementById('s-override-keywords').value = '';
    document.getElementById('s-override-min').value = '';
    paintOverrideEditor();
  });
  document.getElementById('s-scheduler').checked = !!s.scheduler.enabled;
  setDurationControl('s-scheduler-interval', s.scheduler.default_interval || '30m', '30m');
  setDurationControl('s-scheduler-window', s.scheduler.digest_window || '4h', '4h');
  document.getElementById('s-scheduler-min').value = s.scheduler.min_messages_per_digest ?? 30;
  const schedulerStatus = document.getElementById('s-scheduler-status');
  let schedulerStatusSeq = 0;
  let schedulerBusy = false;
  function schedulerDetailLabel(detail) {
    const map = {
      scheduler_disabled: '定时任务未启用',
      llm_not_configured: 'AI 设置未配置完整',
      no_whitelisted_groups: '没有可自动检查的白名单群',
      already_running: '已有检查正在运行',
      below_minimum: '消息数低于阈值',
      no_new_messages: '没有新消息',
      no_matching_filters: '筛选条件无匹配消息',
      account_groups_failed: '读取群列表失败',
      error: '检查失败',
    };
    return map[detail] || detail || '';
  }
  function schedulerItemsSummary(items = []) {
    const counts = new Map();
    const examples = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.generated) continue;
      const detail = item?.error ? 'error' : item?.detail;
      if (!detail) continue;
      counts.set(detail, (counts.get(detail) || 0) + 1);
      if (!examples.has(detail)) examples.set(detail, []);
      const list = examples.get(detail);
      const name = item.group || item.account || item.group_id || item.account_id || '';
      if (name && list.length < 2) list.push(String(name));
    }
    return [...counts.entries()].map(([detail, count]) => {
      const names = examples.get(detail) || [];
      const sample = names.length ? `：${names.join('、')}${count > names.length ? ' 等' : ''}` : '';
      return `${schedulerDetailLabel(detail)} ${count}${sample}`;
    }).join('；');
  }
  function schedulerStatusClass(status = {}) {
    const r = status.last_result || {};
    if (status.last_error || r.error || Number(r.failed || 0) > 0) return 'status err';
    const warningDetails = new Set([
      'llm_not_configured',
      'no_whitelisted_groups',
      'already_running',
      'scheduler_disabled',
      'below_minimum',
      'no_matching_filters',
    ]);
    const details = [
      r.detail,
      ...(Array.isArray(r.items) ? r.items.map(item => item?.detail) : []),
    ].filter(Boolean);
    if (r.ok === false || details.some(detail => warningDetails.has(detail))) return 'status warn';
    return 'status';
  }
  function schedulerStatusWithImmediateResult(status = {}, result = null) {
    if (!result) return status || {};
    const lastResult = result.detail || result.generated !== undefined || result.skipped || result.error
      ? result
      : status?.last_result;
    return { ...(status || {}), last_result: lastResult || status?.last_result };
  }
  function paintSchedulerStatus(status = {}, { immediateResult = null } = {}) {
    const view = schedulerStatusWithImmediateResult(status, immediateResult);
    const bits = [];
    bits.push(view.enabled ? '已启用' : '未启用');
    if (view.running) bits.push('运行中');
    if (view.next_run_at) bits.push(`下次 ${new Date(view.next_run_at).toLocaleString()}`);
    if (view.last_result) {
      const r = view.last_result;
      if (r.generated !== undefined) {
        const itemSummary = schedulerItemsSummary(r.items);
        const detail = [
          `生成 ${r.generated || 0}`,
          r.checked !== undefined ? `检查 ${r.checked}` : '',
          r.skipped ? `跳过 ${r.skipped}` : '',
          r.failed ? `失败 ${r.failed}` : '',
          r.detail ? schedulerDetailLabel(r.detail) : '',
          itemSummary,
        ].filter(Boolean).join(' / ');
        bits.push(`上次 ${detail}`);
      } else if (r.detail) {
        bits.push(`上次 ${schedulerDetailLabel(r.detail)}`);
      } else if (r.error) {
        bits.push(`上次失败：${r.error}`);
      }
    }
    if (view.last_error) bits.push(`错误：${view.last_error}`);
    schedulerStatus.className = schedulerStatusClass(view);
    schedulerStatus.textContent = bits.join(' · ');
  }
  function setSchedulerActionBusy(value) {
    schedulerBusy = !!value;
    schedulerStatusSeq++;
  }
  function setSchedulerStatusFromBackground(status) {
    if (schedulerBusy) return;
    paintSchedulerStatus(status);
  }
  const schedulerInitialSeq = schedulerStatusSeq;
  api('/api/scheduler/status')
    .then(r => {
      if (settingsRouteSeq !== _routeSeq || !document.getElementById('s-scheduler-status')) return;
      if (schedulerStatusSeq !== schedulerInitialSeq) return;
      setSchedulerStatusFromBackground(r.scheduler);
    })
    .catch(() => {
      if (settingsRouteSeq !== _routeSeq || !document.getElementById('s-scheduler-status')) return;
      if (schedulerStatusSeq !== schedulerInitialSeq) return;
      setSchedulerStatusFromBackground({ enabled: !!s.scheduler.enabled });
    });
  const saveGroupsButton = document.getElementById('s-save-groups');
  const runSchedulerButton = document.getElementById('s-run-scheduler');
  function overrideGroupRef(item) {
    if (item?.group_id || item?.group_name || item?.account_id) {
      const out = {};
      if (item.account_id) out.account_id = item.account_id;
      if (item.group_id) out.group_id = item.group_id;
      if (item.group_name) out.group_name = item.group_name;
      return out;
    }
    const legacy = String(item?.group || '').trim();
    return legacy || {};
  }
  function overridePayload(item) {
    const ref = overrideGroupRef(item);
    const base = typeof ref === 'string'
      ? { group: ref }
      : { ...ref, group: item.group || groupLabelFromRef(ref) };
    return {
      ...base,
      keywords: item.keywords,
      min_messages: item.min_messages,
    };
  }
  function schedulerSettingsPayload() {
    const existingWhitelist = Array.isArray(s.groups?.whitelist) ? s.groups.whitelist : [];
    const wl = groupsLoaded
      ? mergeGroupRefs([
          ...existingWhitelist.filter(ref => !groups.some(group => groupRefMatches(ref, group, settingsAccountId))),
          ...[...document.querySelectorAll('#s-whitelist input:checked')].map(input => {
            const group = groups.find(item => item.id === input.value) || { id: input.value, name: input.dataset.groupName || input.value };
            return groupRefForPayload(group, settingsAccountId);
          }),
        ])
      : existingWhitelist;
    const perGroup = schedulerOverrides.map(overridePayload);
    return {
      groups: { whitelist: mergeGroupRefs([...wl, ...perGroup.map(overrideGroupRef)]) },
      scheduler: {
        enabled: document.getElementById('s-scheduler').checked,
        default_interval: getDurationControlValue('s-scheduler-interval', '30m'),
        digest_window: getDurationControlValue('s-scheduler-window', '4h'),
        min_messages_per_digest: parseInt(document.getElementById('s-scheduler-min').value || '30', 10),
        per_group: perGroup,
      },
    };
  }
  async function saveSchedulerSettings() {
    return api('/api/settings', {
      method: 'PUT',
      body: schedulerSettingsPayload(),
    });
  }
  saveGroupsButton.addEventListener('click', () => withBusyButtons([saveGroupsButton, runSchedulerButton], async () => {
    setSchedulerActionBusy(true);
    schedulerStatus.className = 'status';
    schedulerStatus.textContent = groupsLoaded ? '保存中...' : '保存中（保留原白名单）...';
    try {
      await saveSchedulerSettings();
      schedulerStatus.className = 'status ok';
      schedulerStatus.textContent = groupsLoaded ? '✓ 已保存白名单与调度设置' : '✓ 已保存调度设置，原白名单已保留';
      const r = await api('/api/scheduler/status').catch(() => null);
      if (r?.scheduler) paintSchedulerStatus(r.scheduler);
    } catch (e) {
      schedulerStatus.className = 'status err';
      schedulerStatus.textContent = '✗ 保存失败：' + e.message;
    } finally {
      setSchedulerActionBusy(false);
    }
  }));
  runSchedulerButton.addEventListener('click', () => withBusyButtons([saveGroupsButton, runSchedulerButton], async () => {
    setSchedulerActionBusy(true);
    schedulerStatus.className = 'status';
    schedulerStatus.textContent = groupsLoaded ? '先保存当前设置，再检查...' : '先保存当前设置（保留原白名单），再检查...';
    try {
      await saveSchedulerSettings();
      schedulerStatus.textContent = '检查中...';
      const r = await api('/api/scheduler/run-once', { method: 'POST', body: {} });
      paintSchedulerStatus(r.scheduler, { immediateResult: r.result });
    } catch (e) {
      schedulerStatus.className = 'status err';
      schedulerStatus.textContent = '✗ ' + e.message;
    } finally {
      setSchedulerActionBusy(false);
    }
  }));
  saveGroupsButton.disabled = false;
  runSchedulerButton.disabled = false;
  loadSettingsGroupsInBackground();

  // 渲染与输出
  function paintSettingsStateMeta() {
    const platformEl = document.getElementById('s-platform');
    const rootEl = document.getElementById('s-projroot');
    if (platformEl) platformEl.textContent = settingsState.platform || '';
    if (rootEl) rootEl.textContent = settingsState.project_root || '';
  }
  statePromise.then(state => {
    if (settingsRouteSeq !== _routeSeq) return;
    settingsState = state || settingsState;
    paintSettingsStateMeta();
  }).catch(() => {});
  document.getElementById('s-theme').value = s.render.default_theme;
  document.getElementById('s-fontsize').value = s.render.default_font_size;
  document.getElementById('s-outdir').value = s.output.dir;
  document.getElementById('s-retention').value = s.output.retention_days ?? 0;
  const openOutdirButton = document.getElementById('s-open-outdir');
  const saveRenderButton = document.getElementById('s-save-render');
  const renderOutputButtons = [openOutdirButton, saveRenderButton];
  openOutdirButton.addEventListener('click', () => withBusyButtons(renderOutputButtons, async () => {
    const $st = document.getElementById('s-render-status');
    const outDir = document.getElementById('s-outdir').value.trim();
    if (!outputDirLooksInsideProject(outDir, settingsState.project_root)) {
      $st.className = 'status err';
      $st.textContent = '✗ 输出目录必须在 outputs/ 下，且不能位于 outputs/.tmp';
      return;
    }
    $st.className = 'status';
    $st.textContent = '正在打开输出目录...';
    try {
      await api('/api/open-output', { method: 'POST', body: { dir: outDir } });
      $st.className = 'status ok';
      $st.textContent = '✓ 已请求系统打开输出目录';
    } catch (e) {
      $st.className = 'status err';
      $st.textContent = '✗ 打开失败：' + e.message;
    }
  }));
  saveRenderButton.addEventListener('click', () => withBusyButtons(renderOutputButtons, async () => {
    const $st = document.getElementById('s-render-status');
    const outDir = document.getElementById('s-outdir').value.trim();
    if (!outputDirLooksInsideProject(outDir, settingsState.project_root)) {
      $st.className = 'status err';
      $st.textContent = '✗ 输出目录必须在 outputs/ 下，且不能位于 outputs/.tmp';
      return;
    }
    $st.className = 'status';
    $st.textContent = '保存中...';
    try {
      const r = await api('/api/settings', {
        method: 'PUT',
        body: {
          render: {
            default_theme: document.getElementById('s-theme').value,
            default_font_size: document.getElementById('s-fontsize').value,
          },
          output: {
            dir: outDir,
            retention_days: parseInt(document.getElementById('s-retention').value || '0', 10),
          },
        },
      });
      if (r.settings?.render) s.render = r.settings.render;
      if (r.settings?.output) {
        s.output = r.settings.output;
        document.getElementById('s-outdir').value = s.output.dir || outDir;
        document.getElementById('s-retention').value = s.output.retention_days ?? 0;
      }
      $st.className = 'status ok';
      $st.textContent = '✓ 已保存';
    } catch (e) {
      $st.className = 'status err';
      $st.textContent = '✗ ' + e.message;
    }
  }));
  openOutdirButton.disabled = false;
  saveRenderButton.disabled = false;

  // 隐私
  document.getElementById('s-redact-phone').checked = !!s.privacy.redact_phone;
  document.getElementById('s-redact-id').checked = !!s.privacy.redact_id_card;
  document.getElementById('s-redact-bank').checked = !!s.privacy.redact_bank_card;
  document.getElementById('s-redact-email').checked = !!s.privacy.redact_email;
  document.getElementById('s-keymode').value = s.wechat.manual_key_set ? 'manual' : 'auto';
  document.getElementById('s-keymode').addEventListener('change', e => {
    document.getElementById('s-manual-key-row').classList.toggle('hidden', e.target.value !== 'manual');
  });
  if (document.getElementById('s-keymode').value === 'manual') document.getElementById('s-manual-key-row').classList.remove('hidden');
  const savePrivacyButton = document.getElementById('s-save-privacy');
  const exportDiagButton = document.getElementById('s-export-diag');
  savePrivacyButton.addEventListener('click', () => withBusyButtons([savePrivacyButton, exportDiagButton], async () => {
    const $st = document.getElementById('s-privacy-status');
    const keyMode = document.getElementById('s-keymode').value;
    const manualKey = document.getElementById('s-manual-key').value.trim();
    const manualKeys = normalizeManualKeysText(manualKey);
    if (keyMode === 'manual' && manualKey && manualKeys.invalid.length) {
      $st.className = 'status err';
      $st.textContent = '✗ 手动密钥每条必须是 64 或 96 位 hex';
      return;
    }
    if (keyMode === 'manual' && !manualKeys.keys.length && !s.wechat.manual_key_set) {
      $st.className = 'status err';
      $st.textContent = '✗ 手动模式需要填写至少一条 64 或 96 位 hex 密钥；不填写请切回自动模式';
      return;
    }
    const wechatPatch = keyMode === 'manual'
      ? (manualKeys.keys.length ? { manual_key: manualKeys.text } : {})
      : { clear_manual_key: true };
    $st.className = 'status';
    $st.textContent = '保存中...';
    try {
      const r = await api('/api/settings', {
        method: 'PUT',
        body: {
          privacy: {
            redact_phone: document.getElementById('s-redact-phone').checked,
            redact_id_card: document.getElementById('s-redact-id').checked,
            redact_bank_card: document.getElementById('s-redact-bank').checked,
            redact_email: document.getElementById('s-redact-email').checked,
          },
          wechat: wechatPatch,
        },
      });
      if (r.settings?.wechat) s.wechat = r.settings.wechat;
      document.getElementById('s-manual-key').value = '';
      $st.className = 'status ok';
      const savedManualCount = keyMode === 'manual' ? manualKeys.keys.length : 0;
      if (savedManualCount) {
        $st.textContent = `✓ 已保存隐私设置（${savedManualCount} 条手动密钥）`;
      } else if (keyMode === 'manual' && s.wechat.manual_key_set) {
        $st.textContent = '✓ 已保存隐私设置；未填写新手动密钥，已保留原密钥';
      } else if (keyMode === 'manual') {
        $st.textContent = '✓ 已保存隐私设置；未填写手动密钥';
      } else {
        $st.textContent = '✓ 已保存隐私设置；已切回自动模式并清除手动密钥';
      }
    } catch (e) {
      $st.className = 'status err';
      $st.textContent = '✗ 保存失败：' + e.message;
    }
  }));
  exportDiagButton.addEventListener('click', () => withBusyButtons([savePrivacyButton, exportDiagButton], async () => {
    const $st = document.getElementById('s-privacy-status');
    $st.className = 'status';
    $st.textContent = '正在导出诊断包...';
    try {
      const diag = await api('/api/diagnostics');
      const blob = new Blob([JSON.stringify(diag, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wx-summary-diagnostics-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      $st.className = 'status ok';
      $st.textContent = '✓ 已导出诊断包（含人工验收清单）';
    } catch (e) {
      $st.className = 'status err';
      $st.textContent = '✗ 导出失败：' + e.message;
    }
  }));
  savePrivacyButton.disabled = false;
  exportDiagButton.disabled = false;

  function acceptanceStatusLabel(status) {
    const map = {
      needs_user_confirmation: '待人工确认',
      passed: '已通过',
      failed: '未通过',
    };
    return map[status] || status || '';
  }
  function softwareEvidenceLabel(status) {
    const map = {
      external_baseline_matched: '外部基线已匹配',
      external_baseline_after_service_start: '外部基线晚于本轮启动',
      ready_for_external_baseline_check: '工具内证据就绪，仍需外部基线',
      software_evidence_incomplete: '软件证据不完整',
      ready_for_user_confirmation: '证据已就绪，待人工确认',
      waiting_for_24h_uptime: '等待服务连续运行满 24 小时',
      ready_for_user_paste_confirmation: '复制证据已就绪，待人工粘贴确认',
      needs_local_copy_action: '需要先执行复制 PNG',
      explorer_selection_matched: '文件管理器选中证据已匹配',
      reveal_requested_needs_visual_confirmation: '已请求打开文件夹，待目测确认',
      needs_local_reveal_action: '需要先执行在文件夹中显示',
      bad_secret_detected_external_user_needed: '坏密钥证据已出现，仍需跨用户确认',
      needs_bad_secret_or_external_user_test: '需要坏密钥或跨用户测试',
    };
    return map[status] || status || '';
  }
  function acceptanceStateLabel(item = {}) {
    return item.ready_for_user_confirmation ? '证据已就绪，待人工确认' : '等待软件证据';
  }

  async function refreshAcceptanceChecks() {
    const $list = document.getElementById('s-acceptance-checks');
    const $st = document.getElementById('s-acceptance-status');
    if (!$list || !$st) return;
    $st.className = 'status';
    $st.textContent = '正在读取诊断状态...';
    try {
      const diag = await api('/api/diagnostics?scope=acceptance');
      const checks = Array.isArray(diag.acceptance_manual_checks) ? diag.acceptance_manual_checks : [];
      _state_settings.acceptanceDiagnostics = diag;
      if (!checks.length) {
        $list.innerHTML = '<p class="empty">暂无验收证据。</p>';
        $st.className = 'status warn';
        $st.textContent = '诊断包未返回人工验收清单';
        return;
      }
      $list.innerHTML = checks.map(item => {
        const ready = !!item.ready_for_user_confirmation;
        const stateLabel = acceptanceStateLabel(item);
        const evidenceLabel = softwareEvidenceLabel(item.software_evidence_status);
        const summary = item.software_evidence_summary || evidenceLabel || '';
        const next = item.next_step || '';
        return `
          <article class="acceptance-check ${ready ? 'ready' : 'pending'}">
            <div class="acceptance-head">
              <span class="acceptance-id">${escapeHtml(item.id || '')}</span>
              <strong>${escapeHtml(item.title || '')}</strong>
              <span class="acceptance-state">${stateLabel}</span>
            </div>
            ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
            ${next ? `<p class="muted small">${escapeHtml(next)}</p>` : ''}
          </article>`;
      }).join('');
      const readyCount = checks.filter(item => item.ready_for_user_confirmation).length;
      $st.className = readyCount === checks.length ? 'status ok' : 'status warn';
      $st.textContent = `已读取 ${checks.length} 项，${readyCount} 项证据已就绪，仍需逐项人工确认`;
    } catch (e) {
      $list.innerHTML = '<p class="empty">诊断状态读取失败。</p>';
      $st.className = 'status err';
      $st.textContent = '✗ ' + e.message;
    }
  }
  function acceptanceMarkdown(diag = _state_settings.acceptanceDiagnostics) {
    const checks = Array.isArray(diag?.acceptance_manual_checks) ? diag.acceptance_manual_checks : [];
    const lines = [
      '# wx-summary 人工验收记录',
      '',
      `导出时间：${fmtDateTime(new Date())}`,
      `服务地址：${diag?.service?.url || ''}`,
      `服务运行：${diag?.service?.uptime_hours ?? ''} 小时`,
      '',
      '## 人工确认项',
      '',
    ];
    for (const item of checks) {
      lines.push(`### ${item.id || ''} ${item.title || ''}`.trim());
      lines.push(`- 状态：${acceptanceStatusLabel(item.status)}${item.status ? ` (${item.status})` : ''}`);
      lines.push(`- 软件证据：${softwareEvidenceLabel(item.software_evidence_status)}${item.software_evidence_status ? ` (${item.software_evidence_status})` : ''}`);
      lines.push(`- 是否可人工确认：${item.ready_for_user_confirmation ? '是' : '否'}`);
      if (item.software_evidence_summary) lines.push(`- 证据摘要：${item.software_evidence_summary}`);
      if (item.next_step) lines.push(`- 下一步：${item.next_step}`);
      lines.push('');
    }
    lines.push('## 本机动作证据');
    lines.push('');
    const copy = diag?.local_action_evidence?.last_clipboard_copy;
    const reveal = diag?.local_action_evidence?.last_reveal_request;
    lines.push(`- 最近复制：${copy?.relative_path || '无'}${copy?.clipboard ? ` (${imageSizeLabel(copy.clipboard)})` : ''}`);
    lines.push(`- 最近打开文件夹：${reveal?.relative_path || '无'}${reveal?.explorer_selection ? ` (Explorer matched=${reveal.explorer_selection.matched})` : ''}`);
    return lines.join('\n');
  }
  function exportAcceptanceMarkdown() {
    const $st = document.getElementById('s-acceptance-status');
    const markdown = acceptanceMarkdown();
    if (!markdown.includes('### ')) {
      $st.className = 'status warn';
      $st.textContent = '请先刷新验收证据';
      return;
    }
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wx-summary-acceptance-${Date.now()}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $st.className = 'status ok';
    $st.textContent = '✓ 已导出验收记录 MD';
  }
  const refreshAcceptanceButton = document.getElementById('s-refresh-acceptance');
  const exportAcceptanceButton = document.getElementById('s-export-acceptance-md');
  refreshAcceptanceButton.addEventListener('click', () => withBusyButtons([refreshAcceptanceButton, exportAcceptanceButton], refreshAcceptanceChecks));
  exportAcceptanceButton.addEventListener('click', () => withBusyButtons(exportAcceptanceButton, exportAcceptanceMarkdown));
  refreshAcceptanceButton.disabled = false;
  exportAcceptanceButton.disabled = false;
  document.getElementById('s-acceptance-status').textContent = '未读取';

  // 关于
  paintSettingsStateMeta();
}

function formatCapabilityStatus(item = {}) {
  const name = item.name === 'responses_web_search' ? 'Responses 联网查链接'
    : item.name === 'responses' ? 'Responses'
      : item.name === 'chat' ? 'Chat'
        : item.name === 'messages' ? 'Messages'
          : (item.name || '能力');
  if (item.ok) return `${name} OK (${item.latency_ms}ms)`;
  return `${name} 失败：${item.error || '未知错误'}`;
}

function formatModelConnectivityResult(result = {}) {
  const role = result.role === 'long_context' ? '长上下文模型' : '主模型';
  const model = result.model ? ` ${result.model}` : '';
  const okItems = (result.capabilities || []).filter(item => item.ok).map(formatCapabilityStatus);
  const badItems = (result.capabilities || []).filter(item => !item.ok).map(formatCapabilityStatus);
  const mark = result.ok ? (badItems.length ? '部分通过' : 'OK') : '失败';
  return `${role}${model} ${mark}：${[...okItems, ...badItems].join('，') || '无能力结果'}`;
}

// ---------- 首次启动向导 ----------
async function renderSetup() {
  $app.appendChild(tplOf('tpl-setup'));
  const state = await api('/api/state');
  let step = 1;
  const $body = document.getElementById('setup-body');
  const $title = document.getElementById('setup-title');
  const $step = document.getElementById('setup-step');
  const $back = document.getElementById('setup-back');
  const $next = document.getElementById('setup-next');
  const wizardData = { llm: {}, wechat: {}, whitelist: new Map() };
  let setupPaintSeq = 0;
  function normalizeSetupBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }
  function setupLlmIdentityFromDom() {
    return {
      provider: document.querySelector('input[name="w-provider"]:checked')?.value || 'openai',
      base_url: normalizeSetupBaseUrl(document.getElementById('w-base')?.value || ''),
      api_key: document.getElementById('w-key')?.value.trim() || '',
    };
  }
  function sameSetupLlmIdentity(a, b) {
    return JSON.stringify(a || {}) === JSON.stringify(b || {});
  }

  function paint() {
    const paintSeq = ++setupPaintSeq;
    $step.textContent = step;
    $back.disabled = step === 1;
    $next.disabled = false;
    $next.textContent = step === 4 ? '完成' : '下一步';
    if (step === 1) {
      $title.textContent = '欢迎使用 wx-summary';
      const secretWarningText = state.platform === 'win32'
        ? '当前 Windows 用户不能解开已有的 DPAPI 密钥文件。请重新填写 AI Key 和可选微信手动密钥；旧密文不会展示，也不会上传。'
        : '当前系统用户不能解开已有的本机密钥文件。请重新填写 AI Key 和可选微信手动密钥；旧密文不会展示，也不会上传。';
      const secretBackupPath = state.secrets_invalid_info?.backup_relative_path || state.secrets_invalid_info?.backup_path || '';
      const secretWarning = state.secrets_invalid
        ? `<div class="notice-card setup-secret-warning">
            <strong>检测到本机密钥无法解密</strong>
            <span>${secretWarningText}${secretBackupPath ? ` 原密文已备份到 ${escapeHtml(secretBackupPath)}。` : ''}</span>
          </div>`
        : '';
      const settingsWarning = state.settings_invalid
        ? `<div class="notice-card setup-secret-warning">
            <strong>设置文件已损坏，已用默认配置继续启动</strong>
            <span>原文件已备份到 ${escapeHtml(state.settings_invalid.backup_relative_path || state.settings_invalid.backup_path || 'data/settings.invalid.json')}；重新完成配置后会写入新的 settings.json。</span>
          </div>`
        : '';
      $body.innerHTML = `
        ${settingsWarning}
        ${secretWarning}
        <p>本工具帮你把忙不过来的微信群消息一键总结成长图。</p>
        <ul>
          <li>✓ 本机只读采集与解密，摘要时只发送给你配置的 AI 端点</li>
          <li>✓ 密钥提取走只读路径，不 hook、不注入、不发消息</li>
          <li>✓ AI 接到你自己的 OpenAI 兼容端点</li>
          <li>✗ 不会自动加好友、不会发朋友圈、不会模拟登录</li>
        </ul>
        <p class="muted small">点「下一步」开始 4 步配置。</p>`;
    } else if (step === 2) {
      $title.textContent = '配置 AI 接入';
      const models = wizardData.llm.available_models || [];
      const customModel = !!wizardData.llm.custom_model;
      const customLongModel = !!wizardData.llm.custom_long_context_model;
      const modelOptions = models.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}</option>`).join('') || '<option value="">请先获取模型，或勾选自定义</option>';
      $body.innerHTML = `
        <div class="form-row"><label>Provider</label>
          <div class="radio-row">
            <label><input type="radio" name="w-provider" value="openai" ${(wizardData.llm.provider || 'openai') === 'openai' ? 'checked' : ''} /> OpenAI</label>
            <label><input type="radio" name="w-provider" value="anthropic" ${wizardData.llm.provider === 'anthropic' ? 'checked' : ''} /> Anthropic</label>
          </div>
        </div>
        <div class="form-row"><label>Base URL</label><input id="w-base" type="text" placeholder="https://your-endpoint/v1" value="${escapeHtml(wizardData.llm.base_url || '')}" /></div>
        <div class="form-row"><label>API Key</label><input id="w-key" type="password" placeholder="sk-..." value="${escapeHtml(wizardData.llm.api_key || '')}" /></div>
        <div class="form-row inline"><button class="btn" id="w-list">获取模型</button><span class="status" id="w-status"></span></div>
        <div class="form-row"><label>模型</label>
          <select id="w-model-select" class="${customModel ? 'hidden' : ''}">${modelOptions}</select>
          <label class="inline-check"><input id="w-model-custom" type="checkbox" ${customModel ? 'checked' : ''} /> 自定义</label>
          <input id="w-model" class="${customModel ? '' : 'hidden'}" type="text" placeholder="model-id" value="${escapeHtml(wizardData.llm.model || '')}" />
        </div>
        <div class="form-row"><label>长上下文模型</label>
          <select id="w-model-long-select" class="${customLongModel ? 'hidden' : ''}">${modelOptions}</select>
          <label class="inline-check"><input id="w-model-long-custom" type="checkbox" ${customLongModel ? 'checked' : ''} /> 自定义</label>
          <input id="w-model-long" class="${customLongModel ? '' : 'hidden'}" type="text" placeholder="默认同上方模型" value="${escapeHtml(wizardData.llm.long_context_model || '')}" />
        </div>`;
      if (!customModel && wizardData.llm.model) document.getElementById('w-model-select').value = wizardData.llm.model;
      if (!customLongModel && wizardData.llm.long_context_model) document.getElementById('w-model-long-select').value = wizardData.llm.long_context_model;
      const syncSetupCustomModel = which => {
        const isLong = which === 'long';
        const cb = document.getElementById(isLong ? 'w-model-long-custom' : 'w-model-custom');
        const select = document.getElementById(isLong ? 'w-model-long-select' : 'w-model-select');
        const input = document.getElementById(isLong ? 'w-model-long' : 'w-model');
        if (cb.checked && select.value) input.value = select.value;
        select.classList.toggle('hidden', cb.checked);
        input.classList.toggle('hidden', !cb.checked);
      };
      document.getElementById('w-model-custom')?.addEventListener('change', () => syncSetupCustomModel('model'));
      document.getElementById('w-model-long-custom')?.addEventListener('change', () => syncSetupCustomModel('long'));
      const markSetupModelsStale = () => {
        const $st = document.getElementById('w-status');
        if (wizardData.llm.available_models?.length && !sameSetupLlmIdentity(wizardData.llm.model_identity, setupLlmIdentityFromDom())) {
          wizardData.llm.available_models = [];
          document.getElementById('w-model-select').innerHTML = '<option value="">请重新获取模型，或勾选自定义</option>';
          document.getElementById('w-model-long-select').innerHTML = '<option value="">请重新获取模型，或勾选自定义</option>';
          if ($st) {
            $st.className = 'status warn';
            $st.textContent = '端点或密钥已变化，请重新获取模型列表。';
          }
        }
      };
      [
        ...document.querySelectorAll('input[name="w-provider"]'),
        document.getElementById('w-base'),
        document.getElementById('w-key'),
      ].forEach(input => {
        input?.addEventListener('input', markSetupModelsStale);
        input?.addEventListener('change', markSetupModelsStale);
      });
      const listButton = document.getElementById('w-list');
      listButton.addEventListener('click', () => withBusyButtons(listButton, async () => {
        const $st = document.getElementById('w-status');
        const requestIdentity = setupLlmIdentityFromDom();
        if (!requestIdentity.base_url) {
          $st.className = 'status err';
          $st.textContent = '✗ 请填写 Base URL';
          return;
        }
        if (!requestIdentity.api_key) {
          $st.className = 'status err';
          $st.textContent = '✗ 请填写 API Key';
          return;
        }
        $st.className = 'status'; $st.textContent = '获取中...';
        try {
          const r = await api('/api/list-models', {
            method: 'POST',
            body: { provider: requestIdentity.provider, base_url: requestIdentity.base_url, api_key: requestIdentity.api_key },
          });
          if (!sameSetupLlmIdentity(setupLlmIdentityFromDom(), requestIdentity)) {
            $st.className = 'status warn';
            $st.textContent = '端点或密钥已变化，旧模型列表结果已忽略。';
            return;
          }
          wizardData.llm.provider = requestIdentity.provider;
          wizardData.llm.base_url = requestIdentity.base_url;
          wizardData.llm.api_key = requestIdentity.api_key;
          wizardData.llm.available_models = r.models || [];
          wizardData.llm.model_identity = requestIdentity;
          wizardData.llm.model = wizardData.llm.available_models[0]?.id || '';
          wizardData.llm.long_context_model = wizardData.llm.model;
          wizardData.llm.custom_model = false;
          wizardData.llm.custom_long_context_model = false;
          $st.className = 'status ok'; $st.textContent = `✓ 获取到 ${wizardData.llm.available_models.length} 个模型`;
          paint();
        } catch (e) { $st.className = 'status err'; $st.textContent = '✗ ' + e.message; }
      }));
    } else if (step === 3) {
      $title.textContent = '检测微信';
      $body.innerHTML = `
        <p>检测本机微信进程并尝试提取数据库密钥...</p>
        <p>当前版本能识别 Weixin 主进程、数据根目录和 db_storage，并用只读权限扫描 key 候选。</p>
        <p>已能读取本机群列表、文本、引用、图片、文件、视频关键帧、语音/音频元信息；媒体解封失败时会保留时间、发送人和文件元信息，不假装看过或听过内容。</p>
        <p class="muted">${escapeHtml(state.wechat?.message || '检测中')}</p>
        <div class="form-row"><label>手动密钥（可选）</label><textarea id="w-manual-key" rows="3" spellcheck="false" autocomplete="off" placeholder="自动失败时填一条或多条 64/96 位 hex">${escapeHtml(wizardData.wechat.manual_key || '')}</textarea></div>
        <p class="muted small">留空表示继续使用自动扫描；填写后会先保存到本机加密密钥区，再进入群列表。</p>
        <span class="status" id="w-key-status"></span>`;
    } else if (step === 4) {
      $title.textContent = '选择群白名单';
      $next.disabled = true;
      $next.textContent = '读取群列表...';
      $body.innerHTML = '<p class="muted small">正在读取本机微信群列表...</p>';
      const setupAccountId = selectedAccountId();
      api(`/api/groups?account=${encodeURIComponent(setupAccountId)}`).then(groups => {
        if (step !== 4 || paintSeq !== setupPaintSeq) return;
        $next.disabled = false;
        $next.textContent = '完成';
        $body.innerHTML = `
          <p class="muted small">勾选你常看的群，加入白名单。也可以全部跳过。</p>
          <div class="setup-whitelist-tools">
            <input id="w-whitelist-search" type="text" placeholder="搜索群名 / ID" />
            <button class="btn" id="w-whitelist-all" type="button">全选当前</button>
            <button class="btn btn-ghost" id="w-whitelist-clear" type="button">清空</button>
          </div>
          <div class="whitelist-area setup-whitelist-list" id="w-whitelist"></div>
          <p class="muted small" id="w-whitelist-count"></p>`;
        const paintWhitelist = (filter = '') => {
          const f = filter.trim().toLowerCase();
          const visible = groups.filter(g => {
            if (!f) return true;
            return [g.name, g.id, g.pinyin, g.pinyin_initial].some(v => String(v || '').toLowerCase().includes(f));
          });
          const list = document.getElementById('w-whitelist');
          list.innerHTML = visible.length
            ? visible.map(g => {
              const ref = groupRefForPayload(g, setupAccountId);
              const key = groupRefKey(ref);
              return `<label class="chip"><input type="checkbox" value="${escapeHtml(key)}" ${wizardData.whitelist.has(key) ? 'checked' : ''} /> ${escapeHtml(g.name)}</label>`;
            }).join('')
            : '<span class="muted small">没有匹配的群。</span>';
          list.querySelectorAll('input[type="checkbox"]').forEach(input => {
            input.addEventListener('change', () => {
              const group = groups.find(g => groupRefKey(groupRefForPayload(g, setupAccountId)) === input.value);
              if (input.checked && group) wizardData.whitelist.set(input.value, groupRefForPayload(group, setupAccountId));
              else wizardData.whitelist.delete(input.value);
              document.getElementById('w-whitelist-count').textContent = `已选 ${wizardData.whitelist.size} 个群`;
            });
          });
          document.getElementById('w-whitelist-count').textContent = `已选 ${wizardData.whitelist.size} 个群；当前显示 ${visible.length} 个`;
        };
        const search = document.getElementById('w-whitelist-search');
        search.addEventListener('input', () => paintWhitelist(search.value));
        document.getElementById('w-whitelist-all').addEventListener('click', () => {
          const f = search.value.trim().toLowerCase();
          groups
            .filter(g => !f || [g.name, g.id, g.pinyin, g.pinyin_initial].some(v => String(v || '').toLowerCase().includes(f)))
            .forEach(g => {
              const ref = groupRefForPayload(g, setupAccountId);
              wizardData.whitelist.set(groupRefKey(ref), ref);
            });
          paintWhitelist(search.value);
        });
        document.getElementById('w-whitelist-clear').addEventListener('click', () => {
          wizardData.whitelist.clear();
          paintWhitelist(search.value);
        });
        paintWhitelist();
      }).catch(e => {
        if (step !== 4 || paintSeq !== setupPaintSeq) return;
        $next.disabled = false;
        $next.textContent = '跳过白名单并完成';
        $body.innerHTML = `<p class="status err">读取本机微信群列表失败：${escapeHtml(e.message || '未知错误')}</p><p class="muted small">可以返回重试，也可以跳过白名单先完成配置。</p>`;
      });
    }
  }
  paint();

  $back.addEventListener('click', () => { if (step > 1) { step--; paint(); } });
  $next.addEventListener('click', async () => {
    if (step === 2) {
      const provider = document.querySelector('input[name="w-provider"]:checked')?.value || 'openai';
      wizardData.llm.base_url = document.getElementById('w-base').value;
      wizardData.llm.api_key = document.getElementById('w-key').value;
      wizardData.llm.provider = provider;
      wizardData.llm.custom_model = !!document.getElementById('w-model-custom')?.checked;
      wizardData.llm.custom_long_context_model = !!document.getElementById('w-model-long-custom')?.checked;
      const listedModel = document.getElementById('w-model-select')?.value || '';
      const listedLongModel = document.getElementById('w-model-long-select')?.value || '';
      wizardData.llm.model = wizardData.llm.custom_model
        ? document.getElementById('w-model').value.trim()
        : listedModel;
      wizardData.llm.long_context_model = wizardData.llm.custom_long_context_model
        ? document.getElementById('w-model-long').value.trim()
        : (listedLongModel || wizardData.llm.model);
      const currentIdentity = setupLlmIdentityFromDom();
      if (!wizardData.llm.base_url || !wizardData.llm.api_key) {
        const $st = document.getElementById('w-status');
        if ($st) {
          $st.className = 'status err';
          $st.textContent = '✗ 请填写 Base URL 和 API Key';
        }
        return;
      }
      if (!wizardData.llm.model) {
        const $st = document.getElementById('w-status');
        if ($st) {
          $st.className = 'status err';
          $st.textContent = wizardData.llm.custom_model ? '✗ 请填写自定义模型' : '✗ 请先点击「获取模型」并选择模型，或勾选自定义';
        }
        return;
      }
      if (wizardData.llm.custom_long_context_model && !wizardData.llm.long_context_model) {
        const $st = document.getElementById('w-status');
        if ($st) {
          $st.className = 'status err';
          $st.textContent = '✗ 请填写自定义长上下文模型，或关闭自定义';
        }
        return;
      }
      const usesListedModel = !wizardData.llm.custom_model || (!wizardData.llm.custom_long_context_model && listedLongModel);
      if (usesListedModel && !wizardData.llm.available_models?.length) {
        const $st = document.getElementById('w-status');
        if ($st) {
          $st.className = 'status err';
          $st.textContent = '✗ 请先点击「获取模型」并选择模型，或勾选自定义';
        }
        return;
      }
      if (usesListedModel && !sameSetupLlmIdentity(wizardData.llm.model_identity, currentIdentity)) {
        const $st = document.getElementById('w-status');
        if ($st) {
          $st.className = 'status warn';
          $st.textContent = '端点或密钥已变化，请重新获取模型列表。';
        }
        return;
      }
    }
    if (step === 3) {
      const manualKey = document.getElementById('w-manual-key')?.value.trim() || '';
      const manualKeys = normalizeManualKeysText(manualKey);
      wizardData.wechat.manual_key = manualKeys.text;
      if (manualKey) {
        const $st = document.getElementById('w-key-status');
        if (manualKeys.invalid.length) {
          $st.className = 'status err';
          $st.textContent = '✗ 手动密钥每条必须是 64 或 96 位 hex';
          return;
        }
        $st.className = 'status';
        $st.textContent = '保存中...';
        try {
          await api('/api/settings', { method: 'PUT', body: { wechat: { manual_key: manualKeys.text } } });
          $st.className = 'status ok';
          $st.textContent = `✓ 已保存 ${manualKeys.keys.length} 条手动密钥`;
        } catch (e) {
          $st.className = 'status err';
          $st.textContent = '✗ ' + e.message;
          return;
        }
      }
    }
    if (step === 4) {
      const wl = [...wizardData.whitelist.values()];
      const { model_identity: _modelIdentity, ...llmPayload } = wizardData.llm;
      const payload = { llm: llmPayload, groups: { whitelist: wl } };
      if (wizardData.wechat.manual_key) payload.wechat = { manual_key: wizardData.wechat.manual_key };
      $next.disabled = true;
      const oldText = $next.textContent;
      $next.textContent = '保存中...';
      let $st = document.getElementById('w-finish-status');
      if (!$st) {
        $st = document.createElement('span');
        $st.id = 'w-finish-status';
        $st.className = 'status';
        $next.insertAdjacentElement('beforebegin', $st);
      }
      $st.className = 'status';
      $st.textContent = '正在保存设置...';
      try {
        const r = await api('/api/settings', { method: 'PUT', body: payload });
        const warnings = Array.isArray(r.warnings) ? r.warnings : [];
        if (warnings.length) {
          $st.className = 'status warn';
          $st.textContent = '⚠ 已保存；' + warnings.map(w => w.message || w).join('；');
          await new Promise(resolve => setTimeout(resolve, 1200));
        }
        _appState = await api('/api/state?refresh=true').catch(() => _appState);
        await refreshTopbarAccounts();
        const alreadyDigest = location.hash === '#/digest';
        location.hash = '#/digest';
        if (alreadyDigest) await route();
      } catch (e) {
        $st.className = 'status err';
        $st.textContent = '✗ 保存失败：' + (e.message || '未知错误');
        $next.disabled = false;
        $next.textContent = oldText;
      }
      return;
    }
    step++;
    paint();
  });
}
