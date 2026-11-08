//! Input Device Priority: which microphone Native Intelligence opens.
//!
//! The user keeps an ordered list of every input device Native Intelligence has seen
//! (Settings → Recording → Microphone). The highest one that is connected
//! wins; while the list is not customised, Native Intelligence uses the system default
//! input exactly as before (the resolver answers `None`).
//!
//! Pieces:
//! - [`enumerate`]: the CoreAudio input devices right now (UID, model UID,
//!   transport, alive, input streams, default input), through the
//!   `output_route` FFI helpers;
//! - [`StoredInputs`] (store key `input_devices`) with the pure rules:
//!   [`merge_seen`], [`set_priority`], [`forget`], [`pick`],
//!   [`build_snapshot`], [`should_switch`];
//! - [`resolve`]: the one resolver every mic start calls, BEFORE taking any
//!   AppState lock (it reads the plugin store, which has its own mutex);
//! - the "for now" override ([`set_override`], command `set_input_override`):
//!   one mic the user picked to use right now WITHOUT reordering the list.
//!   In memory only (never saved); it beats the order and the system default
//!   ([`pick_with_override`]) until it is cleared, its mic leaves the list,
//!   or Native Intelligence quits;
//! - the supervisor thread ([`start_supervisor`]): a CoreAudio listener on
//!   the device list and the default input feeds it; it debounces 300 ms,
//!   re-enumerates, merges into the store, emits [`EVENT`], flags a fault
//!   when the in-use device disappears, clears an override whose mic left,
//!   and switches a live capture (a meeting capture or a voice session) to a
//!   newly available higher-priority mic (2 s settle, at most once per 10 s)
//!   or, on an explicit override pick, at once ([`should_switch_explicit`]);
//!   a voice session also leaves, at once, a mic the lid just made
//!   unavailable ([`must_leave`]);
//! - the lid ([`super::lid`]): while it is closed the MacBook's built-in mic
//!   delivers exact zeros, so it is passed over everywhere the passed-over
//!   mics are ([`lid_unavailable`], [`pick_available`]); the snapshot says
//!   why (`unavailableReason`);
//! - digital silence ([`SilenceWatch`]): a live stream that hasn't delivered
//!   one non-zero sample in the [`SILENT_AFTER`] since it opened raises
//!   [`SILENT_EVENT`] once (and once more when sound comes). Never a reason
//!   to switch: a hardware-muted headset sends zeros too.
//!
//! Identity is the CoreAudio device UID. cpal 0.15 can only open a device
//! by name, so an [`InputTarget`] carries the name, plus the AudioObjectID
//! when two present inputs share that name ([`cpal_object_id`] reads it
//! from cpal's pinned `Debug` output).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use super::lid;

/// Emitted (payload: [`Snapshot`]) whenever the list, the order, the
/// default, the active pick, the in-use device or a device's availability
/// (the lid) changes.
pub const EVENT: &str = "audio://input-devices-changed";
/// Emitted (payload: [`SilencePayload`]) when the live mic starts and stops
/// delivering only exact zeros ([`SilenceWatch`]).
pub const SILENT_EVENT: &str = "audio://input-silent";
/// A live stream whose samples have all been exactly 0.0 for this long since
/// it opened is digitally silent. A live ADC never reads exactly zero (2904
/// logged mic RMS samples on a MacBook: the lowest 0.000305); a lid-closed
/// MacBook mic, a hardware-muted headset or a mic the system denied deliver
/// nothing else. (Zeros after a sound don't count: a noise gate makes them.)
pub const SILENT_AFTER: Duration = Duration::from_millis(3000);
/// Only a stream whose callbacks arrived this recently is judged (no frames
/// at all is the stall watchdogs' business).
const SILENCE_FRAMES_WITHIN: Duration = Duration::from_millis(1000);
/// How often the supervisor looks at a live stream's samples.
const SILENCE_POLL: Duration = Duration::from_millis(500);

/// How long a CoreAudio device-list burst must stay quiet before re-reading
/// (plugging one device fires several notifications).
const DEBOUNCE: Duration = Duration::from_millis(300);
/// A new higher-priority pick must hold this long before a live capture
/// switches to it (lets a Bluetooth headset settle into its HFP profile).
pub const SWITCH_SETTLE: Duration = Duration::from_secs(2);
/// At most one live switch per this long.
pub const SWITCH_MIN_GAP: Duration = Duration::from_secs(10);
/// `lastSeenAt` is only rewritten when older than this, to spare the disk.
const LAST_SEEN_REFRESH_SECS: i64 = 3600;
/// A mic that faults again within this long of being reopened after a
/// fault is passed over (see [`Suspects`]); one that ran this long counts
/// as healthy, and its next fault is a first fault again.
pub const SUSPECT_WINDOW: Duration = Duration::from_secs(60);
/// How long a passed-over mic stays passed over for NEW starts once no
/// capture (a meeting capture or a voice session) is running (while one runs
/// it stays passed over, so a live capture is never switched back onto a mic
/// that went silent in it).
/// Its own reconnect or a priority edit clears it sooner.
pub const SUSPECT_EXCLUDE_FOR: Duration = Duration::from_secs(10 * 60);

// ── model ────────────────────────────────────────────────────────────────

/// What kind of connection an input device has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Transport {
    BuiltIn,
    Bluetooth,
    Usb,
    Virtual,
    Aggregate,
    /// An iPhone mic through Continuity.
    Continuity,
    Display,
    #[default]
    Other,
}

/// CoreAudio `kAudioDeviceTransportType*` to [`Transport`].
pub fn classify_transport(code: u32) -> Transport {
    use super::output_route::transport::*;
    const fn cc(s: &[u8; 4]) -> u32 {
        ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | s[3] as u32
    }
    const CONTINUITY: u32 = cc(b"ccap");
    const CONTINUITY_WIRED: u32 = cc(b"ccwd");
    const CONTINUITY_WIRELESS: u32 = cc(b"ccwl");
    match code {
        BUILT_IN => Transport::BuiltIn,
        BLUETOOTH | BLUETOOTH_LE => Transport::Bluetooth,
        USB => Transport::Usb,
        VIRTUAL => Transport::Virtual,
        AGGREGATE => Transport::Aggregate,
        CONTINUITY | CONTINUITY_WIRED | CONTINUITY_WIRELESS => Transport::Continuity,
        HDMI | DISPLAY_PORT => Transport::Display,
        _ => Transport::Other,
    }
}

/// Our own capture aggregates are private (never enumerated), and macOS's
/// auto-made default aggregate is plumbing: neither is a mic to rank.
pub(crate) fn is_plumbing(uid: &str, name: &str) -> bool {
    name.starts_with("Dial8 ") || uid.starts_with("CADefaultDeviceAggregate") || name.starts_with("CADefaultDeviceAggregate")
}

/// One input device present right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveInput {
    pub uid: String,
    pub name: String,
    pub model_uid: String,
    pub transport: Transport,
    /// CoreAudio AudioObjectID (stable while the device stays connected).
    pub object_id: u32,
    pub is_default: bool,
}

/// One device in the saved list (store key `input_devices`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDevice {
    pub uid: String,
    #[serde(default)]
    pub model_uid: String,
    pub name: String,
    #[serde(default)]
    pub transport: Transport,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

/// The saved list. `devices` order is the priority order; it only means
/// anything when `customised`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredInputs {
    #[serde(default)]
    pub customised: bool,
    #[serde(default)]
    pub devices: Vec<StoredDevice>,
}

/// The device a mic start should open (None anywhere = the system default).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputTarget {
    pub uid: String,
    /// The cpal open key.
    pub name: String,
    /// Set only when another present input has the same name, to tell them
    /// apart when opening (see [`cpal_object_id`]).
    pub object_id: Option<u32>,
}

/// The device a MicCapture stream is open on. `uid` is None when it could
/// not be read (a default-device stream whose AudioObjectID cpal didn't
/// reveal).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InUse {
    pub uid: Option<String>,
    pub name: String,
}

/// A lock-free-ish view of what MicCapture has open, readable without the
/// mic lock. `device` is an internal leaf mutex (like MicCapture's
/// `wav_writer_tx`): never held while taking another lock.
#[derive(Clone, Default)]
pub struct InUseHandle {
    pub(crate) device: Arc<Mutex<Option<InUse>>>,
    pub(crate) recording: Arc<AtomicBool>,
    pub(crate) to_file: Arc<AtomicBool>,
    pub(crate) sound: SoundHandle,
}

impl InUseHandle {
    /// The device a stream is capturing on right now (a meeting capture or
    /// a voice session); None while idle (the paused persistent stream
    /// doesn't count).
    pub fn live(&self) -> Option<InUse> {
        if !self.recording.load(Ordering::SeqCst) {
            return None;
        }
        self.device.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// A meeting capture (a WAV-writing start) is live.
    pub fn meeting_capture(&self) -> bool {
        self.recording.load(Ordering::SeqCst) && self.to_file.load(Ordering::SeqCst)
    }

    /// A capture of either kind is live: what keeps a passed-over mic
    /// passed over ([`Suspects::prune`]), so a running capture is never
    /// switched back onto a mic that went silent in it.
    pub fn capture_live(&self) -> bool {
        self.recording.load(Ordering::SeqCst)
    }

    /// A voice session (a WAV-less start) is live.
    pub fn voice_session(&self) -> bool {
        self.recording.load(Ordering::SeqCst) && !self.to_file.load(Ordering::SeqCst)
    }
}

/// What MicCapture's capture callback stamps, readable without the mic
/// lock: when the current stream last delivered a callback, when it first
/// delivered a non-zero sample, and when it was opened or (re)started (which
/// clears the first). All in `clock.elapsed()` ms + 1, 0 = never
/// (`mic_capture::frame_age`).
#[derive(Clone)]
pub struct SoundHandle {
    pub(crate) clock: Instant,
    pub(crate) last_frame_ms: Arc<AtomicU64>,
    pub(crate) last_sound_ms: Arc<AtomicU64>,
    pub(crate) stream_opened_ms: Arc<AtomicU64>,
}

impl Default for SoundHandle {
    fn default() -> Self {
        Self { clock: Instant::now(), last_frame_ms: Arc::default(), last_sound_ms: Arc::default(), stream_opened_ms: Arc::default() }
    }
}

/// One look at the live stream's samples ([`SoundHandle::read`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SoundView {
    /// Since its last callback (None: none yet).
    pub frame_age: Option<Duration>,
    /// It has delivered a non-zero sample since it was opened or started.
    pub heard: bool,
    /// Since it was opened or started.
    pub open_for: Option<Duration>,
}

impl SoundHandle {
    pub fn read(&self) -> SoundView {
        use super::mic_capture::frame_age;
        SoundView {
            frame_age: frame_age(self.clock, self.last_frame_ms.load(Ordering::Relaxed)),
            heard: self.last_sound_ms.load(Ordering::Relaxed) != 0,
            open_for: frame_age(self.clock, self.stream_opened_ms.load(Ordering::Relaxed)),
        }
    }
}

/// [`SILENT_EVENT`]'s payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SilencePayload {
    /// The mic's CoreAudio UID (null when the stream didn't record it).
    pub device_id: Option<String>,
    pub name: String,
    pub silent: bool,
}

/// Digital silence on the live mic, judged from [`SoundHandle::read`]: a
/// stream that, delivering callbacks, has not produced a single non-zero
/// sample in the [`SILENT_AFTER`] since it was opened or started (a
/// lid-closed MacBook mic, a dead or muted-from-the-start one) is flagged
/// (one `silent: true`); the flag goes, with one `silent: false` for the same
/// device, when a non-zero sample arrives, the device in use changes, or the
/// capture ends. A stream that has made a sound is never flagged again: some
/// USB mics with a noise gate, speakerphones and virtual devices send exact
/// zeros between utterances. Only ever reported: a hardware-muted headset
/// sends zeros too, and switching away would unmute the user.
#[derive(Debug, Default)]
pub struct SilenceWatch {
    flagged: Option<InUse>,
}

impl SilenceWatch {
    /// One look: `in_use` is the live stream's device (None: no capture),
    /// `sound` its [`SoundHandle::read`]. Returns the payload to emit on a
    /// change.
    pub fn update(&mut self, in_use: Option<&InUse>, sound: SoundView) -> Option<SilencePayload> {
        let payload = |d: &InUse, silent| SilencePayload { device_id: d.uid.clone(), name: d.name.clone(), silent };
        if let Some(flagged) = &self.flagged {
            if in_use != Some(flagged) || sound.heard {
                let out = payload(flagged, false);
                self.flagged = None;
                return Some(out);
            }
            return None;
        }
        let in_use = in_use?;
        let frames = sound.frame_age.is_some_and(|a| a < SILENCE_FRAMES_WITHIN);
        if frames && !sound.heard && sound.open_for.is_some_and(|a| a >= SILENT_AFTER) {
            self.flagged = Some(in_use.clone());
            return Some(payload(in_use, true));
        }
        None
    }
}

// ── the pure rules ───────────────────────────────────────────────────────

/// RFC 3339, UTC, milliseconds: sorts as text.
pub fn stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn older_than(stamp: &str, now: DateTime<Utc>, secs: i64) -> bool {
    match DateTime::parse_from_rfc3339(stamp) {
        Ok(t) => (now - t.with_timezone(&Utc)).num_seconds() > secs,
        Err(_) => true,
    }
}

/// Record the present devices in the saved list. Returns whether anything
/// changed (a name, a first sighting, an adopted UID, or a `lastSeenAt`
/// more than an hour old), so the caller writes only then.
///
/// Matching, per present device:
/// 1. the exact UID;
/// 2. else the same model UID and name as an entry that is not present
///    (a USB device moved to another port gets a new UID): adopt the new UID
///    in place, keeping its position;
/// 3. else the exact name of an entry that is not present, likewise;
/// 4. else append it (a new device never jumps the queue).
///
/// Entries that are not present are never pruned ([`forget`] removes them).
pub fn merge_seen(stored: &mut StoredInputs, live: &[LiveInput], now: DateTime<Utc>) -> bool {
    let now_s = stamp(now);
    let live_uids: HashSet<&str> = live.iter().map(|d| d.uid.as_str()).collect();
    let mut changed = false;
    // Exact matches first, so an adoption below can never take an entry that
    // a present device owns by UID.
    for d in live {
        if let Some(e) = stored.devices.iter_mut().find(|e| e.uid == d.uid) {
            changed |= refresh(e, d, now, &now_s);
        }
    }
    for d in live {
        if stored.devices.iter().any(|e| e.uid == d.uid) {
            continue;
        }
        let absent = |e: &StoredDevice| !live_uids.contains(e.uid.as_str());
        let by_model = stored
            .devices
            .iter()
            .position(|e| absent(e) && !d.model_uid.is_empty() && e.model_uid == d.model_uid && e.name == d.name);
        let by_name = || stored.devices.iter().position(|e| absent(e) && e.name == d.name);
        match by_model.or_else(by_name) {
            Some(i) => {
                let e = &mut stored.devices[i];
                e.uid = d.uid.clone();
                refresh(e, d, now, &now_s);
                e.last_seen_at = now_s.clone();
            }
            None => stored.devices.push(StoredDevice {
                uid: d.uid.clone(),
                model_uid: d.model_uid.clone(),
                name: d.name.clone(),
                transport: d.transport,
                first_seen_at: now_s.clone(),
                last_seen_at: now_s.clone(),
            }),
        }
        changed = true;
    }
    changed
}

