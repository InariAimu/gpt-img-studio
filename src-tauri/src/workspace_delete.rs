use crate::{
    session_delete::{references, root_id},
    store::{find, list_mut, text, Result},
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub session_count: usize,
    pub reference_count: usize,
    pub removed_result_count: usize,
    pub preserved_result_count: usize,
}

struct Analysis {
    sessions: BTreeSet<String>,
    removed: BTreeSet<String>,
    reference_ids: BTreeSet<String>,
    preserved_results: usize,
}

fn analyze(doc: &Value, workspace_id: &str, selected: Option<&[String]>) -> Result<Analysis> {
    find(doc, "workspaces", workspace_id)?;
    let sessions = doc["sessions"].as_array().ok_or("会话列表无效")?;
    let jobs = doc["jobs"].as_array().ok_or("任务列表无效")?;
    let assets = doc["assets"].as_array().ok_or("图片列表无效")?;
    if jobs.iter().any(|j| j["status"] == "running")
        || sessions.iter().any(|s| s["titleStatus"] == "pending")
    {
        return Err("请等待后台生成或命名完成后再删除工作区".into());
    }
    let mut session_ids: BTreeSet<String> = sessions
        .iter()
        .filter(|s| text(s, "workspaceId") == workspace_id)
        .map(|s| text(s, "id").to_owned())
        .collect();
    if let Some(selected) = selected {
        if selected.is_empty() || selected.iter().any(|id| !session_ids.contains(id)) {
            return Err("所选会话不存在或已移出当前工作区，请重新选择".into());
        }
        session_ids = selected.iter().cloned().collect();
    }
    let belongs = |a: &Value| {
        session_ids.contains(text(a, "sessionId"))
            || (selected.is_none() && text(a, "workspaceId") == workspace_id
                && !sessions
                    .iter()
                    .any(|s| text(s, "id") == text(a, "sessionId")))
    };
    let owned: BTreeSet<String> = assets
        .iter()
        .filter(|a| {
            belongs(a)
                && !text(a, "sessionId").is_empty()
                && a["model"] != "本地导入"
                && a["referenceOnly"] != true
        })
        .map(|a| text(a, "id").to_owned())
        .collect();
    let mut related = BTreeSet::new();
    let mut protected = BTreeSet::new();
    for asset in assets {
        if belongs(asset) {
            related.extend(references(asset));
            if !owned.contains(text(asset, "id")) || asset["isReference"] == true {
                related.insert(text(asset, "id").to_owned());
            }
        }
        if !owned.contains(text(asset, "id")) || asset["isReference"] == true {
            protected.insert(text(asset, "id").to_owned());
        }
    }
    for (collection, owner_key) in [(sessions, "id"), (jobs, "sessionId")] {
        for record in collection {
            if session_ids.contains(text(record, owner_key)) {
                // Job outputs are results, not reference inputs.
                let mut inputs = record.clone();
                inputs
                    .as_object_mut()
                    .ok_or("创作记录无效")?
                    .remove("assetIds");
                related.extend(references(&inputs));
            } else {
                protected.extend(references(record));
            }
        }
    }
    for preset in doc["presets"].as_array().ok_or("预设列表无效")? {
        protected.extend(references(preset));
    }
    // Preserve the full dependency chain of surviving references and presets.
    loop {
        let before = protected.len();
        let roots: BTreeSet<String> = assets
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
        if protected.len() == before {
            break;
        }
    }
    let removed = owned
        .difference(&protected)
        .cloned()
        .collect::<BTreeSet<_>>();
    let reference_ids = assets
        .iter()
        .filter(|a| related.contains(text(a, "id")) && !removed.contains(text(a, "id")))
        .map(|a| text(a, "id").to_owned())
        .collect();
    Ok(Analysis {
        sessions: session_ids,
        removed,
        reference_ids,
        preserved_results: owned.intersection(&protected).count(),
    })
}

