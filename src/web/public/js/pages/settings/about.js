// 设置页 · 关于分区:平台、项目目录、页面资源信息。
import { el } from './core.js';

const PLATFORM_LABELS = Object.freeze({
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
});

export function createAboutSection(page) {
  const list = el('div', { class: 'settings-about-list' });

  function kv(k, v, { mono = false } = {}) {
    return el('div', { class: 'settings-kv' },
      el('span', { class: 'settings-kv-k', text: k }),
      el('span', {
        class: 'settings-kv-v',
        text: v || '—',
        title: v || '',
        style: mono ? 'font-family:var(--font-mono);font-size:12px;white-space:normal;word-break:break-all;' : '',
      }));
  }

  function paint() {
    const state = page.getState() || {};
    const platform = String(state.platform || '').trim();
    list.replaceChildren(
      kv('应用', '微信群消息 AI 总结工具'),
      kv('页面资源信息', '', {}),
      kv('平台', PLATFORM_LABELS[platform] || platform || '—'),
      kv('项目标识', String(state.project_label || '').trim() || '—'),
      kv('项目目录', String(state.project_root || '').trim() || '—', { mono: true }),
      kv('页面资源标识', String(state.asset_version || '').trim() || '—', { mono: true }),
    );
    // “页面资源信息”这一格带徽章
    const badgeRow = list.children[1];
    if (badgeRow) {
      const value = badgeRow.querySelector('.settings-kv-v');
      if (value) {
        value.textContent = '';
        value.append(
          el('span', { class: 'settings-badge', text: '页面资源' }),
          document.createTextNode(' 零依赖原生 ESM'),
        );
      }
    }
  }

  const section = el('section', { class: 'settings-section', 'data-section': 'about' },
    el('div', { class: 'settings-section-head' },
      el('h2', { class: 'settings-section-title', text: '关于' }),
      el('p', { class: 'muted', text: '本地服务与页面资源信息。' }),
    ),
    el('div', { class: 'card card-pad settings-card' }, list),
  );

  return {
    id: 'about',
    el: section,
    applySettings() { paint(); },
    onActivated() { paint(); },
    onStateChanged() { paint(); },
    setBusy() {},
  };
}
