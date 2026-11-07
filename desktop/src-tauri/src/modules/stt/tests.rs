//! The local-stt session against an in-process fake sidecar (duplex pipes
//! speaking protocol v1): webview routing for meetings, Rust-channel routing
//! for voice, and finalize/ack matching. No process, no audio device.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tokio::io::{duplex, DuplexStream};

use super::*;
use crate::modules::protocol::{read_frame, write_frame};

// ---- sink ----------------------------------------------------------------------

fn sink(capacity: usize) -> (SttSink, mpsc::Receiver<Input>) {
    let (tx, rx) = mpsc::channel(capacity);
    let sink = SttSink {
        tx,
        shared: Arc::new(Shared::new()),
        owed: [AtomicU64::new(0), AtomicU64::new(0)],
    };
    (sink, rx)
}

fn samples_of(input: &Input) -> usize {
    match input {
        Input::Audio(Frame::Audio { samples, .. }) => samples.len(),
        _ => 0,
    }
}

#[test]
fn dropped_audio_is_repaid_as_silence_so_the_clock_never_drifts() {
    let (sink, mut rx) = sink(2);
    sink.push(STREAM_MIC, &[0.5; 100]);
    sink.push(STREAM_MIC, &[0.5; 100]);
    sink.push(STREAM_MIC, &[0.5; 100]); // queue full → owed
    sink.push(STREAM_SYSTEM, &[0.5; 40]); // other stream owes independently
    assert_eq!(sink.owed[0].load(Ordering::Relaxed), 100);
    assert_eq!(sink.owed[1].load(Ordering::Relaxed), 40);
    assert_eq!(sink.shared.dropped.load(Ordering::Relaxed), 2);

    // Drain, then the next push repays the debt before its own audio.
    let mut total = 0;
    while let Ok(f) = rx.try_recv() {
        total += samples_of(&f);
    }
    assert_eq!(total, 200);
    sink.push(STREAM_MIC, &[0.5; 100]);
    let silence = rx.try_recv().unwrap();
    assert!(
        matches!(&silence, Input::Audio(Frame::Audio { samples, .. }) if samples.len() == 100 && samples.iter().all(|&x| x == 0.0))
    );
    assert_eq!(samples_of(&rx.try_recv().unwrap()), 100);
    assert_eq!(sink.owed[0].load(Ordering::Relaxed), 0);
}

