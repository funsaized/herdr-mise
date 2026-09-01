use crate::feed::Feed;
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use std::{borrow::Cow, sync::Arc, time::Duration};

use crate::protocol::{AgentStateEvent, PROTOCOL_VERSION};

#[derive(RustEmbed)]
#[folder = "$OUT_DIR/embedded-dist/"]
struct Assets;

#[cfg(test)]
const EMBEDDED_ASSET_MODE: &str = env!("HERDR_MISE_ASSET_MODE");

struct ServiceState {
    feed: Arc<Feed>,
    port: u16,
    extra_origins: Vec<String>,
}

pub fn router(feed: Feed, port: u16) -> Router {
    router_with_extra_origins(feed, port, Vec::new())
}

pub fn router_with_extra_origins(feed: Feed, port: u16, extra_origins: Vec<String>) -> Router {
    Router::new()
        .route("/ws", get(ws))
        .fallback(get(static_asset))
        .with_state(Arc::new(ServiceState {
            feed: Arc::new(feed),
            port,
            extra_origins,
        }))
}

/// Parses `HERDR_MISE_EXTRA_ORIGINS`: a comma-separated list of exact
/// browser origins (scheme://host[:port], no path, no wildcard). Any
/// invalid entry is a hard error so a widened origin policy is never
/// silently misconfigured.
pub fn parse_extra_origins(value: &str) -> Result<Vec<String>, String> {
    let mut origins = Vec::new();
    for entry in value.split(',') {
        let origin = entry.trim();
        if origin.is_empty() {
            continue;
        }
        let host = origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"))
            .ok_or_else(|| format!("origin {origin:?} must start with http:// or https://"))?;
        if host.is_empty()
            || host.contains('/')
            || host.contains('*')
            || host.chars().any(char::is_whitespace)
        {
            return Err(format!(
                "origin {origin:?} must be an exact scheme://host[:port] with no path or wildcard"
            ));
        }
        origins.push(origin.to_string());
    }
    Ok(origins)
}

