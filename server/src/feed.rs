use chrono::{SecondsFormat, Utc};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{broadcast, watch, Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::{
    adapter::{self, Normalizer},
    demo,
    protocol::{
        AgentRecord, AgentStateEvent, AppMode, DeltaOperation, SourceDiagnostic, SourceStatus,
        PROTOCOL_VERSION,
    },
};

#[derive(Clone)]
pub struct Feed {
    inner: Arc<Inner>,
}
struct Inner {
    state: RwLock<FeedState>,
    pending: Mutex<HashMap<String, AgentRecord>>,
    changes: broadcast::Sender<AgentStateEvent>,
    health: watch::Sender<bool>,
}

struct FeedState {
    mode: AppMode,
    source_status: SourceStatus,
    source_diagnostic: Option<SourceDiagnostic>,
    agents: HashMap<String, AgentRecord>,
}

impl Feed {
    pub async fn start(
        path: PathBuf,
        probe_timeout: Duration,
        shutdown: CancellationToken,
    ) -> Self {
        let (changes, _) = broadcast::channel(256);
        let (health, _) = watch::channel(true);
        let inner = Arc::new(Inner {
            state: RwLock::new(FeedState {
                mode: AppMode::Demo,
                source_status: SourceStatus::UnavailableSocket,
                source_diagnostic: None,
                agents: HashMap::new(),
            }),
            pending: Mutex::new(HashMap::new()),
            changes,
            health,
        });
        let feed = Self { inner };
        tokio::spawn(run_coalescer(feed.clone()));
        let started_at = Utc::now();
        feed.replace_demo(demo::agents(0, started_at)).await;
        tokio::spawn(run_startup_recovery(
            feed.clone(),
            path,
            probe_timeout,
            shutdown,
            started_at,
        ));
        feed
    }

    pub async fn fixed(mode: AppMode, agents: Vec<AgentRecord>) -> Self {
        let (changes, _) = broadcast::channel(256);
        let (health, _) = watch::channel(true);
        let feed = Self {
            inner: Arc::new(Inner {
                state: RwLock::new(FeedState {
                    source_status: if mode == AppMode::Live {
                        SourceStatus::Connected
                    } else {
                        SourceStatus::UnavailableSocket
                    },
                    source_diagnostic: None,
                    mode,
                    agents: HashMap::new(),
                }),
                pending: Mutex::new(HashMap::new()),
                changes,
                health,
            }),
        };
        feed.replace(agents).await;
        tokio::spawn(run_coalescer(feed.clone()));
        feed
    }
    pub fn subscribe(&self) -> broadcast::Receiver<AgentStateEvent> {
        self.inner.changes.subscribe()
    }
    pub fn subscribe_health(&self) -> watch::Receiver<bool> {
        self.inner.health.subscribe()
    }
    pub async fn snapshot(&self) -> AgentStateEvent {
        let state = self.inner.state.read().await;
        let mut agents = state.agents.values().cloned().collect::<Vec<_>>();
        agents.sort_by(|a, b| a.id.cmp(&b.id));
        AgentStateEvent::Snapshot {
            version: PROTOCOL_VERSION,
            mode: state.mode.clone(),
            source_status: state.source_status.clone(),
            source_diagnostic: state.source_diagnostic.clone(),
            agents,
        }
    }
    pub async fn publish(&self, agent: AgentRecord) {
        self.reconcile(vec![agent], false).await;
    }
    pub async fn publish_high_frequency(&self, agent: AgentRecord) {
        self.inner
            .pending
            .lock()
            .await
            .insert(agent.id.clone(), agent);
    }

    async fn replace(&self, agents: Vec<AgentRecord>) {
        self.reconcile(agents, true).await;
    }
    #[cfg(test)]
    async fn apply_live(&self, agents: Vec<AgentRecord>, ended_ids: Vec<String>) {
        self.reconcile(agents, false).await;
        self.end_ids(ended_ids).await;
    }
    async fn transition_to_live(&self, agents: Vec<AgentRecord>) {
        self.inner.pending.lock().await.clear();
        {
            let mut state = self.inner.state.write().await;
            state.mode = AppMode::Live;
            state.source_status = SourceStatus::Connected;
            state.source_diagnostic = None;
            state.agents = agents
                .into_iter()
                .map(|agent| (agent.id.clone(), agent))
                .collect();
            let mut agents = state.agents.values().cloned().collect::<Vec<_>>();
            agents.sort_by(|a, b| a.id.cmp(&b.id));
            let event = AgentStateEvent::Snapshot {
                version: PROTOCOL_VERSION,
                mode: AppMode::Live,
                source_status: SourceStatus::Connected,
                source_diagnostic: None,
                agents,
            };
            let _ = self.inner.changes.send(event);
        }
    }
    async fn set_demo_error(&self, error: &adapter::AdapterError) {
        let source_status = error.source_status();
        let source_diagnostic = error.source_diagnostic();
        {
            let mut state = self.inner.state.write().await;
            if state.mode != AppMode::Demo
                || (state.source_status == source_status
                    && state.source_diagnostic == source_diagnostic)
            {
                return;
            }
            state.source_status = source_status.clone();
            state.source_diagnostic = source_diagnostic.clone();
            let mut agents = state.agents.values().cloned().collect::<Vec<_>>();
            agents.sort_by(|a, b| a.id.cmp(&b.id));
            let event = AgentStateEvent::Snapshot {
                version: PROTOCOL_VERSION,
                mode: AppMode::Demo,
                source_status,
                source_diagnostic,
                agents,
            };
            let _ = self.inner.changes.send(event);
        }
    }
    async fn apply_live_coalesced(&self, agents: Vec<AgentRecord>, ended_ids: Vec<String>) {
        {
            let mut pending = self.inner.pending.lock().await;
            for agent in agents {
                pending.insert(agent.id.clone(), agent);
            }
        }
        self.end_ids(ended_ids).await;
    }
    async fn end_ids(&self, ended_ids: Vec<String>) {
        let mut pending = self.inner.pending.lock().await;
        let mut state = self.inner.state.write().await;
        let mode = state.mode.clone();
        let stamp = now();
        for id in ended_ids {
            pending.remove(&id);
            let Some(mut agent) = state.agents.remove(&id) else {
                continue;
            };
            agent.state = crate::protocol::AgentState::Ended;
            agent.state_entered_at = stamp.clone();
            agent.progress = None;
            let _ = self.inner.changes.send(AgentStateEvent::Delta {
                version: PROTOCOL_VERSION,
                mode: mode.clone(),
                operation: DeltaOperation::Upsert,
                agent: Some(agent),
                agent_id: None,
            });
        }
    }
    async fn replace_demo(&self, agents: Vec<AgentRecord>) {
        let (ended, active): (Vec<_>, Vec<_>) = agents
            .into_iter()
            .partition(|agent| agent.state == crate::protocol::AgentState::Ended);
        if !ended.is_empty() {
            let mut state = self.inner.state.write().await;
            let mode = state.mode.clone();
            for agent in ended {
                if state.agents.remove(&agent.id).is_some() {
                    let _ = self.inner.changes.send(AgentStateEvent::Delta {
                        version: PROTOCOL_VERSION,
                        mode: mode.clone(),
                        operation: DeltaOperation::Upsert,
                        agent: Some(agent),
                        agent_id: None,
                    });
                }
            }
        }
        self.reconcile(active, true).await;
    }
    async fn reconcile(&self, incoming: Vec<AgentRecord>, authoritative: bool) {
        let mut state = self.inner.state.write().await;
        let mode = state.mode.clone();
        let incoming_ids = incoming
            .iter()
            .map(|a| a.id.clone())
            .collect::<std::collections::HashSet<_>>();
        for agent in incoming {
            if state.agents.get(&agent.id) != Some(&agent) {
                state.agents.insert(agent.id.clone(), agent.clone());
                let _ = self.inner.changes.send(AgentStateEvent::Delta {
                    version: PROTOCOL_VERSION,
                    mode: mode.clone(),
                    operation: DeltaOperation::Upsert,
                    agent: Some(agent),
                    agent_id: None,
                });
            }
        }
        if authoritative {
            let removed = state
                .agents
                .keys()
                .filter(|id| !incoming_ids.contains(*id))
                .cloned()
                .collect::<Vec<_>>();
            for id in removed {
                state.agents.remove(&id);
                let _ = self.inner.changes.send(AgentStateEvent::Delta {
                    version: PROTOCOL_VERSION,
                    mode: mode.clone(),
                    operation: DeltaOperation::Remove,
                    agent: None,
                    agent_id: Some(id),
                });
            }
        }
    }
}

const RETRY_INITIAL: Duration = Duration::from_millis(250);
const RETRY_MAX: Duration = Duration::from_secs(4);

async fn run_startup_recovery(
    feed: Feed,
    path: PathBuf,
    probe_timeout: Duration,
    shutdown: CancellationToken,
    started_at: chrono::DateTime<Utc>,
) {
    let mut normalizer = Normalizer::default();
    let mut step = 1;
    let mut backoff = RETRY_INITIAL;
    let mut demo_tick = tokio::time::interval(Duration::from_secs(1));
    demo_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    demo_tick.tick().await;
    loop {
        let attempt = adapter::fetch_snapshot(&path, probe_timeout);
        let result = tokio::select! {
            _ = shutdown.cancelled() => return,
            result = attempt => result.and_then(|raw| normalizer.normalize_snapshot_value(raw, &now())),
        };
        match result {
            Ok(snapshot) => {
                feed.transition_to_live(snapshot.agents).await;
                tokio::spawn(run_live(feed, path, normalizer, shutdown));
                return;
            }
            Err(error) => feed.set_demo_error(&error).await,
        }
        let delay = tokio::time::sleep(backoff);
        tokio::pin!(delay);
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return,
                _ = &mut delay => break,
                _ = demo_tick.tick() => {
                    feed.replace_demo(demo::agents(step, started_at)).await;
                    step += 1;
                }
            }
        }
        backoff = std::cmp::min(backoff.saturating_mul(2), RETRY_MAX);
    }
}

