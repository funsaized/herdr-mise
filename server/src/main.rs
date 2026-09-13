use std::time::Duration;

use herdr_mise_server::{
    adapter::{self, Normalizer},
    discovery,
    feed::Feed,
    protocol::SourceStatus,
    runtime::{self, Command, Mode},
    service, tui,
};
use tokio_util::sync::CancellationToken;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    match runtime::parse_command(std::env::args().skip(1))? {
        Command::Help => println!("{}", runtime::HELP),
        Command::Version => println!("herdr-mise {}", env!("CARGO_PKG_VERSION")),
        Command::Diagnostic => tokio::runtime::Runtime::new()?.block_on(diagnostic())?,
        Command::Run(mode) => tokio::runtime::Runtime::new()?.block_on(run(mode))?,
    }
    Ok(())
}

async fn diagnostic() -> Result<(), Box<dyn std::error::Error>> {
    let port = runtime::parse_http_port_env(std::env::var("HERDR_MISE_PORT"))?;
    let status =
        match adapter::fetch_snapshot(&discovery::discover_socket(), Duration::from_secs(2))
            .await
            .and_then(|snapshot| {
                Normalizer::default()
                    .normalize_snapshot_value(snapshot, &chrono::Utc::now().to_rfc3339())
            }) {
            Ok(_) => SourceStatus::Connected,
            Err(error) => error.source_status(),
        };
    let protocols = adapter::supported_protocols()
        .into_iter()
        .map(|protocol| protocol.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let status = serde_json::to_string(&status)?;

    println!("version={}", env!("CARGO_PKG_VERSION"));
    println!("supported_protocols={protocols}");
    println!("source_status={}", status.trim_matches('"'));
    println!("http_address=http://{}", runtime::http_address(port));
    Ok(())
}

async fn run(mode: Mode) -> Result<(), Box<dyn std::error::Error>> {
    let http_address = runtime::http_address(runtime::parse_http_port_env(std::env::var(
        "HERDR_MISE_PORT",
    ))?);
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

    match mode {
        Mode::Http => {
            let listener = tokio::net::TcpListener::bind(http_address).await?;
            eprintln!("herdr-mise listening on http://{}", listener.local_addr()?);
            let signal = shutdown.clone();
            tokio::spawn(async move {
                let _ = tokio::signal::ctrl_c().await;
                signal.cancel();
            });
            runtime::serve_http(listener, feed, extra_origins, shutdown).await?;
        }
        Mode::Tui => {
            let mut warning = tui::BindWarning::default();
            let mut http =
                runtime::bind_for_tui(http_address, &mut warning)
                    .await
                    .map(|listener| {
                        eprintln!(
                            "herdr-mise listening on http://{}",
                            listener
                                .local_addr()
                                .expect("bound listener has a local address")
                        );
                        let shutdown = shutdown.clone();
                        let feed = feed.clone();
                        tokio::spawn(runtime::serve_http(listener, feed, extra_origins, shutdown))
                    });
            let (tui_result, http_was_consumed) = if let Some(task) = http.as_mut() {
                tokio::select! {
                    result = tui::run(feed, shutdown.clone(), warning) => (result, false),
                    result = &mut *task => {
                        let result = match result {
                            Ok(Ok(())) => Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "HTTP server stopped before TUI shutdown")),
                            Ok(Err(error)) => Err(error),
                            Err(error) => Err(std::io::Error::other(format!("HTTP task failed: {error}"))),
                        };
                        (result, true)
                    },
                }
            } else {
                (tui::run(feed, shutdown.clone(), warning).await, false)
            };
            shutdown.cancel();
            let http_result = if !http_was_consumed {
                if let Some(task) = http {
                    runtime::finish_http_task(task).await
                } else {
                    Ok(())
                }
            } else {
                Ok(())
            };
            match (tui_result, http_result) {
                (Ok(()), Ok(())) => {}
                (Err(error), Ok(())) | (Ok(()), Err(error)) => return Err(error.into()),
                (Err(tui_error), Err(http_error)) => {
                    return Err(std::io::Error::other(format!(
                        "TUI failed: {tui_error}; HTTP failed: {http_error}"
                    ))
                    .into());
                }
            }
        }
    }
    Ok(())
}
