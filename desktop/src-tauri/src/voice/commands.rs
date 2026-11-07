//! The voice bridge commands (chat-voice.md §3.3). Arguments are flat and
//! camelCase on the web (`voice_start { sessionId, mode, endSilenceMs?,
//! bargeIn?, noiseProfile? }`); Tauri maps them onto these snake_case
//! parameters (and ignores keys it doesn't know, so an older desktop drops
//! `noiseProfile`; the web only offers it when `voice_status` lists
//! `noiseProfiles`). Errors are
//! string codes, `code` or `code: detail`: `recording`, `busy`, `not_ready`,
//! `mic_denied`, `unavailable`.
//!
//! Interactive mode (the interactive-mode spec's desktop ⇄ web contract):
//! - `voice_status { interactive: true }`: this desktop understands
//!   `voice_start { mode: "interactive" }` and `voice_set_barge` (a
//!   capability, like `readyFlag`; whether the pieces are there is
//!   `conversation`, which an interactive session needs exactly). An older
//!   desktop has no key, and the web keeps Interactive to reading only.
//! - `voice_start { sessionId, mode: "interactive", endSilenceMs?,
//!   noiseProfile? }`: a conversation that never idle-ends, starts on the
//!   `wake` barge policy (`bargeIn` is ignored) and feeds local-stt around
//!   speech only; same refusals as a conversation.
//! - `voice_set_barge { sessionId, policy: "speech" | "wake" | "off" }`
//!   ([`super::turn::BargePolicy`]): a conversation or interactive session,
//!   any time. Errors: `unknown_session` (no such live session),
//!   `invalid: …` (another policy), `unsupported: …` (a dictation).
//!
//! Voice focus (the web checks each turn's voice against the user's
//! voiceprint):
//! - `voice_status { speechAudio: true }`: a capability, like `readyFlag`;
//! - `voice_start { …, speechAudio?: bool }`: true makes a conversation or
//!   interactive session emit `voice://speech` ([`super::speech`]): each
//!   candidate turn's audio from its onset (less the onset slack), in
//!   `{ sessionId, turnId, seq, startMs, sampleRate: 16000, pcm, end: false }`
//!   chunks of ~500 ms (the first 8 s only), then `{ sessionId, turnId, seq,
//!   end: true, outcome: "turn" | "abandoned" }`, a turn's before its
//!   `voice://turn`. Never written to disk;
//! - `voice_log { sessionId, line }`: one sanitised `[voice-focus]` line in
//!   the debug log.
//!
//! The lid: with the MacBook's lid closed and its built-in mic the only one,
//! `voice_start` refuses `unavailable: lid_closed` (that mic would open and
//! hear exact zeros; `audio::lid`).
//!
//! Who asks: `voice_start` refuses `unavailable: …` for a window that isn't
//! on screen, or not in front (but Interactive starting again once, just
//! after a dictation of its webview took the mic from it), and for Dictate
//! anywhere's panel unless a right ⌥ press is listening and it asks for a
//! dictation ([`may_listen`]). The panel's session ends when the press does
//! (dictate.rs).

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::mpsc;

use super::capture::{self, Capture};
use super::dsp::{self, DspParts, DspShared};
use super::events::EchoMode;
use super::levels;
use super::profile::NoiseProfile;
use super::session::{self, SessionCtx, TtsSpeech};
use super::turn::{BargePolicy, Machine, Mode, TurnConfig, DEFAULT_END_SILENCE_MS, MAX_END_SILENCE_MS, MIN_END_SILENCE_MS};
use super::{Active, Ctl, MicLease, Refusal, VoiceService};
use crate::audio::tap::{tap_channel, TapSlot, TapWriter};
use crate::modules::manager::ModuleState;
use crate::modules::tts::TtsService;
use crate::modules::{stt, tts, ModuleManager};

/// Tap rings: ~1 s at 96 kHz, 2 s at 48 kHz. The DSP thread drains every
/// ~5 ms, so this only fills if it stalls.
const TAP_CAPACITY: usize = 96_000;

// ─── arguments ──────────────────────────────────────────────────────────────

/// `voice_start`'s arguments, as the web sends them.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    pub session_id: String,
    pub mode: String,
    #[serde(default)]
    pub end_silence_ms: Option<f64>,
    #[serde(default)]
    pub barge_in: Option<bool>,
    /// `"auto"` | `"quiet"` | `"noisy"`; absent or unknown is quiet (the
    /// web sends auto by default, an older web nothing).
    #[serde(default)]
    pub noise_profile: Option<String>,
    /// Emit each candidate turn's audio as `voice://speech` (Voice focus:
    /// the web checks it against the user's voiceprint). Absent: false.
    #[serde(default)]
    pub speech_audio: Option<bool>,
}

/// A checked start request.
#[derive(Debug, Clone, PartialEq)]
pub struct StartRequest {
    pub session_id: String,
    pub mode: Mode,
    pub end_silence_ms: u32,
    pub barge_in: bool,
    pub noise_profile: NoiseProfile,
    /// `voice://speech` for a conversation or an interactive session (a
    /// dictation has no turns: it ignores it). Never written to disk.
    pub speech_audio: bool,
}

pub fn parse_mode(mode: &str) -> Option<Mode> {
    Mode::from_name(mode)
}

impl StartArgs {
    /// Defaults: 700 ms, barge-in on, the quiet room. `endSilenceMs` is
    /// clamped to 200..=3000 and rounded; a non-finite one is the default. An
    /// unknown `noiseProfile` is the quiet room (a newer web asking for a
    /// preset this desktop doesn't have). An interactive session starts on
    /// the `wake` barge policy whatever `bargeIn` says
    /// ([`BargePolicy::initial`]).
    pub fn validate(self) -> Result<StartRequest, String> {
        let session_id = self.session_id.trim().to_string();
        if session_id.is_empty() {
            return Err(Refusal::Unavailable.with("missing sessionId"));
        }
        let mode = parse_mode(&self.mode).ok_or_else(|| Refusal::Unavailable.with(format!("unknown mode {:?}", self.mode)))?;
        let end_silence_ms = match self.end_silence_ms {
            Some(ms) if ms.is_finite() => ms.round().clamp(MIN_END_SILENCE_MS as f64, MAX_END_SILENCE_MS as f64) as u32,
            _ => DEFAULT_END_SILENCE_MS,
        };
        Ok(StartRequest {
            session_id,
            mode,
            end_silence_ms,
            barge_in: self.barge_in.unwrap_or(true),
            noise_profile: NoiseProfile::parse(self.noise_profile.as_deref()),
            speech_audio: self.speech_audio.unwrap_or(false) && mode.converses(),
        })
    }
}