#[test]
fn failed_or_closed_session_ignores_audio() {
    let (sink, mut rx) = sink(8);
    sink.shared.failed.store(true, Ordering::SeqCst);
    sink.push(STREAM_MIC, &[0.5; 10]);
    assert!(rx.try_recv().is_err());

    let (sink, mut rx) = self::sink(8);
    sink.close();
    sink.push(STREAM_MIC, &[0.5; 10]);
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn close_wakes_a_waiting_task_once() {
    let (sink, _rx) = sink(8);
    let shared = sink.shared.clone();
    let waiter = tokio::spawn(async move { shared.stop.notified().await });
    tokio::task::yield_now().await;
    sink.close();
    sink.close(); // idempotent
    tokio::time::timeout(Duration::from_secs(1), waiter).await.unwrap().unwrap();
}

// ---- configure -------------------------------------------------------------------

fn launch() -> LaunchConfig {
    LaunchConfig {
        exe: PathBuf::from("/nonexistent/dial8-local-stt"),
        assets: HashMap::from([
            ("asr".to_string(), PathBuf::from("/m/asr.gguf")),
            ("diarizer".to_string(), PathBuf::from("/m/diar.gguf")),
        ]),
    }
}

#[test]
fn voice_configure_has_one_mic_stream_and_no_diarizer() {
    let v = voice_configure(&launch());
    assert_eq!(v["streams"], json!([{ "id": 0, "name": "mic" }]));
    assert_eq!(v["assets"], json!({ "asr": "/m/asr.gguf" }));
    assert_eq!(v["endpointing"], true);
    assert_eq!(v["rnntRightContext"], RNNT_RIGHT_CONTEXT);
}

#[test]
fn meeting_configure_is_unchanged() {
    let v = configure(&launch());
    assert_eq!(v["streams"], json!([{ "id": 0, "name": "mic" }, { "id": 1, "name": "system" }]));
    assert_eq!(v["assets"]["diarizer"], "/m/diar.gguf");
    assert_eq!(v["assets"]["asr"], "/m/asr.gguf");
    assert_eq!(v["endpointing"], true);
}

// ---- parsing ---------------------------------------------------------------------

#[test]
fn parses_results_speech_started_and_utterance_end() {
    let results = json!({
        "type": "Results", "channel_index": [0, 1], "is_final": true, "speech_final": true,
        "from_finalize": true, "start": 1.2, "duration": 0.9,
        "channel": { "alternatives": [{ "transcript": "Hello there.", "words": [
            { "word": "Hello", "punctuated_word": "Hello", "start": 1.2, "end": 1.5, "confidence": 0.9 },
            { "word": "there.", "punctuated_word": "there.", "start": 1.6, "end": 2.1, "confidence": 0.8, "speaker": 0 }
        ]}]}
    });
    let Some(VoiceSttEvent::Results(r)) = parse_message(&results) else { panic!("not Results") };
    assert!(r.is_final && r.speech_final && r.from_finalize);
    assert_eq!(r.transcript, "Hello there.");
    assert_eq!((r.start, r.duration), (1.2, 0.9));
    assert_eq!(r.words.len(), 2);
    assert_eq!(r.words[1], SttWord { word: "there.".into(), start: 1.6, end: 2.1, confidence: 0.8 });

    // Interims carry no from_finalize / speech_final.
    let interim = json!({ "type": "Results", "is_final": false,
        "channel": { "alternatives": [{ "transcript": "hel", "words": [] }] } });
    let Some(VoiceSttEvent::Results(r)) = parse_message(&interim) else { panic!() };
    assert!(!r.is_final && !r.from_finalize && r.words.is_empty());

    assert_eq!(
        parse_message(&json!({ "type": "SpeechStarted", "channel": [0, 1], "timestamp": 3.5 })),
        Some(VoiceSttEvent::SpeechStarted { timestamp: 3.5 })
    );
    assert_eq!(
        parse_message(&json!({ "type": "UtteranceEnd", "last_word_end": 7.25 })),
        Some(VoiceSttEvent::UtteranceEnd { last_word_end: 7.25 })
    );
    assert_eq!(parse_message(&json!({ "type": "Metadata" })), None);
    assert_eq!(parse_message(&json!({ "no": "type" })), None);
}

// ---- fake sidecar ------------------------------------------------------------------

async fn send(w: &mut DuplexStream, v: Value) {
    write_frame(w, &Frame::Json(v)).await.unwrap();
}

fn results(text: &str, start: f64, is_final: bool, from_finalize: bool) -> Value {
    let mut m = json!({
        "type": "Results", "is_final": is_final, "speech_final": is_final,
        "start": start, "duration": 0.3,
        "channel": { "alternatives": [{ "transcript": text, "words": [
            { "word": text, "punctuated_word": text, "start": start, "end": start + 0.3, "confidence": 0.9 }
        ]}]}
    });
    if from_finalize {
        m["from_finalize"] = json!(true);
    }
    m
}

fn transcript(stream: &str, message: Value) -> Value {
    json!({ "type": "transcript", "stream": stream, "message": message })
}

/// How the fake answers a `finalize`.
#[derive(Clone, Copy, PartialEq)]
enum OnFinalize {
    /// A final covering all audio so far, then the ack.
    Ack,
    /// Never answers.
    Ignore,
    /// Acks the first finalize after 300 ms, later ones at once.
    LateFirst,
    /// A non-fatal error naming the request.
    Refuse,
    /// Exits.
    Crash,
}

/// A fake local-stt sidecar. Records every JSON message it receives (with
/// the audio sample count received before it), answers `finalize` per
/// `on_finalize`, flushes one final on `finish`, and exits on stdin EOF.
fn fake(
    on_finalize: OnFinalize,
    received: Arc<Mutex<Vec<(Value, usize)>>>,
) -> Link {
    let (host_read, side_write) = duplex(1 << 20);
    let (side_read, host_write) = duplex(1 << 20);
    tokio::spawn(async move {
        let (mut r, mut w) = (side_read, side_write);
        send(&mut w, json!({"type":"hello","module":"local-stt","protocol":1,"version":"fake"})).await;
        let Ok(Some(Frame::Json(cfg))) = read_frame(&mut r).await else { return };
        received.lock().unwrap().push((cfg, 0));
        send(&mut w, json!({"type":"ready"})).await;
        let mut samples = 0usize;
        let mut sent_words = 0usize;
        while let Ok(Some(frame)) = read_frame(&mut r).await {
            match frame {
                Frame::Audio { samples: s, .. } => {
                    samples += s.len();
                    // One interim per 0.1 s of audio, on the audio clock.
                    if samples / 1600 > sent_words {
                        sent_words = samples / 1600;
                        let t = samples as f64 / 16_000.0;
                        send(&mut w, transcript("mic", results("hmm", t, false, false))).await;
                    }
                }
                Frame::Json(v) => {
                    received.lock().unwrap().push((v.clone(), samples));
                    match v["type"].as_str() {
                        Some("finalize") => match on_finalize {
                            OnFinalize::Ack => {
                                let t = samples as f64 / 16_000.0;
                                send(&mut w, transcript("mic", results("done", t, true, true))).await;
                                send(&mut w, json!({"type":"finalized","stream":v["stream"],"seq":v["seq"]})).await;
                            }
                            OnFinalize::Ignore => {}
                            OnFinalize::LateFirst => {
                                if v["seq"] == 1 {
                                    tokio::time::sleep(Duration::from_millis(300)).await;
                                }
                                send(&mut w, json!({"type":"finalized","stream":v["stream"],"seq":v["seq"]})).await;
                            }
                            OnFinalize::Refuse => {
                                send(&mut w, json!({"type":"error","message":"finalize: no stream named \"x\"",
                                    "fatal":false,"request":"finalize","stream":"x","seq":v["seq"]})).await;
                            }
                            OnFinalize::Crash => return,
                        },
                        Some("finish") => {
                            send(&mut w, transcript("system", results("tail", 9.0, true, false))).await;
                        }
                        _ => {}
                    }
                }
            }
        }
    });
    Link::over("test".into(), host_read, host_write)
}

/// A voice session driving `link`, as `start_voice` wires it.
fn voice(link: Link) -> (Arc<SttSink>, VoiceSttHandle) {
    let (events_tx, events) = mpsc::unbounded_channel();
    let parts = Parts::new(Box::new(ChannelOutput { events: events_tx }), voice_configure(&launch()));
    let handle = VoiceSttHandle { control: parts.control, events };
    tokio::spawn(parts.session.drive(link, None, parts.input));
    (parts.sink, handle)
}

async fn next_event(handle: &mut VoiceSttHandle) -> VoiceSttEvent {
    tokio::time::timeout(Duration::from_secs(2), handle.events.recv())
        .await
        .expect("event in time")
        .expect("channel open")
}

/// Events up to and including the first one matching `until`.
async fn events_until(handle: &mut VoiceSttHandle, until: impl Fn(&VoiceSttEvent) -> bool) -> Vec<VoiceSttEvent> {
    let mut out = Vec::new();
    loop {
        let e = next_event(handle).await;
        let done = until(&e);
        out.push(e);
        if done {
            return out;
        }
    }
}

// ---- webview routing (meeting capture, unchanged) -------------------------------------

#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Vec<(String, Value)>>>);

impl EventEmitter for Recorder {
    fn emit_json(&self, event: &str, payload: Value) {
        self.0.lock().unwrap().push((event.to_string(), payload));
    }
}

fn meeting(link: Link, recorder: Recorder) -> Arc<SttSink> {
    let output = WebviewOutput { emitter: recorder, session: "rec-1".into() };
    let parts = Parts::new(Box::new(output), configure(&launch()));
    tokio::spawn(parts.session.drive(link, None, parts.input));
    parts.sink
}

async fn wait_for(recorder: &Recorder, event: &str) {
    for _ in 0..200 {
        if recorder.0.lock().unwrap().iter().any(|(e, _)| e == event) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no {event}");
}

#[tokio::test]
async fn meeting_session_emits_stt_events_to_the_webview() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let recorder = Recorder::default();
    let sink = meeting(fake(OnFinalize::Ack, received.clone()), recorder.clone());
    sink.push(STREAM_MIC, &[0.1; 1600]);
    sink.push(STREAM_SYSTEM, &[0.1; 1600]);
    tokio::time::sleep(Duration::from_millis(100)).await;
    sink.close();
    wait_for(&recorder, "stt://finished").await;

    let events = recorder.0.lock().unwrap().clone();
    let names: Vec<&str> = events.iter().map(|(e, _)| e.as_str()).collect();
    assert_eq!(names.last(), Some(&"stt://finished"));
    assert!(names[..names.len() - 1].iter().all(|n| *n == "stt://message"), "{names:?}");
    let (_, first) = &events[0];
    assert_eq!(first["session"], "rec-1");
    assert_eq!(first["stream"], "mic");
    assert_eq!(first["message"]["type"], "Results", "the message is relayed verbatim");
    let (_, tail) = &events[events.len() - 2];
    assert_eq!(tail["stream"], "system");
    assert_eq!(tail["message"]["channel"]["alternatives"][0]["transcript"], "tail");
    assert_eq!(events.last().unwrap().1, json!({ "session": "rec-1" }));

    // The sidecar was configured for two streams with the diarizer.
    let got = received.lock().unwrap();
    assert_eq!(got[0].0["type"], "configure");
    assert_eq!(got[0].0["streams"].as_array().unwrap().len(), 2);
    assert!(got[0].0["assets"]["diarizer"].is_string());
    assert!(got.iter().any(|(v, _)| v["type"] == "finish"));
}

#[tokio::test]
async fn meeting_engine_death_falls_back_to_deepgram() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let recorder = Recorder::default();
    let link = fake(OnFinalize::Crash, received);
    let output = WebviewOutput { emitter: recorder.clone(), session: "rec-2".into() };
    let parts = Parts::new(Box::new(output), configure(&launch()));
    let control = parts.control.clone();
    tokio::spawn(parts.session.drive(link, None, parts.input));
    // Crash the fake through the one path that makes it exit.
    let _ = control.finalize_within(1, Duration::from_millis(500)).await;
    wait_for(&recorder, "stt://engine-changed").await;
    let events = recorder.0.lock().unwrap().clone();
    let (_, changed) = events.iter().find(|(e, _)| e == "stt://engine-changed").unwrap();
    assert_eq!(changed["session"], "rec-2");
    assert_eq!(changed["engine"], "deepgram");
    assert!(changed["reason"].as_str().unwrap().contains("stopped unexpectedly"));
    assert!(!events.iter().any(|(e, _)| e == "stt://finished"));
    assert!(parts.sink.shared.failed.load(Ordering::SeqCst), "audio is no longer wanted");
}

