use std::{env::VarError, net::SocketAddr};

use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::{feed::Feed, service, tui::BindWarning};

pub const HTTP_ADDRESS: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 8686);

pub fn parse_http_port(value: Option<&str>) -> Result<u16, String> {
    let Some(value) = value else {
        return Ok(HTTP_ADDRESS.port());
    };
    let value = value.trim();
    let port = value
        .parse::<u16>()
        .map_err(|_| "HERDR_MISE_PORT: expected an integer from 1024 to 65535".to_string())?;
    if port < 1024 {
        return Err("HERDR_MISE_PORT: expected an integer from 1024 to 65535".to_string());
    }
    Ok(port)
}

pub fn parse_http_port_env(value: Result<String, VarError>) -> Result<u16, String> {
    match value {
        Ok(value) => parse_http_port(Some(&value)),
        Err(VarError::NotPresent) => parse_http_port(None),
        Err(VarError::NotUnicode(_)) => {
            Err("HERDR_MISE_PORT: value must be valid Unicode".to_string())
        }
    }
}

pub fn http_address(port: u16) -> SocketAddr {
    SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Http,
    Tui,
}

pub fn parse_mode(args: impl IntoIterator<Item = String>) -> Result<Mode, String> {
    let args = args.into_iter().collect::<Vec<_>>();
    match args.as_slice() {
        [] => Ok(Mode::Http),
        [flag] if flag == "--tui" => Ok(Mode::Tui),
        _ => Err(format!(
            "usage: herdr-mise [--tui] (unexpected arguments: {})",
            args.join(" ")
        )),
    }
}

pub async fn bind_for_tui(address: SocketAddr, warning: &mut BindWarning) -> Option<TcpListener> {
    downgrade_tui_bind(TcpListener::bind(address).await, address, warning)
}

pub fn downgrade_tui_bind<T>(
    result: Result<T, std::io::Error>,
    address: SocketAddr,
    warning: &mut BindWarning,
) -> Option<T> {
    match result {
        Ok(listener) => Some(listener),
        Err(error) => {
            warning.set_once(format!("HTTP unavailable at {address}: {error}"));
            None
        }
    }
}

pub async fn serve_http(
    listener: TcpListener,
    feed: Feed,
    extra_origins: Vec<String>,
    shutdown: CancellationToken,
) -> Result<(), std::io::Error> {
    let port = listener.local_addr()?.port();
    axum::serve(
        listener,
        service::router_with_extra_origins(feed, port, extra_origins),
    )
    .with_graceful_shutdown(shutdown.cancelled_owned())
    .await
}

pub async fn finish_http_task(
    task: tokio::task::JoinHandle<Result<(), std::io::Error>>,
) -> Result<(), std::io::Error> {
    match task.await {
        Ok(result) => result,
        Err(error) => Err(std::io::Error::other(format!("HTTP task failed: {error}"))),
    }
}
