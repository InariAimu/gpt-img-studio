use crate::{
    session_delete::{protect_related_assets, references},
    store::{find, list_mut, text, Result},
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    token: String,
    removed_turn_count: usize,
    removed_result_count: usize,
    preserved_result_count: usize,
    has_response: bool,
}

struct Rollback {
    preview: Preview,
    jobs: BTreeSet<String>,
    results: BTreeSet<String>,
    protected: BTreeSet<String>,
    context: Value,
}

fn order(record: &Value) -> (&str, &str) {
    (text(record, "createdAt"), text(record, "id"))
}

fn analyze(doc: &Value, session_id: &str, asset_id: &str) -> Result<Rollback> {
    let session = find(doc, "sessions", session_id)?;
    let anchor = find(doc, "assets", asset_id)?;
    if text(anchor, "sessionId") != session_id
        || anchor["demo"] == true
        || anchor["referenceOnly"] == true
        || text(anchor, "model") == "本地导入"
    {
        return Err("请选择此会话中要保留的生成轮次".into());
    }
    let assets = doc["assets"].as_array().ok_or("图片列表无效")?;
    let all_jobs = doc["jobs"].as_array().ok_or("任务列表无效")?;
    let session_jobs: Vec<_> = all_jobs
        .iter()
        .filter(|job| text(job, "sessionId") == session_id)
        .collect();
    if session["titleStatus"] == "pending"
        || session_jobs.iter().any(|job| job["status"] == "running")
    {
        return Err("请等待会话生成或命名完成后再回退".into());
    }
    let jobs_by_asset: HashMap<_, _> = session_jobs
        .iter()
        .copied()
        .flat_map(|job| {
            job["assetIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(move |id| id.as_str().map(|id| (id, job)))
        })
        .collect();
    let anchor_job = jobs_by_asset.get(asset_id).copied();
    if anchor_job.is_some_and(|job| job["status"] != "completed") {
        return Err("只能回退到已完成的生成轮次".into());
    }
    let cutoff = order(anchor_job.unwrap_or(anchor));
    if cutoff.0.is_empty() {
        return Err("该轮缺少时间记录，无法安全回退".into());
    }
    let later_jobs: Vec<_> = session_jobs
        .into_iter()
        .filter(|job| order(job) > cutoff)
        .collect();
    let mut unlinked_count = 0;
    let later_results: Vec<_> = assets
        .iter()
        .filter(|asset| {
            if text(asset, "sessionId") != session_id || asset["referenceOnly"] == true {
                return false;
            }
            if let Some(job) = jobs_by_asset.get(text(asset, "id")) {
                return order(job) > cutoff;
            }
            let later = order(asset) > cutoff;
            if later {
                unlinked_count += 1;
            }
            later
        })
        .collect();
    let removed_turn_count = later_jobs.len() + unlinked_count;
    if removed_turn_count == 0 {
        return Err("此轮之后没有可移除的内容".into());
    }
    let jobs: BTreeSet<_> = later_jobs
        .iter()
        .map(|job| text(job, "id").to_owned())
        .collect();
    let results: BTreeSet<_> = later_results
        .iter()
        .map(|asset| text(asset, "id").to_owned())
        .collect();

    let mut protected = BTreeSet::new();
    for collection in ["sessions", "presets", "jobs"] {
        for record in doc[collection].as_array().into_iter().flatten() {
            if collection != "jobs" || !jobs.contains(text(record, "id")) {
                protected.extend(references(record));
            }
        }
    }
    for asset in assets {
        let id = text(asset, "id");
        if !results.contains(id) || asset["isReference"] == true {
            protected.insert(id.to_owned());
        }
    }
    protect_related_assets(assets, &mut protected);
    protected.retain(|id| results.contains(id));

    let has_response = !text(anchor, "responseId").is_empty();
    let provider_id = anchor_job
        .and_then(|job| job["imageSelection"]["providerId"].as_str())
        .or_else(|| {
            if session["lastResponseId"] == anchor["responseId"] {
                session["lastProviderId"].as_str()
            } else {
                None
            }
        });
    let context = if has_response {
        json!({
            "lastResponseId": anchor["responseId"],
            "lastProviderBaseUrl": anchor["providerBaseUrl"],
            "lastMainModel": anchor["mainModel"],
            "lastProviderId": provider_id,
            "contextMode": "continue",
        })
    } else {
        json!({"lastResponseId":null,"lastProviderBaseUrl":null,"lastMainModel":null,"lastProviderId":null,"contextMode":"new"})
    };
    let material = json!({"sessionId":session_id,"anchor":anchor,"context":context,
        "cutoff":cutoff,"laterJobs":later_jobs,"laterResults":later_results,"protected":protected});
    let preview = Preview {
        token: format!("{:x}", Sha256::digest(material.to_string().as_bytes())),
        removed_turn_count,
        removed_result_count: results.len() - protected.len(),
        preserved_result_count: protected.len(),
        has_response,
    };
    Ok(Rollback {
        preview,
        jobs,
        results,
        protected,
        context,
    })
}

pub fn preview(doc: &Value, session_id: &str, asset_id: &str) -> Result<Preview> {
    Ok(analyze(doc, session_id, asset_id)?.preview)
}

pub fn apply(doc: &mut Value, session_id: &str, asset_id: &str, token: &str) -> Result<()> {
    let rollback = analyze(doc, session_id, asset_id)?;
    if rollback.preview.token != token {
        return Err("轮次或图片引用已变化，请重新检查后确认回退".into());
    }
    list_mut(doc, "jobs")?.retain(|job| !rollback.jobs.contains(text(job, "id")));
    let assets = list_mut(doc, "assets")?;
    assets.retain(|asset| {
        let id = text(asset, "id");
        !rollback.results.contains(id) || rollback.protected.contains(id)
    });
    for asset in assets {
        if rollback.protected.contains(text(asset, "id")) {
            asset["sessionId"] = json!("");
            asset["sourceSessionId"] = json!(session_id);
            asset["referenceOnly"] = json!(true);
        }
    }
    let session = list_mut(doc, "sessions")?
        .iter_mut()
        .find(|session| text(session, "id") == session_id)
        .and_then(Value::as_object_mut)
        .ok_or("会话不存在")?;
    session.extend(rollback.context.as_object().unwrap().clone());
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn document() -> Value {
        json!({
            "schemaVersion": 1, "revision": 0,
            "settings": {"generation":{"apiMode":"responses","baseUrl":"https://example.com/v1","mainModel":"main-a","providerId":"provider-a"}},
            "workspaces": [{"id":"workspace"}],
            "sessions": [
                {"id":"session","workspaceId":"workspace","draft":"unsent prompt","referenceIds":["input"],
                 "contextMode":"new","lastResponseId":"resp-later","lastProviderId":"provider-b","lastMainModel":"main-b","lastProviderBaseUrl":"https://other.example/v1"},
                {"id":"elsewhere","workspaceId":"workspace","referenceIds":["shared"]}
            ],
            "assets": [
                {"id":"first","sessionId":"session","workspaceId":"workspace","createdAt":"2026-11-17T04:00:02+00:00",
                 "responseId":"resp-first","providerBaseUrl":"https://example.com/v1","mainModel":"main-a","path":"assets/first.png"},
                {"id":"first-sibling","sessionId":"session","workspaceId":"workspace","createdAt":"2026-11-17T04:00:03+00:00","path":"assets/first-sibling.png"},
                {"id":"shared","sessionId":"session","workspaceId":"workspace","createdAt":"2026-11-17T04:01:02+00:00","referenceIds":["linked"],"path":"assets/shared.png"},
                {"id":"linked","sessionId":"session","workspaceId":"workspace","createdAt":"2026-11-17T04:01:03+00:00","path":"assets/linked.png"},
                {"id":"private","sessionId":"session","workspaceId":"workspace","createdAt":"2026-11-17T04:01:04+00:00","path":"assets/private.png"},
                {"id":"input","workspaceId":"workspace","path":"assets/input.png"}
            ],
            "jobs": [
                {"id":"failed","sessionId":"session","status":"failed","createdAt":"2026-11-17T04:03:00+00:00","assetIds":[]},
                {"id":"other-job","sessionId":"elsewhere","status":"completed","createdAt":"2026-11-17T04:03:00+00:00","assetIds":[]},
                {"id":"later","sessionId":"session","status":"completed","createdAt":"2026-11-17T04:01:00+00:00","assetIds":["shared","linked","private"]},
                {"id":"starting","sessionId":"session","status":"completed","createdAt":"2026-11-17T04:00:00+00:00","assetIds":["first","first-sibling"],"imageSelection":{"providerId":"provider-a","modelId":"image-a"}}
            ],
            "presets": []
        })
    }

    #[test]
    fn session_rollback_keeps_whole_anchor_turn_and_syncs_restored_response() {
        let before = document();
        let mut after = before.clone();
        let preview = preview(&before, "session", "first").unwrap();
        assert_eq!(preview.removed_turn_count, 2);
        assert_eq!(preview.removed_result_count, 1);
        assert_eq!(preview.preserved_result_count, 2);
        apply(&mut after, "session", "first", &preview.token).unwrap();

        assert!(find(&after, "jobs", "later").is_err());
        assert!(find(&after, "jobs", "failed").is_err());
        assert!(find(&after, "jobs", "other-job").is_ok());
        assert!(find(&after, "assets", "first-sibling").is_ok());
        assert!(find(&after, "assets", "private").is_err());
        for id in ["shared", "linked"] {
            let asset = find(&after, "assets", id).unwrap();
            assert_eq!(asset["sessionId"], "");
            assert_eq!(asset["referenceOnly"], true);
        }
        let session = find(&after, "sessions", "session").unwrap();
        assert_eq!(session["draft"], "unsent prompt");
        assert_eq!(session["referenceIds"], json!(["input"]));
        assert_eq!(session["lastProviderId"], "provider-a");
        assert_eq!(session["contextMode"], "continue");

        let mut second_device = before;
        let synced = studio_sync::project(&after);
        studio_sync::validate_graph(&synced).unwrap();
        studio_sync::apply(&mut second_device, &synced);
        assert!(find(&second_device, "assets", "private").is_err());
        let request = serde_json::from_value(json!({"sessionId":"session","prompt":"new edit",
            "originalPrompt":"new edit","referenceIds":[],"size":"auto","quality":"auto","contextMode":"continue"})).unwrap();
        assert_eq!(
            crate::provider::previous_response_id(&second_device, &request)
                .unwrap()
                .as_deref(),
            Some("resp-first")
        );
    }

    #[test]
    fn session_rollback_rechecks_preview_and_clears_context_for_legacy_independent_result() {
        let mut doc = document();
        let token = preview(&doc, "session", "first").unwrap().token;
        doc["sessions"][1]["referenceIds"] = json!(["private"]);
        let changed = doc.clone();
        assert!(apply(&mut doc, "session", "first", &token).is_err());
        assert_eq!(doc, changed);
        assert!(preview(&doc, "elsewhere", "first").is_err());

        list_mut(&mut doc, "jobs")
            .unwrap()
            .retain(|job| job["id"] != "starting");
        list_mut(&mut doc, "assets")
            .unwrap()
            .retain(|asset| asset["id"] != "first-sibling");
        doc["assets"][0]["responseId"] = Value::Null;
        let preview = preview(&doc, "session", "first").unwrap();
        assert!(!preview.has_response);
        apply(&mut doc, "session", "first", &preview.token).unwrap();
        let session = find(&doc, "sessions", "session").unwrap();
        assert!(session["lastResponseId"].is_null());
        assert!(session["lastProviderId"].is_null());
        assert_eq!(session["contextMode"], "new");
    }
}
