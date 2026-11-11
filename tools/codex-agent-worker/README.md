# Codex Agent Worker

这是独立于网站 `src/` 的 Linux worker。它接收网站生成的自动任务启动链接，读取其中的轮询凭证，先回报启动状态，再每 10 秒轮询任务；任务交给 `codex exec`，后续任务用 `codex exec resume <session-id>` 复用同一会话，最终结果 POST 到任务的 `report.url`。

启动链接不是手填的 token：登录 `/admin`，进入目标 Agent 对话页，打开“自动任务”开关，页面生成并复制的“请阅读这个任务……”链接就是启动链接。把其中完整的 `http://localhost:8003/api/tasks/...` URL 传给脚本即可。

## 使用

```bash
tools/codex-agent-worker/start-worker.sh 'http://localhost:8003/api/tasks/<启动任务凭证>'
```

状态默认写入当前目录的 `codex-agent-worker-state.json`，可用 `CODEX_WORKER_STATE` 指定。`CODEX_WORKER_POLL_MS` 和 `CODEX_WORKER_IDLE_MS` 可调整轮询与空闲停止时间。空闲一小时后 worker 保存 `startUrl`、`pollUrl`、`sessionId` 和停止原因并退出；下次使用保存的启动链接即可恢复。Codex 的执行事件会以 `[codex]` 前缀写入 stdout，便于 systemd/journal 收集进度。

部署时建议用 systemd 的 `Restart=on-failure` 和专用工作目录运行；启动链接与轮询 token 属于凭证，不要写入公开日志或提交仓库。
