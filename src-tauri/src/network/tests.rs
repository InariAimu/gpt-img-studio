use super::*;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    thread,
};

fn settings(mode: Mode, proxy_url: &str) -> Settings {
    Settings {
        mode,
        proxy_url: proxy_url.into(),
    }
}
fn run(future: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future);
}
fn client(settings: &Settings) -> Client {
    settings
        .client(Duration::from_secs(5), Duration::from_secs(5))
        .unwrap()
}
fn listener() -> TcpListener {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    listener
}
fn accept(listener: TcpListener) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                return stream;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline, "No connection arrived");
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("{error}"),
        }
    }
}
fn headers(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 8192);
    }
    String::from_utf8(bytes).unwrap()
}
fn http_server(listener: TcpListener, status: &str) -> thread::JoinHandle<String> {
    let status = status.to_owned();
    thread::spawn(move || {
        let mut stream = accept(listener);
        let request = headers(&mut stream);
        write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
        )
        .unwrap();
        request
    })
}

#[test]
fn http_proxy_and_https_connect_do_not_fallback_on_failure() {
    run(async {
        for (url, first_line) in [
            (
                "http://network-fixture.invalid/catalog",
                "GET http://network-fixture.invalid/catalog HTTP/1.1",
            ),
            (
                "https://network-fixture.invalid/catalog",
                "CONNECT network-fixture.invalid:443 HTTP/1.1",
            ),
        ] {
            let proxy = listener();
            let config = settings(
                Mode::Manual,
                &format!("http://{}", proxy.local_addr().unwrap()),
            );
            let server = http_server(proxy, "502 Bad Gateway");
            let response = client(&config).get(url).send().await;
            if url.starts_with("https") {
                assert!(response.is_err());
            } else {
                assert_eq!(response.unwrap().status(), 502);
            }
            assert!(server.join().unwrap().starts_with(first_line));
        }
        // The origin is reachable, but an unavailable explicit proxy must fail closed.
        let origin = listener();
        let port = origin.local_addr().unwrap().port();
        let proxy = listener();
        let config = settings(
            Mode::Manual,
            &format!("http://{}", proxy.local_addr().unwrap()),
        );
        drop(proxy);
        let http = config
            .builder()
            .unwrap()
            .resolve("network-fixture.invalid", origin.local_addr().unwrap())
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        assert!(http
            .get(format!("http://network-fixture.invalid:{port}/"))
            .send()
            .await
            .is_err());
        assert!(origin.accept().is_err());
    });
}

#[test]
fn socks5h_resolves_destination_and_carries_request() {
    run(async {
        let proxy = listener();
        let config = settings(
            Mode::Manual,
            &format!("socks5h://{}", proxy.local_addr().unwrap()),
        );
        let server = thread::spawn(move || {
            let mut stream = accept(proxy);
            let mut greeting = [0; 2];
            stream.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting[0], 5);
            let mut methods = vec![0; greeting[1] as usize];
            stream.read_exact(&mut methods).unwrap();
            assert!(methods.contains(&0));
            stream.write_all(&[5, 0]).unwrap();
            let mut request = [0; 5];
            stream.read_exact(&mut request).unwrap();
            assert_eq!(&request[..4], &[5, 1, 0, 3]);
            let mut host = vec![0; request[4] as usize];
            stream.read_exact(&mut host).unwrap();
            assert_eq!(host, b"network-fixture.invalid");
            let mut port = [0; 2];
            stream.read_exact(&mut port).unwrap();
            assert_eq!(u16::from_be_bytes(port), 80);
            stream
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
                .unwrap();
            let request = headers(&mut stream);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
            request
        });
        assert_eq!(
            client(&config)
                .get("http://network-fixture.invalid/catalog")
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "ok"
        );
        assert!(server.join().unwrap().starts_with("GET /catalog HTTP/1.1"));
    });
}

#[test]
fn loopback_bypasses_manual_proxy_and_direct_ignores_proxy() {
    run(async {
        for mode in [Mode::Manual, Mode::Direct] {
            let proxy = listener();
            let config = settings(mode, &format!("http://{}", proxy.local_addr().unwrap()));
            let origin = listener();
            let url = format!("http://{}/local", origin.local_addr().unwrap());
            let server = http_server(origin, "200 OK");
            assert_eq!(
                client(&config)
                    .get(&url)
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "ok"
            );
            assert!(server.join().unwrap().starts_with("GET /local HTTP/1.1"));
            assert!(proxy.accept().is_err());
            for target in [
                &url,
                "http://localhost/",
                "http://[::1]/",
                "http://127.2.3.4/",
            ] {
                assert_eq!(config.route(target).unwrap(), None);
            }
        }
    });
}

