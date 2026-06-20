# CodeBuddy 手机远程控制方案

本项目整理 CodeBuddy 手机远程控制的最终方案、探索材料和验证探针。

## 最终方案

请优先阅读：

- `docs/codebuddy-remote-final-plan.md`

一句话结论：

```text
本地 CodeBuddy CLI / IDE = session owner
iOS App = control endpoint
Local Host / Relay = 安全连接与事件转发层
```

推荐路线：

1. 先做 CLI 本地闭环。
2. 再做 CLI 审批闭环。
3. 然后验证 IDE Bridge 的事件流和审批链路。
4. 最后统一 CLI / IDE 两条路径。

## 当前决策

- 不做手机独立 companion agent。
- 不把源码、完整上下文或凭据同步到云端。
- 手机端只允许发送 prompt、查看事件、审批工具调用、中断和恢复任务。
- CLI 是第一阶段主线。
- IDE 作为第二阶段产品化能力，前提是能稳定订阅 assistant/tool/permission 事件。

## 目录

- `apps/local-host/`：本地控制面服务，支持 mock adapter 和真实 CodeBuddy CLI adapter。
- `apps/relay/`：应用层 WebSocket Relay，只转发 CodeBuddyRemote command/event，不做通用端口穿透。
- `apps/ios/CodeBuddyRemote/`：原生 iOS 控制端，连接本机 `codebuddy-remote`。
- `packages/protocol/`：统一 command/event 协议工具。
- `tests/`：协议和 Local Host 行为测试。
- `docs/README.md`：文档入口和读取顺序。
- `docs/codebuddy-remote-final-plan.md`：当前最终方案。
- `docs/security-and-pairing-flow.md`：安全设计、扫码绑定和登录流程。
- `docs/archive/`：精简探索摘要、探针脚本和探针扩展。
- `docs/archive/tools/codebuddy-ide-probe.mjs`：CodeBuddy IDE 静态探针脚本。
- `docs/archive/probes/codebuddy-mobile-bridge-extension/`：VS Code 兼容 IDE bridge 探针扩展。
- `docs/archive/probes/vsix/`：探针扩展 VSIX 打包元数据。

## 本地运行

当前主入口是 `codebuddy-remote`：在目标项目目录执行它，就等价于在该目录启动一个真实的前台 `codebuddy` CLI，同时通过 Relay 暴露给 iOS App。产品上只保留 Relay 模式；Local Host 仍作为 Mac 端内部控制面存在，不再作为手机端连接方式。

```sh
npm test
CODEBUDDY_REMOTE_RELAY_URL=ws://127.0.0.1:17330/relay codebuddy-remote
```

本地调试时先启动 Relay：

```sh
npm run start:relay
```

如果还没有安装本地命令，可以在本仓库执行一次：

```sh
npm link
```

`codebuddy-remote` 使用系统 `python3` 创建伪终端；macOS 自带的 Xcode Command Line Tools Python 即可。需要指定 Python 路径时可设置 `CODEBUDDY_REMOTE_PYTHON`。

例如在 `/Users/robiluo/aicoding/drink` 目录执行：

```sh
cd /Users/robiluo/aicoding/drink
CODEBUDDY_REMOTE_RELAY_URL=ws://127.0.0.1:17330/relay codebuddy-remote
```

启动后终端会打印 Relay 地址、短期配对码和一张配对二维码。推荐在 iOS App 里点 `扫码绑定` 直接扫描二维码，App 会自动填入 Relay 配置并连接。二维码内容是短期 `cbr://pair` 配对 URL，包含 Relay URL、配对码、配对密钥、workspace、host 和过期时间。

`codebuddy-remote` 会由 Local Host 通过伪终端启动并复用一个长期驻留的 `codebuddy` 进程。这个 CodeBuddy 进程显示在当前终端里，所以本地仍能看到 CLI 界面输出并继续键盘交互；iOS App 会把 prompt 写入同一个终端 session。当前工作目录就是 CodeBuddy workspace。

Local Host 会把语义事件追加写入本机 JSONL 历史文件，`codebuddy-remote` 重启后 iOS App 仍可回放历史消息。默认路径按 workspace 生成：

```text
~/.codebuddy-remote/history/<workspace>-<sha256(cwd).前16位>.jsonl
```

例如在 `/Users/robiluo/aicoding/drink` 下启动，文件名会类似 `drink-<hash>.jsonl`。如果两个目录都叫 `drink`，完整路径 hash 会让它们落到不同文件。需要显式指定历史文件时：

```sh
CODEBUDDY_REMOTE_HISTORY_FILE=/path/to/events.jsonl codebuddy-remote
```

历史文件只保存 normalized semantic events，不保存原始 `terminal.output` 刷新帧，避免 TUI 输出把历史撑爆。

绑定设备列表默认保存在：

```text
~/.codebuddy-remote/devices.json
```

需要显式指定设备库时：

```sh
CODEBUDDY_REMOTE_DEVICE_STORE_FILE=/path/to/devices.json codebuddy-remote
```

安全审计日志默认保存在：

```text
~/.codebuddy-remote/audit/<workspace>-<sha256(cwd).前16位>.jsonl
```

需要显式指定审计日志时：

```sh
CODEBUDDY_REMOTE_AUDIT_FILE=/path/to/audit.jsonl codebuddy-remote
```

如需换端口：

```sh
CODEBUDDY_REMOTE_PORT=17322 codebuddy-remote
```

开发调试时也可以显式启动 Local Host：

```sh
CODEBUDDY_REMOTE_ADAPTER=serve npm run start:local-host
```

