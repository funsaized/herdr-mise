use chrono::{DateTime, Utc};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table, Wrap},
    Frame,
};

use super::{
    state::{AgentTable, BOARD_CAP},
    theme, Scope,
};
use crate::protocol::{AgentRecord, AgentState, AppMode, SourceDiagnostic, SourceStatus};

pub(super) fn sanitize_external(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .collect()
}

#[cfg(test)]
use ratatui::buffer::CellDiffOption;

fn workspace_display_name(workspace: &str) -> &str {
    let value = workspace.trim();
    let bytes = value.as_bytes();
    let windows_root = bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2..].iter().all(|byte| matches!(byte, b'/' | b'\\'));
    if windows_root {
        return "Unavailable";
    }
    value
        .split(['/', '\\'])
        .rfind(|part| !part.is_empty())
        .unwrap_or("Unavailable")
}

fn short_workspace_id(id: &str) -> String {
    let compact = id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    compact
        .chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn available(value: Option<&str>) -> String {
    value
        .filter(|value| !value.trim().is_empty())
        .map(sanitize_external)
        .unwrap_or_else(|| "Unavailable".into())
}

pub(super) fn display_width(value: &str) -> usize {
    Line::from(value).width()
}

fn take_width(value: &str, max_width: usize, from_end: bool) -> String {
    let mut width = 0_usize;
    let mut characters = value.chars().collect::<Vec<_>>();
    if from_end {
        characters.reverse();
    }
    let mut kept = characters
        .into_iter()
        .take_while(|character| {
            let character_width = display_width(&character.to_string());
            if width.saturating_add(character_width) > max_width {
                return false;
            }
            width += character_width;
            true
        })
        .collect::<Vec<_>>();
    if from_end {
        kept.reverse();
    }
    kept.into_iter().collect()
}

fn compact_text(value: &str, max_width: usize) -> String {
    if display_width(value) <= max_width {
        return value.into();
    }
    if max_width <= 1 {
        return take_width(value, max_width, true);
    }
    let content_width = max_width - 1;
    let head_width = content_width / 2;
    format!(
        "{}…{}",
        take_width(value, head_width, false),
        take_width(value, content_width - head_width, true)
    )
}

fn station_suffix(agent: &AgentRecord, agents: &[&AgentRecord], max_width: usize) -> String {
    let key = format!(
        "{}\0{}",
        sanitize_external(&agent.name).to_uppercase(),
        sanitize_external(workspace_display_name(&agent.workspace)).to_uppercase()
    );
    let colliding = agents
        .iter()
        .filter(|candidate| {
            format!(
                "{}\0{}",
                sanitize_external(&candidate.name).to_uppercase(),
                sanitize_external(workspace_display_name(&candidate.workspace)).to_uppercase()
            ) == key
        })
        .count()
        > 1;
    if colliding {
        let identity = sanitize_external(agent.pane_id.as_deref().unwrap_or(&agent.id));
        if display_width(&identity).saturating_add(3) <= max_width {
            return format!(" · {identity}");
        }
        if max_width <= 3 {
            return take_width(&identity, max_width, true);
        }
        format!(" · {}", compact_text(&identity, max_width - 3))
    } else {
        String::new()
    }
}

pub(super) fn station_display_name(
    agent: &AgentRecord,
    agents: &[&AgentRecord],
    max_width: usize,
) -> String {
    let name = sanitize_external(&agent.name);
    let name_key = name.to_uppercase();
    let duplicate_name = agents
        .iter()
        .filter(|candidate| sanitize_external(&candidate.name).to_uppercase() == name_key)
        .count()
        > 1;
    let base = if duplicate_name {
        format!(
            "{name} · {}",
            sanitize_external(workspace_display_name(&agent.workspace))
        )
    } else {
        name
    };
    let suffix = station_suffix(agent, agents, max_width.saturating_sub(1));
    let available = max_width.saturating_sub(display_width(&suffix));
    format!("{}{suffix}", compact_text(&base, available))
}

pub(super) fn inspect_facts(agent: &AgentRecord) -> [String; 4] {
    let tickets = agent.session.tickets_text();
    [
        format!("Agent kind: {}", available(agent.agent_kind.as_deref())),
        format!(
            "Pane locator: {} · Tickets: {tickets}",
            available(agent.pane_id.as_deref())
        ),
        format!("Workspace: {}", available(Some(&agent.workspace)),),
        format!(
            "{} · {}",
            sanitize_external(&agent.name),
            record_state_label(agent)
        ),
    ]
}

pub(super) fn inspect_paragraph(agent: &AgentRecord) -> Paragraph<'static> {
    Paragraph::new(inspect_facts(agent).map(Line::from).to_vec()).wrap(Wrap { trim: false })
}

pub(super) fn inspect_height(agent: &AgentRecord, width: u16) -> u16 {
    u16::try_from(inspect_paragraph(agent).line_count(width.max(1))).unwrap_or(u16::MAX)
}

fn format_duration(milliseconds: u64) -> String {
    let seconds = milliseconds / 1_000;
    let minutes = seconds / 60;
    let hours = minutes / 60;
    if hours > 0 {
        format!("{hours}h {}m", minutes % 60)
    } else if minutes > 0 {
        format!("{minutes}m {}s", seconds % 60)
    } else {
        format!("{seconds}s")
    }
}

pub(super) fn service_line(table: &AgentTable, now: DateTime<Utc>, scope: Option<&str>) -> String {
    let summary = table.service_summary_scoped(scope);
    let oldest = table
        .blocked_agents()
        .into_iter()
        .filter(|agent| scope.is_none_or(|id| agent.workspace_id.as_deref() == Some(id)))
        .next()
        .map_or_else(
            || "None".into(),
            |agent| {
                let milliseconds = DateTime::parse_from_rfc3339(&agent.state_entered_at)
                    .ok()
                    .map(|entered| {
                        now.signed_duration_since(entered.with_timezone(&Utc))
                            .num_milliseconds()
                            .max(0) as u64
                    })
                    .unwrap_or(0);
                format!(
                    "{} {}",
                    sanitize_external(&agent.name),
                    format_duration(milliseconds)
                )
            },
        );
    format!(
        "OBSERVED W {} · B {} · P {} · U {} · SHOWN {}/{} · HIDDEN {} · OLDEST BLOCKED {oldest}",
        summary.working,
        summary.blocked,
        summary.plated,
        summary.unknown,
        summary.visible,
        summary.visible + summary.hidden_done,
        summary.hidden_done,
    )
}

fn state_label(state: &AgentState) -> &'static str {
    match state {
        AgentState::Idle => "IDLE / PREPPING",
        AgentState::Working => "WORKING / ON THE FIRE",
        AgentState::Blocked => "BLOCKED / AT THE PASS",
        AgentState::Done => "DONE / PLATED",
        AgentState::Ended => "86'D / SESSION ENDED",
    }
}

fn record_state_label(agent: &AgentRecord) -> &'static str {
    if agent.state_known == Some(false) {
        "UNKNOWN / AT PREP"
    } else {
        state_label(&agent.state)
    }
}

fn source_status_text(status: &SourceStatus) -> &'static str {
    match status {
        SourceStatus::UnavailableSocket => "Herdr socket unavailable",
        SourceStatus::Timeout => "Herdr did not respond in time",
        SourceStatus::UnsupportedProtocol => "Herdr protocol is unsupported",
        SourceStatus::IncompatibleResponse => "Herdr returned an incompatible response",
        SourceStatus::Connected => "Connected to Herdr",
    }
}

