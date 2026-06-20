# 安全设计与登录流程

Generated: 2026-06-20

## 目标

CodeBuddy Remote 的安全目标是让手机可以控制本地 CodeBuddy session，但不扩大成本地任意执行入口。

核心约束：

- CodeBuddy CLI / IDE 仍是 session owner，完整 workspace、上下文、登录态和权限系统都留在 Mac 本地。
- iOS App 只做控制端：发送 prompt、查看 normalized events、审批当前 permission、中断和恢复任务。
- 产品上只保留 Relay 模式；Local Host 是 Mac 端内部控制面，不再作为手机端连接方式。
- Relay 只转发 CodeBuddyRemote 协议消息，不做通用 TCP 端口穿透，不保存 prompt、diff、terminal output。
- 配对必须显式、短期有效、可撤销，并尽量减少长期共享 token 的使用。

## 术语

- Local Host：`codebuddy-remote` 启动的本地 HTTP/SSE 控制面，只供 Mac 端内部 adapter、测试和管理 API 使用。
- Relay：公网或内网中转服务，只转发应用层 `encrypted` payload。
- Relay Token：Mac host 注册 Relay 时使用的服务端 token，不进入扫码 Pairing URL。
- Device Credential：iOS App 生成的 `deviceId + deviceSecret`，用于 Relay 设备登记、HMAC 重连和本地持久身份。
- Pairing URL：`cbr://pair?...`，由 Mac 端二维码承载，短期有效。

## 信任边界

```text
iOS App
  | Relay WebSocket + pairing code/secret + device HMAC + E2E encrypted payload
  v
codebuddy-relay
  v
Mac codebuddy-remote Local Host
  v
TerminalCliAdapter
  v
本地 codebuddy CLI session
```

边界说明：

- iOS App 到 Relay 是公网边界。短期 pairing code 和 pairing secret 只证明可以加入转发会话，不代表可以直接访问 Mac 本地 HTTP API。
- Relay 到 Mac Local Host 是 Mac 端内部控制边界。产品上手机不直接连接 Local Host。
- Local Host 到 CodeBuddy CLI 是本机进程边界。手机输入只能被归一化成白名单 command，再由 adapter 写入已有 CLI session。

## 统一 Relay 登录流程

### 1. 启动 Relay

公网 Relay 必须配置 token：

```sh
CODEBUDDY_RELAY_TOKEN=<relay-token> npm run start:relay
```

Relay 只接受 CodeBuddyRemote 协议 payload：

- `encrypted`，正式 Mac/iOS 通道使用，内部封装加密后的 `command` / `event` / `response`

Relay 不提供任意 TCP 转发，也不暴露 Mac 的 Local HTTP 端口。

### 2. Mac 加入 Relay

用户在目标 workspace 执行：

```sh
CODEBUDDY_REMOTE_RELAY_URL=wss://<relay-domain>/relay \
CODEBUDDY_REMOTE_RELAY_TOKEN=<relay-token> \
codebuddy-remote
```

Mac 端会：

- 启动长期驻留的 `codebuddy` CLI。
- 启动内部 Local Host，默认端口 `17320`。
- 通过 Relay 注册 host。
- 生成短期 Relay Pairing URL。
- 打印二维码和 Pairing URL。

Pairing URL 包含：

- `mode=relay`
- `relayURL`
- `pairingCode`
- `pairingSecret`
- `workspace`
- `host`
- `expiresAt`

`CODEBUDDY_REMOTE_RELAY_TOKEN` 只在 Mac host 注册 Relay 时发送，不进入 Pairing URL，也不由 iOS 保存。Mac host 注册时还会把 `pairingSecret` 发给 Relay，Relay 只保存其哈希用于后续 client join 校验。`pairingSecret` 默认随机生成，需要固定时可设置 `CODEBUDDY_REMOTE_RELAY_PAIRING_SECRET`。

### 3. iOS 加入 Relay

iOS App 扫码后：

- 校验 `expiresAt`。
- 写入 Relay URL、配对码和配对密钥。
- 生成或复用本机设备凭证。
- 使用 `relayURL + pairingCode + pairingSecret` 加入对应 host。
- Relay 配对码默认短期有效，已加入后不能被第二个 client 复用。

iOS App 生成或复用本机凭证：

```text
deviceId     随机 UUID
deviceSecret 32 字节随机数，经 base64url 编码
deviceName   当前 iOS 设备名
```

首次或带有效 pairing secret 的 Relay join 会提交本机 `deviceId + deviceSecret`，Relay 在 pairing secret 校验通过后登记该设备。设备登记后，同一设备可在 pairing code 过期后用 `relay.join` HMAC 签名重新加入，不再依赖短期 pairing secret。Relay 对设备 join nonce 做窗口内防重放。

