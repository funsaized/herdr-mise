use chrono::{DateTime, Utc};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table, Wrap},
    Frame,
};

use super::{
    freezer_keys,
    state::{AgentTable, BoardEntry, BOARD_CAP},
    theme, HitRegion, Scope,
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

pub(super) fn freezer_inspect_paragraph(
    entry: &BoardEntry,
    ordinal: usize,
    total: usize,
) -> Paragraph<'static> {
    let tickets = board_tickets(entry);
    Paragraph::new(vec![
        Line::from(format!("Retained session: {ordinal} of {total}")),
        Line::from(format!(
            "{} · {}",
            sanitize_external(&entry.name),
            state_label(&entry.final_state)
        )),
        Line::from(format!(
            "Mise runtime: {} · Tickets: {tickets}",
            format_duration(entry.runtime_ms)
        )),
    ])
    .wrap(Wrap { trim: false })
}

fn board_tickets(entry: &BoardEntry) -> String {
    if entry.tickets_available.unwrap_or(entry.tickets > 0) {
        entry.tickets.to_string()
    } else {
        "Unavailable".into()
    }
}

pub(super) fn freezer_inspect_height(
    entry: &BoardEntry,
    ordinal: usize,
    total: usize,
    width: u16,
) -> u16 {
    u16::try_from(freezer_inspect_paragraph(entry, ordinal, total).line_count(width.max(1)))
        .unwrap_or(u16::MAX)
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
        .find(|agent| scope.is_none_or(|id| agent.workspace_id.as_deref() == Some(id)))
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
        format!("Mock feed — Nothing here is real. {condition}")
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
    let selected_index = selected_id.and_then(|id| agents.iter().position(|agent| agent.id == id));
    let board_height = u16::try_from(table.board().len().min(3))
        .unwrap_or(3)
        .saturating_add(2);
    let constraints = vec![
        Constraint::Length(header_height),
        Constraint::Length(table_height),
        Constraint::Length(board_height),
        Constraint::Min(0),
        Constraint::Length(1),
    ];
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area)
        .to_vec();
    let capacity = usize::from(areas[1].height.saturating_sub(3));
    FallbackLayout {
        areas,
        window: window_for(agent_count, capacity, selected_index, requested_offset),
    }
}

fn window_for(
    agent_count: usize,
    capacity: usize,
    selected_index: Option<usize>,
    requested_offset: usize,
) -> TableWindow {
    let mut offset = requested_offset.min(agent_count.saturating_sub(capacity));
    if let Some(index) = selected_index {
        if index < offset {
            offset = index;
        } else if index >= offset.saturating_add(capacity) {
            offset = index.saturating_add(1).saturating_sub(capacity);
        }
    }
    TableWindow {
        offset,
        end: offset.saturating_add(capacity).min(agent_count),
    }
}

pub(crate) fn stats_table_window(
    area: Rect,
    agents: &[&AgentRecord],
    selected_id: Option<&str>,
    requested_offset: usize,
) -> TableWindow {
    window_for(
        agents.len(),
        usize::from(area.height.saturating_sub(3)),
        selected_id.and_then(|id| agents.iter().position(|agent| agent.id == id)),
        requested_offset,
    )
}

fn stats_hit_regions(area: Rect, agents: &[&AgentRecord], window: TableWindow) -> Vec<HitRegion> {
    agents
        .iter()
        .skip(window.offset)
        .take(window.end.saturating_sub(window.offset))
        .enumerate()
        .map(|(row, agent)| HitRegion {
            area: Rect::new(
                area.x + 1,
                area.y + 2 + row as u16,
                area.width.saturating_sub(2),
                1,
            ),
            agent_id: agent.id.clone(),
            table_row: true,
        })
        .collect()
}

