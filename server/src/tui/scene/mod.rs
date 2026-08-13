pub mod layout;
pub mod particles;
pub mod sprites;

use chrono::{DateTime, Utc};
use ratatui::{
    layout::Rect,
    style::{Color, Style},
    text::Line,
    widgets::Paragraph,
    Frame,
};

use self::layout::{compute_layout, LayoutDecision, PixelRect};
use super::{
    canvas::{rgb_to_xterm256, ColorMode, PixelCanvas},
    state::AgentTable,
    theme, view,
};
use crate::protocol::{AgentRecord, AgentState};

fn mapped(color: Color, mode: ColorMode) -> Color {
    match (mode, color) {
        (ColorMode::Xterm256, Color::Rgb(red, green, blue)) => {
            Color::Indexed(rgb_to_xterm256(red, green, blue))
        }
        _ => color,
    }
}

fn pixel_color(key: u8, agent: &AgentRecord) -> Option<Color> {
    match key {
        b'C' => Some(theme::COAT),
        b'S' => Some(theme::SKIN),
        b'A' => Some(theme::accent(agent.accent_index)),
        b'F' => Some(theme::state_color(&AgentState::Working)),
        b'R' => Some(theme::state_color(&AgentState::Blocked)),
        b'G' => Some(theme::state_color(&AgentState::Done)),
        b'P' => Some(theme::CHALK),
        _ => None,
    }
}

fn border(canvas: &mut PixelCanvas, rect: PixelRect, color: Color) {
    canvas.fill_rect(rect.x.into(), rect.y.into(), rect.width.into(), 1, color);
    canvas.fill_rect(
        rect.x.into(),
        i32::from(rect.bottom().saturating_sub(1)),
        rect.width.into(),
        1,
        color,
    );
    canvas.fill_rect(rect.x.into(), rect.y.into(), 1, rect.height.into(), color);
    canvas.fill_rect(
        i32::from(rect.right().saturating_sub(1)),
        rect.y.into(),
        1,
        rect.height.into(),
        color,
    );
}

fn draw_agent(
    canvas: &mut PixelCanvas,
    station: PixelRect,
    agent: &AgentRecord,
    index: usize,
    tick: u64,
) {
    let state_color = theme::state_color(&agent.state);
    border(
        canvas,
        station,
        if agent.state == AgentState::Blocked {
            state_color
        } else {
            theme::STEEL_DARK
        },
    );
    let sprite = sprites::cook_sprite(&agent.state, tick + index as u64);
    let sprite_x = i32::from(station.x + station.width.saturating_sub(sprite.width() as u16) / 2);
    let sprite_y = i32::from(station.y + 1);
    for (y, row) in sprite.rows.iter().enumerate() {
        for (x, key) in row.bytes().enumerate() {
            if let Some(color) = pixel_color(key, agent) {
                canvas.put(sprite_x + x as i32, sprite_y + y as i32, color);
            }
        }
    }
    canvas.fill_rect(
        i32::from(station.right().saturating_sub(4)),
        i32::from(station.y + 1),
        3,
        2,
        theme::accent(agent.accent_index),
    );
    if agent.state == AgentState::Working {
        for particle in
            particles::steam_at_tick(tick, index, sprite_x as i16 + 3, sprite_y as i16 - 1)
        {
            if particle.active {
                canvas.put(
                    i32::from(particle.x),
                    i32::from(particle.y),
                    theme::STEAM[usize::from(particle.shade)],
                );
            }
        }
    }
}

fn overlay(
    frame: &mut Frame<'_>,
    area: Rect,
    x: u16,
    y: u16,
    width: u16,
    text: String,
    color: Color,
    mode: ColorMode,
) {
    if y >= area.height || x >= area.width {
        return;
    }
    let line = Line::from(text);
    let text_width = u16::try_from(line.width()).unwrap_or(u16::MAX);
    frame.render_widget(
        Paragraph::new(line).style(Style::default().fg(mapped(color, mode))),
        Rect::new(
            area.x + x,
            area.y + y,
            width.min(text_width).min(area.width - x),
            1,
        ),
    );
}

