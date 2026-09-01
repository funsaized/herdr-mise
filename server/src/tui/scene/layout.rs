use super::super::theme;

pub const MIN_SCENE_WIDTH: u16 = 80;
pub const MIN_SCENE_PIXEL_HEIGHT: u16 = 48;
const MIN_SCENE_CELL_HEIGHT: u16 = MIN_SCENE_PIXEL_HEIGHT / 2;
const MIN_STATION_PITCH: u16 = 4;
const MAX_STATION_PITCH: u16 = 28;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SplitOrientation {
    Horizontal,
    Vertical,
}

pub fn split_orientation(width: u16, height: u16, blocked: bool) -> Option<SplitOrientation> {
    let horizontal = width / 2 >= MIN_SCENE_WIDTH && height >= MIN_SCENE_CELL_HEIGHT;
    let vertical = width >= MIN_SCENE_WIDTH && height / 2 >= MIN_SCENE_CELL_HEIGHT;
    match (horizontal, vertical) {
        (false, false) => None,
        (true, false) => Some(SplitOrientation::Horizontal),
        (false, true) => Some(SplitOrientation::Vertical),
        (true, true) if blocked => {
            let kitchen_horizontal = u32::from(width / 2) * u32::from(height);
            let kitchen_vertical = u32::from(width) * u32::from(height / 2);
            if kitchen_vertical > kitchen_horizontal {
                Some(SplitOrientation::Vertical)
            } else {
                Some(SplitOrientation::Horizontal)
            }
        }
        (true, true) => {
            let leftover_horizontal =
                u32::from(width.saturating_sub(MIN_SCENE_WIDTH * 2)) * u32::from(height);
            let leftover_vertical =
                u32::from(width) * u32::from(height.saturating_sub(MIN_SCENE_CELL_HEIGHT * 2));
            if leftover_vertical > leftover_horizontal {
                Some(SplitOrientation::Vertical)
            } else {
                Some(SplitOrientation::Horizontal)
            }
        }
    }
}

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
    pub spirits: Vec<(PixelRect, u8)>,
}

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

pub(super) fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = FNV_OFFSET;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
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
    board_ids: &[&str],
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
    let rack_width = theme::FREEZER_RACK_WIDTH;
    let racks = [
        PixelRect {
            x: theme::FREEZER_RACK_MARGIN_X,
            y: theme::FREEZER_RACK_MARGIN_Y,
            width: rack_width,
            height: pixel_height - theme::FREEZER_RACK_VERTICAL_INSET,
        },
        PixelRect {
            x: width - rack_width - theme::FREEZER_RACK_MARGIN_X,
            y: theme::FREEZER_RACK_MARGIN_Y,
            width: rack_width,
            height: pixel_height - theme::FREEZER_RACK_VERTICAL_INSET,
        },
    ];
    let door = PixelRect {
        x: width / 2 - theme::FREEZER_DOOR_HALF,
        y: theme::FREEZER_DOOR_Y,
        width: theme::FREEZER_DOOR_WIDTH,
        height: theme::FREEZER_DOOR_HEIGHT,
    };
    let frost = vec![
        PixelRect {
            x: theme::FREEZER_FROST_MARGIN,
            y: theme::FREEZER_FROST_MARGIN,
            width: width - theme::FREEZER_FROST_MARGIN * 2,
            height: theme::FREEZER_FROST_TOP_HEIGHT,
        },
        PixelRect {
            x: theme::FREEZER_FROST_MARGIN,
            y: pixel_height - theme::FREEZER_FROST_BOTTOM_Y,
            width: width - theme::FREEZER_FROST_MARGIN * 2,
            height: theme::FREEZER_FROST_BOTTOM_HEIGHT,
        },
        PixelRect {
            x: door.x - theme::FREEZER_FROST_DOOR_PAD,
            y: door.bottom() - theme::FREEZER_FROST_DOOR_PAD,
            width: door.width + theme::FREEZER_FROST_DOOR_PAD * 2,
            height: theme::FREEZER_FROST_DOOR_HEIGHT,
        },
    ];
    let floor = PixelRect {
        x: racks[0].right() + theme::FREEZER_FLOOR_GAP,
        y: door.bottom() + theme::FREEZER_FLOOR_GAP,
        width: racks[1].x - racks[0].right() - theme::FREEZER_FLOOR_WIDTH_GAP,
        height: pixel_height.saturating_sub(door.bottom() + theme::FREEZER_FLOOR_BOTTOM_INSET),
    };
    let spirit_w = super::sprites::SPRITE_WIDTH as u16;
    let spirit_h = super::sprites::SPRITE_HALF_ROWS as u16;
    let mut spirits = Vec::with_capacity(board_ids.len());
    for id in board_ids {
        let hash = fnv1a(id.as_bytes());
        let pose = (hash % 3) as u8;
        let width = spirit_w.min(floor.width).max(1);
        let height = spirit_h.min(floor.height).max(1);
        let max_dx = u64::from(floor.width.saturating_sub(width).saturating_add(1).max(1));
        let max_dy = u64::from(floor.height.saturating_sub(height).saturating_add(1).max(1));
        spirits.push((
            PixelRect {
                x: floor.x + ((hash >> 2) % max_dx) as u16,
                y: floor.y + ((hash >> 33) % max_dy) as u16,
                width,
                height,
            },
            pose,
        ));
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
    fn split_prefers_leftover_space_unless_blocked_needs_more_kitchen() {
        assert_eq!(
            split_orientation(161, 49, false),
            Some(SplitOrientation::Vertical)
        );
        assert_eq!(
            split_orientation(161, 49, true),
            Some(SplitOrientation::Horizontal)
        );
        assert_eq!(split_orientation(80, 24, false), None);
    }

    #[test]
    fn freezer_slots_are_deterministic_bounded_and_preserve_board_order() {
        let owned = (0..8).map(|index| format!("p-{index}")).collect::<Vec<_>>();
        let ids = owned.iter().map(String::as_str).collect::<Vec<_>>();
        let layout = compute_freezer_layout(80, 48, &ids).unwrap();
        assert_eq!(layout.spirits.len(), ids.len());
        for (slot, pose) in &layout.spirits {
            assert!(slot.x >= layout.floor.x && slot.right() <= layout.floor.right());
            assert!(slot.y >= layout.floor.y && slot.bottom() <= layout.floor.bottom());
            assert!(*pose < 3);
        }
        assert_eq!(layout, compute_freezer_layout(80, 48, &ids).unwrap());
        assert_eq!(
            layout.spirits[0],
            compute_freezer_layout(80, 48, &["p-0"]).unwrap().spirits[0]
        );
        let reversed_ids = ids.iter().rev().copied().collect::<Vec<_>>();
        let mut reversed_spirits = layout.spirits.clone();
        reversed_spirits.reverse();
        assert_eq!(
            compute_freezer_layout(80, 48, &reversed_ids)
                .unwrap()
                .spirits,
            reversed_spirits
        );

        let wide_owned = (0..12)
            .map(|index| format!("p-{index}"))
            .collect::<Vec<_>>();
        let wide_ids = wide_owned.iter().map(String::as_str).collect::<Vec<_>>();
        let wide = compute_freezer_layout(110, 80, &wide_ids).unwrap();
        assert_eq!(wide.spirits.len(), wide_ids.len());
        for (slot, _) in &wide.spirits {
            assert!(slot.x >= wide.floor.x && slot.right() <= wide.floor.right());
            assert!(slot.y >= wide.floor.y && slot.bottom() <= wide.floor.bottom());
        }
        assert_eq!(wide, compute_freezer_layout(110, 80, &wide_ids).unwrap());
    }
}
