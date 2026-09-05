use super::*;
use crate::adapter::Normalizer;
use crate::protocol::{AgentStateEvent, AppMode, DeltaOperation, SessionStats, SourceDiagnostic};
use chrono::TimeZone;
use ratatui::{backend::TestBackend, buffer::Buffer, Terminal};

fn record(id: &str, state: AgentState) -> AgentRecord {
    AgentRecord {
        state_known: None,
        id: id.into(),
        name: format!("Cook {id}"),
        state,
        progress: Some(0.5),
        state_entered_at: "2026-08-13T12:00:00Z".into(),
        accent_index: 2,
        model: "gpt-5.6-sol".into(),
        workspace: "/work/customer-api".into(),
        session: SessionStats {
            tickets_available: None,
            runtime_ms: 61_000,
            tickets: 7,
        },
    }
}

fn live_table(agents: Vec<AgentRecord>) -> AgentTable {
    let mut table = AgentTable::default();
    table.apply(AgentStateEvent::Snapshot {
        version: 1,
        mode: AppMode::Live,
        source_status: SourceStatus::Connected,
        source_diagnostic: None,
        agents,
    });
    table
}

fn render(table: &AgentTable, width: u16, height: u16, tick: u64) -> Buffer {
    render_selected(table, width, height, tick, None)
}

fn render_selected(
    table: &AgentTable,
    width: u16,
    height: u16,
    tick: u64,
    selected_id: Option<&str>,
) -> Buffer {
    render_view(
        table,
        width,
        height,
        tick,
        selected_id,
        SceneView::Kitchen,
        false,
    )
}

fn render_view(
    table: &AgentTable,
    width: u16,
    height: u16,
    tick: u64,
    selected_id: Option<&str>,
    scene_view: SceneView,
    reduced_motion: bool,
) -> Buffer {
    render_view_with_warning(
        table,
        width,
        height,
        tick,
        selected_id,
        scene_view,
        reduced_motion,
        Some("bind warning"),
    )
}

#[allow(clippy::too_many_arguments)]
fn render_view_with_warning(
    table: &AgentTable,
    width: u16,
    height: u16,
    tick: u64,
    selected_id: Option<&str>,
    scene_view: SceneView,
    reduced_motion: bool,
    warning: Option<&str>,
) -> Buffer {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| {
            draw_view(
                frame,
                table,
                warning,
                Utc.with_ymd_and_hms(2026, 8, 13, 12, 0, 0).unwrap(),
                tick,
                ColorMode::Xterm256,
                true,
                selected_id,
                scene_view,
                false,
                reduced_motion,
            )
        })
        .unwrap();
    terminal.backend().buffer().clone()
}

pub(crate) fn render_freezer(table: &AgentTable, width: u16, height: u16) -> Buffer {
    render_view(table, width, height, 9, None, SceneView::Freezer, false)
}

pub(crate) fn text(buffer: &Buffer) -> String {
    buffer.content.iter().map(|cell| cell.symbol()).collect()
}

fn buffer_dump(buffer: &Buffer) -> String {
    let mut dump = format!("AREA {}x{}\n", buffer.area.width, buffer.area.height);
    for y in buffer.area.y..buffer.area.bottom() {
        let row = (buffer.area.x..buffer.area.right())
            .map(|x| buffer.cell((x, y)).unwrap().symbol())
            .collect::<String>();
        dump.push_str(&format!("TEXT {y:02} {row:?}\n"));
        let mut x = buffer.area.x;
        while x < buffer.area.right() {
            let cell = buffer.cell((x, y)).unwrap();
            let start = x;
            x += 1;
            while x < buffer.area.right() {
                let next = buffer.cell((x, y)).unwrap();
                if next.fg != cell.fg
                    || next.bg != cell.bg
                    || next.modifier != cell.modifier
                    || next.diff_option != cell.diff_option
                    || next.symbol() != cell.symbol()
                {
                    break;
                }
                x += 1;
            }
            dump.push_str(&format!(
                "CELL {y:02} {start:03}..{x:03} symbol={:?} fg={:?} bg={:?} mod={:?} diff={:?}\n",
                cell.symbol(),
                cell.fg,
                cell.bg,
                cell.modifier,
                cell.diff_option
            ));
        }
    }
    dump
}

