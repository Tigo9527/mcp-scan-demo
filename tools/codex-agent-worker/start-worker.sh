#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z ${1:-} ]]; then
  echo "用法: $0 '<自动任务启动链接>'" >&2
  echo "示例: $0 'http://localhost:8003/api/tasks/<token>'" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/worker.mjs" "$1"
