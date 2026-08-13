use std::collections::BTreeMap;

use crate::protocol::{
    AgentRecord, AgentStateEvent, AppMode, DeltaOperation, SourceDiagnostic, SourceStatus,
};

#[derive(Debug)]
pub struct AgentTable {
    mode: AppMode,
    source_status: SourceStatus,
    source_diagnostic: Option<SourceDiagnostic>,
    agents: BTreeMap<String, AgentRecord>,
}

impl Default for AgentTable {
    fn default() -> Self {
        Self {
            mode: AppMode::Demo,
            source_status: SourceStatus::UnavailableSocket,
            source_diagnostic: None,
            agents: BTreeMap::new(),
        }
    }
}

impl AgentTable {
    pub fn apply(&mut self, event: AgentStateEvent) {
        match event {
            AgentStateEvent::Snapshot {
                mode,
                source_status,
                source_diagnostic,
                agents,
                ..
            } => {
                self.mode = mode;
                self.source_status = source_status;
                self.source_diagnostic = source_diagnostic;
                self.agents = agents
                    .into_iter()
                    .map(|agent| (agent.id.clone(), agent))
                    .collect();
            }
            AgentStateEvent::Delta {
                mode,
                operation,
                agent,
                agent_id,
                ..
            } => {
                self.mode = mode;
                match operation {
                    DeltaOperation::Upsert => {
                        if let Some(agent) = agent {
                            self.agents.insert(agent.id.clone(), agent);
                        }
                    }
                    DeltaOperation::Remove => {
                        if let Some(id) = agent_id {
                            self.agents.remove(&id);
                        }
                    }
                }
            }
            AgentStateEvent::Heartbeat { .. } => {}
        }
    }

    pub fn mode(&self) -> AppMode {
        self.mode.clone()
    }
    pub fn source_status(&self) -> &SourceStatus {
        &self.source_status
    }
    pub fn source_diagnostic(&self) -> Option<&SourceDiagnostic> {
        self.source_diagnostic.as_ref()
    }
    pub fn agents(&self) -> impl Iterator<Item = &AgentRecord> {
        self.agents.values()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> AgentStateEvent {
        let text = std::fs::read_to_string(format!(
            "{}/../protocol/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn snapshot_heartbeat_upsert_and_remove_are_reduced() {
        let mut table = AgentTable::default();
        table.apply(fixture("snapshot.v1.json"));
        assert!(!table.agents().collect::<Vec<_>>().is_empty());
        for name in [
            "heartbeat.v1.json",
            "delta-upsert.v1.json",
            "delta-remove.v1.json",
        ] {
            table.apply(fixture(name));
        }
        assert!(table.agents().all(|agent| agent.id != "agent-2"));
    }
}
