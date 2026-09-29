use chrono::DateTime;
use std::collections::{HashMap, HashSet, VecDeque};

use crate::protocol::{
    AgentRecord, AgentState, AgentStateEvent, AppMode, DeltaOperation, SourceStatus,
    WorkspaceRecord,
};

pub const RECAP_CAP: usize = 4096;

#[derive(Debug, Default)]
pub struct ServiceRecap {
    closed: VecDeque<Closed>,
    current: HashMap<String, Current>,
    anchor_ms: Option<i64>,
    mode: Option<AppMode>,
    truncated: bool,
}

#[derive(Debug, Clone)]
struct Current {
    agent_name: String,
    state: AgentState,
    entered_at: String,
    workspace_id: Option<String>,
    workspace_label: String,
    start_ms: Option<i64>,
    wait_start_ms: Option<i64>,
    wait_accumulated_ms: u64,
    scoped_wait_accumulated_ms: u64,
    occurrence: bool,
    partial: bool,
    interrupted: bool,
}

#[derive(Debug)]
struct Closed {
    agent_name: String,
    workspace_id: Option<String>,
    workspace_label: String,
    state: Option<AgentState>,
    start_ms: Option<i64>,
    duration_ms: u64,
    scoped_wait_ms: Option<u64>,
    global_wait_ms: Option<u64>,
    occurrence: bool,
    ended: bool,
    agent_id: String,
    entered_at: String,
    gap: bool,
    partial: bool,
    interrupted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecapWorkspace {
    pub id: Option<String>,
    pub label: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct RecapSummary {
    pub start_ms: Option<i64>,
    pub idle_ms: u64,
    pub working_ms: u64,
    pub blocked_ms: u64,
    pub done_ms: u64,
    pub ended_count: usize,
    pub plated_count: usize,
    pub blocked_occurrences: usize,
    pub median_wait_ms: Option<f64>,
    pub worst_wait_ms: Option<u64>,
    pub worst_wait_agent: Option<String>,
    pub worst_wait_name: Option<String>,
    pub partial: bool,
    pub truncated: bool,
    pub interrupted: bool,
}

#[derive(Debug, PartialEq)]
pub struct RecapAgentRow {
    pub id: String,
    pub name: String,
    pub summary: RecapSummary,
}

#[derive(Default)]
struct Accumulator {
    summary: RecapSummary,
    waits: Vec<u64>,
}

impl Accumulator {
    fn add_wait(&mut self, wait: u64, id: &str, name: &str) {
        self.waits.push(wait);
        if self.summary.worst_wait_ms.is_none_or(|worst| wait > worst) {
            self.summary.worst_wait_ms = Some(wait);
            self.summary.worst_wait_agent = Some(id.to_owned());
            self.summary.worst_wait_name = Some(name.to_owned());
        }
    }

    fn add_start(&mut self, start: Option<i64>) {
        if let Some(start) = start {
            self.summary.start_ms = Some(self.summary.start_ms.map_or(start, |old| old.min(start)));
        }
    }

    fn closed(&mut self, entry: &Closed, scoped: bool) {
        self.summary.partial |= entry.interrupted || (scoped && entry.partial);
        self.summary.interrupted |= entry.interrupted;
        self.add_start(entry.start_ms);
        if let Some(state) = &entry.state {
            add_duration(&mut self.summary, state, entry.duration_ms);
            if entry.occurrence && *state == AgentState::Blocked {
                self.summary.blocked_occurrences += 1;
            }
            if entry.occurrence && *state == AgentState::Done {
                self.summary.plated_count += 1;
            }
        }
        let wait = if scoped {
            entry.scoped_wait_ms
        } else {
            entry.global_wait_ms
        };
        if let Some(wait) = wait {
            self.add_wait(wait, &entry.agent_id, &entry.agent_name);
        }
        if entry.ended {
            self.summary.ended_count += 1;
        }
    }

    fn current(&mut self, id: &str, current: &Current, scoped: bool, now_ms: i64) {
        self.summary.partial |=
            current.start_ms.is_some() || current.interrupted || (scoped && current.partial);
        self.summary.interrupted |= current.interrupted;
        self.add_start(current.start_ms);
        if let Some(start) = current.start_ms {
            add_duration(&mut self.summary, &current.state, elapsed(start, now_ms));
        }
        if current.occurrence {
            match current.state {
                AgentState::Blocked => self.summary.blocked_occurrences += 1,
                AgentState::Done => self.summary.plated_count += 1,
                _ => {}
            }
        }
        if current.state == AgentState::Blocked {
            if scoped {
                if current.start_ms.is_some() || current.scoped_wait_accumulated_ms > 0 {
                    let wait = current
                        .scoped_wait_accumulated_ms
                        .saturating_add(current.start_ms.map_or(0, |start| elapsed(start, now_ms)));
                    self.add_wait(wait, id, &current.agent_name);
                }
            } else if current.wait_start_ms.is_some() || current.wait_accumulated_ms > 0 {
                let wait = current.wait_accumulated_ms.saturating_add(
                    current
                        .wait_start_ms
                        .map_or(0, |start| elapsed(start, now_ms)),
                );
                self.add_wait(wait, id, &current.agent_name);
            }
        }
    }

    fn finish(mut self) -> RecapSummary {
        self.waits.sort_unstable();
        if !self.waits.is_empty() {
            let middle = self.waits.len() / 2;
            self.summary.median_wait_ms = Some(if self.waits.len().is_multiple_of(2) {
                (self.waits[middle - 1] as f64 / 2.0) + (self.waits[middle] as f64 / 2.0)
            } else {
                self.waits[middle] as f64
            });
        }
        self.summary
    }
}

fn elapsed(start: i64, end: i64) -> u64 {
    end.saturating_sub(start).max(0) as u64
}

fn same_generation(previous: &str, incoming: &str) -> bool {
    previous == incoming
        || DateTime::parse_from_rfc3339(incoming)
            .ok()
            .zip(DateTime::parse_from_rfc3339(previous).ok())
            .is_some_and(|(incoming, previous)| incoming <= previous)
}

impl ServiceRecap {
    fn push(&mut self, closed: Closed) {
        if self.closed.len() == RECAP_CAP {
            self.closed.pop_front();
            self.truncated = true;
        }
        self.closed.push_back(closed);
    }

    fn close(&mut self, id: &str, now_ms: i64, finish_wait: bool, moved: bool, gap: bool) {
        if let Some(current) = self.current.remove(id) {
            let blocked = current.state == AgentState::Blocked;
            let duration_ms = current
                .start_ms
                .map(|start| elapsed(start, now_ms))
                .unwrap_or(0);
            self.push(Closed {
                agent_name: current.agent_name,
                workspace_id: current.workspace_id,
                workspace_label: current.workspace_label,
                state: Some(current.state),
                start_ms: current.start_ms,
                duration_ms,
                scoped_wait_ms: ((finish_wait || moved)
                    && blocked
                    && (current.start_ms.is_some() || current.scoped_wait_accumulated_ms > 0))
                    .then_some(
                        current
                            .scoped_wait_accumulated_ms
                            .saturating_add(duration_ms),
                    ),
                global_wait_ms: if finish_wait
                    && blocked
                    && (current.wait_start_ms.is_some() || current.wait_accumulated_ms > 0)
                {
                    Some(
                        current.wait_accumulated_ms.saturating_add(
                            current
                                .wait_start_ms
                                .map_or(0, |start| elapsed(start, now_ms)),
                        ),
                    )
                } else {
                    None
                },
                occurrence: current.occurrence,
                ended: false,
                agent_id: id.to_owned(),
                entered_at: current.entered_at,
                gap: false,
                partial: current.partial || moved,
                interrupted: current.interrupted || gap,
            });
        }
    }

    fn record(&mut self, agent: &AgentRecord, now_ms: i64, catalog: &[WorkspaceRecord]) {
        let id = &agent.id;
        if agent.state == AgentState::Ended {
            let active = self.current.contains_key(id);
            let workspace_label = self
                .current
                .get(id)
                .filter(|c| c.workspace_id == agent.workspace_id)
                .map_or_else(|| label(agent, catalog), |c| c.workspace_label.clone());
            self.close(id, now_ms, true, false, false);
            // A replayed terminal record must not count as another outcome.
            if !active
                && self.closed.iter().any(|entry| {
                    entry.ended
                        && entry.agent_id == *id
                        && entry.entered_at == agent.state_entered_at
                })
            {
                return;
            }
            self.push(Closed {
                agent_name: agent.name.clone(),
                workspace_id: agent.workspace_id.clone(),
                workspace_label,
                state: None,
                start_ms: None,
                duration_ms: 0,
                scoped_wait_ms: None,
                global_wait_ms: None,
                occurrence: false,
                ended: true,
                agent_id: id.clone(),
                entered_at: agent.state_entered_at.clone(),
                gap: false,
                partial: false,
                interrupted: false,
            });
            return;
        }
        if agent.state_known == Some(false) {
            self.close(id, now_ms, false, false, false);
            return;
        }
        if let Some(current) = self.current.get_mut(id) {
            if current.state == agent.state
                && same_generation(&current.entered_at, &agent.state_entered_at)
                && current.workspace_id == agent.workspace_id
            {
                current.agent_name = agent.name.clone();
                if current.start_ms.is_none() {
                    current.start_ms = Some(now_ms);
                    current.wait_start_ms =
                        (current.state == AgentState::Blocked).then_some(now_ms);
                    current.partial = true;
                }
                if let Some(label) = catalog
                    .iter()
                    .find(|w| Some(w.id.as_str()) == agent.workspace_id.as_deref())
                {
                    current.workspace_label = label.label.clone();
                }
                return;
            }
        }
        let moved = self
            .current
            .get(id)
            .is_some_and(|current| current.workspace_id != agent.workspace_id);
        let same_occurrence = self.current.get(id).is_some_and(|current| {
            current.state == agent.state
                && same_generation(&current.entered_at, &agent.state_entered_at)
        });
        let workspace_label = if catalog.is_empty() {
            self.current
                .get(id)
                .filter(|c| c.workspace_id == agent.workspace_id)
                .map_or_else(|| label(agent, catalog), |c| c.workspace_label.clone())
        } else {
            label(agent, catalog)
        };
        let wait_start_ms = self.current.get(id).and_then(|current| {
            (current.state == AgentState::Blocked
                && agent.state == AgentState::Blocked
                && same_generation(&current.entered_at, &agent.state_entered_at))
            .then_some(current.wait_start_ms)
            .flatten()
        });
        let continuing_wait = same_occurrence && agent.state == AgentState::Blocked;
        let wait_accumulated_ms = if continuing_wait {
            self.current
                .get(id)
                .map_or(0, |current| current.wait_accumulated_ms)
        } else {
            0
        };
        let scoped_wait_accumulated_ms = if continuing_wait && !moved {
            self.current
                .get(id)
                .map_or(0, |current| current.scoped_wait_accumulated_ms)
        } else {
            0
        };
        let partial = (moved || self.current.get(id).is_some_and(|current| current.partial))
            && same_occurrence;
        let interrupted = self
            .current
            .get(id)
            .is_some_and(|current| current.interrupted)
            && same_occurrence;
        self.close(id, now_ms, !continuing_wait, moved, false);
        if self.current.len() == RECAP_CAP {
            // Keep the newest observed agents; an evicted agent's open duration is unknown.
            if let Some(oldest) = self
                .current
                .iter()
                .min_by_key(|(_, c)| c.start_ms)
                .map(|(id, _)| id.clone())
            {
                self.current.remove(&oldest);
                self.truncated = true;
            }
        }
        self.current.insert(
            id.clone(),
            Current {
                agent_name: agent.name.clone(),
                state: agent.state.clone(),
                entered_at: agent.state_entered_at.clone(),
                workspace_id: agent.workspace_id.clone(),
                workspace_label,
                start_ms: Some(now_ms),
                wait_start_ms: if agent.state == AgentState::Blocked {
                    Some(wait_start_ms.unwrap_or(now_ms))
                } else {
                    None
                },
                wait_accumulated_ms,
                scoped_wait_accumulated_ms,
                occurrence: !same_occurrence,
                partial,
                interrupted,
            },
        );
    }

    /// Discard unobserved time, including the interval since the last healthy receipt.
    pub fn gap_at(&mut self, _now_ms: i64) {
        let end = self.anchor_ms.take();
        if let Some(end) = end {
            for id in self.current.keys().cloned().collect::<Vec<_>>() {
                let saved = self.current.get(&id).cloned();
                self.close(&id, end, false, false, true);
                if let Some(mut saved) = saved {
                    if let Some(start) = saved.wait_start_ms {
                        saved.wait_accumulated_ms = saved
                            .wait_accumulated_ms
                            .saturating_add(elapsed(start, end));
                    }
                    if saved.state == AgentState::Blocked {
                        if let Some(start) = saved.start_ms {
                            saved.scoped_wait_accumulated_ms = saved
                                .scoped_wait_accumulated_ms
                                .saturating_add(elapsed(start, end));
                        }
                    }
                    saved.start_ms = None;
                    saved.wait_start_ms = None;
                    saved.occurrence = false;
                    saved.partial = true;
                    saved.interrupted = true;
                    self.current.insert(id, saved);
                }
            }
        }
        if !self.closed.back().is_some_and(|entry| entry.gap) {
            self.push(Closed {
                agent_name: String::new(),
                workspace_id: None,
                workspace_label: String::new(),
                state: None,
                start_ms: None,
                duration_ms: 0,
                scoped_wait_ms: None,
                global_wait_ms: None,
                occurrence: false,
                ended: false,
                agent_id: String::new(),
                entered_at: String::new(),
                gap: true,
                partial: true,
                interrupted: true,
            });
        }
    }

    pub fn apply_at(&mut self, event: &AgentStateEvent, now_ms: i64) {
        match event {
            AgentStateEvent::Snapshot {
                mode,
                source_status,
                agents,
                workspaces,
                ..
            } => {
                if self.mode.as_ref().is_some_and(|prior| prior != mode) {
                    *self = Self::default();
                }
                self.mode = Some(mode.clone());
                if *mode == AppMode::Live && *source_status != SourceStatus::Connected {
                    self.gap_at(now_ms);
                    return;
                }
                let seen: HashSet<_> = agents.iter().map(|agent| agent.id.as_str()).collect();
                for id in self
                    .current
                    .keys()
                    .filter(|id| !seen.contains(id.as_str()))
                    .cloned()
                    .collect::<Vec<_>>()
                {
                    self.close(&id, now_ms, true, false, false);
                }
                for agent in agents {
                    self.record(agent, now_ms, workspaces.as_deref().unwrap_or(&[]));
                }
                self.anchor_ms = Some(now_ms);
            }
            AgentStateEvent::Delta {
                mode,
                operation,
                agent,
                agent_id,
                ..
            } => {
                if self.mode.as_ref() != Some(mode) {
                    *self = Self::default();
                    self.mode = Some(mode.clone());
                    return;
                }
                if self.anchor_ms.is_none() {
                    return;
                }
                match operation {
                    DeltaOperation::Upsert => {
                        if let Some(agent) = agent {
                            self.record(agent, now_ms, &[]);
                        }
                    }
                    DeltaOperation::Remove => {
                        if let Some(id) = agent_id {
                            self.close(id, now_ms, true, false, false);
                        }
                    }
                }
                self.anchor_ms = Some(now_ms);
            }
            AgentStateEvent::Heartbeat { .. } => {}
        }
    }

    fn evaluate(
        &self,
        scope: Option<Option<&str>>,
        now_ms: i64,
        with_rows: bool,
    ) -> (RecapSummary, Vec<RecapAgentRow>) {
        let mut total = Accumulator::default();
        total.summary.truncated = self.truncated;
        total.summary.partial = self.truncated;
        let mut rows: HashMap<String, (String, Accumulator)> = HashMap::new();
        for entry in &self.closed {
            if entry.gap {
                total.summary.partial = true;
                total.summary.interrupted = true;
            } else if in_scope(scope, entry.workspace_id.as_deref()) {
                total.closed(entry, scope.is_some());
                if with_rows {
                    let (name, row) = rows
                        .entry(entry.agent_id.clone())
                        .or_insert_with(|| (entry.agent_name.clone(), Accumulator::default()));
                    *name = entry.agent_name.clone();
                    row.closed(entry, scope.is_some());
                }
            }
        }
        for (id, current) in &self.current {
            if in_scope(scope, current.workspace_id.as_deref()) {
                total.current(id, current, scope.is_some(), now_ms);
                if with_rows {
                    let (name, row) = rows
                        .entry(id.clone())
                        .or_insert_with(|| (current.agent_name.clone(), Accumulator::default()));
                    *name = current.agent_name.clone();
                    row.current(id, current, scope.is_some(), now_ms);
                }
            }
        }
        let mut rows = rows
            .into_iter()
            .map(|(id, (name, mut row))| {
                row.summary.truncated = self.truncated;
                row.summary.partial |= self.truncated;
                RecapAgentRow {
                    id,
                    name,
                    summary: row.finish(),
                }
            })
            .collect::<Vec<_>>();
        if with_rows {
            rows.sort_by(|a, b| a.id.cmp(&b.id));
        }
        (total.finish(), rows)
    }

    pub fn summary(&self, scope: Option<&str>, now_ms: i64) -> RecapSummary {
        self.evaluate(scope.map(Some), now_ms, false).0
    }

    pub fn rows(&self, scope: Option<&str>, now_ms: i64) -> Vec<RecapAgentRow> {
        self.evaluate(scope.map(Some), now_ms, true).1
    }

    pub fn summary_missing(&self, now_ms: i64) -> RecapSummary {
        self.evaluate(Some(None), now_ms, false).0
    }

    pub fn rows_missing(&self, now_ms: i64) -> Vec<RecapAgentRow> {
        self.evaluate(Some(None), now_ms, true).1
    }

    /// Scopes represented by retained history or current agents, not the unbounded feed catalog.
    pub fn workspaces(&self) -> Vec<RecapWorkspace> {
        let mut result = Vec::new();
        let mut seen = HashSet::new();
        for (id, label) in self
            .current
            .values()
            .map(|c| (&c.workspace_id, &c.workspace_label))
            .chain(
                self.closed
                    .iter()
                    .rev()
                    .filter(|c| !c.gap)
                    .map(|c| (&c.workspace_id, &c.workspace_label)),
            )
        {
            if seen.insert(id.clone()) {
                result.push(RecapWorkspace {
                    id: id.clone(),
                    label: label.clone(),
                });
                if result.len() == RECAP_CAP {
                    break;
                }
            }
        }
        result
    }
}

fn in_scope(scope: Option<Option<&str>>, workspace: Option<&str>) -> bool {
    scope.is_none_or(|id| workspace == id)
}

fn label(agent: &AgentRecord, catalog: &[WorkspaceRecord]) -> String {
    agent.workspace_id.as_deref().map_or_else(
        || "Missing workspace".into(),
        |id| {
            catalog
                .iter()
                .find(|w| w.id == id)
                .map_or_else(|| id.to_owned(), |w| w.label.clone())
        },
    )
}

fn add_duration(summary: &mut RecapSummary, state: &AgentState, ms: u64) {
    let value = match state {
        AgentState::Idle => &mut summary.idle_ms,
        AgentState::Working => &mut summary.working_ms,
        AgentState::Blocked => &mut summary.blocked_ms,
        AgentState::Done => &mut summary.done_ms,
        AgentState::Ended => return,
    };
    *value = value.saturating_add(ms);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::SessionStats;

    fn agent(id: &str, state: AgentState, entered: &str, workspace: &str) -> AgentRecord {
        AgentRecord {
            id: id.into(),
            state,
            state_entered_at: entered.into(),
            workspace_id: Some(workspace.into()),
            state_known: Some(true),
            pane_id: None,
            agent_kind: None,
            name: id.into(),
            progress: None,
            accent_index: 0,
            model: String::new(),
            workspace: String::new(),
            session: SessionStats {
                runtime_ms: 999_999,
                tickets: 0,
                tickets_available: None,
            },
        }
    }

    fn snapshot(
        agents: Vec<AgentRecord>,
        mode: AppMode,
        source_status: SourceStatus,
    ) -> AgentStateEvent {
        AgentStateEvent::Snapshot {
            version: 1,
            mode,
            source_status,
            source_diagnostic: None,
            agents,
            workspaces: None,
        }
    }

    fn upsert(agent: AgentRecord, mode: AppMode) -> AgentStateEvent {
        AgentStateEvent::Delta {
            version: 1,
            mode,
            operation: DeltaOperation::Upsert,
            agent: Some(agent),
            agent_id: None,
        }
    }

    #[test]
    fn service_recap_excludes_gaps_and_preserves_retained_outcomes() {
        use crate::tui::state::AgentTable;
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/service-recap-observations.json"
        ))
        .unwrap();
        let mut shared = ServiceRecap::default();
        for step in fixture["transitions"].as_array().unwrap() {
            let state = match step["state"].as_str().unwrap() {
                "working" => AgentState::Working,
                "blocked" => AgentState::Blocked,
                "done" => AgentState::Done,
                "ended" => AgentState::Ended,
                other => panic!("unexpected shared state {other}"),
            };
            shared.apply_at(
                &snapshot(
                    vec![agent(
                        "a",
                        state,
                        step["generation"].as_str().unwrap(),
                        step["workspace"].as_str().unwrap(),
                    )],
                    AppMode::Live,
                    SourceStatus::Connected,
                ),
                step["at"].as_i64().unwrap(),
            );
        }
        let result = shared.summary(None, 5_000);
        assert_eq!(
            (
                result.working_ms,
                result.blocked_ms,
                result.median_wait_ms,
                result.blocked_occurrences,
                result.plated_count,
                result.ended_count
            ),
            (2_000, 1_000, Some(1_000.0), 1, 1, 1)
        );
        let mut table = AgentTable::default();
        table.apply_at(
            snapshot(
                vec![agent("a", AgentState::Blocked, "1", "w1")],
                AppMode::Live,
                SourceStatus::Connected,
            ),
            100,
        );
        table.apply_at(
            upsert(agent("a", AgentState::Blocked, "1", "w1"), AppMode::Live),
            120,
        );
        table.apply_at(
            upsert(agent("a", AgentState::Blocked, "1", "w2"), AppMode::Live),
            130,
        );
        table.apply_at(
            upsert(agent("a", AgentState::Working, "2", "w2"), AppMode::Live),
            150,
        );
        table.apply_at(
            upsert(agent("a", AgentState::Working, "3", "w2"), AppMode::Live),
            160,
        );
        table.apply_at(
            upsert(agent("a", AgentState::Ended, "4", "w2"), AppMode::Live),
            170,
        );
        table.apply_at(
            upsert(agent("a", AgentState::Ended, "4", "w2"), AppMode::Live),
            171,
        );
        let all = table.recap().summary(None, 1000);
        assert_eq!(
            (
                all.blocked_ms,
                all.working_ms,
                all.median_wait_ms,
                all.ended_count
            ),
            (50, 20, Some(50.0), 1)
        );
        assert_eq!(
            (
                table.recap().summary(Some("w1"), 1000).blocked_ms,
                table.recap().summary(Some("w2"), 1000).blocked_ms
            ),
            (30, 20)
        );
        assert_eq!(
            table.recap().summary(Some("w2"), 1000).median_wait_ms,
            Some(20.0)
        );
        assert_eq!(
            table.recap().summary(Some("w1"), 1000).median_wait_ms,
            Some(30.0)
        );
        assert!(table.recap().summary(Some("w1"), 1000).partial);
        assert!(table.recap().summary(Some("w2"), 1000).partial);
        assert!(!all.partial);
        assert_eq!(
            (
                all.blocked_occurrences,
                all.plated_count,
                all.start_ms,
                all.worst_wait_ms,
                all.worst_wait_agent.as_deref(),
                all.worst_wait_name.as_deref()
            ),
            (1, 0, Some(100), Some(50), Some("a"), Some("a"))
        );
        table.apply_at(
            snapshot(
                vec![agent("b", AgentState::Blocked, "5", "w1")],
                AppMode::Live,
                SourceStatus::Connected,
            ),
            200,
        );
        table.apply_at(AgentStateEvent::Heartbeat { version: 1 }, 205);
        assert_eq!(table.recap().summary(None, 299).blocked_ms, 149);
        table.gap_at(300);
        assert_eq!(table.recap().summary(None, 300).blocked_ms, 50);
        assert!(table.recap().summary(None, 300).partial);
        table.apply_at(
            snapshot(
                vec![agent("b", AgentState::Blocked, "5", "w1")],
                AppMode::Live,
                SourceStatus::Timeout,
            ),
            400,
        );
        table.apply_at(
            snapshot(
                vec![agent("c", AgentState::Blocked, "6", "w1")],
                AppMode::Demo,
                SourceStatus::UnavailableSocket,
            ),
            500,
        );
        table.apply_at(
            upsert(agent("c", AgentState::Working, "7", "w1"), AppMode::Demo),
            510,
        );
        assert_eq!(table.recap().summary(None, 510).blocked_ms, 10);
        let mut unknown = agent("u", AgentState::Blocked, "8", "w1");
        unknown.state_known = Some(false);
        table.apply_at(upsert(unknown, AppMode::Demo), 520);
        assert_eq!(table.recap().summary(None, 520).blocked_ms, 10);
        assert_eq!(table.recap().summary(None, 520).ended_count, 0);
        table.apply_at(
            upsert(agent("d", AgentState::Blocked, "9", "w1"), AppMode::Demo),
            530,
        );
        table.apply_at(
            upsert(agent("d", AgentState::Working, "10", "w1"), AppMode::Demo),
            541,
        );
        assert_eq!(table.recap().summary(None, 541).median_wait_ms, Some(10.5));
        assert_eq!(
            table.recap().summary(Some("w1"), 541).median_wait_ms,
            Some(10.5)
        );
        table.apply_at(
            upsert(agent("e", AgentState::Blocked, "11", "w1"), AppMode::Demo),
            550,
        );
        table.apply_at(
            upsert(agent("e", AgentState::Working, "12", "w1"), AppMode::Demo),
            559,
        );
        assert_eq!(table.recap().summary(None, 559).median_wait_ms, Some(10.0));
        missing_workspace_and_matching_real_id_have_distinct_scopes();
    }

