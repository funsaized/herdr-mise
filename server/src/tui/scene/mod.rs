pub mod layout;
pub mod particles;
pub mod sprites;

use chrono::{DateTime, Utc};
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph},
    Frame,
};

use self::layout::{compute_layout, LayoutDecision, PixelRect};
use super::{
    canvas::{rgb_to_xterm256, ColorMode, PixelCanvas},
    state::{AgentTable, BoardEntry},
    theme, view,
};
use crate::protocol::{AgentRecord, AgentState, SourceStatus};

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
        b'H' | b'C' => Some(theme::COAT),
        b'h' | b'c' => Some(theme::COAT_LO),
        b'S' | b'K' => Some(theme::SKIN),
        b'e' => Some(theme::EYE),
        b'a' => Some(theme::accent(agent.accent_index)),
        b'A' => Some(theme::accent_dim(agent.accent_index)),
        b'D' => Some(theme::PANTS),
        b'B' => Some(theme::BOOT),
        b'k' => Some(theme::STEEL),
        b'W' => Some(theme::PLATE),
        b'G' => Some(theme::GREEN),
        b'R' => Some(theme::SKIN_MAD),
        b'b' => Some(theme::BROW_MAD),
        b'o' => Some(theme::BAND),
        _ => None,
    }
}

fn cell_rect(rect: PixelRect) -> Rect {
    Rect::new(rect.x, rect.y / 2, rect.width, rect.height.div_ceil(2))
}

fn put_inside(canvas: &mut PixelCanvas, station: PixelRect, x: i32, y: i32, color: Color) {
    if x > i32::from(station.x)
        && x < i32::from(station.right().saturating_sub(1))
        && y > i32::from(station.y)
        && y < i32::from(station.bottom().saturating_sub(1))
    {
        canvas.put(x, y, color);
    }
}

fn draw_sprite(canvas: &mut PixelCanvas, station: PixelRect, agent: &AgentRecord, tick: u64) {
    let sprite = sprites::cook_sprite(&agent.state, tick);
    if sprite.rows.is_empty()
        || station.width < sprites::SPRITE_WIDTH as u16 + 2
        || station.height < sprites::SPRITE_HALF_ROWS as u16 + 6
    {
        return;
    }
    let working = agent.state == AgentState::Working;
    let centered = station.x + station.width.saturating_sub(sprite.width() as u16) / 2;
    let sprite_x = i32::from(centered.saturating_sub(u16::from(working) * 3));
    let sprite_y = i32::from(station.y + 4);
    if working && station.width >= 24 {
        // Pinned paper ticket, matching the handoff's 4x6 half-pixel card.
        let ticket_x = i32::from(station.x + 2);
        let ticket_y = i32::from(station.y + 3);
        for row in 0..6 {
            for column in 0..4 {
                put_inside(
                    canvas,
                    station,
                    ticket_x + column,
                    ticket_y + row,
                    theme::PLATE,
                );
            }
        }
        for column in 1..=2 {
            put_inside(
                canvas,
                station,
                ticket_x + column,
                ticket_y - 1,
                theme::STEEL_LO,
            );
        }
        for column in 0..3 {
            put_inside(
                canvas,
                station,
                ticket_x + column,
                ticket_y + 1,
                theme::STEAM,
            );
            put_inside(
                canvas,
                station,
                ticket_x + column,
                ticket_y + 3,
                theme::STEAM,
            );
        }
        for column in 0..2 {
            put_inside(
                canvas,
                station,
                ticket_x + column,
                ticket_y + 5,
                theme::STEAM,
            );
        }
    }

    // Match the mock's z-order: the cook wins any overlap with the ticket.
    for (row_index, row) in sprite.rows.iter().enumerate() {
        for (column, key) in row.bytes().enumerate() {
            if let Some(color) = pixel_color(key, agent) {
                put_inside(
                    canvas,
                    station,
                    sprite_x + column as i32,
                    sprite_y + row_index as i32,
                    color,
                );
            }
        }
    }

    if !working || station.width < 24 {
        return;
    }

    // Pot and alternating flames sit to the right of the static working pose.
    let pot_x = sprite_x + 13;
    let pot_y = sprite_y + 9;
    for column in 0..5 {
        put_inside(canvas, station, pot_x + column, pot_y, theme::POT_HI);
        put_inside(canvas, station, pot_x + column, pot_y + 1, theme::POT);
        put_inside(canvas, station, pot_x + column, pot_y + 2, theme::POT);
    }
    put_inside(canvas, station, pot_x + 5, pot_y + 1, theme::POT_HI);
    let (left_fire, right_fire) = if tick.is_multiple_of(2) {
        (theme::FIRE_HI, theme::FIRE)
    } else {
        (theme::FIRE, theme::FIRE_HI)
    };
    put_inside(canvas, station, pot_x + 1, pot_y + 3, left_fire);
    put_inside(canvas, station, pot_x + 3, pot_y + 3, right_fire);

    for particle in particles::steam_at_tick(tick, (pot_x + 1) as i16, (pot_y - 1) as i16) {
        put_inside(
            canvas,
            station,
            i32::from(particle.x),
            i32::from(particle.y),
            if particle.shade == 0 {
                theme::STEAM_HI
            } else {
                theme::STEAM
            },
        );
    }
}

