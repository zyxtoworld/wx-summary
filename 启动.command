#!/usr/bin/env bash
# wx-summary macOS 启动器：双击即可
set -u

cd "$(dirname "$0")" || exit 1

# Terminal 双击 .command 时 PATH 可能没有 Homebrew / nvm；
# Homebrew 的版本化 Node LTS 公式可能是 keg-only，所以也补 opt 路径。
export PATH="/opt/homebrew/opt/node@24/bin:/usr/local/opt/node@24/bin:/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:/opt/homebrew/opt/node@20/bin:/usr/local/opt/node@20/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# nvm/asdf 启动脚本可能读取未设置变量；source 时暂时关闭 nounset，避免双击启动中断。
set +u
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
[ -s "$HOME/.asdf/asdf.sh" ] && . "$HOME/.asdf/asdf.sh"
set -u

pause_exit() {
  echo
  read -r -n 1 -s -p "按任意键退出..." || true
  echo
}

echo "wx-summary 启动中..."

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 20+。"
  pause_exit
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  echo "当前 Node.js 版本过低：$(node -v 2>/dev/null || echo unknown)。请升级到 Node.js 20+。"
  pause_exit
  exit 1
fi

if ! node scripts/check-dependencies.mjs >/dev/null 2>&1; then
  echo "依赖缺失、过期或与当前 Node.js 不兼容，正在自动安装..."
  if command -v npm >/dev/null 2>&1; then
    npm ci
  elif command -v corepack >/dev/null 2>&1; then
    corepack npm ci
  else
    echo "未找到 npm 或 corepack。请先安装 Node.js 20+。"
    pause_exit
    exit 1
  fi
  if [ $? -ne 0 ]; then
    echo "依赖安装失败，请检查网络后重试。"
    pause_exit
    exit 1
  fi
  if ! node scripts/check-dependencies.mjs --write-stamp; then
    echo "依赖安装后验证失败，请检查 Node.js 版本后重试。"
    pause_exit
    exit 1
  fi
fi

node src/main.js
status=$?
echo
if [ "$status" -eq 0 ]; then
  echo "服务已停止。"
else
  echo "服务异常退出（exit $status）。"
fi
pause_exit
exit "$status"