pub fn preview(doc: &Value, workspace_id: &str) -> Result<Preview> {
    preview_scope(doc, workspace_id, None)
}

pub fn preview_sessions(doc: &Value, workspace_id: &str, selected: &[String]) -> Result<Preview> {
    preview_scope(doc, workspace_id, Some(selected))
}

fn preview_scope(doc: &Value, workspace_id: &str, selected: Option<&[String]>) -> Result<Preview> {
    let analysis = analyze(doc, workspace_id, selected)?;
    let material = json!({"workspaceId":workspace_id,"selected":selected.map(|_| &analysis.sessions),"workspaces":doc["workspaces"],"sessions":doc["sessions"],"assets":doc["assets"],"jobs":doc["jobs"],"presets":doc["presets"]});
    let reference_roots: BTreeSet<&str> = doc["assets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| analysis.reference_ids.contains(text(a, "id")))
        .map(root_id)
        .collect();
    Ok(Preview {
        token: format!("{:x}", Sha256::digest(material.to_string().as_bytes())),
        session_count: analysis.sessions.len(),
        reference_count: reference_roots.len(),
        removed_result_count: analysis.removed.len(),
        preserved_result_count: analysis.preserved_results,
    })
}

pub fn apply(doc: &mut Value, workspace_id: &str, token: &str) -> Result<()> {
    apply_scope(doc, workspace_id, None, token)
}

pub fn apply_sessions(doc: &mut Value, workspace_id: &str, selected: &[String], token: &str) -> Result<()> {
    apply_scope(doc, workspace_id, Some(selected), token)
}

fn apply_scope(doc: &mut Value, workspace_id: &str, selected: Option<&[String]>, token: &str) -> Result<()> {
    if preview_scope(doc, workspace_id, selected)?.token != token {
        return Err("工作区内容或图片引用已变化，请重新检查数量后确认删除".into());
    }
    let analysis = analyze(doc, workspace_id, selected)?;
    if selected.is_none() {
        list_mut(doc, "workspaces")?.retain(|w| text(w, "id") != workspace_id);
    }
    list_mut(doc, "sessions")?.retain(|s| !analysis.sessions.contains(text(s, "id")));
    list_mut(doc, "jobs")?.retain(|j| !analysis.sessions.contains(text(j, "sessionId")));
    list_mut(doc, "assets")?.retain(|a| !analysis.removed.contains(text(a, "id")));
    for asset in list_mut(doc, "assets")? {
        if analysis.sessions.contains(text(asset, "sessionId")) {
            asset["sourceSessionId"] = asset["sessionId"].clone();
            asset["sessionId"] = json!("");
            asset["referenceOnly"] = json!(true);
            asset["isReference"] = json!(true);
        }
        if selected.is_none() && text(asset, "workspaceId") == workspace_id {
            asset["workspaceId"] = json!("");
            asset["isReference"] = json!(true);
        } else if text(asset, "workspaceId").is_empty()
            && analysis.reference_ids.contains(text(asset, "id"))
        {
            asset["isReference"] = json!(true);
        }
    }
    for session in list_mut(doc, "sessions")? {
        if analysis.sessions.contains(text(session, "parentSessionId")) {
            session.as_object_mut().unwrap().remove("parentSessionId");
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    #[test]
    fn batch_delete_preserves_workspace_unselected_sessions_and_all_references() {
        let mut doc = document();
        let before = doc.clone();
        let selected = vec!["s2".into()];
        let p = preview_sessions(&doc,"w",&selected).unwrap();
        assert_eq!((p.session_count,p.removed_result_count),(1,1));
        apply_sessions(&mut doc,"w",&selected,&p.token).unwrap();
        assert_eq!(doc["workspaces"],before["workspaces"]);
        assert!(find(&doc,"sessions","s2").is_err());
        assert!(find(&doc,"assets","out2").is_err());
        for id in ["s1","other"] { assert_eq!(find(&doc,"sessions",id).unwrap(),find(&before,"sessions",id).unwrap()); }
        for id in ["private","global","out1","sharedout","other-output"] { assert_eq!(find(&doc,"assets",id).unwrap(),find(&before,"assets",id).unwrap()); }
        assert_eq!(doc["jobs"].as_array().unwrap().len(),1);
    }
    #[test]
    fn batch_delete_analyzes_selected_sessions_together_and_rejects_stale_scope() {
        let mut doc = document();
        let selected = vec!["s2".into(),"s1".into(),"s1".into()];
        let p = preview_sessions(&doc,"w",&selected).unwrap();
        assert_eq!((p.session_count,p.removed_result_count,p.preserved_result_count),(2,2,1));
        let before = doc.clone();
        assert!(apply_sessions(&mut doc,"w",&["s1".into()],&p.token).is_err());
        assert!(apply(&mut doc,"w",&p.token).is_err());
        assert_eq!(doc,before);
        for ids in [vec![],vec!["missing".into()],vec!["other".into()]] { assert!(preview_sessions(&doc,"w",&ids).is_err()); }
        doc["sessions"][0]["referenceIds"] = json!(["out2"]);
        let changed = doc.clone();
        assert!(apply_sessions(&mut doc,"w",&selected,&p.token).is_err());
        assert_eq!(doc,changed);
        doc=before.clone();
        apply_sessions(&mut doc,"w",&["s1".into(),"s2".into()],&p.token).unwrap();
        assert_eq!(doc["workspaces"],before["workspaces"]);
        assert!(find(&doc,"assets","out1").is_err());
        assert!(find(&doc,"assets","out2").is_err());
        assert_eq!(find(&doc,"assets","sharedout").unwrap()["isReference"],true);
        let previous=studio_sync::project(&before);
        let mut projected=studio_sync::project(&doc);
        let expected=projected.clone();
        studio_sync::protect_references(&mut projected,&previous,&mut studio_sync::ClientState::default()).unwrap();
        assert_eq!(projected,expected);
    }
    pub(crate) fn document() -> Value {
        json!({"schemaVersion":1,"revision":0,"settings":{},"workspaces":[{"id":"w","name":"Delete"},{"id":"v","name":"Keep"}],
        "sessions":[{"id":"s1","workspaceId":"w","referenceIds":["private","global","global"]},{"id":"s2","workspaceId":"w","referenceIds":["private","out1"]},{"id":"other","workspaceId":"v","parentSessionId":"s1","referenceIds":["sharedout"]}],
        "assets":[
            {"id":"private","workspaceId":"w","sessionId":"","model":"本地导入","path":"assets/private.png","referenceIds":[]},
            {"id":"global","workspaceId":"","sessionId":"","isReference":true,"path":"assets/global.png","referenceIds":[]},
            {"id":"out1","workspaceId":"w","sessionId":"s1","path":"assets/out1.png","thumbnailPath":"thumbnails/out1.webp","referenceIds":["private"]},
            {"id":"out2","workspaceId":"w","sessionId":"s2","path":"assets/out2.png","referenceIds":["out1"]},
            {"id":"sharedout","workspaceId":"w","sessionId":"s1","path":"assets/sharedout.png","referenceIds":["private"]},
            {"id":"other-output","workspaceId":"v","sessionId":"other","path":"assets/other.png","referenceIds":[]}
        ],"jobs":[{"id":"j1","sessionId":"s1","status":"completed","assetIds":["out1","sharedout"],"referenceIds":["private"]},{"id":"j2","sessionId":"s2","status":"completed","assetIds":["out2"]}],"presets":[{"id":"p","assetId":"sharedout","referenceIds":["global"]}]})
    }
    #[test]
    fn workspace_delete_removes_all_sessions_results_and_jobs_but_keeps_references() {
        let mut doc = document();
        let before = doc.clone();
        let p = preview(&doc, "w").unwrap();
        assert_eq!(
            (
                p.session_count,
                p.reference_count,
                p.removed_result_count,
                p.preserved_result_count
            ),
            (2, 2, 2, 1)
        );
        apply(&mut doc, "w", &p.token).unwrap();
        assert_eq!(doc["sessions"].as_array().unwrap().len(), 1);
        assert!(doc["jobs"].as_array().unwrap().is_empty());
        for id in ["out1", "out2"] {
            assert!(find(&doc, "assets", id).is_err());
        }
        for id in ["private", "global", "sharedout"] {
            let a = find(&doc, "assets", id).unwrap();
            assert_eq!(a["sessionId"], "");
            assert_eq!(a["workspaceId"], "");
            assert_eq!(a["isReference"], true);
        }
        assert_eq!(
            find(&doc, "assets", "other-output").unwrap(),
            find(&before, "assets", "other-output").unwrap()
        );
        assert_eq!(doc["presets"], before["presets"]);
        assert!(doc["sessions"][0].get("parentSessionId").is_none());
        // Retained reference metadata must not resurrect deleted workspaces/sessions on sync.
        let previous = studio_sync::project(&before);
        let mut entities = studio_sync::project(&doc);
        let expected = entities.clone();
        let mut state = studio_sync::ClientState::default();
        studio_sync::protect_references(&mut entities, &previous, &mut state).unwrap();
        assert_eq!(entities, expected);
    }
    #[test]
    fn workspace_delete_handles_empty_last_workspace_and_preserves_unattached_references() {
        let mut doc = document();
        doc["workspaces"] = json!([{"id":"w"}]);
        doc["sessions"] = json!([]);
        doc["jobs"] = json!([]);
        doc["presets"] = json!([]);
        doc["assets"] = json!([doc["assets"][0].clone()]);
        let p = preview(&doc, "w").unwrap();
        assert_eq!(p.session_count, 0);
        assert_eq!(p.reference_count, 1);
        apply(&mut doc, "w", &p.token).unwrap();
        assert!(doc["workspaces"].as_array().unwrap().is_empty());
        assert_eq!(doc["assets"][0]["path"], "assets/private.png");
        assert_eq!(doc["assets"][0]["isReference"], true);
    }
    #[test]
    fn workspace_delete_rejects_stale_confirmation_busy_jobs_and_missing_targets() {
        let mut doc = document();
        let token = preview(&doc, "w").unwrap().token;
        doc["sessions"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"new","workspaceId":"w"}));
        let before = doc.clone();
        assert!(apply(&mut doc, "w", &token).is_err());
        assert_eq!(doc, before);
        doc["jobs"][0]["status"] = json!("running");
        assert!(preview(&doc, "w").is_err());
        doc["jobs"][0]["status"] = json!("completed");
        doc["sessions"][0]["titleStatus"] = json!("pending");
        assert!(preview(&doc, "w").is_err());
        assert!(preview(&document(), "missing").is_err());
    }
    #[test]
    fn workspace_delete_deduplicates_reference_copies_and_preserves_reference_chains() {
        let mut doc = document();
        doc["assets"].as_array_mut().unwrap().push(json!({"id":"private-copy","referenceSourceId":"private","workspaceId":"w","sessionId":"","referenceOnly":true,"path":"assets/private.png","referenceIds":[]}));
        doc["sessions"][1]["referenceIds"] = json!(["private-copy"]);
        doc["assets"][4]["referenceIds"] = json!(["out1"]);
        let p = preview(&doc, "w").unwrap();
        assert_eq!(p.reference_count, 3);
        assert_eq!(p.preserved_result_count, 2);
        apply(&mut doc, "w", &p.token).unwrap();
        assert!(find(&doc, "assets", "out1").is_ok());
        assert!(find(&doc, "assets", "out2").is_err());
        assert_eq!(
            find(&doc, "assets", "private-copy").unwrap()["workspaceId"],
            ""
        );
    }
}
