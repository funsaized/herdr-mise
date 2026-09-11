use crate::protocol::{
    AgentRecord, AgentState, AgentStateEvent, AppMode, DeltaOperation, SourceDiagnostic,
    SourceStatus, WorkspaceRecord,
};
use chrono::DateTime;

pub(crate) const BOARD_CAP: usize = 64;

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
    workspaces: Vec<WorkspaceRecord>,
}

#[derive(Debug, PartialEq)]
pub struct ServiceSummary {
    pub working: usize,
    pub blocked: usize,
    pub plated: usize,
    pub unknown: usize,
    pub visible: usize,
    pub hidden_done: usize,
}

impl Default for AgentTable {
    fn default() -> Self {
        Self {
            mode: AppMode::Demo,
            source_status: SourceStatus::UnavailableSocket,
            source_diagnostic: None,
            agents: Vec::new(),
            board: Vec::new(),
            workspaces: Vec::new(),
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
                workspaces,
                ..
            } => {
                if mode != self.mode {
                    self.board.clear();
                }
                self.mode = mode;
                self.source_status = source_status;
                self.source_diagnostic = source_diagnostic;
                self.workspaces = workspaces.unwrap_or_default();
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
    pub fn service_summary(&self) -> ServiceSummary {
        self.service_summary_scoped(None)
    }
    pub fn service_summary_scoped(&self, scope: Option<&str>) -> ServiceSummary {
        let agents = self.scoped_agents(scope).collect::<Vec<_>>();
        let known = agents
            .iter()
            .copied()
            .filter(|agent| agent.state_known != Some(false));
        ServiceSummary {
            working: known
                .clone()
                .filter(|agent| agent.state == AgentState::Working)
                .count(),
            blocked: known
                .clone()
                .filter(|agent| agent.state == AgentState::Blocked)
                .count(),
            plated: known
                .filter(|agent| agent.state == AgentState::Done)
                .count(),
            unknown: agents
                .iter()
                .filter(|agent| agent.state_known == Some(false))
                .count(),
            visible: agents.len(),
            hidden_done: 0,
        }
    }
    pub fn blocked_agents(&self) -> Vec<&AgentRecord> {
        let mut blocked = self
            .agents
            .iter()
            .filter(|agent| agent.state == AgentState::Blocked && agent.state_known != Some(false))
            .collect::<Vec<_>>();
        blocked.sort_by(|a, b| {
            let a_time = DateTime::parse_from_rfc3339(&a.state_entered_at).ok();
            let b_time = DateTime::parse_from_rfc3339(&b.state_entered_at).ok();
            match (a_time, b_time) {
                (Some(a_time), Some(b_time)) => a_time.cmp(&b_time).then_with(|| a.id.cmp(&b.id)),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => a.id.cmp(&b.id),
            }
        });
        blocked
    }

    pub fn workspaces(&self) -> &[WorkspaceRecord] {
        &self.workspaces
    }

    pub fn workspace(&self, id: &str) -> Option<&WorkspaceRecord> {
        self.workspaces.iter().find(|workspace| workspace.id == id)
    }

    pub fn scoped_agents<'a>(
        &'a self,
        scope: Option<&'a str>,
    ) -> impl Iterator<Item = &'a AgentRecord> + 'a {
        self.agents.iter().filter(move |agent| match scope {
            Some(id) => agent.workspace_id.as_deref() == Some(id),
            None => true,
        })
    }

    pub fn blocked_elsewhere(&self, scope: Option<&str>) -> usize {
        match scope {
            Some(id) => self
                .agents
                .iter()
                .filter(|agent| {
                    agent.state == AgentState::Blocked && agent.workspace_id.as_deref() != Some(id)
                })
                .count(),
            None => 0,
        }
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
        if prior_final_state.is_none() {
            if let Some(index) = self
                .board
                .iter()
                .rposition(|entry| same_identity(&entry.id, &agent.id))
            {
                let mut existing = self.board.remove(index);
                existing.name = agent.name;
                existing.runtime_ms = agent.session.runtime_ms;
                existing.tickets = agent.session.tickets;
                self.board.insert(index, existing);
                return;
            }
        }
        let id = if prior_final_state.is_some()
            && self
                .board
                .iter()
                .any(|entry| same_identity(&entry.id, &agent.id))
        {
            format!("{}:{}", agent.id, self.board.len())
        } else {
            agent.id.clone()
        };
        self.board.push(BoardEntry {
            id,
            name: agent.name,
            runtime_ms: agent.session.runtime_ms,
            tickets: agent.session.tickets,
            final_state: prior_final_state.unwrap_or(AgentState::Ended),
        });
        self.trim_board();
    }

    fn trim_board(&mut self) {
        while self.board.len() > BOARD_CAP {
            self.board.remove(0);
        }
    }
}

fn same_identity(entry_id: &str, agent_id: &str) -> bool {
    entry_id == agent_id || entry_id.starts_with(&format!("{agent_id}:"))
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
            state_known: None,
            id: id.into(),
            pane_id: None,
            agent_kind: None,
            name: format!("cook-{id}"),
            state,
            progress: None,
            state_entered_at: "2026-07-31T16:00:00Z".into(),
            accent_index: 0,
            model: "codex".into(),
            workspace: format!("/work/{id}"),
            workspace_id: None,
            session: SessionStats {
                tickets_available: None,
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
                supported_protocols: vec![17, 19, 20],
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
    fn service_summary_excludes_unknown_and_orders_blocked_oldest_then_id() {
        let mut unknown = record("unknown", AgentState::Blocked, 0, 0);
        unknown.state_known = Some(false);
        let mut newer = record("z", AgentState::Blocked, 0, 0);
        newer.state_entered_at = "2026-07-31T16:02:00Z".into();
        let mut tied_b = record("b", AgentState::Blocked, 0, 0);
        tied_b.state_entered_at = "2026-07-31T16:01:00Z".into();
        let mut tied_a = record("a", AgentState::Blocked, 0, 0);
        tied_a.state_entered_at = tied_b.state_entered_at.clone();
        let mut table = AgentTable::default();
        for agent in [
            record("working", AgentState::Working, 0, 0),
            record("done", AgentState::Done, 0, 0),
            newer,
            tied_b,
            tied_a,
            unknown,
        ] {
            table.apply(upsert(agent));
        }
        assert_eq!(
            table.service_summary(),
            ServiceSummary {
                working: 1,
                blocked: 3,
                plated: 1,
                unknown: 1,
                visible: 6,
                hidden_done: 0,
            }
        );
        assert_eq!(
            table
                .blocked_agents()
                .iter()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "z"]
        );
    }

    #[test]
    fn ended_records_leave_roster_and_board_deduplicates_to_cap() {
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
            ["a", "b", "c", "d"]
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
            ["a", "b", "c", "d"]
        );
        assert_eq!(table.board()[2].name, "updated-c");
        assert_eq!(table.board()[2].final_state, AgentState::Ended);
        assert_eq!(
            (table.board()[2].runtime_ms, table.board()[2].tickets),
            (333, 33)
        );

        for index in 0..=BOARD_CAP {
            table.apply(upsert(record(
                &format!("cap-{index}"),
                AgentState::Ended,
                index as u64,
                1,
            )));
        }
        assert_eq!(table.board().len(), BOARD_CAP);
        assert_eq!(table.board()[0].id, "cap-1");
        assert_eq!(table.board()[BOARD_CAP - 1].id, format!("cap-{BOARD_CAP}"));
    }