// ─── voice_status ───────────────────────────────────────────────────────────

/// One local module, as far as voice cares.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModuleView {
    pub state: Option<ModuleState>,
    /// Enabled, ready and launchable (`ModuleManager::launch_config`).
    pub launchable: bool,
}

/// `ready | missing | downloading | unsupported | error`.
pub fn module_state(m: ModuleView) -> &'static str {
    if m.launchable {
        return "ready";
    }
    match m.state {
        None | Some(ModuleState::Unavailable) => "unsupported",
        Some(ModuleState::Downloading | ModuleState::Verifying | ModuleState::Warming) => "downloading",
        Some(ModuleState::Error) => "error",
        // Off, or "ready" but not launchable (disabled, assets gone).
        Some(ModuleState::Off | ModuleState::Ready) => "missing",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub available: bool,
    pub dictation: bool,
    pub conversation: bool,
    pub stt: &'static str,
    pub tts: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The `noiseProfile`s `voice_start` understands (its presence is the
    /// web's capability check for the "Background noise" setting).
    pub noise_profiles: &'static [&'static str],
    /// `voice://state` carries `ready` (local-stt ready and the DSP up): the
    /// web's cue for its start sounds, instead of inferring it from the
    /// first state past `starting`.
    pub ready_flag: bool,
    /// This desktop runs `voice_start { mode: "interactive" }` and
    /// `voice_set_barge` (a capability: true wherever voice is `available`;
    /// readiness is `conversation`, the same pieces).
    pub interactive: bool,
    /// This desktop understands `voice_start { speechAudio: true }` and emits
    /// `voice://speech` (a capability, like `readyFlag`). An older desktop
    /// has no key.
    pub speech_audio: bool,
}

/// dictation = local-stt ready; conversation = local-stt and local-tts
/// ready and a VAD (`vad`: `None` = not probed because a module is missing).
/// `reason` is the first thing missing.
pub fn compute_status(available: bool, stt: ModuleView, tts: ModuleView, vad: Option<&Result<(), String>>) -> VoiceStatus {
    let (stt_state, tts_state) = (module_state(stt), module_state(tts));
    let mut status = VoiceStatus {
        available,
        dictation: false,
        conversation: false,
        stt: stt_state,
        tts: tts_state,
        reason: None,
        noise_profiles: &NoiseProfile::NAMES,
        ready_flag: true,
        interactive: available,
        speech_audio: true,
    };
    if !available {
        status.reason = Some("Chat voice needs the Dial8 desktop app for macOS".into());
        return status;
    }
    if !stt.launchable {
        status.reason = Some(format!("On-device transcription (local-stt) is {stt_state}"));
        return status;
    }
    status.dictation = true;
    if !tts.launchable {
        status.reason = Some(format!("On-device speech (local-tts) is {tts_state}"));
        return status;
    }
    match vad {
        Some(Ok(())) => status.conversation = true,
        Some(Err(e)) => status.reason = Some(format!("The voice activity detector is unavailable: {e}")),
        None => status.reason = Some("The voice activity detector was not checked".into()),
    }
    status
}

fn module_view(app: &AppHandle, id: &str) -> ModuleView {
    let modules = app.state::<ModuleManager>();
    ModuleView { state: modules.state(id), launchable: modules.launch_config(app, id).is_some() }
}

async fn status_now(app: &AppHandle) -> VoiceStatus {
    let (stt, tts) = (module_view(app, stt::MODULE_ID), module_view(app, tts::MODULE_ID));
    // The VAD is only probed once both modules are there (building it may
    // load a runtime); the probe is cached.
    let vad = if stt.launchable && tts.launchable {
        let app = app.clone();
        Some(
            tauri::async_runtime::spawn_blocking(move || app.state::<VoiceService>().vad_probe().clone())
                .await
                .unwrap_or_else(|_| Err("the probe failed".into())),
        )
    } else {
        None
    };
    compute_status(cfg!(target_os = "macos"), stt, tts, vad.as_ref())
}

#[tauri::command]
pub async fn voice_status(app: AppHandle) -> VoiceStatus {
    status_now(&app).await
}

// ─── voice_start ────────────────────────────────────────────────────────────

/// Where a `voice_start` came from, as far as opening the mic goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Asker {
    /// Dictate anywhere's panel (dictate.rs): `pressed`, right ⌥'s press is listening.
    Panel { pressed: bool },
    /// Any other window: on screen (visible, not minimised), in front, and
    /// whether its webview may start Interactive again once unfocused
    /// ([`VoiceService::interactive_restart`]).
    Window { shown: bool, focused: bool, interactive_restart: bool },
}

/// Whether `asker` may open the mic for `mode` (security review 2026-10-31
/// P1-5: a page is the server's code, and a start from a window the person
/// can't see would listen unseen). The panel only for the press listening
/// now (it listens before it shows, and never has focus, but the press is
/// native), and only a dictation: a tap and a hold both dictate there, the
/// hold's words going to the agent (talk_send); the agent's reply is the main
/// window's. Any other window only on screen and in front (a click there
/// started it), whatever the mode the page names. One exception: Interactive
/// starting again by itself once, just after a dictation of the same webview
/// took the mic from it. The menu bar shows the mic either way (tray.rs). The
/// refusal's detail, for the log and the web. Pure.
pub fn may_listen(asker: Asker, mode: Mode) -> Result<(), &'static str> {
    match asker {
        Asker::Panel { pressed: false } => Err("no right ⌥ press is listening"),
        Asker::Panel { pressed: true } if mode == Mode::Dictation => Ok(()),
        Asker::Panel { pressed: true } => Err("the right ⌥ panel only dictates"),
        Asker::Window { shown: false, .. } => Err("the window that asked isn't on screen"),
        Asker::Window { focused: true, .. } => Ok(()),
        Asker::Window { interactive_restart: true, .. } if mode == Mode::Interactive => Ok(()),
        Asker::Window { .. } => Err("the window that asked isn't in front"),
    }
}

