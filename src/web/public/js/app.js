// wx-summary UI 脚本
// 模块化：路由 + 4 个页面渲染 + Canvas 长图绘制 + API 调用封装

const TOKEN = window.__WX_TOKEN__;
const $app = document.getElementById('app');
let _appState = null;
let _keyboardShortcutsAttached = false;
let _routeSeq = 0;

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
function applySystemTheme() {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.body.classList.toggle('is-dark', isDark);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = isDark ? '🌙' : '☀';
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySystemTheme);
applySystemTheme();

document.getElementById('theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  if (cur === 'dark') {
    document.documentElement.dataset.theme = 'light';
    document.body.classList.remove('is-dark');
    document.getElementById('theme-toggle').textContent = '☀';
  } else {
    document.documentElement.dataset.theme = 'dark';
    document.body.classList.add('is-dark');
    document.getElementById('theme-toggle').textContent = '🌙';
  }
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
  const hash = location.hash.replace(/^#/, '') || '/digest';
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
  if (_state_digest.abortController) _state_digest.abortController.abort();
  _state_digest.selectedGroups.clear();
  _state_digest.lastDigest = null;
  _state_digest.lastSavedItem = null;
  route();
}

async function bootstrap() {
  // 拉账号列表填充顶部切换器
  try {
    const accounts = await api('/api/accounts');
    const sel = document.getElementById('account-switcher');
    sel.innerHTML = accounts.length
      ? accounts.map(a => `<option value="${escapeHtml(a.id || a.wxid)}">${escapeHtml(a.name)} (${escapeHtml(a.wxid)})</option>`).join('')
      : '<option value="">未检测到微信账号</option>';
    sel.disabled = !accounts.length;
    sel.addEventListener('change', handleAccountSwitch);
  } catch (e) {
    const sel = document.getElementById('account-switcher');
    if (sel) {
      sel.innerHTML = `<option value="">账号读取失败：${escapeHtml(e.message || '未知错误')}</option>`;
      sel.disabled = true;
    }
  }

  // 检查是否需要走向导
  let state;
  try {
    state = await api('/api/state');
  } catch (e) {
    renderBootstrapError(e);
    return;
  }
  _appState = state;
  if (state.need_setup && !location.hash.includes('/setup')) {
    location.hash = '#/setup';
    return;
  }
  if (!location.hash) location.hash = '#/digest';
  await route();
}
bootstrap();

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

function quickRangeToDates(key) {
  const now = new Date();
  const since = new Date(now);
  if (key === 'today') since.setHours(0, 0, 0, 0);
  else if (key === 'yesterday') {
    since.setDate(since.getDate() - 1);
    since.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);
  } else if (key === 'last4h') since.setHours(now.getHours() - 4);
  else if (key === 'last12h') since.setHours(now.getHours() - 12);
  else if (key === 'last1d') since.setDate(now.getDate() - 1);
  else if (key === 'thisweek') {
    const day = now.getDay() || 7;
    since.setDate(now.getDate() - (day - 1));
    since.setHours(0, 0, 0, 0);
  }
  return { since: fmtDateTime(since), until: fmtDateTime(now) };
}

function fmtDateTime(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
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
  document.addEventListener('click', e => {
    if (popover.classList.contains('hidden')) return;
    if (document.getElementById('range-picker')?.contains(e.target)) return;
    popover.classList.add('hidden');
    startButton.classList.remove('active');
    endButton.classList.remove('active');
  });
}

function ensureCustomRangeDefaults() {
  if (_state_digest.customSince && _state_digest.customUntil) return;
  const r = quickRangeToDates('last1d');
  _state_digest.customSince = _state_digest.customSince || r.since;
  _state_digest.customUntil = _state_digest.customUntil || r.until;
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
    return rel !== '.'
      && rel !== ''
      && !rel.split('/').includes('..')
      && rel !== 'outputs/.tmp'
      && !rel.startsWith('outputs/.tmp/');
  }
  const root = normalizePathForUi(projectRoot).toLowerCase();
  const full = normalizePathForUi(raw).toLowerCase();
  const tmp = root ? `${root}/outputs/.tmp` : '';
  return !!root && full !== root && full.startsWith(root + '/') && full !== tmp && !full.startsWith(`${tmp}/`);
}

function updateCustomRangeDate(dateText) {
  const current = parseLocalDateTime(_state_digest.customRangeSide === 'since' ? _state_digest.customSince : _state_digest.customUntil) || new Date();
  const [y, m, d] = String(dateText).split('-').map(Number);
  const next = new Date(y, m - 1, d, current.getHours(), current.getMinutes(), 0, 0);
  commitCustomRangeSide(next);
}

function updateCustomRangeTime() {
  const current = parseLocalDateTime(_state_digest.customRangeSide === 'since' ? _state_digest.customSince : _state_digest.customUntil) || new Date();
  current.setHours(Number(document.getElementById('range-hour').value || 0));
  current.setMinutes(Number(document.getElementById('range-minute').value || 0));
  commitCustomRangeSide(current);
}

function commitCustomRangeSide(date) {
  if (_state_digest.customRangeSide === 'since') _state_digest.customSince = fmtDateTime(date);
  else _state_digest.customUntil = fmtDateTime(date);
  const sinceDate = parseLocalDateTime(_state_digest.customSince);
  const untilDate = parseLocalDateTime(_state_digest.customUntil);
  if (sinceDate && untilDate && sinceDate > untilDate) {
    if (_state_digest.customRangeSide === 'since') _state_digest.customUntil = fmtDateTime(new Date(sinceDate.getTime() + 60 * 60 * 1000));
    else _state_digest.customSince = fmtDateTime(new Date(untilDate.getTime() - 60 * 60 * 1000));
  }
  paintCustomRangeFields();
  paintRangeCalendar();
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
  generating: false,
  abortController: null,
};

let _state_settings = {
  acceptanceDiagnostics: null,
};

const DIGEST_ACCENTS = [
  { id: 'green', label: '绿色', light: '#10B981', dark: '#34D399' },
  { id: 'blue', label: '蓝色', light: '#2563EB', dark: '#60A5FA' },
  { id: 'amber', label: '琥珀色', light: '#D97706', dark: '#FBBF24' },
  { id: 'rose', label: '玫红色', light: '#E11D48', dark: '#FB7185' },
];

