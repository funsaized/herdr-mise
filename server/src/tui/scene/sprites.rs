use crate::protocol::AgentState;

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

// Original seven-column cell art. '.' is transparent; palette keys are interpreted
// by the scene compositor so the same silhouette works in both color modes.
const IDLE_A: &[&str] = &[
    "..CCC..", ".CSSSC.", "..CAC..", ".CCACC.", "..A.A..", ".AA.AA.",
];
const IDLE_B: &[&str] = &[
    "..CCC..", ".CSSSC.", "..CAC..", "CCA.CC.", "..A.A..", ".AA.AA.",
];
const WORKING: &[&str] = &[
    "..CCC..", ".CSSSC.", ".ACACA.", "..AAA..", ".AA.AA.", "..FFF..",
];
const BLOCKED: &[&str] = &[
    ".RRRRR.", "R.CCC.R", "R.CSS.R", "R.AAA.R", "R.A.A.R", ".RRRRR.",
];
const DONE: &[&str] = &[
    "..CCC..", ".CSSSC.", "..AAA..", ".A...A.", "..PPP..", ".GGGGG.",
];
const ENDED: &[&str] = &[];

pub fn cook_sprite(state: &AgentState, tick: u64) -> Sprite {
    let rows = match state {
        AgentState::Idle if tick % 2 == 0 => IDLE_A,
        AgentState::Idle => IDLE_B,
        AgentState::Working => WORKING,
        AgentState::Blocked => BLOCKED,
        AgentState::Done => DONE,
        AgentState::Ended => ENDED,
    };
    Sprite { rows }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_state_art_is_original_distinct_and_four_to_six_pixels_high() {
        let idle = cook_sprite(&AgentState::Idle, 0);
        let working = cook_sprite(&AgentState::Working, 0);
        let blocked = cook_sprite(&AgentState::Blocked, 0);
        let done = cook_sprite(&AgentState::Done, 0);
        for sprite in [idle, working, blocked, done] {
            assert!((4..=6).contains(&sprite.height()));
            assert_eq!(sprite.width(), 7);
        }
        assert_ne!(idle.rows, working.rows);
        assert_ne!(working.rows, blocked.rows);
        assert_ne!(blocked.rows, done.rows);
        assert_ne!(
            cook_sprite(&AgentState::Idle, 0).rows,
            cook_sprite(&AgentState::Idle, 1).rows
        );
    }

    #[test]
    fn ended_has_no_active_cook_sprite() {
        assert!(cook_sprite(&AgentState::Ended, 0).rows.is_empty());
    }
}