// ---- voice routing + finalize --------------------------------------------------------

#[tokio::test]
async fn voice_events_go_to_the_channel_not_the_webview() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let (sink, mut handle) = voice(fake(OnFinalize::Ack, received.clone()));
    assert_eq!(next_event(&mut handle).await, VoiceSttEvent::Ready);
    sink.push(STREAM_MIC, &[0.1; 1600]);
    let VoiceSttEvent::Results(r) = next_event(&mut handle).await else { panic!("expected Results") };
    assert!(!r.is_final);
    assert_eq!(r.words[0].word, "hmm");
    assert!((r.words[0].start - 0.1).abs() < 1e-9);

    let cfg = received.lock().unwrap()[0].0.clone();
    assert_eq!(cfg["streams"], json!([{ "id": 0, "name": "mic" }]));
    assert!(cfg["assets"].get("diarizer").is_none(), "no diarizer asset for voice");

    handle.close();
    let rest = events_until(&mut handle, |e| *e == VoiceSttEvent::Finished).await;
    assert!(
        rest.iter().any(|e| matches!(e, VoiceSttEvent::Results(r) if r.transcript == "tail")),
        "the tail flushed on close is delivered before Finished: {rest:?}"
    );
}

#[tokio::test]
async fn finalize_is_ordered_after_pushed_audio_and_acked_after_its_final() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let (sink, mut handle) = voice(fake(OnFinalize::Ack, received.clone()));
    // Push before the engine is ready: the audio queues, and so does the
    // finalize, behind it.
    for _ in 0..10 {
        sink.push(STREAM_MIC, &[0.1; 800]);
    }
    handle.finalize(7).await.expect("acked");

    // The fake saw all 8000 samples before the finalize.
    let got = received.lock().unwrap().clone();
    let (fin, before) = got.iter().find(|(v, _)| v["type"] == "finalize").unwrap();
    assert_eq!(*before, 8000);
    assert_eq!(fin["stream"], "mic");
    assert_eq!(fin["seq"], 7);

    // When finalize resolves, its final and the ack are already queued, in
    // that order, after Ready and the interims.
    let mut queued = Vec::new();
    while let Ok(e) = handle.events.try_recv() {
        queued.push(e);
    }
    assert_eq!(queued.first(), Some(&VoiceSttEvent::Ready));
    assert_eq!(queued.last(), Some(&VoiceSttEvent::Finalized { seq: 7 }));
    let VoiceSttEvent::Results(fin) = &queued[queued.len() - 2] else { panic!("{queued:?}") };
    assert!(fin.is_final && fin.from_finalize);
    assert!((fin.words[0].start - 0.5).abs() < 1e-9, "covers all 0.5 s pushed");
}

