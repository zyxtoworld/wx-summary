// 前端挂载验收:/ 服务新前端,静态资源与 import 图完整,鉴权链路与版本闸门正常。
// 运行:node tests/web-frontend-mount.mjs
// 隔离实例(ACCEPTANCE_MODE + 独立 DATA_DIR + 固定 bootstrap token),不触碰 7788 生产实例。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'outputs', '.tmp', `web-frontend-mount-test-${process.pid}`);
const BOOTSTRAP = 'webfrontendmountbootstrap0123456';
const HEALTH = 'webfrontendmounthealth0123456789';
const START_PORT = 8480;
const PAGE_ENTRIES = ['digest', 'history', 'settings', 'setup'].map(name => `/js/pages/${name}/index.js`);

async function waitForPort(child, timeoutMs = 30000) {
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待服务监听超时。输出:\n${buffer.slice(-2000)}`)), timeoutMs);
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      const match = buffer.match(/服务：(http:\/\/127\.0\.0\.1:(\d+))/);
      if (match) {
        clearTimeout(timer);
        resolve({ url: match[1], port: Number(match[2]) });
      }
    });
    child.stderr.on('data', chunk => { buffer += String(chunk); });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出 code=${code}。输出:\n${buffer.slice(-2000)}`));
    });
  });
}