fn blocked_elapsed(agent: &AgentRecord, now: DateTime<Utc>) -> String {
    let elapsed = DateTime::parse_from_rfc3339(&agent.state_entered_at)
        .ok()
        .map(|entered| {
            now.signed_duration_since(entered.with_timezone(&Utc))
                .num_seconds()
                .max(0)
        })
        .unwrap_or(0);
    format!("{:02}:{:02}", elapsed / 60, elapsed % 60)
}

fn wrap_words(text: &str, width: usize) -> Vec<String> {
    let mut lines = vec![String::new()];
    for word in text.split_whitespace() {
        let line = lines.last_mut().unwrap();
        if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > width {
            lines.push(word.into());
        } else {
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(word);
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
    color_mode: ColorMode,
    scene_supported: bool,
) {
    let area = frame.area();
    let LayoutDecision::Scene(layout) = compute_layout(
        area.width,
        area.height.saturating_mul(2),
        table.agents().count(),
    ) else {
        view::draw(frame, table, warning, now, tick);
        return;
    };
    if !scene_supported {
        view::draw(frame, table, warning, now, tick);
        return;
    }

    let mut canvas = PixelCanvas::new(
        area.width,
        area.height.saturating_mul(2),
        theme::WALL,
        color_mode,
    );
    canvas.fill_rect(
        0,
        0,
        area.width.into(),
        area.height.saturating_mul(2).into(),
        theme::WALL,
    );
    for y in (4..layout.pass.y).step_by(4) {
        canvas.fill_rect(0, y.into(), area.width.into(), 1, theme::TILE);
    }
    canvas.fill_rect(
        0,
        layout.pass.bottom().into(),
        area.width.into(),
        i32::from(layout.room.height - layout.pass.bottom()),
        theme::FLOOR,
    );
    for x in (0..area.width).step_by(8) {
        canvas.fill_rect(
            x.into(),
            layout.pass.bottom().into(),
            1,
            i32::from(layout.room.height - layout.pass.bottom()),
            theme::FLOOR_SEAM,
        );
    }
    canvas.fill_rect(
        layout.pass.x.into(),
        layout.pass.y.into(),
        layout.pass.width.into(),
        layout.pass.height.into(),
        theme::STEEL_DARK,
    );
    canvas.fill_rect(
        layout.pass.x.into(),
        layout.pass.y.into(),
        layout.pass.width.into(),
        2,
        theme::STEEL,
    );
    canvas.fill_rect(
        layout.board.x.into(),
        layout.board.y.into(),
        layout.board.width.into(),
        layout.board.height.into(),
        theme::CHALKBOARD,
    );
    border(&mut canvas, layout.board, theme::BRASS);

    let agents = table.agents().collect::<Vec<_>>();
    for (index, (station, agent)) in layout.stations.iter().copied().zip(&agents).enumerate() {
        draw_agent(&mut canvas, station, agent, index, tick);
    }
    if agents
        .iter()
        .any(|agent| agent.state == AgentState::Blocked)
    {
        border(
            &mut canvas,
            layout.room,
            theme::state_color(&AgentState::Blocked),
        );
    }
    frame.render_widget(&canvas, area);

    let (title, source) = view::status_lines(
        table.mode(),
        table.source_status(),
        table.source_diagnostic(),
        agents.len(),
    );
    overlay(
        frame,
        area,
        2,
        0,
        area.width.saturating_sub(4),
        title,
        theme::CHALK,
        color_mode,
    );
    let source_width = layout.board.x.saturating_sub(4).max(1);
    for (line, source_line) in wrap_words(&source, usize::from(source_width))
        .into_iter()
        .enumerate()
    {
        overlay(
            frame,
            area,
            2,
            1 + line as u16,
            source_width,
            source_line,
            theme::CHALK,
            color_mode,
        );
    }
    overlay(
        frame,
        area,
        layout.board.x + 1,
        layout.board.y / 2,
        layout.board.width.saturating_sub(2),
        "86 BOARD".into(),
        theme::CHALK,
        color_mode,
    );
    for (row, entry) in table.board().iter().rev().enumerate() {
        overlay(
            frame,
            area,
            layout.board.x + 1,
            layout.board.y / 2 + 1 + row as u16,
            layout.board.width.saturating_sub(2),
            format!("{} {}T", entry.name, entry.tickets),
            theme::CHALK,
            color_mode,
        );
    }
    overlay(
        frame,
        area,
        3,
        layout.pass.y / 2 + 1,
        layout.pass.width.saturating_sub(2),
        "PASS — ORDERS UP".into(),
        theme::CHALK,
        color_mode,
    );
    if let Some(agent) = agents
        .iter()
        .find(|agent| agent.state == AgentState::Blocked)
    {
        overlay(
            frame,
            area,
            3,
            layout.pass.y / 2 + 1,
            layout.pass.width.saturating_sub(2),
            format!(
                "!! BLOCKED {} {} !!",
                agent.name,
                blocked_elapsed(agent, now)
            ),
            theme::CHALK,
            color_mode,
        );
    }
    for (station, agent) in layout.stations.iter().copied().zip(agents) {
        let label = match agent.state {
            AgentState::Idle => format!("{} · PREP", agent.name),
            AgentState::Working => format!("{} · FIRE", agent.name),
            AgentState::Blocked => format!("!! BLOCKED {} !!", blocked_elapsed(agent, now)),
            AgentState::Done => format!("{} · PLATED ✓", agent.name),
            AgentState::Ended => unreachable!("ended agents are not in the active roster"),
        };
        overlay(
            frame,
            area,
            station.x + 1,
            station.bottom().saturating_sub(2) / 2,
            station.width.saturating_sub(2),
            label,
            theme::CHALK,
            color_mode,
        );
        overlay(
            frame,
            area,
            station.right().saturating_sub(4),
            station.y / 2,
            3,
            format!("{}T", agent.session.tickets),
            theme::INK,
            color_mode,
        );
    }
    let footer = warning.map_or_else(
        || format!("q / Esc quit · tick {tick}"),
        |warning| format!("{warning} · q / Esc quit · tick {tick}"),
    );
    overlay(
        frame,
        area,
        1,
        area.height.saturating_sub(1),
        area.width.saturating_sub(2),
        footer,
        theme::CHALK,
        color_mode,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        protocol::{
            AgentRecord, AgentState, AgentStateEvent, AppMode, DeltaOperation, SessionStats,
            SourceDiagnostic, SourceStatus,
        },
        tui::state::AgentTable,
    };
    use chrono::{TimeZone, Utc};
    use ratatui::{backend::TestBackend, buffer::Buffer, style::Color, Terminal};
    use std::time::{Duration, Instant};

    fn record(id: &str, state: AgentState) -> AgentRecord {
        AgentRecord {
            id: id.into(),
            name: format!("Cook {id}"),
            state,
            progress: Some(0.5),
            state_entered_at: "2026-08-13T12:00:00Z".into(),
            accent_index: 2,
            model: "gpt-5.6-sol".into(),
            workspace: "/work/customer-api".into(),
            session: SessionStats {
                runtime_ms: 61_000,
                tickets: 7,
            },
        }
    }

    fn upsert(table: &mut AgentTable, agent: AgentRecord) {
        table.apply(AgentStateEvent::Delta {
            version: 1,
            mode: AppMode::Live,
            operation: DeltaOperation::Upsert,
            agent: Some(agent),
            agent_id: None,
        });
    }

    fn live_table(agents: Vec<AgentRecord>) -> AgentTable {
        let mut table = AgentTable::default();
        table.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents,
        });
        table
    }

    fn render(
        table: &AgentTable,
        width: u16,
        height: u16,
        mode: ColorMode,
        tick: u64,
    ) -> Terminal<TestBackend> {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                draw(
                    frame,
                    table,
                    Some("bind warning"),
                    Utc.with_ymd_and_hms(2026, 8, 13, 12, 0, 0).unwrap(),
                    tick,
                    mode,
                    true,
                )
            })
            .unwrap();
        terminal
    }

    fn text(terminal: &Terminal<TestBackend>) -> String {
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect()
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
                let start = x;
                x += 1;
                while x < buffer.area.right() {
                    let next = buffer.cell((x, y)).unwrap();
                    if next.fg != cell.fg
                        || next.bg != cell.bg
                        || next.modifier != cell.modifier
                        || next.skip != cell.skip
                        || next.symbol() != cell.symbol()
                    {
                        break;
                    }
                    x += 1;
                }
                dump.push_str(&format!(
                    "CELL {y:02} {start:03}..{x:03} symbol={:?} fg={:?} bg={:?} mod={:?} skip={}\n",
                    cell.symbol(),
                    cell.fg,
                    cell.bg,
                    cell.modifier,
                    cell.skip
                ));
            }
        }
        dump
    }

    fn snapshot(
        mode: AppMode,
        status: SourceStatus,
        diagnostic: Option<SourceDiagnostic>,
        agents: Vec<AgentRecord>,
    ) -> AgentTable {
        let mut table = AgentTable::default();
        table.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode,
            source_status: status,
            source_diagnostic: diagnostic,
            agents,
        });
        table
    }

    fn golden_cases() -> Vec<(&'static str, AgentTable, u16, u16)> {
        let idle = snapshot(
            AppMode::Live,
            SourceStatus::Connected,
            None,
            vec![record("idle", AgentState::Idle)],
        );
        let working = snapshot(
            AppMode::Live,
            SourceStatus::Connected,
            None,
            vec![record("working", AgentState::Working)],
        );
        let blocked = snapshot(
            AppMode::Live,
            SourceStatus::Connected,
            None,
            vec![record("blocked", AgentState::Blocked)],
        );
        let done = snapshot(
            AppMode::Live,
            SourceStatus::Connected,
            None,
            vec![record("done", AgentState::Done)],
        );
        let mut ended = snapshot(
            AppMode::Live,
            SourceStatus::Connected,
            None,
            vec![record("ended", AgentState::Done)],
        );
        upsert(&mut ended, record("ended", AgentState::Ended));
        vec![
            ("idle", idle, 80, 24),
            ("working", working, 80, 24),
            ("blocked", blocked, 80, 24),
            ("done", done, 80, 24),
            ("ended", ended, 80, 24),
            ("demo", AgentTable::default(), 80, 24),
            ("waiting", live_table(vec![]), 80, 24),
            (
                "unsupported",
                snapshot(
                    AppMode::Demo,
                    SourceStatus::UnsupportedProtocol,
                    Some(SourceDiagnostic {
                        observed_protocol: 23,
                        supported_protocols: vec![17, 19],
                        next_action: "upgrade Herdr, then retry".into(),
                    }),
                    vec![],
                ),
                80,
                24,
            ),
            (
                "fallback",
                live_table(vec![record("small", AgentState::Idle)]),
                79,
                23,
            ),
        ]
    }

    fn render_dump(table: &AgentTable, width: u16, height: u16) -> String {
        let terminal = render(table, width, height, ColorMode::Truecolor, 9);
        buffer_dump(terminal.backend().buffer())
    }

    #[test]
    fn short_overlay_preserves_trailing_scene_pixels() {
        let mut terminal = Terminal::new(TestBackend::new(5, 1)).unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                let mut canvas = PixelCanvas::new(5, 2, theme::WALL, ColorMode::Truecolor);
                canvas.fill_rect(0, 0, 5, 2, theme::state_color(&AgentState::Blocked));
                frame.render_widget(&canvas, area);
                overlay(
                    frame,
                    area,
                    0,
                    0,
                    5,
                    "X".into(),
                    theme::CHALK,
                    ColorMode::Truecolor,
                );
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        assert_eq!(buffer.cell((0, 0)).unwrap().fg, theme::CHALK);
        for x in 1..5 {
            let cell = buffer.cell((x, 0)).unwrap();
            assert_eq!(cell.symbol(), "▀");
            assert_eq!(
                cell.fg,
                theme::state_color(&AgentState::Blocked),
                "overlay restyled trailing scene pixel at x={x}"
            );
        }
    }

    #[test]
    fn fixed_input_scene_goldens_are_stable_and_committed() {
        for (name, table, width, height) in golden_cases() {
            let actual = render_dump(&table, width, height);
            assert_eq!(
                actual,
                render_dump(&table, width, height),
                "{name} was nondeterministic"
            );
            let path = format!(
                "{}/tests/goldens/scene-{name}.txt",
                env!("CARGO_MANIFEST_DIR")
            );
            let expected = std::fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("missing golden {path}: {error}"));
            assert_eq!(actual, expected, "golden mismatch: {path}");
        }
    }

    #[test]
    fn identical_event_sequence_produces_identical_buffers_for_one_hundred_ticks() {
        fn replay() -> Vec<Buffer> {
            let mut table = live_table(vec![
                record("a", AgentState::Idle),
                record("b", AgentState::Working),
            ]);
            let mut frames = Vec::new();
            for tick in 0..100 {
                match tick {
                    25 => upsert(&mut table, record("a", AgentState::Working)),
                    50 => upsert(&mut table, record("b", AgentState::Blocked)),
                    75 => upsert(&mut table, record("a", AgentState::Done)),
                    _ => {}
                }
                frames.push(
                    render(&table, 80, 24, ColorMode::Truecolor, tick)
                        .backend()
                        .buffer()
                        .clone(),
                );
            }
            frames
        }
        assert_eq!(replay(), replay());
    }

    #[test]
    fn resize_scene_to_fallback_and_back_has_no_stale_cells() {
        let table = live_table(vec![
            record("a", AgentState::Working),
            record("b", AgentState::Blocked),
        ]);
        let backend = TestBackend::new(120, 40);
        let mut reused = Terminal::new(backend).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 12, 0, 0).unwrap();
        reused
            .draw(|frame| {
                draw(
                    frame,
                    &table,
                    Some("bind warning"),
                    now,
                    1,
                    ColorMode::Truecolor,
                    true,
                )
            })
            .unwrap();
        reused.backend_mut().resize(79, 23);
        reused.autoresize().unwrap();
        reused
            .draw(|frame| {
                draw(
                    frame,
                    &table,
                    Some("bind warning"),
                    now,
                    2,
                    ColorMode::Truecolor,
                    true,
                )
            })
            .unwrap();
        assert_eq!(
            reused.backend().buffer(),
            render(&table, 79, 23, ColorMode::Truecolor, 2)
                .backend()
                .buffer()
        );
        reused.backend_mut().resize(80, 24);
        reused.autoresize().unwrap();
        reused
            .draw(|frame| {
                draw(
                    frame,
                    &table,
                    Some("bind warning"),
                    now,
                    3,
                    ColorMode::Truecolor,
                    true,
                )
            })
            .unwrap();
        assert_eq!(
            reused.backend().buffer(),
            render(&table, 80, 24, ColorMode::Truecolor, 3)
                .backend()
                .buffer()
        );
    }

    #[test]
    fn twenty_agent_frame_budget_reports_median_and_p95_under_five_ms() {
        let agents = (0..20)
            .map(|index| {
                record(
                    &index.to_string(),
                    match index % 4 {
                        0 => AgentState::Idle,
                        1 => AgentState::Working,
                        2 => AgentState::Blocked,
                        _ => AgentState::Done,
                    },
                )
            })
            .collect();
        let table = live_table(agents);
        for tick in 0..20 {
            let _ = render(&table, 110, 24, ColorMode::Truecolor, tick);
        }
        let mut samples = Vec::with_capacity(200);
        for tick in 0..200 {
            let started = Instant::now();
            let _ = render(&table, 110, 24, ColorMode::Truecolor, tick);
            samples.push(started.elapsed());
        }
        samples.sort_unstable();
        let median = samples[samples.len() / 2];
        let p95 = samples[samples.len() * 95 / 100];
        eprintln!("20-agent scene median={median:?} p95={p95:?}");
        assert!(
            median < Duration::from_millis(5),
            "median {median:?}, p95 {p95:?}"
        );
    }

    #[test]
    fn blocked_escalation_is_visible_on_first_render_after_delta_without_color() {
        let mut table = live_table(vec![record("a", AgentState::Working)]);
        upsert(&mut table, record("a", AgentState::Blocked));
        let output = text(&render(&table, 80, 24, ColorMode::Xterm256, 0));
        assert!(output.contains("!! BLOCKED 00:00 !!"));
    }

    #[test]
    fn scene_shell_is_truthful_and_small_or_degraded_term_uses_table() {
        let table = live_table(vec![]);
        let scene = text(&render(&table, 80, 24, ColorMode::Truecolor, 0));
        assert!(scene.contains("MISE — LIVE"));
        assert!(scene.contains("Waiting for agents"));
        assert!(!scene.contains("Kitchen status"));

        let small = text(&render(&table, 79, 24, ColorMode::Truecolor, 0));
        assert!(small.contains("Kitchen status"));

        let mut degraded = Terminal::new(TestBackend::new(80, 24)).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 12, 0, 0).unwrap();
        degraded
            .draw(|frame| draw(frame, &table, None, now, 0, ColorMode::Xterm256, false))
            .unwrap();
        assert!(text(&degraded).contains("Kitchen status"));

        let unsupported = snapshot(
            AppMode::Demo,
            SourceStatus::UnsupportedProtocol,
            Some(SourceDiagnostic {
                observed_protocol: 23,
                supported_protocols: vec![17, 19],
                next_action: "upgrade Herdr, then retry".into(),
            }),
            vec![],
        );
        let unsupported = text(&render(&unsupported, 80, 24, ColorMode::Truecolor, 0));
        assert!(unsupported.contains("observed"));
        assert!(unsupported.contains("23; supported: 17, 19"));
        assert!(unsupported.contains("upgrade Herdr, then retry"));
    }

    #[test]
    fn truecolor_and_xterm256_render_same_scene_with_different_color_types() {
        let table = live_table(vec![record("a", AgentState::Working)]);
        let truecolor = render(&table, 80, 24, ColorMode::Truecolor, 2);
        let xterm = render(&table, 80, 24, ColorMode::Xterm256, 2);
        assert_eq!(text(&truecolor), text(&xterm));
        assert!(truecolor
            .backend()
            .buffer()
            .content
            .iter()
            .any(|cell| matches!(cell.fg, Color::Rgb(..))));
        assert!(xterm
            .backend()
            .buffer()
            .content
            .iter()
            .any(|cell| matches!(cell.fg, Color::Indexed(_))));
    }

    #[test]
    fn ended_agent_clears_station_and_is_written_to_86_board() {
        let mut table = live_table(vec![record("a", AgentState::Done)]);
        upsert(&mut table, record("a", AgentState::Ended));
        let output = text(&render(&table, 80, 24, ColorMode::Truecolor, 4));
        assert!(output.contains("86 BOARD"));
        assert!(output.contains("Cook a"));
        assert!(output.contains("Waiting for agents"));
    }
}
