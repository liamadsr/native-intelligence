//! The tts actor against an in-process fake sidecar (duplex pipes speaking
//! protocol v1) and a fake output device (a thread that runs the real
//! renderer ~10× faster than real time). No process, no speakers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};

use tokio::io::{duplex, DuplexStream};

use super::*;
use crate::audio::playback::Renderer;
use crate::modules::protocol::{read_frame, write_frame};

const FRAME_SAMPLES: usize = 1920; // 80 ms at 24 kHz
const DEVICE_RATE: u32 = 48_000;

#[derive(Clone, Copy)]
struct Behavior {
    /// Audio frames per utterance.
    frames: usize,
    /// Pause before each frame (synthesis speed).
    frame_delay_ms: u64,
    /// Exit as soon as a `speak` arrives.
    crash_on_speak: bool,
    /// Answer `configure` with a fatal error.
    refuse_start: bool,
    /// Take speaks and never answer.
    hang: bool,
    /// Never send `done` for a text containing "nodone" (a buggy sidecar).
    skip_done: bool,
}

impl Default for Behavior {
    fn default() -> Self {
        Self { frames: 3, frame_delay_ms: 1, crash_on_speak: false, refuse_start: false, hang: false, skip_done: false }
    }
}

struct FakeHost {
    behavior: Mutex<Behavior>,
    events: mpsc::UnboundedSender<(StateEvent, u64)>,
    /// Every message the fake sidecars received, in order.
    received: Arc<Mutex<Vec<Value>>>,
    starts: AtomicUsize,
    /// Fake sidecars that have exited (saw EOF, or crashed).
    exits: Arc<AtomicUsize>,
    opens: AtomicUsize,
    closes: AtomicUsize,
    fail_open: AtomicBool,
    /// Opens block while set (a wedged CoreAudio).
    hold_open: Arc<AtomicBool>,
    opener: OutputOpener,
    /// Device frames with signal the fake device has played.
    heard: Arc<AtomicU64>,
    /// Spawn this real sidecar (exe, assets dir) instead of the fake.
    real: Option<(std::path::PathBuf, std::path::PathBuf)>,
    /// Play through the Mac's default output device instead of the fake one.
    speakers: bool,
    /// The AudioObjectID fake players report (0: none).
    device: Arc<AtomicU32>,
}

impl FakeHost {
    fn new(behavior: Behavior) -> (Arc<FakeHost>, mpsc::UnboundedReceiver<(StateEvent, u64)>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let host = Arc::new(FakeHost {
            behavior: Mutex::new(behavior),
            events: tx,
            received: Arc::new(Mutex::new(Vec::new())),
            starts: AtomicUsize::new(0),
            exits: Arc::new(AtomicUsize::new(0)),
            opens: AtomicUsize::new(0),
            closes: AtomicUsize::new(0),
            fail_open: AtomicBool::new(false),
            hold_open: Arc::new(AtomicBool::new(false)),
            opener: OutputOpener::new(Duration::from_secs(1)),
            heard: Arc::new(AtomicU64::new(0)),
            real: None,
            speakers: false,
            device: Arc::new(AtomicU32::new(0)),
        });
        (host, rx)
    }

    fn received(&self, ty: &str) -> Vec<Value> {
        self.received.lock().unwrap().iter().filter(|v| v["type"] == ty).cloned().collect()
    }
}

impl Host for FakeHost {
    fn start_engine(&self) -> BoxFuture<Result<Engine, StartError>> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        if let Some((exe, dir)) = self.real.clone() {
            return Box::pin(start_real(exe, dir));
        }
        let behavior = *self.behavior.lock().unwrap();
        let received = self.received.clone();
        let exits = self.exits.clone();
        Box::pin(async move {
            let (host_read, side_write) = duplex(1 << 20);
            let (side_read, host_write) = duplex(1 << 20);
            tokio::spawn(fake_sidecar(side_read, side_write, behavior, received, exits));
            let mut link = Link::over("tts-test".into(), host_read, host_write);
            let launch = LaunchConfig {
                exe: "/nonexistent/dial8-local-tts".into(),
                assets: HashMap::from([("tokenizer".to_string(), "/m/tokenizer.model".into())]),
            };
            match link.handshake(MODULE_ID, configure(&launch), Duration::from_secs(2)).await {
                Ok(hello) => Ok(Engine { voices: ready_voices(&hello.ready), link, process: None }),
                Err(e) => Err(StartError::Failed(e.to_string())),
            }
        })
    }

    fn open_output(&self, gate: Arc<CancelGate>) -> BoxFuture<Result<Player, String>> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        if self.fail_open.load(Ordering::SeqCst) {
            return Box::pin(async { Err("no output device".to_string()) });
        }
        if self.speakers {
            return self.opener.open(move || crate::audio::playback::open_default_output(gate));
        }
        let hold = self.hold_open.clone();
        let heard = self.heard.clone();
        let device = self.device.load(Ordering::SeqCst);
        self.opener.open(move || {
            while hold.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            let (mut player, renderer) = Player::new(DEVICE_RATE, gate);
            player.set_device_id((device != 0).then_some(device));
            fake_device(renderer, heard);
            Ok(player)
        })
    }

    fn close_output(&self, player: Player) {
        self.closes.fetch_add(1, Ordering::SeqCst);
        drop(player);
    }

    fn emit(&self, event: StateEvent) {
        // Logged beside what the sidecars received, in order (read-ahead test).
        self.received.lock().unwrap().push(json!({"type":"_event","id":event.id,"state":event.state}));
        let _ = self.events.send((event, self.heard.load(Ordering::SeqCst)));
    }
}

/// The real sidecar, configured like the app does, with assets from `dir`.
async fn start_real(exe: std::path::PathBuf, dir: std::path::PathBuf) -> Result<Engine, StartError> {
    let manifest = registry::find(MODULE_ID).unwrap().manifest();
    let launch = LaunchConfig {
        exe,
        assets: manifest.assets.iter().map(|a| (a.name.clone(), dir.join(&a.file))).collect(),
    };
    let Sidecar { mut link, process } =
        Sidecar::spawn(MODULE_ID, &launch.exe, &[]).map_err(|e| StartError::Failed(e.to_string()))?;
    match link.handshake(MODULE_ID, configure(&launch), START_TIMEOUT).await {
        Ok(hello) => Ok(Engine { voices: ready_voices(&hello.ready), link, process: Some(process) }),
        Err(e) => {
            drop(link);
            process.reap(Duration::from_secs(2)).await;
            Err(StartError::Failed(e.to_string()))
        }
    }
}

/// A stereo device consuming 480 frames per millisecond (10× real time at
/// 48 kHz) until its player is dropped.
fn fake_device(mut renderer: Renderer, heard: Arc<AtomicU64>) {
    std::thread::spawn(move || {
        let mut buf = vec![0f32; 480 * 2];
        while !renderer.is_retired() {
            renderer.render(&mut buf, 2);
            let with_signal = buf.chunks(2).filter(|f| f[0].abs() > 1e-4).count();
            assert!(buf.chunks(2).all(|f| f[0] == f[1]), "mono on every channel");
            heard.fetch_add(with_signal as u64, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(1));
        }
    });
}

async fn send(w: &mut DuplexStream, v: Value) -> bool {
    write_frame(w, &Frame::Json(v)).await.is_ok()
}