短进程 CodeBuddy CLI 只作为对照测试：

```sh
CODEBUDDY_REMOTE_ADAPTER=real npm run start:local-host
```

`real` 模式使用 `codebuddy -p --output-format stream-json`，每次 prompt 启动一个 CLI 进程，不是目标的长期驻留形态。

如需换开发调试端口：

```sh
CODEBUDDY_REMOTE_ADAPTER=real CODEBUDDY_REMOTE_PORT=17321 npm run start:local-host
```

已实现 API：

- `GET /api/sessions`
- `GET /api/sessions/:id/state`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/input`
- `POST /api/sessions/:id/interrupt`
- `POST /api/sessions/:id/resume`
- `GET /api/events`
- `GET /api/events/stream`
- `POST /api/devices/bind`
- `GET /api/devices`
- `PATCH /api/devices/:id`
- `POST /api/devices/:id/revoke`
- `GET /api/audit`

`codebuddy-remote` 已验证支持长期驻留多轮对话：多轮 prompt 复用同一个 ACP session 和同一个 `conversationId`。

## Relay 模式

Relay 是唯一的手机连接方式：

```text
iOS App <-> codebuddy-relay <-> Mac codebuddy-remote <-> 本地 codebuddy CLI
```

公网部署时 Relay 必须启用 token。先生成一个强随机 token：

```sh
openssl rand -base64 32
```

在公网服务器上启动 Relay。推荐让 Node 只监听本机，再由 Caddy / Nginx / Cloudflare Tunnel 暴露 `wss://`：

```sh
CODEBUDDY_RELAY_HOST=127.0.0.1 \
CODEBUDDY_RELAY_PORT=17330 \
CODEBUDDY_RELAY_TOKEN=<relay-token> \
npm run start:relay
```

本地调试可以直接监听：

```text
ws://127.0.0.1:17330/relay
```

如果要直接监听公网地址，`CODEBUDDY_RELAY_TOKEN` 不能为空；否则服务会拒绝启动。只在临时本机测试时才使用：

```sh
CODEBUDDY_RELAY_ALLOW_INSECURE=1 npm run start:relay
```

不要在公网使用 `CODEBUDDY_RELAY_ALLOW_INSECURE=1`。

Mac 端连接 Relay：

```sh
cd /Users/robiluo/aicoding/drink
CODEBUDDY_REMOTE_RELAY_URL=wss://<relay-domain>/relay \
CODEBUDDY_REMOTE_RELAY_TOKEN=<relay-token> \
codebuddy-remote
```

`CODEBUDDY_REMOTE_RELAY_TOKEN` 只用于 Mac host 向 Relay 注册，不会写入二维码。启动后 Mac 终端会打印 `Pairing` 和二维码；二维码里包含 Relay 地址、短期配对码和短期配对密钥。配对密钥默认随机生成；需要固定时可设置 `CODEBUDDY_REMOTE_RELAY_PAIRING_SECRET`。配对码默认有效 120 秒，并且已配对后不再允许第二台手机复用同一个配对码。iOS App 首次加入 Relay 时会登记本机设备，后续同一设备可以用设备级 HMAC 重连。手动连接时，在 iOS App 里填写 Relay 地址、配对码和配对密钥即可。

如果使用扫码绑定，App 会自动填入 Relay URL、配对码和配对密钥，并连接到对应 Mac host。

iOS 模拟器不能直接使用 Mac 摄像头扫码，可以复制终端里二维码下方的 `Pairing URL`，然后用 deep link 打开：

```sh
xcrun simctl openurl booted 'cbr://pair?...'
```

也可以在 App 的连接设置里把 `Pairing URL` 粘贴到 `粘贴 Pairing URL` 输入框。

Relay 只接受 CodeBuddyRemote E2E `encrypted` 应用层 payload：Mac/iOS 通道会把 `command`、`event`、`response` 封装进加密信封，Relay 只看到路由信息和密文。Relay 不暴露本地 HTTP 端口，也不提供任意 TCP 转发。手机端的终端输入也被限制为单个审批控制键，例如 `1` / `2` / `3`，不能通过该接口发送任意 shell 文本。

## iOS App

原生 iOS 客户端位于：

```text
apps/ios/CodeBuddyRemote/CodeBuddyRemote.xcodeproj
```

打开工程后运行 `CodeBuddyRemote` target。推荐使用右上角菜单或连接设置里的 `扫码绑定` 扫描 Mac 端 `codebuddy-remote` 打印的二维码；也可以手动输入 Relay URL、配对码和配对密钥。App 会订阅事件流、显示终端输出，并把手机输入发送到同一个长期驻留的 CodeBuddy CLI session。连接设置会显示当前 host、workspace 和绑定状态。

本仓库的命令行编译验证：

```sh
xcodebuild -project apps/ios/CodeBuddyRemote/CodeBuddyRemote.xcodeproj \
  -target CodeBuddyRemote \
  -configuration Debug \
  -sdk iphonesimulator \
  CODE_SIGNING_ALLOWED=NO \
  build
```

可以使用 XcodeBuildMCP / Xcode 命令行在已安装的 iOS Simulator runtime 上执行 `CodeBuddyRemoteTests`，覆盖 Markdown 解析和消息分组逻辑。

## 下一步

进入 M1/M2：

- 把 `serve` adapter 从“ACP 请求完成后回放”升级为“边读 ACP SSE 边实时推送 normalized events”。
- 验证 CodeBuddy CLI 的 permission request / approval / rejection 行为。
- 补齐工具审批事件和 `approveTool` / `rejectTool`。
