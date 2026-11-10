//! Is macOS's audio daemon (coreaudiod) answering?
//!
//! coreaudiod can deadlock. On 2026-09-28 a device restart it had started
//! itself never finished (Chrome's Voice Isolation on a Loopback virtual mic
//! could not be set up again), and from then on every CoreAudio call on the
//! Mac blocked until the daemon was killed. A blocked call never returns and
//! can't be cancelled, so:
//!   - nothing that runs on the main thread may call CoreAudio directly (a
//!     sync Tauri command runs there: one stuck call freezes every window,
//!     and a stuck call in `setup` means the app never opens);
//!   - this module notices, so the app can say so and offer the fix instead
//!     of hanging.
//!
//! A probe reads the default input device on its own thread and waits
//! [`PROBE_TIMEOUT`] for it. No answer: the state becomes Unresponsive and
//! [`EVENT`] goes to every window. The probe thread stays blocked until the
//! daemon comes back (it can't be cancelled); when its call returns, the
//! state goes back to Responsive and the event fires again. One probe at a
//! time: at start, every [`PROBE_EVERY`], and on demand ([`check_now`]).
//! A probe is a property read: no device IO, never the microphone.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::OnceLock;
use std::time::Duration;

/// `{ "health": "responsive" | "unresponsive" }`, to every window, on change.
pub const EVENT: &str = "audio://health";

/// What a command that needs CoreAudio returns instead of hanging.
pub const UNRESPONSIVE: &str =
    "macOS audio isn't responding (coreaudiod is stuck). Restart audio, then try again.";

/// A healthy daemon answers a property read in well under a millisecond.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const PROBE_EVERY: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    /// No probe has answered or timed out yet.
    Unknown,
    Responsive,
    Unresponsive,
}

