use crate::protocol::{AgentRecord, AgentState, SessionStats};
use chrono::{DateTime, Duration, SecondsFormat, Utc};

struct DemoIdentity {
    name: &'static str,
    model: &'static str,
    workspace: &'static str,
}
const ROSTER: [DemoIdentity; 6] = [
    DemoIdentity {
        name: "Codex",
        model: "gpt-5.3-codex",
        workspace: "/demo/checkout-api",
    },
    DemoIdentity {
        name: "Claude",
        model: "claude-sonnet-4",
        workspace: "/demo/payments",
    },
    DemoIdentity {
        name: "Hermes",
        model: "hermes-4",
        workspace: "/demo/order-routing",
    },
    DemoIdentity {
        name: "OpenClaw",
        model: "openclaw-2",
        workspace: "/demo/kitchen-ui",
    },
    DemoIdentity {
        name: "Gemini",
        model: "gemini-2.5-pro",
        workspace: "/demo/inventory",
    },
    DemoIdentity {
        name: "Aider",
        model: "deepseek-v3",
        workspace: "/demo/receipts",
    },
];

pub fn agents(step: u64, started_at: DateTime<Utc>) -> Vec<AgentRecord> {
    let count = std::env::var("HERDR_MISE_DEMO_COUNT")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(ROSTER.len())
        .clamp(1, 12);
    (0..count)
        .map(|index| record(index, step, started_at))
        .collect()
}

fn record(index: usize, step: u64, started_at: DateTime<Utc>) -> AgentRecord {
    let identity = ROSTER.get(index);
    let name = identity
        .map(|identity| identity.name.to_owned())
        .unwrap_or_else(|| format!("Agent {}", index + 1));
    let (state, entered_step, generation) = schedule(index, step);
    let observed_step = step / 5 * 5;
    let progress = match state {
        AgentState::Working | AgentState::Done => {
            Some(((observed_step * 7 + index as u64 * 13) % 101) as f64 / 100.0)
        }
        _ => None,
    };
    AgentRecord {
        state_known: None,
        id: if index == 4 {
            format!("demo-{index}-session-{generation}")
        } else {
            format!("demo-{index}")
        },
        name,
        state,
        progress,
        state_entered_at: (started_at + Duration::seconds(entered_step))
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        accent_index: index as u8,
        model: identity
            .map(|value| value.model)
            .unwrap_or("simulated")
            .to_owned(),
        workspace: identity
            .map(|value| value.workspace)
            .unwrap_or("/demo/overflow")
            .to_owned(),
        session: SessionStats {
            tickets_available: Some(true),
            runtime_ms: observed_step * 1_000,
            tickets: observed_step / 60,
        },
    }
}

