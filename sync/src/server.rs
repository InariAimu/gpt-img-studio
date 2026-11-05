use crate::*;
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Extension, Json, Router,
};
use futures_util::StreamExt;
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use subtle::ConstantTimeEq;
use tokio::io::AsyncWriteExt;

pub struct Service {
    pub root: PathBuf,
    db: Mutex<Connection>,
    pub server_id: String,
    tokens_file: PathBuf,
    transfers: tokio::sync::Semaphore,
}
type ApiResult<T> = std::result::Result<T, (StatusCode, String)>;
fn internal(e: impl std::fmt::Display) -> (StatusCode, String) {
    eprintln!("sync storage: {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "同步服务存储操作失败".into(),
    )
}
impl Service {
    pub fn open(root: PathBuf, tokens_file: PathBuf) -> Result<Arc<Self>> {
        std::fs::create_dir_all(root.join("blobs")).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(root.join("staging")).map_err(|e| e.to_string())?;
        let db = Connection::open(root.join("sync.sqlite3")).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS entities (key TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT);
          CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT);").map_err(|e| e.to_string())?;
        db.execute(
            "INSERT OR IGNORE INTO meta VALUES('instance',?1)",
            [uuid::Uuid::new_v4().to_string()],
        )
        .map_err(|e| e.to_string())?;
        let server_id = db
            .query_row("SELECT value FROM meta WHERE key='instance'", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(Self {
            root,
            db: Mutex::new(db),
            server_id,
            tokens_file,
            transfers: tokio::sync::Semaphore::new(2),
        }))
    }
    fn record(db: &Connection, key: &str) -> rusqlite::Result<Record> {
        let row: Option<(i64, Option<String>)> = db
            .query_row(
                "SELECT revision,payload FROM entities WHERE key=?1",
                [key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(match row {
            Some((revision, payload)) => Record {
                key: key.into(),
                revision: revision as u64,
                value: payload.map(|v| serde_json::from_str(&v).expect("validated JSON")),
            },
            None => Record {
                key: key.into(),
                revision: 0,
                value: None,
            },
        })
    }
    fn push(&self, request: Push) -> ApiResult<PushResult> {
        if request.protocol != PROTOCOL || request.server_id != self.server_id {
            return Err((
                StatusCode::CONFLICT,
                "服务端身份或协议已改变；请检查备份恢复状态".into(),
            ));
        }
        if request.mutations.len() > 10000 {
            return Err((StatusCode::BAD_REQUEST, "每批最多 10000 条记录".into()));
        }
        let mut seen = BTreeSet::new();
        for m in &request.mutations {
            validate_entity(&m.key, &m.value).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
            if !seen.insert(&m.key) {
                return Err((StatusCode::BAD_REQUEST, "同一批次不能重复修改记录".into()));
            }
            if m.key.starts_with("assets/") {
                if let Some(v) = &m.value {
                    let name = blob_name(v["path"].as_str().unwrap())
                        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
                    if !self.root.join("blobs").join(name).is_file() {
                        return Err((StatusCode::CONFLICT, "原图尚未上传完成".into()));
                    }
                }
            }
        }
        let mut db = self.db.lock().map_err(internal)?;
        let tx = db.transaction().map_err(internal)?;
        let before: Vec<Record> = request
            .mutations
            .iter()
            .map(|m| Self::record(&tx, &m.key))
            .collect::<std::result::Result<_, _>>()
            .map_err(internal)?;
        let mut result = PushResult::default();
        for m in request.mutations {
            let old = Self::record(&tx, &m.key).map_err(internal)?;
            if old.value == m.value {
                result.accepted.push(old);
                continue;
            }
            if old.revision != m.base_revision {
                result.conflicts.push(old);
                continue;
            }
            let r = Record {
                key: m.key,
                revision: old.revision + 1,
                value: m.value,
            };
            let payload = r.value.as_ref().map(Value::to_string);
            tx.execute("INSERT INTO entities VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",params![r.key,r.revision as i64,payload]).map_err(internal)?;
            tx.execute(
                "INSERT INTO changes(key,revision,payload) VALUES(?1,?2,?3)",
                params![r.key, r.revision as i64, payload],
            )
            .map_err(internal)?;
            result.accepted.push(r);
        }
        {
            let mut stmt = tx
                .prepare("SELECT key,payload FROM entities WHERE payload IS NOT NULL")
                .map_err(internal)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(internal)?;
            let mut entities = Entities::new();
            for row in rows {
                let (k, v) = row.map_err(internal)?;
                entities.insert(k, serde_json::from_str(&v).map_err(internal)?);
            }
            if validate_graph(&entities).is_err() {
                return Ok(PushResult {
                    accepted: vec![],
                    conflicts: before,
                });
            }
        }
        tx.commit().map_err(internal)?;
        Ok(result)
    }
}
async fn auth(State(s): State<Arc<Service>>, mut request: Request, next: Next) -> Response {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    let hashed = hash(token.as_bytes());
    let tokens: BTreeMap<String, String> = std::fs::read(&s.tokens_file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let device = tokens
        .into_iter()
        .find(|(_, expected)| {
            token.len() >= 32 && bool::from(expected.as_bytes().ct_eq(hashed.as_bytes()))
        })
        .map(|(device, _)| device);
    let Some(device) = device else {
        return (StatusCode::UNAUTHORIZED, "同步令牌无效或已撤销").into_response();
    };
    request.extensions_mut().insert(device);
    next.run(request).await
}
pub fn router(s: Arc<Service>) -> Router {
    let protected = Router::new()
        .route("/v1/push", post(push))
        .route("/v1/changes", get(changes))
        .route("/v1/blobs/{name}", put(upload).get(download).head(exists))
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .route_layer(middleware::from_fn_with_state(s.clone(), auth));
    Router::new()
        .route("/health", get(health))
        .merge(protected)
        .with_state(s)
}
async fn health(State(s): State<Arc<Service>>) -> Json<Value> {
    Json(
        json!({"service":"gpt-img-studio-sync","protocol":PROTOCOL,"serverId":s.server_id,"version":env!("CARGO_PKG_VERSION")}),
    )
}
async fn push(
    State(s): State<Arc<Service>>,
    Extension(device): Extension<String>,
    Json(request): Json<Push>,
) -> ApiResult<Json<PushResult>> {
    if request.device_id != device {
        return Err((StatusCode::FORBIDDEN, "令牌不属于此设备".into()));
    }
    s.push(request).map(Json)
}
#[derive(Deserialize)]
struct Cursor {
    #[serde(default)]
    after: u64,
}
async fn changes(
    State(s): State<Arc<Service>>,
    Query(q): Query<Cursor>,
) -> ApiResult<Json<Changes>> {
    if q.after > i64::MAX as u64 {
        return Err((StatusCode::BAD_REQUEST, "无效游标".into()));
    }
    let db = s.db.lock().map_err(internal)?;
    let max: i64 = db
        .query_row("SELECT COALESCE(MAX(seq),0) FROM changes", [], |r| r.get(0))
        .map_err(internal)?;
    if q.after > max as u64 {
        return Err((
            StatusCode::CONFLICT,
            "服务端游标已回退，请检查服务端恢复状态".into(),
        ));
    }
    let mut stmt = db
        .prepare("SELECT seq,key,revision,payload FROM changes WHERE seq>?1 ORDER BY seq LIMIT 200")
        .map_err(internal)?;
    let rows = stmt
        .query_map([q.after as i64], |r| {
            Ok((
                r.get::<_, i64>(0)? as u64,
                Record {
                    key: r.get(1)?,
                    revision: r.get::<_, i64>(2)? as u64,
                    value: r
                        .get::<_, Option<String>>(3)?
                        .map(|v| serde_json::from_str(&v).expect("validated JSON")),
                },
            ))
        })
        .map_err(internal)?;
    let mut cursor = q.after;
    let mut records = Vec::new();
    for row in rows {
        let (seq, r) = row.map_err(internal)?;
        cursor = seq;
        records.push(r);
    }
    Ok(Json(Changes {
        server_id: s.server_id.clone(),
        cursor,
        more: cursor < (max as u64),
        records,
    }))
}
fn path(s: &Service, name: &str) -> ApiResult<PathBuf> {
    blob_name(&format!("assets/{name}")).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(s.root.join("blobs").join(name))
}
async fn exists(State(s): State<Arc<Service>>, Path(name): Path<String>) -> ApiResult<StatusCode> {
    Ok(if path(&s, &name)?.is_file() {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    })
}
async fn download(State(s): State<Arc<Service>>, Path(name): Path<String>) -> ApiResult<Response> {
    let file = tokio::fs::File::open(path(&s, &name)?)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "原图不存在".into()))?;
    let len = file.metadata().await.map_err(internal)?.len();
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, len.to_string()),
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable".into(),
            ),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(file)),
    )
        .into_response())
}
async fn upload(
    State(s): State<Arc<Service>>,
    Path(name): Path<String>,
    body: Body,
) -> ApiResult<StatusCode> {
    let target = path(&s, &name)?;
    let _permit = s.transfers.acquire().await.map_err(internal)?;
    let temp = s
        .root
        .join("staging")
        .join(uuid::Uuid::new_v4().to_string());
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .await
            .map_err(internal)?;
        let mut stream = body.into_data_stream();
        let mut digest = Sha256::new();
        let mut len = 0usize;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| (StatusCode::BAD_REQUEST, "上传中断".into()))?;
            len += chunk.len();
            if len > MAX_BLOB {
                return Err((StatusCode::PAYLOAD_TOO_LARGE, "原图超过 128 MiB".into()));
            }
            digest.update(&chunk);
            file.write_all(&chunk).await.map_err(internal)?;
        }
        if format!("{:x}", digest.finalize()) != name.split('.').next().unwrap_or("") {
            return Err((StatusCode::BAD_REQUEST, "图片哈希校验失败".into()));
        }
        file.sync_all().await.map_err(internal)?;
        drop(file);
        if !target.exists() {
            tokio::fs::rename(&temp, &target).await.map_err(internal)?;
        }
        Ok(StatusCode::CREATED)
    }
    .await;
    if temp.exists() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}