fn pixel(buffer: &Buffer, x: u16, y: u16) -> Color {
    let cell = buffer.cell((x, y / 2)).unwrap();
    if y.is_multiple_of(2) {
        cell.fg
    } else {
        cell.bg
    }
}

fn snapshot(
    mode: AppMode,
    status: SourceStatus,
    diagnostic: Option<SourceDiagnostic>,
    agents: Vec<AgentRecord>,
) -> AgentTable {
    let mut table = AgentTable::default();
    table.apply(AgentStateEvent::Snapshot {
        version: 1,
        mode,
        source_status: status,
        source_diagnostic: diagnostic,
        agents,
    });
    table
}

fn golden_cases() -> Vec<(&'static str, AgentTable, u16, u16)> {
    let state = |name, state| {
        snapshot(
            AppMode::Live,
            SourceStatus::Connected,
            None,
            vec![record(name, state)],
        )
    };
    let mut ended = state("ended", AgentState::Done);
    ended.apply(AgentStateEvent::Delta {
        version: 1,
        mode: AppMode::Live,
        operation: DeltaOperation::Upsert,
        agent: Some(record("ended", AgentState::Ended)),
        agent_id: None,
    });
    vec![
        ("idle", state("idle", AgentState::Idle), 80, 24),
        ("working", state("working", AgentState::Working), 80, 24),
        ("blocked", state("blocked", AgentState::Blocked), 80, 24),
        ("done", state("done", AgentState::Done), 80, 24),
        ("ended", ended, 80, 24),
        ("demo", AgentTable::default(), 80, 24),
        ("waiting", live_table(vec![]), 80, 24),
        (
            "unsupported",
            snapshot(
                AppMode::Demo,
                SourceStatus::UnsupportedProtocol,
                Some(SourceDiagnostic {
                    observed_protocol: 23,
                    supported_protocols: vec![17, 19, 20],
                    next_action: "upgrade Herdr, then retry".into(),
                }),
                vec![],
            ),
            80,
            24,
        ),
        (
            "fallback",
            live_table(vec![record("small", AgentState::Idle)]),
            79,
            23,
        ),
    ]
}

#[test]
fn fixed_input_scene_goldens_are_stable_and_committed() {
    for (name, table, width, height) in golden_cases() {
        let actual = buffer_dump(&render(&table, width, height, 9));
        assert_eq!(actual, buffer_dump(&render(&table, width, height, 9)));
        let path = format!(
            "{}/tests/goldens/scene-{name}.txt",
            env!("CARGO_MANIFEST_DIR")
        );
        if std::env::var_os("UPDATE_SCENE_GOLDENS").is_some() {
            std::fs::write(&path, &actual).unwrap();
        }
        let expected = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("missing golden {path}: {error}"));
        assert_eq!(actual, expected, "golden mismatch: {path}");
    }
}

