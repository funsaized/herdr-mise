//! The only module containing Herdr protocol schema knowledge.
use chrono::DateTime;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io,
    path::Path,
    sync::LazyLock,
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    time::timeout,
};

use crate::protocol::{AgentRecord, AgentState, SessionStats, SourceDiagnostic, SourceStatus};

const MAX_TEXT_UTF16_UNITS: usize = 4096;
const MAX_FEED_FRAME_UTF16_UNITS: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilityManifest {
    schema_version: u64,
    supported: Vec<CompatibilityEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilityEntry {
    protocol: u64,
}

static COMPATIBILITY: LazyLock<CompatibilityManifest> = LazyLock::new(|| {
    let manifest: CompatibilityManifest =
        serde_json::from_str(include_str!("../../compatibility/herdr.json"))
            .expect("checked Herdr compatibility manifest");
    assert_eq!(manifest.schema_version, 1, "supported manifest schema");
    manifest
});

pub fn supported_protocols() -> Vec<u64> {
    COMPATIBILITY
        .supported
        .iter()
        .map(|entry| entry.protocol)
        .collect()
}

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
    #[error("incompatible snapshot: {next_action}")]
    IncompatibleSnapshot {
        observed_protocol: u64,
        next_action: &'static str,
    },
    #[error("unsupported herdr protocol: {0}")]
    Protocol(u64),
    #[error("missing snapshot result")]
    MissingSnapshot,
}

impl AdapterError {
    pub fn source_status(&self) -> SourceStatus {
        match self {
            Self::Io(_) => SourceStatus::UnavailableSocket,
            Self::Timeout => SourceStatus::Timeout,
            Self::Protocol(_) => SourceStatus::UnsupportedProtocol,
            Self::Json(_)
            | Self::Remote(_)
            | Self::IncompatibleSnapshot { .. }
            | Self::MissingSnapshot => SourceStatus::IncompatibleResponse,
        }
    }

