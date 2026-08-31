pub mod canvas;
pub mod scene;
pub mod state;
pub mod theme;
pub mod view;

use std::{
    io::{self, stdout},
    panic,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        OnceLock,
    },
    time::Duration,
};

use chrono::Utc;
use crossterm::{
    event::{Event, EventStream, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures_util::StreamExt;
use ratatui::{backend::CrosstermBackend, Terminal};
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;

use crate::feed::Feed;
use state::AgentTable;

const SCENE_TICK_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TerminalCapabilities {
    color_mode: canvas::ColorMode,
    scene_supported: bool,
}

fn terminal_capabilities(
    term: Option<&str>,
    colorterm: Option<&str>,
    no_color: bool,
) -> TerminalCapabilities {
    let color_mode = if colorterm.is_some_and(|value| {
        let value = value.to_ascii_lowercase();
        value.contains("truecolor") || value.contains("24bit")
    }) {
        canvas::ColorMode::Truecolor
    } else {
        canvas::ColorMode::Xterm256
    };
    TerminalCapabilities {
        color_mode,
        scene_supported: !no_color && !term.is_some_and(|value| value.eq_ignore_ascii_case("dumb")),
    }
}

fn startup_terminal_capabilities() -> TerminalCapabilities {
    let term = std::env::var_os("TERM");
    let colorterm = std::env::var_os("COLORTERM");
    terminal_capabilities(
        term.as_deref().and_then(std::ffi::OsStr::to_str),
        colorterm.as_deref().and_then(std::ffi::OsStr::to_str),
        std::env::var_os("NO_COLOR").is_some(),
    )
}

#[derive(Debug, PartialEq)]
enum FeedDecision<T> {
    Apply(T),
    Resnapshot,
    Closed,
}

fn decide_feed_event<T: Clone>(
    receiver: &mut tokio::sync::broadcast::Receiver<T>,
    event: Result<T, RecvError>,
) -> FeedDecision<T> {
    match event {
        Ok(event) => FeedDecision::Apply(event),
        Err(RecvError::Lagged(_)) => {
            *receiver = receiver.resubscribe();
            FeedDecision::Resnapshot
        }
        Err(RecvError::Closed) => FeedDecision::Closed,
    }
}

#[derive(Default, Debug)]
pub struct BindWarning(Option<String>);
impl BindWarning {
    pub fn set_once(&mut self, message: String) {
        if self.0.is_none() {
            self.0 = Some(message);
        }
    }
    pub fn message(&self) -> Option<&str> {
        self.0.as_deref()
    }
}

static PANIC_RESTORE_INSTALLED: AtomicBool = AtomicBool::new(false);
static PANIC_RESTORE_INSTALL_COUNT: AtomicUsize = AtomicUsize::new(0);
static PANIC_RESTORE_HOOK: OnceLock<()> = OnceLock::new();

fn restore_terminal() {
    let _ = disable_raw_mode();
    let _ = execute!(stdout(), LeaveAlternateScreen);
}

pub fn install_panic_restore_hook() {
    PANIC_RESTORE_HOOK.get_or_init(|| {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            restore_terminal();
            previous(info);
        }));
        PANIC_RESTORE_INSTALL_COUNT.fetch_add(1, Ordering::SeqCst);
        PANIC_RESTORE_INSTALLED.store(true, Ordering::SeqCst);
    });
}

#[cfg(test)]
fn panic_restore_install_count() -> usize {
    PANIC_RESTORE_INSTALL_COUNT.load(Ordering::SeqCst)
}

fn retain_selection(selected_id: &mut Option<String>, table: &AgentTable) {
    if selected_id
        .as_ref()
        .is_some_and(|id| !table.agents().any(|agent| &agent.id == id))
    {
        *selected_id = None;
    }
}

fn handle_key(
    code: KeyCode,
    table: &AgentTable,
    selected_id: &mut Option<String>,
    shutdown: &CancellationToken,
) -> bool {
    if code == KeyCode::Char('q') || (code == KeyCode::Esc && selected_id.is_none()) {
        shutdown.cancel();
        true
    } else if code == KeyCode::Esc {
        *selected_id = None;
        false
    } else if matches!(code, KeyCode::Tab | KeyCode::BackTab) {
        let agents = table.agents().collect::<Vec<_>>();
        if agents.is_empty() {
            *selected_id = None;
            return false;
        }
        let current = selected_id
            .as_ref()
            .and_then(|id| agents.iter().position(|agent| &agent.id == id));
        let index = if code == KeyCode::BackTab {
            current.map_or(agents.len() - 1, |index| {
                (index + agents.len() - 1) % agents.len()
            })
        } else {
            current.map_or(0, |index| (index + 1) % agents.len())
        };
        *selected_id = Some(agents[index].id.clone());
        false
    } else {
        false
    }
}

struct TerminalGuard;
impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        install_panic_restore_hook();
        enable_raw_mode()?;
        if let Err(error) = execute!(stdout(), EnterAlternateScreen) {
            let _ = disable_raw_mode();
            return Err(error);
        }
        Ok(Self)
    }
}
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore_terminal();
    }
}