fn schedule(index: usize, step: u64) -> (AgentState, i64, u64) {
    if index == 0 {
        let generation = step / 180;
        let phase = step % 180;
        let cycle_start = (generation * 180) as i64;
        return match phase {
            0..=29 => (AgentState::Working, cycle_start, generation),
            30..=59 => (AgentState::Blocked, cycle_start + 30, generation),
            60..=119 => (AgentState::Working, cycle_start + 60, generation),
            120..=179 => (AgentState::Done, cycle_start + 120, generation),
            _ => unreachable!(),
        };
    }
    if index == 1 {
        // Claude remains blocked long enough to exercise both escalation thresholds.
        return (AgentState::Blocked, 0, 0);
    }
    if index == 4 {
        let generation = step / 300;
        let phase = step % 300;
        let cycle_start = (generation * 300) as i64;
        return match phase {
            0..=29 => (AgentState::Idle, cycle_start, generation),
            30..=269 => (AgentState::Working, cycle_start + 30, generation),
            270..=298 => (AgentState::Done, cycle_start + 270, generation),
            _ => (AgentState::Ended, cycle_start + 299, generation),
        };
    }
    let offset = (index as u64 * 37) % 180;
    let phase = (step + offset) % 180;
    let cycle_start = step as i64 - phase as i64;
    let (state, entered) = match phase {
        0..=29 => (AgentState::Idle, cycle_start - 30),
        30..=119 => (AgentState::Working, cycle_start + 30),
        120..=149 => (AgentState::Done, cycle_start + 120),
        _ => (AgentState::Idle, cycle_start + 150),
    };
    (state, entered, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn start() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 7, 31, 12, 0, 0).unwrap()
    }

    #[test]
    fn deterministic_roster_has_stable_state_timestamps() {
        let a = agents(4, start());
        let b = agents(4, start());
        assert_eq!(a, b);
        assert_eq!(a.len(), 6);
        assert_eq!(a[1].state, AgentState::Blocked);
        assert_eq!(a[1].state_entered_at, "2026-07-31T12:00:00.000Z");
        assert_eq!(
            agents(5, start())[1].state_entered_at,
            a[1].state_entered_at
        );
    }

    #[test]
    fn codex_repeats_the_answered_lifecycle_with_a_stable_identity() {
        let phases = [0, 30, 60, 120, 180].map(|step| {
            let hero = &agents(step, start())[0];
            (
                hero.id.clone(),
                hero.state.clone(),
                hero.state_entered_at.clone(),
            )
        });
        assert_eq!(
            phases.clone().map(|(_, state, _)| state),
            [
                AgentState::Working,
                AgentState::Blocked,
                AgentState::Working,
                AgentState::Done,
                AgentState::Working,
            ]
        );
        assert!(phases.iter().all(|(id, _, _)| id == "demo-0"));
        assert_eq!(phases[1].2, "2026-07-31T12:00:30.000Z");
        assert_eq!(phases[2].2, "2026-07-31T12:01:00.000Z");
    }

    #[test]
    fn roster_exposes_real_agent_and_workspace_identities() {
        let roster = agents(0, start());
        let names = roster
            .iter()
            .map(|agent| agent.name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"Codex"));
        assert!(names.contains(&"Claude"));
        assert!(names.contains(&"Hermes"));
        assert!(names.contains(&"OpenClaw"));
        assert!(roster.iter().all(|agent| agent.model != "simulated"));
        assert!(roster.iter().all(|agent| agent.workspace != "example"));
    }

    #[test]
    fn service_stays_mixed_and_shared_across_the_full_cycle() {
        for step in 0..900 {
            let roster = agents(step, start());
            let represented = [
                AgentState::Idle,
                AgentState::Working,
                AgentState::Blocked,
                AgentState::Done,
            ]
            .iter()
            .filter(|state| roster.iter().any(|agent| agent.state == **state))
            .count();
            assert!(represented >= 3, "step {step}");
            assert!(
                [
                    AgentState::Idle,
                    AgentState::Working,
                    AgentState::Blocked,
                    AgentState::Done
                ]
                .iter()
                .any(|state| roster
                    .iter()
                    .filter(|agent| agent.state == *state)
                    .count()
                    >= 2),
                "step {step}"
            );
            assert_eq!(roster[1].state, AgentState::Blocked);
        }
    }

    #[test]
    fn no_more_than_two_agents_change_state_per_step_across_the_full_cycle() {
        for step in 1..=900 {
            let before = agents(step - 1, start());
            let after = agents(step, start());
            let changed = before
                .iter()
                .zip(&after)
                .filter(|(a, b)| a.state != b.state)
                .count();
            assert!(changed <= 2, "step {step}: {changed} agents changed state");
        }
    }

    #[test]
    fn nearby_steps_are_calm_and_boundaries_are_intentional() {
        let before = agents(89, start());
        let nearby = agents(90, start());
        assert_eq!(
            before
                .iter()
                .map(|a| (&a.id, &a.state, &a.state_entered_at))
                .collect::<Vec<_>>(),
            nearby
                .iter()
                .map(|a| (&a.id, &a.state, &a.state_entered_at))
                .collect::<Vec<_>>()
        );
        assert_eq!(agents(269, start())[4].state, AgentState::Working);
        assert_eq!(agents(270, start())[4].state, AgentState::Done);
        assert_eq!(
            agents(270, start())[4].state_entered_at,
            "2026-07-31T12:04:30.000Z"
        );
    }

    #[test]
    fn demo_includes_sustained_blocking_and_occasional_ended_sessions() {
        assert_eq!(agents(299, start())[1].state, AgentState::Blocked);
        assert_eq!(agents(299, start())[4].state, AgentState::Ended);
        assert_eq!(agents(300, start())[4].state, AgentState::Idle);
        assert_ne!(agents(299, start())[4].id, agents(300, start())[4].id);
    }
}
