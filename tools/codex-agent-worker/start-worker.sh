#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z ${1:-} || ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  echo "用法: $0 '<自动任务启动链接>'" >&2
  echo "" >&2
  echo "如何获得启动链接：" >&2
  echo "  1. 打开 http://localhost:8003/admin 并登录。" >&2
  echo "  2. 进入目标 Agent 的对话页。" >&2
  echo "  3. 打开‘自动任务’开关，页面会生成并复制启动任务链接。" >&2
  echo "  4. 将复制的完整链接（从 http:// 开始，包含长 token）作为本脚本唯一参数。" >&2
  echo "示例: $0 'http://localhost:8003/api/tasks/<完整启动任务链接>'" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/worker.mjs" "$1"
