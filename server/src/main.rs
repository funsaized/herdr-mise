use std::time::Duration;

use herdr_mise_server::{
    discovery,
    feed::Feed,
    runtime::{self, Mode, HTTP_ADDRESS},
    service, tui,
};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mode = runtime::parse_mode(std::env::args().skip(1))?;
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
            let listener = tokio::net::TcpListener::bind(HTTP_ADDRESS).await?;
            eprintln!("herdr-mise listening on http://{HTTP_ADDRESS}");
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
                runtime::bind_for_tui(HTTP_ADDRESS, &mut warning)
                    .await
                    .map(|listener| {
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
