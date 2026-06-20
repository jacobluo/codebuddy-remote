# CodeBuddy 手机远程控制最终方案

Generated: 2026-06-19

## 结论

采用“本地 CodeBuddy session owner + 手机远程控制端”的方案。

```text
手机 Web/App
  ↓
安全控制通道 Relay / Tunnel / P2P
  ↓
Local Host
  ├─ CLI Adapter → CodeBuddy CLI session
  └─ IDE Adapter → CodeBuddy IDE bridge extension → CodeBuddy / Genie session
```

核心原则：

- 本地 CodeBuddy CLI / IDE 持有完整 session、workspace、上下文和权限系统。
- 手机只负责提交 prompt、展示事件、审批工具调用、中断或恢复任务。
- Relay / Tunnel 只做安全转发，不保存 prompt、diff、terminal output 等敏感内容。
- CLI 和 IDE 统一成一套手机端协议，前端不关心底层 session 来源。

不采用“手机独立 companion agent”。那条路线会引入上下文同步、源码镜像、凭据复制、权限扩散和 session 一致性问题。

## 目标边界

### P0 必须完成

- 手机向本地活动 session 发送 prompt。
- 手机实时接收 assistant 回复、tool call、terminal output、diff 摘要和状态变化。
- 手机审批或拒绝高风险工具调用。
- 手机中断、恢复、查看 busy/running 状态。
- 本地 Host 重启、网络断开、手机刷新后能恢复连接。
- 远程控制显式配对、可撤销、可审计。

### P1 后置

- 手机查看完整历史消息。
- 多项目、多 workspace 同时在线。
- IDE 与 CLI session 无缝迁移。
- 手机端编辑复杂 diff。
- 多设备同时控制同一个本地 session。

### 明确不做

- 不把项目源码同步到云端 Relay。
- 不让手机直接执行本地 shell 命令。
- 不让手机直接读写任意本地文件。
- 不把探针扩展里的任意 command execution 暴露到正式产品。
- 不依赖 CodeBuddy 私有 bundle 内部实现作为长期稳定接口。

## 实施路线

### M1: CLI 本地闭环

目标：先证明手机能稳定控制本地 CLI session。

```text
codebuddy-remote
  ↓
CodeBuddy CLI
  ↓
CLI Adapter
  ↓
Local Host
  ↓
手机 Web
```

范围：

- 用户在目标项目目录执行 `codebuddy-remote`，该目录就是 CodeBuddy workspace。
- `codebuddy-remote` 通过伪终端以前台交互模式启动长期驻留的 `codebuddy`，本地终端保留 CodeBuddy CLI 界面输出和键盘交互。
- `codebuddy-remote` 同时启动手机 Web 控制端，手机 prompt 写入同一个 CodeBuddy 终端 session。
- `listSessions`
- `selectSession`
- `sendPrompt`
- `streamEvents`
- `getState`
- `interrupt`
- `resume`

验收标准：

- 手机端发送 prompt 后，本地 CLI session 继续执行。
- 手机端能看到 assistant 流式回复。
- 手机断网、刷新或重连后能恢复当前 session 状态。
- Local Host 能维护 session registry 和当前 busy/running 状态。
- Relay 或 tunnel 层不持久化敏感正文。

### M2: CLI 审批闭环

目标：让手机端安全处理高风险工具调用。

范围：

- 解析 CLI 侧 permission request。
- 输出统一的 `tool.permissionRequested` 事件。
- 支持 `approveTool` / `rejectTool`。
- 本地记录轻量审计日志。

验收标准：

- 手机收到工具审批卡片。
- 用户可 `allow_once` 或 `deny`。
- 审计日志记录设备、session、request id、选择和时间。
- 默认不提供长期 `allow_always`。

### M3: IDE Bridge 事件验证

目标：把 IDE 从“可注入 prompt”推进到“可观测 session”。

```text
CodeBuddy IDE / Genie
  ↓
Bridge Extension
  ↓
Local Host
  ↓
手机 Web
```

范围：

- Bridge extension 改为白名单 API，不保留通用 `/exec`。
- 验证 assistant message stream。
- 验证 tool call / diff / terminal output event stream。
- 验证 permission request 和 approval/rejection 链路。
- 验证 conversation id 与当前 IDE session 的绑定。
- 验证 IDE reload、sleep、restart 后恢复能力。

验收标准：

- 至少能稳定订阅 assistant message chunk。
- 能可靠读取当前 session state。
- 能明确判断 IDE 权限审批是否可产品化。
- 输出 IDE capability matrix。