#[test]
fn freezer_scene_golden_keeps_locker_landmarks_and_spirits() {
    let event = serde_json::from_str::<AgentStateEvent>(include_str!(
        "../../../../protocol/fixtures/snapshot.v1.json"
    ))
    .unwrap();
    let agents = match &event {
        AgentStateEvent::Snapshot { agents, .. } => agents.clone(),
        _ => unreachable!(),
    };
    let mut table = AgentTable::default();
    table.apply(event);
    for mut agent in agents {
        agent.state = AgentState::Ended;
        table.apply(AgentStateEvent::Delta {
            version: 1,
            mode: AppMode::Live,
            operation: DeltaOperation::Upsert,
            agent: Some(agent),
            agent_id: None,
        });
    }
    for index in 0..BOARD_CAP - table.board().len() {
        table.apply(AgentStateEvent::Delta {
            version: 1,
            mode: AppMode::Live,
            operation: DeltaOperation::Upsert,
            agent: Some(record(&format!("extra-{index}"), AgentState::Ended)),
            agent_id: None,
        });
    }
    assert_eq!(table.board().len(), BOARD_CAP);
    let buffer = render_freezer(&table, 80, 24);
    let actual = buffer_dump(&buffer);
    let path = format!(
        "{}/tests/goldens/scene-freezer.txt",
        env!("CARGO_MANIFEST_DIR")
    );
    if std::env::var_os("UPDATE_SCENE_GOLDENS").is_some() {
        std::fs::write(&path, &actual).unwrap();
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("missing golden {path}: {error}"));
    assert_eq!(actual, expected);
    assert!(text(&buffer).contains("WALK-IN FREEZER"));
    assert!(text(&buffer).contains("MISE — LIVE"));
    assert!(text(&buffer).contains("86 64/64"));
    assert_eq!(
        layout::compute_freezer_layout(
            80,
            48,
            &table
                .board()
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>()
        )
        .unwrap()
        .spirits
        .len(),
        BOARD_CAP
    );

    let compact = text(&render_view(
        &table,
        79,
        23,
        9,
        None,
        SceneView::Kitchen,
        false,
    ));
    for newest in ["Cook extra-61", "Cook extra-60", "Cook extra-59"] {
        assert!(compact.contains(newest));
    }
    assert!(!compact.contains("Cook extra-58"));
    assert!(compact.contains("86 64/64"));

    let mut unsupported = AgentTable::default();
    unsupported.apply(
        serde_json::from_str(include_str!(
            "../../../../protocol/fixtures/snapshot-demo-unsupported.v1.json"
        ))
        .unwrap(),
    );
    let output = text(&render_freezer(&unsupported, 80, 24))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    for expected in [
        "MISE — DEMO SERVICE",
        "Mock feed",
        "observed 23",
        "upgrade or downgrade Herdr",
        "Nothing here",
    ] {
        assert!(
            output.contains(expected),
            "missing {expected:?} in {output:?}"
        );
    }
}

#[test]
fn snapshot_fixture_renders_two_tier_unclipped_hats() {
    let event = serde_json::from_str::<AgentStateEvent>(include_str!(
        "../../../../protocol/fixtures/snapshot.v1.json"
    ))
    .unwrap();
    let mut table = AgentTable::default();
    table.apply(event);

    let at_zero = render(&table, 80, 24, 0);
    let at_four = render(&table, 80, 24, 4);
    for sprite_x in [12, 53] {
        let coat_width = |buffer: &Buffer, y| {
            (sprite_x..sprite_x + sprites::SPRITE_WIDTH as u16)
                .filter(|x| pixel(buffer, *x, y) == theme::COAT)
                .count()
        };
        assert_eq!(coat_width(&at_zero, 24), 5);
        assert_eq!(coat_width(&at_zero, 26), 9);
    }
    for y in 24..29 {
        for x in 53..53 + sprites::SPRITE_WIDTH as u16 {
            assert_eq!(pixel(&at_zero, x, y), pixel(&at_four, x, y));
        }
    }

    let (_, done, width, height) = golden_cases()
        .into_iter()
        .find(|(name, ..)| *name == "done")
        .unwrap();
    let done = render(&done, width, height, 0);
    for y in 24..29 {
        for x in 34..34 + sprites::SPRITE_WIDTH as u16 {
            assert!(!matches!(pixel(&done, x, y), theme::PLATE | theme::GREEN));
        }
    }
}

#[test]
fn blocked_and_clear_frames_keep_neutral_outer_chrome_without_pulsing() {
    for table in [
        live_table(vec![record("idle", AgentState::Idle)]),
        live_table(vec![record("blocked", AgentState::Blocked)]),
    ] {
        let at_zero = render(&table, 80, 24, 0);
        let at_nine = render(&table, 80, 24, 9);
        for buffer in [&at_zero, &at_nine] {
            assert_eq!(buffer.cell((0, 0)).unwrap().fg, theme::FRAME);
            assert_eq!(buffer.cell((79, 23)).unwrap().fg, theme::FRAME);
        }
    }
}

#[test]
fn selected_blocked_station_keeps_alarm_chrome_and_fact_strip() {
    let table = live_table(vec![record("blocked", AgentState::Blocked)]);
    let buffer = render_selected(&table, 80, 24, 0, Some("blocked"));
    let output = text(&buffer);

    assert!(output.contains("Cook blocked · BLOCKED / AT THE PASS"));
    assert!(output.contains("‼ BLOCKED 00:00 ‼"));
    assert!(buffer
        .content
        .iter()
        .any(|cell| cell.symbol() == "╔" && cell.fg == theme::RED));
}

