use ratatui::style::Color;

use crate::protocol::AgentState;

// Refined TUI handoff palette. Keeping the source tokens indexed means the
// scene never depends on truecolor support.
pub const BG: Color = Color::Indexed(233);
pub const PANEL: Color = Color::Indexed(234);
pub const PANEL2: Color = Color::Indexed(235);
pub const FRAME: Color = Color::Indexed(242);
pub const FRAME_HI: Color = Color::Indexed(248);
pub const TEXT: Color = Color::Indexed(230);
pub const DIM: Color = Color::Indexed(246);
pub const STEEL: Color = Color::Indexed(245);
pub const STEEL_LO: Color = Color::Indexed(240);

pub const COAT: Color = Color::Indexed(230);
pub const COAT_LO: Color = Color::Indexed(187);
pub const ICE: Color = Color::Indexed(159);
pub const ICE_LO: Color = Color::Indexed(24);
pub const BAND: Color = Color::Indexed(235);
pub const SKIN: Color = Color::Indexed(180);
pub const EYE: Color = Color::Indexed(234);
pub const PANTS: Color = Color::Indexed(59);
pub const BOOT: Color = Color::Indexed(94);
pub const PLATE: Color = Color::Indexed(255);
pub const SKIN_MAD: Color = Color::Indexed(167);
pub const BROW_MAD: Color = Color::Indexed(52);

pub const FIRE: Color = Color::Indexed(208);
pub const FIRE_HI: Color = Color::Indexed(220);
pub const RED: Color = Color::Indexed(160);
pub const RED_HI: Color = Color::Indexed(203);
pub const RED_DIM: Color = Color::Indexed(88);
pub const GREEN: Color = Color::Indexed(71);
pub const GREEN_HI: Color = Color::Indexed(114);
pub const BOARD: Color = Color::Indexed(22);
pub const BRASS: Color = Color::Indexed(136);
pub const CHALK: Color = Color::Indexed(187);
pub const BOARD_FACT_WIDTH: usize = 7;
pub const BOARD_FACTS_WIDTH: usize = 16;
pub const POT: Color = Color::Indexed(238);
pub const POT_HI: Color = Color::Indexed(245);
pub const STEAM: Color = Color::Indexed(247);
pub const STEAM_HI: Color = Color::Indexed(253);

pub const ACCENTS: [Color; 6] = [
    Color::Indexed(66),
    Color::Indexed(96),
    Color::Indexed(67),
    Color::Indexed(101),
    Color::Indexed(131),
    Color::Indexed(137),
];
pub const ACCENT_DIMS: [Color; 6] = [
    Color::Indexed(23),
    Color::Indexed(53),
    Color::Indexed(24),
    Color::Indexed(58),
    Color::Indexed(95),
    Color::Indexed(94),
];
pub const SPIRIT: Color = ACCENTS[4];
pub const SPIRIT_DIM: Color = ACCENT_DIMS[4];