    #[test]
    fn service_recap_bounds_retention_across_agent_and_workspace_churn() {
        let mut recap = ServiceRecap::default();
        recap.apply_at(
            &snapshot(Vec::new(), AppMode::Live, SourceStatus::Connected),
            0,
        );
        for n in 0..=RECAP_CAP {
            let id = format!("agent-{n}");
            let workspace = format!("workspace-{n}");
            recap.apply_at(
                &upsert(
                    agent(&id, AgentState::Blocked, "1", &workspace),
                    AppMode::Live,
                ),
                n as i64 * 10,
            );
            recap.apply_at(
                &upsert(
                    agent(&id, AgentState::Ended, "2", &workspace),
                    AppMode::Live,
                ),
                n as i64 * 10 + 2,
            );
        }
        assert_eq!(recap.closed.len(), RECAP_CAP);
        assert!(recap.current.is_empty());
        assert!(recap.workspaces().len() <= RECAP_CAP);
        assert_eq!(recap.workspaces()[0].label, "workspace-4096");
        assert!(recap.summary(None, i64::MAX).truncated);
        assert!(recap.summary(Some("workspace-4096"), i64::MAX).ended_count == 1);
        for n in 0..=RECAP_CAP {
            recap.apply_at(
                &upsert(
                    agent(
                        &format!("active-{n}"),
                        AgentState::Working,
                        "1",
                        &format!("new-workspace-{n}"),
                    ),
                    AppMode::Live,
                ),
                50_000 + n as i64,
            );
        }
        assert_eq!(recap.current.len(), RECAP_CAP);
        assert!(recap.workspaces().len() <= RECAP_CAP);
        assert!(recap.summary(None, 60_000).partial);
        assert!(recap.rows(None, 60_000).len() <= RECAP_CAP * 2);
    }

