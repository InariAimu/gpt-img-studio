use image::{GenericImageView, ImageFormat};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
pub const SEED: &str = include_str!("../../src/data/seed.json");

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn id() -> String {
    Uuid::new_v4().to_string()
}
pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
pub fn list_mut<'a>(doc: &'a mut Value, key: &str) -> Result<&'a mut Vec<Value>> {
    doc[key]
        .as_array_mut()
        .ok_or_else(|| format!("本地数据缺少 {key}"))
}
pub fn find<'a>(doc: &'a Value, collection: &str, item_id: &str) -> Result<&'a Value> {
    doc[collection]
        .as_array()
        .and_then(|items| items.iter().find(|item| text(item, "id") == item_id))
        .ok_or_else(|| "记录不存在，请刷新后重试".into())
}

pub struct Store {
    pub root: PathBuf,
    connection: Mutex<Connection>,
    relocating: AtomicBool,
    operations: AtomicUsize,
}
pub struct OperationGuard<'a>(&'a Store);
impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        self.0.operations.fetch_sub(1, Ordering::AcqRel);
    }
}
struct IdleWriteGuard<'a>(&'a Store);
impl Drop for IdleWriteGuard<'_> {
    fn drop(&mut self) {
        self.0.cancel_relocation();
    }
}