/// A protocol-v1 local-tts sidecar: speaks are queued and synthesized in
/// order (started → audio frames → done); cancel drops the current one and
/// the queue; it exits on stdin EOF.
async fn fake_sidecar(
    mut r: DuplexStream,
    mut w: DuplexStream,
    b: Behavior,
    received: Arc<Mutex<Vec<Value>>>,
    exits: Arc<AtomicUsize>,
) {
    // read_frame is not cancel-safe; read on a task and select on a channel.
    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        while let Ok(Some(Frame::Json(v))) = read_frame(&mut r).await {
            if in_tx.send(v).is_err() {
                break;
            }
        }
    });

    'run: {
        if !send(&mut w, json!({"type":"hello","module":"local-tts","protocol":1,"version":"fake"})).await {
            break 'run;
        }
        let Some(cfg) = in_rx.recv().await else { break 'run };
        received.lock().unwrap().push(cfg);
        if b.refuse_start {
            send(&mut w, json!({"type":"error","code":"model_missing","message":"no model","fatal":true})).await;
            break 'run;
        }
        send(&mut w, json!({"type":"ready","voices":["tana","cha"]})).await;

        let mut queue: VecDeque<(String, String)> = VecDeque::new();
        let mut current: Option<(String, usize)> = None;
        loop {
            if current.is_none() {
                if let Some((id, text)) = queue.pop_front() {
                    if text.contains("boom") {
                        send(&mut w, json!({"type":"error","id":id,"code":"synthesis_failed","message":"boom","fatal":false})).await;
                        continue;
                    }
                    send(&mut w, json!({"type":"started","id":id})).await;
                    current = Some((id, 0));
                }
            }
            let synthesizing = current.is_some();
            tokio::select! {
                msg = in_rx.recv() => {
                    let Some(v) = msg else { break 'run }; // stdin EOF
                    received.lock().unwrap().push(v.clone());
                    match v["type"].as_str() {
                        Some("speak") => {
                            if b.crash_on_speak {
                                break 'run;
                            }
                            if b.hang {
                                continue;
                            }
                            // Like the real sidecar: an id it lacks is a
                            // non-fatal `unknown_voice`, never spoken.
                            if !["tana", "cha"].contains(&v["voice"].as_str().unwrap_or("")) {
                                send(&mut w, json!({"type":"error","id":v["id"],"code":"unknown_voice","message":"no voice","fatal":false})).await;
                                continue;
                            }
                            queue.push_back((v["id"].as_str().unwrap().into(), v["text"].as_str().unwrap().into()));
                        }
                        Some("cancel") => {
                            let mut ids: Vec<String> = current.take().map(|c| c.0).into_iter().collect();
                            ids.extend(queue.drain(..).map(|q| q.0));
                            send(&mut w, json!({"type":"cancelled","ids":ids})).await;
                        }
                        _ => {} // shutdown: wait for EOF
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(b.frame_delay_ms)), if synthesizing => {
                    let (id, sent) = current.as_mut().unwrap();
                    let audio = Frame::Audio { stream: 0, sample_rate: SPEECH_RATE, samples: vec![0.1; FRAME_SAMPLES] };
                    if write_frame(&mut w, &audio).await.is_err() {
                        break 'run;
                    }
                    *sent += 1;
                    if *sent >= b.frames && b.skip_done && id.contains("nodone") {
                        current = None;
                    } else if *sent >= b.frames {
                        let secs = (b.frames * FRAME_SAMPLES) as f64 / SPEECH_RATE as f64;
                        send(&mut w, json!({"type":"done","id":id,"audioSeconds":secs})).await;
                        current = None;
                    }
                }
            }
        }
    }
    exits.fetch_add(1, Ordering::SeqCst);
}

fn timing() -> Timing {
    Timing {
        idle: Duration::from_secs(600),
        linger: Duration::from_millis(100),
        tick: Duration::from_millis(5),
        stall: Duration::from_secs(20),
        restart_window: Duration::from_secs(600),
        max_restarts: 3,
        shutdown_grace: Duration::from_millis(200),
        reopen_backoff: Duration::from_millis(50),
    }
}

fn start(host: &Arc<FakeHost>, timing: Timing) -> TtsService {
    let (service, actor) = TtsService::with_host(host.clone(), timing);
    tokio::spawn(actor.run());
    service
}

async fn next(rx: &mut mpsc::UnboundedReceiver<(StateEvent, u64)>) -> (StateEvent, u64) {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("timed out waiting for a tts://state event")
        .expect("event channel closed")
}

/// The next events must be exactly these; returns the device-frame count
/// heard when each was emitted.
async fn expect(
    rx: &mut mpsc::UnboundedReceiver<(StateEvent, u64)>,
    want: &[(&str, UtteranceState, Option<&str>)],
) -> Vec<u64> {
    let mut heard = Vec::new();
    for (id, state, error) in want {
        let (ev, h) = next(rx).await;
        assert_eq!(
            (ev.id.as_str(), ev.state, ev.error.as_deref()),
            (*id, *state, *error),
            "unexpected event order"
        );
        heard.push(h);
    }
    heard
}

async fn wait_until(what: &str, cond: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(std::time::Instant::now() < deadline, "timed out waiting until {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

use UtteranceState::*;

/// Device frames one fake utterance plays: 24 kHz frames × 2 at 48 kHz.
const UTTERANCE_DEVICE_FRAMES: u64 = (3 * FRAME_SAMPLES * 2) as u64;

#[tokio::test]
async fn speaks_in_order_and_done_follows_the_last_played_sample() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    tts.speak("a".into(), "Hello there.".into(), None);
    tts.speak("b".into(), "General Kenobi.".into(), Some("cha".into()));

    let heard = expect(
        &mut rx,
        &[
            ("a", Queued, None),
            ("b", Queued, None),
            ("a", Speaking, None),
            ("a", Done, None),
            ("b", Speaking, None),
            ("b", Done, None),
        ],
    )
    .await;
    // `done` waits for playback, not synthesis: by then the device has
    // played (almost — the counter lags by one 480-frame buffer) all of it.
    assert!(heard[2] < UTTERANCE_DEVICE_FRAMES, "speaking fired at its first sample");
    assert!(heard[3] + 480 >= UTTERANCE_DEVICE_FRAMES * 95 / 100, "a done at {} frames", heard[3]);
    assert!(heard[5] + 480 >= 2 * UTTERANCE_DEVICE_FRAMES * 95 / 100, "b done at {} frames", heard[5]);

    let cfg = &host.received("configure")[0];
    assert_eq!(cfg["threads"], 2);
    assert_eq!(cfg["lsdSteps"], 8);
    assert_eq!(cfg["warmup"], false);
    assert_eq!(cfg["assets"]["tokenizer"], "/m/tokenizer.model");
    let speaks = host.received("speak");
    let sent: Vec<_> = speaks.iter().map(|s| (s["id"].as_str().unwrap(), s["voice"].as_str().unwrap())).collect();
    assert_eq!(sent, vec![("a", "tana"), ("b", "cha")], "in order, default voice, requested voice");
    assert_eq!(host.starts.load(Ordering::SeqCst), 1, "one sidecar serves both");
    assert_eq!(host.opens.load(Ordering::SeqCst), 1, "one stream for back-to-back sentences");
}

/// The Speed setting stretches what plays, not what the sidecar makes: at 2×
/// a sentence takes half the device frames, at 0.5× twice as many.
#[tokio::test]
async fn the_speed_setting_changes_how_long_a_sentence_plays() {
    for (rate, frames) in [(2.0f32, UTTERANCE_DEVICE_FRAMES / 2), (0.5, UTTERANCE_DEVICE_FRAMES * 2)] {
        let (host, mut rx) = FakeHost::new(Behavior::default());
        let tts = start(&host, timing());
        assert_eq!(tts.set_rate(rate), rate);
        tts.speak("a".into(), "Hello there.".into(), None);
        let heard = expect(&mut rx, &[("a", Queued, None), ("a", Speaking, None), ("a", Done, None)]).await;
        let done = heard[2] as f64;
        let want = frames as f64;
        assert!((done - want).abs() < want * 0.15 + 960.0, "rate {rate}: done at {done} frames, want about {want}");
    }
    let (host, _rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    assert_eq!(tts.rate(), 1.0, "1× until set");
    assert_eq!(tts.set_rate(9.0), 4.0, "clamped");
}

/// Only speech that starts from silence asks the sidecar to drop the
/// model's lead-in: a reply's first sentence, and the first one after the
/// queue drained. One queued behind a sentence still playing keeps it, as
/// the pause between the two.
#[tokio::test]
async fn speech_starting_from_silence_trims_the_lead_in() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    tts.speak("a".into(), "One.".into(), None);
    tts.speak("b".into(), "Two.".into(), None);
    expect(
        &mut rx,
        &[
            ("a", Queued, None),
            ("b", Queued, None),
            ("a", Speaking, None),
            ("a", Done, None),
            ("b", Speaking, None),
            ("b", Done, None),
        ],
    )
    .await;
    tts.speak("c".into(), "Three.".into(), None);
    expect(&mut rx, &[("c", Queued, None), ("c", Speaking, None), ("c", Done, None)]).await;
    let trims: Vec<_> =
        host.received("speak").iter().map(|s| (s["id"].as_str().unwrap().to_string(), s["trimLead"] == true)).collect();
    assert_eq!(trims, vec![("a".to_string(), true), ("b".to_string(), false), ("c".to_string(), true)]);
}

/// A page that saved a voice since removed from the catalogue (the web keeps
/// the id in localStorage) still gets speech, in the default voice: the host
/// swaps the id before the sidecar, which would refuse it, ever sees it.
#[tokio::test]
async fn a_removed_voice_speaks_in_the_default() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    tts.speak("a".into(), "Hello again.".into(), Some("alba".into()));
    expect(&mut rx, &[("a", Queued, None), ("a", Speaking, None), ("a", Done, None)]).await;
    let speaks = host.received("speak");
    assert_eq!(speaks.len(), 1);
    assert_eq!(speaks[0]["voice"], "tana", "the default, not the stale id");
}

#[tokio::test]
async fn cancel_silences_at_once_even_before_the_actor_runs() {
    let (host, _rx) = FakeHost::new(Behavior::default());
    let (tts, actor) = TtsService::with_host(host.clone(), timing());
    let (mut player, mut renderer) = Player::new(DEVICE_RATE, tts.gate.clone());
    player.push(&[0.5; 64]);
    tts.cancel();
    let mut out = [1.0f32; 16];
    renderer.render(&mut out, 1);
    assert!(out.iter().all(|&s| s == 0.0), "silent before the actor has seen the cancel");
    tokio::spawn(actor.run());
    wait_until("the actor acknowledges", || !tts.gate.silenced()).await;
}

#[tokio::test]
async fn cancel_stops_sound_and_cancels_every_pending_sentence() {
    let (host, mut rx) = FakeHost::new(Behavior { frames: 40, frame_delay_ms: 10, ..Default::default() });
    let tts = start(&host, timing());
    tts.speak("a".into(), "One.".into(), None);
    tts.speak("b".into(), "Two.".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("b", Queued, None), ("a", Speaking, None)]).await;

    tts.cancel();
    expect(&mut rx, &[("a", Cancelled, None), ("b", Cancelled, None)]).await;
    wait_until("the sidecar is told to cancel", || !host.received("cancel").is_empty()).await;

    // The sidecar keeps sending a's frames until it reads the cancel; none of
    // them may reach the device.
    tokio::time::sleep(Duration::from_millis(30)).await;
    let before = host.heard.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(host.heard.load(Ordering::SeqCst), before, "silence after cancel");

    // The same sidecar serves the next sentence.
    host.behavior.lock().unwrap().frames = 3;
    tts.speak("c".into(), "Three.".into(), None);
    expect(&mut rx, &[("c", Queued, None), ("c", Speaking, None), ("c", Done, None)]).await;
    assert_eq!(host.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn idle_timeout_stops_the_sidecar_and_the_next_request_restarts_it() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, Timing { idle: Duration::from_millis(150), ..timing() });
    tts.prepare();
    wait_until("prepare starts the sidecar", || host.received("configure").len() == 1).await;
    wait_until("the idle sidecar exits", || host.exits.load(Ordering::SeqCst) == 1).await;
    assert_eq!(host.received("shutdown").len(), 1, "graceful: shutdown, then EOF");
    assert!(!tts.exhausted(), "an idle stop is not a crash");

    tts.speak("a".into(), "Back again.".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("a", Speaking, None), ("a", Done, None)]).await;
    assert_eq!(host.starts.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn prepare_is_a_no_op_while_running() {
    let (host, _rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    tts.prepare();
    tts.prepare();
    wait_until("the sidecar is ready", || host.received("configure").len() == 1).await;
    tts.prepare();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(host.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn crashes_restart_on_demand_at_most_three_times() {
    let (host, mut rx) = FakeHost::new(Behavior { crash_on_speak: true, ..Default::default() });
    let tts = start(&host, timing());
    for i in 0..4 {
        let id = format!("s{i}");
        tts.speak(id.clone(), "Hello.".into(), None);
        expect(&mut rx, &[(&id, Queued, None), (&id, Error, Some("engine_exited"))]).await;
    }
    assert_eq!(host.starts.load(Ordering::SeqCst), 4, "first start + 3 restarts");
    assert!(tts.exhausted());

    tts.speak("x".into(), "Hello?".into(), None);
    expect(&mut rx, &[("x", Queued, None), ("x", Error, Some("unavailable"))]).await;
    tts.prepare();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(host.starts.load(Ordering::SeqCst), 4, "no fifth start in the window");
}

#[tokio::test]
async fn crash_budget_frees_up_after_the_window() {
    let (host, mut rx) = FakeHost::new(Behavior { crash_on_speak: true, ..Default::default() });
    let tts = start(&host, Timing { restart_window: Duration::from_millis(300), ..timing() });
    for i in 0..4 {
        let id = format!("s{i}");
        tts.speak(id.clone(), "Hello.".into(), None);
        expect(&mut rx, &[(&id, Queued, None), (&id, Error, Some("engine_exited"))]).await;
    }
    assert!(tts.exhausted());
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert!(!tts.exhausted());
}

#[tokio::test]
async fn a_failed_start_errors_the_sentence_and_counts_as_a_crash() {
    let (host, mut rx) = FakeHost::new(Behavior { refuse_start: true, ..Default::default() });
    let tts = start(&host, timing());
    tts.speak("a".into(), "Hello.".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("a", Error, Some("unavailable"))]).await;
    assert_eq!(tts.crashes.times.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_hung_sidecar_is_replaced() {
    let (host, mut rx) = FakeHost::new(Behavior { hang: true, ..Default::default() });
    let tts = start(&host, Timing { stall: Duration::from_millis(150), ..timing() });
    tts.speak("a".into(), "Hello.".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("a", Error, Some("engine_stalled"))]).await;
    wait_until("the hung sidecar is shut down", || host.exits.load(Ordering::SeqCst) == 1).await;

    host.behavior.lock().unwrap().hang = false;
    tts.speak("b".into(), "Hello again.".into(), None);
    expect(&mut rx, &[("b", Queued, None), ("b", Speaking, None), ("b", Done, None)]).await;
    assert_eq!(host.starts.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_sentence_the_sidecar_skips_cannot_wedge_the_queue() {
    let (host, mut rx) = FakeHost::new(Behavior { skip_done: true, ..Default::default() });
    let tts = start(&host, timing());
    tts.speak("a-nodone".into(), "One.".into(), None);
    tts.speak("b".into(), "Two.".into(), None);
    let mut seen = Vec::new();
    while seen.last().map(|(id, st): &(String, UtteranceState)| (id.as_str(), *st)) != Some(("b", Done)) {
        let (ev, _) = next(&mut rx).await;
        seen.push((ev.id, ev.state));
    }
    assert!(seen.contains(&("a-nodone".to_string(), Error)), "{seen:?}");
    assert!(!seen.contains(&("a-nodone".to_string(), Done)), "{seen:?}");
}

#[tokio::test]
async fn a_sidecar_error_fails_only_that_sentence() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    tts.speak("a".into(), "boom".into(), None);
    tts.speak("b".into(), "Fine.".into(), None);
    expect(
        &mut rx,
        &[
            ("a", Queued, None),
            ("b", Queued, None),
            ("a", Error, Some("synthesis_failed")),
            ("b", Speaking, None),
            ("b", Done, None),
        ],
    )
    .await;
}

#[tokio::test]
async fn the_output_closes_after_the_queue_drains_and_reopens_for_the_next_reply() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    tts.speak("a".into(), "One.".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("a", Speaking, None), ("a", Done, None)]).await;
    assert_eq!(host.closes.load(Ordering::SeqCst), 0, "not closed the moment it drains");
    wait_until("the stream closes after the linger", || host.closes.load(Ordering::SeqCst) == 1).await;

    tts.speak("b".into(), "Two.".into(), None);
    expect(&mut rx, &[("b", Queued, None), ("b", Speaking, None), ("b", Done, None)]).await;
    assert_eq!(host.opens.load(Ordering::SeqCst), 2, "a new stream on whatever the default device is now");
}

#[tokio::test]
async fn an_output_failure_errors_pending_sentences_and_cancels_synthesis() {
    let (host, mut rx) = FakeHost::new(Behavior { frames: 5, frame_delay_ms: 5, ..Default::default() });
    host.fail_open.store(true, Ordering::SeqCst);
    let tts = start(&host, timing());
    tts.speak("a".into(), "One.".into(), None);
    tts.speak("b".into(), "Two.".into(), None);
    expect(
        &mut rx,
        &[
            ("a", Queued, None),
            ("b", Queued, None),
            ("a", Error, Some("output_device")),
            ("b", Error, Some("output_device")),
        ],
    )
    .await;
    wait_until("the sidecar is told to cancel", || !host.received("cancel").is_empty()).await;
}

#[tokio::test]
async fn shutdown_cancels_and_stops_the_sidecar() {
    let (host, mut rx) = FakeHost::new(Behavior { frames: 40, frame_delay_ms: 10, ..Default::default() });
    let tts = start(&host, timing());
    tts.speak("a".into(), "One.".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("a", Speaking, None)]).await;
    tts.shutdown().await;
    expect(&mut rx, &[("a", Cancelled, None)]).await;
    assert_eq!(host.received("shutdown").len(), 1);
    wait_until("the sidecar exits", || host.exits.load(Ordering::SeqCst) == 1).await;
    assert_eq!(host.closes.load(Ordering::SeqCst), 1, "the output stream is closed too");
    assert!(!tts.gate.silenced(), "every gated request is acknowledged");
}

#[tokio::test]
async fn stop_during_start_abandons_it() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    tts.speak("a".into(), "One.".into(), None);
    tts.stop();
    expect(&mut rx, &[("a", Queued, None), ("a", Cancelled, None)]).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(host.received("speak").is_empty(), "nothing reaches an abandoned sidecar");
}

#[tokio::test]
async fn blank_text_is_done_without_starting_anything() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    tts.speak("a".into(), "  ".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("a", Done, None)]).await;
    assert_eq!(host.starts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn only_the_page_that_owns_the_speech_cancels_it_by_going_away() {
    let (host, mut rx) = FakeHost::new(Behavior { frames: 40, frame_delay_ms: 10, ..Default::default() });
    let tts = start(&host, timing());
    assert!(!tts.cancel_if_owner("main"), "nothing owned yet");

    tts.claim("main");
    tts.speak("a".into(), "One.".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("a", Speaking, None)]).await;
    assert!(!tts.cancel_if_owner("workspace-2"), "another window reloading leaves it alone");
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(rx.try_recv().is_err(), "still speaking");

    assert!(tts.cancel_if_owner("main"));
    expect(&mut rx, &[("a", Cancelled, None)]).await;
    assert!(!tts.cancel_if_owner("main"), "ownership ends with the cancel");

    // The last page to ask owns what plays now.
    tts.claim("main");
    tts.claim("workspace-2");
    tts.speak("b".into(), "Two.".into(), None);
    expect(&mut rx, &[("b", Queued, None), ("b", Speaking, None)]).await;
    assert!(!tts.cancel_if_owner("main"));
    assert!(tts.cancel_if_owner("workspace-2"));
    expect(&mut rx, &[("b", Cancelled, None)]).await;

    // A claim hands out the epoch its speak belongs to: one claimed before
    // its page went away is cancelled, one claimed after plays.
    let stale = tts.claim("main");
    assert!(tts.cancel_if_owner("main"));
    let fresh = tts.claim("workspace-2");
    assert!(fresh > stale);
    tts.speak_at(stale, "c".into(), "Gone.".into(), None);
    tts.speak_at(fresh, "d".into(), "Three.".into(), None);
    expect(&mut rx, &[("c", Queued, None), ("c", Cancelled, None), ("d", Queued, None), ("d", Speaking, None)])
        .await;
}

