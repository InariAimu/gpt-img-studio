# Studio Sync v2

Rust/Axum 单实例服务。同步草图库、共享姿势库、工作区、会话/草稿、图片记录、参考关系、预设、已结束任务和提供商定义。模型密钥、网络/界面设置、默认模型分配、设备身份和用量不进入协议。客户端保留本地 SQLite，通过每实体修订号与持久基线检测离线修改；基线差异本身是可恢复的待传队列。上传确认丢失可以幂等重试，游标与本地文档在同一事务提交。

图片先上传到暂存文件，校验 SHA-256 后原子就位，再提交引用元数据。同步删除仅删除逻辑记录，服务端原图及本地下载副本不自动物理回收。冲突保留本机及远端内容，通过设置页选择。服务端实例变化或游标回退会暂停同步，避免错误恢复覆盖本地数据；不会自动重置这些状态。

## 构建与验证

Windows 使用既有 target：

```powershell
$env:CARGO_PROFILE_DEV_DEBUG='0'
$env:CARGO_PROFILE_TEST_DEBUG='0'
$env:CARGO_INCREMENTAL='0'
cargo test --manifest-path sync/Cargo.toml --release --locked --features server --target-dir src-tauri/target --lib
npm run desktop:build -- -- --locked
```

Linux 在包含本目录的构建容器中执行 `cargo build --release --locked --features server --bin studio-sync-server`。运行镜像仅复制 Linux release 二进制，使用本目录 Dockerfile。DS1618+ 的当前内核不支持 CFS CPU 配额，因此 Compose 使用 CPU 权重与两个运行线程。Compose 中 UID/GID、宿主内网地址与现有代理网络须按部署环境调整；不挂载 Docker socket。`data/` 需对运行 UID 可写。在本机群晖上为本项目新建的 data、secrets 目录设置所有者 1026:100 和 0700；避免继承仅管理员组可访问的共享文件夹 ACL。编译缓存使用专用 Docker 卷 gpt-img-studio-sync-build-target，避免共享目录 ACL 导致 LLVM 无法判断输出文件可写。

`STUDIO_SYNC_TOKENS` 指向 JSON 对象：设备 ID 映射到令牌的 SHA-256 十六进制摘要。使用密码学随机数生成每设备至少 32 字符的令牌；令牌原文只交给对应客户端。文件请求时重新读取，移除映射即可撤销设备。该文件以只读卷挂载、限制文件权限。不得提交真实令牌。

接口：`GET /health`、`POST /v1/push`、`GET /v1/changes?after=N`、`HEAD/PUT/GET /v1/blobs/{sha256}.{extension}`。除 health 外均需 Bearer 令牌；push 的 deviceId 必须匹配令牌。公网必须使用 HTTPS，客户端禁止重定向；内网直连只允许显式私有 IP/本机 HTTP。

## 当前 NAS 部署

目标根目录 `/volume2/docker-disk2/gpt-img-studio-sync/`。`compose.yaml` 与 `data/`、`secrets/`、`backups/` 分离。公网地址 `https://gis.inariaimu.synology.me:41658`；局域网 `http://192.168.1.127:18081`。将 `nginx-server.conf` 放入现有 Nginx 的 conf.d 目录，复用 http 层的通配证书与 41658 端口映射。上线前 `nginx -t`，失败将新文件移出 conf.d，成功后 reload。旧 fox `/studio-sync` 入口暂留兼容已有客户端（`nginx-location.conf`），GitLab 仍使用 fox 根路径。

使用 SQLite Backup API 取得一致性数据库；图片为不可变追加文件，可先备份数据库，再复制该快照引用的原图。数据库备份需保留 instance、变更序列、删除标记，并配套备份设备令牌摘要。恢复旧快照导致客户端游标回退时应停止客户端、协调恢复，不假装同步完成。同盘 backups 只是回滚材料，还应复制到另一台服务器。