impl Store {
    pub fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join("assets")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("thumbnails")).map_err(|e| e.to_string())?;
        let connection =
            Connection::open(root.join("studio.sqlite3")).map_err(|e| e.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS studio_state (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);").map_err(|e| e.to_string())?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, event TEXT NOT NULL);").map_err(|e|e.to_string())?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS model_usage (id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, measurement TEXT NOT NULL);").map_err(|e|e.to_string())?;
        connection
            .execute(
                "INSERT OR IGNORE INTO studio_state(id, document) VALUES(1, ?1)",
                params![SEED],
            )
            .map_err(|e| e.to_string())?;
        let store = Self {
            root,
            connection: Mutex::new(connection),
            relocating: AtomicBool::new(false),
            operations: AtomicUsize::new(0),
        };
        let doc = store.read()?;
        if doc["schemaVersion"] != 1 {
            return Err("此图库的数据版本暂不受支持，请使用更新的应用版本".into());
        }
        crate::session_delete::recover(&store.root, &doc)?;
        Ok(store)
    }
    pub fn operation(&self) -> Result<OperationGuard<'_>> {
        self.ensure_writable()?;
        self.operations.fetch_add(1, Ordering::AcqRel);
        if let Err(error) = self.ensure_writable() {
            self.operations.fetch_sub(1, Ordering::AcqRel);
            return Err(error);
        }
        Ok(OperationGuard(self))
    }
    pub fn reserve_relocation(&self) -> Result<()> {
        if self
            .relocating
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("正在迁移数据，请等待重启".into());
        }
        if self.operations.load(Ordering::Acquire) > 0 {
            self.cancel_relocation();
            return Err("仍有任务正在进行，请等待生成、命名或导入完成后再迁移".into());
        }
        Ok(())
    }
    pub fn cancel_relocation(&self) {
        self.relocating.store(false, Ordering::Release);
    }
    fn ensure_writable(&self) -> Result<()> {
        if self.relocating.load(Ordering::Acquire) {
            Err("数据目录正在切换，请等待重启".into())
        } else {
            Ok(())
        }
    }
    pub fn recover_interrupted(&self) -> Result<()> {
        let saved = self.read()?;
        if saved["jobs"]
            .as_array()
            .is_some_and(|jobs| jobs.iter().any(|j| j["status"] == "running"))
            || saved["sessions"]
                .as_array()
                .is_some_and(|sessions| sessions.iter().any(|s| s["titleStatus"] == "pending"))
        {
            self.change(|doc| {
                for job in list_mut(doc, "jobs")? {
                    if job["status"] == "running" {
                        job["status"] = json!("interrupted");
                        job["error"] = json!("上次运行已中断；为避免重复计费，不会自动重新提交。");
                    }
                }
                for session in list_mut(doc, "sessions")? {
                    if session["titleStatus"] == "pending" {
                        session["titleStatus"] = json!("failed");
                        session["titleError"] = json!("上次命名已中断，可手动重试。");
                    }
                }
                Ok(())
            })?;
        }
        Ok(())
    }
    pub fn read(&self) -> Result<Value> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "图库正在恢复，请重启应用")?;
        let value: String = connection
            .query_row("SELECT document FROM studio_state WHERE id=1", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&value).map_err(|e| format!("无法读取图库：{e}"))
    }
    pub fn change(&self, update: impl FnOnce(&mut Value) -> Result<()>) -> Result<Value> {
        self.ensure_writable()?;
        self.change_locked(update)
    }
    pub fn change_when_idle(&self, update: impl FnOnce(&mut Value) -> Result<()>) -> Result<Value> {
        self.reserve_relocation()?;
        let _guard = IdleWriteGuard(self);
        self.change_locked(update)
    }
    pub fn delete_session(&self, session_id: &str, references: &[String], token: &str) -> Result<Value> {
        self.delete_session_recycling(session_id, references, token, crate::recycle::directory)
    }
    fn delete_session_recycling(&self, session_id: &str, references: &[String], token: &str, recycle: impl FnOnce(&Path) -> Result<()>) -> Result<Value> {
        self.reserve_relocation()?;
        let _guard = IdleWriteGuard(self);
        let connection = self.connection.lock().map_err(|_| "图库正在恢复，请重启应用")?;
        let saved: String = connection.query_row("SELECT document FROM studio_state WHERE id=1", [], |row| row.get(0)).map_err(|e|e.to_string())?;
        let mut before: Value = serde_json::from_str(&saved).map_err(|e|e.to_string())?;
        let mut after = before.clone();
        crate::session_delete::apply(&mut after, session_id, references, token)?;
        after["revision"] = json!(before["revision"].as_u64().unwrap_or(0) + 1);
        let serialized = serde_json::to_string(&after).map_err(|e|e.to_string())?;
        let archive = crate::session_delete::Archive::stage(&self.root, &before, &after, session_id)?;
        if let Err(error) = connection.execute("UPDATE studio_state SET document=?1 WHERE id=1", params![serialized]) {
            archive.restore()?;
            return Err(format!("会话删除未保存，图片已恢复：{error}；恢复材料：{}", archive.path.display()));
        }
        if let Err(error) = recycle(&archive.path) {
            archive.restore()?;
            before["revision"] = json!(after["revision"].as_u64().unwrap_or(0) + 1);
            connection.execute("UPDATE studio_state SET document=?1 WHERE id=1", params![before.to_string()]).map_err(|e| format!("恢复记录失败：{e}；恢复材料：{}", archive.path.display()))?;
            return Err(format!("无法移入回收站，删除已取消并恢复：{error}；恢复材料：{}", archive.path.display()));
        }
        Ok(after)
    }
    fn change_locked(&self, update: impl FnOnce(&mut Value) -> Result<()>) -> Result<Value> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "图库正在恢复，请重启应用")?;
        let value: String = connection
            .query_row("SELECT document FROM studio_state WHERE id=1", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        let mut doc: Value = serde_json::from_str(&value).map_err(|e| e.to_string())?;
        update(&mut doc)?;
        doc["revision"] = json!(doc["revision"].as_u64().unwrap_or(0) + 1);
        connection
            .execute(
                "UPDATE studio_state SET document=?1 WHERE id=1",
                params![doc.to_string()],
            )
            .map_err(|e| format!("无法保存图库：{e}"))?;
        Ok(doc)
    }
    pub fn record_usage(&self, event: &Value) -> Result<()> {
        let connection = self.connection.lock().map_err(|_| "无法写入用量记录")?;
        let serialized = serde_json::to_string(event).map_err(|e| e.to_string())?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let inserted = transaction
            .execute(
                "INSERT OR IGNORE INTO usage_events(id,occurred_at,event) VALUES(?1,?2,?3)",
                params![
                    text(event, "id"),
                    event["occurredAt"].as_i64().unwrap_or(0),
                    serialized
                ],
            )
            .map_err(|e| e.to_string())?;
        let measurements = crate::usage::model_records(event);
        if inserted > 0 {
            for record in &measurements {
                transaction.execute("INSERT OR IGNORE INTO model_usage(id,occurred_at,measurement) VALUES(?1,?2,?3)",
                    params![text(record,"id"), record["occurredAt"].as_i64().unwrap_or(0), record.to_string()]).map_err(|e| e.to_string())?;
            }
        }
        transaction.commit().map_err(|e| e.to_string())?;
        if inserted > 0 {
            // SQLite is authoritative. A failed/interrupted mirror is rebuilt at startup/export.
            let _ = (|| -> std::io::Result<()> {
                fs::create_dir_all(self.root.join("usage"))?;
                let mut file = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(self.root.join("usage/usage.jsonl"))?;
                writeln!(file, "{serialized}")?;
                file.sync_data()?;
                let mut models = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(self.root.join("usage/models.jsonl"))?;
                for record in &measurements {
                    writeln!(models, "{record}")?;
                }
                models.sync_data()
            })();
        }
        Ok(())
    }
    pub fn usage_events(&self) -> Result<Vec<Value>> {
        let connection = self.connection.lock().map_err(|_| "无法读取用量记录")?;
        let mut statement = connection
            .prepare("SELECT event FROM usage_events ORDER BY occurred_at,id")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn sync_usage_journal(&self) -> Result<()> {
        // Keep the lock through replacement so a concurrent request cannot append to an old file.
        let connection = self.connection.lock().map_err(|_| "无法同步用量日志")?;
        let events = {
            let mut statement = connection
                .prepare("SELECT event FROM usage_events ORDER BY occurred_at,id")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        let transaction = connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        for serialized in &events {
            let event: Value = serde_json::from_str(serialized).map_err(|e| e.to_string())?;
            for record in crate::usage::model_records(&event) {
                transaction.execute("INSERT OR IGNORE INTO model_usage(id,occurred_at,measurement) VALUES(?1,?2,?3)",
                    params![text(&record,"id"),record["occurredAt"].as_i64().unwrap_or(0),record.to_string()]).map_err(|e|e.to_string())?;
            }
        }
        transaction.commit().map_err(|e| e.to_string())?;
        fs::create_dir_all(self.root.join("usage")).map_err(|e| e.to_string())?;
        let temp = self.root.join("usage/usage.jsonl.tmp");
        let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
        for event in events {
            writeln!(file, "{event}").map_err(|e| e.to_string())?;
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(temp, self.root.join("usage/usage.jsonl")).map_err(|e| e.to_string())?;
        let mut statement = connection
            .prepare("SELECT measurement FROM model_usage ORDER BY occurred_at,id")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let temp = self.root.join("usage/models.jsonl.tmp");
        let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
        for row in rows {
            writeln!(file, "{}", row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(temp, self.root.join("usage/models.jsonl")).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn asset_path(&self, asset: &Value) -> Result<PathBuf> {
        if asset["demo"] == true {
            return Err("示例插画仅用于界面预览，请导入实际图片后使用".into());
        }
        let relative = Path::new(text(asset, "path"));
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
            || !relative.starts_with("assets")
        {
            return Err("无效的图片路径".into());
        }
        let path = self
            .root
            .join(relative)
            .canonicalize()
            .map_err(|e| format!("无法读取原图：{e}"))?;
        let root = self.root.canonicalize().map_err(|e| e.to_string())?;
        if !path.starts_with(root) {
            return Err("图片路径超出本地图库范围".into());
        }
        Ok(path)
    }
    pub fn save_image(&self, bytes: &[u8], name: &str) -> Result<Value> {
        if bytes.len() > 128 * 1024 * 1024 {
            return Err("单张图片不能超过 128 MB".into());
        }
        let format = image::guess_format(bytes)
            .map_err(|_| "不支持的图片格式，请使用 PNG、JPEG、WebP 或 GIF")?;
        let (extension, mime) = match format {
            ImageFormat::Png => ("png", "image/png"),
            ImageFormat::Jpeg => ("jpg", "image/jpeg"),
            ImageFormat::WebP => ("webp", "image/webp"),
            ImageFormat::Gif => ("gif", "image/gif"),
            _ => return Err("不支持的图片格式，请使用 PNG、JPEG、WebP 或 GIF".into()),
        };
        let reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
        let (w, h) = reader
            .into_dimensions()
            .map_err(|e| format!("无法读取图片尺寸：{e}"))?;
        if u64::from(w) * u64::from(h) > 50_000_000 {
            return Err("图片超过 5000 万像素，请先缩小图片".into());
        }
        let decoded = image::load_from_memory_with_format(bytes, format)
            .map_err(|e| format!("无法解码图片：{e}"))?;
        let hash = format!("{:x}", Sha256::digest(bytes));
        let relative = format!("assets/{hash}.{extension}");
        let path = self.root.join(&relative);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(bytes).map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = fs::read(&path).map_err(|e| e.to_string())?;
                if Sha256::digest(&existing) != Sha256::digest(bytes) {
                    return Err("原图校验失败，已停止写入".into());
                }
            }
            Err(e) => return Err(format!("无法保存原图：{e}")),
        }
        let thumbnail = format!("thumbnails/{hash}.webp");
        if !self.root.join(&thumbnail).exists() {
            decoded
                .thumbnail(960, 960)
                .to_rgba8()
                .save_with_format(self.root.join(&thumbnail), ImageFormat::WebP)
                .map_err(|e| format!("无法生成预览图：{e}"))?;
        }
        let (width, height) = decoded.dimensions();
        Ok(
            json!({"id":hash,"title":name,"path":relative,"thumbnailPath":thumbnail,"mime":mime,"width":width,"height":height,"createdAt":now(),"workspaceId":"","sessionId":"","originalPrompt":"","submittedPrompt":"","referenceIds":[],"model":"本地导入","size":format!("{width}x{height}"),"quality":"original","groupId":hash,"favorite":false,"isReference":false,"demo":false}),
        )
    }
}

pub fn new_session(workspace_id: &str, title: &str) -> Value {
    let title_source = if ["新会话", "首次创作", "未命名会话"].contains(&title) {
        "default"
    } else {
        "manual"
    };
    json!({"id":id(),"workspaceId":workspace_id,"title":title,"titleSource":title_source,"draft":"","originalPrompt":"","referenceIds":[],"contextMode":"new","createdAt":now()})
}

pub fn needs_auto_name(session: &Value) -> bool {
    session["titleAttempted"] != true
        && (session["titleSource"] == "default"
            || (session["titleSource"].is_null()
                && ["新会话", "首次创作", "未命名会话"].contains(&text(session, "title"))))
}

pub fn insert_imports(
    doc: &mut Value,
    assets: Vec<Value>,
    session_id: Option<&str>,
) -> Result<Vec<String>> {
    let ids: Vec<String> = assets.iter().map(|a| text(a, "id").to_owned()).collect();
    if let Some(session_id) = session_id {
        let session = find(doc, "sessions", session_id)?;
        let mut references = session["referenceIds"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for asset_id in &ids {
            if !references.iter().any(|v| v.as_str() == Some(asset_id)) {
                references.push(json!(asset_id));
            }
        }
        if references.len() > 8 {
            return Err("每个会话最多支持 8 张参考图".into());
        }
        list_mut(doc, "sessions")?
            .iter_mut()
            .find(|s| text(s, "id") == session_id)
            .ok_or("会话不存在")?["referenceIds"] = json!(references);
    }
    for asset in assets {
        if let Some(existing) = list_mut(doc, "assets")?
            .iter_mut()
            .find(|a| a["id"] == asset["id"])
        {
            if asset["isReference"] == true {
                existing["isReference"] = json!(true);
            }
        } else {
            list_mut(doc, "assets")?.insert(0, asset);
        }
    }
    Ok(ids)
}

pub fn apply_action(doc: &mut Value, action: &Value) -> Result<()> {
    match text(action, "type") {
        "rename_workspace" => {
            let name=text(action,"name").trim();
            if name.is_empty()||name.chars().count()>80||name.chars().any(char::is_control){return Err("工作区名称需为 1–80 个字符，不能包含控制字符".into());}
            let workspace=list_mut(doc,"workspaces")?.iter_mut().find(|w|text(w,"id")==text(action,"id")).ok_or("工作区不存在")?;
            workspace["name"]=json!(name);
        }
        "rename_asset" => {
            let title=text(action,"title").trim();
            if title.is_empty()||title.chars().count()>200||title.chars().any(char::is_control){return Err("图片名称需为 1–200 个字符，不能包含控制字符".into());}
            let asset=list_mut(doc,"assets")?.iter_mut().find(|a|text(a,"id")==text(action,"id")).ok_or("图片不存在")?;
            asset["title"]=json!(title);
        }
        "move_session" => {
            crate::session_move::apply(doc, text(action, "id"), text(action, "workspaceId"))?
        }
        "create_workspace" => {
            let name = text(action, "name").trim();
            if name.is_empty() {
                return Err("请输入工作区名称".into());
            }
            let workspace_id = id();
            list_mut(doc, "workspaces")?
                .push(json!({"id":workspace_id,"name":name,"createdAt":now()}));
            list_mut(doc, "sessions")?.push(new_session(&workspace_id, "首次创作"));
        }
        "create_session" => {
            let workspace_id = text(action, "workspaceId");
            find(doc, "workspaces", workspace_id)?;
            if ["parentAssetId", "copyInputAssetId", "presetId"].iter().filter(|key| !text(action, key).is_empty()).count() > 1 {
                return Err("每次新建会话只能选择一种输入来源".into());
            }
            let mut session = new_session(
                workspace_id,
                if text(action, "title").is_empty() {
                    "新会话"
                } else {
                    text(action, "title")
                },
            );
            if !text(action, "parentAssetId").is_empty() {
                session["titleSource"] = json!("default");
                let asset = find(doc, "assets", text(action, "parentAssetId"))?;
                session["parentAssetId"] = asset["id"].clone();
                session["parentSessionId"] = asset["sessionId"].clone();
                session["draft"] = asset["submittedPrompt"].clone();
                session["originalPrompt"] = asset["originalPrompt"].clone();
                if asset["demo"] != true {
                    session["referenceIds"] = json!([asset["id"]]);
                }
            }
            if !text(action, "copyInputAssetId").is_empty() {
                let asset = find(doc, "assets", text(action, "copyInputAssetId"))?;
                let prompt = if text(asset,"submittedPrompt").trim().is_empty() { text(asset,"originalPrompt") } else { text(asset,"submittedPrompt") };
                if prompt.trim().is_empty() { return Err("此图片没有可复制的生成输入".into()); }
                let references = asset["referenceIds"].as_array().cloned().unwrap_or_default();
                if references.len() > 8 { return Err("本轮参考图超过 8 张，无法复制".into()); }
                for reference in &references {
                    let reference_id = reference.as_str().ok_or("本轮参考图记录无效")?;
                    find(doc,"assets",reference_id).map_err(|_| "本轮参考图已缺失，请先恢复参考图".to_string())?;
                }
                session["draft"] = json!(prompt);
                session["originalPrompt"] = json!(if text(asset,"originalPrompt").trim().is_empty() { prompt } else { text(asset,"originalPrompt") });
                session["referenceIds"] = json!(references);
                session["titleSource"] = json!("default");
                if !text(asset,"sessionId").is_empty() { session["parentSessionId"] = asset["sessionId"].clone(); }
                for key in ["size", "quality"] {
                    if !text(asset,key).is_empty() { session[key] = asset[key].clone(); }
                }
                let selection = doc["jobs"].as_array().into_iter().flatten()
                    .find(|job| job["assetIds"].as_array().is_some_and(|ids| ids.iter().any(|asset_id| asset_id == &asset["id"])))
                    .and_then(|job| job.get("imageSelection"))
                    .filter(|selection| !text(selection,"providerId").is_empty() && !text(selection,"modelId").is_empty())
                    .cloned()
                    .or_else(|| doc["settings"]["providers"].as_array().into_iter().flatten()
                        .find(|provider| text(provider,"baseUrl") == text(asset,"providerBaseUrl") && provider["models"].as_array().is_some_and(|models| models.iter().any(|model| model["kind"] == "image" && model["id"] == asset["model"])))
                        .map(|provider| json!({"providerId":provider["id"],"modelId":asset["model"]})));
                if let Some(selection) = selection { session["imageSelection"] = selection; }
            }
            if !text(action, "presetId").is_empty() {
                let preset = find(doc, "presets", text(action, "presetId"))?;
                session["draft"] = preset["prompt"].clone();
                session["originalPrompt"] = preset["prompt"].clone();
                session["referenceIds"] = preset["referenceIds"].clone();
                session["size"] = preset["size"].clone();
                session["quality"] = preset["quality"].clone();
            }
            list_mut(doc, "sessions")?.push(session);
        }
        "update_session" => {
            if let Some(selection)=action.get("imageSelection") {
                if !selection.is_null()&&(!selection.is_object()||text(selection,"providerId").is_empty()||text(selection,"modelId").is_empty()){return Err("绘图模型选择格式错误".into());}
            }
            let session = list_mut(doc, "sessions")?
                .iter_mut()
                .find(|s| text(s, "id") == text(action, "id"))
                .ok_or("会话不存在")?;
            for key in [
                "draft",
                "originalPrompt",
                "referenceIds",
                "contextMode",
                "title",
                "size",
                "quality",
                "imageSelection",
            ] {
                if let Some(value) = action.get(key) {
                    let valid = if key == "referenceIds" {
                        value
                            .as_array()
                            .is_some_and(|items| items.iter().all(Value::is_string))
                    } else if key=="imageSelection" {true} else {
                        value.is_string()
                    };
                    if !valid {
                        return Err("会话数据格式错误".into());
                    }
                    session[key] = value.clone();
                    if key == "title" {
                        session["titleSource"] = json!("manual");
                    }
                }
            }
        }
        "favorite" | "toggle_reference" => {
            let asset = list_mut(doc, "assets")?
                .iter_mut()
                .find(|a| text(a, "id") == text(action, "id"))
                .ok_or("图片不存在")?;
            if text(action, "type") == "toggle_reference" && asset["demo"] == true {
                return Err("请导入实际图片作为参考图".into());
            }
            let key = if text(action, "type") == "favorite" {
                "favorite"
            } else {
                "isReference"
            };
            asset[key] = json!(!asset[key].as_bool().unwrap_or(false));
        }
        "save_preset" => {
            let asset = find(doc, "assets", text(action, "assetId"))?.clone();
            let name = text(action, "name").trim();
            if name.is_empty() {
                return Err("请输入效果名称".into());
            }
            list_mut(doc,"presets")?.push(json!({"id":id(),"name":name,"description":"从作品保存的效果配置","assetId":asset["id"],"prompt":asset["submittedPrompt"],"size":asset["size"],"quality":asset["quality"],"referenceIds":asset["referenceIds"],"createdAt":now()}));
        }
        _ => return Err("不支持的操作".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session_input_copy_document() -> Value {
        let mut doc: Value = serde_json::from_str(SEED).unwrap();
        doc["assets"][0]["submittedPrompt"] = json!("实际提交的这一轮提示词");
        doc["assets"][0]["originalPrompt"] = json!("原始创作意图");
        doc["assets"][0]["revisedPrompt"] = json!("服务端修订文本，不作为输入副本");
        doc["assets"][0]["referenceIds"] = json!(["demo-botanic","demo-mountain"]);
        doc["assets"][0]["size"] = json!("1536x1024");
        doc["assets"][0]["quality"] = json!("medium");
        doc["assets"][0]["model"] = json!("original-image-model");
        doc["assets"][0]["providerBaseUrl"] = json!("https://original.example/v1");
        doc["assets"][0]["demo"] = json!(false);
        doc["assets"][0]["responseId"] = json!("resp-result");
        doc["assets"][0]["previousResponseId"] = json!("resp-previous");
        doc["sessions"][0]["draft"] = json!("后来编辑但未提交的内容");
        doc["sessions"][0]["referenceIds"] = json!(["demo-night"]);
        doc["sessions"][0]["lastResponseId"] = json!("resp-latest");
        doc["sessions"][0]["imageSelection"] = json!({"providerId":"changed","modelId":"changed-model"});
        doc["jobs"] = json!([{"id":"original-job","sessionId":"demo-material","assetIds":["demo-fox-v3"],"imageSelection":{"providerId":"original-provider","modelId":"original-image-model"}}]);
        doc["settings"]["providers"] = json!([{"id":"original-provider","baseUrl":"https://original.example/v1","models":[{"id":"original-image-model","kind":"image"}]}]);
        doc
    }
    #[test]
    fn session_input_copy_uses_selected_result_inputs_and_preserves_source_data() {
        let mut doc = session_input_copy_document();
        let before = doc.clone();
        apply_action(&mut doc,&json!({"type":"create_session","workspaceId":"demo-plush","title":"输入副本","copyInputAssetId":"demo-fox-v3"})).unwrap();
        let copy = doc["sessions"].as_array().unwrap().last().unwrap();
        assert_eq!(copy["draft"],"实际提交的这一轮提示词");
        assert_eq!(copy["originalPrompt"],"原始创作意图");
        assert_eq!(copy["referenceIds"],json!(["demo-botanic","demo-mountain"]));
        assert_eq!(copy["size"],"1536x1024");
        assert_eq!(copy["quality"],"medium");
        assert_eq!(copy["imageSelection"],before["jobs"][0]["imageSelection"]);
        assert_eq!(copy["contextMode"],"new");
        assert_eq!(copy["titleSource"],"default");
        assert_eq!(copy["parentSessionId"],"demo-material");
        assert!(copy.get("parentAssetId").is_none());
        for key in ["lastResponseId","lastProviderId","lastProviderBaseUrl","lastMainModel"] { assert!(copy.get(key).is_none()); }
        assert_ne!(copy["id"],before["sessions"][0]["id"]);
        doc["sessions"].as_array_mut().unwrap().pop();
        assert_eq!(doc,before);
    }
    #[test]
    fn session_input_copy_without_job_recovers_model_and_supports_text_only_results() {
        let mut doc = session_input_copy_document();
        doc["jobs"] = json!([]);
        doc["assets"][0]["referenceIds"] = json!([]);
        doc["assets"][0]["submittedPrompt"] = json!("");
        apply_action(&mut doc,&json!({"type":"create_session","workspaceId":"demo-plush","copyInputAssetId":"demo-fox-v3"})).unwrap();
        let copy = doc["sessions"].as_array().unwrap().last().unwrap();
        assert_eq!(copy["draft"],"原始创作意图");
        assert_eq!(copy["referenceIds"],json!([]));
        assert_eq!(copy["imageSelection"],json!({"providerId":"original-provider","modelId":"original-image-model"}));
    }
    #[test]
    fn session_input_copy_rejects_missing_inputs_and_ambiguous_sources_atomically() {
        for kind in ["missing-reference","missing-prompt","ambiguous-source","too-many-references"] {
            let mut doc = session_input_copy_document();
            let mut action = json!({"type":"create_session","workspaceId":"demo-plush","copyInputAssetId":"demo-fox-v3"});
            match kind {
                "missing-reference" => doc["assets"][0]["referenceIds"] = json!(["missing"]),
                "missing-prompt" => {doc["assets"][0]["submittedPrompt"] = json!("");doc["assets"][0]["originalPrompt"] = json!("");},
                "ambiguous-source" => action["parentAssetId"] = json!("demo-fox-v3"),
                _ => doc["assets"][0]["referenceIds"] = json!(vec!["demo-mountain";9]),
            }
            let before = doc.clone();
            assert!(apply_action(&mut doc,&action).is_err(),"{kind}");
            assert_eq!(doc,before,"{kind}");
        }
    }
    #[test]
    fn session_input_copy_keeps_use_result_as_reference_distinct() {
        let mut doc = session_input_copy_document();
        apply_action(&mut doc,&json!({"type":"create_session","workspaceId":"demo-plush","parentAssetId":"demo-fox-v3"})).unwrap();
        let session = doc["sessions"].as_array().unwrap().last().unwrap();
        assert_eq!(session["referenceIds"],json!(["demo-fox-v3"]));
        assert_eq!(session["parentAssetId"],"demo-fox-v3");
        assert_eq!(session["draft"],"实际提交的这一轮提示词");
    }
    fn deletion_store() -> Store {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../output/session-delete-20261105/tests").join(id());
        fs::create_dir_all(&root).unwrap();
        let store = Store::open(root).unwrap();
        store.change(|doc| { *doc = crate::session_delete::tests::document(); Ok(()) }).unwrap();
        for path in ["assets/output.png","thumbnails/output.webp","assets/private.png","thumbnails/private.webp"] {
            fs::write(store.root.join(path), path.as_bytes()).unwrap();
        }
        store
    }
    #[test]
    fn session_delete_recycle_failure_restores_records_and_original_files() {
        let store = deletion_store();
        let before = store.read().unwrap();
        let token = crate::session_delete::preview(&before,"deleting").unwrap().token;
        let error = store.delete_session_recycling("deleting", &["private".into()], &token, |_| Err("simulated unavailable recycle bin".into())).unwrap_err();
        assert!(error.contains("删除已取消并恢复"));
        let mut restored = store.read().unwrap();
        restored["revision"] = before["revision"].clone();
        assert_eq!(restored,before);
        assert_eq!(fs::read(store.root.join("assets/output.png")).unwrap(),b"assets/output.png");
        assert_eq!(fs::read(store.root.join("assets/private.png")).unwrap(),b"assets/private.png");
    }
    #[cfg(windows)]
    #[test]
    fn session_delete_recycles_only_unshared_files_and_keeps_a_recovery_manifest() {
        let store = deletion_store();
        store.change(|doc| {
            list_mut(doc,"assets")?.push(json!({"id":"same-bytes","sessionId":"other","path":"assets/output.png","thumbnailPath":"thumbnails/output.webp","referenceIds":[]}));
            Ok(())
        }).unwrap();
        let token = crate::session_delete::preview(&store.read().unwrap(),"deleting").unwrap().token;
        let after = store.delete_session_recycling("deleting", &["private".into()], &token, |path| {
            let manifest: Value = serde_json::from_slice(&fs::read(path.join("session.json")).unwrap()).unwrap();
            assert_eq!(manifest["session"]["id"],"deleting");
            assert!(path.join("assets/private.png").exists());
            assert!(!path.join("assets/output.png").exists());
            crate::recycle::directory(path)?;
            println!("RECYCLED_SESSION_ARCHIVE={}",path.display());
            Ok(())
        }).unwrap();
        assert!(find(&after,"sessions","deleting").is_err());
        assert!(find(&after,"assets","private").is_err());
        assert!(store.root.join("assets/output.png").exists());
        assert!(!store.root.join("assets/private.png").exists());
    }
    #[test]
    fn session_delete_rejects_unsafe_paths_before_changing_records_or_files() {
        let store = deletion_store();
        store.change(|doc| { doc["assets"][5]["path"] = json!("../outside.png"); Ok(()) }).unwrap();
        let before = store.read().unwrap();
        let token = crate::session_delete::preview(&before,"deleting").unwrap().token;
        assert!(store.delete_session("deleting",&[],&token).is_err());
        assert_eq!(store.read().unwrap(),before);
        assert!(store.root.join("assets/output.png").exists());
    }
    #[cfg(windows)]
    #[test]
    fn session_delete_interrupted_before_commit_restores_files_on_reopen() {
        let store = deletion_store();
        let before = store.read().unwrap();
        let token = crate::session_delete::preview(&before,"deleting").unwrap().token;
        let mut after = before.clone();
        crate::session_delete::apply(&mut after,"deleting",&["private".into()],&token).unwrap();
        let archive = crate::session_delete::Archive::stage(&store.root,&before,&after,"deleting").unwrap();
        let archive_path = archive.path.clone();
        let root = store.root.clone();
        assert!(!root.join("assets/private.png").exists());
        drop(store);
        let reopened = Store::open(root).unwrap();
        assert_eq!(reopened.read().unwrap(),before);
        assert_eq!(fs::read(reopened.root.join("assets/private.png")).unwrap(),b"assets/private.png");
        assert!(!archive_path.exists());
    }
    #[cfg(windows)]
    #[test]
    fn session_delete_interrupted_after_commit_finishes_recycling_on_reopen() {
        let store = deletion_store();
        let before = store.read().unwrap();
        let token = crate::session_delete::preview(&before,"deleting").unwrap().token;
        let mut after = before.clone();
        crate::session_delete::apply(&mut after,"deleting",&["private".into()],&token).unwrap();
        let archive = crate::session_delete::Archive::stage(&store.root,&before,&after,"deleting").unwrap();
        let archive_path = archive.path.clone();
        store.change(|doc|{*doc=after;Ok(())}).unwrap();
        let root = store.root.clone();
        drop(store);
        let reopened=Store::open(root).unwrap();
        assert!(find(&reopened.read().unwrap(),"sessions","deleting").is_err());
        assert!(!reopened.root.join("assets/private.png").exists());
        assert!(!archive_path.exists());
    }
    #[test]
    fn workspace_rename_persists_and_preserves_all_relationships(){
        let dir=tempfile::tempdir().unwrap();let store=Store::open(dir.path().into()).unwrap();let before=store.read().unwrap();
        let saved=store.change(|doc|apply_action(doc,&json!({"type":"rename_workspace","id":"demo-plush","name":"  角色材质研究  "}))).unwrap();
        let mut expected=before.clone();expected["workspaces"][0]["name"]=json!("角色材质研究");expected["revision"]=saved["revision"].clone();assert_eq!(saved,expected);
        for name in [String::new(),"   ".into(),"bad\nname".into(),"x".repeat(81)]{assert!(store.change(|doc|apply_action(doc,&json!({"type":"rename_workspace","id":"demo-plush","name":name}))).is_err());}
        assert!(store.change(|doc|apply_action(doc,&json!({"type":"rename_workspace","id":"missing","name":"New name"}))).is_err());
        assert_eq!(store.read().unwrap(),saved);drop(store);
        let reopened=Store::open(dir.path().into()).unwrap();assert_eq!(reopened.read().unwrap(),saved);
    }
    #[test]
    fn logical_rename_and_session_model_choice_persist_without_changing_original_files(){
        let dir=tempfile::tempdir().unwrap();let store=Store::open(dir.path().into()).unwrap();
        let bytes=include_bytes!("../icons/icon.png");let asset=store.save_image(bytes,"reference.png").unwrap();
        let asset_id=text(&asset,"id").to_owned();let path=store.asset_path(&asset).unwrap();
        let settings=store.read().unwrap()["settings"].clone();let choice=settings["modelAssignments"]["image"].clone();
        store.change(|doc|{list_mut(doc,"assets")?.push(asset.clone());Ok(())}).unwrap();
        store.change(|doc|apply_action(doc,&json!({"type":"rename_asset","id":asset_id,"title":"  角色三视图  "}))).unwrap();
        store.change(|doc|apply_action(doc,&json!({"type":"update_session","id":"demo-material","imageSelection":choice}))).unwrap();
        let saved=store.read().unwrap();let renamed=find(&saved,"assets",&asset_id).unwrap();
        let mut expected=asset.clone();expected["title"]=json!("角色三视图");assert_eq!(renamed,&expected);
        assert_eq!(fs::read(&path).unwrap(),bytes);assert_eq!(saved["settings"],settings);
        for title in ["", "   ", "bad\nname"]{assert!(store.change(|doc|apply_action(doc,&json!({"type":"rename_asset","id":asset_id,"title":title}))).is_err());}
        assert_eq!(store.read().unwrap(),saved);drop(store);
        let reopened=Store::open(dir.path().into()).unwrap();let restored=reopened.read().unwrap();
        assert_eq!(find(&restored,"assets",&asset_id).unwrap()["title"],"角色三视图");
        assert_eq!(find(&restored,"sessions","demo-material").unwrap()["imageSelection"],choice);
        reopened.change(|doc|apply_action(doc,&json!({"type":"update_session","id":"demo-material","imageSelection":null}))).unwrap();
        assert!(find(&reopened.read().unwrap(),"sessions","demo-material").unwrap()["imageSelection"].is_null());
    }
    #[test]
    fn model_measurements_backfill_frozen_quotes_and_repair_journal_without_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf()).unwrap();
        let event: Value =
            serde_json::from_str(include_str!("../tests/fixtures/usage-event.json")).unwrap();
        // Upgrade from a database containing only original events.
        store
            .connection
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO usage_events VALUES(?1,?2,?3)",
                rusqlite::params![
                    text(&event, "id"),
                    event["occurredAt"].as_i64(),
                    event.to_string()
                ],
            )
            .unwrap();
        store.sync_usage_journal().unwrap();
        let expected = fs::read_to_string(dir.path().join("usage/models.jsonl")).unwrap();
        assert_eq!(expected.lines().count(), 2);
        store.record_usage(&event).unwrap();
        fs::write(dir.path().join("usage/models.jsonl"), "interrupted line").unwrap();
        store.sync_usage_journal().unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("usage/models.jsonl")).unwrap(),
            expected
        );
        assert_eq!(store.usage_events().unwrap(), vec![event]);
        let count: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM model_usage", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }
    #[test]
    fn relocation_waits_for_active_operations_and_blocks_new_writes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf()).unwrap();
        let operation = store.operation().unwrap();
        assert!(store.reserve_relocation().is_err());
        drop(operation);
        store.reserve_relocation().unwrap();
        assert!(store.operation().is_err());
        assert!(store.change(|_| Ok(())).is_err());
        store.cancel_relocation();
        assert!(store.operation().is_ok());
    }
    #[test]
    fn usage_is_durable_idempotent_and_journal_can_be_rebuilt() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf()).unwrap();
        let event = json!({"id":"request","occurredAt":1,"requestCount":1,"components":[]});
        store.record_usage(&event).unwrap();
        store.record_usage(&event).unwrap();
        assert_eq!(store.usage_events().unwrap().len(), 1);
        fs::write(dir.path().join("usage/usage.jsonl"), "interrupted line").unwrap();
        store.sync_usage_journal().unwrap();
        let journal = fs::read_to_string(dir.path().join("usage/usage.jsonl")).unwrap();
        assert_eq!(journal.lines().count(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(journal.trim()).unwrap(),
            event
        );
        drop(store);
        assert_eq!(
            Store::open(dir.path().to_path_buf())
                .unwrap()
                .usage_events()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn pasted_references_are_deduplicated_and_are_not_generation_results() {
        let mut doc: Value = serde_json::from_str(SEED).unwrap();
        let asset = json!({"id":"pasted","sessionId":"","isReference":false});
        insert_imports(&mut doc, vec![asset.clone()], Some("demo-material")).unwrap();
        insert_imports(&mut doc, vec![asset], Some("demo-material")).unwrap();
        assert_eq!(
            find(&doc, "sessions", "demo-material").unwrap()["referenceIds"],
            json!(["pasted"])
        );
        assert_eq!(
            doc["assets"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|a| a["id"] == "pasted")
                .count(),
            1
        );
        assert_eq!(find(&doc, "assets", "pasted").unwrap()["sessionId"], "");
    }
    #[test]
    fn auto_naming_preserves_manual_titles_and_does_not_repeat_attempts() {
        let mut session = new_session("workspace", "新会话");
        assert!(needs_auto_name(&session));
        session["titleAttempted"] = json!(true);
        assert!(!needs_auto_name(&session));
        assert!(!needs_auto_name(&new_session(
            "workspace",
            "我的自定义名称"
        )));
        let legacy = json!({"title":"材质与光照"});
        assert!(!needs_auto_name(&legacy));
    }
    #[test]
    fn original_is_preserved_thumbnail_is_separate_and_metadata_survives_restart() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path().to_owned()).unwrap();
        let image = image::RgbaImage::from_pixel(18, 12, image::Rgba([10, 80, 150, 255]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let original = bytes.into_inner();
        let asset = store.save_image(&original, "测试原图").unwrap();
        let again = store.save_image(&original, "再次导入").unwrap();
        assert_eq!(asset["id"], again["id"]);
        assert_eq!(
            fs::read(store.asset_path(&asset).unwrap()).unwrap(),
            original
        );
        assert!(store.root.join(text(&asset, "thumbnailPath")).is_file());
        store
            .change(|doc| {
                list_mut(doc, "assets")?.push(asset.clone());
                Ok(())
            })
            .unwrap();
        drop(store);
        let reopened = Store::open(directory.path().to_owned()).unwrap();
        assert!(find(&reopened.read().unwrap(), "assets", text(&asset, "id")).is_ok());
    }
    #[test]
    fn failed_action_does_not_replace_saved_document() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path().to_owned()).unwrap();
        let before = store.read().unwrap();
        assert!(store
            .change(|doc| apply_action(
                doc,
                &json!({"type":"create_session","workspaceId":"missing"})
            ))
            .is_err());
        assert_eq!(store.read().unwrap(), before);
    }
}