/// The [`Asker`] for webview `label`: the panel by its press (`pressed`, read
/// only for it), any other by its window (`window`: on screen, in front; read
/// only for one). Pure but for the two readers.
pub fn asker_for(label: &str, interactive_restart: bool, pressed: impl FnOnce() -> bool, window: impl FnOnce() -> (bool, bool)) -> Asker {
    if label == crate::dictate::PANEL {
        return Asker::Panel { pressed: pressed() };
    }
    let (shown, focused) = window();
    Asker::Window { shown, focused, interactive_restart }
}

/// The webview's window on screen (visible, not minimised), and in front.
fn window_state(webview: &tauri::Webview) -> (bool, bool) {
    let window = webview.window();
    (window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true), window.is_focused().unwrap_or(false))
}

/// The webview asking, as [`may_listen`] reads it.
fn asker(voice: &VoiceService, webview: &tauri::Webview) -> Asker {
    let label = webview.label();
    asker_for(label, voice.interactive_restart(label), crate::dictate::mic_wanted, || window_state(webview))
}

/// The mic may be used: TCC granted, or granted now at the system prompt.
/// A denied mic is invisible to cpal (it records zeros), hence the check.
async fn mic_allowed() -> bool {
    use crate::commands::recording::{check_mic_permission, request_mic_permission};
    match check_mic_permission().as_deref() {
        Ok("denied") | Ok("restricted") => false,
        Ok("not-determined") => matches!(request_mic_permission().await.as_deref(), Ok("granted")),
        _ => true,
    }
}

/// What the mic start hands back.
struct MicStarted {
    fault: Arc<AtomicBool>,
    rate: Option<u32>,
    /// MicCapture's live-switch epoch (odd while a switch runs).
    switch_epoch: Arc<std::sync::atomic::AtomicU64>,
}

/// The voice start's locked section (see the lock order in `voice/mod.rs`).
/// Under the recording and mic locks, in that order (like
/// `start_recording`, which ends any voice session holding the first):
/// refuse during a capture, for another webview's session or when the page
/// went away since `page` was read; otherwise register the session (taking
/// over this webview's own), all in [`VoiceService::admit`]. Then the
/// recording lock goes, before the slow part: start the mic without a WAV on
/// the preferred device (else the default) and install the raw tap, under the
/// mic lock only. Blocking.
fn start_mic(
    app: &AppHandle,
    active: Active,
    page: u64,
    writer: TapWriter,
    preferred: Option<crate::audio::input_devices::InputTarget>,
) -> (Option<Active>, Result<MicStarted, String>) {
    use crate::audio::dual_stream::DualStreamState;
    // A stuck coreaudiod (audio::health) would hang the mic open below with
    // the recording locks held: refuse in seconds instead.
    if let Err(e) = crate::audio::health::ensure_answering() {
        crate::log_to_file(&format!("[voice] {} refused: {e}", active.session_id));
        return (None, Err(Refusal::Unavailable.with(&e)));
    }
    // Belt and braces for the page generation: the webview itself must still
    // be there (a destroyed popout's label may never come back).
    if app.get_webview_window(&active.owner).is_none() {
        crate::log_to_file(&format!("[voice] {} refused: webview {:?} is gone", active.session_id, active.owner));
        return (None, Err(Refusal::PageGone.with("the page that asked went away")));
    }
    let state = app.state::<crate::state::AppState>();
    let voice = app.state::<VoiceService>();
    let token = active.token;
    let lease = active.lease.clone();
    let session_id = active.session_id.clone();
    let dual = state.dual_stream.lock().unwrap_or_else(|p| p.into_inner());
    let recording = dual.state != DualStreamState::Inactive;
    let mut mic = state.mic_capture.lock().unwrap_or_else(|p| p.into_inner());
    let replaced = match voice.admit(recording, active, page) {
        Ok(replaced) => replaced,
        Err(Refusal::PageGone) => {
            crate::log_to_file(&format!("[voice] {session_id} refused: its page went away during the start"));
            return (None, Err(Refusal::PageGone.with("the page that asked went away")));
        }
        Err(refusal) => return (None, Err(refusal.code().to_string())),
    };
    // Registered: from here a capture start ends this session itself
    // (end_for_recording waits for the mic lock, then stops the mic), so the
    // recording lock needn't be held across the mic start.
    drop(dual);
    let mut started = mic.start(preferred.as_ref(), None);
    if let (Err(e), Some(t)) = (&started, preferred.as_ref()) {
        // Not onto a default the lid made unavailable (exact zeros).
        if crate::audio::input_devices::default_unavailable() {
            crate::log_to_file(&format!("[voice] mic {:?} failed ({e}); the default is the MacBook mic and the lid is closed", t.name));
            started = Err(format!("{e} (and the lid is closed)"));
        } else {
            crate::log_to_file(&format!("[voice] mic {:?} failed ({e}); trying the default", t.name));
            started = mic.start(None, None);
        }
    }
    if let Err(e) = started {
        crate::log_to_file(&format!("[voice] mic start failed: {e}"));
        // Release the mic as the session's own teardown would (a replaced
        // session's stream may be what's left running).
        if lease.take() {
            drop(mic.remove_raw_tap());
            if let Err(e) = mic.stop() {
                crate::log_to_file(&format!("[voice] mic stop failed: {e}"));
            }
        }
        voice.deregister(token);
        return (replaced, Err(Refusal::Unavailable.with(format!("the microphone could not start: {e}"))));
    }
    drop(mic.install_raw_tap(writer));
    let out = MicStarted { fault: mic.fault_handle(), rate: mic.device_rate(), switch_epoch: mic.switch_epoch_handle() };
    drop(mic);
    (replaced, Ok(out))
}

