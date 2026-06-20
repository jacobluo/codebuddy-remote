# CodeBuddy Remote 最终方案

Updated: 2026-06-21

## 一句话结论

CodeBuddy Remote 是“Mac 本地 CodeBuddy CLI session owner + iOS 远程控制端 + Relay 安全转发”的方案。

```text
iOS App
  <-> Relay WebSocket + device HMAC + E2E encrypted payload
  <-> Mac codebuddy-remote
  <-> Local Host
  <-> TerminalCliAdapter
  <-> 本地长期驻留 codebuddy CLI
```

当前产品方案统一为 Relay 模式。Local Host 仍存在，但只是 Mac 端内部控制面，不再作为手机端直连入口。

## 当前决策

- 用户在目标 workspace 执行 `codebuddy-remote`，就等价于在该目录启动一个真实的长期驻留 `codebuddy` CLI。
- Mac 终端保留原始 CodeBuddy CLI 界面输出和本地键盘交互。
- iOS App 通过 Relay 向同一个 CLI session 发送 prompt、查看 normalized events、发送审批控制键、中断和恢复。
- Relay 不做通用端口穿透，不暴露 Mac Local HTTP API，不接受明文 `command` / `event` / `response` payload。
- 正式 Mac/iOS 业务 payload 只走 `encrypted` 信封，Relay 只看到路由元数据和密文。
- 不做手机独立 companion agent，不把源码、完整上下文、凭据或 CodeBuddy 登录态同步到云端。
- IDE Bridge 探索材料保留在 `docs/archive/`，不作为当前实现主线。

## 已实现范围

### Mac CLI Host

代码位置：

- `apps/local-host/src/codebuddy-remote.mjs`
- `apps/local-host/src/terminal-cli-adapter.mjs`
- `apps/local-host/src/local-host.mjs`
- `apps/local-host/src/relay-client.mjs`
- `apps/local-host/src/relay-e2e.mjs`

已实现：

- `codebuddy-remote` 要求配置 `CODEBUDDY_REMOTE_RELAY_URL`，缺少时不生成 pairing URL 并退出。
- 默认用 `TerminalCliAdapter` 通过 macOS 伪终端启动真实 `codebuddy`。
- 当前终端显示真实 CodeBuddy CLI TUI，手机 prompt 写入同一个终端 session。
- Local Host 提供内部 HTTP/SSE 控制面和统一 command/event 处理。
- 事件按 `seq` 编号，支持 `listEvents` 窗口查询和重连回放。
- semantic events 写入本地 JSONL 历史文件，重启后可恢复历史。
- 原始 `terminal.output` 刷新帧不写入历史，避免 TUI 输出撑爆存储。
- 本地设备库和审计日志写入 `~/.codebuddy-remote/`。

### Relay

代码位置：

- `apps/relay/src/relay.mjs`
- `apps/relay/src/server.mjs`

已实现：

- WebSocket endpoint：`/relay`。
- health endpoint：`/health`。
- Host 注册可用 `CODEBUDDY_RELAY_TOKEN` 保护；公网监听时必须配置 token，除非显式设置本机调试开关。
- Pairing code 默认短期有效，已配对后不允许第二个 client 复用。
- Pairing secret 只存 hash，用于首次 join 校验。
- 设备登记后，iOS 可用设备级 HMAC 在 pairing 过期后重新 join。
- Relay join nonce 有窗口内 replay cache。
- Relay frame payload 只接受 `type: "encrypted"`，明文 `command` / `event` / `response` 会被拒绝。
- Relay 限制 frame size，并对 pairing 失败做简单限速。

### iOS App

代码位置：

- `apps/ios/CodeBuddyRemote/CodeBuddyRemote/`
- `apps/ios/CodeBuddyRemote/CodeBuddyRemoteTests/`

已实现：

