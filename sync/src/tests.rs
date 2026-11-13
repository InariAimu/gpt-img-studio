use super::*;

fn session(prompt: &str) -> Value {
    json!({"id":"session-one","workspaceId":"workspace-one","title":"创作","draft":prompt,"referenceIds":[]})
}
fn document(prompt: &str) -> Value {
    json!({"schemaVersion":1,"revision":0,"installationId":"private-device","settings":{"network":{"proxyUrl":"local-only"},"providers":[],"theme":"dark"},"workspaces":[{"id":"workspace-one","name":"同步验证"}],"sessions":[session(prompt)],"assets":[],"presets":[],"jobs":[]})
}
fn record(prompt: &str, rev: u64) -> Record {
    Record {
        key: "sessions/session-one".into(),
        revision: rev,
        value: Some(session(prompt)),
    }
}
#[test]
fn local_settings_and_credentials_do_not_enter_projection() {
    let mut doc = document("hello");
    doc["usage_events"] = json!([{"secret":"usage"}]);
    doc["settings"]["apiKey"] = json!("do-not-upload");
    doc["settings"]["providers"] = json!([{"id":"p","name":"p","kind":"custom","baseUrl":"https://example.com/v1","models":[],"apiKey":"provider-secret-do-not-upload"}]);
    let p = project(&doc);
    let text = serde_json::to_string(&p).unwrap();
    assert!(!text.contains("do-not-upload"));
    assert!(!text.contains("local-only"));
    assert!(!text.contains("private-device"));
    doc["settings"]["providers"][0]
        .as_object_mut()
        .unwrap()
        .remove("apiKey");
    let before = doc["settings"].clone();
    apply(&mut doc, &p);
    assert_eq!(doc["settings"], before);
}
#[test]
fn concurrent_edit_and_inflight_edits_are_not_silently_overwritten() {
    let r = record("initial", 1);
    let mut state = ClientState::default();
    state.baseline.insert(r.key.clone(), r);
    let local = project(&document("local"));
    let sent = mutations(&local, &state);
    let (merged, conflicted) = reconcile(&local, state.clone(), &sent, &[], &[record("remote", 2)]);
    assert_eq!(merged["sessions/session-one"]["draft"], "local");
    assert_eq!(conflicted.conflicts.len(), 1);
    assert!(mutations(&merged, &conflicted)
        .iter()
        .all(|m| m.key != "sessions/session-one"));
    let (merged, state) = reconcile(
        &project(&document("typed while uploading")),
        state,
        &sent,
        &[record("local", 2)],
        &[record("local", 2)],
    );
    assert_eq!(
        merged["sessions/session-one"]["draft"],
        "typed while uploading"
    );
    assert!(state.conflicts.is_empty());
    assert_eq!(
        mutations(&merged, &state)
            .iter()
            .find(|m| m.key == "sessions/session-one")
            .unwrap()
            .base_revision,
        2
    );
}
#[test]
fn deleted_dependency_is_preserved_until_explicit_resolution() {
    let previous = project(&document("unsynced edit"));
    let mut merged = previous.clone();
    merged.remove("workspaces/workspace-one");
    let mut state = ClientState::default();
    protect_references(&mut merged, &previous, &mut state).unwrap();
    assert!(merged.contains_key("workspaces/workspace-one"));
    assert_eq!(state.conflicts.len(), 1);
}
#[test]
fn rejects_unsafe_paths_and_public_plain_http() {
    for p in [
        "assets/../secret",
        "assets/foo.png",
        "assets/../../a.png",
        "C:/secret",
    ] {
        assert!(blob_name(p).is_err());
    }
    for u in [
        "http://example.com",
        "https://user:secret@example.com",
        "https://example.com?token=secret",
    ] {
        assert!(client::normalize_url(u).is_err());
    }
    assert!(client::normalize_url("http://192.168.0.10:8080").is_ok());
    assert_eq!(
        client::normalize_url("https://example.com/studio-sync/").unwrap(),
        "https://example.com/studio-sync"
    );
}