pub(crate) fn status_lines(
    mode: AppMode,
    source_status: &SourceStatus,
    diagnostic: Option<&SourceDiagnostic>,
    agent_count: usize,
) -> (String, String) {
    let title = if mode == AppMode::Live {
        "MISE — LIVE"
    } else {
        "MISE — DEMO SERVICE"
    };
    if mode == AppMode::Live && source_status == &SourceStatus::Connected && agent_count == 0 {
        return (
            title.into(),
            "Waiting for agents — start one in herdr".into(),
        );
    }
    let detail = match (source_status, diagnostic) {
        (SourceStatus::UnsupportedProtocol, Some(diagnostic)) => format!(
            " — observed {}; supported: {}; {}",
            diagnostic.observed_protocol,
            diagnostic
                .supported_protocols
                .iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join(", "),
            sanitize_external(&diagnostic.next_action)
        ),
        (SourceStatus::IncompatibleResponse, Some(diagnostic)) => {
            format!(" — {}", sanitize_external(&diagnostic.next_action))
        }
        _ => String::new(),
    };
    let condition = format!("{}{}", source_status_text(source_status), detail);
    let status = if mode == AppMode::Demo {
        format!("Mock feed — {condition}. Nothing here is real.")
    } else {
        condition
    };
    (title.into(), status)
}

pub(crate) fn scope_summary(table: &AgentTable, scope: &Scope) -> String {
    let Some(id) = scope.id.as_deref() else {
        return "Workspace: All".into();
    };
    let current = table.workspace(id);
    let label = current
        .map(|workspace| workspace.label.as_str())
        .or(scope.label.as_deref())
        .filter(|label| !label.trim().is_empty())
        .unwrap_or(id);
    let display_label = workspace_display_name(label);
    let duplicate = current.is_some()
        && table
            .workspaces()
            .iter()
            .filter(|workspace| workspace_display_name(&workspace.label) == display_label)
            .count()
            > 1;
    let suffix = duplicate.then(|| format!(" ({})", short_workspace_id(id)));
    let mut summary = format!(
        "Workspace: {}{}",
        sanitize_external(display_label),
        suffix.as_deref().unwrap_or_default()
    );
    if current.is_none() {
        summary.push_str(" (unavailable)");
    } else if table.scoped_agents(Some(id)).next().is_none() {
        summary.push_str(" (empty)");
    }
    let blocked = table.blocked_elsewhere(Some(id));
    if blocked > 0 {
        summary.push_str(&format!(" · {blocked} blocked elsewhere"));
    }
    summary
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TableWindow {
    pub(crate) offset: usize,
    pub(crate) end: usize,
}

struct FallbackLayout {
    areas: Vec<Rect>,
    window: TableWindow,
}

fn fallback_layout(
    area: Rect,
    table: &AgentTable,
    agents: &[&AgentRecord],
    selected_id: Option<&str>,
    requested_offset: usize,
    header_content_height: u16,
) -> FallbackLayout {
    let compact = area.height < 20;
    let agent_count = agents.len();
    let baseline_height = if compact { 2 } else { 4 };
    let header_height = baseline_height.max(header_content_height + u16::from(!compact));
    let table_height = u16::try_from(agent_count)
        .unwrap_or(u16::MAX)
        .saturating_add(3);
    let selected = selected_id.and_then(|id| agents.iter().copied().find(|agent| agent.id == id));
    let selected_index = selected_id.and_then(|id| agents.iter().position(|agent| agent.id == id));
    let board_height = if compact && selected.is_some() {
        0
    } else {
        u16::try_from(table.board().len().min(3))
            .unwrap_or(3)
            .saturating_add(2)
    };
    let mut constraints = vec![
        Constraint::Length(header_height),
        Constraint::Length(table_height),
        Constraint::Length(board_height),
        Constraint::Min(0),
        Constraint::Length(1),
    ];
    if let Some(agent) = selected {
        constraints.insert(4, Constraint::Length(inspect_height(agent, area.width)));
    }
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area)
        .to_vec();
    let capacity = usize::from(areas[1].height.saturating_sub(3));
    let mut offset = requested_offset.min(agent_count.saturating_sub(capacity));
    if let Some(index) = selected_index {
        if index < offset {
            offset = index;
        } else if index >= offset.saturating_add(capacity) {
            offset = index.saturating_add(1).saturating_sub(capacity);
        }
    }
    let end = offset.saturating_add(capacity).min(agent_count);
    FallbackLayout {
        areas,
        window: TableWindow { offset, end },
    }
}