fn render_line(frame: &mut Frame<'_>, area: Rect, x: u16, y: u16, width: u16, line: Line<'static>) {
    if x >= area.width || y >= area.height || width == 0 {
        return;
    }
    frame.render_widget(
        Paragraph::new(line),
        Rect::new(area.x + x, area.y + y, width.min(area.width - x), 1),
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

fn format_runtime(milliseconds: u64) -> String {
    let seconds = milliseconds / 1_000;
    let minutes = seconds / 60;
    if minutes >= 60 {
        format!("{}:{:02}", minutes / 60, minutes % 60)
    } else {
        format!("{:02}:{:02}", minutes, seconds % 60)
    }
}

fn split_line(text: &str, width: usize) -> (String, String) {
    if text.chars().count() <= width {
        return (text.into(), String::new());
    }
    let prefix = text.chars().take(width).collect::<String>();
    let split = prefix.rfind(char::is_whitespace).unwrap_or(prefix.len());
    let first = prefix[..split].to_owned();
    let consumed_chars = first.chars().count();
    let rest = text
        .chars()
        .skip(consumed_chars)
        .collect::<String>()
        .trim_start()
        .to_owned();
    (first, rest)
}

fn board_line(entry: &BoardEntry, width: usize) -> String {
    if width < 12 {
        return entry.name.chars().take(width).collect();
    }
    let name_width = width.saturating_sub(12).max(4);
    format!(
        "{:<name_width$} {:>5} {:>3}T",
        entry
            .name
            .to_uppercase()
            .chars()
            .take(name_width)
            .collect::<String>(),
        format_runtime(entry.runtime_ms),
        entry.tickets,
    )
}

fn connection_text(table: &AgentTable, warning: Option<&str>) -> String {
    let connection = match table.source_status() {
        SourceStatus::Connected => "connected",
        SourceStatus::UnavailableSocket => "Herdr socket unavailable",
        SourceStatus::Timeout => "Herdr timeout",
        SourceStatus::UnsupportedProtocol => "unsupported Herdr protocol",
        SourceStatus::IncompatibleResponse => "incompatible Herdr response",
    };
    warning.map_or_else(
        || connection.into(),
        |warning| format!("{connection} · {warning}"),
    )
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
    let agents = table.agents().collect::<Vec<_>>();
    let LayoutDecision::Scene(layout) =
        compute_layout(area.width, area.height.saturating_mul(2), agents.len())
    else {
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
        theme::BG,
        color_mode,
    );
    canvas.clear(theme::BG);
    canvas.fill_rect(
        layout.board.x.into(),
        layout.board.y.into(),
        layout.board.width.into(),
        layout.board.height.into(),
        theme::BOARD,
    );
    if agents
        .iter()
        .any(|agent| agent.state == AgentState::Blocked)
    {
        canvas.fill_rect(
            layout.pass.x.into(),
            layout.pass.y.into(),
            layout.pass.width.into(),
            layout.pass.height.into(),
            theme::PANEL2,
        );
    }
    for (station, agent) in layout.stations.iter().copied().zip(&agents) {
        canvas.fill_rect(
            i32::from(station.x + 1),
            i32::from(station.y + 2),
            i32::from(station.width.saturating_sub(2)),
            i32::from(station.height.saturating_sub(4)),
            theme::PANEL,
        );
        if agent.state == AgentState::Done && station.height >= 6 {
            canvas.fill_rect(
                i32::from(station.x + 1),
                i32::from(station.bottom().saturating_sub(6)),
                i32::from(station.width.saturating_sub(2)),
                2,
                theme::GREEN,
            );
        }
        draw_sprite(&mut canvas, station, agent, tick);
    }
    frame.render_widget(&canvas, area);

    // Always-neutral room frame; escalation stays local to blocked stations.
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(mapped(theme::FRAME, color_mode))),
        area,
    );

    let (title, source) = view::status_lines(
        table.mode(),
        table.source_status(),
        table.source_diagnostic(),
        agents.len(),
    );
    render_line(
        frame,
        area,
        2,
        1,
        area.width.saturating_sub(4),
        Line::from(vec![Span::styled(
            title,
            Style::default()
                .fg(mapped(theme::TEXT, color_mode))
                .add_modifier(Modifier::BOLD),
        )]),
    );
    let tick_text = format!("10Hz · tick {tick}");
    render_line(
        frame,
        area,
        area.width
            .saturating_sub(tick_text.chars().count() as u16 + 2),
        1,
        tick_text.chars().count() as u16,
        Line::styled(
            tick_text,
            Style::default().fg(mapped(theme::DIM, color_mode)),
        ),
    );
    let source_width = area.width.saturating_sub(4);
    let (source_first, source_overflow) = split_line(&source, usize::from(source_width));
    render_line(
        frame,
        area,
        2,
        2,
        source_width,
        Line::styled(
            source_first,
            Style::default().fg(mapped(theme::DIM, color_mode)),
        ),
    );
    if !source_overflow.is_empty() {
        render_line(
            frame,
            area,
            2,
            3,
            layout.board.x.saturating_sub(4),
            Line::styled(
                source_overflow,
                Style::default().fg(mapped(theme::DIM, color_mode)),
            ),
        );
    }

    let board_area = cell_rect(layout.board);
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .title(Span::styled(
                " 86 BOARD ",
                Style::default()
                    .fg(mapped(theme::BRASS, color_mode))
                    .add_modifier(Modifier::BOLD),
            ))
            .border_style(Style::default().fg(mapped(theme::BRASS, color_mode))),
        board_area,
    );
    for (row, entry) in table.board().iter().rev().take(4).enumerate() {
        render_line(
            frame,
            area,
            board_area.x + 2,
            board_area.y + 1 + row as u16,
            board_area.width.saturating_sub(4),
            Line::styled(
                board_line(entry, usize::from(board_area.width.saturating_sub(4))),
                Style::default()
                    .fg(mapped(theme::CHALK, color_mode))
                    .bg(mapped(theme::BOARD, color_mode)),
            ),
        );
    }

    let blocked = agents
        .iter()
        .filter(|agent| agent.state == AgentState::Blocked)
        .copied()
        .collect::<Vec<_>>();
    if blocked.is_empty() {
        render_line(
            frame,
            area,
            4,
            layout.pass.y / 2,
            layout.pass.width.saturating_sub(2),
            Line::styled(
                "— all stations clear —",
                Style::default().fg(mapped(theme::DIM, color_mode)),
            ),
        );
    } else {
        let names = blocked
            .iter()
            .map(|agent| agent.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let elapsed = blocked_elapsed(blocked[0], now);
        render_line(
            frame,
            area,
            4,
            layout.pass.y / 2,
            layout.pass.width.saturating_sub(2),
            Line::styled(
                format!("‼ BLOCKED  {names}  {elapsed}"),
                Style::default()
                    .fg(mapped(theme::RED_HI, color_mode))
                    .bg(mapped(theme::PANEL2, color_mode))
                    .add_modifier(Modifier::BOLD),
            ),
        );
    }

    for (station, agent) in layout.stations.iter().copied().zip(agents.iter().copied()) {
        let station_area = cell_rect(station);
        let blocked = agent.state == AgentState::Blocked;
        frame.render_widget(
            Block::default()
                .borders(Borders::ALL)
                .border_type(if blocked {
                    BorderType::Double
                } else {
                    BorderType::Plain
                })
                .border_style(Style::default().fg(mapped(
                    if blocked { theme::RED } else { theme::STEEL_LO },
                    color_mode,
                ))),
            station_area,
        );

        let chip = format!(" {}T ", agent.session.tickets);
        let chip_width = chip.chars().count() as u16;
        render_line(
            frame,
            area,
            station_area.right().saturating_sub(chip_width + 1),
            station_area.y,
            chip_width,
            Line::styled(
                chip,
                Style::default()
                    .fg(mapped(theme::BG, color_mode))
                    .bg(mapped(theme::accent(agent.accent_index), color_mode))
                    .add_modifier(Modifier::BOLD),
            ),
        );

        if blocked && station_area.height >= 3 {
            let banner = format!("‼ BLOCKED {} ‼", blocked_elapsed(agent, now));
            let banner_width = banner.chars().count() as u16;
            let banner_x = station_area
                .x
                .saturating_add(station_area.width.saturating_sub(banner_width) / 2);
            render_line(
                frame,
                area,
                banner_x,
                station_area.bottom().saturating_sub(2),
                banner_width.min(station_area.width),
                Line::styled(
                    banner,
                    Style::default()
                        .fg(mapped(theme::TEXT, color_mode))
                        .bg(mapped(theme::RED_DIM, color_mode))
                        .add_modifier(Modifier::BOLD),
                ),
            );
        }

        let (word, word_color, word_bold) = match agent.state {
            AgentState::Idle => ("PREP", theme::DIM, false),
            AgentState::Working => ("FIRE", theme::FIRE, false),
            AgentState::Blocked => ("AT THE PASS", theme::RED_HI, true),
            AgentState::Done => ("PLATED ✓", theme::GREEN, false),
            AgentState::Ended => unreachable!("ended agents are not active stations"),
        };
        let available = station_area.width.saturating_sub(4);
        let suffix = format!("· {word} ");
        let maximum_name = usize::from(available)
            .saturating_sub(suffix.chars().count() + 2)
            .max(1);
        let display_name = agent.name.chars().take(maximum_name).collect::<String>();
        render_line(
            frame,
            area,
            station_area.x + 2,
            station_area.bottom().saturating_sub(1),
            available,
            Line::from(vec![
                Span::styled(
                    format!(" {display_name} "),
                    Style::default()
                        .fg(mapped(theme::TEXT, color_mode))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    suffix,
                    Style::default()
                        .fg(mapped(word_color, color_mode))
                        .add_modifier(if word_bold {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                ),
            ]),
        );
    }

    if agents.is_empty() {
        let waiting = "Waiting for agents — start one in herdr";
        render_line(
            frame,
            area,
            area.width.saturating_sub(waiting.chars().count() as u16) / 2,
            area.height / 2,
            waiting.chars().count() as u16,
            Line::styled(waiting, Style::default().fg(mapped(theme::DIM, color_mode))),
        );
    }

    let connection = connection_text(table, warning);
    render_line(
        frame,
        area,
        2,
        area.height.saturating_sub(1),
        area.width.saturating_sub(4),
        Line::styled(
            connection,
            Style::default().fg(mapped(theme::DIM, color_mode)),
        ),
    );
    let keys = "q / Esc quit · ? help";
    render_line(
        frame,
        area,
        area.width.saturating_sub(keys.chars().count() as u16 + 2),
        area.height.saturating_sub(1),
        keys.chars().count() as u16,
        Line::styled(keys, Style::default().fg(mapped(theme::DIM, color_mode))),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        AgentStateEvent, AppMode, DeltaOperation, SessionStats, SourceDiagnostic,
    };
    use chrono::TimeZone;
    use ratatui::{backend::TestBackend, buffer::Buffer, Terminal};

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

    fn render(table: &AgentTable, width: u16, height: u16, tick: u64) -> Buffer {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| {
                draw(
                    frame,
                    table,
                    Some("bind warning"),
                    Utc.with_ymd_and_hms(2026, 8, 13, 12, 0, 0).unwrap(),
                    tick,
                    ColorMode::Xterm256,
                    true,
                )
            })
            .unwrap();
        terminal.backend().buffer().clone()
    }

    fn text(buffer: &Buffer) -> String {
        buffer.content.iter().map(|cell| cell.symbol()).collect()
    }

    fn buffer_dump(buffer: &Buffer) -> String {
        let mut dump = format!("AREA {}x{}\n", buffer.area.width, buffer.area.height);
        for y in buffer.area.y..buffer.area.bottom() {
            let row = (buffer.area.x..buffer.area.right())
                .map(|x| buffer.cell((x, y)).unwrap().symbol())
                .collect::<String>();
            dump.push_str(&format!("TEXT {y:02} {row:?}\n"));
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
                        || next.diff_option != cell.diff_option
                        || next.symbol() != cell.symbol()
                    {
                        break;
                    }
                    x += 1;
                }
                dump.push_str(&format!(
                    "CELL {y:02} {start:03}..{x:03} symbol={:?} fg={:?} bg={:?} mod={:?} diff={:?}\n",
                    cell.symbol(), cell.fg, cell.bg, cell.modifier, cell.diff_option
                ));
            }
        }
        dump
    }

    fn pixel(buffer: &Buffer, x: u16, y: u16) -> Color {
        let cell = buffer.cell((x, y / 2)).unwrap();
        if y.is_multiple_of(2) {
            cell.fg
        } else {
            cell.bg
        }
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
        let state = |name, state| {
            snapshot(
                AppMode::Live,
                SourceStatus::Connected,
                None,
                vec![record(name, state)],
            )
        };
        let mut ended = state("ended", AgentState::Done);
        ended.apply(AgentStateEvent::Delta {
            version: 1,
            mode: AppMode::Live,
            operation: DeltaOperation::Upsert,
            agent: Some(record("ended", AgentState::Ended)),
            agent_id: None,
        });
        vec![
            ("idle", state("idle", AgentState::Idle), 80, 24),
            ("working", state("working", AgentState::Working), 80, 24),
            ("blocked", state("blocked", AgentState::Blocked), 80, 24),
            ("done", state("done", AgentState::Done), 80, 24),
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
                        supported_protocols: vec![17, 19, 20],
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

    #[test]
    fn fixed_input_scene_goldens_are_stable_and_committed() {
        for (name, table, width, height) in golden_cases() {
            let actual = buffer_dump(&render(&table, width, height, 9));
            assert_eq!(actual, buffer_dump(&render(&table, width, height, 9)));
            let path = format!(
                "{}/tests/goldens/scene-{name}.txt",
                env!("CARGO_MANIFEST_DIR")
            );
            if std::env::var_os("UPDATE_SCENE_GOLDENS").is_some() {
                std::fs::write(&path, &actual).unwrap();
            }
            let expected = std::fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("missing golden {path}: {error}"));
            assert_eq!(actual, expected, "golden mismatch: {path}");
        }
    }

    #[test]
    fn snapshot_fixture_renders_two_tier_unclipped_hats() {
        let event = serde_json::from_str::<AgentStateEvent>(include_str!(
            "../../../../protocol/fixtures/snapshot.v1.json"
        ))
        .unwrap();
        let mut table = AgentTable::default();
        table.apply(event);

        let at_zero = render(&table, 80, 24, 0);
        let at_four = render(&table, 80, 24, 4);
        for sprite_x in [12, 53] {
            let coat_width = |buffer: &Buffer, y| {
                (sprite_x..sprite_x + sprites::SPRITE_WIDTH as u16)
                    .filter(|x| pixel(buffer, *x, y) == theme::COAT)
                    .count()
            };
            assert_eq!(coat_width(&at_zero, 24), 5);
            assert_eq!(coat_width(&at_zero, 26), 9);
        }
        for y in 24..29 {
            for x in 53..53 + sprites::SPRITE_WIDTH as u16 {
                assert_eq!(pixel(&at_zero, x, y), pixel(&at_four, x, y));
            }
        }

        let (_, done, width, height) = golden_cases()
            .into_iter()
            .find(|(name, ..)| *name == "done")
            .unwrap();
        let done = render(&done, width, height, 0);
        for y in 24..29 {
            for x in 34..34 + sprites::SPRITE_WIDTH as u16 {
                assert!(!matches!(pixel(&done, x, y), theme::PLATE | theme::GREEN));
            }
        }
    }

    #[test]
    fn blocked_and_clear_frames_keep_neutral_outer_chrome_without_pulsing() {
        for table in [
            live_table(vec![record("idle", AgentState::Idle)]),
            live_table(vec![record("blocked", AgentState::Blocked)]),
        ] {
            let at_zero = render(&table, 80, 24, 0);
            let at_nine = render(&table, 80, 24, 9);
            for buffer in [&at_zero, &at_nine] {
                assert_eq!(buffer.cell((0, 0)).unwrap().fg, theme::FRAME);
                assert_eq!(buffer.cell((79, 23)).unwrap().fg, theme::FRAME);
            }
        }
    }

    #[test]
    fn state_specific_station_chrome_and_half_block_art_are_present() {
        let table = live_table(vec![
            record("idle", AgentState::Idle),
            record("work", AgentState::Working),
            record("blocked", AgentState::Blocked),
        ]);
        let buffer = render(&table, 80, 24, 2);
        let output = text(&buffer);
        for expected in [
            "PREP",
            "FIRE",
            "AT THE PASS",
            "‼ BLOCKED 00:00 ‼",
            "10Hz · tick 2",
            "? help",
        ] {
            assert!(output.contains(expected), "missing {expected:?}");
        }
        assert!(buffer.content.iter().any(|cell| cell.symbol() == "▀"));
        assert!(buffer
            .content
            .iter()
            .any(|cell| cell.symbol() == "╔" && cell.fg == theme::RED));
        let blocked_banner = buffer
            .content
            .iter()
            .find(|cell| cell.symbol() == "‼" && cell.bg == theme::RED_DIM)
            .expect("blocked station banner");
        assert_eq!(blocked_banner.fg, theme::TEXT);
        assert!(!blocked_banner.modifier.contains(Modifier::REVERSED));
    }

    #[test]
    fn working_flames_alternate_but_static_states_do_not() {
        let working = live_table(vec![record("work", AgentState::Working)]);
        let even = render(&working, 80, 24, 0);
        let odd = render(&working, 80, 24, 1);
        assert_eq!(even.cell((45, 18)).unwrap().fg, theme::FIRE_HI);
        assert_eq!(even.cell((47, 18)).unwrap().fg, theme::FIRE);
        assert_eq!(odd.cell((45, 18)).unwrap().fg, theme::FIRE);
        assert_eq!(odd.cell((47, 18)).unwrap().fg, theme::FIRE_HI);
        let blocked = live_table(vec![record("blocked", AgentState::Blocked)]);
        // Tick text changes, so compare the sprite's known center region only.
        let a = render(&blocked, 80, 24, 0);
        let b = render(&blocked, 80, 24, 9);
        for y in 12..19 {
            for x in 8..19 {
                assert_eq!(a.cell((x, y)), b.cell((x, y)));
            }
        }
    }

    #[test]
    fn working_sprite_wins_ticket_overlap_at_minimum_station_width() {
        let working = live_table(
            (0..3)
                .map(|i| record(&i.to_string(), AgentState::Working))
                .collect(),
        );
        let buffer = render(&working, 80, 24, 0);
        let overlap = buffer.cell((7, 13)).unwrap();
        assert_eq!(overlap.fg, theme::COAT);
        assert_eq!(overlap.bg, theme::COAT);
    }

    #[test]
    fn responsive_boundaries_and_compact_fallback_are_rendered() {
        let three = live_table(
            (0..3)
                .map(|i| record(&i.to_string(), AgentState::Working))
                .collect(),
        );
        let minimum = text(&render(&three, 80, 24, 0));
        assert_eq!(minimum.matches("· FIRE").count(), 3);
        let six = live_table(
            (0..6)
                .map(|i| record(&i.to_string(), AgentState::Idle))
                .collect(),
        );
        let full = text(&render(&six, 110, 40, 0));
        assert_eq!(full.matches("· PREP").count(), 6);
        let fallback = text(&render(&three, 79, 24, 0));
        assert!(fallback.contains("Kitchen status"));
        let fallback = text(&render(&three, 80, 23, 0));
        assert!(fallback.contains("Kitchen status"));
    }

    #[test]
    fn xterm_scene_emits_only_indexed_handoff_colors_and_all_accent_pairs() {
        let agents = (0..6)
            .map(|index| {
                let mut agent = record(&index.to_string(), AgentState::Idle);
                agent.accent_index = index;
                agent
            })
            .collect();
        let buffer = render(&live_table(agents), 110, 40, 0);
        assert!(buffer.content.iter().all(|cell| {
            matches!(cell.fg, Color::Reset | Color::Indexed(_))
                && matches!(cell.bg, Color::Reset | Color::Indexed(_))
        }));
        let emitted = buffer
            .content
            .iter()
            .flat_map(|cell| [cell.fg, cell.bg])
            .collect::<Vec<_>>();
        for expected in theme::ACCENTS.into_iter().chain(theme::ACCENT_DIMS) {
            assert!(emitted.contains(&expected), "missing rendered {expected:?}");
        }
        for expected in [
            theme::BG,
            theme::PANEL,
            theme::FRAME,
            theme::TEXT,
            theme::DIM,
            theme::STEEL_LO,
            theme::COAT,
            theme::COAT_LO,
            theme::SKIN,
            theme::PANTS,
            theme::BOOT,
            theme::BRASS,
            theme::BOARD,
        ] {
            assert!(emitted.contains(&expected), "missing rendered {expected:?}");
        }
    }

    #[test]
    fn ended_moves_to_board_and_truthful_status_survives() {
        let mut table = live_table(vec![record("a", AgentState::Done)]);
        table.apply(AgentStateEvent::Delta {
            version: 1,
            mode: AppMode::Live,
            operation: DeltaOperation::Upsert,
            agent: Some(record("a", AgentState::Ended)),
            agent_id: None,
        });
        let output = text(&render(&table, 80, 24, 4));
        assert!(output.contains("86 BOARD"));
        assert!(output.contains("COOK A"));
        assert!(output.contains("Waiting for agents"));

        let mut demo = AgentTable::default();
        demo.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Demo,
            source_status: SourceStatus::UnsupportedProtocol,
            source_diagnostic: Some(SourceDiagnostic {
                observed_protocol: 23,
                supported_protocols: vec![17, 19, 20],
                next_action: "upgrade Herdr, then retry".into(),
            }),
            agents: vec![],
        });
        let output = text(&render(&demo, 110, 40, 0));
        assert!(output.contains("MISE — DEMO SERVICE"));
        assert!(output.contains("Mock feed"));
        assert!(output.contains("Nothing here is real"));
    }
}