#[tauri::command]
pub async fn voice_start(
    app: AppHandle,
    webview: tauri::Webview,
    session_id: String,
    mode: String,
    end_silence_ms: Option<f64>,
    barge_in: Option<bool>,
    noise_profile: Option<String>,
    speech_audio: Option<bool>,
) -> Result<(), String> {
    let asked_profile = noise_profile.clone();
    let req = StartArgs { session_id, mode, end_silence_ms, barge_in, noise_profile, speech_audio }.validate()?;
    let owner = webview.label().to_string();
    // Before the first await: a reload, navigation or close of this page from
    // here on makes the start refuse at admit (VoiceService::end_for_page).
    let page = app.state::<VoiceService>().page_generation(&owner);
    // Before the mic permission prompt too, which takes the focus.
    if let Err(why) = may_listen(asker(&app.state::<VoiceService>(), &webview), req.mode) {
        crate::log_to_file(&format!("[voice] {} refused: {why} ({owner:?})", req.session_id));
        return Err(Refusal::Unavailable.with(why));
    }

    let status = status_now(&app).await;
    if !status.available {
        return Err(Refusal::Unavailable.code().into());
    }
    let ready = match req.mode {
        Mode::Dictation => status.dictation,
        // (Interactive needs what a conversation does: both modules, a VAD.)
        Mode::Conversation | Mode::Interactive => status.conversation,
    };
    if !ready {
        return Err(Refusal::NotReady.with(status.reason.unwrap_or_default()));
    }
    let voice = app.state::<VoiceService>();
    if crate::modules::tts::recording_active(&app) {
        return Err(Refusal::Recording.code().into());
    }
    if voice.busy_for(&owner) {
        return Err(Refusal::Busy.code().into());
    }
    if !mic_allowed().await {
        return Err(Refusal::MicDenied.code().into());
    }
    let Some(launch) = app.state::<ModuleManager>().launch_config(&app, stt::MODULE_ID) else {
        return Err(Refusal::NotReady.with("On-device transcription (local-stt) is not ready"));
    };

    // Transcription first: it loads while the mic starts. Dropping the handle
    // on any refusal below closes it.
    let (stt_sink, stt_handle) = stt::start_voice(launch);
    let (mic_writer, mic_reader) = tap_channel(TAP_CAPACITY);
    let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
    let lease = Arc::new(MicLease::new());
    let token = voice.next_token();
    let active = Active {
        session_id: req.session_id.clone(),
        owner: owner.clone(),
        mode: req.mode,
        token,
        ctl: ctl_tx.clone(),
        lease: lease.clone(),
    };
    // The mic to open. With the lid closed and the MacBook mic the only one,
    // refuse: it would open and hear exact zeros (audio::lid). Store and
    // CoreAudio / IOKit reads, off the runtime, no AppState lock held.
    let preferred = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || crate::audio::input_devices::resolve_checked(&app))
            .await
            .unwrap_or(Ok(None))
    };
    let Ok(preferred) = preferred else {
        crate::log_to_file(&format!("[voice] {} refused: the lid is closed and the MacBook microphone is the only one", req.session_id));
        return Err(Refusal::Unavailable.with(crate::audio::lid::LID_CLOSED));
    };
    let joined = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || start_mic(&app, active, page, mic_writer, preferred)).await
    };
    let (replaced, started) = match joined {
        Ok(r) => r,
        Err(_) => {
            // The blocking start died part-way (it may have registered and
            // started the mic): undo whatever it got to.
            let app2 = app.clone();
            let lease2 = lease.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || app2.state::<VoiceService>().release_mic(&lease2)).await;
            voice.deregister(token);
            return Err(Refusal::Unavailable.with("the microphone start failed"));
        }
    };
    if let Some(old) = replaced {
        // Another panel of the same webview started over it: a dictation
        // keeps its words (ends as stopped with its text), a conversation is
        // cancelled.
        crate::log_to_file(&format!("[voice] {} replaces {} in {:?}", req.session_id, old.session_id, owner));
        let _ = old.ctl.send(Ctl::Replaced);
    }
    let started = started?;

    // The noisy room and Auto start from the level this mic remembers (WP7;
    // the session feeds it to the machine first thing); the quiet room never
    // looks. Store and CoreAudio reads, off the runtime, no
    // AppState lock held (start_mic has let go of them).
    let memory = if req.noise_profile.tuning().gate.is_some() {
        let app2 = app.clone();
        tauri::async_runtime::spawn_blocking(move || remembered_level(&app2)).await.ok()
    } else {
        None
    };
    if let Some(m) = &memory {
        crate::log_to_file(&format!("[voice] {} {}", req.session_id, m.note()));
    }

    // The reference, and TTS state.
    let tts = app.state::<TtsService>();
    let speaking = tts.subscribe_speaking();
    let (hold, ref_reader) = match req.mode {
        // Interactive holds it too: the reading (listen mode's section
        // player) plays through the same TTS output, and must stay in the
        // canceller's reference.
        Mode::Conversation | Mode::Interactive => {
            let (ref_writer, ref_reader) = tap_channel(TAP_CAPACITY);
            (Some(tts.hold_output(Some(ref_writer))), Some(ref_reader))
        }
        Mode::Dictation => {
            // Dictation never talks over read-aloud; its canceller runs with
            // zero reference frames, or the system audio alone on speakers.
            tts.cancel();
            (None, None)
        }
    };

    // The system-audio echo reference's tap (every mode): the session's
    // actor runs the system tap into it on speakers (voice/system_ref.rs);
    // until then, and without the permission, nothing arrives.
    let (system_writer, system_reader) = tap_channel(TAP_CAPACITY);
    let system_feed = Arc::new(TapSlot::new());
    drop(system_feed.replace(Some(system_writer)));

    let capture = start_capture(&app, &req);
    // Interactive: local-stt hears speech only, its clock mapped back for
    // the actor (voice/feed.rs).
    let (feed, feed_clock) = match req.mode {
        Mode::Interactive => {
            let (gate, clock) = dsp::feed_gate(req.end_silence_ms);
            (Some(gate), Some(clock))
        }
        Mode::Conversation | Mode::Dictation => (None, None),
    };
    let shared = Arc::new(DspShared::default());
    let (dsp_tx, dsp_rx) = mpsc::unbounded_channel();
    let parts = DspParts {
        mic: mic_reader,
        reference: ref_reader,
        system_reference: Some(system_reader),
        sink: Box::new(stt_sink),
        speech: Box::new(TtsSpeech { app: app.clone(), speaking: speaking.clone() }),
        shared: shared.clone(),
        events: dsp_tx,
        profile: req.noise_profile,
        capture: capture.clone(),
        feed,
        speech_audio: req.speech_audio,
    };
    let thread = match dsp::spawn(parts) {
        Ok(t) => t,
        Err(e) => {
            crate::log_to_file(&format!("[voice] DSP thread failed to start: {e}"));
            let app2 = app.clone();
            let lease2 = lease.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || app2.state::<VoiceService>().release_mic(&lease2)).await;
            voice.deregister(token);
            return Err(Refusal::Unavailable.with("the audio thread could not start"));
        }
    };

    crate::log_to_file(&format!(
        "[voice] {} started: {:?}, endSilenceMs={}, barge={}, sttFeed={}, noiseProfile={}{}, speechAudio={}, owner={:?}, mic {:?} Hz",
        req.session_id,
        req.mode,
        req.end_silence_ms,
        BargePolicy::initial(req.mode, req.barge_in).name(),
        if feed_clock.is_some() { "speech" } else { "all" },
        req.noise_profile.name(),
        profile_note(asked_profile.as_deref(), req.noise_profile),
        req.speech_audio,
        owner,
        started.rate
    ));
    let machine = Machine::new(
        TurnConfig::for_profile(req.mode, req.end_silence_ms, req.barge_in, req.noise_profile),
        EchoMode::Converging,
    );
    let ctx = SessionCtx {
        app: app.clone(),
        session_id: req.session_id,
        token,
        machine,
        stt: stt_handle,
        ctl: ctl_rx,
        ctl_tx,
        dsp_shared: shared,
        dsp_events: dsp_rx,
        dsp_thread: Some(thread),
        speaking,
        hold,
        mic_fault: started.fault,
        mic_switch_epoch: started.switch_epoch,
        lease,
        capture,
        levels: memory,
        feed_clock,
        speech_audio: req.speech_audio,
        system_feed,
    };
    tauri::async_runtime::spawn(session::run(ctx));
    // The menu bar says the mic is on now, not at its next check.
    crate::tray::refresh_mic(&app);
    Ok(())
}

