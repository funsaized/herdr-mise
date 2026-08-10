use chrono::{SecondsFormat, Utc};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{broadcast, watch, Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::{
    adapter::{self, Normalizer},
    demo,
    protocol::{AgentRecord, AgentStateEvent, AppMode, DeltaOperation, PROTOCOL_VERSION},
};

#[derive(Clone)]
pub struct Feed {
    inner: Arc<Inner>,
}
struct Inner {
    mode: RwLock<AppMode>,
    agents: RwLock<HashMap<String, AgentRecord>>,
    pending: Mutex<HashMap<String, AgentRecord>>,
    changes: broadcast::Sender<AgentStateEvent>,
    health: watch::Sender<bool>,
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
            mode: RwLock::new(AppMode::Demo),
            agents: RwLock::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            changes,
            health,
        });
        let feed = Self { inner };
        tokio::spawn(run_coalescer(feed.clone()));
        match adapter::fetch_snapshot(&path, probe_timeout).await {
            Ok(raw) => {
                let mut normalizer = Normalizer::default();
                let stamp = now();
                match normalizer.normalize_snapshot_value(raw, &stamp) {
                    Ok(snapshot) => {
                        *feed.inner.mode.write().await = AppMode::Live;
                        feed.apply_live(snapshot.agents, snapshot.ended_ids).await;
                        tokio::spawn(run_live(feed.clone(), path, normalizer, shutdown));
                    }
                    Err(_) => {
                        let started_at = Utc::now();
                        feed.replace_demo(demo::agents(0, started_at)).await;
                        tokio::spawn(run_demo(feed.clone(), shutdown, started_at));
                    }
                }
            }
            Err(_) => {
                let started_at = Utc::now();
                feed.replace_demo(demo::agents(0, started_at)).await;
                tokio::spawn(run_demo(feed.clone(), shutdown, started_at));
            }
        }
        feed
    }

    pub async fn fixed(mode: AppMode, agents: Vec<AgentRecord>) -> Self {
        let (changes, _) = broadcast::channel(256);
        let (health, _) = watch::channel(true);
        let feed = Self {
            inner: Arc::new(Inner {
                mode: RwLock::new(mode),
                agents: RwLock::new(HashMap::new()),
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
        let mode = self.inner.mode.read().await.clone();
        let mut agents = self
            .inner
            .agents
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        agents.sort_by(|a, b| a.id.cmp(&b.id));
        AgentStateEvent::Snapshot {
            version: PROTOCOL_VERSION,
            mode,
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
    async fn apply_live(&self, agents: Vec<AgentRecord>, ended_ids: Vec<String>) {
        self.reconcile(agents, false).await;
        self.end_ids(ended_ids).await;
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
        let mode = self.inner.mode.read().await.clone();
        let mut pending = self.inner.pending.lock().await;
        let mut stored = self.inner.agents.write().await;
        let stamp = now();
        for id in ended_ids {
            pending.remove(&id);
            let Some(mut agent) = stored.remove(&id) else {
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
            let mode = self.inner.mode.read().await.clone();
            let mut stored = self.inner.agents.write().await;
            for agent in ended {
                if stored.remove(&agent.id).is_some() {
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
        let mode = self.inner.mode.read().await.clone();
        let mut stored = self.inner.agents.write().await;
        let incoming_ids = incoming
            .iter()
            .map(|a| a.id.clone())
            .collect::<std::collections::HashSet<_>>();
        for agent in incoming {
            if stored.get(&agent.id) != Some(&agent) {
                stored.insert(agent.id.clone(), agent.clone());
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
            let removed = stored
                .keys()
                .filter(|id| !incoming_ids.contains(*id))
                .cloned()
                .collect::<Vec<_>>();
            for id in removed {
                stored.remove(&id);
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

async fn run_demo(feed: Feed, shutdown: CancellationToken, started_at: chrono::DateTime<Utc>) {
    let mut step = 1;
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! { _=shutdown.cancelled()=>break, _=interval.tick()=>{ feed.replace_demo(demo::agents(step, started_at)).await; step+=1; } }
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
    loop {
        tokio::select! { _=shutdown.cancelled()=>break, _=interval.tick()=>{}, event=wake_rx.recv()=>if event.is_none(){break} }
        match adapter::fetch_snapshot(&path, Duration::from_secs(2))
            .await
            .and_then(|raw| normalizer.normalize_snapshot_value(raw, &now()))
        {
            Ok(snapshot) => {
                failures = 0;
                if !*feed.inner.health.borrow() {
                    // send() fails without storing when every receiver is gone,
                    // and all receivers live in already-closed connection
                    // handlers at this point; send_replace stores regardless.
                    feed.inner.health.send_replace(true);
                }
                // Event wakes can burst; all production snapshot upserts therefore use
                // the same bounded coalescer exercised by the wire-rate tests. Ended
                // transitions remain immediate so their final record is never lost.
                feed.apply_live_coalesced(snapshot.agents, snapshot.ended_ids)
                    .await
            }
            Err(_) => {
                failures = failures.saturating_add(1);
                if failures >= 3 && *feed.inner.health.borrow() {
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
            Err(_) => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    }
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AgentState, SessionStats};
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
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut stream = BufReader::new(stream);
                    let mut request = String::new();
                    stream.read_line(&mut request).await.unwrap();
                    stream
                        .get_mut()
                        .write_all(include_bytes!("../tests/fixtures/snapshot-working.json"))
                        .await
                        .unwrap();
                    stream.get_mut().write_all(b"\n").await.unwrap();
                });
            }
        })
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
        assert!(
            matches!(feed.snapshot().await,AgentStateEvent::Snapshot{mode:AppMode::Live,agents,..} if agents.len()==1)
        );
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
        let restored = serve_snapshots(UnixListener::bind(&path).unwrap());
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
            matches!(feed.snapshot().await,AgentStateEvent::Snapshot{mode:AppMode::Live,agents,..} if agents.len()==1)
        );
        shutdown.cancel();
        restored.abort();
    }
}