impl Health {
    fn from_u8(v: u8) -> Self {
        match v {
            1 => Health::Responsive,
            2 => Health::Unresponsive,
            _ => Health::Unknown,
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct Payload {
    health: Health,
}

static STATE: AtomicU8 = AtomicU8::new(Health::Unknown as u8);
static WAKE: OnceLock<Sender<()>> = OnceLock::new();

/// The last verdict. Cheap: an atomic read, safe on any thread.
pub fn current() -> Health {
    Health::from_u8(STATE.load(Ordering::Relaxed))
}

/// `Err(UNRESPONSIVE)` while the daemon is known to be stuck. For commands
/// that are about to call CoreAudio: fail at once rather than block. (Unknown
/// passes: before the first verdict there is nothing to go on.)
pub fn ensure_responsive() -> Result<(), String> {
    match current() {
        Health::Unresponsive => Err(UNRESPONSIVE.to_string()),
        _ => Ok(()),
    }
}

/// [`ensure_responsive`], then ask the daemon now, waiting at most
/// [`ANSWER_TIMEOUT`]: for a command about to open or close a device, so it
/// fails instead of hanging when the daemon has wedged since the last probe.
/// A timeout also wakes the prober, which flips the state and tells the
/// windows. (The asking thread is left blocked until the daemon comes back:
/// CoreAudio calls can't be cancelled. Once the state is Unresponsive the
/// first check returns early, so at most one is ever left behind per wedge.)
pub fn ensure_answering() -> Result<(), String> {
    // The user is starting audio: CoreAudio starts now anyway, and the
    // device watcher has to be running for it.
    super::launch_gate::open("audio started by the user");
    ensure_responsive()?;
    if answers_within(ANSWER_TIMEOUT, probe_once) {
        Ok(())
    } else {
        crate::log_to_file(&format!(
            "[audio-health] coreaudiod didn't answer within {}s before a device operation: refusing it",
            ANSWER_TIMEOUT.as_secs()
        ));
        check_now();
        Err(UNRESPONSIVE.to_string())
    }
}

/// A healthy daemon answers in well under a millisecond, a busy one in tens.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(3);

fn answers_within(timeout: Duration, call: fn()) -> bool {
    let (tx, rx) = mpsc::channel::<()>();
    let spawned = std::thread::Builder::new().name("audio-health-ask".into()).spawn(move || {
        call();
        let _ = tx.send(());
    });
    // Can't spawn a thread: don't block a command on a guess.
    spawned.is_err() || rx.recv_timeout(timeout).is_ok()
}

/// Probe again now (after a restart attempt, or when a caller has reason to
/// doubt the daemon). No-op before [`start`], and while a probe is stuck.
pub fn check_now() {
    if let Some(tx) = WAKE.get() {
        let _ = tx.send(());
    }
}

/// Start probing. Call once from setup: spawns threads, touches nothing. The
/// first probe waits for the launch gate (a probe starts CoreAudio).
pub fn start(app: tauri::AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    if WAKE.set(tx).is_err() {
        return;
    }
    let spawned = std::thread::Builder::new().name("audio-health".into()).spawn(move || {
        super::launch_gate::wait();
        loop {
            probe(PROBE_TIMEOUT, probe_once, &|health| set(&app, health));
            match rx.recv_timeout(PROBE_EVERY) {
                Ok(()) | Err(RecvTimeoutError::Timeout) => {
                    // Coalesce a burst of check_now()s into one probe.
                    while rx.try_recv().is_ok() {}
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    });
    if let Err(e) = spawned {
        crate::log_to_file(&format!("[audio-health] could not start: {e}"));
    }
}

/// One probe: run `call` on its own thread and wait `timeout` for it. On a
/// timeout, report Unresponsive, then keep waiting (blocking the caller) for
/// the stuck call to come back, and report Responsive when it does.
fn probe(timeout: Duration, call: fn(), report: &dyn Fn(Health)) {
    let (tx, rx) = mpsc::channel::<()>();
    let spawned = std::thread::Builder::new().name("audio-health-probe".into()).spawn(move || {
        call();
        let _ = tx.send(());
    });
    if spawned.is_err() {
        return;
    }
    match rx.recv_timeout(timeout) {
        Ok(()) => report(Health::Responsive),
        Err(RecvTimeoutError::Timeout) => {
            crate::log_to_file(&format!(
                "[audio-health] coreaudiod didn't answer a property read in {}s: marking audio unresponsive",
                timeout.as_secs()
            ));
            report(Health::Unresponsive);
            // Blocks until the daemon answers (it was restarted, or it
            // recovered by itself). Nothing else to probe meanwhile.
            if rx.recv().is_ok() {
                crate::log_to_file("[audio-health] coreaudiod is answering again");
                report(Health::Responsive);
            }
        }
        // The probe thread died without answering (a panic): no verdict.
        Err(RecvTimeoutError::Disconnected) => {}
    }
}

fn set(app: &tauri::AppHandle, health: Health) {
    use tauri::Emitter;
    let previous = Health::from_u8(STATE.swap(health as u8, Ordering::Relaxed));
    if previous != health {
        let _ = app.emit(EVENT, Payload { health });
    }
}

/// The call a probe makes: the default input device's ID. Any answer counts,
/// even an error status; only a call that never returns is a stuck daemon.
fn probe_once() {
    #[cfg(target_os = "macos")]
    {
        use super::output_route::ffi::{get_u32, SCOPE_GLOBAL, SYSTEM_OBJECT};
        const DEFAULT_INPUT: u32 = u32::from_be_bytes(*b"dIn ");
        let _ = get_u32(SYSTEM_OBJECT, DEFAULT_INPUT, SCOPE_GLOBAL);
    }
}

/// Restart coreaudiod: macOS asks for an administrator's password (the
/// daemon is root's), then launchd starts a fresh one. A plain SIGTERM is not
/// enough for a deadlocked daemon (it hangs in its own exit handler), so this
/// sends SIGKILL. Blocks until the user answers the password prompt: call it
/// off the main thread. `Err("cancelled")` when the user dismisses it.
pub fn restart_daemon() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        const SCRIPT: &str = r#"do shell script "/usr/bin/killall -9 coreaudiod" with prompt "Native Intelligence needs your password to restart macOS audio." with administrator privileges"#;
        let out = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", SCRIPT])
            .output()
            .map_err(|e| format!("couldn't run osascript: {e}"))?;
        if out.status.success() {
            crate::log_to_file("[audio-health] restarted coreaudiod (killall -9, admin prompt)");
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        // AppleScript's "User canceled." is error -128.
        if stderr.contains("-128") {
            return Err("cancelled".to_string());
        }
        crate::log_to_file(&format!("[audio-health] restarting coreaudiod failed: {}", stderr.trim()));
        Err(format!("couldn't restart macOS audio: {}", stderr.trim()))
    }
    #[cfg(not(target_os = "macos"))]
    Err("restarting audio is macOS only".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_passes_and_unresponsive_refuses() {
        STATE.store(Health::Unknown as u8, Ordering::Relaxed);
        assert!(ensure_responsive().is_ok());
        STATE.store(Health::Unresponsive as u8, Ordering::Relaxed);
        assert_eq!(ensure_responsive(), Err(UNRESPONSIVE.to_string()));
        STATE.store(Health::Responsive as u8, Ordering::Relaxed);
        assert!(ensure_responsive().is_ok());
        STATE.store(Health::Unknown as u8, Ordering::Relaxed);
    }

    #[test]
    fn health_round_trips_through_its_byte() {
        for h in [Health::Unknown, Health::Responsive, Health::Unresponsive] {
            assert_eq!(Health::from_u8(h as u8), h);
        }
    }

    fn record(timeout: Duration, call: fn()) -> Vec<Health> {
        let seen = std::sync::Mutex::new(Vec::new());
        probe(timeout, call, &|h| seen.lock().unwrap().push(h));
        seen.into_inner().unwrap()
    }

    #[test]
    fn a_call_that_answers_is_responsive() {
        fn quick() {}
        assert_eq!(record(Duration::from_secs(2), quick), vec![Health::Responsive]);
    }

    #[test]
    fn a_call_that_hangs_is_unresponsive_until_it_returns() {
        fn stuck_for_a_while() {
            std::thread::sleep(Duration::from_millis(300));
        }
        assert_eq!(
            record(Duration::from_millis(50), stuck_for_a_while),
            vec![Health::Unresponsive, Health::Responsive]
        );
    }

    #[test]
    fn answers_within_waits_only_as_long_as_it_is_told() {
        fn quick() {}
        fn slow() {
            std::thread::sleep(Duration::from_millis(400));
        }
        assert!(answers_within(Duration::from_secs(2), quick));
        let started = std::time::Instant::now();
        assert!(!answers_within(Duration::from_millis(50), slow));
        assert!(started.elapsed() < Duration::from_millis(300), "gave up at the timeout, not when the call returned");
    }

    #[test]
    fn a_call_that_panics_gives_no_verdict() {
        fn panics() {
            panic!("probe blew up");
        }
        assert_eq!(record(Duration::from_secs(2), panics), Vec::<Health>::new());
    }

    #[test]
    fn health_serializes_lowercase() {
        let json = serde_json::to_string(&Payload { health: Health::Unresponsive }).unwrap();
        assert_eq!(json, r#"{"health":"unresponsive"}"#);
    }
}