fn refresh(e: &mut StoredDevice, d: &LiveInput, now: DateTime<Utc>, now_s: &str) -> bool {
    let mut changed = false;
    if e.name != d.name {
        e.name = d.name.clone();
        changed = true;
    }
    if !d.model_uid.is_empty() && e.model_uid != d.model_uid {
        e.model_uid = d.model_uid.clone();
        changed = true;
    }
    if e.transport != d.transport {
        e.transport = d.transport;
        changed = true;
    }
    if older_than(&e.last_seen_at, now, LAST_SEEN_REFRESH_SECS) {
        e.last_seen_at = now_s.to_string();
        changed = true;
    }
    changed
}

/// Save a new order: `ids` first (unknown ones ignored, duplicates once),
/// then every known device `ids` left out, in its current order, so the
/// saved list stays a full permutation. Marks the list customised.
pub fn set_priority(stored: &mut StoredInputs, ids: &[String]) {
    let mut rest = std::mem::take(&mut stored.devices);
    let mut ordered = Vec::with_capacity(rest.len());
    for id in ids {
        if let Some(i) = rest.iter().position(|e| &e.uid == id) {
            ordered.push(rest.remove(i));
        }
    }
    ordered.extend(rest);
    stored.devices = ordered;
    stored.customised = true;
}

/// Remove a device that is not connected. Unknown ids are a no-op.
pub fn forget(stored: &mut StoredInputs, id: &str, live: &[LiveInput]) -> Result<(), String> {
    if live.iter().any(|d| d.uid == id) {
        return Err("This microphone is connected; only a disconnected one can be forgotten".into());
    }
    stored.devices.retain(|e| e.uid != id);
    Ok(())
}

fn target_for(live: &[LiveInput], d: &LiveInput) -> InputTarget {
    let shared = live.iter().filter(|o| o.name == d.name).count() > 1;
    InputTarget { uid: d.uid.clone(), name: d.name.clone(), object_id: shared.then_some(d.object_id) }
}

/// The resolution rule. Not customised → None: the system default, exactly
/// as before. Customised → the first saved device that is present; None
/// (the system default) when none is.
pub fn pick(customised: bool, order: &[StoredDevice], live: &[LiveInput]) -> Option<InputTarget> {
    pick_excluding(customised, order, live, &[])
}

/// [`pick`], passing over the `exclude`d UIDs (mics that are listed but
/// went silent, see [`Suspects`]): the next present device in the order,
/// then the system default.
pub fn pick_excluding(customised: bool, order: &[StoredDevice], live: &[LiveInput], exclude: &[String]) -> Option<InputTarget> {
    if !customised {
        return None;
    }
    order
        .iter()
        .filter(|e| !exclude.contains(&e.uid))
        .find_map(|e| live.iter().find(|d| d.uid == e.uid))
        .map(|d| target_for(live, d))
}

/// [`pick_excluding`] with the "for now" override first: the override when
/// it is set, present and not passed over (a mic recovery passed over is not
/// re-chosen through the override), else the order (customised), else None
/// (the system default).
pub fn pick_with_override(
    customised: bool,
    order: &[StoredDevice],
    live: &[LiveInput],
    exclude: &[String],
    override_id: Option<&str>,
) -> Option<InputTarget> {
    override_id
        .filter(|id| !exclude.iter().any(|e| e == id))
        .and_then(|id| live.iter().find(|d| d.uid == id))
        .map(|d| target_for(live, d))
        .or_else(|| pick_excluding(customised, order, live, exclude))
}

/// The mics the lid makes unavailable: the built-in one (by UID: a mic on
/// the headphone jack is `Transport::BuiltIn` too) while it is closed.
/// They join the passed-over UIDs everywhere those apply ([`excluded_now`]),
/// so the override on one is skipped (not cleared) until the lid opens.
pub fn lid_unavailable(lid_closed: bool) -> Vec<String> {
    if lid_closed {
        vec![lid::BUILT_IN_MIC_UID.to_string()]
    } else {
        Vec::new()
    }
}

/// No mic can be picked: the system default input is one the lid made
/// unavailable and no other present mic qualifies ([`pick_available`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LidClosed;

/// An input [`pick_available`] may land on by itself: never a virtual or
/// aggregate device (a loopback, a meeting app's driver, an aggregate that
/// may hold the very mic it replaces) nor an iPhone through Continuity
/// (which would light up the phone). Ranking one in a customised order
/// still picks it.
fn auto_pickable(t: Transport) -> bool {
    !matches!(t, Transport::Virtual | Transport::Aggregate | Transport::Continuity)
}

/// [`pick_with_override`], except that the system default (its `None`) is
/// no answer while the default input is one the lid made unavailable
/// (`lid`, a subset of `exclude`): then the first present, not excluded,
/// [`auto_pickable`] mic in the saved order, then any other present one.
/// Err when there is none (the built-in mic is the only one): a voice start
/// refuses, a meeting capture opens the default anyway (`resolve`).
pub fn pick_available(
    customised: bool,
    order: &[StoredDevice],
    live: &[LiveInput],
    exclude: &[String],
    override_id: Option<&str>,
    lid: &[String],
) -> Result<Option<InputTarget>, LidClosed> {
    if let Some(t) = pick_with_override(customised, order, live, exclude, override_id) {
        return Ok(Some(t));
    }
    if !live.iter().find(|d| d.is_default).is_some_and(|d| lid.contains(&d.uid)) {
        return Ok(None);
    }
    let usable = |d: &&LiveInput| !exclude.contains(&d.uid) && !lid.contains(&d.uid) && auto_pickable(d.transport);
    let saved = order.iter().filter_map(|e| live.iter().find(|d| d.uid == e.uid));
    let unsaved = live.iter().filter(|d| !order.iter().any(|e| e.uid == d.uid));
    saved.chain(unsaved).find(usable).map(|d| Some(target_for(live, d))).ok_or(LidClosed)
}

/// A running voice session must leave its mic now: the lid made it
/// unavailable (it hears exact zeros).
pub fn must_leave(in_use_uid: Option<&str>, lid: &[String]) -> bool {
    in_use_uid.is_some_and(|u| lid.iter().any(|l| l == u))
}

/// The present input a pick names, or with no pick (the system default) the
/// default input: the mic the next start opens. The TTS output pairs with it
/// (`audio::speech_output`).
pub fn chosen_live<'a>(pick: Option<&InputTarget>, live: &'a [LiveInput]) -> Option<&'a LiveInput> {
    match pick {
        Some(t) => live.iter().find(|d| d.uid == t.uid),
        None => live.iter().find(|d| d.is_default),
    }
}

/// The input the speech output pairs with (`audio::speech_output`): the mic
/// a stream is capturing on (`in_use_uid`, when it is present; a running
/// voice session keeps its mic whatever the pick says), else the pick as
/// [`chosen_live`] maps it.
pub fn paired_input<'a>(in_use_uid: Option<&str>, pick: Option<&InputTarget>, live: &'a [LiveInput]) -> Option<&'a LiveInput> {
    in_use_uid.and_then(|u| live.iter().find(|d| d.uid == u)).or_else(|| chosen_live(pick, live))
}

/// The UID the order alone would open: its pick, else the system default
/// input's.
fn priority_uid(stored: &StoredInputs, live: &[LiveInput], exclude: &[String]) -> Option<String> {
    pick_excluding(stored.customised, &stored.devices, live, exclude)
        .map(|t| t.uid)
        .or_else(|| live.iter().find(|d| d.is_default).map(|d| d.uid.clone()))
}

/// `set_input_override(id)`'s rule: the override to hold. An unknown or
/// disconnected id is an error; the mic the order would open anyway is the
/// same as clearing (Ok(None)).
pub fn override_for(stored: &StoredInputs, live: &[LiveInput], exclude: &[String], id: &str) -> Result<Option<String>, String> {
    if !live.iter().any(|d| d.uid == id) {
        return Err(if stored.devices.iter().any(|e| e.uid == id) {
            format!("That microphone isn't connected ({id})")
        } else {
            format!("Unknown microphone ({id})")
        });
    }
    Ok((priority_uid(stored, live, exclude).as_deref() != Some(id)).then(|| id.to_string()))
}

/// The supervisor's disconnect rule: clear `slot` when its mic has left the
/// list; returns the cleared UID. An empty list is more likely a failed read
/// than every mic gone at once: it keeps the override.
pub fn clear_override_if_gone(slot: &mut Option<String>, live: &[LiveInput]) -> Option<String> {
    let gone = slot.as_ref().is_some_and(|id| !live.is_empty() && !live.iter().any(|d| &d.uid == id));
    if gone { slot.take() } else { None }
}

/// One connection of a device: its UID plus the AudioObjectID CoreAudio
/// gave it. A device that is unplugged and comes back (or a Bluetooth
/// headset that reconnects) gets a new AudioObjectID, so this changes only
/// when THAT device changes, not on unrelated device-list churn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceIdentity {
    pub uid: String,
    pub object_id: u32,
}

impl DeviceIdentity {
    /// `uid`'s current connection; None when it is not present.
    pub fn of(live: &[LiveInput], uid: &str) -> Option<Self> {
        live.iter().find(|d| d.uid == uid).map(|d| Self { uid: d.uid.clone(), object_id: d.object_id })
    }

    /// Still present on the same connection.
    pub fn unchanged_in(&self, live: &[LiveInput]) -> bool {
        live.iter().any(|d| d.uid == self.uid && d.object_id == self.object_id)
    }
}

/// Mics that faulted while in use but stay listed and alive: a Bluetooth
/// headset switched away keeps its CoreAudio device and raises no cpal
/// error, it just stops sending frames. [`pick`] alone would reopen it on
/// every recovery and every new start. The first fault reopens the same
/// device (that cures the CoreAudio device-release race); a second fault
/// within [`SUSPECT_WINDOW`] of that passes it over.
///
/// An entry is dropped when its device leaves the list or reconnects (a new
/// AudioObjectID), when the priority is edited, or once it has aged out:
/// [`SUSPECT_WINDOW`] for a first fault, [`SUSPECT_EXCLUDE_FOR`] (and no
/// capture running, [`InUseHandle::capture_live`]) for a passed-over one.
#[derive(Debug, Default)]
pub struct Suspects {
    list: Vec<Suspect>,
}

#[derive(Debug, Clone)]
struct Suspect {
    id: DeviceIdentity,
    /// The last fault on it (for a first fault: when it was reopened).
    at: Instant,
    excluded: bool,
}

impl Suspects {
    /// A fault on the in-use `uid`. True when it is now passed over. A
    /// device that is not listed is ignored (the resolver skips it anyway).
    pub fn on_fault(&mut self, uid: &str, live: &[LiveInput], now: Instant) -> bool {
        // Faults are only recovered during a capture: keep passed-over ones.
        self.prune(live, now, true);
        let Some(id) = DeviceIdentity::of(live, uid) else { return false };
        match self.list.iter_mut().find(|s| s.id.uid == uid) {
            Some(s) => {
                // Pruned above if it aged out, so this is a repeat fault
                // within the window (or on an already passed-over device).
                s.at = now;
                s.excluded = true;
                true
            }
            None => {
                self.list.push(Suspect { id, at: now, excluded: false });
                false
            }
        }
    }

    /// Drop entries whose device left or reconnected, or that aged out. A
    /// passed-over entry doesn't age out while `capture_live`.
    pub fn prune(&mut self, live: &[LiveInput], now: Instant, capture_live: bool) {
        self.list.retain(|s| {
            let age = now.saturating_duration_since(s.at);
            s.id.unchanged_in(live)
                && if s.excluded { capture_live || age < SUSPECT_EXCLUDE_FOR } else { age < SUSPECT_WINDOW }
        });
    }

    /// The passed-over UIDs (call [`Suspects::prune`] first).
    pub fn excluded(&self) -> Vec<String> {
        self.list.iter().filter(|s| s.excluded).map(|s| s.id.uid.clone()).collect()
    }

    pub fn clear(&mut self) {
        self.list.clear();
    }

    /// Drop `uid`'s entry (the user just picked it explicitly: worth trying
    /// again).
    pub fn forgive(&mut self, uid: &str) {
        self.list.retain(|s| s.id.uid != uid);
    }
}

static SUSPECTS: Mutex<Suspects> = Mutex::new(Suspects { list: Vec::new() });

/// The shared [`Suspects`]. A leaf lock: nothing else is taken while it is
/// held.
fn suspects() -> std::sync::MutexGuard<'static, Suspects> {
    SUSPECTS.lock().unwrap_or_else(|p| p.into_inner())
}

/// The "for now" override's UID. In memory only (never saved). A leaf lock:
/// nothing else is taken while it is held.
static OVERRIDE: Mutex<Option<String>> = Mutex::new(None);

fn override_slot() -> std::sync::MutexGuard<'static, Option<String>> {
    OVERRIDE.lock().unwrap_or_else(|p| p.into_inner())
}

/// The override as set (connected or not; the pick and the snapshot check).
pub fn current_override() -> Option<String> {
    override_slot().clone()
}

/// The passed-over UIDs right now (pruned against `live`), and the mics the
/// lid makes unavailable as last read ([`lid_now`]).
fn excluded_now(live: &[LiveInput], capture_live: bool) -> Vec<String> {
    let mut out = {
        let mut s = suspects();
        s.prune(live, Instant::now(), capture_live);
        s.excluded()
    };
    for uid in lid_now() {
        if !out.contains(&uid) {
            out.push(uid);
        }
    }
    out
}

/// [`lid_unavailable`] for the lid as last read ([`lid::closed`]).
fn lid_now() -> Vec<String> {
    lid_unavailable(lid::closed())
}