    pub fn source_diagnostic(&self) -> Option<SourceDiagnostic> {
        match self {
            Self::Protocol(observed_protocol) => Some(SourceDiagnostic {
                observed_protocol: *observed_protocol,
                supported_protocols: supported_protocols(),
                next_action: "upgrade or downgrade Herdr to a tested release, then retry"
                    .to_owned(),
            }),
            Self::IncompatibleSnapshot {
                observed_protocol,
                next_action,
            } => Some(SourceDiagnostic {
                observed_protocol: *observed_protocol,
                supported_protocols: supported_protocols(),
                next_action: (*next_action).to_owned(),
            }),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct Workspace {
    workspace_id: String,
    #[serde(default)]
    label: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RawAgent {
    terminal_id: String,
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
    state_change_seq: Option<u64>,
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
    tabs: Vec<Value>,
    layouts: Vec<Value>,
}

#[derive(Debug, Default)]
pub struct Normalizer {
    previous_ids: HashSet<String>,
    entered_at: HashMap<String, (AgentState, bool, String, Option<u64>)>,
    first_seen: HashMap<String, String>,
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
        if !supported_protocols().contains(&raw.protocol) {
            return Err(AdapterError::Protocol(raw.protocol));
        }
        // Every manifest-supported protocol exposes the snapshot fields consumed below.
        // The product version is intentionally descriptive so patch releases keep working.
        let _server_version = &raw.version;
        let _ = (&raw.tabs, &raw.layouts);
        let workspaces: HashMap<_, _> = raw
            .workspaces
            .into_iter()
            .map(|w| (w.workspace_id, w.label))
            .collect();
        let source = raw.agents;
        if source.len() > 4096 {
            return Err(AdapterError::Remote(
                "snapshot exceeds 4096 agent limit".into(),
            ));
        }
        let mut current = HashSet::with_capacity(source.len());
        for agent in &source {
            if agent.terminal_id.trim().is_empty()
                || agent.terminal_id.encode_utf16().count() > MAX_TEXT_UTF16_UNITS
                || agent.pane_id.trim().is_empty()
                || agent.pane_id.encode_utf16().count() > MAX_TEXT_UTF16_UNITS
            {
                return Err(AdapterError::IncompatibleSnapshot {
                    observed_protocol: raw.protocol,
                    next_action:
                        "ensure every agent has a valid terminal identity and pane locator, then retry",
                });
            }
            if !current.insert(agent.terminal_id.clone()) {
                return Err(AdapterError::IncompatibleSnapshot {
                    observed_protocol: raw.protocol,
                    next_action:
                        "ensure terminal identities are unique within the Herdr snapshot, then retry",
                });
            }
        }
        let mut agents = Vec::with_capacity(source.len());
        let mut entered_at = self.entered_at.clone();
        let mut first_seen = self.first_seen.clone();
        for agent in source {
            let id = agent.terminal_id.clone();
            let state_known = !matches!(agent.agent_status, RawStatus::Unknown);
            let state = match agent.agent_status {
                RawStatus::Idle | RawStatus::Unknown => AgentState::Idle,
                RawStatus::Working => AgentState::Working,
                RawStatus::Blocked => AgentState::Blocked,
                RawStatus::Done => AgentState::Done,
            };
            let stamp = match entered_at.get(&id) {
                Some((old, known, stamp, previous_sequence))
                    if old == &state && *known == state_known =>
                {
                    if matches!(
                        (*previous_sequence, agent.state_change_seq),
                        (Some(previous), Some(current)) if current > previous
                    ) {
                        received_at.to_owned()
                    } else {
                        stamp.clone()
                    }
                }
                _ => received_at.to_owned(),
            };
            entered_at.insert(
                id.clone(),
                (
                    state.clone(),
                    state_known,
                    stamp.clone(),
                    agent.state_change_seq,
                ),
            );
            let name = truncate_utf16(
                [agent.name, agent.display_agent, agent.agent, agent.title]
                    .into_iter()
                    .flatten()
                    .find(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| format!("agent-{}", agent.pane_id)),
            );
            let workspace = truncate_utf16(
                workspaces
                    .get(&agent.workspace_id)
                    .filter(|s| !s.is_empty())
                    .cloned()
                    .unwrap_or(agent.workspace_id),
            );
            let started = first_seen
                .entry(id.clone())
                .or_insert_with(|| received_at.to_owned())
                .clone();
            agents.push(AgentRecord {
                state_known: Some(state_known),
                accent_index: accent(&id),
                id,
                pane_id: Some(agent.pane_id),
                name,
                state,
                progress: None,
                state_entered_at: stamp,
                model: String::new(),
                workspace,
                session: SessionStats {
                    tickets_available: Some(false),
                    runtime_ms: mise_runtime_ms(&started, received_at),
                    tickets: 0,
                },
            });
        }
        agents.sort_by(|a, b| a.id.cmp(&b.id));
        let ended_ids: Vec<String> = self.previous_ids.difference(&current).cloned().collect();
        for id in &ended_ids {
            first_seen.remove(id);
            entered_at.remove(id);
        }
        if serde_json::to_string(&agents)?.encode_utf16().count() > MAX_FEED_FRAME_UTF16_UNITS - 256
        {
            return Err(AdapterError::Remote(
                "normalized snapshot exceeds browser frame limit".into(),
            ));
        }
        self.first_seen = first_seen;
        self.entered_at = entered_at;
        self.previous_ids = current;
        Ok(NormalizedSnapshot { agents, ended_ids })
    }
}

fn truncate_utf16(value: String) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= MAX_TEXT_UTF16_UNITS
        })
        .collect()
}

fn mise_runtime_ms(started_at: &str, received_at: &str) -> u64 {
    let (Ok(start), Ok(end)) = (
        DateTime::parse_from_rfc3339(started_at),
        DateTime::parse_from_rfc3339(received_at),
    ) else {
        return 0;
    };
    end.signed_duration_since(start).num_milliseconds().max(0) as u64
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
        let value = read_frame(&mut BufReader::new(stream), &mut Vec::new()).await?;
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
    pending: Vec<u8>,
}

const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