    #[test]
    fn delayed_failure_rolls_back_heartbeat_and_recovery_reuses_occurrence() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/service-recap-observations.json"
        ))
        .unwrap();
        let delayed = &fixture["delayedFailure"];
        let healthy = delayed["healthy"].as_i64().unwrap();
        let notification = delayed["notification"].as_i64().unwrap();
        let recovery = delayed["recovery"].as_i64().unwrap();
        let mut recap = ServiceRecap::default();
        recap.apply_at(
            &snapshot(
                vec![agent("a", AgentState::Blocked, "1", "w")],
                AppMode::Live,
                SourceStatus::Connected,
            ),
            healthy,
        );
        recap.apply_at(
            &upsert(agent("a", AgentState::Blocked, "1", "w"), AppMode::Live),
            notification,
        );
        recap.apply_at(
            &AgentStateEvent::Heartbeat { version: 1 },
            delayed["failedPolls"][2].as_i64().unwrap(),
        );
        assert_eq!(recap.summary(None, 7000).blocked_ms, 6000);
        assert_eq!(recap.summary(None, 7000).median_wait_ms, Some(6000.0));
        assert_eq!(recap.summary(None, 7000).blocked_occurrences, 1);
        recap.gap_at(7000);
        assert_eq!(recap.summary(None, 7000).blocked_ms, 3000);
        assert_eq!(recap.summary(None, 7000).median_wait_ms, Some(3000.0));
        assert!(recap.summary(None, 7000).interrupted);
        assert!(recap.rows(None, 7000)[0].summary.interrupted);
        assert_eq!(recap.workspaces().len(), 1);
        recap.apply_at(
            &snapshot(
                vec![agent("a", AgentState::Blocked, "1", "w")],
                AppMode::Live,
                SourceStatus::Connected,
            ),
            recovery + 1000,
        );
        assert_eq!(recap.summary(None, 8500).blocked_occurrences, 1);
        assert_eq!(recap.summary(None, 8500).blocked_ms, 3500);
        assert_eq!(recap.summary(None, 8500).median_wait_ms, Some(3500.0));
        recap.apply_at(
            &upsert(agent("a", AgentState::Working, "2", "w"), AppMode::Live),
            9000,
        );
        assert_eq!(recap.summary(None, 9000).blocked_ms, 4000);
        assert_eq!(recap.summary(None, 9000).blocked_occurrences, 1);
        assert_eq!(recap.summary(None, 9000).median_wait_ms, Some(4000.0));
        assert_eq!(recap.summary(Some("w"), 9000).median_wait_ms, Some(4000.0));
        assert!(recap.summary(None, 9000).partial);
        recap.apply_at(
            &snapshot(
                vec![agent("a", AgentState::Done, "3", "w")],
                AppMode::Demo,
                SourceStatus::UnavailableSocket,
            ),
            10_000,
        );
        assert_eq!(recap.summary(None, 10_000).blocked_ms, 0);
        assert_eq!(recap.summary(None, 10_000).plated_count, 1);
        assert!(recap.summary(None, 10_000).partial);
        recap.apply_at(
            &snapshot(Vec::new(), AppMode::Live, SourceStatus::Timeout),
            11_000,
        );
        assert!(recap.summary(None, 11_000).partial);
        assert!(recap.workspaces().is_empty());
    }

    #[test]
    fn missing_workspace_scope_and_catalog_labels_survive_roster_removal() {
        let mut recap = ServiceRecap::default();
        let mut missing = agent("a", AgentState::Done, "1", "w");
        missing.workspace_id = None;
        let mut snapshot = snapshot(
            vec![missing.clone(), agent("b", AgentState::Blocked, "1", "w")],
            AppMode::Live,
            SourceStatus::Connected,
        );
        if let AgentStateEvent::Snapshot { workspaces, .. } = &mut snapshot {
            *workspaces = Some(vec![WorkspaceRecord {
                id: "w".into(),
                label: "Kitchen".into(),
            }]);
        }
        recap.apply_at(&snapshot, 1);
        assert_eq!(recap.summary_missing(1).plated_count, 1);
        assert_eq!(recap.summary(Some("w"), 1).blocked_occurrences, 1);
        recap.apply_at(
            &upsert(agent("b", AgentState::Ended, "2", "w"), AppMode::Live),
            2,
        );
        assert!(recap.workspaces().contains(&RecapWorkspace {
            id: Some("w".into()),
            label: "Kitchen".into()
        }));
        assert!(recap.workspaces().contains(&RecapWorkspace {
            id: None,
            label: "Missing workspace".into()
        }));
        let mut unknown_end = missing;
        unknown_end.state = AgentState::Ended;
        unknown_end.state_known = Some(false);
        recap.apply_at(&upsert(unknown_end, AppMode::Live), 3);
        assert_eq!(recap.summary_missing(3).ended_count, 1);
    }

    fn missing_workspace_and_matching_real_id_have_distinct_scopes() {
        let mut missing = agent("missing", AgentState::Blocked, "1", "unused");
        missing.workspace_id = None;
        let mut recap = ServiceRecap::default();
        recap.apply_at(
            &snapshot(
                vec![
                    missing,
                    agent("real", AgentState::Working, "1", "__missing__"),
                ],
                AppMode::Live,
                SourceStatus::Connected,
            ),
            100,
        );
        let scopes = recap.workspaces();
        assert!(scopes.iter().any(|w| w.id.is_none()));
        assert!(scopes
            .iter()
            .any(|w| w.id.as_deref() == Some("__missing__")));
        assert_eq!(recap.rows_missing(200)[0].id, "missing");
        assert_eq!(recap.rows(Some("__missing__"), 200)[0].id, "real");
    }

    #[test]
    fn same_state_new_timestamp_is_new_occurrence_but_replay_is_not() {
        assert!(same_generation(
            "2026-01-01T00:00:02Z",
            "2026-01-01T00:00:01Z"
        ));
        assert!(!same_generation(
            "2026-01-01T00:00:01Z",
            "2026-01-01T00:00:02Z"
        ));
        let mut recap = ServiceRecap::default();
        recap.apply_at(
            &snapshot(Vec::new(), AppMode::Live, SourceStatus::Connected),
            0,
        );
        recap.gap_at(1);
        assert!(recap.workspaces().is_empty());
        recap.apply_at(
            &snapshot(
                vec![agent("a", AgentState::Blocked, "1", "w")],
                AppMode::Live,
                SourceStatus::Connected,
            ),
            1,
        );
        recap.apply_at(
            &upsert(agent("a", AgentState::Blocked, "1", "w"), AppMode::Live),
            2,
        );
        assert_eq!(recap.summary(None, 2).blocked_occurrences, 1);
        assert_eq!(recap.summary(None, 2).blocked_ms, 1);
        recap.apply_at(
            &upsert(agent("a", AgentState::Blocked, "2", "w"), AppMode::Live),
            3,
        );
        assert_eq!(recap.summary(None, 3).blocked_occurrences, 2);
        assert_eq!(recap.summary(None, 3).median_wait_ms, Some(1.0));
        recap.apply_at(
            &upsert(agent("a", AgentState::Ended, "3", "w"), AppMode::Live),
            4,
        );
        recap.apply_at(
            &upsert(agent("a", AgentState::Working, "4", "w"), AppMode::Live),
            5,
        );
        recap.apply_at(
            &upsert(agent("a", AgentState::Ended, "3", "w"), AppMode::Live),
            6,
        );
        recap.apply_at(
            &upsert(agent("a", AgentState::Ended, "3", "w"), AppMode::Live),
            7,
        );
        assert_eq!(recap.summary(None, 7).ended_count, 2);
    }

    #[test]
    fn live_rows_and_summary_share_ongoing_evidence_across_workspace_moves() {
        let mut recap = ServiceRecap::default();
        recap.apply_at(
            &snapshot(
                vec![
                    agent("a", AgentState::Blocked, "1", "w1"),
                    agent("b", AgentState::Working, "1", "w2"),
                ],
                AppMode::Live,
                SourceStatus::Connected,
            ),
            100,
        );
        recap.apply_at(
            &upsert(agent("a", AgentState::Blocked, "1", "w2"), AppMode::Live),
            130,
        );
        let all = recap.summary(None, 140);
        assert_eq!(
            (
                all.blocked_ms,
                all.working_ms,
                all.median_wait_ms,
                all.worst_wait_ms
            ),
            (40, 40, Some(40.0), Some(40))
        );
        let rows = recap.rows(None, 140);
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(rows[0].name, "a");
        assert_eq!(
            (
                rows[0].summary.blocked_ms,
                rows[0].summary.median_wait_ms,
                rows[0].summary.blocked_occurrences
            ),
            (40, Some(40.0), 1)
        );
        assert_eq!(
            rows.iter().map(|row| row.summary.blocked_ms).sum::<u64>(),
            all.blocked_ms
        );
        assert_eq!(
            rows.iter().map(|row| row.summary.working_ms).sum::<u64>(),
            all.working_ms
        );
        assert_eq!(recap.summary(Some("w1"), 140).median_wait_ms, Some(30.0));
        assert_eq!(recap.summary(Some("w2"), 140).median_wait_ms, Some(10.0));
        assert_eq!(recap.rows(Some("w1"), 140)[0].summary.blocked_ms, 30);
        assert_eq!(recap.rows(Some("w2"), 140)[0].summary.blocked_ms, 10);
        recap.gap_at(200);
        assert_eq!(recap.summary(None, 200).blocked_ms, 30);
        assert_eq!(recap.summary(None, 200).median_wait_ms, Some(30.0));
        assert!(recap.summary(None, 200).interrupted);
        assert!(recap.rows(Some("w2"), 200)[0].summary.interrupted);
        recap.apply_at(
            &snapshot(
                vec![agent("a", AgentState::Blocked, "1", "w2")],
                AppMode::Live,
                SourceStatus::Connected,
            ),
            300,
        );
        assert_eq!(recap.summary(None, 310).median_wait_ms, Some(40.0));
        assert_eq!(recap.summary(Some("w2"), 310).median_wait_ms, Some(10.0));
        recap.apply_at(
            &upsert(agent("a", AgentState::Working, "2", "w2"), AppMode::Live),
            320,
        );
        assert_eq!(recap.summary(None, 320).median_wait_ms, Some(50.0));
        assert_eq!(recap.summary(Some("w1"), 320).median_wait_ms, Some(30.0));
        assert_eq!(recap.summary(Some("w2"), 320).median_wait_ms, Some(20.0));
        assert_eq!(recap.rows(None, 320)[0].summary.blocked_occurrences, 1);
    }
}
