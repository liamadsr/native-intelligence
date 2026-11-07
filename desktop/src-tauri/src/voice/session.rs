//! A live voice session: the async actor that owns everything the session
//! started (local-stt, the held TTS output and its reference tap, the output
//! route watcher, the DSP thread, the mic lease), feeds the [`Machine`] and
//! carries out its actions.
//!
//! Inputs, one `select!`: commands (`Ctl`), local-stt events, DSP events,
//! the TTS speaking watch, and a 50 ms tick (machine timers, the mic fault
//! flag, keeping the TTS engine warm). After every input the machine's
//! barge-in arming and barge policy (and, in the noisy room, the user's
//! speech level) are published to the DSP thread.
//!
//! An interactive session's transcription hears speech only ([`super::feed`]):
//! every local-stt event's times go through its [`FeedClock`] onto the
//! session audio clock before anything else sees them.
//!
//! Speech audio (`speechAudio`, [`super::speech`]): the DSP thread's audio
//! and the machine's open runs, after every input, make the
//! `voice://speech` chunks; a run's closing one goes out right before its
//! `voice://turn`.
//!
//! The mic: when its stream faults (the device vanished, cpal's error) or
//! stalls, the session doesn't end at once but recovers onto what
//! `input_devices::resolve_for_recovery_checked` picks now (the same device
//! once, then the next one; never the lid-closed MacBook mic), at most
//! [`MIC_RECOVERIES`] times in [`MIC_RECOVERY_WINDOW`]. The new stream shows
//! up as `MicReplaced`, as a live switch does.
//!
//! The system-audio echo reference ([`super::system_ref`]): at the start and
//! on every output route change, a reconcile job (one at a time, on a
//! blocking thread) reads the permission and the default output and starts or
//! stops the session's tap, flipping [`DspShared::system_ref_on`] for the DSP
//! thread. One `echo reference` line per change. A tap the DSP thread
//! reports stalled is restarted by a reconcile, within a [`RestartBudget`];
//! and the machine hears the DSP thread's hold (`Input::AudioDelay`) so its
//! wall-time echo guard covers the same audio. The tap stops in the
//! teardown, after the mic lease is gone, on every end path; a capture
//! starting stops it synchronously (`VoiceService::end_now`).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, watch};

use super::capture::Capture;
use super::dsp::{self, DspEvent, DspShared, SpeechControl};
use super::events::{self, EchoMode, EndReason, Emitter};
use super::feed::FeedClock;
use super::levels::{self, Device, Memory};
use super::speech::{self, SpeechAudio, SpeechOut};
use super::system_ref::{self, Decision, RestartBudget, Serial};
use super::trace::{self, Input};
use super::turn::{Action, Machine, Mode, FINALIZE_FORWARD_MS};
use super::{Ctl, MicLease, VoiceService};
use crate::audio::output_route::{self, OutputKind, OutputRoute, RouteWatcher};
use crate::audio::speech_output;
use crate::audio::system_capture::SystemCapture;
use crate::audio::tap::TapSlot;
use crate::modules::stt::{VoiceSttControl, VoiceSttEvent, VoiceSttHandle};
use crate::modules::tts::{OutputHold, TtsService};

const TICK: Duration = Duration::from_millis(50);
/// Keep the TTS engine from idling out mid-conversation (its idle timeout is
/// 5 minutes).
const KEEP_WARM_EVERY: Duration = Duration::from_secs(60);
/// A mic swap's device lookup: the DSP thread sees the new stream as soon
/// as its tap starts over, before MicCapture has built and started it and
/// published its device (a Bluetooth headset's open can take a second or
/// two), so the lookup asks this often...
const DEVICE_LOOKUP_EVERY: Duration = Duration::from_millis(50);
/// ...for up to this long, then gives up (the session stays on the
/// bootstrap and saves nothing for that mic).
const DEVICE_LOOKUP_WITHIN: Duration = Duration::from_secs(3);
/// A faulted or stalled mic is recovered at most this many times...
pub const MIC_RECOVERIES: usize = 3;
/// ...within this long; one more fault ends the session (`device`).
pub const MIC_RECOVERY_WINDOW: Duration = Duration::from_secs(60);

/// The recoveries a session has made lately ([`MIC_RECOVERIES`] per
/// [`MIC_RECOVERY_WINDOW`]): a mic that keeps failing can't hold the session
/// in a loop.
#[derive(Debug, Default)]
pub struct Recoveries(VecDeque<Instant>);

impl Recoveries {
    /// One more recovery at `now`, if the budget allows (counted when it does).
    pub fn allow(&mut self, now: Instant) -> bool {
        while self.0.front().is_some_and(|t| now.saturating_duration_since(*t) >= MIC_RECOVERY_WINDOW) {
            self.0.pop_front();
        }
        if self.0.len() >= MIC_RECOVERIES {
            return false;
        }
        self.0.push_back(now);
        true
    }
}

/// A DSP stall report belongs to a live switch, not a dead mic: a switch is
/// running (`epoch_now` odd: `switch_device` bumps it before and after), or
/// one has run since the stream the DSP thread judged (`epoch_at_stream`, the
/// epoch when the session last heard of a new stream). The old stream's
/// frames stop at the switch's start and a Bluetooth open can outlast
/// `MIC_STALL_MS`; the new stream re-arms the DSP thread's stall report, so a
/// real stall of it still counts.
pub fn stall_from_a_switch(epoch_now: u64, epoch_at_stream: u64) -> bool {
    epoch_now % 2 == 1 || epoch_now != epoch_at_stream
}

