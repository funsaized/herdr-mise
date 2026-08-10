//! Generated-shape bindings for protocol/schema/agent-state-event.v1.schema.json.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Idle,
    Working,
    Blocked,
    Done,
    Ended,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppMode {
    Live,
    Demo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeltaOperation {
    Upsert,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub runtime_ms: u64,
    pub tickets: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub id: String,
    pub name: String,
    pub state: AgentState,
    pub progress: Option<f64>,
    pub state_entered_at: String,
    pub accent_index: u8,
    pub model: String,
    pub workspace: String,
    pub session: SessionStats,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum AgentStateEvent {
    Snapshot {
        version: u8,
        mode: AppMode,
        agents: Vec<AgentRecord>,
    },
    Delta {
        version: u8,
        mode: AppMode,
        operation: DeltaOperation,
        #[serde(skip_serializing_if = "Option::is_none")]
        agent: Option<AgentRecord>,
        #[serde(skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
    },
    Heartbeat {
        version: u8,
    },
}

#[cfg(test)]
mod tests {
    use super::AgentStateEvent;
    use serde_json::Value;
    use std::{fs, path::PathBuf};

    fn protocol_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol")
    }

    #[test]
    fn golden_fixtures_validate_and_round_trip() {
        let schema_value: Value = serde_json::from_str(
            &fs::read_to_string(protocol_dir().join("schema/agent-state-event.v1.schema.json"))
                .expect("read schema"),
        )
        .expect("parse schema");
        let schema = jsonschema::JSONSchema::compile(&schema_value).expect("compile schema");

        for name in [
            "snapshot.v1.json",
            "delta-upsert.v1.json",
            "delta-remove.v1.json",
            "heartbeat.v1.json",
        ] {
            let value: Value = serde_json::from_str(
                &fs::read_to_string(protocol_dir().join("fixtures").join(name))
                    .expect("read fixture"),
            )
            .expect("parse fixture");
            assert!(
                schema.is_valid(&value),
                "{name} must match the shared schema"
            );
            let event: AgentStateEvent =
                serde_json::from_value(value.clone()).expect("deserialize");
            assert_eq!(
                serde_json::to_value(event).expect("serialize"),
                value,
                "{name}"
            );
        }
    }
}
