use std::net::SocketAddr;

use herdr_mise_server::{
    feed::Feed,
    protocol::{AgentRecord, AgentState, AppMode, SessionStats},
    runtime::{parse_mode, Mode},
    tui::{state::AgentTable, BindWarning},
};

#[test]
fn arguments_preserve_default_and_accept_only_tui() {
    assert_eq!(parse_mode(Vec::<String>::new()).unwrap(), Mode::Http);
    assert_eq!(parse_mode(["--tui".to_string()]).unwrap(), Mode::Tui);
    assert!(parse_mode(["--unknown".to_string()]).is_err());
    assert!(parse_mode(["--tui".to_string(), "extra".to_string()]).is_err());
}

#[test]
fn bind_conflict_becomes_one_tui_warning() {
    let address = SocketAddr::from(([127, 0, 0, 1], 8686));
    let mut warning = BindWarning::default();
    let conflict = || std::io::Error::new(std::io::ErrorKind::AddrInUse, "address in use");
    assert!(herdr_mise_server::runtime::downgrade_tui_bind::<()>(
        Err(conflict()),
        address,
        &mut warning
    )
    .is_none());
    assert!(warning.message().unwrap().contains(&address.to_string()));
    let first = warning.message().unwrap().to_string();
    let _ = herdr_mise_server::runtime::downgrade_tui_bind::<()>(
        Err(conflict()),
        address,
        &mut warning,
    );
    assert_eq!(warning.message(), Some(first.as_str()));
}

#[tokio::test]
async fn fixed_feed_snapshot_applies_through_real_reducer() {
    let active = AgentRecord {
        state_known: None,
        id: "fixed-a".into(),
        name: "Fixed A".into(),
        state: AgentState::Blocked,
        progress: None,
        state_entered_at: "2026-08-13T12:00:00Z".into(),
        accent_index: 1,
        model: "codex".into(),
        workspace: "/work/fixed".into(),
        session: SessionStats {
            tickets_available: None,
            runtime_ms: 60_000,
            tickets: 2,
        },
    };
    let mut ended = active.clone();
    ended.state = AgentState::Ended;
    ended.session.runtime_ms = 90_000;
    ended.session.tickets = 3;
    let feed = Feed::fixed(AppMode::Live, vec![active]).await;
    let mut receiver = feed.subscribe();
    let mut table = AgentTable::default();
    table.apply(feed.snapshot().await);
    assert_eq!(table.mode(), AppMode::Live);
    assert_eq!(table.agents().count(), 1);
    feed.publish(ended).await;
    table.apply(receiver.recv().await.unwrap());
    assert_eq!(table.agents().count(), 0);
    assert_eq!(table.board().len(), 1);
    assert_eq!(table.board()[0].id, "fixed-a");
    assert_eq!(table.board()[0].final_state, AgentState::Blocked);
    assert_eq!(table.board()[0].runtime_ms, 90_000);
    assert_eq!(table.board()[0].tickets, 3);
}

#[test]
fn loopback_address_is_stable() {
    assert_eq!(
        herdr_mise_server::runtime::HTTP_ADDRESS,
        SocketAddr::from(([127, 0, 0, 1], 8686))
    );
}

#[tokio::test]
async fn finished_http_task_error_is_still_consumed() {
    let task = tokio::spawn(async {
        Err::<(), std::io::Error>(std::io::Error::other("late server failure"))
    });
    tokio::task::yield_now().await;
    let error = herdr_mise_server::runtime::finish_http_task(task)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("late server failure"));
}

#[tokio::test]
async fn clean_cancelled_http_task_is_successful() {
    let task = tokio::spawn(async { Ok::<(), std::io::Error>(()) });
    herdr_mise_server::runtime::finish_http_task(task)
        .await
        .unwrap();
}
