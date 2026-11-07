//! The DSP loop against synthetic taps, a fake canceller, a fake VAD, a
//! recording sink and a fake TTS. No device, no audio.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use super::*;
use crate::audio::aec::AecMetrics;
use crate::voice::detect;
use crate::voice::profile::NoiseProfile;
use crate::audio::tap::{tap_channel, TapSlot};

/// What the fake canceller saw, in order.
#[derive(Debug, Clone, PartialEq)]
enum Call {
    /// A render frame; its first sample (frames are filled with one value).
    Render(f32),
    Capture(f32),
    Reset,
}

struct FakeCanceller {
    log: Rc<RefCell<Vec<Call>>>,
    converged: Rc<RefCell<bool>>,
    /// The ERL it reports.
    erl: Rc<RefCell<Option<f32>>>,
}

impl EchoCanceller for FakeCanceller {
    fn render(&mut self, frame: &[f32; AEC_FRAME]) {
        self.log.borrow_mut().push(Call::Render(frame[0]));
    }

    /// Cleaned = captured / 2 (so tests can tell cleaned from raw).
    fn capture(&mut self, frame: &[f32; AEC_FRAME], out: &mut [f32; AEC_FRAME]) -> AecMetrics {
        self.log.borrow_mut().push(Call::Capture(frame[0]));
        for (o, i) in out.iter_mut().zip(frame) {
            *o = i / 2.0;
        }
        AecMetrics { erle_db: None, delay_ms: None, erl_db: *self.erl.borrow(), converged: *self.converged.borrow() }
    }

    fn reset(&mut self) {
        self.log.borrow_mut().push(Call::Reset);
    }
}

/// Speech probability from loudness: RMS > 0.05 → 0.9, else 0.05.
struct FakeVad {
    frame: usize,
    calls: Rc<RefCell<usize>>,
    resets: Rc<RefCell<usize>>,
}

impl Vad for FakeVad {
    fn frame_len(&self) -> usize {
        self.frame
    }

    fn process(&mut self, frame: &[f32]) -> f32 {
        assert_eq!(frame.len(), self.frame);
        *self.calls.borrow_mut() += 1;
        if rms(sum_squares(frame), frame.len()) > 0.05 {
            0.9
        } else {
            0.05
        }
    }

    fn reset(&mut self) {
        *self.resets.borrow_mut() += 1;
    }
}

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<f32>>>);

impl AudioSink for Sink {
    fn push(&self, samples: &[f32]) {
        self.0.lock().unwrap().extend_from_slice(samples);
    }
}

#[derive(Clone, Default)]
struct Speech {
    audible: Arc<AtomicBool>,
    cancels: Arc<AtomicUsize>,
}

impl SpeechControl for Speech {
    fn agent_audible(&self) -> bool {
        self.audible.load(Ordering::SeqCst)
    }

    fn cancel_speech(&self) {
        self.cancels.fetch_add(1, Ordering::SeqCst);
    }
}

/// Taps are installed in `TapSlot`s and pushed through them, as the audio
/// callbacks do (that is also where a full ring's drops are published).
struct Rig {
    core: DspCore,
    mic: TapSlot,
    reference: Option<TapSlot>,
    /// The system-audio reference's tap (flows into the DSP only while
    /// `shared.system_ref_on`).
    system: TapSlot,
    log: Rc<RefCell<Vec<Call>>>,
    converged: Rc<RefCell<bool>>,
    erl: Rc<RefCell<Option<f32>>>,
    vad_calls: Rc<RefCell<usize>>,
    vad_resets: Rc<RefCell<usize>>,
    sink: Sink,
    speech: Speech,
    shared: Arc<DspShared>,
    events: mpsc::UnboundedReceiver<DspEvent>,
    now: u64,
}

struct Opts {
    rate: u32,
    reference: bool,
    real_canceller: bool,
    vad: bool,
    mic_capacity: usize,
    ref_capacity: usize,
}

impl Default for Opts {
    fn default() -> Self {
        Self { rate: 16_000, reference: true, real_canceller: true, vad: true, mic_capacity: 96_000, ref_capacity: 96_000 }
    }
}

impl Rig {
    fn new(o: Opts) -> Rig {
        let install = |capacity: usize| {
            let (w, r) = tap_channel(capacity);
            let slot = TapSlot::new();
            slot.replace(Some(w));
            slot.begin_stream(o.rate);
            (slot, r)
        };
        let (mic, mic_r) = install(o.mic_capacity);
        let (system, system_r) = {
            let (w, r) = tap_channel(96_000);
            let slot = TapSlot::new();
            slot.replace(Some(w));
            slot.begin_stream(16_000);
            (slot, r)
        };
        let (reference, ref_r) = if o.reference {
            let (slot, r) = install(o.ref_capacity);
            (Some(slot), Some(r))
        } else {
            (None, None)
        };
        let log = Rc::new(RefCell::new(Vec::new()));
        let converged = Rc::new(RefCell::new(false));
        let erl = Rc::new(RefCell::new(None));
        let vad_calls = Rc::new(RefCell::new(0));
        let vad_resets = Rc::new(RefCell::new(0));
        let vad: Option<Box<dyn Vad>> = o.vad.then(|| {
            Box::new(FakeVad { frame: 512, calls: vad_calls.clone(), resets: vad_resets.clone() }) as Box<dyn Vad>
        });
        let sink = Sink::default();
        let speech = Speech::default();
        let shared = Arc::new(DspShared::default());
        let (tx, events) = mpsc::unbounded_channel();
        let core = DspCore::new(
            mic_r,
            ref_r,
            Box::new(FakeCanceller { log: log.clone(), converged: converged.clone(), erl: erl.clone() }),
            o.real_canceller,
            vad,
            Box::new(sink.clone()),
            Box::new(speech.clone()),
            shared.clone(),
            tx,
            0,
        )
        .with_system_reference(Some(system_r));
        Rig {
            core,
            mic,
            reference,
            system,
            log,
            converged,
            erl,
            vad_calls,
            vad_resets,
            sink,
            speech,
            shared,
            events,
            now: 0,
        }
    }

    /// The same rig running the noisy room's barge-in (level-gated).
    fn noisy(mut self) -> Rig {
        self.core = self.core.with_profile(NoiseProfile::Noisy);
        self
    }

    fn push(slot: &TapSlot, value: f32, n: usize) {
        slot.acquire().expect("installed").push_slice(&vec![value; n]);
    }

    fn mic(&mut self, value: f32, n: usize) {
        Self::push(&self.mic, value, n);
    }

    fn reference(&mut self, value: f32, n: usize) {
        Self::push(self.reference.as_ref().unwrap(), value, n);
    }

    fn system(&mut self, value: f32, n: usize) {
        Self::push(&self.system, value, n);
    }

    /// Run the system tap from the next pass on (or stop it).
    fn system_tap(&mut self, on: bool) {
        self.shared.system_ref_on.store(on, Ordering::SeqCst);
    }

    fn step(&mut self, ms: u64) -> bool {
        self.now += ms;
        self.core.step(self.now)
    }

    fn calls(&self) -> Vec<Call> {
        std::mem::take(&mut *self.log.borrow_mut())
    }

    fn events(&mut self) -> Vec<DspEvent> {
        let mut out = Vec::new();
        while let Ok(e) = self.events.try_recv() {
            out.push(e);
        }
        out
    }

    fn sunk(&self) -> Vec<f32> {
        std::mem::take(&mut *self.sink.0.lock().unwrap())
    }
}

use Call::{Capture as C, Render as R, Reset};

// ─── ordering and the reference ─────────────────────────────────────────────

