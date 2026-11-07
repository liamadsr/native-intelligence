//! The session registry's guards: one session app-wide, owned by a webview;
//! refused during a capture or for another webview; ended by its page going
//! away, by a capture starting (mic released before returning), and at exit.

use std::sync::atomic::AtomicUsize;

use super::*;

/// Counts releases, and stops (a release that finds the lease still held).
#[derive(Default)]
struct FakeMic {
    releases: Arc<AtomicUsize>,
    stops: Arc<AtomicUsize>,
}

impl MicControl for FakeMic {
    fn release(&self, lease: &MicLease) {
        self.releases.fetch_add(1, Ordering::SeqCst);
        if lease.take() {
            self.stops.fetch_add(1, Ordering::SeqCst);
        }
    }
}

struct Rig {
    voice: VoiceService,
    releases: Arc<AtomicUsize>,
    stops: Arc<AtomicUsize>,
}

fn rig() -> Rig {
    let mic = FakeMic::default();
    let (releases, stops) = (mic.releases.clone(), mic.stops.clone());
    Rig { voice: VoiceService::with_mic(Box::new(mic)), releases, stops }
}

fn session(voice: &VoiceService, id: &str, owner: &str) -> (Active, mpsc::UnboundedReceiver<Ctl>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let active = Active {
        session_id: id.into(),
        owner: owner.into(),
        mode: Mode::Conversation,
        token: voice.next_token(),
        ctl: tx,
        lease: Arc::new(MicLease::new()),
    };
    (active, rx)
}

/// Admit (which registers), as `voice_start` does under the mic lock, with
/// the page generation read just before.
fn start(voice: &VoiceService, id: &str, owner: &str) -> (Active, mpsc::UnboundedReceiver<Ctl>) {
    let (active, rx) = session(voice, id, owner);
    let page = voice.page_generation(owner);
    assert!(voice.admit(false, active.clone(), page).unwrap().is_none());
    (active, rx)
}

/// Admit a fresh session for `owner` at its current page generation.
fn admit(voice: &VoiceService, recording: bool, owner: &str) -> Result<Option<Active>, Refusal> {
    let (active, _rx) = session(voice, "x", owner);
    voice.admit(recording, active, voice.page_generation(owner))
}

#[test]
fn a_capture_refuses_voice() {
    let r = rig();
    assert_eq!(admit(&r.voice, true, "main").unwrap_err(), Refusal::Recording);
    assert_eq!(Refusal::Recording.code(), "recording");
    assert!(r.voice.find("x").is_none(), "nothing registered");
}

#[test]
fn another_webviews_session_is_busy() {
    let r = rig();
    let (_a, _rx) = start(&r.voice, "s1", "main");
    assert!(r.voice.busy_for("workspace-2"));
    assert!(!r.voice.busy_for("main"));
    assert_eq!(admit(&r.voice, false, "workspace-2").unwrap_err(), Refusal::Busy);
    // Even during a capture, recording is what's reported first.
    assert_eq!(admit(&r.voice, true, "workspace-2").unwrap_err(), Refusal::Recording);
    assert!(r.voice.find("s1").is_some(), "the owner's session is untouched");
}

#[test]
fn the_same_webview_replaces_its_own_session_without_stopping_the_mic() {
    let r = rig();
    let (old, _rx) = start(&r.voice, "s1", "main");
    let (new, _rx2) = session(&r.voice, "s2", "main");
    let replaced = r.voice.admit(false, new, r.voice.page_generation("main")).unwrap().expect("the old session is handed back");
    assert_eq!(replaced.session_id, "s1");
    assert!(r.voice.find("s2").is_some() && r.voice.find("s1").is_none(), "the new one is registered");
    assert!(!old.lease.held(), "the old session no longer owns the mic…");
    assert_eq!(r.stops.load(Ordering::SeqCst), 0, "…but the mic wasn't stopped: the new session carries on");
    // The old session ending later doesn't stop the new one's mic.
    r.voice.release_mic(&old.lease);
    assert_eq!(r.stops.load(Ordering::SeqCst), 0);
}

