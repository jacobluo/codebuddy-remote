# 决策地图：目录组织

状态：2026-06-21 创建初版。

范围：判断是否要重组 `apps/local-host/src` 和 `apps/ios/CodeBuddyRemote/CodeBuddyRemote`。这两个目录目前基本都是平铺文件。本地图只记录决策，不移动代码。

上下文：当前仓库没有 `CONTEXT.md` 或与此主题相关的 ADR。这里使用的是实现 module 术语，不是领域词汇。

## #1：Local Host module 分类

阻塞于：无
类型：Discuss

### 问题

`apps/local-host/src` 是否继续保持平铺，还是按稳定 module 分组？如果分组，怎样的分类能提升 locality，同时避免制造空洞的浅目录？

### 答案

未解决。初始建议：只围绕代码里已经真实存在的 module 拆分，例如 CLI entry、Local Host HTTP/SSE adapter、Session Command Workflow、Relay client/E2E、terminal adapter/parser、alternative CLI adapters。不要使用 `utils` 这类模糊目录。

## #2：iOS module 分类

阻塞于：无
类型：Discuss

### 问题

`apps/ios/CodeBuddyRemote/CodeBuddyRemote` 是否继续保持平铺，还是按 iOS app module 分组？如果分组，是按产品功能、基础设施，还是按 SwiftUI view/model 类型拆？

### 答案

未解决。初始建议：按产品 module 分组，而不是纯按 SwiftUI 文件类型分组。候选目录包括 App shell、Conversation、Input、Relay、Pairing、Device Credentials、Terminal、shared Remote Models。不要在 module 还没有形成 locality 前，把每个小 view 都拆进独立目录。

## #3：Xcode project 移动策略

阻塞于：#2
类型：Prototype

### 问题

怎样把 iOS 文件移动到新目录，同时保证 `.xcodeproj` build graph 正确且 diff 容易 review？

### 答案

未解决。当前 project 使用显式 PBX file references 和 groups。建议先做一个小 prototype：移动一个低风险 Swift 文件到候选目录，更新 project 文件，并跑 iOS simulator test target；确认没问题后再做完整移动。

## #4：Local Host import 和测试路径策略

阻塞于：#1
类型：Prototype

### 问题

Local Host 目录移动会带来多少 import churn？测试应该导入最终 module entry，还是继续导入具体实现文件？

### 答案

未解决。初始建议：测试尽量打在最高可用 seam 上。例如 workflow 测试可以直接导入 Session Command Workflow module；Relay 和 Local Host 测试继续走现有 public module entry。

## #5：文档和兼容更新

阻塞于：#1, #2, #3, #4
类型：Discuss

### 问题

目录移动后，需要更新哪些文档和脚本，才能避免后续 agent 继续引用旧的平铺路径？

### 答案

未解决。已知影响范围：README 目录说明、final plan 文件列表、架构博客、测试 import、package bin 引用，以及 Xcode project source references。

## #6：判断是否跳过后续地图流程

阻塞于：#1, #2
类型：Discuss

### 问题

如果 #1 和 #2 都能收敛到明显、低风险的目录形态，是否应该直接进入实现，而不是继续追加 ticket？

### 答案

未解决。初始建议：如果目录分类很清晰，剩下只是机械移动和跑测试，就跳过后续地图流程，直接实现。只有在 Xcode project 移动方式或 module 命名仍有争议时，才继续推进地图。
