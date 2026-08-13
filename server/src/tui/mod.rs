pub mod state;
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

pub fn handle_key(code: KeyCode, shutdown: &CancellationToken) -> bool {
    if matches!(code, KeyCode::Char('q') | KeyCode::Esc) {
        shutdown.cancel();
        true
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
    let _guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
    let mut events = EventStream::new();
    let mut receiver = feed.subscribe();
    let mut table = AgentTable::default();
    table.apply(feed.snapshot().await);
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    let mut tick = 0_u64;
    loop {
        terminal.draw(|frame| view::draw(frame, &table, warning.message(), Utc::now(), tick))?;
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = interval.tick() => tick = tick.wrapping_add(1),
            event = receiver.recv() => match decide_feed_event(&mut receiver, event) {
                FeedDecision::Apply(event) => table.apply(event),
                FeedDecision::Resnapshot => table.apply(feed.snapshot().await),
                FeedDecision::Closed => break,
            },
            event = events.next() => match event {
                Some(Ok(Event::Key(key))) if key.kind == KeyEventKind::Press && handle_key(key.code, &shutdown) => break,
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
    fn panic_hook_contract_is_installed_before_raw_mode_helper_returns() {
        install_panic_restore_hook();
        install_panic_restore_hook();
        assert!(PANIC_RESTORE_INSTALLED.load(Ordering::SeqCst));
        assert_eq!(panic_restore_install_count(), 1);
    }
    #[test]
    fn quit_keys_cancel_shared_token() {
        for code in [KeyCode::Char('q'), KeyCode::Esc] {
            let token = CancellationToken::new();
            assert!(handle_key(code, &token));
            assert!(token.is_cancelled());
        }
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
