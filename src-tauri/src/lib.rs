mod network;
mod provider;
mod providers;
mod session_move;
mod session_delete;
mod recycle;
mod storage;
mod taskbar;
mod store;
mod usage;
mod sync;
mod gallery;
use base64::{engine::general_purpose::STANDARD, Engine};
use provider::GenerationRequest;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use store::{
    apply_action, find, id, insert_imports, list_mut, needs_auto_name, now, text, Result, Store,
};
use tauri::{Emitter, Manager, State};

fn changed(app: &tauri::AppHandle, document: Value) -> Value {
    taskbar::sync(app, &document);
    let _ = app.emit("studio:changed", &document);
    document
}
fn bootstrap_value(app: &tauri::AppHandle, store: &Store) -> Result<Value> {
    let document = store.read()?;
    let settings = &document["settings"];
    let has_image_key = provider::has_role_key(settings, "image");
    let has_refine_key = provider::has_role_key(settings, "refine");
    let provider_keys: serde_json::Map<String, Value> = settings["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            (
                text(p, "id").into(),
                json!(provider::has_key(
                    &providers::credential_kind(p),
                    text(p, "baseUrl")
                )),
            )
        })
        .collect();
    Ok(
        json!({"document":document,"dataDir":store.root.to_string_lossy(),"hasImageKey":has_image_key,"hasRefineKey":has_refine_key,"providerKeys":provider_keys,"storageNotice":app.path().app_data_dir().ok().and_then(|base|storage::notice(&base))}),
    )
}
#[tauri::command]
fn bootstrap(app: tauri::AppHandle, store: State<'_, Store>) -> Result<Value> {
    bootstrap_value(&app, &store)
}
#[tauri::command]
fn gallery_settings(store: State<'_, Store>) -> Result<Value> { gallery::view(&store) }
#[tauri::command]
fn save_gallery_settings(store: State<'_, Store>, config: gallery::Config, token: Option<String>, forget_token: bool) -> Result<Value> {
    gallery::save(&store, config, token, forget_token)
}
#[tauri::command]
async fn test_gallery_settings(store: State<'_, Store>, config: gallery::Config, token: Option<String>) -> Result<Value> {
    gallery::test(&store, config, token).await
}
#[tauri::command]
fn sync_status(store:State<'_,Store>,runtime:State<'_,sync::Runtime>)->Result<Value>{sync::view(&store,&runtime)}
#[tauri::command]
fn set_sync_editing(runtime:State<'_,sync::Runtime>,editing:bool){sync::set_editing(&runtime,editing)}
#[tauri::command]
fn save_sync_config(store:State<'_,Store>,runtime:State<'_,sync::Runtime>,config:sync::Config,token:Option<String>)->Result<Value>{sync::configure(&store,&runtime,config,token)}
#[tauri::command]
fn import_sync_config(store:State<'_,Store>,runtime:State<'_,sync::Runtime>,path:PathBuf)->Result<Value>{sync::import_config(&store,&runtime,path)}
#[tauri::command]
async fn sync_now(app:tauri::AppHandle)->Result<Value>{sync::run(&app).await}
#[tauri::command]
fn resolve_sync_conflict(app:tauri::AppHandle,store:State<'_,Store>,runtime:State<'_,sync::Runtime>,key:String,use_local:bool)->Result<Value>{Ok(changed(&app,sync::resolve(&store,&runtime,key,use_local)?))}
#[tauri::command]
fn dispatch(app: tauri::AppHandle, store: State<'_, Store>, action: Value) -> Result<Value> {
    if action["type"] == "move_session" {
        return Ok(changed(
            &app,
            store.change_when_idle(|doc| apply_action(doc, &action))?,
        ));
    }
    Ok(changed(
        &app,
        store.change(|doc| apply_action(doc, &action))?,
    ))
}
#[tauri::command]
fn preview_session_delete(store: State<'_, Store>, session_id: String) -> Result<session_delete::Preview> {
    session_delete::preview(&store.read()?, &session_id)
}
#[tauri::command]
fn delete_session(app: tauri::AppHandle, store: State<'_, Store>, session_id: String, reference_ids: Vec<String>, token: String) -> Result<Value> {
    let result = store.delete_session(&session_id, &reference_ids, &token);
    if let Ok(document) = store.read() { changed(&app, document); }
    result
}
#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    mut settings: Value,
    image_key: Option<String>,
    refine_key: Option<String>,
    provider_keys: Option<std::collections::HashMap<String, String>>,
) -> Result<Value> {
    let _operation = store.operation()?;
    network::normalize(&mut settings)?;
    if settings["providers"].is_array() {
        providers::normalize(&mut settings)?;
        if let Some(keys) = provider_keys {
            for id in keys.keys() {
                find(&settings, "providers", id)?;
            }
            for (id, key) in keys {
                let p = find(&settings, "providers", &id)?;
                provider::save_key(&providers::credential_kind(p), text(p, "baseUrl"), &key)?;
            }
        }
        changed(
            &app,
            store.change(|doc| {
                doc["settings"] = settings;
                Ok(())
            })?,
        );
        return bootstrap_value(&app, &store);
    }
    settings["generation"]["baseUrl"] = json!(provider::base_url(text(
        &settings["generation"],
        "baseUrl"
    ))?);
    settings["refine"]["baseUrl"] =
        json!(provider::base_url(text(&settings["refine"], "baseUrl"))?);
    if text(&settings["generation"], "model").trim().is_empty()
        || text(&settings["generation"], "mainModel").trim().is_empty()
        || text(&settings["refine"], "model").trim().is_empty()
    {
        return Err("请填写模型 ID".into());
    }
    if let Some(key) = image_key {
        provider::save_key("image", text(&settings["generation"], "baseUrl"), &key)?;
    }
    if let Some(key) = refine_key {
        provider::save_key("refine", text(&settings["refine"], "baseUrl"), &key)?;
    }
    let legacy = settings.clone();
    providers::migrate(&mut settings)?;
    provider::copy_legacy_keys(&legacy, &settings)?;
    changed(
        &app,
        store.change(|doc| {
            doc["settings"] = settings;
            Ok(())
        })?,
    );
    bootstrap_value(&app, &store)
}
#[tauri::command]
fn network_settings(store: State<'_, Store>) -> Result<Value> {
    network::view(&store.read()?["settings"])
}
#[tauri::command]
async fn test_network_settings(settings: network::Settings) -> Result<Value> {
    network::test(settings).await
}
#[tauri::command]
async fn import_assets(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    paths: Vec<String>,
    as_reference: bool,
    workspace_id: Option<String>,
    session_id: Option<String>,
) -> Result<Value> {
    let _operation = store.operation()?;
    let root = store.root.clone();
    let attachment_session = session_id.clone();
    let imported =
        tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<Value>, Vec<String>)> {
            let worker = Store::open(root)?;
            let mut assets = Vec::new();
            let mut errors = Vec::new();
            for path in paths {
                let path = PathBuf::from(path);
                let name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("未命名图片")
                    .to_string();
                let result = (|| {
                    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
                    if size > 128 * 1024 * 1024 {
                        return Err("文件超过 128 MB".into());
                    }
                    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
                    worker.save_image(&bytes, &name)
                })();
                match result {
                    Ok(mut asset) => {
                        asset["isReference"] = json!(as_reference);
                        asset["workspaceId"] = json!(workspace_id.as_deref().unwrap_or(""));
                        asset["sourceSessionId"] = json!(session_id.as_deref().unwrap_or(""));
                        assets.push(asset);
                    }
                    Err(error) => errors.push(format!("{name}：{error}")),
                }
            }
            Ok((assets, errors))
        })
        .await
        .map_err(|e| e.to_string())??;
    let ids: Vec<String> = imported
        .0
        .iter()
        .map(|a| text(a, "id").to_owned())
        .collect();
    let count = ids.len();
    let document = store.change(|doc| {
        insert_imports(doc, imported.0, attachment_session.as_deref())?;
        Ok(())
    })?;
    Ok(json!({"document":changed(&app,document),"assetIds":ids,"count":count,"errors":imported.1}))
}

