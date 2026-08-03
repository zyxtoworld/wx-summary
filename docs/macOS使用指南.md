# macOS 使用指南

> 本指南专为 macOS 用户编写。Windows 用户请参考 [用户手册](用户手册.md)。

## 系统要求

- 操作系统：macOS 13+（Ventura、Sonoma、Sequoia、Tahoe 26 或更新的正式版；完整结论仍需真机记录）
- Node.js：20.0.0 或更高版本
- 微信客户端：macOS 版微信 4.1.9
- 磁盘空间：至少 500 MB 可用空间
- AI 接口：OpenAI / Anthropic 兼容端点

## 快速开始

### 1. 安装 Node.js

推荐使用 Homebrew 或 nvm。

使用 Homebrew：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node

# 如果想固定当前 LTS，而不是跟随 Homebrew 默认 node，可选：
# brew install node@24
# export PATH="$(brew --prefix node@24)/bin:$PATH"
# 或在需要兼容较长维护窗口时使用：
# brew install node@22
# export PATH="$(brew --prefix node@22)/bin:$PATH"
node --version
```

使用 nvm：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install --lts
nvm use --lts
node --version
```

`node --version` 应显示 `v20.x.x` 或更高版本；Node.js 20 是最低兼容线，
不是推荐锁定的旧版本。`启动.command` 会自动补齐 Homebrew 的默认
`bin` 路径，以及 `/opt/homebrew/opt/node@24/bin`、
`/usr/local/opt/node@24/bin`、`/opt/homebrew/opt/node@22/bin`、
`/usr/local/opt/node@22/bin` 等版本化 LTS 路径；脚本仍保留
`/opt/homebrew/opt/node@20/bin`、`/usr/local/opt/node@20/bin`
兼容旧机器，方便双击启动时找到可用的 Node.js 20+。

### 2. 启动工具

双击项目根目录的 `启动.command`，或先在 Terminal 中进入项目根目录，再运行：

```bash
./启动.command
```

首次启动会自动执行 `npm ci` 安装依赖。启动成功后，浏览器会打开实际服务
URL；默认是 `http://127.0.0.1:7788`，端口被占用时会顺延，按 Terminal
输出的 `✓ 服务：http://127.0.0.1:<port>` 为准。服务运行在 Terminal
窗口中，退出时按 `Ctrl+C`。

### 3. 获取数据库密钥

macOS 版当前不支持自动提取微信数据库密钥，必须手动填写。本项目不
捆绑、不调用、也不推荐特定第三方取 key 工具。PyWxDump、WeChatExporter
等社区工具的可用性、平台兼容性和合规风险会随时间变化；使用前请自行
确认当前版本是否支持 macOS、是否符合你的授权和使用边界。

只要你已经通过可信、合规且只读的方式拿到数据库 key，导出的 key 可能是
64/96/128/160/192 位十六进制字符串、`x'...'`、`0x...`、all_keys.json 片段
或 192 位导出 blob；如果工具导出多条 key，请全部粘贴到手动密钥输入框，
每行一条。

填写方式：

1. 打开网页设置页，找到“隐私与安全”。
2. 将“手动密钥候选”切换为保存手动候选。
3. 粘贴 64/96/128/160/192 位 hex、`x'...'`、`0x...`、all_keys.json
   片段或 192 位导出 blob。
4. 点击保存。
5. 回到总结页刷新群列表；程序会在需要时自动把当前账号数据库复制/刷新到 `data/wxdb-mirror`。
6. 如果自动准备连续失败，回到生成、生成文本预览或刷新群列表的进度卡点击“重试自动准备副本”。

## 功能说明

### 核心功能（手动密钥 + 自动项目副本后）

以下功能已有跨平台实现路径。macOS 真机验证时仍需用当前 Mac 微信账号、
正确手动密钥、已由真实读取自动准备的 `data/wxdb-mirror` 项目副本和真实小时间窗逐项记录结果。

| 功能 | 说明 |
| --- | --- |
| 读取群列表 | 自动准备项目副本后显示本机微信群，支持搜索和拼音首字母 |
| 消息采集 | 读取文本、引用、图片、文件、视频、语音和音频元信息 |
| AI 摘要生成 | 调用你配置的 OpenAI / Anthropic 兼容端点 |
| 前端长图生成 | 使用浏览器 Canvas 生成 PNG 长图 |
| 下载 PNG | 保存到项目 `outputs/digests/` |
| 历史记录 | 查看、搜索、打开历史摘要 |
| 在文件夹中显示 | 请求 Finder `open -R` 显示目标文件；Finder 可见、目标 PNG 选中、窗口置前需真机确认 |
| 配置管理 | 所有普通设置都在网页里完成 |
| 加密存储 | API Key 和手动密钥写入 `data/secrets.bin` 加密包，Keychain 条目 `wx-summary.secrets` 提供本机包装密钥 |

