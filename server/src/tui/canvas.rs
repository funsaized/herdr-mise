use ratatui::{buffer::Buffer, layout::Rect, style::Color, widgets::Widget};

const ANSI_COLORS: [(u8, u8, u8); 16] = [
    (0, 0, 0),
    (128, 0, 0),
    (0, 128, 0),
    (128, 128, 0),
    (0, 0, 128),
    (128, 0, 128),
    (0, 128, 128),
    (192, 192, 192),
    (128, 128, 128),
    (255, 0, 0),
    (0, 255, 0),
    (255, 255, 0),
    (0, 0, 255),
    (255, 0, 255),
    (0, 255, 255),
    (255, 255, 255),
];

pub fn rgb_to_xterm256(red: u8, green: u8, blue: u8) -> u8 {
    let mut nearest = 0;
    let mut nearest_distance = u32::MAX;
    for index in 0..=u8::MAX {
        let (palette_red, palette_green, palette_blue) = xterm_rgb(index);
        let red_delta = i32::from(red) - i32::from(palette_red);
        let green_delta = i32::from(green) - i32::from(palette_green);
        let blue_delta = i32::from(blue) - i32::from(palette_blue);
        let distance =
            (red_delta * red_delta + green_delta * green_delta + blue_delta * blue_delta) as u32;
        if distance < nearest_distance {
            nearest = index;
            nearest_distance = distance;
        }
    }
    nearest
}

fn xterm_rgb(index: u8) -> (u8, u8, u8) {
    match index {
        0..=15 => ANSI_COLORS[usize::from(index)],
        16..=231 => {
            let cube = index - 16;
            let level = |component: u8| {
                if component == 0 {
                    0
                } else {
                    55 + component * 40
                }
            };
            (level(cube / 36), level((cube % 36) / 6), level(cube % 6))
        }
        232..=255 => {
            let level = 8 + (index - 232) * 10;
            (level, level, level)
        }
    }
}