async function main() {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const child = spawn(process.execPath, ['src/main.js', '--no-open', '--port', String(START_PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      WX_SUMMARY_ACCEPTANCE_MODE: '1',
      WX_SUMMARY_ACCEPTANCE_DATA_DIR: path.relative(ROOT, DATA_DIR),
      WX_SUMMARY_BOOTSTRAP_TOKEN: BOOTSTRAP,
      WX_SUMMARY_HEALTH_TOKEN: HEALTH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  try {
    const { url: base } = await waitForPort(child);
    const get = async (url, options = {}) => {
      const response = await fetch(`${base}${url}`, { redirect: 'manual', ...options });
      return { status: response.status, text: await response.text(), headers: response.headers };
    };

    // 1. 入口:/ 直接服务新前端,占位符已替换
    const index = await get('/');
    assert.equal(index.status, 200, 'GET / 必须 200');
    assert.ok(index.text.includes('/js/main.js'), 'GET / 必须引用前端入口 /js/main.js');
    assert.match(index.text, /<link\s+rel="icon"\s+href="\/favicon\.svg"\s*>/, 'GET / 必须声明同源 SVG 站点图标，避免浏览器隐式请求缺失的 /favicon.ico');
    assert.ok(!index.text.includes('window.__WX_TOKEN__'), '不得残留旧前端标记');
    for (const placeholder of ['__SESSION_TOKEN__', '__ASSET_VERSION__', '__SERVICE_INSTANCE_ID__']) {
      assert.ok(!index.text.includes(placeholder), `占位符 ${placeholder} 必须被替换`);
    }
    assert.match(index.text, /assetVersion:\s*'sha256-[0-9a-f]{16}'/, '必须注入 asset_version');
    assert.match(index.text, /serviceInstanceId:\s*'[A-Za-z0-9_-]{16,128}'/, '必须注入 service_instance_id');

    // 2. 静态资源:index.html 引用 + 全量 import 图(含 router 动态加载的页面入口)
    const assetUrls = new Set();
    for (const match of index.text.matchAll(/(?:src|href)="(\/[^"]+)"/g)) assetUrls.add(match[1]);
    assert.ok([...assetUrls].some(u => u.endsWith('app.css')), 'index.html 必须引用 app.css');
    assert.ok([...assetUrls].some(u => u.endsWith('main.js')), 'index.html 必须引用 main.js');

    const appCss = await get('/css/app.css');
    assert.equal(appCss.status, 200, 'app.css 必须 200');
    assert.match(appCss.text, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/, '组件 display 不能覆盖 hidden 属性');
    assert.match(appCss.text, /@media\s*\(max-width:\s*760px\)[\s\S]*?grid-template-areas:\s*["']brand footer["'][\s\S]*?["']nav nav["']/, '窄屏必须把侧栏改为顶部导航');
    assert.match(appCss.text, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.digest-layout\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/, '窄屏总结页必须收起双栏布局');
    assert.match(appCss.text, /\.group-list\s*\{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/, '群列表必须限制为可收缩单列,避免最长群名撑出横向滚动条');
    assert.match(appCss.text, /\.chip-input-row \.input\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-width:\s*0;[\s\S]*?\.chip-input-row \.btn\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?white-space:\s*nowrap;/, '总结筛选输入必须让文本框收缩并保持添加按钮单行');
    assert.match(appCss.text, /\.account-menu\s*\{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto;/, '窄屏账号菜单不得出现横向滚动条');
    assert.match(appCss.text, /\.account-menu-item\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/, '账号菜单项必须允许在窄屏收缩');
    const settingsCss = await get('/css/settings.css');
    assert.equal(settingsCss.status, 200, 'settings.css 必须 200');
    assert.match(settingsCss.text, /\.settings-picker-list\s*\{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/, '设置页群白名单必须限制为可收缩单列,避免移动端横向滚动条');
    const settingsCssWithoutComments = settingsCss.text.replace(/\/\*[\s\S]*?\*\//g, '');
    const settingsRuleDeclarations = selector => [...settingsCssWithoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selectors]) => selectors.split(',').some(item => item.trim() === selector))
      .map(([, , declarations]) => declarations)
      .join('\n');
    for (const selector of ['.settings-main', '.settings-section', '.settings-card', '.settings-rule-list', '.settings-rule']) {
      const declarations = settingsRuleDeclarations(selector);
      assert.match(declarations, /min-width:\s*0;/, `${selector} 必须允许在极窄屏收缩`);
      assert.match(declarations, /grid-template-columns:\s*minmax\(0,\s*1fr\);/, `${selector} 必须使用可收缩单列,避免聚焦分区导航时外层内容横移`);
    }
    assert.match(appCss.text, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.theme-btn\s*\{\s*min-width:\s*24px;/, '窄屏主题按钮必须保留可点击宽度');
    assert.match(appCss.text, /@media\s*\(max-width:\s*360px\)[\s\S]*?\.brand-name\s*\{\s*display:\s*none;/, '极窄屏必须收起品牌文字为账号区留出空间');

    const importRe = /(?:import|export)[^'";]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;
    const resolveDep = (spec, fromUrl) => {
      if (!spec) return '';
      if (spec.startsWith('/js/')) return spec;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        try {
          const resolved = new URL(spec, `http://local${fromUrl}`).pathname;
          if (resolved.startsWith('/js/')) return resolved;
        } catch {}
      }
      return '';
    };

    const seen = new Set();
    const queue = [...assetUrls, ...PAGE_ENTRIES];
    const pageCssHrefs = new Set();
    while (queue.length) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      const response = await get(url);
      assert.equal(response.status, 200, `GET ${url} 必须 200(实际 ${response.status})`);
      if (!url.endsWith('.js') || response.status !== 200) continue;
      if (PAGE_ENTRIES.includes(url)) {
        const cssMatch = response.text.match(/css:\s*'(\/css\/[^']+)'/);
        if (cssMatch) pageCssHrefs.add(cssMatch[1]);
      }
      for (const match of response.text.matchAll(importRe)) {
        const dep = resolveDep(match[1] || match[2] || match[3], url);
        if (dep && !seen.has(dep)) queue.push(dep);
      }
    }
    for (const entry of PAGE_ENTRIES) {
      assert.ok(seen.has(entry), `页面入口 ${entry} 必须存在于 import 图`);
    }
    for (const href of pageCssHrefs) {
      const response = await get(href);
      assert.equal(response.status, 200, `页面样式 ${href} 必须 200(实际 ${response.status})`);
    }
    // 后端也直接引用的共享模块,必须经 /js/shared/ 可服务
    for (const shared of [
      '/js/shared/digest-view-model.js',
      '/js/shared/unicode-text.js',
      '/js/shared/local-action-recovery.js',
    ]) {
      const response = await get(shared);
      assert.equal(response.status, 200, `${shared} 必须 200(实际 ${response.status})`);
    }
    const modalJs = await get('/js/ui/modal.js');
    const dialogFocusJs = await get('/js/ui/dialog-focus.js');
    const routeFocusJs = await get('/js/shared/route-focus.js');
    const liveRegionJs = await get('/js/ui/live-region.js');
    assert.equal(modalJs.status, 200, '统一模态框模块必须 200');
    assert.equal(dialogFocusJs.status, 200, '模态框焦点管理模块必须 200');
    assert.equal(routeFocusJs.status, 200, '路由焦点模块必须 200');
    assert.equal(liveRegionJs.status, 200, '状态播报模块必须 200');
    assert.ok(
      modalJs.text.includes("from './dialog-focus.js'")
        && modalJs.text.includes("aria-labelledby")
        && modalJs.text.includes('focusManager.focusInitial()')
        && modalJs.text.includes('focusManager?.dispose({ restore: restoreFocus })'),
      '统一模态框必须接入命名、初始焦点、Tab 管理和关闭恢复',
    );
    const routerJs = await get('/js/router.js');
    assert.equal(routerJs.status, 200, '路由模块必须 200');
    assert.ok(
      routerJs.text.includes("from './shared/route-focus.js'")
        && routerJs.text.includes('focusRouteHeading(root)'),
      '每次页面挂载后必须进入统一页面标题焦点入口',
    );
    assert.ok(
      liveRegionJs.text.includes("aria-live")
        && liveRegionJs.text.includes("aria-atomic"),
      '状态播报模块必须声明 live region 属性',
    );
    const settingsMutationRecoveryJs = await get('/js/shared/settings-mutation-recovery.js');
    assert.equal(settingsMutationRecoveryJs.status, 200, '设置写入恢复模块必须 200');

    // 设置页的列表渲染必须把 map 返回的 DOM 节点逐个传入 replaceChildren。
    // 如果遗漏展开运算符, 浏览器会把节点数组强制转成 [object HTML...] 文本。
    const arrayRenderMarkers = new Map([
      ['/js/pages/settings/system.js', [
        'checklistEl.replaceChildren(...',
        'capabilityGrid.replaceChildren(...',
        'limitationList.replaceChildren(...',
      ]],
      ['/js/pages/settings/scheduler.js', [
        'whitelistChips.replaceChildren(...',
        'pickerList.replaceChildren(...',
        'ruleList.replaceChildren(...',
      ]],
      ['/js/pages/settings/privacy.js', [
        'logPanel.replaceChildren(...',
      ]],
    ]);
    for (const [url, markers] of arrayRenderMarkers) {
      const response = await get(url);
      assert.equal(response.status, 200, `${url} 必须 200(实际 ${response.status})`);
      for (const marker of markers) {
        assert.ok(response.text.includes(marker), `${url} 的 ${marker} 必须展开 DOM 节点数组`);
      }
    }
    const systemJs = await get('/js/pages/settings/system.js');
    assert.match(systemJs.text, /\['platform', '当前操作系统'\][\s\S]*?\['browser_clipboard_image', '浏览器图片剪贴板'\]/, '平台限制必须为平台与浏览器剪贴板能力提供中文名称');
    assert.match(systemJs.text, /label:\s*LIMITATION_LABELS\[key\]\s*\|\|\s*'其他平台能力'[\s\S]*?entry\.label/, '平台限制必须渲染统一的中文能力名称,不得直接展示内部键');
    const settingsIndexJs = await get('/js/pages/settings/index.js');
    assert.equal(settingsIndexJs.status, 200, '设置页面编排模块必须 200');
    assert.match(settingsIndexJs.text, /function switchSection\(id\)[\s\S]*?root\.scrollTop\s*=\s*0[\s\S]*?active\?\.onActivated\?\.\(\)/, '切换设置分区必须把共享内容滚动容器复位到顶部');
    const schedulerJs = await get('/js/pages/settings/scheduler.js');
    assert.equal(schedulerJs.status, 200, '调度设置模块必须 200');
    assert.match(schedulerJs.text, /function handleDraftChange\(\)\s*\{[\s\S]*?status\.clear\(\)[\s\S]*?markDirty\(\)/, '修改调度设置草稿后必须清除上一轮校验错误');
    assert.match(schedulerJs.text, /case 'persisted_disabled':\s*return '设置中未启用';[\s\S]*?default:\s*return '未知停用原因';/, '调度停用原因必须覆盖默认关闭状态,且未知内部代码不得直接显示给用户');
    assert.match(schedulerJs.text, /disabledReasonLabel\(scheduler\.disabled_reason, scheduler\.disabled_reason_label\)/, '调度状态必须优先使用后端提供的用户可读停用原因');
    const backendMainSource = await fsp.readFile(path.join(ROOT, 'src', 'main.js'), 'utf8');
    assert.match(backendMainSource, /case 'persisted_disabled':\s*return '设置中未启用';/, '后端公开的调度默认停用原因必须是用户可读文案');
    const mainJs = await get('/js/main.js');
    assert.equal(mainJs.status, 200, '前端壳入口必须 200');
    assert.match(mainJs.text, /refreshStateForAccount[\s\S]*\/api\/state\?account=/, '选择账号后必须用带账号的状态请求清除陈旧的多账号提示');
    assert.match(mainJs.text, /store\.subscribe\('account'[\s\S]*?renderAccountSwitcher\(\)[\s\S]*?refreshStateForAccount\(account\)/, '向导等页面直接更新账号 store 后,壳层必须同步账号按钮并刷新账号状态');
    assert.match(mainJs.text, /createAccountSelectionController\(\{[\s\S]*?persistConfirmedAccountId: rememberConfirmedAccountId[\s\S]*?selectAccount\(account, \{ userInitiated: true \}\)/, '壳层必须只在用户明确选择后持久化确认账号,并经过当前页切换守卫');
    const outputJs = await get('/js/pages/settings/output.js');
    assert.equal(outputJs.status, 200, '输出设置模块必须 200');
    assert.match(outputJs.text, /function handleDraftChange\(\)\s*\{[\s\S]*?status\.clear\(\)/, '修改输出设置草稿后必须清除上一轮校验错误');
    assert.match(outputJs.text, /FILENAME_TOKEN_RE[\s\S]*?文件名模板至少包含/, '输出文件名模板必须在保存前校验变量占位符');
    const aiJs = await get('/js/pages/settings/ai.js');
    assert.equal(aiJs.status, 200, 'AI 设置模块必须 200');
    assert.match(aiJs.text, /function markTestDraftDirty\(\)\s*\{[\s\S]*?status\.clear\(\)[\s\S]*?clearTestResult\(\)[\s\S]*?markDirty\(\)/, '修改 AI 草稿后必须清除旧错误与旧模型绑定的测试结果');
    assert.match(aiJs.text, /const checkedResult = requireAiConnectivityResult\(result\);[\s\S]*?const allOk = checkedResult\.ok === true && checkedResult\.partial_ok !== true[\s\S]*?const partial = checkedResult\.partial_ok === true/,
      'AI 连通测试必须先验证响应合同，且存在部分能力失败时不得误报为全部通过');
    const historyJs = await get('/js/pages/history/index.js');
    assert.equal(historyJs.status, 200, '历史页面模块必须 200');
    const historyActionGuardJs = await get('/js/pages/history/action-guard.js');
    assert.equal(historyActionGuardJs.status, 200, '历史危险操作目标核对模块必须 200');
    const historyRevalidationJs = await get('/js/pages/history/revalidation.js');
    assert.equal(historyRevalidationJs.status, 200, '历史详情重验模块必须 200');
    assert.ok(
      historyJs.text.includes('createHistoryReturnRevalidator(')
        && historyJs.text.includes('detail.revalidator.schedule(0)')
        && historyJs.text.includes('detail.revalidator?.dispose()')
        && historyJs.text.includes('revalidateHistoryActionTarget('),
      '历史详情必须在打开/回到窗口时重验,关闭时清理重验任务',
    );
    assert.ok(
      historyJs.text.includes('signal: state.controller.signal')
        && historyJs.text.includes('page.destroyed || state.controller.signal.aborted'),
      '历史重渲染保存必须绑定弹层取消信号并阻止关闭后的回写',
    );
    assert.match(historyJs.text, /state\?\.status === 'error' \|\| state\?\.status === 'missing'[\s\S]*?缩略图不可用/, '历史详情必须把已失败的缩略图请求渲染为明确占位,不能永久显示加载 spinner');
    assert.match(historyJs.text, /loadFirstPage\(\{ clearItems: true \}\)/, '历史筛选/搜索切换必须先清除旧卡片,避免加载期间操作到过期记录');
    assert.match(historyJs.text, /function commitSearchDraft\(\)[\s\S]*?filterSegmented\.addEventListener[\s\S]*?commitSearchDraft\(\)[\s\S]*?accountSegmented\.addEventListener[\s\S]*?commitSearchDraft\(\)/, '历史输入搜索后切换状态或账号筛选都必须先提交防抖草稿,避免旧 page.q 覆盖输入框');
    assert.match(historyJs.text, /history_search_index_repair_incomplete:\s*'[^']*搜索结果可能不完整[\s\S]*?function warningText\(entry\)[\s\S]*?incompleteReasonLabels\[code\]/, '历史页不能把 incomplete_reasons 的内部代码直接展示给用户,必须渲染为友好警示文案');
    const digestJs = await get('/js/pages/digest/index.js');
    assert.equal(digestJs.status, 200, '总结页面模块必须 200');
    const recoveryActionJs = await get('/js/pages/digest/recovery-action-state.js');
    assert.equal(recoveryActionJs.status, 200, '摘要恢复 action lease 模块必须 200');
    assert.match(digestJs.text, /import \{ createRecoveryActionState \} from '\.\/recovery-action-state\.js'/, '摘要恢复页面必须接入 action lease');
    assert.match(digestJs.text, /if \(page\.destroyed \|\| page\.accountContextBlocked \|\| recoveryAction\.isBusy\(\)\) return;/, '恢复 action 进行中或账号上下文锁定时不得因跨标签变化重绘恢复卡片');
    const textPreviewActionJs = await get('/js/pages/digest/text-preview-action-state.js');
    assert.equal(textPreviewActionJs.status, 200, '文本预览 action lease 模块必须 200');
    assert.match(digestJs.text, /import \{ createTextPreviewActionState \} from '\.\/text-preview-action-state\.js'/, '文本预览必须接入统一 action lease');
    assert.match(digestJs.text, /invalidateTextPreviewAction\('页面已卸载'\)[\s\S]*?beforeunload/, '页面卸载必须失效并取消文本预览动作');
    assert.match(digestJs.text, /textPreviewLeaveConfirmation\(textPreviewAction\.snapshot\(\)\?\.kind\)[\s\S]*?invalidateTextPreviewAction\('页面已离开'\)/, '文本预览操作进行中离开页面必须按动作种类确认并取消');
    assert.match(digestJs.text, /api\.post\('\/api\/export-preview'[\s\S]*?signal: action\.controller\.signal/, 'Markdown 导出请求必须绑定 action 取消信号');
    assert.match(digestJs.text, /function invalidateTextPreviewAction[\s\S]*?renderTextPreviewCard[\s\S]*?invalidateTextPreviewAction\('文本预览已替换'\)/, '替换预览必须先失效旧导出');
    const settingsPageJs = await get('/js/pages/settings/index.js');
    const setupPageJs = await get('/js/pages/setup/index.js');
    const settingsCoordinatorJs = await get('/js/shared/settings-write-coordinator.js');
    assert.match(digestJs.text, /el\('h1', 'digest-page-title', '总结'\)/, '总结页必须提供可聚焦的页面标题');
    assert.match(digestJs.text,
      /mainCol\.append\(settingsCard,[^;]+\);\s*layout\.append\(pageTitle, sidebar, mainCol\);/,
      '总结页标题必须是布局直接子项，窄屏才能在群列表之前展示页面 H1');
    assert.match(appCss.text,
      /\.digest-layout\s*\{[^}]*grid-template-areas:\s*"sidebar title"\s*"sidebar main";/,
      '桌面总结页必须让群侧栏跨越标题与主内容两行');
    assert.match(appCss.text,
      /@media\s*\(max-width:\s*760px\)[\s\S]*?\.digest-layout\s*\{[^}]*grid-template-areas:\s*"title"\s*"sidebar"\s*"main";/,
      '窄屏总结页必须按页面标题、群列表、生成设置的阅读顺序排列');
    assert.match(settingsPageJs.text, /class: 'settings-page-title'[^\n]*text: '设置'/, '设置页必须提供可聚焦的页面标题');
    assert.match(setupPageJs.text, /el\('h1', 'setup-brand-name', '首次配置向导'\)/, '向导必须使用语义化页面标题');
    assert.match(setupPageJs.text, /stepsNav\.setAttribute\('aria-label', '配置步骤'\)/, '向导步骤导航必须有可访问名称');
    assert.match(setupPageJs.text, /import \{ focusRouteHeading \} from '\.\.\/\.\.\/shared\/route-focus\.js'/, '向导步骤必须复用标题焦点边界');
    assert.match(setupPageJs.text, /root\.scrollTop = 0/, '向导切换步骤必须回到内容顶部');
    assert.match(setupPageJs.text, /focusRouteHeading\(currentStep\(\)\.el\)/, '向导切换步骤必须聚焦当前步骤标题');
    assert.match(settingsCoordinatorJs.text, /beginPendingSettingsMutation\('设置保存'\)[\s\S]*?completePendingSettingsMutationAfterResponse[\s\S]*?completePendingSettingsMutationAfterError/, '设置协调器必须在写入前登记并按结果清理恢复 marker');
    assert.match(settingsPageJs.text, /restorePendingSettingsMutationRecovery\([\s\S]*?wait_for_writes/, '设置页启动必须先核对未完成写入');
    assert.match(setupPageJs.text, /recoverPendingSettingsMutations[\s\S]*?restorePendingSettingsMutationRecovery/, '配置向导启动必须复用设置写入恢复边界');
    const canvasPngJs = await get('/js/shared/canvas-png.js');
    assert.equal(canvasPngJs.status, 200, '共享 Canvas PNG 编码模块必须 200');
    const digestRenderJs = await get('/js/pages/digest/render.js');
    const historyRerenderJs = await get('/js/pages/history/rerender.js');
    assert.equal(digestRenderJs.status, 200, '总结长图渲染模块必须 200');
    assert.equal(historyRerenderJs.status, 200, '历史重渲染模块必须 200');
    assert.ok(
      digestRenderJs.text.includes("from '/js/shared/canvas-png.js'")
        && historyRerenderJs.text.includes("from '/js/shared/canvas-png.js'"),
      '总结与历史重渲染必须复用同一 Canvas PNG 编码通道',
    );
    assert.match(digestJs.text, /canvasToValidatedPngBytes\(rendered\.canvas, \{ signal: actionAbort\.signal \}\)[\s\S]*?canvasToPngBlob\(rendered\.canvas, \{ signal: actionAbort\.signal \}\)[\s\S]*?actionAbort\.abort\(new Error\('页面已卸载'\)\)/, '总结保存、图片复制和页面卸载必须贯穿同一取消信号');
    assert.match(historyJs.text, /canvasToValidatedPngBytes\(rendered\.canvas, \{[\s\S]*?signal: state\.controller\.signal/, '历史重渲染关闭后必须取消排队中的 Canvas PNG 编码');
    const digestProgressJs = await get('/js/pages/digest/progress.js');
    assert.equal(digestProgressJs.status, 200, '总结进度组件必须 200');
    assert.match(digestProgressJs.text, /setTerminal\(status = 'done'\)[\s\S]*?生成完成[\s\S]*?已取消生成[\s\S]*?生成失败[\s\S]*?cancelBtn\.hidden = true/, '进度卡进入终态后必须更新标题并隐藏取消按钮');
    assert.match(digestJs.text, /let progressTerminalStatus = 'done'[\s\S]*?if \(controller\.signal\.aborted\)[\s\S]*?progressTerminalStatus = 'cancelled'[\s\S]*?run\.results\.some\(item => item\?\.outcome === 'error'\)[\s\S]*?progressTerminalStatus = 'error'[\s\S]*?progressView\.setTerminal\(progressTerminalStatus\)/, '总结批次完成、取消或失败后必须把终态传给进度卡');
    assert.match(digestJs.text, /function createChipInput\(placeholder, onChange, onPendingChange\)/, '总结筛选组件必须分别提供已提交值与待提交文本变更回调');
    assert.match(digestJs.text, /onChange\?\.\(\[\.\.\.values\]\)/, '总结筛选变更必须同步到页面状态,避免路由切换后丢失');
    assert.match(digestJs.text, /minInput\.addEventListener\('input'[\s\S]*?page\.minMessages = parsed\.value/, '总结最少消息数必须在输入时同步,避免点击其他控件时丢失');
    assert.match(
      digestJs.text,
      /draftScopeLifecycle = createDigestDraftScopeLifecycle\([\s\S]*?resetDraft: resetDraftState[\s\S]*?applyDraft: applyDraftState/,
      '总结草稿必须由 scope 生命周期统一决定何时重置并应用目标账号草稿',
    );
    assert.match(
      digestJs.text,
      /import \{[\s\S]*?digestAccountContextIdentity[\s\S]*?\} from '\.\/account-context\.js';[\s\S]*?function restoreDraft\(\)[\s\S]*?draftScopeLifecycle\.reconcile\(draftScope\(\)[\s\S]*?accountIdentity: digestAccountContextIdentity\(store\.get\('account'\)\)/,
      '总结页恢复草稿必须按当前账号/项目 scope 和稳定身份协调',
    );
    assert.match(
      digestJs.text,
      /function resetDraftState\(\)[\s\S]*?page\.filters = \{[\s\S]*?senders: \[\],[\s\S]*?keywords: \[\],[\s\S]*?exclude_types: \[\],[\s\S]*?pending_senders: '',[\s\S]*?pending_keywords: '',[\s\S]*?\};[\s\S]*?page\.minMessages = 1/,
      '总结草稿重置必须清空已提交和待提交筛选并恢复最少消息数默认值',
    );
    assert.match(digestJs.text, /const accountSwitchGuard = \(\) => \{[\s\S]*?page\.generationStarting[\s\S]*?page\.running[\s\S]*?page\.activeBatch[\s\S]*?store\.set\('accountSwitchGuard', accountSwitchGuard\)[\s\S]*?store\.get\('accountSwitchGuard'\) === accountSwitchGuard/, '总结页必须在参数确认、生成和批次结果仍绑定原账号时持有账号切换守卫,卸载时按所有权释放');
    const digestGroupLoadScopeJs = await get('/js/pages/digest/group-load-scope.js');
    assert.equal(digestGroupLoadScopeJs.status, 200, '群列表请求生命周期模块必须 200');
    assert.match(digestJs.text, /createGroupLoadScope[\s\S]*?const groupLoadScope = createGroupLoadScope\(\)[\s\S]*?const operation = groupLoadScope\.begin\(\)[\s\S]*?signal: operation\.signal[\s\S]*?groupLoadScope\.dispose\(\)/, '总结页必须把群列表请求、进度轮询和页面销毁接入统一生命周期');
    assert.match(digestJs.text, /const cancellationMarkers = \[error\?\.code, error\?\.public_code, error\?\.reason, error\?\.message\][\s\S]*?user_button[\s\S]*?statusEl\.textContent = '已取消'/, '用户取消摘要后批次结果必须显示已取消,不能误报为生成失败');

    // 3. bootstrap cookie → session → state 鉴权链路
    const boot = await get(`/?bootstrap=${encodeURIComponent(BOOTSTRAP)}`);
    const setCookie = boot.headers.get('set-cookie') || '';
    assert.equal(boot.status, 200);
    assert.match(setCookie, /wx_summary_bootstrap_[0-9a-f]{16}=/, '/?bootstrap= 必须 Set-Cookie');
    const cookie = setCookie.split(';')[0];
    const badSession = await get('/api/session');
    assert.equal(badSession.status, 403, '无凭据 /api/session 必须 403');
    assert.ok(badSession.text.includes('invalid_bootstrap_token'));
    const sessionRes = await get('/api/session', { headers: { cookie } });
    const sessionData = JSON.parse(sessionRes.text);
    assert.equal(sessionRes.status, 200, '带 cookie /api/session 必须 200');
    assert.ok(sessionData.token && sessionData.service_instance_id && sessionData.asset_version);

    const authHeaders = { 'x-wx-token': sessionData.token, 'x-wx-asset-version': sessionData.asset_version };
    const state = await get('/api/state', { headers: authHeaders });
    const stateData = JSON.parse(state.text);
    assert.equal(state.status, 200, '/api/state 必须 200');
    assert.equal(stateData.ok, true);
    assert.ok(Object.hasOwn(stateData, 'need_setup') && Object.hasOwn(stateData, 'wechat'));

    // 4. 目录逃逸一律 403/404
    for (const evil of ['/..%2f..%2fsrc/main.js', '/js/..%2f..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/src/main.js', '/js/../../../src/main.js']) {
      const response = await get(evil);
      assert.ok([403, 404].includes(response.status), `目录逃逸 ${evil} 必须 403/404(实际 ${response.status})`);
    }

    // 5. 版本闸门:过期 asset_version 调 /api/groups 必须 409 stale_frontend_asset
    const stale = await get('/api/groups?account=x', {
      headers: { 'x-wx-token': sessionData.token, 'x-wx-asset-version': 'sha256-0000000000000000' },
    });
    assert.equal(stale.status, 409, '过期 asset_version 必须 409');
    assert.ok(stale.text.includes('stale_frontend_asset'));

    console.log('web frontend mount checks passed');
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref();
    await new Promise(resolve => child.on('exit', resolve));
    await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  console.error('web frontend mount 验收失败:', error);
  process.exitCode = 1;
});