### 功能限制

| 功能 | Windows | macOS | 替代方案 |
| --- | --- | --- | --- |
| 自动密钥提取 | 支持 | 不支持 | 使用自行评估过的只读第三方方式手动获取 |
| 后台服务端 PNG | 支持 | 不支持 | 页面手动历史重渲染改用浏览器 Canvas；定时任务需要服务端 PNG 时仍受限 |
| 历史重渲染 | 浏览器 Canvas | 浏览器 Canvas，待真机 | 先预览最终 PNG，再由本地服务校验版本并另存，原版保留 |
| 历史缩略图 | 支持 | 实现路径，待真机 | Node 便携 PNG 缩略图；仍可直接查看原图 |
| 图片复制 | 浏览器剪贴板 + Windows 系统兜底 | 浏览器剪贴板视权限而定；无系统兜底 | 下载 PNG 后手动分享 |
| 系统托盘 | 支持 | 不支持 | 保持 Terminal 窗口运行 |

这些限制属于便利功能差异，不等同于核心链路已完成真机证明。手动密钥正确后，
仍需在 macOS 真机上逐项记录“读取群聊消息 -> AI 摘要 -> Canvas 长图 -> 下载 PNG”
是否按预期完成。
实际可用性以目标 Mac 上的验证结果为准。
后台服务端 PNG 和系统剪贴板图片复制兜底在 macOS 上应返回
`501` 或在页面显示明确“不支持/仅支持 Windows”的提示；页面手动历史重渲染应走浏览器 Canvas，历史缩略图应走便携 PNG 路径；浏览器图片剪贴板
是否可用取决于浏览器和权限。真机验证时请核对实际提示文本，避免把无响应
误判成已知限制。

## 使用流程

### 首次配置

1. 双击 `启动.command`。
2. 在首次向导中配置 AI Provider、Base URL、API Key 和模型。
3. 使用自行评估过的只读第三方方式获取数据库手动密钥。
4. 在设置页保存手动密钥。
5. 在总结页刷新群列表，让程序自动准备项目副本；只有自动准备连续失败时，才在当前进度卡点击“重试自动准备副本”。
6. 回到总结页读取群列表，选择常用群或设置白名单。

### 生成摘要

1. 在总结页选择一个或多个群。
2. 选择“昨天”“今天”“最近 24h”或自定义时间范围。
3. 可选填写发送人、关键词、消息类型过滤。
4. 点击“生成长图”或“生成文本预览”；需要文件时，在文本预览区再点“导出 MD”。
5. 等待进度完成后预览长图。
6. 点击“下载 PNG”保存结果。

### 查看历史

1. 打开“历史”页。
2. 搜索群名、日期或账号。
3. 点击历史记录查看完整长图。
4. 需要分享时下载 PNG 文件。

## 常见问题

### Q1：为什么提示“需要填写手动密钥”？

这是正常现象。macOS 当前不支持自动密钥提取。请先自行评估第三方工具或
教程的 macOS 兼容性、授权边界和合规风险，再用只读方式导出数据库 key，
然后在设置页保存手动密钥。

### Q2：手动密钥保存后仍然打不开数据库？

常见原因是 key 不属于当前微信账号、数据库版本变化、只填了一条 key
但 contact/session/message 分库 key 不同。请重新导出，并把所有候选
key 都粘贴进去，每行一条。

### Q3：密钥可以保存在哪里，安全吗？

网页保存的 API Key 和手动密钥会写入 `data/secrets.bin` 加密包；成功验证的数据库密钥候选会按账号指纹写入 `data/wxdb-keys.bin` 加密缓存，减少服务重启后的重复验证。macOS Keychain 不直接保存这些密钥，只保存 `wx-summary.secrets` 本机包装密钥材料。
删除任一加密文件或 Keychain 条目后，对应旧密文都可能无法解开。
不要把 `data/`、`outputs/` 或导出的明文 key 提交到公开仓库。

### Q4：历史页为什么没有缩略图？

macOS 使用 Node 便携 PNG 路径生成缩略图，不依赖 Windows PowerShell/GDI+。
若某条记录没有缩略图，通常是源 PNG 已移动、损坏、权限不足或缩略图请求被取消；点击卡片仍可尝试查看原图，页面也会显示具体错误。

### Q5：为什么有时不能复制图片到剪贴板？

当前页面会先尝试浏览器图片剪贴板；这受浏览器、权限和安全上下文影响。
Windows 还有系统剪贴板兜底，macOS 没有这个兜底。失败时请使用“下载 PNG”，
然后在 Finder 或聊天窗口中手动拖放/上传。

### Q6：如何退出工具？

在运行 `启动.command` 的 Terminal 窗口按 `Ctrl+C`。也可以关闭该
Terminal 窗口，服务会退出并清理临时文件。

