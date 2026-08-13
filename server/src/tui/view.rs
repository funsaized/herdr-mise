use chrono::{DateTime, Utc};
use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Color, Style},
    text::Line,
    widgets::{Block, Borders, Paragraph, Row, Table},
    Frame,
};

use super::state::AgentTable;
use crate::protocol::{AgentState, AppMode};

pub fn draw(
    frame: &mut Frame<'_>,
    table: &AgentTable,
    warning: Option<&str>,
    now: DateTime<Utc>,
    tick: u64,
) {
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(3),
            Constraint::Length(2),
        ])
        .split(frame.area());
    let mode = if table.mode() == AppMode::Live {
        "LIVE"
    } else {
        "DEMO SERVICE"
    };
    frame.render_widget(
        Paragraph::new(format!("MISE — {mode}\n{:?}", table.source_status())),
        areas[0],
    );
    let rows = table.agents().map(|agent| {
        let entered = DateTime::parse_from_rfc3339(&agent.state_entered_at)
            .ok()
            .map(|d| d.with_timezone(&Utc));
        let elapsed = entered
            .map(|d| now.signed_duration_since(d).num_seconds().max(0))
            .unwrap_or(0);
        let style = if agent.state == AgentState::Blocked {
            Style::default().fg(Color::Red)
        } else {
            Style::default()
        };
        Row::new([
            agent.name.clone(),
            format!("{:?}", agent.state),
            format!("{elapsed}s"),
            agent.model.clone(),
        ])
        .style(style)
    });
    frame.render_widget(
        Table::new(
            rows,
            [
                Constraint::Percentage(30),
                Constraint::Length(10),
                Constraint::Length(10),
                Constraint::Percentage(40),
            ],
        )
        .header(Row::new(["AGENT", "STATE", "TIME", "MODEL"]))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("Kitchen status"),
        ),
        areas[1],
    );
    let status = warning.map_or_else(
        || format!("q / Esc quit · tick {tick}"),
        |warning| format!("{warning} · q / Esc quit · tick {tick}"),
    );
    frame.render_widget(Paragraph::new(Line::from(status)), areas[2]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};

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
