# CodeBuddy Remote

CodeBuddy Remote 让 iOS App 通过 Relay 控制 Mac 本地长期驻留的 `codebuddy` CLI session。

```text
iOS App <-> Relay <-> Mac codebuddy-remote <-> 本地 codebuddy CLI
```

当前产品口径：

- Mac 本地 `codebuddy` CLI 是唯一 session owner。
- iOS App 只负责发送 prompt、查看事件、发送审批控制键、中断和恢复。
- 手机端统一走 Relay，不直连 Local Host。
- Relay 只转发 E2E `encrypted` payload，不接受明文 `command` / `event` / `response`。
- 不同步源码、完整上下文、凭据或 CodeBuddy 登录态到云端。

## 快速启动

安装本地命令：

```sh
npm install
npm link
```

启动本机 Relay：

```sh
npm run start:relay
```

在目标项目目录启动 Mac Host：

```sh
cd /Users/robiluo/aicoding/drink
CODEBUDDY_REMOTE_RELAY_URL=ws://127.0.0.1:17330/relay codebuddy-remote
```

终端会启动真实 `codebuddy` CLI，并打印 pairing code、二维码和 Pairing URL。iOS 真机可以扫码绑定；iOS 模拟器可用：

```sh
xcrun simctl openurl booted 'cbr://pair?...'
```

## 公网 Relay

公网 Relay 必须配置 token，建议由 Caddy / Nginx / Cloudflare Tunnel 暴露 `wss://`：

```sh
CODEBUDDY_RELAY_HOST=127.0.0.1 \
CODEBUDDY_RELAY_PORT=17330 \
CODEBUDDY_RELAY_TOKEN=<relay-token> \
npm run start:relay
```

Mac 端连接公网 Relay：

```sh
CODEBUDDY_REMOTE_RELAY_URL=wss://<relay-domain>/relay \
CODEBUDDY_REMOTE_RELAY_TOKEN=<relay-token> \
codebuddy-remote
```

`CODEBUDDY_REMOTE_RELAY_TOKEN` 只用于 Mac host 注册 Relay，不进入二维码，也不会由 iOS 保存。

## iOS App

工程位置：

```text
apps/ios/CodeBuddyRemote/CodeBuddyRemote.xcodeproj
```

打开 Xcode 后运行 `CodeBuddyRemote` target。App 支持扫码绑定、粘贴 Pairing URL、Relay 连接、消息展示、活动折叠、历史恢复和受限审批控制键输入。

命令行编译：

```sh
xcodebuild -project apps/ios/CodeBuddyRemote/CodeBuddyRemote.xcodeproj \
  -target CodeBuddyRemote \
  -configuration Debug \
  -sdk iphonesimulator \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## 本地数据

默认本地文件：

```text
~/.codebuddy-remote/history/<workspace>-<sha256(cwd).前16位>.jsonl
~/.codebuddy-remote/devices.json
~/.codebuddy-remote/audit/<workspace>-<sha256(cwd).前16位>.jsonl
```

可用环境变量覆盖：

```sh
CODEBUDDY_REMOTE_HISTORY_FILE=/path/to/events.jsonl
CODEBUDDY_REMOTE_DEVICE_STORE_FILE=/path/to/devices.json
CODEBUDDY_REMOTE_AUDIT_FILE=/path/to/audit.jsonl
```

历史文件只保存 normalized semantic events，不保存原始 TUI 刷新帧。

## 目录

- `apps/local-host/`：Mac 本地控制面和 CLI adapter。
- `apps/relay/`：WebSocket Relay。
- `apps/ios/CodeBuddyRemote/`：原生 iOS App。
- `packages/protocol/`：统一 command/event 协议。
- `tests/`：Node 测试。
- `docs/`：当前方案、安全流程和 archive。

## 验证

```sh
npm test
node --test tests/relay.test.mjs
```

## 文档

- `docs/codebuddy-remote-final-plan.md`：当前权威方案和 Backlog。
- `docs/security-and-pairing-flow.md`：安全设计、扫码绑定和 Relay 登录流程。
- `docs/archive/`：历史探索结论和探针，只用于追溯。