/// Reopen a faulted voice session's mic on what the resolver picks now
/// (`resolve_for_recovery_checked`: the in-use mic once, then passed over;
/// never the lid-closed MacBook mic). Blocking: the store, CoreAudio, then
/// the mic lock alone. Not when coreaudiod isn't answering (the reopen would
/// hang with the mic lock held), the session's lease is gone (a capture took
/// the mic) or the stream isn't a voice session's; and never falling back onto
/// a default the lid made unavailable
/// (`MicCapture::recover_after_fault_avoiding_dead_default`). Ok: what it
/// opened.
fn recover_mic(app: &AppHandle, lease: &MicLease) -> Result<String, String> {
    crate::audio::health::ensure_answering()?;
    let target = crate::audio::input_devices::resolve_for_recovery_checked(app)
        .map_err(|_| format!("{}: the MacBook microphone is the only one and the lid is closed", crate::audio::lid::LID_CLOSED))?;
    let state = app.state::<crate::state::AppState>();
    let mut mic = state.mic_capture.lock().unwrap_or_else(|p| p.into_inner());
    if !lease.held() {
        return Err("the microphone was taken over".into());
    }
    if !mic.is_recording() || mic.is_capturing_to_file() {
        return Err("the microphone is no longer this session's".into());
    }
    mic.recover_after_fault_avoiding_dead_default(target.as_ref())?;
    Ok(target.map_or_else(|| "the system default".to_string(), |t| format!("{:?}", t.name)))
}

/// Emit the speech audio's chunks and ends, in order.
fn emit_speech(emitter: &dyn Emitter, session_id: &str, outs: Vec<SpeechOut>) {
    for out in outs {
        match out {
            SpeechOut::Chunk { turn_id, seq, start, pcm } => {
                let pcm = speech::pcm_base64(&pcm);
                events::emit(
                    emitter,
                    events::SPEECH,
                    &events::SpeechChunkPayload {
                        session_id,
                        turn_id: &turn_id,
                        seq,
                        start_ms: speech::clock_ms(start),
                        sample_rate: super::SAMPLE_RATE as u32,
                        pcm: &pcm,
                        end: false,
                    },
                );
            }
            SpeechOut::End { turn_id, seq, outcome } => {
                crate::log_to_file(&format!("[voice] {session_id} speech audio {turn_id}: {seq} chunk(s), {outcome:?}"));
                events::emit(
                    emitter,
                    events::SPEECH,
                    &events::SpeechEndPayload { session_id, turn_id: &turn_id, seq, end: true, outcome },
                );
            }
        }
    }
}