#[test]
fn end_for_recording_releases_the_mic_before_returning() {
    let r = rig();
    let (a, mut rx) = start(&r.voice, "s1", "main");
    assert!(r.voice.end_now(EndReason::Recording));
    assert_eq!(r.stops.load(Ordering::SeqCst), 1, "mic stopped synchronously");
    assert!(!a.lease.held());
    assert_eq!(rx.try_recv().unwrap(), Ctl::End(EndReason::Recording));
    // The session's own teardown releasing again is a no-op.
    r.voice.release_mic(&a.lease);
    assert_eq!(r.releases.load(Ordering::SeqCst), 2);
    assert_eq!(r.stops.load(Ordering::SeqCst), 1);
    // Nothing live: a no-op.
    r.voice.deregister(a.token);
    assert!(!r.voice.end_now(EndReason::Recording));
    assert_eq!(r.releases.load(Ordering::SeqCst), 2);
}

/// Records the voice system tap's starts and stops, and whether the
/// session's lease was still held when it was stopped.
#[derive(Default)]
struct FakeRefTap {
    running: Mutex<Option<u64>>,
    stops: Mutex<Vec<(Option<u64>, bool)>>,
    lease: Mutex<Option<Arc<MicLease>>>,
}

impl FakeRefTap {
    fn held(&self) -> bool {
        self.lease.lock().unwrap().as_ref().is_some_and(|l| l.held())
    }
}

impl system_ref::RefTapControl for Arc<FakeRefTap> {
    fn start(&self, token: u64, lease: &MicLease, _feed: Arc<crate::audio::tap::TapSlot>, _restart: bool) -> Result<(), String> {
        let mut running = self.running.lock().unwrap();
        if !lease.held() {
            return Err("no lease".into());
        }
        *running = Some(token);
        Ok(())
    }

    fn stop(&self, token: u64) -> bool {
        let mut running = self.running.lock().unwrap();
        self.stops.lock().unwrap().push((Some(token), self.held()));
        if *running == Some(token) {
            *running = None;
            true
        } else {
            false
        }
    }

    fn stop_any(&self) -> bool {
        let mut running = self.running.lock().unwrap();
        self.stops.lock().unwrap().push((None, self.held()));
        running.take().is_some()
    }
}

#[test]
fn a_capture_starting_stops_the_voice_system_tap_before_returning() {
    let tap = Arc::new(FakeRefTap::default());
    let voice = VoiceService::with_controls(Box::new(FakeMic::default()), Box::new(tap.clone()));
    let (a, mut rx) = start(&voice, "s1", "main");
    *tap.lease.lock().unwrap() = Some(a.lease.clone());
    let feed = Arc::new(crate::audio::tap::TapSlot::new());
    voice.ref_tap().start(a.token, &a.lease, feed.clone(), false).unwrap();
    assert!(voice.end_now(EndReason::Recording));
    assert_eq!(*tap.running.lock().unwrap(), None, "the tap is gone before the capture's own starts");
    assert_eq!(*tap.stops.lock().unwrap(), vec![(None, false)], "stopped once, after the lease was taken");
    assert_eq!(rx.try_recv().unwrap(), Ctl::End(EndReason::Recording));
    // A start racing the end (the session's reconcile job) is refused.
    assert!(voice.ref_tap().start(a.token, &a.lease, feed, false).is_err());
    assert_eq!(*tap.running.lock().unwrap(), None);
}

#[test]
fn a_capture_starting_stops_a_replaced_sessions_tap_too() {
    let tap = Arc::new(FakeRefTap::default());
    let voice = VoiceService::with_controls(Box::new(FakeMic::default()), Box::new(tap.clone()));
    let (old, _rx) = start(&voice, "s1", "main");
    let feed = Arc::new(crate::audio::tap::TapSlot::new());
    voice.ref_tap().start(old.token, &old.lease, feed.clone(), false).unwrap();
    // Replaced: the new session hasn't started a tap of its own yet, the
    // old one's teardown hasn't run, so the old tap still runs.
    let (new, _rx2) = session(&voice, "s2", "main");
    voice.admit(false, new.clone(), voice.page_generation("main")).unwrap().expect("replaced");
    assert_eq!(*tap.running.lock().unwrap(), Some(old.token));
    assert!(voice.end_now(EndReason::Recording));
    assert_eq!(*tap.running.lock().unwrap(), None, "never two taps: the replaced session's goes too");
    // And neither session can bring one back.
    assert!(voice.ref_tap().start(old.token, &old.lease, feed.clone(), false).is_err());
    assert!(voice.ref_tap().start(new.token, &new.lease, feed.clone(), false).is_err());
    // Even with no live session at all, a capture start stops a straggler.
    voice.deregister(new.token);
    *tap.running.lock().unwrap() = Some(old.token);
    assert!(!voice.end_now(EndReason::Recording));
    assert_eq!(*tap.running.lock().unwrap(), None);
}

