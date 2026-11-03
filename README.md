# Image Studio

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
