pub const MIN_SCENE_WIDTH: u16 = 80;
pub const MIN_SCENE_PIXEL_HEIGHT: u16 = 48;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PixelRect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl PixelRect {
    pub const fn right(self) -> u16 {
        self.x + self.width
    }

    pub const fn bottom(self) -> u16 {
        self.y + self.height
    }

    pub const fn intersects(self, other: Self) -> bool {
        self.x < other.right()
            && other.x < self.right()
            && self.y < other.bottom()
            && other.y < self.bottom()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SceneLayout {
    pub room: PixelRect,
    pub pass: PixelRect,
    pub board: PixelRect,
    pub stations: Vec<PixelRect>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LayoutDecision {
    Scene(SceneLayout),
    Fallback,
}

pub fn compute_layout(width: u16, pixel_height: u16, agent_count: usize) -> LayoutDecision {
    if width < MIN_SCENE_WIDTH || pixel_height < MIN_SCENE_PIXEL_HEIGHT {
        return LayoutDecision::Fallback;
    }

    let room = PixelRect {
        x: 0,
        y: 0,
        width,
        height: pixel_height,
    };
    let pass = PixelRect {
        x: 2,
        y: 14,
        width: width - 4,
        height: 6,
    };
    let board_width = width.clamp(80, 120) / 4;
    let board = PixelRect {
        x: width - board_width - 2,
        y: 2,
        width: board_width,
        height: 10,
    };

    let mut stations = Vec::with_capacity(agent_count);
    if agent_count > 0 {
        let columns = match agent_count {
            1..=3 => agent_count,
            4..=6 => 3,
            7..=12 => 4,
            13..=15 => 5,
            16..=18 => 6,
            _ => 7,
        };
        let rows = agent_count.div_ceil(columns);
        let grid_x = 2_u16;
        let grid_y = 22_u16;
        let grid_width = width - 4;
        let grid_height = pixel_height - grid_y - 4;
        let station_width = grid_width / columns as u16;
        let station_height = grid_height / rows as u16;
        for index in 0..agent_count {
            let row = index / columns;
            let column = index % columns;
            stations.push(PixelRect {
                x: grid_x + column as u16 * station_width,
                y: grid_y + row as u16 * station_height,
                width: station_width,
                height: station_height,
            });
        }
    }

    LayoutDecision::Scene(SceneLayout {
        room,
        pass,
        board,
        stations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exhaustive_terminal_layout_is_bounded_or_explicit_fallback() {
        for terminal_width in 40..=300 {
            for terminal_height in 10..=80 {
                for agents in 0..=20 {
                    let pixel_height = terminal_height * 2;
                    match compute_layout(terminal_width, pixel_height, agents) {
                        LayoutDecision::Fallback => {
                            assert!(terminal_width < 80 || terminal_height < 24);
                        }
                        LayoutDecision::Scene(layout) => {
                            assert!(terminal_width >= 80 && terminal_height >= 24);
                            assert_eq!(layout.stations.len(), agents);
                            for (index, station) in layout.stations.iter().enumerate() {
                                assert!(station.right() <= terminal_width);
                                assert!(station.bottom() <= pixel_height);
                                for other in &layout.stations[index + 1..] {
                                    assert!(!station.intersects(*other));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn sufficient_empty_pane_is_a_truthful_scene_shell() {
        let LayoutDecision::Scene(layout) = compute_layout(80, 48, 0) else {
            panic!("80x24 empty panes must render the waiting scene")
        };
        assert!(layout.stations.is_empty());
    }
}