#[test]
fn the_owners_page_going_away_ends_its_session_only() {
    let r = rig();
    let (_a, mut rx) = start(&r.voice, "s1", "main");
    assert!(!r.voice.end_for_page("workspace-2"));
    assert!(rx.try_recv().is_err());
    assert!(r.voice.end_for_page("main"));
    assert_eq!(rx.try_recv().unwrap(), Ctl::End(EndReason::Page));
    assert_eq!(r.releases.load(Ordering::SeqCst), 0, "the session releases the mic itself");
}

#[test]
fn commands_reach_only_their_session() {
    let r = rig();
    let (_a, mut rx) = start(&r.voice, "s1", "main");
    assert!(!r.voice.send("nope", Ctl::Stop), "unknown session: a no-op");
    assert!(rx.try_recv().is_err());
    assert!(r.voice.send("s1", Ctl::Mute(true)));
    assert!(r.voice.send("s1", Ctl::Stop));
    assert_eq!(rx.try_recv().unwrap(), Ctl::Mute(true));
    assert_eq!(rx.try_recv().unwrap(), Ctl::Stop);
}

/// `voice_set_barge`: a live conversation or interactive session gets the
/// policy; a dictation, an unknown session, a session gone since, or a policy
/// this desktop doesn't know are errors (the web reads them).
#[test]
fn set_barge_reaches_a_conversation_or_interactive_session_only() {
    use super::commands::set_barge;
    use super::turn::BargePolicy;
    let r = rig();
    let (mut a, mut rx) = session(&r.voice, "int", "main");
    a.mode = Mode::Interactive;
    assert!(r.voice.admit(false, a.clone(), r.voice.page_generation("main")).unwrap().is_none());
    assert_eq!(set_barge(&r.voice, "int", "speech"), Ok(()));
    assert_eq!(set_barge(&r.voice, "int", "wake"), Ok(()));
    assert_eq!(set_barge(&r.voice, "int", "off"), Ok(()));
    assert_eq!(rx.try_recv().unwrap(), Ctl::Barge(BargePolicy::Speech));
    assert_eq!(rx.try_recv().unwrap(), Ctl::Barge(BargePolicy::Wake));
    assert_eq!(rx.try_recv().unwrap(), Ctl::Barge(BargePolicy::Off));
    let err = set_barge(&r.voice, "int", "shout").unwrap_err();
    assert!(err.starts_with("invalid: "), "{err}");
    assert_eq!(set_barge(&r.voice, "nope", "wake"), Err("unknown_session".into()));
    assert!(rx.try_recv().is_err(), "nothing sent for a refusal");
    // The session's actor is gone (its receiver dropped) but not yet
    // deregistered: unknown, not Ok.
    drop(rx);
    assert_eq!(set_barge(&r.voice, "int", "wake"), Err("unknown_session".into()));
    r.voice.deregister(a.token);

    // A conversation takes it too; a dictation has no barge-in.
    let (_c, mut rx) = start(&r.voice, "conv", "main");
    assert_eq!(set_barge(&r.voice, "conv", "wake"), Ok(()));
    assert_eq!(rx.try_recv().unwrap(), Ctl::Barge(BargePolicy::Wake));
    let (mut d, _rx) = session(&r.voice, "dict", "main");
    d.mode = Mode::Dictation;
    r.voice.admit(false, d, r.voice.page_generation("main")).unwrap();
    let err = set_barge(&r.voice, "dict", "wake").unwrap_err();
    assert!(err.starts_with("unsupported: "), "{err}");
}

fn start_replacing(voice: &VoiceService, id: &str, owner: &str) -> (Active, mpsc::UnboundedReceiver<Ctl>) {
    let (active, rx) = session(voice, id, owner);
    assert!(voice.admit(false, active.clone(), voice.page_generation(owner)).unwrap().is_some());
    (active, rx)
}

#[test]
fn deregister_only_removes_its_own_token() {
    let r = rig();
    let (old, _rx1) = start(&r.voice, "s1", "main");
    // Replaced by a newer session of the same webview.
    let (new, _rx2) = start_replacing(&r.voice, "s2", "main");
    // The old session's teardown must not unregister the new one.
    r.voice.deregister(old.token);
    assert!(r.voice.find("s2").is_some());
    r.voice.deregister(new.token);
    assert!(r.voice.find("s2").is_none());
    assert!(!r.voice.busy_for("other"));
}