#[test]
fn settings_persist_and_invalid_updates_leave_saved_config_intact() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../output/network-migration/test-data")
        .join(crate::store::id());
    let store = crate::store::Store::open(root.clone()).unwrap();
    let mut app_settings = store.read().unwrap()["settings"].clone();
    assert_eq!(
        Settings::from_settings(&app_settings).unwrap().mode,
        Mode::System
    );
    crate::providers::migrate(&mut app_settings).unwrap();
    app_settings["network"] = json!({"mode":"manual", "proxyUrl":" http://127.0.0.1:7890 "});
    normalize(&mut app_settings).unwrap();
    assert_eq!(
        app_settings["network"]["proxyUrl"],
        "http://127.0.0.1:7890/"
    );
    store
        .change(|doc| {
            doc["settings"] = app_settings.clone();
            Ok(())
        })
        .unwrap();
    for url in [
        "",
        "127.0.0.1:7890",
        "ftp://localhost",
        "http://user:secret@localhost",
        "http://localhost/path",
        "http://localhost/?secret=yes",
        "http://localhost/#frag",
        "http://local\nhost",
    ] {
        let result = store.change(|doc| {
            doc["settings"]["network"]["proxyUrl"] = json!(url);
            normalize(&mut doc["settings"])
        });
        assert!(!result.unwrap_err().contains("secret"));
        assert_eq!(store.read().unwrap()["settings"], app_settings);
    }
    for scheme in ["http", "https", "socks5", "socks5h"] {
        settings(Mode::Manual, &format!("{scheme}://[::1]:1080"))
            .validate()
            .unwrap();
    }
    for mode in [Mode::System, Mode::Direct] {
        let mut config = settings(mode, "http://user:secret@unfinished/");
        config.validate().unwrap();
        assert!(config.proxy_url.is_empty());
    }
    drop(store);
    let reopened = crate::store::Store::open(root).unwrap();
    assert_eq!(reopened.read().unwrap()["settings"], app_settings);
    let state = view(&app_settings).unwrap();
    assert!(state["routes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["proxy"] == "http://127.0.0.1:7890/"));
    app_settings["network"]["mode"] = json!("direct");
    app_settings["providers"][0]["baseUrl"] = json!("not-a-url");
    assert_eq!(view(&app_settings).unwrap()["routes"][0]["invalid"], true);
    // Kept under output for the task's recoverable cleanup, never in the real library.
}

#[test]
fn system_environment_and_direct_mode_in_isolated_process() {
    let proxy = listener();
    let address = format!("http://{}", proxy.local_addr().unwrap());
    let server = http_server(proxy, "200 OK");
    let mut child = Command::new(std::env::current_exe().unwrap());
    child.args([
        "--exact",
        "network::tests::environment_proxy_child",
        "--ignored",
    ]);
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] {
        child.env_remove(key).env_remove(key.to_ascii_lowercase());
    }
    child
        .env(
            "HTTP_PROXY",
            address.replace("http://", "http://user:secret@"),
        )
        .env("HTTPS_PROXY", &address)
        .env("NO_PROXY", LOOPBACK)
        .env("STUDIO_TEST_PROXY", &address);
    let output = child.output().unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(server
        .join()
        .unwrap()
        .starts_with("GET http://network-fixture.invalid/catalog HTTP/1.1"));
}

#[test]
#[ignore = "Spawned with isolated environment by system_environment_and_direct_mode_in_isolated_process"]
fn environment_proxy_child() {
    run(async {
        let address = std::env::var("STUDIO_TEST_PROXY").unwrap();
        let config = Settings::default();
        let target = "http://network-fixture.invalid/catalog";
        assert_eq!(config.route(target).unwrap(), Some(format!("{address}/")));
        assert_eq!(
            client(&config)
                .get(target)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "ok"
        );
        assert_eq!(config.route("http://127.0.0.1/").unwrap(), None);
        let direct = settings(Mode::Direct, "");
        assert_eq!(direct.route(target).unwrap(), None);
        let origin = listener();
        let address = origin.local_addr().unwrap();
        let url = format!("http://network-fixture.invalid:{}/local", address.port());
        let server = http_server(origin, "200 OK");
        let http = direct
            .builder()
            .unwrap()
            .resolve("network-fixture.invalid", address)
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        assert_eq!(http.get(url).send().await.unwrap().status(), 200);
        server.join().unwrap();
    });
}