/// The session's per-mic level memory: the stored levels and the device the
/// mic just opened (the in-use handle's UID, or the default input's), with
/// its input volume. Blocking.
fn remembered_level(app: &AppHandle) -> levels::Memory {
    levels::Memory::new(levels::load(app), levels::device_in_use(app), std::time::Instant::now())
}

/// The dev-only debug capture ([`capture`]), when `DIAL8_VOICE_CAPTURE` is
/// set in a debug build. Never on by default, never in a release build; a
/// failure to create it only logs.
fn start_capture(app: &AppHandle, req: &StartRequest) -> Option<Capture> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let base = capture::base_dir(std::env::var_os(capture::ENV), app.path().app_data_dir().ok())?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let dir = base.join(capture::session_dir_name(&stamp, &req.session_id));
    let header = serde_json::json!({
        "session_id": req.session_id,
        "mode": req.mode.name(),
        "end_silence_ms": req.end_silence_ms,
        "barge_in": req.barge_in,
        "barge": BargePolicy::initial(req.mode, req.barge_in).name(),
        "noise_profile": req.noise_profile.name(),
        "tuning": req.noise_profile.tuning().label,
        "app_version": env!("CARGO_PKG_VERSION"),
        "started": chrono::Local::now().to_rfc3339(),
        "sample_rate": super::SAMPLE_RATE,
    });
    match Capture::start(&dir, header) {
        Ok(cap) => {
            crate::log_to_file(&format!(
                "[voice] {} debug capture ON ({}) → {} (stops at 30 min / 500 MB)",
                req.session_id,
                capture::ENV,
                dir.display()
            ));
            Some(cap)
        }
        Err(e) => {
            crate::log_to_file(&format!("[voice] {} debug capture failed to start in {}: {e}", req.session_id, dir.display()));
            None
        }
    }
}

/// The start line's note when the web asked for something else than it got
/// (nothing, or a preset this desktop doesn't know).
fn profile_note(asked: Option<&str>, got: NoiseProfile) -> String {
    match asked {
        None => " (default)".into(),
        Some(a) if NoiseProfile::from_name(a) == Some(got) => String::new(),
        Some(a) => format!(" (asked {a:?}, unknown)"),
    }
}

// ─── stop, cancel, mute ─────────────────────────────────────────────────────

/// End gracefully (dictation: finalize, then `voice://ended` with the
/// text). A no-op for an unknown or finished session.
#[tauri::command]
pub fn voice_stop(voice: State<'_, VoiceService>, session_id: String) {
    voice.send(&session_id, Ctl::Stop);
}

/// End now, discarding what was heard.
#[tauri::command]
pub fn voice_cancel(voice: State<'_, VoiceService>, session_id: String) {
    voice.send(&session_id, Ctl::Cancel);
}

/// Gate the mic: no VAD, no transcription; the session stays open.
#[tauri::command]
pub fn voice_set_muted(voice: State<'_, VoiceService>, session_id: String, muted: bool) {
    voice.send(&session_id, Ctl::Mute(muted));
}

/// The agent speech about to play is an aside (voice mode's greeting, its
/// `text`): the user may talk over it on the headphones hint alone, and its
/// words heard back on the mic never make a turn (turn.rs). `false` takes
/// that back.
#[tauri::command]
pub fn voice_set_aside(voice: State<'_, VoiceService>, session_id: String, aside: bool, text: Option<String>) {
    voice.send(&session_id, Ctl::Aside { on: aside, text });
}

/// `voice_set_barge`'s checks and hand-over ([`voice_set_barge`]): the
/// policy must be one this desktop knows and the session a live
/// conversation or interactive one (a dictation has no barge-in).
pub fn set_barge(voice: &VoiceService, session_id: &str, policy: &str) -> Result<(), String> {
    let policy = BargePolicy::from_name(policy).ok_or_else(|| format!("invalid: unknown barge policy {policy:?}"))?;
    let live = voice.find(session_id).ok_or_else(|| "unknown_session".to_string())?;
    if !live.mode.converses() {
        return Err("unsupported: a dictation has no barge-in".into());
    }
    // (The session may have ended since the lookup: then it is unknown.)
    live.ctl.send(Ctl::Barge(policy)).map_err(|_| "unknown_session".to_string())
}