#[tokio::test]
async fn a_speak_overtaken_by_a_cancel_is_cancelled() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    // tts_speak reads the epoch, normalizes, then queues; the page's cancel
    // lands in between.
    let epoch = tts.epoch();
    tts.cancel();
    tts.speak_at(epoch, "a".into(), "Too late.".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("a", Cancelled, None)]).await;
    assert_eq!(host.starts.load(Ordering::SeqCst), 0);

    let epoch = tts.epoch();
    tts.speak_at(epoch, "b".into(), "On time.".into(), None);
    expect(&mut rx, &[("b", Queued, None), ("b", Speaking, None), ("b", Done, None)]).await;
}

#[tokio::test]
async fn oversized_text_is_refused_without_reaching_the_sidecar() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    tts.speak("big".into(), "x".repeat(MAX_SIDECAR_TEXT_BYTES + 1), None);
    tts.speak("ok".into(), "Fine.".into(), None);
    expect(
        &mut rx,
        &[
            ("big", Queued, None),
            ("big", Error, Some("text_too_long")),
            ("ok", Queued, None),
            ("ok", Speaking, None),
            ("ok", Done, None),
        ],
    )
    .await;
    let speaks = host.received("speak");
    assert_eq!(speaks.len(), 1);
    assert_eq!(speaks[0]["id"], "ok");
    // What tts_speak accepts stays under the actor's limit after the usual
    // ~2.5× expansion of words.
    assert!(MAX_SPEAK_BYTES * 5 / 2 <= MAX_SIDECAR_TEXT_BYTES);
}

