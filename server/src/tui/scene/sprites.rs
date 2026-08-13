use crate::protocol::AgentState;

pub const SPRITE_WIDTH: usize = 11;
pub const SPRITE_HALF_ROWS: usize = 14;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Sprite {
    pub rows: &'static [&'static str],
}

impl Sprite {
    pub fn width(self) -> usize {
        self.rows.first().map_or(0, |row| row.len())
    }

    pub fn height(self) -> usize {
        self.rows.len()
    }
}

pub const PREP_A: &[&str] = &[
    "..HHHHHHH..",
    "..HhHhHhH..",
    "...ooooo...",
    "..oSSSSSo..",
    "...SeSeS...",
    "...SSSSS...",
    "..CaaaaaC..",
    ".CCCCCCCCC.",
    ".KCAAAAACC.",
    "...AAAAACK.",
    "...AAAAA.kk",
    "...D...D...",
    "...D...D...",
    "..BB...BB..",
];
pub const PREP_B: &[&str] = &[
    "..HHHHHHH..",
    "..HhHhHhH..",
    "...ooooo...",
    "..oSSSSS.K.",
    "...SeSeS.kk",
    "...SSSSS.C.",
    "..CaaaaaCC.",
    ".CCCCCCCC..",
    ".KCAAAAAC..",
    "...AAAAA...",
    "...AAAAA...",
    "...D...D...",
    "...D...D...",
    "..BB...BB..",
];
pub const WORK: &[&str] = &[
    "..HHHHHHH..",
    "..HhHhHhH..",
    "...ooooo...",
    "..oSSSSSo..",
    "...SeSeS...",
    "...SSSSS...",
    "..CaaaaaC..",
    ".CCCCCCCCC.",
    ".CCAAAAACC.",
    ".KCAAAAACK.",
    "...AAAAA...",
    "...D...D...",
    "...D...D...",
    "..BB...BB..",
];
pub const PLATED: &[&str] = &[
    ".....WWGWWW",
    "..HHHHH.K..",
    "..HhHhH.C..",
    "...ooo..C..",
    "..SSSSS.C..",
    "..SeSeS.C..",
    "..SSSSS.C..",
    ".CaaaaaCC..",
    "CCCCCCCC...",
    "KCAAAAAC...",
    "..AAAAA....",
    "..D...D....",
    "..D...D....",
    ".BB...BB...",
];
pub const BLOCKED: &[&str] = &[
    "...HHHHH...",
    ".K.HhHhH.K.",
    ".K..ooo..K.",
    ".C.RRRRR.C.",
    ".C.RbRbR.C.",
    ".C.ReReR.C.",
    ".CCRRRRRCC.",
    "..CaaaaaC..",
    "..CCCCCCC..",
    "..CAAAAAC..",
    "...AAAAA...",
    "...D...D...",
    "...D...D...",
    "..BB...BB..",
];
const ENDED: &[&str] = &[];

pub fn cook_sprite(state: &AgentState, tick: u64) -> Sprite {
    let rows = match state {
        AgentState::Idle if (tick / 4).is_multiple_of(2) => PREP_B,
        AgentState::Idle => PREP_A,
        AgentState::Working => WORK,
        AgentState::Blocked => BLOCKED,
        AgentState::Done => PLATED,
        AgentState::Ended => ENDED,
    };
    Sprite { rows }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_grids_are_exact_handoff_dimensions_with_shared_baseline() {
        for rows in [PREP_A, PREP_B, WORK, BLOCKED, PLATED] {
            assert_eq!(rows.len(), SPRITE_HALF_ROWS);
            assert!(rows.iter().all(|row| row.len() == SPRITE_WIDTH));
            assert!(rows[12].contains('D'));
            assert!(rows[13].contains('B'));
        }
        assert_eq!(BLOCKED[4], ".C.RbRbR.C.");
        assert_eq!(BLOCKED[5], ".C.ReReR.C.");
        assert_eq!(PLATED[0], ".....WWGWWW");
        assert_ne!(PLATED, WORK);
    }

    #[test]
    fn idle_swaps_only_at_four_tick_boundaries_and_other_poses_are_static() {
        assert_eq!(cook_sprite(&AgentState::Idle, 0).rows, PREP_B);
        assert_eq!(cook_sprite(&AgentState::Idle, 3).rows, PREP_B);
        assert_eq!(cook_sprite(&AgentState::Idle, 4).rows, PREP_A);
        assert_eq!(cook_sprite(&AgentState::Idle, 7).rows, PREP_A);
        assert_eq!(cook_sprite(&AgentState::Idle, 8).rows, PREP_B);
        for state in [AgentState::Working, AgentState::Blocked, AgentState::Done] {
            assert_eq!(cook_sprite(&state, 0), cook_sprite(&state, 999));
        }
    }

    #[test]
    fn ended_has_no_active_cook_sprite() {
        assert!(cook_sprite(&AgentState::Ended, 0).rows.is_empty());
    }
}
