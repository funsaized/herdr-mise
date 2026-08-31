pub const MIN_SCENE_WIDTH: u16 = 80;
pub const MIN_SCENE_PIXEL_HEIGHT: u16 = 48;
const MIN_STATION_PITCH: u16 = 4;
const MAX_STATION_PITCH: u16 = 28;

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FreezerLayout {
    pub room: PixelRect,
    pub door: PixelRect,
    pub racks: [PixelRect; 2],
    pub frost: Vec<PixelRect>,
    pub floor: PixelRect,
    pub spirits: Vec<(String, PixelRect)>,
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
        y: 8,
        width: width.saturating_sub(32),
        height: 2,
    };
    let board_width = 26.min(width.saturating_sub(4));
    let board = PixelRect {
        x: width - board_width - 2,
        y: 6,
        width: board_width,
        height: 14,
    };

    let mut stations = Vec::new();
    if agent_count > 0 {
        let columns = agent_count.min(3);
        let rows = agent_count.div_ceil(columns);
        let grid_x = 2_u16;
        let grid_y = 20_u16;
        let grid_width = width - 4;
        let grid_height = pixel_height.saturating_sub(grid_y + 4);
        let Ok(rows_u16) = u16::try_from(rows) else {
            return LayoutDecision::Fallback;
        };
        let station_height = (grid_height / rows_u16).min(MAX_STATION_PITCH);
        if station_height < MIN_STATION_PITCH {
            return LayoutDecision::Fallback;
        }
        stations.reserve(agent_count);
        let station_width = grid_width / columns as u16;
        for index in 0..agent_count {
            let row = index / columns;
            let column = index % columns;
            stations.push(PixelRect {
                x: grid_x + column as u16 * station_width,
                y: grid_y + row as u16 * station_height,
                width: station_width.saturating_sub(1).max(1),
                height: station_height
                    .saturating_sub(u16::from(rows > 1) * 2)
                    .max(2),
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

pub fn compute_freezer_layout(
    width: u16,
    pixel_height: u16,
    board_ids: &[String],
) -> Option<FreezerLayout> {
    if width < MIN_SCENE_WIDTH || pixel_height < MIN_SCENE_PIXEL_HEIGHT {
        return None;
    }
    let room = PixelRect {
        x: 0,
        y: 0,
        width,
        height: pixel_height,
    };
    let rack_width = 12;
    let racks = [
        PixelRect {
            x: 3,
            y: 8,
            width: rack_width,
            height: pixel_height - 16,
        },
        PixelRect {
            x: width - rack_width - 3,
            y: 8,
            width: rack_width,
            height: pixel_height - 16,
        },
    ];
    let door = PixelRect {
        x: width / 2 - 9,
        y: 4,
        width: 18,
        height: 12,
    };
    let frost = vec![
        PixelRect {
            x: 2,
            y: 2,
            width: width - 4,
            height: 2,
        },
        PixelRect {
            x: 2,
            y: pixel_height - 8,
            width: width - 4,
            height: 3,
        },
        PixelRect {
            x: door.x - 2,
            y: door.bottom() - 2,
            width: door.width + 4,
            height: 3,
        },
    ];
    let floor = PixelRect {
        x: racks[0].right() + 2,
        y: door.bottom() + 2,
        width: racks[1].x - racks[0].right() - 4,
        height: pixel_height.saturating_sub(door.bottom() + 9),
    };
    let slot_width = 13_u16;
    let slot_height = 22_u16;
    let columns = usize::from(floor.width / slot_width);
    let rows = usize::from(floor.height / slot_height);
    let capacity = columns.saturating_mul(rows);
    let visible = &board_ids[board_ids.len().saturating_sub(capacity)..];
    let used_columns = columns.min(visible.len().max(1));
    let mut spirits = Vec::with_capacity(visible.len());
    for (index, id) in visible.iter().enumerate() {
        let row = index / used_columns;
        let count = used_columns.min(visible.len() - row * used_columns);
        let column = index % used_columns;
        let row_width = u16::try_from(count).ok()?.saturating_mul(slot_width);
        let rect = PixelRect {
            x: floor.x
                + floor.width.saturating_sub(row_width) / 2
                + u16::try_from(column).ok()?.saturating_mul(slot_width),
            y: floor.y + u16::try_from(row).ok()?.saturating_mul(slot_height),
            width: slot_width,
            height: slot_height,
        };
        spirits.push((id.clone(), rect));
    }
    Some(FreezerLayout {
        room,
        door,
        racks,
        frost,
        floor,
        spirits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exhaustive_terminal_layout_is_bounded_or_explicit_fallback() {
        for terminal_width in 40..=300 {
            for terminal_height in 10..=80 {
                for agents in 0..=80 {
                    let pixel_height = terminal_height * 2;
                    match compute_layout(terminal_width, pixel_height, agents) {
                        LayoutDecision::Fallback => {
                            if terminal_width >= MIN_SCENE_WIDTH
                                && pixel_height >= MIN_SCENE_PIXEL_HEIGHT
                                && agents > 0
                            {
                                let columns = agents.min(3);
                                let rows = agents.div_ceil(columns);
                                let grid_height = pixel_height.saturating_sub(24);
                                assert!(
                                    rows > usize::from(u16::MAX)
                                        || grid_height / (rows as u16) < MIN_STATION_PITCH
                                );
                            } else {
                                assert!(
                                    terminal_width < MIN_SCENE_WIDTH
                                        || pixel_height < MIN_SCENE_PIXEL_HEIGHT
                                );
                            }
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

    #[test]
    fn responsive_contract_has_three_across_and_six_as_three_by_two() {
        let LayoutDecision::Scene(minimum) = compute_layout(80, 48, 3) else {
            panic!()
        };
        assert_eq!(minimum.stations.len(), 3);
        assert!(minimum.stations.iter().all(|station| station.y == 20));
        assert!(minimum.stations.iter().all(|station| station.height >= 24));

        let LayoutDecision::Scene(full) = compute_layout(110, 80, 6) else {
            panic!()
        };
        assert_eq!(
            full.stations
                .iter()
                .map(|station| station.y)
                .collect::<Vec<_>>(),
            [20, 20, 20, 48, 48, 48]
        );
        assert!(full.stations.iter().all(|station| station.width >= 34));
        assert!(full.stations.iter().all(|station| station.height >= 26));
    }

    #[test]
    fn first_unusable_dense_rows_fall_back() {
        assert!(matches!(
            compute_layout(80, 48, 18),
            LayoutDecision::Scene(_)
        ));
        assert_eq!(compute_layout(80, 48, 19), LayoutDecision::Fallback);
        assert!(matches!(
            compute_layout(110, 80, 42),
            LayoutDecision::Scene(_)
        ));
        assert_eq!(compute_layout(110, 80, 43), LayoutDecision::Fallback);
        assert_eq!(
            compute_layout(300, 160, usize::MAX),
            LayoutDecision::Fallback
        );
    }

    #[test]
    fn freezer_slots_are_deterministic_bounded_and_newest_first_when_truncated() {
        let ids = (0..8).map(|index| format!("p-{index}")).collect::<Vec<_>>();
        let layout = compute_freezer_layout(80, 48, &ids).unwrap();
        let visible = layout
            .spirits
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(visible, ["p-5", "p-6", "p-7"]);
        for (index, (_, slot)) in layout.spirits.iter().enumerate() {
            assert!(slot.x >= layout.floor.x && slot.right() <= layout.floor.right());
            assert!(slot.y >= layout.floor.y && slot.bottom() <= layout.floor.bottom());
            assert!(!slot.intersects(layout.door));
            assert!(layout.racks.iter().all(|rack| !slot.intersects(*rack)));
            assert!(layout.frost.iter().all(|frost| !slot.intersects(*frost)));
            assert!(layout.spirits[index + 1..]
                .iter()
                .all(|(_, other)| !slot.intersects(*other)));
        }
        assert_eq!(layout, compute_freezer_layout(80, 48, &ids).unwrap());
    }
}