#[test]
fn state_specific_station_chrome_and_half_block_art_are_present() {
    let table = live_table(vec![
        record("idle", AgentState::Idle),
        record("work", AgentState::Working),
        record("blocked", AgentState::Blocked),
    ]);
    let buffer = render(&table, 80, 24, 2);
    let output = text(&buffer);
    for expected in [
        "PREP",
        "FIRE",
        "AT THE PASS",
        "‼ BLOCKED 00:00 ‼",
        "10Hz · tick 2",
        "? help",
    ] {
        assert!(output.contains(expected), "missing {expected:?}");
    }
    assert!(buffer.content.iter().any(|cell| cell.symbol() == "▀"));
    assert!(buffer
        .content
        .iter()
        .any(|cell| cell.symbol() == "╔" && cell.fg == theme::RED));
    let blocked_banner = buffer
        .content
        .iter()
        .find(|cell| cell.symbol() == "‼" && cell.bg == theme::RED_DIM)
        .expect("blocked station banner");
    assert_eq!(blocked_banner.fg, theme::TEXT);
    assert!(!blocked_banner.modifier.contains(Modifier::REVERSED));
}

#[test]
fn real_fixture_keeps_capped_tall_scene_and_state_chrome() {
    let value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/snapshot-herdr-0.8.0-p19.json"
    ))
    .unwrap();
    let normalized = Normalizer::default()
        .normalize_snapshot_value(value, "2026-08-13T12:00:00Z")
        .unwrap();
    let table = snapshot(
        AppMode::Live,
        SourceStatus::Connected,
        None,
        normalized.agents,
    );

    let LayoutDecision::Scene(compact_layout) = compute_layout(80, 48, 1) else {
        panic!()
    };
    assert!(compact_layout.stations[0].height >= 24);
    let compact = render(&table, 80, 24, 0);
    let compact_text = text(&compact);
    assert!(compact_text.contains("‼ BLOCKED"));
    assert!(compact_text.contains("AT THE PASS"));
    assert!(compact.content.iter().any(|cell| cell.symbol() == "▀"));
    assert!(compact.content.iter().any(|cell| cell.fg == theme::COAT));
    assert!(compact
        .content
        .iter()
        .any(|cell| cell.symbol() == "‼" && cell.bg == theme::RED_DIM));

    let LayoutDecision::Scene(tall_layout) = compute_layout(80, 120, 1) else {
        panic!()
    };
    assert_eq!(tall_layout.stations[0].height, 28);
    let tall = render(&table, 80, 60, 0);
    let tall_text = text(&tall);
    for expected in [
        "‼ BLOCKED",
        "AT THE PASS",
        "MISE — LIVE",
        "Connected to Herdr",
    ] {
        assert!(tall_text.contains(expected), "missing {expected:?}");
    }
    assert!(tall.content.iter().any(|cell| cell.symbol() == "▀"));
    assert!(tall.content.iter().any(|cell| cell.fg == theme::COAT));

    for (name, table, width, height) in golden_cases()
        .into_iter()
        .filter(|(name, ..)| matches!(*name, "demo" | "waiting" | "unsupported" | "fallback"))
    {
        let height = if name == "fallback" { height } else { 60 };
        let output = text(&render(&table, width, height, 0));
        let expected = match name {
            "demo" => &["MISE — DEMO SERVICE"][..],
            "waiting" => &["Waiting for agents"][..],
            "unsupported" => &["unsupported Herdr protocol", "Mock feed"][..],
            "fallback" => &["Kitchen status"][..],
            _ => unreachable!(),
        };
        for expected in expected {
            assert!(output.contains(expected), "{name} missing {expected:?}");
        }
    }
}