async fn run_coalescer(feed: Feed) {
    // Progress-like sources are intentionally stricter than the four-Hz ceiling so a
    // full twelve-record roster remains beneath the steady wire budget.
    let mut interval = tokio::time::interval(Duration::from_millis(1_250));
    interval.tick().await;
    loop {
        interval.tick().await;
        let pending = {
            let mut pending = feed.inner.pending.lock().await;
            pending.drain().map(|(_, agent)| agent).collect::<Vec<_>>()
        };
        if !pending.is_empty() {
            feed.reconcile(pending, false).await;
        }
    }
}

async fn run_live(
    feed: Feed,
    path: PathBuf,
    mut normalizer: Normalizer,
    shutdown: CancellationToken,
) {
    let (wake_tx, mut wake_rx) = tokio::sync::mpsc::channel(16);
    tokio::spawn(watch_events(path.clone(), wake_tx, shutdown.clone()));
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    let mut failures = 0_u8;
    let mut reconnecting = false;
    loop {
        tokio::select! { _=shutdown.cancelled()=>break, _=interval.tick()=>{}, event=wake_rx.recv()=>if event.is_none(){break} }
        let result = tokio::select! {
            _ = shutdown.cancelled() => return,
            result = adapter::fetch_snapshot(&path, Duration::from_secs(2)) => {
                result.and_then(|raw| normalizer.normalize_snapshot_value(raw, &now()))
            }
        };
        match result {
            Ok(snapshot) => {
                failures = 0;
                if reconnecting {
                    feed.transition_to_live(snapshot.agents).await;
                    reconnecting = false;
                } else {
                    // Event wakes can burst; all production snapshot upserts therefore use
                    // the same bounded coalescer exercised by the wire-rate tests. Ended
                    // transitions remain immediate so their final record is never lost.
                    feed.apply_live_coalesced(snapshot.agents, snapshot.ended_ids)
                        .await;
                }
                if !*feed.inner.health.borrow() {
                    // send() fails without storing when every receiver is gone,
                    // and all receivers live in already-closed connection
                    // handlers at this point; send_replace stores regardless.
                    feed.inner.health.send_replace(true);
                }
            }
            Err(_) => {
                failures = failures.saturating_add(1);
                if failures >= 3 && *feed.inner.health.borrow() {
                    reconnecting = true;
                    feed.inner.health.send_replace(false);
                }
            }
        }
    }
}