/// What the user talking over audible agent speech does from now on, in a
/// conversation or an interactive session (voice/turn.rs, "Barge policy"):
/// `speech` (barge-in: the speech stops, `voice://interrupted`, the turn
/// goes on), `wake` (the speech goes on; the user's turn is transcribed,
/// partials streaming, and sent at its end) or `off` (no turn). Takes effect
/// with the session's next input, a few ms later. Errors: `unknown_session`,
/// `invalid: …`, `unsupported: …`.
#[tauri::command]
pub fn voice_set_barge(voice: State<'_, VoiceService>, session_id: String, policy: String) -> Result<(), String> {
    set_barge(&voice, &session_id, &policy)
}

// ─── voice_log ──────────────────────────────────────────────────────────────

/// A `voice_log` line keeps at most this many characters.
pub const VOICE_LOG_MAX_CHARS: usize = 400;
/// ...and its session id this many.
const VOICE_LOG_MAX_ID_CHARS: usize = 80;

/// Control characters (newlines included) become spaces, then at most `max`
/// characters are kept: one log line, whatever the web sends.
fn one_line(s: &str, max: usize) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).take(max).collect()
}

/// `voice_log`'s line: `[voice-focus] <sessionId> <line>`, sanitised
/// ([`one_line`]); None for an empty (or blank) session id.
pub fn voice_log_line(session_id: &str, line: &str) -> Option<String> {
    let sid = one_line(session_id.trim(), VOICE_LOG_MAX_ID_CHARS);
    if sid.trim().is_empty() {
        return None;
    }
    Some(format!("[voice-focus] {} {}", sid.trim(), one_line(line, VOICE_LOG_MAX_CHARS)))
}