async function renderDigest() {
  $app.appendChild(tplOf('tpl-digest'));
  const state = _appState || await api('/api/state');
  const digestSettings = await api('/api/settings').catch(() => ({}));
  applyDigestRenderDefaults(digestSettings.render || {});
  const whitelistNames = new Set(digestSettings.groups?.whitelist || []);
  const recentNames = Array.isArray(digestSettings.groups?.recent) ? digestSettings.groups.recent : [];
  const recentRank = new Map(recentNames.map((name, index) => [String(name || ''), index]));
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
      _appState = await api('/api/state');
      location.reload();
    });
    document.getElementById('wechat-manual-key').addEventListener('click', () => { location.hash = '#/settings'; });
  }

  // 群列表
  let groups = [];
  try {
    groups = await api(`/api/groups?account=${encodeURIComponent(selectedAccountId())}`);
    groups = groups
      .map(group => {
        const rank = Math.min(
          recentRank.has(group.name) ? recentRank.get(group.name) : Number.POSITIVE_INFINITY,
          recentRank.has(group.id) ? recentRank.get(group.id) : Number.POSITIVE_INFINITY,
        );
        const starred = Number.isFinite(rank);
        const nonWhitelist = whitelistNames.size > 0 && !whitelistNames.has(group.name) && !whitelistNames.has(group.id);
        return { ...group, starred, non_whitelist: nonWhitelist, recent_rank: starred ? rank : 9999 };
      })
      .sort((a, b) => (a.recent_rank - b.recent_rank) || ((b.last_msg_at || 0) - (a.last_msg_at || 0)));
  } catch (e) {
    notice.classList.remove('hidden');
    notice.innerHTML = `
      <strong>读取群列表失败</strong>
      <span>${escapeHtml(e.message || '无法读取本机微信群列表。')} 如果自动密钥提取失败，可以到设置页填写一条或多条 64/96 位手动密钥。</span>
      <button class="link-btn" id="wechat-retry">重试检测</button>
      <button class="link-btn" id="wechat-manual-key">填写手动密钥</button>`;
    document.getElementById('wechat-retry').addEventListener('click', async () => {
      _appState = await api('/api/state');
      location.reload();
    });
    document.getElementById('wechat-manual-key').addEventListener('click', () => { location.hash = '#/settings'; });
  }
  const $list = document.getElementById('group-list');
  function paint(filter = '') {
    const f = filter.trim().toLowerCase();
    $list.innerHTML = groups
      .filter(g => {
        if (!f) return true;
        return [g.name, g.pinyin, g.pinyin_initial, g.id].some(v => String(v || '').toLowerCase().includes(f));
      })
      .map(g => `
        <li data-id="${g.id}" class="${[
          _state_digest.selectedGroups.has(g.id) ? 'selected' : '',
          g.non_whitelist ? 'non-whitelist' : '',
        ].filter(Boolean).join(' ')}">
          <input type="checkbox" ${_state_digest.selectedGroups.has(g.id) ? 'checked' : ''} />
          ${g.starred ? '<span class="star">★</span>' : ''}
          <span class="gname">${escapeHtml(g.name)}</span>
          <span class="meta">${fmtTimeAgo(g.last_msg_at)}</span>
        </li>`).join('');
    document.querySelectorAll('#group-list li').forEach(li => {
      li.addEventListener('click', e => {
        const cb = li.querySelector('input');
        if (e.target.tagName !== 'INPUT') cb.checked = !cb.checked;
        const id = li.dataset.id;
        if (cb.checked) _state_digest.selectedGroups.add(id);
        else _state_digest.selectedGroups.delete(id);
        li.classList.toggle('selected', cb.checked);
        updateSelectedCount();
      });
    });
    updateSelectedCount();
  }
  function updateSelectedCount() {
    document.getElementById('selected-count').textContent = `已选 ${_state_digest.selectedGroups.size} 个`;
    const disabled = _state_digest.selectedGroups.size === 0 || _state_digest.generating;
    document.getElementById('btn-generate').disabled = disabled;
    document.getElementById('btn-preview-text').disabled = disabled;
  }
  paint();
  document.getElementById('group-search').addEventListener('input', e => paint(e.target.value));
  const whitelistButton = document.getElementById('select-whitelist');
  whitelistButton.disabled = whitelistNames.size === 0;
  whitelistButton.title = whitelistNames.size ? '选择设置页白名单里的群' : '设置页尚未配置白名单';
  document.getElementById('select-whitelist').addEventListener('click', () => {
    groups.filter(g => whitelistNames.has(g.name)).forEach(g => _state_digest.selectedGroups.add(g.id));
    paint(document.getElementById('group-search').value);
  });

  // 时间范围
  const $qr = document.getElementById('quick-range');
  const $cr = document.getElementById('custom-range');
  setupCustomRangePicker();
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
  });

  // chip 输入
  document.querySelectorAll('.chip-input').forEach(box => {
    const name = box.dataset.name;
    const inp = box.querySelector('input');
    function addChip(v) {
      v = v.trim();
      if (!v) return;
      if (_state_digest.filters[name].includes(v)) return;
      _state_digest.filters[name].push(v);
      const span = document.createElement('span');
      span.className = 'chip';
      span.innerHTML = `${v} <span class="x">×</span>`;
      span.querySelector('.x').addEventListener('click', () => {
        _state_digest.filters[name] = _state_digest.filters[name].filter(x => x !== v);
        span.remove();
      });
      box.insertBefore(span, inp);
    }
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
          _state_digest.filters[name] = _state_digest.filters[name].filter(x => x !== v);
          last[last.length - 1].remove();
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

  // 生成按钮
  bindDigestRenderOptions();
  document.getElementById('btn-generate').addEventListener('click', () => generateDigest({ previewText: false }));
  document.getElementById('btn-preview-text').addEventListener('click', () => generateDigest({ previewText: true }));
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
        if (!_state_digest.lastSavedItem?.digest_id) return null;
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
  document.getElementById('btn-copy').addEventListener('click', copyCanvas);
  document.getElementById('digest-canvas').addEventListener('click', () => {
    const canvas = document.getElementById('digest-canvas');
    if (!canvas.width || !canvas.height) return;
    showImageZoomModal({
      title: _state_digest.lastDigest?.group || '长图预览',
      src: canvas.toDataURL('image/png'),
    });
  });
  document.getElementById('btn-reveal').addEventListener('click', async () => {
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
  });

  ensureKeyboardShortcuts();
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
  panel.querySelector('[data-save]').addEventListener('click', async () => {
    panelStatus.className = 'status';
    panelStatus.textContent = '保存中...';
    try {
      const result = typeof onSave === 'function' ? await onSave({ ...selection }) : null;
      panelStatus.className = 'status ok';
      panelStatus.textContent = result ? '✓ 已重新渲染' : '✓ 已更新预览';
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
    _state_digest.abortController.abort();
  }
}

function commitPendingChipInputs() {
  document.querySelectorAll('.chip-input').forEach(box => {
    if (typeof box._commitPendingChip === 'function') box._commitPendingChip();
  });
}

// ---------- 生成（SSE） ----------
async function generateDigest({ previewText = false } = {}) {
  commitPendingChipInputs();
  if (_state_digest.selectedGroups.size === 0) return;
  if (_state_digest.generating) return;
  _state_digest.generating = true;
  const generateButton = document.getElementById('btn-generate');
  const previewButton = document.getElementById('btn-preview-text');
  if (generateButton) generateButton.disabled = true;
  if (previewButton) previewButton.disabled = true;
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
  $progress.classList.remove('hidden');
  $stages.innerHTML = `<li class="running">⟳ 准备生成 · 读取群列表</li>`;
  $fill.style.width = '2%';
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
  _state_digest.lastSavedItem = null;
  _state_digest.lastTextMarkdown = '';
  _state_digest.lastTextTitle = '';
  scrollDigestWorkIntoView($progress);
  const selectedIds = [..._state_digest.selectedGroups];
  let groups;
  try {
    groups = await api(`/api/groups?account=${encodeURIComponent(selectedAccountId())}`);
  } catch (e) {
    _state_digest.generating = false;
    if (generateButton) generateButton.disabled = false;
    if (previewButton) previewButton.disabled = false;
    if ($progress && $stages && $fill) {
      $progress.classList.remove('hidden');
      $fill.style.width = '0%';
      $stages.innerHTML = `<li class="error">✗ 读取群列表失败：${escapeHtml(e.message || '未知错误')}</li>`;
      showProgressLogPrompt(e.message || '读取群列表失败');
      scrollDigestWorkIntoView($progress);
    }
    return;
  }
  const targets = selectedIds.map(id => {
    const group = groups.find(g => g.id === id) || {};
    return { id, name: group.name || id || '未命名会话' };
  });
  rememberRecentGroups(targets, groups).catch(() => {});

  let since, until;
  if (_state_digest.rangeKey === 'custom') {
    ensureCustomRangeDefaults();
    since = _state_digest.customSince;
    until = _state_digest.customUntil || 'now';
  } else {
    const r = quickRangeToDates(_state_digest.rangeKey);
    since = r.since;
    until = r.until;
  }

  $progress.classList.remove('hidden');
  $stages.innerHTML = '';
  $fill.style.width = '0%';
  $logTools.classList.add('hidden');
  $log.classList.add('hidden');
  $log.textContent = '';
  $logStatus.textContent = '';

  const stageMap = {};
  const stagesOrder = previewText ? ['fetching', 'summarizing', 'rendering'] : ['fetching', 'summarizing', 'rendering', 'saving'];
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
    const icon = s.status === 'done' ? '✓' : s.status === 'running' ? '⟳' : s.status === 'error' ? '✗' : '·';
    li.textContent = `${icon} ${s.label}${s.detail ? ' (' + s.detail + ')' : ''}`;
    const doneStageCount = Object.values(stageMap).filter(item => stagesOrder.includes(item.dataset.stageName) && item.classList.contains('done')).length;
    const totalSteps = Math.max(1, targets.length * stagesOrder.length);
    $fill.style.width = Math.min(100, (doneStageCount / totalSteps * 100)) + '%';
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
    const controller = new AbortController();
    _state_digest.abortController = controller;
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
          since,
          until,
          previewText,
          signal: controller.signal,
          onStage: stage => upsertStage({
            ...groupStage(i, stage),
          }),
        });
        digests[i] = digest;
        _state_digest.lastDigest = digest;
        if (previewText) {
          renderTextPreviews(digests.filter(Boolean));
        } else {
          await enqueueRender(async () => {
            document.getElementById('preview-card').classList.remove('hidden');
            drawDigestCanvas(digest);
            upsertStage(groupStage(i, { name: 'saving', label: '保存长图', status: 'running' }));
            try {
              const saved = await saveRenderedCanvas(digest);
              _state_digest.lastSavedItem = saved.item;
              digest.file_path = saved.item.file_path;
              document.getElementById('btn-reveal').disabled = false;
              document.getElementById('btn-reveal').title = '在文件夹中显示最后一张';
              upsertStage(groupStage(i, { name: 'saving', label: '保存长图', status: 'done', detail: saved.item.relative_path }));
              scrollDigestWorkIntoView(document.getElementById('preview-card'));
            } catch (e) {
              failures.push({ group: target.name, error: e.message });
              upsertStage(groupStage(i, { name: 'saving', label: `保存失败：${e.message}`, status: 'error' }));
              showProgressLogPrompt(e.message);
            }
          });
        }
      } catch (e) {
        const aborted = e?.name === 'AbortError';
        failures.push({ group: target.name, error: aborted ? '已取消' : e.message });
        upsertStage(groupStage(i, { name: 'error', label: aborted ? '已取消' : `失败：${e.message}`, status: aborted ? 'done' : 'error' }));
        if (!aborted) showProgressLogPrompt(e.message);
      }
    }, controller.signal);
    await renderQueue;

    const doneDigests = digests.filter(Boolean);
    if (failures.length && doneDigests.length) {
      upsertStage({ key: 'batch', name: 'batch', stageName: 'batch', label: `已完成 ${doneDigests.length} 个，失败 ${failures.length} 个`, status: 'error', detail: failures.map(f => f.group).join('、') });
      $fill.style.width = '100%';
      showProgressLogPrompt(failures.map(f => `${f.group}: ${f.error}`).join('；'));
    } else if (failures.length) {
      upsertStage({ key: 'batch', name: 'batch', stageName: 'batch', label: `全部失败 ${failures.length} 个群`, status: 'error', detail: failures.map(f => f.group).join('、') });
      $fill.style.width = '100%';
      if (!failures.every(f => f.error === '已取消')) showProgressLogPrompt(failures.map(f => `${f.group}: ${f.error}`).join('；'));
    } else if (doneDigests.length === targets.length) {
      upsertStage({ key: 'batch', name: 'batch', stageName: 'batch', label: `已完成 ${doneDigests.length} 个群`, status: 'done' });
      $fill.style.width = '100%';
    }
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    upsertStage({ name: 'error', label: aborted ? '已取消' : '失败：' + e.message, status: aborted ? 'done' : 'error' });
    if (!aborted) showProgressLogPrompt(e.message);
  } finally {
    _state_digest.abortController = null;
    _state_digest.generating = false;
    const finalGenerateButton = document.getElementById('btn-generate');
    const finalPreviewButton = document.getElementById('btn-preview-text');
    if (finalGenerateButton) finalGenerateButton.disabled = _state_digest.selectedGroups.size === 0;
    if (finalPreviewButton) finalPreviewButton.disabled = _state_digest.selectedGroups.size === 0;
  }
}