### Q7：支持 Apple Silicon 吗？

支持。Node.js 20、SQLCipher 依赖和前端 Canvas 都可以在 Apple Silicon
上运行。请优先安装原生 arm64 Node.js。

### Q8：浏览器打不开本地服务 URL 怎么办？

确认 Terminal 中服务没有报错；如果端口被占用，服务会顺延使用下一个
可用端口，按 Terminal 输出的 URL 打开。仍失败时运行
`node src/main.js --no-open` 查看详细错误。

## 故障排查

### 启动失败

检查 Node.js：

```bash
node --version
```

检查启动器权限：

```bash
chmod +x 启动.command
```

仓库中的 `启动.command` 已按可执行文件记录；如果通过 zip、网盘或复制
目录拿到项目后双击无反应，先运行上面的 `chmod +x` 再重试。

双击 `.command` 打开的 Terminal 可能拿不到你交互式 shell 里的完整 PATH。
启动器会主动补齐 Homebrew 常见路径，并在 source nvm/asdf 时避免 nounset
中断；如果仍提示找不到 Node.js，请在 Terminal 里执行 `./启动.command`
查看具体输出。

查看详细日志：

```bash
node src/main.js --no-open
```

### 群列表为空

1. 确认 Mac 微信正在运行。
2. 确认当前账号存在 `xwechat_files` 数据目录。
3. 回到总结页刷新群列表，让程序自动准备 `data/wxdb-mirror` 项目副本；如果自动准备连续失败，在当前进度卡点击“重试自动准备副本”。
4. 重新保存手动密钥。
5. 如果有多个微信账号，确认右上角选择的是最近同步的账号。

### 长图生成失败

1. 检查 AI Base URL、API Key 和模型是否可用。
2. 缩短时间范围，避免一次处理过多消息。
3. 确认手动密钥能读取 message 数据库。
4. 改用“生成文本预览”判断问题是 AI 摘要还是 Canvas 长图生成；文本预览不会自动写入 MD。

### 性能较慢

1. 缩短时间范围，优先按天生成。
2. 减少同时选择的群数量。
3. 避免在首次扫描大量媒体时同时运行重负载任务。
4. 检查网络到 AI 端点的延迟。

## 隐私与安全

### 本地数据位置

- 普通配置：`data/settings.json`
- 加密密文文件：`data/secrets.bin`（保存 API Key 和手动密钥的 AES-GCM 加密包）
- 自动数据库密钥缓存：`data/wxdb-keys.bin`（按账号指纹保存验证成功候选的 AES-GCM 加密包）
- Keychain 条目：generic password，service `wx-summary.secrets`，account `wx-summary`（保存本机包装密钥材料）
- 生成长图：`outputs/digests/YYYY-MM-DD/`
- 临时文件：`outputs/.tmp/`

### 安全边界

- API Key 和手动密钥写入 `data/secrets.bin`，自动验证成功的数据库密钥候选写入 `data/wxdb-keys.bin`；macOS Keychain 条目 `wx-summary.secrets` 为两个加密包提供本机包装密钥。
- 服务只监听 `127.0.0.1`。
- 微信数据库源文件只在刷新项目副本时用于复制，查询和解密只操作 `data/wxdb-mirror` 项目副本和 `outputs/.tmp/db` 项目临时副本；自动复用时 DB/WAL 文件集合（SHM 不持久复制）完全一致，且副本为普通文件、大小匹配；源库不可见时拒绝复用旧项目副本，避免过期副本看似成功。
- 不使用协议号、模拟登录、自动发消息或 UI 自动化。
- 摘要只发送你选择的时间窗内容到你配置的 AI 端点。

### 卸载清理

先在 Terminal 中进入项目根目录，再执行：

```bash
rm -rf data/
rm -rf outputs/
rm -rf node_modules/

# 可选：同时删除本机 Keychain 中的 wx-summary 密钥材料
security delete-generic-password -a wx-summary -s wx-summary.secrets 2>/dev/null || true
```

删除前请确认不再需要历史长图和配置。只删除 `data/secrets.bin` 或
`data/wxdb-keys.bin` 不会自动删除 Keychain 里的 `wx-summary.secrets` 条目；
只删除 Keychain 条目也会让这两个旧加密包无法解密。如果要彻底清理本机密钥材料，需删除两个文件并执行上面的 `security delete-generic-password` 命令。

## macOS 真机验证

在实际设备上验证时，先按下面的命令检查平台、Node.js、Keychain 和静态验收，再逐项核对真实群列表、长图、下载、历史原图与 Finder 行为。记录应保存在项目外部，不要提交本机路径、账号、群名、密钥、聊天内容或原始诊断输出。

### 自动验收命令

先在 Terminal 中进入项目根目录，再执行：