#[test]
fn render_frames_that_arrived_go_in_before_each_capture_frame() {
    let mut r = Rig::new(Opts::default());
    r.reference(0.2, 320); // two render frames
    r.mic(0.4, 480); // three capture frames
    assert!(r.step(5));
    assert_eq!(r.calls(), vec![R(0.2), R(0.2), C(0.4), C(0.4), C(0.4)]);
    // Interleaved arrival: each pass hands over what has arrived.
    r.reference(0.3, 160);
    r.mic(0.5, 160);
    r.step(5);
    assert_eq!(r.calls(), vec![R(0.3), C(0.5)]);
    // A live reference that is merely late adds no zeros...
    r.mic(0.6, 160);
    r.step(5);
    assert_eq!(r.calls(), vec![C(0.6)]);
    // ...a partial render frame waits for the rest...
    r.reference(0.7, 100);
    r.mic(0.6, 160);
    r.step(5);
    assert_eq!(r.calls(), vec![C(0.6)]);
    r.reference(0.7, 60);
    r.mic(0.6, 160);
    r.step(5);
    assert_eq!(r.calls(), vec![R(0.7), C(0.6)]);
    // ...and a reference silent for > 100 ms is absent: zeros keep the
    // render timeline moving.
    r.mic(0.8, 320);
    r.step(REFERENCE_STALL_MS + 1);
    assert_eq!(r.calls(), vec![R(0.0), C(0.8), R(0.0), C(0.8)]);
}

