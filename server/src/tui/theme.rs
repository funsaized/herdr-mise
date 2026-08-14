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
            [COAT, COAT_LO, BAND, SKIN, EYE, PANTS, BOOT, PLATE, SKIN_MAD, BROW_MAD],
            [230, 187, 235, 180, 234, 59, 94, 255, 167, 52].map(Color::Indexed)
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