function digestPrepareConcurrency(total) {
  const cores = Number(window.navigator?.hardwareConcurrency || 4);
  const estimated = cores >= 12 ? 4 : cores >= 8 ? 3 : cores >= 4 ? 2 : 1;
  return Math.max(1, Math.min(Number(total || 1), estimated));
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
  if (!element) return;
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
  if (!tools || !status) return;
  tools.classList.remove('hidden');
  status.className = 'status err';
  status.textContent = summary ? `错误摘要：${summary}` : '生成失败';
}

async function toggleProgressLog() {
  const log = document.getElementById('progress-log');
  const status = document.getElementById('progress-log-status');
  if (!log || !status) return;
  if (!log.classList.contains('hidden')) {
    log.classList.add('hidden');
    return;
  }
  status.className = 'status';
  status.textContent = '正在读取日志...';
  try {
    const diag = await api('/api/diagnostics');
    const lines = Array.isArray(diag.log_tail) ? diag.log_tail.slice(-80) : [];
    log.textContent = lines.length ? lines.join('\n') : '暂无可显示的运行日志。';
    log.classList.remove('hidden');
    status.className = 'status';
    status.textContent = '已显示最近日志';
  } catch (e) {
    status.className = 'status err';
    status.textContent = `日志读取失败：${e.message || '未知错误'}`;
  }
}