pub async fn run(feed: Feed, shutdown: CancellationToken, warning: BindWarning) -> io::Result<()> {
    let capabilities = startup_terminal_capabilities();
    let _guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
    let mut events = EventStream::new();
    let mut receiver = feed.subscribe();
    let mut table = AgentTable::default();
    table.apply(feed.snapshot().await);
    let mut interval = tokio::time::interval(SCENE_TICK_INTERVAL);
    let mut tick = 0_u64;
    let mut selected_id = None;
    loop {
        retain_selection(&mut selected_id, &table);
        let now = Utc::now();
        terminal.draw(|frame| {
            scene::draw(
                frame,
                &table,
                warning.message(),
                now,
                tick,
                capabilities.color_mode,
                capabilities.scene_supported,
                selected_id.as_deref(),
            )
        })?;
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = interval.tick() => tick = tick.wrapping_add(1),
            event = receiver.recv() => match decide_feed_event(&mut receiver, event) {
                FeedDecision::Apply(event) => {
                    table.apply(event);
                },
                FeedDecision::Resnapshot => {
                    table.apply(feed.snapshot().await);
                },
                FeedDecision::Closed => break,
            },
            event = events.next() => match event {
                Some(Ok(Event::Key(key))) if key.kind == KeyEventKind::Press && handle_key(key.code, &table, &mut selected_id, &shutdown) => break,
                Some(Err(error)) => return Err(error),
                None => break,
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_capability_detection_is_injectable_and_non_interactive() {
        assert_eq!(
            terminal_capabilities(Some("xterm-256color"), Some("truecolor"), false),
            TerminalCapabilities {
                color_mode: canvas::ColorMode::Truecolor,
                scene_supported: true
            }
        );
        assert_eq!(
            terminal_capabilities(Some("xterm-256color"), None, false),
            TerminalCapabilities {
                color_mode: canvas::ColorMode::Xterm256,
                scene_supported: true
            }
        );
        assert!(!terminal_capabilities(Some("dumb"), Some("truecolor"), false).scene_supported);
        assert!(
            !terminal_capabilities(Some("xterm-256color"), Some("truecolor"), true).scene_supported
        );
    }

    #[test]
    fn scene_tick_interval_is_ten_hertz() {
        assert_eq!(SCENE_TICK_INTERVAL, Duration::from_millis(100));
    }

    #[test]
    fn panic_hook_contract_is_installed_before_raw_mode_helper_returns() {
        install_panic_restore_hook();
        install_panic_restore_hook();
        assert!(PANIC_RESTORE_INSTALLED.load(Ordering::SeqCst));
        assert_eq!(panic_restore_install_count(), 1);
    }
    #[test]
    fn quit_keys_cancel_shared_token() {
        let table = AgentTable::default();
        for code in [KeyCode::Char('q'), KeyCode::Esc] {
            let token = CancellationToken::new();
            assert!(handle_key(code, &table, &mut None, &token));
            assert!(token.is_cancelled());
        }
    }

    #[test]
    fn station_keys_cycle_dismiss_then_quit() {
        use crate::protocol::{
            AgentRecord, AgentState, AgentStateEvent, AppMode, DeltaOperation, SessionStats,
            SourceStatus,
        };

        let agent = |id: &str| AgentRecord {
            id: id.into(),
            name: id.into(),
            state: AgentState::Working,
            progress: None,
            state_entered_at: String::new(),
            accent_index: 0,
            model: String::new(),
            workspace: String::new(),
            session: SessionStats {
                runtime_ms: 0,
                tickets: 0,
            },
        };
        let mut table = AgentTable::default();
        table.apply(AgentStateEvent::Snapshot {
            version: 1,
            mode: AppMode::Live,
            source_status: SourceStatus::Connected,
            source_diagnostic: None,
            agents: vec![agent("a"), agent("b")],
        });
        let quit = CancellationToken::new();
        let mut selected = Some("a".into());
        assert!(handle_key(KeyCode::Char('q'), &table, &mut selected, &quit));
        assert!(quit.is_cancelled());

        let shutdown = CancellationToken::new();
        let mut selected = None;

        assert!(!handle_key(KeyCode::Tab, &table, &mut selected, &shutdown));
        assert_eq!(selected.as_deref(), Some("a"));
        assert!(!handle_key(KeyCode::Tab, &table, &mut selected, &shutdown));
        assert_eq!(selected.as_deref(), Some("b"));
        assert!(!handle_key(
            KeyCode::BackTab,
            &table,
            &mut selected,
            &shutdown
        ));
        assert_eq!(selected.as_deref(), Some("a"));
        assert!(!handle_key(KeyCode::Esc, &table, &mut selected, &shutdown));
        assert_eq!(selected, None);
        assert!(!shutdown.is_cancelled());
        assert!(handle_key(KeyCode::Esc, &table, &mut selected, &shutdown));
        assert!(shutdown.is_cancelled());

        selected = Some("b".into());
        table.apply(AgentStateEvent::Delta {
            version: 1,
            mode: AppMode::Live,
            operation: DeltaOperation::Remove,
            agent: None,
            agent_id: Some("b".into()),
        });
        retain_selection(&mut selected, &table);
        assert_eq!(selected, None);
    }

    #[tokio::test]
    async fn lag_decision_resubscribes_at_tail_before_resnapshot() {
        let (sender, mut receiver) = tokio::sync::broadcast::channel(2);
        sender.send(1).unwrap();
        sender.send(2).unwrap();
        sender.send(3).unwrap();

        let lag = receiver.recv().await;
        assert!(matches!(lag, Err(RecvError::Lagged(_))));
        assert_eq!(
            decide_feed_event(&mut receiver, lag),
            FeedDecision::Resnapshot
        );

        sender.send(4).unwrap();
        assert_eq!(receiver.recv().await.unwrap(), 4);
    }

    #[tokio::test]
    async fn feed_decision_maps_events_and_closed_channels() {
        let (sender, mut receiver) = tokio::sync::broadcast::channel(2);
        sender.send(7).unwrap();
        let event = receiver.recv().await;
        assert_eq!(
            decide_feed_event(&mut receiver, event),
            FeedDecision::Apply(7)
        );

        drop(sender);
        let closed = receiver.recv().await;
        assert_eq!(
            decide_feed_event(&mut receiver, closed),
            FeedDecision::Closed
        );
    }
}