#[derive(Deserialize)]
struct IncomingImage {
    name: String,
    data: String,
}

#[tauri::command]
async fn import_image_data(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    images: Vec<IncomingImage>,
    workspace_id: String,
    session_id: String,
) -> Result<Value> {
    let _operation = store.operation()?;
    let snapshot = store.read()?;
    find(&snapshot, "sessions", &session_id)?;
    find(&snapshot, "workspaces", &workspace_id)?;
    if images.is_empty() || images.len() > 8 {
        return Err("每次最多粘贴 8 张图片".into());
    }
    let root = store.root.clone();
    let source_session = session_id.clone();
    let assets = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Value>> {
        let worker = Store::open(root)?;
        let mut assets = Vec::new();
        let mut total = 0;
        for image in images {
            if image.data.len() > 28 * 1024 * 1024 {
                return Err("单张粘贴图片不能超过 20 MB".into());
            }
            let bytes = STANDARD
                .decode(&image.data)
                .map_err(|_| "剪贴板图片编码无效")?;
            total += bytes.len();
            if bytes.len() > 20 * 1024 * 1024 || total > 50 * 1024 * 1024 {
                return Err("单张粘贴图片最多 20 MB，每批最多 50 MB".into());
            }
            let mut asset =
                worker.save_image(&bytes, &image.name.chars().take(80).collect::<String>())?;
            asset["workspaceId"] = json!(workspace_id);
            asset["sourceSessionId"] = json!(source_session);
            assets.push(asset);
        }
        Ok(assets)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut ids = Vec::new();
    let document = store.change(|doc| {
        ids = insert_imports(doc, assets, Some(&session_id))?;
        Ok(())
    })?;
    Ok(json!({"document":changed(&app,document),"assetIds":ids}))
}

async fn run_naming(app: tauri::AppHandle, session_id: String, automatic: bool) -> Result<Value> {
    let store = app.state::<Store>();
    let _operation = store.operation()?;
    let initial = store.read()?;
    let session = find(&initial, "sessions", &session_id)?;
    if automatic && (!needs_auto_name(session) || initial["settings"]["autoNameSessions"] == false)
    {
        return Ok(initial);
    }
    if session["titleStatus"] == "pending" {
        return Err("此会话正在命名，请稍候".into());
    }
    let original_title = session["title"].clone();
    changed(
        &app,
        store.change(|doc| {
            let current = list_mut(doc, "sessions")?
                .iter_mut()
                .find(|s| text(s, "id") == session_id)
                .ok_or("会话不存在")?;
            if current["titleStatus"] == "pending" {
                return Err("此会话正在命名，请稍候".into());
            }
            current["titleStatus"] = json!("pending");
            current["titleAttempted"] = json!(true);
            current.as_object_mut().unwrap().remove("titleError");
            Ok(())
        })?,
    );
    match provider::session_title(&store, &initial, &session_id).await {
        Ok(title) => Ok(changed(
            &app,
            store.change(|doc| {
                let current = list_mut(doc, "sessions")?
                    .iter_mut()
                    .find(|s| text(s, "id") == session_id)
                    .ok_or("会话不存在")?;
                if current["title"] == original_title {
                    current["title"] = json!(title);
                    current["titleSource"] = json!("automatic");
                }
                current["titleStatus"] = json!("complete");
                Ok(())
            })?,
        )),
        Err(error) => {
            let _ = store
                .change(|doc| {
                    if let Some(current) = list_mut(doc, "sessions")?
                        .iter_mut()
                        .find(|s| text(s, "id") == session_id)
                    {
                        current["titleStatus"] = json!("failed");
                        current["titleError"] = json!(error);
                    }
                    Ok(())
                })
                .map(|doc| changed(&app, doc));
            Err(error)
        }
    }
}

#[tauri::command]
async fn name_session(app: tauri::AppHandle, session_id: String) -> Result<Value> {
    run_naming(app, session_id, false).await
}
#[tauri::command]
fn export_asset(store: State<'_, Store>, asset_id: String, destination: String) -> Result<()> {
    let doc = store.read()?;
    let source = store.asset_path(find(&doc, "assets", &asset_id)?)?;
    let destination = PathBuf::from(destination);
    if !destination.is_absolute() {
        return Err("请选择一个绝对路径".into());
    }
    let parent = destination
        .parent()
        .ok_or("导出路径无效")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if parent.starts_with(store.root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("请选择本地图库目录以外的位置".into());
    }
    fs::copy(source, destination).map_err(|e| format!("导出失败：{e}"))?;
    Ok(())
}
#[tauri::command]
async fn generate(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    request: GenerationRequest,
) -> Result<Value> {
    let _operation = store.operation()?;
    let initial = provider::generation_document(&store.read()?,&request)?;
    if request.prompt.trim().is_empty() {
        return Err("请先输入 Prompt".into());
    }
    if !provider::has_role_key(&initial["settings"], "image") {
        return Err("请先在设置中保存此生成服务的 API Key".into());
    }
    if initial["jobs"].as_array().is_some_and(|jobs| {
        jobs.iter()
            .any(|j| j["status"] == "running" && text(j, "sessionId") == request.session_id)
    }) {
        return Err("当前会话还有任务进行中，请等待完成".into());
    }
    provider::validate_image_options(
        text(&initial["settings"]["generation"], "model"),
        &request.size,
        &request.quality,
    )?;
    let previous_response_id = provider::previous_response_id(&initial, &request)?;
    let job_id = id();
    let job = json!({"id":job_id,"sessionId":request.session_id,"prompt":request.prompt,"originalPrompt":request.original_prompt,"referenceIds":request.reference_ids,"contextMode":request.context_mode,"previousResponseId":previous_response_id,"imageSelection":initial["settings"]["modelAssignments"]["image"],"status":"running","createdAt":now(),"assetIds":[]});
    changed(
        &app,
        store.change(|doc| {
            list_mut(doc, "jobs")?.insert(0, job);
            let session = list_mut(doc, "sessions")?
                .iter_mut()
                .find(|s| text(s, "id") == request.session_id)
                .ok_or("会话不存在")?;
            session["draft"] = json!("");
            session["originalPrompt"] = json!("");
            session["referenceIds"] = json!([]);
            Ok(())
        })?,
    );
    let result = provider::generate(&store, &initial, &request).await;
    let result: Result<Value> = match result {
        Ok(output) => {
            let session = find(&initial, "sessions", &request.session_id)?;
            let workspace_id = text(session, "workspaceId").to_string();
            let group_id = request.session_id.clone();
            let name = request.prompt.chars().take(20).collect::<String>();
            let mut assets = Vec::new();
            let mut error = None;
            for image in output.images {
                match store.save_image(&image.bytes, &name) {
                    Ok(mut asset) => {
                        // Each execution is distinct even when the provider returns identical image bytes.
                        asset["id"] = json!(id());
                        asset["workspaceId"] = json!(workspace_id);
                        asset["sessionId"] = json!(request.session_id);
                        asset["originalPrompt"] = json!(request.original_prompt);
                        asset["submittedPrompt"] = json!(request.prompt);
                        asset["referenceIds"] = json!(request.reference_ids);
                        asset["model"] = initial["settings"]["generation"]["model"].clone();
                        asset["mainModel"] = initial["settings"]["generation"]["mainModel"].clone();
                        asset["providerBaseUrl"] =
                            initial["settings"]["generation"]["baseUrl"].clone();
                        asset["size"] = json!(request.size);
                        asset["quality"] = json!(request.quality);
                        asset["groupId"] = json!(group_id);
                        if let Some(revised) = image.revised {
                            asset["revisedPrompt"] = json!(revised);
                        }
                        if let Some(response_id) = &output.response_id {
                            asset["responseId"] = json!(response_id);
                        }
                        if let Some(previous_id) = &previous_response_id {
                            asset["previousResponseId"] = json!(previous_id);
                        }
                        if !text(session, "parentAssetId").is_empty() {
                            asset["parentAssetId"] = session["parentAssetId"].clone();
                        }
                        assets.push(asset);
                    }
                    Err(e) => {
                        error = Some(e);
                        break;
                    }
                }
            }
            if let Some(error) = error {
                Err(error)
            } else {
                let asset_ids: Vec<Value> = assets.iter().map(|a| a["id"].clone()).collect();
                store.change(|doc| {
                    for asset in assets {
                        list_mut(doc, "assets")?.insert(0, asset);
                    }
                    let job = list_mut(doc, "jobs")?
                        .iter_mut()
                        .find(|j| text(j, "id") == job_id)
                        .ok_or("任务不存在")?;
                    job["status"] = json!("completed");
                    job["finishedAt"] = json!(now());
                    job["assetIds"] = json!(asset_ids);
                    let s = list_mut(doc, "sessions")?
                        .iter_mut()
                        .find(|s| text(s, "id") == request.session_id)
                        .ok_or("会话不存在")?;
                    if let Some(response_id) = output.response_id {
                        s["lastResponseId"] = json!(response_id);
                        s["lastProviderBaseUrl"] =
                            initial["settings"]["generation"]["baseUrl"].clone();
                        s["lastMainModel"] = initial["settings"]["generation"]["mainModel"].clone();
                        s["lastProviderId"] =
                            initial["settings"]["generation"]["providerId"].clone();
                    } else {
                        s["lastResponseId"] = Value::Null;
                        s["lastProviderBaseUrl"] = Value::Null;
                        s["lastMainModel"] = Value::Null;
                        s["lastProviderId"] = Value::Null;
                    }
                    Ok(())
                })
            }
        }
        Err(e) => Err(e),
    };
    match result {
        Ok(doc) => {
            let should_name = doc["settings"]["autoNameSessions"] != false
                && find(&doc, "sessions", &request.session_id).is_ok_and(needs_auto_name);
            let doc = changed(&app, doc);
            if should_name {
                let app = app.clone();
                let session_id = request.session_id.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = run_naming(app, session_id, true).await;
                });
            }
            Ok(doc)
        }
        Err(error) => {
            let _ = store
                .change(|doc| {
                    if let Some(job) = list_mut(doc, "jobs")?
                        .iter_mut()
                        .find(|j| text(j, "id") == job_id)
                    {
                        job["status"] = json!("failed");
                        job["finishedAt"] = json!(now());
                        job["error"] = json!(error);
                    }
                    Ok(())
                })
                .map(|doc| changed(&app, doc));
            Err(error)
        }
    }
}
#[tauri::command]
async fn refine_prompt(
    store: State<'_, Store>,
    prompt: String,
    reference_ids: Vec<String>,
    mode: String,
    session_id: Option<String>,
) -> Result<Value> {
    let _operation = store.operation()?;
    let doc = store.read()?;
    provider::refine(
        &store,
        &doc,
        session_id.as_deref().unwrap_or("unassigned"),
        &prompt,
        &reference_ids,
        &mode,
    )
    .await
}

