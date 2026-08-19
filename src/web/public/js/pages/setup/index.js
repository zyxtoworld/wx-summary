// 首次启动向导页面(#/setup):全屏居中卡片步进器,4 步。
//   1 欢迎+账号 → 2 AI 接入 → 3 数据库密钥(条件步骤)→ 4 群列表+完成。
// 框架职责:步骤渲染/指示器/底部按钮、异步竞态防护(generation token + AbortController)、
// 账号身份升级同步;各步骤的接口调用都在 step-*.js。
import {
  createWizardState,
  accountIdOf,
  bindWizardAccountContext,
  findAccountByAnyId,
  refreshWizardStateForAccount,
  stateMatchesAccountContext,
  syncWizardStateFromSettingsResponse,
  wizardAccountContextIdentity,
} from './state.js';
import { restorePendingSettingsMutationRecovery } from '../../shared/settings-mutation-recovery.js';
import { createAccountStep } from './step-account.js';
import { createLlmStep } from './step-llm.js';
import { createKeyStep } from './step-key.js';
import { createFinishStep, stepForNeedSetupReason } from './step-finish.js';
import { createSetupSkipAction } from './skip-action.js';
import { createSetupLeaveGuard } from './leave-guard.js';
import { focusRouteHeading } from '../../shared/route-focus.js';
import { setAriaCurrentState } from '../../ui/aria-state.js';
import { createScopedUi } from '../../ui/lifecycle.js';

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const STEP_TITLES = ['账号', 'AI 接入', '数据库密钥', '完成'];

// 当前页面实例(模块被 router 缓存,同一时刻只挂载一次)。
let activePage = null;

export default {
  title: '首次配置向导',
  css: '/css/setup.css',

  async mount(root, ctx) {
    const page = buildPage(root, ctx);
    activePage = page;
    page.startInitialRecovery();
    return () => page.destroy();
  },

  async unmount() {
    if (activePage) {
      activePage.destroy();
      activePage = null;
    }
  },

  async canLeave() {
    if (!activePage) return true;
    return activePage.confirmLeave();
  },

  onRouteLoadingFailure() {
    activePage?.handleRouteLoadingFailure?.();
  },
};