/// The same passes, with and without the debug capture: identical
/// behaviour, and the capture holds the exact interleaving.
#[test]
fn the_debug_capture_changes_nothing_and_records_the_interleaving() {
    fn script(r: &mut Rig) -> (Vec<Call>, Vec<DspEvent>, Vec<f32>) {
        let mut calls = Vec::new();
        let mut events = Vec::new();
        let mut pass = |r: &mut Rig, ms: u64| {
            r.step(ms);
            calls.extend(r.calls());
            events.extend(r.events());
        };
        r.reference(0.2, 320);
        r.mic(0.4, 480);
        pass(r, 5);
        r.reference(0.7, 100);
        r.mic(0.6, 160);
        pass(r, 5);
        r.reference(0.7, 60);
        r.mic(0.02, 640);
        pass(r, 5);
        r.mic(0.8, 320);
        pass(r, REFERENCE_STALL_MS + 1);
        r.shared.muted.store(true, Ordering::SeqCst);
        r.mic(0.4, 320);
        pass(r, 5);
        r.shared.muted.store(false, Ordering::SeqCst);
        r.mic(0.4, 1_024);
        pass(r, 5);
        let sunk = r.sunk();
        (calls, events, sunk)
    }
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("cap");
    let mut plain = Rig::new(Opts::default());
    let mut recorded = Rig::new(Opts::default());
    let cap = crate::voice::capture::Capture::start(&dir, serde_json::json!({})).unwrap();
    let core = recorded.core;
    recorded.core = core.with_capture(Some(cap));
    let a = script(&mut plain);
    let b = script(&mut recorded);
    assert_eq!(a, b);
    let renders = a.0.iter().filter(|c| matches!(c, R(_))).count();
    let captures: Vec<f32> = a.0.iter().filter_map(|c| if let C(v) = c { Some(*v) } else { None }).collect();
    drop(recorded);
    let meta = dir.join("meta.json");
    for _ in 0..300 {
        if meta.is_file() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(meta.is_file());
    let aec = std::fs::read_to_string(dir.join("aec.csv")).unwrap();
    let rows: Vec<Vec<String>> = aec.lines().skip(1).map(|l| l.split(',').map(str::to_string).collect()).collect();
    assert_eq!(rows.len(), captures.len());
    let before: usize = rows.iter().map(|r| r[2].parse::<usize>().unwrap() + r[3].parse::<usize>().unwrap()).sum();
    assert_eq!(before, renders, "render frames (absent zeros included) per capture frame add up");
    let mic: Vec<f32> = hound::WavReader::open(dir.join("mic_16k.wav")).unwrap().samples::<f32>().map(|s| s.unwrap()).collect();
    assert_eq!(mic.iter().step_by(AEC_FRAME).copied().collect::<Vec<_>>(), captures);
    let reference: Vec<f32> =
        hound::WavReader::open(dir.join("ref_16k.wav")).unwrap().samples::<f32>().map(|s| s.unwrap()).collect();
    let rendered: Vec<f32> = a.0.iter().filter_map(|c| if let R(v) = c { Some(*v) } else { None }).collect();
    assert_eq!(reference.iter().step_by(AEC_FRAME).copied().collect::<Vec<_>>(), rendered);
    assert!(rows.iter().any(|r| r[13] == "1"), "the mute toggles are marked");
    let vads = a.1.iter().filter(|e| matches!(e, DspEvent::Vad { .. })).count();
    let frames = std::fs::read_to_string(dir.join("frames.csv")).unwrap();
    assert_eq!(frames.lines().count() - 1, vads);
}

#[test]
fn without_a_reference_every_capture_frame_gets_one_zero_render_frame() {
    let mut r = Rig::new(Opts { reference: false, ..Default::default() });
    r.mic(0.4, 480);
    r.step(5);
    assert_eq!(r.calls(), vec![R(0.0), C(0.4), R(0.0), C(0.4), R(0.0), C(0.4)]);
}

#[test]
fn a_reference_not_yet_on_a_stream_is_absent() {
    let (mic, mic_r) = tap_channel(4_096);
    mic.begin_stream(16_000);
    let (_ref_w, ref_r) = tap_channel(4_096); // never installed: rate 0
    let log = Rc::new(RefCell::new(Vec::new()));
    let (tx, _rx) = mpsc::unbounded_channel();
    let mut core = DspCore::new(
        mic_r,
        Some(ref_r),
        Box::new(FakeCanceller {
            log: log.clone(),
            converged: Rc::new(RefCell::new(false)),
            erl: Rc::new(RefCell::new(None)),
        }),
        true,
        None,
        Box::new(Sink::default()),
        Box::new(Speech::default()),
        Arc::new(DspShared::default()),
        tx,
        0,
    );
    let mut mic = mic;
    mic.push_slice(&[0.1; 160]);
    core.step(5);
    assert_eq!(*log.borrow(), vec![R(0.0), C(0.1)]);
}

// ─── the clock, the sink, mute ──────────────────────────────────────────────

#[test]
fn cleaned_audio_feeds_transcription_and_counts_the_clock() {
    let mut r = Rig::new(Opts::default());
    r.mic(0.4, 1_000);
    r.step(5);
    // Whole frames only: 6 × 160; the 40 left wait.
    assert_eq!(r.core.clock(), 960);
    let sunk = r.sunk();
    assert_eq!(sunk.len(), 960);
    assert!(sunk.iter().all(|&s| s == 0.2), "the canceller's output, not the raw mic");
    r.mic(0.4, 120);
    r.step(5);
    assert_eq!(r.core.clock(), 1_120);
    assert_eq!(r.sunk().len(), 160);
}

#[test]
fn mute_feeds_silence_and_no_vad_but_keeps_the_canceller_on_the_real_mic() {
    let mut r = Rig::new(Opts::default());
    r.mic(0.4, 2_560); // 16 capture frames, 5 VAD frames
    r.step(5);
    let vad_before = *r.vad_calls.borrow();
    assert_eq!(vad_before, 5);
    r.calls();
    r.sunk();
    r.events();

    r.shared.muted.store(true, Ordering::SeqCst);
    r.mic(0.4, 1_600);
    r.step(5);
    assert_eq!(*r.vad_calls.borrow(), vad_before, "no VAD while muted");
    let sunk = r.sunk();
    assert_eq!(sunk.len(), 1_600, "transcription still gets the clock's worth");
    assert!(sunk.iter().all(|&s| s == 0.0), "…of silence");
    let calls = r.calls();
    assert!(calls.contains(&C(0.4)), "the canceller keeps running on the real mic");
    assert!(r.events().iter().all(|e| !matches!(e, DspEvent::Vad { .. })));

    r.shared.muted.store(false, Ordering::SeqCst);
    r.mic(0.4, 640);
    r.step(5);
    assert_eq!(*r.vad_resets.borrow(), 1, "the VAD restarts clean");
    let vads: Vec<_> = r.events().into_iter().filter(|e| matches!(e, DspEvent::Vad { .. })).collect();
    // The VAD frame starts where unmuting left the clock.
    let clock_at_unmute = 2_560 + 1_600;
    let level_db = detect::level_db(0.2); // 0.4 in, halved by the fake canceller
    assert!(matches!(
        vads[..],
        [DspEvent::Vad { prob: 0.9, start, end, level_db: l, .. }] if start == clock_at_unmute && end == clock_at_unmute + 512 && l == level_db
    ), "{vads:?}");
}

#[test]
fn vad_frames_tile_the_clock() {
    let mut r = Rig::new(Opts::default());
    r.mic(0.0, 700);
    r.step(5);
    r.mic(0.4, 1_000);
    r.step(5);
    let vads: Vec<_> = r
        .events()
        .into_iter()
        .filter_map(|e| if let DspEvent::Vad { prob, start, end, .. } = e { Some((prob, start, end)) } else { None })
        .collect();
    // 1600 cleaned samples → three 512-sample frames.
    assert_eq!(vads, vec![(0.05, 0, 512), (0.9, 512, 1_024), (0.9, 1_024, 1_536)]);
}

#[test]
fn vad_frames_carry_their_level_and_the_floor_before_them() {
    let mut r = Rig::new(Opts::default());
    // Cleaned = mic / 2: 0.002 → −60 dBFS, then 0.02 → −40 dBFS.
    r.mic(0.002, 1_024);
    r.mic(0.02, 1_056); // 2080 = 13 capture frames = 4 VAD frames (and change)
    r.step(5);
    let vads: Vec<_> = r
        .events()
        .into_iter()
        .filter_map(|e| if let DspEvent::Vad { level_db, floor_db, .. } = e { Some((level_db, floor_db)) } else { None })
        .collect();
    assert_eq!(vads.len(), 4);
    let mut floor = detect::NoiseFloor::default();
    for (i, &(level, before)) in vads.iter().enumerate() {
        let want = if i < 2 { detect::level_db(0.001) } else { detect::level_db(0.01) };
        assert!((level - want).abs() < 1e-3, "frame {i}: {level} vs {want}");
        assert_eq!(before, floor.update(level), "frame {i}: the floor before it");
    }
    assert_eq!(vads[0].1, detect::FLOOR_START_DB);
}

// ─── taps: epochs and drops ─────────────────────────────────────────────────

#[test]
fn a_new_mic_stream_resets_the_canceller_and_drops_stale_frames() {
    let mut r = Rig::new(Opts::default());
    r.mic(0.1, 160);
    r.step(5);
    r.calls();
    assert!(!r.events().contains(&DspEvent::MicReplaced), "the first stream is no replacement");
    // Render frames are waiting when the mic stream is replaced.
    r.reference(0.3, 320);
    r.mic(0.9, 100); // the old stream's tail, never read
    r.mic.begin_stream(16_000);
    r.mic(0.5, 160);
    r.step(5);
    let calls = r.calls();
    assert_eq!(calls[0], Reset);
    // The session is told (the level gate starts over), once.
    assert_eq!(r.events().iter().filter(|e| **e == DspEvent::MicReplaced).count(), 1);
    // The old stream's queued frames are gone (reader cleared), and so are the
    // render frames queued against the old timeline; the new stream's frames
    // come later.
    assert!(!calls.contains(&C(0.9)));
    assert!(!calls.contains(&R(0.3)));
    r.mic(0.5, 160);
    r.reference(0.6, 160);
    r.step(5);
    assert_eq!(r.calls(), vec![R(0.6), C(0.5)]);
}

#[test]
fn a_new_reference_stream_resets_the_canceller_and_echo_tracking() {
    let mut r = Rig::new(Opts::default());
    r.reference(0.2, 160);
    r.mic(0.1, 160);
    r.step(5);
    assert_eq!(r.calls(), vec![R(0.2), C(0.1)]);
    r.reference(0.9, 160); // queued on the old output stream
    r.reference.as_ref().unwrap().begin_stream(16_000);
    r.reference(0.3, 160);
    r.mic(0.1, 160);
    r.step(5);
    let calls = r.calls();
    assert_eq!(calls.first(), Some(&Reset));
    assert!(!calls.contains(&R(0.9)), "the old stream's frames are cleared");
    assert!(!r.events().contains(&DspEvent::MicReplaced), "an output swap leaves the mic's level alone");
}

#[test]
fn a_new_stream_at_another_rate_is_resampled() {
    let mut r = Rig::new(Opts::default());
    r.mic.begin_stream(48_000);
    r.step(5);
    r.sunk();
    // One second at 48 kHz → about one second at 16 kHz (within the
    // resampler's latency).
    for _ in 0..100 {
        r.mic(0.1, 480);
        r.step(5);
    }
    let n = r.sunk().len() as i64;
    assert!((16_000 - n).abs() <= 400, "{n}");
    assert_eq!(n % 160, 0);
}

#[test]
fn mic_frames_a_full_ring_dropped_come_back_as_silence() {
    let mut r = Rig::new(Opts { mic_capacity: 256, ..Default::default() });
    r.mic(0.4, 600); // 344 dropped
    r.step(5);
    // 256 + 344 zeros = 600 → three whole frames, 120 waiting.
    assert_eq!(r.core.clock(), 480);
    let sunk = r.sunk();
    assert_eq!(&sunk[..256], &[0.2; 256][..]);
    assert!(sunk[256..].iter().all(|&s| s == 0.0));
    r.mic(0.4, 40);
    r.step(5);
    assert_eq!(r.core.clock(), 640, "the gap kept the timeline");
}

#[test]
fn reference_frames_a_full_ring_dropped_come_back_as_silence() {
    let mut r = Rig::new(Opts { ref_capacity: 160, ..Default::default() });
    r.reference(0.3, 480); // 320 dropped
    r.mic(0.1, 480);
    r.step(5);
    assert_eq!(r.calls(), vec![R(0.3), R(0.0), R(0.0), C(0.1), C(0.1), C(0.1)]);
}

// ─── echo mode, barge-in ────────────────────────────────────────────────────

fn echo_events(events: &[DspEvent]) -> Vec<EchoMode> {
    events.iter().filter_map(|e| if let DspEvent::Echo(m) = e { Some(*m) } else { None }).collect()
}

#[test]
fn echo_mode_is_reported_on_change() {
    let mut r = Rig::new(Opts { real_canceller: false, ..Default::default() });
    r.mic(0.1, 320);
    r.step(5);
    assert_eq!(echo_events(&r.events()), vec![EchoMode::HalfDuplex]);
    // A headphones name is only a hint: no change.
    r.shared.headphones_hint.store(true, Ordering::SeqCst);
    r.mic(0.1, 320);
    r.step(5);
    assert!(echo_events(&r.events()).is_empty());

    let mut r = Rig::new(Opts::default());
    r.mic(0.1, 160);
    r.step(5);
    assert_eq!(echo_events(&r.events()), vec![EchoMode::Converging]);
    *r.converged.borrow_mut() = true;
    r.mic(0.1, 160);
    r.step(5);
    assert_eq!(echo_events(&r.events()), vec![EchoMode::Cancelling]);
}

/// The agent talking (a loud reference) for `ms`, the mic silent.
fn agent_talks(r: &mut Rig, ms: usize) {
    for _ in 0..ms / 10 {
        r.reference(0.1, 160);
        r.mic(0.0, 160);
        r.step(10);
    }
}

#[test]
fn no_echo_path_is_measured_from_the_erl_while_the_agent_talks() {
    let mut r = Rig::new(Opts::default());
    *r.erl.borrow_mut() = Some(-30.0);
    agent_talks(&mut r, detect::NO_PATH_AFTER_MS as usize - 10);
    assert_eq!(echo_events(&r.events()), vec![EchoMode::Converging]);
    agent_talks(&mut r, 10);
    assert_eq!(echo_events(&r.events()), vec![EchoMode::Headphones]);
    // The canceller finding an echo takes it back.
    *r.erl.borrow_mut() = Some(10.0);
    agent_talks(&mut r, 10);
    assert_eq!(echo_events(&r.events()), vec![EchoMode::Converging]);
}

fn barge_ins(events: &[DspEvent]) -> Vec<u64> {
    events.iter().filter_map(|e| if let DspEvent::BargeIn { onset } = e { Some(*onset) } else { None }).collect()
}

/// Loud mic for `ms` in 10 ms passes.
fn talk(r: &mut Rig, ms: usize) {
    for _ in 0..ms / 10 {
        r.mic(0.4, 160);
        r.reference(0.0, 160);
        r.step(10);
    }
}

#[test]
fn barge_in_cancels_speech_from_the_dsp_thread() {
    let mut r = Rig::new(Opts::default());
    *r.converged.borrow_mut() = true; // cancelling
    r.shared.barge_armed.store(true, Ordering::SeqCst);
    r.speech.audible.store(true, Ordering::SeqCst);
    r.mic(0.0, 1_024); // two quiet VAD frames
    r.reference(0.0, 1_024);
    r.step(10);
    talk(&mut r, 330);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 1, "cancelled right here");
    assert_eq!(barge_ins(&r.events()), vec![1_024], "onset = the first loud VAD frame");
    assert!(!r.shared.barge_armed.load(Ordering::SeqCst), "fires once; the session re-arms");
    talk(&mut r, 500);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 1);
}

