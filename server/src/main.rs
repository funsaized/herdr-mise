use std::{net::SocketAddr, time::Duration};

use herdr_mise_server::{discovery, feed::Feed, service};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let shutdown = CancellationToken::new();
    let feed = Feed::start(
        discovery::discover_socket(),
        Duration::from_secs(2),
        shutdown.clone(),
    )
    .await;
    let extra_origins = match std::env::var("HERDR_MISE_EXTRA_ORIGINS") {
        Ok(value) => service::parse_extra_origins(&value)
            .map_err(|error| format!("HERDR_MISE_EXTRA_ORIGINS: {error}"))?,
        Err(_) => Vec::new(),
    };
    if !extra_origins.is_empty() {
        eprintln!(
            "herdr-mise: /ws additionally accepts browser origins: {}",
            extra_origins.join(", ")
        );
    }
    let app = service::router_with_extra_origins(feed, extra_origins);
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 8686))).await?;
    eprintln!("herdr-mise listening on http://127.0.0.1:8686");
    let signal = shutdown.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            signal.cancel();
        })
        .await?;
    Ok(())
}