#[tokio::test]
async fn new_requests_do_not_hide_a_hung_sidecar() {
    let (host, mut rx) = FakeHost::new(Behavior { hang: true, ..Default::default() });
    let tts = start(&host, Timing { stall: Duration::from_millis(300), ..timing() });
    let t0 = std::time::Instant::now();
    // A streaming auto-read: a new sentence (and prepare) every 50 ms.
    for i in 0..40 {
        tts.speak(format!("s{i}"), "More.".into(), None);
        tts.prepare();
        tokio::time::sleep(Duration::from_millis(50)).await;
        while let Ok((ev, _)) = rx.try_recv() {
            if ev.id == "s0" && ev.state == Error {
                assert_eq!(ev.error.as_deref(), Some("engine_stalled"));
                assert!(t0.elapsed() < Duration::from_millis(900), "stalled after {:?}", t0.elapsed());
                return;
            }
        }
    }
    panic!("the hung sidecar was never detected while requests kept arriving");
}

#[tokio::test]
async fn a_full_channel_to_the_sidecar_is_retried() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let (tts, mut actor) = TtsService::with_host(host.clone(), timing());
    // A sidecar whose stdin takes one frame at a time.
    let (to_tx, mut to_rx) = mpsc::channel::<Frame>(1);
    let (_from_tx, from_rx) = mpsc::channel::<Frame>(1);
    actor.engine =
        EngineSlot::Running(Engine { link: Link { tx: to_tx, rx: from_rx }, process: None, voices: vec!["tana".into()] });
    tokio::spawn(actor.run());

    tts.speak("a".into(), "One.".into(), None);
    tts.speak("b".into(), "Two.".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("b", Queued, None)]).await;
    for want in ["a", "b"] {
        let frame = tokio::time::timeout(Duration::from_secs(2), to_rx.recv())
            .await
            .unwrap_or_else(|_| panic!("{want} never reached the sidecar"))
            .expect("link open");
        let Frame::Json(v) = frame else { panic!("expected a speak") };
        assert_eq!((v["type"].as_str(), v["id"].as_str()), (Some("speak"), Some(want)));
    }
}

#[tokio::test]
async fn the_sidecar_gets_at_most_three_sentences_beyond_the_one_playing() {
    let (host, mut rx) = FakeHost::new(Behavior { frames: 10, ..Default::default() });
    let tts = start(&host, timing());
    for i in 0..10 {
        tts.speak(format!("u{i}"), "Words.".into(), None);
    }
    loop {
        let (ev, _) = next(&mut rx).await;
        assert_ne!(ev.state, Error, "{ev:?}");
        if ev.id == "u9" && ev.state == Done {
            break;
        }
    }
    // Walk what the sidecar received against what finished playing.
    let (mut sent, mut done, mut most) = (0usize, 0usize, 0usize);
    for v in host.received.lock().unwrap().iter() {
        match (v["type"].as_str(), v["state"].as_str()) {
            (Some("speak"), _) => {
                sent += 1;
                most = most.max(sent - done);
            }
            (Some("_event"), Some("done")) => done += 1,
            _ => {}
        }
    }
    assert_eq!((sent, done), (10, 10));
    assert_eq!(most, READ_AHEAD + 1, "the one playing plus {READ_AHEAD} ahead");
}

#[tokio::test]
async fn output_opener_times_out_and_refuses_while_an_open_is_stuck() {
    let opener = OutputOpener::new(Duration::from_millis(100));
    let (release, stuck) = std::sync::mpsc::channel::<()>();
    let t = std::time::Instant::now();
    let err = opener.open(move || {
        let _ = stuck.recv(); // CoreAudio never answers
        Err("late".into())
    });
    let err = err.await.err().expect("the open fails");
    assert!(err.starts_with(OUTPUT_NOT_RESPONDING), "{err}");
    assert!(t.elapsed() >= Duration::from_millis(100));

    // Still stuck: fail at once, without starting a second blocked thread.
    let called = Arc::new(AtomicBool::new(false));
    let c = called.clone();
    let t = std::time::Instant::now();
    let err = opener
        .open(move || {
            c.store(true, Ordering::SeqCst);
            Err("should not run".into())
        })
        .await
        .err().expect("the open fails");
    assert!(err.starts_with(OUTPUT_NOT_RESPONDING), "{err}");
    assert!(t.elapsed() < Duration::from_millis(50));
    assert!(!called.load(Ordering::SeqCst));

    // It comes back: the next open works.
    drop(release);
    wait_until("the stuck open returns", || !opener.busy.load(Ordering::SeqCst)).await;
    let gate = Arc::new(CancelGate::new());
    assert!(opener.open(move || Ok(Player::new(DEVICE_RATE, gate).0)).await.is_ok());

    // A panicking open fails that open and frees the opener.
    let err = opener.open(|| panic!("HAL exploded")).await.err().expect("the open fails");
    assert!(err.contains("thread failed"), "{err}");
    wait_until("the opener is free", || !opener.busy.load(Ordering::SeqCst)).await;
}

#[tokio::test]
async fn a_hung_output_device_errors_the_speech_and_later_opens_fail_fast() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    host.hold_open.store(true, Ordering::SeqCst);
    let tts = start(&host, timing());
    tts.speak("a".into(), "One.".into(), None);
    tts.speak("b".into(), "Two.".into(), None);
    let t = std::time::Instant::now();
    expect(
        &mut rx,
        &[
            ("a", Queued, None),
            ("b", Queued, None),
            ("a", Error, Some("output_device")),
            ("b", Error, Some("output_device")),
        ],
    )
    .await;
    assert!(t.elapsed() >= Duration::from_millis(900), "failed by the 1 s timeout");

    let t = std::time::Instant::now();
    tts.speak("c".into(), "Three.".into(), None);
    expect(&mut rx, &[("c", Queued, None), ("c", Error, Some("output_device"))]).await;
    assert!(t.elapsed() < Duration::from_millis(500), "no second wait on a device that's stuck");

    host.hold_open.store(false, Ordering::SeqCst);
    wait_until("the stuck open returns", || !host.opener.busy.load(Ordering::SeqCst)).await;
    tts.speak("d".into(), "Four.".into(), None);
    expect(&mut rx, &[("d", Queued, None), ("d", Speaking, None), ("d", Done, None)]).await;
    assert_eq!(host.opens.load(Ordering::SeqCst), 3);
    assert_eq!(host.starts.load(Ordering::SeqCst), 1, "the sidecar was never at fault");
}