/// The noisy room: speech well under the user's measured level (a TV) never
/// interrupts the agent; the user at their level does.
#[test]
fn the_noisy_barge_in_ignores_far_speech() {
    let mut r = Rig::new(Opts::default()).noisy();
    *r.converged.borrow_mut() = true;
    r.shared.barge_armed.store(true, Ordering::SeqCst);
    r.speech.audible.store(true, Ordering::SeqCst);
    // Cleaned = mic / 2: 0.4 → −14 dBFS, the user's level; 0.12 → −24.4
    // dBFS, loud enough for the VAD but 10.4 dB under the user.
    r.shared.speech_level.set(Some((-14.0, true)));
    for _ in 0..100 {
        r.mic(0.12, 160);
        r.reference(0.0, 160);
        r.step(10);
    }
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 0, "far speech");
    assert!(barge_ins(&r.events()).is_empty());
    talk(&mut r, 450);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 1, "the user");
    assert_eq!(barge_ins(&r.events()).len(), 1);
}

/// Auto: the quiet room's barge-in until the machine publishes an S (a
/// switch, or a known S), the noisy room's gated one from then on, and the
/// quiet one again when it takes S back.
#[test]
fn the_auto_barge_in_follows_the_published_speech_level() {
    let far = |r: &mut Rig| {
        for _ in 0..60 {
            r.mic(0.12, 160);
            r.reference(0.0, 160);
            r.step(10);
        }
    };
    let arm = |r: &mut Rig| r.shared.barge_armed.store(true, Ordering::SeqCst);
    let mut r = Rig::new(Opts::default());
    r.core = r.core.with_profile(NoiseProfile::Auto);
    *r.converged.borrow_mut() = true;
    r.speech.audible.store(true, Ordering::SeqCst);
    arm(&mut r);
    // No S published: the quiet room's barge-in, which a TV fires.
    far(&mut r);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 1, "ungated");
    // S published (−14 dBFS, the user's level): far speech doesn't, the
    // user does.
    r.shared.speech_level.set(Some((-14.0, true)));
    arm(&mut r);
    far(&mut r);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 1, "gated: far speech");
    talk(&mut r, 450);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 2, "gated: the user");
    // Taken back (S relaxed to unknown): the quiet room's again.
    r.shared.speech_level.set(None);
    arm(&mut r);
    far(&mut r);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 3);
}

#[test]
fn barge_in_is_suppressed_by_the_echo_mode() {
    // Passthrough on speakers: half-duplex.
    let mut r = Rig::new(Opts { real_canceller: false, ..Default::default() });
    r.shared.barge_armed.store(true, Ordering::SeqCst);
    r.speech.audible.store(true, Ordering::SeqCst);
    talk(&mut r, 1_000);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 0);
    assert!(barge_ins(&r.events()).is_empty());
    // A headphones name doesn't allow it either.
    r.shared.headphones_hint.store(true, Ordering::SeqCst);
    talk(&mut r, 1_000);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 0);

    // A canceller that measured no echo path does.
    let mut r = Rig::new(Opts::default());
    *r.erl.borrow_mut() = Some(-30.0);
    r.shared.barge_armed.store(true, Ordering::SeqCst);
    r.speech.audible.store(true, Ordering::SeqCst);
    talk(&mut r, 1_000);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 0, "converging: not yet");
    agent_talks(&mut r, detect::NO_PATH_AFTER_MS as usize);
    talk(&mut r, 400);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 1);
}

#[test]
fn barge_in_needs_the_session_armed_and_the_agent_audible() {
    let mut r = Rig::new(Opts::default());
    *r.converged.borrow_mut() = true;
    r.speech.audible.store(true, Ordering::SeqCst);
    talk(&mut r, 1_000);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 0, "not armed");
    r.shared.barge_armed.store(true, Ordering::SeqCst);
    r.speech.audible.store(false, Ordering::SeqCst);
    talk(&mut r, 1_000);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 0, "between sentences");
    r.speech.audible.store(true, Ordering::SeqCst);
    r.shared.muted.store(true, Ordering::SeqCst);
    talk(&mut r, 1_000);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 0, "muted");
}

/// The `wake` policy: the same detector, the same arming and echo-mode
/// rule, but the speech is left playing and the session hears `Wake`.
#[test]
fn a_wake_fires_like_barge_in_but_cancels_nothing() {
    let mut r = Rig::new(Opts::default());
    *r.converged.borrow_mut() = true; // cancelling
    r.shared.barge_armed.store(true, Ordering::SeqCst);
    r.shared.barge_wakes.store(true, Ordering::SeqCst);
    r.speech.audible.store(true, Ordering::SeqCst);
    r.mic(0.0, 1_024);
    r.reference(0.0, 1_024);
    r.step(10);
    talk(&mut r, 330);
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 0, "the reading goes on");
    let events = r.events();
    assert!(barge_ins(&events).is_empty());
    let wakes: Vec<u64> = events.iter().filter_map(|e| if let DspEvent::Wake { onset } = e { Some(*onset) } else { None }).collect();
    assert_eq!(wakes, vec![1_024], "onset = the first loud VAD frame");
    assert!(!r.shared.barge_armed.load(Ordering::SeqCst), "fires once; the session re-arms");
    talk(&mut r, 500);
    assert!(r.events().iter().all(|e| !matches!(e, DspEvent::Wake { .. })));

    // Before the canceller converges (on speakers) the agent's own voice
    // would be the "user": no wake, as no barge-in.
    let mut r = Rig::new(Opts::default());
    r.shared.barge_armed.store(true, Ordering::SeqCst);
    r.shared.barge_wakes.store(true, Ordering::SeqCst);
    r.speech.audible.store(true, Ordering::SeqCst);
    talk(&mut r, 1_000);
    assert!(r.events().iter().all(|e| !matches!(e, DspEvent::Wake { .. } | DspEvent::BargeIn { .. })));
    assert_eq!(r.speech.cancels.load(Ordering::SeqCst), 0);
}

