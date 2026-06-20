# 探索结论摘要

Generated: 2026-06-19

本文件只记录对最终方案有用的探索结论。当前权威方案以 `../codebuddy-remote-final-plan.md` 为准。

## CLI 结论

CLI 路线适合作为第一阶段主线。

已发现能力线索：

- session 相关：`--session-id`、`--resume`、`--continue`
- 后台任务相关：`--bg` / `--background`、`ps`、`logs`、`attach`、`kill`
- 远程/服务相关：`--serve`、`--remote-control`
- 流式协议相关：`--input-format stream-json`、`--output-format stream-json`

不能仅凭这些 flag 宣称已闭环。下一步必须做真实行为验收：

- stream-json 的实际事件 schema；
- permission request 的实际表达；
- approval / rejection 的实际入口；
- interrupt 的正式方式；
- background session 的恢复行为。

## IDE 结论

IDE 路线有产品价值，但不是第一阶段阻塞项。

已验证：

- CodeBuddy IDE 可以安装第三方 VS Code 兼容扩展。
- 探针扩展可以在 CodeBuddy extension host 中运行。
- 探针扩展能看到并调用部分 Genie / CodeBuddy command。
- `tencentcloud.codingcopilot.chat.sendMessage` 可以注入 prompt，并返回 conversation id、user message 和 agent running 状态。
- `getWebviewInfo`、`checkChatRunning`、`isAgentBusy`、`getContext` 可用于基础状态探测。

未闭环：

- assistant message stream；
- tool call / diff / terminal output stream；
- permission request event；
- approval / rejection 稳定 API；
- IDE reload、sleep、restart 后恢复。

因此，IDE Bridge 当前只能证明“可发送 prompt”，不能证明“完整远程控制已可产品化”。

## 探针扩展结论

探针扩展只用于验证，不是正式产品代码。

当前探针能力：

- `GET /health`
- `GET /probe`
- `GET /commands`
- `GET|POST /exec`

正式 Bridge 必须删除通用 `/exec`，改为白名单 API：

- `GET /sessions`
- `GET /sessions/:id/state`
- `POST /sessions/:id/messages`
- `GET /events`
- `POST /approvals/:id/resolve`
- `POST /sessions/:id/interrupt`
- `POST /sessions/:id/resume`

## 保留材料

归档目录只保留：

- 本摘要；
- 可复跑的静态探针脚本；
- 可复跑的 IDE bridge 探针扩展；
- VSIX 打包元数据。

旧的长报告和原始 JSON 已移除，避免后续模型误把早期草案或原始扫描结果当作当前方案。
