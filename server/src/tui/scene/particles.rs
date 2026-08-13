pub const STEAM_POOL_SIZE: usize = 32;
const STEAM_LIFE_TICKS: u64 = 8;
const SPAWN_EVERY_TICKS: u64 = 2;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Particle {
    pub active: bool,
    pub x: i16,
    pub y: i16,
    pub age_ticks: u8,
    pub shade: u8,
}

/// Reconstructs the fixed pool at an explicit tick. This is equivalent to
/// stepping a retained pool, but keeps the renderer pure and replayable.
pub fn steam_at_tick(
    tick: u64,
    agent_index: usize,
    origin_x: i16,
    origin_y: i16,
) -> [Particle; STEAM_POOL_SIZE] {
    let mut particles = [Particle::default(); STEAM_POOL_SIZE];
    for age in 0..STEAM_LIFE_TICKS {
        let Some(spawn_tick) = tick.checked_sub(age) else {
            continue;
        };
        if spawn_tick % SPAWN_EVERY_TICKS != 0 {
            continue;
        }
        let slot = (agent_index * 7 + (spawn_tick / SPAWN_EVERY_TICKS) as usize) % STEAM_POOL_SIZE;
        let drift = ((agent_index * 3 + spawn_tick as usize) % 3) as i16 - 1;
        particles[slot] = Particle {
            active: true,
            x: origin_x + drift * age as i16,
            y: origin_y - age as i16,
            age_ticks: age as u8,
            shade: u8::from(age >= STEAM_LIFE_TICKS / 2),
        };
    }
    particles
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steam_is_a_fixed_deterministic_index_seeded_pool() {
        let first = steam_at_tick(42, 3, 20, 18);
        let second = steam_at_tick(42, 3, 20, 18);
        assert_eq!(first, second);
        assert_eq!(first.len(), STEAM_POOL_SIZE);
        assert!(first.iter().any(|particle| particle.active));
        assert_ne!(first, steam_at_tick(42, 4, 20, 18));
    }

    #[test]
    fn steam_advances_only_from_explicit_tick() {
        let before = steam_at_tick(20, 0, 10, 10);
        let after = steam_at_tick(21, 0, 10, 10);
        assert_ne!(before, after);
        assert_eq!(before, steam_at_tick(20, 0, 10, 10));
    }
}