// ─── voice-mode hooks: output hold, reference tap, speaking watch ─────────

fn drain_tap(tap: &mut crate::audio::tap::TapReader) -> Vec<f32> {
    let mut out = vec![0.0; tap.available()];
    let n = tap.pop_slice(&mut out);
    out.truncate(n);
    out
}

#[tokio::test]
async fn a_held_output_opens_at_once_outlives_the_linger_and_feeds_the_reference_tap() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    let (writer, mut tap) = crate::audio::tap::tap_channel(1 << 21);
    let hold = tts.hold_output(Some(writer));
    wait_until("the held output opens before any speech", || host.opens.load(Ordering::SeqCst) == 1).await;
    wait_until("the tap learns the device rate", || tap.rate() == DEVICE_RATE).await;
    assert_eq!(tap.epoch(), 1);

    tts.speak("a".into(), "One.".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("a", Speaking, None), ("a", Done, None)]).await;
    tokio::time::sleep(Duration::from_millis(300)).await; // 3× the linger
    assert_eq!(host.closes.load(Ordering::SeqCst), 0, "held open past the linger");

    tts.speak("b".into(), "Two.".into(), None);
    expect(&mut rx, &[("b", Queued, None), ("b", Speaking, None), ("b", Done, None)]).await;
    assert_eq!(host.opens.load(Ordering::SeqCst), 1, "one stream for the whole hold");

    // The reference is what the device rendered: both utterances at the
    // device rate, and the silence around them.
    let reference = drain_tap(&mut tap);
    let voiced = reference.iter().filter(|s| s.abs() > 0.05).count() as u64;
    let want = 2 * UTTERANCE_DEVICE_FRAMES;
    assert!(voiced >= want * 98 / 100 && voiced <= want * 102 / 100, "{voiced} voiced frames, want ~{want}");
    assert!(reference.len() as u64 > voiced + 10_000, "silence is in the reference too");
    assert_eq!(tap.dropped(), 0);

    drop(hold);
    wait_until("released, it closes after the linger", || host.closes.load(Ordering::SeqCst) == 1).await;
    drain_tap(&mut tap);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(tap.available(), 0, "the tap is gone with the hold");
}

#[tokio::test]
async fn speaking_is_true_from_the_first_sample_to_the_last() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    let mut speaking = tts.subscribe_speaking();
    assert!(!*speaking.borrow());
    let changes = Arc::new(Mutex::new(Vec::<(bool, u64)>::new()));
    {
        let changes = changes.clone();
        let heard = host.heard.clone();
        tokio::spawn(async move {
            while speaking.changed().await.is_ok() {
                let v = *speaking.borrow_and_update();
                changes.lock().unwrap().push((v, heard.load(Ordering::SeqCst)));
            }
        });
    }
    tts.speak("a".into(), "Hello there.".into(), None);
    tts.speak("b".into(), "General Kenobi.".into(), None);
    expect(
        &mut rx,
        &[
            ("a", Queued, None),
            ("b", Queued, None),
            ("a", Speaking, None),
            ("a", Done, None),
            ("b", Speaking, None),
            ("b", Done, None),
        ],
    )
    .await;
    wait_until("speaking goes false after the last sample", || {
        changes.lock().unwrap().last().is_some_and(|c| !c.0)
    })
    .await;
    let changes = changes.lock().unwrap().clone();
    let (first, last) = (changes[0], *changes.last().unwrap());
    assert!(first.0 && first.1 < UTTERANCE_DEVICE_FRAMES, "true at the first sample: {changes:?}");
    assert!(last.1 + 480 >= 2 * UTTERANCE_DEVICE_FRAMES * 95 / 100, "false after the last: {changes:?}");
}

#[tokio::test]
async fn a_cancel_ends_speaking() {
    let (host, mut rx) = FakeHost::new(Behavior { frames: 40, frame_delay_ms: 10, ..Default::default() });
    let tts = start(&host, timing());
    let mut speaking = tts.subscribe_speaking();
    tts.speak("a".into(), "One.".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("a", Speaking, None)]).await;
    tokio::time::timeout(Duration::from_secs(5), speaking.wait_for(|v| *v)).await.unwrap().unwrap();
    tts.cancel();
    expect(&mut rx, &[("a", Cancelled, None)]).await;
    tokio::time::timeout(Duration::from_secs(5), speaking.wait_for(|v| !*v)).await.unwrap().unwrap();
}