/// An interactive session: transcription hears speech (with its pre-roll),
/// not the quiet room, and the clock map puts the engine's times back on
/// the session clock. Muting shuts it at once.
#[test]
fn an_interactive_session_feeds_transcription_around_speech_only() {
    use crate::voice::feed::{PRE_ROLL_MS, TAIL_MARGIN_MS};
    let mut r = Rig::new(Opts::default());
    let (gate, clock) = feed_gate(700);
    r.core = r.core.with_feed_gate(Some(gate));
    // Two seconds of a quiet room: nothing fed, the clock runs.
    for _ in 0..200 {
        r.mic(0.0, 160);
        r.step(10);
    }
    assert!(r.sunk().is_empty());
    assert_eq!(r.core.clock(), 32_000);
    // Speech: the pre-roll (the quiet room's cleaned silence) then the voice.
    talk(&mut r, 500);
    let fed = r.sunk();
    let onset_frame = 31_744; // the first VAD frame (512 samples) at 0.9
    let pre = (PRE_ROLL_MS * 16) as usize;
    let from = onset_frame - pre as u64;
    assert_eq!(fed.len() as u64, r.core.clock() - from, "contiguous from the pre-roll to the clock");
    assert!(fed[..32_000 - from as usize].iter().all(|&s| s == 0.0), "the pre-roll: the room before the voice");
    assert!(fed[32_000 - from as usize..].iter().all(|&s| s == 0.2), "then the voice (cleaned)");
    assert_eq!(clock.to_session(0.0), from as f64 / 16_000.0);
    // The pause: fed through the end silence and the margin, then nothing.
    for _ in 0..(700 + TAIL_MARGIN_MS + 100) / 10 {
        r.mic(0.0, 160);
        r.step(10);
    }
    let tail = r.sunk().len() as u64;
    assert!((700 + TAIL_MARGIN_MS) * 16 <= tail && tail <= (700 + TAIL_MARGIN_MS + 100) * 16, "{tail}");
    for _ in 0..100 {
        r.mic(0.0, 160);
        r.step(10);
    }
    assert!(r.sunk().is_empty());
    // Speech again, then mute mid-speech: nothing more is fed (not even
    // silence), and nothing after unmuting until the voice is back.
    talk(&mut r, 300);
    assert!(!r.sunk().is_empty());
    r.shared.muted.store(true, Ordering::SeqCst);
    talk(&mut r, 500);
    assert!(r.sunk().is_empty(), "muted");
    r.shared.muted.store(false, Ordering::SeqCst);
    for _ in 0..50 {
        r.mic(0.0, 160);
        r.step(10);
    }
    assert!(r.sunk().is_empty());
    talk(&mut r, 200);
    assert!(!r.sunk().is_empty());
}

// ─── levels, stalls ─────────────────────────────────────────────────────────

#[test]
fn levels_are_the_cleaned_mic_and_the_reference_at_about_15_hz() {
    let mut r = Rig::new(Opts::default());
    r.mic(0.4, 16_000);
    r.reference(0.3, 16_000);
    r.step(5);
    let levels: Vec<_> = r
        .events()
        .into_iter()
        .filter_map(|e| if let DspEvent::Level { mic, agent } = e { Some((mic, agent)) } else { None })
        .collect();
    assert!((14..=15).contains(&levels.len()), "{}", levels.len());
    let (mic, agent) = levels[0];
    assert!((mic - 0.2).abs() < 1e-4, "cleaned, not raw: {mic}");
    assert!((agent - 0.3).abs() < 1e-4, "{agent}");
    // Muted: the mic reads 0.
    r.shared.muted.store(true, Ordering::SeqCst);
    r.mic(0.4, 2_000);
    r.step(5);
    let levels: Vec<_> = r.events().into_iter().filter(|e| matches!(e, DspEvent::Level { .. })).collect();
    assert!(levels.iter().all(|e| matches!(e, DspEvent::Level { mic, .. } if *mic == 0.0)));
}

#[test]
fn a_mic_that_never_delivers_or_stops_delivering_is_reported_once() {
    let mut r = Rig::new(Opts::default());
    r.step(MIC_FIRST_FRAME_MS);
    assert!(!r.events().contains(&DspEvent::MicStalled));
    r.step(1);
    assert_eq!(r.events().iter().filter(|e| **e == DspEvent::MicStalled).count(), 1);
    r.step(10_000);
    assert!(!r.events().contains(&DspEvent::MicStalled), "once");

    let mut r = Rig::new(Opts::default());
    r.mic(0.1, 160);
    r.step(5);
    r.step(MIC_STALL_MS);
    assert!(!r.events().contains(&DspEvent::MicStalled));
    r.step(1);
    assert!(r.events().contains(&DspEvent::MicStalled));
}

/// A live switch or a recovery replaces the stream: it gets its own
/// first-frame budget, and its own stall is reported again.
#[test]
fn a_replaced_mic_stream_rearms_the_stall_report() {
    let mut r = Rig::new(Opts::default());
    r.mic(0.1, 160);
    r.step(5);
    r.step(MIC_STALL_MS + 1);
    assert_eq!(r.events().iter().filter(|e| **e == DspEvent::MicStalled).count(), 1);
    r.mic.begin_stream(16_000);
    r.step(5);
    assert!(r.events().contains(&DspEvent::MicReplaced));
    r.step(MIC_FIRST_FRAME_MS);
    assert!(!r.events().contains(&DspEvent::MicStalled), "the new stream's first frame may take this long");
    r.step(1);
    assert!(r.events().contains(&DspEvent::MicStalled));
}

// ─── speech audio (Voice focus) ─────────────────────────────────────────────

fn audio_events(events: &[DspEvent]) -> Vec<(u64, Vec<i16>)> {
    events.iter().filter_map(|e| if let DspEvent::Audio { start, pcm } = e { Some((*start, pcm.clone())) } else { None }).collect()
}

#[test]
fn speech_audio_is_what_local_stt_hears_on_the_session_clock() {
    let mut r = Rig::new(Opts::default());
    r.core = r.core.with_speech_audio(true);
    r.mic(0.4, 1_600);
    r.step(5);
    let audio = audio_events(&r.events());
    assert_eq!(audio.len(), 1);
    let (start, pcm) = &audio[0];
    assert_eq!((*start, pcm.len()), (0, SPEECH_FLUSH));
    // The cleaned audio (the fake canceller halves it), as local-stt got it.
    let sunk = r.sunk();
    assert_eq!(sunk.len(), SPEECH_FLUSH);
    assert!(sunk.iter().zip(pcm).all(|(s, p)| crate::voice::speech::to_i16(*s) == *p));
    assert_eq!(pcm[0], crate::voice::speech::to_i16(0.2));
    // Less than a batch waits for the rest; the next batch starts where it left off.
    r.mic(0.4, 800);
    r.step(5);
    assert!(audio_events(&r.events()).is_empty());
    r.mic(0.4, 800);
    r.step(5);
    assert_eq!(audio_events(&r.events()).iter().map(|(s, p)| (*s, p.len())).collect::<Vec<_>>(), [(1_600, 1_600)]);
    // Muted: what local-stt hears is silence, still on the clock.
    r.shared.muted.store(true, Ordering::SeqCst);
    r.mic(0.4, 1_600);
    r.step(5);
    let audio = audio_events(&r.events());
    assert_eq!(audio[0].0, 3_200);
    assert!(audio[0].1.iter().all(|&s| s == 0));

    // Off unless asked for.
    let mut r = Rig::new(Opts::default());
    r.mic(0.4, 1_600);
    r.step(5);
    assert!(audio_events(&r.events()).is_empty());
}

// ─── the real canceller: speakers vs headphones, by signal ──────────────────

mod real_canceller {
    use super::*;
    use crate::audio::aec3_canceller::tests::{convolve, echo_path, synthetic_speech, Rng};
    use crate::audio::aec3_canceller::Aec3Canceller;

    /// A sensitive VAD: any frame above −46 dBFS is speech. The agent's echo
    /// on speakers (before the canceller converges) passes for speech, as it
    /// does for Silero.
    struct LoudnessVad;

    impl Vad for LoudnessVad {
        fn frame_len(&self) -> usize {
            512
        }
        fn process(&mut self, frame: &[f32]) -> f32 {
            if rms(sum_squares(frame), frame.len()) > 0.005 {
                0.9
            } else {
                0.05
            }
        }
        fn reset(&mut self) {}
    }

    /// The real canceller, whose output keeps half the raw echo until it
    /// reports converged. aec3's suppressor hides a synthetic (linear) echo
    /// almost at once; a real room and loudspeaker leak far more until the
    /// canceller has converged, which is what the barge-in gate is for. The
    /// metrics (ERL, convergence) are the real canceller's, on the real echo.
    struct LeakUntilConverged(Aec3Canceller);