#[tokio::test]
async fn a_finalize_queued_while_the_engine_loads_is_reported_sent_after_ready() {
    // Chat voice's ack deadline starts when the finalize reaches the engine,
    // not when it was asked for: while the engine loads it waits in the queue
    // behind the audio.
    let received = Arc::new(Mutex::new(Vec::new()));
    let (sink, mut handle) = voice(fake(OnFinalize::Ack, received));
    sink.push(STREAM_MIC, &[0.1; 1600]);
    let control = handle.control.clone();
    let ack = tokio::spawn(async move { control.finalize(3).await });
    let events = events_until(&mut handle, |e| *e == VoiceSttEvent::Finalized { seq: 3 }).await;
    assert_eq!(ack.await.unwrap(), Ok(()));
    let at = |want: &VoiceSttEvent| events.iter().position(|e| e == want).unwrap_or_else(|| panic!("{events:?}"));
    let (ready, sent, acked) =
        (at(&VoiceSttEvent::Ready), at(&VoiceSttEvent::FinalizeSent { seq: 3 }), at(&VoiceSttEvent::Finalized { seq: 3 }));
    assert!(ready < sent && sent < acked, "{events:?}");
}

#[tokio::test]
async fn several_finalizes_resolve_by_seq() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let (sink, handle) = voice(fake(OnFinalize::Ack, received));
    sink.push(STREAM_MIC, &[0.1; 1600]);
    let control = handle.control.clone();
    let (a, b, c) = tokio::join!(control.finalize(1), control.finalize(2), handle.finalize(3));
    assert_eq!((a, b, c), (Ok(()), Ok(()), Ok(())));
}

