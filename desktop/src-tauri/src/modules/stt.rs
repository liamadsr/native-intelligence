//! local-stt adapter: tees PCM into the NeMo-Speech.cpp sidecar and delivers
//! its Deepgram-shaped messages to one of two consumers.
//!
//! **Meeting capture → the web** ([`start`]). Bridge contract
//! (web/docs/plans/local-modules.md §1.6). Every payload carries the
//! recording's `session` id so a straggler from a finished session can never
//! land in the next one:
//! - `stt://message`        { session, stream: "mic" | "system", message }  Deepgram-shaped
//! - `stt://engine-changed` { session, engine: "deepgram", reason }          fall back now
//! - `stt://finished`       { session }                                      after stop, tail flushed
//!
//! **Voice session → Rust** ([`start_voice`]). One stream (`mic`), no
//! diarizer. Messages arrive as parsed [`VoiceSttEvent`]s on an mpsc
//! receiver, never as webview events, and [`VoiceSttControl::finalize`] ends
//! the current utterance on demand (web/docs/plans/chat-voice.md
//! §3.2): it resolves
//! once the sidecar's `finalized` ack is in, by which time every event for
//! the audio pushed before the call is already in the receiver.
//!
//! Lifecycle (both): `start*` returns immediately with a sink the capture
//! callbacks push into; the sidecar spawns and loads in the background while
//! audio queues (bounded). [`SttSink::close`] (meeting stop, or dropping the
//! voice handle) → the task sends `finish`, delivers the final results,
//! reports finished, reaps the process.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Notify};

use super::manager::LaunchConfig;
use super::protocol::Frame;
use super::supervisor::{Link, Sidecar, SidecarProcess};

pub const MODULE_ID: &str = "local-stt";

pub const STREAM_MIC: u8 = 0;
pub const STREAM_SYSTEM: u8 = 1;
/// The mic stream's name in `configure` and in `finalize`.
const STREAM_MIC_NAME: &str = "mic";
const SAMPLE_RATE: u32 = 16_000;

/// Audio frames queued while the sidecar loads (~1.6 s warm, longer right
/// after an app update recompiles GPU kernels). Capture chunks are ~10–60 ms,
/// so this covers well over a minute per stream before dropping.
const AUDIO_QUEUE_FRAMES: usize = 8192;
/// Load + handshake budget before falling back to Deepgram.
const START_TIMEOUT: Duration = Duration::from_secs(90);
/// How long stop waits for the tail to flush before giving up.
const FINISH_TIMEOUT: Duration = Duration::from_secs(4);
/// Most silence sent per push while repaying dropped audio (1 s): bounds the
/// allocation on the capture thread while still catching up ~50× real time.
const MAX_GAP_REPAY_SAMPLES: u64 = SAMPLE_RATE as u64;
/// Default wait for a `finalized` ack (chat-voice.md §3.1: ≤ 1.5 s).
pub const FINALIZE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Latency/accuracy knob: RNNT right context in 80 ms frames. 6 → 0.56 s
/// chunks (bake-off default: better accuracy, ~half the GPU of 0.16 s).
const RNNT_RIGHT_CONTEXT: u32 = 6;

/// State shared by the sink (capture side), the voice control and the
/// session task. Deliberately NOT holding the input sender, so the task can
/// observe it without keeping the channel open.
struct Shared {
    /// The engine failed; audio is no longer wanted.
    failed: AtomicBool,
    /// The session was told to stop; audio is no longer wanted.
    closed: AtomicBool,
    /// Wakes the task when `closed` is set.
    stop: Notify,
    /// Chunks dropped on a full queue (logged by the task, never from the
    /// capture thread).
    dropped: AtomicU64,
}

impl Shared {
    fn new() -> Self {
        Self {
            failed: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            stop: Notify::new(),
            dropped: AtomicU64::new(0),
        }
    }

    fn close(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.stop.notify_one();
        }
    }
}