/// The web's Voice focus scores, into the desktop debug log. Always Ok; an
/// empty `sessionId` is ignored. Async: the file write stays off the main
/// thread.
#[tauri::command]
pub async fn voice_log(session_id: String, line: String) -> Result<(), String> {
    if let Some(l) = voice_log_line(&session_id, &line) {
        crate::log_to_file(&l);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn start_args_parse_the_webs_flat_camel_case_payload() {
        // tauri-bridge.ts voiceStart: { sessionId, mode, endSilenceMs?, bargeIn? }.
        let full: StartArgs = serde_json::from_value(json!({
            "sessionId": "voice-abc", "mode": "conversation", "endSilenceMs": 500, "bargeIn": false,
            "noiseProfile": "noisy"
        }))
        .unwrap();
        assert_eq!(
            full.validate().unwrap(),
            StartRequest {
                session_id: "voice-abc".into(),
                mode: Mode::Conversation,
                end_silence_ms: 500,
                barge_in: false,
                noise_profile: NoiseProfile::Noisy,
                speech_audio: false,
            }
        );
        let bare: StartArgs = serde_json::from_value(json!({ "sessionId": "d1", "mode": "dictation" })).unwrap();
        assert_eq!(
            bare.validate().unwrap(),
            StartRequest {
                session_id: "d1".into(),
                mode: Mode::Dictation,
                end_silence_ms: 700,
                barge_in: true,
                noise_profile: NoiseProfile::Quiet,
                speech_audio: false,
            }
        );
        // speechAudio: a conversation's or an interactive session's; a
        // dictation has no turns.
        for (mode, want) in [("conversation", true), ("interactive", true), ("dictation", false)] {
            let a: StartArgs = serde_json::from_value(json!({ "sessionId": "s", "mode": mode, "speechAudio": true })).unwrap();
            assert_eq!(a.validate().unwrap().speech_audio, want, "{mode}");
        }
        let off: StartArgs = serde_json::from_value(json!({ "sessionId": "s", "mode": "conversation", "speechAudio": false })).unwrap();
        assert!(!off.validate().unwrap().speech_audio);
        // Auto (the web's default), in both modes.
        for mode in ["conversation", "dictation"] {
            let auto: StartArgs =
                serde_json::from_value(json!({ "sessionId": "d2", "mode": mode, "noiseProfile": "auto" })).unwrap();
            assert_eq!(auto.validate().unwrap().noise_profile, NoiseProfile::Auto);
        }
        // A preset this desktop doesn't know (a newer web): the quiet room.
        let later: StartArgs =
            serde_json::from_value(json!({ "sessionId": "d3", "mode": "conversation", "noiseProfile": "concert" })).unwrap();
        assert_eq!(later.validate().unwrap().noise_profile, NoiseProfile::Quiet);
        assert_eq!(profile_note(Some("concert"), NoiseProfile::Quiet), " (asked \"concert\", unknown)");
        assert_eq!(profile_note(Some("auto"), NoiseProfile::Auto), "");
        assert_eq!(profile_note(Some("noisy"), NoiseProfile::Noisy), "");
        assert_eq!(profile_note(None, NoiseProfile::Quiet), " (default)");
    }

    #[test]
    fn start_args_validation() {
        let args = |mode: &str, ms: Option<f64>| StartArgs {
            session_id: "s".into(),
            mode: mode.into(),
            end_silence_ms: ms,
            barge_in: None,
            noise_profile: None,
            speech_audio: None,
        };
        let err = args("karaoke", None).validate().unwrap_err();
        assert!(err.starts_with("unavailable: "), "{err}");
        assert_eq!(args("conversation", Some(1200.0)).validate().unwrap().end_silence_ms, 1200);
        assert_eq!(args("conversation", Some(10.0)).validate().unwrap().end_silence_ms, 200);
        assert_eq!(args("conversation", Some(99_999.0)).validate().unwrap().end_silence_ms, 3_000);
        assert_eq!(args("conversation", Some(699.6)).validate().unwrap().end_silence_ms, 700);
        assert_eq!(args("conversation", Some(f64::NAN)).validate().unwrap().end_silence_ms, 700);
        let empty = StartArgs {
            session_id: "  ".into(),
            mode: "dictation".into(),
            end_silence_ms: None,
            barge_in: None,
            noise_profile: None,
            speech_audio: None,
        };
        assert!(empty.validate().unwrap_err().starts_with("unavailable"));
    }

    #[test]
    fn the_lid_refusal_is_unavailable_with_its_detail() {
        // tauri-bridge.ts voiceRefusal: `code: detail`.
        assert_eq!(Refusal::Unavailable.with(crate::audio::lid::LID_CLOSED), "unavailable: lid_closed");
    }

    #[test]
    fn voice_log_lines_are_one_sanitised_line() {
        assert_eq!(voice_log_line("v-1", "score 0.82 accept").as_deref(), Some("[voice-focus] v-1 score 0.82 accept"));
        // Newlines and other control characters: spaces.
        assert_eq!(voice_log_line("v-1", "a\nb\r\tc\u{1b}[31m").as_deref(), Some("[voice-focus] v-1 a b  c [31m"));
        // At most VOICE_LOG_MAX_CHARS of the line (characters, not bytes).
        let long = "é".repeat(1_000);
        let line = voice_log_line("v-1", &long).unwrap();
        assert_eq!(line.chars().count(), "[voice-focus] v-1 ".chars().count() + VOICE_LOG_MAX_CHARS);
        // No session id: nothing to log.
        assert_eq!(voice_log_line("", "x"), None);
        assert_eq!(voice_log_line(" \n ", "x"), None);
        assert_eq!(voice_log_line("v\n2", "x").as_deref(), Some("[voice-focus] v 2 x"));
    }

    /// `voice_log`'s parameters, as the web sends them.
    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LogArgs {
        session_id: String,
        line: String,
    }

    #[test]
    fn voice_log_args_parse() {
        let a: LogArgs = serde_json::from_value(json!({ "sessionId": "v-1", "line": "hi" })).unwrap();
        assert_eq!(a, LogArgs { session_id: "v-1".into(), line: "hi".into() });
    }

    /// `voice_stop` / `voice_cancel`'s parameters, as the web sends them.
    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SessionArgs {
        session_id: String,
    }

    /// `voice_set_muted`'s.
    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MuteArgs {
        session_id: String,
        muted: bool,
    }

    /// `voice_set_aside`'s.
    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AsideArgs {
        session_id: String,
        aside: bool,
        text: Option<String>,
    }

    #[test]
    fn stop_and_mute_args_parse() {
        let s: SessionArgs = serde_json::from_value(json!({ "sessionId": "x" })).unwrap();
        assert_eq!(s.session_id, "x");
        let m: MuteArgs = serde_json::from_value(json!({ "sessionId": "x", "muted": true })).unwrap();
        assert_eq!(m, MuteArgs { session_id: "x".into(), muted: true });
        assert!(serde_json::from_value::<MuteArgs>(json!({ "sessionId": "x" })).is_err(), "muted is required");
        let a: AsideArgs = serde_json::from_value(json!({ "sessionId": "x", "aside": true, "text": "Yo" })).unwrap();
        assert_eq!(a, AsideArgs { session_id: "x".into(), aside: true, text: Some("Yo".into()) });
        let a: AsideArgs = serde_json::from_value(json!({ "sessionId": "x", "aside": false })).unwrap();
        assert_eq!(a, AsideArgs { session_id: "x".into(), aside: false, text: None }, "the text is optional");
    }

    #[test]
    fn refusal_codes_are_what_the_web_parses() {
        // tauri-bridge.ts voiceRefusal: `code` or `code: detail`.
        assert_eq!(Refusal::Recording.with(""), "recording");
        assert_eq!(Refusal::Busy.code(), "busy");
        assert_eq!(Refusal::NotReady.with("local-stt is missing"), "not_ready: local-stt is missing");
        assert_eq!(Refusal::MicDenied.code(), "mic_denied");
        assert_eq!(Refusal::Unavailable.code(), "unavailable");
    }

    const READY: ModuleView = ModuleView { state: Some(ModuleState::Ready), launchable: true };

    #[test]
    fn module_states_map_to_the_contract() {
        let v = |state, launchable| module_state(ModuleView { state, launchable });
        assert_eq!(v(Some(ModuleState::Ready), true), "ready");
        assert_eq!(v(Some(ModuleState::Ready), false), "missing");
        assert_eq!(v(Some(ModuleState::Off), false), "missing");
        assert_eq!(v(Some(ModuleState::Downloading), false), "downloading");
        assert_eq!(v(Some(ModuleState::Verifying), false), "downloading");
        assert_eq!(v(Some(ModuleState::Warming), false), "downloading");
        assert_eq!(v(Some(ModuleState::Error), false), "error");
        assert_eq!(v(Some(ModuleState::Unavailable), false), "unsupported");
        assert_eq!(v(None, false), "unsupported");
    }

    #[test]
    fn status_modes_need_their_pieces() {
        let off = ModuleView { state: Some(ModuleState::Off), launchable: false };
        let warming = ModuleView { state: Some(ModuleState::Warming), launchable: false };

        let s = compute_status(true, READY, READY, Some(&Ok(())));
        assert_eq!((s.available, s.dictation, s.conversation, s.reason.clone()), (true, true, true, None));
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "available": true, "dictation": true, "conversation": true, "stt": "ready", "tts": "ready",
                "noiseProfiles": ["quiet", "noisy", "auto"], "readyFlag": true, "interactive": true,
                "speechAudio": true
            })
        );

        let s = compute_status(true, off, READY, None);
        assert_eq!((s.dictation, s.conversation, s.stt), (false, false, "missing"));
        assert!(s.reason.unwrap().contains("(local-stt) is missing"));

        let s = compute_status(true, READY, warming, None);
        assert_eq!((s.dictation, s.conversation, s.tts), (true, false, "downloading"));
        assert!(s.reason.unwrap().contains("(local-tts) is downloading"));

        let s = compute_status(true, READY, READY, Some(&Err("not built yet".into())));
        assert_eq!((s.dictation, s.conversation), (true, false));
        let v = serde_json::to_value(&s).unwrap();
        assert!(v["reason"].as_str().unwrap().contains("not built yet"));

        let s = compute_status(false, READY, READY, Some(&Ok(())));
        assert_eq!((s.available, s.dictation, s.conversation), (false, false, false));
        assert!(!s.interactive, "no voice, no Interactive mic");
    }

    /// `interactive` is the capability (this build runs the mode and
    /// `voice_set_barge`), not readiness: it holds with a module missing,
    /// where `conversation` (what an interactive start needs) says no.
    #[test]
    fn status_says_interactive_wherever_voice_is_available() {
        let off = ModuleView { state: Some(ModuleState::Off), launchable: false };
        for (stt, tts) in [(READY, READY), (off, READY), (READY, off)] {
            let s = compute_status(true, stt, tts, Some(&Ok(())));
            assert!(s.interactive);
            assert_eq!(serde_json::to_value(&s).unwrap()["interactive"], json!(true));
        }
        assert!(!compute_status(true, off, READY, None).conversation);
    }

    #[test]
    fn interactive_start_args_parse_and_start_on_the_wake_policy() {
        // The spec's voice_start { sessionId, mode: 'interactive', endSilenceMs?, noiseProfile? }.
        let a: StartArgs = serde_json::from_value(json!({
            "sessionId": "int-1", "mode": "interactive", "endSilenceMs": 900, "noiseProfile": "auto"
        }))
        .unwrap();
        let req = a.validate().unwrap();
        assert_eq!((req.mode, req.end_silence_ms, req.noise_profile), (Mode::Interactive, 900, NoiseProfile::Auto));
        assert_eq!(BargePolicy::initial(req.mode, req.barge_in), BargePolicy::Wake);
        // bargeIn is a conversation's: an interactive session starts on wake whatever it says.
        let a: StartArgs = serde_json::from_value(json!({ "sessionId": "int-2", "mode": "interactive", "bargeIn": false })).unwrap();
        assert_eq!(BargePolicy::initial(Mode::Interactive, a.validate().unwrap().barge_in), BargePolicy::Wake);
        assert_eq!(BargePolicy::initial(Mode::Conversation, true), BargePolicy::Speech);
        assert_eq!(BargePolicy::initial(Mode::Conversation, false), BargePolicy::Off);
        assert_eq!(BargePolicy::initial(Mode::Dictation, true), BargePolicy::Off);
        for m in [Mode::Dictation, Mode::Conversation, Mode::Interactive] {
            assert_eq!(parse_mode(m.name()), Some(m));
        }
    }

    /// `voice_set_barge`'s parameters, as the web sends them.
    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BargeArgs {
        session_id: String,
        policy: String,
    }

    #[test]
    fn set_barge_args_parse_and_every_policy_name_reads_back() {
        let b: BargeArgs = serde_json::from_value(json!({ "sessionId": "x", "policy": "wake" })).unwrap();
        assert_eq!(b, BargeArgs { session_id: "x".into(), policy: "wake".into() });
        assert!(serde_json::from_value::<BargeArgs>(json!({ "sessionId": "x" })).is_err(), "policy is required");
        for p in [BargePolicy::Speech, BargePolicy::Wake, BargePolicy::Off] {
            assert_eq!(BargePolicy::from_name(p.name()), Some(p));
        }
        assert_eq!(BargePolicy::from_name("loud"), None);
    }

    #[test]
    fn only_a_window_in_front_or_a_listening_press_opens_the_mic() {
        let window = |shown, focused, interactive_restart| Asker::Window { shown, focused, interactive_restart };
        for mode in [Mode::Dictation, Mode::Conversation, Mode::Interactive] {
            assert_eq!(may_listen(window(true, true, false), mode), Ok(()), "{mode:?}");
            // Hidden to the tray or minimised: never, in front, granted a restart or not.
            assert!(may_listen(window(false, true, true), mode).is_err(), "{mode:?}");
            assert!(may_listen(window(false, false, true), mode).is_err(), "{mode:?}");
            // No right ⌥ press listening: the panel never opens it.
            assert!(may_listen(Asker::Panel { pressed: false }, mode).is_err(), "{mode:?}");
        }
        // The panel listens unseen and unfocused, for the press, and only to dictate (a hold dictates too).
        assert_eq!(may_listen(Asker::Panel { pressed: true }, Mode::Dictation), Ok(()));
        for mode in [Mode::Conversation, Mode::Interactive] {
            assert_eq!(may_listen(Asker::Panel { pressed: true }, mode), Err("the right ⌥ panel only dictates"), "{mode:?}");
        }
        // Behind another app, naming Interactive is no way round it: the first start needs the window in front.
        let behind = window(true, false, false);
        for mode in [Mode::Dictation, Mode::Conversation, Mode::Interactive] {
            assert_eq!(may_listen(behind, mode), Err("the window that asked isn't in front"), "{mode:?}");
        }
        // Interactive starting again just after a dictation took the mic from it, the person in another app...
        let granted = window(true, false, true);
        assert_eq!(may_listen(granted, Mode::Interactive), Ok(()));
        // ...and nothing else on the strength of it.
        assert!(may_listen(granted, Mode::Dictation).is_err());
        assert!(may_listen(granted, Mode::Conversation).is_err());
        // The web reads the refusal as `unavailable` with its detail.
        assert_eq!(
            Refusal::Unavailable.with(may_listen(window(false, false, false), Mode::Dictation).unwrap_err()),
            "unavailable: the window that asked isn't on screen"
        );
    }

    #[test]
    fn the_panel_is_asked_by_its_press_and_every_other_webview_by_its_window() {
        let never = || -> bool { panic!("the press is read for the panel only") };
        let no_window = || -> (bool, bool) { panic!("a window is read for a window only") };
        assert_eq!(asker_for(crate::dictate::PANEL, false, || true, no_window), Asker::Panel { pressed: true });
        assert_eq!(asker_for(crate::dictate::PANEL, true, || false, no_window), Asker::Panel { pressed: false });
        assert_eq!(
            asker_for("main", true, never, || (true, false)),
            Asker::Window { shown: true, focused: false, interactive_restart: true }
        );
        // Only the panel's own label is the panel.
        for label in ["workspace-1", "agent-hud", "meeting-hud", "Dictate", "dictate-2", ""] {
            assert_eq!(
                asker_for(label, false, never, || (false, false)),
                Asker::Window { shown: false, focused: false, interactive_restart: false },
                "{label}"
            );
        }
    }
}
