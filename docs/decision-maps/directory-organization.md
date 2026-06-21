# 决策地图：目录组织

状态：2026-06-21 已执行。

范围：记录 `apps/local-host/src` 和 `apps/ios/CodeBuddyRemote/CodeBuddyRemote` 的目录重组决策。

上下文：当前仓库没有 `CONTEXT.md` 或与此主题相关的 ADR。这里使用的是实现 module 术语，不是领域词汇。

## #1：Local Host module 分类

阻塞于：无
类型：Discuss

### 问题

`apps/local-host/src` 是否继续保持平铺，还是按稳定 module 分组？如果分组，怎样的分类能提升 locality，同时避免制造空洞的浅目录？

### 答案

已解决。按真实运行边界拆分：

- `cli/`：`codebuddy-remote` 和本地开发 server 入口。
- `host/`：Local Host HTTP/SSE 控制面。
- `session/`：Session Command Workflow。
- `relay/`：Relay client 和 E2E 加密。
- `adapters/`：真实 CLI、serve CLI、mock、terminal CLI adapter。
- `terminal/`：PTY bridge 和 terminal semantic parser。

没有引入 `utils` 这类模糊目录。

## #2：iOS module 分类

阻塞于：无
类型：Discuss

### 问题

`apps/ios/CodeBuddyRemote/CodeBuddyRemote` 是否继续保持平铺，还是按 iOS app module 分组？如果分组，是按产品功能、基础设施，还是按 SwiftUI view/model 类型拆？

### 答案

已解决。按产品 module 分组，而不是纯按 SwiftUI 文件类型分组：

- `App/`：应用入口、全局状态、主界面组合。
- `Conversation/`：消息模型和消息展示。
- `Input/`：输入栏和附件动作入口。
- `Models/`：远端协议模型。
- `Pairing/`：配对 URL 解析和扫码。
- `Relay/`：Relay client 和端到端加密。
- `Security/`：设备凭据和签名。
- `Terminal/`：终端屏幕模型。

## #3：Xcode project 移动策略

阻塞于：#2
类型：Prototype

### 问题

怎样把 iOS 文件移动到新目录，同时保证 `.xcodeproj` build graph 正确且 diff 容易 review？

### 答案

已解决。当前 project 使用显式 PBX file references 和 groups。本次保留原 build file id，只调整 Xcode group 层级和物理目录，降低 target membership 变化风险。

## #4：Local Host import 和测试路径策略

阻塞于：#1
类型：Prototype

### 问题

Local Host 目录移动会带来多少 import churn？测试应该导入最终 module entry，还是继续导入具体实现文件？

### 答案

已解决。测试继续导入对应 public module entry：

- Local Host 测试导入 `src/host/local-host.mjs`。
- Workflow 测试导入 `src/session/session-command-workflow.mjs`。
- Relay 测试导入 `src/relay/*`。
- Adapter 和 terminal parser 测试导入各自模块目录。

## #5：文档和兼容更新

阻塞于：#1, #2, #3, #4
类型：Discuss

### 问题

目录移动后，需要更新哪些文档和脚本，才能避免后续 agent 继续引用旧的平铺路径？

### 答案

已解决。同步更新 README 目录说明、final plan 文件列表、架构博客、测试 import、package bin/scripts，以及 Xcode project source references。

## #6：判断是否跳过后续地图流程

阻塞于：#1, #2
类型：Discuss

### 问题

如果 #1 和 #2 都能收敛到明显、低风险的目录形态，是否应该直接进入实现，而不是继续追加 ticket？

### 答案

已解决。目录分类已经清晰，本次直接进入实现并通过测试验证。
