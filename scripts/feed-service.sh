#!/bin/zsh
# 本机 bot feed 静态服务（macOS launchd）。只监听 127.0.0.1，开机自启、退出自动拉起。
# 用法：scripts/feed-service.sh install|uninstall|status
# 可选环境变量：XRC_FEED_DIR（默认 ~/x-reply-feed）、XRC_FEED_PORT（默认 8765）
set -euo pipefail

LABEL="com.xreplycontext.feed"
FEED_DIR="${XRC_FEED_DIR:-$HOME/x-reply-feed}"
PORT="${XRC_FEED_PORT:-8765}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/x-reply-feed.log"
PYTHON="/usr/bin/python3"

install_service() {
  [[ -x "$PYTHON" ]] || { echo "未找到 $PYTHON，请先安装 Xcode 命令行工具：xcode-select --install"; exit 1; }
  mkdir -p "$FEED_DIR" "$(dirname "$PLIST")" "$(dirname "$LOG")"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string><string>-m</string><string>http.server</string><string>$PORT</string>
    <string>--bind</string><string>127.0.0.1</string><string>--directory</string><string>$FEED_DIR</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "已安装：http://127.0.0.1:$PORT/feed.json → $FEED_DIR/feed.json"
}

uninstall_service() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载（目录 $FEED_DIR 保留）"
}

status_service() {
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "服务：运行中"; else echo "服务：未安装或未运行"; fi
  echo "目录：$FEED_DIR"
  if [[ -f "$FEED_DIR/feed.json" ]]; then echo "feed.json：$(stat -f '%z 字节，更新于 %Sm' "$FEED_DIR/feed.json")"; else echo "feed.json：尚未生成"; fi
  curl -s -o /dev/null -w "HTTP 检查：%{http_code}\n" "http://127.0.0.1:$PORT/feed.json" || echo "HTTP 检查：无法连接"
}

case "${1:-}" in
  install) install_service ;;
  uninstall) uninstall_service ;;
  status) status_service ;;
  *) echo "用法：$0 install|uninstall|status"; exit 2 ;;
esac