async function rememberRecentGroups(targets, allGroups) {
  const current = await api('/api/settings').catch(() => ({}));
  const previous = Array.isArray(current.groups?.recent) ? current.groups.recent : [];
  const selectedNames = targets
    .map(target => {
      const group = allGroups.find(g => g.id === target.id || g.name === target.name);
      return group?.name || target.name || target.id || '';
    })
    .map(name => String(name || '').trim())
    .filter(Boolean);
  const nextRecentGroups = [...new Set([...selectedNames, ...previous])].slice(0, 5);
  if (!nextRecentGroups.length || JSON.stringify(nextRecentGroups) === JSON.stringify(previous.slice(0, 5))) return;
  await api('/api/settings', { method: 'PUT', body: { groups: { recent: nextRecentGroups } } });
}

async function runSingleDigestRequest({ target, since, until, previewText, signal, onStage }) {
  let digest = null;
  let modelError = null;
  const resp = await fetch('/api/digest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WX-Token': TOKEN },
    signal,
    body: JSON.stringify({
      group_id: target.id,
      group_name: target.name,
      account_id: selectedAccountId(),
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
      else if (event === 'error') modelError = obj.message || '未知错误';
    }
  }
  if (modelError) throw new Error(modelError);
  if (!digest) throw new Error('未收到摘要结果');
  return digest;
}

