# 探索材料归档

当前权威方案只有一份：

- `../codebuddy-remote-final-plan.md`

本目录只保留最小探索摘要和可复跑探针，避免多个历史版本干扰后续模型判断。

## 文件说明

- `exploration-summary.md`：精简后的探索结论。
- `tools/codebuddy-ide-probe.mjs`：CodeBuddy IDE 静态探针脚本。
- `probes/codebuddy-mobile-bridge-extension/`：VS Code 兼容 IDE bridge 探针扩展。
- `probes/vsix/`：探针扩展 VSIX 打包元数据。
- `generated/`：复跑探针时生成的临时验证输出。

## 读取原则

- 做方案、实现、排期时，只读 `../codebuddy-remote-final-plan.md`。
- 需要追溯可行性依据时，再读 `exploration-summary.md`。
- 需要复跑验证时，才看 `tools/` 和 `probes/`。

重新运行 `tools/codebuddy-ide-probe.mjs` 时，新的静态扫描输出会写入 `generated/`。该输出是临时验证产物，不应替代最终方案。