    #[test]
    fn reused_pane_keeps_each_death_on_the_board() {
        let mut table = AgentTable::default();
        table.apply(upsert(record("a", AgentState::Working, 1, 1)));
        table.apply(upsert(record("a", AgentState::Ended, 10, 1)));
        table.apply(upsert(record("a", AgentState::Blocked, 20, 2)));
        table.apply(upsert(record("a", AgentState::Ended, 50, 5)));
        assert_eq!(
            table
                .board()
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "a:1"]
        );
        assert_eq!(table.board()[1].final_state, AgentState::Blocked);
        assert_eq!(
            (table.board()[1].runtime_ms, table.board()[1].tickets),
            (50, 5)
        );

        let mut replay = record("a", AgentState::Ended, 99, 9);
        replay.name = "replay-a".into();
        table.apply(upsert(replay));
        assert_eq!(table.board().len(), 2);
        assert_eq!(table.board()[1].name, "replay-a");
        assert_eq!(table.board()[1].final_state, AgentState::Blocked);
    }

    #[test]
    fn snapshot_duplicate_ids_keep_first_position_and_last_value() {
        let mut first_a = record("a", AgentState::Idle, 10, 1);
        first_a.name = "first-a".into();
        let mut last_a = record("a", AgentState::Blocked, 30, 3);
        last_a.name = "last-a".into();
        table_snapshot_duplicate_assertion(first_a, last_a);
    }

    #[test]
    fn workspace_scope_filters_agents_and_counts_global_blocked_elsewhere() {
        let mut here = record("here", AgentState::Working, 0, 0);
        here.workspace_id = Some("ws-1".into());
        let mut elsewhere = record("elsewhere", AgentState::Blocked, 0, 0);
        elsewhere.workspace_id = Some("ws-2".into());
        let mut table = AgentTable::default();
        table.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents: vec![here, elsewhere],
            workspaces: Some(vec![
                WorkspaceRecord {
                    id: "ws-1".into(),
                    label: "same".into(),
                },
                WorkspaceRecord {
                    id: "ws-2".into(),
                    label: "same".into(),
                },
                WorkspaceRecord {
                    id: "ws-empty".into(),
                    label: "empty".into(),
                },
            ]),
        });
        assert_eq!(
            table
                .scoped_agents(Some("ws-1"))
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>(),
            ["here"]
        );
        assert_eq!(table.scoped_agents(Some("ws-empty")).count(), 0);
        assert_eq!(table.blocked_elsewhere(Some("ws-1")), 1);
        assert_eq!(table.blocked_elsewhere(None), 0);
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
            workspaces: None,
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