function buildPage(root, ctx) {
  const { store, ui: baseUi } = ctx;
  const abortController = new AbortController();
  const ui = createScopedUi(baseUi, abortController.signal);
  const scopedCtx = { ...ctx, ui };
  const page = {
    destroyed: false,
    initializing: true,
    noticeText: '',
    noticeKind: 'info',
    noticeCarryToNextStep: false,
    generation: 0,
    stepIndex: 0,
    busy: false,       // 底部“下一步/完成”正在执行
    completionNavigationPending: false, // 完成成功后等待 router 消费内部导航
    skipPending: false, // “跳过 AI”确认框正在等待用户决定
    entering: 0,       // 正在渲染的步骤序号(防 onEnter 竞态)
  };

  const wiz = createWizardState(ctx.store);

  // 页面级上下文,传给各步骤。
  const w = {
    ctx: scopedCtx,
    wiz,
    get destroyed() { return page.destroyed; },
    signal: abortController.signal,
    // 每次异步操作取一个新 token;unmount 或新操作开启后旧 token 失效。
    beginAsync() {
      page.generation += 1;
      return page.generation;
    },
    alive(token) {
      return !page.destroyed && token === page.generation;
    },
    refreshButtons,
    gotoStep,
    showPageNotice,
    // 服务端返回 account_identity_upgrade 时,用响应里的最新账号刷新本地指纹与列表。
    async applyAccountIdentityUpgrade(latestAccount, { ownerToken = null } = {}) {
      if (!latestAccount) return false;
      const generationAtStart = page.generation;
      const previousIdentity = wizardAccountContextIdentity(wiz.account);
      const nextIdentity = wizardAccountContextIdentity(latestAccount);
      const ownerIsCurrent = () => !page.destroyed
        && page.generation === generationAtStart
        && (!ownerToken || page.generation === ownerToken);
      const previousIsCurrent = () => ownerIsCurrent()
        && wizardAccountContextIdentity(wiz.account) === previousIdentity;
      const nextIsCurrent = () => ownerIsCurrent()
        && wizardAccountContextIdentity(wiz.account) === nextIdentity;
      if (!previousIsCurrent()) return false;
      const previousId = accountIdOf(wiz.account);
      bindWizardAccountContext(wiz, latestAccount, ctx.store);
      if (!nextIsCurrent()) return false;
      const fresh = findAccountByAnyId(wiz.accounts, latestAccount);
      if (fresh !== latestAccount) {
        wiz.accounts = [
          latestAccount,
          ...(Array.isArray(wiz.accounts) ? wiz.accounts : []).filter(item => item !== fresh),
        ];
      }
      ctx.store.set('accounts', wiz.accounts);
      ctx.store.set('account', latestAccount);
      try {
        const id = accountIdOf(latestAccount) || previousId;
        if (id) localStorage.setItem('wx-summary:confirmed-account-id', id);
      } catch {}
      let stateReady = false;
      try {
        stateReady = await refreshWizardStateForAccount({
          api: ctx.api,
          store: ctx.store,
          wiz,
          account: latestAccount,
          signal: abortController.signal,
          isCurrent: nextIsCurrent,
        });
      } catch (error) {
        if (nextIsCurrent() && error?.name !== 'AbortError' && error?.status !== 499) {
          showPageNotice('warn', '微信账号身份已更新,但当前账号状态尚未重新确认;请回到第 1 步重新检测。', {
            carryToNextStep: true,
          });
        }
        return false;
      }
      if (!stateReady) {
        if (nextIsCurrent()) {
          showPageNotice('warn', '微信账号身份已更新,但当前账号状态尚未重新确认;请回到第 1 步重新检测。', {
            carryToNextStep: true,
          });
        }
        return false;
      }
      if (!nextIsCurrent()) return false;
      showPageNotice('info', '微信账号身份已更新,已同步最新账号信息。', { carryToNextStep: true });
      return true;
    },
  };

  // ---------------------------------------------------------------------------
  // DOM 骨架
  // ---------------------------------------------------------------------------
  root.replaceChildren();
  const pageEl = el('div', 'setup-page');
  const card = el('div', 'setup-card');

  const head = el('div', 'setup-head');
  const brand = el('div', 'setup-brand');
  brand.append(
    (() => {
      const logo = el('span', 'setup-brand-logo');
      logo.setAttribute('aria-hidden', 'true');
      logo.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
      return logo;
    })(),
    el('h1', 'setup-brand-name', '首次配置向导'),
  );
  const stepsNav = document.createElement('ol');
  stepsNav.className = 'setup-steps';
  stepsNav.setAttribute('aria-label', '配置步骤');
  const stepItems = STEP_TITLES.map((title, index) => {
    const item = el('li', 'setup-step-item');
    item.append(el('span', 'setup-step-dot', String(index + 1)), el('span', 'setup-step-label', title));
    stepsNav.appendChild(item);
    return item;
  });
  head.append(brand, stepsNav);

  const pageNotice = el('div', 'setup-status setup-page-notice');
  pageNotice.setAttribute('role', 'status');
  pageNotice.setAttribute('aria-live', 'polite');
  pageNotice.setAttribute('aria-atomic', 'true');
  pageNotice.hidden = true;

  const body = el('div', 'setup-body');

  const foot = el('div', 'setup-foot');
  const backBtn = el('button', 'btn btn-ghost', '上一步');
  backBtn.type = 'button';
  const skipBtn = el('button', 'btn btn-ghost', '跳过本步');
  skipBtn.type = 'button';
  const spacer = el('span', 'setup-foot-spacer');
  const nextBtn = el('button', 'btn btn-primary', '下一步');
  nextBtn.type = 'button';
  foot.append(backBtn, skipBtn, spacer, nextBtn);

  card.append(head, pageNotice, body, foot);
  pageEl.appendChild(card);
  root.appendChild(pageEl);

  // ---------------------------------------------------------------------------
  // 步骤实例
  // ---------------------------------------------------------------------------
  const accountStep = createAccountStep(w);
  const steps = [accountStep, createLlmStep(w), createKeyStep(w), createFinishStep(w)];
  // 密钥步骤的 stale-account 恢复必须复用第 1 步的选择与 state 刷新链,
  // 不能只替换 wiz.account 而跳过账号作用域清理。
  w.switchToAccount = async account => {
    if (page.destroyed) return false;
    return await accountStep.selectAccount?.(account, { restoreSelectedFocus: false }) === true;
  };

  function currentStep() {
    return steps[page.stepIndex];
  }

  function stepBusy() {
    return page.initializing || page.busy || page.skipPending
      || currentStep()?.isBusy?.() === true;
  }

  function actionBusy() {
    return stepBusy() || page.completionNavigationPending;
  }

  function paintStepIndicator() {
    stepItems.forEach((item, index) => {
      const current = index === page.stepIndex;
      item.classList.toggle('active', current);
      item.classList.toggle('done', index < page.stepIndex);
      setAriaCurrentState(item, current, 'step');
      const dot = item.querySelector('.setup-step-dot');
      if (dot) dot.textContent = index < page.stepIndex ? '✓' : String(index + 1);
    });
  }

  function refreshButtons() {
    if (page.destroyed) return;
    const step = currentStep();
    const busyNow = actionBusy();
    backBtn.disabled = busyNow || page.stepIndex === 0;
    nextBtn.disabled = busyNow;
    const last = page.stepIndex === steps.length - 1;
    nextBtn.textContent = last ? '完成' : '下一步';
    // 跳过按钮:仅在步骤声明可跳过(canContinue 已满足或步骤允许显式跳过)时显示;
    // 账号步骤不可跳,最后一步无跳过。
    let skipVisible = false;
    if (!last && page.stepIndex > 0) {
      if (page.stepIndex === 1) {
        // AI 步骤允许显式跳过;下一步的 beforeNext 只负责测试/保存,不是跳过门槛。
        skipVisible = true;
      } else if (page.stepIndex === 2) {
        // 密钥步骤:已满足时无需“跳过”(直接下一步),未满足时允许显式跳过。
        skipVisible = !(step?.canContinue?.() === true);
      } else {
        skipVisible = step?.canContinue?.() === true;
      }
    }
    skipBtn.hidden = !skipVisible;
    skipBtn.disabled = busyNow;
    paintStepIndicator();
  }

  function paintPageNotice() {
    const text = String(page.noticeText || '').trim();
    const kind = ['info', 'ok', 'warn', 'err'].includes(page.noticeKind)
      ? page.noticeKind
      : 'info';
    pageNotice.className = `setup-status setup-status-${kind} setup-page-notice`;
    pageNotice.hidden = !text;
    pageNotice.replaceChildren();
    if (!text) return;
    pageNotice.append(
      el('span', 'setup-status-icon', { info: '•', ok: '✓', warn: '⚠', err: '✗' }[kind]),
      el('span', 'setup-status-text', text),
    );
  }

  function showPageNotice(kind, text, { carryToNextStep = false } = {}) {
    if (page.destroyed) return;
    page.noticeKind = kind;
    page.noticeText = String(text || '').trim();
    page.noticeCarryToNextStep = Boolean(page.noticeText && carryToNextStep);
    paintPageNotice();
  }

  function gotoStep(index, { focus = true, keepNotice = false } = {}) {
    if (page.destroyed) return;
    const preserveNotice = keepNotice || page.noticeCarryToNextStep;
    page.noticeCarryToNextStep = false;
    if (!preserveNotice) {
      page.noticeKind = 'info';
      page.noticeText = '';
      paintPageNotice();
    }
    const clamped = Math.max(0, Math.min(steps.length - 1, index));
    if (clamped !== page.stepIndex) currentStep().onExit?.();
    page.stepIndex = clamped;
    page.entering += 1;
    const enterToken = page.entering;
    if (focus) root.scrollTop = 0;
    body.replaceChildren(currentStep().el);
    refreshButtons();
    if (focus) focusRouteHeading(currentStep().el);
    Promise.resolve(currentStep().onEnter?.()).catch(error => {
      if (page.destroyed || enterToken !== page.entering) return;
      console.error('setup step onEnter failed', error);
    });
  }

  async function goNext() {
    if (stepBusy() || page.completionNavigationPending) return;
    const step = currentStep();
    // 让上一步骤残留的异步回调失效;注意:步骤内部操作会再取新 token,
    // 所以这里只用 destroyed 判断,不能用 w.alive(token)。
    w.beginAsync();
    page.busy = true;
    refreshButtons();
    try {
      // 步骤自定义门槛(如 AI 步骤的测试+保存)。
      if (typeof step.beforeNext === 'function') {
        const pass = await step.beforeNext();
        if (page.destroyed) return;
        if (!pass) return;
      } else if (typeof step.canContinue === 'function' && !step.canContinue()) {
        showPageNotice('warn', step.blockedMessage?.() || '请先完成当前步骤。');
        return;
      }
      if (page.destroyed) return;
      if (page.stepIndex >= steps.length - 1) return;
      gotoStep(page.stepIndex + 1);
    } catch (error) {
      if (page.destroyed) return;
      if (error?.name === 'AbortError' || error?.status === 499) return;
      showPageNotice('err', error?.message || '操作失败,请重试。');
    } finally {
      page.busy = false;
      if (!page.destroyed) refreshButtons();
    }
  }

  async function goFinish() {
    if (stepBusy() || page.completionNavigationPending) return;
    const step = currentStep();
    if (typeof step.finish !== 'function') return;
    w.beginAsync();
    page.busy = true;
    refreshButtons();
    try {
      const completed = await step.finish();
      if (completed === true && !page.destroyed) {
        // step.finish 已请求 #/digest,但 hashchange/router 仍在后续任务中;
        // 在此窗口内继续允许第二次完成会重复提交并发起重复导航。
        page.completionNavigationPending = true;
      }
    } catch (error) {
      if (page.destroyed) return;
      if (error?.name === 'AbortError' || error?.status === 499) return;
      showPageNotice('err', error?.message || '操作失败,请重试。');
    } finally {
      page.busy = false;
      if (!page.destroyed) refreshButtons();
    }
  }

  page.handleRouteLoadingFailure = () => {
    if (page.destroyed || !page.completionNavigationPending) return;
    page.completionNavigationPending = false;
    showPageNotice('err', '进入总结页失败,请重试。');
    refreshButtons();
  };

  backBtn.addEventListener('click', () => {
    if (actionBusy() || page.stepIndex === 0) return;
    gotoStep(page.stepIndex - 1);
  });

  nextBtn.addEventListener('click', () => {
    if (page.stepIndex >= steps.length - 1) void goFinish();
    else void goNext();
  });

  const skipAction = createSetupSkipAction({
    button: skipBtn,
    isBusy: actionBusy,
    getStepIndex: () => page.stepIndex,
    isDestroyed: () => page.destroyed,
    confirmDialog: options => ui.confirmDialog(options),
    onPendingChange: pending => { page.skipPending = pending; },
    refreshButtons,
    gotoStep,
    markKeySkipped: () => { wiz.key.skipped = true; },
    showNotice: showPageNotice,
  });

  // ---------------------------------------------------------------------------
  // 页面生命周期
  // ---------------------------------------------------------------------------
  page.render = () => {
    page.initializing = false;
    // 依据 need_setup_reason 决定初始高亮步骤:llm* 从第 2 步起更符合用户预期,
    // 但账号确认是后续一切的前提,固定从第 1 步开始;密钥原因且账号已确认时直接高亮第 3 步。
    const reason = String(wiz.needSetupReason || '').trim();
    let initial = 0;
    if (wiz.stateAccountId === accountIdOf(wiz.account)
      && accountIdOf(wiz.account)
      && stateMatchesAccountContext(wiz.state, wiz.account)
      && ['wechat_manual_key_required', 'wechat_auto_key_scan_failed'].includes(reason)) {
      initial = stepForNeedSetupReason(reason) - 1;
    }
    gotoStep(initial, { focus: false, keepNotice: true });
  };

  page.startInitialRecovery = () => {
    const loading = el('div', 'setup-initial-loading');
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-live', 'polite');
    loading.append(
      el('p', '', '正在核对上次设置写入状态…'),
      el('p', 'muted', '完成后将显示可继续的配置步骤。'),
    );
    body.replaceChildren(loading);
    refreshButtons();
    void page.recoverPendingSettingsMutations().then(() => {
      if (!page.destroyed) page.render();
    });
  };

  page.recoverPendingSettingsMutations = async () => {
    try {
      const recovered = await restorePendingSettingsMutationRecovery({
        api: ctx.api,
        signal: abortController.signal,
        applySettings(settings) {
          syncWizardStateFromSettingsResponse(wiz, {
            settings,
            settings_revision: settings?.settings_revision,
          });
        },
      });
      if (recovered.cleared && !page.destroyed) {
        showPageNotice('info', '已核对上次未确认的设置写入,向导已同步最终状态。');
      }
    } catch (error) {
      if (!page.destroyed && error?.name !== 'AbortError' && error?.status !== 499) {
        showPageNotice('warn', `上次设置写入尚未核对:${error?.message || '请稍后刷新重试。'}`);
      }
    }
  };

  page.destroy = () => {
    if (page.destroyed) return;
    page.destroyed = true;
    page.initializing = false;
    page.completionNavigationPending = false;
    skipAction.dispose();
    page.generation += 1;
    page.entering += 1;
    try {
      currentStep()?.onExit?.();
    } catch (error) {
      try { console.error('setup step cleanup failed', error); } catch {}
    } finally {
      abortController.abort();
      if (store.get('accountSwitchGuard') === accountSwitchGuard) {
        store.set('accountSwitchGuard', null);
      }
    }
  };

  // 离开守卫:进行中的操作和未保存草稿都不能被壳层导航静默丢弃。
  page.confirmLeave = createSetupLeaveGuard(() => ({
      busy: !page.initializing && stepBusy(),
      wiz,
      confirmDialog: ui.confirmDialog,
  }));

  function accountSwitchGuard() {
    if (page.destroyed) return '';
    return '首次配置向导已打开,请回到第 1 步在向导中选择账号,避免向导状态与账号不一致。';
  }

  // 向导内部维护自己的账号与草稿;壳层菜单只能在离开向导后切换。
  store.set('accountSwitchGuard', accountSwitchGuard);

  return page;
}
