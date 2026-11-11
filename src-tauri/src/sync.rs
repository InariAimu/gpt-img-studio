use crate::{
    network, provider,
    store::{now, text, Result, Store},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use studio_sync::{client::Exchange, ClientState};
use tauri::{Emitter, Manager};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    pub url: String,
    pub device_id: String,
    pub direct: bool,
}
impl Config {
    fn credential_kind(&self) -> String {
        format!("sync:{}", self.device_id)
    }
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub paused_for_gallery: bool,
    pub last_success: Option<String>,
    pub error: Option<String>,
    pub uploaded: usize,
    pub downloaded: usize,
}
#[derive(Default)]
pub struct Runtime {
    busy: AtomicBool,
    editing: AtomicBool,
    status: Mutex<Status>,
}
pub fn set_editing(runtime: &Runtime, editing: bool) {
    runtime.editing.store(editing, Ordering::Release);
}
struct Guard<'a>(&'a Runtime);
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}
impl Store {
    pub(crate) fn init_sync(&self) -> Result<()> {
        self.connection.lock().map_err(|e|e.to_string())?.execute_batch("CREATE TABLE IF NOT EXISTS sync_local (id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,state TEXT NOT NULL);").map_err(|e|e.to_string())?;
        Ok(())
    }
    fn sync_saved(&self) -> Result<(Config, ClientState)> {
        let db = self.connection.lock().map_err(|e| e.to_string())?;
        let row: Option<(String, String)> = db
            .query_row("SELECT config,state FROM sync_local WHERE id=1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
            .map_err(|e| e.to_string())?;
        row.map(|(c, s)| {
            Ok((
                serde_json::from_str(&c).map_err(|e| e.to_string())?,
                serde_json::from_str(&s).map_err(|e| e.to_string())?,
            ))
        })
        .unwrap_or_else(|| Ok((Config::default(), ClientState::default())))
    }
    fn finish_sync(&self, e: Exchange) -> Result<Value> {
        let mut db = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let saved: String = tx
            .query_row("SELECT document FROM studio_state WHERE id=1", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        let state: String = tx
            .query_row("SELECT state FROM sync_local WHERE id=1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let mut doc: Value = serde_json::from_str(&saved).map_err(|e| e.to_string())?;
        if doc["jobs"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|j| j["status"] == "running")
            || doc["sessions"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|s| s["titleStatus"] == "pending")
        {
            return Err("创作任务已开始，下载内容将在任务结束后合并".into());
        }
        let previous = studio_sync::project(&doc);
        let (mut entities, mut state) = studio_sync::reconcile(
            &previous,
            serde_json::from_str(&state).map_err(|e| e.to_string())?,
            &e.sent,
            &e.accepted,
            &e.remote,
        );
        studio_sync::preserve_sketch_conflicts(&mut entities, &mut state);
        studio_sync::protect_references(&mut entities, &previous, &mut state)?;
        studio_sync::apply(&mut doc, &entities);
        for asset in doc["assets"].as_array_mut().into_iter().flatten() {
            if asset["demo"] != true && text(asset, "mime") == "image/svg+xml" {
                asset["thumbnailPath"] = json!(self.ensure_svg_preview(asset)?);
            }
        }
        // Remote originals are immediately usable; previews are optional and remain local.
        state.server_id = e.server_id;
        state.cursor = e.cursor;
        doc["revision"] = json!(doc["revision"].as_u64().unwrap_or(0) + 1);
        tx.execute(
            "UPDATE studio_state SET document=?1 WHERE id=1",
            [doc.to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE sync_local SET state=?1 WHERE id=1",
            [serde_json::to_string(&state).map_err(|e| e.to_string())?],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(doc)
    }
}
pub fn view(store: &Store, runtime: &Runtime) -> Result<Value> {
    let (config, state) = store.sync_saved()?;
    let mut status = runtime.status.lock().map_err(|e| e.to_string())?.clone();
    status.running = runtime.busy.load(Ordering::Acquire);
    status.paused_for_gallery = crate::gallery_import::has_pending(store)?;
    Ok(
        json!({"hasToken":!config.url.is_empty()&&provider::has_key(&config.credential_kind(),&config.url),"pending":studio_sync::mutations(&studio_sync::project(&store.read()?),&state).len(),"config":config,"status":status,"conflicts":state.conflicts.values().collect::<Vec<_>>() }),
    )
}
pub fn configure(
    store: &Store,
    runtime: &Runtime,
    mut config: Config,
    token: Option<String>,
) -> Result<Value> {
    let _op = store.operation()?;
    if runtime
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("同步正在进行，请稍后保存".into());
    }
    let _guard = Guard(runtime);
    config.url = studio_sync::client::normalize_url(&config.url)?;
    if !studio_sync::valid_id(&config.device_id) {
        return Err("设备 ID 只能包含字母、数字、横线和下划线".into());
    }
    let (old, _) = store.sync_saved()?;
    if !old.device_id.is_empty() && old.device_id != config.device_id {
        return Err("已关联的同步设备 ID 不能更换，请使用原设备 ID".into());
    }
    if let Some(token) = token.filter(|v| !v.trim().is_empty()) {
        if token.trim().len() < 32 {
            return Err("同步令牌至少需要 32 个字符".into());
        }
        provider::save_key(&config.credential_kind(), &config.url, token.trim())?;
    }
    if config.enabled && !provider::has_key(&config.credential_kind(), &config.url) {
        return Err("请填写此同步地址对应的设备令牌".into());
    }
    let db = store.connection.lock().map_err(|e| e.to_string())?;
    db.execute("INSERT INTO sync_local VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET config=excluded.config",params![serde_json::to_string(&config).map_err(|e|e.to_string())?,serde_json::to_string(&ClientState::default()).unwrap()]).map_err(|e|e.to_string())?;
    drop(db);
    drop(_guard);
    view(store, runtime)
}
pub fn import_config(store: &Store, runtime: &Runtime, path: std::path::PathBuf) -> Result<Value> {
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 64 * 1024 {
        return Err("连接文件过大".into());
    }
    let value: Value = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "连接文件不是有效 JSON")?;
    let config: Config =
        serde_json::from_value(value["config"].clone()).map_err(|_| "连接文件缺少配置")?;
    configure(
        store,
        runtime,
        config,
        value["token"].as_str().map(str::to_string),
    )
}
pub fn resolve(store: &Store, runtime: &Runtime, key: String, use_local: bool) -> Result<Value> {
    let _op = store.operation()?;
    if runtime
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("同步正在进行，请稍后处理冲突".into());
    }
    let _guard = Guard(runtime);
    let mut db = store.connection.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let serialized: String = tx
        .query_row("SELECT state FROM sync_local WHERE id=1", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut state: ClientState = serde_json::from_str(&serialized).map_err(|e| e.to_string())?;
    let conflict = state.conflicts.remove(&key).ok_or("冲突已处理")?;
    let saved: String = tx
        .query_row("SELECT document FROM studio_state WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let mut doc: Value = serde_json::from_str(&saved).map_err(|e| e.to_string())?;
    if !use_local {
        let mut entities = studio_sync::project(&doc);
        studio_sync::set(&mut entities, &key, conflict.remote);
        studio_sync::validate_graph(&entities)?;
        studio_sync::apply(&mut doc, &entities);
    }
    doc["revision"] = json!(doc["revision"].as_u64().unwrap_or(0) + 1);
    tx.execute(
        "UPDATE studio_state SET document=?1 WHERE id=1",
        [doc.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE sync_local SET state=?1 WHERE id=1",
        [serde_json::to_string(&state).unwrap()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(doc)
}
pub fn is_running(runtime: &Runtime) -> bool { runtime.busy.load(Ordering::Acquire) }
pub async fn run(app: &tauri::AppHandle) -> Result<Value> {
    let runtime = app.state::<Runtime>();
    let store = app.state::<Store>();
    if runtime
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return view(&store, &runtime);
    }
    let guard = Guard(&runtime);
    if crate::gallery_import::has_pending(&store)? {
        drop(guard);
        let value=view(&store,&runtime)?;
        let _=app.emit("studio:sync",&value);
        return Ok(value);
    }
    if let Ok(value) = view(&store, &runtime) {
        let _ = app.emit("studio:sync", value);
    }
    let result = async {
        let _op = store.operation()?;
        let (config, state) = store.sync_saved()?;
        // `enabled` controls the automatic timer; configured devices may always sync manually.
        if config.url.is_empty() || config.device_id.is_empty() {
            return Err("请先配置多设备同步连接".into());
        }
        let doc = store.read()?;
        // Do not export an intermediate generation/naming transaction.
        if doc["jobs"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|j| j["status"] == "running")
            || doc["sessions"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|s| s["titleStatus"] == "pending")
        {
            return Err("正在创作，任务结束后自动同步".into());
        }
        let token = provider::get_key(&config.credential_kind(), &config.url)?;
        let network = if config.direct {
            network::Settings {
                mode: network::Mode::Direct,
                proxy_url: String::new(),
            }
        } else {
            network::Settings::from_settings(&doc["settings"])?
        };
        let client = network.client(Duration::from_secs(300), Duration::from_secs(10))?;
        let exchange = studio_sync::client::exchange(
            &client,
            &config.url,
            &token,
            &config.device_id,
            &store.root,
            &studio_sync::project(&doc),
            &state,
        )
        .await?;
        let uploaded = exchange.uploaded;
        let downloaded = exchange.downloaded;
        if runtime.editing.load(Ordering::Acquire) {
            return Err("正在编辑，离开输入框后继续同步；已下载原图会保留".into());
        }
        let document = store.finish_sync(exchange)?;
        let _ = app.emit("studio:changed", document);
        *runtime.status.lock().map_err(|e| e.to_string())? = Status {
            last_success: Some(now()),
            uploaded,
            downloaded,
            ..Status::default()
        };
        Ok::<(), String>(())
    }
    .await;
    if let Err(e) = &result {
        runtime.status.lock().map_err(|e| e.to_string())?.error = Some(e.clone());
    }
    drop(guard);
    let value = view(&store, &runtime)?;
    let _ = app.emit("studio:sync", &value);
    result?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sync_skips_demo_svg_and_generates_real_svg_preview() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../output/sync-svg-regression")
            .join(uuid::Uuid::new_v4().to_string());
        let store = Store::open(root).unwrap();
        store.init_sync().unwrap();
        let before = store.read().unwrap();
        let demos: Vec<_> = before["assets"].as_array().unwrap().iter()
            .filter(|asset| asset["demo"] == true && text(asset, "mime") == "image/svg+xml")
            .cloned().collect();
        assert!(!demos.is_empty());
        let mut svg = store.save_svg(br#"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>"#, "real.svg").unwrap();
        let expected_preview = svg["thumbnailPath"].clone();
        svg["thumbnailPath"] = json!("remote-preview-not-present.png");
        store.connection.lock().unwrap().execute(
            "INSERT INTO sync_local VALUES(1,?1,?2)",
            params![serde_json::to_string(&Config::default()).unwrap(), serde_json::to_string(&ClientState::default()).unwrap()],
        ).unwrap();
        let doc = store.finish_sync(Exchange {
            sent: vec![], accepted: vec![],
            remote: vec![studio_sync::Record { key: format!("assets/{}", text(&svg, "id")), revision: 1, value: Some(svg.clone()) }],
            server_id: "server".into(), cursor: 1, uploaded: 0, downloaded: 1,
        }).unwrap();
        for demo in demos {
            assert!(doc["assets"].as_array().unwrap().contains(&demo));
        }
        let merged = doc["assets"].as_array().unwrap().iter().find(|asset| asset["id"] == svg["id"]).unwrap();
        assert_eq!(merged["thumbnailPath"], expected_preview);
        assert_eq!(store.sync_saved().unwrap().1.cursor, 1);
    }
    #[test]
    fn sync_state_and_document_commit_together_without_replacing_settings_or_usage() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../output/sync-v1/desktop-tests")
            .join(uuid::Uuid::new_v4().to_string());
        let store = Store::open(root.clone()).unwrap();
        store.init_sync().unwrap();
        let before = store.read().unwrap();
        let config = Config {
            device_id: "pc".into(),
            ..Config::default()
        };
        store
            .connection
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO sync_local VALUES(1,?1,?2)",
                params![
                    serde_json::to_string(&config).unwrap(),
                    serde_json::to_string(&ClientState::default()).unwrap()
                ],
            )
            .unwrap();
        let record = studio_sync::Record {
            key: "workspaces/remote".into(),
            revision: 1,
            value: Some(json!({"id":"remote","name":"remote workspace"})),
        };
        let e = Exchange {
            sent: vec![],
            accepted: vec![],
            remote: vec![record.clone()],
            server_id: "server".into(),
            cursor: 1,
            uploaded: 0,
            downloaded: 0,
        };
        let doc = store.finish_sync(e).unwrap();
        assert_eq!(before["settings"], doc["settings"]);
        assert_eq!(before["installationId"], doc["installationId"]);
        assert!(doc["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w["id"] == "remote"));
        drop(store);
        let reopened = Store::open(root).unwrap();
        let (_, state) = reopened.sync_saved().unwrap();
        assert_eq!(state.cursor, 1);
        assert_eq!(state.baseline["workspaces/remote"], record);
        assert!(reopened.usage_events().unwrap().is_empty());
    }
}
