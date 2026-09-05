pub mod layout;
pub mod particles;
pub mod sprites;

use chrono::{DateTime, Utc};
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph, Wrap},
    Frame,
};

use self::layout::{compute_freezer_layout, compute_layout, LayoutDecision, PixelRect};
use super::{
    canvas::{rgb_to_xterm256, ColorMode, PixelCanvas},
    state::{AgentTable, BoardEntry, BOARD_CAP},
    theme, view, SceneView, HELP_LINES, KEY_ESC_CLOSE, KEY_ESC_KITCHEN, KEY_FREEZER, KEY_HELP,
    KEY_INSPECT, KEY_KITCHEN, KEY_QUIT, KEY_QUIT_ESC,
};
use crate::protocol::{AgentRecord, AgentState, AppMode, SourceStatus};

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
        b'Z' => Some(theme::STEAM_HI),
        b'z' => Some(theme::STEAM),
        _ => None,
    }
}

fn cell_rect(rect: PixelRect) -> Rect {
    Rect::new(rect.x, rect.y / 2, rect.width, rect.height.div_ceil(2))
}

fn pane_rect(area: Rect, rect: Rect) -> Rect {
    Rect::new(area.x + rect.x, area.y + rect.y, rect.width, rect.height)
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

fn motion_tick(tick: u64, reduced_motion: bool) -> u64 {
    if reduced_motion {
        0
    } else {
        tick
    }
}

fn draw_sprite(canvas: &mut PixelCanvas, station: PixelRect, agent: &AgentRecord, tick: u64) {
    let sprite = sprites::cook_sprite(&agent.state, tick);
    if sprite.rows.is_empty()
        || station.width < sprites::SPRITE_WIDTH as u16 + 2
        || station.height < 8
    {
        return;
    }
    let working = agent.state == AgentState::Working;
    let avail_h = station.height.saturating_sub(2).max(1);
    let avail_w = station.width.saturating_sub(2).max(1);
    let row_step = (sprites::SPRITE_HALF_ROWS as u16).div_ceil(avail_h).max(1);
    let col_step = (sprites::SPRITE_WIDTH as u16).div_ceil(avail_w).max(1);
    let drawn_h = (sprites::SPRITE_HALF_ROWS as u16).div_ceil(row_step);
    let drawn_w = (sprites::SPRITE_WIDTH as u16).div_ceil(col_step);
    let centered = station.x + station.width.saturating_sub(drawn_w) / 2;
    let sprite_x = i32::from(centered.saturating_sub(u16::from(working) * theme::WORKING_SHIFT));
    let sprite_y = i32::from(station.y + station.height.saturating_sub(drawn_h) / 2);
    if working && station.width >= theme::TICKET_MIN_STATION_WIDTH {
        let ticket_x = i32::from(station.x) + theme::TICKET_X_INSET;
        let ticket_y = i32::from(station.y) + theme::TICKET_Y_INSET;
        for row in 0..theme::TICKET_HEIGHT {
            for column in 0..theme::TICKET_WIDTH {
                put_inside(
                    canvas,
                    station,
                    ticket_x + column,
                    ticket_y + row,
                    theme::PLATE,
                );
            }
        }
        for column in theme::TICKET_PIN_START..=theme::TICKET_PIN_END {
            put_inside(
                canvas,
                station,
                ticket_x + column,
                ticket_y + theme::TICKET_PIN_Y,
                theme::STEEL_LO,
            );
        }
        for column in 0..theme::TICKET_MARK_W {
            put_inside(
                canvas,
                station,
                ticket_x + column,
                ticket_y + theme::TICKET_MARK_Y1,
                theme::STEAM,
            );
            put_inside(
                canvas,
                station,
                ticket_x + column,
                ticket_y + theme::TICKET_MARK_Y2,
                theme::STEAM,
            );
        }
        for column in 0..theme::TICKET_MARK3_W {
            put_inside(
                canvas,
                station,
                ticket_x + column,
                ticket_y + theme::TICKET_MARK_Y3,
                theme::STEAM,
            );
        }
    }

    for (row_index, row) in sprite.rows.iter().enumerate() {
        if !(row_index as u16).is_multiple_of(row_step) {
            continue;
        }
        let dy = row_index as u16 / row_step;
        for (column, key) in row.bytes().enumerate() {
            if !(column as u16).is_multiple_of(col_step) {
                continue;
            }
            if let Some(color) = pixel_color(key, agent) {
                put_inside(
                    canvas,
                    station,
                    sprite_x + i32::from(column as u16 / col_step),
                    sprite_y + i32::from(dy),
                    color,
                );
            }
        }
    }

    if !working || station.width < theme::TICKET_MIN_STATION_WIDTH {
        return;
    }

    let pot_x = sprite_x + theme::POT_X_OFFSET;
    let pot_y = sprite_y + theme::POT_Y_OFFSET;
    for column in 0..theme::POT_WIDTH {
        put_inside(canvas, station, pot_x + column, pot_y, theme::POT_HI);
        put_inside(canvas, station, pot_x + column, pot_y + 1, theme::POT);
        put_inside(
            canvas,
            station,
            pot_x + column,
            pot_y + theme::POT_BODY_ROWS,
            theme::POT,
        );
    }
    put_inside(
        canvas,
        station,
        pot_x + theme::POT_SPOUT_X,
        pot_y + theme::POT_SPOUT_Y,
        theme::POT_HI,
    );
    let (left_fire, right_fire) = if tick.is_multiple_of(2) {
        (theme::FIRE_HI, theme::FIRE)
    } else {
        (theme::FIRE, theme::FIRE_HI)
    };
    put_inside(
        canvas,
        station,
        pot_x + theme::FIRE_LEFT_X,
        pot_y + theme::FIRE_Y,
        left_fire,
    );
    put_inside(
        canvas,
        station,
        pot_x + theme::FIRE_RIGHT_X,
        pot_y + theme::FIRE_Y,
        right_fire,
    );

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

fn draw_spirit(canvas: &mut PixelCanvas, slot: PixelRect, pose: u8) {
    let sprite = sprites::spirit_sprite(pose);
    let x = slot.x + slot.width.saturating_sub(sprite.width() as u16) / 2;
    let y = slot.y;
    for (row, pixels) in sprite.rows.iter().enumerate() {
        for (column, key) in pixels.bytes().enumerate() {
            let color = match key {
                b'H' | b'C' => Some(theme::COAT),
                b'h' | b'c' => Some(theme::COAT_LO),
                b'S' | b'K' => Some(theme::ICE),
                b'X' | b'e' => Some(theme::EYE),
                b't' => Some(theme::SKIN_MAD),
                b'a' => Some(theme::SPIRIT),
                b'A' => Some(theme::SPIRIT_DIM),
                b'D' => Some(theme::PANTS),
                b'B' => Some(theme::BOOT),
                b'o' => Some(theme::BAND),
                _ => None,
            };
            if let Some(color) = color {
                canvas.put(
                    i32::from(x) + column as i32,
                    i32::from(y) + row as i32,
                    color,
                );
            }
        }
    }
}

fn draw_ice_cubes(canvas: &mut PixelCanvas, floor: PixelRect) {
    let size = theme::ICE_CUBE_SIZE;
    let origin_x = i32::from(floor.x.saturating_add(theme::ICE_CUBE_X_INSET));
    let origin_y = i32::from(floor.bottom().saturating_sub(theme::ICE_CUBE_Y_INSET));
    for (col, height) in theme::ICE_CUBE_STACKS {
        for level in 0..height {
            canvas.fill_rect(
                origin_x + col * (size + 1),
                origin_y - level * (size + 1),
                size,
                size,
                if level % 2 == 0 {
                    theme::STEAM_HI
                } else {
                    theme::ICE
                },
            );
        }
    }
}

fn draw_gravestone(canvas: &mut PixelCanvas, floor: PixelRect) {
    let x = i32::from(floor.right().saturating_sub(theme::GRAVE_X_INSET));
    let y = i32::from(floor.bottom().saturating_sub(theme::GRAVE_Y_INSET));
    canvas.fill_rect(
        x,
        y + theme::GRAVE_BODY_Y,
        theme::GRAVE_W,
        theme::GRAVE_H,
        theme::STEEL,
    );
    canvas.fill_rect(
        x + theme::GRAVE_CAP_X,
        y,
        theme::GRAVE_CAP_W,
        theme::GRAVE_CAP_H,
        theme::ICE_LO,
    );
}

fn draw_icicles_and_puddles(canvas: &mut PixelCanvas, area: Rect, floor: PixelRect) {
    for x in (theme::ICICLE_MARGIN..area.width.saturating_sub(theme::ICICLE_MARGIN))
        .step_by(theme::ICICLE_STEP)
    {
        canvas.fill_rect(
            i32::from(x),
            theme::ICICLE_Y,
            1,
            i32::from(theme::ICICLE_BASE_H + x % theme::ICICLE_H_MOD),
            theme::ICE,
        );
    }
    canvas.fill_rect(
        i32::from(floor.x.saturating_add(theme::PUDDLE_NEAR_X)),
        i32::from(floor.bottom().saturating_sub(theme::PUDDLE_NEAR_Y)),
        theme::PUDDLE_NEAR_W,
        theme::PUDDLE_NEAR_H,
        theme::STEAM_HI,
    );
    canvas.fill_rect(
        i32::from(floor.x.saturating_add(theme::PUDDLE_FAR_X)),
        i32::from(floor.bottom().saturating_sub(theme::PUDDLE_FAR_Y)),
        theme::PUDDLE_FAR_W,
        theme::PUDDLE_FAR_H,
        theme::ICE,
    );
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
    format!("{:02}:{:02}", minutes, seconds % 60)
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
        return view::sanitize_external(&entry.name)
            .chars()
            .take(width)
            .collect();
    }
    let runtime = if entry.runtime_ms == 0 {
        "—".into()
    } else {
        format_runtime(entry.runtime_ms)
    };
    board_columns(
        &view::sanitize_external(&entry.name)
            .to_uppercase()
            .chars()
            .take(width.saturating_sub(theme::BOARD_FACTS_WIDTH).max(4))
            .collect::<String>(),
        &runtime,
        width,
    )
}

fn board_columns(name: &str, mise: &str, width: usize) -> String {
    let name_width = width.saturating_sub(theme::BOARD_FACTS_WIDTH).max(4);
    format!(
        "{name:<name_width$} {mise:>fact_width$}",
        fact_width = theme::BOARD_FACT_WIDTH,
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
        |warning| format!("{connection} · {}", view::sanitize_external(warning)),
    )
}

fn board_count_text(table: &AgentTable) -> String {
    format!("86 {}/{BOARD_CAP}", table.board().len())
}

fn footer_connection(table: &AgentTable, warning: Option<&str>, width: u16) -> String {
    let board = board_count_text(table);
    let connection_width = usize::from(width).saturating_sub(board.chars().count() + 3);
    format!(
        "{} · {board}",
        connection_text(table, warning)
            .chars()
            .take(connection_width)
            .collect::<String>()
    )
}

fn draw_help(frame: &mut Frame<'_>, color_mode: ColorMode) {
    let area = frame.area();
    let width = HELP_LINES
        .iter()
        .map(|line| line.chars().count() as u16)
        .max()
        .unwrap_or_default()
        .saturating_add(4)
        .min(area.width);
    let line_width = width.saturating_sub(2).max(1);
    let paragraph = Paragraph::new(HELP_LINES.map(Line::from).to_vec())
        .wrap(Wrap { trim: false })
        .block(
            Block::default().borders(Borders::ALL).style(
                Style::default()
                    .fg(mapped(theme::TEXT, color_mode))
                    .bg(mapped(theme::PANEL2, color_mode)),
            ),
        );
    let height = u16::try_from(paragraph.line_count(line_width))
        .unwrap_or(u16::MAX)
        .saturating_add(2)
        .min(area.height);
    let overlay = Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    );
    frame.render_widget(paragraph, overlay);
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_view(
    frame: &mut Frame<'_>,
    table: &AgentTable,
    warning: Option<&str>,
    now: DateTime<Utc>,
    tick: u64,
    color_mode: ColorMode,
    scene_supported: bool,
    selected_id: Option<&str>,
    scene_view: SceneView,
    help_open: bool,
    reduced_motion: bool,
) {
    if !scene_supported {
        view::draw(
            frame,
            table,
            warning,
            now,
            motion_tick(tick, reduced_motion),
            selected_id,
        );
        if help_open {
            draw_help(frame, color_mode);
        }
        return;
    }
    let area = frame.area();
    match scene_view {
        SceneView::Freezer => draw_freezer(
            frame,
            area,
            table,
            warning,
            now,
            tick,
            color_mode,
            selected_id,
            reduced_motion,
        ),
        SceneView::Kitchen => draw_kitchen(
            frame,
            area,
            table,
            warning,
            now,
            tick,
            color_mode,
            selected_id,
            reduced_motion,
        ),
    }
    if help_open {
        draw_help(frame, color_mode);
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_kitchen(
    frame: &mut Frame<'_>,
    area: Rect,
    table: &AgentTable,
    warning: Option<&str>,
    now: DateTime<Utc>,
    tick: u64,
    color_mode: ColorMode,
    selected_id: Option<&str>,
    reduced_motion: bool,
) {
    let agents = table.agents().collect::<Vec<_>>();
    let LayoutDecision::Scene(layout) =
        compute_layout(area.width, area.height.saturating_mul(2), agents.len())
    else {
        if area == frame.area() {
            view::draw(
                frame,
                table,
                warning,
                now,
                motion_tick(tick, reduced_motion),
                selected_id,
            );
        }
        return;
    };

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
        draw_sprite(
            &mut canvas,
            station,
            agent,
            motion_tick(tick, reduced_motion),
        );
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
    let tick_text = format!("10Hz · tick {}", motion_tick(tick, reduced_motion));
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
        pane_rect(area, board_area),
    );
    if !table.board().is_empty() {
        let width = usize::from(board_area.width.saturating_sub(4));
        render_line(
            frame,
            area,
            board_area.x + 2,
            board_area.y + 1,
            board_area.width.saturating_sub(4),
            Line::styled(
                board_columns("COOK", "MISE TIME", width),
                Style::default()
                    .fg(mapped(theme::CHALK, color_mode))
                    .bg(mapped(theme::BOARD, color_mode)),
            ),
        );
        for (row, entry) in table.board().iter().rev().take(3).enumerate() {
            render_line(
                frame,
                area,
                board_area.x + 2,
                board_area.y + 2 + row as u16,
                board_area.width.saturating_sub(4),
                Line::styled(
                    board_line(entry, width),
                    Style::default()
                        .fg(mapped(theme::CHALK, color_mode))
                        .bg(mapped(theme::BOARD, color_mode)),
                ),
            );
        }
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
            .map(|agent| view::sanitize_external(&agent.name))
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
        let selected = selected_id == Some(agent.id.as_str());
        frame.render_widget(
            Block::default()
                .borders(Borders::ALL)
                .border_type(if blocked || selected {
                    BorderType::Double
                } else {
                    BorderType::Plain
                })
                .border_style(Style::default().fg(mapped(
                    if blocked {
                        theme::RED
                    } else if selected {
                        theme::BRASS
                    } else {
                        theme::STEEL_LO
                    },
                    color_mode,
                ))),
            pane_rect(area, station_area),
        );

        let chip = if agent.session.tickets_text() == "Unavailable" {
            " ?T ".into()
        } else {
            format!(" {}T ", agent.session.tickets)
        };
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

        let (mut word, word_color, word_bold) = match agent.state {
            AgentState::Idle => ("PREP", theme::DIM, false),
            AgentState::Working => ("FIRE", theme::FIRE, false),
            AgentState::Blocked => ("AT THE PASS", theme::RED_HI, true),
            AgentState::Done => ("PLATED ✓", theme::GREEN, false),
            AgentState::Ended => unreachable!("ended agents are not active stations"),
        };
        if agent.state_known == Some(false) {
            word = "UNKNOWN";
        }
        let available = station_area.width.saturating_sub(4);
        let suffix = format!("· {word} ");
        let maximum_name = usize::from(available)
            .saturating_sub(suffix.chars().count() + 2)
            .max(1);
        let display_name = view::sanitize_external(&agent.name)
            .chars()
            .take(maximum_name)
            .collect::<String>();
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

    if agents.is_empty()
        && table.mode() == AppMode::Live
        && table.source_status() == &SourceStatus::Connected
    {
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

    if let Some(agent) = selected_id.and_then(|id| agents.iter().find(|agent| agent.id == id)) {
        for (row, facts) in view::inspect_facts(agent).into_iter().enumerate() {
            render_line(
                frame,
                area,
                2,
                area.height.saturating_sub(3) + row as u16,
                area.width.saturating_sub(4),
                Line::styled(
                    facts,
                    Style::default()
                        .fg(mapped(theme::TEXT, color_mode))
                        .bg(mapped(theme::PANEL2, color_mode))
                        .add_modifier(Modifier::BOLD),
                ),
            );
        }
    }

    let keys = if selected_id.is_some() {
        format!("{KEY_INSPECT} · {KEY_FREEZER} · {KEY_ESC_CLOSE} · {KEY_QUIT}")
    } else {
        format!("{KEY_FREEZER} · {KEY_QUIT_ESC} · {KEY_HELP}")
    };
    let connection_width = area.width.saturating_sub(keys.chars().count() as u16 + 5);
    let connection = footer_connection(table, warning, connection_width);
    render_line(
        frame,
        area,
        2,
        area.height.saturating_sub(1),
        connection_width,
        Line::styled(
            connection,
            Style::default().fg(mapped(theme::DIM, color_mode)),
        ),
    );
    render_line(
        frame,
        area,
        area.width.saturating_sub(keys.chars().count() as u16 + 2),
        area.height.saturating_sub(1),
        keys.chars().count() as u16,
        Line::styled(keys, Style::default().fg(mapped(theme::DIM, color_mode))),
    );
}

#[allow(clippy::too_many_arguments)]
fn draw_freezer(
    frame: &mut Frame<'_>,
    area: Rect,
    table: &AgentTable,
    warning: Option<&str>,
    now: DateTime<Utc>,
    tick: u64,
    color_mode: ColorMode,
    selected_id: Option<&str>,
    reduced_motion: bool,
) {
    let ids = table
        .board()
        .iter()
        .map(|entry| entry.id.as_str())
        .collect::<Vec<_>>();
    let Some(layout) = compute_freezer_layout(area.width, area.height.saturating_mul(2), &ids)
    else {
        if area == frame.area() {
            view::draw(
                frame,
                table,
                warning,
                now,
                motion_tick(tick, reduced_motion),
                selected_id,
            );
        }
        return;
    };
    let mut canvas = PixelCanvas::new(
        area.width,
        area.height.saturating_mul(2),
        theme::STEEL_LO,
        color_mode,
    );
    canvas.clear(theme::STEEL_LO);
    canvas.fill_rect(
        theme::FREEZER_SHELL_INSET,
        theme::FREEZER_SHELL_INSET,
        i32::from(area.width) - theme::FREEZER_SHELL_INSET * 2,
        i32::from(area.height.saturating_mul(2)) - theme::FREEZER_SHELL_INSET * 2,
        theme::STEEL,
    );
    canvas.fill_rect(
        layout.floor.x.into(),
        layout.floor.y.into(),
        layout.floor.width.into(),
        layout.floor.height.into(),
        theme::FREEZER_FLOOR,
    );
    for rack in layout.racks {
        canvas.fill_rect(
            rack.x.into(),
            rack.y.into(),
            rack.width.into(),
            rack.height.into(),
            theme::STEEL_LO,
        );
        for shelf in 1..theme::FREEZER_SHELF_DIVISIONS {
            let y = rack.y + rack.height * shelf / theme::FREEZER_SHELF_DIVISIONS;
            canvas.fill_rect(
                rack.x.into(),
                y.into(),
                rack.width.into(),
                theme::FREEZER_SHELF_THICKNESS.into(),
                theme::COAT_LO,
            );
            let bin_w = i32::from(rack.width / theme::FREEZER_BIN_FRACTION);
            let bins = [
                (
                    i32::from(rack.x + theme::FREEZER_BIN_X_INSET),
                    if shelf.is_multiple_of(2) {
                        theme::SKIN_MAD
                    } else {
                        theme::GREEN
                    },
                ),
                (i32::from(rack.x) + bin_w + 1, theme::COAT),
                (
                    i32::from(
                        rack.right()
                            .saturating_sub(bin_w as u16 + theme::FREEZER_BIN_X_INSET),
                    ),
                    if shelf.is_multiple_of(2) {
                        theme::ICE
                    } else {
                        theme::SKIN_MAD
                    },
                ),
            ];
            for (x, color) in bins {
                for layer in 0..theme::FREEZER_BIN_STACK {
                    canvas.fill_rect(
                        x + i32::from(layer),
                        i32::from(y)
                            - i32::from(theme::FREEZER_BIN_HEIGHT)
                            - i32::from(layer * theme::FREEZER_BIN_STACK_LIFT),
                        bin_w,
                        i32::from(theme::FREEZER_BIN_HEIGHT),
                        color,
                    );
                }
            }
        }
    }
    canvas.fill_rect(
        layout.door.x.into(),
        layout.door.y.into(),
        layout.door.width.into(),
        layout.door.height.into(),
        theme::STEEL_LO,
    );
    canvas.fill_rect(
        i32::from(layout.door.x + theme::FREEZER_DOOR_FRAME),
        i32::from(layout.door.y + theme::FREEZER_DOOR_FRAME),
        i32::from(layout.door.width - theme::FREEZER_DOOR_FRAME * 2),
        i32::from(layout.door.height - theme::FREEZER_DOOR_FRAME * 2),
        theme::STEEL,
    );
    canvas.fill_rect(
        i32::from(layout.door.x + layout.door.width - theme::FREEZER_DOOR_FRAME * 2),
        i32::from(layout.door.y + layout.door.height / 2),
        i32::from(theme::FREEZER_HANDLE_WIDTH),
        i32::from(theme::FREEZER_HANDLE_HEIGHT),
        theme::COAT_LO,
    );
    for y in [
        layout.door.y + theme::FREEZER_DOOR_FRAME,
        layout.door.bottom() - theme::FREEZER_DOOR_FRAME * 2,
    ] {
        canvas.fill_rect(
            layout.door.x.into(),
            y.into(),
            1,
            theme::FREEZER_HINGE_HEIGHT.into(),
            theme::COAT_LO,
        );
    }
    for frost in &layout.frost {
        canvas.fill_rect(
            frost.x.into(),
            frost.y.into(),
            frost.width.into(),
            frost.height.into(),
            theme::STEAM_HI,
        );
    }
    draw_icicles_and_puddles(&mut canvas, area, layout.floor);
    draw_ice_cubes(&mut canvas, layout.floor);
    for x in (2..area.width.saturating_sub(2)).step_by(theme::FREEZER_RIVET_STEP.into()) {
        canvas.put(i32::from(x), 1, theme::COAT_LO);
        canvas.put(
            i32::from(x),
            i32::from(layout.room.height - 2),
            theme::COAT_LO,
        );
    }
    let snow_tick = if !reduced_motion { tick } else { 0 };
    for particle in particles::snow_at_tick(
        snow_tick,
        area.width.min(i16::MAX as u16) as i16,
        layout.room.height.min(i16::MAX as u16) as i16,
    ) {
        canvas.put(
            i32::from(particle.x),
            i32::from(particle.y),
            if particle.shade == 0 {
                theme::ICE
            } else {
                theme::ICE_LO
            },
        );
    }
    if !reduced_motion {
        draw_gravestone(&mut canvas, layout.floor);
    }
    for (_, (slot, pose)) in table.board().iter().zip(&layout.spirits) {
        draw_spirit(&mut canvas, *slot, *pose);
    }
    frame.render_widget(&canvas, area);
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .title(Span::styled(
                " WALK-IN FREEZER ",
                Style::default()
                    .fg(mapped(theme::STEAM_HI, color_mode))
                    .add_modifier(Modifier::BOLD),
            ))
            .border_style(Style::default().fg(mapped(theme::STEEL, color_mode))),
        area,
    );
    let (title, source) = view::status_lines(
        table.mode(),
        table.source_status(),
        table.source_diagnostic(),
        table.agents().count(),
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
            source_width,
            Line::styled(
                source_overflow,
                Style::default().fg(mapped(theme::DIM, color_mode)),
            ),
        );
    }
    for (entry, (slot, _)) in table.board().iter().zip(&layout.spirits) {
        let name = view::sanitize_external(&entry.name)
            .to_uppercase()
            .chars()
            .take(theme::SPIRIT_LABEL_CHARS)
            .collect::<String>();
        render_line(
            frame,
            area,
            slot.x + slot.width.saturating_sub(name.chars().count() as u16) / 2,
            slot.bottom().saturating_sub(theme::SPIRIT_LABEL_Y_INSET) / 2,
            slot.width,
            Line::styled(
                name,
                Style::default()
                    .fg(mapped(theme::TEXT, color_mode))
                    .add_modifier(Modifier::BOLD),
            ),
        );
    }
    let caption = table
        .board()
        .iter()
        .rev()
        .map(|entry| view::sanitize_external(&entry.name))
        .collect::<Vec<_>>()
        .join(" · ");
    render_line(
        frame,
        area,
        layout.floor.x,
        layout.floor.bottom().saturating_sub(1) / 2,
        layout.floor.width,
        Line::styled(
            caption,
            Style::default().fg(mapped(theme::TEXT, color_mode)),
        ),
    );
    if let Some(agent) = selected_id.and_then(|id| table.agents().find(|agent| agent.id == id)) {
        for (row, facts) in view::inspect_facts(agent).into_iter().enumerate() {
            render_line(
                frame,
                area,
                2,
                area.height.saturating_sub(3) + row as u16,
                area.width.saturating_sub(4),
                Line::styled(
                    facts,
                    Style::default()
                        .fg(mapped(theme::TEXT, color_mode))
                        .bg(mapped(theme::PANEL2, color_mode))
                        .add_modifier(Modifier::BOLD),
                ),
            );
        }
    }
    let keys = format!("{KEY_KITCHEN} · {KEY_ESC_KITCHEN} · {KEY_QUIT}");
    let connection_width = area.width.saturating_sub(keys.chars().count() as u16 + 5);
    let connection = footer_connection(table, warning, connection_width);
    render_line(
        frame,
        area,
        2,
        area.height.saturating_sub(1),
        connection_width,
        Line::styled(
            connection,
            Style::default().fg(mapped(theme::DIM, color_mode)),
        ),
    );
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
pub(crate) mod tests;