pub const FREEZER_SHELL_INSET: i32 = 2;
pub const FREEZER_BIN_FRACTION: u16 = 3;
pub const SPIRIT_LABEL_CHARS: usize = 11;
pub const SPIRIT_LABEL_Y_INSET: u16 = 2;
pub const FREEZER_RACK_WIDTH: u16 = 12;
pub const FREEZER_RACK_MARGIN_X: u16 = 3;
pub const FREEZER_RACK_MARGIN_Y: u16 = 8;
pub const FREEZER_RACK_VERTICAL_INSET: u16 = 16;
pub const FREEZER_DOOR_HALF: u16 = 9;
pub const FREEZER_DOOR_Y: u16 = 4;
pub const FREEZER_DOOR_WIDTH: u16 = 18;
pub const FREEZER_DOOR_HEIGHT: u16 = 12;
pub const FREEZER_FROST_MARGIN: u16 = 2;
pub const FREEZER_FROST_TOP_HEIGHT: u16 = 2;
pub const FREEZER_FROST_BOTTOM_Y: u16 = 8;
pub const FREEZER_FROST_BOTTOM_HEIGHT: u16 = 3;
pub const FREEZER_FROST_DOOR_PAD: u16 = 2;
pub const FREEZER_FROST_DOOR_HEIGHT: u16 = 3;
pub const FREEZER_FLOOR_GAP: u16 = 2;
pub const FREEZER_FLOOR_WIDTH_GAP: u16 = 4;
pub const FREEZER_FLOOR_BOTTOM_INSET: u16 = 9;
pub const FREEZER_TILE: u16 = 4;
pub const FREEZER_SHELF_DIVISIONS: u16 = 4;
pub const FREEZER_SHELF_THICKNESS: u16 = 2;
pub const FREEZER_BIN_X_INSET: u16 = 2;
pub const FREEZER_BIN_Y_LIFT: u16 = 4;
pub const FREEZER_BIN_HEIGHT: u16 = 3;
pub const FREEZER_PLATE_Y_LIFT: u16 = 7;
pub const FREEZER_PLATE_HEIGHT: u16 = 2;
pub const FREEZER_DOOR_FRAME: u16 = 2;
pub const FREEZER_HANDLE_WIDTH: u16 = 3;
pub const FREEZER_HANDLE_HEIGHT: u16 = 2;
pub const FREEZER_HINGE_HEIGHT: u16 = 2;
pub const FREEZER_RIVET_STEP: u16 = 8;
pub const SNOW_SLOT_PHASE: u64 = 5;
pub const SNOW_SLOT_X: u64 = 11;
pub const SNOW_PHASE_X_DIV: u64 = 4;
pub const SNOW_SLOT_Y: u64 = 3;
pub const PARTICLE_SHADE_AGE: u64 = 4;
pub const TICKET_MIN_STATION_WIDTH: u16 = 24;
pub const WORKING_SHIFT: u16 = 3;
pub const SPRITE_Y_PAD: u16 = 4;
pub const TICKET_X_INSET: i32 = 2;
pub const TICKET_Y_INSET: i32 = 3;
pub const TICKET_WIDTH: i32 = 4;
pub const TICKET_HEIGHT: i32 = 6;
pub const POT_X_OFFSET: i32 = 13;
pub const POT_Y_OFFSET: i32 = 9;
pub const POT_WIDTH: i32 = 5;
pub const POT_BODY_ROWS: i32 = 2;
pub const POT_SPOUT_X: i32 = 5;
pub const POT_SPOUT_Y: i32 = 1;
pub const FIRE_Y: i32 = 3;
pub const FIRE_LEFT_X: i32 = 1;
pub const FIRE_RIGHT_X: i32 = 3;
pub const TICKET_PIN_Y: i32 = -1;
pub const TICKET_PIN_START: i32 = 1;
pub const TICKET_PIN_END: i32 = 2;
pub const TICKET_MARK_W: i32 = 3;
pub const TICKET_MARK_Y1: i32 = 1;
pub const TICKET_MARK_Y2: i32 = 3;
pub const TICKET_MARK_Y3: i32 = 5;
pub const TICKET_MARK3_W: i32 = 2;
pub const SNOWMAN_STACK_X: i32 = 1;
pub const SNOWMAN_EYE_X: i32 = 2;
pub const SNOWMAN_EYE_Y: i32 = 1;
pub const GRAVE_BODY_Y: i32 = 1;
pub const GRAVE_CAP_X: i32 = 1;
pub const SNOWMAN_X_INSET: u16 = 3;
pub const SNOWMAN_Y_INSET: u16 = 8;
pub const SNOWMAN_BASE_W: i32 = 5;
pub const SNOWMAN_BASE_H: i32 = 3;
pub const SNOWMAN_MID_W: i32 = 3;
pub const SNOWMAN_MID_H: i32 = 3;
pub const SNOWMAN_HEAD_W: i32 = 3;
pub const SNOWMAN_HEAD_H: i32 = 2;
pub const GRAVE_X_INSET: u16 = 8;
pub const GRAVE_Y_INSET: u16 = 7;
pub const GRAVE_W: i32 = 5;
pub const GRAVE_H: i32 = 5;
pub const GRAVE_CAP_W: i32 = 3;
pub const GRAVE_CAP_H: i32 = 2;
pub const ICICLE_MARGIN: u16 = 4;
pub const ICICLE_STEP: usize = 7;
pub const ICICLE_Y: i32 = 3;
pub const ICICLE_BASE_H: u16 = 2;
pub const ICICLE_H_MOD: u16 = 3;
pub const PUDDLE_NEAR_X: u16 = 6;
pub const PUDDLE_NEAR_Y: u16 = 2;
pub const PUDDLE_NEAR_W: i32 = 8;
pub const PUDDLE_NEAR_H: i32 = 2;
pub const PUDDLE_FAR_X: u16 = 20;
pub const PUDDLE_FAR_Y: u16 = 1;
pub const PUDDLE_FAR_W: i32 = 6;
pub const PUDDLE_FAR_H: i32 = 1;

