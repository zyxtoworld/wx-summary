// 生成中进度卡:总体进度条 + 当前群 stage 列表(耗时/重试倒计时)+ 可展开日志。
import { makeScrollableRegion } from '/js/shared/scroll-region.js';

const STAGE_ORDER = ['context', 'fetching', 'preflight', 'summarizing', 'handoff'];

export const STAGE_LABELS = Object.freeze({
  context: '核对生成环境',
  fetching: '拉取消息',
  preflight: '检查 AI 设置',
  summarizing: 'AI 总结',
  handoff: '发送摘要到浏览器',
});

function formatElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `${seconds} 秒`;
}

export function createProgressView({ onCancel = null } = {}) {
  const el = document.createElement('section');
  el.className = 'card card-pad progress-card';
  el.innerHTML = `
    <div class="progress-head">
      <h3 class="progress-title">正在生成摘要</h3>
      <button type="button" class="btn btn-ghost btn-sm progress-cancel">取消生成 (Esc)</button>
    </div>
    <div class="progress-overall">
      <div class="progress-track"><div class="progress-fill"></div></div>
      <span class="progress-count muted">0 / 0</span>
    </div>
    <p class="progress-current muted"></p>
    <ol class="stage-list"></ol>
    <details class="progress-log-wrap">
      <summary>运行日志</summary>
      <div class="progress-log" aria-live="polite"></div>
    </details>
  `;
  const fill = el.querySelector('.progress-fill');
  const count = el.querySelector('.progress-count');
  const current = el.querySelector('.progress-current');
  const title = el.querySelector('.progress-title');
  const stageList = el.querySelector('.stage-list');
  const logBox = el.querySelector('.progress-log');
  makeScrollableRegion(logBox, { label: '生成运行日志', role: 'log' });
  const cancelBtn = el.querySelector('.progress-cancel');
  let disposed = false;
  cancelBtn.addEventListener('click', () => {
    if (disposed) return;
    onCancel?.();
  });

  const stageRows = new Map(); // name -> { row, status, time, startedAt, accumulatedMs, state }
  let ticker = null;
  let logLines = 0;

  const ensureTicker = () => {
    if (disposed || ticker) return;
    ticker = setInterval(() => {
      if (disposed) return;
      for (const item of stageRows.values()) {
        if (item.state === 'running') {
          item.time.textContent = formatElapsed(item.accumulatedMs + Date.now() - item.startedAt);
        }
      }
      updateRetryCountdown();
    }, 1000);
  };

  let retryRow = null;
  let retryAtMs = 0;
  const updateRetryCountdown = () => {
    if (disposed || !retryRow) return;
    const remain = Math.max(0, retryAtMs - Date.now());
    retryRow.textContent = remain > 0
      ? `模型限流/失败,${Math.ceil(remain / 1000)} 秒后自动重试…`
      : '正在重试…';
  };

  const appendLog = text => {
    const line = document.createElement('div');
    line.className = 'progress-log-line';
    const time = new Date();
    line.textContent = `[${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}] ${text}`;
    logBox.appendChild(line);
    logLines += 1;
    if (logLines > 300) logBox.firstElementChild?.remove();
    logBox.scrollTop = logBox.scrollHeight;
  };

  const upsertStageRow = name => {
    if (stageRows.has(name)) return stageRows.get(name);
    const row = document.createElement('li');
    row.className = 'stage-row';
    row.dataset.stage = name;
    const icon = document.createElement('span');
    icon.className = 'stage-icon';
    const label = document.createElement('span');
    label.className = 'stage-label';
    label.textContent = STAGE_LABELS[name] || name;
    const detail = document.createElement('span');
    detail.className = 'stage-detail muted';
    const time = document.createElement('span');
    time.className = 'stage-time muted';
    row.append(icon, label, detail, time);
    // 按固定顺序插入。
    const order = STAGE_ORDER.indexOf(name);
    const before = [...stageList.children].find(child => {
      const childOrder = STAGE_ORDER.indexOf(child.dataset.stage);
      return order !== -1 && childOrder !== -1 && childOrder > order;
    });
    stageList.insertBefore(row, before || null);
    const item = {
      row, icon, detail, time,
      state: 'pending',
      startedAt: 0,
      accumulatedMs: 0,
    };
    stageRows.set(name, item);
    return item;
  };

  ensureTicker();

  return {
    el,
    setTotal(done, total) {
      if (disposed) return;
      const pct = total > 0 ? Math.min(1, done / total) : 0;
      fill.style.width = `${Math.round(pct * 1000) / 10}%`;
      count.textContent = `${done} / ${total}`;
    },
    setCurrentGroup(name) {
      if (disposed) return;
      current.textContent = name ? `当前群:${name}` : '';
    },
    resetStages() {
      if (disposed) return;
      stageList.replaceChildren();
      stageRows.clear();
      if (retryRow) {
        retryRow.remove();
        retryRow = null;
      }
    },
    onStage(stage = {}) {
      if (disposed) return;
      const name = String(stage?.name || '').trim();
      if (!name) return;
      const item = upsertStageRow(name);
      const status = String(stage?.status || 'running').trim();
      if (status === 'running' && item.state !== 'running') {
        item.startedAt = Date.now();
      } else if (status !== 'running' && item.state === 'running') {
        item.accumulatedMs += Date.now() - item.startedAt;
      }
      item.state = status;
      item.row.dataset.status = status;
      item.icon.textContent = status === 'done' ? '✓' : status === 'error' ? '✕' : status === 'warn' ? '!' : '';
      item.icon.className = `stage-icon stage-icon-${status}`;
      const detail = String(stage?.detail || '').trim();
      item.detail.textContent = detail;
      if (status !== 'running' && (item.accumulatedMs || item.startedAt)) {
        const total = item.accumulatedMs + (item.startedAt ? 0 : 0);
        item.time.textContent = formatElapsed(total);
      }
      // 分块进度
      if (Number(stage?.chunk_total) > 1 && Number.isFinite(Number(stage?.chunk_index))) {
        item.detail.textContent = `${detail ? `${detail} · ` : ''}分块 ${Number(stage.chunk_index) + 1}/${Number(stage.chunk_total)}`;
      }
      // 重试倒计时
      if (Number(stage?.retry_at_ms) > Date.now()) {
        retryAtMs = Number(stage.retry_at_ms);
        if (!retryRow) {
          retryRow = document.createElement('p');
          retryRow.className = 'stage-retry muted';
          item.row.after(retryRow);
        }
        const attempt = Number(stage?.retry_attempt || 0);
        const maxAttempt = Number(stage?.retry_max_attempts || 0);
        const reason = String(stage?.retry_reason || '').trim();
        retryRow.textContent = `模型重试 ${attempt}/${maxAttempt}${reason ? `(${reason})` : ''}`;
        updateRetryCountdown();
      } else if (retryRow && status !== 'running') {
        retryRow.remove();
        retryRow = null;
      }
      appendLog(`[${STAGE_LABELS[name] || name}] ${status}${detail ? ` — ${detail}` : ''}`);
    },
    log(text) {
      if (disposed) return;
      appendLog(String(text || ''));
    },
    setCancelling() {
      if (disposed) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = '正在取消…';
    },
    setTerminal(status = 'done') {
      if (disposed) return;
      const normalized = ['done', 'error', 'cancelled', 'pending'].includes(status) ? status : 'done';
      if (retryRow) {
        retryRow.remove();
        retryRow = null;
      }
      retryAtMs = 0;
      title.textContent = normalized === 'done'
        ? '生成完成'
        : normalized === 'cancelled'
          ? '已取消生成'
          : normalized === 'pending' ? '结果待确认' : '生成失败';
      el.dataset.status = normalized;
      cancelBtn.hidden = true;
      cancelBtn.disabled = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (ticker) clearInterval(ticker);
      ticker = null;
    },
  };
}
