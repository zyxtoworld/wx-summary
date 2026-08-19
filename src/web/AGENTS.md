# 前端开发约定

本目录(src/web/)是微信群总结工具的**唯一前端**。零 npm 依赖、零构建步骤:原生 ES module + 手写 CSS。所有 UI 文案与代码注释一律简体中文。

## 红线

- 不许新增 npm 依赖、不许引入构建步骤、不许引外部 CDN/字体/图片资源(图标用内联 SVG 或 Unicode)。
- `/api/*` 契约以 `src/main.js` 实际代码为准,不许改后端来迁就前端。
- **`public/js/shared/` 下的模块会被前端、Node 后端或 tests 直接 import**(`digest-view-model.js` 被 src/main.js、src/renderer/output.js、src/renderer/server-png.js 引用;`unicode-text.js` 被 src/main.js、src/config/settings.js、src/renderer/output.js 引用;其余被多个 tests/*.mjs 引用)。改动它们的导出必须全局同步,默认**不改**。
- 页面私有样式写自己页面的 css 文件(经页面模块 `css` 字段注入);设计系统与壳样式在 `public/css/app.css`。

## 目录结构

```
src/web/
  views/index.html            # 单页壳:左侧导航 + #app 内容区 + 全局进度条(占位符 __SESSION_TOKEN__/__SERVICE_INSTANCE_ID__/__ASSET_VERSION__ 由服务端替换)
  public/css/app.css          # 设计系统(CSS 变量双主题)+ 壳样式 + 总结页样式
  public/css/{history,settings,setup}.css   # 页面样式(页面模块 css 字段注入)
  public/js/main.js           # bootstrap:主题/会话/初始 state/账号切换器/版本闸门/路由表
  public/js/session.js        # /api/session 握手(sessionStorage 键见下)
  public/js/api.js            # createApi:统一 fetch 封装
  public/js/store.js          # createStore:键值状态容器
  public/js/router.js         # hash 路由 + 页面动态加载 + 离开守卫(串行执行,防双挂载)
  public/js/theme.js          # 亮/暗/自动三态
  public/js/ui/{index,toast,modal,spinner}.js
  public/js/shared/           # 前后端共享模块(见红线)
  public/js/pages/digest/     # 总结页
  public/js/pages/history/    # 历史页
  public/js/pages/settings/   # 设置页
  public/js/pages/setup/      # 首次配置向导
```

## 页面插件接口

`main.js` 显式注册 `digest/history/settings/setup` 四个生产路由;未知路由回落到 `digest`。
模块必须默认导出:

```js
export default {
  title: '页面名',                 // 用于 document.title:`页面名 · 微信群总结`
  css: '/css/xxx.css',             // 可选;router 去重注入 <link>,只增不删
  async mount(el, ctx) {           // el = #app 内容根(已被清空)
    // 返回可选的清理函数,等价于 unmount
    return () => {};
  },
  async unmount() {},              // 可选;路由切换时先调用,再调 mount 返回值
  async canLeave(nextRoute) {},    // 可选离开守卫;返回 false 阻止切换(如生成进行中)
};
```

`ctx = { api, store, navigate, ui, session }`:

- `api`:`createApi` 实例(见下)。
- `store`:壳层共享状态。键:`'state'`(/api/state 响应)、`'stateAccountContext'`(最近一次按账号读取 state 的账号 ID/指纹)、`'accounts'`(publicAccount 数组)、`'account'`(当前选中账号)。页面用 `store.subscribe('account', fn)` 响应账号切换。
- `navigate(target)`:`navigate('#/history')` 或 `navigate('history')`。
- `ui`:见"UI 原语"。
- `session`:会话模块,一般只需要 `session.currentServiceInstanceId()`。

路由串行执行:当前页 `canLeave` → 当前页 `unmount` + 清理 → 清空 `#app` → 加载目标页模块 → 注入 `css` → `mount`;切换期间到来的新路由排队,只保留最新一个。**页面自己的异步回调必须用 token/AbortController 防护,unmount 后不得再写 DOM。**
import 失败时 router 自动渲染"页面加载失败 + 错误信息"占位,页面无需处理。

## api.js 用法

```js
// ctx.api 已注入,不要自己 createApi。
await api.get('/api/state');
await api.get('/api/groups?account=xxx', { signal, timeoutMs: 600000 });
await api.post('/api/recent-groups', { groups: [...] });          // 对象自动 JSON + Content-Type
await api.post('/api/digest-batch-start', body, { signal });
const resp = await api.postStream('/api/digest', body, { signal }); // 原始 Response,自解 SSE
await api.postRaw('/api/save-render', pngBytes, {                  // 原始字节 + 元数据头
  'Content-Type': 'image/png',
  'x-wx-save-metadata': encodeURIComponent(JSON.stringify(metadata)),
  'x-wx-batch-id': batchId,
  'x-wx-batch-token': batchToken,
}, { timeoutMs: 180000, localActionId: metadata.local_action_id });
```

- 自动携带:`X-WX-Token`(会话令牌)、`X-WX-Asset-Version`(版本闸门)。
- **错误对象 shape**:`Error & { status, code, payload, responseText, outcomeUnknown? }`。
  `payload` 是解析后的错误 JSON(`{ ok:false, status, error, code? }`),`error.message` 已是服务端中文文案。
- **409 `stale_frontend_asset` / `service_restart_required`**:api 层已接管(守卫式重载 / 重启提示),页面不用处理,但仍会原样抛出以中断当前操作。
- **403 `invalid_token`**:自动重建会话重试一次;仍失败弹"会话已失效"。
- **写操作(非 GET)网络层失败(超时/断连)**:`error.outcomeUnknown === true`。
  UI 必须表述为"结果未知,请核对后再决定是否重试",**绝不说成功,也绝不自动重试**。
- 499 = 取消(AbortError,`error.name === 'AbortError'`);429 = 槽位满;413 = 超限;428 = 缺前置参数。
- 默认超时 90s;长任务传 `timeoutMs` 或用自己的 AbortController。

## store 用法

```js
store.get('account');                       // 读
store.set('account', next);                 // 写(同引用不触发)
const off = store.subscribe('account', (value, prev) => {});  // 订阅,返回退订函数
store.subscribe('*', (key, value) => {});   // 通配
```

## UI 原语(ctx.ui)

- `ui.toast(msg, { type: 'info'|'success'|'warn'|'error', duration })`、`toastSuccess/toastWarn/toastError`(`duration: 0` = 不自动消失)。
- `ui.openModal({ title, content(Node|string), actions: [{ label, kind: 'primary', danger, onClick(modalApi) }], dismissible, wide, onClose })` → `{ close, el }`;action 的 onClick 返回 `false` 阻止自动关闭。
- `ui.confirmDialog({ title, message, confirmLabel, cancelLabel, danger })` → `Promise<boolean>`。
- `ui.spinner(size)`、`ui.skeletonRows(n)`、`ui.setGlobalProgress(visible, value0to1|null)`。

## 主题

`theme.js` 三态 `light|dark|auto`,localStorage 键 `wx-summary:theme`。
样式只用 CSS 变量(`var(--bg-elevated)` 等),实际生效主题在 `:root[data-theme-resolved]` 上切换。
Canvas 渲染取当前主题:`import { currentResolvedTheme } from '/js/theme.js'`。

## storage 键清单

| 键 | 存储 | 用途 |
| --- | --- | --- |
| `wx-summary:session-token:{origin}` | sessionStorage | 会话令牌 |
| `wx-summary:service-instance:{origin}` | sessionStorage | 服务实例 ID |
| `wx-summary:bootstrap-token:{origin}` | sessionStorage | 启动令牌 |
| `wx-summary:asset-reload:{version}` | sessionStorage | 版本闸门防重载死循环 |
| `wx-summary:interrupted-digest-batch:{origin}` | localStorage | 中断摘要批次恢复记录(version 5 格式) |
| `wx-summary:interrupted-digest-batch:{origin}:claim:{batch_id}` | localStorage | 跨标签恢复短期 claim(仅 owner/时间,不含摘要内容) |
| `wx-summary:digest-drafts:v1:{origin}` | sessionStorage | 总结页草稿(digest-draft-store) |
| `wx-summary:theme` | localStorage | 主题 |
| `wx-summary:confirmed-account-id` | localStorage | 当前账号 |
| `wx-summary.browser-clipboard-journal.v1` | localStorage | 浏览器剪贴板 journal(shared 模块持有) |
| `wx-summary:history-view:{origin}` | localStorage | 历史页视图状态 |
| `wx-summary:history-item-updated:{origin}` | localStorage | 历史项跨标签更新通知 |

## shared/ 模块清单(前后端共享)

- `digest-view-model.js` — 摘要渲染/Markdown 视图模型(49 个导出;长图与 MD 必须用它保证内容一致:`digestRenderViewModel`、`normalizeDigestForRender`、`digestMarkdown`、`digestMarkdownForDigests`)。**后端 renderer 也依赖**。
- `unicode-text.js` — 孤代理对修复/安全截断。**后端也依赖**。
- `response-reader.js` — 限字节读取响应。
- `cross-tab-task-runner.js`、`settings-write-coordinator.js` — Web Locks 跨标签页任务协调与设置写串行化。
- `digest-draft-store.js` — 草稿读写(schema 有界校验)。
- `digest-batch-policy.js`、`digest-recovery-supersession.js`、`digest-stage-paint-queue.js` — 批次失败策略/恢复取代/阶段绘制队列。
- `clipboard-write-coordinator.js` — 浏览器剪贴板写入协调(`submitBrowserClipboardWriteLocked`;`clipboard_outcome_unknown` 语义)。
- `browser-clipboard-journal.js` — 浏览器剪贴板取证 journal。
- `local-action-recovery-state.js` — `classifyLocalActionRecovery(result)` → `'verified'|'committed_unverified'|'pending'|'failed'`。
- `browser-download-capability.js`、`local-date-time.js`、`numeric-input.js`、`settings-runtime-sync.js`、`shared-request-lease.js`。

前端 import 方式:`import { ... } from '/js/shared/<模块>.js'`(绝对路径)。

## 后端契约要点(必须到 src/main.js 核实,以下为索引)

- 鉴权:`GET /api/session`(bootstrap 凭据:query/header `x-wx-bootstrap`/cookie 三选一)→ `{ token, service_instance_id, asset_version, started_at }`;之后所有 `/api/*` 带 `x-wx-token`。
- 版本闸门:写操作 + 部分 GET(`/api/groups`、`/api/history` 等)要求 `x-wx-asset-version`,否则 409。`/api/state`、`/api/accounts`、`/api/session`、`/api/group-progress/*` 不在闸门内。
- 所有 POST/PUT/PATCH/DELETE 必须 `Content-Type: application/json`(api.js 已处理);例外:`/api/save-render`、`/api/preview-rerender-history` 是原始 PNG。
- `local_action_id` 没有签发端点:前端生成(`createLocalActionId(kind)`,格式 `/^[a-z0-9][a-z0-9_-]{5,80}$/i`),随 body 提交,响应回显需校验一致。
- 摘要批次协议:见 `pages/digest/batch-runner.js` 顶部注释与 main.js 21097-21491 行;严格按 start → 逐群 SSE → 心跳 15s → finish/cancel 执行,断流用 `/api/digest-result` 确定性恢复。
- 保存 PNG:`POST /api/save-render` 元数据头 `x-wx-save-metadata`(encodeURIComponent 的 JSON,必含 `render{theme,font_size,accent_color}`、`batch_id`、`batch_token`、`service_instance_id`、`local_action_id`、`generation_id`+`generation_token`(来自 digest 事件的 `__generation`)、`digest_id`、`account_label`)。
- 高阈值:`min_messages >= 100` 必须带 `high_min_messages_confirmation` 整数等于 min_messages(main.js:2472)。

## 本地验证

- 语法:`for f in $(find src/web -name '*.js'); do node --input-type=module --check < "$f"; done`
- 挂载/资源/鉴权链路:`node tests/web-frontend-mount.mjs`(起隔离实例,自动覆盖 import 图)。
- 冒烟:不得动 7788 生产实例。用 `WX_SUMMARY_ACCEPTANCE_MODE=1` + `WX_SUMMARY_ACCEPTANCE_DATA_DIR=outputs/.tmp/web-dev-xxx` + `WX_SUMMARY_BOOTSTRAP_TOKEN=<固定>` spawn `node src/main.js --no-open --port <起始>`(验收模式不写 server.json,从 stdout 解析端口;结束后推荐测试脚本直接 kill 子进程)。
- 回归:`node tests/acceptance/static-checks.mjs` 必须绿。
