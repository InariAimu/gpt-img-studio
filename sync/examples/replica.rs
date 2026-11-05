//! Verify a real service with a fresh local replica, without uploading mutations.
use serde_json::{json, Value};
use std::path::PathBuf;
use studio_sync::{client, ClientState, Result};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Usage: replica CONNECTION.json NEW-OUTPUT-DIR".into());
    }
    let config: Value =
        serde_json::from_slice(&std::fs::read(&args[1]).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let root = PathBuf::from(&args[2]);
    if root.exists() {
        return Err("Output directory must not already exist".into());
    }
    std::fs::create_dir_all(root.join("assets")).map_err(|e| e.to_string())?;
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .unwrap();
    let exchange = client::exchange(
        &http,
        config["config"]["url"].as_str().unwrap(),
        config["token"].as_str().unwrap(),
        config["config"]["deviceId"].as_str().unwrap(),
        &root,
        &Default::default(),
        &ClientState::default(),
    )
    .await?;
    assert!(exchange.sent.is_empty());
    let (entities, mut state) = studio_sync::reconcile(
        &Default::default(),
        ClientState::default(),
        &exchange.sent,
        &exchange.accepted,
        &exchange.remote,
    );
    studio_sync::validate_graph(&entities)?;
    let mut doc = json!({"schemaVersion":1,"revision":1,"settings":{},"workspaces":[],"sessions":[],"assets":[],"jobs":[],"presets":[]});
    studio_sync::apply(&mut doc, &entities);
    state.server_id = exchange.server_id;
    state.cursor = exchange.cursor;
    let mut db =
        rusqlite::Connection::open(root.join("studio.sqlite3")).map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE studio_state (id INTEGER PRIMARY KEY,document TEXT NOT NULL);CREATE TABLE sync_local (id INTEGER PRIMARY KEY,config TEXT NOT NULL,state TEXT NOT NULL);").map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO studio_state VALUES(1,?1)", [doc.to_string()])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO sync_local VALUES(1,?1,?2)",
        rusqlite::params![
            config["config"].to_string(),
            serde_json::to_string(&state).unwrap()
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    drop(db);
    let reopened = rusqlite::Connection::open(root.join("studio.sqlite3")).unwrap();
    let serialized: String = reopened
        .query_row("SELECT state FROM sync_local", [], |r| r.get(0))
        .unwrap();
    let persisted: ClientState = serde_json::from_str(&serialized).unwrap();
    let retry = client::exchange(
        &http,
        config["config"]["url"].as_str().unwrap(),
        config["token"].as_str().unwrap(),
        config["config"]["deviceId"].as_str().unwrap(),
        &root,
        &entities,
        &persisted,
    )
    .await?;
    assert!(retry.sent.is_empty());
    assert_eq!(retry.uploaded, 0);
    assert_eq!(retry.downloaded, 0);
    println!("PASS: fresh replica, {} records, {} verified original files, cursor {}, reopened SQLite and no duplicate transfer",entities.len(),exchange.downloaded,state.cursor);
    Ok(())
}
