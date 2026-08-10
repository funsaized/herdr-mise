//! The only module containing Herdr protocol schema knowledge.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io,
    path::Path,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    time::timeout,
};

use crate::protocol::{AgentRecord, AgentState, SessionStats};

pub const HERDR_PROTOCOLS: &[u64] = &[17, 19];

#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("socket unavailable: {0}")]
    Io(#[from] io::Error),
    #[error("operation timed out")]
    Timeout,
    #[error("malformed response: {0}")]
    Json(#[from] serde_json::Error),
    #[error("remote error: {0}")]
    Remote(String),
    #[error("unsupported herdr protocol: {0}")]
    Protocol(u64),
    #[error("missing snapshot result")]
    MissingSnapshot,
}

#[derive(Debug, Clone, Deserialize)]
struct Workspace {
    workspace_id: String,
    #[serde(default)]
    label: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RawAgent {
    pane_id: String,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    display_agent: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    title: Option<String>,
    agent_status: RawStatus,
    #[serde(default)]
    agent_session: Option<AgentSession>,
}

#[derive(Debug, Clone, Deserialize)]
struct AgentSession {
    value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RawStatus {
    Idle,
    Working,
    Blocked,
    Done,
    Unknown,
}

#[derive(Debug, Deserialize)]
struct RawSnapshot {
    version: String,
    protocol: u64,
    workspaces: Vec<Workspace>,
    agents: Vec<RawAgent>,
    panes: Vec<RawAgent>,
    tabs: Vec<Value>,
    layouts: Vec<Value>,
}

#[derive(Debug, Default)]
pub struct Normalizer {
    previous_ids: HashSet<String>,
    entered_at: HashMap<String, (AgentState, String)>,
}

#[derive(Debug)]
pub struct NormalizedSnapshot {
    pub agents: Vec<AgentRecord>,
    pub ended_ids: Vec<String>,
}

impl Normalizer {
    pub fn normalize_snapshot_value(
        &mut self,
        value: Value,
        received_at: &str,
    ) -> Result<NormalizedSnapshot, AdapterError> {
        let snapshot_value = value
            .get("result")
            .and_then(|v| v.get("snapshot"))
            .cloned()
            .or_else(|| value.get("snapshot").cloned())
            .unwrap_or(value);
        let raw: RawSnapshot = serde_json::from_value(snapshot_value)?;
        if !HERDR_PROTOCOLS.contains(&raw.protocol) {
            return Err(AdapterError::Protocol(raw.protocol));
        }
        // Herdr protocols 17 and 19 expose the snapshot fields consumed below. The
        // product version is intentionally descriptive so patch releases keep working.
        let _server_version = &raw.version;
        let _ = (&raw.tabs, &raw.layouts);
        let workspaces: HashMap<_, _> = raw
            .workspaces
            .into_iter()
            .map(|w| (w.workspace_id, w.label))
            .collect();
        let source = if raw.agents.is_empty() {
            raw.panes
        } else {
            raw.agents
        };
        let mut current = HashSet::new();
        let mut agents = Vec::with_capacity(source.len());
        for agent in source {
            let id = agent
                .agent_session
                .as_ref()
                .map(|s| s.value.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| agent.pane_id.clone());
            current.insert(id.clone());
            let state = match agent.agent_status {
                RawStatus::Idle | RawStatus::Unknown => AgentState::Idle,
                RawStatus::Working => AgentState::Working,
                RawStatus::Blocked => AgentState::Blocked,
                RawStatus::Done => AgentState::Done,
            };
            let stamp = match self.entered_at.get(&id) {
                Some((old, stamp)) if old == &state => stamp.clone(),
                _ => {
                    self.entered_at
                        .insert(id.clone(), (state.clone(), received_at.to_owned()));
                    received_at.to_owned()
                }
            };
            let name = [agent.name, agent.display_agent, agent.agent, agent.title]
                .into_iter()
                .flatten()
                .find(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("agent-{}", &agent.pane_id));
            let workspace = workspaces
                .get(&agent.workspace_id)
                .filter(|s| !s.is_empty())
                .cloned()
                .unwrap_or(agent.workspace_id);
            agents.push(AgentRecord {
                accent_index: accent(&id),
                id,
                name,
                state,
                progress: None,
                state_entered_at: stamp,
                model: String::new(),
                workspace,
                session: SessionStats {
                    runtime_ms: 0,
                    tickets: 0,
                },
            });
        }
        agents.sort_by(|a, b| a.id.cmp(&b.id));
        let ended_ids = self.previous_ids.difference(&current).cloned().collect();
        self.previous_ids = current;
        Ok(NormalizedSnapshot { agents, ended_ids })
    }
}

fn accent(id: &str) -> u8 {
    use sha2::{Digest, Sha256};
    Sha256::digest(id.as_bytes())[0] % 12
}

#[derive(Debug, PartialEq)]
pub enum AdapterEvent {
    Status {
        pane_id: String,
        state: Option<AgentState>,
    },
    Exited {
        pane_id: String,
    },
    Structural,
}

pub fn decode_event(value: Value) -> Result<AdapterEvent, AdapterError> {
    let event = value
        .get("event")
        .and_then(Value::as_str)
        .ok_or(AdapterError::MissingSnapshot)?;
    let data = value.get("data").ok_or(AdapterError::MissingSnapshot)?;
    let pane_id = || {
        data.get("pane_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or(AdapterError::MissingSnapshot)
    };
    match event {
        "pane_agent_status_changed" | "pane.agent_status_changed" => {
            let state = match data.get("agent_status").and_then(Value::as_str) {
                Some("idle") => Some(AgentState::Idle),
                Some("working") => Some(AgentState::Working),
                Some("blocked") => Some(AgentState::Blocked),
                Some("done") => Some(AgentState::Done),
                Some("unknown") => None,
                _ => return Err(AdapterError::MissingSnapshot),
            };
            Ok(AdapterEvent::Status {
                pane_id: pane_id()?,
                state,
            })
        }
        "pane_exited" | "pane_closed" | "pane.exited" | "pane.closed" => Ok(AdapterEvent::Exited {
            pane_id: pane_id()?,
        }),
        _ => Ok(AdapterEvent::Structural),
    }
}

pub async fn fetch_snapshot(path: &Path, bound: Duration) -> Result<Value, AdapterError> {
    timeout(bound, async {
        let mut stream = UnixStream::connect(path).await?;
        let request =
            json!({"id":"herdr-mise-snapshot","method":"session.snapshot","params":{}}).to_string();
        stream.write_all(request.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        let mut line = String::new();
        let read = BufReader::new(stream).read_line(&mut line).await?;
        if read == 0 {
            return Err(AdapterError::MissingSnapshot);
        }
        let value: Value = serde_json::from_str(&line)?;
        if let Some(error) = value.get("error") {
            return Err(AdapterError::Remote(error.to_string()));
        }
        Ok(value)
    })
    .await
    .map_err(|_| AdapterError::Timeout)?
}

pub struct EventStream {
    reader: BufReader<UnixStream>,
}

impl EventStream {
    pub async fn next(&mut self, bound: Duration) -> Result<Value, AdapterError> {
        timeout(bound, async {
            let mut line = String::new();
            if self.reader.read_line(&mut line).await? == 0 {
                return Err(AdapterError::MissingSnapshot);
            }
            Ok(serde_json::from_str(&line)?)
        })
        .await
        .map_err(|_| AdapterError::Timeout)?
    }
}

pub async fn subscribe_events(path: &Path, bound: Duration) -> Result<EventStream, AdapterError> {
    timeout(bound, async {
        let mut stream = UnixStream::connect(path).await?;
        let subscriptions = [
            "workspace.created", "workspace.updated", "workspace.renamed", "workspace.closed",
            "tab.created", "tab.closed", "tab.renamed", "pane.created", "pane.closed",
            "pane.updated", "pane.moved", "pane.exited", "pane.agent_detected",
            "pane.agent_status_changed", "layout.updated",
        ].into_iter().map(|kind| json!({"type":kind})).collect::<Vec<_>>();
        let request = json!({"id":"herdr-mise-events","method":"events.subscribe","params":{"subscriptions":subscriptions}}).to_string();
        stream.write_all(request.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 { return Err(AdapterError::MissingSnapshot); }
        let response: Value = serde_json::from_str(&line)?;
        if let Some(error) = response.get("error") { return Err(AdapterError::Remote(error.to_string())); }
        if response.pointer("/result/type").and_then(Value::as_str) != Some("subscription_started") { return Err(AdapterError::MissingSnapshot); }
        Ok(EventStream { reader })
    }).await.map_err(|_| AdapterError::Timeout)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::AsyncBufReadExt, net::UnixListener};
    fn raw(status: &str) -> Value {
        json!({"version":"0.7.5","protocol":17,"workspaces":[{"workspace_id":"ws-1","label":"demo"}],"tabs":[],"panes":[],"layouts":[],"agents":[{"pane_id":"p-1","workspace_id":"ws-1","agent":"codex","agent_status":status,"agent_session":null}]})
    }
    #[test]
    fn joins_and_defaults() {
        let mut n = Normalizer::default();
        let out = n
            .normalize_snapshot_value(raw("working"), "2026-07-31T00:00:00Z")
            .unwrap();
        let a = &out.agents[0];
        assert_eq!(a.id, "p-1");
        assert_eq!(a.workspace, "demo");
        assert_eq!(a.progress, None);
        assert_eq!(a.model, "");
        assert_eq!(a.session.runtime_ms, 0);
    }
    #[test]
    fn unknown_is_not_ended_and_disappearance_is() {
        let mut n = Normalizer::default();
        assert_eq!(
            n.normalize_snapshot_value(raw("unknown"), "a")
                .unwrap()
                .agents[0]
                .state,
            AgentState::Idle
        );
        let out = n
            .normalize_snapshot_value(json!({"version":"0.7.5","protocol":17,"workspaces":[],"tabs":[],"panes":[],"layouts":[],"agents":[]}), "b")
            .unwrap();
        assert_eq!(out.ended_ids, vec!["p-1"]);
    }
    #[test]
    fn rejects_protocol_mismatch_and_malformed() {
        let mut n = Normalizer::default();
        assert!(matches!(
            n.normalize_snapshot_value(json!({"version":"0.7.5","protocol":16,"agents":[],"workspaces":[],"tabs":[],"panes":[],"layouts":[]}), "a"),
            Err(AdapterError::Protocol(16))
        ));
        assert!(n
            .normalize_snapshot_value(json!({"version":"0.7.5","protocol":17,"agents":[{}],"workspaces":[],"tabs":[],"panes":[],"layouts":[]}), "a")
            .is_err());
    }

    #[test]
    fn accepts_compatible_protocol_across_patch_versions() {
        let mut n = Normalizer::default();
        let mut compatible = raw("idle");
        compatible["version"] = json!("0.7.99");
        assert!(n
            .normalize_snapshot_value(compatible, "2026-07-31T00:00:00Z")
            .is_ok());
    }

    #[test]
    fn accepts_herdr_0_8_protocol_19_snapshot() {
        let mut n = Normalizer::default();
        let current = json!({
            "version": "0.8.0",
            "protocol": 19,
            "focused_workspace_id": "ws-1",
            "focused_tab_id": "tab-1",
            "focused_pane_id": "p-1",
            "workspaces": [{"workspace_id": "ws-1", "label": "demo"}],
            "tabs": [],
            "panes": [],
            "layouts": [],
            "agents": [{
                "pane_id": "p-1",
                "workspace_id": "ws-1",
                "agent": "codex",
                "agent_status": "working",
                "revision": 1,
                "state_change_seq": 1
            }]
        });

        let snapshot = n
            .normalize_snapshot_value(current, "2026-08-07T00:00:00Z")
            .unwrap();

        assert_eq!(snapshot.agents.len(), 1);
        assert_eq!(snapshot.agents[0].state, AgentState::Working);
    }

    #[test]
    fn decodes_sanitized_events() {
        let blocked =
            serde_json::from_str(include_str!("../tests/fixtures/event-status-blocked.json"))
                .unwrap();
        assert_eq!(
            decode_event(blocked).unwrap(),
            AdapterEvent::Status {
                pane_id: "p-1".into(),
                state: Some(AgentState::Blocked)
            }
        );
        let exited =
            serde_json::from_str(include_str!("../tests/fixtures/event-pane-exited.json")).unwrap();
        assert_eq!(
            decode_event(exited).unwrap(),
            AdapterEvent::Exited {
                pane_id: "p-1".into()
            }
        );
    }

    #[tokio::test]
    async fn newline_transport_reads_stub_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("stub.sock");
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind stub socket: {error}"),
        };
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut request = String::new();
            let mut stream = BufReader::new(stream);
            stream.read_line(&mut request).await.unwrap();
            assert!(request.ends_with('\n'));
            assert_eq!(
                serde_json::from_str::<Value>(&request).unwrap()["method"],
                "session.snapshot"
            );
            stream
                .get_mut()
                .write_all(include_bytes!("../tests/fixtures/snapshot-working.json"))
                .await
                .unwrap();
            stream.get_mut().write_all(b"\n").await.unwrap();
        });
        let response = fetch_snapshot(&path, Duration::from_secs(1)).await.unwrap();
        assert_eq!(response["result"]["snapshot"]["protocol"], 17);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn response_timeout_is_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("silent.sock");
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind stub socket: {error}"),
        };
        let server = tokio::spawn(async move {
            let _connection = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });
        let started = std::time::Instant::now();
        assert!(matches!(
            fetch_snapshot(&path, Duration::from_millis(75)).await,
            Err(AdapterError::Timeout)
        ));
        assert!(started.elapsed() < Duration::from_millis(500));
        server.abort();
    }

    #[tokio::test]
    async fn subscription_requests_only_state_and_structure() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sock");
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind stub socket: {error}"),
        };
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut request = String::new();
            stream.read_line(&mut request).await.unwrap();
            let request: Value = serde_json::from_str(&request).unwrap();
            assert_eq!(request["method"], "events.subscribe");
            let encoded = request.to_string();
            assert!(!encoded.contains("output_matched"));
            assert!(!encoded.contains("scroll_changed"));
            stream.get_mut().write_all(b"{\"id\":\"herdr-mise-events\",\"result\":{\"type\":\"subscription_started\"}}\n").await.unwrap();
            stream.get_mut().write_all(b"{\"event\":\"pane.agent_status_changed\",\"data\":{\"pane_id\":\"p-1\",\"agent_status\":\"blocked\"}}\n").await.unwrap();
        });
        let mut events = subscribe_events(&path, Duration::from_secs(1))
            .await
            .unwrap();
        assert!(matches!(
            decode_event(events.next(Duration::from_secs(1)).await.unwrap()).unwrap(),
            AdapterEvent::Status {
                state: Some(AgentState::Blocked),
                ..
            }
        ));
        server.await.unwrap();
    }
}
