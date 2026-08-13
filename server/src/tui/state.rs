use crate::protocol::{
    AgentRecord, AgentState, AgentStateEvent, AppMode, DeltaOperation, SourceDiagnostic,
    SourceStatus,
};

#[derive(Debug, Clone, PartialEq)]
pub struct BoardEntry {
    pub id: String,
    pub name: String,
    pub runtime_ms: u64,
    pub tickets: u64,
    pub final_state: AgentState,
}

#[derive(Debug)]
pub struct AgentTable {
    mode: AppMode,
    source_status: SourceStatus,
    source_diagnostic: Option<SourceDiagnostic>,
    agents: Vec<AgentRecord>,
    board: Vec<BoardEntry>,
}

impl Default for AgentTable {
    fn default() -> Self {
        Self {
            mode: AppMode::Demo,
            source_status: SourceStatus::UnavailableSocket,
            source_diagnostic: None,
            agents: Vec::new(),
            board: Vec::new(),
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
                let prior_agents = std::mem::take(&mut self.agents);
                for agent in agents {
                    if agent.state == AgentState::Ended {
                        let current = self.agents.iter().position(|entry| entry.id == agent.id);
                        let prior_state = current
                            .map(|index| self.agents.remove(index).state)
                            .or_else(|| {
                                prior_agents
                                    .iter()
                                    .find(|prior| prior.id == agent.id)
                                    .map(|prior| prior.state.clone())
                            });
                        self.end(agent, prior_state);
                    } else {
                        self.upsert(agent);
                    }
                }
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
                            self.upsert(agent);
                        }
                    }
                    DeltaOperation::Remove => {
                        if let Some(id) = agent_id {
                            self.agents.retain(|agent| agent.id != id);
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
        self.agents.iter()
    }
    pub fn board(&self) -> &[BoardEntry] {
        &self.board
    }

    fn upsert(&mut self, agent: AgentRecord) {
        let existing = self.agents.iter().position(|entry| entry.id == agent.id);
        if agent.state == AgentState::Ended {
            let final_state = existing.map(|index| self.agents.remove(index).state);
            self.end(agent, final_state);
        } else if let Some(index) = existing {
            self.agents[index] = agent;
        } else {
            self.agents.push(agent);
        }
    }

    fn end(&mut self, agent: AgentRecord, prior_final_state: Option<AgentState>) {
        if let Some(index) = self.board.iter().position(|entry| entry.id == agent.id) {
            let mut existing = self.board.remove(index);
            existing.name = agent.name;
            existing.runtime_ms = agent.session.runtime_ms;
            existing.tickets = agent.session.tickets;
            if let Some(final_state) = prior_final_state {
                existing.final_state = final_state;
                self.board.push(existing);
                if self.board.len() > 3 {
                    self.board.remove(0);
                }
            } else {
                self.board.insert(index, existing);
            }
            return;
        }
        self.board.push(BoardEntry {
            id: agent.id,
            name: agent.name,
            runtime_ms: agent.session.runtime_ms,
            tickets: agent.session.tickets,
            final_state: prior_final_state.unwrap_or(AgentState::Ended),
        });
        if self.board.len() > 3 {
            self.board.remove(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AgentState, SessionStats};

    fn fixture(name: &str) -> AgentStateEvent {
        let text = std::fs::read_to_string(format!(
            "{}/../protocol/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    fn record(id: &str, state: AgentState, runtime_ms: u64, tickets: u64) -> AgentRecord {
        AgentRecord {
            id: id.into(),
            name: format!("cook-{id}"),
            state,
            progress: None,
            state_entered_at: "2026-07-31T16:00:00Z".into(),
            accent_index: 0,
            model: "codex".into(),
            workspace: format!("/work/{id}"),
            session: SessionStats {
                runtime_ms,
                tickets,
            },
        }
    }

    fn upsert(agent: AgentRecord) -> AgentStateEvent {
        AgentStateEvent::Delta {
            version: 1,
            mode: AppMode::Live,
            operation: DeltaOperation::Upsert,
            agent: Some(agent),
            agent_id: None,
        }
    }

    #[test]
    fn every_fixture_reduces_to_exact_content_and_metadata() {
        let mut table = AgentTable::default();
        let snapshot = fixture("snapshot.v1.json");
        let expected_snapshot_agents = match &snapshot {
            AgentStateEvent::Snapshot { agents, .. } => agents.clone(),
            _ => unreachable!(),
        };
        table.apply(snapshot);
        assert_eq!(table.mode(), AppMode::Live);
        assert_eq!(table.source_status(), &SourceStatus::Connected);
        assert_eq!(table.source_diagnostic(), None);
        assert_eq!(
            table
                .agents()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            ["agent-01", "agent-02"]
        );
        assert_eq!(
            table.agents().cloned().collect::<Vec<_>>(),
            expected_snapshot_agents
        );

        table.apply(fixture("heartbeat.v1.json"));
        assert_eq!(
            table.agents().cloned().collect::<Vec<_>>(),
            expected_snapshot_agents
        );

        let upsert = fixture("delta-upsert.v1.json");
        let expected_upsert = match &upsert {
            AgentStateEvent::Delta { agent, .. } => agent.clone().unwrap(),
            _ => unreachable!(),
        };
        table.apply(upsert);
        let agents = table.agents().collect::<Vec<_>>();
        assert_eq!(
            agents
                .iter()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            ["agent-01", "agent-02"]
        );
        assert_eq!(agents[0], &expected_upsert);
        assert_eq!(agents[1], &expected_snapshot_agents[1]);

        table.apply(fixture("delta-remove.v1.json"));
        assert_eq!(
            table
                .agents()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            ["agent-01"]
        );
        assert!(table.board().is_empty());

        table.apply(fixture("snapshot-demo-unsupported.v1.json"));
        assert_eq!(table.mode(), AppMode::Demo);
        assert_eq!(table.source_status(), &SourceStatus::UnsupportedProtocol);
        assert_eq!(table.agents().count(), 0);
        assert!(table.board().is_empty());
        assert_eq!(
            table.source_diagnostic(),
            Some(&SourceDiagnostic {
                observed_protocol: 23,
                supported_protocols: vec![17, 19],
                next_action: "upgrade or downgrade Herdr to a tested release, then retry".into(),
            })
        );
    }

    #[test]
    fn ordered_roster_keeps_existing_position_appends_new_and_removes() {
        let mut table = AgentTable::default();
        table.apply(upsert(record("b", AgentState::Idle, 1, 1)));
        table.apply(upsert(record("a", AgentState::Working, 2, 2)));
        table.apply(upsert(record("b", AgentState::Done, 3, 3)));
        assert_eq!(
            table
                .agents()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(table.agents().next().unwrap().state, AgentState::Done);
        table.apply(AgentStateEvent::Delta {
            version: 1,
            mode: AppMode::Live,
            operation: DeltaOperation::Remove,
            agent: None,
            agent_id: Some("b".into()),
        });
        assert_eq!(
            table
                .agents()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            ["a"]
        );
    }

    #[test]
    fn ended_records_leave_roster_and_board_deduplicates_last_three() {
        let mut table = AgentTable::default();
        let mut prior = record("a", AgentState::Blocked, 10, 1);
        prior.name = "prior-a".into();
        table.apply(upsert(prior));
        table.apply(upsert(record("a", AgentState::Ended, 100, 4)));
        assert_eq!(table.agents().count(), 0);
        assert_eq!(table.board()[0].final_state, AgentState::Blocked);
        assert_eq!(
            (table.board()[0].runtime_ms, table.board()[0].tickets),
            (100, 4)
        );

        table.apply(upsert(record("b", AgentState::Ended, 200, 2)));
        table.apply(upsert(record("c", AgentState::Ended, 300, 3)));
        table.apply(upsert(record("d", AgentState::Ended, 400, 4)));
        assert_eq!(
            table
                .board()
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "c", "d"]
        );

        let mut duplicate = record("c", AgentState::Ended, 333, 33);
        duplicate.name = "updated-c".into();
        table.apply(upsert(duplicate));
        assert_eq!(
            table
                .board()
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "c", "d"]
        );
        assert_eq!(table.board()[1].name, "updated-c");
        assert_eq!(table.board()[1].final_state, AgentState::Ended);
        assert_eq!(
            (table.board()[1].runtime_ms, table.board()[1].tickets),
            (333, 33)
        );
    }

    #[test]
    fn active_agent_ending_again_moves_to_newest_before_board_cap() {
        let mut table = AgentTable::default();
        for id in ["a", "b", "c"] {
            table.apply(upsert(record(id, AgentState::Working, 1, 1)));
            table.apply(upsert(record(id, AgentState::Ended, 10, 1)));
        }

        table.apply(upsert(record("a", AgentState::Blocked, 20, 2)));
        table.apply(upsert(record("a", AgentState::Ended, 50, 5)));
        table.apply(upsert(record("d", AgentState::Working, 30, 3)));
        table.apply(upsert(record("d", AgentState::Ended, 40, 4)));

        assert_eq!(
            table
                .board()
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["c", "a", "d"]
        );
        assert_eq!(table.board()[1].final_state, AgentState::Blocked);
        assert_eq!(
            (table.board()[1].runtime_ms, table.board()[1].tickets),
            (50, 5)
        );
    }

    #[test]
    fn snapshot_duplicate_ids_keep_first_position_and_last_value() {
        let mut first_a = record("a", AgentState::Idle, 10, 1);
        first_a.name = "first-a".into();
        let mut last_a = record("a", AgentState::Blocked, 30, 3);
        last_a.name = "last-a".into();
        table_snapshot_duplicate_assertion(first_a, last_a);
    }

    fn table_snapshot_duplicate_assertion(first_a: AgentRecord, last_a: AgentRecord) {
        let mut table = AgentTable::default();
        table.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents: vec![
                first_a,
                record("b", AgentState::Working, 20, 2),
                last_a.clone(),
            ],
        });
        let agents = table.agents().collect::<Vec<_>>();
        assert_eq!(
            agents
                .iter()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(agents[0], &last_a);
    }
}