    impl EchoCanceller for LeakUntilConverged {
        fn render(&mut self, frame: &[f32; AEC_FRAME]) {
            self.0.render(frame);
        }
        fn capture(&mut self, frame: &[f32; AEC_FRAME], out: &mut [f32; AEC_FRAME]) -> AecMetrics {
            let m = self.0.capture(frame, out);
            if !m.converged {
                out.iter_mut().zip(frame).for_each(|(o, i)| *o += 0.5 * i);
            }
            m
        }
        fn reset(&mut self) {
            self.0.reset();
        }
    }

    struct Scene {
        core: DspCore,
        mic: TapSlot,
        reference: TapSlot,
        speech: Speech,
        shared: Arc<DspShared>,
        events: mpsc::UnboundedReceiver<DspEvent>,
    }

    fn scene(hint: bool) -> Scene {
        let install = || {
            let (w, r) = tap_channel(96_000);
            let slot = TapSlot::new();
            slot.replace(Some(w));
            slot.begin_stream(16_000);
            (slot, r)
        };
        let ((mic, mic_r), (reference, ref_r)) = (install(), install());
        let speech = Speech::default();
        let shared = Arc::new(DspShared::default());
        shared.headphones_hint.store(hint, Ordering::SeqCst);
        shared.barge_armed.store(true, Ordering::SeqCst);
        speech.audible.store(true, Ordering::SeqCst);
        let (tx, events) = mpsc::unbounded_channel();
        let core = DspCore::new(
            mic_r,
            Some(ref_r),
            Box::new(LeakUntilConverged(Aec3Canceller::new().unwrap())),
            true,
            Some(Box::new(LoudnessVad)),
            Box::new(Sink::default()),
            Box::new(speech.clone()),
            shared.clone(),
            tx,
            0,
        );
        Scene { core, mic, reference, speech, shared, events }
    }

    /// What happened, frame by frame: the echo mode in force at each barge-in,
    /// every mode reported, and how many VAD frames said speech.
    #[derive(Default)]
    struct Log {
        modes: Vec<EchoMode>,
        barge_ins_in: Vec<EchoMode>,
        speech_frames: usize,
    }

    /// Plays `far` into the reference and `mic` into the mic, 10 ms a pass.
    fn play(s: &mut Scene, far: &[f32], mic: &[f32], log: &mut Log) {
        let mut now = 0;
        let mut mode = log.modes.last().copied().unwrap_or(EchoMode::Converging);
        for (f, m) in far.as_chunks::<AEC_FRAME>().0.iter().zip(mic.as_chunks::<AEC_FRAME>().0) {
            s.reference.acquire().unwrap().push_slice(f);
            s.mic.acquire().unwrap().push_slice(m);
            now += 10;
            s.core.step(now);
            while let Ok(e) = s.events.try_recv() {
                match e {
                    DspEvent::Echo(m) => {
                        mode = m;
                        log.modes.push(m);
                    }
                    // (The DSP thread cancelled the speech and disarmed.)
                    DspEvent::BargeIn { .. } => log.barge_ins_in.push(mode),
                    DspEvent::Vad { prob, .. } if prob > 0.5 => log.speech_frames += 1,
                    _ => {}
                }
            }
        }
    }

    /// The agent's voice (−20 dBFS speech, after a second of silence) and what
    /// a speaker in the room puts back into the mic: echo at `gain` over a
    /// 60 ms path, plus −60 dBFS noise.
    fn agent(seconds: f32, gain: f32) -> (Vec<f32>, Vec<f32>) {
        let mut far = vec![0.0f32; 16_000];
        far.extend(synthetic_speech(seconds, 7));
        let echo = convolve(&far, &echo_path(60.0, 0.25, 11));
        let mut rng = Rng::new(3);
        let mic = echo.iter().map(|e| gain * e + 0.001 * rng.gauss()).collect();
        (far, mic)
    }