async fn watch_events(
    path: PathBuf,
    wake: tokio::sync::mpsc::Sender<()>,
    shutdown: CancellationToken,
) {
    loop {
        if shutdown.is_cancelled() {
            break;
        }
        match adapter::subscribe_events(&path, Duration::from_secs(2)).await {
            Ok(mut events) => loop {
                tokio::select! {
                    _=shutdown.cancelled()=>return,
                    event=events.next(Duration::from_secs(30))=>match event {
                        Ok(value)=>{ let _=adapter::decode_event(value); if wake.send(()).await.is_err(){return} },
                        Err(adapter::AdapterError::Timeout)=>continue,
                        Err(_)=>break,
                    }
                }
            },
            Err(_) => tokio::select! {
                _ = shutdown.cancelled() => return,
                _ = tokio::time::sleep(Duration::from_millis(500)) => {},
            },
        }
    }
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        adapter::{decode_event, AdapterEvent},
        protocol::{AgentState, SessionStats},
        tui::state::AgentTable,
    };
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::UnixListener,
    };

    fn record(progress: f64) -> AgentRecord {
        AgentRecord {
            id: "a".into(),
            name: "A".into(),
            state: AgentState::Working,
            progress: Some(progress),
            state_entered_at: "2026-07-31T00:00:00Z".into(),
            accent_index: 0,
            model: "".into(),
            workspace: "".into(),
            session: SessionStats {
                runtime_ms: 0,
                tickets: 0,
            },
        }
    }

    fn serve_snapshots(listener: UnixListener) -> tokio::task::JoinHandle<()> {
        serve_snapshot_response(
            listener,
            include_bytes!("../tests/fixtures/snapshot-working.json"),
        )
    }

    fn serve_snapshot_response(
        listener: UnixListener,
        response: &'static [u8],
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut stream = BufReader::new(stream);
                    let mut request = String::new();
                    stream.read_line(&mut request).await.unwrap();
                    stream.get_mut().write_all(response).await.unwrap();
                    stream.get_mut().write_all(b"\n").await.unwrap();
                });
            }
        })
    }

    async fn wait_for_source_status(feed: &Feed, expected: SourceStatus) {
        loop {
            if matches!(
                feed.snapshot().await,
                AgentStateEvent::Snapshot { source_status, .. } if source_status == expected
            ) {
                return;
            }
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn unsupported_snapshot_exposes_safe_actionable_diagnostic() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("unsupported.sock");
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind stub socket: {error}"),
        };
        const UNSUPPORTED: &[u8] = br#"{"version":"9.9.9","protocol":23,"workspaces":[],"tabs":[],"panes":[],"layouts":[],"agents":[]}"#;
        let server = serve_snapshot_response(listener, UNSUPPORTED);
        let shutdown = CancellationToken::new();
        let feed = Feed::start(path, Duration::from_secs(1), shutdown.clone()).await;
        wait_for_source_status(&feed, SourceStatus::UnsupportedProtocol).await;
        match feed.snapshot().await {
            AgentStateEvent::Snapshot {
                source_status: SourceStatus::UnsupportedProtocol,
                source_diagnostic: Some(diagnostic),
                ..
            } => {
                assert_eq!(diagnostic.observed_protocol, 23);
                assert_eq!(diagnostic.supported_protocols, vec![17, 19, 20]);
                assert!(diagnostic.next_action.contains("retry"));
            }
            event => panic!("missing unsupported diagnostic: {event:?}"),
        }
        shutdown.cancel();
        server.abort();
    }

    #[tokio::test]
    async fn fifty_hz_source_is_coalesced_to_four_hz() {
        let feed = Feed::fixed(AppMode::Live, vec![record(0.0)]).await;
        let mut changes = feed.subscribe();
        let started = std::time::Instant::now();
        for i in 1..=50 {
            feed.publish_high_frequency(record(i as f64 / 50.0)).await;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut count = 0;
        while changes.try_recv().is_ok() {
            count += 1;
        }
        eprintln!(
            "50 Hz source produced {count} deltas in {:.3}s",
            started.elapsed().as_secs_f64()
        );
        assert!(count <= 2, "observed {count} deltas in about one second");
        assert!(count >= 1, "coalescer stopped publishing");
    }

    #[tokio::test]
    async fn authoritative_disappearance_is_broadcast_once_then_evicted() {
        let feed = Feed::fixed(AppMode::Live, vec![record(0.0)]).await;
        let mut changes = feed.subscribe();
        feed.apply_live(vec![], vec!["a".into()]).await;
        assert!(
            matches!(changes.try_recv().unwrap(),AgentStateEvent::Delta{agent:Some(agent),..} if agent.state==AgentState::Ended)
        );
        for _reconnect in 0..3 {
            assert!(
                matches!(feed.snapshot().await,AgentStateEvent::Snapshot{agents,..} if agents.is_empty())
            );
        }
        feed.apply_live(vec![], vec!["a".into()]).await;
        assert!(changes.try_recv().is_err(), "ended must not repeat");
        assert!(
            matches!(feed.snapshot().await,AgentStateEvent::Snapshot{agents,..} if agents.is_empty())
        );
    }

    #[tokio::test]
    async fn freezer_board_membership_from_disappearance_snapshots() {
        let mut normalizer = Normalizer::default();
        let first = normalizer
            .normalize_snapshot_value(
                serde_json::from_str(include_str!("../tests/fixtures/snapshot-working.json"))
                    .unwrap(),
                "2026-08-13T12:00:00Z",
            )
            .unwrap();
        let second = normalizer
            .normalize_snapshot_value(
                serde_json::from_str(include_str!(
                    "../tests/fixtures/snapshot-protocol-19-empty-agents.json"
                ))
                .unwrap(),
                "2026-08-13T12:01:00Z",
            )
            .unwrap();
        assert_eq!(second.ended_ids, ["p-1"]);

        let feed = Feed::fixed(AppMode::Live, vec![]).await;
        let mut changes = feed.subscribe();
        let mut table = AgentTable::default();
        feed.apply_live(first.agents, first.ended_ids).await;
        table.apply(changes.recv().await.unwrap());
        feed.apply_live(second.agents, second.ended_ids).await;
        table.apply(changes.recv().await.unwrap());
        assert_eq!(
            table
                .board()
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["p-1"]
        );
        assert!(table.agents().all(|agent| agent.id != "p-1"));
        let freezer = crate::tui::scene::tests::render_freezer(&table, 80, 24);
        let freezer_text = crate::tui::scene::tests::text(&freezer);
        assert!(freezer_text.contains("WALK-IN FREEZER"));
        assert!(freezer_text.contains("CODEX"));

        let before = table.board().to_vec();
        let exited = decode_event(
            serde_json::from_str(include_str!("../tests/fixtures/event-pane-exited.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            exited,
            AdapterEvent::Exited {
                pane_id: "p-1".into()
            }
        );
        assert_eq!(table.board(), before);
    }

    #[tokio::test]
    async fn twelve_record_chatty_source_stays_below_wire_budget() {
        let initial = (0..12)
            .map(|i| {
                let mut a = record(0.0);
                a.id = format!("a-{i}");
                a
            })
            .collect();
        let feed = Feed::fixed(AppMode::Live, initial).await;
        let mut changes = feed.subscribe();
        let started = std::time::Instant::now();
        for tick in 1..=50 {
            for i in 0..12 {
                let mut a = record(tick as f64 / 50.0);
                a.id = format!("a-{i}");
                feed.publish_high_frequency(a).await;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut bytes = 0;
        while let Ok(event) = changes.try_recv() {
            bytes += websocket_frame_bytes(serde_json::to_vec(&event).unwrap().len());
        }
        let heartbeat_bytes = websocket_frame_bytes(
            serde_json::to_vec(&AgentStateEvent::Heartbeat {
                version: PROTOCOL_VERSION,
            })
            .unwrap()
            .len(),
        );
        let bytes_per_second =
            bytes as f64 / started.elapsed().as_secs_f64() + heartbeat_bytes as f64;
        eprintln!("twelve-record wire rate: {bytes_per_second:.1} bytes/s");
        assert!(
            bytes_per_second <= 5_000.0,
            "observed {bytes_per_second:.1} bytes/s"
        );
    }

    fn websocket_frame_bytes(payload: usize) -> usize {
        payload
            + if payload <= 125 {
                2
            } else if payload <= u16::MAX as usize {
                4
            } else {
                10
            }
    }

    #[tokio::test]
    async fn production_live_updates_flow_through_coalescer() {
        let feed = Feed::fixed(AppMode::Live, vec![record(0.0)]).await;
        let mut changes = feed.subscribe();
        feed.apply_live_coalesced(vec![record(0.9)], vec![]).await;
        assert!(
            changes.try_recv().is_err(),
            "production update published directly"
        );
        tokio::time::timeout(Duration::from_millis(1_500), changes.recv())
            .await
            .expect("coalescer deadline")
            .expect("coalesced update");
    }

    #[tokio::test]
    async fn health_recovers_after_all_subscribers_dropped() {
        // Regression for E2E-1: every health receiver lives inside a WebSocket
        // connection handler, and all of them are dropped when health goes
        // false. Recovery must still store `true` for the next subscriber.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("feed.sock");
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind stub socket: {error}"),
        };
        let server = serve_snapshots(listener);
        let shutdown = CancellationToken::new();
        let feed = Feed::start(path.clone(), Duration::from_secs(1), shutdown.clone()).await;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if matches!(
                    feed.snapshot().await,
                    AgentStateEvent::Snapshot {
                        mode: AppMode::Live,
                        source_status: SourceStatus::Connected,
                        agents,
                        ..
                    } if agents.len() == 1
                ) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("initial connected snapshot");
        {
            let mut health = feed.subscribe_health();
            server.abort();
            std::fs::remove_file(&path).unwrap();
            tokio::time::timeout(Duration::from_secs(6), async {
                loop {
                    health.changed().await.unwrap();
                    if !*health.borrow() {
                        break;
                    }
                }
            })
            .await
            .expect("source loss surfaced");
        } // last receiver dropped, like the closed WebSocket handlers
        let restored = serve_snapshots(UnixListener::bind(&path).unwrap());
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                if *feed.subscribe_health().borrow() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("health must recover with no live subscribers");
        shutdown.cancel();
        restored.abort();
    }

    #[tokio::test]
    async fn stub_socket_selects_live_mode() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("feed.sock");
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind stub socket: {error}"),
        };
        let server = serve_snapshots(listener);
        let shutdown = CancellationToken::new();
        let feed = Feed::start(path.clone(), Duration::from_secs(1), shutdown.clone()).await;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if matches!(feed.snapshot().await,AgentStateEvent::Snapshot{mode:AppMode::Live,agents,..} if agents.len()==1) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("startup snapshot");
        let mut health = feed.subscribe_health();
        server.abort();
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                health.changed().await.unwrap();
                if !*health.borrow() {
                    break;
                }
            }
        })
        .await
        .expect("source loss surfaced");
        std::fs::remove_file(&path).unwrap();
        const RESTORED: &[u8] = br#"{"result":{"snapshot":{"version":"0.7.5","protocol":17,"workspaces":[],"tabs":[],"panes":[],"layouts":[],"agents":[{"pane_id":"p-restored","agent_status":"idle"}]}}}"#;
        let restored = serve_snapshot_response(UnixListener::bind(&path).unwrap(), RESTORED);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                health.changed().await.unwrap();
                if *health.borrow() {
                    break;
                }
            }
        })
        .await
        .expect("source reconnected");
        assert!(
            matches!(feed.snapshot().await,AgentStateEvent::Snapshot{mode:AppMode::Live,agents,..} if agents.len()==1 && agents[0].id == "p-restored")
        );
        shutdown.cancel();
        restored.abort();
    }

    #[tokio::test]
    async fn missing_source_then_live_source_replaces_demo_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("late.sock");
        let shutdown = CancellationToken::new();
        let feed = Feed::start(path.clone(), Duration::from_millis(100), shutdown.clone()).await;
        assert!(matches!(
            feed.snapshot().await,
            AgentStateEvent::Snapshot {
                mode: AppMode::Demo,
                source_status: SourceStatus::UnavailableSocket,
                agents,
                ..
            } if !agents.is_empty()
        ));
        let mut changes = feed.subscribe();
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind stub socket: {error}"),
        };
        let server = serve_snapshots(listener);
        let transition = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let AgentStateEvent::Snapshot {
                    mode: AppMode::Live,
                    source_status: SourceStatus::Connected,
                    agents,
                    ..
                } = changes.recv().await.unwrap()
                {
                    break agents;
                }
            }
        })
        .await
        .expect("same feed recovers without restart");
        assert_eq!(transition.len(), 1);
        assert_eq!(transition[0].id, "p-1");
        assert!(matches!(
            feed.snapshot().await,
            AgentStateEvent::Snapshot { mode: AppMode::Live, source_status: SourceStatus::Connected, agents, .. }
                if agents.len() == 1 && agents[0].id == "p-1"
        ));
        shutdown.cancel();
        server.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn startup_retry_uses_exponential_backoff_and_stops_on_shutdown() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("malformed.sock");
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind stub socket: {error}"),
        };
        let (attempt_tx, mut attempt_rx) = tokio::sync::mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let mut attempt = 0;
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                attempt += 1;
                let response: &[u8] = if attempt % 2 == 0 {
                    b"{\"version\":\"0.7.5\",\"protocol\":999,\"workspaces\":[],\"tabs\":[],\"layouts\":[],\"agents\":[]}\n"
                } else {
                    b"not-json\n"
                };
                stream.write_all(response).await.unwrap();
                attempt_tx.send(attempt).unwrap();
            }
        });
        let shutdown = CancellationToken::new();
        let feed = Feed::start(path, Duration::from_secs(2), shutdown.clone()).await;
        assert_eq!(attempt_rx.recv().await, Some(1));
        wait_for_source_status(&feed, SourceStatus::IncompatibleResponse).await;
        tokio::time::advance(Duration::from_millis(249)).await;
        assert!(matches!(
            attempt_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        tokio::time::advance(Duration::from_millis(1)).await;
        assert_eq!(attempt_rx.recv().await, Some(2));
        wait_for_source_status(&feed, SourceStatus::UnsupportedProtocol).await;
        tokio::time::advance(Duration::from_millis(499)).await;
        assert!(matches!(
            attempt_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        tokio::time::advance(Duration::from_millis(1)).await;
        assert_eq!(attempt_rx.recv().await, Some(3));
        wait_for_source_status(&feed, SourceStatus::IncompatibleResponse).await;
        for (delay, expected) in [
            (Duration::from_secs(1), 4),
            (Duration::from_secs(2), 5),
            (Duration::from_secs(4), 6),
            (Duration::from_secs(4), 7),
        ] {
            tokio::time::advance(delay).await;
            assert_eq!(attempt_rx.recv().await, Some(expected));
            let status = if expected % 2 == 0 {
                SourceStatus::UnsupportedProtocol
            } else {
                SourceStatus::IncompatibleResponse
            };
            wait_for_source_status(&feed, status).await;
        }
        shutdown.cancel();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(30)).await;
        tokio::task::yield_now().await;
        assert!(matches!(
            attempt_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        server.abort();
    }
}
