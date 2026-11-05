//! Destructive synthetic smoke test: use a separate, empty test service.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use studio_sync::{client, ClientState, Result};

struct Peer {
    config: Value,
    root: PathBuf,
    doc: Value,
    state: ClientState,
}
impl Peer {
    async fn sync(&mut self, http: &reqwest::Client) -> Result<()> {
        let e = client::exchange(
            http,
            self.config["config"]["url"].as_str().unwrap(),
            self.config["token"].as_str().unwrap(),
            self.config["config"]["deviceId"].as_str().unwrap(),
            &self.root,
            &studio_sync::project(&self.doc),
            &self.state,
        )
        .await?;
        let previous = studio_sync::project(&self.doc);
        let (mut entities, mut state) = studio_sync::reconcile(
            &previous,
            self.state.clone(),
            &e.sent,
            &e.accepted,
            &e.remote,
        );
        studio_sync::protect_references(&mut entities, &previous, &mut state)?;
        studio_sync::apply(&mut self.doc, &entities);
        state.server_id = e.server_id;
        state.cursor = e.cursor;
        self.state = state;
        Ok(())
    }
}
fn peer(config: &str, root: &Path) -> Peer {
    std::fs::create_dir_all(root.join("assets")).unwrap();
    Peer {
        config: serde_json::from_slice(&std::fs::read(config).unwrap()).unwrap(),
        root: root.into(),
        doc: json!({"settings":{},"workspaces":[],"sessions":[],"assets":[],"jobs":[],"presets":[]}),
        state: ClientState::default(),
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4 {
        return Err(
            "Usage: verify TEST-PC-A.json TEST-PC-B.json EMPTY-OUTPUT-DIR (empty test server only)"
                .into(),
        );
    }
    let root = PathBuf::from(&args[3]);
    if root.exists() {
        return Err("Test directory must not already exist".into());
    }
    let mut a = peer(&args[1], &root.join("a"));
    let mut b = peer(&args[2], &root.join("b"));
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap();
    let url = a.config["config"]["url"].as_str().unwrap();
    let changes: studio_sync::Changes = http
        .get(format!("{url}/v1/changes"))
        .bearer_auth(a.config["token"].as_str().unwrap())
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?
        .error_for_status()
        .map_err(|e| e.without_url().to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if changes.cursor != 0 {
        return Err("Refusing smoke test on a nonempty service".into());
    }
    let bytes = vec![42u8; 3 * 1024 * 1024];
    let name = format!("{}.png", studio_sync::hash(&bytes));
    std::fs::write(a.root.join("assets").join(&name), &bytes).unwrap();
    a.doc["workspaces"] = json!([{"id":"probe-workspace","name":"NAS smoke test"}]);
    a.doc["sessions"] = json!([{"id":"probe-session","workspaceId":"probe-workspace","draft":"A","referenceIds":["probe-image"]}]);
    a.doc["assets"] = json!([{"id":"probe-image","path":format!("assets/{name}"),"sessionId":"probe-session","workspaceId":"probe-workspace"}]);
    a.sync(&http).await?;
    b.sync(&http).await?;
    assert_eq!(
        std::fs::read(b.root.join("assets").join(name)).unwrap(),
        bytes
    );
    b.doc["sessions"][0]["draft"] = json!("B edit");
    b.sync(&http).await?;
    a.sync(&http).await?;
    assert_eq!(a.doc["sessions"][0]["draft"], "B edit");
    a.doc["sessions"][0]["draft"] = json!("A concurrent");
    b.doc["sessions"][0]["draft"] = json!("B concurrent");
    a.sync(&http).await?;
    b.sync(&http).await?;
    assert_eq!(b.state.conflicts.len(), 1);
    assert_eq!(b.doc["sessions"][0]["draft"], "B concurrent");
    b.state.conflicts.clear();
    b.sync(&http).await?;
    a.sync(&http).await?;
    assert_eq!(a.doc["sessions"][0]["draft"], "B concurrent");
    for key in ["workspaces", "sessions", "assets"] {
        a.doc[key] = json!([]);
    }
    a.sync(&http).await?;
    b.sync(&http).await?;
    assert!(studio_sync::project(&b.doc).is_empty());
    println!("PASS: two device tokens, 3 MiB SHA-256 transfer, bidirectional edit, conflict resolution, tombstones; cursor={}",b.state.cursor);
    Ok(())
}
