# CodeBuddy 手机远程控制方案

本项目整理 CodeBuddy 手机远程控制的最终方案、探索材料和验证探针。

## 最终方案

请优先阅读：

- `reports/codebuddy-remote-final-plan.md`

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
- `reports/codebuddy-remote-final-plan.md`：当前最终方案。
- `reports/archive/`：精简探索摘要、探针脚本和探针扩展。
- `reports/archive/tools/codebuddy-ide-probe.mjs`：CodeBuddy IDE 静态探针脚本。
- `reports/archive/probes/codebuddy-mobile-bridge-extension/`：VS Code 兼容 IDE bridge 探针扩展。
- `reports/archive/probes/vsix/`：探针扩展 VSIX 打包元数据。

## 本地运行

当前主入口是 `codebuddy-remote`：在目标项目目录执行它，就等价于在该目录启动一个真实的前台 `codebuddy` CLI，同时额外开启给 iOS App 使用的 Local API。

```sh
npm test
codebuddy-remote
```

默认地址：

```text
http://127.0.0.1:17320
```

如果还没有安装本地命令，可以在本仓库执行一次：

```sh
npm link
```

`codebuddy-remote` 使用系统 `python3` 创建伪终端；macOS 自带的 Xcode Command Line Tools Python 即可。需要指定 Python 路径时可设置 `CODEBUDDY_REMOTE_PYTHON`。

例如在 `/Users/robiluo/aicoding/drink` 目录执行：

```sh
cd /Users/robiluo/aicoding/drink
codebuddy-remote
```

启动后终端会打印 Local API 候选地址和 token。局域网模式下，手机和电脑需要在同一局域网，在 iOS App 里填写形如：

```text
http://<电脑局域网IP>:17320
```

Token 填启动时打印的 `Local Token`。

`codebuddy-remote` 会由 Local Host 通过伪终端启动并复用一个长期驻留的 `codebuddy` 进程。这个 CodeBuddy 进程显示在当前终端里，所以本地仍能看到 CLI 界面输出并继续键盘交互；iOS App 会把 prompt 写入同一个终端 session。当前工作目录就是 CodeBuddy workspace。

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
- `POST /api/sessions/:id/interrupt`
- `POST /api/sessions/:id/resume`
- `GET /api/events`
- `GET /api/events/stream`

`codebuddy-remote` 已验证支持长期驻留多轮对话：多轮 prompt 复用同一个 ACP session 和同一个 `conversationId`。

## Relay 模式

Relay 是应用层中转服务，适合手机和 Mac 不在同一个局域网时使用：

```text
iOS App <-> codebuddy-relay <-> Mac codebuddy-remote <-> 本地 codebuddy CLI
```

启动一个 Relay：

```sh
npm run start:relay
```

默认监听：

```text
ws://0.0.0.0:17330/relay
```

如果需要 Relay token：

```sh
CODEBUDDY_RELAY_TOKEN=<relay-token> npm run start:relay
```

Mac 端连接 Relay：

```sh
cd /Users/robiluo/aicoding/drink
CODEBUDDY_REMOTE_RELAY_URL=ws://<relay-host>:17330/relay \
CODEBUDDY_REMOTE_PAIRING_CODE=123456 \
CODEBUDDY_REMOTE_RELAY_TOKEN=<relay-token> \
codebuddy-remote
```

iOS App 里切到 `Relay` 模式，填写 Relay 地址、配对码和可选 Relay token。Relay 只接受 `command`、`event`、`response` 三类应用层 payload，不暴露本地 HTTP 端口，也不提供任意 TCP 转发。

## iOS App

原生 iOS 客户端位于：

```text
apps/ios/CodeBuddyRemote/CodeBuddyRemote.xcodeproj
```

打开工程后运行 `CodeBuddyRemote` target。局域网模式下，在 App 内输入 Mac 端启动 `codebuddy-remote` 后打印的局域网 URL 和 token；Relay 模式下，输入 Relay URL 和配对码。App 会订阅事件流、显示终端输出，并把手机输入发送到同一个长期驻留的 CodeBuddy CLI session。

本仓库的命令行编译验证：

```sh
xcodebuild -project apps/ios/CodeBuddyRemote/CodeBuddyRemote.xcodeproj \
  -target CodeBuddyRemote \
  -configuration Debug \
  -sdk iphonesimulator \
  CODE_SIGNING_ALLOWED=NO \
  build
```

当前本机没有可用 iOS Simulator runtime，所以 scheme 运行和 UI 启动验证需要先在 Xcode > Settings > Components 安装 iOS runtime。

## 下一步

进入 M1/M2：

- 把 `serve` adapter 从“ACP 请求完成后回放”升级为“边读 ACP SSE 边实时推送 normalized events”。
- 验证 CodeBuddy CLI 的 permission request / approval / rejection 行为。
- 补齐工具审批事件和 `approveTool` / `rejectTool`。