如果 IDE 事件订阅无法稳定获得，IDE Bridge 降级为轻量能力：手机可发送 prompt，结果仍主要在桌面 IDE 查看。

### M4: 双轨统一

目标：CLI 和 IDE 共用同一套手机端协议。

范围：

- CLI Adapter 和 IDE Adapter 输出同构事件。
- Local Host 做事件归一化、去重、短期重放和 state snapshot。
- 手机端支持选择 CLI / IDE session。
- session 绑定 workspace fingerprint 和用户确认机制。

验收标准：

- 手机端不需要理解 CLI/IDE 内部实现。
- 断线后可按 `seq` 重放事件或恢复 snapshot。
- prompt 不会发到错误 workspace 或错误 session。

## Local Host 设计

Local Host 是本地统一控制面。

职责：

- 管理本地 session registry。
- 管理手机配对、设备 token 和撤销。
- 接入 CLI Adapter / IDE Adapter。
- 归一化 command 和 event。
- 维护 event seq、短期 ring buffer 和 state snapshot。
- 执行本地安全策略。
- 记录轻量审计日志。

不做：

- 不保存完整聊天历史，除非用户显式开启本地日志。
- 不绕过 CodeBuddy 自身权限系统。
- 不开放任意 shell、任意 IDE command 或任意文件读写。
- 不向 Relay 暴露明文敏感内容。

本地 API 只监听 `127.0.0.1` 或 Unix domain socket。对手机远程访问必须经过配对后的安全通道。

## 统一协议

### Commands

```json
{
  "type": "command",
  "id": "cmd_...",
  "sessionId": "local_session_...",
  "name": "sendPrompt",
  "payload": {
    "text": "继续上一个任务",
    "mode": "craft"
  }
}
```

命令集合：

- `listSessions`
- `selectSession`
- `sendPrompt`
- `approveTool`
- `rejectTool`
- `interrupt`
- `resume`
- `getState`
- `openInDesktop`

### Events

```json
{
  "type": "event",
  "id": "evt_...",
  "sessionId": "local_session_...",
  "conversationId": "chat_...",
  "seq": 42,
  "name": "assistant.delta",
  "payload": {
    "text": "正在检查文件..."
  }
}
```

事件集合：

- `session.created`
- `session.selected`
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
- `connection.resumed`

### Approval

```json
{
  "type": "event",
  "name": "tool.permissionRequested",
  "sessionId": "local_session_...",
  "payload": {
    "requestId": "approval_...",
    "tool": "execute_command",
    "risk": "high",
    "title": "运行 shell 命令",
    "summary": "即将在当前项目目录执行 npm test",
    "options": ["allow_once", "deny"]
  }
}
```

审批选项：

- `allow_once`
- `deny`
- `allow_for_session`

默认不提供 `allow_always`。如果未来支持，必须绑定 tool、workspace、command pattern 和过期时间。

## 安全模型

### 配对

- 首次连接由桌面端显示一次性配对码或二维码。
- 配对码短期有效，例如 60 到 120 秒。
- 配对成功后发放设备级 token。
- 用户可在桌面端查看、重命名、撤销已配对设备。

### 通道

优先级：

1. 本地同网直连 / P2P。
2. 用户显式开启的 tunnel。
3. Relay 转发。

Relay 要求：

- 不持久化消息正文。
- 不记录 prompt、diff、terminal output。
- 只保留必要连接元数据和错误指标。
- 支持端到端加密时，Relay 只见密文。

### 手机端权限

允许：

- 发送 prompt。
- 读取 normalized events。
- 审批当前 pending request。
- interrupt / resume。
- 查看 session state。

禁止：

- 执行任意 IDE command。
- 执行任意 shell 命令。
- 直接读写任意本地文件。
- 修改 CodeBuddy 配置、登录态或扩展列表。

### 审计

Local Host 本地保存轻量审计日志：

- 设备连接和断开。
- prompt command 的时间、设备、session id、长度摘要。
- approval request 和用户选择。
- interrupt / resume。
- 错误和异常断连。

审计日志默认不保存完整 prompt 和输出内容。

## 已探索结论简化

### CLI

结论：适合作为第一阶段主线。

已发现能力线索：

- `--serve`
- `--session-id`
- `--resume` / `--continue`
- `--bg` / `--background`
- `ps` / `logs` / `attach` / `kill`
- `--remote-control`
- `--input-format stream-json`
- `--output-format stream-json`

