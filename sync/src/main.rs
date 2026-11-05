use std::path::PathBuf;
#[tokio::main]
async fn main() {
    let root = PathBuf::from(std::env::var("STUDIO_SYNC_DATA").unwrap_or_else(|_| "/data".into()));
    let tokens = PathBuf::from(
        std::env::var("STUDIO_SYNC_TOKENS").unwrap_or_else(|_| "/run/secrets/devices.json".into()),
    );
    let service = studio_sync::server::Service::open(root, tokens).expect("open sync storage");
    let bind = std::env::var("STUDIO_SYNC_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .expect("bind sync server");
    println!(
        "Studio Sync listening on {}",
        listener.local_addr().unwrap()
    );
    axum::serve(listener, studio_sync::server::router(service))
        .with_graceful_shutdown(shutdown())
        .await
        .expect("serve sync");
}
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=terminate.recv()=>{} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