/// What the session task reads, in order: audio from the sink, or a finalize
/// from a voice control. One channel, so a finalize always reaches the
/// sidecar after every chunk pushed before it.
enum Input {
    Audio(Frame),
    Finalize {
        stream: &'static str,
        seq: u64,
        reply: oneshot::Sender<Result<(), FinalizeError>>,
    },
}

/// Cheap, non-blocking handle the capture callbacks push PCM into.
pub struct SttSink {
    tx: mpsc::Sender<Input>,
    shared: Arc<Shared>,
    /// Samples dropped on a full queue and not yet repaid, per stream. The
    /// engine's timestamps are its own sample count, and the web lines them
    /// up with the audio:// clock (Voice ID, Deepgram fallback), so dropped
    /// audio is replaced by the same amount of silence instead of vanishing.
    owed: [AtomicU64; 2],
}

impl SttSink {
    /// Called from capture callbacks — the mic one runs on the CoreAudio IO
    /// thread, so this never blocks and never does I/O. On a full queue the
    /// chunk is dropped and owed back as silence once there is room.
    pub fn push(&self, stream: u8, samples: &[f32]) {
        if samples.is_empty()
            || self.shared.failed.load(Ordering::Relaxed)
            || self.shared.closed.load(Ordering::Relaxed)
        {
            return;
        }
        let Some(owed) = self.owed.get(stream as usize) else { return };

        let debt = owed.load(Ordering::Relaxed);
        if debt > 0 {
            let repay = debt.min(MAX_GAP_REPAY_SAMPLES);
            let silence = Input::Audio(Frame::Audio {
                stream,
                sample_rate: SAMPLE_RATE,
                samples: vec![0.0; repay as usize],
            });
            if self.tx.try_send(silence).is_ok() {
                owed.fetch_sub(repay, Ordering::Relaxed);
            } else {
                // Still full: this chunk joins the debt, keeping order.
                owed.fetch_add(samples.len() as u64, Ordering::Relaxed);
                self.shared.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
        }

        let frame = Input::Audio(Frame::Audio {
            stream,
            sample_rate: SAMPLE_RATE,
            samples: samples.to_vec(),
        });
        if self.tx.try_send(frame).is_err() {
            owed.fetch_add(samples.len() as u64, Ordering::Relaxed);
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// For a producer that can wait instead of a capture callback (a Studio
    /// take's microphone file, read faster than real time): queue the chunk
    /// behind the ones before it, waiting for room rather than dropping it.
    /// false = the session has failed or closed; nothing more is wanted.
    pub async fn push_wait(&self, stream: u8, samples: &[f32]) -> bool {
        if self.shared.failed.load(Ordering::Relaxed) || self.shared.closed.load(Ordering::Relaxed) {
            return false;
        }
        if samples.is_empty() {
            return true;
        }
        let frame = Input::Audio(Frame::Audio {
            stream,
            sample_rate: SAMPLE_RATE,
            samples: samples.to_vec(),
        });
        self.tx.send(frame).await.is_ok()
    }

    /// The recording stopped: finish the session even if some capture
    /// callback still holds a clone of this sink.
    pub fn close(&self) {
        self.shared.close();
    }
}

/// Start a local transcription session for recording `session_id`. Returns
/// the sink to feed; failures after this point surface as
/// `stt://engine-changed`.
pub fn start(app: &AppHandle, launch: LaunchConfig, session_id: String) -> Arc<SttSink> {
    let output = WebviewOutput { emitter: app.clone(), session: session_id };
    let parts = Parts::new(Box::new(output), configure(&launch));
    let (sink, session, input) = (parts.sink, parts.session, parts.input);
    tauri::async_runtime::spawn(async move {
        session.run(launch, input).await;
    });
    sink
}

/// Start a voice-session transcription: one `mic` stream (id [`STREAM_MIC`]),
/// no diarizer, endpointing as for meetings. Push 16 kHz mono PCM into the
/// sink on [`STREAM_MIC`]; events arrive on the handle, starting with
/// [`VoiceSttEvent::Ready`] once the models are loaded. Dropping the handle
/// ends the session.
pub fn start_voice(launch: LaunchConfig) -> (Arc<SttSink>, VoiceSttHandle) {
    let (events_tx, events) = mpsc::unbounded_channel();
    let parts = Parts::new(Box::new(ChannelOutput { events: events_tx }), voice_configure(&launch));
    let handle = VoiceSttHandle { control: parts.control, events };
    let (session, input) = (parts.session, parts.input);
    tauri::async_runtime::spawn(async move {
        session.run(launch, input).await;
    });
    (parts.sink, handle)
}

/// Everything one session needs, wired together but not yet running.
struct Parts {
    sink: Arc<SttSink>,
    control: VoiceSttControl,
    session: Session,
    input: mpsc::Receiver<Input>,
}

impl Parts {
    fn new(output: Box<dyn Output>, configure: Value) -> Self {
        let (tx, input) = mpsc::channel::<Input>(AUDIO_QUEUE_FRAMES);
        let shared = Arc::new(Shared::new());
        let sink = Arc::new(SttSink {
            tx: tx.clone(),
            shared: shared.clone(),
            owed: [AtomicU64::new(0), AtomicU64::new(0)],
        });
        let control = VoiceSttControl { input: tx, shared: shared.clone() };
        let session = Session {
            output,
            shared,
            configure,
            relayed: 0,
            pending: VecDeque::new(),
        };
        Self { sink, control, session, input }
    }
}

fn configure(launch: &LaunchConfig) -> Value {
    json!({
        "assets": launch.assets_json(),
        "streams": [
            { "id": STREAM_MIC, "name": STREAM_MIC_NAME },
            { "id": STREAM_SYSTEM, "name": "system" }
        ],
        "language": "en-US",
        "rnntRightContext": RNNT_RIGHT_CONTEXT,
        "endpointing": true,
        "speechContexts": []
    })
}

/// The voice session's `configure`: the mic stream only, and no diarizer
/// asset, so the sidecar never loads Sortformer.
fn voice_configure(launch: &LaunchConfig) -> Value {
    let mut assets = launch.assets_json();
    if let Some(map) = assets.as_object_mut() {
        map.remove("diarizer");
    }
    json!({
        "assets": assets,
        "streams": [{ "id": STREAM_MIC, "name": STREAM_MIC_NAME }],
        "language": "en-US",
        "rnntRightContext": RNNT_RIGHT_CONTEXT,
        "endpointing": true,
        "speechContexts": []
    })
}

// ---- voice consumer ---------------------------------------------------------

/// One word of a [`SttResults`]. Times are seconds on the stream's audio
/// clock: samples pushed since the session started (dropped audio is repaid
/// as silence, and the sidecar hides its finalize padding).
#[derive(Debug, Clone, PartialEq)]
pub struct SttWord {
    /// As displayed (punctuated).
    pub word: String,
    pub start: f64,
    pub end: f64,
    pub confidence: f64,
}

/// A Deepgram-shaped `Results` message.
#[derive(Debug, Clone, PartialEq)]
pub struct SttResults {
    /// false = interim: the utterance so far, replaced by later results.
    pub is_final: bool,
    /// The last final of an utterance.
    pub speech_final: bool,
    /// This final was forced by a `finalize` request.
    pub from_finalize: bool,
    pub transcript: String,
    pub start: f64,
    pub duration: f64,
    pub words: Vec<SttWord>,
}

/// What a voice session's transcription delivers, in the sidecar's order.
#[derive(Debug, Clone, PartialEq)]
pub enum VoiceSttEvent {
    /// Models loaded; audio pushed so far is being transcribed.
    Ready,
    Results(SttResults),
    /// First words of a new utterance (`timestamp` = its first word's start).
    SpeechStarted { timestamp: f64 },
    /// Two seconds without words after the last final (not sent for an
    /// utterance that a finalize ended).
    UtteranceEnd { last_word_end: f64 },
    /// `finalize(seq)` has been handed to the engine, behind every chunk
    /// pushed before it (while the engine loads, a finalize waits in the
    /// queue with the audio): its ack can only come after this.
    FinalizeSent { seq: u64 },
    /// The ack for `finalize(seq)`: every event before this one covers all
    /// audio pushed before that call; nothing after it does.
    Finalized { seq: u64 },
    /// The engine failed to start or stopped mid-session. Always the last
    /// event: no [`VoiceSttEvent::Finished`] follows.
    Failed { reason: String },
    /// The session ended after a close; the tail was flushed.
    Finished,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum FinalizeError {
    #[error("the local engine did not acknowledge the finalize in time")]
    Timeout,
    #[error("the transcription session has ended")]
    Closed,
    #[error("the local engine refused the finalize: {0}")]
    Rejected(String),
}

/// Cloneable control side of a voice session (finalize, close).
#[derive(Clone)]
pub struct VoiceSttControl {
    input: mpsc::Sender<Input>,
    shared: Arc<Shared>,
}

impl VoiceSttControl {
    /// End the current utterance now; resolves on the matching `finalized`
    /// ack, within [`FINALIZE_TIMEOUT`]. Audio pushed into the sink before
    /// this call is covered: its final `Results` are in the event receiver
    /// before this resolves. `seq` is the caller's and is echoed in
    /// [`VoiceSttEvent::Finalized`].
    #[allow(dead_code)] // the handle's shorthand; chat voice waits longer (finalize_within)
    pub async fn finalize(&self, seq: u64) -> Result<(), FinalizeError> {
        self.finalize_within(seq, FINALIZE_TIMEOUT).await
    }

    pub async fn finalize_within(&self, seq: u64, timeout: Duration) -> Result<(), FinalizeError> {
        if self.shared.failed.load(Ordering::SeqCst) || self.shared.closed.load(Ordering::SeqCst) {
            return Err(FinalizeError::Closed);
        }
        let (reply, ack) = oneshot::channel();
        let request = Input::Finalize { stream: STREAM_MIC_NAME, seq, reply };
        tokio::time::timeout(timeout, async {
            // Queued behind the audio already pushed (the queue is bounded,
            // so this waits if the sidecar is still loading and it is full).
            self.input.send(request).await.map_err(|_| FinalizeError::Closed)?;
            ack.await.map_err(|_| FinalizeError::Closed)?
        })
        .await
        .map_err(|_| FinalizeError::Timeout)?
    }

    /// End the session: the tail is flushed, then [`VoiceSttEvent::Finished`].
    pub fn close(&self) {
        self.shared.close();
    }
}

/// A voice session's transcription. `control` and `events` are separate
/// fields so a consumer can `select!` on `events.recv()` while a
/// `control.finalize()` is in flight. Dropping the handle closes the session.
pub struct VoiceSttHandle {
    pub control: VoiceSttControl,
    pub events: mpsc::UnboundedReceiver<VoiceSttEvent>,
}

impl VoiceSttHandle {
    pub async fn finalize(&self, seq: u64) -> Result<(), FinalizeError> {
        self.control.finalize(seq).await
    }

    pub fn close(&self) {
        self.control.close();
    }
}

impl Drop for VoiceSttHandle {
    fn drop(&mut self) {
        self.control.close();
    }
}

fn num(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// Parse one Deepgram-shaped sidecar message. `None` for types a voice
/// session has no use for.
pub fn parse_message(message: &Value) -> Option<VoiceSttEvent> {
    match message.get("type").and_then(Value::as_str)? {
        "Results" => {
            let alt = message
                .pointer("/channel/alternatives/0")
                .cloned()
                .unwrap_or(Value::Null);
            let words = alt
                .get("words")
                .and_then(Value::as_array)
                .map(|ws| {
                    ws.iter()
                        .map(|w| SttWord {
                            word: w
                                .get("punctuated_word")
                                .or_else(|| w.get("word"))
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            start: num(w, "start"),
                            end: num(w, "end"),
                            confidence: num(w, "confidence"),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let flag = |key: &str| message.get(key).and_then(Value::as_bool).unwrap_or(false);
            Some(VoiceSttEvent::Results(SttResults {
                is_final: flag("is_final"),
                speech_final: flag("speech_final"),
                from_finalize: flag("from_finalize"),
                transcript: alt.get("transcript").and_then(Value::as_str).unwrap_or("").to_string(),
                start: num(message, "start"),
                duration: num(message, "duration"),
                words,
            }))
        }
        "SpeechStarted" => Some(VoiceSttEvent::SpeechStarted { timestamp: num(message, "timestamp") }),
        "UtteranceEnd" => Some(VoiceSttEvent::UtteranceEnd { last_word_end: num(message, "last_word_end") }),
        _ => None,
    }
}

// ---- delivery -----------------------------------------------------------------

/// Where a session's results go.
trait Output: Send + Sync + 'static {
    /// For log lines.
    fn label(&self) -> String;
    fn ready(&self) {}
    /// One `transcript` message. false = the consumer is gone.
    fn transcript(&self, stream: Value, message: Value) -> bool;
    /// A finalize was written to the engine.
    fn finalize_sent(&self, _seq: u64) {}
    fn finalized(&self, _seq: u64) {}
    fn failed(&self, reason: &str);
    fn finished(&self);
}

/// Emits a webview event (an `AppHandle` in the app, a recorder in tests).
trait EventEmitter: Send + Sync + 'static {
    fn emit_json(&self, event: &str, payload: Value);
}

impl EventEmitter for AppHandle {
    fn emit_json(&self, event: &str, payload: Value) {
        let _ = self.emit(event, payload);
    }
}

/// Meeting capture: today's `stt://*` events, unchanged.
struct WebviewOutput<E: EventEmitter> {
    emitter: E,
    session: String,
}

impl<E: EventEmitter> Output for WebviewOutput<E> {
    fn label(&self) -> String {
        format!("session {}", self.session)
    }

    fn transcript(&self, stream: Value, message: Value) -> bool {
        self.emitter.emit_json(
            "stt://message",
            json!({ "session": self.session, "stream": stream, "message": message }),
        );
        true
    }

    /// Tell the web to fall back (the session calls this once).
    fn failed(&self, reason: &str) {
        crate::log_to_file(&format!("[module:{}] falling back to Deepgram: {}", MODULE_ID, reason));
        self.emitter.emit_json(
            "stt://engine-changed",
            json!({ "session": self.session, "engine": "deepgram", "reason": reason }),
        );
    }

    fn finished(&self) {
        self.emitter.emit_json("stt://finished", json!({ "session": self.session }));
    }
}

/// Voice session: parsed events on a Rust channel. Unbounded because the
/// rate is a few messages a second and the session task must never stall on
/// a consumer that is itself awaiting a finalize ack.
struct ChannelOutput {
    events: mpsc::UnboundedSender<VoiceSttEvent>,
}

impl Output for ChannelOutput {
    fn label(&self) -> String {
        "voice session".into()
    }

    fn ready(&self) {
        let _ = self.events.send(VoiceSttEvent::Ready);
    }

    fn transcript(&self, _stream: Value, message: Value) -> bool {
        match parse_message(&message) {
            Some(event) => self.events.send(event).is_ok(),
            None => !self.events.is_closed(),
        }
    }

    fn finalize_sent(&self, seq: u64) {
        let _ = self.events.send(VoiceSttEvent::FinalizeSent { seq });
    }

    fn finalized(&self, seq: u64) {
        let _ = self.events.send(VoiceSttEvent::Finalized { seq });
    }

    fn failed(&self, reason: &str) {
        crate::log_to_file(&format!("[module:{}] voice session failed: {}", MODULE_ID, reason));
        let _ = self.events.send(VoiceSttEvent::Failed { reason: reason.to_string() });
    }

    fn finished(&self) {
        let _ = self.events.send(VoiceSttEvent::Finished);
    }
}

// ---- the session task -----------------------------------------------------------

/// A finalize sent to the sidecar and not yet acknowledged.
struct PendingFinalize {
    seq: u64,
    reply: oneshot::Sender<Result<(), FinalizeError>>,
}

struct Session {
    output: Box<dyn Output>,
    shared: Arc<Shared>,
    configure: Value,
    /// Transcript messages relayed (diagnostics).
    relayed: u64,
    /// In the order sent; the sidecar acks one stream's finalizes in order.
    pending: VecDeque<PendingFinalize>,
}

async fn reap(process: Option<SidecarProcess>) {
    if let Some(process) = process {
        process.reap(Duration::from_secs(2)).await;
    }
}

impl Session {
    fn stopped(&self) -> bool {
        self.shared.closed.load(Ordering::SeqCst)
    }

    /// Engine failure: tell the consumer (once) and stop taking audio.
    fn fail(&self, reason: String) {
        self.shared.failed.store(true, Ordering::SeqCst);
        self.output.failed(&reason);
    }

    fn log_drops(&self, when: &str) {
        let dropped = self.shared.dropped.load(Ordering::Relaxed);
        if dropped > 0 {
            crate::log_to_file(&format!(
                "[module:{}] {}: {} audio chunk(s) arrived on a full queue and were replaced by silence",
                MODULE_ID, when, dropped
            ));
        }
    }

    async fn run(self, launch: LaunchConfig, input: mpsc::Receiver<Input>) {
        match Sidecar::spawn(MODULE_ID, &launch.exe, &[]) {
            Ok(Sidecar { link, process }) => self.drive(link, Some(process), input).await,
            Err(e) => self.fail(format!("could not start the local engine: {e}")),
        }
    }

    /// Handshake, then pump until the session stops or the sidecar dies.
    /// `process` is `None` for in-process fakes in tests.
    async fn drive(mut self, mut link: Link, process: Option<SidecarProcess>, mut input: mpsc::Receiver<Input>) {
        // Load the models, unless the session stops first — then there is
        // nothing to transcribe and no reason to keep ~1.5 GB loading.
        let configure = std::mem::take(&mut self.configure);
        let handshake = tokio::select! {
            result = link.handshake(MODULE_ID, configure, START_TIMEOUT) => Some(result),
            _ = self.shared.stop.notified() => None,
        };
        match handshake {
            None => {
                crate::log_to_file(&format!(
                    "[module:{}] {} stopped before the engine was ready",
                    MODULE_ID,
                    self.output.label()
                ));
                drop(link);
                reap(process).await;
                return self.output.finished();
            }
            Some(Err(e)) => {
                drop(link);
                reap(process).await;
                if self.stopped() {
                    return self.output.finished();
                }
                return self.fail(format!("the local engine did not start: {e}"));
            }
            Some(Ok(_)) => {}
        }
        crate::log_to_file(&format!("[module:{}] {} ready", MODULE_ID, self.output.label()));
        self.log_drops("while loading");
        self.output.ready();

        let Link { tx: to_sidecar, rx: mut from_sidecar } = link;
        let mut forwarded: u64 = 0;

        // Main loop: forward audio and finalizes, relay results. Ends when
        // the session stops (close(), every sender dropped, or the consumer
        // gone) or the sidecar dies.
        let mut stop_requested = self.stopped();
        while !stop_requested {
            tokio::select! {
                item = input.recv() => match item {
                    Some(item) => {
                        if !self.forward(&to_sidecar, item).await {
                            return self.die(to_sidecar, process).await;
                        }
                        forwarded += 1;
                    }
                    None => break,
                },
                msg = from_sidecar.recv() => match msg {
                    Some(frame) => {
                        if !self.relay(frame) {
                            self.shared.close();
                            stop_requested = true;
                        }
                    }
                    None => return self.die(to_sidecar, process).await,
                },
                _ = self.shared.stop.notified() => stop_requested = true,
            }
        }
        // Audio (and finalizes) queued before the stop are still owed.
        while let Ok(item) = input.try_recv() {
            if !self.forward(&to_sidecar, item).await {
                return self.die(to_sidecar, process).await;
            }
            forwarded += 1;
        }
        drop(input);

        // Flush the last utterance, relay it, then exit.
        crate::log_to_file(&format!(
            "[module:{}] finishing {} after {} inputs, {} transcript messages",
            MODULE_ID,
            self.output.label(),
            forwarded,
            self.relayed
        ));
        self.log_drops("session total");
        let _ = to_sidecar.send(Frame::Json(json!({ "type": "finish" }))).await;
        drop(to_sidecar); // stdin EOF after `finish`
        let flushed = tokio::time::timeout(FINISH_TIMEOUT, async {
            while let Some(frame) = from_sidecar.recv().await {
                self.relay(frame);
            }
        })
        .await
        .is_ok();
        if !flushed {
            crate::log_to_file(&format!("[module:{}] tail flush timed out", MODULE_ID));
        }
        // Finalizes still unanswered resolve as Closed.
        self.pending.clear();
        self.output.finished();
        drop(from_sidecar);
        reap(process).await;
    }

    /// Send one input to the sidecar. false = the sidecar is gone.
    async fn forward(&mut self, to_sidecar: &mpsc::Sender<Frame>, item: Input) -> bool {
        match item {
            Input::Audio(frame) => to_sidecar.send(frame).await.is_ok(),
            Input::Finalize { stream, seq, reply } => {
                // Forget callers that stopped waiting (timed out).
                self.pending.retain(|p| !p.reply.is_closed());
                self.pending.push_back(PendingFinalize { seq, reply });
                let sent = to_sidecar
                    .send(Frame::Json(json!({ "type": "finalize", "stream": stream, "seq": seq })))
                    .await
                    .is_ok();
                if sent {
                    self.output.finalize_sent(seq);
                }
                sent
            }
        }
    }

    /// Resolve the oldest pending finalize with this `seq`.
    fn resolve(&mut self, seq: u64, result: Result<(), FinalizeError>) {
        if let Some(i) = self.pending.iter().position(|p| p.seq == seq) {
            if let Some(p) = self.pending.remove(i) {
                let _ = p.reply.send(result);
            }
        }
    }

    /// The sidecar went away mid-session.
    async fn die(&mut self, to_sidecar: mpsc::Sender<Frame>, process: Option<SidecarProcess>) {
        crate::log_to_file(&format!(
            "[module:{}] engine exited after {} transcript messages",
            MODULE_ID, self.relayed
        ));
        drop(to_sidecar);
        self.pending.clear();
        reap(process).await;
        if self.stopped() {
            self.output.finished();
        } else {
            self.fail("the local engine stopped unexpectedly".into());
        }
    }

    /// Relay one sidecar message. Transcript messages carry their stream and a
    /// Deepgram-shaped payload; `finalized` acks resolve their finalize after
    /// the ack itself is delivered; errors are logged (fatal ones end the
    /// process, which the main loop treats as a failure). false = the
    /// consumer is gone.
    fn relay(&mut self, frame: Frame) -> bool {
        let Frame::Json(value) = frame else { return true };
        match value.get("type").and_then(Value::as_str) {
            Some("transcript") => {
                let stream = value.get("stream").cloned().unwrap_or(Value::Null);
                let message = value.get("message").cloned().unwrap_or(Value::Null);
                self.relayed += 1;
                return self.output.transcript(stream, message);
            }
            Some("finalized") => match value.get("seq").and_then(Value::as_u64) {
                Some(seq) => {
                    // Delivered before the reply, so a consumer woken by the
                    // reply finds the ack (and everything before it) queued.
                    self.output.finalized(seq);
                    self.resolve(seq, Ok(()));
                }
                None => crate::log_to_file(&format!("[module:{}] finalized without seq: {}", MODULE_ID, value)),
            },
            Some("error") => {
                crate::log_to_file(&format!("[module:{}] engine error: {}", MODULE_ID, value));
                if value.get("request").and_then(Value::as_str) == Some("finalize") {
                    if let Some(seq) = value.get("seq").and_then(Value::as_u64) {
                        let message = value.get("message").and_then(Value::as_str).unwrap_or("error");
                        self.resolve(seq, Err(FinalizeError::Rejected(message.to_string())));
                    }
                }
            }
            _ => {}
        }
        true
    }
}

#[cfg(test)]
mod tests;
