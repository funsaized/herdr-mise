use chrono::{DateTime, Utc};
use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table, Wrap},
    Frame,
};

use super::{state::AgentTable, theme};
use crate::protocol::{AgentRecord, AgentState, AppMode, SourceDiagnostic, SourceStatus};

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

pub(super) fn inspect_facts(agent: &AgentRecord) -> [String; 2] {
    let model = if agent.model.trim().is_empty() {
        "Unavailable"
    } else {
        agent.model.trim()
    };
    let tickets = if agent.session.tickets == 0 {
        "Unavailable".into()
    } else {
        agent.session.tickets.to_string()
    };
    [
        format!("{} · {}", agent.name, state_label(&agent.state)),
        format!(
            "Workspace: {} · Model: {model} · Tickets: {tickets}",
            workspace_display_name(&agent.workspace),
        ),
    ]
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

fn state_label(state: &AgentState) -> &'static str {
    match state {
        AgentState::Idle => "IDLE / PREPPING",
        AgentState::Working => "WORKING / ON THE FIRE",
        AgentState::Blocked => "BLOCKED / AT THE PASS",
        AgentState::Done => "DONE / PLATED",
        AgentState::Ended => "86'D / SESSION ENDED",
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
    let detail = if source_status == &SourceStatus::UnsupportedProtocol {
        diagnostic.map_or_else(String::new, |diagnostic| {
            format!(
                " — observed {}; supported: {}; {}",
                diagnostic.observed_protocol,
                diagnostic
                    .supported_protocols
                    .iter()
                    .map(u64::to_string)
                    .collect::<Vec<_>>()
                    .join(", "),
                diagnostic.next_action
            )
        })
    } else {
        String::new()
    };
    let condition = format!("{}{}", source_status_text(source_status), detail);
    let status = if mode == AppMode::Demo {
        format!("Mock feed — {condition}. Nothing here is real.")
    } else {
        condition
    };
    (title.into(), status)
}

fn wrapped_line_count(text: &str, width: u16) -> u16 {
    let width = usize::from(width.max(1));
    let mut lines = 1_u16;
    let mut used = 0_usize;
    for word in text.split_whitespace() {
        let word_width = word.chars().count();
        let needed = word_width + usize::from(used > 0);
        if used > 0 && used + needed > width {
            lines += 1;
            used = word_width;
        } else {
            used += needed;
        }
    }
    lines
}

pub fn draw(
    frame: &mut Frame<'_>,
    table: &AgentTable,
    warning: Option<&str>,
    now: DateTime<Utc>,
    tick: u64,
    selected_id: Option<&str>,
) {
    let compact = frame.area().height < 20;
    let agent_count = table.agents().count();
    let (title, source_copy) = status_lines(
        table.mode(),
        table.source_status(),
        table.source_diagnostic(),
        agent_count,
    );
    let content_height = 1 + wrapped_line_count(&source_copy, frame.area().width);
    let mut header = Paragraph::new(vec![
        Line::from(Span::styled(
            title,
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(source_copy),
    ])
    .wrap(Wrap { trim: true });
    let baseline_height = if compact { 2 } else { 4 };
    let header_height = baseline_height.max(content_height + u16::from(!compact));
    if !compact {
        header = header.block(Block::default().borders(Borders::BOTTOM));
    }
    let mut constraints = if compact {
        vec![
            Constraint::Length(header_height),
            Constraint::Min(3),
            Constraint::Length(3),
            Constraint::Length(2),
        ]
    } else {
        vec![
            Constraint::Length(header_height),
            Constraint::Min(8),
            Constraint::Length(6),
            Constraint::Length(2),
        ]
    };
    let selected = selected_id.and_then(|id| table.agents().find(|agent| agent.id == id));
    if selected.is_some() {
        constraints.insert(3, Constraint::Length(2));
    }
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(frame.area());
    frame.render_widget(header, areas[0]);
    let rows = table.agents().map(|agent| {
        let entered = DateTime::parse_from_rfc3339(&agent.state_entered_at)
            .ok()
            .map(|d| d.with_timezone(&Utc));
        let elapsed = entered
            .map(|d| now.signed_duration_since(d).num_milliseconds().max(0) as u64)
            .unwrap_or(0);
        let style = if agent.state == AgentState::Blocked {
            Style::default().add_modifier(Modifier::BOLD | Modifier::REVERSED)
        } else if selected_id == Some(agent.id.as_str()) {
            Style::default().add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        Row::new(vec![
            Cell::from(agent.name.clone())
                .style(Style::default().fg(theme::compact_accent(agent.accent_index))),
            Cell::from(state_label(&agent.state))
                .style(Style::default().fg(theme::compact_state_color(&agent.state))),
            Cell::from(format_duration(elapsed)),
            Cell::from(agent.model.clone()),
            Cell::from(workspace_display_name(&agent.workspace)),
            Cell::from(agent.session.tickets.to_string()),
            Cell::from(format_duration(agent.session.runtime_ms)),
        ])
        .style(style)
    });
    frame.render_widget(
        Table::new(
            rows,
            [
                Constraint::Length(16),
                Constraint::Length(22),
                Constraint::Length(9),
                Constraint::Length(14),
                Constraint::Length(16),
                Constraint::Length(7),
                Constraint::Min(9),
            ],
        )
        .header(
            Row::new([
                "AGENT",
                "STATE",
                "ELAPSED",
                "MODEL",
                "WORKSPACE",
                "TICKETS",
                "RUNTIME",
            ])
            .style(Style::default().add_modifier(Modifier::BOLD)),
        )
        .column_spacing(1)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("Kitchen status"),
        ),
        areas[1],
    );
    let board_rows = table.board().iter().map(|entry| {
        Row::new([format!(
            "{} · {} · {} TICKETS · FINAL {}",
            entry.name,
            format_duration(entry.runtime_ms),
            entry.tickets,
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
        frame.render_widget(
            Paragraph::new(inspect_facts(agent).map(Line::from).to_vec()),
            areas[3],
        );
        areas[4]
    } else {
        areas[3]
    };
    let keys = if selected.is_some() {
        "Tab / Shift+Tab inspect · Esc close · q quit"
    } else {
        "q / Esc quit"
    };
    let status = warning.map_or_else(
        || format!("{keys} · tick {tick}"),
        |warning| format!("{warning} · {keys} · tick {tick}"),
    );
    frame.render_widget(Paragraph::new(Line::from(status)), status_area);
}

#[cfg(test)]
mod tests {
    use super::super::{handle_key, retain_selection, scene};
    use super::*;
    use crate::adapter::Normalizer;
    use crate::protocol::{
        AgentRecord, AgentStateEvent, DeltaOperation, SessionStats, SourceDiagnostic, SourceStatus,
    };
    use crossterm::event::KeyCode;
    use ratatui::{backend::TestBackend, buffer::Buffer, style::Color, Terminal};
    use tokio_util::sync::CancellationToken;

    fn record(id: &str, state: AgentState) -> AgentRecord {
        AgentRecord {
            id: id.into(),
            name: format!("Cook {id}"),
            state,
            progress: None,
            state_entered_at: "2026-08-13T12:00:00Z".into(),
            accent_index: 2,
            model: "gpt-5.6-sol".into(),
            workspace: "/work/customer-api".into(),
            session: SessionStats {
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
            .draw(|frame| draw(frame, table, warning, now, 9, None))
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
        });
        let shutdown = CancellationToken::new();
        let mut selected = None;
        assert!(!handle_key(KeyCode::Tab, &table, &mut selected, &shutdown));
        assert_eq!(selected.as_deref(), Some("fictional-session-20"));

        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-13T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        terminal
            .draw(|frame| {
                scene::draw(
                    frame,
                    &table,
                    None,
                    now,
                    0,
                    super::super::canvas::ColorMode::Xterm256,
                    true,
                    selected.as_deref(),
                )
            })
            .unwrap();
        let strip = terminal
            .backend()
            .buffer()
            .content
            .chunks(80)
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .filter(|row| row.contains("example-cook") || row.contains("Workspace:"))
            .collect::<Vec<_>>()
            .join(" ");

        for expected in ["example-cook", "WORKING / ON THE FIRE", "Example Kitchen"] {
            assert!(
                strip.contains(expected),
                "missing {expected:?} in {strip:?}"
            );
        }
        assert_eq!(strip.matches("Unavailable").count(), 2);
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

        assert!(!handle_key(KeyCode::Esc, &table, &mut selected, &shutdown));
        assert_eq!(selected, None);
        assert!(!shutdown.is_cancelled());
        assert!(!handle_key(KeyCode::Tab, &table, &mut selected, &shutdown));
        table.apply(AgentStateEvent::Delta {
            version: 1,
            mode: AppMode::Live,
            operation: DeltaOperation::Remove,
            agent: None,
            agent_id: Some("fictional-session-20".into()),
        });
        retain_selection(&mut selected, &table);
        assert_eq!(selected, None);
        assert!(handle_key(KeyCode::Esc, &table, &mut selected, &shutdown));
        assert!(shutdown.is_cancelled());
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
    fn status_copy_is_truthful_for_live_demo_waiting_and_unsupported() {
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
        });
        apply_upsert(&mut table, record("ended", AgentState::Ended));
        let backend = TestBackend::new(110, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-13T12:02:05Z")
            .unwrap()
            .with_timezone(&Utc);
        terminal
            .draw(|frame| draw(frame, &table, None, now, 9, None))
            .unwrap();
        let text = buffer_text(&terminal);
        for expected in [
            "MISE — LIVE",
            "Connected to Herdr",
            "AGENT",
            "STATE",
            "ELAPSED",
            "MODEL",
            "WORKSPACE",
            "TICKETS",
            "RUNTIME",
            "Cook blocked",
            "BLOCKED / AT THE PASS",
            "2m 5s",
            "gpt-5.6-sol",
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
    fn deterministic_complete_buffer_goldens() {
        let mut demo = AgentTable::default();
        demo.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Demo,
            source_status: SourceStatus::UnavailableSocket,
            source_diagnostic: None,
            agents: vec![record("demo", AgentState::Working)],
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
                draw(
                    frame,
                    &AgentTable::default(),
                    Some("bind warning"),
                    now,
                    7,
                    None,
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
        assert!(rendered.contains("tick 7"));
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
                .draw(|frame| draw(frame, &table, None, now, 7, None))
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
}
