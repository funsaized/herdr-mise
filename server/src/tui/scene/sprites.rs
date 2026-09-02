use crate::protocol::AgentState;
use crate::tui::theme;

pub const SPRITE_WIDTH: usize = 11;
pub const SPRITE_HALF_ROWS: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Sprite {
    pub rows: &'static [&'static str],
}

impl Sprite {
    pub fn width(self) -> usize {
        self.rows.first().map_or(0, |row| row.len())
    }
}

pub const PREP_A: &[&str] = &[
    "...HHHHH...",
    "..HHhHhHH..",
    ".HHHHHHHHH.",
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
    "...HHHHH...",
    "..HHhHhHH..",
    ".HHHHHHHHH.",
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
    "...HHHHH...",
    "..HHhHhHH..",
    ".HHHHHHHHH.",
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
pub const SLEEP_A: &[&str] = &[
    "...HHHHH...",
    "..HHhHhHH..",
    ".HHHHHHHHH.",
    "..HhHhHhH..",
    "...ooooo...",
    "..oSSSSSo..",
    "...SeeeS.Z.",
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
pub const SLEEP_B: &[&str] = &[
    "...HHHHH...",
    "..HHhHhHH..",
    ".HHHHHHHHH.",
    "..HhHhHhH..",
    "...ooooo...",
    "..oSSSSSo.Z",
    "...SeeeSz..",
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
    "...HHHHH...",
    "..HHhHhHH..",
    ".HHHHHHHHH.",
    "..HhHhHhH..",
    "...ooooo...",
    ".oSSSSSo...",
    "..SeSeS....",
    "..SSSSS....",
    ".CaaaaaCC..",
    "CCCCCCCC...",
    "CCCCKWWGWWW",
    "KCAAAAAC...",
    "..AAAAA....",
    "..D...D....",
    "..D...D....",
    ".BB...BB...",
];
pub const BLOCKED: &[&str] = &[
    "...HHHHH...",
    "..HHhHhHH..",
    ".HHHHHHHHH.",
    "..HhHhHhH..",
    ".K.ooooo.K.",
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
pub const SPIRIT_A: &[&str] = &[
    "...HHHHH...",
    "..HHhHhHH..",
    ".HHHHHHHHH.",
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
pub const SPIRIT_B: &[&str] = SPIRIT_A;
pub const SPIRIT_C: &[&str] = SPIRIT_A;
const SPIRIT_POSES: [&[&str]; 3] = [SPIRIT_A, SPIRIT_B, SPIRIT_C];

pub fn spirit_sprite(pose: u8) -> Sprite {
    Sprite {
        rows: SPIRIT_POSES[usize::from(pose) % SPIRIT_POSES.len()],
    }
}

pub fn cook_sprite(state: &AgentState, tick: u64) -> Sprite {
    let rows = match state {
        AgentState::Idle if (tick / theme::IDLE_FRAME_TICKS).is_multiple_of(2) => SLEEP_B,
        AgentState::Idle => SLEEP_A,
        AgentState::Working if (tick / theme::WORKING_FRAME_TICKS).is_multiple_of(2) => PREP_B,
        AgentState::Working => PREP_A,
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
        for rows in [PREP_A, PREP_B, WORK, SLEEP_A, SLEEP_B, BLOCKED, PLATED] {
            assert_eq!(rows.len(), SPRITE_HALF_ROWS);
            assert!(rows.iter().all(|row| row.len() == SPRITE_WIDTH));
            assert!(rows[14].contains('D'));
            assert!(rows[15].contains('B'));
        }
        assert_eq!(BLOCKED[6], ".C.RbRbR.C.");
        assert_eq!(BLOCKED[7], ".C.ReReR.C.");
        assert_ne!(PLATED, WORK);
    }

    #[test]
    fn hats_have_a_narrow_puff_over_a_shared_wider_brim() {
        for rows in [PREP_A, PREP_B, WORK, SLEEP_A, SLEEP_B, BLOCKED, PLATED] {
            let coat_width =
                |row: &str| row.bytes().filter(|key| matches!(key, b'H' | b'h')).count();
            assert_eq!(&rows[..4], &PREP_A[..4]);
            assert!(coat_width(rows[0]) < coat_width(rows[2]));
            assert_eq!(rows[4].bytes().filter(|key| *key == b'o').count(), 5);
        }
        assert_eq!(&PREP_A[..5], &PREP_B[..5]);
        assert!(PLATED[..5].iter().all(|row| !row.contains(['W', 'G'])));
        assert!(PLATED[10].contains("WWGWWW"));
    }

    #[test]
    fn idle_sleeps_slowly_and_working_chops_at_four_tick_boundaries() {
        assert_eq!(cook_sprite(&AgentState::Idle, 0).rows, SLEEP_B);
        assert_eq!(cook_sprite(&AgentState::Idle, 15).rows, SLEEP_B);
        assert_eq!(cook_sprite(&AgentState::Idle, 16).rows, SLEEP_A);
        assert_eq!(cook_sprite(&AgentState::Idle, 32).rows, SLEEP_B);
        assert!(SLEEP_A[6].contains("eee"));
        assert!(SLEEP_A.iter().any(|row| row.contains('Z')));
        assert_ne!(SLEEP_A, SLEEP_B);
        assert_eq!(cook_sprite(&AgentState::Working, 0).rows, PREP_B);
        assert_eq!(cook_sprite(&AgentState::Working, 3).rows, PREP_B);
        assert_eq!(cook_sprite(&AgentState::Working, 4).rows, PREP_A);
        assert_eq!(cook_sprite(&AgentState::Working, 7).rows, PREP_A);
        assert_eq!(cook_sprite(&AgentState::Working, 8).rows, PREP_B);
        for state in [AgentState::Blocked, AgentState::Done] {
            assert_eq!(cook_sprite(&state, 0), cook_sprite(&state, 999));
        }
    }

    #[test]
    fn ended_has_no_active_cook_sprite() {
        assert!(cook_sprite(&AgentState::Ended, 0).rows.is_empty());
        for rows in [SPIRIT_A, SPIRIT_B, SPIRIT_C] {
            assert_eq!(rows.len(), SPRITE_HALF_ROWS);
            assert!(rows.iter().all(|row| row.len() == SPRITE_WIDTH));
        }
        assert_eq!(
            SPIRIT_A
                .iter()
                .map(|row| row.matches('e').count())
                .sum::<usize>(),
            2
        );
        assert_eq!(spirit_sprite(0).rows, SPIRIT_A);
        assert_eq!(spirit_sprite(1).rows, SPIRIT_B);
        assert_eq!(spirit_sprite(3).rows, SPIRIT_A);
    }
}
