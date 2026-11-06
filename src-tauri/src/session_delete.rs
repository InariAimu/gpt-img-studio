use crate::store::{find, id, list_mut, now, text, Result};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

pub(crate) fn references(record: &Value) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for key in ["referenceIds", "assetIds"] {
        for value in record[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !value.is_empty() {
                ids.insert(value.to_owned());
            }
        }
    }
    for key in ["parentAssetId", "assetId", "referenceSourceId"] {
        if !text(record, key).is_empty() {
            ids.insert(text(record, key).to_owned());
        }
    }
    ids
}
pub(crate) fn root_id(asset: &Value) -> &str {
    if text(asset, "referenceSourceId").is_empty() {
        text(asset, "id")
    } else {
        text(asset, "referenceSourceId")
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub removable_references: Vec<Value>,
    pub preserved_reference_count: usize,
    pub removed_result_count: usize,
    pub preserved_result_count: usize,
}

struct Analysis {
    owned: BTreeSet<String>,
    protected: BTreeSet<String>,
    references: BTreeSet<String>,
}
fn analyze(doc: &Value, session_id: &str) -> Result<Analysis> {
    let session = find(doc, "sessions", session_id)?;
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
        return Err("请等待后台生成或命名完成后再删除会话".into());
    }
    let assets = doc["assets"].as_array().ok_or("图片列表无效")?;
    let owned: BTreeSet<String> = assets
        .iter()
        .filter(|a| text(a, "sessionId") == session_id)
        .map(|a| text(a, "id").to_owned())
        .collect();
    let mut session_refs = references(session);
    let mut protected = BTreeSet::new();
    for asset in assets {
        if owned.contains(text(asset, "id")) {
            session_refs.extend(references(asset));
        }
        if asset["isReference"] == true {
            protected.insert(text(asset, "id").to_owned());
        }
    }
    for collection in ["sessions", "jobs"] {
        for record in doc[collection].as_array().into_iter().flatten() {
            let owner = if collection == "sessions" {
                text(record, "id")
            } else {
                text(record, "sessionId")
            };
            if owner == session_id {
                session_refs.extend(references(record));
            } else {
                protected.extend(references(record));
            }
        }
    }
    for preset in doc["presets"].as_array().into_iter().flatten() {
        protected.extend(references(preset));
    }
    for asset in assets {
        if !owned.contains(text(asset, "id")) && !session_refs.contains(text(asset, "id")) {
            protected.extend(references(asset));
        }
    }
    // A reference to another live session's output never authorizes removing that output.
    for asset in assets {
        if !text(asset, "sessionId").is_empty() && text(asset, "sessionId") != session_id {
            protected.insert(text(asset, "id").to_owned());
        }
    }
    loop {
        let before = protected.len();
        let roots: HashSet<String> = assets
            .iter()
            .filter(|a| protected.contains(text(a, "id")))
            .map(|a| root_id(a).to_owned())
            .collect();
        for asset in assets {
            if protected.contains(text(asset, "id")) || roots.contains(root_id(asset)) {
                protected.insert(text(asset, "id").to_owned());
                protected.extend(references(asset));
            }
        }
        if before == protected.len() {
            break;
        }
    }
    session_refs.retain(|asset_id| !owned.contains(asset_id));
    Ok(Analysis {
        owned,
        protected,
        references: session_refs,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn document() -> Value {
        json!({"schemaVersion":1,"revision":0,"workspaces":[{"id":"w"}],"sessions":[{"id":"deleting","workspaceId":"w","title":"Delete me","referenceIds":["private","global","shared","preset-ref","from-another-session"]},{"id":"other","workspaceId":"w","referenceIds":["shared"]}],"assets":[
            {"id":"private","path":"assets/private.png","thumbnailPath":"thumbnails/private.webp","sessionId":"","referenceIds":[],"model":"本地导入"},
            {"id":"global","path":"assets/global.png","sessionId":"","isReference":true,"referenceIds":[]},
            {"id":"shared","path":"assets/shared.png","sessionId":"","referenceIds":[]},
            {"id":"preset-ref","path":"assets/preset.png","sessionId":"","referenceIds":[]},
            {"id":"from-another-session","path":"assets/other.png","sessionId":"other","referenceIds":[]},
            {"id":"output","path":"assets/output.png","thumbnailPath":"thumbnails/output.webp","sessionId":"deleting","referenceIds":[]}
        ],"jobs":[{"id":"finished","sessionId":"deleting","status":"completed","assetIds":["output"],"referenceIds":[]}],"presets":[{"id":"p","assetId":"preset-ref","referenceIds":[]}]})
    }
    #[test]
    fn only_exclusive_references_are_optional_and_shared_assets_stay_unchanged() {
        let before = document();
        let preview = preview(&before, "deleting").unwrap();
        assert_eq!(
            preview
                .removable_references
                .iter()
                .map(|a| text(a, "id"))
                .collect::<Vec<_>>(),
            vec!["private"]
        );
        assert_eq!(preview.preserved_reference_count, 4);
        let mut kept = before.clone();
        apply(&mut kept, "deleting", &[], &preview.token).unwrap();
        assert!(find(&kept, "assets", "private").is_ok());
        assert!(find(&kept, "assets", "output").is_err());
        assert!(find(&kept, "sessions", "deleting").is_err());
        assert!(kept["jobs"].as_array().unwrap().is_empty());
        let mut removed = before.clone();
        apply(
            &mut removed,
            "deleting",
            &["private".into()],
            &preview.token,
        )
        .unwrap();
        assert!(find(&removed, "assets", "private").is_err());
        for asset_id in ["global", "shared", "preset-ref", "from-another-session"] {
            assert_eq!(
                find(&removed, "assets", asset_id).unwrap(),
                find(&before, "assets", asset_id).unwrap()
            );
        }
    }
    #[test]
    fn surviving_derived_sessions_and_presets_protect_outputs_and_their_reference_chain() {
        let mut doc = document();
        doc["sessions"][1]["parentAssetId"] = json!("output");
        doc["assets"][5]["referenceIds"] = json!(["private"]);
        let preview = preview(&doc, "deleting").unwrap();
        assert_eq!(preview.preserved_result_count, 1);
        assert!(preview.removable_references.is_empty());
        apply(&mut doc, "deleting", &[], &preview.token).unwrap();
        let retained = find(&doc, "assets", "output").unwrap();
        assert_eq!(retained["sessionId"], "");
        assert_eq!(retained["referenceOnly"], true);
        assert_eq!(doc["sessions"][0]["parentAssetId"], "output");
        assert!(find(&doc, "assets", "private").is_ok());
    }
    #[test]
    fn history_and_cross_workspace_reference_copies_count_as_shared_usage() {
        let mut doc = document();
        doc["assets"].as_array_mut().unwrap().push(json!({"id":"copy","referenceSourceId":"private","path":"assets/private.png","sessionId":"","referenceOnly":true}));
        doc["jobs"].as_array_mut().unwrap().push(
            json!({"id":"failed","sessionId":"other","status":"failed","referenceIds":["copy"]}),
        );
        assert!(preview(&doc, "deleting")
            .unwrap()
            .removable_references
            .is_empty());
        doc["jobs"].as_array_mut().unwrap().pop();
        doc["sessions"][0]["referenceIds"] = json!(["copy"]);
        let preview = preview(&doc, "deleting").unwrap();
        assert_eq!(preview.removable_references[0]["id"], "copy");
    }
    #[test]
    fn changed_usage_and_invalid_selections_cannot_delete_a_shared_reference() {
        let mut doc = document();
        let token = preview(&doc, "deleting").unwrap().token;
        let original = doc.clone();
        assert!(apply(&mut doc, "deleting", &["shared".into()], &token).is_err());
        assert_eq!(doc, original);
        doc["sessions"][1]["referenceIds"] = json!(["private"]);
        let changed = doc.clone();
        assert!(apply(&mut doc, "deleting", &["private".into()], &token).is_err());
        assert_eq!(doc, changed);
    }
    #[test]
    fn running_work_blocks_deletion_and_the_last_session_can_be_removed() {
        let mut doc = document();
        doc["jobs"][0]["status"] = json!("running");
        assert!(preview(&doc, "deleting").is_err());
        doc["jobs"] = json!([]);
        doc["sessions"].as_array_mut().unwrap().pop();
        let token = preview(&doc, "deleting").unwrap().token;
        apply(&mut doc, "deleting", &[], &token).unwrap();
        assert!(doc["sessions"].as_array().unwrap().is_empty());
    }
    #[test]
    fn a_preset_cover_keeps_a_generated_output_available_after_its_session_is_deleted() {
        let mut doc = document();
        doc["presets"][0]["assetId"] = json!("output");
        let preview = preview(&doc, "deleting").unwrap();
        assert_eq!(preview.preserved_result_count, 1);
        apply(&mut doc, "deleting", &[], &preview.token).unwrap();
        assert_eq!(doc["presets"][0]["assetId"], "output");
        assert_eq!(
            find(&doc, "assets", "output").unwrap()["referenceOnly"],
            true
        );
    }
}

pub fn preview(doc: &Value, session_id: &str) -> Result<Preview> {
    let analysis = analyze(doc, session_id)?;
    let assets = doc["assets"].as_array().ok_or("图片列表无效")?;
    let removable: Vec<Value> = assets
        .iter()
        .filter(|a| {
            analysis.references.contains(text(a, "id"))
                && !analysis.protected.contains(text(a, "id"))
        })
        .cloned()
        .collect();
    let preserved_results = analysis.owned.intersection(&analysis.protected).count();
    let material = json!({"session":find(doc,"sessions",session_id)?,"owned":assets.iter().filter(|a|analysis.owned.contains(text(a,"id"))).collect::<Vec<_>>(),"references":removable,"protected":analysis.protected});
    Ok(Preview {
        token: format!("{:x}", Sha256::digest(material.to_string().as_bytes())),
        preserved_reference_count: analysis.references.len().saturating_sub(removable.len()),
        removed_result_count: analysis.owned.len() - preserved_results,
        preserved_result_count: preserved_results,
        removable_references: removable,
    })
}

pub fn apply(doc: &mut Value, session_id: &str, selected: &[String], token: &str) -> Result<()> {
    let current = preview(doc, session_id)?;
    if current.token != token {
        return Err("会话或图片引用已变化，请重新检查后确认删除".into());
    }
    let allowed: HashSet<&str> = current
        .removable_references
        .iter()
        .map(|a| text(a, "id"))
        .collect();
    if selected
        .iter()
        .any(|asset_id| !allowed.contains(asset_id.as_str()))
    {
        return Err("所选参考图正在被使用，不能同时删除".into());
    }
    let analysis = analyze(doc, session_id)?;
    let mut removed: BTreeSet<String> = analysis
        .owned
        .difference(&analysis.protected)
        .cloned()
        .collect();
    removed.extend(selected.iter().cloned());
    list_mut(doc, "sessions")?.retain(|s| text(s, "id") != session_id);
    list_mut(doc, "jobs")?.retain(|j| text(j, "sessionId") != session_id);
    list_mut(doc, "assets")?.retain(|a| !removed.contains(text(a, "id")));
    for asset in list_mut(doc, "assets")? {
        if text(asset, "sessionId") == session_id {
            asset["sessionId"] = json!("");
            asset["sourceSessionId"] = json!(session_id);
            asset["referenceOnly"] = json!(true);
        }
    }
    Ok(())
}

fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let relative = Path::new(relative);
    if relative.components().count() != 2
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || !(relative.starts_with("assets") || relative.starts_with("thumbnails"))
    {
        return Err("图片路径无效，已停止删除".into());
    }
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component);
        no_link(&path)?;
    }
    Ok(path)
}
fn no_link(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("路径包含目录链接，已停止删除".into());
                }
            }
            if meta.file_type().is_symlink() {
                return Err("路径包含符号链接，已停止删除".into());
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub struct Archive {
    pub path: PathBuf,
    moved: Vec<(PathBuf, PathBuf)>,
}
impl Archive {
    pub fn stage(root: &Path, before: &Value, after: &Value, session_id: &str) -> Result<Self> {
        Self::stage_scope(root, before, after, "session", session_id)
    }
    pub fn stage_workspace(root: &Path, before: &Value, after: &Value, workspace_id: &str) -> Result<Self> {
        Self::stage_scope(root, before, after, "workspace", workspace_id)
    }
    pub fn stage_sessions(root: &Path, before: &Value, after: &Value) -> Result<Self> {
        Self::stage_scope(root, before, after, "sessions", "")
    }
    fn stage_scope(root: &Path, before: &Value, after: &Value, scope: &str, target_id: &str) -> Result<Self> {
        let session_ids: HashSet<&str> = before["sessions"].as_array().into_iter().flatten()
            .filter(|s| if scope == "workspace" { text(s,"workspaceId") == target_id } else if scope == "sessions" { find(after,"sessions",text(s,"id")).is_err() } else { text(s,"id") == target_id })
            .map(|s| text(s,"id")).collect();
        for ancestor in root.ancestors() {
            no_link(ancestor)?;
        }
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        let kept_ids: HashSet<&str> = after["assets"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|a| text(a, "id"))
            .collect();
        let deleted: Vec<&Value> = before["assets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| !kept_ids.contains(text(a, "id")))
            .collect();
        let mut kept_paths = HashSet::new();
        for asset in after["assets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| a["demo"] != true)
        {
            for key in ["path", "thumbnailPath"] {
                if !text(asset, key).is_empty() {
                    kept_paths.insert(
                        safe_path(&root, text(asset, key))?
                            .to_string_lossy()
                            .to_lowercase(),
                    );
                }
            }
        }
        let mut paths = BTreeSet::new();
        for asset in &deleted {
            if asset["demo"] == true {
                continue;
            }
            for key in ["path", "thumbnailPath"] {
                if text(asset, key).is_empty() {
                    continue;
                }
                let path = safe_path(&root, text(asset, key))?;
                if path.exists() && !kept_paths.contains(&path.to_string_lossy().to_lowercase()) {
                    if !path.is_file() {
                        return Err("图片路径不是文件，已停止删除".into());
                    }
                    paths.insert(path);
                }
            }
        }
        let parent = root.join("deleted-sessions");
        no_link(&parent)?;
        fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        let path = parent.join(format!("gpt-img-studio-{scope}-{}", id()));
        fs::create_dir(&path).map_err(|e| e.to_string())?;
        let mut manifest = json!({"version":1,"deletedAt":now(),"scope":scope,"files":paths.iter().map(|p|p.strip_prefix(&root).unwrap().to_string_lossy().into_owned()).collect::<Vec<_>>(),"assets":deleted,"jobs":before["jobs"].as_array().into_iter().flatten().filter(|j|session_ids.contains(text(j,"sessionId"))).collect::<Vec<_>>(),"retainedAssetsBefore":before["assets"].as_array().into_iter().flatten().filter(|a|kept_ids.contains(text(a,"id")) && find(after,"assets",text(a,"id")).is_ok_and(|b| b != *a)).collect::<Vec<_>>()});
        if scope == "workspace" {
            manifest["workspace"] = find(before,"workspaces",target_id)?.clone();
        }
        if scope == "workspace" || scope == "sessions" {
            manifest["sessions"] = json!(before["sessions"].as_array().into_iter().flatten().filter(|s|session_ids.contains(text(s,"id"))).collect::<Vec<_>>());
            manifest["retainedSessionsBefore"] = json!(before["sessions"].as_array().into_iter().flatten().filter(|s| !session_ids.contains(text(s,"id")) && find(after,"sessions",text(s,"id")).is_ok_and(|b| b != *s)).collect::<Vec<_>>());
        } else { manifest["session"] = find(before,"sessions",target_id)?.clone(); }
        let mut file =
            fs::File::create(path.join("session.json.tmp")).map_err(|e| e.to_string())?;
        file.write_all(
            serde_json::to_string_pretty(&manifest)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(path.join("session.json.tmp"), path.join("session.json"))
            .map_err(|e| e.to_string())?;
        let mut archive = Self {
            path,
            moved: Vec::new(),
        };
        for source in paths {
            let destination = archive
                .path
                .join(source.strip_prefix(&root).map_err(|e| e.to_string())?);
            let result = (|| {
                fs::create_dir_all(destination.parent().ok_or("图片目录无效")?)
                    .map_err(|e| e.to_string())?;
                fs::rename(&source, &destination).map_err(|e| e.to_string())
            })();
            if let Err(error) = result {
                let rollback = archive.restore();
                return Err(format!(
                    "整理删除材料失败：{error}；恢复结果：{rollback:?}；恢复材料：{}",
                    archive.path.display()
                ));
            }
            archive.moved.push((source, destination));
        }
        Ok(archive)
    }
    pub fn restore(&self) -> Result<()> {
        for (source, destination) in self.moved.iter().rev() {
            if source.exists() {
                return Err(format!("恢复目标已存在：{}", source.display()));
            }
            fs::rename(destination, source)
                .map_err(|e| format!("恢复图片失败：{e}；恢复材料：{}", self.path.display()))?;
        }
        Ok(())
    }
}

pub fn recover(root: &Path, doc: &Value) -> Result<()> {
    let pending = root.join("deleted-sessions");
    no_link(&pending)?;
    if !pending.exists() {
        return Ok(());
    }
    for ancestor in root.ancestors() {
        no_link(ancestor)?;
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    for entry in fs::read_dir(&pending).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !["gpt-img-studio-session-", "gpt-img-studio-workspace-", "gpt-img-studio-sessions-"].iter().any(|prefix| entry.file_name().to_string_lossy().starts_with(prefix))
        {
            continue;
        }
        let path = entry.path();
        no_link(&path)?;
        no_link(&path.join("session.json"))?;
        if !path.join("session.json").exists() {
            continue;
        }
        let manifest: Value = serde_json::from_slice(
            &fs::read(path.join("session.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if manifest["version"] != 1 || !manifest["files"].is_array() {
            return Err(format!("删除恢复材料无效：{}", path.display()));
        }
        let restore = if manifest["scope"] == "sessions" {
            let sessions = manifest["sessions"].as_array().filter(|s| !s.is_empty()).ok_or("批量删除恢复材料无效")?;
            if sessions.iter().any(|s| text(s,"id").is_empty()) { return Err("批量删除恢复材料缺少会话标识".into()); }
            let present = sessions.iter().filter(|s| find(doc,"sessions",text(s,"id")).is_ok()).count();
            if present != 0 && present != sessions.len() { return Err(format!("批量删除恢复状态不一致，材料已保留：{}", path.display())); }
            present == sessions.len()
        } else {
            let (collection, target) = if manifest["scope"] == "workspace" { ("workspaces", &manifest["workspace"]) } else { ("sessions", &manifest["session"]) };
            if text(target,"id").is_empty() { return Err(format!("删除恢复材料无效：{}", path.display())); }
            find(doc, collection, text(target,"id")).is_ok()
        };
        if restore {
            for relative in manifest["files"].as_array().into_iter().flatten() {
                let relative = relative.as_str().ok_or("删除恢复路径无效")?;
                let source = safe_path(&root, relative)?;
                let saved = safe_path(&path, relative)?;
                if saved.exists() && !source.exists() {
                    fs::rename(&saved, &source).map_err(|e| {
                        format!("恢复中断的删除失败：{e}；恢复材料：{}", path.display())
                    })?;
                } else if saved.exists() && source.exists() {
                    if Sha256::digest(fs::read(&saved).map_err(|e| e.to_string())?)
                        != Sha256::digest(fs::read(&source).map_err(|e| e.to_string())?)
                    {
                        return Err(format!("恢复文件冲突，已保留两份文件：{}", path.display()));
                    }
                } else if !source.exists() {
                    return Err(format!("删除恢复文件缺失：{}", path.display()));
                }
            }
        }
        crate::recycle::directory(&path).map_err(|e| {
            format!(
                "未能回收上次删除的恢复材料：{e}；材料保留在 {}",
                path.display()
            )
        })?;
    }
    Ok(())
}