#[tauri::command]
fn relocate_data(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    destination: String,
) -> Result<()> {
    store.reserve_relocation()?;
    let result = (|| -> Result<()> {
        let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
        storage::request_move(&base, &store.root, &PathBuf::from(destination))
    })();
    if let Err(error) = result {
        store.cancel_relocation();
        return Err(error);
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        app.restart();
    });
    Ok(())
}
#[tauri::command]
async fn list_provider_models(store: State<'_, Store>, provider_id: String) -> Result<Value> {
    provider::list_models(&store.read()?, &provider_id).await
}
#[tauri::command]
fn usage_records(store: State<'_, Store>) -> Result<Value> {
    let events = store.usage_events()?;
    let known = events
        .iter()
        .filter_map(|e| {
            e["estimatedCostUsd"]
                .as_str()
                .and_then(|s| s.parse::<rust_decimal::Decimal>().ok())
        })
        .sum::<rust_decimal::Decimal>();
    Ok(
        json!({"totalRequests":events.len(),"unpricedRequests":events.iter().filter(|e|e["estimatedCostUsd"].is_null()).count(),"knownEstimatedCostUsd":known.normalize().to_string(),"journalPath":store.root.join("usage/usage.jsonl").to_string_lossy(),"modelJournalPath":store.root.join("usage/models.jsonl").to_string_lossy(),"totalModelUsages":events.iter().map(|e| e["components"].as_array().map_or(0,Vec::len)).sum::<usize>(),"records":events.into_iter().rev().take(200).collect::<Vec<_>>()}),
    )
}
#[tauri::command]
fn export_usage(store: State<'_, Store>, destination: String) -> Result<()> {
    let target = PathBuf::from(destination);
    if !target.is_absolute() {
        return Err("请选择绝对路径".into());
    }
    let parent = target
        .parent()
        .ok_or("导出路径无效")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if parent.starts_with(store.root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("请选择应用数据目录以外的位置".into());
    }
    let data = store
        .usage_events()?
        .iter()
        .map(|e| e.to_string() + "\n")
        .collect::<String>();
    fs::write(target, data).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let location = app.path().app_data_dir()?;
            let root = if let Some(root)=std::env::var_os("GPT_IMG_STUDIO_DATA_DIR") {
                let root=PathBuf::from(root);
                if !root.is_absolute(){return Err("GPT_IMG_STUDIO_DATA_DIR 必须是绝对路径".into());}
                root
            } else {storage::resolve(&location).map_err(std::io::Error::other)?};
            let store = Store::open(root).map_err(std::io::Error::other)?;
            store.init_sync().map_err(std::io::Error::other)?;
            let saved = store.read().map_err(std::io::Error::other)?;
            let mut settings = saved["settings"].clone();
            if providers::migrate(&mut settings).map_err(std::io::Error::other)? {
                provider::copy_legacy_keys(&saved["settings"], &settings)
                    .map_err(std::io::Error::other)?;
                store
                    .change(|doc| {
                        doc["settings"] = settings;
                        Ok(())
                    })
                    .map_err(std::io::Error::other)?;
            }
            if text(&saved, "installationId").is_empty() {
                store
                    .change(|doc| {
                        doc["installationId"] = json!(id());
                        Ok(())
                    })
                    .map_err(std::io::Error::other)?;
            }
            store.sync_usage_journal().map_err(std::io::Error::other)?;
            store.recover_interrupted().map_err(std::io::Error::other)?;
            app.asset_protocol_scope()
                .allow_directory(store.root.join("assets"), true)?;
            app.asset_protocol_scope()
                .allow_directory(store.root.join("thumbnails"), true)?;
            let webview_directory = store.root.join("webview2");
            app.manage(store);
            app.manage(sync::Runtime::default());
            if let Some(path)=std::env::var_os("GPT_IMG_STUDIO_SYNC_CONFIG") {
                sync::import_config(&app.state::<Store>(),&app.state::<sync::Runtime>(),PathBuf::from(path)).map_err(std::io::Error::other)?;
            }
            tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                .data_directory(webview_directory)
                .build()?;
            let document=app.state::<Store>().read().map_err(std::io::Error::other)?;
            taskbar::initialize(app.handle(),&document);
            Ok(())
        })
        .on_window_event(|window,event| {
            if window.label()=="main" && matches!(event,tauri::WindowEvent::Focused(true)) {
                taskbar::focused(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            gallery_settings,
            save_gallery_settings,
            test_gallery_settings,
            sync_status,
            set_sync_editing,
            save_sync_config,
            import_sync_config,
            sync_now,
            resolve_sync_conflict,
            dispatch,
            preview_session_delete,
            delete_session,
            save_settings,
            network_settings,
            test_network_settings,
            import_assets,
            import_image_data,
            name_session,
            export_asset,
            generate,
            refine_prompt,
            relocate_data,
            list_provider_models,
            usage_records,
            export_usage
        ])
        .run(tauri::generate_context!())
        .expect("GPT Image Studio 无法启动");
}