pub(crate) fn render_stats_table(
    frame: &mut Frame<'_>,
    area: Rect,
    agents: &[&AgentRecord],
    selected_id: Option<&str>,
    requested_offset: usize,
    now: DateTime<Utc>,
) -> (TableWindow, Vec<HitRegion>) {
    let window = stats_table_window(area, agents, selected_id, requested_offset);
    let inner_width = area.width.saturating_sub(2);
    let (kind_width, mut pane_width, mut workspace_width, state_width, elapsed_width) =
        if inner_width >= 90 {
            (11, 11, 16, 21, 9)
        } else if inner_width >= 70 {
            (7, 7, 9, 21, 9)
        } else if inner_width >= 54 {
            (7, 7, 9, 11, 7)
        } else if inner_width >= 50 {
            (5, 6, 7, 9, 7)
        } else {
            (4, 5, 5, 7, 5)
        };
    let show_elapsed = inner_width >= theme::KITCHEN_TABLE_ELAPSED_MIN_WIDTH;
    let mut show_tickets = inner_width >= theme::KITCHEN_TABLE_TICKETS_MIN_WIDTH;
    let mut show_runtime = inner_width >= theme::KITCHEN_TABLE_RUNTIME_MIN_WIDTH;
    if inner_width >= 140 {
        // Give the roster's actual locators room before spending spare width on names.
        // The budget depends on the viewport and roster, never the selected row.
        let required_pane = agents
            .iter()
            .map(|agent| display_width(&available(agent.pane_id.as_deref())) as u16)
            .max()
            .unwrap_or(pane_width)
            .max(pane_width);
        let required_workspace = agents
            .iter()
            .map(|agent| display_width(&available(Some(&agent.workspace))) as u16)
            .max()
            .unwrap_or(workspace_width)
            .max(workspace_width);
        let fixed = 2 + kind_width + state_width + 5 + 12 + elapsed_width + 1;
        if fixed + required_pane + required_workspace + 8 + 10 > inner_width {
            show_runtime = false;
        }
        if fixed + required_pane + required_workspace + 8 > inner_width {
            show_tickets = false;
        }
        let locator_budget = inner_width.saturating_sub(
            fixed + if show_tickets { 8 } else { 0 } + if show_runtime { 10 } else { 0 },
        );
        pane_width = required_pane.min(locator_budget.saturating_sub(workspace_width));
        workspace_width = required_workspace.min(locator_budget.saturating_sub(pane_width));
    }
    let agent_width = inner_width.saturating_sub(
        2 + kind_width
            + pane_width
            + workspace_width
            + state_width
            + 5
            + if show_elapsed { elapsed_width + 1 } else { 0 }
            + if show_tickets { 8 } else { 0 }
            + if show_runtime { 10 } else { 0 },
    );
    let rows = agents
        .iter()
        .copied()
        .skip(window.offset)
        .take(window.end.saturating_sub(window.offset))
        .map(|agent| {
            let selected = selected_id == Some(agent.id.as_str());
            let entered = DateTime::parse_from_rfc3339(&agent.state_entered_at)
                .ok()
                .map(|value| value.with_timezone(&Utc));
            let elapsed = entered
                .map(|value| now.signed_duration_since(value).num_milliseconds().max(0) as u64)
                .unwrap_or(0);
            let mut cells = vec![
                Cell::from(format!(
                    "{}{}",
                    if selected { '>' } else { ' ' },
                    if agent.state == AgentState::Blocked {
                        '!'
                    } else {
                        ' '
                    }
                )),
                Cell::from(compact_text(
                    &sanitize_external(&agent.name),
                    agent_width.into(),
                ))
                .style(Style::default().fg(theme::accent(agent.accent_index))),
                Cell::from(compact_text(
                    &available(agent.agent_kind.as_deref()),
                    kind_width.into(),
                )),
                Cell::from(compact_text(
                    &available(agent.pane_id.as_deref()),
                    pane_width.into(),
                )),
                Cell::from(compact_text(
                    &available(Some(if inner_width >= 140 {
                        &agent.workspace
                    } else {
                        workspace_display_name(&agent.workspace)
                    })),
                    workspace_width.into(),
                )),
                Cell::from(take_width(
                    record_state_label(agent),
                    state_width.into(),
                    false,
                ))
                .style(Style::default().fg(theme::state_color(&agent.state))),
            ];
            if show_elapsed {
                cells.push(Cell::from(format_duration(elapsed)));
            }
            if show_tickets {
                cells.push(Cell::from(agent.session.tickets_text()));
            }
            if show_runtime {
                cells.push(Cell::from(format_duration(agent.session.runtime_ms)));
            }
            let mut style = if selected {
                Style::default().fg(theme::TEXT).bg(theme::PANEL2)
            } else {
                Style::default()
            };
            if agent.state == AgentState::Blocked {
                style = style.add_modifier(Modifier::BOLD);
            }
            Row::new(cells).style(style)
        });
    let mut widths = vec![
        Constraint::Length(2),
        Constraint::Length(agent_width),
        Constraint::Length(kind_width),
        Constraint::Length(pane_width),
        Constraint::Length(workspace_width),
        Constraint::Length(state_width),
    ];
    let mut headings = vec!["", "AGENT", "KIND", "PANE", "WORKSPACE", "STATE"];
    if show_elapsed {
        widths.push(Constraint::Length(elapsed_width));
        headings.push("ELAPSED");
    }
    if show_tickets {
        widths.push(Constraint::Length(7));
        headings.push("TICKETS");
    }
    if show_runtime {
        widths.push(Constraint::Length(9));
        headings.push("MISE");
    }
    let blocked_count = agents
        .iter()
        .filter(|agent| agent.state == AgentState::Blocked)
        .count();
    let range_start = usize::from(!agents.is_empty() && window.end > window.offset) + window.offset;
    frame.render_widget(
        Table::new(rows, widths)
            .header(Row::new(headings).style(Style::default().add_modifier(Modifier::BOLD)))
            .column_spacing(1)
            .block(Block::default().borders(Borders::ALL).title(format!(
                "Kitchen status · {range_start}-{}/{} · {blocked_count} blocked",
                window.end,
                agents.len()
            ))),
        area,
    );
    let hits = stats_hit_regions(area, agents, window);
    (window, hits)
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
        table.agents().count(),
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
pub(crate) fn draw_scoped_with_hits(
    frame: &mut Frame<'_>,
    table: &AgentTable,
    warning: Option<&str>,
    now: DateTime<Utc>,
    _tick: u64,
    selected_id: Option<&str>,
    table_offset: usize,
    scope: &Scope,
) -> Vec<HitRegion> {
    let compact = frame.area().height < 20;
    let agents = table.scoped_agents(scope.id.as_deref()).collect::<Vec<_>>();
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
    let (_, hits) = render_stats_table(
        frame,
        areas[1],
        &agents,
        selected_id,
        layout.window.offset,
        now,
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
    let keys = if selected_id.is_some() {
        "Tab / Shift+Tab select · b next blocked · w scope · a all · Esc close · q quit"
    } else {
        "q / Esc quit · b next blocked · w scope · a all"
    };
    let board = format!("86 {}/{BOARD_CAP}", table.board().len());
    let status = warning.map_or_else(
        || format!("{keys} · {board}"),
        |warning| format!("{} · {keys} · {board}", sanitize_external(warning)),
    );
    frame.render_widget(Paragraph::new(Line::from(status)), areas[4]);
    hits
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_scoped(
    frame: &mut Frame<'_>,
    table: &AgentTable,
    warning: Option<&str>,
    now: DateTime<Utc>,
    tick: u64,
    selected_id: Option<&str>,
    table_offset: usize,
    scope: &Scope,
) {
    let _ = draw_scoped_with_hits(
        frame,
        table,
        warning,
        now,
        tick,
        selected_id,
        table_offset,
        scope,
    );
}

pub(crate) fn draw_freezer_scoped(
    frame: &mut Frame<'_>,
    table: &AgentTable,
    warning: Option<&str>,
    now: DateTime<Utc>,
    selected_id: Option<&str>,
) {
    let total = table.board().len();
    let selected = selected_id.and_then(|id| table.board_entry(id));
    let inspect_height = selected
        .map(|(index, entry)| freezer_inspect_height(entry, index + 1, total, frame.area().width))
        .unwrap_or(0);
    let (title, source_copy) = status_lines(
        table.mode(),
        table.source_status(),
        table.source_diagnostic(),
        table.agents().count(),
    );
    let header = Paragraph::new(vec![
        Line::from(Span::styled(
            title,
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(source_copy),
        Line::from(service_line(table, now, None)),
    ])
    .wrap(Wrap { trim: true });
    let header_height =
        u16::try_from(header.line_count(frame.area().width.max(1))).unwrap_or(u16::MAX);
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(header_height),
            Constraint::Min(3),
            Constraint::Length(inspect_height),
            Constraint::Length(1),
        ])
        .split(frame.area());
    frame.render_widget(header, areas[0]);

    let capacity = usize::from(areas[1].height.saturating_sub(3)).max(1);
    let selected_newest_index = selected.map(|(index, _)| total - index - 1);
    let offset = selected_newest_index
        .map(|index| index.saturating_sub(capacity - 1))
        .unwrap_or(0);
    let rows = table
        .board()
        .iter()
        .enumerate()
        .rev()
        .skip(offset)
        .take(capacity)
        .map(|(index, entry)| {
            let is_selected = selected_id == Some(entry.id.as_str());
            Row::new([
                if is_selected {
                    format!("> {} of {total}", index + 1)
                } else {
                    format!("{} of {total}", index + 1)
                },
                sanitize_external(&entry.name),
                state_label(&entry.final_state).into(),
                format_duration(entry.runtime_ms),
                board_tickets(entry),
            ])
            .style(if is_selected {
                Style::default().add_modifier(Modifier::BOLD | Modifier::REVERSED)
            } else {
                Style::default()
            })
        });
    let title = if total == 0 {
        format!("Freezer empty · no ended sessions · retention limit {BOARD_CAP}")
    } else {
        format!("Ended sessions · {total} inspectable · latest {BOARD_CAP} retained")
    };
    frame.render_widget(
        Table::new(
            rows,
            [
                Constraint::Length(theme::FREEZER_TABLE_RETAINED_WIDTH),
                Constraint::Min(theme::FREEZER_TABLE_CHEF_MIN_WIDTH),
                Constraint::Length(theme::FREEZER_TABLE_FINAL_WIDTH),
                Constraint::Length(theme::FREEZER_TABLE_MISE_WIDTH),
                Constraint::Length(theme::FREEZER_TABLE_TICKETS_WIDTH),
            ],
        )
        .header(Row::new(["RETAINED", "CHEF", "FINAL", "MISE", "TICKETS"]))
        .block(Block::default().borders(Borders::ALL).title(title)),
        areas[1],
    );
    if let Some((index, entry)) = selected {
        frame.render_widget(freezer_inspect_paragraph(entry, index + 1, total), areas[2]);
    }
    let keys = freezer_keys(
        selected.is_some(),
        frame.area().width <= theme::FREEZER_COMPACT_FOOTER_MAX_WIDTH,
    );
    let status = warning.map_or_else(
        || keys.clone(),
        |warning| format!("{} · {keys}", sanitize_external(warning)),
    );
    frame.render_widget(Paragraph::new(status), areas[3]);
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
        assert_eq!(super::record_state_label(&agents[0]), "UNKNOWN / AT PREP");
        assert_eq!(agents[0].session.tickets_text(), "Unavailable");
        assert_eq!(agents[1].session.tickets_text(), "0");
    }
    use super::super::{
        handle_key_with_scope, handle_mouse, reconcile_scope, retain_board_selection,
        retain_selection, scene, SceneView, HELP_LINES, KEY_ESC_KITCHEN,
    };
    use super::*;
    use crate::adapter::Normalizer;
    use crate::feed::Feed;
    use crate::protocol::{
        AgentRecord, AgentStateEvent, DeltaOperation, SessionStats, SourceDiagnostic, SourceStatus,
        WorkspaceRecord,
    };
    use crossterm::event::{KeyCode, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
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
        assert!(narrow.contains("codex"), "{narrow}");
        let narrow_freezer = render_scene(
            &long_table,
            80,
            24,
            Some("fictional-terminal-19"),
            SceneView::Freezer,
            false,
        );
        assert!(
            narrow_freezer.contains("FREEZER EMPTY · NO ENDED SESSIONS · LIMIT 64"),
            "{narrow_freezer}"
        );
        assert!(!narrow_freezer.contains("Agent kind:"), "{narrow_freezer}");

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
        assert!(initial.contains("example-pantry"));
        assert!(initial.contains("codex"));
        assert!(initial.contains("prefix-19"));
        let (wide, wide_hits) = render_with_hits(&table, 160, 48, Some(selected_id));
        let wide_text = |buffer: &Buffer| {
            (0..buffer.area.height)
                .map(|y| {
                    (0..buffer.area.width)
                        .map(|x| buffer[(x, y)].symbol())
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let wide_output = wide_text(&wide);
        assert!(
            wide_output.contains("/work/one/example-pantry"),
            "{wide_output}"
        );
        let (other, other_hits) = render_with_hits(&table, 160, 48, Some("fictional-terminal-20"));
        assert_eq!(wide_hits, other_hits);
        assert!(wide_text(&other).contains("/work/two/example-pantry"));
        let compact = render_scene(&table, 60, 18, Some(selected_id), SceneView::Kitchen, false);
        assert!(compact.contains("codex"));
        assert!(compact.contains("-19"), "{compact}");

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
        assert!(moved.contains("moved"));
        let freezer = render_scene(
            &table,
            100,
            30,
            Some(selected_id),
            SceneView::Freezer,
            false,
        );
        assert!(freezer.contains("FREEZER EMPTY"));
        assert!(!freezer.contains("Agent kind: codex"));
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

    #[tokio::test]
    async fn freezer_real_fixture_traverses_all_retained_sessions_and_escape_layers() {
        let raw = serde_json::from_str(include_str!("../../tests/fixtures/snapshot-working.json"))
            .unwrap();
        let normalized = Normalizer::default()
            .normalize_snapshot_value(raw, "2026-08-13T12:00:00Z")
            .unwrap();
        let feed = Feed::fixed(AppMode::Live, normalized.agents).await;
        let mut table = AgentTable::default();
        table.apply(feed.snapshot().await);
        let mut lifetime = table.agents().next().unwrap().clone();
        for ordinal in 1..=BOARD_CAP {
            lifetime.name = format!("Fixture lifetime {ordinal}");
            lifetime.state = AgentState::Working;
            apply_upsert(&mut table, lifetime.clone());
            lifetime.state = AgentState::Ended;
            lifetime.session.runtime_ms = ordinal as u64 * 1_000;
            lifetime.session.tickets = ordinal as u64;
            lifetime.session.tickets_available = Some(true);
            apply_upsert(&mut table, lifetime.clone());
        }
        assert_eq!(table.board().len(), BOARD_CAP);
        assert_eq!(
            table
                .board()
                .iter()
                .map(|entry| &entry.id)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            BOARD_CAP
        );

        let newest = table.board().last().unwrap().id.clone();
        let mut fallback = Terminal::new(TestBackend::new(80, 24)).unwrap();
        fallback
            .draw(|frame| {
                scene::draw_view_scoped(
                    frame,
                    &table,
                    None,
                    Utc::now(),
                    0,
                    super::super::canvas::ColorMode::Xterm256,
                    false,
                    Some(&newest),
                    0,
                    SceneView::Freezer,
                    false,
                    true,
                    &Scope::default(),
                )
            })
            .unwrap();
        let fallback = buffer_text(&fallback);
        assert!(fallback.contains("MISE — LIVE"), "{fallback}");
        assert!(
            fallback.contains(&format!("Retained session: {BOARD_CAP} of {BOARD_CAP}")),
            "{fallback}"
        );

        for (width, height) in [(80, 24), (110, 40)] {
            let mut selected = None;
            let mut view = SceneView::Freezer;
            let mut help = false;
            let shutdown = CancellationToken::new();
            for newest_index in 0..BOARD_CAP {
                assert!(!handle_key_with_scope(
                    KeyCode::Tab,
                    &table,
                    &mut selected,
                    &mut view,
                    &mut help,
                    &mut Scope::default(),
                    &shutdown,
                ));
                let ordinal = BOARD_CAP - newest_index;
                let output = render_scene(&table, width, height, selected.as_deref(), view, false);
                assert!(
                    output.contains(&format!("Retained session: {ordinal} of {BOARD_CAP}")),
                    "{width}x{height} selected {selected:?}: {output:?}"
                );
                assert!(output.contains(&format!("Fixture lifetime {ordinal}")));
                let facts = format!(
                    "Mise runtime: {} · Tickets: {ordinal}",
                    format_duration(ordinal as u64 * 1_000)
                );
                assert!(output.contains(&facts), "missing {facts:?} in {output:?}");
            }
            assert!(!handle_key_with_scope(
                KeyCode::Esc,
                &table,
                &mut selected,
                &mut view,
                &mut help,
                &mut Scope::default(),
                &shutdown,
            ));
            assert_eq!(selected, None);
            assert_eq!(view, SceneView::Freezer);
            assert!(!handle_key_with_scope(
                KeyCode::Esc,
                &table,
                &mut selected,
                &mut view,
                &mut help,
                &mut Scope::default(),
                &shutdown,
            ));
            assert_eq!(view, SceneView::Kitchen);
        }

        let oldest = table.board()[0].id.clone();
        let mut selected = Some(oldest);
        lifetime.state = AgentState::Working;
        apply_upsert(&mut table, lifetime.clone());
        lifetime.state = AgentState::Ended;
        apply_upsert(&mut table, lifetime);
        retain_board_selection(&mut selected, &table);
        assert_eq!(selected, None);
    }

    #[tokio::test]
    async fn protocol_21_and_22_fixtures_flow_through_feed_to_tui() {
        let mut normalizer = Normalizer::default();
        let protocol21 = normalizer
            .normalize_snapshot_value(
                serde_json::from_str(include_str!(
                    "../../tests/fixtures/snapshot-herdr-0.8.2-p21.json"
                ))
                .unwrap(),
                "2026-09-01T19:45:00Z",
            )
            .unwrap();
        let feed = Feed::fixed(AppMode::Live, protocol21.agents).await;
        let mut table = AgentTable::default();
        table.apply(feed.snapshot().await);
        assert!(
            render_scene(&table, 80, 24, None, SceneView::Kitchen, false).contains("example-baker")
        );

        let protocol22 = normalizer
            .normalize_snapshot_value(
                serde_json::from_str(include_str!(
                    "../../tests/fixtures/snapshot-herdr-0.9.0-p22.json"
                ))
                .unwrap(),
                "2026-09-06T00:00:00Z",
            )
            .unwrap();
        feed.apply_normalized_for_test(protocol22).await;
        table.apply(feed.snapshot().await);
        let agent = table.agents().next().unwrap();
        assert_eq!(agent.id, "fictional-terminal-current");
        assert_eq!(agent.pane_id.as_deref(), Some("fictional-pane-22"));
        assert_eq!(
            agent.workspace_id.as_deref(),
            Some("fictional-workspace-22")
        );
        let rendered = render_scene(&table, 80, 24, None, SceneView::Kitchen, false);
        assert!(rendered.contains("example-reviewer"), "{rendered}");
        assert!(!rendered.contains("example-baker"), "{rendered}");
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

        for expected in ["example-cook", "WORKING / ON THE FIRE", "Exam…chen"] {
            assert!(
                strip.contains(expected),
                "missing {expected:?} in {strip:?}"
            );
        }
        assert_eq!(strip.matches("Una…ble").count(), 1);
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
        assert!(buffer_text(&compact).contains(">  example-cook"));

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
                    output.contains(&format!(
                        ">{} Cook{index:02}",
                        if index == 29 { '!' } else { ' ' }
                    )),
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
            assert!(render(width, height, selected.as_deref(), &mut offset).contains(">! Cook29"));

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
            assert!(render(width, height, selected.as_deref(), &mut offset).contains(">! Cook29"));
        }

        let selected = Some("fixture-29".to_owned());
        let mut offset = 0;
        render(60, 12, selected.as_deref(), &mut offset);
        let narrow_offset = offset;
        let resized = render(80, 24, selected.as_deref(), &mut offset);
        assert_eq!(selected.as_deref(), Some("fixture-29"));
        assert!(resized.contains(">! Cook29"));
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
        for wrapped in ["Shift+Tab", "select", "leave", "q quit"] {
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
        assert!(freezer_fallback.contains("Freezer empty · no ended sessions"));
        assert!(!freezer_fallback.contains("example-cook"));
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
        assert_eq!(
            record_state_label(table.agents().next().unwrap()),
            "WORKING / ON THE FIRE"
        );

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
                "Mock feed — Nothing here is real. Herdr did not respond in time".into()
            )
        );
        let diagnostic = SourceDiagnostic {
            observed_protocol: 23,
            supported_protocols: vec![17, 19, 20, 21, 22],
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
                "Mock feed — Nothing here is real. Herdr protocol is unsupported — observed 23; supported: 17, 19, 20, 21, 22; upgrade Herdr, then retry".into()
            )
        );
        let incompatible = SourceDiagnostic {
            observed_protocol: 20,
            supported_protocols: vec![17, 19, 20, 21, 22],
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
            "MISE",
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
        let reversed_cells = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .filter(|cell| cell.modifier.contains(ratatui::style::Modifier::REVERSED))
            .count();
        assert_eq!(reversed_cells, 0);
        assert!(terminal
            .backend()
            .buffer()
            .content
            .iter()
            .any(|cell| cell.modifier.contains(Modifier::BOLD)));
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
        assert!(!buffer_text(&terminal).contains("Waiting for agents"));
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
        assert!(output.contains("scope-work"));
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
                .chunks(usize::from(width))
                .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
                .collect::<Vec<_>>()
                .join(" ");
            let rendered = rendered.split_whitespace().collect::<Vec<_>>().join(" ");
            for expected in [
                "MISE — DEMO SERVICE",
                "Mock feed",
                "unsupported",
                "observed 23",
                "supported: 17, 19, 20, 21, 22",
                "upgrade or downgrade Herdr to a tested release, then retry",
                "Nothing here is real",
                "q / Esc quit",
            ] {
                assert!(
                    rendered.contains(expected),
                    "{width}x{height} missing {expected:?} in {rendered:?}"
                );
            }

            let mut freezer = Terminal::new(TestBackend::new(width, height)).unwrap();
            freezer
                .draw(|frame| draw_freezer_scoped(frame, &table, None, now, None))
                .unwrap();
            let freezer = freezer
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            for expected in [
                "Mock feed",
                "observed 23",
                "supported: 17, 19, 20, 21, 22",
                "upgrade or downgrade Herdr to a tested release, then retry",
                "Nothing here is real",
                KEY_ESC_KITCHEN,
            ] {
                assert!(
                    freezer.contains(expected),
                    "freezer {width}x{height} missing {expected:?} in {freezer:?}"
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

    fn normalized_table(fixture: &str) -> AgentTable {
        let raw = std::fs::read_to_string(format!(
            "{}/tests/fixtures/{fixture}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let normalized = Normalizer::default()
            .normalize_snapshot_value(serde_json::from_str(&raw).unwrap(), "2026-08-13T12:00:00Z")
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
        table
    }

    fn render_with_hits(
        table: &AgentTable,
        width: u16,
        height: u16,
        selected: Option<&str>,
    ) -> (Buffer, Vec<super::super::HitRegion>) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut hits = Vec::new();
        terminal
            .draw(|frame| {
                hits = scene::draw_view_scoped_with_hits(
                    frame,
                    table,
                    None,
                    DateTime::parse_from_rfc3339("2026-08-13T12:00:00Z")
                        .unwrap()
                        .with_timezone(&Utc),
                    0,
                    super::super::canvas::ColorMode::Xterm256,
                    true,
                    selected,
                    0,
                    SceneView::Kitchen,
                    false,
                    false,
                    &Scope::default(),
                );
            })
            .unwrap();
        (terminal.backend().buffer().clone(), hits)
    }

    #[tokio::test]
    async fn real_herdr_statistics_table_selection_is_spatially_stable() {
        let normalized = Normalizer::default()
            .normalize_snapshot_value(
                serde_json::from_str(include_str!(
                    "../../tests/fixtures/snapshot-herdr-0.8.2-p20.json"
                ))
                .unwrap(),
                "2026-08-13T12:00:00Z",
            )
            .unwrap();
        let feed = Feed::fixed(AppMode::Live, normalized.agents).await;
        let mut table = AgentTable::default();
        table.apply(feed.snapshot().await);
        let mut selected = None;
        assert!(!handle_key_with_scope(
            KeyCode::Tab,
            &table,
            &mut selected,
            &mut SceneView::Kitchen,
            &mut false,
            &mut Scope::default(),
            &CancellationToken::new(),
        ));
        for (width, height) in [(120, 42), (80, 24), (79, 23), (66, 18), (60, 12)] {
            let (plain, plain_hits) = render_with_hits(&table, width, height, None);
            let (selected_buffer, selected_hits) =
                render_with_hits(&table, width, height, selected.as_deref());
            assert_eq!(plain_hits, selected_hits, "{width}x{height}");
            for hit in plain_hits.iter().filter(|hit| hit.table_row) {
                for x in hit.area.x + 2..hit.area.right() {
                    assert_eq!(
                        plain[(x, hit.area.y)].symbol(),
                        selected_buffer[(x, hit.area.y)].symbol(),
                        "{width}x{height} ({x}, {})",
                        hit.area.y
                    );
                }
            }
            assert!(selected_buffer
                .content
                .iter()
                .any(|cell| cell.symbol() == ">"));
        }
        handle_key_with_scope(
            KeyCode::BackTab,
            &table,
            &mut selected,
            &mut SceneView::Kitchen,
            &mut false,
            &mut Scope::default(),
            &CancellationToken::new(),
        );
        assert!(selected.is_some());
    }

    #[test]
    fn real_herdr_statistics_table_mouse_tracks_visible_rows() {
        let table = normalized_table("snapshot-workspace-scope.json");
        let (buffer, hits) = render_with_hits(&table, 60, 18, None);
        let rows = hits.iter().filter(|hit| hit.table_row).collect::<Vec<_>>();
        assert_eq!(rows.len(), 2);
        let line = |y| (0..60).map(|x| buffer[(x, y)].symbol()).collect::<String>();
        assert!(line(rows[0].area.y - 1).contains("AGENT"));
        assert!(line(rows[0].area.y).contains("scop…king"));
        assert!(line(rows[1].area.y).contains("scop…cked"));
        let mut selected = None;
        let click = |hit: &super::super::HitRegion| MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: hit.area.x,
            row: hit.area.y,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse(click(rows[1]), &hits, &mut selected, false);
        assert_eq!(selected.as_deref(), Some("scope-terminal-two"));
        handle_mouse(
            MouseEvent {
                row: rows[0].area.y.saturating_sub(1),
                ..click(rows[0])
            },
            &hits,
            &mut selected,
            false,
        );
        assert_eq!(selected.as_deref(), Some("scope-terminal-two"));
        handle_mouse(click(rows[0]), &hits, &mut selected, true);
        assert_eq!(selected.as_deref(), Some("scope-terminal-two"));
        handle_mouse(
            MouseEvent {
                kind: MouseEventKind::ScrollDown,
                ..click(rows[0])
            },
            &hits,
            &mut selected,
            false,
        );
        assert_eq!(selected.as_deref(), Some("scope-terminal-two"));
        let (_, scene_hits) = render_with_hits(&table, 120, 42, None);
        let scene_row = scene_hits.iter().find(|hit| hit.table_row).unwrap();
        handle_mouse(click(scene_row), &scene_hits, &mut selected, false);
        assert_eq!(selected.as_deref(), Some(scene_row.agent_id.as_str()));
        let mut empty = normalized_table("snapshot-workspace-scope.json");
        for id in table.agents().map(|agent| agent.id.clone()) {
            empty.apply(AgentStateEvent::Delta {
                version: 2,
                mode: AppMode::Live,
                operation: DeltaOperation::Remove,
                agent: None,
                agent_id: Some(id),
            });
        }
        let (_, cleared) = render_with_hits(&empty, 120, 42, None);
        handle_mouse(click(scene_row), &cleared, &mut selected, false);
        assert_eq!(selected.as_deref(), Some(scene_row.agent_id.as_str()));
    }

    #[test]
    fn real_herdr_statistics_table_compact_layout_preserves_core_values() {
        let table = normalized_table("snapshot-herdr-0.8.2-p20.json");
        let (buffer, _) = render_with_hits(&table, 60, 18, Some("fictional-terminal-20"));
        let output: String = buffer.content.iter().map(|cell| cell.symbol()).collect();
        for expected in [
            "AGENT",
            "KIND",
            "PANE",
            "WORKSPACE",
            "STATE",
            "exam…cook",
            "WORKING / O",
            "ELAPSED",
        ] {
            assert!(
                output.contains(expected),
                "missing {expected:?} in {output:?}"
            );
        }
        assert!(!output.contains("TICKETS"));
        let blocked = normalized_table("snapshot-herdr-0.8.0-p19.json");
        let (blocked_buffer, _) = render_with_hits(
            &blocked,
            60,
            18,
            blocked.agents().next().map(|agent| agent.id.as_str()),
        );
        let blocked_text: String = blocked_buffer
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(blocked_text.contains(">! "), "{blocked_text}");
        assert!(blocked_text.contains("BLOCKED /"));
        assert!(blocked_text.contains("ELAPSED"));

        let mut first = table.agents().next().unwrap().clone();
        first.name = "Ada".into();
        first.state = AgentState::Blocked;
        first.state_entered_at = "2026-08-13T11:59:50Z".into();
        let mut second = first.clone();
        second.id = "second-blocked".into();
        second.name = "Bea".into();
        second.state_entered_at = "2026-08-13T11:59:40Z".into();
        let mut two_blocked = AgentTable::default();
        two_blocked.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents: vec![first, second],
            workspaces: None,
        });
        for width in [52, 60] {
            let (buffer, hits) = render_with_hits(&two_blocked, width, 18, None);
            let rows = hits.iter().filter(|hit| hit.table_row).collect::<Vec<_>>();
            assert_eq!(rows.len(), 2);
            for (hit, name, elapsed) in [(rows[0], "Ada", "10s"), (rows[1], "Bea", "20s")] {
                let text = (0..width)
                    .map(|x| buffer[(x, hit.area.y)].symbol())
                    .collect::<String>();
                assert!(
                    text.contains(name) && text.contains("BLOCKED") && text.contains(elapsed),
                    "{width}x18: {text}"
                );
            }
        }
        let (narrow, hits) = render_with_hits(&two_blocked, 42, 18, None);
        assert_eq!(hits.iter().filter(|hit| hit.table_row).count(), 2);
        for (hit, name) in hits.iter().filter(|hit| hit.table_row).zip(["Ada", "Bea"]) {
            let row = (0..42)
                .map(|x| narrow[(x, hit.area.y)].symbol())
                .collect::<String>();
            assert!(row.contains(name) && row.contains("BLOCKED"), "{row}");
        }
    }

    #[test]
    fn real_herdr_stats_table_retains_selection_across_locator_changes() {
        let mut table = normalized_table("snapshot-herdr-0.8.2-p20.json");
        let selected = "fictional-terminal-20";
        let mut long_agent = table
            .agents()
            .find(|agent| agent.id == selected)
            .unwrap()
            .clone();
        long_agent.pane_id = Some("fictional-pane-with-a-long-shared-prefix-20".into());
        long_agent.workspace = "/work/example-kitchen-with-a-long-label".into();
        apply_upsert(&mut table, long_agent);
        let before = render_with_hits(&table, 160, 48, Some(selected)).0;
        let inspection = render_scene(&table, 80, 24, Some(selected), SceneView::Kitchen, true);
        assert!(inspection.contains("fictional-pane-with-a-long-shared-prefix-20"));
        assert!(inspection.contains("/work/example-kitchen-with-a-long-label"));
        let moved = normalized_table("snapshot-herdr-0.8.2-p20-moved.json");
        table.apply(AgentStateEvent::Snapshot {
            version: 2,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents: moved.agents().cloned().collect(),
            workspaces: Some(moved.workspaces().to_vec()),
        });
        let after = render_with_hits(&table, 160, 48, Some(selected)).0;
        let text = |buffer: &Buffer| {
            (0..buffer.area.height)
                .map(|y| {
                    (0..buffer.area.width)
                        .map(|x| buffer[(x, y)].symbol())
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert!(text(&before).contains("fictional-pane-with-a-long-shared-prefix-20"));
        assert!(text(&before).contains("/work/example-kitchen-with-a-long-label"));
        assert!(!text(&before).contains("moved"));
        assert!(text(&after).contains("moved"));
        assert!(text(&after).contains(">"));
    }

    #[test]
    fn stats_table_preserves_truthful_modes_without_color() {
        let mut table = AgentTable::default();
        table.apply(fixture("snapshot-provenance.v1.json"));
        let mut terminal = Terminal::new(TestBackend::new(110, 24)).unwrap();
        terminal
            .draw(|frame| {
                draw_scoped(
                    frame,
                    &table,
                    None,
                    Utc::now(),
                    0,
                    Some("fictional-unknown"),
                    0,
                    &Scope::default(),
                )
            })
            .unwrap();
        let output = buffer_text(&terminal);
        assert!(output.contains("UNKNOWN / AT PREP"));
        assert!(output.contains("Unavailable"), "{output}");
        assert!(output.contains(">"));
        assert!(!terminal
            .backend()
            .buffer()
            .content
            .iter()
            .any(|cell| cell.modifier.contains(Modifier::REVERSED)));
    }
}