iOS 端把 `deviceSecret` 保存到 Keychain，使用 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`。

### 4. 端到端加密

Mac host 和 iOS client 在 Relay join 阶段交换临时公钥：

```text
P-256 KeyAgreement -> HKDF-SHA256 -> ChaCha20-Poly1305
```

之后正式 Mac/iOS 通道把 `command`、`event`、`response` 封装到 `encrypted` payload。Relay 只校验信封结构并转发密文，看不到 prompt、terminal output、diff 或 response 正文。

## API 权限边界

当前允许的内部 Local API：

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

手机端禁止能力：

- 不能发送任意 shell 命令。
- 不能读取任意本地文件。
- 不能写入任意本地文件。
- 不能调用任意 IDE command。
- 不能修改 CodeBuddy 登录态、配置或扩展列表。

终端审批输入目前限制为单个控制键，例如 `1` / `2` / `3` / `y` / `n` / `q`。

## 本地持久化

### iOS

- Relay 连接配置保存在 `AppStorage`。
- `deviceSecret` 保存在 Keychain。
- 聊天展示缓存保存在本地 AppStorage，只用于 UI 恢复。

### Mac

- 历史事件默认保存到：

```text
~/.codebuddy-remote/history/<workspace>-<sha256(cwd).前16位>.jsonl
```

- 设备列表默认保存到：

```text
~/.codebuddy-remote/devices.json
```

- 安全审计日志默认保存到：

```text
~/.codebuddy-remote/audit/<workspace>-<sha256(cwd).前16位>.jsonl
```

历史文件只保存 normalized semantic events，不保存原始 `terminal.output` 刷新帧。

## 当前已有控制

- Pairing URL 带过期时间。
- Pairing URL 只生成 `mode=relay`；iOS App 会拒绝 `mode=local`。
- `codebuddy-remote` 缺少 `CODEBUDDY_REMOTE_RELAY_URL` 时不会生成配对二维码。
- Relay pairing code / pairing secret 短期有效，且不能被多个 client 复用。
- 公网 Relay 要求 token，除非显式设置本机调试开关。
- Relay token 只用于 Mac host 注册，不进入 iOS 二维码和业务 frame。
- Relay 支持登记后的设备用 HMAC 重新加入，并对 join nonce 做防重放。
- 正式 Mac/iOS Relay 通道使用应用层 E2E：`P-256 KeyAgreement + HKDF-SHA256 + ChaCha20-Poly1305`。
- Relay payload 做类型白名单校验；E2E 模式下 Relay 只校验 `encrypted` 信封结构，不读取内部正文。
- Mac 端支持设备列表、重命名和撤销 API。
- Mac 端写入安全审计 JSONL，记录绑定、prompt 摘要、审批输入、中断/恢复和事件流连接，并提供 `GET /api/audit` 导出。
- Local 管理 API 要求本机来源，带非本机 `X-Forwarded-For` 会被拒绝。
- 设备密钥保存在 iOS Keychain。
- 设备列表保存在 Mac 本地。
- iOS 连接设置显示当前 host、workspace 和绑定状态。
- 终端输入接口只接受审批控制键。
- 历史记录不保存原始 TUI 刷新输出。

## 已知缺口

- Relay 仍可看到路由元数据，例如 pairing code、host/client 连接状态和 encrypted frame 尺寸/频率；正式 Mac/iOS 通道的 payload 正文已加密。
- 安全审计日志已有独立文件和导出 API，但还没有独立可视化页面。
- Relay Pairing URL 中携带短期 pairing secret。二维码仍需要被视为短期敏感凭证。

## 下一步安全任务

1. 为审计日志增加独立可视化页面。
2. 为设备管理增加 iOS 侧查看入口。

## 验收清单

- Mac 缺少 `CODEBUDDY_REMOTE_RELAY_URL` 时不生成 Pairing URL。
- Pairing URL 只包含 `mode=relay`。
- iOS 扫码 Local 旧二维码会拒绝。
- Relay 未配置 token 时不能公网启动。
- 同一个 Relay pairing code 不能被两个 client 复用。
- Relay 设备登记后可用 HMAC 重新加入，且同一 join nonce 不能重放。
- 正式 Mac/iOS Relay 通道的 command/response/event 以 `encrypted` payload 转发，Relay frame 中不出现 prompt、terminal output 或 response 正文。
- Relay 明文 `command` / `event` / `response` payload 会被拒绝。
- iOS 重启后仍能从 Keychain 读取设备凭证。
- Mac 删除 `devices.json` 后，iOS 需要重新扫码绑定。