pub(crate) fn table_window(
    area: Rect,
    table: &AgentTable,
    now: DateTime<Utc>,
    scope: &Scope,
    selected_id: Option<&str>,
    requested_offset: usize,
) -> TableWindow {
    let agents = table.scoped_agents(scope.id.as_deref()).collect::<Vec<_>>();
    let (title, source_copy) = status_lines(
        table.mode(),
        table.source_status(),
        table.source_diagnostic(),
        agents.len(),
    );
    let header = Paragraph::new(vec![
        Line::from(title),
        Line::from(format!("{source_copy} · {}", scope_summary(table, scope))),
        Line::from(service_line(table, now, scope.id.as_deref())),
    ])
    .wrap(Wrap { trim: true });
    let header_content_height = u16::try_from(header.line_count(area.width)).unwrap_or(u16::MAX);
    fallback_layout(
        area,
        table,
        &agents,
        selected_id,
        requested_offset,
        header_content_height,
    )
    .window
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_scoped(
    frame: &mut Frame<'_>,
    table: &AgentTable,
    warning: Option<&str>,
    now: DateTime<Utc>,
    _tick: u64,
    selected_id: Option<&str>,
    table_offset: usize,
    scope: &Scope,
) {
    let compact = frame.area().height < 20;
    let agents = table.scoped_agents(scope.id.as_deref()).collect::<Vec<_>>();
    let agent_count = agents.len();
    let (title, source_copy) = status_lines(
        table.mode(),
        table.source_status(),
        table.source_diagnostic(),
        table.agents().count(),
    );
    let mut header = Paragraph::new(vec![
        Line::from(Span::styled(
            title,
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(format!("{source_copy} · {}", scope_summary(table, scope))),
        Line::from(service_line(table, now, scope.id.as_deref())),
    ])
    .wrap(Wrap { trim: true });
    let header_content_height =
        u16::try_from(header.line_count(frame.area().width)).unwrap_or(u16::MAX);
    if !compact {
        header = header.block(Block::default().borders(Borders::BOTTOM));
    }
    let selected = selected_id.and_then(|id| agents.iter().copied().find(|agent| agent.id == id));
    let layout = fallback_layout(
        frame.area(),
        table,
        &agents,
        selected_id,
        table_offset,
        header_content_height,
    );
    let areas = layout.areas;
    frame.render_widget(header, areas[0]);
    let available_width = areas[1].width.saturating_sub(2);
    let show_workspace = available_width >= theme::KITCHEN_TABLE_WORKSPACE_MIN_WIDTH;
    let show_tickets = available_width >= theme::KITCHEN_TABLE_TICKETS_MIN_WIDTH;
    let show_runtime = available_width >= theme::KITCHEN_TABLE_RUNTIME_MIN_WIDTH;
    let agent_width = agents
        .iter()
        .map(|agent| station_suffix(agent, &agents, usize::MAX))
        .filter(|suffix| !suffix.is_empty())
        .map(|suffix| display_width(&suffix) + theme::KITCHEN_TABLE_AGENT_SUFFIX_PADDING)
        .max()
        .unwrap_or(theme::KITCHEN_TABLE_AGENT_MIN_WIDTH)
        .max(theme::KITCHEN_TABLE_AGENT_MIN_WIDTH)
        .min(
            usize::from(available_width.saturating_sub(theme::KITCHEN_TABLE_RESERVED_WIDTH))
                .max(theme::KITCHEN_TABLE_AGENT_MIN_WIDTH),
        );
    let rows = agents
        .iter()
        .copied()
        .skip(layout.window.offset)
        .take(layout.window.end.saturating_sub(layout.window.offset))
        .map(|agent| {
            let selected_row = selected_id == Some(agent.id.as_str());
            let entered = DateTime::parse_from_rfc3339(&agent.state_entered_at)
                .ok()
                .map(|d| d.with_timezone(&Utc));
            let elapsed = entered
                .map(|d| now.signed_duration_since(d).num_milliseconds().max(0) as u64)
                .unwrap_or(0);
            let style = if agent.state == AgentState::Blocked {
                Style::default().add_modifier(Modifier::BOLD | Modifier::REVERSED)
            } else if selected_row {
                Style::default().add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            let mut cells = vec![
                Cell::from(if selected_row {
                    format!(
                        "> {}",
                        station_display_name(agent, &agents, agent_width.saturating_sub(2))
                    )
                } else {
                    station_display_name(agent, &agents, agent_width)
                })
                .style(Style::default().fg(theme::compact_accent(agent.accent_index))),
                Cell::from(record_state_label(agent))
                    .style(Style::default().fg(theme::compact_state_color(&agent.state))),
                Cell::from(format_duration(elapsed)),
            ];
            if show_workspace {
                cells.push(Cell::from(sanitize_external(workspace_display_name(
                    &agent.workspace,
                ))));
            }
            if show_tickets {
                cells.push(Cell::from(agent.session.tickets_text()));
            }
            if show_runtime {
                cells.push(Cell::from(format_duration(agent.session.runtime_ms)));
            }
            Row::new(cells).style(style)
        });
    let mut widths = vec![
        Constraint::Length(u16::try_from(agent_width).unwrap_or(u16::MAX)),
        Constraint::Length(22),
        Constraint::Min(9),
    ];
    let mut headings = vec!["AGENT", "STATE", "ELAPSED"];
    if show_workspace {
        widths.push(Constraint::Length(16));
        headings.push("WORKSPACE");
    }
    if show_tickets {
        widths.push(Constraint::Length(7));
        headings.push("TICKETS");
    }
    if show_runtime {
        widths.push(Constraint::Min(9));
        headings.push("RUNTIME");
    }
    let blocked_count = agents
        .iter()
        .filter(|agent| agent.state == AgentState::Blocked)
        .count();
    let range_start = usize::from(agent_count > 0 && layout.window.end > layout.window.offset)
        .saturating_add(layout.window.offset);
    frame.render_widget(
        Table::new(rows, widths)
            .header(Row::new(headings).style(Style::default().add_modifier(Modifier::BOLD)))
            .column_spacing(1)
            .block(Block::default().borders(Borders::ALL).title(format!(
                "Kitchen status · {range_start}-{}/{agent_count} · {blocked_count} blocked",
                layout.window.end
            ))),
        areas[1],
    );
    let board_rows = table.board().iter().rev().take(3).map(|entry| {
        Row::new([format!(
            "{} · mise {} · FINAL {}",
            sanitize_external(&entry.name),
            format_duration(entry.runtime_ms),
            state_label(&entry.final_state)
        )])
    });
    frame.render_widget(
        Table::new(board_rows, [Constraint::Min(1)])
            .style(
                Style::default()
                    .fg(theme::COMPACT_CHALK)
                    .bg(theme::COMPACT_BOARD),
            )
            .block(Block::default().borders(Borders::ALL).title("86 BOARD")),
        areas[2],
    );
    let status_area = if let Some(agent) = selected {
        frame.render_widget(inspect_paragraph(agent), areas[4]);
        areas[5]
    } else {
        areas[4]
    };
    let keys = if selected.is_some() {
        "Tab / Shift+Tab inspect · b next blocked · w scope · a all · Esc close · q quit"
    } else {
        "q / Esc quit · b next blocked · w scope · a all"
    };
    let board = format!("86 {}/{BOARD_CAP}", table.board().len());
    let status = warning.map_or_else(
        || format!("{keys} · {board}"),
        |warning| format!("{} · {keys} · {board}", sanitize_external(warning)),
    );
    frame.render_widget(Paragraph::new(Line::from(status)), status_area);
}

#[cfg(test)]
mod tests {
    #[test]
    fn shared_provenance_fixture_distinguishes_unavailable_from_zero() {
        let event: crate::protocol::AgentStateEvent = serde_json::from_str(include_str!(
            "../../../protocol/fixtures/snapshot-provenance.v1.json"
        ))
        .unwrap();
        let crate::protocol::AgentStateEvent::Snapshot { agents, .. } = event else {
            panic!("snapshot")
        };
        assert!(super::inspect_facts(&agents[0])[3].contains("UNKNOWN"));
        assert!(super::inspect_facts(&agents[0])[1].contains("Tickets: Unavailable"));
        assert!(super::inspect_facts(&agents[1])[1].contains("Tickets: 0"));
        assert_eq!(agents[0].session.tickets_text(), "Unavailable");
        assert_eq!(agents[1].session.tickets_text(), "0");
    }
    use super::super::{
        handle_key_with_scope, reconcile_scope, retain_selection, scene, SceneView, HELP_LINES,
    };
    use super::*;
    use crate::adapter::Normalizer;
    use crate::feed::Feed;
    use crate::protocol::{
        AgentRecord, AgentStateEvent, DeltaOperation, SessionStats, SourceDiagnostic, SourceStatus,
        WorkspaceRecord,
    };
    use crossterm::event::KeyCode;
    use ratatui::{backend::TestBackend, buffer::Buffer, style::Color, Terminal};
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn fixture_backed_inspection_identity_is_unambiguous() {
        let kind_fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/snapshot-working-idle-accents.json"
        ))
        .unwrap();
        let agent_kind = kind_fixture["result"]["snapshot"]["agents"][0]["agent"]
            .as_str()
            .unwrap();
        let mut source: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/snapshot-herdr-0.8.0-p19.json"
        ))
        .unwrap();
        source["agents"][0]["agent"] = agent_kind.into();
        source["agents"][0]["name"] = "same chef".into();
        source["agents"][0]["pane_id"] =
            "fictional-pane-料理🥘-with-a-long-shared-prefix-19".into();
        source["workspaces"][0]["label"] = "/work/one/example-pantry".into();
        let mut duplicate = source["agents"][0].clone();
        duplicate["terminal_id"] = "fictional-terminal-20".into();
        duplicate["pane_id"] = "fictional-pane-料理🥘-with-a-long-shared-prefix-20".into();
        duplicate["workspace_id"] = "fictional-pantry-two".into();
        source["agents"].as_array_mut().unwrap().push(duplicate);
        source["workspaces"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "workspace_id": "fictional-pantry-two",
                "label": "/work/two/example-pantry"
            }));

        let mut normalizer = Normalizer::default();
        let normalized = normalizer
            .normalize_snapshot_value(source.clone(), "2026-08-13T12:00:00Z")
            .unwrap();
        let normalized_agents = normalized.agents.iter().collect::<Vec<_>>();
        let labels = normalized_agents
            .iter()
            .map(|agent| station_display_name(agent, &normalized_agents, 18))
            .collect::<Vec<_>>();
        assert!(labels.iter().all(|label| display_width(label) <= 18));
        assert!(labels[0].ends_with("-19"));
        assert!(labels[1].ends_with("-20"));

        let mut distinct_workspaces = source.clone();
        distinct_workspaces["workspaces"][1]["label"] = "/work/two/different-pantry".into();
        let distinct = Normalizer::default()
            .normalize_snapshot_value(distinct_workspaces, "2026-08-13T12:00:00Z")
            .unwrap();
        let distinct_agents = distinct.agents.iter().collect::<Vec<_>>();
        assert_eq!(
            distinct_agents
                .iter()
                .map(|agent| station_display_name(agent, &distinct_agents, 80))
                .collect::<Vec<_>>(),
            ["same chef · example-pantry", "same chef · different-pantry"]
        );
        let mut long_agents = normalized.agents.clone();
        long_agents[0].workspace = format!("/work/{}/example-pantry", "料理🥘/".repeat(20));
        long_agents[0]
            .pane_id
            .as_mut()
            .unwrap()
            .push_str(&"-料理🥘".repeat(20));
        assert!((6..=18).contains(&inspect_height(&long_agents[0], 76)));
        let long_feed = crate::feed::Feed::fixed(AppMode::Live, long_agents).await;
        let mut long_table = AgentTable::default();
        long_table.apply(long_feed.snapshot().await);
        let narrow = render_scene(
            &long_table,
            80,
            24,
            Some("fictional-terminal-19"),
            SceneView::Kitchen,
            false,
        );
        assert!(narrow.contains("BLOCKED / AT THE PASS"), "{narrow}");
        assert!(narrow.contains("Kitchen status"), "{narrow}");
        assert!(narrow.contains("Agent kind: codex"), "{narrow}");
        assert!(narrow.contains("Pane locator:"), "{narrow}");
        assert!(narrow.contains("prefix-19"), "{narrow}");
        let narrow_freezer = render_scene(
            &long_table,
            80,
            24,
            Some("fictional-terminal-19"),
            SceneView::Freezer,
            false,
        );
        assert!(
            narrow_freezer.contains("Kitchen status"),
            "{narrow_freezer}"
        );
        assert!(
            !narrow_freezer.contains("FREEZER EMPTY"),
            "{narrow_freezer}"
        );

        let feed = crate::feed::Feed::fixed(AppMode::Live, normalized.agents).await;
        let mut table = AgentTable::default();
        table.apply(feed.snapshot().await);
        let selected_id = "fictional-terminal-19";
        let mut terminal = Terminal::new(TestBackend::new(60, 18)).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-13T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        terminal
            .draw(|frame| draw_scoped(frame, &table, None, now, 0, None, 0, &Scope::default()))
            .unwrap();
        let fallback = buffer_text(&terminal);
        assert!(fallback.contains("-19"));
        assert!(fallback.contains("-20"));
        let initial = render_scene(
            &table,
            100,
            30,
            Some(selected_id),
            SceneView::Kitchen,
            false,
        );
        assert!(
            initial.contains("‼ BLOCKED  y · fictional…prefix-19, y · fictional…prefix-20  00:00"),
            "{initial}"
        );
        assert!(initial.contains("-19"));
        assert!(initial.contains("-20"));
        assert!(initial.contains("Workspace: /work/one/example-pantry"));
        assert!(initial.contains("Agent kind: codex"));
        assert_eq!(
            inspect_facts(table.agents().find(|agent| agent.id == selected_id).unwrap())[1],
            "Pane locator: fictional-pane-料理🥘-with-a-long-shared-prefix-19 · Tickets: Unavailable"
        );
        assert!(initial.contains("Pane locator: fictional-pane-"));
        assert!(initial.contains("prefix-19"));
        let compact = render_scene(&table, 60, 18, Some(selected_id), SceneView::Kitchen, false);
        assert!(compact.contains("Agent kind: codex"));
        assert!(compact.contains("prefix-19"), "{compact}");

        let mut invalid = source.clone();
        invalid["agents"][0]["pane_id"] = "fictional-pane\nmoved".into();
        assert!(normalizer
            .normalize_snapshot_value(invalid, "2026-08-13T12:00:01Z")
            .is_err());

        source["agents"][0]["pane_id"] = "fictional-pane-moved".into();
        let moved = normalizer
            .normalize_snapshot_value(source, "2026-08-13T12:00:01Z")
            .unwrap();
        let selected = moved
            .agents
            .iter()
            .find(|agent| agent.id == selected_id)
            .unwrap()
            .clone();
        feed.publish(selected).await;
        table.apply(feed.snapshot().await);
        let moved = render_scene(
            &table,
            100,
            30,
            Some(selected_id),
            SceneView::Kitchen,
            false,
        );
        assert!(moved.contains("Pane locator: fictional-pane-moved"));
        assert!(moved.contains("fictional-pane-moved"));
        let freezer = render_scene(
            &table,
            100,
            30,
            Some(selected_id),
            SceneView::Freezer,
            false,
        );
        assert!(freezer.contains("Agent kind: codex"));
        assert!(freezer.contains("Pane locator: fictional-pane-moved"));
    }

    fn record(id: &str, state: AgentState) -> AgentRecord {
        AgentRecord {
            state_known: None,
            id: id.into(),
            pane_id: None,
            agent_kind: None,
            name: format!("Cook {id}"),
            state,
            progress: None,
            state_entered_at: "2026-08-13T12:00:00Z".into(),
            accent_index: 2,
            model: "gpt-5.6-sol".into(),
            workspace: "/work/customer-api".into(),
            workspace_id: None,
            session: SessionStats {
                tickets_available: None,
                runtime_ms: 3_661_000,
                tickets: 7,
            },
        }
    }

    fn apply_upsert(table: &mut AgentTable, agent: AgentRecord) {
        table.apply(AgentStateEvent::Delta {
            version: 1,
            mode: AppMode::Live,
            operation: DeltaOperation::Upsert,
            agent: Some(agent),
            agent_id: None,
        });
    }

    fn buffer_text(terminal: &Terminal<TestBackend>) -> String {
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    fn render_scene(
        table: &AgentTable,
        width: u16,
        height: u16,
        selected_id: Option<&str>,
        scene_view: SceneView,
        help_open: bool,
    ) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-13T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        terminal
            .draw(|frame| {
                scene::draw_view_scoped(
                    frame,
                    table,
                    None,
                    now,
                    0,
                    super::super::canvas::ColorMode::Xterm256,
                    true,
                    selected_id,
                    0,
                    scene_view,
                    help_open,
                    false,
                    &Scope::default(),
                )
            })
            .unwrap();
        buffer_text(&terminal)
    }

    fn fixture(name: &str) -> AgentStateEvent {
        let text = std::fs::read_to_string(format!(
            "{}/../protocol/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    fn buffer_dump(buffer: &Buffer) -> String {
        let mut dump = format!("AREA {}x{}\n", buffer.area.width, buffer.area.height);
        for y in buffer.area.y..buffer.area.bottom() {
            let text = (buffer.area.x..buffer.area.right())
                .map(|x| buffer.cell((x, y)).unwrap().symbol())
                .collect::<String>();
            dump.push_str(&format!("TEXT {y:02} {text:?}\n"));
            let mut x = buffer.area.x;
            while x < buffer.area.right() {
                let cell = buffer.cell((x, y)).unwrap();
                let styled = cell.fg != Color::Reset
                    || cell.bg != Color::Reset
                    || !cell.modifier.is_empty()
                    || cell.diff_option != CellDiffOption::None;
                if !styled {
                    x += 1;
                    continue;
                }
                let start = x;
                x += 1;
                while x < buffer.area.right() {
                    let next = buffer.cell((x, y)).unwrap();
                    if next.fg != cell.fg
                        || next.bg != cell.bg
                        || next.modifier != cell.modifier
                        || next.diff_option != cell.diff_option
                    {
                        break;
                    }
                    x += 1;
                }
                dump.push_str(&format!(
                    "STYLE {y:02} {start:03}..{x:03} fg={:?} bg={:?} mod={:?} skip={}\n",
                    cell.fg,
                    cell.bg,
                    cell.modifier,
                    cell.diff_option == CellDiffOption::Skip
                ));
            }
        }
        dump
    }

    fn render_dump(table: &AgentTable, warning: Option<&str>) -> String {
        let backend = TestBackend::new(110, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-13T12:02:05Z")
            .unwrap()
            .with_timezone(&Utc);
        terminal
            .draw(|frame| draw_scoped(frame, table, warning, now, 9, None, 0, &Scope::default()))
            .unwrap();
        buffer_dump(terminal.backend().buffer())
    }

    fn golden_result(name: &str, table: &AgentTable, warning: Option<&str>) -> Result<(), String> {
        let first = render_dump(table, warning);
        let second = render_dump(table, warning);
        if first != second {
            return Err("fixed inputs did not render identically twice".into());
        }
        let path = format!(
            "{}/tests/goldens/tui-{name}.txt",
            env!("CARGO_MANIFEST_DIR")
        );
        if std::env::var_os("UPDATE_SCENE_GOLDENS").is_some() {
            std::fs::write(&path, &first).unwrap();
        }
        let expected = std::fs::read_to_string(&path).unwrap();
        if first != expected {
            let line = first
                .lines()
                .zip(expected.lines())
                .position(|(actual, expected)| actual != expected)
                .unwrap_or_else(|| first.lines().count().min(expected.lines().count()));
            return Err(format!(
                "golden mismatch at {path}, line {}\nexpected: {:?}\nactual:   {:?}\n\ncomplete actual dump:\n{first}",
                line + 1,
                expected.lines().nth(line),
                first.lines().nth(line),
            ));
        }
        Ok(())
    }

    #[test]
    fn workspace_labels_match_client_behavior() {
        for (workspace, expected) in [
            ("/work/customer-api", "customer-api"),
            ("/work/customer-api/", "customer-api"),
            (r"C:\work\customer-api", "customer-api"),
            ("customer-api", "customer-api"),
            ("", "Unavailable"),
            ("/", "Unavailable"),
            (r"C:\", "Unavailable"),
        ] {
            assert_eq!(workspace_display_name(workspace), expected);
        }
    }

    #[test]
    fn real_herdr_snapshot_drives_keyboard_inspection_lifecycle() {
        let raw = serde_json::from_str(include_str!(
            "../../tests/fixtures/snapshot-herdr-0.8.2-p20.json"
        ))
        .unwrap();
        let normalized = Normalizer::default()
            .normalize_snapshot_value(raw, "2026-08-13T12:00:00Z")
            .unwrap();
        let mut table = AgentTable::default();
        table.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents: normalized.agents,
            workspaces: Some(normalized.workspaces),
        });
        let shutdown = CancellationToken::new();
        let mut selected = None;
        assert!(!handle_key_with_scope(
            KeyCode::Tab,
            &table,
            &mut selected,
            &mut SceneView::Kitchen,
            &mut false,
            &mut Scope::default(),
            &shutdown,
        ));
        assert_eq!(selected.as_deref(), Some("fictional-terminal-20"));

        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-13T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        terminal
            .draw(|frame| {
                scene::draw_view_scoped(
                    frame,
                    &table,
                    None,
                    now,
                    0,
                    super::super::canvas::ColorMode::Xterm256,
                    true,
                    selected.as_deref(),
                    0,
                    SceneView::Kitchen,
                    false,
                    false,
                    &Scope::default(),
                )
            })
            .unwrap();
        let strip = terminal
            .backend()
            .buffer()
            .content
            .chunks(80)
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .filter(|row| {
                row.contains("example-cook")
                    || row.contains("Workspace:")
                    || row.contains("Agent kind:")
            })
            .collect::<Vec<_>>()
            .join(" ");

        for expected in ["example-cook", "WORKING / ON THE FIRE", "Example Kitchen"] {
            assert!(
                strip.contains(expected),
                "missing {expected:?} in {strip:?}"
            );
        }
        assert_eq!(strip.matches("Unavailable").count(), 1);
        assert!(!terminal
            .backend()
            .buffer()
            .content
            .iter()
            .any(|cell| cell.modifier.contains(Modifier::REVERSED)));
        let lower = strip.to_ascii_lowercase();
        for absent in [
            "elapsed", "progress", "runtime", "history", "health", "owner", "attach", "open",
            "copy",
        ] {
            assert!(
                !lower.contains(absent),
                "unexpected {absent:?} in {strip:?}"
            );
        }

        let mut compact = Terminal::new(TestBackend::new(79, 23)).unwrap();
        compact
            .draw(|frame| {
                scene::draw_view_scoped(
                    frame,
                    &table,
                    None,
                    now,
                    0,
                    super::super::canvas::ColorMode::Xterm256,
                    true,
                    selected.as_deref(),
                    0,
                    SceneView::Kitchen,
                    false,
                    false,
                    &Scope::default(),
                )
            })
            .unwrap();
        assert!(buffer_text(&compact).contains("> example-cook"));

        assert!(!handle_key_with_scope(
            KeyCode::Esc,
            &table,
            &mut selected,
            &mut SceneView::Kitchen,
            &mut false,
            &mut Scope::default(),
            &shutdown,
        ));
        assert_eq!(selected, None);
        assert!(!shutdown.is_cancelled());
        assert!(!handle_key_with_scope(
            KeyCode::Tab,
            &table,
            &mut selected,
            &mut SceneView::Kitchen,
            &mut false,
            &mut Scope::default(),
            &shutdown,
        ));
        table.apply(AgentStateEvent::Delta {
            version: 1,
            mode: AppMode::Live,
            operation: DeltaOperation::Remove,
            agent: None,
            agent_id: Some("fictional-terminal-20".into()),
        });
        retain_selection(&mut selected, &table, &Scope::default());
        assert_eq!(selected, None);
        assert!(handle_key_with_scope(
            KeyCode::Esc,
            &table,
            &mut selected,
            &mut SceneView::Kitchen,
            &mut false,
            &mut Scope::default(),
            &shutdown,
        ));
        assert!(shutdown.is_cancelled());
    }

    #[test]
    fn real_herdr_fixtures_keep_fallback_rows_reachable() {
        let normalize = |fixture| {
            Normalizer::default()
                .normalize_snapshot_value(
                    serde_json::from_str(fixture).unwrap(),
                    "2026-08-13T12:00:00Z",
                )
                .unwrap()
                .agents
                .into_iter()
                .next()
                .unwrap()
        };
        let working = normalize(include_str!(
            "../../tests/fixtures/snapshot-herdr-0.8.2-p20.json"
        ));
        let blocked = normalize(include_str!(
            "../../tests/fixtures/snapshot-herdr-0.8.0-p19.json"
        ));
        assert_eq!(blocked.state, AgentState::Blocked);
        let agents = (0..30)
            .map(|index| {
                let mut agent = if index == 29 {
                    blocked.clone()
                } else {
                    working.clone()
                };
                agent.id = format!("fixture-{index:02}");
                agent.name = format!("Cook{index:02}");
                agent
            })
            .collect();
        let mut table = AgentTable::default();
        table.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents,
            workspaces: None,
        });
        let now = DateTime::parse_from_rfc3339("2026-08-13T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let render = |width, height, selected: Option<&str>, offset: &mut usize| {
            let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
            terminal
                .draw(|frame| {
                    *offset = table_window(
                        frame.area(),
                        &table,
                        now,
                        &Scope::default(),
                        selected,
                        *offset,
                    )
                    .offset;
                    scene::draw_view_scoped(
                        frame,
                        &table,
                        None,
                        now,
                        0,
                        super::super::canvas::ColorMode::Xterm256,
                        true,
                        selected,
                        *offset,
                        SceneView::Kitchen,
                        false,
                        false,
                        &Scope::default(),
                    )
                })
                .unwrap();
            buffer_text(&terminal)
        };
        let shutdown = CancellationToken::new();

        for (width, height) in [(60, 12), (80, 24)] {
            let mut offset = 0;
            let mut view = SceneView::Kitchen;
            let mut help_open = false;
            let mut scope = Scope::default();
            let initial = render(width, height, None, &mut offset);
            assert!(
                initial.contains("/30 · 1 blocked"),
                "{width}x{height}: {initial:?}"
            );
            assert!(!initial.contains("│Cook29"));

            let mut selected = None;
            for index in 0..30 {
                assert!(!handle_key_with_scope(
                    KeyCode::Tab,
                    &table,
                    &mut selected,
                    &mut view,
                    &mut help_open,
                    &mut scope,
                    &shutdown,
                ));
                let output = render(width, height, selected.as_deref(), &mut offset);
                assert!(
                    output.contains(&format!("> Cook{index:02}")),
                    "{width}x{height} could not show {selected:?}: {output:?}"
                );
            }

            selected = None;
            assert!(!handle_key_with_scope(
                KeyCode::BackTab,
                &table,
                &mut selected,
                &mut view,
                &mut help_open,
                &mut scope,
                &shutdown,
            ));
            assert_eq!(selected.as_deref(), Some("fixture-29"));
            assert!(render(width, height, selected.as_deref(), &mut offset).contains("> Cook29"));

            selected = None;
            assert!(!handle_key_with_scope(
                KeyCode::Char('b'),
                &table,
                &mut selected,
                &mut view,
                &mut help_open,
                &mut scope,
                &shutdown,
            ));
            assert_eq!(selected.as_deref(), Some("fixture-29"));
            assert!(render(width, height, selected.as_deref(), &mut offset).contains("> Cook29"));
        }

        let selected = Some("fixture-29".to_owned());
        let mut offset = 0;
        render(60, 12, selected.as_deref(), &mut offset);
        let narrow_offset = offset;
        let resized = render(80, 24, selected.as_deref(), &mut offset);
        assert_eq!(selected.as_deref(), Some("fixture-29"));
        assert!(resized.contains("> Cook29"));
        assert!(offset < narrow_offset);
        assert!(resized.contains(&format!("{}-30/30", offset + 1)));
    }

    #[test]
    fn real_herdr_snapshot_drives_scene_help_lifecycle() {
        let raw = serde_json::from_str(include_str!(
            "../../tests/fixtures/snapshot-herdr-0.8.2-p20.json"
        ))
        .unwrap();
        let normalized = Normalizer::default()
            .normalize_snapshot_value(raw, "2026-08-13T12:00:00Z")
            .unwrap();
        let mut table = AgentTable::default();
        table.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents: normalized.agents,
            workspaces: Some(normalized.workspaces),
        });
        let shutdown = CancellationToken::new();
        let mut selected = None;
        let mut scene_view = SceneView::Kitchen;
        let mut help_open = false;

        assert!(!handle_key_with_scope(
            KeyCode::Char('?'),
            &table,
            &mut selected,
            &mut scene_view,
            &mut help_open,
            &mut Scope::default(),
            &shutdown,
        ));
        assert!(help_open);
        for code in [
            KeyCode::Tab,
            KeyCode::BackTab,
            KeyCode::Char('b'),
            KeyCode::Char('f'),
        ] {
            assert!(!handle_key_with_scope(
                code,
                &table,
                &mut selected,
                &mut scene_view,
                &mut help_open,
                &mut Scope::default(),
                &shutdown,
            ));
        }
        assert_eq!(selected, None);
        assert_eq!(scene_view, SceneView::Kitchen);

        let compact = render_scene(&table, 79, 23, None, scene_view, help_open);
        let narrow = render_scene(&table, 20, 12, None, scene_view, help_open);
        assert!(!narrow.contains(HELP_LINES[1]));
        for wrapped in ["Shift+Tab", "inspect", "leave", "q quit"] {
            assert!(
                narrow.contains(wrapped),
                "missing wrapped help text {wrapped:?} in {narrow:?}"
            );
        }

        assert!(!handle_key_with_scope(
            KeyCode::Char('?'),
            &table,
            &mut selected,
            &mut scene_view,
            &mut help_open,
            &mut Scope::default(),
            &shutdown,
        ));
        assert!(!handle_key_with_scope(
            KeyCode::Tab,
            &table,
            &mut selected,
            &mut scene_view,
            &mut help_open,
            &mut Scope::default(),
            &shutdown,
        ));
        assert_eq!(selected.as_deref(), Some("fictional-terminal-20"));
        assert!(!handle_key_with_scope(
            KeyCode::Char('?'),
            &table,
            &mut selected,
            &mut scene_view,
            &mut help_open,
            &mut Scope::default(),
            &shutdown,
        ));
        let kitchen = render_scene(&table, 80, 24, selected.as_deref(), scene_view, help_open);
        assert!(!handle_key_with_scope(
            KeyCode::Char('?'),
            &table,
            &mut selected,
            &mut scene_view,
            &mut help_open,
            &mut Scope::default(),
            &shutdown,
        ));
        assert!(!handle_key_with_scope(
            KeyCode::Char('f'),
            &table,
            &mut selected,
            &mut scene_view,
            &mut help_open,
            &mut Scope::default(),
            &shutdown,
        ));
        assert_eq!(scene_view, SceneView::Freezer);
        assert!(!handle_key_with_scope(
            KeyCode::Char('?'),
            &table,
            &mut selected,
            &mut scene_view,
            &mut help_open,
            &mut Scope::default(),
            &shutdown,
        ));
        for code in [
            KeyCode::Tab,
            KeyCode::BackTab,
            KeyCode::Char('b'),
            KeyCode::Char('f'),
        ] {
            assert!(!handle_key_with_scope(
                code,
                &table,
                &mut selected,
                &mut scene_view,
                &mut help_open,
                &mut Scope::default(),
                &shutdown,
            ));
        }
        assert_eq!(selected.as_deref(), Some("fictional-terminal-20"));
        assert_eq!(scene_view, SceneView::Freezer);

        let freezer = render_scene(&table, 80, 24, selected.as_deref(), scene_view, help_open);
        let freezer_fallback = render_scene(&table, 79, 23, selected.as_deref(), scene_view, false);
        assert!(freezer_fallback.contains("> example-cook"));
        assert!(!freezer_fallback.contains("tick "));
        for output in [&kitchen, &freezer, &compact] {
            for line in HELP_LINES {
                assert!(output.contains(line), "missing {line:?} in {output:?}");
            }
            let lower = output.to_ascii_lowercase();
            for absent in ["approve", "kill", "prompt"] {
                assert!(
                    !lower.contains(absent),
                    "unexpected {absent:?} in {output:?}"
                );
            }
        }
        assert!(
            kitchen.contains("example-cook"),
            "missing example-cook in {kitchen:?}"
        );
        assert!(inspect_facts(table.agents().next().unwrap())[3].contains("WORKING / ON THE FIRE"));

        assert!(!handle_key_with_scope(
            KeyCode::Esc,
            &table,
            &mut selected,
            &mut scene_view,
            &mut help_open,
            &mut Scope::default(),
            &shutdown,
        ));
        assert!(!help_open);
        assert!(selected.is_some());
        assert_eq!(scene_view, SceneView::Freezer);
        assert!(!shutdown.is_cancelled());
        assert!(!handle_key_with_scope(
            KeyCode::Esc,
            &table,
            &mut selected,
            &mut scene_view,
            &mut help_open,
            &mut Scope::default(),
            &shutdown,
        ));
        assert_eq!(selected, None);
        assert_eq!(scene_view, SceneView::Freezer);
        assert!(!handle_key_with_scope(
            KeyCode::Esc,
            &table,
            &mut selected,
            &mut scene_view,
            &mut help_open,
            &mut Scope::default(),
            &shutdown,
        ));
        assert_eq!(scene_view, SceneView::Kitchen);
        assert!(handle_key_with_scope(
            KeyCode::Esc,
            &table,
            &mut selected,
            &mut scene_view,
            &mut help_open,
            &mut Scope::default(),
            &shutdown,
        ));
        assert!(shutdown.is_cancelled());

        let quit = CancellationToken::new();
        help_open = true;
        assert!(handle_key_with_scope(
            KeyCode::Char('q'),
            &table,
            &mut selected,
            &mut scene_view,
            &mut help_open,
            &mut Scope::default(),
            &quit,
        ));
        assert!(quit.is_cancelled());
        assert!(help_open);
    }

    #[test]
    fn durations_and_state_words_are_readable() {
        assert_eq!(format_duration(0), "0s");
        assert_eq!(format_duration(59_999), "59s");
        assert_eq!(format_duration(60_000), "1m 0s");
        assert_eq!(format_duration(3_661_000), "1h 1m");
        assert_eq!(state_label(&AgentState::Blocked), "BLOCKED / AT THE PASS");
        assert_eq!(state_label(&AgentState::Ended), "86'D / SESSION ENDED");
    }

    #[test]
    fn status_copy_is_truthful_for_live_demo_and_source_failures() {
        assert_eq!(
            status_lines(AppMode::Live, &SourceStatus::Connected, None, 1),
            ("MISE — LIVE".into(), "Connected to Herdr".into())
        );
        assert_eq!(
            status_lines(AppMode::Live, &SourceStatus::Connected, None, 0),
            (
                "MISE — LIVE".into(),
                "Waiting for agents — start one in herdr".into()
            )
        );
        assert_eq!(
            status_lines(AppMode::Demo, &SourceStatus::Timeout, None, 2),
            (
                "MISE — DEMO SERVICE".into(),
                "Mock feed — Herdr did not respond in time. Nothing here is real.".into()
            )
        );
        let diagnostic = SourceDiagnostic {
            observed_protocol: 23,
            supported_protocols: vec![17, 19, 20],
            next_action: "upgrade Herdr, then retry".into(),
        };
        assert_eq!(
            status_lines(
                AppMode::Demo,
                &SourceStatus::UnsupportedProtocol,
                Some(&diagnostic),
                0,
            ),
            (
                "MISE — DEMO SERVICE".into(),
                "Mock feed — Herdr protocol is unsupported — observed 23; supported: 17, 19, 20; upgrade Herdr, then retry. Nothing here is real.".into()
            )
        );
        let incompatible = SourceDiagnostic {
            observed_protocol: 20,
            supported_protocols: vec![17, 19, 20],
            next_action: "ensure terminal identities are unique, then retry".into(),
        };
        assert_eq!(
            status_lines(
                AppMode::Live,
                &SourceStatus::IncompatibleResponse,
                Some(&incompatible),
                0,
            ),
            (
                "MISE — LIVE".into(),
                "Herdr returned an incompatible response — ensure terminal identities are unique, then retry".into()
            )
        );
    }

    #[test]
    fn full_surface_renders_columns_blocked_salience_and_board() {
        let mut table = AgentTable::default();
        table.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents: vec![record("blocked", AgentState::Blocked)],
            workspaces: None,
        });
        apply_upsert(&mut table, record("ended", AgentState::Ended));
        let backend = TestBackend::new(110, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-13T12:02:05Z")
            .unwrap()
            .with_timezone(&Utc);
        terminal
            .draw(|frame| draw_scoped(frame, &table, None, now, 9, None, 0, &Scope::default()))
            .unwrap();
        let text = buffer_text(&terminal);
        for expected in [
            "MISE — LIVE",
            "Connected to Herdr",
            "AGENT",
            "STATE",
            "ELAPSED",
            "WORKSPACE",
            "TICKETS",
            "RUNTIME",
            "Cook blocked",
            "BLOCKED / AT THE PASS",
            "2m 5s",
            "customer-api",
            "1h 1m",
            "86 BOARD",
            "Cook ended",
        ] {
            assert!(text.contains(expected), "missing {expected:?} in {text:?}");
        }
        let blocked_cells = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .filter(|cell| cell.modifier.contains(ratatui::style::Modifier::REVERSED))
            .count();
        assert!(
            blocked_cells >= 20,
            "blocked row needs strong static treatment"
        );
    }

    #[test]
    fn workspace_scope_compact_header_filters_and_marks_unavailable() {
        let mut here = record("here", AgentState::Working);
        here.workspace_id = Some("ws-1".into());
        let mut elsewhere = record("elsewhere", AgentState::Blocked);
        elsewhere.workspace_id = Some("ws-2".into());
        let mut table = AgentTable::default();
        table.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents: vec![here, elsewhere],
            workspaces: Some(vec![WorkspaceRecord {
                id: "ws-1".into(),
                label: "/srv/Kitchen One".into(),
            }]),
        });
        let now = DateTime::parse_from_rfc3339("2026-08-13T12:02:05Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut terminal = Terminal::new(TestBackend::new(110, 24)).unwrap();
        let scope = Scope {
            id: Some("ws-1".into()),
            label: Some("/srv/Kitchen One".into()),
        };
        terminal
            .draw(|frame| draw_scoped(frame, &table, None, now, 0, None, 0, &scope))
            .unwrap();
        let output = buffer_text(&terminal);
        assert!(output.contains("Workspace: Kitchen One · 1 blocked elsewhere"));
        assert!(output.contains("Cook here"));
        assert!(!output.contains("Cook elsewhere"));

        let mut narrow = Terminal::new(TestBackend::new(20, 24)).unwrap();
        narrow
            .draw(|frame| draw_scoped(frame, &table, None, now, 0, None, 0, &scope))
            .unwrap();
        let narrow_output = buffer_text(&narrow);
        for expected in ["Workspace:", "Kitchen", "One", "blocked", "elsewhere"] {
            assert!(
                narrow_output.contains(expected),
                "missing {expected:?} in {narrow_output:?}"
            );
        }

        let unavailable = Scope {
            id: Some("removed".into()),
            label: Some("Gone".into()),
        };
        terminal
            .draw(|frame| draw_scoped(frame, &table, None, now, 0, None, 0, &unavailable))
            .unwrap();
        assert!(buffer_text(&terminal).contains("Workspace: Gone (unavailable)"));
    }

    #[tokio::test]
    async fn workspace_scope_fixture_flows_through_feed_keys_and_test_backend() {
        let mut normalizer = Normalizer::default();
        let mut raw: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/snapshot-workspace-scope.json"
        ))
        .unwrap();
        let feed = Feed::fixed(AppMode::Live, vec![]).await;
        let mut changes = feed.subscribe();
        feed.apply_normalized_for_test(
            normalizer
                .normalize_snapshot_value(raw.clone(), "2026-08-13T12:00:00Z")
                .unwrap(),
        )
        .await;
        let mut table = AgentTable::default();
        table.apply(changes.recv().await.unwrap());
        let shutdown = CancellationToken::new();
        let mut selected = None;
        let mut view = SceneView::Kitchen;
        let mut help_open = false;
        let mut scope = Scope::default();

        for expected in ["scope-workspace-empty", "scope-workspace-one"] {
            assert!(!handle_key_with_scope(
                KeyCode::Char('w'),
                &table,
                &mut selected,
                &mut view,
                &mut help_open,
                &mut scope,
                &shutdown,
            ));
            assert_eq!(scope.id.as_deref(), Some(expected));
        }
        assert_eq!(table.blocked_elsewhere(scope.id.as_deref()), 1);

        let now = DateTime::parse_from_rfc3339("2026-08-13T12:02:05Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut scene_terminal = Terminal::new(TestBackend::new(110, 40)).unwrap();
        scene_terminal
            .draw(|frame| {
                scene::draw_view_scoped(
                    frame,
                    &table,
                    None,
                    now,
                    0,
                    super::super::canvas::ColorMode::Xterm256,
                    true,
                    None,
                    0,
                    SceneView::Kitchen,
                    false,
                    false,
                    &scope,
                )
            })
            .unwrap();
        let scene_output = buffer_text(&scene_terminal);
        assert!(scene_output.contains("Workspace: duplicate (aceone) · 1 blocked elsewhere"));
        assert!(scene_output.contains("scope-working"));
        assert!(scene_output.contains("‼ BLOCKED  scope-blocked"));

        let mut terminal = Terminal::new(TestBackend::new(110, 24)).unwrap();
        terminal
            .draw(|frame| draw_scoped(frame, &table, None, now, 0, None, 0, &scope))
            .unwrap();
        let output = buffer_text(&terminal);
        assert!(output.contains("Workspace: duplicate (aceone) · 1 blocked elsewhere"));
        assert!(output.contains("scope-working"));
        assert!(!output.contains("scope-blocked"));

        raw["workspaces"][0]["label"] = "renamed".into();
        feed.apply_normalized_for_test(
            normalizer
                .normalize_snapshot_value(raw.clone(), "2026-08-13T12:00:01Z")
                .unwrap(),
        )
        .await;
        table.apply(changes.recv().await.unwrap());
        reconcile_scope(&mut scope, &table);
        assert_eq!(scope.label.as_deref(), Some("renamed"));

        raw["workspaces"] = serde_json::json!([
            raw["workspaces"][1].clone(),
            raw["workspaces"][2].clone(),
            { "workspace_id": "scope-workspace-new", "label": "renamed" }
        ]);
        raw["agents"] = serde_json::json!([
            raw["agents"][1].clone(),
            {
                "terminal_id": "scope-terminal-new",
                "pane_id": "scope-pane-new",
                "workspace_id": "scope-workspace-new",
                "display_agent": "scope-new",
                "agent_status": "working"
            }
        ]);
        feed.apply_normalized_for_test(
            normalizer
                .normalize_snapshot_value(raw, "2026-08-13T12:00:02Z")
                .unwrap(),
        )
        .await;
        table.apply(changes.recv().await.unwrap());
        table.apply(changes.recv().await.unwrap());
        reconcile_scope(&mut scope, &table);
        terminal
            .draw(|frame| draw_scoped(frame, &table, None, now, 0, None, 0, &scope))
            .unwrap();
        let output = buffer_text(&terminal);
        assert!(output.contains("Workspace: renamed (unavailable) · 1 blocked elsewhere"));
        assert!(!output.contains("scope-new"));

        assert!(!handle_key_with_scope(
            KeyCode::Char('a'),
            &table,
            &mut selected,
            &mut view,
            &mut help_open,
            &mut scope,
            &shutdown,
        ));
        assert_eq!(scope, Scope::default());
        assert_eq!(table.scoped_agents(None).count(), 2);
    }

    #[test]
    fn deterministic_complete_buffer_goldens() {
        let mut demo = AgentTable::default();
        demo.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Demo,
            source_status: SourceStatus::UnavailableSocket,
            source_diagnostic: None,
            agents: vec![record("demo", AgentState::Working)],
            workspaces: None,
        });
        demo.apply(AgentStateEvent::Delta {
            version: 1,
            mode: AppMode::Demo,
            operation: DeltaOperation::Upsert,
            agent: Some(record("finished", AgentState::Ended)),
            agent_id: None,
        });
        let mut mismatches = Vec::new();
        if let Err(error) = golden_result("demo", &demo, Some("HTTP 127.0.0.1:8686 unavailable")) {
            mismatches.push(error);
        }

        let mut live = AgentTable::default();
        live.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents: vec![record("blocked", AgentState::Blocked)],
            workspaces: None,
        });
        if let Err(error) = golden_result("live-blocked", &live, None) {
            mismatches.push(error);
        }

        let mut waiting = AgentTable::default();
        waiting.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents: vec![],
            workspaces: None,
        });
        if let Err(error) = golden_result("waiting", &waiting, None) {
            mismatches.push(error);
        }

        let mut unsupported = AgentTable::default();
        unsupported.apply(fixture("snapshot-demo-unsupported.v1.json"));
        if let Err(error) = golden_result("unsupported", &unsupported, None) {
            mismatches.push(error);
        }
        assert!(mismatches.is_empty(), "{}", mismatches.join("\n\n"));
    }

    #[test]
    fn fixed_inputs_render_status_surface() {
        let backend = TestBackend::new(60, 12);
        let mut terminal = Terminal::new(backend).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        terminal
            .draw(|frame| {
                draw_scoped(
                    frame,
                    &AgentTable::default(),
                    Some("bind warning"),
                    now,
                    7,
                    None,
                    0,
                    &Scope::default(),
                )
            })
            .unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("MISE — DEMO SERVICE"));
        assert!(rendered.contains("bind warning"));
        assert!(rendered.contains("q / Esc quit"));
        assert!(!rendered.contains("tick "));
    }

    #[test]
    fn unsupported_source_treatment_stays_actionable_at_narrow_sizes() {
        let mut table = AgentTable::default();
        table.apply(fixture("snapshot-demo-unsupported.v1.json"));
        let now = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        for (width, height) in [(80, 24), (60, 12)] {
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).unwrap();
            terminal
                .draw(|frame| draw_scoped(frame, &table, None, now, 7, None, 0, &Scope::default()))
                .unwrap();
            let rendered = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>();
            let rendered = rendered.split_whitespace().collect::<Vec<_>>().join(" ");
            for expected in [
                "MISE — DEMO SERVICE",
                "Mock feed",
                "unsupported",
                "observed 23",
                "supported: 17, 19, 20",
                "upgrade or downgrade Herdr to a tested release, then retry",
                "Nothing here is real",
                "q / Esc quit",
            ] {
                assert!(
                    rendered.contains(expected),
                    "{width}x{height} missing {expected:?} in {rendered:?}"
                );
            }
        }
    }

    #[test]
    fn compact_view_strips_c0_c1_del_from_herdr_strings() {
        let mut event = fixture("snapshot.v1.json");
        let tainted = "\x1b[31m\u{9b}\x7fSAFE";
        let AgentStateEvent::Snapshot {
            source_status,
            source_diagnostic,
            agents,
            ..
        } = &mut event
        else {
            unreachable!()
        };
        *source_status = SourceStatus::UnsupportedProtocol;
        *source_diagnostic = Some(SourceDiagnostic {
            observed_protocol: 23,
            supported_protocols: vec![20],
            next_action: tainted.into(),
        });
        for agent in agents.iter_mut() {
            agent.name = tainted.into();
            agent.model = tainted.into();
            agent.workspace = format!("/work/{tainted}");
        }
        let mut ended = agents[0].clone();
        ended.state = AgentState::Ended;
        let mut table = AgentTable::default();
        table.apply(event);
        apply_upsert(&mut table, ended);

        let mut terminal = Terminal::new(TestBackend::new(79, 23)).unwrap();
        terminal
            .draw(|frame| {
                draw_scoped(
                    frame,
                    &table,
                    None,
                    Utc::now(),
                    0,
                    Some("agent-02"),
                    0,
                    &Scope::default(),
                )
            })
            .unwrap();
        let output = buffer_text(&terminal);
        assert!(output.contains("[31mSAFE"));
        assert!(['\x1b', '\u{9b}', '\x7f']
            .into_iter()
            .all(|character| !output.contains(character)));
    }
}