async fn ws(
    State(state): State<Arc<ServiceState>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !allowed_origin(&headers, state.port, &state.extra_origins) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let feed = state.feed.clone();
    upgrade
        .on_upgrade(move |socket| client(socket, feed))
        .into_response()
}
fn allowed_origin(headers: &HeaderMap, port: u16, extra_origins: &[String]) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    origin == format!("http://localhost:{port}")
        || origin == format!("http://127.0.0.1:{port}")
        || extra_origins.iter().any(|extra| extra == origin)
}
async fn client(socket: WebSocket, feed: Arc<Feed>) {
    let mut changes = feed.subscribe();
    let mut health = feed.subscribe_health();
    let (mut output, mut input) = socket.split();
    if !*health.borrow() {
        let _ = output.send(Message::Close(None)).await;
        return;
    }
    let Ok(snapshot) = serde_json::to_string(&feed.snapshot().await) else {
        return;
    };
    if output.send(Message::Text(snapshot.into())).await.is_err() {
        return;
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
    heartbeat.tick().await;
    loop {
        tokio::select! {
            changed=health.changed()=>if changed.is_err() || !*health.borrow() { let _=output.send(Message::Close(None)).await; break },
            message=input.next()=>match message { Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break, _=>{} },
            event=changes.recv()=>match event { Ok(event)=> { let Ok(text)=serde_json::to_string(&event) else{continue}; if output.send(Message::Text(text.into())).await.is_err(){break} }, Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=> { let Ok(text)=serde_json::to_string(&feed.snapshot().await) else{continue}; if output.send(Message::Text(text.into())).await.is_err(){break} }, Err(_)=>break },
            _=heartbeat.tick()=> { let event=AgentStateEvent::Heartbeat{version:PROTOCOL_VERSION}; let Ok(text)=serde_json::to_string(&event) else{continue}; if output.send(Message::Text(text.into())).await.is_err(){break} }
        }
    }
}
async fn static_asset(uri: Uri) -> Response {
    let requested = uri.path().trim_start_matches('/');
    let key = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
    let asset = Assets::get(key).or_else(|| {
        if navigation_path(requested) {
            Assets::get("index.html")
        } else {
            None
        }
    });
    match asset {
        Some(file) => {
            let mime = content_type(key);
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .body(Body::from(match file.data {
                    Cow::Borrowed(data) => data.to_vec(),
                    Cow::Owned(data) => data,
                }))
                .unwrap()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
fn navigation_path(path: &str) -> bool {
    path.is_empty()
        || (!path.starts_with("assets/")
            && path
                .rsplit('/')
                .next()
                .is_some_and(|segment| !segment.contains('.')))
}
fn content_type(path: &str) -> &'static str {
    if path.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".ttf") {
        "font/ttf"
    } else if path.ends_with(".txt") {
        "text/plain; charset=utf-8"
    } else {
        "text/html; charset=utf-8"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AgentRecord, AgentState, AgentStateEvent, AppMode, SessionStats};
    use axum::body::to_bytes;
    use std::{ffi::OsString, future::IntoFuture};
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::UnixListener,
    };
    use tokio_util::sync::CancellationToken;
    use tower::ServiceExt;
    #[tokio::test]
    async fn serves_root_and_spa_fallback() {
        let app = router(Feed::fixed(AppMode::Demo, vec![]).await, 8686);
        for path in ["/", "/nested/route"] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert!(body.windows(10).any(|w| w == b"herdr-mise"));
        }
    }

    #[tokio::test]
    async fn missing_assets_do_not_fall_back_to_html() {
        let app = router(Feed::fixed(AppMode::Demo, vec![]).await, 8686);
        for path in [
            "/assets/missing.js",
            "/assets/missing",
            "/missing.css",
            "/favicon.ico",
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[tokio::test]
    async fn embedded_assets_match_selected_mode_and_mime_types() {
        let app = router(Feed::fixed(AppMode::Demo, vec![]).await, 8686);
        let expected = match EMBEDDED_ASSET_MODE {
            "fallback" => vec![
                ("/fonts/instrument-sans-400.ttf", None),
                ("/fonts/OFL-Instrument-Sans.txt", None),
            ],
            "production" => vec![
                ("/fonts/instrument-sans-400.ttf", Some("font/ttf")),
                (
                    "/fonts/OFL-Instrument-Sans.txt",
                    Some("text/plain; charset=utf-8"),
                ),
            ],
            mode => panic!("unexpected embedded asset mode: {mode}"),
        };
        for (path, expected) in expected {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            match expected {
                Some(mime) => {
                    assert_eq!(response.status(), StatusCode::OK, "{path}");
                    assert_eq!(
                        response.headers().get(header::CONTENT_TYPE).unwrap(),
                        mime,
                        "{path}"
                    );
                }
                None => assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}"),
            }
        }
    }

    #[test]
    fn websocket_origin_policy_is_loopback_same_origin_only() {
        for allowed in [
            None,
            Some("http://localhost:8686"),
            Some("http://127.0.0.1:8686"),
        ] {
            let mut headers = HeaderMap::new();
            if let Some(origin) = allowed {
                headers.insert(header::ORIGIN, origin.parse().unwrap());
            }
            assert!(allowed_origin(&headers, 8686, &[]), "{allowed:?}");
        }
        for rejected in [
            "https://localhost:8686",
            "http://localhost",
            "http://evil.test",
            "http://127.0.0.1:8687",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::ORIGIN, rejected.parse().unwrap());
            assert!(!allowed_origin(&headers, 8686, &[]), "{rejected}");
        }
    }

    #[test]
    fn configured_extra_origin_is_accepted_alongside_loopback_defaults() {
        let extra = vec!["https://herdr-mise.example.com".to_string()];
        for allowed in [
            "https://herdr-mise.example.com",
            "http://localhost:8686",
            "http://127.0.0.1:8686",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::ORIGIN, allowed.parse().unwrap());
            assert!(allowed_origin(&headers, 8686, &extra), "{allowed}");
        }
        for rejected in [
            "http://herdr-mise.example.com",
            "https://herdr-mise.example.com:8443",
            "https://evil.test",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::ORIGIN, rejected.parse().unwrap());
            assert!(!allowed_origin(&headers, 8686, &extra), "{rejected}");
        }
    }

    #[test]
    fn extra_origins_parse_exact_values_and_reject_unsafe_shapes() {
        assert_eq!(
            parse_extra_origins(" https://herdr-mise.example.com , http://pi.tailnet:8686 ,")
                .unwrap(),
            vec![
                "https://herdr-mise.example.com".to_string(),
                "http://pi.tailnet:8686".to_string(),
            ]
        );
        assert_eq!(parse_extra_origins("").unwrap(), Vec::<String>::new());
        for invalid in [
            "herdr-mise.example.com",
            "https://herdr-mise.example.com/",
            "https://*.example.com",
            "ws://herdr-mise.example.com",
            "https://",
        ] {
            assert!(parse_extra_origins(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn http_port_configuration_is_fail_closed_and_loopback_only() {
        use crate::runtime::{http_address, parse_http_port, parse_http_port_env, HTTP_ADDRESS};

        assert_eq!(parse_http_port(None).unwrap(), 8686);
        assert_eq!(HTTP_ADDRESS, "127.0.0.1:8686".parse().unwrap());
        assert_eq!(parse_http_port(Some(" 9000 ")).unwrap(), 9000);
        assert_eq!(
            parse_http_port_env(Err(std::env::VarError::NotPresent)).unwrap(),
            8686
        );
        assert!(
            parse_http_port_env(Err(std::env::VarError::NotUnicode(OsString::from(
                "invalid"
            ))))
            .unwrap_err()
            .starts_with("HERDR_MISE_PORT:")
        );
        for invalid in ["", "not-a-port", "0", "80", "65536"] {
            assert!(
                parse_http_port(Some(invalid))
                    .unwrap_err()
                    .starts_with("HERDR_MISE_PORT:"),
                "{invalid:?}"
            );
        }
        assert_eq!(http_address(9000), "127.0.0.1:9000".parse().unwrap());
    }

    #[tokio::test]
    async fn occupied_configured_port_fails_without_fallback() {
        let occupied = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind occupied test port: {error}"),
        };
        let address = occupied.local_addr().unwrap();
        assert_eq!(address.ip(), std::net::Ipv4Addr::LOCALHOST);
        let error = tokio::net::TcpListener::bind(crate::runtime::http_address(address.port()))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
    }

    #[tokio::test]
    async fn serve_http_uses_effective_port_for_assets_and_websocket_origins() {
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind test server: {error}"),
        };
        let address = listener.local_addr().unwrap();
        assert_ne!(address.port(), 8686);
        let expected: AgentStateEvent = serde_json::from_str(
            &std::fs::read_to_string(format!(
                "{}/../protocol/fixtures/snapshot.v1.json",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap(),
        )
        .unwrap();
        let (mode, agents) = match &expected {
            AgentStateEvent::Snapshot { mode, agents, .. } => (mode.clone(), agents.clone()),
            _ => unreachable!(),
        };
        let shutdown = CancellationToken::new();
        let server = tokio::spawn(crate::runtime::serve_http(
            listener,
            Feed::fixed(mode, agents).await,
            vec!["https://mise.example.ts.net".to_string()],
            shutdown.clone(),
        ));

        let root = raw_http_request(address, "/", None).await;
        assert!(root.starts_with("HTTP/1.1 200"), "{root}");
        assert!(root.contains("herdr-mise"));

        for origin in [
            format!("http://127.0.0.1:{}", address.port()),
            format!("http://localhost:{}", address.port()),
            "https://mise.example.ts.net".to_string(),
        ] {
            let (headers, mut socket) = websocket_request(address, &origin).await;
            assert!(headers.starts_with("HTTP/1.1 101"), "{origin}: {headers}");
            let first = read_server_text(&mut socket).await;
            assert_eq!(
                serde_json::from_str::<AgentStateEvent>(&first).unwrap(),
                expected
            );
        }
        for origin in ["http://127.0.0.1:8686", "https://evil.test"] {
            let (headers, _) = websocket_request(address, origin).await;
            assert!(headers.starts_with("HTTP/1.1 403"), "{origin}: {headers}");
        }

        shutdown.cancel();
        server.abort();
    }

    #[tokio::test]
    async fn websocket_endpoint_accepts_configured_extra_origin() {
        let feed = Feed::fixed(AppMode::Demo, vec![]).await;
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind test server: {error}"),
        };
        let address = listener.local_addr().unwrap();
        let app = router_with_extra_origins(
            feed,
            address.port(),
            vec!["https://mise.example.ts.net".to_string()],
        );
        let server = tokio::spawn(axum::serve(listener, app).into_future());
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket.write_all(format!("GET /ws HTTP/1.1\r\nHost: {address}\r\nOrigin: https://mise.example.ts.net\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").as_bytes()).await.unwrap();
        let headers = read_http_headers(&mut socket).await;
        assert!(headers.starts_with("HTTP/1.1 101"), "{headers}");
        server.abort();
    }

    #[tokio::test]
    async fn websocket_endpoint_rejects_foreign_browser_origin() {
        let feed = Feed::fixed(AppMode::Demo, vec![]).await;
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind test server: {error}"),
        };
        let address = listener.local_addr().unwrap();
        let server =
            tokio::spawn(axum::serve(listener, router(feed, address.port())).into_future());
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket.write_all(format!("GET /ws HTTP/1.1\r\nHost: {address}\r\nOrigin: https://evil.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").as_bytes()).await.unwrap();
        let headers = read_http_headers(&mut socket).await;
        assert!(headers.starts_with("HTTP/1.1 403"), "{headers}");
        server.abort();
    }

    #[tokio::test]
    async fn quiet_websocket_receives_typed_heartbeat() {
        let feed = Feed::fixed(AppMode::Demo, vec![]).await;
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind test server: {error}"),
        };
        let address = listener.local_addr().unwrap();
        let server =
            tokio::spawn(axum::serve(listener, router(feed, address.port())).into_future());
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket.write_all(format!("GET /ws HTTP/1.1\r\nHost: {address}\r\nOrigin: http://localhost:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", address.port()).as_bytes()).await.unwrap();
        assert!(read_http_headers(&mut socket)
            .await
            .starts_with("HTTP/1.1 101"));
        let first = read_server_text(&mut socket).await;
        assert!(matches!(
            serde_json::from_str::<AgentStateEvent>(&first).unwrap(),
            AgentStateEvent::Snapshot { .. }
        ));
        let heartbeat =
            tokio::time::timeout(Duration::from_millis(1_200), read_server_text(&mut socket))
                .await
                .expect("heartbeat deadline");
        assert_eq!(
            serde_json::from_str::<AgentStateEvent>(&heartbeat).unwrap(),
            AgentStateEvent::Heartbeat {
                version: PROTOCOL_VERSION
            }
        );
        server.abort();
    }

    #[test]
    fn embeds_assets_for_selected_mode() {
        let files: Vec<_> = Assets::iter().map(|name| name.into_owned()).collect();
        assert!(files.iter().any(|name| name == "index.html"));
        let has_vite_javascript = files
            .iter()
            .any(|name| name.starts_with("assets/") && name.ends_with(".js"));
        match EMBEDDED_ASSET_MODE {
            "fallback" => assert!(
                !has_vite_javascript,
                "fallback assets must not masquerade as a production client: {files:?}"
            ),
            "production" => assert!(
                has_vite_javascript,
                "embedded files must include the Vite production JavaScript: {files:?}"
            ),
            mode => panic!("unexpected embedded asset mode: {mode}"),
        }
        assert!(!files.iter().any(|name| name.contains("node_modules")));
    }

    #[tokio::test]
    async fn websocket_sends_snapshot_before_delta() {
        let feed = Feed::fixed(AppMode::Demo, vec![]).await;
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind test server: {error}"),
        };
        let address = listener.local_addr().unwrap();
        let server =
            tokio::spawn(axum::serve(listener, router(feed.clone(), address.port())).into_future());
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket.write_all(format!("GET /ws HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").as_bytes()).await.unwrap();
        let mut headers = Vec::new();
        let mut byte = [0_u8; 1];
        while !headers.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).await.unwrap();
            headers.push(byte[0]);
        }
        assert!(String::from_utf8(headers)
            .unwrap()
            .starts_with("HTTP/1.1 101"));
        let first = read_server_text(&mut socket).await;
        assert!(matches!(
            serde_json::from_str::<AgentStateEvent>(&first).unwrap(),
            AgentStateEvent::Snapshot { .. }
        ));
        feed.publish(AgentRecord {
            id: "a".into(),
            name: "A".into(),
            state: AgentState::Working,
            progress: Some(0.5),
            state_entered_at: "2026-07-31T00:00:00Z".into(),
            accent_index: 0,
            model: "".into(),
            workspace: "".into(),
            session: SessionStats {
                runtime_ms: 0,
                tickets: 0,
            },
        })
        .await;
        let second = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            read_server_text(&mut socket),
        )
        .await
        .unwrap();
        assert!(matches!(
            serde_json::from_str::<AgentStateEvent>(&second).unwrap(),
            AgentStateEvent::Delta { .. }
        ));
        server.abort();
    }

    #[tokio::test]
    async fn source_loss_and_restore_serves_a_fresh_authoritative_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("herdr.sock");
        let (source_a_shutdown, source_a) =
            start_realistic_herdr_stub(&source_path, "agent-a-live").await;
        let feed_shutdown = CancellationToken::new();
        let feed = Feed::start(
            source_path.clone(),
            Duration::from_millis(250),
            feed_shutdown.clone(),
        )
        .await;
        wait_for_agent(&feed, "agent-a-live").await;

        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind test server: {error}"),
        };
        let address = listener.local_addr().unwrap();
        let server =
            tokio::spawn(axum::serve(listener, router(feed.clone(), address.port())).into_future());
        let mut first_client = connect_websocket(address).await;
        assert_snapshot_agent(&mut first_client, "agent-a-live").await;

        source_a_shutdown.cancel();
        source_a.await.unwrap();
        std::fs::remove_file(&source_path).unwrap();
        tokio::time::timeout(Duration::from_secs(6), async {
            let mut header = [0_u8; 2];
            loop {
                first_client.read_exact(&mut header).await.unwrap();
                if header[0] & 0x0f == 8 {
                    break;
                }
                let length = (header[1] & 0x7f) as usize;
                let mut payload = vec![0; length];
                first_client.read_exact(&mut payload).await.unwrap();
            }
        })
        .await
        .expect("source loss closes the existing websocket");

        let (source_b_shutdown, source_b) =
            start_realistic_herdr_stub(&source_path, "agent-b-live").await;
        wait_for_agent(&feed, "agent-b-live").await;
        let mut fresh_client = connect_websocket(address).await;
        assert_snapshot_agent(&mut fresh_client, "agent-b-live").await;

        feed_shutdown.cancel();
        source_b_shutdown.cancel();
        source_b.await.unwrap();
        server.abort();
    }

    async fn start_realistic_herdr_stub(
        path: &std::path::Path,
        agent_id: &'static str,
    ) -> (CancellationToken, tokio::task::JoinHandle<()>) {
        let listener = UnixListener::bind(path).unwrap();
        let shutdown = CancellationToken::new();
        let task_shutdown = shutdown.clone();
        let task = tokio::spawn(async move {
            loop {
                let stream = tokio::select! {
                    _ = task_shutdown.cancelled() => break,
                    accepted = listener.accept() => accepted.unwrap().0,
                };
                let connection_shutdown = task_shutdown.clone();
                tokio::spawn(async move {
                    let mut stream = BufReader::new(stream);
                    let mut request = String::new();
                    if stream.read_line(&mut request).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let method = serde_json::from_str::<serde_json::Value>(&request)
                        .ok()
                        .and_then(|value| value.get("method")?.as_str().map(str::to_owned));
                    match method.as_deref() {
                        Some("session.snapshot") => {
                            let response = serde_json::json!({
                                "id": "herdr-mise-snapshot",
                                "result": {
                                    "type": "snapshot",
                                    "snapshot": {
                                        "version": "0.7.5",
                                        "protocol": 19,
                                        "workspaces": [],
                                        "tabs": [],
                                        "layouts": [],
                                        "agents": [{
                                            "pane_id": agent_id,
                                            "agent_status": "working"
                                        }]
                                    }
                                }
                            });
                            stream
                                .get_mut()
                                .write_all(format!("{response}\n").as_bytes())
                                .await
                                .unwrap();
                        }
                        Some("events.subscribe") => {
                            stream
                                .get_mut()
                                .write_all(
                                    b"{\"id\":\"herdr-mise-events\",\"result\":{\"type\":\"subscription_started\"}}\n",
                                )
                                .await
                                .unwrap();
                            connection_shutdown.cancelled().await;
                        }
                        _ => {}
                    }
                });
            }
        });
        (shutdown, task)
    }

    async fn wait_for_agent(feed: &Feed, expected: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if matches!(
                    feed.snapshot().await,
                    AgentStateEvent::Snapshot { mode: AppMode::Live, source_status: crate::protocol::SourceStatus::Connected, agents, .. }
                        if agents.len() == 1 && agents[0].id == expected
                ) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("feed did not recover with {expected}"));
    }

    async fn connect_websocket(address: std::net::SocketAddr) -> tokio::net::TcpStream {
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket.write_all(format!("GET /ws HTTP/1.1\r\nHost: {address}\r\nOrigin: http://localhost:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", address.port()).as_bytes()).await.unwrap();
        assert!(read_http_headers(&mut socket)
            .await
            .starts_with("HTTP/1.1 101"));
        socket
    }

    async fn assert_snapshot_agent(socket: &mut tokio::net::TcpStream, expected: &str) {
        let first = read_server_text(socket).await;
        assert!(matches!(
            serde_json::from_str::<AgentStateEvent>(&first).unwrap(),
            AgentStateEvent::Snapshot { mode: AppMode::Live, source_status: crate::protocol::SourceStatus::Connected, agents, .. }
                if agents.len() == 1 && agents[0].id == expected
        ));
    }

    async fn raw_http_request(
        address: std::net::SocketAddr,
        path: &str,
        origin: Option<&str>,
    ) -> String {
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        let origin = origin
            .map(|origin| format!("Origin: {origin}\r\n"))
            .unwrap_or_default();
        socket
            .write_all(
                format!(
                    "GET {path} HTTP/1.1\r\nHost: {address}\r\n{origin}Connection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).await.unwrap();
        response
    }

    async fn websocket_request(
        address: std::net::SocketAddr,
        origin: &str,
    ) -> (String, tokio::net::TcpStream) {
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket.write_all(format!("GET /ws HTTP/1.1\r\nHost: {address}\r\nOrigin: {origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").as_bytes()).await.unwrap();
        (read_http_headers(&mut socket).await, socket)
    }

    async fn read_server_text(stream: &mut tokio::net::TcpStream) -> String {
        let mut head = [0_u8; 2];
        stream.read_exact(&mut head).await.unwrap();
        assert_eq!(head[0] & 0x0f, 1);
        let length = match head[1] & 0x7f {
            n @ 0..=125 => n as usize,
            126 => {
                let mut bytes = [0_u8; 2];
                stream.read_exact(&mut bytes).await.unwrap();
                u16::from_be_bytes(bytes) as usize
            }
            _ => {
                let mut bytes = [0_u8; 8];
                stream.read_exact(&mut bytes).await.unwrap();
                u64::from_be_bytes(bytes) as usize
            }
        };
        let mut payload = vec![0; length];
        stream.read_exact(&mut payload).await.unwrap();
        String::from_utf8(payload).unwrap()
    }

    async fn read_http_headers(stream: &mut tokio::net::TcpStream) -> String {
        let mut headers = Vec::new();
        let mut byte = [0_u8; 1];
        while !headers.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).await.unwrap();
            headers.push(byte[0]);
        }
        String::from_utf8(headers).unwrap()
    }
}