// ---------- Canvas 长图渲染（前端预览，1080×N） ----------
function drawDigestCanvas(d) {
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
  const canvas = document.getElementById('digest-canvas');
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

    // headline
    y = drawCard(ctx, y, COLORS, dryRun, c => {
      c.fillStyle = COLORS.primary;
      c.font = font(600, 14);
      c.fillText('一句话总览', padding + cardInset, y + s(10));
      const lines = wrapText(c, d.headline, W - padding * 2 - cardInset * 2, font(600, 26));
      c.fillStyle = COLORS.text;
      c.font = font(600, 26);
      let yy = y + s(35);
      for (const ln of lines) { c.fillText(ln, padding + cardInset, yy); yy += s(42); }
      return yy + s(10) - y;
    });
    y += s(6);

    // todos
    if (d.todos?.length) {
      y = drawCard(ctx, y, COLORS, dryRun, c => {
        c.fillStyle = COLORS.primary;
        c.font = font(600, 20);
        c.fillText(`✓ 待办（${d.todos.length}）`, padding + cardInset, y + s(10));
        let yy = y + s(44);
        for (const t of d.todos) {
          c.fillStyle = COLORS.text;
          c.font = font(500, 17);
          c.fillText(renderSafeText(`• ${t.item}`), padding + cardInset, yy); yy += s(34);
          const meta = [t.owner, t.deadline].filter(Boolean).join(' · ');
          if (meta) {
            c.fillStyle = COLORS.meta;
            c.font = font(400, 14);
            c.fillText(renderSafeText(`  ${meta}`), padding + bodyIndent, yy); yy += s(24);
          }
          yy += s(10);
        }
        return yy - y + s(6);
      });
      y += s(6);
    }

    // topics
    if (d.topics?.length) {
      y = drawCard(ctx, y, COLORS, dryRun, c => {
        c.fillStyle = COLORS.primary;
        c.font = font(600, 20);
        c.fillText(`议题（${d.topics.length}）`, padding + cardInset, y + s(10));
        let yy = y + s(50);
        const topicTitleLineHeight = s(34);
        const topicTitleGap = s(10);
        const topicNoParticipantGap = s(12);
        const participantLineHeight = s(24);
        const participantSummaryGap = s(16);
        const summaryLineHeight = s(31);
        const topicAfterSummaryGap = s(14);
        const topicSeparatorGap = s(18);
        for (let i = 0; i < d.topics.length; i++) {
          const t = d.topics[i];
          c.fillStyle = COLORS.text;
          c.font = font(600, 20);
          const titleLines = wrapText(c, `${i + 1}. ${t.title}${t.need_followup ? '  🔥' : ''}`, W - padding * 2 - cardInset * 2, font(600, 20));
          for (const ln of titleLines) { c.fillText(ln, padding + cardInset, yy); yy += topicTitleLineHeight; }
          yy += t.participants?.length ? topicTitleGap : topicNoParticipantGap;
          if (t.participants?.length) {
            c.fillStyle = COLORS.meta;
            c.font = font(500, 14);
            const participantLines = wrapText(c, `参与：${t.participants.join('、')}`, W - padding * 2 - metaIndent - cardInset, font(500, 14));
            const participantTop = yy;
            const participantHeight = Math.max(s(18), participantLines.length * participantLineHeight - s(4));
            c.fillStyle = COLORS.primary;
            c.fillRect(padding + cardInset + 2, participantTop + s(4), 3, participantHeight);
            c.fillStyle = COLORS.meta;
            for (const ln of participantLines) { c.fillText(ln, padding + metaIndent, yy); yy += participantLineHeight; }
            yy += participantSummaryGap;
          }
          c.fillStyle = COLORS.text;
          c.font = font(400, 17);
          const lines = wrapText(c, t.summary, W - padding * 2 - cardInset * 2, font(400, 17));
          for (const ln of lines) { c.fillText(ln, padding + cardInset, yy); yy += summaryLineHeight; }
          if (i < d.topics.length - 1) {
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
    if (d.links?.length) {
      y = drawCard(ctx, y, COLORS, dryRun, c => {
        c.fillStyle = COLORS.primary;
        c.font = font(600, 20);
        c.fillText('🔗 重要链接', padding + cardInset, y + s(10));
        let yy = y + s(50);
        for (let i = 0; i < d.links.length; i++) {
          const l = d.links[i];
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
          const titleLines = wrapText(c, `• ${l.title || l.summary || l.url}`, W - padding * 2 - cardInset * 2, font(600, 17));
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
            const urlLines = wrapText(c, l.url, W - padding * 2 - bodyIndent - cardInset, font(400, 12));
            for (const ln of urlLines) { c.fillText(ln, padding + bodyIndent, yy); yy += s(22); }
          }
          const source = [l.from, l.time].filter(Boolean).join(' @ ');
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

    // 底部
    y += s(1);
    const footer = `生成于 ${new Date(d.created_at).toLocaleString()}    模型：${d.model}    本地读取 · AI 汇总`;
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
}

async function saveRenderedCanvas(digest) {
  const canvas = document.getElementById('digest-canvas');
  const png_data_url = canvas.toDataURL('image/png');
  return api('/api/save-render', { method: 'POST', body: { digest: { ...digest, __render: digestRenderPayload() }, png_data_url } });
}

function renderTextPreview(d) {
  renderTextPreviews([d]);
}

function renderTextPreviews(digests) {
  const card = document.getElementById('text-preview-card');
  const pre = document.getElementById('text-preview');
  card.classList.remove('hidden');
  const markdown = (digests || []).map(d => [
    `# ${d.group}`,
    '',
    `${d.since} ~ ${d.until} · ${d.message_count} 条消息 · ${d.model}`,
    d.source_label ? `${d.source_label}${d.truncated ? ` · 已从 ${d.scanned_message_count || d.message_count} 条中截取 ${d.input_message_count || d.message_count} 条` : ''}` : '',
    '',
    `## 一句话总览`,
    d.headline,
    '',
    d.todos?.length ? `## 待办\n${d.todos.map(t => `- ${t.owner || '未指定'}：${t.item}${t.deadline ? `（${t.deadline}）` : ''}`).join('\n')}` : '',
    d.topics?.length ? `## 议题\n${d.topics.map((t, i) => `${i + 1}. ${t.title}\n   参与：${(t.participants || []).join('、') || '未识别'}\n   ${t.summary}${t.need_followup ? '\n   需要跟进' : ''}`).join('\n\n')}` : '',
    d.links?.length ? `## 链接\n${d.links.map(l => `- ${l.title || l.summary || l.url}${l.summary ? `：${l.summary}` : ''}${l.url ? ` <${l.url}>` : ''}${l.from ? ` by ${l.from}` : ''}${l.time ? ` @ ${l.time}` : ''}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')).join('\n\n---\n\n');
  pre.textContent = markdown;
  _state_digest.lastTextMarkdown = markdown;
  _state_digest.lastTextTitle = (digests || []).map(d => d.group).filter(Boolean).join('_') || '文本预览';
  const exportButton = document.getElementById('btn-export-md');
  const status = document.getElementById('text-preview-status');
  if (exportButton) exportButton.disabled = !markdown.trim();
  if (status) {
    status.className = 'status';
    status.textContent = '';
  }
}

async function exportTextPreviewMarkdown() {
  const status = document.getElementById('text-preview-status');
  const button = document.getElementById('btn-export-md');
  if (!_state_digest.lastTextMarkdown?.trim()) return;
  if (status) {
    status.className = 'status';
    status.textContent = '正在导出...';
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
    if (button) button.disabled = false;
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
    btn.textContent = '✓ 已复制';
    if (status) {
      status.className = 'status ok';
      const size = imageSizeLabel(canvasSize);
      status.textContent = size ? `✓ 已复制到剪贴板（${size}）` : '✓ 已复制到剪贴板';
    }
    setTimeout(() => btn.textContent = old, 1500);
  } catch (e) {
    const digestId = _state_digest.lastSavedItem?.digest_id;
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
      } catch {}
    }
    if (status) {
      status.className = 'status err';
      status.textContent = '复制失败：浏览器和系统剪贴板都拒绝写入，请改用「下载 PNG」。';
    }
  }
}

// ---------- 历史页 ----------
async function renderHistory() {
  $app.appendChild(tplOf('tpl-history'));
  const list = await api('/api/history');
  const $grid = document.getElementById('history-grid');
  const $empty = document.getElementById('history-empty');
  if (!list.length) {
    $empty.classList.remove('hidden');
    return;
  }
  function paint(filter = '') {
    const f = filter.trim().toLowerCase();
    $grid.innerHTML = list
      .filter(it => !f || historySearchText(it).includes(f))
      .map(it => {
        const version = historyItemCacheBust(it);
        return `
        <div class="history-item" data-id="${it.digest_id}">
          <div class="history-thumb"><img loading="lazy" decoding="async" src="${historyThumbUrl(it.digest_id, version)}" alt="${escapeHtml(it.group)}" /></div>
          <div class="history-meta">
            <div class="gname">${escapeHtml(it.group)}</div>
            <div class="time">${escapeHtml(it.since)} ~ ${escapeHtml(it.until)}</div>
            <div class="time muted">${escapeHtml(it.model)} · ${it.message_count || 0} 条</div>
          </div>
        </div>`;
      }).join('');
    document.querySelectorAll('.history-thumb img').forEach(img => {
      const thumb = img.closest('.history-thumb');
      const markLoaded = () => thumb?.classList.add('loaded');
      const markError = () => thumb?.classList.add('error');
      img.addEventListener('load', markLoaded, { once: true });
      img.addEventListener('error', markError, { once: true });
      if (img.complete && img.naturalWidth > 0) markLoaded();
      else if (img.complete) markError();
    });
    document.querySelectorAll('.history-item').forEach(el => {
      el.addEventListener('click', () => {
        const item = list.find(x => x.digest_id === el.dataset.id);
        if (item) showHistoryModal(item);
      });
    });
  }
  paint();
  document.getElementById('history-search').addEventListener('input', e => paint(e.target.value));
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

function showHistoryModal(item) {
  const imageUrl = historyImageUrl(item.digest_id, historyItemCacheBust(item));
  const serverRerenderSupported = supportsServerRerender();
  const canRerender = !!item.digest_path && serverRerenderSupported;
  const rerenderTitle = !item.digest_path
    ? '旧记录缺少摘要 JSON，生成新摘要后可用'
    : serverRerenderSupported
      ? ''
      : '当前系统不支持历史重新渲染；请回到总结页重新生成摘要长图';
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="image-modal">
      <div class="modal-head">
        <strong>${escapeHtml(item.group)}</strong>
        <button class="icon-btn" data-close>×</button>
      </div>
      <div class="modal-body">
        <img data-zoomable src="${imageUrl}" alt="${escapeHtml(item.group)}" title="点击查看 100%" />
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
  modal.querySelector('[data-zoomable]').addEventListener('click', () => {
    showImageZoomModal({ title: item.group, src: historyImageUrl(item.digest_id, historyItemCacheBust(item) || Date.now()) });
  });
  modal.querySelector('[data-reveal]').addEventListener('click', async () => {
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
  });
  modal.querySelector('[data-copy]').addEventListener('click', async () => {
    status.className = 'status';
    status.textContent = '复制中...';
    try {
      const copied = await copyImageUrlToClipboard(historyImageUrl(item.digest_id, Date.now()));
      status.className = 'status ok';
      const size = imageSizeLabel(copied);
      status.textContent = size ? `✓ 已复制到剪贴板（${size}）` : '✓ 已复制到剪贴板';
    } catch {
      try {
        const copied = await api('/api/copy-image', { method: 'POST', body: { digest_id: item.digest_id } });
        status.className = 'status ok';
        const size = imageSizeLabel(copied.clipboard);
        status.textContent = size ? `✓ 已通过系统剪贴板复制（${size}）` : '✓ 已通过系统剪贴板复制';
      } catch (e) {
        status.className = 'status err';
        status.textContent = `复制失败：${e.message || '请下载 PNG'}`;
      }
    }
  });
  modal.querySelector('[data-rerender]').addEventListener('click', e => {
    showDigestRerenderPanel({
      anchor: e.currentTarget,
      statusTarget: status,
      initial: currentDigestRenderSelection(),
      onSave: async selection => {
        const r = await api('/api/rerender-history', {
          method: 'POST',
          body: { digest_id: item.digest_id, render: digestRenderPayload(selection) },
        });
        Object.assign(item, r.item || {});
        const freshUrl = historyImageUrl(item.digest_id, Date.now());
        modal.querySelector('img').src = freshUrl;
        modal.querySelector('[data-download]').href = freshUrl;
        return r;
      },
    });
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
  if (!res.ok) throw new Error('image fetch failed');
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
  const s = await api('/api/settings');
  const statePromise = api('/api/state').catch(() => ({ platform: '', project_root: '' }));

  // AI
  let availableModels = Array.isArray(s.llm.available_models) ? s.llm.available_models : [];
  let pendingUnlistedModelConfirm = '';
  document.querySelectorAll('input[name="s-provider"]').forEach(r => {
    r.checked = r.value === (s.llm.provider || 'openai');
  });
  document.getElementById('s-baseurl').value = s.llm.base_url || '';
  document.getElementById('s-apikey').value = '';
  document.getElementById('s-apikey-mask').textContent = s.llm.api_key_set ? `已保存 (${s.llm.api_key_display})` : '尚未保存';
  document.getElementById('s-model').value = s.llm.model || '';
  document.getElementById('s-model-long').value = s.llm.long_context_model || '';

  function selectedProvider() {
    return document.querySelector('input[name="s-provider"]:checked')?.value || 'openai';
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
  function syncCustomModel(which) {
    const isLong = which === 'long';
    const cb = document.getElementById(isLong ? 's-model-long-custom' : 's-model-custom');
    const select = document.getElementById(isLong ? 's-model-long-select' : 's-model-select');
    const input = document.getElementById(isLong ? 's-model-long' : 's-model');
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
    document.getElementById('s-model-custom').checked = !!s.llm.custom_model;
    document.getElementById('s-model-long-custom').checked = !!s.llm.custom_long_context_model;
    fillModelSelects();
    syncCustomModel('model');
    syncCustomModel('long');
  }
  fillModelSelects();
  document.getElementById('s-model-custom').checked = !!s.llm.custom_model;
  document.getElementById('s-model-long-custom').checked = !!s.llm.custom_long_context_model;
  syncCustomModel('model');
  syncCustomModel('long');
  document.getElementById('s-model-custom').addEventListener('change', () => syncCustomModel('model'));
  document.getElementById('s-model-long-custom').addEventListener('change', () => syncCustomModel('long'));

  document.getElementById('s-apikey-toggle').addEventListener('click', () => {
    const inp = document.getElementById('s-apikey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('s-list-models').addEventListener('click', async () => {
    const $st = document.getElementById('s-model-status');
    $st.className = 'status'; $st.textContent = '获取中...';
    try {
      const key = document.getElementById('s-apikey').value.trim();
      const payload = { provider: selectedProvider(), base_url: document.getElementById('s-baseurl').value, refresh: true, persist: true };
      if (key) payload.api_key = key;
      const r = await api('/api/list-models?refresh=true', { method: 'POST', body: payload });
      availableModels = r.models || [];
      fillModelSelects();
      $st.className = 'status ok';
      $st.textContent = `✓ 已获取 ${availableModels.length} 个模型`;
    } catch (e) {
      $st.className = 'status err';
      $st.textContent = '✗ ' + e.message;
    }
  });
  document.getElementById('s-test-llm').addEventListener('click', async () => {
    const $st = document.getElementById('s-llm-status');
    $st.className = 'status'; $st.textContent = '测试中...';
    try {
      const key = document.getElementById('s-apikey').value.trim();
      const payload = { provider: selectedProvider(), base_url: document.getElementById('s-baseurl').value };
      if (key) payload.api_key = key;
      const r = await api('/api/test-llm', {
        method: 'POST',
        body: payload,
      });
      $st.className = 'status ok';
      $st.textContent = `✓ 连通成功 (${r.latency_ms}ms)，可用模型：${r.models_sample.join(', ')}`;
    } catch (e) {
      $st.className = 'status err'; $st.textContent = '✗ 失败：' + e.message;
    }
  });
  document.getElementById('s-save-llm').addEventListener('click', async () => {
    const $st = document.getElementById('s-llm-status');
    const apiKey = document.getElementById('s-apikey').value.trim();
    const customModel = document.getElementById('s-model-custom').checked;
    const customLongModel = document.getElementById('s-model-long-custom').checked;
    const baseUrl = document.getElementById('s-baseurl').value.trim();
    const model = customModel ? document.getElementById('s-model').value.trim() : document.getElementById('s-model-select').value;
    const longModel = customLongModel ? document.getElementById('s-model-long').value.trim() : document.getElementById('s-model-long-select').value;
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
        available_models: availableModels,
      },
    };
    if (apiKey) payload.llm.api_key = apiKey;
    $st.className = 'status';
    $st.textContent = '保存中...';
    try {
      const r = await api('/api/settings', { method: 'PUT', body: payload });
      applySavedLlmSettings(r.settings);
      const warnings = Array.isArray(r.warnings) ? r.warnings : [];
      if (warnings.length) {
        $st.className = 'status warn';
        $st.textContent = '⚠ 已保存；' + warnings.map(w => w.message || w).join('；');
      } else {
        $st.className = 'status ok';
        $st.textContent = '✓ 已保存并完成连通探测';
        setTimeout(() => location.reload(), 600);
      }
    } catch (e) {
      $st.className = 'status err';
      $st.textContent = '✗ 保存失败：' + e.message;
    }
  });

  // 群与调度
  const $wl = document.getElementById('s-whitelist');
  let groups = [];
  let schedulerOverrides = Array.isArray(s.scheduler.per_group) ? s.scheduler.per_group.map(item => ({
    group: item.group || item.group_id || '',
    keywords: Array.isArray(item.keywords) ? item.keywords : String(item.keywords || '').split(/[,，]/).map(x => x.trim()).filter(Boolean),
    min_messages: Number(item.min_messages || item.min_messages_per_digest || 0) || 0,
  })).filter(item => item.group && (item.keywords.length || item.min_messages)) : [];
  try {
    groups = await api(`/api/groups?account=${encodeURIComponent(selectedAccountId())}`);
  } catch (e) {
    groups = [];
    $wl.innerHTML = `<p class="empty">读取本机微信群列表失败：${escapeHtml(e.message || '未知错误')}</p>`;
  }
  function paintWl() {
    if (!groups.length) return;
    $wl.innerHTML = groups.map(g => {
      const checked = (s.groups.whitelist || []).includes(g.name);
      return `<label class="chip"><input type="checkbox" ${checked ? 'checked' : ''} value="${escapeHtml(g.name)}" /> ${escapeHtml(g.name)}</label>`;
    }).join('');
  }
  paintWl();
  function paintOverrideEditor() {
    const groupSelect = document.getElementById('s-override-group');
    const list = document.getElementById('s-overrides');
    if (!groupSelect || !list) return;
    groupSelect.innerHTML = groups.length
      ? groups.map(g => `<option value="${escapeHtml(g.name || g.id)}">${escapeHtml(g.name || g.id)}</option>`).join('')
      : '<option value="">群列表不可用</option>';
    list.innerHTML = schedulerOverrides.length
      ? schedulerOverrides.map((item, index) => `
        <div class="override-item" data-index="${index}">
          <strong>${escapeHtml(item.group)}</strong>
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
  paintOverrideEditor();
  document.getElementById('s-add-override')?.addEventListener('click', () => {
    const group = document.getElementById('s-override-group').value;
    const keywords = document.getElementById('s-override-keywords').value
      .split(/[,，]/)
      .map(x => x.trim())
      .filter(Boolean);
    const minMessages = parseInt(document.getElementById('s-override-min').value || '0', 10) || 0;
    if (!group || (!keywords.length && !minMessages)) return;
    schedulerOverrides = schedulerOverrides.filter(item => item.group !== group);
    schedulerOverrides.push({ group, keywords, min_messages: minMessages });
    document.getElementById('s-override-keywords').value = '';
    document.getElementById('s-override-min').value = '';
    paintOverrideEditor();
  });
  document.getElementById('s-scheduler').checked = !!s.scheduler.enabled;
  setDurationControl('s-scheduler-interval', s.scheduler.default_interval || '30m', '30m');
  setDurationControl('s-scheduler-window', s.scheduler.digest_window || '4h', '4h');
  document.getElementById('s-scheduler-min').value = s.scheduler.min_messages_per_digest ?? 30;
  const schedulerStatus = document.getElementById('s-scheduler-status');
  function paintSchedulerStatus(status = {}) {
    const bits = [];
    bits.push(status.enabled ? '已启用' : '未启用');
    if (status.running) bits.push('运行中');
    if (status.next_run_at) bits.push(`下次 ${new Date(status.next_run_at).toLocaleString()}`);
    if (status.last_result?.generated !== undefined) {
      const r = status.last_result;
      const detail = [
        `生成 ${r.generated || 0}`,
        r.checked !== undefined ? `检查 ${r.checked}` : '',
        r.skipped ? `跳过 ${r.skipped}` : '',
        r.failed ? `失败 ${r.failed}` : '',
      ].filter(Boolean).join(' / ');
      bits.push(`上次 ${detail}`);
    }
    if (status.last_error) bits.push(`错误：${status.last_error}`);
    schedulerStatus.className = status.last_error ? 'status err' : 'status';
    schedulerStatus.textContent = bits.join(' · ');
  }
  api('/api/scheduler/status').then(r => paintSchedulerStatus(r.scheduler)).catch(() => paintSchedulerStatus({ enabled: !!s.scheduler.enabled }));
  document.getElementById('s-save-groups').addEventListener('click', async () => {
    const wl = [...document.querySelectorAll('#s-whitelist input:checked')].map(i => i.value);
    schedulerStatus.className = 'status';
    schedulerStatus.textContent = '保存中...';
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: {
          groups: { whitelist: wl },
          scheduler: {
            enabled: document.getElementById('s-scheduler').checked,
            default_interval: getDurationControlValue('s-scheduler-interval', '30m'),
            digest_window: getDurationControlValue('s-scheduler-window', '4h'),
            min_messages_per_digest: parseInt(document.getElementById('s-scheduler-min').value || '30', 10),
            per_group: schedulerOverrides,
          },
        },
      });
      schedulerStatus.className = 'status ok';
      schedulerStatus.textContent = '✓ 已保存白名单与调度设置';
      const r = await api('/api/scheduler/status').catch(() => null);
      if (r?.scheduler) paintSchedulerStatus(r.scheduler);
    } catch (e) {
      schedulerStatus.className = 'status err';
      schedulerStatus.textContent = '✗ 保存失败：' + e.message;
    }
  });
  document.getElementById('s-run-scheduler').addEventListener('click', async () => {
    schedulerStatus.className = 'status';
    schedulerStatus.textContent = '检查中...';
    try {
      const r = await api('/api/scheduler/run-once', { method: 'POST', body: {} });
      paintSchedulerStatus(r.scheduler);
    } catch (e) {
      schedulerStatus.className = 'status err';
      schedulerStatus.textContent = '✗ ' + e.message;
    }
  });
  document.getElementById('s-save-groups').disabled = false;
  document.getElementById('s-run-scheduler').disabled = false;

  // 渲染与输出
  const state = await statePromise;
  document.getElementById('s-theme').value = s.render.default_theme;
  document.getElementById('s-fontsize').value = s.render.default_font_size;
  document.getElementById('s-outdir').value = s.output.dir;
  document.getElementById('s-retention').value = s.output.retention_days ?? 0;
  document.getElementById('s-open-outdir').addEventListener('click', async () => {
    const $st = document.getElementById('s-render-status');
    const outDir = document.getElementById('s-outdir').value.trim();
    if (!outputDirLooksInsideProject(outDir, state.project_root)) {
      $st.className = 'status err';
      $st.textContent = '✗ 输出目录必须在项目根之下，且不能位于 outputs/.tmp';
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
  });
  document.getElementById('s-save-render').addEventListener('click', async () => {
    const $st = document.getElementById('s-render-status');
    const outDir = document.getElementById('s-outdir').value.trim();
    if (!outputDirLooksInsideProject(outDir, state.project_root)) {
      $st.className = 'status err';
      $st.textContent = '✗ 输出目录必须在项目根之下，且不能位于 outputs/.tmp';
      return;
    }
    $st.className = 'status';
    $st.textContent = '保存中...';
    try {
      await api('/api/settings', {
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
      $st.className = 'status ok';
      $st.textContent = '✓ 已保存';
    } catch (e) {
      $st.className = 'status err';
      $st.textContent = '✗ ' + e.message;
    }
  });
  document.getElementById('s-open-outdir').disabled = false;
  document.getElementById('s-save-render').disabled = false;

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
  document.getElementById('s-save-privacy').addEventListener('click', async () => {
    const $st = document.getElementById('s-privacy-status');
    const keyMode = document.getElementById('s-keymode').value;
    const manualKey = document.getElementById('s-manual-key').value.trim();
    const manualKeys = normalizeManualKeysText(manualKey);
    if (keyMode === 'manual' && manualKey && manualKeys.invalid.length) {
      $st.className = 'status err';
      $st.textContent = '✗ 手动密钥每条必须是 64 或 96 位 hex';
      return;
    }
    const wechatPatch = keyMode === 'manual'
      ? (manualKeys.keys.length ? { manual_key: manualKeys.text } : {})
      : { clear_manual_key: true };
    $st.className = 'status';
    $st.textContent = '保存中...';
    try {
      await api('/api/settings', {
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
      document.getElementById('s-manual-key').value = '';
      $st.className = 'status ok';
      const savedManualCount = keyMode === 'manual' ? manualKeys.keys.length : 0;
      $st.textContent = savedManualCount ? `✓ 已保存隐私设置（${savedManualCount} 条手动密钥）` : '✓ 已保存隐私设置';
    } catch (e) {
      $st.className = 'status err';
      $st.textContent = '✗ 保存失败：' + e.message;
    }
  });
  document.getElementById('s-export-diag').addEventListener('click', async () => {
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
  });
  document.getElementById('s-save-privacy').disabled = false;
  document.getElementById('s-export-diag').disabled = false;

  async function refreshAcceptanceChecks() {
    const $list = document.getElementById('s-acceptance-checks');
    const $st = document.getElementById('s-acceptance-status');
    if (!$list || !$st) return;
    $st.className = 'status';
    $st.textContent = '正在读取诊断状态...';
    try {
      const diag = await api('/api/diagnostics');
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
        const stateLabel = ready ? '软件证据就绪' : '等待软件证据';
        const summary = item.software_evidence_summary || item.software_evidence_status || '';
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
      $st.textContent = `已读取 ${checks.length} 项，${readyCount} 项软件证据就绪`;
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
      lines.push(`- 状态：${item.status || ''}`);
      lines.push(`- 软件证据：${item.software_evidence_status || ''}`);
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
  document.getElementById('s-refresh-acceptance').addEventListener('click', refreshAcceptanceChecks);
  document.getElementById('s-export-acceptance-md').addEventListener('click', exportAcceptanceMarkdown);
  document.getElementById('s-refresh-acceptance').disabled = false;
  document.getElementById('s-export-acceptance-md').disabled = false;
  refreshAcceptanceChecks();

  // 关于
  document.getElementById('s-platform').textContent = state.platform;
  document.getElementById('s-projroot').textContent = state.project_root;
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
  const wizardData = { llm: {}, wechat: {}, whitelist: new Set() };

  function paint() {
    $step.textContent = step;
    $back.disabled = step === 1;
    $next.textContent = step === 4 ? '完成' : '下一步';
    if (step === 1) {
      $title.textContent = '欢迎使用 wx-summary';
      const secretWarning = state.secrets_invalid
        ? `<div class="notice-card setup-secret-warning">
            <strong>检测到本机密钥无法解密</strong>
            <span>当前系统用户不能解开已有的本机密钥文件。请重新填写 AI Key 和可选微信手动密钥；旧密文不会展示，也不会上传。</span>
          </div>`
        : '';
      $body.innerHTML = `
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
      $body.innerHTML = `
        <div class="form-row"><label>Provider</label>
          <div class="radio-row">
            <label><input type="radio" name="w-provider" value="openai" ${(wizardData.llm.provider || 'openai') === 'openai' ? 'checked' : ''} /> OpenAI</label>
            <label><input type="radio" name="w-provider" value="anthropic" ${wizardData.llm.provider === 'anthropic' ? 'checked' : ''} /> Anthropic</label>
          </div>
        </div>
        <div class="form-row"><label>Base URL</label><input id="w-base" type="text" placeholder="https://your-endpoint/v1" value="${wizardData.llm.base_url || ''}" /></div>
        <div class="form-row"><label>API Key</label><input id="w-key" type="password" placeholder="sk-..." value="${wizardData.llm.api_key || ''}" /></div>
        <div class="form-row inline"><button class="btn" id="w-list">获取模型</button><span class="status" id="w-status"></span></div>
        <div class="form-row"><label>模型</label><select id="w-model">${models.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}</option>`).join('') || '<option value="">请先获取模型</option>'}</select></div>
        <div class="form-row"><label>长上下文模型</label><select id="w-model-long">${models.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}</option>`).join('') || '<option value="">请先获取模型</option>'}</select></div>`;
      if (wizardData.llm.model) document.getElementById('w-model').value = wizardData.llm.model;
      if (wizardData.llm.long_context_model) document.getElementById('w-model-long').value = wizardData.llm.long_context_model;
      document.getElementById('w-list').addEventListener('click', async () => {
        const $st = document.getElementById('w-status');
        $st.className = 'status'; $st.textContent = '获取中...';
        try {
          const provider = document.querySelector('input[name="w-provider"]:checked')?.value || 'openai';
          const r = await api('/api/list-models?refresh=true', {
            method: 'POST',
            body: { provider, base_url: document.getElementById('w-base').value, api_key: document.getElementById('w-key').value, refresh: true },
          });
          wizardData.llm.provider = provider;
          wizardData.llm.base_url = document.getElementById('w-base').value;
          wizardData.llm.api_key = document.getElementById('w-key').value;
          wizardData.llm.available_models = r.models || [];
          wizardData.llm.model = wizardData.llm.available_models[0]?.id || '';
          wizardData.llm.long_context_model = wizardData.llm.model;
          $st.className = 'status ok'; $st.textContent = `✓ 获取到 ${wizardData.llm.available_models.length} 个模型`;
          paint();
        } catch (e) { $st.className = 'status err'; $st.textContent = '✗ ' + e.message; }
      });
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
      api(`/api/groups?account=${encodeURIComponent(selectedAccountId())}`).then(groups => {
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
            ? visible.map(g => `<label class="chip"><input type="checkbox" value="${escapeHtml(g.name)}" ${wizardData.whitelist.has(g.name) ? 'checked' : ''} /> ${escapeHtml(g.name)}</label>`).join('')
            : '<span class="muted small">没有匹配的群。</span>';
          list.querySelectorAll('input[type="checkbox"]').forEach(input => {
            input.addEventListener('change', () => {
              if (input.checked) wizardData.whitelist.add(input.value);
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
            .forEach(g => wizardData.whitelist.add(g.name));
          paintWhitelist(search.value);
        });
        document.getElementById('w-whitelist-clear').addEventListener('click', () => {
          wizardData.whitelist.clear();
          paintWhitelist(search.value);
        });
        paintWhitelist();
      }).catch(e => {
        $body.innerHTML = `<p class="status err">读取本机微信群列表失败：${escapeHtml(e.message || '未知错误')}</p>`;
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
      wizardData.llm.model = document.getElementById('w-model').value;
      wizardData.llm.long_context_model = document.getElementById('w-model-long').value;
      if (!wizardData.llm.base_url || !wizardData.llm.api_key) {
        const $st = document.getElementById('w-status');
        if ($st) {
          $st.className = 'status err';
          $st.textContent = '✗ 请填写 Base URL 和 API Key';
        }
        return;
      }
      if (!wizardData.llm.available_models?.length || !wizardData.llm.model) {
        const $st = document.getElementById('w-status');
        if ($st) {
          $st.className = 'status err';
          $st.textContent = '✗ 请先点击「获取模型」并选择模型';
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
      const wl = [...wizardData.whitelist];
      const payload = { llm: wizardData.llm, groups: { whitelist: wl } };
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
        location.hash = '#/digest';
        location.reload();
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