下一步重点不是继续列 flag，而是做真实行为验收：stream-json schema、permission request 表达、interrupt 方式和 background session 管理。

### IDE

结论：产品价值高，但应作为第二阶段风险包。

已验证：

- CodeBuddy IDE 可安装第三方 VS Code 兼容扩展。
- 扩展能看到并调用 Genie / CodeBuddy command。
- `tencentcloud.codingcopilot.chat.sendMessage` 可注入 prompt，并返回 conversation id、user message 和 agent running 状态。
- `getWebviewInfo`、`checkChatRunning`、`isAgentBusy`、`getContext` 可用于状态探测。

未闭环：

- assistant stream。
- tool call / diff / terminal log stream。
- permission request event。
- approval/rejection 稳定 API。
- IDE restart / reload 后恢复。

### 探针扩展

结论：只用于验证，不进入正式产品。

当前探针暴露：

- `GET /health`
- `GET /probe`
- `GET /commands`
- `GET|POST /exec`

正式 Bridge 必须删除通用 `/exec`，替换成白名单 API。

## 主要风险与处理

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| IDE 事件订阅拿不到 | 手机无法实时展示 IDE 回复和工具状态 | M3 前置验证，失败则 IDE 降级 |
| IDE 审批 API 不公开 | 手机无法审批 IDE 工具调用 | CLI 先闭环；IDE 争取官方 API 或产品侧小改 |
| Relay 边界不清 | 远程控制变成本地执行入口 | 配对、E2E、白名单、审计、可撤销 |
| 会话绑定错误 | prompt 发到错误 workspace/session | session registry、workspace fingerprint、用户确认 |
| 断线重连丢事件 | 手机状态与本地不一致 | event seq、ring buffer、state snapshot |
| 内部 command 变更 | IDE Bridge 版本脆弱 | capability probe、版本矩阵、降级策略 |

## 最终建议

立即推进 M1/M2。

原因：

- CLI 路线最快验证产品价值。
- 安全、配对、Relay、移动端 UX 可以先完整闭环。
- IDE prompt 注入已经验证，后续重点是事件订阅和审批，不应阻塞 MVP。

判断标准：

- M1/M2 成功：产品方向具备可用 MVP。
- M3 成功：IDE 远程控制可产品化。
- M3 失败：保留 CLI Remote Control 为主产品，IDE 只做轻量 prompt bridge。

## 当前实现状态

已完成 M1 骨架：

- `packages/protocol/`：统一 command/event 协议工具。
- `apps/local-host/`：Local Host HTTP/SSE 服务。
- `apps/mobile-web/`：最小手机 Web 控制台。
- `tests/`：协议、session、prompt、event、interrupt/resume 和鉴权测试。
- `TerminalCliAdapter`：通过 macOS 伪终端启动真实 `codebuddy` CLI，本地终端保留 CodeBuddy 原生界面和键盘交互，手机 prompt 写入同一个终端 session。
- `ServeCliAdapter`：保留为探索/对照路径，通过 `codebuddy --serve` + ACP HTTP 接口接入 CodeBuddy session，但不作为默认入口。
- `RealCliAdapter`：保留为短进程对照路径，通过 `codebuddy -p --output-format stream-json --max-turns 1` 接入真实 CodeBuddy CLI。

当前 `codebuddy-remote` 默认接入 `TerminalCliAdapter`。用户在目标项目目录执行 `codebuddy-remote` 后，当前终端会进入真实 CodeBuddy CLI；手机 Web 端通过 Local Host 发送 prompt，并通过 `terminal.output` 事件查看终端输出。

`server.mjs` 仍可用于开发调试：默认 mock adapter；设置 `CODEBUDDY_REMOTE_ADAPTER=real` 可切换短进程 `RealCliAdapter`；设置 `CODEBUDDY_REMOTE_ADAPTER=serve` 可切换 ACP `ServeCliAdapter`。

真实验证结论：

- `codebuddy --serve` 前台输出不是用户熟悉的聊天 TUI，且会把 ACP/JSON 更新吐到终端，因此不适合作为默认“像直接运行 codebuddy”的入口。
- 伪终端方案能保持真实 `codebuddy` CLI 前台界面，并允许手机端把 prompt 注入同一个终端 session。
- `TerminalCliAdapter` 当前按终端输出流推送 `terminal.output`，不伪造结构化 `assistant.delta`。

下一步需要继续验证 permission request、approval/rejection、终端输出分段展示和手机端 interrupt 对真实 CodeBuddy TUI 的行为。
