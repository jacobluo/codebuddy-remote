# 安全设计与登录流程

Generated: 2026-06-20

## 目标

CodeBuddy Remote 的安全目标是让手机可以控制本地 CodeBuddy session，但不扩大成本地任意执行入口。

核心约束：

- CodeBuddy CLI / IDE 仍是 session owner，完整 workspace、上下文、登录态和权限系统都留在 Mac 本地。
- iOS App 只做控制端：发送 prompt、查看 normalized events、审批当前 permission、中断和恢复任务。
- Local Host 只暴露白名单 API，不提供任意 shell、任意文件读写或任意 IDE command。
- Relay 只转发 CodeBuddyRemote 协议消息，不做通用 TCP 端口穿透，不保存 prompt、diff、terminal output。
- 配对必须显式、短期有效、可撤销，并尽量减少长期共享 token 的使用。

## 术语

- Local Host：`codebuddy-remote` 启动的本地 HTTP/SSE 控制面。
- Relay：公网或内网中转服务，只转发应用层 command/event/response。
- Local Token：Mac 启动时生成或由环境变量提供的本地 bootstrap token。
- Device Credential：iOS App 生成的 `deviceId + deviceSecret`，用于绑定后的请求签名。
- Pairing URL：`cbr://pair?...`，由 Mac 端二维码承载，短期有效。

## 信任边界

```text
iOS App
  | Local: HTTP/SSE + HMAC device signature
  | Relay: WebSocket + relay token + pairing code
  v
Local Host / Relay
  v
TerminalCliAdapter
  v
本地 codebuddy CLI session
```

边界说明：

- iOS App 到 Local Host 是不可信网络边界。即便是局域网，也不能默认信任同网设备。
- iOS App 到 Relay 是公网边界。Relay token 和 pairing code 只证明可以加入转发会话，不代表可以直接访问本地 HTTP API。
- Local Host 到 CodeBuddy CLI 是本机进程边界。手机输入只能被归一化成白名单 command，再由 adapter 写入已有 CLI session。

## Local 模式登录和绑定流程

Local 模式用于手机和 Mac 在同一局域网，或 iOS 模拟器访问本机。

### 1. Mac 启动

用户在目标 workspace 执行：

```sh
codebuddy-remote
```

启动后 Mac 端会：

- 启动长期驻留的 `codebuddy` CLI。
- 启动 Local Host，默认端口 `17320`。
- 生成或读取 `CODEBUDDY_REMOTE_TOKEN`。
- 生成短期 Pairing URL。
- 打印二维码和 Pairing URL。

Pairing URL 包含：

- `mode=local`
- `baseURL`
- `token`
- `workspace`
- `host`
- `expiresAt`

### 2. iOS 扫码

iOS App 扫描二维码或粘贴 Pairing URL 后：

- 校验 `expiresAt`。
- 切换到 Local 模式。
- 写入 `baseURL` 和 Local Token。
- 准备绑定当前设备。

### 3. 设备绑定

iOS App 生成或复用本机凭证：

```text
deviceId     随机 UUID
deviceSecret 32 字节随机数，经 base64url 编码
deviceName   当前 iOS 设备名
```

iOS App 使用 Local Token 调用：

```http
POST /api/devices/bind
Authorization: Bearer <local-token>
Content-Type: application/json

{
  "deviceId": "...",
  "deviceSecret": "...",
  "deviceName": "..."
}
```

Mac 端把绑定设备保存到：

```text
~/.codebuddy-remote/devices.json
```

也可以通过环境变量覆盖：

```sh
CODEBUDDY_REMOTE_DEVICE_STORE_FILE=/path/to/devices.json codebuddy-remote
```

