//! App quit: finalize an in-flight recording, release the voice mic, stop
//! the read-aloud sidecar and the local agents, once, whichever way the app
//! quits.
//!
//! What each quit raises on macOS (Tauri 2.10, tao 0.34):
//! - Cmd+Q, the default menu's Quit (muda sends `terminate:`): only
//!   `RunEvent::Exit`. tao answers `applicationWillTerminate` with
//!   LoopDestroyed, which Tauri hands us as `Exit`, the last event before
//!   AppKit ends the process. Never `ExitRequested`.
//! - The tray's "Quit Native Intelligence" (`app.exit(0)`), `request_restart()` (the
//!   process plugin's `relaunch()`, read_selection_relaunch) and the last
//!   window closing: `ExitRequested`, then `Exit`.
//! - `app.restart()` on the main thread, where every sync command runs:
//!   neither. It restarts the process at once, so the app never calls it
//!   (a test below refuses it) and uses `request_restart()` instead.
//!
//! So lib.rs calls [`run`] from both arms, and the cleanup runs on the first
//! of them: `ExitRequested` when there is one, `Exit` on Cmd+Q.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

use crate::{commands, local_agent, log_to_file, modules, voice, AppState};

/// Set by the first quit event.
static CLEANED_UP: AtomicBool = AtomicBool::new(false);

/// Runs `cleanup` the first time only; later calls return at once.
fn once(flag: &AtomicBool, cleanup: impl FnOnce()) {
    if !flag.swap(true, Ordering::SeqCst) {
        cleanup();
    }
}

/// `via`: the event, for the log.
pub fn run(app_handle: &AppHandle, via: &str) {
    once(&CLEANED_UP, || {
        log_to_file(&format!("[exit] quit cleanup on {via}"));

        // Stop and FINALIZE any in-flight recording before the process goes
        // away. Close-to-tray makes this the common case, not an edge case:
        // the window the user was recording from is now routinely hidden
        // rather than closed, so at quit time there is very plausibly a live
        // capture nobody can see. Without this, the process dies mid-stream
        // and the WAV loses its tail (and its header fixups);
        // reset_recording_state stops the mic + system-audio taps and closes
        // the file out properly. Losing the last seconds beats losing the
        // recording.
        //
        // Sync and try_lock-based throughout, so it cannot block or deadlock
        // the event thread here.
        let state = app_handle.state::<AppState>();
        commands::recording::reset_recording_state(&state);

        // End a voice session, mic released before this returns. Not while
        // coreaudiod is stuck (audio::health): releasing the mic would never
        // return, and quit would hang with it.
        if crate::audio::health::current() != crate::audio::health::Health::Unresponsive {
            voice::shutdown(app_handle);
        } else {
            log_to_file("[exit] coreaudiod is stuck: not releasing the voice mic");
        }

        // Stop read-aloud and its long-lived local-tts sidecar (shutdown →
        // stdin EOF → reap) and the local agents (stop + stdin EOF to every
        // job; at 2.6 s, after the launchers' own ~2.0 s shutdown, SIGKILL to
        // what is left, process group and all; marked interrupted, resumable
        // after relaunch), so none of them outlives the app. Side by side:
        // each is bounded to 3 s, and so is the whole.
        let tts = app_handle.try_state::<modules::tts::TtsService>();
        let agents = app_handle.try_state::<local_agent::LocalAgentService>();
        // A Studio export on this computer stops too, its whole process tree
        // (SIGTERM, then SIGKILL at 2.5 s; the job object on Windows).
        let studio = app_handle.try_state::<std::sync::Arc<crate::studio_local::StudioLocal>>();
        tauri::async_runtime::block_on(async {
            let tts_done = async {
                if let Some(tts) = &tts {
                    tts.shutdown().await;
                }
            };
            let agents_done = async {
                if let Some(agents) = &agents {
                    agents.shutdown().await;
                }
            };
            let studio_done = async {
                if let Some(studio) = &studio {
                    studio.shutdown().await;
                }
            };
            tokio::join!(tts_done, agents_done, studio_done);
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    #[test]
    fn cmd_q_cleans_up_on_exit_alone() {
        let flag = AtomicBool::new(false);
        let runs = AtomicUsize::new(0);
        once(&flag, || {
            runs.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_tray_quit_cleans_up_once_across_both_events() {
        let flag = AtomicBool::new(false);
        let runs = AtomicUsize::new(0);
        for _event in ["ExitRequested", "Exit"] {
            once(&flag, || {
                runs.fetch_add(1, Ordering::SeqCst);
            });
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1, "the second event returns at once");
    }

    #[test]
    fn racing_callers_clean_up_once() {
        let flag = Arc::new(AtomicBool::new(false));
        let runs = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (flag, runs) = (flag.clone(), runs.clone());
                std::thread::spawn(move || {
                    once(&flag, || {
                        runs.fetch_add(1, Ordering::SeqCst);
                    })
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    /// The `if let tauri::RunEvent::<pattern> = event {` arm in lib.rs's run
    /// callback, up to the next arm.
    fn run_event_arm<'a>(lib_rs: &'a str, pattern: &str) -> &'a str {
        let head = format!("if let tauri::RunEvent::{pattern} = event {{");
        let start = lib_rs.find(&head).unwrap_or_else(|| panic!("no `{head}` in lib.rs"));
        let rest = &lib_rs[start + head.len()..];
        &rest[..rest.find("if let tauri::RunEvent::").unwrap_or(rest.len())]
    }

    /// Cmd+Q raises only `Exit`, so the cleanup can't live in the
    /// `ExitRequested` arm alone (the bug this module fixes).
    #[test]
    fn both_exit_arms_run_the_quit_cleanup() {
        let lib_rs = include_str!("lib.rs");
        assert!(
            run_event_arm(lib_rs, "ExitRequested { .. }").contains("quit::run(app_handle"),
            "the ExitRequested arm (tray Quit, request_restart) must call quit::run"
        );
        assert!(
            run_event_arm(lib_rs, "Exit").contains("quit::run(app_handle"),
            "the Exit arm (Cmd+Q) must call quit::run"
        );
    }

    /// Code in `src/`, `//` comments dropped.
    fn source_files() -> Vec<(String, String)> {
        fn walk(dir: &Path, out: &mut Vec<(String, String)>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let code: String = std::fs::read_to_string(&path)
                        .unwrap()
                        .lines()
                        .map(|l| l.find("//").map_or(l, |i| &l[..i]))
                        .collect::<Vec<_>>()
                        .join("\n");
                    out.push((path.display().to_string(), code));
                }
            }
        }
        let mut out = Vec::new();
        walk(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut out);
        assert!(out.len() > 20, "src/ was read");
        out
    }

    /// `app.restart()` from the main thread skips both exit events, and with
    /// them this cleanup; `request_restart()` raises them. And nothing may
    /// prevent an exit: see the ⚠️ at lib.rs's ExitRequested arm.
    #[test]
    fn nothing_restarts_past_the_exit_events_or_prevents_an_exit() {
        for (file, code) in source_files() {
            if file.ends_with("quit.rs") {
                continue; // the needles below
            }
            assert!(!code.contains(".restart()"), "{file}: use request_restart(), not restart()");
            assert!(!code.contains("prevent_exit("), "{file}: prevent_exit() swallows tray Quit");
        }
    }
}
