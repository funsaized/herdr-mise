use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use herdr_mise_server::{
    feed::Feed,
    protocol::{AgentRecord, AgentState, AgentStateEvent, AppMode, SessionStats, SourceStatus},
    runtime::{parse_command, Command, Mode},
    tui::{state::AgentTable, BindWarning},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::broadcast,
};
use tokio_util::sync::CancellationToken;

#[test]
fn arguments_preserve_modes_and_accept_one_documented_option() {
    assert_eq!(
        parse_command(Vec::<String>::new()).unwrap(),
        Command::Run(Mode::Http)
    );
    for (argument, expected) in [
        ("--tui", Command::Run(Mode::Tui)),
        ("--help", Command::Help),
        ("-h", Command::Help),
        ("--version", Command::Version),
        ("-V", Command::Version),
        ("--diagnostic", Command::Diagnostic),
    ] {
        assert_eq!(parse_command([argument.to_string()]).unwrap(), expected);
    }
    assert!(parse_command(["--unknown".to_string()]).is_err());
    assert!(parse_command(["--tui".to_string(), "extra".to_string()]).is_err());
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
        pane_id: None,
        agent_kind: None,
        name: "Fixed A".into(),
        state: AgentState::Blocked,
        progress: None,
        state_entered_at: "2026-08-13T12:00:00Z".into(),
        accent_index: 1,
        model: "codex".into(),
        workspace: "/work/fixed".into(),
        workspace_id: None,
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

/// A checked-in Herdr snapshot, then mutated in memory for each observed state.
const HERDR_SNAPSHOT: &str = include_str!("fixtures/snapshot-herdr-0.8.2-p20.json");

fn with_status(base: &serde_json::Value, status: &str) -> serde_json::Value {
    let mut value = base.clone();
    value["agents"][0]["agent_status"] = serde_json::Value::String(status.to_owned());
    value["agents"][0]["state_change_seq"] = serde_json::json!(match status {
        "blocked" => 2,
        "working" => 3,
        "done" => 4,
        _ => 1,
    });
    value
}

/// Serves newline-delimited `session.snapshot` envelopes and an event subscription
/// so the public feed drives live transitions through real socket transport.
struct RecapSource {
    current: Mutex<serde_json::Value>,
    outage: AtomicBool,
    wake: broadcast::Sender<()>,
}

impl RecapSource {
    fn new() -> Self {
        Self {
            current: Mutex::new(serde_json::Value::Null),
            outage: AtomicBool::new(false),
            wake: broadcast::channel(16).0,
        }
    }

    fn publish(&self, snapshot: serde_json::Value) {
        *self.current.lock().unwrap() = snapshot;
    }

    fn current(&self) -> serde_json::Value {
        self.current.lock().unwrap().clone()
    }

    fn set_outage(&self, outage: bool) {
        self.outage.store(outage, Ordering::SeqCst);
    }

    fn notify(&self) {
        let _ = self.wake.send(());
    }
}

async fn serve_recap_source(listener: UnixListener, source: Arc<RecapSource>) {
    while let Ok((stream, _)) = listener.accept().await {
        let source = Arc::clone(&source);
        tokio::spawn(handle_recap_connection(stream, source));
    }
}

async fn handle_recap_connection(stream: UnixStream, source: Arc<RecapSource>) {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut request = String::new();
    if reader.read_line(&mut request).await.unwrap_or(0) == 0 {
        return;
    }
    let request: serde_json::Value =
        serde_json::from_str(&request).unwrap_or(serde_json::Value::Null);
    match request.get("method").and_then(serde_json::Value::as_str) {
        Some("session.snapshot") => {
            let response = if source.outage.load(Ordering::SeqCst) {
                serde_json::json!({"id": "herdr-mise-snapshot", "error": "synthetic outage"})
            } else {
                serde_json::json!({
                    "id": "herdr-mise-snapshot",
                    "result": {"type": "session_snapshot", "snapshot": source.current()}
                })
            };
            let mut frame = response.to_string();
            frame.push('\n');
            let _ = write.write_all(frame.as_bytes()).await;
        }
        Some("events.subscribe") => {
            let _ = write
                .write_all(
                    b"{\"id\":\"herdr-mise-events\",\"result\":{\"type\":\"subscription_started\"}}\n",
                )
                .await;
            let mut wake = source.wake.subscribe();
            while wake.recv().await.is_ok() {
                if write
                    .write_all(b"{\"event\":\"workspace.updated\",\"data\":{}}\n")
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
        _ => {}
    }
}

async fn wait_for_feed(
    feed: &Feed,
    predicate: impl Fn(&AgentStateEvent) -> bool,
) -> AgentStateEvent {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let snapshot = feed.snapshot().await;
            if predicate(&snapshot) {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("feed source transition")
}

async fn wait_for_event(
    events: &mut broadcast::Receiver<AgentStateEvent>,
    predicate: impl Fn(&AgentStateEvent) -> bool,
) -> AgentStateEvent {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match events.recv().await {
                Ok(event) if predicate(&event) => return event,
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => panic!("feed events closed"),
            }
        }
    })
    .await
    .expect("fixture feed event")
}

#[tokio::test]
async fn fixture_feed_service_recap_preserves_observed_waits() {
    let base: serde_json::Value = serde_json::from_str(HERDR_SNAPSHOT).unwrap();
    let blocked = with_status(&base, "blocked");

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("recap-feed.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let source = Arc::new(RecapSource::new());
    let mut initial_working = with_status(&base, "working");
    initial_working["agents"][0]["state_change_seq"] = serde_json::json!(1);
    source.publish(initial_working);
    let server = tokio::spawn(serve_recap_source(listener, Arc::clone(&source)));

    let shutdown = CancellationToken::new();
    let feed = Feed::start(path, Duration::from_secs(1), shutdown.clone()).await;
    wait_for_feed(&feed, |event| {
        matches!(
            event,
            AgentStateEvent::Snapshot {
                mode: AppMode::Live,
                source_status: SourceStatus::Connected,
                agents,
                ..
            } if agents.len() == 1 && agents[0].id == "fictional-terminal-20" && agents[0].state == AgentState::Working
        )
    })
    .await;

    let mut table = AgentTable::default();
    let (mut events, initial) = feed.subscribe_snapshot().await;
    table.apply_at(initial, 1_000);
    source.publish(blocked.clone());
    source.notify();
    let blocked_event = wait_for_event(&mut events, |event| {
        matches!(event, AgentStateEvent::Delta { agent: Some(agent), .. } if agent.state == AgentState::Blocked)
    })
    .await;
    table.apply_at(blocked_event, 3_000);

    source.set_outage(true);
    source.notify();
    let failure = wait_for_event(&mut events, |event| {
        matches!(
            event,
            AgentStateEvent::Snapshot {
                source_status,
                ..
            } if *source_status != SourceStatus::Connected
        )
    })
    .await;
    table.apply_at(failure, 4_000);

    source.set_outage(false);
    source.publish(blocked.clone());
    source.notify();
    let recovery = wait_for_event(&mut events, |event| {
        matches!(
            event,
            AgentStateEvent::Snapshot {
                mode: AppMode::Live,
                source_status: SourceStatus::Connected,
                ..
            }
        )
    })
    .await;
    table.apply_at(recovery, 6_000);

    source.publish(with_status(&base, "working"));
    source.notify();
    let working = wait_for_event(&mut events, |event| {
        matches!(
            event,
            AgentStateEvent::Delta { agent: Some(agent), .. } if agent.state == AgentState::Working
        )
    })
    .await;
    table.apply_at(working, 8_000);

    source.publish(with_status(&base, "done"));
    source.notify();
    let done = wait_for_event(&mut events, |event| {
        matches!(
            event,
            AgentStateEvent::Delta { agent: Some(agent), .. } if agent.state == AgentState::Done
        )
    })
    .await;
    table.apply_at(done, 9_000);

    let mut empty = base.clone();
    empty["agents"] = serde_json::json!([]);
    source.publish(empty);
    source.notify();
    let ended = wait_for_event(&mut events, |event| {
        matches!(
            event,
            AgentStateEvent::Delta { agent: Some(agent), .. } if agent.state == AgentState::Ended
        )
    })
    .await;
    table.apply_at(ended, 10_000);

    let summary = table.recap().summary(None, 10_500);
    assert_eq!(summary.start_ms, Some(1_000));
    assert_eq!(summary.blocked_ms, 2_000);
    assert_eq!(summary.working_ms, 3_000);
    assert_eq!(summary.done_ms, 1_000);
    assert_eq!(summary.median_wait_ms, Some(2_000.0));
    assert_eq!(summary.worst_wait_ms, Some(2_000));
    assert_eq!(
        summary.worst_wait_agent.as_deref(),
        Some("fictional-terminal-20")
    );
    assert_eq!(summary.blocked_occurrences, 1);
    assert_eq!(summary.plated_count, 1);
    assert_eq!(summary.ended_count, 1);
    assert!(summary.partial);
    assert!(summary.interrupted);
    // The unobserved outage interval (3000..6000) is discarded, so the wait is
    // bounded by observed time rather than the wall gap.
    assert!(summary.median_wait_ms.unwrap() < (8_000.0 - 1_000.0));

    shutdown.cancel();
    server.abort();
}