#[test]
fn working_flames_alternate_but_static_states_do_not() {
    let working = live_table(vec![record("work", AgentState::Working)]);
    let even = render(&working, 80, 24, 0);
    let odd = render(&working, 80, 24, 1);
    assert_eq!(even.cell((45, 18)).unwrap().fg, theme::FIRE_HI);
    assert_eq!(even.cell((47, 18)).unwrap().fg, theme::FIRE);
    assert_eq!(odd.cell((45, 18)).unwrap().fg, theme::FIRE);
    assert_eq!(odd.cell((47, 18)).unwrap().fg, theme::FIRE_HI);
    let blocked = live_table(vec![record("blocked", AgentState::Blocked)]);
    // Tick text changes, so compare the sprite's known center region only.
    let a = render(&blocked, 80, 24, 0);
    let b = render(&blocked, 80, 24, 9);
    for y in 12..19 {
        for x in 8..19 {
            assert_eq!(a.cell((x, y)), b.cell((x, y)));
        }
    }
}

#[test]
fn working_sprite_wins_ticket_overlap_at_minimum_station_width() {
    let working = live_table(
        (0..3)
            .map(|i| record(&i.to_string(), AgentState::Working))
            .collect(),
    );
    let buffer = render(&working, 80, 24, 0);
    let overlap = buffer.cell((7, 13)).unwrap();
    assert_eq!(overlap.fg, theme::COAT);
    assert_eq!(overlap.bg, theme::COAT);
}

#[test]
fn responsive_boundaries_and_compact_fallback_are_rendered() {
    let three = live_table(
        (0..3)
            .map(|i| record(&i.to_string(), AgentState::Working))
            .collect(),
    );
    let minimum = text(&render(&three, 80, 24, 0));
    assert_eq!(minimum.matches("· FIRE").count(), 3);
    let six = live_table(
        (0..6)
            .map(|i| record(&i.to_string(), AgentState::Idle))
            .collect(),
    );
    let full = text(&render(&six, 110, 40, 0));
    assert_eq!(full.matches("· PREP").count(), 6);
    let fallback = text(&render(&three, 79, 24, 0));
    assert!(fallback.contains("Kitchen status"));
    let fallback = text(&render(&three, 80, 23, 0));
    assert!(fallback.contains("Kitchen status"));
}

#[test]
fn xterm_scene_emits_only_indexed_handoff_colors_and_rendered_accent_pairs() {
    let agents = (0..6)
        .map(|index| {
            let mut agent = record(&index.to_string(), AgentState::Idle);
            agent.accent_index = index;
            agent
        })
        .collect();
    let buffer = render(&live_table(agents), 110, 40, 0);
    assert!(buffer.content.iter().all(|cell| {
        matches!(cell.fg, Color::Reset | Color::Indexed(_))
            && matches!(cell.bg, Color::Reset | Color::Indexed(_))
    }));
    let emitted = buffer
        .content
        .iter()
        .flat_map(|cell| [cell.fg, cell.bg])
        .collect::<Vec<_>>();
    for expected in theme::ACCENTS[..6].iter().chain(&theme::ACCENT_DIMS[..6]) {
        assert!(emitted.contains(expected), "missing rendered {expected:?}");
    }
    for expected in [
        theme::BG,
        theme::PANEL,
        theme::FRAME,
        theme::TEXT,
        theme::DIM,
        theme::STEEL_LO,
        theme::COAT,
        theme::COAT_LO,
        theme::SKIN,
        theme::PANTS,
        theme::BOOT,
        theme::BRASS,
        theme::BOARD,
    ] {
        assert!(emitted.contains(&expected), "missing rendered {expected:?}");
    }
}