/// What the web gets: `list_input_devices`, the setters, and [`EVENT`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub customised: bool,
    /// The "for now" override, only while it is set AND its mic is connected.
    /// It can name a mic that isn't `active`: one a stream isn't on, or one
    /// recovery passed over (the next start skips it, see [`Suspects`]).
    pub override_id: Option<String>,
    pub devices: Vec<SnapshotDevice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDevice {
    /// The CoreAudio device UID.
    pub id: String,
    pub name: String,
    pub transport: Transport,
    /// Connected right now.
    pub available: bool,
    /// The system default input.
    pub is_default: bool,
    /// The device in use while a stream runs, else the one the next start
    /// would pick (the override when one is set and not passed over). At
    /// most one row.
    pub active: bool,
    /// A stream is capturing on it right now.
    pub live: bool,
    /// Why a connected device won't be picked: `"lid_closed"` for the
    /// MacBook's built-in mic while the lid is closed ([`lid::LID_CLOSED`]).
    /// `available` stays true (false means unplugged). Absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<&'static str>,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

/// The web's view. Order: the saved order when customised; otherwise the
/// system default first, then the other connected devices, then the
/// disconnected ones, each group by first sighting. `exclude`: the
/// passed-over UIDs and the lid's ([`excluded_now`]), which the idle pick
/// skips exactly as the next start's [`resolve`] does; `lid`: the lid's
/// alone ([`lid_unavailable`]), each marked with its reason. `override_id`:
/// the override as set.
pub fn build_snapshot(
    stored: &StoredInputs,
    live: &[LiveInput],
    in_use: Option<&InUse>,
    exclude: &[String],
    override_id: Option<&str>,
    lid: &[String],
) -> Snapshot {
    let override_id = override_id.filter(|id| live.iter().any(|d| d.uid == *id));
    let default_uid = live.iter().find(|d| d.is_default).map(|d| d.uid.as_str());
    let in_use_uid = in_use.and_then(|u| {
        u.uid.clone().or_else(|| live.iter().find(|d| d.name == u.name).map(|d| d.uid.clone()))
    });
    let active_uid: Option<String> = match &in_use_uid {
        Some(uid) => Some(uid.clone()),
        None if in_use.is_some() => None,
        // (Lid closed and nothing else: a meeting capture would still open
        // the default, so it stays the active row, with its reason.)
        None => pick_available(stored.customised, &stored.devices, live, exclude, override_id, lid)
            .unwrap_or(None)
            .map(|t| t.uid)
            .or_else(|| default_uid.map(str::to_string)),
    };
    let mut devices: Vec<SnapshotDevice> = stored
        .devices
        .iter()
        .map(|e| {
            let now = live.iter().find(|d| d.uid == e.uid);
            SnapshotDevice {
                id: e.uid.clone(),
                name: now.map_or_else(|| e.name.clone(), |d| d.name.clone()),
                transport: e.transport,
                available: now.is_some(),
                is_default: Some(e.uid.as_str()) == default_uid,
                active: active_uid.as_deref() == Some(e.uid.as_str()),
                live: in_use_uid.as_deref() == Some(e.uid.as_str()),
                unavailable_reason: lid.contains(&e.uid).then_some(lid::LID_CLOSED),
                first_seen_at: e.first_seen_at.clone(),
                last_seen_at: e.last_seen_at.clone(),
            }
        })
        .collect();
    if !stored.customised {
        let group = |d: &SnapshotDevice| if d.is_default { 0 } else if d.available { 1 } else { 2 };
        devices.sort_by(|a, b| group(a).cmp(&group(b)).then_with(|| a.first_seen_at.cmp(&b.first_seen_at)));
    }
    Snapshot { customised: stored.customised, override_id: override_id.map(str::to_string), devices }
}

/// The supervisor's live-switch decision for a live capture (a meeting
/// capture or a voice session): customised, capturing, the pick differs from the device in use (an unknown in-use
/// device counts as different), the pick has held for [`SWITCH_SETTLE`],
/// and the last switch was at least [`SWITCH_MIN_GAP`] ago.
pub fn should_switch(
    customised: bool,
    recording: bool,
    in_use: Option<&str>,
    pick: Option<&str>,
    stable_for: Duration,
    since_last: Option<Duration>,
) -> bool {
    let Some(pick) = pick else { return false };
    customised
        && recording
        && in_use != Some(pick)
        && stable_for >= SWITCH_SETTLE
        && since_last.is_none_or(|d| d >= SWITCH_MIN_GAP)
}

/// The live-switch decision right after an explicit override pick (set or
/// cleared) during a live capture (a meeting capture or a voice session):
/// switch when `want` (the resolved
/// device's UID, the system default input's when the resolver answers None)
/// differs from the device in use (an unknown in-use device counts as
/// different). A user action: no [`SWITCH_SETTLE`], exempt from
/// [`SWITCH_MIN_GAP`], and tried even on a device an automatic switch failed
/// to open.
pub fn should_switch_explicit(recording: bool, in_use: Option<&str>, want: Option<&str>) -> bool {
    recording && want.is_some() && in_use != want
}

/// The supervisor's automatic switch candidate after a refresh: `pick`
/// while a choice is in effect, a capture runs (`capture_live`: a meeting
/// capture or a voice session), `pick` differs from
/// the device in use and no live switch to it failed on this connection.
/// `in_use_uid` must be resolved with [`uid_in_use`] (as the explicit switch
/// does): a default-device stream whose UID wasn't read is still on a known
/// mic, and treating it as unknown would reopen that same mic. `prev`'s
/// start time is kept while the pick holds.
pub fn next_candidate(
    prev: Option<(InputTarget, Instant)>,
    pick: Option<InputTarget>,
    chosen: bool,
    capture_live: bool,
    in_use_uid: Option<&str>,
    failed_switch: Option<&DeviceIdentity>,
    now: Instant,
) -> Option<(InputTarget, Instant)> {
    let t = pick.filter(|t| {
        chosen
            && capture_live
            && in_use_uid != Some(t.uid.as_str())
            && failed_switch.is_none_or(|f| f.uid != t.uid)
    })?;
    match prev {
        Some((c, since)) if c.uid == t.uid => Some((t, since)),
        _ => Some((t, now)),
    }
}

/// A live switch that opened `opened` (a UID) proves that mic works: drop a
/// failed-switch mark on it, so automatic switching may return to it later.
pub fn clear_failed_on_open(failed: &mut Option<DeviceIdentity>, opened: Option<&str>) {
    if failed.as_ref().is_some_and(|f| Some(f.uid.as_str()) == opened) {
        *failed = None;
    }
}

/// The AudioObjectID in cpal 0.15's `Debug` for a CoreAudio device:
/// `Device { audio_device_id: 73, name: Ok("…") }`. cpal keeps the field
/// `pub(crate)`; this is safe only because cpal is pinned (a test checks).
pub fn parse_audio_device_id(debug: &str) -> Option<u32> {
    let rest = &debug[debug.find("audio_device_id: ")? + "audio_device_id: ".len()..];
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// A cpal device's CoreAudio AudioObjectID.
#[cfg(target_os = "macos")]
pub fn cpal_object_id(device: &cpal::Device) -> Option<u32> {
    #[allow(unreachable_patterns)]
    match device.as_inner() {
        cpal::platform::DeviceInner::CoreAudio(d) => parse_audio_device_id(&format!("{d:?}")),
        _ => None,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn cpal_object_id(_device: &cpal::Device) -> Option<u32> {
    None
}

// ── CoreAudio ────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod ca {
    use super::super::output_route::ffi::*;
    use super::{classify_transport, is_plumbing, LiveInput};

    const fn cc(s: &[u8; 4]) -> u32 {
        ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | s[3] as u32
    }
    pub const DEFAULT_INPUT: u32 = cc(b"dIn ");
    const SCOPE_INPUT: u32 = cc(b"inpt");
    const STREAMS: u32 = cc(b"stm#");
    const IS_ALIVE: u32 = cc(b"livn");
    const IS_HIDDEN: u32 = cc(b"hidn");
    const DEVICE_UID: u32 = cc(b"uid ");
    const MODEL_UID: u32 = cc(b"muid");
    const VOLUME_DECIBELS: u32 = cc(b"vold");

    pub fn uid(object: AudioObjectID) -> Option<String> {
        get_string(object, DEVICE_UID, SCOPE_GLOBAL)
    }

    pub fn enumerate() -> Vec<LiveInput> {
        let default = get_u32(SYSTEM_OBJECT, DEFAULT_INPUT, SCOPE_GLOBAL).unwrap_or(0);
        let mut out = Vec::new();
        for id in all_devices() {
            if property_size(id, STREAMS, SCOPE_INPUT).unwrap_or(0) == 0 {
                continue;
            }
            if get_u32(id, IS_ALIVE, SCOPE_GLOBAL) == Some(0) || get_u32(id, IS_HIDDEN, SCOPE_GLOBAL) == Some(1) {
                continue;
            }
            let Some(uid) = uid(id).filter(|u| !u.is_empty()) else { continue };
            let name = device_name(id).filter(|n| !n.is_empty()).unwrap_or_else(|| uid.clone());
            if is_plumbing(&uid, &name) {
                continue;
            }
            out.push(LiveInput {
                model_uid: get_string(id, MODEL_UID, SCOPE_GLOBAL).unwrap_or_default(),
                transport: classify_transport(get_u32(id, TRANSPORT_TYPE, SCOPE_GLOBAL).unwrap_or(0)),
                is_default: id == default,
                object_id: id,
                uid,
                name,
            });
        }
        out
    }

    /// The device's input volume in dB: the main element's control (a
    /// MacBook mic's), else the first channel's. None without either.
    pub fn input_volume_db(object: AudioObjectID) -> Option<f32> {
        [0, 1].into_iter().find_map(|element| get_f32(object, VOLUME_DECIBELS, SCOPE_INPUT, element)).filter(|db| db.is_finite())
    }

    /// Listens for the device list and the default input changing.
    pub fn watch(on_change: Box<dyn Fn() + Send + Sync>) -> Result<Watcher, String> {
        let mut w = Watcher::new(on_change);
        w.add(SYSTEM_OBJECT, addr(DEVICES, SCOPE_GLOBAL))?;
        w.add(SYSTEM_OBJECT, addr(DEFAULT_INPUT, SCOPE_GLOBAL))?;
        Ok(w)
    }
}

// ── Windows (Core Audio endpoints, through wasapi) ──────────────────────

/// A Windows input's transport, from its name and its adapter's name (no
/// API says it plainly): enough to rank a headset over the laptop's array.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_transport(name: &str, interface: &str) -> Transport {
    let text = format!("{name} {interface}").to_lowercase();
    if text.contains("bluetooth") || text.contains("hands-free") || text.contains("airpods") {
        Transport::Bluetooth
    } else if text.contains("usb") {
        Transport::Usb
    } else if text.contains("virtual") || text.contains("vb-audio") || text.contains("voicemeeter") {
        Transport::Virtual
    } else {
        Transport::Other
    }
}

#[cfg(target_os = "windows")]
mod win {
    use super::{is_plumbing, windows_transport, LiveInput};

    /// Active capture endpoints: the endpoint id is the UID, the friendly
    /// name is cpal's name for it (the open key).
    pub fn enumerate() -> Vec<LiveInput> {
        // MTA on this thread (an STA thread answers RPC_E_CHANGED_MODE, and
        // the endpoint API works from either).
        let _ = wasapi::initialize_mta();
        let Ok(enumerator) = wasapi::DeviceEnumerator::new() else { return Vec::new() };
        let default_id = enumerator.get_default_device(&wasapi::Direction::Capture).ok().and_then(|d| d.get_id().ok());
        let Ok(collection) = enumerator.get_device_collection(&wasapi::Direction::Capture) else { return Vec::new() };
        let mut out = Vec::new();
        for i in 0..collection.get_nbr_devices().unwrap_or(0) {
            let Ok(device) = collection.get_device_at_index(i) else { continue };
            let Ok(uid) = device.get_id() else { continue };
            let name = device.get_friendlyname().ok().filter(|n| !n.is_empty()).unwrap_or_else(|| uid.clone());
            if is_plumbing(&uid, &name) {
                continue;
            }
            let interface = device.get_interface_friendlyname().unwrap_or_default();
            out.push(LiveInput {
                transport: windows_transport(&name, &interface),
                is_default: default_id.as_deref() == Some(uid.as_str()),
                object_id: 0,
                model_uid: String::new(),
                uid,
                name,
            });
        }
        out
    }

    /// Calls `on_change` (on an audio system thread: keep it a send) when an
    /// endpoint comes, goes or changes state, or a default changes. Kept
    /// registered while the value lives.
    pub fn watch(on_change: impl Fn() + Send + Sync + Clone + 'static) -> Result<wasapi::DeviceEventRegistration, String> {
        let _ = wasapi::initialize_mta();
        let enumerator = wasapi::DeviceEnumerator::new().map_err(|e| e.to_string())?;
        let mut callbacks = wasapi::DeviceEventCallbacks::new();
        let f = on_change.clone();
        callbacks.set_device_added_callback(move |_| f());
        let f = on_change.clone();
        callbacks.set_device_removed_callback(move |_| f());
        let f = on_change.clone();
        callbacks.set_device_state_callback(move |_, _| f());
        callbacks.set_default_device_callback(move |_, _, _| on_change());
        enumerator.register_notification_callback(callbacks).map_err(|e| e.to_string())
    }
}

/// The input devices present right now. Blocking property reads (fast; no
/// device IO): CoreAudio on macOS, Core Audio endpoints on Windows. Empty
/// elsewhere.
pub fn enumerate() -> Vec<LiveInput> {
    #[cfg(target_os = "macos")]
    return ca::enumerate();
    #[cfg(target_os = "windows")]
    return win::enumerate();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Vec::new()
}

/// The input volume (dB, the device's own volume control: System Settings →
/// Sound → Input's slider for the default one) of the present input `uid`.
/// None when it isn't present or has no volume control. Blocking CoreAudio
/// property reads (fast; no device IO). None off macOS.
pub fn input_volume_db(uid: &str) -> Option<f32> {
    #[cfg(target_os = "macos")]
    return enumerate().into_iter().find(|d| d.uid == uid).and_then(|d| ca::input_volume_db(d.object_id));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = uid;
        None
    }
}

/// The UID of the device a cpal handle refers to.
pub fn uid_of(device: &cpal::Device) -> Option<String> {
    #[cfg(target_os = "macos")]
    return cpal_object_id(device).and_then(ca::uid);
    // cpal's WASAPI name is the endpoint's friendly name.
    #[cfg(target_os = "windows")]
    {
        use cpal::traits::DeviceTrait;
        let name = device.name().ok()?;
        return win::enumerate().into_iter().find(|d| d.name == name).map(|d| d.uid);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = device;
        None
    }
}

// ── store ────────────────────────────────────────────────────────────────

/// Serialises read-modify-writes of the `input_devices` key (the
/// supervisor's merge vs a command's reorder). A leaf lock: nothing else is
/// taken while it is held except the plugin store's own.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Read, change and (only when changed) write the saved list.
fn update_store<R>(app: &tauri::AppHandle, f: impl FnOnce(&mut StoredInputs) -> R) -> (StoredInputs, R) {
    let _g = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let before = crate::settings::input_devices(app);
    let mut after = before.clone();
    let r = f(&mut after);
    if after != before {
        crate::settings::set_input_devices(app, &after);
    }
    (after, r)
}

/// The one resolver: the device the next mic start should open. Call it
/// BEFORE taking any AppState lock. Not customised, no override and the lid
/// open → None without touching CoreAudio: today's
/// `default_input_device()`, bit for bit. A meeting capture's: when the
/// built-in mic is the only one and the lid is closed it still opens the
/// default (a capture never refuses for want of a mic; the snapshot says
/// why); a voice start uses [`resolve_checked`] and refuses.
pub fn resolve(app: &tauri::AppHandle) -> Option<InputTarget> {
    resolve_checked(app).unwrap_or_else(|LidClosed| {
        crate::log_to_file("[input-devices] the lid is closed and the MacBook microphone is the only one: opening the system default anyway");
        None
    })
}

/// [`resolve`], with [`LidClosed`] when the lid is closed and the built-in
/// mic is the only one (a voice start refuses: `unavailable: lid_closed`).
/// Re-reads the lid first ([`lid::sync`]).
pub fn resolve_checked(app: &tauri::AppHandle) -> Result<Option<InputTarget>, LidClosed> {
    let lid = lid_unavailable(lid::sync());
    let stored = crate::settings::input_devices(app);
    let override_id = current_override();
    if !stored.customised && override_id.is_none() && lid.is_empty() {
        return Ok(None);
    }
    resolve_in(app, &stored, &enumerate(), override_id.as_deref(), &lid)
}

/// [`resolve`] for `recover_mic`, called while a fault is set: records the
/// fault against the device in use first, so a mic that is listed but has
/// gone silent is reopened once and then passed over ([`Suspects`]).
pub fn resolve_for_recovery(app: &tauri::AppHandle) -> Option<InputTarget> {
    resolve_for_recovery_checked(app).unwrap_or_else(|LidClosed| {
        crate::log_to_file("[input-devices] recovery: the lid is closed and the MacBook microphone is the only one: reopening the system default anyway");
        None
    })
}

/// [`resolve_for_recovery`] with [`LidClosed`] (a voice session's own mic
/// recovery ends the session instead).
pub fn resolve_for_recovery_checked(app: &tauri::AppHandle) -> Result<Option<InputTarget>, LidClosed> {
    let lid = lid_unavailable(lid::sync());
    let stored = crate::settings::input_devices(app);
    let override_id = current_override();
    if !stored.customised && override_id.is_none() && lid.is_empty() {
        return Ok(None);
    }
    let live = enumerate();
    if let Some(uid) = in_use_now(app).and_then(|u| u.uid) {
        if suspects().on_fault(&uid, &live, Instant::now()) {
            crate::log_to_file(&format!("[input-devices] {uid} faulted again right after recovering; passing over it"));
        }
    }
    resolve_in(app, &stored, &live, override_id.as_deref(), &lid)
}

/// The lid is closed and the system default input is the built-in mic: a
/// start that fails on its pick must not fall back to the default (it would
/// hear exact zeros). Blocking CoreAudio property reads; call only then.
pub fn default_unavailable() -> bool {
    let lid = lid_unavailable(lid::sync());
    !lid.is_empty() && enumerate().iter().any(|d| d.is_default && lid.contains(&d.uid))
}

/// What the speech output pairs with (`audio::speech_output`), as
/// [`paired_input`]: the mic a stream is capturing on while one is live,
/// else the device the next mic start would open, as [`resolve`] picks it
/// but always as a present device (the system default input when nothing is
/// chosen) and without logging. Blocking CoreAudio property reads; takes no
/// AppState lock (the in-use handle's, the store's and SUSPECTS, all leaves).
pub fn chosen_input(app: &tauri::AppHandle) -> Option<LiveInput> {
    let stored = crate::settings::input_devices(app);
    let override_id = current_override();
    let live = enumerate();
    let in_use_uid = in_use_now(app).and_then(|u| uid_in_use(&u, &live));
    let exclude = excluded_for(app, &live);
    let pick = pick_available(stored.customised, &stored.devices, &live, &exclude, override_id.as_deref(), &lid_now()).unwrap_or(None);
    paired_input(in_use_uid.as_deref(), pick.as_ref(), &live).cloned()
}

fn resolve_in(
    app: &tauri::AppHandle,
    stored: &StoredInputs,
    live: &[LiveInput],
    override_id: Option<&str>,
    lid: &[String],
) -> Result<Option<InputTarget>, LidClosed> {
    let exclude = excluded_for(app, live);
    let target = pick_available(stored.customised, &stored.devices, live, &exclude, override_id, lid);
    crate::log_to_file(&format!(
        "[input-devices] resolved {} (of {} present{}{}{})",
        match &target {
            Ok(Some(t)) => format!("{:?} ({})", t.name, t.uid),
            Ok(None) => "the system default".to_string(),
            Err(LidClosed) => "nothing: the MacBook microphone is the only one and the lid is closed".to_string(),
        },
        live.len(),
        override_id.map_or_else(String::new, |id| format!(", override {id}")),
        if exclude.is_empty() { String::new() } else { format!(", passing over {}", exclude.join(", ")) },
        if lid.is_empty() { "" } else { ", lid closed" }
    ));
    target
}

// ── commands' bodies ─────────────────────────────────────────────────────

fn in_use_handle(app: &tauri::AppHandle) -> Option<InUseHandle> {
    use tauri::Manager;
    app.try_state::<InputDevices>().map(|s| s.in_use.clone())
}

fn in_use_now(app: &tauri::AppHandle) -> Option<InUse> {
    in_use_handle(app).and_then(|h| h.live())
}

/// The UID of the device a stream reports as in use: its own, or for a
/// default-device stream whose AudioObjectID cpal didn't reveal, the present
/// input with that name (the default one among several), or with no name
/// the default input.
pub fn uid_in_use(in_use: &InUse, live: &[LiveInput]) -> Option<String> {
    if let Some(uid) = &in_use.uid {
        return Some(uid.clone());
    }
    if in_use.name.is_empty() {
        return live.iter().find(|d| d.is_default).map(|d| d.uid.clone());
    }
    let named: Vec<&LiveInput> = live.iter().filter(|d| d.name == in_use.name).collect();
    match named.as_slice() {
        [one] => Some(one.uid.clone()),
        many => many.iter().find(|d| d.is_default).map(|d| d.uid.clone()),
    }
}

/// The mic a stream is capturing on right now, as (UID, name), for the
/// voice session's per-device speech level: the in-use handle's, the UID
/// resolved as [`uid_in_use`] does when the stream didn't record one
/// (enumerating only then). None while idle or when it can't be told.
/// Blocking; takes no AppState lock.
pub fn device_in_use(app: &tauri::AppHandle) -> Option<(String, String)> {
    let in_use = in_use_now(app)?;
    let uid = match &in_use.uid {
        Some(uid) => uid.clone(),
        None => uid_in_use(&in_use, &enumerate())?,
    };
    Some((uid, in_use.name))
}

/// [`excluded_now`] for a command or the supervisor: whether a meeting
/// capture is running comes from the in-use handle. Takes SUSPECTS alone
/// (never while holding another lock).
fn excluded_for(app: &tauri::AppHandle, live: &[LiveInput]) -> Vec<String> {
    excluded_now(live, in_use_handle(app).is_some_and(|h| h.capture_live()))
}

/// `list_input_devices`: also records the present devices.
pub fn list(app: &tauri::AppHandle) -> Snapshot {
    let live = enumerate();
    let (stored, _) = update_store(app, |s| merge_seen(s, &live, Utc::now()));
    let exclude = excluded_for(app, &live);
    build_snapshot(&stored, &live, in_use_now(app).as_ref(), &exclude, current_override().as_deref(), &lid_now())
}

/// `set_input_priority`.
pub fn set_order(app: &tauri::AppHandle, ids: &[String]) -> Snapshot {
    let live = enumerate();
    let (stored, _) = update_store(app, |s| {
        merge_seen(s, &live, Utc::now());
        set_priority(s, ids);
    });
    // An edited order is a fresh intent: every mic is worth trying again.
    suspects().clear();
    crate::log_to_file(&format!("[input-devices] priority set ({} devices)", stored.devices.len()));
    poke();
    let exclude = excluded_for(app, &live);
    build_snapshot(&stored, &live, in_use_now(app).as_ref(), &exclude, current_override().as_deref(), &lid_now())
}

/// `reset_input_priority`: back to the system default; the list is kept.
pub fn reset(app: &tauri::AppHandle) -> Snapshot {
    let live = enumerate();
    let (stored, _) = update_store(app, |s| {
        merge_seen(s, &live, Utc::now());
        s.customised = false;
    });
    suspects().clear();
    crate::log_to_file("[input-devices] priority reset to the system default");
    poke();
    let exclude = excluded_for(app, &live);
    build_snapshot(&stored, &live, in_use_now(app).as_ref(), &exclude, current_override().as_deref(), &lid_now())
}

/// `forget_input_device`: only for a disconnected device.
pub fn forget_device(app: &tauri::AppHandle, id: &str) -> Result<Snapshot, String> {
    let live = enumerate();
    let (stored, r) = update_store(app, |s| forget(s, id, &live));
    r?;
    // Its remembered voice speech level goes with it (after the list's lock
    // is released: both are leaf locks).
    crate::voice::levels::forget(app, id);
    // So does the override on it (only reachable if the supervisor hasn't
    // cleared it yet: a forgettable mic is unplugged).
    {
        let mut slot = override_slot();
        if slot.as_deref() == Some(id) {
            *slot = None;
        }
    }
    poke();
    let exclude = excluded_for(app, &live);
    Ok(build_snapshot(&stored, &live, in_use_now(app).as_ref(), &exclude, current_override().as_deref(), &lid_now()))
}

/// `set_input_override`: use `id` for now (None clears it) without touching
/// the saved order. An unknown or disconnected id is an error; the mic the
/// order would open anyway clears it. Never saved. A running capture (a
/// meeting capture or a voice session) switches at once (see
/// [`should_switch_explicit`]).
pub fn set_override(app: &tauri::AppHandle, id: Option<String>) -> Result<Snapshot, String> {
    let live = enumerate();
    let (stored, _) = update_store(app, |s| merge_seen(s, &live, Utc::now()));
    if let Some(id) = &id {
        // An explicit pick is a fresh intent for that mic (the list's lock
        // is released: both are leaf locks).
        suspects().forgive(id);
    }
    // After the forgive: the picked mic is no longer passed over.
    let exclude = excluded_for(app, &live);
    let next = match &id {
        None => None,
        Some(id) => override_for(&stored, &live, &exclude, id)?,
    };
    let prev = std::mem::replace(&mut *override_slot(), next.clone());
    if prev != next {
        crate::log_to_file(&format!(
            "[input-devices] override {}",
            next.as_deref().map_or_else(|| "cleared".to_string(), |n| format!("set to {n}"))
        ));
    }
    if id.is_some() || prev != next {
        explicit_pick();
    } else {
        poke();
    }
    Ok(build_snapshot(&stored, &live, in_use_now(app).as_ref(), &exclude, next.as_deref(), &lid_now()))
}

// ── supervisor ───────────────────────────────────────────────────────────

enum Wake {
    /// CoreAudio: the device list or the default input changed (debounced).
    Devices,
    /// A mic start / stop / switch, a setting change, the lid opening or
    /// closing, a wake: re-evaluate now.
    Poke,
    /// The user set or cleared the override: re-evaluate, then switch a live
    /// capture at once.
    Explicit,
}

static WAKE: OnceLock<Sender<Wake>> = OnceLock::new();

/// Ask the supervisor to re-read everything now (a mic start, stop or
/// switch; a priority change; the lid; a wake). A channel send: fine from a
/// notification callback. No-op before it starts (and in tests).
pub fn poke() {
    if let Some(tx) = WAKE.get() {
        let _ = tx.send(Wake::Poke);
    }
}

/// An explicit override pick: re-read, then switch a live capture now.
/// No-op before the supervisor starts (and in tests).
fn explicit_pick() {
    if let Some(tx) = WAKE.get() {
        let _ = tx.send(Wake::Explicit);
    }
}

/// Managed state: what the commands and `recover_mic` read without the mic
/// lock.
pub struct InputDevices {
    pub in_use: InUseHandle,
}

/// Start the device watcher, the lid watcher and the supervisor thread, and
/// manage [`InputDevices`]. Call once from setup; `in_use` and `fault` come
/// from the MicCapture. Touches no CoreAudio on the calling thread: the
/// watchers are registered on the supervisor's thread, so a stuck coreaudiod
/// (see audio::health) stalls that thread, not setup and the main thread; and
/// only once the launch gate opens (audio::launch_gate).
pub fn start_supervisor(app: &tauri::AppHandle, in_use: InUseHandle, fault: Arc<AtomicBool>) {
    use tauri::Manager;
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = WAKE.set(tx.clone());
    app.manage(InputDevices { in_use: in_use.clone() });
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("input-devices".into()).spawn(move || {
        super::launch_gate::wait();
        // Lives as long as this thread, which is the app's lifetime.
        #[cfg(target_os = "macos")]
        let _watcher = {
            // Runs on a CoreAudio notification thread: a channel send, nothing else.
            match ca::watch(Box::new(move || {
                let _ = tx.send(Wake::Devices);
            })) {
                Ok(w) => Some(w),
                Err(e) => {
                    crate::log_to_file(&format!("[input-devices] device watcher failed: {e}"));
                    None
                }
            }
        };
        #[cfg(target_os = "windows")]
        let _watcher = match win::watch(move || {
            let _ = tx.send(Wake::Devices);
        }) {
            Ok(w) => Some(w),
            Err(e) => {
                crate::log_to_file(&format!("[input-devices] device watcher failed: {e}"));
                None
            }
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        drop(tx);
        // The lid: its notification only pokes; every refresh re-reads it.
        if let Err(e) = lid::watch(poke) {
            crate::log_to_file(&format!("[input-devices] lid watcher failed: {e}"));
        }
        Supervisor::new(in_use, fault).run(&app, rx);
    });
    if let Err(e) = spawned {
        crate::log_to_file(&format!("[input-devices] could not start the supervisor: {e}"));
    }
}

struct Supervisor {
    in_use: InUseHandle,
    fault: Arc<AtomicBool>,
    last: Option<Snapshot>,
    /// A choice is in effect: the list is customised or an override is set
    /// (otherwise the capture just follows the system default).
    chosen: bool,
    /// A higher-priority pick for the live capture, and since when.
    candidate: Option<(InputTarget, Instant)>,
    last_switch: Option<Instant>,
    /// The in-use UID already flagged as gone (flag once per disappearance).
    flagged_gone: Option<String>,
    /// A device a live switch failed to open: not tried again automatically
    /// until THAT device leaves the list or reconnects (a new AudioObjectID).
    /// Other device-list or default-input churn doesn't clear it: each retry
    /// costs the capture a gap that shifts mic.wav against system.wav. An
    /// explicit pick still tries it, and a switch that opens it clears it
    /// ([`clear_failed_on_open`]).
    failed_switch: Option<DeviceIdentity>,
    /// The voice session's mic the lid made unavailable with no other mic to
    /// go to (logged once per mic).
    stranded: Option<String>,
    /// Digital silence on the live mic.
    silence: SilenceWatch,
}

enum SwitchOutcome {
    /// No capture is recording.
    NotRecording,
    /// Not now (the stream isn't the capture's, or a fault is pending:
    /// recovery owns the mic).
    Skipped,
    Done(Result<(), String>),
}

impl Supervisor {
    fn new(in_use: InUseHandle, fault: Arc<AtomicBool>) -> Self {
        Self {
            in_use,
            fault,
            last: None,
            chosen: false,
            candidate: None,
            last_switch: None,
            flagged_gone: None,
            failed_switch: None,
            stranded: None,
            silence: SilenceWatch::default(),
        }
    }

    fn run(mut self, app: &tauri::AppHandle, rx: Receiver<Wake>) {
        self.refresh(app);
        loop {
            // A live stream is looked at every SILENCE_POLL (its samples).
            let wait = if self.candidate.is_some() {
                Duration::from_millis(250)
            } else if self.in_use.live().is_some() {
                SILENCE_POLL
            } else {
                Duration::from_secs(60)
            };
            match rx.recv_timeout(wait) {
                Ok(first) => {
                    let mut devices = matches!(first, Wake::Devices);
                    let mut explicit = matches!(first, Wake::Explicit);
                    while let Ok(w) = rx.try_recv() {
                        devices |= matches!(w, Wake::Devices);
                        explicit |= matches!(w, Wake::Explicit);
                    }
                    if devices {
                        // Debounce: wait for DEBOUNCE of quiet.
                        loop {
                            match rx.recv_timeout(DEBOUNCE) {
                                Ok(w) => explicit |= matches!(w, Wake::Explicit),
                                Err(RecvTimeoutError::Timeout) => break,
                                Err(RecvTimeoutError::Disconnected) => return,
                            }
                        }
                    }
                    self.refresh(app);
                    if explicit {
                        self.switch_now(app);
                    }
                    self.leave_unavailable(app);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            self.maybe_switch(app);
            self.check_silence(app);
        }
    }

    /// Re-read the lid, re-enumerate, merge, clear an override whose mic
    /// left, emit on change, flag a vanished in-use device, and update the
    /// switch candidate.
    fn refresh(&mut self, app: &tauri::AppHandle) {
        use tauri::Emitter;
        let lid = lid_unavailable(lid::sync());
        let live = enumerate();
        let (stored, _) = update_store(app, |s| merge_seen(s, &live, Utc::now()));
        let gone = clear_override_if_gone(&mut override_slot(), &live);
        if let Some(uid) = gone {
            crate::log_to_file(&format!("[input-devices] override mic {uid} disconnected — override cleared"));
        }
        let override_id = current_override();
        let in_use = self.in_use.live();
        // The same exclusions as resolve(): the snapshot's idle pick and the
        // switch candidate never land on a mic recovery just passed over, or
        // on the built-in one with the lid closed.
        let exclude = excluded_now(&live, self.in_use.capture_live());
        let snap = build_snapshot(&stored, &live, in_use.as_ref(), &exclude, override_id.as_deref(), &lid);
        if self.last.as_ref() != Some(&snap) {
            let _ = app.emit(EVENT, &snap);
            self.last = Some(snap);
        }
        self.chosen = stored.customised || override_id.is_some();
        if self.failed_switch.as_ref().is_some_and(|f| !f.unchanged_in(&live)) {
            self.failed_switch = None;
        }

        // The device in use vanished: raise the mic fault now instead of
        // waiting for the stall watchdog (meeting capture recovers onto the
        // next device; so does a voice session, voice/session.rs). An empty
        // list is more likely a failed read than every mic gone at once:
        // leave that to cpal. Resolved as switch_now does (a UID-less stream
        // maps to a present mic, so it is never flagged gone, as before).
        let in_use_uid = in_use.as_ref().and_then(|u| uid_in_use(u, &live));
        match &in_use_uid {
            Some(uid) if !live.is_empty() && !live.iter().any(|d| &d.uid == uid) => {
                if self.flagged_gone.as_deref() != Some(uid.as_str()) {
                    crate::log_to_file(&format!("[input-devices] in-use mic {uid} disappeared — flagging a fault"));
                    self.fault.store(true, Ordering::SeqCst);
                    self.flagged_gone = Some(uid.clone());
                }
            }
            _ => self.flagged_gone = None,
        }

        // (With the lid open exactly pick_with_override; with it closed and
        // the default the built-in mic, the next usable one.)
        let pick = pick_available(stored.customised, &stored.devices, &live, &exclude, override_id.as_deref(), &lid).unwrap_or(None);
        // The speech output pairs with the mic in use while a stream is live
        // (a new pick moves the speech only once the stream has moved), else
        // the chosen mic: a new pick (order, override, plug / unplug) that
        // changes the pairing moves a held TTS output (the voice session
        // listens).
        let paired = paired_input(in_use_uid.as_deref(), pick.as_ref(), &live);
        super::speech_output::note_pairing(&super::speech_output::decide(paired));
        let prev_uid = self.candidate.as_ref().map(|(c, _)| c.uid.clone());
        self.candidate = next_candidate(
            self.candidate.take(),
            pick,
            self.chosen,
            in_use.is_some(),
            in_use_uid.as_deref(),
            self.failed_switch.as_ref(),
            Instant::now(),
        );
        if let Some((t, _)) = &self.candidate {
            if prev_uid.as_deref() != Some(t.uid.as_str()) {
                crate::log_to_file(&format!("[input-devices] {:?} outranks the mic in use; switching once it settles", t.name));
            }
        }
    }

    /// Switch the live capture to `target` (None = the system default): a
    /// meeting capture (the dual stream recording, the mic writing its WAV)
    /// or a voice session (the dual stream idle, the mic running without a
    /// WAV; voice_start refuses during a capture, so the two never overlap).
    /// The voice session follows through its tap: the new stream bumps the
    /// tap's epoch and the DSP thread reports `MicReplaced`. Lock order: dual
    /// stream, then mic (never both held across the switch: like
    /// recover_mic, read the dual stream and let it go).
    fn switch_to(&self, app: &tauri::AppHandle, target: Option<&InputTarget>) -> SwitchOutcome {
        use tauri::Manager;
        let Some(state) = app.try_state::<crate::state::AppState>() else { return SwitchOutcome::Skipped };
        let recording = state.dual_stream.lock().unwrap_or_else(|p| p.into_inner()).is_recording();
        let mut mic = state.mic_capture.lock().unwrap_or_else(|p| p.into_inner());
        let what = if recording {
            if !mic.is_capturing_to_file() || mic.fault_handle().load(Ordering::SeqCst) {
                return SwitchOutcome::Skipped;
            }
            "the live capture"
        } else {
            // (A paused meeting capture is not recording, as before.)
            if !mic.is_recording() || mic.is_capturing_to_file() {
                return SwitchOutcome::NotRecording;
            }
            if mic.fault_handle().load(Ordering::SeqCst) {
                return SwitchOutcome::Skipped;
            }
            "the voice session"
        };
        crate::log_to_file(&format!(
            "[input-devices] switching {what} to {}",
            target.map_or_else(|| "the system default".to_string(), |t| format!("{:?} ({})", t.name, t.uid))
        ));
        let result = mic.switch_device(target);
        drop(mic);
        SwitchOutcome::Done(result)
    }

    fn maybe_switch(&mut self, app: &tauri::AppHandle) {
        let Some((target, since)) = self.candidate.clone() else { return };
        // Resolved as refresh and switch_now do (enumerating only when the
        // stream didn't record its UID).
        let in_use_uid = self.in_use.live().and_then(|u| u.uid.clone().or_else(|| uid_in_use(&u, &enumerate())));
        if !should_switch(
            self.chosen,
            self.in_use.live().is_some(),
            in_use_uid.as_deref(),
            Some(&target.uid),
            since.elapsed(),
            self.last_switch.map(|t| t.elapsed()),
        ) {
            return;
        }
        match self.switch_to(app, Some(&target)) {
            SwitchOutcome::NotRecording => {
                self.candidate = None;
                return;
            }
            SwitchOutcome::Skipped => return,
            SwitchOutcome::Done(Err(e)) => {
                crate::log_to_file(&format!("[input-devices] live switch failed: {e}"));
                // Keyed to this connection of the device (a vanished one: None,
                // so the next refresh clears it, as it may come back working).
                self.failed_switch = DeviceIdentity::of(&enumerate(), &target.uid);
            }
            SwitchOutcome::Done(Ok(())) => clear_failed_on_open(&mut self.failed_switch, Some(&target.uid)),
        }
        self.last_switch = Some(Instant::now());
        self.candidate = None;
        self.refresh(app);
    }

    /// Right after the user set or cleared the override: a live capture
    /// moves to what the resolver picks now, with no settle and exempt from
    /// the 10 s gap ([`should_switch_explicit`]). A failed pick clears the
    /// override (the capture stayed on its mic). With the lid closed and
    /// nothing but the built-in mic, a meeting capture goes to the default
    /// (as `resolve` opens it) and a voice session stays.
    fn switch_now(&mut self, app: &tauri::AppHandle) {
        if self.in_use.live().is_none() {
            return;
        }
        let meeting = self.in_use.meeting_capture();
        let live = enumerate();
        let stored = crate::settings::input_devices(app);
        let override_id = current_override();
        let exclude = excluded_now(&live, true);
        let target = match pick_available(stored.customised, &stored.devices, &live, &exclude, override_id.as_deref(), &lid_now()) {
            Ok(t) => t,
            Err(LidClosed) if meeting => None,
            Err(LidClosed) => return,
        };
        let want = target.as_ref().map(|t| t.uid.clone()).or_else(|| live.iter().find(|d| d.is_default).map(|d| d.uid.clone()));
        let in_use = self.in_use.live().and_then(|u| uid_in_use(&u, &live));
        if !should_switch_explicit(true, in_use.as_deref(), want.as_deref()) {
            return;
        }
        match self.switch_to(app, target.as_ref()) {
            SwitchOutcome::NotRecording | SwitchOutcome::Skipped => return,
            SwitchOutcome::Done(Err(e)) => {
                crate::log_to_file(&format!("[input-devices] explicit switch failed: {e}"));
                if let Some(t) = &target {
                    self.failed_switch = DeviceIdentity::of(&enumerate(), &t.uid);
                    let mut slot = override_slot();
                    if slot.as_deref() == Some(t.uid.as_str()) {
                        *slot = None;
                    }
                }
            }
            // It opened: an earlier failed automatic switch to it no longer
            // blocks automatic moves back to it.
            SwitchOutcome::Done(Ok(())) => clear_failed_on_open(&mut self.failed_switch, want.as_deref()),
        }
        self.last_switch = Some(Instant::now());
        self.candidate = None;
        self.refresh(app);
    }

    /// A running voice session on a mic the lid just made unavailable (it
    /// hears exact zeros): move it at once, no settle and no gap, to what the
    /// next start would open ([`pick_available`]). Not to a mic that refused
    /// a switch on this connection; with no other mic it stays (logged once;
    /// [`SILENT_EVENT`] tells the web). A meeting capture keeps its mic here
    /// (its customised order may still move it, through the candidate).
    fn leave_unavailable(&mut self, app: &tauri::AppHandle) {
        if !self.in_use.voice_session() || !lid::closed() {
            self.stranded = None;
            return;
        }
        let Some(in_use) = self.in_use.live() else { return };
        let live = enumerate();
        let in_use_uid = uid_in_use(&in_use, &live);
        let lid = lid_now();
        if !must_leave(in_use_uid.as_deref(), &lid) {
            self.stranded = None;
            return;
        }
        let stored = crate::settings::input_devices(app);
        let exclude = excluded_now(&live, true);
        let target = match pick_available(stored.customised, &stored.devices, &live, &exclude, current_override().as_deref(), &lid) {
            Ok(t) => t,
            Err(LidClosed) => {
                if self.stranded != in_use_uid {
                    crate::log_to_file(&format!(
                        "[input-devices] the lid closed under the voice session's {:?} and there is no other mic: it stays (hearing nothing)",
                        in_use.name
                    ));
                    self.stranded = in_use_uid;
                }
                return;
            }
        };
        let Some(want) = target.as_ref().map(|t| t.uid.clone()).or_else(|| live.iter().find(|d| d.is_default).map(|d| d.uid.clone())) else {
            return;
        };
        if self.failed_switch.as_ref().is_some_and(|f| f.uid == want) {
            return;
        }
        crate::log_to_file(&format!("[input-devices] the lid closed under the voice session's {:?}: moving it to {want}", in_use.name));
        match self.switch_to(app, target.as_ref()) {
            SwitchOutcome::NotRecording | SwitchOutcome::Skipped => return,
            SwitchOutcome::Done(Err(e)) => {
                crate::log_to_file(&format!("[input-devices] lid switch failed: {e}"));
                self.failed_switch = DeviceIdentity::of(&enumerate(), &want);
            }
            SwitchOutcome::Done(Ok(())) => clear_failed_on_open(&mut self.failed_switch, Some(&want)),
        }
        self.last_switch = Some(Instant::now());
        self.candidate = None;
        self.refresh(app);
    }

    /// Digital silence on the live mic ([`SilenceWatch`]): emit and log each
    /// change. Atomics only, plus the in-use handle's leaf lock.
    fn check_silence(&mut self, app: &tauri::AppHandle) {
        use tauri::Emitter;
        let in_use = self.in_use.live();
        if let Some(p) = self.silence.update(in_use.as_ref(), self.in_use.sound.read()) {
            crate::log_to_file(&format!(
                "[input-devices] {:?} ({}): {}",
                p.name,
                p.device_id.as_deref().unwrap_or("uid unknown"),
                if p.silent {
                    "only exact zeros for 3 s since it opened: digital silence, nothing reaches Native Intelligence"
                } else {
                    "silence over (sound at last, or the capture moved on)"
                }
            ));
            let _ = app.emit(SILENT_EVENT, &p);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_inputs_are_ranked_by_their_names() {
        use super::{windows_transport, Transport};
        assert_eq!(windows_transport("Headset (WH-1000XM4 Hands-Free AG Audio)", ""), Transport::Bluetooth);
        assert_eq!(windows_transport("Microphone (Yeti Stereo Microphone)", "USB Audio Device"), Transport::Usb);
        assert_eq!(windows_transport("CABLE Output (VB-Audio Virtual Cable)", ""), Transport::Virtual);
        assert_eq!(windows_transport("Microphone Array (Realtek(R) Audio)", "Realtek(R) Audio"), Transport::Other);
    }

    use super::*;
    use chrono::TimeZone;

    fn t(h: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 26, h, 0, 0).unwrap()
    }

    fn live(uid: &str, name: &str, model: &str, id: u32) -> LiveInput {
        LiveInput {
            uid: uid.into(),
            name: name.into(),
            model_uid: model.into(),
            transport: Transport::Usb,
            object_id: id,
            is_default: false,
        }
    }

    fn stored(uid: &str, name: &str, model: &str) -> StoredDevice {
        StoredDevice {
            uid: uid.into(),
            model_uid: model.into(),
            name: name.into(),
            transport: Transport::Usb,
            first_seen_at: stamp(t(1)),
            last_seen_at: stamp(t(1)),
        }
    }

    fn uids(s: &StoredInputs) -> Vec<&str> {
        s.devices.iter().map(|d| d.uid.as_str()).collect()
    }

    // ── the in-use UID (voice's per-device speech level) ──

    #[test]
    fn the_in_use_uid_is_the_streams_or_the_present_device_by_name() {
        let mut dflt = live("B", "Built-in", "", 2);
        dflt.is_default = true;
        let l = vec![live("A", "AirPods", "", 1), dflt.clone(), live("U", "BRIO", "", 3)];
        let used = |uid: Option<&str>, name: &str| InUse { uid: uid.map(Into::into), name: name.into() };
        assert_eq!(uid_in_use(&used(Some("A"), "AirPods"), &l).as_deref(), Some("A"));
        // A default stream that didn't record its UID: by name...
        assert_eq!(uid_in_use(&used(None, "BRIO"), &l).as_deref(), Some("U"));
        // ...the default among two of that name, else none...
        let twins = vec![live("U1", "BRIO", "", 3), live("U2", "BRIO", "", 4)];
        assert_eq!(uid_in_use(&used(None, "BRIO"), &twins), None);
        let mut d2 = live("U2", "BRIO", "", 4);
        d2.is_default = true;
        assert_eq!(uid_in_use(&used(None, "BRIO"), &[live("U1", "BRIO", "", 3), d2]).as_deref(), Some("U2"));
        // ...a name that's gone: none; no name: the default input.
        assert_eq!(uid_in_use(&used(None, "Gone"), &l), None);
        assert_eq!(uid_in_use(&used(None, ""), &l).as_deref(), Some("B"));
    }

    // ── pick ──

    #[test]
    fn not_customised_picks_the_system_default() {
        let order = vec![stored("A", "AirPods", ""), stored("B", "Built-in", "")];
        let l = vec![live("A", "AirPods", "", 1), live("B", "Built-in", "", 2)];
        assert_eq!(pick(false, &order, &l), None);
    }

    #[test]
    fn customised_picks_the_first_present_device() {
        let order = vec![stored("A", "AirPods", ""), stored("U", "BRIO", ""), stored("B", "Built-in", "")];
        let l = vec![live("B", "Built-in", "", 2), live("U", "BRIO", "", 3)];
        assert_eq!(pick(true, &order, &l), Some(InputTarget { uid: "U".into(), name: "BRIO".into(), object_id: None }));
        let l = vec![live("B", "Built-in", "", 2), live("A", "AirPods", "", 1), live("U", "BRIO", "", 3)];
        assert_eq!(pick(true, &order, &l).unwrap().uid, "A");
    }

    #[test]
    fn customised_with_nothing_present_is_the_system_default() {
        let order = vec![stored("A", "AirPods", "")];
        assert_eq!(pick(true, &order, &[live("X", "Other", "", 9)]), None);
        assert_eq!(pick(true, &[], &[live("X", "Other", "", 9)]), None);
        assert_eq!(pick(true, &order, &[]), None);
    }

    #[test]
    fn an_always_present_virtual_device_wins_when_ranked_first() {
        let mut v = live("V", "Loopback Audio", "", 5);
        v.transport = Transport::Virtual;
        let order = vec![stored("V", "Loopback Audio", ""), stored("B", "Built-in", "")];
        assert_eq!(pick(true, &order, &[live("B", "Built-in", "", 2), v]).unwrap().uid, "V");
    }

    #[test]
    fn a_shared_name_carries_the_object_id() {
        let order = vec![stored("U2", "USB Audio Device", "")];
        let l = vec![live("U1", "USB Audio Device", "", 11), live("U2", "USB Audio Device", "", 12)];
        assert_eq!(pick(true, &order, &l).unwrap().object_id, Some(12));
    }

    // ── merge_seen ──

    #[test]
    fn first_sight_appends_and_repeat_sight_writes_nothing() {
        let mut s = StoredInputs::default();
        let l = vec![live("B", "Built-in", "m", 2), live("A", "AirPods", "", 1)];
        assert!(merge_seen(&mut s, &l, t(1)));
        assert_eq!(uids(&s), ["B", "A"]);
        assert_eq!(s.devices[0].first_seen_at, "2026-09-26T01:00:00.000Z");
        // Same devices 30 min later: nothing to write.
        assert!(!merge_seen(&mut s, &l, t(1) + chrono::Duration::minutes(30)));
        // Two hours later: lastSeenAt refreshes.
        assert!(merge_seen(&mut s, &l, t(3)));
        assert_eq!(s.devices[0].last_seen_at, stamp(t(3)));
        assert_eq!(s.devices[0].first_seen_at, stamp(t(1)));
        // A new device goes to the end, even when customised.
        s.customised = true;
        assert!(merge_seen(&mut s, &[live("N", "New Mic", "", 7)], t(3)));
        assert_eq!(uids(&s), ["B", "A", "N"]);
    }

    #[test]
    fn a_moved_usb_device_keeps_its_place_by_model_and_name() {
        let mut s = StoredInputs {
            customised: true,
            devices: vec![stored("brio-port1", "BRIO", "046d:085e"), stored("B", "Built-in", "")],
        };
        assert!(merge_seen(&mut s, &[live("brio-port2", "BRIO", "046d:085e", 4), live("B", "Built-in", "", 2)], t(2)));
        assert_eq!(uids(&s), ["brio-port2", "B"]);
    }

    #[test]
    fn name_only_adoption_needs_an_absent_entry() {
        let mut s = StoredInputs { customised: true, devices: vec![stored("old", "Yeti", "")] };
        merge_seen(&mut s, &[live("new", "Yeti", "", 4)], t(2));
        assert_eq!(uids(&s), ["new"]);
    }

    #[test]
    fn duplicate_names_do_not_steal_a_present_entry() {
        let mut s = StoredInputs { customised: true, devices: vec![stored("U1", "USB Audio Device", "m")] };
        let l = vec![live("U1", "USB Audio Device", "m", 11), live("U2", "USB Audio Device", "m", 12)];
        assert!(merge_seen(&mut s, &l, t(2)));
        assert_eq!(uids(&s), ["U1", "U2"]);
        // Order in the enumeration doesn't matter.
        let mut s = StoredInputs { customised: true, devices: vec![stored("U1", "USB Audio Device", "m")] };
        merge_seen(&mut s, &[l[1].clone(), l[0].clone()], t(2));
        assert_eq!(uids(&s), ["U1", "U2"]);
    }

    #[test]
    fn a_rename_updates_the_name_only() {
        let mut s = StoredInputs { customised: true, devices: vec![stored("A", "AirPods Pro", ""), stored("B", "Built-in", "")] };
        assert!(merge_seen(&mut s, &[live("A", "Liam's AirPods Pro", "", 1)], t(1)));
        assert_eq!(uids(&s), ["A", "B"]);
        assert_eq!(s.devices[0].name, "Liam's AirPods Pro");
        assert_eq!(s.devices[0].first_seen_at, stamp(t(1)));
    }

    // ── set_priority / forget ──

    #[test]
    fn set_priority_keeps_a_full_permutation() {
        let mut s = StoredInputs {
            customised: false,
            devices: vec![stored("A", "a", ""), stored("B", "b", ""), stored("C", "c", ""), stored("D", "d", "")],
        };
        set_priority(&mut s, &["C".into(), "ghost".into(), "A".into(), "C".into()]);
        assert!(s.customised);
        assert_eq!(uids(&s), ["C", "A", "B", "D"]);
        set_priority(&mut s, &[]);
        assert_eq!(uids(&s), ["C", "A", "B", "D"]);
    }

    #[test]
    fn forget_only_disconnected_devices() {
        let mut s = StoredInputs { customised: true, devices: vec![stored("A", "a", ""), stored("B", "b", "")] };
        assert!(forget(&mut s, "A", &[live("A", "a", "", 1)]).is_err());
        assert_eq!(uids(&s), ["A", "B"]);
        assert!(forget(&mut s, "B", &[live("A", "a", "", 1)]).is_ok());
        assert_eq!(uids(&s), ["A"]);
        assert!(forget(&mut s, "nope", &[]).is_ok());
    }

    // ── transport ──

    #[test]
    fn classifies_input_transports() {
        use crate::audio::output_route::transport::*;
        let cc = |s: &[u8; 4]| u32::from_be_bytes(*s);
        assert_eq!(classify_transport(BUILT_IN), Transport::BuiltIn);
        assert_eq!(classify_transport(BLUETOOTH), Transport::Bluetooth);
        assert_eq!(classify_transport(BLUETOOTH_LE), Transport::Bluetooth);
        assert_eq!(classify_transport(USB), Transport::Usb);
        assert_eq!(classify_transport(VIRTUAL), Transport::Virtual);
        assert_eq!(classify_transport(AGGREGATE), Transport::Aggregate);
        assert_eq!(classify_transport(cc(b"ccwl")), Transport::Continuity);
        assert_eq!(classify_transport(cc(b"ccwd")), Transport::Continuity);
        assert_eq!(classify_transport(HDMI), Transport::Display);
        assert_eq!(classify_transport(DISPLAY_PORT), Transport::Display);
        assert_eq!(classify_transport(cc(b"thun")), Transport::Other);
        assert_eq!(classify_transport(0), Transport::Other);
        assert!(is_plumbing("CADefaultDeviceAggregate-1234-0", "CADefaultDeviceAggregate-1234-0"));
        assert!(is_plumbing("x", "Dial8 System Audio"));
        assert!(!is_plumbing("BuiltInMicrophoneDevice", "MacBook Pro Microphone"));
    }

    // ── snapshot ──

    #[test]
    fn snapshot_shape_is_camel_case() {
        let s = StoredInputs { customised: true, devices: vec![stored("A", "AirPods", "")] };
        let mut a = live("A", "AirPods", "", 1);
        a.transport = Transport::Bluetooth;
        a.is_default = true;
        let v = serde_json::to_value(build_snapshot(&s, &[a], None, &[], None, &[])).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"customised": true, "overrideId": null, "devices": [{
                "id": "A", "name": "AirPods", "transport": "usb", "available": true, "isDefault": true,
                "active": true, "live": false,
                "firstSeenAt": "2026-09-26T01:00:00.000Z", "lastSeenAt": "2026-09-26T01:00:00.000Z"
            }]})
        );
        assert_eq!(serde_json::to_value(Transport::BuiltIn).unwrap(), "builtIn");
        // The lid closed: the built-in mic stays available, with its reason.
        let s = StoredInputs { customised: false, devices: vec![stored(BUILT_IN, "MacBook Pro Microphone", "")] };
        let mut b = live(BUILT_IN, "MacBook Pro Microphone", "", 2);
        b.is_default = true;
        let lid = lid_unavailable(true);
        let v = serde_json::to_value(build_snapshot(&s, &[b], None, &lid, None, &lid)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"customised": false, "overrideId": null, "devices": [{
                "id": BUILT_IN, "name": "MacBook Pro Microphone", "transport": "usb", "available": true, "isDefault": true,
                "active": true, "live": false, "unavailableReason": "lid_closed",
                "firstSeenAt": "2026-09-26T01:00:00.000Z", "lastSeenAt": "2026-09-26T01:00:00.000Z"
            }]})
        );
    }

    // ── the lid ──

    const BUILT_IN: &str = lid::BUILT_IN_MIC_UID;

    fn earpods() -> LiveInput {
        let mut e = live("AppleUSBAudioEngine:EarPods", "EarPods", "", 7);
        e.transport = Transport::BuiltIn;
        e
    }

    #[test]
    fn the_lid_excludes_the_built_in_mic_by_uid_only() {
        assert!(lid_unavailable(false).is_empty());
        assert_eq!(lid_unavailable(true), [BUILT_IN]);
        // A mic on the headphone jack is built-in by transport, not by UID.
        assert!(!lid_unavailable(true).contains(&earpods().uid));
        assert!(must_leave(Some(BUILT_IN), &lid_unavailable(true)));
        assert!(!must_leave(Some(BUILT_IN), &lid_unavailable(false)));
        assert!(!must_leave(Some("AppleUSBAudioEngine:EarPods"), &lid_unavailable(true)));
        assert!(!must_leave(None, &lid_unavailable(true)));
    }

    #[test]
    fn with_the_lid_closed_the_default_built_in_mic_gives_way_to_another() {
        let mut b = live(BUILT_IN, "MacBook Pro Microphone", "", 2);
        b.is_default = true;
        let l = vec![b.clone(), earpods()];
        let order = vec![stored(BUILT_IN, "MacBook Pro Microphone", ""), stored("AppleUSBAudioEngine:EarPods", "EarPods", "")];
        let lid = lid_unavailable(true);
        let pa = |customised, exclude: &[String], ov: Option<&str>, lid: &[String], l: &[LiveInput]| {
            pick_available(customised, &order, l, exclude, ov, lid).map(|t| t.map(|t| t.uid))
        };
        // Lid open: exactly pick_with_override (None: the system default).
        assert_eq!(pa(false, &[], None, &[], &l), Ok(None));
        assert_eq!(pa(true, &[], None, &[], &l), Ok(Some(BUILT_IN.to_string())));
        // Lid closed, not customised: the default is the dead mic, so the EarPods.
        assert_eq!(pa(false, &lid, None, &lid, &l), Ok(Some(earpods().uid)));
        // Customised with the built-in first: the next in the order.
        assert_eq!(pa(true, &lid, None, &lid, &l), Ok(Some(earpods().uid)));
        // An override on the built-in mic is skipped (not cleared).
        assert_eq!(pa(false, &lid, Some(BUILT_IN), &lid, &l), Ok(Some(earpods().uid)));
        // The default is something else already: the default, as before.
        let mut e = earpods();
        e.is_default = true;
        let not_default = vec![live(BUILT_IN, "MacBook Pro Microphone", "", 2), e];
        assert_eq!(pa(false, &lid, None, &lid, &not_default), Ok(None));
        // The built-in mic alone: nothing to open.
        assert_eq!(pa(false, &lid, None, &lid, &[b.clone()]), Err(LidClosed));
        assert_eq!(pa(true, &lid, None, &lid, &[b.clone()]), Err(LidClosed));
        // Never by itself onto a virtual, aggregate or Continuity device...
        let mut v = live("V", "BlackHole 2ch", "", 9);
        v.transport = Transport::Virtual;
        let mut phone = live("P", "iPhone Microphone", "", 10);
        phone.transport = Transport::Continuity;
        let mut agg = live("G", "Aggregate", "", 11);
        agg.transport = Transport::Aggregate;
        assert_eq!(pa(false, &lid, None, &lid, &[b.clone(), v.clone(), phone, agg]), Err(LidClosed));
        // ...unless the customised order ranks it.
        let ranked = vec![stored("V", "BlackHole 2ch", ""), stored(BUILT_IN, "MacBook Pro Microphone", "")];
        assert_eq!(
            pick_available(true, &ranked, &[b.clone(), v], &lid, None, &lid).map(|t| t.map(|t| t.uid)),
            Ok(Some("V".to_string()))
        );
        // A passed-over mic stays passed over in the fallback too.
        let suspect_and_lid = vec![earpods().uid, BUILT_IN.to_string()];
        assert_eq!(pa(false, &suspect_and_lid, None, &lid, &l), Err(LidClosed));
    }

    #[test]
    fn the_idle_snapshot_shows_the_mic_the_next_start_opens_with_the_lid_closed() {
        let s = StoredInputs {
            customised: false,
            devices: vec![stored(BUILT_IN, "MacBook Pro Microphone", ""), stored("AppleUSBAudioEngine:EarPods", "EarPods", "")],
        };
        let mut b = live(BUILT_IN, "MacBook Pro Microphone", "", 2);
        b.is_default = true;
        let l = vec![b, earpods()];
        let active = |snap: &Snapshot| snap.devices.iter().filter(|d| d.active).map(|d| d.id.clone()).collect::<Vec<_>>();
        let lid = lid_unavailable(true);
        let snap = build_snapshot(&s, &l, None, &lid, None, &lid);
        assert_eq!(active(&snap), [earpods().uid]);
        let reasons: Vec<_> = snap.devices.iter().map(|d| (d.id.as_str(), d.unavailable_reason)).collect();
        assert!(reasons.contains(&(BUILT_IN, Some("lid_closed"))));
        assert!(reasons.contains(&("AppleUSBAudioEngine:EarPods", None)));
        // The lid opens: the snapshot changes (so it is emitted again).
        let open = build_snapshot(&s, &l, None, &[], None, &[]);
        assert_ne!(open, snap);
        assert_eq!(active(&open), [BUILT_IN]);
        // A meeting capture still on the built-in mic: it is the live row, with its reason.
        let snap = build_snapshot(&s, &l, Some(&InUse { uid: Some(BUILT_IN.into()), name: "MacBook Pro Microphone".into() }), &lid, None, &lid);
        assert!(snap.devices.iter().any(|d| d.id == BUILT_IN && d.live && d.unavailable_reason == Some("lid_closed")));
    }

    // ── digital silence ──

    #[test]
    fn a_stream_with_no_sound_since_it_opened_is_flagged_once_and_sound_clears_it() {
        let ms = Duration::from_millis;
        // Callbacks arriving; `heard`: a non-zero sample since it opened.
        let view = |heard: bool, open: u64| SoundView { frame_age: Some(ms(10)), heard, open_for: Some(ms(open)) };
        let mic = InUse { uid: Some(BUILT_IN.into()), name: "MacBook Pro Microphone".into() };
        let mut w = SilenceWatch::default();
        // Idle: nothing.
        assert_eq!(w.update(None, SoundView::default()), None);
        // Zeros since it opened, just under the threshold: nothing yet.
        assert_eq!(w.update(Some(&mic), view(false, 2_999)), None);
        // At the threshold: one `silent: true`...
        let p = w.update(Some(&mic), view(false, 3_000)).unwrap();
        assert_eq!(p, SilencePayload { device_id: Some(BUILT_IN.into()), name: "MacBook Pro Microphone".into(), silent: true });
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::json!({ "deviceId": BUILT_IN, "name": "MacBook Pro Microphone", "silent": true })
        );
        // ...once.
        assert_eq!(w.update(Some(&mic), view(false, 9_000)), None);
        // Sound at last: one `silent: false` for it.
        assert_eq!(w.update(Some(&mic), view(true, 9_100)).map(|p| p.silent), Some(false));
        // A stream that has made a sound is never flagged again, however
        // long its zeros (a noise gate between utterances).
        assert_eq!(w.update(Some(&mic), view(true, 60_000)), None);
        // No callbacks at all is a stall, not silence.
        let stalled = SoundView { frame_age: Some(ms(1_500)), heard: false, open_for: Some(ms(9_000)) };
        assert_eq!(w.update(Some(&mic), stalled), None);
        assert_eq!(w.update(Some(&mic), SoundView { frame_age: None, ..stalled }), None);
        // Flagged, then the capture ends or moves to another mic: cleared, for that mic.
        w.update(Some(&mic), view(false, 4_000)).unwrap();
        let p = w.update(None, SoundView::default()).unwrap();
        assert_eq!((p.device_id.as_deref(), p.silent), (Some(BUILT_IN), false));
        w.update(Some(&mic), view(false, 4_000)).unwrap();
        let other = InUse { uid: None, name: "EarPods".into() };
        assert_eq!(w.update(Some(&other), view(false, 100)).map(|p| (p.name, p.silent)), Some(("MacBook Pro Microphone".into(), false)));
        // ...and the new stream is judged on its own, from its own opening.
        assert_eq!(w.update(Some(&other), view(false, 2_000)), None);
        assert_eq!(w.update(Some(&other), view(false, 3_000)).map(|p| (p.device_id, p.silent)), Some((None, true)));
    }

    #[test]
    fn snapshot_orders_by_default_then_available_when_not_customised() {
        let mut s = StoredInputs {
            customised: false,
            devices: vec![stored("gone", "Old", ""), stored("A", "AirPods", ""), stored("B", "Built-in", "")],
        };
        s.devices[0].first_seen_at = stamp(t(0));
        s.devices[2].first_seen_at = stamp(t(2));
        let mut b = live("B", "Built-in", "", 2);
        b.is_default = true;
        let l = vec![live("A", "AirPods", "", 1), b];
        let snap = build_snapshot(&s, &l, None, &[], None, &[]);
        let ids: Vec<_> = snap.devices.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, ["B", "A", "gone"]);
        assert!(snap.devices[0].active && !snap.devices[1].active, "idle, not customised: the default is the pick");
        assert!(!snap.devices[2].available);
        // Customised: the saved order, and the pick is active.
        s.customised = true;
        let snap = build_snapshot(&s, &l, None, &[], None, &[]);
        let ids: Vec<_> = snap.devices.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, ["gone", "A", "B"]);
        assert!(snap.devices[1].active && !snap.devices[1].live);
        // While capturing, the device in use is active and live.
        let snap = build_snapshot(&s, &l, Some(&InUse { uid: Some("B".into()), name: "Built-in".into() }), &[], None, &[]);
        assert!(snap.devices[2].active && snap.devices[2].live);
        assert!(!snap.devices[1].active);
        // An in-use device without a UID is found by name.
        let snap = build_snapshot(&s, &l, Some(&InUse { uid: None, name: "AirPods".into() }), &[], None, &[]);
        assert!(snap.devices[1].live);
    }

    // ── should_switch ──

    #[test]
    fn switches_only_after_the_settle_and_the_gap() {
        let s = |c, r, u: Option<&str>, p: Option<&str>, stable: u64, last: Option<u64>| {
            should_switch(c, r, u, p, Duration::from_millis(stable), last.map(Duration::from_secs))
        };
        assert!(s(true, true, Some("B"), Some("A"), 2_000, None));
        assert!(s(true, true, Some("B"), Some("A"), 2_000, Some(10)));
        assert!(!s(true, true, Some("B"), Some("A"), 1_999, None), "not settled");
        assert!(!s(true, true, Some("B"), Some("A"), 5_000, Some(9)), "switched too recently");
        assert!(!s(false, true, Some("B"), Some("A"), 5_000, None), "not customised");
        assert!(!s(true, false, Some("B"), Some("A"), 5_000, None), "not capturing");
        assert!(!s(true, true, Some("A"), Some("A"), 5_000, None), "already on it");
        assert!(!s(true, true, Some("B"), None, 5_000, None), "nothing to switch to");
        assert!(s(true, true, None, Some("A"), 5_000, None), "unknown in-use device");
    }

    // ── suspects (a listed mic that went silent) ──

    #[test]
    fn excluding_passes_over_to_the_next_present_then_the_default() {
        let order = vec![stored("A", "AirPods", ""), stored("B", "Built-in", "")];
        let l = vec![live("A", "AirPods", "", 1), live("B", "Built-in", "", 2)];
        assert_eq!(pick_excluding(true, &order, &l, &["A".into()]).unwrap().uid, "B");
        assert_eq!(pick_excluding(true, &order, &l, &["A".into(), "B".into()]), None);
        assert_eq!(pick_excluding(false, &order, &l, &[]), None);
    }

    #[test]
    fn a_silent_top_mic_is_reopened_once_then_passed_over() {
        let order = vec![stored("A", "AirPods", ""), stored("B", "MacBook Pro Microphone", "")];
        let l = vec![live("A", "AirPods", "", 1), live("B", "MacBook Pro Microphone", "", 2)];
        let mut s = Suspects::default();
        let t0 = Instant::now();
        // First stall: reopen the same device (the device-release race).
        assert!(!s.on_fault("A", &l, t0));
        s.prune(&l, t0, true);
        assert_eq!(pick_excluding(true, &order, &l, &s.excluded()).unwrap().uid, "A");
        // It stalls again 3 s later: the next device in the order.
        assert!(s.on_fault("A", &l, t0 + Duration::from_secs(3)));
        s.prune(&l, t0 + Duration::from_secs(4), true);
        assert_eq!(pick_excluding(true, &order, &l, &s.excluded()).unwrap().uid, "B");
        // Faulting again (say it was also the default) keeps it passed over.
        assert!(s.on_fault("A", &l, t0 + Duration::from_secs(8)));
    }

    #[test]
    fn a_fault_after_a_healthy_minute_is_a_first_fault_again() {
        let l = vec![live("A", "AirPods", "", 1)];
        let mut s = Suspects::default();
        let t0 = Instant::now();
        assert!(!s.on_fault("A", &l, t0));
        assert!(!s.on_fault("A", &l, t0 + SUSPECT_WINDOW), "ran healthy for the window");
        assert!(s.on_fault("A", &l, t0 + SUSPECT_WINDOW + Duration::from_secs(3)));
    }

    #[test]
    fn a_passed_over_mic_comes_back_on_its_own_reconnect_or_age_only() {
        let l = vec![live("A", "AirPods", "", 1), live("B", "Built-in", "", 2)];
        let t0 = Instant::now();
        let fresh = || {
            let mut s = Suspects::default();
            s.on_fault("A", &l, t0);
            s.on_fault("A", &l, t0 + Duration::from_secs(3));
            s
        };
        let later = t0 + Duration::from_secs(5);
        // Unrelated churn (an iPhone mic appears) changes nothing.
        let mut s = fresh();
        s.prune(&[l[0].clone(), l[1].clone(), live("P", "iPhone Microphone", "", 9)], later, true);
        assert_eq!(s.excluded(), ["A"]);
        // It reconnects (a new AudioObjectID): worth trying again.
        let mut s = fresh();
        s.prune(&[live("A", "AirPods", "", 44), l[1].clone()], later, true);
        assert!(s.excluded().is_empty());
        // It leaves the list.
        let mut s = fresh();
        s.prune(&[l[1].clone()], later, true);
        assert!(s.excluded().is_empty());
        // Aging out: never during a meeting capture, after the limit otherwise.
        let old = t0 + Duration::from_secs(3) + SUSPECT_EXCLUDE_FOR;
        let mut s = fresh();
        s.prune(&l, old, true);
        assert_eq!(s.excluded(), ["A"]);
        s.prune(&l, old, false);
        assert!(s.excluded().is_empty());
        // A device that is not listed is never recorded.
        let mut s = Suspects::default();
        assert!(!s.on_fault("Z", &l, t0));
        assert!(!s.on_fault("Z", &l, t0));
    }

    /// A voice session now switches mics live like a meeting capture: while
    /// it runs, a mic recovery passed over stays passed over (it isn't
    /// released after SUSPECT_EXCLUDE_FOR and switched back to).
    #[test]
    fn a_passed_over_mic_stays_passed_over_while_a_voice_session_runs() {
        let voice = InUseHandle::default();
        voice.recording.store(true, Ordering::SeqCst);
        assert!(voice.capture_live() && voice.voice_session() && !voice.meeting_capture());
        let meeting = InUseHandle::default();
        meeting.recording.store(true, Ordering::SeqCst);
        meeting.to_file.store(true, Ordering::SeqCst);
        assert!(meeting.capture_live() && meeting.meeting_capture(), "a meeting capture: as before");
        assert!(!InUseHandle::default().capture_live());

        let l = vec![live("A", "AirPods", "", 1), live("B", "Built-in", "", 2)];
        let t0 = Instant::now();
        let mut s = Suspects::default();
        s.on_fault("A", &l, t0);
        assert!(s.on_fault("A", &l, t0 + Duration::from_secs(3)));
        let old = t0 + Duration::from_secs(3) + SUSPECT_EXCLUDE_FOR;
        s.prune(&l, old, voice.capture_live());
        assert_eq!(s.excluded(), ["A"]);
        s.prune(&l, old, InUseHandle::default().capture_live());
        assert!(s.excluded().is_empty(), "released once nothing runs");
    }

    // ── failed live switch ──

    #[test]
    fn a_failed_switch_is_cleared_only_by_that_device_changing() {
        let l = vec![live("X", "Headset X", "", 5), live("B", "Built-in", "", 2)];
        let f = DeviceIdentity::of(&l, "X").unwrap();
        assert!(f.unchanged_in(&l));
        // An iPhone mic appears, the default input moves, a hub re-enumerates
        // another device: X is still the same refusing device.
        assert!(f.unchanged_in(&[l[0].clone(), live("B", "Built-in", "", 3), live("P", "iPhone Microphone", "", 9)]));
        // X reconnects or leaves.
        assert!(!f.unchanged_in(&[live("X", "Headset X", "", 50), l[1].clone()]));
        assert!(!f.unchanged_in(&[l[1].clone()]));
        assert_eq!(DeviceIdentity::of(&[l[1].clone()], "X"), None);
    }

    // ── the "for now" override ──

    fn dflt(uid: &str, name: &str, id: u32) -> LiveInput {
        let mut d = live(uid, name, "", id);
        d.is_default = true;
        d
    }

    #[test]
    fn the_override_wins_when_present_and_not_passed_over() {
        let order = vec![stored("A", "AirPods", ""), stored("U", "BRIO", ""), stored("B", "Built-in", "")];
        let l = vec![live("A", "AirPods", "", 1), live("U", "BRIO", "", 3), dflt("B", "Built-in", 2)];
        // Available: beats the order, customised or not (not: beats the default).
        assert_eq!(pick_with_override(true, &order, &l, &[], Some("U")).unwrap().uid, "U");
        assert_eq!(pick_with_override(false, &order, &l, &[], Some("U")).unwrap().uid, "U");
        // Unavailable: the order, else the system default (None).
        assert_eq!(pick_with_override(true, &order, &l, &[], Some("gone")).unwrap().uid, "A");
        assert_eq!(pick_with_override(false, &order, &l, &[], Some("gone")), None);
        // Passed over by recovery: not re-chosen through the override.
        assert_eq!(pick_with_override(true, &order, &l, &["U".into()], Some("U")).unwrap().uid, "A");
        assert_eq!(pick_with_override(false, &order, &l, &["U".into()], Some("U")), None);
        // Equal to the priority pick: the same device either way.
        assert_eq!(pick_with_override(true, &order, &l, &[], Some("A")), pick(true, &order, &l));
        // None: exactly pick_excluding.
        assert_eq!(pick_with_override(true, &order, &l, &["A".into()], None).unwrap().uid, "U");
        // A shared name still carries the object id.
        let twins = vec![live("U1", "USB Audio Device", "", 11), live("U2", "USB Audio Device", "", 12)];
        assert_eq!(pick_with_override(false, &[], &twins, &[], Some("U2")).unwrap().object_id, Some(12));
    }

    #[test]
    fn setting_the_override_validates_and_the_priority_pick_clears_it() {
        let customised = StoredInputs {
            customised: true,
            devices: vec![stored("A", "AirPods", ""), stored("U", "BRIO", ""), stored("gone", "Old", ""), stored("B", "Built-in", "")],
        };
        let l = vec![live("A", "AirPods", "", 1), live("U", "BRIO", "", 3), dflt("B", "Built-in", 2)];
        assert_eq!(override_for(&customised, &l, &[], "U"), Ok(Some("U".into())));
        assert_eq!(override_for(&customised, &l, &[], "B"), Ok(Some("B".into())));
        // The mic the order would open anyway: same as clearing.
        assert_eq!(override_for(&customised, &l, &[], "A"), Ok(None));
        // With A passed over the order opens U: picking U is clearing.
        assert_eq!(override_for(&customised, &l, &["A".into()], "U"), Ok(None));
        // Known but disconnected, or unknown: rejected.
        assert!(override_for(&customised, &l, &[], "gone").unwrap_err().contains("isn't connected"));
        assert!(override_for(&customised, &l, &[], "ghost").unwrap_err().contains("Unknown"));
        // Not customised: the order's pick is the system default.
        let plain = StoredInputs { customised: false, ..customised.clone() };
        assert_eq!(override_for(&plain, &l, &[], "B"), Ok(None));
        assert_eq!(override_for(&plain, &l, &[], "A"), Ok(Some("A".into())));
    }

    #[test]
    fn the_override_is_cleared_when_its_mic_leaves_the_list() {
        let l = vec![live("A", "AirPods", "", 1), dflt("B", "Built-in", 2)];
        let mut slot = Some("A".to_string());
        // Still there (another device churns): kept.
        assert_eq!(clear_override_if_gone(&mut slot, &[l[0].clone(), l[1].clone(), live("P", "iPhone", "", 9)]), None);
        assert_eq!(slot.as_deref(), Some("A"));
        // An empty list is a failed read: kept.
        assert_eq!(clear_override_if_gone(&mut slot, &[]), None);
        assert_eq!(slot.as_deref(), Some("A"));
        // It leaves: cleared, once.
        assert_eq!(clear_override_if_gone(&mut slot, &[l[1].clone()]).as_deref(), Some("A"));
        assert_eq!(slot, None);
        assert_eq!(clear_override_if_gone(&mut slot, &[l[1].clone()]), None);
    }

    #[test]
    fn the_snapshot_carries_the_override_only_while_connected() {
        let s = StoredInputs { customised: true, devices: vec![stored("A", "AirPods", ""), stored("U", "BRIO", ""), stored("B", "Built-in", "")] };
        let l = vec![live("A", "AirPods", "", 1), live("U", "BRIO", "", 3), dflt("B", "Built-in", 2)];
        let active = |snap: &Snapshot| snap.devices.iter().filter(|d| d.active).map(|d| d.id.clone()).collect::<Vec<_>>();
        // Idle: the override is the next start's pick, so it's active.
        let snap = build_snapshot(&s, &l, None, &[], Some("U"), &[]);
        assert_eq!(snap.override_id.as_deref(), Some("U"));
        assert_eq!(active(&snap), ["U"]);
        assert_eq!(serde_json::to_value(&snap).unwrap()["overrideId"], "U");
        // Not customised: still the override, not the default.
        let plain = StoredInputs { customised: false, ..s.clone() };
        assert_eq!(active(&build_snapshot(&plain, &l, None, &[], Some("U"), &[])), ["U"]);
        // Capturing on another mic: the in-use device stays active.
        let snap = build_snapshot(&s, &l, Some(&InUse { uid: Some("A".into()), name: "AirPods".into() }), &[], Some("U"), &[]);
        assert_eq!((snap.override_id.as_deref(), active(&snap)), (Some("U"), vec!["A".to_string()]));
        // Disconnected: null, and the order's pick is active again.
        let snap = build_snapshot(&s, &l[..1], None, &[], Some("U"), &[]);
        assert_eq!(snap.override_id, None);
        assert_eq!(active(&snap), ["A"]);
        assert_eq!(serde_json::to_value(&snap).unwrap()["overrideId"], serde_json::Value::Null);
    }

    #[test]
    fn an_explicit_pick_switches_at_once() {
        // No settle, no gap: only "capturing" and "a different device" count.
        assert!(should_switch_explicit(true, Some("A"), Some("U")));
        assert!(should_switch_explicit(true, None, Some("U")), "unknown in-use device");
        assert!(!should_switch_explicit(true, Some("U"), Some("U")), "already on it");
        assert!(!should_switch_explicit(false, Some("A"), Some("U")), "no meeting capture");
        assert!(!should_switch_explicit(true, Some("A"), None), "nothing to switch to");
        // The automatic rule for the same situation would wait.
        assert!(!should_switch(true, true, Some("A"), Some("U"), Duration::ZERO, Some(Duration::from_secs(1))));
    }

    #[test]
    fn forgiving_a_passed_over_mic_makes_it_pickable_again() {
        let l = vec![live("A", "AirPods", "", 1), live("B", "Built-in", "", 2)];
        let t0 = Instant::now();
        let mut s = Suspects::default();
        s.on_fault("A", &l, t0);
        s.on_fault("A", &l, t0 + Duration::from_secs(3));
        s.on_fault("B", &l, t0 + Duration::from_secs(4));
        s.on_fault("B", &l, t0 + Duration::from_secs(5));
        s.forgive("A");
        assert_eq!(s.excluded(), ["B"]);
    }

    #[test]
    fn the_idle_snapshot_skips_a_passed_over_override_like_the_next_start() {
        let s = StoredInputs { customised: true, devices: vec![stored("A", "AirPods", ""), stored("U", "BRIO", ""), stored("B", "Built-in", "")] };
        let l = vec![live("A", "AirPods", "", 1), live("U", "BRIO", "", 3), dflt("B", "Built-in", 2)];
        let active = |snap: &Snapshot| snap.devices.iter().filter(|d| d.active).map(|d| d.id.clone()).collect::<Vec<_>>();
        // The override (A) faulted twice during a capture and recovery passed
        // over it; the capture ended inside SUSPECT_EXCLUDE_FOR.
        let t0 = Instant::now();
        let mut sus = Suspects::default();
        sus.on_fault("A", &l, t0);
        assert!(sus.on_fault("A", &l, t0 + Duration::from_secs(3)));
        sus.prune(&l, t0 + Duration::from_secs(60), false);
        let exclude = sus.excluded();
        assert_eq!(exclude, ["A"]);
        // The next start opens U (the order past A), so U is active, not A;
        // overrideId still names the override as set.
        let next_start = pick_with_override(true, &s.devices, &l, &exclude, Some("A")).unwrap().uid;
        let snap = build_snapshot(&s, &l, None, &exclude, Some("A"), &[]);
        assert_eq!(active(&snap), [next_start.clone()]);
        assert_eq!(next_start, "U");
        assert_eq!(snap.override_id.as_deref(), Some("A"));
        // Not customised: the next start is the system default.
        let plain = StoredInputs { customised: false, ..s.clone() };
        assert_eq!(pick_with_override(false, &plain.devices, &l, &exclude, Some("A")), None);
        assert_eq!(active(&build_snapshot(&plain, &l, None, &exclude, Some("A"), &[])), ["B"]);
        // The order's own pick passed over (no override): the next one.
        assert_eq!(active(&build_snapshot(&s, &l, None, &exclude, None, &[])), ["U"]);
        // While capturing, the in-use device stays active regardless.
        let snap = build_snapshot(&s, &l, Some(&InUse { uid: Some("A".into()), name: "AirPods".into() }), &exclude, Some("A"), &[]);
        assert_eq!(active(&snap), ["A"]);
    }

    #[test]
    fn a_uid_less_stream_on_the_override_mic_is_not_a_switch_candidate() {
        // Not customised; a capture opened on the default X with target None
        // and cpal didn't reveal its UID. The default then moved to Y and the
        // user picked X (override X, since the priority pick is now Y).
        let stored_plain = StoredInputs { customised: false, devices: vec![stored("X", "Mic X", ""), stored("Y", "Mic Y", "")] };
        let l = vec![live("X", "Mic X", "", 1), dflt("Y", "Mic Y", 2)];
        assert_eq!(override_for(&stored_plain, &l, &[], "X"), Ok(Some("X".into())));
        let in_use = InUse { uid: None, name: "Mic X".into() };
        let pick = pick_with_override(false, &stored_plain.devices, &l, &[], Some("X"));
        assert_eq!(pick.as_ref().unwrap().uid, "X");
        // Resolved as switch_now does: already on X, so neither the explicit
        // nor the automatic path switches.
        let resolved = uid_in_use(&in_use, &l);
        assert_eq!(resolved.as_deref(), Some("X"));
        assert!(!should_switch_explicit(true, resolved.as_deref(), Some("X")));
        let now = Instant::now();
        assert_eq!(next_candidate(None, pick.clone(), true, true, resolved.as_deref(), None, now), None);
        assert!(!should_switch(true, true, resolved.as_deref(), Some("X"), SWITCH_SETTLE, None));
        // The raw UID (None) would have made X a candidate and reopened it.
        assert!(next_candidate(None, pick.clone(), true, true, in_use.uid.as_deref(), None, now).is_some());
        assert!(should_switch(true, true, None, Some("X"), SWITCH_SETTLE, None));
        // A real difference still yields a candidate, whose start time holds.
        let on_y = uid_in_use(&InUse { uid: None, name: "Mic Y".into() }, &l);
        let c = next_candidate(None, pick.clone(), true, true, on_y.as_deref(), None, now).unwrap();
        assert_eq!((c.0.uid.as_str(), c.1), ("X", now));
        let later = now + Duration::from_secs(1);
        assert_eq!(next_candidate(Some(c), pick.clone(), true, true, on_y.as_deref(), None, later).unwrap().1, now);
        // No choice in effect, or no meeting capture: none.
        assert_eq!(next_candidate(None, pick.clone(), false, true, on_y.as_deref(), None, now), None);
        assert_eq!(next_candidate(None, pick, true, false, on_y.as_deref(), None, now), None);
    }

    #[test]
    fn a_successful_switch_clears_the_failed_mark_on_that_mic() {
        let order = vec![stored("A", "AirPods", ""), stored("B", "Built-in", "")];
        let l = vec![live("A", "AirPods", "", 1), dflt("B", "Built-in", 2)];
        let pick = pick_with_override(true, &order, &l, &[], None);
        assert_eq!(pick.as_ref().unwrap().uid, "A");
        let now = Instant::now();
        // An automatic switch to A failed: the capture stays on B, and A is
        // not re-tried automatically on this connection.
        let mut failed = DeviceIdentity::of(&l, "A");
        assert_eq!(next_candidate(None, pick.clone(), true, true, Some("B"), failed.as_ref(), now), None);
        // Opening another mic (or the default, None) keeps the mark.
        clear_failed_on_open(&mut failed, Some("B"));
        clear_failed_on_open(&mut failed, None);
        assert_eq!(failed.as_ref().map(|f| f.uid.as_str()), Some("A"));
        // The user picks A explicitly and it opens: the mark goes, so after a
        // later fallback to B the supervisor may move back to A.
        clear_failed_on_open(&mut failed, Some("A"));
        assert_eq!(failed, None);
        assert_eq!(next_candidate(None, pick, true, true, Some("B"), failed.as_ref(), now).unwrap().0.uid, "A");
    }

    // ── cpal ──

    #[test]
    fn parses_the_audio_device_id_from_cpal_debug() {
        assert_eq!(parse_audio_device_id(r#"Device { audio_device_id: 73, name: Ok("MacBook Pro Microphone") }"#), Some(73));
        assert_eq!(parse_audio_device_id("Device { audio_device_id: 1234 }"), Some(1234));
        assert_eq!(parse_audio_device_id("Device { id: 73 }"), None);
        assert_eq!(parse_audio_device_id("audio_device_id: x"), None);
    }

    /// cpal keeps `audio_device_id` pub(crate); we read it from `Debug`. That
    /// is only sound on the pinned version: bumping cpal must fail here until
    /// someone re-checks `host/coreaudio/macos/mod.rs`'s `impl Debug for
    /// Device`. Where a real input exists, the format is checked live too.
    #[test]
    fn cpal_debug_format_is_pinned() {
        // A Windows checkout has CRLF line ends (`* text=auto`).
        let lock = include_str!("../../Cargo.lock").replace("\r\n", "\n");
        assert!(
            lock.contains("name = \"cpal\"\nversion = \"0.15.3\"\n"),
            "cpal was bumped: re-verify Device's Debug format (audio_device_id) before changing this pin"
        );
        #[cfg(target_os = "macos")]
        {
            use cpal::traits::{DeviceTrait, HostTrait};
            if let Some(d) = cpal::default_host().default_input_device() {
                let id = cpal_object_id(&d).expect("an audio_device_id in cpal's Debug");
                if let Some(uid) = uid_of(&d) {
                    let listed = enumerate().into_iter().find(|l| l.uid == uid);
                    if let Some(l) = listed {
                        assert_eq!(l.object_id, id);
                        assert_eq!(Some(l.name), d.name().ok());
                    }
                }
            }
        }
    }

    /// Reads this Mac's input devices (property reads only; no stream).
    #[test]
    #[ignore = "reads this Mac's CoreAudio devices; run by hand with --ignored --nocapture"]
    fn reads_the_real_inputs() {
        for d in enumerate() {
            println!("{d:?}");
        }
    }
}