#[tokio::test]
async fn an_unanswered_finalize_times_out_and_the_session_carries_on() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let (_sink, mut handle) = voice(fake(OnFinalize::Ignore, received.clone()));
    assert_eq!(next_event(&mut handle).await, VoiceSttEvent::Ready);
    let err = handle.control.finalize_within(4, Duration::from_millis(100)).await.unwrap_err();
    assert_eq!(err, FinalizeError::Timeout);
    // The session is still healthy: audio flows, events arrive.
    _sink.push(STREAM_MIC, &[0.1; 1600]);
    let events = events_until(&mut handle, |e| matches!(e, VoiceSttEvent::Results(_))).await;
    assert!(events.iter().all(|e| matches!(e, VoiceSttEvent::FinalizeSent { seq: 4 } | VoiceSttEvent::Results(_))), "{events:?}");
}

#[tokio::test]
async fn a_late_ack_after_a_timeout_does_not_resolve_the_next_finalize() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let (_sink, mut handle) = voice(fake(OnFinalize::LateFirst, received));
    assert_eq!(next_event(&mut handle).await, VoiceSttEvent::Ready);
    assert_eq!(
        handle.control.finalize_within(1, Duration::from_millis(50)).await,
        Err(FinalizeError::Timeout)
    );
    // The fake answers seq 1 late, then seq 2: seq 2 resolves on its own ack.
    assert_eq!(handle.finalize(2).await, Ok(()));
    let events = events_until(&mut handle, |e| *e == VoiceSttEvent::Finalized { seq: 2 }).await;
    let acks: Vec<_> = events.into_iter().filter(|e| !matches!(e, VoiceSttEvent::FinalizeSent { .. })).collect();
    assert_eq!(
        acks,
        vec![VoiceSttEvent::Finalized { seq: 1 }, VoiceSttEvent::Finalized { seq: 2 }],
        "the late ack is still delivered as a boundary marker"
    );
}

