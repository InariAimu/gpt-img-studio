use crate::*;
use futures_util::stream;
use reqwest::{Client, Response};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

pub struct Exchange {
    pub sent: Vec<Mutation>,
    pub accepted: Vec<Record>,
    pub remote: Vec<Record>,
    pub server_id: String,
    pub cursor: u64,
    pub uploaded: usize,
    pub downloaded: usize,
}
pub fn normalize_url(input: &str) -> Result<String> {
    let value = input.trim().trim_end_matches('/');
    let u = reqwest::Url::parse(value).map_err(|_| "同步地址无效")?;
    let host = u.host_str().unwrap_or("");
    let local = host == "localhost"
        || host.parse::<std::net::IpAddr>().is_ok_and(|ip| match ip {
            std::net::IpAddr::V4(v) => v.is_private() || v.is_loopback(),
            std::net::IpAddr::V6(v) => v.is_loopback() || v.is_unique_local(),
        });
    if (u.scheme() != "https" && !(u.scheme() == "http" && local))
        || host.is_empty()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("公网同步必须使用 HTTPS；HTTP 仅支持明确的内网或本机 IP".into());
    }
    Ok(value.into())
}
async fn checked(response: std::result::Result<Response, reqwest::Error>) -> Result<Response> {
    let r = response.map_err(|e| format!("同步连接失败：{}", e.without_url()))?;
    if !r.status().is_success() {
        return Err(format!("同步服务返回 HTTP {}", r.status().as_u16()));
    }
    Ok(r)
}
async fn json<T: serde::de::DeserializeOwned>(r: Response) -> Result<T> {
    let mut r = r;
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|e| e.without_url().to_string())? {
        if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
            return Err("同步元数据响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "同步服务返回的数据格式无效".into())
}
fn local_path(root: &Path, name: &str) -> Result<PathBuf> {
    blob_name(&format!("assets/{name}"))?;
    let dir = root.join("assets");
    let path = dir.join(name);
    for ancestor in path.ancestors() {
        if let Ok(meta) = std::fs::symlink_metadata(ancestor) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("同步图片路径不能经过目录链接".into());
                }
            }
            if meta.file_type().is_symlink() {
                return Err("同步图片路径不能经过链接".into());
            }
        }
    }
    Ok(path)
}
pub async fn exchange(
    client: &Client,
    url: &str,
    token: &str,
    device: &str,
    root: &Path,
    local: &Entities,
    state: &ClientState,
) -> Result<Exchange> {
    validate_graph(local)?;
    let url = normalize_url(url)?;
    let health: Value =
        json(checked(client.get(format!("{url}/health")).send().await).await?).await?;
    let server_id = health["serverId"]
        .as_str()
        .ok_or("同步服务器缺少身份")?
        .to_string();
    if health["service"] != "gpt-img-studio-sync" || health["protocol"] != PROTOCOL {
        return Err("同步服务器协议不兼容".into());
    }
    if !state.server_id.is_empty() && server_id != state.server_id {
        return Err("同步服务器身份发生变化；已暂停同步以保护本地数据，请恢复原服务备份".into());
    }
    let sent = mutations(local, state);
    // Bound a whole transaction instead of splitting a session move/delete across requests.
    if sent.len() > 10000
        || serde_json::to_vec(&sent).map_err(|e| e.to_string())?.len() > 31 * 1024 * 1024
    {
        return Err("单次待同步超过 10000 条或 31 MiB；本地数据保留".into());
    }
    let mut uploaded = 0;
    let mut names = BTreeSet::new();
    for m in &sent {
        if m.key.starts_with("assets/") {
            if let Some(v) = &m.value {
                names.insert(blob_name(v["path"].as_str().unwrap_or(""))?.to_string());
            }
        }
    }
    for name in names {
        let r = client
            .head(format!("{url}/v1/blobs/{name}"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        if r.status().is_success() {
            continue;
        }
        if r.status() != reqwest::StatusCode::NOT_FOUND {
            return Err(format!("检查原图失败：HTTP {}", r.status().as_u16()));
        }
        let path = local_path(root, &name)?;
        let file = tokio::fs::File::open(&path)
            .await
            .map_err(|_| format!("待上传原图缺失：{name}"))?;
        let len = file.metadata().await.map_err(|e| e.to_string())?.len();
        if len > MAX_BLOB as u64 {
            return Err("原图超过 128 MiB".into());
        }
        let body = stream::try_unfold(file, |mut file| async move {
            use tokio::io::AsyncReadExt;
            let mut bytes = vec![0u8; 64 * 1024];
            let len = file.read(&mut bytes).await?;
            Ok::<_, std::io::Error>(if len == 0 {
                None
            } else {
                bytes.truncate(len);
                Some((bytes, file))
            })
        });
        checked(
            client
                .put(format!("{url}/v1/blobs/{name}"))
                .bearer_auth(token)
                .header("Content-Type", "application/octet-stream")
                .header("Content-Length", len)
                .body(reqwest::Body::wrap_stream(body))
                .send()
                .await,
        )
        .await?;
        uploaded += 1;
    }
    let pushed: PushResult = if sent.is_empty() {
        PushResult::default()
    } else {
        json(
            checked(
                client
                    .post(format!("{url}/v1/push"))
                    .bearer_auth(token)
                    .json(&Push {
                        protocol: PROTOCOL,
                        server_id: server_id.clone(),
                        device_id: device.into(),
                        mutations: sent.clone(),
                    })
                    .send()
                    .await,
            )
            .await?,
        )
        .await?
    };
    let mut cursor = state.cursor;
    let mut latest = BTreeMap::new();
    loop {
        let page: Changes = json(
            checked(
                client
                    .get(format!("{url}/v1/changes?after={cursor}"))
                    .bearer_auth(token)
                    .send()
                    .await,
            )
            .await?,
        )
        .await?;
        if page.server_id != server_id
            || page.cursor < cursor
            || (page.more && page.cursor == cursor)
        {
            return Err("服务端游标或身份异常".into());
        }
        for r in page.records {
            validate_entity(&r.key, &r.value)?;
            latest.insert(r.key.clone(), r);
        }
        cursor = page.cursor;
        if !page.more {
            break;
        }
    }
    for r in pushed.conflicts.iter().chain(pushed.accepted.iter()) {
        if !latest.contains_key(&r.key) {
            latest.insert(r.key.clone(), r.clone());
        }
    }
    let mut downloaded = 0;
    tokio::fs::create_dir_all(root.join("assets"))
        .await
        .map_err(|e| e.to_string())?;
    for r in latest.values().filter(|r| r.key.starts_with("assets/")) {
        if let Some(v) = &r.value {
            let name = blob_name(v["path"].as_str().unwrap_or(""))?;
            let path = local_path(root, name)?;
            if path.is_file() {
                let existing = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
                if hash(&existing) == name.split('.').next().unwrap() {
                    continue;
                }
                return Err(format!("本地原图校验失败，未覆盖文件：{name}"));
            }
            let mut r = checked(
                client
                    .get(format!("{url}/v1/blobs/{name}"))
                    .bearer_auth(token)
                    .send()
                    .await,
            )
            .await?;
            let temp = root
                .join("assets")
                .join(format!(".sync-{}", uuid::Uuid::new_v4()));
            let result = async {
                let mut f = tokio::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&temp)
                    .await
                    .map_err(|e| e.to_string())?;
                let mut digest = Sha256::new();
                let mut size = 0;
                while let Some(b) = r.chunk().await.map_err(|e| e.without_url().to_string())? {
                    size += b.len();
                    if size > MAX_BLOB {
                        return Err("下载图片超过 128 MiB".to_string());
                    }
                    digest.update(&b);
                    f.write_all(&b).await.map_err(|e| e.to_string())?;
                }
                if format!("{:x}", digest.finalize()) != name.split('.').next().unwrap() {
                    return Err("下载图片校验失败".into());
                }
                f.sync_all().await.map_err(|e| e.to_string())?;
                drop(f);
                // Never replace an image concurrently created by a generation/import.
                if !path.exists() {
                    tokio::fs::rename(&temp, &path)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                Ok(())
            }
            .await;
            if temp.exists() {
                let _ = tokio::fs::remove_file(&temp).await;
            }
            result?;
            downloaded += 1;
        }
    }
    Ok(Exchange {
        sent,
        accepted: pushed.accepted,
        remote: latest.into_values().collect(),
        server_id,
        cursor,
        uploaded,
        downloaded,
    })
}