    #[test]
    fn a_speaker_named_like_headphones_never_barges_in_on_its_own_echo() {
        // A "Beats Pill": the route hint says headphones; the mic hears the
        // agent at −6 dB. Its echo passes for speech until the canceller has
        // converged (the old name rule allowed barge-in from the first frame),
        // and barge-in stays off all that time.
        let mut s = scene(true);
        let (far, mic) = agent(9.0, 1.0);
        let mut log = Log::default();
        play(&mut s, &far, &mic, &mut log);
        assert!(!log.modes.contains(&EchoMode::Headphones), "modes {:?}", log.modes);
        assert!(log.modes.contains(&EchoMode::Cancelling), "the canceller converged: {:?}", log.modes);
        assert!(log.speech_frames > 50, "the echo was heard as speech ({} frames)", log.speech_frames);
        assert!(log.barge_ins_in.is_empty(), "barge-in on the agent's own echo: {:?} (modes {:?})", log.barge_ins_in, log.modes);
        assert_eq!(s.speech.cancels.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn headphones_with_an_unknown_name_barge_in_once_no_echo_path_is_measured() {
        // Sony / Bose / a USB dongle: no hint, and the mic hears none of the
        // agent (just room noise).
        let mut s = scene(false);
        let (far, mic) = agent(7.0, 0.0);
        let mut log = Log::default();
        play(&mut s, &far, &mic, &mut log);
        assert_eq!(log.modes.last(), Some(&EchoMode::Headphones), "modes {:?}", log.modes);
        assert!(log.barge_ins_in.is_empty(), "nobody talked");
        // The user talks over the agent: barge-in.
        let far2 = synthetic_speech(1.0, 21);
        let user: Vec<f32> = synthetic_speech(1.0, 33).iter().map(|v| v * 2.0).collect();
        play(&mut s, &far2, &user, &mut log);
        assert_eq!(log.barge_ins_in, vec![EchoMode::Headphones]);
        assert_eq!(s.speech.cancels.load(Ordering::SeqCst), 1);
    }

    /// The greeting: a second of the agent, with the user starting to talk
    /// half a second in (`user`: their voice in the mic; 0 = silent).
    fn greeting(user: f32, echo_gain: f32) -> (Vec<f32>, Vec<f32>) {
        let far = synthetic_speech(1.2, 5);
        let echo = convolve(&far, &echo_path(60.0, 0.25, 11));
        let voice = synthetic_speech(1.0, 41);
        let mut rng = Rng::new(9);
        let mic = (0..far.len())
            .map(|i| {
                let v = if i >= 8_000 { voice.get(i - 8_000).copied().unwrap_or(0.0) } else { 0.0 };
                echo_gain * echo[i] + user * 2.0 * v + 0.001 * rng.gauss()
            })
            .collect();
        (far, mic)
    }

    #[test]
    fn headphones_by_name_let_the_user_talk_over_the_greeting_before_any_echo_path_is_measured() {
        // Session start: the echo mode is converging (no path measured in a
        // second of far end), which rules barge-in out for a reply. The
        // greeting is an aside: on the hint it may be talked over.
        let mut s = scene(true);
        s.shared.barge_aside.store(true, Ordering::SeqCst);
        let (far, mic) = greeting(1.0, 0.0);
        let mut log = Log::default();
        play(&mut s, &far, &mic, &mut log);
        assert!(!log.modes.iter().any(|m| m.allows_barge_in()), "modes {:?}", log.modes);
        assert_eq!(log.barge_ins_in.len(), 1, "modes {:?}", log.modes);
        assert_eq!(s.speech.cancels.load(Ordering::SeqCst), 1);
        assert!(!s.shared.barge_aside.load(Ordering::SeqCst), "disarmed with the barge-in");

        // A reply (no aside) on the same route at the same point: no barge-in.
        let mut s = scene(true);
        let mut log = Log::default();
        play(&mut s, &far, &mic, &mut log);
        assert!(log.barge_ins_in.is_empty(), "modes {:?}", log.modes);
    }

    #[test]
    fn laptop_speakers_never_barge_into_the_greeting() {
        // No hint (the built-in speakers never carry one): the greeting's
        // echo passes for speech, and so would the user, but neither can
        // barge in before the echo mode allows it.
        for user in [0.0, 1.0] {
            let mut s = scene(false);
            s.shared.barge_aside.store(true, Ordering::SeqCst);
            let (far, mic) = greeting(user, 1.0);
            let mut log = Log::default();
            play(&mut s, &far, &mic, &mut log);
            assert!(log.speech_frames > 10, "the echo was heard as speech ({} frames)", log.speech_frames);
            assert!(log.barge_ins_in.is_empty(), "user {user}: {:?} (modes {:?})", log.barge_ins_in, log.modes);
            assert_eq!(s.speech.cancels.load(Ordering::SeqCst), 0);
        }
    }
}

// ─── the system-audio reference (voice/system_ref.rs) ──────────────────────

#[test]
fn the_system_tap_installed_but_off_changes_nothing() {
    let mut r = Rig::new(Opts { reference: false, ..Default::default() });
    r.system(0.3, 480);
    r.mic(0.4, 320);
    assert!(r.step(5));
    assert_eq!(r.core.hold_ms(), 0, "no tap: no hold");
    assert_eq!(r.calls(), vec![R(0.0), C(0.4), R(0.0), C(0.4)], "today's dictation: zero render frames");
}

#[test]
fn dictation_with_the_system_tap_holds_the_mic_and_renders_the_system_audio_first() {
    let mut r = Rig::new(Opts { reference: false, ..Default::default() });
    r.system_tap(true);
    r.step(5);
    assert_eq!(r.core.hold_ms(), system_ref::DEFAULT_HOLD_MS);
    // t=10: a mic frame and its system audio's first part.
    r.system(0.3, 160);
    r.mic(0.4, 160);
    assert!(!r.step(5), "held");
    // t=60: the rest of the system audio arrives, late through the pipe.
    r.system(0.5, 160);
    r.step(50);
    assert!(r.calls().is_empty());
    assert!(r.sunk().is_empty(), "nothing reaches transcription before its hold");
    // t=110 = 10 + the hold: everything that arrived by then goes in first,
    // alone (no read-aloud), and no zeros are added to a live reference.
    assert!(r.step(50));
    assert_eq!(r.calls(), vec![R(0.3), R(0.5), C(0.4)]);
    assert_eq!(r.sunk(), vec![0.2; 160], "the frame, cleaned, exactly once");
    assert_eq!(r.core.clock(), 160, "the session clock counts samples, not time");
}

#[test]
fn conversation_sums_the_system_audio_into_the_read_aloud_frames_without_moving_them() {
    let mut r = Rig::new(Opts::default());
    r.system_tap(true);
    r.step(5);
    // t=10: two read-aloud frames, one system frame, one mic frame.
    r.reference(0.2, 320);
    r.system(0.01, 160);
    r.mic(0.4, 160);
    r.step(5);
    // t=60: more of each (the read-aloud keeps flowing).
    r.reference(0.3, 160);
    r.system(0.02, 160);
    r.mic(0.5, 160);
    r.step(50);
    assert!(r.calls().is_empty(), "held");
    // t=110: the first mic frame. The read-aloud frames that had arrived when
    // it did (t=10) go first, as they would unheld, each carrying a system
    // frame due by its deadline; the t=60 read-aloud frame waits for its own
    // mic frame.
    r.reference(0.0, 160);
    r.step(50);
    assert_eq!(r.calls(), vec![R(0.2 + 0.01), R(0.2 + 0.02), C(0.4)]);
    // t=160: the second mic frame gets the t=60 read-aloud frame, alone (no
    // system frame left: a short system clock costs the system part a hole,
    // never the read-aloud part).
    r.reference(0.0, 160);
    r.step(50);
    assert_eq!(r.calls(), vec![R(0.3), C(0.5)]);
}

#[test]
fn the_echo_mode_and_agent_level_follow_the_read_aloud_only() {
    let mut r = Rig::new(Opts::default());
    r.system_tap(true);
    r.step(5);
    // Loud system audio, silent read-aloud.
    for _ in 0..30 {
        r.reference(0.0, 160);
        r.system(0.5, 160);
        r.mic(0.0, 160);
        r.step(10);
    }
    let levels: Vec<f32> =
        r.events().iter().filter_map(|e| if let DspEvent::Level { agent, .. } = e { Some(*agent) } else { None }).collect();
    assert!(!levels.is_empty());
    assert!(levels.iter().all(|&a| a == 0.0), "the agent level is the agent's speech: {levels:?}");
}

#[test]
fn stopping_the_tap_drops_the_hold_and_flushes_the_held_frames_at_once() {
    let mut r = Rig::new(Opts { reference: false, ..Default::default() });
    r.system_tap(true);
    r.step(5);
    r.system(0.3, 160);
    r.mic(0.4, 320);
    r.step(20);
    assert!(r.calls().is_empty());
    r.system_tap(false);
    r.system(0.6, 160); // what a stopping tap still delivers is not used
    assert!(r.step(5));
    assert_eq!(r.core.hold_ms(), 0);
    assert_eq!(r.calls(), vec![R(0.0), C(0.4), R(0.0), C(0.4)], "today's path again, nothing lost");
    assert_eq!(r.sunk().len(), 320);
}

#[test]
fn system_frames_that_waited_too_long_are_dropped_not_rendered_in_a_burst() {
    let mut r = Rig::new(Opts { reference: false, ..Default::default() });
    r.system_tap(true);
    r.step(5);
    r.system(0.3, 160); // t=10, with no mic frame to go with (a mic gap)
    r.step(5);
    r.mic(0.4, 160); // t=310
    r.step(300);
    r.step(100); // t=410: deadline 410, the system frame is 400 ms old
    assert_eq!(r.calls(), vec![C(0.4)]);
}

/// The real canceller: a far end that reaches the mic but is only in the
/// system reference, which arrives 40 ms AFTER its echo (the sidecar's pipe).
/// Held 100 ms, the reference leads again and the echo goes; unheld it can't.
/// The same with a (silent) read-aloud reference flowing, as in a
/// conversation: the system part rides on it and still gets the hold.
#[test]
fn the_hold_lets_the_canceller_remove_a_far_end_only_in_the_late_system_reference() {
    fn erle_db(hold_ms: u64, read_aloud: bool) -> f64 {
        let (mic_w, mic_r) = tap_channel(96_000);
        let mic = TapSlot::new();
        mic.replace(Some(mic_w));
        mic.begin_stream(16_000);
        let (sys_w, sys_r) = tap_channel(96_000);
        let sys = TapSlot::new();
        sys.replace(Some(sys_w));
        sys.begin_stream(16_000);
        let sink = Sink::default();
        let shared = Arc::new(DspShared::default());
        let (tx, _rx) = mpsc::unbounded_channel();
        let (tts_w, tts_r) = tap_channel(96_000);
        let tts = TapSlot::new();
        tts.replace(Some(tts_w));
        tts.begin_stream(16_000);
        let tts_r = read_aloud.then_some(tts_r);
        let canceller = aec::new_echo_canceller().expect("aec3 builds");
        let speech = Box::new(Speech::default());
        let mut core = DspCore::new(mic_r, tts_r, canceller, true, None, Box::new(sink.clone()), speech, shared.clone(), tx, 0)
            .with_system_reference(Some(sys_r))
            .with_system_hold_ms(hold_ms);
        shared.system_ref_on.store(true, Ordering::SeqCst);
        core.step(0);
        // White-ish noise far end (an LCG), its echo 20 ms later at -6 dB.
        let mut seed = 0x1234_5678u32;
        let x: Vec<f32> = (0..16_000 * 10)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.2
            })
            .collect();
        let echo_at = |n: usize| if n >= 320 { 0.5 * x[n - 320] } else { 0.0 };
        let (step, sys_late) = (80usize, 960usize); // 5 ms passes; the tap 60 ms behind play time
        let mut mic_sent = Vec::new();
        for k in 1..=(x.len() / step) {
            let end = k * step;
            let m: Vec<f32> = (end - step..end).map(echo_at).collect();
            mic.acquire().unwrap().push_slice(&m);
            mic_sent.extend_from_slice(&m);
            if read_aloud {
                tts.acquire().unwrap().push_slice(&[0.0; 80]);
            }
            if end > sys_late {
                let s_end = end - sys_late;
                let s_start = s_end.saturating_sub(step);
                sys.acquire().unwrap().push_slice(&x[s_start..s_end]);
            }
            core.step(5 * k as u64);
        }
        let out = std::mem::take(&mut *sink.0.lock().unwrap());
        let tail = 16_000 * 3; // the last 3 s of what came out
        let out_t = &out[out.len() - tail..];
        let mic_t = &mic_sent[out.len() - tail..out.len()];
        let p = |v: &[f32]| v.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / v.len() as f64;
        10.0 * (p(mic_t) / p(out_t).max(1e-12)).log10()
    }
    for read_aloud in [false, true] {
        let held = erle_db(system_ref::DEFAULT_HOLD_MS, read_aloud);
        let unheld = erle_db(0, read_aloud);
        eprintln!("system-only far end, 40 ms late, read-aloud {read_aloud}: held {held:.1} dB, unheld {unheld:.1} dB");
        assert!(held > 15.0, "read-aloud {read_aloud}: held {held:.1} dB");
        assert!(held > unheld + 10.0, "read-aloud {read_aloud}: held {held:.1} dB vs unheld {unheld:.1} dB");
    }
}

