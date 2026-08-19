// 设置页 · 本机状态分区:验收检查清单、本机能力、平台限制、导出验收 MD。
import {
  assertBrowserDownloadSupported,
  browserDownloadCapability,
  browserDownloadUnsupportedMessage,
} from '/js/shared/browser-download-capability.js';
import {
  el,
  createStatusLine,
  errorText,
  isAbortError,
  downloadTextFile,
  fmtDateTime,
} from './core.js';
import { localStatusDisplayItem, shouldAutoRefreshSystemStatus } from './system-status.js';
import { createSettingsSystemOperation } from './system-operation.js';
import { requireSettingsDiagnosticsResult } from '/js/shared/diagnostics-contract.js';

const CAPABILITY_LABELS = Object.freeze([
  ['system_clipboard_image', '系统剪贴板图片'],
  ['server_png', '服务端 PNG 渲染'],
  ['history_rerender', '历史长图重渲染'],
  ['thumbnail', '缩略图'],
  ['reveal_in_folder', '在文件夹中显示'],
  ['ffmpeg', 'ffmpeg(语音转写)'],
  ['wxgf_native_decoder', '微信语音原生解码'],
]);

const LIMITATION_LABELS = Object.freeze(Object.fromEntries([
  ['platform', '当前操作系统'],
  ['browser_clipboard_image', '浏览器图片剪贴板'],
  ...CAPABILITY_LABELS,
]));

function checkIconClass(item) {
  if (item?.ready_for_user_confirmation === true) return 'ok';
  if (item?.user_confirmation_required === true || item?.status === 'needs_user_confirmation') return 'pending';
  return 'na';
}

function checkIconText(item) {
  const cls = checkIconClass(item);
  return cls === 'ok' ? '✓' : (cls === 'pending' ? '!' : '–');
}

// 平台限制(platform_limitations 的 value 形状各异,做防御式摘要)
function limitationEntries(limitations) {
  if (!limitations || typeof limitations !== 'object' || Array.isArray(limitations)) return [];
  return Object.entries(limitations).map(([key, value]) => {
    const supported = value?.supported === true;
    const reason = String(value?.reason || value?.message || value?.note || '').trim();
    return { key, label: LIMITATION_LABELS[key] || '其他平台能力', supported, reason };
  });
}