/// Ask `lookup` every `every` until it names a device or `within` has
/// passed. Blocking. A reopen clears the in-use device before the new
/// stream's tap starts over (`MicCapture::retire_stream`), so once the DSP
/// thread has seen the swap, the first device named is the new stream's.
fn await_device(mut lookup: impl FnMut() -> Option<Device>, every: Duration, within: Duration) -> Option<Device> {
    let deadline = Instant::now() + within;
    loop {
        if let Some(device) = lookup() {
            return Some(device);
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        std::thread::sleep(every.min(deadline - now));
    }
}

/// Barge-in's view of the agent's speech: the TTS watch and its cancel.
pub struct TtsSpeech {
    pub app: AppHandle,
    pub speaking: watch::Receiver<bool>,
}

impl SpeechControl for TtsSpeech {
    fn agent_audible(&self) -> bool {
        *self.speaking.borrow()
    }

    /// `TtsService::cancel`: a few atomics and an unbounded channel send.
    fn cancel_speech(&self) {
        if let Some(tts) = self.app.try_state::<TtsService>() {
            tts.cancel();
        }
    }
}

/// The output route's hint that it's worn on the head: a Bluetooth or USB
/// device whose name says so outright. Only a hint: it is logged and resets
/// the echo-path measurement when it changes, but never allows barge-in by
/// itself. Whether the agent's voice comes back into the mic is measured
/// ([`super::detect::EchoTracker`]), because names lie both ways: a "Beats
/// Pill" is a speaker, desk speakers on a Mac mini's jack show up as built-in
/// "hdpn" headphones, and "WH-1000XM5" or "Jabra Link 380" say nothing.
pub fn headphones_hint(route: &OutputRoute) -> bool {
    let n = route.name.to_ascii_lowercase();
    let says_headphones =
        || ["airpods", "headphone", "headset", "earbud", "buds", "earphone", "earpods"].iter().any(|k| n.contains(k));
    match route.kind {
        OutputKind::Bluetooth => says_headphones(),
        // The built-in jack ("hdpn") carries speakers as often as headphones:
        // unknown until the signal decides. A USB headset goes by its name.
        OutputKind::WiredHeadphones => route.transport != "bltn" && says_headphones(),
        _ => false,
    }
}

/// Everything a started session hands its actor.
pub struct SessionCtx {
    pub app: AppHandle,
    pub session_id: String,
    pub token: u64,
    pub machine: Machine,
    pub stt: VoiceSttHandle,
    pub ctl: mpsc::UnboundedReceiver<Ctl>,
    /// For the route watcher's callback.
    pub ctl_tx: mpsc::UnboundedSender<Ctl>,
    pub dsp_shared: Arc<DspShared>,
    pub dsp_events: mpsc::UnboundedReceiver<DspEvent>,
    pub dsp_thread: Option<JoinHandle<()>>,
    pub speaking: watch::Receiver<bool>,
    pub hold: Option<OutputHold>,
    pub mic_fault: Arc<AtomicBool>,
    /// MicCapture's live-switch epoch (`switch_device` bumps it before and
    /// after: odd while a switch runs).
    pub mic_switch_epoch: Arc<AtomicU64>,
    pub lease: Arc<MicLease>,
    /// The dev-only debug capture, when on (`events.jsonl` is written here).
    pub capture: Option<Capture>,
    /// The user's speech level remembered per mic (noisy room only).
    pub levels: Option<Memory>,
    /// Interactive: local-stt is fed around speech only, and this maps its
    /// times back onto the session audio clock. `None`: fed everything, the
    /// clocks are one.
    pub feed_clock: Option<Arc<FeedClock>>,
    /// Emit `voice://speech` (the DSP thread hands over its audio).
    pub speech_audio: bool,
    /// Where the system tap's samples go (the DSP thread holds the reader).
    pub system_feed: Arc<TapSlot>,
}

/// Decide, then start or stop session `token`'s system tap to match.
/// Blocking: a TCC preflight, CoreAudio reads, the sidecar. The DSP flag goes
/// up once the tap runs and down before it stops. Returns what is in force.
fn reconcile_system_ref(
    app: &AppHandle,
    mode: Mode,
    token: u64,
    lease: &MicLease,
    feed: Arc<TapSlot>,
    dsp: &DspShared,
    restart: bool,
) -> Decision {
    let off = |reason: String| Decision { on: false, reason, mix: system_ref::RefMix::of(mode, false) };
    let permission = crate::permissions::system_audio_permission();
    let sidecar = SystemCapture::is_available();
    let route = output_route::current().ok();
    let decision = system_ref::decide(mode, permission, sidecar, route.as_ref());
    let Some(voice) = app.try_state::<VoiceService>() else {
        return off("the voice service is gone".into());
    };
    let tap = voice.ref_tap();
    if decision.on {
        match tap.start(token, lease, feed, restart) {
            Ok(()) => {
                dsp.system_ref_on.store(true, Ordering::Relaxed);
                decision
            }
            Err(e) => {
                dsp.system_ref_on.store(false, Ordering::Relaxed);
                tap.stop(token);
                off(format!("the tap could not start: {e}"))
            }
        }
    } else {
        dsp.system_ref_on.store(false, Ordering::Relaxed);
        tap.stop(token);
        decision
    }
}

/// The session's side of the system tap: reconcile jobs, serialised, and
/// the one log line per change.
struct EchoRef {
    app: AppHandle,
    session_id: String,
    mode: Mode,
    token: u64,
    lease: Arc<MicLease>,
    feed: Arc<TapSlot>,
    dsp: Arc<DspShared>,
    serial: Serial,
    done: mpsc::UnboundedSender<Decision>,
    /// What the last line said.
    shown: Option<(bool, String)>,
    /// The next job restarts the tap (it stalled).
    restart: bool,
    restarts: RestartBudget,
}

impl EchoRef {
    /// Re-decide (the start, a route change).
    fn request(&mut self) {
        if self.serial.request() {
            self.spawn();
        }
    }

    /// The tick: a tap the DSP thread reports stalled gets a reconcile that
    /// restarts it, within the budget (a crash loop can't spin).
    fn check_stall(&mut self) {
        let on = self.dsp.system_ref_on.load(Ordering::Relaxed);
        if !on || !self.dsp.system_stalled.load(Ordering::Acquire) || !self.restarts.allow(Instant::now()) {
            return;
        }
        crate::log_to_file(&format!(
            "[voice] {} echo reference: system tap stalled; restarting it ({}/{} in {} s)",
            self.session_id,
            self.restarts.used(),
            system_ref::RESTARTS,
            system_ref::RESTART_WINDOW.as_secs()
        ));
        self.restart = true;
        self.request();
    }

    fn spawn(&mut self) {
        let restart = std::mem::take(&mut self.restart);
        let (app, mode, token) = (self.app.clone(), self.mode, self.token);
        let (lease, feed, dsp, done) = (self.lease.clone(), self.feed.clone(), self.dsp.clone(), self.done.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let _ = done.send(reconcile_system_ref(&app, mode, token, &lease, feed, &dsp, restart));
        });
    }

    /// A job ended with `d` in force.
    fn finished(&mut self, d: Decision) {
        let line = (d.on, d.reason.clone());
        if self.shown.as_ref() != Some(&line) {
            crate::log_to_file(&format!(
                "[voice] {} echo reference: system tap {} ({}; reference: {})",
                self.session_id,
                if d.on { "on" } else { "off" },
                d.reason,
                d.mix.describe()
            ));
            self.shown = Some(line);
        }
        if self.serial.finished() {
            self.spawn();
        }
    }

    /// The session is over and its mic lease gone: stop the tap. Blocking.
    fn stop_blocking(app: &AppHandle, session_id: &str, token: u64, dsp: &DspShared) {
        dsp.system_ref_on.store(false, Ordering::Relaxed);
        if let Some(voice) = app.try_state::<VoiceService>() {
            if voice.ref_tap().stop(token) {
                crate::log_to_file(&format!("[voice] {session_id} echo reference: system tap off (session ended)"));
            }
        }
    }
}

/// How the session ended.
struct Ending {
    reason: EndReason,
    text: Option<String>,
    error: Option<String>,
}

