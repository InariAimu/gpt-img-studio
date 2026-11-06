use crate::store::{find, id, list_mut, text, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

fn reference_ids(value: &Value) -> HashSet<String> {
    let mut ids = value["referenceIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    if !text(value, "parentAssetId").is_empty() {
        ids.insert(text(value, "parentAssetId").into());
    }
    ids
}
fn session_references(doc: &Value, session: &Value) -> HashSet<String> {
    let mut ids = reference_ids(session);
    for collection in ["assets", "jobs"] {
        for record in doc[collection]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| a["sessionId"] == session["id"])
        {
            ids.extend(reference_ids(record));
        }
    }
    ids
}
fn root_id(asset: &Value) -> &str {
    if text(asset, "referenceSourceId").is_empty() {
        text(asset, "id")
    } else {
        text(asset, "referenceSourceId")
    }
}
fn rewrite(value: &mut Value, map: &HashMap<String, String>, deduplicate: bool) {
    if let Some(ids) = value["referenceIds"].as_array_mut() {
        let mut seen = HashSet::new();
        for reference in ids.iter_mut() {
            if let Some(replacement) = reference.as_str().and_then(|s| map.get(s)) {
                *reference = json!(replacement);
            }
        }
        if deduplicate {
            ids.retain(|reference| seen.insert(reference.as_str().unwrap_or("").to_owned()));
        }
    }
    if let Some(replacement) = map.get(text(value, "parentAssetId")) {
        value["parentAssetId"] = json!(replacement);
    }
}
fn is_referenced(doc: &Value, asset_id: &str) -> bool {
    ["sessions", "assets", "jobs", "presets"]
        .iter()
        .any(|collection| {
            doc[*collection]
                .as_array()
                .into_iter()
                .flatten()
                .any(|value| {
                    reference_ids(value).contains(asset_id)
                        || text(value, "assetId") == asset_id
                        || value["assetIds"]
                            .as_array()
                            .is_some_and(|a| a.iter().any(|id| id == asset_id))
                })
        })
}

pub fn apply_many(doc: &mut Value, selected: &[String], source_id: &str, target_id: &str) -> Result<()> {
    find(doc, "workspaces", source_id)?;
    find(doc, "workspaces", target_id)?;
    if selected.is_empty() || source_id == target_id {
        return Err("请选择会话及另一个目标工作区".into());
    }
    let selected: std::collections::BTreeSet<_> = selected.iter().collect();
    for session_id in &selected {
        if text(find(doc, "sessions", session_id)?, "workspaceId") != source_id {
            return Err("所选会话已移出当前工作区，请重新选择".into());
        }
    }
    let mut staged = doc.clone();
    for session_id in selected {
        apply(&mut staged, session_id, target_id)?;
    }
    *doc = staged;
    Ok(())
}