// fill_buf is cancellation-safe; partial frames survive the event watchdog.
async fn read_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    pending: &mut Vec<u8>,
) -> Result<Value, AdapterError> {
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return Err(AdapterError::MissingSnapshot);
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(buffer.len(), |index| index + 1);
        if pending.len() + count > MAX_FRAME_BYTES {
            return Err(AdapterError::Remote(
                "response exceeds 4 MiB frame limit".into(),
            ));
        }
        pending.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if newline.is_some() {
            let result = serde_json::from_slice(pending).map_err(AdapterError::from);
            pending.clear();
            return result;
        }
    }
}

impl EventStream {
    pub async fn next(&mut self, bound: Duration) -> Result<Value, AdapterError> {
        timeout(bound, read_frame(&mut self.reader, &mut self.pending))
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
            "layout.updated",
        ].into_iter().map(|kind| json!({"type":kind})).collect::<Vec<_>>();
        let request = json!({"id":"herdr-mise-events","method":"events.subscribe","params":{"subscriptions":subscriptions}}).to_string();
        stream.write_all(request.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        let mut reader = BufReader::new(stream);
        let response = read_frame(&mut reader, &mut Vec::new()).await?;
        if let Some(error) = response.get("error") { return Err(AdapterError::Remote(error.to_string())); }
        if response.pointer("/result/type").and_then(Value::as_str) != Some("subscription_started") { return Err(AdapterError::MissingSnapshot); }
        Ok(EventStream { reader, pending: Vec::new() })
    }).await.map_err(|_| AdapterError::Timeout)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::AsyncBufReadExt, net::UnixListener};
    #[tokio::test]
    async fn bounded_frames_reject_oversize_and_keep_following_frame() {
        let mut reader = BufReader::new(&b"{\"one\":1}\n{\"two\":2}\n"[..]);
        let mut pending = Vec::new();
        assert_eq!(
            read_frame(&mut reader, &mut pending).await.unwrap()["one"],
            1
        );
        assert_eq!(
            read_frame(&mut reader, &mut pending).await.unwrap()["two"],
            2
        );
        let oversized = vec![b'x'; MAX_FRAME_BYTES + 1];
        assert!(matches!(
            read_frame(&mut BufReader::new(oversized.as_slice()), &mut pending).await,
            Err(AdapterError::Remote(_))
        ));
        assert!(pending.len() <= MAX_FRAME_BYTES);
    }

    #[test]
    fn departed_panes_release_timestamps_and_reentry_starts_now() {
        let mut normalizer = Normalizer::default();
        normalizer
            .normalize_snapshot_value(raw("working"), "2026-07-31T00:00:00Z")
            .unwrap();
        let mut empty = raw("working");
        empty["agents"] = json!([]);
        normalizer
            .normalize_snapshot_value(empty, "2026-07-31T00:00:01Z")
            .unwrap();
        assert!(normalizer.entered_at.is_empty());
        assert!(normalizer.first_seen.is_empty());
        let again = normalizer
            .normalize_snapshot_value(raw("working"), "2026-07-31T00:01:00Z")
            .unwrap();
        assert_eq!(again.agents[0].state_entered_at, "2026-07-31T00:01:00Z");
    }

    #[test]
    fn state_sequence_marks_only_verified_same_state_reentry() {
        let baseline: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/snapshot-herdr-0.8.2-p20.json"
        ))
        .unwrap();
        let advanced: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/snapshot-herdr-0.8.2-p20-state-sequence-advanced.json"
        ))
        .unwrap();
        let mut normalizer = Normalizer::default();
        let stamp = |normalizer: &mut Normalizer, snapshot: Value, received_at: &str| {
            normalizer
                .normalize_snapshot_value(snapshot, received_at)
                .unwrap()
                .agents[0]
                .state_entered_at
                .clone()
        };

        assert_eq!(stamp(&mut normalizer, baseline.clone(), "t0"), "t0");
        assert_eq!(stamp(&mut normalizer, baseline.clone(), "t1"), "t0");
        assert_eq!(stamp(&mut normalizer, advanced.clone(), "t2"), "t2");

        let mut absent = advanced.clone();
        absent["agents"][0]
            .as_object_mut()
            .unwrap()
            .remove("state_change_seq");
        assert_eq!(stamp(&mut normalizer, absent, "t3"), "t2");
        assert_eq!(stamp(&mut normalizer, advanced.clone(), "t4"), "t2");

        let mut regressed = advanced.clone();
        regressed["agents"][0]["state_change_seq"] = json!(1);
        assert_eq!(stamp(&mut normalizer, regressed, "t5"), "t2");
        assert_eq!(stamp(&mut normalizer, baseline.clone(), "t6"), "t6");

        let absent_release: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/snapshot-herdr-0.7.5-p17.json"
        ))
        .unwrap();
        let mut fallback = Normalizer::default();
        assert_eq!(stamp(&mut fallback, absent_release.clone(), "f0"), "f0");
        assert_eq!(stamp(&mut fallback, absent_release.clone(), "f1"), "f0");

        let mut blocked = baseline.clone();
        blocked["agents"][0]["agent_status"] = json!("blocked");
        assert_eq!(stamp(&mut normalizer, blocked, "t7"), "t7");
        let mut idle = baseline.clone();
        idle["agents"][0]["agent_status"] = json!("idle");
        assert_eq!(stamp(&mut normalizer, idle.clone(), "t8"), "t8");
        idle["agents"][0]["agent_status"] = json!("unknown");
        assert_eq!(stamp(&mut normalizer, idle, "t9"), "t9");

        let released = normalizer
            .normalize_snapshot_value(absent_release, "t10")
            .unwrap();
        assert_eq!(released.ended_ids, vec!["fictional-terminal-20"]);
        assert!(!normalizer.entered_at.contains_key("fictional-terminal-20"));
    }
    fn raw(status: &str) -> Value {
        json!({"version":"0.7.5","protocol":17,"workspaces":[{"workspace_id":"ws-1","label":"demo"}],"tabs":[],"panes":[],"layouts":[],"agents":[{"terminal_id":"t-1","pane_id":"p-1","workspace_id":"ws-1","agent":"codex","agent_status":status,"agent_session":null}]})
    }
    #[test]
    fn joins_and_defaults() {
        let mut n = Normalizer::default();
        let out = n
            .normalize_snapshot_value(raw("working"), "2026-07-31T00:00:00Z")
            .unwrap();
        let a = &out.agents[0];
        assert_eq!(a.id, "t-1");
        assert_eq!(a.pane_id.as_deref(), Some("p-1"));
        assert_eq!(a.workspace, "demo");
        assert_eq!(a.progress, None);
        assert_eq!(a.model, "");
        assert_eq!(a.session.runtime_ms, 0);
    }
    #[test]
    fn bounds_fixture_labels_for_browser_decoding() {
        let mut snapshot: Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot-working.json")).unwrap();
        snapshot["result"]["snapshot"]["agents"][0]["name"] = json!("😀".repeat(4096));
        snapshot["result"]["snapshot"]["workspaces"][0]["label"] =
            json!("workspace😀".repeat(4096));
        let normalized = Normalizer::default()
            .normalize_snapshot_value(snapshot, "2026-07-31T00:00:00Z")
            .unwrap();
        let agent = &normalized.agents[0];

        assert_eq!(agent.name.encode_utf16().count(), MAX_TEXT_UTF16_UNITS);
        assert!(agent.workspace.encode_utf16().count() <= MAX_TEXT_UTF16_UNITS);
        assert!(!agent.name.is_empty());
        assert!(serde_json::to_string(agent).unwrap().len() < MAX_FRAME_BYTES);

        let mut amplified: Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot-working.json")).unwrap();
        amplified["result"]["snapshot"]["workspaces"][0]["label"] = json!("😀".repeat(2048));
        let template = amplified["result"]["snapshot"]["agents"][0].clone();
        amplified["result"]["snapshot"]["agents"] = Value::Array(
            (0..4096)
                .map(|index| {
                    let mut agent = template.clone();
                    agent["terminal_id"] = json!(format!("t-{index}"));
                    agent["pane_id"] = json!(format!("p-{index}"));
                    agent
                })
                .collect(),
        );
        assert!(matches!(
            Normalizer::default()
                .normalize_snapshot_value(amplified, "2026-07-31T00:00:00Z"),
            Err(AdapterError::Remote(message))
                if message == "normalized snapshot exceeds browser frame limit"
        ));
    }
    #[test]
    fn mise_time_accumulates_from_first_sighting_and_resets_on_end() {
        let mut n = Normalizer::default();
        n.normalize_snapshot_value(raw("working"), "2026-07-31T00:00:00Z")
            .unwrap();
        let later = n
            .normalize_snapshot_value(raw("working"), "2026-07-31T00:00:05Z")
            .unwrap();
        assert_eq!(later.agents[0].session.runtime_ms, 5_000);
        n.normalize_snapshot_value(
            json!({"version":"0.7.5","protocol":17,"workspaces":[],"tabs":[],"panes":[],"layouts":[],"agents":[]}),
            "2026-07-31T00:00:06Z",
        )
        .unwrap();
        let again = n
            .normalize_snapshot_value(raw("idle"), "2026-07-31T00:01:00Z")
            .unwrap();
        assert_eq!(again.agents[0].session.runtime_ms, 0);
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
        assert_eq!(out.ended_ids, vec!["t-1"]);
    }

    #[test]
    fn starting_agent_session_does_not_end_its_pane() {
        let mut normalizer = Normalizer::default();
        let mut snapshot: Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot-working.json")).unwrap();
        let first = normalizer
            .normalize_snapshot_value(snapshot.clone(), "before-message")
            .unwrap();
        snapshot["result"]["snapshot"]["agents"][0]["agent_session"] =
            json!({"value": "new-session"});
        let after_message = normalizer
            .normalize_snapshot_value(snapshot, "after-message")
            .unwrap();

        assert_eq!(first.agents[0].id, "t-1");
        assert_eq!(after_message.agents[0].id, "t-1");
        assert!(after_message.ended_ids.is_empty());
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
    fn rejects_empty_or_duplicate_identity_before_mutating_lifecycle_state() {
        let mut normalizer = Normalizer::default();
        normalizer
            .normalize_snapshot_value(raw("working"), "2026-07-31T00:00:00Z")
            .unwrap();
        let before = (
            normalizer.previous_ids.clone(),
            normalizer.entered_at.clone(),
            normalizer.first_seen.clone(),
        );
        for (invalid, expected) in [
            (
                json!({"version":"0.7.5","protocol":17,"workspaces":[],"tabs":[],"panes":[],"layouts":[],"agents":[{"terminal_id":"","pane_id":"p","agent_status":"idle"}]}),
                "valid terminal identity and pane locator",
            ),
            (
                json!({"version":"0.7.5","protocol":17,"workspaces":[],"tabs":[],"panes":[],"layouts":[],"agents":[{"terminal_id":"same","pane_id":"p-1","agent_status":"idle"},{"terminal_id":"same","pane_id":"p-2","agent_status":"idle"}]}),
                "terminal identities are unique",
            ),
        ] {
            let error = normalizer
                .normalize_snapshot_value(invalid, "later")
                .expect_err("invalid identity");
            assert!(matches!(&error, AdapterError::IncompatibleSnapshot { .. }));
            assert!(error
                .source_diagnostic()
                .is_some_and(|diagnostic| diagnostic.next_action.contains(expected)));
            assert_eq!(normalizer.previous_ids, before.0);
            assert_eq!(normalizer.entered_at, before.1);
            assert_eq!(normalizer.first_seen, before.2);
        }
    }

    #[test]
    fn maps_adapter_failures_to_non_sensitive_source_statuses() {
        assert_eq!(
            AdapterError::Io(io::Error::new(io::ErrorKind::NotFound, "/private/socket"))
                .source_status(),
            SourceStatus::UnavailableSocket
        );
        assert_eq!(AdapterError::Timeout.source_status(), SourceStatus::Timeout);
        assert_eq!(
            AdapterError::Protocol(999).source_status(),
            SourceStatus::UnsupportedProtocol
        );
        assert_eq!(
            AdapterError::MissingSnapshot.source_status(),
            SourceStatus::IncompatibleResponse
        );
    }

    #[test]
    fn unsupported_diagnostic_is_actionable_and_malformed_remains_distinct() {
        let unsupported = AdapterError::Protocol(23);
        let diagnostic = unsupported.source_diagnostic().expect("diagnostic");
        assert_eq!(diagnostic.observed_protocol, 23);
        assert_eq!(diagnostic.supported_protocols, vec![17, 19, 20]);
        assert!(diagnostic
            .next_action
            .contains("upgrade or downgrade Herdr"));
        assert!(!diagnostic.next_action.contains('/'));

        let malformed =
            AdapterError::Json(serde_json::from_str::<Value>("private-token=secret").unwrap_err());
        assert_eq!(
            malformed.source_status(),
            SourceStatus::IncompatibleResponse
        );
        assert_eq!(malformed.source_diagnostic(), None);
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
    fn compatibility_manifest_drives_runtime_protocols_and_fixture_mapping() {
        assert_eq!(supported_protocols(), vec![17, 19, 20]);

        let cases = [
            (
                include_str!("../tests/fixtures/snapshot-herdr-0.7.5-p17.json"),
                "fictional-terminal-17",
                "fictional-pane-17",
                AgentState::Working,
                "Example Kitchen",
            ),
            (
                include_str!("../tests/fixtures/snapshot-herdr-0.8.0-p19.json"),
                "fictional-terminal-19",
                "fictional-pane-19",
                AgentState::Blocked,
                "/work/example-pantry",
            ),
            (
                include_str!("../tests/fixtures/snapshot-herdr-0.8.2-p20.json"),
                "fictional-terminal-20",
                "fictional-pane-20",
                AgentState::Working,
                "Example Kitchen",
            ),
        ];
        for (fixture, id, pane_id, state, workspace) in cases {
            let mut normalizer = Normalizer::default();
            let normalized = normalizer
                .normalize_snapshot_value(serde_json::from_str(fixture).unwrap(), "fixture-time")
                .unwrap();
            assert_eq!(normalized.agents.len(), 1);
            assert_eq!(normalized.agents[0].id, id);
            assert_eq!(normalized.agents[0].pane_id.as_deref(), Some(pane_id));
            assert_eq!(normalized.agents[0].state, state);
            assert_eq!(normalized.agents[0].workspace, workspace);
        }
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
                "terminal_id": "t-1",
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
    fn protocol_19_empty_agents_ignores_ordinary_panes() {
        let mut n = Normalizer::default();
        let snapshot = serde_json::from_str(include_str!(
            "../tests/fixtures/snapshot-protocol-19-empty-agents.json"
        ))
        .unwrap();

        let normalized = n
            .normalize_snapshot_value(snapshot, "2026-08-11T00:00:00Z")
            .unwrap();

        assert!(normalized.agents.is_empty());
        assert!(normalized.ended_ids.is_empty());
    }

    #[test]
    fn protocol_19_unknown_status_agent_remains_visible() {
        let mut n = Normalizer::default();
        let snapshot = json!({
            "version": "0.8.0",
            "protocol": 19,
            "workspaces": [],
            "tabs": [],
            "panes": [],
            "layouts": [],
            "agents": [{
                "terminal_id": "t-unknown",
                "pane_id": "p-unknown",
                "workspace_id": "",
                "agent": "codex",
                "agent_status": "unknown"
            }]
        });

        let normalized = n
            .normalize_snapshot_value(snapshot, "2026-08-11T00:00:00Z")
            .unwrap();

        assert_eq!(normalized.agents.len(), 1);
        assert_eq!(normalized.agents[0].state, AgentState::Idle);
        assert!(normalized.ended_ids.is_empty());
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
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                panic!("required socket integration unavailable: {error}")
            }
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
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                panic!("required socket integration unavailable: {error}")
            }
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
    async fn subscription_requests_only_unfiltered_structural_events() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sock");
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                panic!("required socket integration unavailable: {error}")
            }
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
            assert!(!encoded.contains("agent_status_changed"));
            stream.get_mut().write_all(b"{\"id\":\"herdr-mise-events\",\"result\":{\"type\":\"subscription_started\"}}\n").await.unwrap();
            stream
                .get_mut()
                .write_all(b"{\"event\":\"pane.updated\",\"data\":{\"pane_id\":\"p-1\"}}\n")
                .await
                .unwrap();
        });
        let mut events = subscribe_events(&path, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(
            decode_event(events.next(Duration::from_secs(1)).await.unwrap()).unwrap(),
            AdapterEvent::Structural
        );
        server.await.unwrap();
    }
}