export function createSystemSection(page) {
  const { api, ui } = page;
  const status = createStatusLine();

  const checklistEl = el('ul', { class: 'settings-checklist' });
  const capabilityGrid = el('div', { class: 'settings-capability-grid' });
  const limitationList = el('div', { class: 'settings-check-list' });
  const refreshBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '刷新本机状态' });
  const exportBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '导出验收 MD' });
  const downloadSupported = browserDownloadCapability({ requireObjectUrl: true }).supported;
  if (!downloadSupported) {
    exportBtn.title = browserDownloadUnsupportedMessage({ artifactLabel: '验收记录' });
    exportBtn.disabled = true;
  }

  let lastDiag = null;
  const diagnosticsOperation = createSettingsSystemOperation();

  function paint(diag) {
    lastDiag = diag || null;
    // 检查清单
    const checks = (Array.isArray(diag?.acceptance_manual_checks) ? diag.acceptance_manual_checks : [])
      .map(localStatusDisplayItem);
    checklistEl.replaceChildren(...(checks.length
      ? checks.map(item => el('li', { class: 'settings-check-item' },
        el('span', { class: `settings-check-icon ${checkIconClass(item)}`, text: checkIconText(item) }),
        el('div', { class: 'settings-check-body' },
          el('span', { class: 'settings-check-title', text: `${item?.id || ''} ${item?.title || ''}`.trim() || '未命名检查项' }),
          el('span', { class: 'settings-check-meta', text: item?.display_status ? `${item.display_status} · ${item?.software_evidence_summary || item?.software_evidence_status || ''}` : (item?.software_evidence_summary || item?.software_evidence_status || '') }),
          item?.next_step ? el('span', { class: 'settings-check-meta', text: `下一步:${item.next_step}` }) : null,
        ),
      ))
      : [el('li', { class: 'settings-check-item' },
        el('span', { class: 'settings-check-icon na', text: '–' }),
        el('div', { class: 'settings-check-body' },
          el('span', { class: 'settings-check-title', text: '诊断包未返回检查清单' }),
        ))]));
    // 能力徽章
    const capabilities = diag?.capabilities || {};
    capabilityGrid.replaceChildren(...CAPABILITY_LABELS.map(([key, label]) => {
      const supported = capabilities[key] === true;
      return el('span', {
        class: `settings-cap ${supported ? 'ok' : 'fail'}`,
        text: `${label} ${supported ? '✓' : '✗'}`,
      });
    }));
    // 平台限制
    const entries = limitationEntries(diag?.platform_limitations);
    limitationList.replaceChildren(...(entries.length
      ? entries.map(entry => el('div', { class: 'settings-check-meta' },
        el('strong', { text: `${entry.supported ? '✓' : '✗'} ${entry.label}` }),
        entry.reason ? el('span', { text: ` — ${entry.reason}` }) : null,
      ))
      : [el('div', { class: 'settings-check-meta', text: '没有平台限制记录。' })]));
  }

  async function performRefresh() {
    const token = page.beginAction('读取本机状态', [refreshBtn, exportBtn]);
    status.set('正在读取本机状态…');
    try {
      const response = await api.get('/api/diagnostics?scope=acceptance', {
        signal: token.signal,
        timeoutMs: 120_000,
      });
      if (!page.alive(token)) return;
      const diag = requireSettingsDiagnosticsResult(response, 'acceptance');
      paint(diag);
      status.set(`已更新(${fmtDateTime(diag?.generated_at) || '刚刚'})。`, 'ok');
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      status.set(errorText(error, '读取本机状态失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }

  function refresh() {
    return diagnosticsOperation.run(performRefresh);
  }

  function acceptanceMarkdown(diag) {
    const checks = Array.isArray(diag?.acceptance_manual_checks) ? diag.acceptance_manual_checks : [];
    const lines = [
      '# wx-summary 本机诊断与操作记录',
      '',
      `导出时间:${fmtDateTime(new Date().toISOString())}`,
      `诊断采集:${fmtDateTime(diag?.generated_at)}`,
      `服务地址:${diag?.service?.url || ''}`,
      `服务运行:${diag?.service?.uptime_hours ?? ''} 小时`,
      `平台:${diag?.platform_limitations ? '见下文平台限制' : ''}`,
      '',
      '## 本机能力',
      '',
      ...CAPABILITY_LABELS.map(([key, label]) => `- ${label}:${diag?.capabilities?.[key] === true ? '支持' : '不支持'}`),
      '',
      '## 需要人工确认的项目',
      '',
    ];
    for (const item of checks) {
      lines.push(`### ${item?.id || ''} ${item?.title || ''}`.trim());
      lines.push(`- 状态:${item?.status || ''}`);
      lines.push(`- 软件证据:${item?.software_evidence_status || ''}`);
      lines.push(`- 可人工确认:${item?.ready_for_user_confirmation === true ? '是' : '否'}`);
      if (item?.software_evidence_summary) lines.push(`- 证据摘要:${item.software_evidence_summary}`);
      if (item?.next_step) lines.push(`- 下一步:${item.next_step}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  async function performExportMarkdown() {
    const token = page.beginAction('导出验收 MD', [exportBtn, refreshBtn]);
    status.set('正在刷新并导出验收记录…');
    try {
      assertBrowserDownloadSupported({ requireObjectUrl: true });
      const response = await api.get('/api/diagnostics?scope=acceptance', {
        signal: token.signal,
        timeoutMs: 120_000,
      });
      if (!page.alive(token)) return;
      const diag = requireSettingsDiagnosticsResult(response, 'acceptance');
      paint(diag);
      const markdown = acceptanceMarkdown(diag);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadTextFile(`wx-summary-diagnostics-${stamp}.md`, markdown, 'text/markdown');
      status.set('验收记录已下载为 Markdown 文件。', 'ok');
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      status.set(errorText(error, '导出验收记录失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }


  function exportMarkdown() {
    return diagnosticsOperation.run(performExportMarkdown);
  }

  refreshBtn.addEventListener('click', () => { void refresh(); });
  exportBtn.addEventListener('click', () => { void exportMarkdown(); });

  const section = el('section', { class: 'settings-section', 'data-section': 'system' },
    el('div', { class: 'settings-section-head' },
      el('h2', { class: 'settings-section-title', text: '本机状态' }),
      el('p', { class: 'muted', text: '验收用检查清单与本机能力;清单项需要人工逐一确认。' }),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '验收检查清单' }),
      checklistEl,
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '本机能力' }),
      capabilityGrid,
      el('h4', { class: 'settings-subtitle', text: '平台限制' }),
      limitationList,
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('div', { class: 'settings-actions' }, refreshBtn, exportBtn, status.el),
    ),
  );

  return {
    id: 'system',
    el: section,
    applySettings() {},
    onActivated() {
      if (shouldAutoRefreshSystemStatus(lastDiag)) void refresh();
    },
    onAccountChanged() {
      diagnosticsOperation.invalidate();
      paint(null);
      status.clear();
      if (!section.hidden) void refresh();
    },
    destroy() {
      diagnosticsOperation.invalidate();
    },
    setBusy(busy) {
      refreshBtn.disabled = busy;
      exportBtn.disabled = busy || !downloadSupported;
    },
  };
}