/// Admit a `mode` session for `owner`, as `voice_start` does (replacing its own, if any).
fn start_mode(voice: &VoiceService, id: &str, owner: &str, mode: Mode) -> (Active, mpsc::UnboundedReceiver<Ctl>) {
    let (mut active, rx) = session(voice, id, owner);
    active.mode = mode;
    voice.admit(false, active.clone(), voice.page_generation(owner)).unwrap();
    (active, rx)
}

#[test]
fn interactive_starts_again_unfocused_once_just_after_a_dictation_took_its_mic() {
    use super::INTERACTIVE_RESTART_WINDOW as WINDOW;
    let r = rig();
    let t0 = std::time::Instant::now();
    let (_i, _rxi) = start_mode(&r.voice, "int", "main", Mode::Interactive);
    assert!(!r.voice.interactive_restart_at("main", t0), "a running Interactive grants nothing");
    // A dictation of the same webview takes the mic: nothing yet, while it runs.
    let (d, _rxd) = start_mode(&r.voice, "dict", "main", Mode::Dictation);
    assert!(!r.voice.interactive_restart_at("main", t0));
    // It ends: one unfocused start, within the window, for that webview only.
    r.voice.deregister_at(d.token, t0);
    assert!(r.voice.interactive_restart_at("main", t0 + WINDOW - std::time::Duration::from_secs(1)));
    assert!(!r.voice.interactive_restart_at("main", t0 + WINDOW), "too late");
    assert!(!r.voice.interactive_restart_at("workspace-1", t0));
    // Once: the restart takes it.
    let (i2, _rxi2) = start_mode(&r.voice, "int-2", "main", Mode::Interactive);
    assert!(!r.voice.interactive_restart_at("main", t0));
    r.voice.deregister_at(i2.token, t0);
    assert!(!r.voice.interactive_restart_at("main", t0), "an Interactive end grants nothing");
}

#[test]
fn every_other_end_of_interactive_leaves_no_unfocused_restart() {
    let t0 = std::time::Instant::now();
    // Stopped, cancelled or ended on its own: deregistered, nothing granted.
    let r = rig();
    let (i, _rx) = start_mode(&r.voice, "int", "main", Mode::Interactive);
    r.voice.deregister_at(i.token, t0);
    assert!(!r.voice.interactive_restart_at("main", t0));
    // Replaced by a conversation, not a dictation.
    let r = rig();
    let (_i, _rx) = start_mode(&r.voice, "int", "main", Mode::Interactive);
    let (c, _rxc) = start_mode(&r.voice, "conv", "main", Mode::Conversation);
    r.voice.deregister_at(c.token, t0);
    assert!(!r.voice.interactive_restart_at("main", t0));
    // Its page went away (load, navigation, close, hide), during the dictation or after it.
    for after in [false, true] {
        let r = rig();
        let (_i, _rx) = start_mode(&r.voice, "int", "main", Mode::Interactive);
        let (d, _rxd) = start_mode(&r.voice, "dict", "main", Mode::Dictation);
        if after {
            r.voice.deregister_at(d.token, t0);
        }
        r.voice.end_for_page("main");
        r.voice.deregister_at(d.token, t0);
        assert!(!r.voice.interactive_restart_at("main", t0), "after: {after}");
    }
    // A capture taking the mic.
    let r = rig();
    let (_i, _rx) = start_mode(&r.voice, "int", "main", Mode::Interactive);
    let (d, _rxd) = start_mode(&r.voice, "dict", "main", Mode::Dictation);
    r.voice.end_now(super::events::EndReason::Recording);
    r.voice.deregister_at(d.token, t0);
    assert!(!r.voice.interactive_restart_at("main", t0));
    // The dictation itself replaced (another panel of the webview): the grant goes with it.
    let r = rig();
    let (_i, _rx) = start_mode(&r.voice, "int", "main", Mode::Interactive);
    let (d, _rxd) = start_mode(&r.voice, "dict", "main", Mode::Dictation);
    let (c, _rxc) = start_mode(&r.voice, "conv", "main", Mode::Conversation);
    r.voice.deregister_at(d.token, t0);
    r.voice.deregister_at(c.token, t0);
    assert!(!r.voice.interactive_restart_at("main", t0));
}