- Relay-only 连接配置。
- 扫码读取 `cbr://pair?...`，也支持在模拟器里粘贴 Pairing URL 或用 deep link 打开。
- 拒绝旧的 `mode=local` pairing URL。
- 生成 `deviceId + deviceSecret + deviceName`，`deviceSecret` 保存到 Keychain。
- Relay join 使用 pairing secret 或设备 HMAC。
- Mac/iOS E2E：`P-256 KeyAgreement -> HKDF-SHA256 -> ChaCha20-Poly1305`。
- AppStorage 保存 Relay 配置、host/workspace 和 UI 聊天缓存。
- 聊天消息按 ChatGPT/Codex 风格展示：用户气泡、assistant Markdown、工具/命令/测试/计划/diff/权限活动卡片。
- 工具和思考过程完成后折叠为活动组，可点击展开。
- 输入框默认单行，支持显式换行和 `+` 操作菜单。
- 连接设置显示 mode、workspace、host 和绑定状态。

### 协议和测试

代码位置：

- `packages/protocol/src/index.mjs`
- `tests/`

已实现命令：

- `listSessions`
- `listEvents`
- `sendPrompt`
- `sendTerminalInput`
- `interrupt`
- `resume`
- `getState`

协议中还保留但当前 Local Host 尚未产品化处理的命令：

- `selectSession`
- `approveTool`
- `rejectTool`
- `openInDesktop`

已实现事件：

- `session.created`
- `session.state`
- `user.message`
- `assistant.delta`
- `assistant.completed`
- `tool.requested`
- `tool.output`
- `tool.permissionRequested`
- `tool.permissionResolved`
- `diff.created`
- `terminal.output`
- `error`

## 运行流程

### 1. 启动 Relay

本机调试：

```sh
npm run start:relay
```

公网部署建议让 Node 监听本机，再由 Caddy / Nginx / Cloudflare Tunnel 暴露 `wss://`：

```sh
CODEBUDDY_RELAY_HOST=127.0.0.1 \
CODEBUDDY_RELAY_PORT=17330 \
CODEBUDDY_RELAY_TOKEN=<relay-token> \
npm run start:relay
```

### 2. 在目标项目启动 Mac Host

```sh
cd /Users/robiluo/aicoding/drink
CODEBUDDY_REMOTE_RELAY_URL=wss://<relay-domain>/relay \
CODEBUDDY_REMOTE_RELAY_TOKEN=<relay-token> \
codebuddy-remote
```

启动后终端会显示：

- workspace
- internal Local Host 地址
- history/device/audit 文件路径
- Relay URL
- pairing code
- 二维码
- Pairing URL

### 3. iOS 绑定

真机：

- 打开 iOS App。
- 点击扫码绑定。
- 扫描 Mac 终端二维码。

模拟器：

```sh
xcrun simctl openurl booted 'cbr://pair?...'
```

或把 Pairing URL 粘贴到 App 的连接设置里。

## 安全模型

### 信任边界

- CodeBuddy CLI / workspace / 登录态 / 权限系统全部留在 Mac 本地。
- iOS 只持有 Relay 连接配置、短期 pairing 信息和本机 device credential。
- Relay 只转发应用层密文，不保存 prompt、diff、terminal output 或 response 正文。
- Local Host 管理 API 只作为 Mac 内部控制面使用；管理 token 请求要求本机来源。

### 配对和设备身份

- Pairing URL 只生成 `mode=relay`。
- Pairing URL 包含短期 `pairingCode` 和 `pairingSecret`，二维码应视为短期敏感凭证。
- Relay token 只用于 Mac host 注册，不进入二维码，不由 iOS 保存。
- 首次 join 可登记设备凭证。
- 后续同一设备可用 HMAC 重新 join，并受 timestamp、nonce 和 replay cache 保护。
- Mac 端支持设备列表、重命名、撤销 API。

### 端到端加密

Relay join 阶段交换临时公钥：

```text
P-256 KeyAgreement -> HKDF-SHA256 -> ChaCha20-Poly1305
```

正式 command/event/response 都封装为：

```json
{
  "type": "encrypted",
  "version": 1,
  "alg": "P256-HKDF-SHA256-CHACHA20-POLY1305",
  "seq": 1,
  "nonce": "...",
  "ciphertext": "..."
}
```

Relay 只校验信封结构并转发，不解密正文。