#[cfg(feature = "server")]
mod http {
    use super::*;
    use std::path::PathBuf;
    struct Fixture {
        root: PathBuf,
        url: String,
        task: tokio::task::JoinHandle<()>,
        client: reqwest::Client,
        token: String,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Fixture {
        async fn new() -> Self {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../output/sketch-library-20261111/sync-tests")
                .join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir_all(&root).unwrap();
            let token = "a-synthetic-test-token-with-at-least-32-characters".to_string();
            std::fs::write(
                root.join("devices.json"),
                json!({"test-pc":hash(token.as_bytes())}).to_string(),
            )
            .unwrap();
            let service =
                server::Service::open(root.join("server"), root.join("devices.json")).unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                axum::serve(listener, server::router(service))
                    .await
                    .unwrap();
            });
            Self {
                root,
                url,
                task,
                client: reqwest::Client::builder().no_proxy().build().unwrap(),
                token,
            }
        }
        async fn sync(
            &self,
            name: &str,
            doc: &mut Value,
            state: &mut ClientState,
        ) -> Result<client::Exchange> {
            let root = self.root.join(name);
            std::fs::create_dir_all(root.join("assets")).unwrap();
            let e = client::exchange(
                &self.client,
                &self.url,
                &self.token,
                "test-pc",
                &root,
                &project(doc),
                state,
            )
            .await?;
            let previous = project(doc);
            let (mut entities, mut next) =
                reconcile(&previous, state.clone(), &e.sent, &e.accepted, &e.remote);
            preserve_sketch_conflicts(&mut entities, &mut next);
            protect_references(&mut entities, &previous, &mut next)?;
            apply(doc, &entities);
            next.cursor = e.cursor;
            next.server_id = e.server_id.clone();
            *state = next;
            Ok(e)
        }
    }
    #[tokio::test]
    async fn sketch_files_pose_library_and_deletion_restore_round_trip() {
        let f=Fixture::new().await;let mut a=document("initial");let mut b=document("initial");
        let (mut sa,mut sb)=(ClientState::default(),ClientState::default());
        let bytes=vec![b' ';2*1024*1024];let json_path=format!("assets/{}.json",hash(&bytes));let png_path=format!("assets/{}.png",hash(b"synthetic-png"));
        std::fs::create_dir_all(f.root.join("a/assets")).unwrap();std::fs::write(f.root.join("a").join(&json_path),&bytes).unwrap();std::fs::write(f.root.join("a").join(&png_path),b"synthetic-png").unwrap();
        a["sketches"]=json!([{"id":"s1","revision":"r1","name":"驾驶构图","width":1536,"height":1024,"documentPath":json_path,"previewPath":png_path,"previewRevision":json_path}]);
        a["sketchLibraries"]=json!([{"id":"shared","savedPoses":[],"favoritePoses":["driving"]}]);
        assert_eq!(f.sync("a",&mut a,&mut sa).await.unwrap().uploaded,2);
        assert_eq!(f.sync("b",&mut b,&mut sb).await.unwrap().downloaded,2);
        assert_eq!(std::fs::read(f.root.join("b").join(&json_path)).unwrap(),bytes);assert_eq!(b["sketchLibraries"],a["sketchLibraries"]);
        b["sketches"][0]["trashedAt"]=json!("now");b["sketches"][0]["revision"]=json!("r2");f.sync("b",&mut b,&mut sb).await.unwrap();f.sync("a",&mut a,&mut sa).await.unwrap();assert_eq!(a["sketches"][0]["trashedAt"],"now");
        a["sketches"][0].as_object_mut().unwrap().remove("trashedAt");a["sketches"][0]["revision"]=json!("r3");f.sync("a",&mut a,&mut sa).await.unwrap();f.sync("b",&mut b,&mut sb).await.unwrap();assert!(b["sketches"][0]["trashedAt"].is_null());assert!(f.root.join("b").join(png_path).is_file());
    }
    #[tokio::test]
    async fn two_clients_blobs_retry_conflict_resolution_and_tombstones() {
        let f = Fixture::new().await;
        let mut a = document("initial");
        let mut b = document("initial");
        let (mut sa, mut sb) = (ClientState::default(), ClientState::default());
        let bytes = b"synthetic-image-bytes";
        let name = format!("{}.png", hash(bytes));
        std::fs::create_dir_all(f.root.join("a/assets")).unwrap();
        std::fs::write(f.root.join("a/assets").join(&name), bytes).unwrap();
        a["assets"] = json!([{"id":"picture-one","path":format!("assets/{name}"),"sessionId":"session-one","workspaceId":"workspace-one","referenceIds":[],"demo":false}]);
        let snapshot = a.clone();
        let first = f.sync("a", &mut a, &mut sa).await.unwrap();
        assert_eq!(first.uploaded, 1);
        // Simulate loss of the ACK: same persistent local state retries without another revision.
        let retry = client::exchange(
            &f.client,
            &f.url,
            &f.token,
            "test-pc",
            &f.root.join("a"),
            &project(&snapshot),
            &ClientState::default(),
        )
        .await
        .unwrap();
        assert_eq!(retry.uploaded, 0);
        assert_eq!(retry.cursor, sa.cursor);
        f.sync("b", &mut b, &mut sb).await.unwrap();
        assert_eq!(b["assets"][0]["id"], "picture-one");
        assert_eq!(
            std::fs::read(f.root.join("b/assets").join(&name)).unwrap(),
            bytes
        );
        a["sessions"][0]["draft"] = json!("from A");
        b["sessions"][0]["draft"] = json!("from B");
        f.sync("a", &mut a, &mut sa).await.unwrap();
        f.sync("b", &mut b, &mut sb).await.unwrap();
        assert_eq!(sb.conflicts.len(), 1);
        assert_eq!(b["sessions"][0]["draft"], "from B");
        assert_eq!(
            sb.conflicts["sessions/session-one"]
                .remote
                .as_ref()
                .unwrap()["draft"],
            "from A"
        );
        sb.conflicts.clear();
        f.sync("b", &mut b, &mut sb).await.unwrap();
        f.sync("a", &mut a, &mut sa).await.unwrap();
        assert_eq!(a["sessions"][0]["draft"], "from B");
        a["sessions"] = json!([]);
        a["assets"] = json!([]);
        f.sync("a", &mut a, &mut sa).await.unwrap();
        f.sync("b", &mut b, &mut sb).await.unwrap();
        assert_eq!(b["sessions"], json!([]));
        assert_eq!(b["assets"], json!([]));
        assert!(f.root.join("server/blobs").join(name).is_file());
        // Baselines survive serialization/restart and do not resurrect deleted entities.
        let persisted: ClientState =
            serde_json::from_slice(&serde_json::to_vec(&sb).unwrap()).unwrap();
        assert!(mutations(&project(&b), &persisted).is_empty());
    }
    #[tokio::test]
    async fn authentication_hash_missing_blob_and_epoch_are_enforced() {
        let f = Fixture::new().await;
        let unauth = f
            .client
            .get(format!("{}/v1/changes", f.url))
            .send()
            .await
            .unwrap();
        assert_eq!(unauth.status(), 401);
        let bad = f
            .client
            .put(format!("{}/v1/blobs/{}.png", f.url, "0".repeat(64)))
            .bearer_auth(&f.token)
            .body("wrong hash")
            .send()
            .await
            .unwrap();
        assert_eq!(bad.status(), 400);
        assert_eq!(
            std::fs::read_dir(f.root.join("server/staging"))
                .unwrap()
                .count(),
            0
        );
        let health: Value = f
            .client
            .get(format!("{}/health", f.url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let request = Push {
            protocol: 1,
            server_id: health["serverId"].as_str().unwrap().into(),
            device_id: "wrong-device".into(),
            mutations: vec![],
        };
        assert_eq!(
            f.client
                .post(format!("{}/v1/push", f.url))
                .bearer_auth(&f.token)
                .json(&request)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        let missing = Push {
            device_id: "test-pc".into(),
            mutations: vec![Mutation {
                key: "assets/missing".into(),
                base_revision: 0,
                value: Some(json!({"id":"missing","path":format!("assets/{}.png","1".repeat(64))})),
            }],
            ..request
        };
        assert_eq!(
            f.client
                .post(format!("{}/v1/push", f.url))
                .bearer_auth(&f.token)
                .json(&missing)
                .send()
                .await
                .unwrap()
                .status(),
            409
        );
        let mut state = ClientState::default();
        state.server_id = "different-server".into();
        let mut doc = document("safe");
        let before = doc.clone();
        assert!(f.sync("a", &mut doc, &mut state).await.is_err());
        assert_eq!(doc, before);
        f.task.abort();
        let state = ClientState::default();
        assert!(f.sync("a", &mut doc, &mut state.clone()).await.is_err());
        assert!(!mutations(&project(&doc), &state).is_empty());
    }
    #[tokio::test]
    async fn concurrent_parent_delete_preserves_other_devices_new_child() {
        let f = Fixture::new().await;
        let mut a = document("initial");
        let mut b = a.clone();
        let (mut sa, mut sb) = (ClientState::default(), ClientState::default());
        f.sync("a", &mut a, &mut sa).await.unwrap();
        f.sync("b", &mut b, &mut sb).await.unwrap();
        a["sessions"] = json!([]);
        a["workspaces"] = json!([]);
        f.sync("a", &mut a, &mut sa).await.unwrap();
        b["sessions"][0]["draft"] = json!("offline work");
        f.sync("b", &mut b, &mut sb).await.unwrap();
        assert_eq!(b["sessions"][0]["draft"], "offline work");
        assert_eq!(b["workspaces"][0]["id"], "workspace-one");
        assert!(sb.conflicts.contains_key("workspaces/workspace-one"));
        assert!(sb.conflicts.contains_key("sessions/session-one"));
        sb.conflicts.clear();
        f.sync("b", &mut b, &mut sb).await.unwrap();
        f.sync("a", &mut a, &mut sa).await.unwrap();
        assert_eq!(a["sessions"][0]["draft"], "offline work");
    }
    #[tokio::test]
    async fn paginated_initial_sync() {
        let f = Fixture::new().await;
        let mut a = document("initial");
        let mut b = document("initial");
        let (mut sa, mut sb) = (ClientState::default(), ClientState::default());
        for n in 0..240 {
            a["sessions"].as_array_mut().unwrap().push(
                json!({"id":format!("extra-{n}"),"workspaceId":"workspace-one","draft":"data"}),
            );
        }
        f.sync("a", &mut a, &mut sa).await.unwrap();
        f.sync("b", &mut b, &mut sb).await.unwrap();
        assert_eq!(b["sessions"].as_array().unwrap().len(), 241);
        assert_eq!(sb.cursor, sa.cursor);
    }
    #[tokio::test]
    async fn corrupt_download_does_not_commit_and_can_retry() {
        let f = Fixture::new().await;
        let mut a = document("safe");
        let mut b = document("safe");
        let (mut sa, mut sb) = (ClientState::default(), ClientState::default());
        let bytes = b"verified-original";
        let name = format!("{}.png", hash(bytes));
        std::fs::create_dir_all(f.root.join("a/assets")).unwrap();
        std::fs::write(f.root.join("a/assets").join(&name), bytes).unwrap();
        a["assets"] = json!([{"id":"original","path":format!("assets/{name}")}]);
        f.sync("a", &mut a, &mut sa).await.unwrap();
        std::fs::write(f.root.join("server/blobs").join(&name), b"corrupt").unwrap();
        let before = b.clone();
        let persisted = serde_json::to_string(&sb).unwrap();
        assert!(f.sync("b", &mut b, &mut sb).await.is_err());
        assert_eq!(b, before);
        assert_eq!(serde_json::to_string(&sb).unwrap(), persisted);
        assert_eq!(
            std::fs::read_dir(f.root.join("b/assets")).unwrap().count(),
            0
        );
        std::fs::write(f.root.join("server/blobs").join(&name), bytes).unwrap();
        f.sync("b", &mut b, &mut sb).await.unwrap();
        assert_eq!(
            std::fs::read(f.root.join("b/assets").join(&name)).unwrap(),
            bytes
        );
    }
}

#[test]
fn sketch_sync_transfers_both_files_and_preserves_concurrent_edits() {
    let make=|tag:&str| json!({"id":"sketch-a","name":"构图","revision":tag,"documentPath":format!("assets/{}.json",hash(tag.as_bytes())),"previewPath":format!("assets/{}.png",hash(b"png")),"width":1536,"height":1024,"favorite":false});
    let base=make("base"); let local=make("local"); let remote=make("remote");
    validate_entity("sketches/sketch-a",&Some(local.clone())).unwrap();
    assert_eq!(blob_names("sketches/sketch-a",&local).unwrap().len(),2);
    assert!(validate_entity("assets/a",&Some(json!({"id":"a","path":local["documentPath"]}))).is_err());
    let mut state=ClientState::default();state.baseline.insert("sketches/sketch-a".into(),Record{key:"sketches/sketch-a".into(),revision:1,value:Some(base)});
    let mut entities=Entities::new();entities.insert("sketches/sketch-a".into(),local.clone());
    let (mut merged,mut state)=reconcile(&entities,state,&[],&[],&[Record{key:"sketches/sketch-a".into(),revision:2,value:Some(remote.clone())}]);
    preserve_sketch_conflicts(&mut merged,&mut state);
    assert!(state.conflicts.is_empty());assert_eq!(merged["sketches/sketch-a"],remote);
    assert!(merged.values().any(|v|v["documentPath"]==local["documentPath"]&&v["name"].as_str().unwrap().contains("冲突副本")));
    assert_eq!(mutations(&merged,&state).len(),1);
    let mut doc=document("");apply(&mut doc,&merged);assert_eq!(doc["sketches"].as_array().unwrap().len(),2);
}