fn color_rgb(color: Color) -> (u8, u8, u8) {
    match color {
        Color::Reset | Color::Black => ANSI_COLORS[0],
        Color::Red => ANSI_COLORS[1],
        Color::Green => ANSI_COLORS[2],
        Color::Yellow => ANSI_COLORS[3],
        Color::Blue => ANSI_COLORS[4],
        Color::Magenta => ANSI_COLORS[5],
        Color::Cyan => ANSI_COLORS[6],
        Color::Gray => ANSI_COLORS[7],
        Color::DarkGray => ANSI_COLORS[8],
        Color::LightRed => ANSI_COLORS[9],
        Color::LightGreen => ANSI_COLORS[10],
        Color::LightYellow => ANSI_COLORS[11],
        Color::LightBlue => ANSI_COLORS[12],
        Color::LightMagenta => ANSI_COLORS[13],
        Color::LightCyan => ANSI_COLORS[14],
        Color::White => ANSI_COLORS[15],
        Color::Rgb(red, green, blue) => (red, green, blue),
        Color::Indexed(index) => xterm_rgb(index),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ColorMode {
    Truecolor,
    Xterm256,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PixelCanvas {
    width: u16,
    pixel_height: u16,
    clear_color: (u8, u8, u8),
    color_mode: ColorMode,
    pixels: Vec<(u8, u8, u8)>,
}

impl PixelCanvas {
    /// Creates a canvas with dimensions measured in pixels, not terminal cells.
    ///
    /// A zero width or height is valid. The pixel count is checked before allocation;
    /// with `u16` dimensions it fits every platform supported by ratatui.
    pub fn new(width: u16, pixel_height: u16, clear_color: Color, color_mode: ColorMode) -> Self {
        let len = usize::from(width)
            .checked_mul(usize::from(pixel_height))
            .expect("u16 canvas dimensions always fit in usize");
        let clear_color = color_rgb(clear_color);
        Self {
            width,
            pixel_height,
            clear_color,
            color_mode,
            pixels: vec![clear_color; len],
        }
    }

    pub const fn size_pixels(&self) -> (u16, u16) {
        (self.width, self.pixel_height)
    }

    pub const fn size_cells(&self) -> (u16, u16) {
        (self.width, self.pixel_height / 2 + self.pixel_height % 2)
    }

    pub fn put(&mut self, x: i32, y: i32, color: Color) {
        let (Ok(x), Ok(y)) = (u16::try_from(x), u16::try_from(y)) else {
            return;
        };
        if x >= self.width || y >= self.pixel_height {
            return;
        }
        let index = usize::from(y) * usize::from(self.width) + usize::from(x);
        self.pixels[index] = color_rgb(color);
    }

    pub fn clear(&mut self, color: Color) {
        self.pixels.fill(color_rgb(color));
    }

    pub fn fill_rect(&mut self, x: i32, y: i32, width: i32, height: i32, color: Color) {
        if width <= 0 || height <= 0 {
            return;
        }
        let left = i64::from(x).clamp(0, i64::from(self.width));
        let top = i64::from(y).clamp(0, i64::from(self.pixel_height));
        let right = (i64::from(x) + i64::from(width)).clamp(0, i64::from(self.width));
        let bottom = (i64::from(y) + i64::from(height)).clamp(0, i64::from(self.pixel_height));
        for pixel_y in top..bottom {
            for pixel_x in left..right {
                self.put(pixel_x as i32, pixel_y as i32, color);
            }
        }
    }

    pub fn render(&self, area: Rect, buffer: &mut Buffer) {
        let width = self.width.min(area.width);
        let cell_height = self.pixel_height / 2 + self.pixel_height % 2;
        let height = cell_height.min(area.height);
        for cell_y in 0..height {
            for x in 0..width {
                let target_x = area.x.saturating_add(x);
                let target_y = area.y.saturating_add(cell_y);
                let Some(cell) = buffer.cell_mut((target_x, target_y)) else {
                    continue;
                };
                let top_y = cell_y * 2;
                let top =
                    self.pixels[usize::from(top_y) * usize::from(self.width) + usize::from(x)];
                let bottom = if top_y + 1 < self.pixel_height {
                    self.pixels[usize::from(top_y + 1) * usize::from(self.width) + usize::from(x)]
                } else {
                    self.clear_color
                };
                cell.reset();
                cell.set_symbol("▀")
                    .set_fg(self.map_color(top))
                    .set_bg(self.map_color(bottom));
            }
        }
    }

    fn map_color(&self, (red, green, blue): (u8, u8, u8)) -> Color {
        match self.color_mode {
            ColorMode::Truecolor => Color::Rgb(red, green, blue),
            ColorMode::Xterm256 => Color::Indexed(rgb_to_xterm256(red, green, blue)),
        }
    }
}

impl Widget for &PixelCanvas {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        PixelCanvas::render(self, area, buffer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{
        buffer::Buffer,
        layout::Rect,
        style::{Color, Modifier},
    };

    #[test]
    fn pixel_to_cell_maps_top_and_bottom_to_foreground_and_background() {
        let mut canvas = PixelCanvas::new(2, 2, Color::Black, ColorMode::Truecolor);
        canvas.put(0, 0, Color::Rgb(1, 2, 3));
        canvas.put(0, 1, Color::Rgb(4, 5, 6));
        canvas.put(1, 0, Color::Rgb(7, 8, 9));

        let mut buffer = Buffer::empty(Rect::new(0, 0, 2, 1));
        canvas.render(Rect::new(0, 0, 2, 1), &mut buffer);

        let left = buffer.cell((0, 0)).unwrap();
        assert_eq!(left.symbol(), "▀");
        assert_eq!(left.fg, Color::Rgb(1, 2, 3));
        assert_eq!(left.bg, Color::Rgb(4, 5, 6));
        let right = buffer.cell((1, 0)).unwrap();
        assert_eq!(right.symbol(), "▀");
        assert_eq!(right.fg, Color::Rgb(7, 8, 9));
        assert_eq!(right.bg, Color::Rgb(0, 0, 0));
    }

    #[test]
    fn fill_rect_clips_negative_partial_and_fully_outside_rectangles() {
        let mut canvas = PixelCanvas::new(3, 4, Color::Black, ColorMode::Truecolor);
        canvas.fill_rect(-1, -1, 3, 3, Color::Red);
        canvas.fill_rect(2, 3, 3, 3, Color::Blue);
        canvas.fill_rect(-5, 1, 2, 2, Color::Green);

        let mut buffer = Buffer::empty(Rect::new(0, 0, 3, 2));
        canvas.render(Rect::new(0, 0, 3, 2), &mut buffer);

        assert_eq!(buffer.cell((0, 0)).unwrap().fg, Color::Rgb(128, 0, 0));
        assert_eq!(buffer.cell((0, 0)).unwrap().bg, Color::Rgb(128, 0, 0));
        assert_eq!(buffer.cell((1, 0)).unwrap().fg, Color::Rgb(128, 0, 0));
        assert_eq!(buffer.cell((1, 0)).unwrap().bg, Color::Rgb(128, 0, 0));
        assert_eq!(buffer.cell((2, 0)).unwrap().fg, Color::Rgb(0, 0, 0));
        assert_eq!(buffer.cell((2, 1)).unwrap().fg, Color::Rgb(0, 0, 0));
        assert_eq!(buffer.cell((2, 1)).unwrap().bg, Color::Rgb(0, 0, 128));
    }

    #[test]
    fn odd_pixel_height_pairs_final_top_with_configured_clear_color() {
        let mut canvas = PixelCanvas::new(1, 3, Color::Rgb(9, 8, 7), ColorMode::Truecolor);
        canvas.clear(Color::Rgb(2, 3, 4));
        canvas.put(0, 2, Color::Rgb(5, 6, 7));

        let mut buffer = Buffer::empty(Rect::new(0, 0, 1, 2));
        canvas.render(Rect::new(0, 0, 1, 2), &mut buffer);

        assert_eq!(buffer.cell((0, 0)).unwrap().fg, Color::Rgb(2, 3, 4));
        assert_eq!(buffer.cell((0, 0)).unwrap().bg, Color::Rgb(2, 3, 4));
        assert_eq!(buffer.cell((0, 1)).unwrap().fg, Color::Rgb(5, 6, 7));
        assert_eq!(buffer.cell((0, 1)).unwrap().bg, Color::Rgb(9, 8, 7));
    }

    #[test]
    fn color_modes_emit_truecolor_and_nearest_xterm_palette_with_stable_ties() {
        assert_eq!(rgb_to_xterm256(0, 0, 0), 0);
        assert_eq!(rgb_to_xterm256(255, 255, 255), 15);
        assert_eq!(rgb_to_xterm256(95, 95, 95), 59);
        assert_eq!(rgb_to_xterm256(95, 135, 175), 67);
        assert_eq!(rgb_to_xterm256(8, 8, 8), 232);
        // (4, 4, 4) is equally distant from palette entries 0 and 232.
        assert_eq!(rgb_to_xterm256(4, 4, 4), 0);

        let mut truecolor = PixelCanvas::new(1, 1, Color::Black, ColorMode::Truecolor);
        truecolor.put(0, 0, Color::Rgb(12, 34, 56));
        let mut truecolor_buffer = Buffer::empty(Rect::new(0, 0, 1, 1));
        truecolor.render(Rect::new(0, 0, 1, 1), &mut truecolor_buffer);
        assert_eq!(
            truecolor_buffer.cell((0, 0)).unwrap().fg,
            Color::Rgb(12, 34, 56)
        );
        assert_eq!(
            truecolor_buffer.cell((0, 0)).unwrap().bg,
            Color::Rgb(0, 0, 0)
        );

        let mut indexed = PixelCanvas::new(1, 2, Color::Black, ColorMode::Xterm256);
        indexed.put(0, 0, Color::Rgb(95, 95, 95));
        indexed.put(0, 1, Color::Rgb(8, 8, 8));
        let mut indexed_buffer = Buffer::empty(Rect::new(0, 0, 1, 1));
        indexed.render(Rect::new(0, 0, 1, 1), &mut indexed_buffer);
        assert_eq!(indexed_buffer.cell((0, 0)).unwrap().fg, Color::Indexed(59));
        assert_eq!(indexed_buffer.cell((0, 0)).unwrap().bg, Color::Indexed(232));
    }

    #[test]
    fn every_refined_theme_token_round_trips_to_its_exact_xterm_index() {
        use crate::tui::theme;

        let tokens = [
            (theme::BG, 233),
            (theme::PANEL, 234),
            (theme::PANEL2, 235),
            (theme::FRAME, 242),
            (theme::FRAME_HI, 248),
            (theme::TEXT, 230),
            (theme::DIM, 246),
            (theme::STEEL, 245),
            (theme::STEEL_LO, 240),
            (theme::COAT_LO, 187),
            (theme::SKIN, 180),
            (theme::PANTS, 59),
            (theme::BOOT, 94),
            (theme::PLATE, 255),
            (theme::SKIN_MAD, 167),
            (theme::BROW_MAD, 52),
            (theme::FIRE, 208),
            (theme::FIRE_HI, 220),
            (theme::RED, 160),
            (theme::RED_HI, 203),
            (theme::RED_DIM, 88),
            (theme::GREEN, 71),
            (theme::GREEN_HI, 114),
            (theme::BOARD, 22),
            (theme::BRASS, 136),
            (theme::POT, 238),
            (theme::STEAM, 247),
            (theme::STEAM_HI, 253),
        ]
        .into_iter()
        .chain(
            theme::ACCENTS
                .into_iter()
                .zip([66, 96, 67, 101, 138, 137, 66, 101, 103, 101, 96, 66]),
        )
        .chain(
            theme::ACCENT_DIMS
                .into_iter()
                .zip([23, 53, 24, 58, 95, 94, 23, 58, 60, 58, 53, 23]),
        )
        .collect::<Vec<_>>();
        let mut canvas = PixelCanvas::new(tokens.len() as u16, 2, theme::BG, ColorMode::Xterm256);
        for (x, (color, _)) in tokens.iter().enumerate() {
            canvas.put(x as i32, 0, *color);
        }
        let mut buffer = Buffer::empty(Rect::new(0, 0, tokens.len() as u16, 1));
        canvas.render(buffer.area, &mut buffer);
        for (x, (_, expected)) in tokens.iter().enumerate() {
            assert_eq!(
                buffer.cell((x as u16, 0)).unwrap().fg,
                Color::Indexed(*expected)
            );
        }
    }

    #[test]
    fn render_clips_to_area_and_is_idempotent() {
        let mut canvas = PixelCanvas::new(3, 4, Color::Rgb(1, 1, 1), ColorMode::Truecolor);
        canvas.put(0, 0, Color::Rgb(2, 2, 2));
        let mut buffer = Buffer::filled(Rect::new(0, 0, 4, 3), ratatui::buffer::Cell::new("x"));
        buffer
            .cell_mut((2, 1))
            .unwrap()
            .set_style(ratatui::style::Style::default().add_modifier(Modifier::BOLD));

        canvas.render(Rect::new(2, 1, 1, 1), &mut buffer);
        let once = buffer.clone();
        canvas.render(Rect::new(2, 1, 1, 1), &mut buffer);

        assert_eq!(buffer, once);
        assert_eq!(buffer.cell((2, 1)).unwrap().symbol(), "▀");
        assert!(buffer.cell((2, 1)).unwrap().modifier.is_empty());
        assert_eq!(buffer.cell((1, 1)).unwrap().symbol(), "x");
        assert_eq!(buffer.cell((3, 1)).unwrap().symbol(), "x");
        assert_eq!(buffer.cell((2, 0)).unwrap().symbol(), "x");
        assert_eq!(buffer.cell((2, 2)).unwrap().symbol(), "x");
    }

    #[test]
    fn empty_dimensions_are_safe_and_deliberate() {
        let mut zero_width = PixelCanvas::new(0, 3, Color::Black, ColorMode::Truecolor);
        zero_width.put(0, 0, Color::Red);
        zero_width.fill_rect(i32::MIN, i32::MIN, i32::MAX, i32::MAX, Color::Red);
        assert_eq!(zero_width.size_pixels(), (0, 3));
        assert_eq!(zero_width.size_cells(), (0, 2));
        let maximum_odd_height = PixelCanvas::new(0, u16::MAX, Color::Black, ColorMode::Truecolor);
        assert_eq!(maximum_odd_height.size_cells(), (0, 32_768));

        let zero_height = PixelCanvas::new(3, 0, Color::Black, ColorMode::Truecolor);
        let mut buffer = Buffer::filled(Rect::new(0, 0, 2, 2), ratatui::buffer::Cell::new("x"));
        zero_width.render(Rect::new(0, 0, 2, 2), &mut buffer);
        zero_height.render(Rect::new(0, 0, 2, 2), &mut buffer);
        assert!(buffer.content.iter().all(|cell| cell.symbol() == "x"));
    }
}