fn ms_since(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

/// The TTS engine may be started now (as `tts_prepare` checks).
fn tts_prepare(app: &AppHandle) {
    if crate::modules::tts::recording_active(app) {
        return;
    }
    let modules = app.state::<crate::modules::ModuleManager>();
    if modules.launch_config(app, crate::modules::tts::MODULE_ID).is_none() {
        return;
    }
    if let Some(tts) = app.try_state::<TtsService>() {
        tts.prepare();
    }
}

/// Re-read the route of the device TTS plays on (the chosen mic's paired
/// output, else the system default: `audio::speech_output`), with the
/// choice behind it. The resolution is published, so `pairing` (this
/// session's own subscription) is marked seen when it still holds that
/// pairing: its own publish doesn't wake it again. CoreAudio property reads,
/// off the runtime.
async fn query_route(app: &AppHandle, pairing: &mut watch::Receiver<Option<String>>) -> Option<(OutputRoute, String)> {
    let app = app.clone();
    match tauri::async_runtime::spawn_blocking(move || speech_output::route(&app)).await {
        Ok(Ok((route, choice))) => {
            speech_output::mark_seen_if_current(pairing, &choice);
            Some((route, choice.why()))
        }
        Ok(Err(e)) => {
            crate::log_to_file(&format!("[voice] output route unknown: {e}"));
            None
        }
        Err(_) => None,
    }
}

/// The output route changed, or the chosen mic's pairing did: re-read where
/// speech plays, update the headphones hint from THAT device, and move a held
/// output there (not reopened when it is already on it).
async fn on_route_change(
    app: &AppHandle,
    actor: &mut Actor,
    dsp_shared: &DspShared,
    session_id: &str,
    pairing: &mut watch::Receiver<Option<String>>,
    refresh_tts: bool,
) {
    let route = query_route(app, pairing).await;
    if let Some((route, why)) = &route {
        let hint = headphones_hint(route);
        crate::log_to_file(&format!(
            "[voice] {} output route now {:?} {:?} ({}) → headphones hint={}",
            session_id, route.kind, route.name, why, hint
        ));
        actor.note(serde_json::json!({ "k": "route", "name": route.name, "hint": hint }));
        dsp_shared.headphones_hint.store(hint, Ordering::Relaxed);
    }
    if !refresh_tts {
        return;
    }
    if let Some(tts) = app.try_state::<TtsService>() {
        match &route {
            Some((route, _)) => tts.refresh_output_unless_on(route.device_id),
            None => tts.refresh_output(),
        }
    }
}

struct Actor {
    app: AppHandle,
    session_id: String,
    started: Instant,
    machine: Machine,
    control: VoiceSttControl,
    shared: Arc<DspShared>,
    ending: Option<Ending>,
    turns_sent: u32,
    capture: Option<Capture>,
    /// The audio clock as far as the session knows (the last VAD frame's end).
    clock: u64,
    /// What `voice://state` last showed, readiness included.
    shown: events::ShownState,
    /// The user's speech level remembered per mic (noisy room only)...
    memory: Option<Memory>,
    /// ...where a mic swap's device lookup answers, tagged with...
    device_tx: mpsc::UnboundedSender<(u64, Option<Device>)>,
    /// ...the swap it answers (only the latest swap's answer counts).
    swaps: u64,
    /// Speech audio (`speechAudio`), else None.
    speech: Option<SpeechAudio>,
    /// MicCapture's fault flag: a stall raises it too, for the recovery...
    mic_fault: Arc<AtomicBool>,
    /// ...unless it came from a live switch ([`stall_from_a_switch`]): the
    /// switch epoch now, and as of the latest stream.
    switch_epoch: Arc<AtomicU64>,
    switch_seen: u64,
}

impl Actor {
    fn now(&self) -> u64 {
        ms_since(self.started)
    }

    /// Feed one input to the machine at `now` and carry out what it says
    /// (every input, even one with no machine call, republishes the barge-in
    /// arming).
    fn input(&mut self, input: Input, now: u64) {
        if let Input::Vad { end, .. } = input {
            self.clock = self.clock.max(end);
        }
        if let Some(cap) = &self.capture {
            cap.event(trace::record(trace::input_json(&input), now, self.clock));
        }
        let actions = trace::feed(&mut self.machine, &input, now);
        self.apply(actions, now);
    }

    /// A note in the capture (not a machine input).
    fn note(&self, body: serde_json::Value) {
        if let Some(cap) = &self.capture {
            cap.event(trace::record(body, self.now(), self.clock));
        }
    }

    fn apply(&mut self, actions: Vec<Action>, now: u64) {
        if let Some(cap) = &self.capture {
            for action in &actions {
                cap.event(trace::record(trace::action_json(action), now, self.clock));
            }
        }
        let emitter: &dyn Emitter = &self.app;
        let sid = self.session_id.as_str();
        let ready = self.machine.ready();
        let noise = self.machine.noise_mode();
        let state_event = |s: events::Shown| events::StatePayload {
            session_id: sid,
            state: s.state,
            echo: s.echo,
            ready: s.ready,
            noise_mode: s.noise_mode,
        };
        for action in actions {
            match action {
                Action::State { state, echo } => {
                    events::emit(emitter, events::STATE, &state_event(self.shown.state(state, echo, ready, noise)))
                }
                Action::Transcript { turn_id, text, is_final } => events::emit(
                    emitter,
                    events::TRANSCRIPT,
                    &events::TranscriptPayload { session_id: sid, turn_id: &turn_id, text: &text, is_final },
                ),
                Action::Turn { turn_id, text } => {
                    // Its audio closes first: the web holds all of it when
                    // the turn arrives.
                    if let Some(sp) = self.speech.as_mut() {
                        emit_speech(emitter, sid, sp.turn(&turn_id));
                    }
                    self.turns_sent += 1;
                    crate::log_to_file(&format!(
                        "[voice] {} turn {} ({} chars)",
                        sid,
                        turn_id,
                        text.chars().count()
                    ));
                    events::emit(emitter, events::TURN, &events::TurnPayload { session_id: sid, turn_id: &turn_id, text: &text })
                }
                Action::Interrupted { turn_id } => {
                    crate::log_to_file(&format!("[voice] {} barge-in (turn {})", sid, turn_id));
                    events::emit(
                        emitter,
                        events::INTERRUPTED,
                        &events::InterruptedPayload { session_id: sid, turn_id: &turn_id },
                    )
                }
                Action::Finalize { seq } => {
                    // `FinalizeSent{seq}` and the ack come back in order on
                    // the event channel; the machine owns the timeouts, so
                    // the result here is only logged. Waiting as long as the
                    // machine may (forward + ack) keeps a finalize queued
                    // behind a loading engine's backlog from being dropped.
                    //
                    // While the system tap runs the DSP thread holds the mic
                    // back: every held frame goes to local-stt first, so the
                    // last word before a stop or a pause is in the finalize
                    // (no tap: nothing held, no wait).
                    let control = self.control.clone();
                    let shared = self.shared.clone();
                    let sid = self.session_id.clone();
                    let within = Duration::from_millis(FINALIZE_FORWARD_MS) + crate::modules::stt::FINALIZE_TIMEOUT;
                    tauri::async_runtime::spawn(async move {
                        if !dsp::flush_held_audio(&shared).await {
                            crate::log_to_file(&format!("[voice] {sid} finalize {seq}: the DSP thread didn't flush its held audio in time"));
                        }
                        if let Err(e) = control.finalize_within(seq, within).await {
                            crate::log_to_file(&format!("[voice] finalize {seq}: {e}"));
                        }
                    });
                }
                // Auto switched rooms: the log says why, the capture has the
                // action, and the state below shows the new `noiseMode`.
                Action::NoiseMode { mode, reason } => crate::log_to_file(&format!(
                    "[voice] {} background noise: now the {} room ({reason}); speech level {}",
                    sid,
                    match mode {
                        events::NoiseMode::Quiet => "quiet",
                        events::NoiseMode::Noisy => "noisy",
                    },
                    self.machine.speech_level().map_or("-".into(), |(db, m)| format!("{db:.1} dB (measured={m})"))
                )),
                Action::End { reason, text, error } => {
                    if self.ending.is_none() {
                        self.ending = Some(Ending { reason, text, error });
                    }
                }
            }
        }
        // Speech audio: runs that opened, ended or got their end.
        if let Some(sp) = self.speech.as_mut() {
            emit_speech(emitter, sid, sp.sync(&self.machine.open_runs()));
        }
        // Readiness flipped under an unchanged state (muted, or speech that
        // began while local-stt loaded): the machine sent no state event.
        if self.ending.is_none() {
            if let Some(shown) = self.shown.refresh(ready, noise) {
                crate::log_to_file(&format!(
                    "[voice] {} ready={} noiseMode={:?} under {:?}",
                    sid, shown.ready, shown.noise_mode, shown.state
                ));
                events::emit(emitter, events::STATE, &state_event(shown));
            }
        }
        // (Read by the DSP thread as barge-in fires. A fire racing a policy
        // switch is either kind; the event says which, and the machine takes
        // it as it happened: speech cancelled or not.)
        self.shared.barge_wakes.store(self.machine.barge_wakes(), Ordering::Relaxed);
        self.shared.barge_armed.store(self.machine.barge_armed(), Ordering::Relaxed);
        self.shared.barge_aside.store(self.machine.barge_aside(), Ordering::Relaxed);
        // (The barge-in detector's S: the noisy room's gating, or none.)
        self.shared.speech_level.set(self.machine.barge_level());
    }

    fn on_dsp(&mut self, event: DspEvent) {
        let now = self.now();
        let input = match event {
            DspEvent::Started { vad_frame, canceller } => {
                crate::log_to_file(&format!(
                    "[voice] {} DSP up: canceller={} vad_frame={:?} noiseProfile={}",
                    self.session_id,
                    if canceller { "aec" } else { "passthrough" },
                    vad_frame,
                    self.machine.profile().name()
                ));
                Input::Started { vad_frame, canceller }
            }
            // The level and floor are for the noisy room's gate; the quiet
            // room ignores them.
            DspEvent::Vad { prob, start, end, level_db, floor_db } => Input::Vad { prob, start, end, level_db, floor_db },
            DspEvent::Echo(mode) => Input::Echo(mode),
            DspEvent::Level { mic, agent } => {
                events::emit(
                    &self.app,
                    events::LEVEL,
                    &events::LevelPayload { session_id: &self.session_id, mic, agent },
                );
                Input::Level { mic, agent }
            }
            DspEvent::BargeIn { onset } => Input::BargeIn { onset },
            // (No transcript text: the run's words come later, from local-stt.)
            DspEvent::Wake { onset } => {
                crate::log_to_file(&format!("[voice] {} speech over the agent opens a turn (wake)", self.session_id));
                Input::Wake { onset }
            }
            DspEvent::MicReplaced => {
                // The stream the DSP thread judges from here on.
                self.switch_seen = self.switch_epoch.load(Ordering::SeqCst);
                if let Some((db, measured)) = self.machine.speech_level() {
                    crate::log_to_file(&format!(
                        "[voice] {} mic stream replaced: speech level {:.1} dB (measured={}) back to the bootstrap until the mic is known",
                        self.session_id, db, measured
                    ));
                }
                self.mic_replaced();
                Input::MicReplaced
            }
            // As a fault: the tick recovers the mic (or ends, past the budget).
            DspEvent::MicStalled => {
                let epoch = self.switch_epoch.load(Ordering::SeqCst);
                if stall_from_a_switch(epoch, self.switch_seen) {
                    crate::log_to_file(&format!("[voice] {} mic delivered no audio during a live switch; waiting for the new stream", self.session_id));
                } else {
                    crate::log_to_file(&format!("[voice] {} mic delivered no audio; treating it as a fault", self.session_id));
                    self.mic_fault.store(true, Ordering::SeqCst);
                }
                return;
            }
            // Not a machine input.
            DspEvent::Audio { start, pcm } => {
                if let Some(sp) = self.speech.as_mut() {
                    let outs = sp.push(start, &pcm);
                    emit_speech(&self.app, &self.session_id, outs);
                }
                return;
            }
        };
        self.input(input, now);
    }

    /// Save the level on the current mic if one is due
    /// ([`Memory::save_due`]; `force`: the session, or its time on this
    /// mic, is ending). The store write runs on a blocking thread; its
    /// handle is returned for the teardown to wait on.
    fn save_level(&mut self, force: bool) -> Option<tauri::async_runtime::JoinHandle<()>> {
        let memory = self.memory.as_mut()?;
        let (db, _) = self.machine.speech_level()?;
        let save = memory.save_due(db, self.machine.measured_turns(), Instant::now(), force, levels::stamp)?;
        crate::log_to_file(&format!(
            "[voice] {} speech level saved for {:?}: {:.1} dB over {} turns (this session {:.1} dB over {})",
            self.session_id, save.device.name, save.level.db, save.level.turns, save.session_db, save.session_turns
        ));
        let app = self.app.clone();
        Some(tauri::async_runtime::spawn_blocking(move || levels::save(&app, &save.device.uid, &save.level)))
    }

    /// The mic's stream was replaced (noisy room): save what this session
    /// measured on the old mic, then look up which mic it is now, off the
    /// runtime ([`Self::on_device`] gets the answer).
    fn mic_replaced(&mut self) {
        if self.memory.is_none() {
            return;
        }
        drop(self.save_level(true));
        let turns = self.machine.measured_turns();
        if let Some(m) = self.memory.as_mut() {
            m.detach(turns, Instant::now());
        }
        self.swaps += 1;
        let (app, tx, swap) = (self.app.clone(), self.device_tx.clone(), self.swaps);
        tauri::async_runtime::spawn_blocking(move || {
            let lookup = || levels::device_in_use(&app);
            let _ = tx.send((swap, await_device(lookup, DEVICE_LOOKUP_EVERY, DEVICE_LOOKUP_WITHIN)));
        });
    }

    /// After mic swap `swap`, the mic the stream is on now: S starts from
    /// its remembered level, unless a turn already measured it meanwhile. An
    /// earlier swap's answer, arriving after a later swap, is dropped.
    fn on_device(&mut self, swap: u64, device: Option<Device>) {
        if swap != self.swaps {
            return;
        }
        let now = self.now();
        let Some(memory) = self.memory.as_mut() else { return };
        let hint = memory.attach(device, Instant::now());
        let fresh = self.machine.measured_turns() == memory.base();
        crate::log_to_file(&format!("[voice] {} mic swapped; {}", self.session_id, memory.note()));
        if let (Some(db), true) = (hint, fresh) {
            self.input(Input::SpeechHint { db }, now);
        }
    }

    fn on_ctl(&mut self, ctl: Ctl) {
        let now = self.now();
        let input = match ctl {
            Ctl::Stop => Input::Stop,
            Ctl::Cancel => Input::Cancel,
            Ctl::Mute(muted) => {
                self.shared.muted.store(muted, Ordering::Relaxed);
                Input::Mute(muted)
            }
            Ctl::Aside { on, text } => Input::Aside { on, text },
            Ctl::Barge(policy) => {
                crate::log_to_file(&format!(
                    "[voice] {} barge policy {} → {}",
                    self.session_id,
                    self.machine.barge_policy().name(),
                    policy.name()
                ));
                Input::Barge(policy)
            }
            Ctl::End(reason) => Input::EndWith { reason, error: None },
            Ctl::Replaced => Input::Replaced,
            Ctl::RouteChanged => {
                // Handled by the caller (async); publishes the arming only.
                self.apply(Vec::new(), now);
                return;
            }
        };
        self.input(input, now);
    }
}

/// Run a session until it ends, then tear it down and emit `voice://ended`.
pub async fn run(ctx: SessionCtx) {
    let SessionCtx {
        app,
        session_id,
        token,
        machine,
        mut stt,
        mut ctl,
        ctl_tx,
        dsp_shared,
        mut dsp_events,
        dsp_thread,
        mut speaking,
        hold,
        mic_fault,
        mic_switch_epoch,
        lease,
        capture,
        levels: memory,
        feed_clock,
        speech_audio,
        system_feed,
    } = ctx;
    let mode = machine.mode();
    let (device_tx, mut device_rx) = mpsc::unbounded_channel();
    // A mic recovery's outcome (run on a blocking thread).
    let (recover_tx, mut recover_rx) = mpsc::unbounded_channel::<Result<String, String>>();
    let mut recovering = false;
    let mut recoveries = Recoveries::default();
    // (VoiceSttHandle closes the transcription when dropped.)
    let control = stt.control.clone();
    let mut actor = Actor {
        app: app.clone(),
        session_id: session_id.clone(),
        started: Instant::now(),
        machine,
        control: control.clone(),
        shared: dsp_shared.clone(),
        ending: None,
        turns_sent: 0,
        capture,
        clock: 0,
        shown: events::ShownState::default(),
        memory,
        device_tx,
        swaps: 0,
        speech: speech_audio.then(SpeechAudio::default),
        mic_fault: mic_fault.clone(),
        switch_seen: mic_switch_epoch.load(Ordering::SeqCst),
        switch_epoch: mic_switch_epoch,
    };

    // The output route of the device TTS plays on: echo mode's headphones,
    // and (conversation) moving the held output to a new default device or a
    // new pairing with the chosen mic.
    let mut pairing = speech_output::subscribe();
    if let Some((route, why)) = query_route(&app, &mut pairing).await {
        let hint = headphones_hint(&route);
        crate::log_to_file(&format!(
            "[voice] {} output {:?} {:?} ({}, {}) → headphones hint={} (the echo path is measured)",
            session_id, route.kind, route.name, route.transport, why, hint
        ));
        dsp_shared.headphones_hint.store(hint, Ordering::Relaxed);
    }
    // The system tap (on speakers) for every mode, so dictation watches the
    // route too; only a conversation moves the held output on a change.
    let (ref_done_tx, mut ref_done_rx) = mpsc::unbounded_channel::<Decision>();
    let mut echo_ref = EchoRef {
        app: app.clone(),
        session_id: session_id.clone(),
        mode,
        token,
        lease: lease.clone(),
        feed: system_feed,
        dsp: dsp_shared.clone(),
        serial: Serial::default(),
        done: ref_done_tx,
        shown: None,
        restart: false,
        restarts: RestartBudget::default(),
    };
    // The hold the machine last heard of (Input::AudioDelay).
    let mut audio_delay = 0u64;
    echo_ref.request();
    let watcher = {
        let tx = ctl_tx.clone();
        match RouteWatcher::start(move || {
            let _ = tx.send(Ctl::RouteChanged);
        }) {
            Ok(w) => {
                #[cfg(target_os = "macos")]
                crate::log_to_file(&format!("[voice] watching the output route ({} listeners)", w.listener_count()));
                Some(w)
            }
            Err(e) => {
                crate::log_to_file(&format!("[voice] no output route watcher: {e}"));
                None
            }
        }
    };
    drop(ctl_tx);
    if mode.converses() {
        tts_prepare(&app);
    }
    // Never headphones up front, whatever the route says: barge-in waits for
    // the DSP thread to measure no echo path (or a converged canceller).
    actor.input(Input::Echo(EchoMode::Converging), actor.now());
    actor.input(Input::Start, actor.now());
    // The level this mic remembers (noisy room), as an input so a debug
    // capture replays it.
    if let Some(db) = actor.memory.as_ref().and_then(Memory::hint) {
        actor.input(Input::SpeechHint { db }, actor.now());
    }
    let initial = *speaking.borrow_and_update();
    actor.input(Input::Speaking(initial), actor.now());

    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_warm = Instant::now();
    let mut speaking_open = true;
    let mut stt_open = true;
    let mut dsp_open = true;

    while actor.ending.is_none() {
        tokio::select! {
            c = ctl.recv() => match c {
                Some(Ctl::RouteChanged) => {
                    on_route_change(&app, &mut actor, &dsp_shared, &session_id, &mut pairing, mode.converses()).await;
                    echo_ref.request();
                }
                Some(c) => actor.on_ctl(c),
                // The registry dropped the session.
                None => actor.on_ctl(Ctl::End(EndReason::Cancelled)),
            },
            e = stt.events.recv(), if stt_open => match e {
                Some(e) => {
                    let now = actor.now();
                    if matches!(e, VoiceSttEvent::Ready) {
                        crate::log_to_file(&format!("[voice] {} transcription ready after {} ms", session_id, now));
                    }
                    // Fed around speech only: back on the session clock.
                    let e = match &feed_clock {
                        Some(clock) => clock.translate(e),
                        None => e,
                    };
                    actor.input(Input::Stt(e), now);
                }
                None => {
                    stt_open = false;
                    let failed = VoiceSttEvent::Failed { reason: "the transcription session went away".into() };
                    actor.input(Input::Stt(failed), actor.now());
                }
            },
            d = dsp_events.recv(), if dsp_open => match d {
                Some(d) => actor.on_dsp(d),
                None => {
                    dsp_open = false;
                    let input = Input::EndWith { reason: EndReason::Error, error: Some("the audio thread stopped".into()) };
                    actor.input(input, actor.now());
                }
            },
            // (Never closed: the actor holds a sender.)
            Some((swap, device)) = device_rx.recv() => actor.on_device(swap, device),
            // (Never closed: this loop holds a sender.)
            Some(result) = recover_rx.recv() => {
                recovering = false;
                match result {
                    // The new stream arrives as MicReplaced.
                    Ok(on) => crate::log_to_file(&format!("[voice] {} mic recovered on {on}", session_id)),
                    Err(e) => {
                        crate::log_to_file(&format!("[voice] {} mic recovery failed ({e}); ending", session_id));
                        let input = Input::EndWith { reason: EndReason::Device, error: Some(format!("the microphone stream failed: {e}")) };
                        actor.input(input, actor.now());
                    }
                }
            },
            // (Never closed: the sender is a static.)
            Ok(()) = pairing.changed() => {
                on_route_change(&app, &mut actor, &dsp_shared, &session_id, &mut pairing, true).await
            }
            // (Never closed: echo_ref holds a sender.)
            Some(d) = ref_done_rx.recv() => echo_ref.finished(d),
            r = speaking.changed(), if speaking_open => match r {
                Ok(()) => {
                    let s = *speaking.borrow_and_update();
                    actor.input(Input::Speaking(s), actor.now());
                }
                Err(_) => speaking_open = false,
            },
            _ = tick.tick() => {
                echo_ref.check_stall();
                let hold = dsp_shared.hold_ms.load(Ordering::Acquire);
                if hold != audio_delay {
                    audio_delay = hold;
                    actor.input(Input::AudioDelay { ms: hold }, actor.now());
                }
                if mic_fault.load(Ordering::SeqCst) && !recovering {
                    if recoveries.allow(Instant::now()) {
                        crate::log_to_file(&format!("[voice] {} mic stream faulted; recovering", session_id));
                        recovering = true;
                        let (app, lease, tx) = (app.clone(), lease.clone(), recover_tx.clone());
                        tauri::async_runtime::spawn_blocking(move || {
                            let _ = tx.send(recover_mic(&app, &lease));
                        });
                        actor.input(Input::Tick, actor.now());
                    } else {
                        crate::log_to_file(&format!(
                            "[voice] {} mic stream faulted again ({MIC_RECOVERIES} recoveries in {} s); ending",
                            session_id,
                            MIC_RECOVERY_WINDOW.as_secs()
                        ));
                        let input = Input::EndWith { reason: EndReason::Device, error: Some("the microphone stream failed".into()) };
                        actor.input(input, actor.now());
                    }
                } else {
                    actor.input(Input::Tick, actor.now());
                }
                // At most once a minute, so a crash keeps it.
                drop(actor.save_level(false));
                if mode.converses() && last_warm.elapsed() >= KEEP_WARM_EVERY {
                    last_warm = Instant::now();
                    tts_prepare(&app);
                }
            },
        }
    }

    // ── teardown ────────────────────────────────────────────────────────────
    let ending = actor.ending.take().unwrap_or(Ending { reason: EndReason::Error, text: None, error: None });
    actor.note(serde_json::json!({ "k": "note", "ended": ending.reason, "turns": actor.turns_sent }));
    if let Some(saving) = actor.save_level(true) {
        let _ = saving.await;
    }
    // (The capture closes when the DSP thread and this actor let go of it.)
    drop(actor.capture.take());
    // Whatever the DSP thread still holds reaches local-stt before it stops,
    // as it would have unheld (a replaced dictation's last audio included).
    let _ = dsp::flush_held_audio(&dsp_shared).await;
    dsp_shared.stop.store(true, Ordering::Relaxed);
    if let Some(thread) = dsp_thread {
        let _ = tauri::async_runtime::spawn_blocking(move || thread.join()).await;
    }
    {
        // The mic lease first (a reconcile job still running then can't
        // start the tap), then the system tap.
        let app = app.clone();
        let lease = lease.clone();
        let (sid, dsp) = (session_id.clone(), dsp_shared.clone());
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Some(voice) = app.try_state::<VoiceService>() {
                voice.release_mic(&lease);
            }
            EchoRef::stop_blocking(&app, &sid, token, &dsp);
        })
        .await;
    }
    drop(echo_ref);
    drop(hold);
    drop(watcher);
    stt.close();
    drop(actor.control);
    drop(stt);
    if let Some(voice) = app.try_state::<VoiceService>() {
        voice.deregister(token);
    }
    // The menu bar lets the mic go now, not at its next check.
    crate::tray::refresh_mic(&app);
    crate::log_to_file(&format!(
        "[voice] {} ended ({:?}{}) after {} ms, {} turn(s)",
        session_id,
        ending.reason,
        ending.error.as_deref().map(|e| format!(": {e}")).unwrap_or_default(),
        ms_since(actor.started),
        actor.turns_sent
    ));
    // Runs still open never became turns.
    if let Some(sp) = actor.speech.as_mut() {
        emit_speech(&app, &session_id, sp.close_all());
    }
    events::emit(
        &app,
        events::ENDED,
        &events::EndedPayload {
            session_id: &session_id,
            reason: ending.reason,
            text: ending.text.as_deref(),
            error: ending.error.as_deref(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::input_devices::{InUse, InUseHandle};

    fn lookup(handle: &InUseHandle) -> Option<Device> {
        handle.live().and_then(|u| Some(Device { uid: u.uid?, name: u.name, input_db: None }))
    }

    #[test]
    fn a_stall_during_a_live_switch_is_not_a_fault() {
        // The stream the session knows is from epoch 2 (one switch done).
        assert!(!stall_from_a_switch(2, 2), "no switch since: a dead mic");
        assert!(stall_from_a_switch(3, 2), "a switch is running");
        // It finished, but the new stream's MicReplaced hasn't arrived yet:
        // the stall was the old stream's.
        assert!(stall_from_a_switch(4, 2));
        // Once it has, a stall is the new stream's own.
        assert!(!stall_from_a_switch(4, 4));
    }

    #[test]
    fn mic_recoveries_are_bounded_per_window() {
        let t0 = Instant::now();
        let mut r = Recoveries::default();
        for i in 0..MIC_RECOVERIES {
            assert!(r.allow(t0 + Duration::from_secs(i as u64)), "recovery {i}");
        }
        assert!(!r.allow(t0 + Duration::from_secs(10)), "one too many within the window");
        // The first one ages out: room for one more.
        assert!(r.allow(t0 + MIC_RECOVERY_WINDOW));
        assert!(!r.allow(t0 + MIC_RECOVERY_WINDOW));
    }

    /// A mic swap: the DSP thread saw the new stream (its tap started over)
    /// while MicCapture was still building it, so nothing is in use yet. The
    /// lookup waits for the new device instead of taking that for "unknown",
    /// so the session starts from the new mic's remembered level and keeps
    /// saving for it. Never published: it gives up, unknown.
    #[test]
    fn a_mic_swap_lookup_waits_for_the_new_stream_to_publish_its_device() {
        let handle = InUseHandle::default();
        handle.recording.store(true, Ordering::SeqCst);
        // Retired: the old stream's device is gone, the new one not up yet.
        assert_eq!(lookup(&handle), None, "what a single lookup read");
        let publisher = {
            let h = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                *h.device.lock().unwrap() = Some(InUse { uid: Some("headset".into()), name: "Headset".into() });
            })
        };
        let t0 = Instant::now();
        let mut levels = levels::Levels::new();
        levels.insert("headset".into(), levels::Level { db: -20.0, turns: 12, updated_at: "t".into(), input_db: None });
        let mut memory = Memory::new(levels, Some(Device { uid: "builtin".into(), name: "MacBook Pro Microphone".into(), input_db: None }), t0);
        memory.detach(4, t0);
        let found = await_device(|| lookup(&handle), Duration::from_millis(10), Duration::from_secs(3));
        publisher.join().unwrap();
        assert!(t0.elapsed() >= Duration::from_millis(150));
        assert_eq!(found.as_ref().map(|d| d.uid.as_str()), Some("headset"));
        assert_eq!(memory.attach(found, Instant::now()), Some(-20.0), "the new mic's level");
        assert_eq!(memory.device().map(|d| d.uid.as_str()), Some("headset"), "and saves go to it");

        let never = InUseHandle::default();
        never.recording.store(true, Ordering::SeqCst);
        let t1 = Instant::now();
        assert_eq!(await_device(|| lookup(&never), Duration::from_millis(10), Duration::from_millis(80)), None);
        let waited = t1.elapsed();
        assert!(waited >= Duration::from_millis(80) && waited < Duration::from_secs(1), "{waited:?}");
    }
}