#[tokio::test]
async fn a_refused_finalize_is_rejected_with_the_engine_message() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let (_sink, handle) = voice(fake(OnFinalize::Refuse, received));
    let err = handle.finalize(9).await.unwrap_err();
    assert_eq!(err, FinalizeError::Rejected("finalize: no stream named \"x\"".into()));
}

#[tokio::test]
async fn engine_death_fails_pending_finalizes_and_reports_failed() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let (sink, mut handle) = voice(fake(OnFinalize::Crash, received));
    assert_eq!(next_event(&mut handle).await, VoiceSttEvent::Ready);
    let err = handle.control.finalize_within(5, Duration::from_secs(2)).await.unwrap_err();
    assert_eq!(err, FinalizeError::Closed);
    let events = events_until(&mut handle, |e| matches!(e, VoiceSttEvent::Failed { .. })).await;
    let VoiceSttEvent::Failed { reason } = events.last().unwrap() else { unreachable!() };
    assert!(reason.contains("stopped unexpectedly"));
    // Afterwards: audio is ignored and finalize fails fast.
    assert!(sink.shared.failed.load(Ordering::SeqCst));
    assert_eq!(handle.finalize(6).await, Err(FinalizeError::Closed));
}

#[tokio::test]
async fn dropping_the_handle_ends_the_session() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let (sink, mut handle) = voice(fake(OnFinalize::Ack, received.clone()));
    assert_eq!(next_event(&mut handle).await, VoiceSttEvent::Ready);
    drop(handle);
    assert!(sink.shared.closed.load(Ordering::SeqCst));
    for _ in 0..200 {
        if received.lock().unwrap().iter().any(|(v, _)| v["type"] == "finish") {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the sidecar never got finish");
}

#[tokio::test]
async fn closed_before_ready_finishes_without_loading() {
    // A fake that says hello and then never answers configure.
    let (host_read, side_write) = duplex(1 << 16);
    let (side_read, host_write) = duplex(1 << 16);
    tokio::spawn(async move {
        let (mut r, mut w) = (side_read, side_write);
        send(&mut w, json!({"type":"hello","module":"local-stt","protocol":1})).await;
        while let Ok(Some(_)) = read_frame(&mut r).await {}
    });
    let (_sink, mut handle) = voice(Link::over("test".into(), host_read, host_write));
    handle.close();
    assert_eq!(next_event(&mut handle).await, VoiceSttEvent::Finished);
}