#[test]
fn mixed_with_read_aloud_a_sidecar_gap_and_burst_leave_no_system_backlog() {
    let mut r = Rig::new(Opts::default());
    r.system_tap(true);
    r.step(5);
    let pass = |r: &mut Rig, system: usize| {
        r.reference(0.0, 160);
        r.system(0.01, 160 * system);
        r.mic(0.0, 160);
        r.step(10);
    };
    for _ in 0..30 {
        pass(&mut r, 1);
    }
    let steady = r.core.system_waiting();
    assert!(steady <= MIXED_SYSTEM_BACKLOG, "steady: {steady}");
    // A 200 ms delivery gap, then the sidecar catches up in one burst.
    for _ in 0..20 {
        pass(&mut r, 0);
    }
    pass(&mut r, 21);
    assert!(r.core.system_waiting() <= MIXED_SYSTEM_BACKLOG, "the burst is trimmed at once: {}", r.core.system_waiting());
    for _ in 0..5 {
        pass(&mut r, 1);
    }
    assert_eq!(r.core.system_waiting(), steady, "back to steady state");
    r.calls();
    // Steady again: one read-aloud frame, carrying one system frame, per mic frame.
    pass(&mut r, 1);
    assert_eq!(r.calls(), vec![R(0.01), C(0.0)]);
}

#[test]
fn a_stalled_system_tap_drops_the_hold_until_its_frames_flow_again() {
    let mut r = Rig::new(Opts { reference: false, ..Default::default() });
    r.system_tap(true);
    r.step(5);
    for _ in 0..60 {
        r.system(0.0, 160);
        r.mic(0.1, 160);
        r.step(10);
    }
    assert_eq!(r.core.hold_ms(), system_ref::DEFAULT_HOLD_MS);
    assert!(!r.shared.system_stalled.load(Ordering::SeqCst));
    assert_eq!(r.shared.hold_ms.load(Ordering::SeqCst), system_ref::DEFAULT_HOLD_MS);
    // The sidecar dies: no system frames.
    for _ in 0..52 {
        r.mic(0.1, 160);
        r.step(10);
    }
    assert_eq!(r.core.hold_ms(), 0, "nothing to wait for");
    assert!(r.shared.system_stalled.load(Ordering::SeqCst), "the session is told (it restarts the tap)");
    assert_eq!(r.shared.hold_ms.load(Ordering::SeqCst), 0);
    r.sunk();
    r.mic(0.1, 160);
    r.step(10);
    assert_eq!(r.sunk().len(), 160, "processed in the pass it arrived in");
    // A restarted tap delivers again: the hold comes back.
    r.system(0.0, 160);
    r.mic(0.1, 160);
    r.step(10);
    assert_eq!(r.core.hold_ms(), system_ref::DEFAULT_HOLD_MS);
    assert!(!r.shared.system_stalled.load(Ordering::SeqCst));
}

#[test]
fn held_audio_from_before_the_agent_was_audible_is_not_a_barge_in() {
    fn overlap(talk_ms: usize) -> usize {
        let mut r = Rig::new(Opts::default());
        *r.converged.borrow_mut() = true;
        r.shared.barge_armed.store(true, Ordering::SeqCst);
        r.system_tap(true);
        r.step(5);
        r.mic(0.0, 1_024);
        r.reference(0.0, 1_024);
        r.system(0.0, 1_024);
        r.step(10);
        // The user talks; the agent becomes audible 300 ms in.
        for i in 0..talk_ms / 10 {
            if i == 30 {
                r.speech.audible.store(true, Ordering::SeqCst);
            }
            r.mic(0.4, 160);
            r.reference(0.0, 160);
            r.system(0.0, 160);
            r.step(10);
        }
        for _ in 0..30 {
            r.mic(0.0, 160);
            r.reference(0.0, 160);
            r.system(0.0, 160);
            r.step(10);
        }
        r.speech.cancels.load(Ordering::SeqCst)
    }
    // 250 ms over the agent (one VAD frame more at most): under barge-in's
    // 320 ms. Held 100 ms, the frames processed once it was audible include
    // 100 ms said before it started (350 ms): they must not count.
    assert_eq!(overlap(550), 0, "250 ms of overlap is no barge-in");
    // 500 ms over it is.
    assert_eq!(overlap(800), 1);
}

#[test]
fn speech_in_the_last_100_ms_before_a_stop_reaches_local_stt_before_the_finalize() {
    let mut r = Rig::new(Opts { reference: false, ..Default::default() });
    // No tap: nothing is held, so a finalize waits for nothing.
    r.step(5);
    assert_eq!(request_flush(&r.shared), None);
    r.system_tap(true);
    r.step(5);
    // The last word: 60 ms of speech right before the stop, all of it still
    // held when the finalize is asked for.
    r.system(0.0, 960);
    r.mic(0.8, 960);
    r.step(5);
    r.step(30);
    assert!(r.sunk().is_empty(), "held");
    let req = request_flush(&r.shared).expect("frames are held: wait for the flush");
    assert!(!flushed(&r.shared, req));
    assert!(r.step(5), "the next pass processes every held frame");
    assert!(flushed(&r.shared, req), "and only then says so");
    assert_eq!(r.sunk(), vec![0.4; 960], "every sample, cleaned, in order, in local-stt's queue");
    assert_eq!(r.core.clock(), 960);
    assert_eq!(r.core.hold_ms(), system_ref::DEFAULT_HOLD_MS, "a flush leaves the hold for what comes next");
    // What arrives after is held as before, and keeps its order.
    r.mic(0.2, 160);
    r.step(5);
    assert!(r.sunk().is_empty());
    r.step(100);
    assert_eq!(r.sunk(), vec![0.1; 160]);
}

#[test]
fn a_mic_switch_processes_the_old_streams_held_frames_instead_of_dropping_them() {
    let mut r = Rig::new(Opts { reference: false, ..Default::default() });
    r.system_tap(true);
    r.step(5);
    r.system(0.0, 320);
    r.mic(0.4, 320); // held when the switch comes
    r.step(5);
    r.step(20);
    assert!(r.calls().is_empty());
    r.mic.begin_stream(16_000);
    r.step(5);
    let calls = r.calls();
    // The old stream's frames on the old canceller state (the system audio
    // that had arrived going in first), then the reset.
    assert_eq!(calls, vec![R(0.0), R(0.0), C(0.4), C(0.4), Reset]);
    assert_eq!(r.sunk(), vec![0.2; 320], "nothing of the old stream lost");
    assert_eq!(r.events().iter().filter(|e| **e == DspEvent::MicReplaced).count(), 1);
    // The new stream's frames are held as usual.
    r.mic(0.6, 160);
    r.step(5);
    assert!(r.calls().is_empty());
    r.step(100);
    assert_eq!(r.calls().last(), Some(&C(0.6)));
}