```bash
chmod +x 启动.command
./启动.command
```

看到服务 URL / 浏览器打开后，保持这个启动 Terminal 窗口运行；另开一个
Terminal 窗口运行：

```bash
node -p "process.platform"
node -p "process.arch"
node -p "process.versions.node"
node tests/acceptance/static-checks.mjs
node -e "import('./src/config/dpapi.js').then(async m => { const b = await m.protectText('macos-keychain-test'); const text = await m.unprotectToText(b); console.log(text === 'macos-keychain-test' ? 'Keychain OK' : 'Keychain FAIL'); })"
```

`node -p "process.platform"` 应输出 `darwin`；`node -p "process.arch"` 在
Apple Silicon 上应输出 `arm64`，在 Intel Mac 上通常输出 `x64`。
`node -p "process.versions.node"` 应输出 `20.0.0` 或更高版本；这个原始
版本号需要和 Node.js 20+ 判定一起记录。
`static-checks.mjs` 在 macOS 上应看到
`verifyMacOSPlatformSupport`、`verifyMacOSKeychain` 和
`verifyMacOSLimitedFeatures` 三项通过，而不是跳过。
如果运行时没有打开 Mac 微信，`verifyMacOSPlatformSupport` 可以在进程探测
返回“未检测到 Mac 微信”等可读提示时通过；这只证明探测链路和错误提示可用，
完整数据读取验收仍需打开 Mac 微信、填写手动密钥并刷新出真实群列表。
如果进程和数据目录探测超过 15 秒，自动测试会失败并提示超时，需要记录当时
微信是否运行、数据目录是否异常庞大或不可访问。

### 手工验收清单

- Terminal 显示服务 URL，启动过程无报错。
- 设置页能保存 AI API Key 和手动密钥，刷新后仍可解密读取。
- 填写手动密钥并自动准备项目副本后，群列表能刷新并显示当前 Mac 微信账号的群。
- 在总结页刷新群列表触发自动项目副本准备；自动准备连续失败时在当前进度卡点击“重试自动准备副本”，并确认当前账号
  `db_storage` 已复制到 `data/wxdb-mirror`。
- 刷新群列表或生成摘要时，查询和解密只操作 `data/wxdb-mirror`
  项目副本以及 `outputs/.tmp/db` 临时工作副本；副本账号段应为
  `wxacc_<hash>` 脱敏标识，不记录原始 wxid 或账号目录名。源库只复制、不查询/解密；微信源数据库只在刷新项目副本时用于复制；自动复用时 DB/WAL 文件集合（SHM 不持久复制）完全一致，且副本为普通文件、大小匹配；源库不可见时拒绝复用旧项目副本，避免过期副本看似成功，不直接打开源文件执行查询。
- 选择一个小时间窗生成真实前端 Canvas 长图，确认预览和下载 PNG 都可用。
- 历史页能显示缩略图并打开原图；缩略图失败时提示清楚。
- 点击“在文件夹中显示”会请求 Finder `open -R` 显示 PNG；真机需人工确认
  Finder 可见、目标 PNG 选中、窗口置前。
- 后台服务端 PNG、系统剪贴板图片复制兜底等限制项要分别记录入口/动作、HTTP `501` 或按钮禁用状态、实际提示文本和替代路径。
- 历史 Canvas 重渲染要记录最终 PNG 预览、保存后的重渲染版本和原版保留；若浏览器不支持 Canvas/toBlob，记录明确提示。

## 附录：与 Windows 版本的差异

| 特性 | Windows | macOS | 说明 |
| --- | --- | --- | --- |
| 启动器 | `启动.cmd` + 托盘 | `启动.command` + Terminal | macOS 无托盘 |
| 密钥提取 | 自动扫描 + 手动兜底 | 手动填写 | macOS 自动提取未适配 |
| 配置加密 | DPAPI | Keychain 包装密钥 + `data/secrets.bin` 加密包 | 都绑定本机当前用户 |
| 长图生成 | 前端 Canvas | 前端 Canvas | 同一前端路径，需真机记录 |
| 历史重渲染 | 浏览器 Canvas | 浏览器 Canvas，待真机 | 预览与保存使用同一 PNG，原版保留 |
| 历史缩略图 | PowerShell/GDI+ | Node 便携 PNG 缩略图 | 点击查看原图 |
| 图片复制 | 浏览器剪贴板 + Windows API 兜底 | 浏览器剪贴板视权限而定；无系统兜底 | 下载 PNG |
| 在文件夹中显示 | `explorer.exe` | `open -R` 请求 | 已有实现路径；Finder 可见、目标 PNG 选中、窗口置前需真机确认 |

总体评价：macOS 核心功能已有实现路径，主要差异集中在自动密钥提取和少数
系统便利功能；实际可用性以目标 Mac 上的验证结果为准。