pub const COMPACT_ACCENTS: [Color; 12] = [
    Color::Rgb(0x5b, 0x8a, 0x8f),
    Color::Rgb(0x8a, 0x6a, 0x92),
    Color::Rgb(0x66, 0x7a, 0x9e),
    Color::Rgb(0x8a, 0x8a, 0x4f),
    Color::Rgb(0xb0, 0x7a, 0x7a),
    Color::Rgb(0xa9, 0x8a, 0x5b),
    Color::Rgb(0x6f, 0x9a, 0x8d),
    Color::Rgb(0x99, 0x7f, 0x5e),
    Color::Rgb(0x7a, 0x7f, 0x9e),
    Color::Rgb(0x8f, 0x9a, 0x6f),
    Color::Rgb(0x9a, 0x6f, 0x7f),
    Color::Rgb(0x6f, 0x8a, 0x9a),
];
pub const COMPACT_CHALK: Color = Color::Rgb(0xe9, 0xe4, 0xd0);
pub const COMPACT_BOARD: Color = Color::Rgb(0x24, 0x35, 0x29);

pub fn accent(index: u8) -> Color {
    ACCENTS[usize::from(index) % ACCENTS.len()]
}

pub fn accent_dim(index: u8) -> Color {
    ACCENT_DIMS[usize::from(index) % ACCENT_DIMS.len()]
}

pub fn compact_accent(index: u8) -> Color {
    COMPACT_ACCENTS[usize::from(index) % COMPACT_ACCENTS.len()]
}

pub fn compact_state_color(state: &AgentState) -> Color {
    match state {
        AgentState::Idle | AgentState::Ended => Color::Rgb(0x8a, 0x82, 0x72),
        AgentState::Working => Color::Rgb(0xf0, 0x88, 0x2a),
        AgentState::Blocked => Color::Rgb(0xd8, 0x34, 0x2c),
        AgentState::Done => Color::Rgb(0x4f, 0x9d, 0x5d),
    }
}

pub fn state_color(state: &AgentState) -> Color {
    match state {
        AgentState::Idle | AgentState::Ended => DIM,
        AgentState::Working => FIRE,
        AgentState::Blocked => RED_HI,
        AgentState::Done => GREEN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_handoff_token_is_the_exact_xterm_index() {
        assert_eq!(
            [BG, PANEL, PANEL2, FRAME, FRAME_HI, TEXT, DIM, STEEL, STEEL_LO],
            [233, 234, 235, 242, 248, 230, 246, 245, 240].map(Color::Indexed)
        );
        assert_eq!(
            [COAT, COAT_LO, ICE, ICE_LO, BAND, SKIN, EYE, PANTS, BOOT, PLATE, SKIN_MAD, BROW_MAD],
            [230, 187, 159, 24, 235, 180, 234, 59, 94, 255, 167, 52].map(Color::Indexed)
        );
        assert_eq!(
            [FIRE, FIRE_HI, RED, RED_HI, RED_DIM, GREEN, GREEN_HI, BOARD, BRASS, CHALK],
            [208, 220, 160, 203, 88, 71, 114, 22, 136, 187].map(Color::Indexed)
        );
        assert_eq!(
            [POT, POT_HI, STEAM, STEAM_HI],
            [238, 245, 247, 253].map(Color::Indexed)
        );
        assert_eq!(ACCENTS, [66, 96, 67, 101, 131, 137].map(Color::Indexed));
        assert_eq!(ACCENT_DIMS, [23, 53, 24, 58, 95, 94].map(Color::Indexed));
    }

    #[test]
    fn accent_pairs_wrap_together() {
        for index in 0..18 {
            assert_eq!(accent(index), ACCENTS[usize::from(index) % 6]);
            assert_eq!(accent_dim(index), ACCENT_DIMS[usize::from(index) % 6]);
        }
    }
}
