#!/usr/bin/env bash
# wx-summary macOS 启动器：双击即可
set -u

cd "$(dirname "$0")" || exit 1

# Terminal 双击 .command 时 PATH 可能没有 Homebrew / nvm。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
[ -s "$HOME/.asdf/asdf.sh" ] && . "$HOME/.asdf/asdf.sh"

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

if [ ! -d "node_modules" ]; then
  echo "首次启动：正在安装依赖，请稍候..."
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
