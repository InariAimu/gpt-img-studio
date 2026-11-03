# GPT Image Studio

Tauri 2 + React + TypeScript 的本地图片生成与实验工作台，第一版面向 Windows。

```powershell
npm ci
npm run desktop
```

构建可直接运行的 Windows EXE：

```powershell
npm run desktop:build
```

输出：`src-tauri/target/release/gpt-img-studio.exe`。开发环境需要 Node.js、Rust MSVC 工具链和 Tauri 的 Windows 开发依赖。

- 图库支持搜索、收藏、工作区筛选、平铺与版本堆叠；所有预览完整适应，不裁切。
- 工作区组织多个会话，支持参考图、独立生成、Responses 多轮接续、从图片派生、结果对比和效果预设。
- 会话输入区固定在底部，支持粘贴图片、选择本地参考图、Ctrl+Enter 生成；尺寸和质量位于紧凑的生成选项菜单。
- 尺寸和质量按所选模型提供。GPT Image 2 / 2.5 支持符合 OpenAI 文档限制的自定义尺寸；2.5 额外提供 xhigh、max 质量。
- 默认名称的会话在首次生成成功后可使用文本模型自动命名；设置中可关闭，也可在会话标题旁手动触发。手动命名不会被自动覆盖。
- 会话页没有右侧详情栏；Prompt 和执行信息位于每张结果下方。
- 支持配置 Responses API 或 Images API；Prompt 优化使用可独立配置的 Responses 文本服务，建议需手动采用。
- PNG / JPEG / WebP / GIF 导入保留原始字节，生成独立 WebP 预览。记录保存在设置页所示目录的 SQLite 数据库；API Key 保存在与端点绑定的 Windows 凭据中。
- 启动时包含标记清楚的示例插画，图库可取消“显示示例”。示例不是实际 API 生成结果。

当前没有 NAS 归档、遮罩编辑、流式预览、安装器、签名或自动更新。API 的实际能力和模型 ID 取决于配置的服务；未配置密钥时不会提交生成。中断的任务不会自动重试，以避免重复计费。

`npm run dev` 可预览界面；文件导入、持久化和 API 调用需要桌面版。最小窗口为 1000 × 720 逻辑像素，默认 1280 × 800。
## Harness Scope 用量采集

每次 HTTP 调用保留原始用量事件，同时按语言模型、图像模型组件写入 `studio.sqlite3` 的 `model_usage` 表。模型记录只统计 Token 和调用时的参考报价，不等于请求次数或图片张数。Responses 顶层图像工具汇总优先于逐次工具用量，避免重复累计。

`usage/models.jsonl` 为可重建的模型用量镜像，稳定 ID 为 `请求 UUID:component:序号`，schema 为 `gpt-img-studio.model-usage` v1。新事件与模型行在同一事务落库；启动时回填已有事件并修复镜像，保留原有费用和价格快照。缓存、输入或输出未上报时保持 `null`；`estimated` / `upper_bound` / `unknown` 分别表示来源估算、费用上界和无法计价。采集文件不含提示词、图片或凭据。

Harness Scope 优先只读 SQLite（包括 WAL），也支持显式导入模型 JSONL。原 `usage/usage.jsonl` 和“导出原始请求 JSONL”仍保留请求层级以便核对。两侧共享合成契约样本，Studio 使用 `cargo test --release --locked -p gpt-img-studio --lib` 验证。


新用量日志的 `provider` 保存请求时的 `id/name/kind`、`billingChannel: api` 和 `apiService` 分类。只有配置的 HTTPS `api.openai.com:443` 归为 `openai-platform`，兼容服务归为 `other`；不记录完整地址或密钥。历史事件不会根据当前配置补写端点，以免误认来源。