#[tokio::test]
async fn refresh_reopens_a_held_output_and_moves_the_tap_to_it() {
    let (host, _rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    let (writer, tap) = crate::audio::tap::tap_channel(1 << 21);
    let _hold = tts.hold_output(Some(writer));
    wait_until("opened", || tap.epoch() == 1).await;
    tts.refresh_output();
    wait_until("closed and reopened on the current default", || {
        host.closes.load(Ordering::SeqCst) == 1 && host.opens.load(Ordering::SeqCst) == 2
    })
    .await;
    wait_until("the tap moved to the new stream", || tap.epoch() == 2).await;
    assert_eq!(tap.rate(), DEVICE_RATE);
}

#[tokio::test]
async fn a_refresh_to_the_device_already_open_keeps_the_stream() {
    let (host, _rx) = FakeHost::new(Behavior::default());
    host.device.store(73, Ordering::SeqCst); // the paired EarPods, say
    let tts = start(&host, timing());
    let (writer, tap) = crate::audio::tap::tap_channel(1 << 21);
    let _hold = tts.hold_output(Some(writer));
    wait_until("opened", || tap.epoch() == 1).await;
    // A route change that leaves speech on the same device: no reopen (it
    // would restart the echo canceller's convergence).
    tts.refresh_output_unless_on(73);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!((host.opens.load(Ordering::SeqCst), host.closes.load(Ordering::SeqCst)), (1, 0));
    assert_eq!(tap.epoch(), 1);
    // The pairing moved speech elsewhere: reopened, the tap follows.
    host.device.store(90, Ordering::SeqCst);
    tts.refresh_output_unless_on(90);
    wait_until("closed and reopened on the new device", || {
        host.closes.load(Ordering::SeqCst) == 1 && host.opens.load(Ordering::SeqCst) == 2
    })
    .await;
    wait_until("the tap moved to the new stream", || tap.epoch() == 2).await;
}

#[tokio::test]
async fn a_replaced_hold_cannot_release_the_new_one() {
    let (host, _rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    let first = tts.hold_output(None);
    let second = tts.hold_output(None);
    wait_until("opened", || host.opens.load(Ordering::SeqCst) == 1).await;
    drop(first);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(host.closes.load(Ordering::SeqCst), 0, "still held by the second");
    drop(second);
    wait_until("released", || host.closes.load(Ordering::SeqCst) == 1).await;
}

#[tokio::test]
async fn a_held_output_that_fails_to_open_is_retried() {
    let (host, mut rx) = FakeHost::new(Behavior::default());
    host.fail_open.store(true, Ordering::SeqCst);
    let tts = start(&host, timing());
    let (writer, tap) = crate::audio::tap::tap_channel(1 << 21);
    let _hold = tts.hold_output(Some(writer));
    wait_until("retried with a backoff", || host.opens.load(Ordering::SeqCst) >= 3).await;
    host.fail_open.store(false, Ordering::SeqCst);
    wait_until("opens once the device is back", || tap.rate() == DEVICE_RATE).await;
    tts.speak("a".into(), "Back.".into(), None);
    expect(&mut rx, &[("a", Queued, None), ("a", Speaking, None), ("a", Done, None)]).await;
}

#[tokio::test]
async fn stop_ends_a_hold() {
    let (host, _rx) = FakeHost::new(Behavior::default());
    let tts = start(&host, timing());
    let hold = tts.hold_output(None);
    wait_until("opened", || host.opens.load(Ordering::SeqCst) == 1).await;
    tts.stop();
    wait_until("closed by the stop", || host.closes.load(Ordering::SeqCst) == 1).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(host.opens.load(Ordering::SeqCst), 1, "not reopened: the hold ended with the stop");
    drop(hold); // a no-op now
}

#[test]
fn state_event_shape() {
    let ev = StateEvent { id: "m1:0".into(), state: Speaking, error: None };
    assert_eq!(serde_json::to_value(&ev).unwrap(), json!({"id":"m1:0","state":"speaking"}));
    let ev = StateEvent { id: "m1:0".into(), state: Error, error: Some("output_device".into()) };
    assert_eq!(
        serde_json::to_value(&ev).unwrap(),
        json!({"id":"m1:0","state":"error","error":"output_device"})
    );
}

#[test]
fn voice_catalogue() {
    let voices = voices();
    assert!(!voices.is_empty());
    let defaults: Vec<_> = voices.iter().filter(|v| v.is_default).collect();
    assert_eq!(defaults.len(), 1, "exactly one default");
    assert_eq!(defaults[0].id, default_voice());
    let json = serde_json::to_value(&voices[0]).unwrap();
    for key in ["id", "name", "description", "default"] {
        assert!(json.get(key).is_some(), "{key}");
    }
}

#[test]
fn voice_resolution() {
    assert_eq!(default_voice(), "tana");
    let engine = vec!["tana".to_string(), "cha".to_string()];
    assert_eq!(resolve_voice(Some("cha"), &engine), "cha");
    assert_eq!(resolve_voice(Some("cosette"), &engine), default_voice());
    assert_eq!(resolve_voice(None, &engine), default_voice());
    assert_eq!(resolve_voice(None, &["ush".to_string()]), "ush", "engine lacks the default");
    assert_eq!(resolve_voice(Some("cha"), &[]), "cha", "no engine list yet: the catalogue decides");
    assert_eq!(resolve_voice(Some("cosette"), &[]), default_voice(), "no engine list yet: unknown → default");
}

/// Voices removed from the catalogue (the Kyutai voices) may still sit in a
/// page's saved setting (`dial8:read-aloud:voice`): they speak in the default.
#[test]
fn removed_voices_fall_back_to_the_default() {
    let ids: Vec<String> = voices().into_iter().map(|v| v.id).collect();
    for gone in ["alba", "anna", "marius", "javert"] {
        assert!(!ids.iter().any(|id| id == gone), "{gone} is no longer compiled in");
        assert_eq!(resolve_voice(Some(gone), &ids), "tana", "{gone} with the engine's list");
        assert_eq!(resolve_voice(Some(gone), &[]), "tana", "{gone} before the engine's list");
    }
}

#[test]
fn normalization() {
    let money = normalize("Revenue hit $4.2M this quarter.");
    assert!(money.contains("four point two million dollars"), "{money}");

    let phone = normalize("Call (415) 555-0123 today.");
    assert!(phone.contains("four one five"), "{phone}");
    assert!(phone.contains("five five five"), "{phone}");
    assert!(phone.contains("zero one two three"), "{phone}");

    let date = normalize("The launch is on 11/15/2026.");
    assert!(date.contains("november fifteenth twenty twenty six"), "{date}");

    let eta = normalize("ETA is ~15 min");
    assert!(eta.contains("about fifteen"), "{eta}");

    assert_eq!(normalize("Plain words stay put."), "Plain words stay put.");
}

#[test]
fn curly_apostrophes_go_out_straight() {
    // Liam heard "I’ll" as "ll", "couldn’t" as "could", "I’m" as "am".
    assert_eq!(
        normalize("I’ll check. I couldn’t find it. I’m here, you’re right."),
        "I'll check. I couldn't find it. I'm here, you're right."
    );
    assert_eq!(normalize("Liamʼs notes"), "Liam's notes");
    assert_eq!(normalize("He said ‘ship it’ and left."), "He said 'ship it' and left.");
    // The words around it are still the shield's and the link reader's.
    assert_eq!(normalize("That did it, didn’t it?"), "That did it, didn't it?");
    assert!(normalize("It’s on https://www.amazon.com/dp/B0C1234567.").starts_with("It's on Amazon"));
    // From the review of #80: the normalizer splits a word at a straight
    // apostrophe and read the part before it as a numeral, either kind.
    for (curly, straight) in [
        ("The part I’m sure about.", "The part I'm sure about."),
        ("Our CI’s red.", "Our CI's red."),
        ("Ask Liv’s team.", "Ask Liv's team."),
        ("The CLI’s output is ready.", "The CLI's output is ready."),
        ("Use Vimʼs keys.", "Use Vim's keys."),
    ] {
        assert_eq!(normalize(curly), straight);
        assert_eq!(normalize(straight), straight);
    }
    // Any other apostrophe is still the normalizer's to split at (second
    // review of #80), curly or straight.
    for (text, read) in [
        ("March 5th’s deadline", "fifth's"),
        ("Our B2B’s churn", "B two B's"),
        ("GPT-4o’s context", "four o's"),
        ("Henry VIII’s wives", "eighth's"),
        ("Chapter IV’s end", "four's"),
        // Third review: after a numbering word it stays a numeral, as in
        // the shield, and "I" before "s" is one.
        ("Super Bowl LX’s halftime show.", "sixtieth's"),
        ("See chapter iv’s end.", "four's"),
        ("Article I’s first clause", "one's"),
        ("amazon.com’s site", "dot com's"),
        ("In the ’90s, rock ’n’ roll.", "In the nineties, rock 'n' roll."),
        ("It’s 5 o’clock.", "It's five o'clock."),
    ] {
        let straight = text.replace('’', "'");
        assert!(normalize(text).contains(read), "{text}: {}", normalize(text));
        assert_eq!(normalize(text), normalize(&straight));
    }
}

#[test]
fn amounts_per_unit_are_spoken() {
    let price = normalize("The Pro plan is $9.99/month, billed annually.");
    assert!(price.contains("nine dollars ninety nine cents per month"), "{price}");
    let two = normalize("It costs $19/month or $190/year.");
    assert!(two.contains("nineteen dollars per month"), "{two}");
    assert!(two.contains("one hundred and ninety dollars per year"), "{two}");
    let chain = normalize("Pricing: $9.99/user/month");
    assert!(chain.contains("nine dollars ninety nine cents per user per month"), "{chain}");
    let abbr = normalize("Only $5/mo.");
    assert!(abbr.contains("five dollars per month"), "{abbr}");
    let big = normalize("We pay $1.2M/year.");
    assert!(big.contains("one point two million dollars per year"), "{big}");
    let pct = normalize("Churn is 4%/month.");
    assert!(pct.contains("four percent per month"), "{pct}");
    let spaced = normalize("It is $9.99 / month.");
    assert!(spaced.contains("nine dollars ninety nine cents per month"), "{spaced}");
    let always = normalize("Support is 24/7 now.");
    assert!(always.contains("twenty four seven"), "{always}");
}

#[test]
fn slashes_that_are_not_rates_stay() {
    assert_eq!(per_units("See v2/api and docs.dial8.ai/api"), "See v2/api and docs.dial8.ai/api");
    assert_eq!(per_units("On 11/15/2026, 1/2 off, and/or later."), "On 11/15/2026, 1/2 off, and/or later.");
    assert_eq!(per_units("24/7"), "twenty four seven");
    assert_eq!(per_units("124/7 and 24/75"), "124/7 and 24/75");
    assert_eq!(per_units("$9.99/month"), "$9.99 per month");
    assert_eq!(per_units("40/hr"), "40 per hour");
    assert_eq!(per_units("$5/2024"), "$5/2024", "a number after the slash is not a unit");
    // Multibyte spaces (no-break, narrow no-break) before the token.
    assert_eq!(per_units("Pay\u{a0}$5/month"), "Pay\u{a0}$5 per month");
    assert_eq!(per_units("At 9:30\u{202f}AM/PM"), "At 9:30\u{202f}AM/PM");
}

#[test]
fn links_are_read_as_their_site() {
    assert_eq!(links("Order it on https://www.amazon.com/dp/B0C1234567?th=1."), "Order it on Amazon.");
    assert_eq!(links("Sell on shopify.com or amazon.co.uk/sell."), "Sell on Shopify or Amazon.");
    assert_eq!(links("See https://www.dial8.ai/docs?x=1#top."), "See Dial8.");
    assert_eq!(links("(see docs.dial8.ai/api)"), "(see Dial8");
    assert_eq!(links("Run it on http://localhost:3000/api/chat."), "Run it on localhost.");
    assert_eq!(
        links("Open https://dial8.ai/account/chat?thread=8f3a2c1d-77b9-4e1a-9c2e-1f0b6d2e9a11 to continue."),
        "Open Dial8 to continue."
    );
    // GitHub: a pull request or issue by its number, anything else as the site.
    assert_eq!(
        links("I opened the PR at github.com/liamadsr/dial8-corss-platform/pull/73 so you can look."),
        "I opened the PR at pull request 73 so you can look."
    );
    assert_eq!(links("Here it is: https://github.com/liamadsr/dial8-website/pull/906"), "Here it is: pull request 906");
    assert_eq!(links("Fixes https://github.com/a/b/issues/12#issuecomment-9."), "Fixes issue 12.");
    assert_eq!(links("Files at https://github.com/a/b/pull/915/files?w=1"), "Files at pull request 915");
    // A cut-off link's number may be cut too.
    assert_eq!(links("See github.com/liamadsr/dial8-website/pull/9… soon."), "See Github soon.");
    // A name with no vowel is an acronym.
    assert_eq!(links("On bbc.co.uk, cnn.com and npmjs.com."), "On BBC, CNN and NPMJS.");
    // A "…" or ".." glued on means the link was cut short ("…" in a link's text).
    assert_eq!(links("The repo is github.com/liamadsr/dial8-corss-p… and it's ready."), "The repo is Github and it's ready.");
    assert_eq!(links("Check out github.com/vercel/next.js... it has the details."), "Check out Github it has the details.");
    assert_eq!(links("It's in liamadsr/dial8-corss-p… now."), "It's in liamadsr now.");
}

#[test]
fn paths_refs_and_ids_are_shortened() {
    // A repo reference is its number; the bracket before it goes (Liam's example).
    assert_eq!(
        links("C0, the host (liamadsr/dial8-website#915 · Cloud browser"),
        "C0, the host number 915 · Cloud browser"
    );
    assert_eq!(links("See liamadsr/dial8-website#906 for the details."), "See number 906 for the details.");
    assert_eq!(
        links("The change is in src/lib/read-aloud/speech-text.ts, near the top."),
        "The change is in speech-text.ts, near the top."
    );
    assert_eq!(links("Saved to ~/notes/today.md."), "Saved to today.md.");
    assert_eq!(links("I pushed commit b31e14e9f2a to the branch."), "I pushed commit to the branch.");
    assert_eq!(links("Thread 8f3a2c1d-77b9-4e1a-9c2e-1f0b6d2e9a11."), "Thread.");
    assert_eq!(links("b31e14e9f2a is merged."), "is merged.");
    assert_eq!(links("Main is at d41528f now."), "Main is at now.");
    assert_eq!(links("Key eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIi, rotated."), "Key, rotated.");
    // Markdown left in the text (Read anywhere over a raw .md file).
    assert_eq!(links("In `src/lib/x-y.ts` now."), "In x-y.ts now.");
    assert_eq!(links("See **github.com/a/b** first."), "See Github first.");
    // Three or more folders: a path even with capitals.
    assert_eq!(links("Edit packages/ui/src/components/Button/Button.tsx today."), "Edit Button.tsx today.");
}

#[test]
fn punctuation_around_dropped_and_cut_tokens() {
    // The sentence's own period stays after a cut link.
    assert_eq!(links("The repo is github.com/x/dial8-corss-p…. It's ready."), "The repo is Github. It's ready.");
    assert_eq!(links("Thread 8f3a2c1d-77b9-4e1a-9c2e-1f0b6d2e9a11…."), "Thread.");
    // Brackets, quotes and an introducing colon go with a dropped token.
    assert_eq!(links("Commit (b31e14e9f2a) landed."), "Commit landed.");
    assert_eq!(links("He said “b31e14e9f2a” was it."), "He said was it.");
    assert_eq!(links("Ref: b31e14e9f2a."), "Ref.");
    assert_eq!(links("ID: b31e14e9f2a, then more."), "ID, then more.");
    assert_eq!(links("b31e14e9f2a d41528f done"), "done");
    assert_eq!(links("done b31e14e9f2a"), "done");
}

#[test]
fn text_that_only_looks_like_a_link_stays() {
    let kept = "Use Next.js/React, and/or v2/api, on 11/15/2026, e.g. ENG-42, v2.1.3, deadbeef, \
                1234567, Q1/Q2/Q3 and a/b/c. Well… maybe... something.. ok — “quoted”.";
    assert_eq!(links(kept), kept);
    // Files whose extension is also a country code, an email, and capitalised names.
    let files = "Run release.sh, build main.cc, load libfoo.so, edit Makefile.in, mail liam@dial8.ai, ship Dial8.app.";
    assert_eq!(links(files), files);
    // A missing space after a period is not a domain (review of #75).
    let typos = "Sounds good.it works now. Let me know.no rush. I went home.at least I tried. Call me tomorrow.me too.";
    assert_eq!(links(typos), typos);
    assert_eq!(links("  two  spaces stay  "), "  two  spaces stay  ");
    // Prose with slashes, from the review of #74.
    let prose = "Work is in-person/remote/hybrid at pre-seed/seed/Series A, in U.S./U.K./EU, for Mr./Mrs./Ms., \
                 on Next.js/React/Vue.js, v2.1/v2.2/v3.0, Fly.io/Render/Railway or ASP.NET/C#.";
    assert_eq!(links(prose), prose);
    // Rates are per_units' to read.
    assert_eq!(links("Pro is 9.99/user/month and 1.2M/yr/seat."), "Pro is 9.99/user/month and 1.2M/yr/seat.");
    let tilde = "It's ~10/user/month, ~9.99/user/month, ...and/or/maybe.";
    assert_eq!(links(tilde), tilde);
    // A cut list of words is not a cut path.
    assert_eq!(links("Monday/Tuesday… or later, either/or... you choose."), "Monday/Tuesday… or later, either/or... you choose.");
    let lists = "Pick red/green/blue... or Mon/Tue/Wed… or in-person/remote… or Q1/Q2/Q3… then cd a/b/..";
    assert_eq!(links(lists), lists);
    // Long words without a digit are words.
    let long = "A state-of-the-art-machine-learning-based-pipeline-thing and Pneumonoultramicroscopicsilicovolcanoconiosis.";
    assert_eq!(links(long), long);
    // Codes that look like hashes, an email, and a long sentence with no spaces.
    let codes = "Keys are ed25519, orders A1234567 and 7A2F9C1, cafe123, mail jonathan.richardson-smith@internationalbusiness.com.";
    assert_eq!(links(codes), codes);
    let cjk = "これは四十文字を超える長い日本語の文章で、スペースが一つもありませんが、読み上げで消えてはいけません。";
    assert_eq!(links(cjk), cjk);
}

#[test]
fn normalized_links_are_short() {
    let url = normalize("Open https://dial8.ai/account/chat?thread=8f3a2c1d-77b9-4e1a-9c2e-1f0b6d2e9a11 to continue.");
    assert!(!url.contains("slash") && !url.contains("three a two"), "{url}");
    assert!(url.contains("to continue."), "{url}");
    let cut = normalize("The repo is github.com/liamadsr/dial8-corss-p… and the branch is ready.");
    assert!(!cut.contains('…') && !cut.contains("liamadsr"), "{cut}");
    let path = normalize("The change is in src/lib/read-aloud/speech-text.ts, near the top.");
    assert!(!path.contains("slash") && path.contains("near the top"), "{path}");
    let rate = normalize("Pro is $9.99/user/month.");
    assert!(rate.contains("per user per month"), "{rate}");
    let about = normalize("It's ~10/user/month.");
    assert!(about.contains("about ten per user per month"), "{about}");
    let host = normalize("See **github.com/a/b** first.");
    assert!(host.contains("Github first") && !host.contains("dot"), "{host}");
    let site = normalize("Order it on https://www.amazon.com/dp/B0C1234567.");
    assert!(site.contains("Amazon.") && !site.contains("dot"), "{site}");
    let pr = normalize("C0, the host (liamadsr/dial8-website#915 · Cloud browser");
    assert!(pr.contains("number nine") && !pr.contains("hash") && !pr.contains("liamadsr"), "{pr}");
}

#[test]
fn words_the_model_garbles_are_said_another_way() {
    assert_eq!(spoken_forms("Mm-hmm, got it."), "Uh-huh, got it.");
    assert_eq!(spoken_forms("Mhm. And mmhmm, sure."), "Uh-huh. And uh-huh, sure.");
    assert_eq!(spoken_forms("Up 18% QoQ, YoY and MoM."), "Up 18% quarter over quarter, year over year and month over month.");
    assert_eq!(spoken_forms("Our ARR and MRR, per the LLM."), "Our A R R and M R R, per the L L M.");
    // Read well as written: other acronyms, all-caps words, interjections,
    // plurals and longer tokens.
    let kept = "The API, CRM, SSO and NPS work. KEEP it TOO. HMM, SHH. ARRs, LLMs, B2B, mom, ENG-42, well-known.";
    assert_eq!(spoken_forms(kept), kept);
    let full = normalize("Revenue grew 18% QoQ to $4.2M ARR.");
    assert!(full.contains("eighteen percent quarter over quarter"), "{full}");
    assert!(full.contains("dollars A R R."), "{full}");
}

#[test]
fn words_the_normalizer_misreads_stay_as_written() {
    // Liam heard "did" as "nine hundred ninety nine": a word of Roman-numeral
    // letters after a capitalised word was read as an ordinal.
    for kept in [
        "That did something.", "Who did it?", "It did.", "You did great.", "They did.", "He did, I did, we all did.",
        "Ask Liv and Max.", "The CD is here.", "Our CI is green.", "The CLI works.", "Use ML here.", "Visit DC.",
        "Size XL please.", "Plan C works.", "Take vitamin D.", "Version vi is old.", "A vivid dream.",
        // "in" at the end of a sentence was read as inches, its period lost.
        "Mix it in.", "Come in.", "Sign in.", "I'm all in.", "He was in.", "In.",
    ] {
        assert_eq!(normalize(kept), kept);
    }
    // Numbers keep their units, and numerals in capitals after a name still read.
    assert!(normalize("It is 5 in.").contains("five inches"));
    assert!(normalize("Chapter IV starts here.").contains("Chapter four"));
    assert!(normalize("Super Bowl LVIII.").contains("fifty"));
}

#[test]
fn the_normalizer_still_reads_what_it_read_well() {
    // From the review of #76: a word right after a number is its unit.
    for (text, says) in [
        ("It is 10 m long.", "ten meters"),
        ("Set it to 30 C.", "thirty degrees"),
        ("We raised $5 m.", "five million dollars"),
        ("Drive 60 mi today.", "sixty"),
    ] {
        let spoken = normalize(text);
        assert!(spoken.contains(says), "{text} → {spoken}");
    }
    // Words inside dotted or slashed tokens are the normalizer's to read.
    let dotted = normalize("Meet at 9 a.m., i.e. before lunch.");
    assert!(dotted.contains("that is") && !dotted.contains('\u{E000}'), "{dotted}");
    let slashed = normalize("Our CI/CD runs on in/out events.");
    assert!(!slashed.chars().any(|c| ('\u{E000}'..='\u{F8FF}').contains(&c)), "{slashed}");
    // A numeral after a word that numbers things still reads as one; a word
    // there is still a word.
    assert!(normalize("See chapter iv.").contains("four"), "{}", normalize("See chapter iv."));
    assert!(normalize("Super Bowl LX was fun.").contains("sixt"), "{}", normalize("Super Bowl LX was fun."));
    for kept in ["The Act did not pass.", "The War did not end.", "See Section D.", "Book Liv a room."] {
        assert_eq!(normalize(kept), kept);
    }
    // "in" after a number is the word when a determiner or a name follows.
    for text in ["Three wins: 3 in a row.", "Born 1990 in Paris.", "Up at 4 in the morning."] {
        assert!(!normalize(text).contains("inches"), "{text} → {}", normalize(text));
    }
    // Text that already holds a private-use character is left to the normalizer.
    let icon = normalize("\u{E000} did it.");
    assert!(!icon.contains("did did"), "{icon}");
}

#[test]
fn numeral_shapes() {
    for word in ["did", "Did", "Liv", "mix", "vi", "CD", "CI", "CLI", "ML", "DC", "XL", "DID", "C", "D", "MIX", "CIVIL"] {
        assert!(misread_as_numeral(word), "{word}");
    }
    for word in ["I", "II", "IV", "VIII", "XIV", "LVIII", "MMXXVI", "MCMXC", "hello", "Max", "X1"] {
        assert!(!misread_as_numeral(word), "{word}");
    }
    assert_eq!(roman_value("XIV"), Some(14));
    assert_eq!(roman_value("MMXXVI"), Some(2026));
    assert_eq!(roman_value("IIII"), None);
    assert_eq!(roman_value("DID"), None);
    assert_eq!(roman_value("IC"), None);
}

#[test]
fn shield_round_trips() {
    let (shielded, kept) = shield("He did it in Rome, did he? Come in.");
    assert!(!shielded.contains("did") && !shielded.contains(" in"), "{shielded}");
    assert_eq!(kept, ["did", "in", "did", "in"]);
    assert_eq!(unshield(&shielded, &kept), "He did it in Rome, did he? Come in.");
    let (plain, none) = shield("Nothing to keep here.");
    assert!(none.is_empty());
    assert_eq!(plain, "Nothing to keep here.");
}

#[test]
fn prepass_only_rewrites_tilde_before_an_amount() {
    assert_eq!(prepass("ETA is ~15 min"), "ETA is about 15 min");
    assert_eq!(prepass("costs ~ $5"), "costs about $5");
    assert_eq!(prepass("~20 people"), "about 20 people");
    assert_eq!(prepass("roughly~3"), "roughly about 3");
    assert_eq!(prepass("see ~/notes"), "see ~/notes");
    assert_eq!(prepass("trailing ~"), "trailing ~");
}

/// The real `dial8-local-tts` binary, end to end, with a fake output device
/// (nothing plays on the speakers). Opt-in: needs the built sidecar and the
/// model files.
///
///   DIAL8_TTS_ASSETS=<dir with the module.json files> \
///     cargo test --lib real_sidecar -- --ignored --nocapture
///
/// The binary defaults to sidecars/local-tts/.out/bin/dial8-local-tts
/// (override with DIAL8_TTS_BIN).
#[tokio::test]
#[ignore = "needs the built dial8-local-tts sidecar and its model files"]
async fn real_sidecar_speaks_one_sentence() {
    let exe = std::env::var_os("DIAL8_TTS_BIN").map(std::path::PathBuf::from).unwrap_or_else(|| {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecars/local-tts/.out/bin/dial8-local-tts")
    });
    let Some(dir) = std::env::var_os("DIAL8_TTS_ASSETS").map(std::path::PathBuf::from) else {
        eprintln!("skipped: set DIAL8_TTS_ASSETS");
        return;
    };
    if !exe.exists() {
        eprintln!("skipped: no sidecar at {}", exe.display());
        return;
    }
    let (fake, mut rx) = FakeHost::new(Behavior::default());
    let host = Arc::new(FakeHost { real: Some((exe, dir)), ..Arc::into_inner(fake).unwrap() });
    let tts = start(&host, timing());

    let started = std::time::Instant::now();
    tts.speak("r1".into(), normalize("Your next meeting starts at 3:30pm and runs ~45 min."), None);
    let heard = expect(&mut rx, &[("r1", Queued, None), ("r1", Speaking, None), ("r1", Done, None)]).await;
    eprintln!(
        "first audio after {:?}; {} device frames with signal ({:.2}s at 48 kHz)",
        started.elapsed(),
        heard[2],
        heard[2] as f64 / DEVICE_RATE as f64
    );
    assert!(heard[2] as f64 / DEVICE_RATE as f64 > 1.0, "a sentence is more than a second of speech");

    // Cancel mid-sentence on the real engine, then speak again.
    tts.speak("r2".into(), "This sentence is long enough that it will still be playing when we cancel it.".into(), None);
    expect(&mut rx, &[("r2", Queued, None), ("r2", Speaking, None)]).await;
    tts.cancel();
    expect(&mut rx, &[("r2", Cancelled, None)]).await;
    tts.speak("r3".into(), "Done.".into(), Some("cha".into()));
    expect(&mut rx, &[("r3", Queued, None), ("r3", Speaking, None), ("r3", Done, None)]).await;
    assert_eq!(host.starts.load(Ordering::SeqCst), 1);
    tts.shutdown().await;
}

/// The same flow through the Mac's default output device, so it is audible.
/// Checks that `done` waits for playback (not synthesis) and that cancel is
/// immediate on a real device:
///
///   DIAL8_TTS_ASSETS=<dir with the module.json files> \
///     cargo test --lib real_speakers -- --ignored --nocapture
#[tokio::test]
#[ignore = "plays speech through the default output device"]
async fn real_sidecar_real_speakers() {
    let exe = std::env::var_os("DIAL8_TTS_BIN").map(std::path::PathBuf::from).unwrap_or_else(|| {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecars/local-tts/.out/bin/dial8-local-tts")
    });
    let Some(dir) = std::env::var_os("DIAL8_TTS_ASSETS").map(std::path::PathBuf::from) else {
        eprintln!("skipped: set DIAL8_TTS_ASSETS");
        return;
    };
    let (fake, mut rx) = FakeHost::new(Behavior::default());
    let host = Arc::new(FakeHost { real: Some((exe, dir)), speakers: true, ..Arc::into_inner(fake).unwrap() });
    let tts = start(&host, timing());

    let t0 = std::time::Instant::now();
    tts.speak("s1".into(), normalize("Here's a quick summary of your week."), None);
    tts.speak("s2".into(), normalize("You have three meetings tomorrow, and the first one starts at 9:30 AM."), None);
    let mut at = HashMap::new();
    while at.len() < 6 {
        let (ev, _) = tokio::time::timeout(Duration::from_secs(30), rx.recv()).await.expect("event").expect("open");
        at.insert(format!("{}:{:?}", ev.id, ev.state), t0.elapsed().as_secs_f64());
    }
    eprintln!("timeline (s): {:?}", {
        let mut v: Vec<_> = at.iter().collect();
        v.sort_by(|a, b| a.1.partial_cmp(b.1).unwrap());
        v
    });
    let s1_play = at["s1:Done"] - at["s1:Speaking"];
    let s2_play = at["s2:Done"] - at["s2:Speaking"];
    assert!(s1_play > 1.0 && s2_play > 2.5, "done must wait for playback: s1 {s1_play:.2}s, s2 {s2_play:.2}s");
    assert!(at["s2:Speaking"] >= at["s1:Done"] - 0.05, "s2 starts after s1 finished playing");

    tts.speak("s3".into(), "This sentence is long enough that it will still be playing when we cancel it.".into(), None);
    expect(&mut rx, &[("s3", Queued, None), ("s3", Speaking, None)]).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let tc = std::time::Instant::now();
    tts.cancel();
    expect(&mut rx, &[("s3", Cancelled, None)]).await;
    eprintln!("cancel acknowledged after {:?}", tc.elapsed());
    tts.shutdown().await;
}
