
# Engineering Policy

## Project Mode: Exploratory

This project prioritizes rapid iteration, working
prototypes, and user-visible functionality.

## Execution

- Implement the smallest useful solution first.
- Prefer direct code changes over lengthy planning.
- Keep changes local and reversible when possible.
- Treat experiments as disposable until accepted.
- Do not expand the task into unrelated improvements.
- Do not create plans, reports, or documentation
  unless they provide lasting value.

## Verification

- Default to lightweight, targeted verification.
- For visual changes, prefer running the UI and
  inspecting the actual behavior.
- For ordinary features, verify the main success path.
- Add regression tests when they protect important
  behavior, not merely to mirror implementation.
- Do not repeatedly run full test suites without a
  concrete reason.
- Do not add mocks, test infrastructure, or audit
  machinery solely to validate trivial changes.
- Once acceptance criteria are met, stop.

## Risk Escalation

Increase verification for:
- Destructive or irreversible operations.
- User data, original files, or persistent storage.
- Credentials, security boundaries, or privacy.
- Significant changes to shared architecture.

## Completion

- Report what changed.
- Report what was actually verified.
- State relevant known limitations.
- Do not perform extra work merely to produce a
  more comprehensive completion report.

## 控制本地构建体积

- 开始前检查 `git status`、相关文档、运行中的应用/构建进程以及已有产物。复用匹配当前代码的工具和依赖，不为每次验证复制运行时或安装一套 `node_modules`。
- 日常自动验证不需要调试器时，在执行 Cargo 的子进程内统一设置 `CARGO_PROFILE_DEV_DEBUG=0`、`CARGO_PROFILE_TEST_DEBUG=0`、`CARGO_INCREMENTAL=0`，减少 PDB 和增量缓存。需要断点或完整符号时可临时启用，并在验证后清理对应产物。
- 环境覆盖只作用于本次命令或专用子进程，不修改用户/系统环境。一次验证保持相同的 profile、features 和 package 范围，避免无必要地切换参数生成多套依赖与测试产物。
- 默认复用仓库的 `src-tauri/target/`。确需隔离构建时，记录临时 `CARGO_TARGET_DIR` 的绝对路径，并在任务结束前清理；禁止通过把缓存搬到其他目录来隐藏占用。
- 用户要求 Windows 应用时默认使用 release：`npm run desktop:build -- -- --locked`。该命令已包含前端构建，无新修改时不要紧接着重复 `npm run build`。
- 更新应用前确认正在运行的可执行文件路径，只停止当前仓库对应的应用。需要回滚时保留最近一份必要的旧程序，验证新程序后清理更早副本，避免每次重启都永久增加一份 EXE。
- `src-tauri/target/` 的常态体积目标为 8 GiB 以内。超过时先定位 debug、PDB、incremental、重复构建及测试产物；这是检查阈值，不是跳过必要测试的理由。
- 必要检查通过后，只有新修改、失败或尚未解决的疑点才需要重跑或扩大测试。清理缓存后不要为证明清理成功而重新编译一遍。

## 新功能验证完成后必须收尾

- 任务结束前清理本次产生且已不再需要的 debug/测试构建目录、测试 EXE/PDB、示例产物、临时 target、测试数据库及 WAL/SHM、复制日志、浏览器 profile、临时运行时和重复依赖。
- 清理共享的 `src-tauri/target/debug` 前确认没有其他任务在构建或使用它；只清理已确认空闲的范围。保留当前可用的 release 程序及正常复用的 release 依赖缓存，不默认执行会清掉整个 `src-tauri/target/` 的 `cargo clean`。
- 通过 Cargo fingerprint 等证据识别 release 中的测试/示例产物，不按“所有 EXE/PDB”批量处理，以免影响运行程序或正常构建缓存。测试源码、合成 fixtures 和最终图标等正式资源必须保留。
- 临时验证材料放在 `output/<任务>/`，不要将整个 `output/` 当作缓存。保留简短的验证结论、必要报告和最终截图；删除已完成实验的数据库、原始日志副本、大型响应快照和其他中间材料。
- 数据迁移需要的回滚材料按“升级前一致性数据库 + 对应旧程序 + 说明”成组保留，默认保留最近一组必要材料。旧组确认已被取代且无保留需求后清理；不得把 AppData 正式数据库、账号配置、凭据或用户日志当作测试产物。
- 保留下来的报告若引用已清理的临时数据，应注明数据已移除；不再宣称这些文件仍可下载或直接复现。若有其他任务仍在使用的产物，记录路径、保留原因及后续清理条件。

## 清理必须可恢复

- Windows 上的清理默认**移入回收站，不永久删除**。使用支持回收站的系统 API；不得用 `Remove-Item`、`rm`、`rmdir`、`cargo clean` 或 `git clean` 代替回收操作。
- 无法进入回收站时停止处理该项并报告原因，不自动退回永久删除，不自行清空回收站。验证完成后提示用户检查效果并自行清空回收站。
- 清理前核验每个目标的规范化绝对路径，确保位于本仓库或本任务明确创建的临时目录内。检查父路径以及目录链接/junction；只处理链接对象，禁止遍历到外部目录。不跨 shell 拼接删除命令。
- 清理前后记录目录大小、处理清单及保留原因；确认目标已进入回收站，当前程序、源码和正式资源仍正常。区分项目目录体积下降与磁盘空间释放：回收站清空前，磁盘可用空间通常不会明显增加。
- 最终答复说明验证结果、清理量、剩余体积和需保留的材料；因占用等原因未完成的清理必须明确说明。
