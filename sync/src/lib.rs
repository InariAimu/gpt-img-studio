//! Shared, versioned sync contract. Local settings, credentials and usage never enter it.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub mod client;
#[cfg(feature = "server")]
pub mod server;
pub type Result<T> = std::result::Result<T, String>;
pub const PROTOCOL: u32 = 2;
pub const MAX_BLOB: usize = 128 * 1024 * 1024;
pub const COLLECTIONS: [&str; 8] = [
    "sketches",
    "sketchLibraries",
    "workspaces",
    "sessions",
    "assets",
    "presets",
    "jobs",
    "providers",
];
pub type Entities = BTreeMap<String, Value>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub key: String,
    pub revision: u64,
    pub value: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    pub key: String,
    pub base_revision: u64,
    pub value: Option<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Push {
    pub protocol: u32,
    pub server_id: String,
    pub device_id: String,
    pub mutations: Vec<Mutation>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub accepted: Vec<Record>,
    pub conflicts: Vec<Record>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub server_id: String,
    pub cursor: u64,
    pub more: bool,
    pub records: Vec<Record>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Conflict {
    pub key: String,
    pub local: Option<Value>,
    pub remote: Option<Value>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientState {
    pub server_id: String,
    pub cursor: u64,
    pub baseline: BTreeMap<String, Record>,
    pub conflicts: BTreeMap<String, Conflict>,
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub fn valid_hash(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn blob_name(path: &str) -> Result<&str> {
    let name = path
        .strip_prefix("assets/")
        .ok_or("图片路径必须位于 assets/")?;
    let (digest, ext) = name.split_once('.').ok_or("图片路径缺少扩展名")?;
    if !valid_hash(digest) || !["png", "jpg", "jpeg", "webp", "gif", "svg", "json"].contains(&ext) {
        return Err("无效的图片哈希路径".into());
    }
    Ok(name)
}
pub fn validate_entity(key: &str, value: &Option<Value>) -> Result<()> {
    let (collection, id) = key.split_once('/').ok_or("无效的同步记录")?;
    if !COLLECTIONS.contains(&collection) || !valid_id(id) {
        return Err("无效的同步记录 ID".into());
    }
    if let Some(v) = value {
        if !v.is_object() || v["id"].as_str() != Some(id) || v.to_string().len() > 1024 * 1024 {
            return Err("同步记录格式错误或过大".into());
        }
        if collection == "assets" {
            let name = blob_name(v["path"].as_str().ok_or("缺少原图路径")?)?;
            if name.ends_with(".json") { return Err("图片不能引用草图 JSON".into()); }
            if name.ends_with(".svg") != (v["mime"].as_str() == Some("image/svg+xml")) {
                return Err("SVG 图片类型与文件扩展名不一致".into());
            }
        }
        if collection == "sketches" {
            let name = blob_name(v["documentPath"].as_str().ok_or("缺少草图文件")?)?;
            if !name.ends_with(".json") || !v["revision"].is_string() || !v["name"].is_string()
                || ["width", "height"].iter().any(|k| !v[*k].as_u64().is_some_and(|n| (256..=4096).contains(&n))) {
                return Err("草图元数据无效".into());
            }
            if let Some(path)=v["previewPath"].as_str(){if !blob_name(path)?.ends_with(".png"){return Err("草图预览必须是 PNG".into());}}
        }
        if collection == "sketchLibraries" && (!v["savedPoses"].is_array() || !v["favoritePoses"].is_array()) { return Err("姿势库格式无效".into()); }
        if collection == "providers" {
            let url = reqwest::Url::parse(v["baseUrl"].as_str().unwrap_or(""))
                .map_err(|_| "提供商地址无效")?;
            if !["http", "https"].contains(&url.scheme())
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
            {
                return Err("提供商地址不能包含凭据或参数".into());
            }
            if v.as_object()
                .unwrap()
                .keys()
                .any(|k| !["id", "name", "kind", "baseUrl", "models"].contains(&k.as_str()))
            {
                return Err("提供商同步字段无效".into());
            }
        }
    }
    Ok(())
}
/// All content must arrive before its metadata, including editable JSON and rendered previews.
pub fn blob_names(key:&str, value:&Value)->Result<Vec<String>> {
    let fields:&[&str]=if key.starts_with("assets/"){&["path"]}else if key.starts_with("sketches/"){&["documentPath","previewPath"]}else{&[]};
    fields.iter().filter_map(|field|value[*field].as_str()).map(|path|blob_name(path).map(str::to_owned)).collect()
}
/// Preserve concurrent scene edits as a separate document instead of merging transforms.
pub fn preserve_sketch_conflicts(entities:&mut Entities,state:&mut ClientState) {
    let conflicts:Vec<_>=state.conflicts.values().filter(|c|c.key.starts_with("sketches/")).cloned().collect();
    for conflict in conflicts {
        if let Some(mut local)=conflict.local.filter(|local| conflict.remote.as_ref().is_none_or(|remote| ["documentPath","name","trashedAt"].iter().any(|key|local[*key]!=remote[*key]))) {
            let copy_id=format!("conflict-{}", &hash(local.to_string().as_bytes())[..32]);
            local["id"]=Value::String(copy_id.clone());
            local["name"]=Value::String(format!("{} · 冲突副本",local["name"].as_str().unwrap_or("草图").chars().take(100).collect::<String>()));
            local.as_object_mut().unwrap().remove("trashedAt");
            entities.insert(format!("sketches/{copy_id}"),local);
        }
        set(entities,&conflict.key,conflict.remote);
        state.conflicts.remove(&conflict.key);
    }
}
pub fn project(doc: &Value) -> Entities {
    let mut result = Entities::new();
    for collection in COLLECTIONS {
        let items = if collection == "providers" {
            &doc["settings"][collection]
        } else {
            &doc[collection]
        };
        for item in items.as_array().into_iter().flatten() {
            let id = item["id"].as_str().unwrap_or("");
            if !valid_id(id) || item["demo"] == true {
                continue;
            }
            // Running jobs remain on their originating device and are never replayed elsewhere.
            if collection == "jobs" && item["status"] == "running" {
                continue;
            }
            let mut item = item.clone();
            if collection == "providers" {
                let fields = ["id", "name", "kind", "baseUrl", "models"];
                item.as_object_mut()
                    .unwrap()
                    .retain(|key, _| fields.contains(&key.as_str()));
                for model in item["models"].as_array_mut().into_iter().flatten() {
                    if let Some(model) = model.as_object_mut() {
                        model.retain(|key, _| {
                            ["id", "name", "kind", "protocol", "vision", "pricing"]
                                .contains(&key.as_str())
                        });
                    }
                }
            }
            if collection == "assets" || collection == "sketches" {
                item.as_object_mut().unwrap().remove("thumbnailPath");
            }
            if collection == "sessions" {
                for field in ["titleStatus", "titleError", "titleAttempted"] {
                    item.as_object_mut().unwrap().remove(field);
                }
            }
            result.insert(format!("{collection}/{id}"), item);
        }
    }
    result
}
pub fn mutations(local: &Entities, state: &ClientState) -> Vec<Mutation> {
    let keys: BTreeSet<_> = local.keys().chain(state.baseline.keys()).cloned().collect();
    keys.into_iter()
        .filter_map(|key| {
            if state.conflicts.contains_key(&key) {
                return None;
            }
            let old = state.baseline.get(&key);
            let value = local.get(&key).cloned();
            if old.and_then(|r| r.value.as_ref()) == value.as_ref() {
                return None;
            }
            Some(Mutation {
                key,
                base_revision: old.map_or(0, |r| r.revision),
                value,
            })
        })
        .collect()
}
/// Three-way reconciliation also handles edits made while the HTTP request was in flight.
pub fn reconcile(
    current: &Entities,
    mut state: ClientState,
    sent: &[Mutation],
    accepted: &[Record],
    remote: &[Record],
) -> (Entities, ClientState) {
    let mut output = current.clone();
    let accepted: BTreeMap<_, _> = accepted.iter().map(|r| (r.key.clone(), r)).collect();
    let sent: BTreeMap<_, _> = sent.iter().map(|r| (r.key.clone(), r)).collect();
    for r in remote {
        let prior = state.baseline.get(&r.key).and_then(|v| v.value.clone());
        let local = output.get(&r.key).cloned();
        let own = accepted
            .get(&r.key)
            .filter(|a| a.revision <= r.revision)
            .and_then(|_| sent.get(&r.key));
        let compared = own.map(|s| s.value.clone()).unwrap_or(prior);
        if local == r.value || local == compared {
            set(&mut output, &r.key, r.value.clone());
            state.conflicts.remove(&r.key);
        } else if compared != r.value {
            state.conflicts.insert(
                r.key.clone(),
                Conflict {
                    key: r.key.clone(),
                    local,
                    remote: r.value.clone(),
                },
            );
        }
        state.baseline.insert(r.key.clone(), r.clone());
    }
    (output, state)
}
pub fn set(items: &mut Entities, key: &str, value: Option<Value>) {
    if let Some(v) = value {
        items.insert(key.into(), v);
    } else {
        items.remove(key);
    }
}
pub fn references(key: &str, value: &Value) -> Vec<String> {
    let mut refs = Vec::new();
    for (field, collection) in [
        ("workspaceId", "workspaces"),
        ("sessionId", "sessions"),
        ("assetId", "assets"),
    ] {
        if key.starts_with("providers/") {
            continue;
        }
        if let Some(id) = value[field].as_str().filter(|s| !s.is_empty()) {
            refs.push(format!("{collection}/{id}"));
        }
    }
    for field in ["referenceIds", "assetIds"] {
        for id in value[field]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            refs.push(format!("assets/{id}"));
        }
    }
    refs
}
pub fn validate_graph(entities: &Entities) -> Result<()> {
    for (key, v) in entities {
        for r in references(key, v) {
            if !r.split('/').nth(1).unwrap_or("").starts_with("demo-") && !entities.contains_key(&r)
            {
                return Err(format!("记录 {key} 仍引用 {r}，请保留相关记录后重试"));
            }
        }
    }
    Ok(())
}
pub fn protect_references(
    entities: &mut Entities,
    previous: &Entities,
    state: &mut ClientState,
) -> Result<()> {
    loop {
        let missing: BTreeSet<_> = entities
            .iter()
            .flat_map(|(k, v)| references(k, v))
            .filter(|k| {
                !entities.contains_key(k) && !k.split('/').nth(1).unwrap_or("").starts_with("demo-")
            })
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        for key in missing {
            let value = previous
                .get(&key)
                .cloned()
                .ok_or_else(|| format!("缺少被引用的记录 {key}；本地同步状态未提交"))?;
            entities.insert(key.clone(), value.clone());
            state.conflicts.insert(
                key.clone(),
                Conflict {
                    key,
                    local: Some(value),
                    remote: None,
                },
            );
        }
    }
}
pub fn apply(doc: &mut Value, entities: &Entities) {
    for collection in COLLECTIONS {
        let previous = if collection == "providers" {
            &doc["settings"][collection]
        } else {
            &doc[collection]
        };
        let mut items = Vec::new();
        let mut seen = BTreeSet::new();
        for old in previous.as_array().into_iter().flatten() {
            let key = format!("{collection}/{}", old["id"].as_str().unwrap_or(""));
            if old["demo"] == true || (collection == "jobs" && old["status"] == "running") {
                items.push(old.clone());
                continue;
            }
            if let Some(v) = entities.get(&key) {
                let mut v = v.clone();
                if collection == "assets"
                    && old["path"] == v["path"]
                    && old.get("thumbnailPath").is_some()
                {
                    v["thumbnailPath"] = old["thumbnailPath"].clone();
                }
                if collection == "sessions" {
                    for field in ["titleStatus", "titleError", "titleAttempted"] {
                        if let Some(x) = old.get(field) {
                            v[field] = x.clone();
                        }
                    }
                }
                items.push(v);
                seen.insert(key);
            }
        }
        for (key, item) in entities
            .iter()
            .filter(|(k, _)| k.starts_with(&format!("{collection}/")))
        {
            if !seen.contains(key) {
                items.push(item.clone());
            }
        }
        if collection == "workspaces" && items.iter().any(|w| w["sortOrder"].as_u64().is_some()) {
            // Legacy documents keep their order until the user explicitly sorts. Unranked
            // workspaces (including new ones from older clients) follow the ordered list.
            // Ties must converge even when the two devices started with different arrays.
            items.sort_by(|a, b| {
                a["sortOrder"].as_u64().unwrap_or(u64::MAX)
                    .cmp(&b["sortOrder"].as_u64().unwrap_or(u64::MAX))
                    .then_with(|| a["createdAt"].as_str().unwrap_or("").cmp(b["createdAt"].as_str().unwrap_or("")))
                    .then_with(|| a["id"].as_str().unwrap_or("").cmp(b["id"].as_str().unwrap_or("")))
            });
        }
        if collection == "providers" {
            if !items.is_empty() || doc["settings"].get(collection).is_some() {
                doc["settings"][collection] = json!(items);
            }
        } else {
            doc[collection] = json!(items);
        }
    }
}

#[cfg(test)]
mod tests;