#[test]
fn ended_moves_to_board_and_truthful_status_survives() {
    let mut table = live_table(vec![record("a", AgentState::Done)]);
    table.apply(AgentStateEvent::Delta {
        version: 1,
        mode: AppMode::Live,
        operation: DeltaOperation::Upsert,
        agent: Some(record("a", AgentState::Ended)),
        agent_id: None,
    });
    let output = text(&render(&table, 80, 24, 4));
    assert!(output.contains("86 BOARD"));
    assert!(output.contains("COOK A"));
    assert!(output.contains("Waiting for agents"));

    let fixture = serde_json::from_str::<AgentStateEvent>(include_str!(
        "../../../../protocol/fixtures/snapshot.v1.json"
    ))
    .unwrap();
    let mut fixture_agent = match &fixture {
        AgentStateEvent::Snapshot { agents, .. } => agents[0].clone(),
        _ => unreachable!(),
    };
    let mut fixture_table = AgentTable::default();
    fixture_table.apply(fixture);
    fixture_agent.state = AgentState::Ended;
    fixture_table.apply(AgentStateEvent::Delta {
        version: 1,
        mode: AppMode::Live,
        operation: DeltaOperation::Upsert,
        agent: Some(fixture_agent.clone()),
        agent_id: None,
    });
    let buffer = render(&fixture_table, 80, 24, 4);
    let rows = buffer
        .content
        .chunks(80)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>();
    assert_eq!(
        rows[4].chars().skip(54).take(22).collect::<String>(),
        "COOK         MISE TIME"
    );
    assert_eq!(
        rows[5].chars().skip(54).take(22).collect::<String>(),
        "REFACTOR-AGE     15:01"
    );

    fixture_agent.id = "zero-runtime".into();
    fixture_agent.name = "zero".into();
    fixture_agent.session.runtime_ms = 0;
    fixture_agent.session.tickets = 0;
    fixture_table.apply(AgentStateEvent::Delta {
        version: 1,
        mode: AppMode::Live,
        operation: DeltaOperation::Upsert,
        agent: Some(fixture_agent),
        agent_id: None,
    });
    let buffer = render(&fixture_table, 80, 24, 4);
    let zero_row = buffer.content.chunks(80).nth(5).unwrap();
    assert_eq!(
        zero_row
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>()
            .chars()
            .skip(54)
            .take(22)
            .collect::<String>(),
        "ZERO                 —"
    );

    let mut demo = AgentTable::default();
    demo.apply(AgentStateEvent::Snapshot {
        version: 1,
        mode: AppMode::Demo,
        source_status: SourceStatus::UnsupportedProtocol,
        source_diagnostic: Some(SourceDiagnostic {
            observed_protocol: 23,
            supported_protocols: vec![17, 19, 20],
            next_action: "upgrade Herdr, then retry".into(),
        }),
        agents: vec![],
    });
    let output = text(&render(&demo, 110, 40, 0));
    assert!(output.contains("MISE — DEMO SERVICE"));
    assert!(output.contains("Mock feed"));
    assert!(output.contains("Nothing here is real"));
}

#[test]
fn scene_strips_c0_c1_del_from_herdr_strings() {
    let mut fixture = serde_json::from_str::<AgentStateEvent>(include_str!(
        "../../../../protocol/fixtures/snapshot.v1.json"
    ))
    .unwrap();
    let tainted = "\x1b[31m\u{9b}\x7fSAFE";
    let AgentStateEvent::Snapshot {
        source_status,
        source_diagnostic,
        agents,
        ..
    } = &mut fixture
    else {
        unreachable!()
    };
    *source_status = SourceStatus::UnsupportedProtocol;
    *source_diagnostic = Some(SourceDiagnostic {
        observed_protocol: 23,
        supported_protocols: vec![20],
        next_action: tainted.into(),
    });
    agents[0].name = tainted.into();
    agents[0].model = tainted.into();
    agents[0].workspace = format!("/work/{tainted}");
    agents[0].state = AgentState::Blocked;
    let ended = agents[0].clone();
    let mut table = AgentTable::default();
    table.apply(fixture);

    let output = text(&render_selected(&table, 110, 40, 0, Some("agent-01")));
    assert!(output.contains("[31mSAFE"));
    assert!(['\x1b', '\u{9b}', '\x7f']
        .into_iter()
        .all(|character| !output.contains(character)));

    let mut ended = ended;
    ended.state = AgentState::Ended;
    table.apply(AgentStateEvent::Delta {
        version: 1,
        mode: AppMode::Live,
        operation: DeltaOperation::Upsert,
        agent: Some(ended),
        agent_id: None,
    });
    let output = text(&render(&table, 80, 24, 0));
    assert!(output.contains("[31MS"));
    assert!(['\x1b', '\u{9b}', '\x7f']
        .into_iter()
        .all(|character| !output.contains(character)));

    let output = text(&render_freezer(&table, 80, 24));
    assert!(output.contains("[31MSAFE"));
    assert!(['\x1b', '\u{9b}', '\x7f']
        .into_iter()
        .all(|character| !output.contains(character)));
}

