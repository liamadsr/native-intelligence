//! Hold Native Intelligence's own launch-time CoreAudio work until the main window has
//! painted.
//!
//! Why (2026-09-29, from the unified logs): the first time a Native Intelligence process
//! starts CoreAudio, macOS reads Native Intelligence's Mic Mode (Voice Isolation on Liam's
//! Mac) and every audio client on the Mac re-syncs its mic modes, for a minute
//! or more. At its first paint the web view connects to WebKit's GPU process,
//! which starts CoreAudio on its main thread as part of that connection. Inside
//! that storm the GPU process froze for 15–30 s, WebKit gave up on it, and
//! nothing composited: the window stayed black (the NSWindow background) until
//! a GPU process got through. A GPU process that is already up rides out a
//! storm (at 14:45 one started a second before the storm and the window was
//! fine through 40 s of it).
//!
//! So the starters that touch CoreAudio at launch (meeting detection's
//! `detect-stream` helper, the audio-health probe, the input-device watcher)
//! each [`wait`] on their own thread until the gate opens:
//!   - [`GRACE`] after the main window's first page load finishes (by then it
//!     has painted and its GPU process has started CoreAudio), or
//!   - [`FALLBACK`] after launch, whatever the page is doing, or
//!   - at once when the user starts audio themselves (a recording or voice
//!     mode: [`open`] from `health::ensure_answering`), which starts CoreAudio
//!     anyway and needs the device watcher running.

use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// From the main window's page load finishing to opening: its GPU process
/// started CoreAudio at first paint, before the load finished, and takes
/// well under a second when nothing else is going on.
const GRACE: Duration = Duration::from_secs(3);

/// The latest the gate opens: meeting detection waits no longer than this.
/// A debug build's dev server can take a minute to compile the first page.
#[cfg(not(debug_assertions))]
const FALLBACK: Duration = Duration::from_secs(30);
#[cfg(debug_assertions)]
const FALLBACK: Duration = Duration::from_secs(120);

struct Gate {
    open: Mutex<bool>,
    opened: Condvar,
}

impl Gate {
    const fn new() -> Self {
        Self { open: Mutex::new(false), opened: Condvar::new() }
    }

    fn is_open(&self) -> bool {
        *self.open.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn wait(&self) {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        while !*open {
            open = self.opened.wait(open).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// Open it. Returns whether this call did (false: it already was).
    fn open(&self) -> bool {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        if *open {
            return false;
        }
        *open = true;
        self.opened.notify_all();
        true
    }
}

static GATE: Gate = Gate::new();

/// Block this thread until the gate opens. Never call it on the main thread.
pub fn wait() {
    GATE.wait();
}

/// Open the gate now, saying why in the log. Idempotent.
pub fn open(why: &str) {
    if GATE.open() {
        crate::log_to_file(&format!("[launch-gate] open: {why}"));
    }
}

/// Start the fallback clock. Call once from setup.
pub fn arm() {
    let spawned = std::thread::Builder::new().name("launch-gate".into()).spawn(|| {
        std::thread::sleep(FALLBACK);
        open(&format!("no main-window page load within {}s", FALLBACK.as_secs()));
    });
    if spawned.is_err() {
        open("could not start the fallback clock");
    }
}

/// The main window finished loading `url`: open the gate [`GRACE`] later.
/// Only a Native Intelligence page counts (a debug build first loads dial8.ai and is then
/// sent to the dev server).
pub fn main_page_loaded(url: &str) {
    if GATE.is_open() || !counts(url, crate::tray::api_base_url()) {
        return;
    }
    let url = url.to_string();
    let spawned = std::thread::Builder::new().name("launch-gate-grace".into()).spawn(move || {
        std::thread::sleep(GRACE);
        open(&format!("main window loaded {url}"));
    });
    if spawned.is_err() {
        open("main window loaded (no thread for the grace)");
    }
}

fn counts(url: &str, base: &str) -> bool {
    url.strip_prefix(base).is_some_and(|rest| rest.is_empty() || rest.starts_with('/') || rest.starts_with('?'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn a_waiter_is_held_until_the_gate_opens() {
        let gate: &'static Gate = Box::leak(Box::new(Gate::new()));
        let through = Arc::new(AtomicBool::new(false));
        let t = {
            let through = Arc::clone(&through);
            std::thread::spawn(move || {
                gate.wait();
                through.store(true, Ordering::SeqCst);
            })
        };
        std::thread::sleep(Duration::from_millis(100));
        assert!(!through.load(Ordering::SeqCst), "went through a closed gate");
        assert!(gate.open());
        t.join().unwrap();
        assert!(through.load(Ordering::SeqCst));
    }

    #[test]
    fn an_open_gate_lets_everyone_through_and_opens_once() {
        let gate = Gate::new();
        assert!(!gate.is_open());
        assert!(gate.open());
        assert!(!gate.open(), "a second open reports it was already open");
        gate.wait();
        gate.wait();
    }

    #[test]
    fn only_a_page_of_the_app_counts() {
        assert!(counts("https://dial8.ai/", "https://dial8.ai"));
        assert!(counts("https://dial8.ai", "https://dial8.ai"));
        assert!(counts("https://dial8.ai/account?tab=1", "https://dial8.ai"));
        assert!(counts("http://localhost:3000/account", "http://localhost:3000"));
        // A debug build's first load, before setup sends it to the dev server.
        assert!(!counts("https://dial8.ai/", "http://localhost:3000"));
        assert!(!counts("https://dial8.ai.evil.com/", "https://dial8.ai"));
        assert!(!counts("about:blank", "https://dial8.ai"));
    }
}
