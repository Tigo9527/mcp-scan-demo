#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
用法：bash scripts/run-cfx-tracker.sh [--top-zero]

默认抓取最近三个日历月的币安 CFX 追踪数据；--top-zero 仅补抓
次数排名前 100 中转入次数为 0 的地址。可用 CFX_TRACKER_FROM、
CFX_TRACKER_UNTIL、CFX_TRACKER_DB 或 DATA_DIR 设置范围与存储位置。
中断或失败后用相同命令重跑：未完成的时间范围保持不变，
Core 地址从已提交的分页检查点续抓；已完成区间自动跳过。
EOF
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  ''|--top-zero) ;;
  *) usage >&2; exit 2 ;;
esac
if (( $# > 1 )); then usage >&2; exit 2; fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
for command_name in node npm curl flock; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '缺少命令：%s\n' "$command_name" >&2
    exit 1
  fi
done

if [[ ! -x node_modules/.bin/tsx ]]; then
  printf '安装 npm 依赖…\n'
  npm ci
fi

# 通过 dotenv 解析路径，保持与同步脚本及 Web 服务一致；环境变量优先于 .env。
db_path="$(node -r dotenv/config -e 'const path=require("node:path"); console.log(path.resolve(process.env.CFX_TRACKER_DB ?? path.resolve(process.env.DATA_DIR ?? "./data", "cfx-tracker.sqlite")))')"
export CFX_TRACKER_DB="$db_path"
mkdir -p "$(dirname "$db_path")"
exec 9>"$db_path.sync.lock"
if ! flock -n 9; then
  printf '已有同步任务在运行：%s\n' "$db_path" >&2
  exit 1
fi

printf '仓库：%s\n数据库：%s\n开始同步…\n' "$repo_dir" "$db_path"
npm run cfx:sync -- "$@"

node -r dotenv/config <<'NODE'
const sqlite3 = require('sqlite3');
const db = new sqlite3.Database(process.env.CFX_TRACKER_DB, sqlite3.OPEN_READONLY);
db.all('SELECT space, COUNT(*) AS count FROM transfers GROUP BY space ORDER BY space', (error, rows) => {
  db.close();
  if (error) { console.error(error); process.exitCode = 1; return; }
  console.log('同步完成，当前转移记录数：');
  for (const row of rows) console.log(`  ${row.space}: ${row.count}`);
  const base = (process.env.PUBLIC_BASE_URL ?? process.env.BASE_URL ?? '').replace(/\/+$/, '');
  console.log(base ? `页面：${base}/cfx-tracker` : '页面路径：/cfx-tracker（请加上部署域名）');
});
NODE
