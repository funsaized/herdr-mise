use chrono::{DateTime, Utc};
use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table, Wrap},
    Frame,
};

use super::{state::AgentTable, theme};
use crate::protocol::{AgentState, AppMode, SourceDiagnostic, SourceStatus};

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
        .filter(|part| !part.is_empty())
        .next_back()
        .unwrap_or("Unavailable")
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

fn status_lines(
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

pub fn draw(
    frame: &mut Frame<'_>,
    table: &AgentTable,
    warning: Option<&str>,
    now: DateTime<Utc>,
    tick: u64,
) {
    let compact = frame.area().height < 20;
    let constraints = if compact {
        [
            Constraint::Length(2),
            Constraint::Min(3),
            Constraint::Length(3),
            Constraint::Length(2),
        ]
    } else {
        [
            Constraint::Length(4),
            Constraint::Min(8),
            Constraint::Length(6),
            Constraint::Length(2),
        ]
    };
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(frame.area());
    let agent_count = table.agents().count();
    let (title, source_copy) = status_lines(
        table.mode(),
        table.source_status(),
        table.source_diagnostic(),
        agent_count,
    );
    let mut header = Paragraph::new(vec![
        Line::from(Span::styled(
            title,
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(source_copy),
    ])
    .wrap(Wrap { trim: true });
    if !compact {
        header = header.block(Block::default().borders(Borders::BOTTOM));
    }
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
        } else {
            Style::default()
        };
        Row::new(vec![
            Cell::from(agent.name.clone())
                .style(Style::default().fg(theme::accent(agent.accent_index))),
            Cell::from(state_label(&agent.state))
                .style(Style::default().fg(theme::state_color(&agent.state))),
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
                    .fg(Color::Rgb(0xe9, 0xe4, 0xd0))
                    .bg(Color::Rgb(0x24, 0x35, 0x29)),
            )
            .block(Block::default().borders(Borders::ALL).title("86 BOARD")),
        areas[2],
    );
    let status = warning.map_or_else(
        || format!("q / Esc quit · tick {tick}"),
        |warning| format!("{warning} · q / Esc quit · tick {tick}"),
    );
    frame.render_widget(Paragraph::new(Line::from(status)), areas[3]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        AgentRecord, AgentStateEvent, DeltaOperation, SessionStats, SourceDiagnostic, SourceStatus,
    };
    use ratatui::{backend::TestBackend, buffer::Buffer, Terminal};

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
                    || cell.skip;
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
                        || next.skip != cell.skip
                    {
                        break;
                    }
                    x += 1;
                }
                dump.push_str(&format!(
                    "STYLE {y:02} {start:03}..{x:03} fg={:?} bg={:?} mod={:?} skip={}\n",
                    cell.fg, cell.bg, cell.modifier, cell.skip
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
            .draw(|frame| draw(frame, table, warning, now, 9))
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
            supported_protocols: vec![17, 19],
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
                "Mock feed — Herdr protocol is unsupported — observed 23; supported: 17, 19; upgrade Herdr, then retry. Nothing here is real.".into()
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
            .draw(|frame| draw(frame, &table, None, now, 9))
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
            .draw(|frame| draw(frame, &AgentTable::default(), Some("bind warning"), now, 7))
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
}