#[test]
fn a_press_ending_reaches_only_its_own_webviews_session() {
    let r = rig();
    assert!(!r.voice.send_owned("dictate", Ctl::Cancel), "nothing live");
    let (a, mut rx) = start_mode(&r.voice, "dict", "dictate", Mode::Dictation);
    assert!(!r.voice.send_owned("main", Ctl::Cancel));
    assert!(rx.try_recv().is_err());
    assert!(r.voice.send_owned("dictate", Ctl::Stop));
    assert_eq!(rx.try_recv().unwrap(), Ctl::Stop);
    r.voice.deregister(a.token);
    assert!(!r.voice.send_owned("dictate", Ctl::Cancel));
}

#[test]
fn live_while_a_session_is_registered_through_a_replace() {
    let r = rig();
    assert!(!r.voice.live());
    let (old, _rx1) = start(&r.voice, "s1", "main");
    assert!(r.voice.live());
    let (new, _rx2) = start_replacing(&r.voice, "s2", "main");
    // The replaced session's teardown leaves the new one's mic showing.
    r.voice.deregister(old.token);
    assert!(r.voice.live());
    r.voice.deregister(new.token);
    assert!(!r.voice.live());
}

#[test]
fn a_lease_is_taken_once() {
    let lease = MicLease::new();
    assert!(lease.held());
    assert!(lease.take());
    assert!(!lease.take());
}

// ─── VL-1: the page going away while a start is in flight ───────────────────

#[test]
fn a_page_that_went_away_during_the_start_is_refused_and_nothing_is_registered() {
    // voice_start reads the generation on entry, then awaits (VAD probe, TCC
    // prompt, mic reopen). Meanwhile the page reloads: end_for_page finds no
    // session yet, but bumps the generation.
    let r = rig();
    let page = r.voice.page_generation("main");
    assert!(!r.voice.end_for_page("main"), "nothing registered yet");
    let (active, mut rx) = session(&r.voice, "s1", "main");
    assert_eq!(r.voice.admit(false, active.clone(), page).unwrap_err(), Refusal::PageGone);
    assert!(r.voice.find("s1").is_none(), "no orphan session");
    assert!(!r.voice.busy_for("workspace-2"), "and no one else is told busy");
    assert!(active.lease.held(), "the mic was never started: nothing to release");
    assert!(rx.try_recv().is_err());
    assert_eq!(Refusal::PageGone.code(), "unavailable");
    // The reloaded page starts fine at the new generation.
    let (again, _rx) = session(&r.voice, "s2", "main");
    assert!(r.voice.admit(false, again, r.voice.page_generation("main")).unwrap().is_none());
    assert!(r.voice.find("s2").is_some());
}

#[test]
fn a_closed_window_refuses_its_start_and_keeps_other_webviews_free() {
    let r = rig();
    let page = r.voice.page_generation("workspace-2");
    // Another webview's page coming and going doesn't touch this start.
    r.voice.end_for_page("main");
    // The popout is closed (Destroyed) while its start is in flight.
    r.voice.end_for_page("workspace-2");
    let (active, _rx) = session(&r.voice, "s1", "workspace-2");
    assert_eq!(r.voice.admit(false, active, page).unwrap_err(), Refusal::PageGone);
    // Nothing was left behind to answer `busy` to the main window.
    let (m, _rx) = session(&r.voice, "s2", "main");
    assert!(r.voice.admit(false, m, r.voice.page_generation("main")).unwrap().is_none());
}

#[test]
fn a_page_going_away_after_the_session_registered_ends_it() {
    // The other side of the race: registration won, so end_for_page finds the
    // session and ends it (it releases the mic itself).
    let r = rig();
    let (_a, mut rx) = start(&r.voice, "s1", "main");
    assert!(r.voice.end_for_page("main"));
    assert_eq!(rx.try_recv().unwrap(), Ctl::End(EndReason::Page));
    // A second start that read the generation before the reload is refused.
    let (b, _rx) = session(&r.voice, "s2", "main");
    assert_eq!(r.voice.admit(false, b, 0).unwrap_err(), Refusal::PageGone);
}