pub fn apply(doc: &mut Value, session_id: &str, target_id: &str) -> Result<()> {
    let session = find(doc, "sessions", session_id)?.clone();
    find(doc, "workspaces", target_id)?;
    let source_id = text(&session, "workspaceId");
    if source_id == target_id {
        return Ok(());
    }
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
        return Err("请等待后台生成或命名完成后再移动会话".into());
    }
    let assets = doc["assets"].as_array().ok_or("图片列表无效")?.clone();
    let sessions = doc["sessions"].as_array().ok_or("会话列表无效")?.clone();
    let moving = assets
        .iter()
        .filter(|a| text(a, "sessionId") == session_id)
        .map(|a| text(a, "id").to_owned())
        .collect::<HashSet<_>>();
    let references = sessions
        .iter()
        .map(|s| (text(s, "id").to_owned(), session_references(doc, s)))
        .collect::<HashMap<_, _>>();
    // Stage a complete graph rewrite before touching the document.
    let mut staged = assets.clone();
    for asset in &mut staged {
        if moving.contains(text(asset, "id")) {
            asset["workspaceId"] = json!(target_id);
        }
    }
    let mut remaps: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut unused_candidates = HashSet::new();

    let mut reference_for = |asset_id: &str, workspace_id: &str| -> Result<String> {
        let original = assets
            .iter()
            .find(|a| text(a, "id") == asset_id)
            .ok_or("参考图记录缺失，已停止移动")?;
        let root = root_id(original);
        if let Some(existing) = staged
            .iter()
            .find(|a| text(a, "workspaceId") == workspace_id && root_id(a) == root)
        {
            return Ok(text(existing, "id").into());
        }
        let shared = references
            .iter()
            .any(|(owner, ids)| owner != session_id && ids.contains(asset_id));
        let preset = doc["presets"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|p| text(p, "assetId") == asset_id || reference_ids(p).contains(asset_id));
        if text(original, "sessionId").is_empty()
            && original["isReference"] != true
            && !shared
            && !preset
            && (text(original, "workspaceId") == source_id
                || text(original, "workspaceId").is_empty())
        {
            staged
                .iter_mut()
                .find(|a| text(a, "id") == asset_id)
                .ok_or("参考图记录缺失")?["workspaceId"] = json!(workspace_id);
            return Ok(asset_id.into());
        }
        let mut copy = original.clone();
        let new_id = id();
        copy["id"] = json!(new_id);
        copy["workspaceId"] = json!(workspace_id);
        copy["sessionId"] = json!("");
        copy["referenceSourceId"] = json!(root);
        copy["referenceOnly"] = json!(true);
        copy["isReference"] = json!(false);
        copy["favorite"] = json!(false);
        if !text(original, "sessionId").is_empty() {
            copy["sourceSessionId"] = original["sessionId"].clone();
        }
        staged.push(copy);
        Ok(new_id)
    };

    for current in &sessions {
        let current_id = text(current, "id");
        let workspace = if current_id == session_id {
            target_id
        } else {
            text(current, "workspaceId")
        };
        for reference in &references[current_id] {
            let Some(original) = assets.iter().find(|a| text(a, "id") == reference) else {
                if current_id == session_id {
                    return Err("参考图记录缺失，已停止移动".into());
                }
                continue;
            };
            let root = root_id(original);
            let replacement = if moving.contains(root) && workspace == target_id {
                // Co-located reference copies can rejoin their original after a return move.
                root.to_owned()
            } else if current_id == session_id || moving.contains(reference) {
                reference_for(reference, workspace)?
            } else {
                continue;
            };
            if replacement != *reference {
                unused_candidates.insert(reference.clone());
                remaps
                    .entry(current_id.into())
                    .or_default()
                    .insert(reference.clone(), replacement);
            }
        }
    }
    doc["assets"] = json!(staged);
    for current in list_mut(doc, "sessions")? {
        if text(current, "id") == session_id {
            current["workspaceId"] = json!(target_id);
        }
        if let Some(map) = remaps.get(text(current, "id")) {
            rewrite(current, map, true);
        }
    }
    for collection in ["assets", "jobs"] {
        for current in list_mut(doc, collection)? {
            if let Some(map) = remaps.get(text(current, "sessionId")) {
                rewrite(current, map, false);
            }
        }
    }
    // Prune only unreferenced bookkeeping copies, never originals or image files.
    let remove = unused_candidates
        .into_iter()
        .filter(|candidate| {
            let Ok(asset) = find(doc, "assets", candidate) else {
                return false;
            };
            asset["referenceOnly"] == true
                && text(asset, "sessionId").is_empty()
                && asset["favorite"] != true
                && asset["isReference"] != true
                && !is_referenced(doc, candidate)
        })
        .collect::<HashSet<_>>();
    list_mut(doc, "assets")?.retain(|a| !remove.contains(text(a, "id")));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batch_move_preserves_versions_shared_references_and_history() {
        let mut doc=fixture();
        let before=doc.clone();
        apply_many(&mut doc,&["moving".into(),"staying".into(),"moving".into()],"a","b").unwrap();
        for id in ["moving","staying"] { assert_eq!(find(&doc,"sessions",id).unwrap()["workspaceId"],"b"); }
        for id in ["output","edit","other-output"] {
            let result=find(&doc,"assets",id).unwrap();
            assert_eq!(result["workspaceId"],"b");
            assert_eq!(result["path"],find(&before,"assets",id).unwrap()["path"]);
        }
        assert_eq!(find(&doc,"sessions","moving").unwrap()["draft"],"unsent");
        assert_eq!(find(&doc,"sessions","moving").unwrap()["lastResponseId"],"resp-last");
        for collection in ["sessions","assets","jobs"] {
            for record in doc[collection].as_array().unwrap() {
                for id in reference_ids(record) { assert!(find(&doc,"assets",&id).is_ok(),"{collection}: {id}"); }
            }
        }
        apply_many(&mut doc,&["moving".into(),"staying".into()],"b","a").unwrap();
        for id in ["output","edit","other-output"] { assert_eq!(find(&doc,"assets",id).unwrap()["workspaceId"],"a"); }
    }
    #[test]
    fn batch_move_rejects_invalid_scope_and_late_failure_without_partial_changes() {
        let original=fixture();
        for (ids,source,target) in [(vec![],"a","b"),(vec!["moving".into()],"b","a"),(vec!["missing".into()],"a","b"),(vec!["moving".into()],"a","a")] {
            let mut doc=original.clone();
            assert!(apply_many(&mut doc,&ids,source,target).is_err());
            assert_eq!(doc,original);
        }
        let mut doc=original;
        doc["sessions"][1]["referenceIds"].as_array_mut().unwrap().push(json!("missing-reference"));
        let before=doc.clone();
        assert!(apply_many(&mut doc,&["moving".into(),"staying".into()],"a","b").is_err());
        assert_eq!(doc,before);
    }
    fn fixture() -> Value {
        json!({"schemaVersion":1,"revision":0,"workspaces":[{"id":"a"},{"id":"b"}],"sessions":[{"id":"moving","workspaceId":"a","draft":"unsent","referenceIds":["shared","private","other-output"],"parentAssetId":"other-output","lastResponseId":"resp-last"},{"id":"staying","workspaceId":"a","referenceIds":["shared","output"]},{"id":"destination","workspaceId":"b","referenceIds":["output"]}],"assets":[{"id":"shared","workspaceId":"a","sessionId":"","referenceIds":[],"path":"assets/shared.png","thumbnailPath":"thumbnails/shared.webp"},{"id":"private","workspaceId":"a","sessionId":"","referenceIds":[],"path":"assets/private.png"},{"id":"output","workspaceId":"a","sessionId":"moving","referenceIds":["shared","private"],"responseId":"resp-first","path":"assets/output.png"},{"id":"edit","workspaceId":"a","sessionId":"moving","referenceIds":["output","shared"],"responseId":"resp-last","previousResponseId":"resp-first","path":"assets/edit.png"},{"id":"other-output","workspaceId":"a","sessionId":"staying","referenceIds":["output"],"path":"assets/other.png"}],"jobs":[{"id":"failed","sessionId":"moving","status":"failed","referenceIds":["shared"]},{"id":"other-failed","sessionId":"staying","status":"failed","referenceIds":["output"]}],"presets":[]})
    }
    #[test]
    fn moving_results_splits_shared_references_and_preserves_history() {
        let mut doc = fixture();
        apply(&mut doc, "moving", "b").unwrap();
        let moving = find(&doc, "sessions", "moving").unwrap();
        let staying = find(&doc, "sessions", "staying").unwrap();
        assert_eq!(moving["workspaceId"], "b");
        assert_eq!(moving["draft"], "unsent");
        assert_eq!(moving["lastResponseId"], "resp-last");
        assert_eq!(find(&doc, "assets", "output").unwrap()["workspaceId"], "b");
        assert_eq!(
            find(&doc, "assets", "edit").unwrap()["previousResponseId"],
            "resp-first"
        );
        assert_eq!(find(&doc, "assets", "private").unwrap()["workspaceId"], "b");
        assert_eq!(
            find(&doc, "assets", "other-output").unwrap()["workspaceId"],
            "a"
        );
        let shared = find(&doc, "assets", moving["referenceIds"][0].as_str().unwrap()).unwrap();
        assert_eq!(shared["workspaceId"], "b");
        assert_eq!(shared["path"], "assets/shared.png");
        assert_eq!(shared["sessionId"], "");
        assert_eq!(staying["referenceIds"][0], "shared");
        let copy = find(&doc, "assets", staying["referenceIds"][1].as_str().unwrap()).unwrap();
        assert_eq!(copy["workspaceId"], "a");
        assert_eq!(copy["path"], "assets/output.png");
        assert_eq!(copy["sessionId"], "");
        assert_eq!(
            find(&doc, "jobs", "failed").unwrap()["referenceIds"][0],
            shared["id"]
        );
        assert_eq!(
            find(&doc, "jobs", "other-failed").unwrap()["referenceIds"][0],
            copy["id"]
        );
        assert_eq!(
            find(&doc, "sessions", "destination").unwrap()["referenceIds"][0],
            "output"
        );
    }
    #[test]
    fn returning_to_source_reuses_references_without_accumulating_copies() {
        let mut doc = fixture();
        doc["sessions"][2]["referenceIds"] = json!([]);
        let original = doc.clone();
        apply(&mut doc, "moving", "b").unwrap();
        apply(&mut doc, "moving", "a").unwrap();
        assert_eq!(doc, original);
    }
    #[test]
    fn global_and_preset_references_remain_available() {
        let mut doc = fixture();
        doc["assets"][1]["isReference"] = json!(true);
        doc["presets"] = json!([{"id":"preset","assetId":"shared","referenceIds":["shared"]}]);
        apply(&mut doc, "moving", "b").unwrap();
        assert_eq!(find(&doc, "assets", "private").unwrap()["workspaceId"], "a");
        assert_eq!(doc["presets"][0]["referenceIds"][0], "shared");
        assert_eq!(
            doc["assets"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|a| a["isReference"] == true)
                .count(),
            1
        );
    }
    #[test]
    fn invalid_or_busy_moves_leave_the_graph_unchanged() {
        for target in ["missing", "b"] {
            let mut doc = fixture();
            if target == "b" {
                doc["jobs"][0]["status"] = json!("running");
            }
            let before = doc.clone();
            assert!(apply(&mut doc, "moving", target).is_err());
            assert_eq!(doc, before);
        }
        let mut doc = fixture();
        doc["sessions"][0]["referenceIds"] = json!(["missing"]);
        let before = doc.clone();
        assert!(apply(&mut doc, "moving", "b").is_err());
        assert_eq!(doc, before);
    }
    #[test]
    fn move_survives_restart_without_copying_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path().into()).unwrap();
        store
            .change(|doc| {
                *doc = fixture();
                Ok(())
            })
            .unwrap();
        let count = std::fs::read_dir(dir.path().join("assets"))
            .unwrap()
            .count();
        store.change(|doc| apply(doc, "moving", "b")).unwrap();
        drop(store);
        let reopened = crate::store::Store::open(dir.path().into()).unwrap();
        let saved = reopened.read().unwrap();
        assert_eq!(
            find(&saved, "sessions", "moving").unwrap()["workspaceId"],
            "b"
        );
        assert_eq!(
            std::fs::read_dir(dir.path().join("assets"))
                .unwrap()
                .count(),
            count
        );
    }
    #[test]
    fn idle_gate_preserves_data_and_releases_after_errors() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path().into()).unwrap();
        store
            .change(|doc| {
                *doc = fixture();
                Ok(())
            })
            .unwrap();
        let operation = store.operation().unwrap();
        let before = store.read().unwrap();
        assert!(store
            .change_when_idle(|doc| apply(doc, "moving", "b"))
            .is_err());
        assert_eq!(store.read().unwrap(), before);
        drop(operation);
        assert!(store
            .change_when_idle(|doc| apply(doc, "moving", "missing"))
            .is_err());
        assert_eq!(store.read().unwrap(), before);
        let operation = store.operation().unwrap();
        drop(operation);
        let moved = store
            .change_when_idle(|doc| apply(doc, "moving", "b"))
            .unwrap();
        assert_eq!(
            find(&moved, "sessions", "moving").unwrap()["workspaceId"],
            "b"
        );
        assert!(store.operation().is_ok());
    }
}