### 手机端禁止能力

- 不能发送任意 shell 命令。
- 不能读取任意本地文件。
- 不能写入任意本地文件。
- 不能调用任意 IDE command。
- 不能修改 CodeBuddy 登录态、配置或扩展列表。

`sendTerminalInput` 只接受单个审批控制键，例如 `1` / `2` / `3` / `y` / `n` / `q`。

## 本地持久化

Mac 默认路径：

```text
~/.codebuddy-remote/history/<workspace>-<sha256(cwd).前16位>.jsonl
~/.codebuddy-remote/devices.json
~/.codebuddy-remote/audit/<workspace>-<sha256(cwd).前16位>.jsonl
```

可通过环境变量覆盖：

```sh
CODEBUDDY_REMOTE_HISTORY_FILE=/path/to/events.jsonl
CODEBUDDY_REMOTE_DEVICE_STORE_FILE=/path/to/devices.json
CODEBUDDY_REMOTE_AUDIT_FILE=/path/to/audit.jsonl
```

iOS 默认持久化：

- Relay 配置、workspace、host 和聊天展示缓存：`AppStorage`。
- device secret：Keychain。

## 和历史方案的差异

已废弃或降级的内容：

- 不再把 Local 直连作为手机端产品模式。
- 不再保留 Relay 明文 command/event/response 兼容路径。
- 不再把 Tunnel / P2P 作为当前推荐链路。
- 不把 `codebuddy --serve` 作为默认入口；它保留为探索/对照 adapter。
- 不把 `codebuddy -p` 短进程模式作为产品入口；它只用于测试对照。
- IDE Bridge 不进入当前 MVP，相关探针和结论只保存在 archive。

保留的探索资产：

- `docs/archive/exploration-summary.md`
- `docs/archive/tools/`
- `docs/archive/probes/`

这些材料只用于追溯，不作为当前实现事实来源。

## 后续 Backlog

这些事项不影响当前 Relay-only MVP 成立。进入实现前，需要重新确认目标、验收标准和测试范围。

### P0: 当前实现相邻

- 历史消息性能回归：已补 1200 条消息的模型层单元/性能回归；后续继续做模拟器或真机滚动、输入和恢复实测。
- Markdown 展示优化：继续补齐 code block、table、tree 输出等高频展示场景。

### P1: 协议产品化

- 真实 permission 结构化：把 CodeBuddy CLI 的 permission request 稳定映射为 `tool.permissionRequested`。
- 结构化审批命令：在真实 permission 行为稳定后，再实现 `approveTool` / `rejectTool`；在此之前继续使用受限的 `sendTerminalInput` 控制键。
- `openInDesktop`：明确安全边界、可用场景和失败行为后再开放。

### P2: 运维增强

- Relay 观测指标：只记录连接数、错误数、frame 尺寸和频率，不记录正文。
- 公网部署模板：补充 Caddy / Nginx / Cloudflare Tunnel 的 `wss://` 示例。
- Relay 设备持久化评估：当前设备登记主要依赖 Mac 本地设备库，是否需要 Relay 侧跨 host 持久化另行决策。

## 验收清单

- 在目标目录执行 `codebuddy-remote` 后，本地终端出现真实 CodeBuddy CLI。
- iOS 扫码后能连接对应 workspace 和 host。
- iOS prompt 会进入同一个长期驻留 CLI session。
- iOS 能收到 assistant、tool、diff、terminal、state 等 normalized events。
- 工具/思考过程完成后默认折叠，手动可展开。
- 断线或重启后，iOS 可通过 `listEvents` 回放历史 semantic events。
- Pairing URL 只包含 Relay 模式。
- iOS 拒绝 Local 旧二维码。
- Relay 明文 payload 被拒绝。
- Relay frame 中不出现 prompt 或 terminal output 明文。
- 设备 HMAC 重连可用，重复 nonce 被拒绝。
- Mac 可导出 audit log。

## 相关文档

- `README.md`：运行方式和目录说明。
- `docs/security-and-pairing-flow.md`：安全设计与登录流程。
- `docs/archive/README.md`：探索资料入口。