#[test]
fn the_page_race_under_threads_never_leaves_a_session_behind() {
    // Many interleavings of a start (generation read, then admit) against a
    // reload of the same page: either the start is refused, or it registered
    // before the reload and the reload ended it. Never a live session with no
    // end sent.
    use std::sync::Barrier;
    for _ in 0..200 {
        let r = rig();
        let voice = Arc::new(r.voice);
        let page = voice.page_generation("main");
        let barrier = Arc::new(Barrier::new(2));
        let (active, mut rx) = session(&voice, "s1", "main");
        let starter = {
            let (voice, barrier) = (voice.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                voice.admit(false, active, page)
            })
        };
        let reloader = {
            let (voice, barrier) = (voice.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                voice.end_for_page("main")
            })
        };
        let admitted = starter.join().unwrap();
        let ended = reloader.join().unwrap();
        match admitted {
            Err(Refusal::PageGone) => {
                assert!(!ended);
                assert!(voice.find("s1").is_none());
            }
            Ok(None) => {
                assert!(ended, "registered first, so the reload found it");
                assert_eq!(rx.try_recv().unwrap(), Ctl::End(EndReason::Page));
            }
            other => panic!("{other:?}"),
        }
    }
}

// ─── VL-2: close-to-tray ends the voice session ──────────────────────────────

#[test]
fn close_to_tray_ends_the_voice_session_before_hiding() {
    // lib.rs's CloseRequested arm hides "main" instead of closing it, so no
    // page load or Destroyed ever ends its voice session. It must end it
    // itself, before either hide (the fullscreen one and the plain one).
    let lib = include_str!("../lib.rs");
    let start = lib.find("if let tauri::WindowEvent::CloseRequested { api, .. } = event {").expect("the close arm");
    let end = start + lib[start..].find("// If the window that OWNS the active recording").expect("the arm's end");
    let arm = &lib[start..end];
    let ends = arm.find("voice::end_for_page(window.app_handle(), window.label());").expect("ends the voice session");
    let prevent = arm.find("api.prevent_close();").unwrap();
    assert!(prevent < ends);
    let hides: Vec<usize> = arm.match_indices(".hide()").map(|(i, _)| i).collect();
    assert_eq!(hides.len(), 2, "the fullscreen and the plain hide");
    assert!(hides.iter().all(|&h| h > ends), "the session ends before any hide");
}

// ─── VL-3: one lock order app-wide ──────────────────────────────────────────

#[test]
fn every_blocking_lock_path_follows_the_documented_order() {
    // voice/mod.rs: dual_stream → mic_capture → system_capture → session.
    // stop_recording used to take the mic first, which could deadlock against
    // a voice start holding the dual stream and waiting for the mic. Every
    // function in the files that take these locks must take them (blocking
    // `.lock()`; `try_lock` can't deadlock) in non-decreasing rank.
    let ranks = [
        (".dual_stream.lock()", 0),
        (".mic_capture.lock()", 1),
        (".system_capture.lock()", 2),
        ("state.session.lock()", 3),
    ];
    let files = [
        ("commands/recording.rs", include_str!("../commands/recording.rs")),
        ("voice/commands.rs", include_str!("commands.rs")),
        ("voice/mod.rs", include_str!("mod.rs")),
        ("modules/tts.rs", include_str!("../modules/tts.rs")),
        ("audio/session.rs", include_str!("../audio/session.rs")),
        ("audio/capture_aec.rs", include_str!("../audio/capture_aec.rs")),
    ];
    let mut checked = 0;
    for (name, src) in files {
        // Top-level and impl functions: split at every `fn ` that starts a
        // line (after indentation and qualifiers).
        let mut bodies: Vec<(String, String)> = Vec::new();
        for line in src.lines() {
            let t = line.trim_start();
            let t = t.strip_prefix("pub(crate) ").or_else(|| t.strip_prefix("pub ")).unwrap_or(t);
            let t = t.strip_prefix("async ").unwrap_or(t);
            if let Some(rest) = t.strip_prefix("fn ") {
                bodies.push((rest.split('(').next().unwrap_or("").to_string(), String::new()));
            }
            if let Some((_, body)) = bodies.last_mut() {
                body.push_str(line);
                body.push('\n');
            }
        }
        for (func, body) in bodies {
            let mut seen: Vec<(usize, &str, i32)> = Vec::new();
            for (needle, rank) in ranks {
                seen.extend(body.match_indices(needle).map(|(at, _)| (at, needle, rank)));
            }
            seen.sort();
            if seen.len() > 1 {
                checked += 1;
            }
            for pair in seen.windows(2) {
                assert!(
                    pair[0].2 <= pair[1].2,
                    "{name} {func}: {} after {} breaks the lock order (voice/mod.rs)",
                    pair[1].1,
                    pair[0].1
                );
            }
        }
    }
    // start/stop/pause/resume_recording, recover_mic and the voice start at
    // least (get_audio_levels only try_locks: it runs on the main thread).
    assert!(checked >= 6, "only {checked} multi-lock functions found: the scan is broken");
}
