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
        let inserted = connection
            .execute(
                "INSERT OR IGNORE INTO usage_events(id,occurred_at,event) VALUES(?1,?2,?3)",
                params![
                    text(event, "id"),
                    event["occurredAt"].as_i64().unwrap_or(0),
                    serialized
                ],
            )
            .map_err(|e| e.to_string())?;
        if inserted > 0 {
            // SQLite is authoritative. A failed/interrupted mirror is rebuilt at startup/export.
            let _ = (|| -> std::io::Result<()> {
                fs::create_dir_all(self.root.join("usage"))?;
                let mut file = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(self.root.join("usage/usage.jsonl"))?;
                writeln!(file, "{serialized}")?;
                file.sync_data()
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
        let mut statement = connection
            .prepare("SELECT event FROM usage_events ORDER BY occurred_at,id")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        fs::create_dir_all(self.root.join("usage")).map_err(|e| e.to_string())?;
        let temp = self.root.join("usage/usage.jsonl.tmp");
        let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
        for row in rows {
            writeln!(file, "{}", row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(temp, self.root.join("usage/usage.jsonl")).map_err(|e| e.to_string())?;
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
            ] {
                if let Some(value) = action.get(key) {
                    let valid = if key == "referenceIds" {
                        value
                            .as_array()
                            .is_some_and(|items| items.iter().all(Value::is_string))
                    } else {
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
