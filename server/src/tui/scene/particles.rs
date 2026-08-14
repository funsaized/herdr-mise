pub const STEAM_POOL_SIZE: usize = 4;
pub const STEAM_LIFE_TICKS: u64 = 8;
pub const SPAWN_EVERY_TICKS: u64 = 2;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Particle {
    pub active: bool,
    pub x: i16,
    pub y: i16,
    pub age_ticks: u8,
    pub shade: u8,
}

/// Reconstructs the four deterministic handoff slots at a given tick.
pub fn steam_at_tick(tick: u64, origin_x: i16, origin_y: i16) -> [Particle; STEAM_POOL_SIZE] {
    std::array::from_fn(|slot| {
        let phase_tick = tick.wrapping_add(slot as u64 * SPAWN_EVERY_TICKS);
        let age = phase_tick % STEAM_LIFE_TICKS;
        let base_x = origin_x + ((slot * 3 + (phase_tick / STEAM_LIFE_TICKS) as usize) % 3) as i16;
        Particle {
            active: true,
            x: base_x + i16::from(age > 4),
            y: origin_y - age as i16,
            age_ticks: age as u8,
            shade: u8::from(age >= 4),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_four_slot_pool_spawns_every_two_ticks_and_lives_eight() {
        assert_eq!(STEAM_POOL_SIZE, 4);
        assert_eq!(SPAWN_EVERY_TICKS, 2);
        assert_eq!(STEAM_LIFE_TICKS, 8);
        assert_eq!(
            steam_at_tick(0, 10, 20).map(|particle| particle.age_ticks),
            [0, 2, 4, 6]
        );
        assert_eq!(
            steam_at_tick(2, 10, 20).map(|particle| particle.age_ticks),
            [2, 4, 6, 0]
        );
    }

    #[test]
    fn particles_rise_each_tick_and_drift_only_after_age_four() {
        let age_four = steam_at_tick(4, 10, 20)[0];
        let age_five = steam_at_tick(5, 10, 20)[0];
        assert_eq!(age_four.y - age_five.y, 1);
        assert_eq!(age_five.x - age_four.x, 1);
        assert_eq!(age_four.shade, 1);
        assert_eq!(steam_at_tick(42, 10, 20), steam_at_tick(42, 10, 20));
    }
}
