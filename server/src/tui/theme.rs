use ratatui::style::Color;

use crate::protocol::AgentState;

pub const ACCENTS: [Color; 12] = [
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
pub const CHALK: Color = Color::Rgb(0xe9, 0xe4, 0xd0);
pub const CHALKBOARD: Color = Color::Rgb(0x24, 0x35, 0x29);
pub const WALL: Color = Color::Rgb(0x37, 0x32, 0x2d);
pub const TILE: Color = Color::Rgb(0x49, 0x43, 0x3b);
pub const FLOOR: Color = Color::Rgb(0x1d, 0x20, 0x22);
pub const FLOOR_SEAM: Color = Color::Rgb(0x2b, 0x30, 0x31);
pub const STEEL: Color = Color::Rgb(0x70, 0x78, 0x78);
pub const STEEL_DARK: Color = Color::Rgb(0x3d, 0x45, 0x46);
pub const BRASS: Color = Color::Rgb(0xc5, 0x96, 0x45);
pub const COAT: Color = Color::Rgb(0xe4, 0xdf, 0xd2);
pub const SKIN: Color = Color::Rgb(0xc7, 0x91, 0x68);
pub const INK: Color = Color::Rgb(0x18, 0x1b, 0x1c);
pub const STEAM: [Color; 2] = [Color::Rgb(0xd6, 0xdd, 0xda), Color::Rgb(0x8d, 0x99, 0x96)];

pub fn accent(index: u8) -> Color {
    ACCENTS[usize::from(index) % ACCENTS.len()]
}

pub fn state_color(state: &AgentState) -> Color {
    match state {
        AgentState::Idle | AgentState::Ended => Color::Rgb(0x8a, 0x82, 0x72),
        AgentState::Working => Color::Rgb(0xf0, 0x88, 0x2a),
        AgentState::Blocked => Color::Rgb(0xd8, 0x34, 0x2c),
        AgentState::Done => Color::Rgb(0x4f, 0x9d, 0x5d),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accents_are_exact_client_tokens_and_wrap_safely() {
        assert_eq!(
            ACCENTS,
            [
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
            ]
        );
        assert_eq!(accent(0), ACCENTS[0]);
        assert_eq!(accent(11), ACCENTS[11]);
        assert_eq!(accent(12), ACCENTS[0]);
        assert_eq!(accent(u8::MAX), ACCENTS[3]);
    }

    #[test]
    fn semantic_states_use_established_tokens() {
        assert_eq!(state_color(&AgentState::Idle), Color::Rgb(0x8a, 0x82, 0x72));
        assert_eq!(
            state_color(&AgentState::Working),
            Color::Rgb(0xf0, 0x88, 0x2a)
        );
        assert_eq!(
            state_color(&AgentState::Blocked),
            Color::Rgb(0xd8, 0x34, 0x2c)
        );
        assert_eq!(state_color(&AgentState::Done), Color::Rgb(0x4f, 0x9d, 0x5d));
        assert_eq!(
            state_color(&AgentState::Ended),
            Color::Rgb(0x8a, 0x82, 0x72)
        );
    }

    #[test]
    fn board_colors_are_exact_client_tokens() {
        assert_eq!(CHALK, Color::Rgb(0xe9, 0xe4, 0xd0));
        assert_eq!(CHALKBOARD, Color::Rgb(0x24, 0x35, 0x29));
    }
}