#[test]
fn kitchen_and_freezer_stay_separate_and_respect_reduced_motion() {
    let event = serde_json::from_str::<AgentStateEvent>(include_str!(
        "../../../../protocol/fixtures/snapshot.v1.json"
    ))
    .unwrap();
    let agents = match &event {
        AgentStateEvent::Snapshot { agents, .. } => agents.clone(),
        _ => unreachable!(),
    };
    let mut table = AgentTable::default();
    table.apply(event);

    for (width, height) in [(160, 24), (80, 48)] {
        let buffer = render_view(&table, width, height, 9, None, SceneView::Kitchen, false);
        let output = text(&buffer);
        assert!(output.contains("MISE — LIVE"));
        assert!(!output.contains("WALK-IN FREEZER"));
    }

    let kitchen_zero = render_view(&table, 80, 24, 0, None, SceneView::Kitchen, true);
    let kitchen_nine = render_view(&table, 80, 24, 9, None, SceneView::Kitchen, true);
    assert_eq!(kitchen_zero, kitchen_nine);
    assert_eq!(
        render_view(&table, 79, 23, 0, None, SceneView::Kitchen, true),
        render_view(&table, 79, 23, 9, None, SceneView::Kitchen, true)
    );

    assert_ne!(
        render_view(&table, 80, 24, 0, None, SceneView::Freezer, false),
        render_view(&table, 80, 24, 9, None, SceneView::Freezer, false)
    );
    assert_eq!(
        render_view(&table, 80, 24, 0, None, SceneView::Freezer, true),
        render_view(&table, 80, 24, 9, None, SceneView::Freezer, true)
    );

    let mut blocked = agents[0].clone();
    blocked.state = AgentState::Blocked;
    let blocked = live_table(vec![blocked]);
    let output = text(&render_view(
        &blocked,
        160,
        48,
        9,
        Some("agent-01"),
        SceneView::Kitchen,
        false,
    ));
    assert!(output.contains("BLOCKED"));
    assert!(output.contains("Workspace:"));
}

#[test]
fn tui_strips_control_characters_from_external_strings() {
    let event = serde_json::from_str::<AgentStateEvent>(include_str!(
        "../../../../protocol/fixtures/snapshot.v1.json"
    ))
    .unwrap();
    let mut agents = match event {
        AgentStateEvent::Snapshot { agents, .. } => agents,
        _ => unreachable!(),
    };
    agents[0].id.push('\u{1b}');
    agents[0].name.push_str("\u{1b}live");
    agents[0].model.push('\u{1b}');
    agents[0].workspace.push('\u{1b}');
    agents[0].state = AgentState::Blocked;
    agents[1].id.push('\u{1b}');
    agents[1].name.push_str("\u{1b}ended");
    agents[1].model.push('\u{1b}');
    agents[1].workspace.push('\u{1b}');
    agents[1].state = AgentState::Ended;
    let selected_id = agents[0].id.clone();
    let mut table = AgentTable::default();
    table.apply(AgentStateEvent::Snapshot {
        version: 1,
        mode: AppMode::Live,
        source_status: SourceStatus::UnsupportedProtocol,
        source_diagnostic: Some(SourceDiagnostic {
            observed_protocol: 23,
            supported_protocols: vec![19, 20],
            next_action: "upgrade\u{1b} now".into(),
        }),
        agents,
    });

    for (width, height, scene_view) in [
        (79, 23, SceneView::Kitchen),
        (80, 24, SceneView::Kitchen),
        (160, 24, SceneView::Kitchen),
        (80, 24, SceneView::Freezer),
    ] {
        let buffer = render_view_with_warning(
            &table,
            width,
            height,
            9,
            Some(&selected_id),
            scene_view,
            false,
            Some("bind\u{1b} warning"),
        );
        assert!(buffer
            .content
            .iter()
            .all(|cell| !cell.symbol().chars().any(char::is_control)));
    }
}