2026-11-11 升级后，Container Manager 项目为 `studio-sync-v2`，运行容器为 `gpt-img-studio-sync-v2`。运行配置位于 `upgrade-v2-20261111/runtime/compose.yaml`，复用原运行镜像并只读挂载 `upgrade-v2-20261111/studio-sync-server-v2` 覆盖服务二进制；保留原数据、凭据、端口和代理网络 IP。旧容器 `gpt-img-studio-sync` 已停止，配套一致性数据库及回退说明保留在 `upgrade-v2-20261111/rollback/`。SQLite 备份时数据卷需允许创建 WAL 的共享内存文件，源连接仍使用只读模式，先在容器临时目录完成备份与完整性检查再复制到共享目录。所有参与同步的客户端须升级至协议 2 版本。

## 接入另一台电脑

使用本版本 Windows release 程序，在“设置 → 多设备同步”导入为该电脑生成的连接 JSON，然后点击“立即同步”。格式如下（真实令牌不应进入 Git）：

```json
{"config":{"enabled":true,"url":"https://gis.inariaimu.synology.me:41658","deviceId":"pc-second","direct":true},"token":"<该设备的随机令牌>"}
```

标题栏显示同步状态、待上传记录与冲突，可直接“立即同步”或打开同步设置。自动同步每 300 秒尝试一次；关闭自动同步仍可手动同步。手动同步先保存当前会话草稿及排队中的设置；切换窗口不会额外触发自动同步。

更换服务域名时，导入包含新地址和原设备令牌的连接文件；凭据按 URL 保存，导入只更新配置，保留同步基线及游标。

连接文件包含访问凭据，须私下传递。服务端 `secrets/devices.json` 中预先登记对应设备的令牌摘要。一台电脑使用一个设备 ID；撤销时从服务端文件移除该 ID 即时生效。已有的本地创作会合并，发生冲突时手动选择；新电脑的默认提供商与服务器不同也可能提示冲突，应检查后采用服务器版本。同步后选择需要的默认模型并填写 API Key，再开始创作。

管理员可仅在启动子进程中设置 `GPT_IMG_STUDIO_SYNC_CONFIG` 为连接文件绝对路径以导入；`GPT_IMG_STUDIO_DATA_DIR` 可指定隔离数据目录用于验收，普通使用无需设置这两个环境变量。

`cargo run --manifest-path sync/Cargo.toml --release --locked --features server --target-dir src-tauri/target --example verify -- TEST-A.json TEST-B.json OUTPUT-DIR` 可对**独立的空测试服务**进行双设备鉴权、3 MiB 文件传输、编辑、冲突和删除冒烟验证；它拒绝已存在变更记录的服务，不得使用正式库作为测试服务。

## v2 边界

- 仅单用户设备共享库；Token 是设备鉴权，不是多人数据隔离。
- 每次最多 10000 个实体变更、31 MiB 上传元数据；单图最多 128 MiB。
- 打字、图片生成和自动命名期间延后自动同步；后台不重新提交模型调用。新电脑需配置同一提供商对应的 API Key；Responses 接续仍依赖提供商上下文有效。
- 图片自动完整下载，无按需缓存/配额回收；远端预览可直接使用原图。
- 不处理 szurubooru 导入，不包含图库部署；可在下一阶段添加独立导入队列，保持展示图库与 Studio 分离。
- 合成 HTTP 测试材料位于 `output/sketch-library-20261111/sync-tests/`，验收后按仓库规则移入回收站。

## 草图库升级

v2 增加 sketches / sketchLibraries 集合与 JSON 内容文件。元数据仍限制为每条 1 MiB；可编辑内容与 PNG 预览作为按 SHA-256 命名的不可变文件，先传文件再提交记录。单份草图在应用中限制 64 MiB。草图并发编辑生成冲突副本；仅预览差异不复制文档。删除采用可恢复状态，生成使用的参考快照与原草图独立。

协议版本从 1 升至 2，升级同步服务和所有客户端；版本不匹配时暂停同步并保留本机数据。HTTP 路由仍使用 /v1 前缀。保留服务数据库的一致性备份和旧容器/映像后再切换；不可只替换客户端继续宣称同步成功。