iOS 端把 `deviceSecret` 保存到 Keychain，使用 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`。

### 4. 绑定后的请求认证

绑定成功后，Local API 请求不再依赖 URL query token，改用设备签名头：

```http
X-CodeBuddy-Device-Id: <deviceId>
X-CodeBuddy-Timestamp: <epoch-ms>
X-CodeBuddy-Nonce: <uuid>
X-CodeBuddy-Signature: <hmac>
```

签名文本：

```text
<method>
<path>
<raw-body>
<timestamp>
<nonce>
```

签名算法：

```text
HMAC-SHA256(deviceSecret, signingText) -> base64url
```

Mac 端校验：

- `deviceId` 存在且未撤销。
- `timestamp` 在 5 分钟窗口内。
- HMAC 签名匹配。
- POST 请求按原始 request body 验签，避免 JSON 编码差异。

Local Token 仍保留为 bootstrap / 兼容认证方式，但正常扫码绑定后的 iOS 请求会使用设备签名。

## Relay 模式登录流程

Relay 模式用于手机无法直接访问 Mac 局域网地址时。

### 1. 启动 Relay

公网 Relay 必须配置 token：

```sh
CODEBUDDY_RELAY_TOKEN=<relay-token> npm run start:relay
```

Relay 只接受 CodeBuddyRemote 协议 payload：

- `command`
- `event`
- `response`

Relay 不提供任意 TCP 转发，也不暴露 Mac 的 Local HTTP 端口。

### 2. Mac 加入 Relay

```sh
CODEBUDDY_REMOTE_RELAY_URL=wss://<relay-domain>/relay \
CODEBUDDY_REMOTE_RELAY_TOKEN=<relay-token> \
codebuddy-remote
```

Mac 端生成短期 pairing code，并通过 Relay 注册 host。

Pairing URL 包含：

- `mode=relay`
- `relayURL`
- `relayToken`
- `pairingCode`
- `workspace`
- `host`
- `expiresAt`

### 3. iOS 加入 Relay

iOS App 扫码后：

- 校验 `expiresAt`。
- 切换到 Relay 模式。
- 使用 `relayURL + relayToken + pairingCode` 加入对应 host。
- Relay 配对码默认短期有效，已加入后不能被第二个 client 复用。

当前 Relay 模式主要依赖 relay token 和短期 pairing code。设备级 HMAC 绑定已经在 Local 模式落地，Relay 侧的设备级认证可以作为下一阶段补齐。

## API 权限边界

当前允许的 Local API：

- `GET /api/sessions`
- `GET /api/sessions/:id/state`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/input`
- `POST /api/sessions/:id/interrupt`
- `POST /api/sessions/:id/resume`
- `GET /api/events`
- `GET /api/events/stream`
- `POST /api/devices/bind`

手机端禁止能力：

- 不能发送任意 shell 命令。
- 不能读取任意本地文件。
- 不能写入任意本地文件。
- 不能调用任意 IDE command。
- 不能修改 CodeBuddy 登录态、配置或扩展列表。

终端审批输入目前限制为单个控制键，例如 `1` / `2` / `3` / `y` / `n` / `q`。

## 本地持久化

### iOS

- 连接配置保存在 `AppStorage`。
- Local `deviceSecret` 保存在 Keychain。
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

历史文件只保存 normalized semantic events，不保存原始 `terminal.output` 刷新帧。

## 当前已有控制

- Pairing URL 带过期时间。
- Relay pairing code 短期有效，且不能被多个 client 复用。
- 公网 Relay 要求 token，除非显式设置本机调试开关。
- Relay payload 做类型白名单校验。
- Local 绑定后支持设备级 HMAC 请求签名。
- 设备密钥保存在 iOS Keychain。
- 设备列表保存在 Mac 本地。
- 终端输入接口只接受审批控制键。
- 历史记录不保存原始 TUI 刷新输出。

## 已知缺口

- Mac 端还没有设备管理 UI，撤销设备需要后续补齐。
- Relay 模式还没有使用设备级 HMAC 或端到端加密。
- Local Host 当前是 HTTP，局域网内依赖 HMAC 请求签名保护认证完整性，未提供传输层加密。
- 审计日志还未形成独立文件和查看入口。
- Pairing URL 中仍携带 bootstrap token，二维码需要被视为短期敏感凭证。
- 还未实现 nonce replay cache，同一 5 分钟窗口内的重复签名请求理论上可被重放。

## 下一步安全任务

1. 增加设备管理能力：列出设备、重命名设备、撤销设备。
2. 增加 nonce replay cache，拒绝同一设备在时间窗口内重复使用的 nonce。
3. 为 Relay 模式补设备级认证，避免长期只依赖 relay token。
4. 增加本地审计日志，记录设备绑定、连接、prompt 摘要、审批选择和中断恢复。
5. 评估 Local 模式 mTLS、Noise、WebSocket over TLS 或局域网 HTTPS 的成本。
6. 把 pairing token 缩短为一次性 bind token，绑定后立即失效。
7. 在 iOS 上增加“当前连接身份”展示，明确 workspace、host、mode 和设备绑定状态。

## 验收清单

- 扫码 Local 二维码后，App 能自动绑定设备并连接。
- 绑定后的 `GET /api/sessions` 不需要 URL token。
- 绑定后的 `POST /api/sessions/:id/messages` 使用设备签名通过。
- 修改 body、timestamp 或 signature 后请求被拒绝。
- Relay 未配置 token 时不能公网启动。
- 同一个 Relay pairing code 不能被两个 client 复用。
- iOS 重启后仍能从 Keychain 读取设备凭证。
- Mac 删除 `devices.json` 后，iOS 需要重新扫码绑定。
