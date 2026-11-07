//! The user's speech level, remembered per microphone (noise design WP7,
//! desktop side): the noisy room's level gate judges frames against S, the
//! user's own speech level, which a session otherwise starts at the
//! bootstrap (−32 dBFS) and only learns from the first sent turn. A TV louder
//! than a soft speaker gets through until then; starting from the level
//! this mic measured before closes that gap from the first word.
//!
//! - Stored in the settings store under `voice_speech_levels`: a map from
//!   the input device's CoreAudio UID to [`Level`] `{ db, turns, updatedAt }`
//!   ([`crate::settings::voice_speech_levels`]).
//! - Used at `voice_start` in the noisy room and under Auto (dictation and
//!   conversation), via [`super::turn::Machine::with_speech_hint`], and after
//!   a mid-session mic swap via [`super::turn::Machine::on_speech_hint`]. The
//!   quiet room never reads or writes it. Under Auto a known S also turns on
//!   the noisy room's barge-in from the start
//!   ([`super::profile::AutoSwitch::barge_when_known`]).
//! - Only conversations write it: a dictation sends no turns, so it never
//!   measures one.
//! - Written when a session ends, and at most once a minute during one (a
//!   crash keeps it), and only once the session has [`MIN_TURNS`] sent turns
//!   that measured a level on that device; blended into what was stored
//!   ([`blend`]) rather than replacing it, raised at most [`MAX_RISE_DB`]
//!   per session, and clamped to S's legal range.
//! - A remembered level over the bootstrap can be wrong (a louder talker, a
//!   TV-only minute): the machine may relax it back to the bootstrap within
//!   the session when the user's speech goes unheard under it, so a bad
//!   level never shuts the user out for good (and the next save blends it
//!   down).
//! - `forget_input_device` drops a device's level; `reset_input_priority`
//!   leaves them all. (No way yet to clear a connected mic's level.)
//! - A level is the user's speech **at the mic's input volume** then, so it
//!   is stored with that volume (`inputDb`, the device's
//!   `kAudioDevicePropertyVolumeDecibels`) and read back moved by the
//!   volume's change since ([`at_volume`]). Another app turning the input
//!   down (a call app's automatic mic level) would otherwise leave S over
//!   the user's voice: their speech reads as far, Auto takes the noisy room,
//!   its gate stays shut, and with no sent turn S never learns the new
//!   level. A level stored without a volume (older builds), or a mic with no
//!   volume control, is used as it is.
//!
//! Threads: [`Memory`] is pure and lives in the session actor; the store
//! reads and writes ([`load`], [`save`], [`forget`]) are blocking and run on
//! blocking threads, never with an AppState lock held (the settings store is
//! outside the lock order). [`STORE_LOCK`] is a leaf lock serialising the
//! read-modify-writes of the key.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::profile::Tuning;

/// Sent turns with a measured level a session needs on a device before it
/// may write that device's level (so one odd session can't set it).
pub const MIN_TURNS: u32 = 3;
/// The stored level weighs at most this many turns against a session's
/// (a turn-weighted mean): it steadies, but keeps following the user.
pub const PRIOR_WEIGHT_CAP: u32 = 10;
/// `turns` stops counting here.
pub const TURNS_CAP: u32 = 1_000_000;
/// A live session saves at most this often.
pub const CHECKPOINT_EVERY: Duration = Duration::from_secs(60);
/// One session raises a stored level at most this far (someone louder at
/// the mic, or the user closer to it that day, moves it a step, not all the
/// way). Lowering is not capped: a level too high shuts the user out, one
/// too low only lets more of the room in until turns lift it.
pub const MAX_RISE_DB: f32 = 6.0;

/// One device's remembered level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Level {
    /// S, dBFS.
    pub db: f32,
    /// Sent turns that measured it, over every session so far.
    pub turns: u32,
    /// RFC 3339.
    pub updated_at: String,
    /// The mic's input volume (dB) that `db` was heard at; None when the
    /// device has no volume control, or for a level saved before it was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_db: Option<f32>,
}

/// Input device UID → its level.
pub type Levels = BTreeMap<String, Level>;

/// A mic, as the session knows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Device {
    pub uid: String,
    pub name: String,
    /// Its input volume (dB) when the session looked it up; None when it has
    /// no volume control (or it couldn't be read).
    pub input_db: Option<f32>,
}

/// S's legal range (the noisy room's gate).
pub fn legal_range() -> (f32, f32) {
    let g = Tuning::NOISY.gate.expect("the noisy room has a level gate");
    (g.speech_min_db, g.speech_max_db)
}

/// `level` as the mic hears it at input volume `input_db` now: moved by the
/// volume's change since it was measured, and stored as at the new volume.
/// Unchanged when either volume is unknown.
pub fn at_volume(level: &Level, input_db: Option<f32>) -> Level {
    match (level.input_db, input_db) {
        (Some(then), Some(now)) if then.is_finite() && now.is_finite() => {
            Level { db: level.db + (now - then), input_db: Some(now), ..level.clone() }
        }
        _ => level.clone(),
    }
}

/// The level a session on `device` starts from: the stored one at its input
/// volume now ([`at_volume`]), clamped to S's range; None when none is
/// stored (or it isn't a number).
pub fn hint(levels: &Levels, device: &Device) -> Option<f32> {
    let (lo, hi) = legal_range();
    levels
        .get(&device.uid)
        .map(|l| at_volume(l, device.input_db).db)
        .filter(|d| d.is_finite())
        .map(|d| d.clamp(lo, hi))
}

/// A session measured `db` over `turns` sent turns at input volume
/// `input_db` on a device whose stored level was `prior` (already at that
/// volume, [`at_volume`]): the level to store. A turn-weighted mean, the prior
/// weighing at most [`PRIOR_WEIGHT_CAP`] turns, at most [`MAX_RISE_DB`] over
/// the prior; clamped to S's range. None under [`MIN_TURNS`] turns, or for
/// a level that isn't a number.
pub fn blend(prior: Option<&Level>, db: f32, turns: u32, input_db: Option<f32>, updated_at: String) -> Option<Level> {
    if turns < MIN_TURNS || !db.is_finite() {
        return None;
    }
    let (lo, hi) = legal_range();
    let db = db.clamp(lo, hi);
    let (blended, total) = match prior.filter(|p| p.db.is_finite()) {
        None => (db, turns),
        Some(p) => {
            let prior = p.db.clamp(lo, hi);
            let w = p.turns.min(PRIOR_WEIGHT_CAP) as f32;
            let n = turns as f32;
            (((prior * w + db * n) / (w + n)).min(prior + MAX_RISE_DB), p.turns.saturating_add(turns))
        }
    };
    Some(Level { db: blended.clamp(lo, hi), turns: total.min(TURNS_CAP), updated_at, input_db: input_db.filter(|d| d.is_finite()) })
}

/// RFC 3339 now, for [`Level::updated_at`].
pub fn stamp() -> String {
    crate::audio::input_devices::stamp(chrono::Utc::now())
}

/// A save [`Memory::save_due`] asks for.
#[derive(Debug, Clone, PartialEq)]
pub struct Save {
    pub device: Device,
    pub level: Level,
    /// This session's own measurement behind it.
    pub session_db: f32,
    pub session_turns: u32,
}

/// One noisy-room session's memory of the level on the mic it listens on.
/// Pure: the session actor feeds it the machine's S and measured-turn count
/// and carries out the saves it asks for.
///
/// A session's time on one device is a segment. Its saves all blend the
/// level stored when the segment began with the segment's S so far, so a
/// checkpoint a minute in and the save at the end don't count the same turns
/// twice.
#[derive(Debug, Clone)]
pub struct Memory {
    /// What was stored when the session started, plus this session's saves.
    levels: Levels,
    device: Option<Device>,
    /// The current device's level when its segment began, at the device's
    /// input volume then ([`at_volume`]).
    prior: Option<Level>,
    /// The machine's measured-turn count when the segment began...
    base: u32,
    /// ...and at the last save.
    saved: u32,
    /// The segment began or was last saved.
    since: Instant,
}

impl Memory {
    /// A session starting on `device` (None: unknown, nothing is used or
    /// saved), with the levels stored now. The machine has measured no turns.
    pub fn new(levels: Levels, device: Option<Device>, now: Instant) -> Self {
        let mut m = Self { levels, device: None, prior: None, base: 0, saved: 0, since: now };
        m.attach(device, now);
        m
    }

    #[cfg(test)]
    pub fn device(&self) -> Option<&Device> {
        self.device.as_ref()
    }

    /// The current device's remembered level, at its input volume now.
    pub fn hint(&self) -> Option<f32> {
        self.device.as_ref().and_then(|d| hint(&self.levels, d))
    }

    /// The current device's stored level when its segment began.
    #[cfg(test)]
    pub fn stored(&self) -> Option<&Level> {
        self.prior.as_ref()
    }

    /// The `[voice]` log's words about it: remembered (which, for which mic)
    /// or not. Levels only, never audio.
    pub fn note(&self) -> String {
        match (&self.device, self.hint(), &self.prior) {
            (None, ..) => "speech level: the mic's UID is unknown; starting from the bootstrap".into(),
            (Some(d), Some(db), Some(l)) => {
                let volume = match (self.levels.get(&d.uid).and_then(|stored| stored.input_db), d.input_db) {
                    (Some(then), Some(now)) if then != now => {
                        format!("; input volume {now:+.1} dB, was {then:+.1} dB when measured")
                    }
                    (_, Some(now)) => format!("; input volume {now:+.1} dB"),
                    _ => String::new(),
                };
                format!("speech level: remembered {db:.1} dB for {:?} ({} turns, {}{volume}), used", d.name, l.turns, l.updated_at)
            }
            (Some(d), ..) => format!("speech level: none remembered for {:?}; starting from the bootstrap", d.name),
        }
    }

    /// The machine's measured-turn count when the current segment began.
    pub fn base(&self) -> u32 {
        self.base
    }

    /// What to save now, given the machine's S (`speech_db`) and its
    /// measured-turn count: the segment has [`MIN_TURNS`] turns, some new
    /// since the last save, and it is the end (`force`) or a minute since
    /// the segment began or was last saved. Records the save as done.
    pub fn save_due(&mut self, speech_db: f32, turns_now: u32, now: Instant, force: bool, updated_at: impl FnOnce() -> String) -> Option<Save> {
        // (Called on every session tick: the cheap checks first.)
        if self.device.is_none() || turns_now == self.saved || (!force && now.duration_since(self.since) < CHECKPOINT_EVERY) {
            return None;
        }
        let turns = turns_now.saturating_sub(self.base);
        let input_db = self.device.as_ref().and_then(|d| d.input_db);
        let level = blend(self.prior.as_ref(), speech_db, turns, input_db, updated_at())?;
        let device = self.device.clone()?;
        self.saved = turns_now;
        self.since = now;
        self.levels.insert(device.uid.clone(), level.clone());
        Some(Save { device, level, session_db: speech_db, session_turns: turns })
    }

    /// The mic's stream was replaced (save the segment first,
    /// [`Self::save_due`] with `force`): the device is unknown until
    /// [`Self::attach`], and turns from here count toward the next one.
    pub fn detach(&mut self, turns_now: u32, now: Instant) {
        self.device = None;
        self.prior = None;
        self.base = turns_now;
        self.saved = turns_now;
        self.since = now;
    }

    /// The stream is on `device` now (a new segment, counting from the last
    /// [`Self::detach`]): its remembered level, if any.
    pub fn attach(&mut self, device: Option<Device>, now: Instant) -> Option<f32> {
        self.prior = device.as_ref().and_then(|d| self.levels.get(&d.uid).map(|l| at_volume(l, d.input_db)));
        self.device = device;
        self.since = now;
        self.hint()
    }
}

/// Drop `uid`'s level; whether there was one.
pub fn forget_in(levels: &mut Levels, uid: &str) -> bool {
    levels.remove(uid).is_some()
}

// ── the store ────────────────────────────────────────────────────────────

/// Serialises read-modify-writes of `voice_speech_levels`. A leaf lock:
/// nothing else is taken while it is held except the plugin store's own.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// The mic a stream is capturing on right now, with its input volume
/// ([`crate::audio::input_devices::device_in_use`]). Blocking CoreAudio
/// property reads; takes no AppState lock.
pub fn device_in_use(app: &tauri::AppHandle) -> Option<Device> {
    let (uid, name) = crate::audio::input_devices::device_in_use(app)?;
    let input_db = crate::audio::input_devices::input_volume_db(&uid);
    Some(Device { uid, name, input_db })
}

/// Every stored level. Blocking; never call with an AppState lock held.
pub fn load(app: &tauri::AppHandle) -> Levels {
    crate::settings::voice_speech_levels(app)
}

/// Store `level` for `uid`. Blocking; never call with an AppState lock held.
pub fn save(app: &tauri::AppHandle, uid: &str, level: &Level) {
    let _g = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut levels = crate::settings::voice_speech_levels(app);
    levels.insert(uid.to_string(), level.clone());
    crate::settings::set_voice_speech_levels(app, &levels);
}

/// `forget_input_device`: drop `uid`'s level. Blocking; never call with an
/// AppState lock held.
pub fn forget(app: &tauri::AppHandle, uid: &str) {
    let _g = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut levels = crate::settings::voice_speech_levels(app);
    if forget_in(&mut levels, uid) {
        crate::settings::set_voice_speech_levels(app, &levels);
        crate::log_to_file(&format!("[voice] forgot the remembered speech level of {uid}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lvl(db: f32, turns: u32) -> Level {
        Level { db, turns, updated_at: "t0".into(), input_db: None }
    }

    fn dev(uid: &str) -> Device {
        Device { uid: uid.into(), name: format!("{uid} mic"), input_db: None }
    }

    /// `uid`'s mic at input volume `input_db`.
    fn dev_at(uid: &str, input_db: f32) -> Device {
        Device { input_db: Some(input_db), ..dev(uid) }
    }

    /// A level heard at input volume `input_db`.
    fn lvl_at(db: f32, turns: u32, input_db: f32) -> Level {
        Level { input_db: Some(input_db), ..lvl(db, turns) }
    }

    #[test]
    fn a_level_needs_three_measured_turns() {
        assert_eq!(blend(None, -26.0, 0, None, "t".into()), None);
        assert_eq!(blend(None, -26.0, 2, None, "t".into()), None);
        assert_eq!(blend(Some(&lvl(-30.0, 40)), -26.0, 2, None, "t".into()), None, "a prior doesn't lower the bar");
        assert_eq!(blend(None, -26.0, 3, None, "t".into()), Some(Level { db: -26.0, turns: 3, updated_at: "t".into(), input_db: None }));
        assert_eq!(blend(None, f32::NAN, 5, None, "t".into()), None);
    }

    #[test]
    fn a_session_blends_into_the_stored_level_by_turns() {
        // 4 stored turns at −30, a session of 4 at −22: halfway.
        let l = blend(Some(&lvl(-30.0, 4)), -22.0, 4, None, "t".into()).unwrap();
        assert_eq!((l.db, l.turns), (-26.0, 8));
        // A long history weighs 10 turns at most: 3 at −20 over −30 moves it
        // 3/13 of the way.
        let l = blend(Some(&lvl(-30.0, 500)), -20.0, 3, None, "t".into()).unwrap();
        assert!((l.db - (-30.0 + 10.0 * 3.0 / 13.0)).abs() < 1e-4, "{}", l.db);
        assert_eq!(l.turns, 503);
        // A stored value that isn't a number is replaced outright.
        let l = blend(Some(&lvl(f32::NAN, 9)), -24.0, 3, None, "t".into()).unwrap();
        assert_eq!((l.db, l.turns), (-24.0, 3));
    }

    #[test]
    fn one_session_raises_a_stored_level_at_most_six_db() {
        // 40 turns at −10 over 10 stored at −34: the mean would be −14.8.
        let l = blend(Some(&lvl(-34.0, 10)), -10.0, 40, None, "t".into()).unwrap();
        assert_eq!((l.db, l.turns), (-34.0 + MAX_RISE_DB, 50));
        // Under the cap: the mean, as usual.
        let l = blend(Some(&lvl(-30.0, 10)), -26.0, 10, None, "t".into()).unwrap();
        assert_eq!(l.db, -28.0);
        // Down is not capped.
        let l = blend(Some(&lvl(-14.0, 10)), -40.0, 40, None, "t".into()).unwrap();
        assert!((l.db - (-14.0 * 10.0 - 40.0 * 40.0) / 50.0).abs() < 1e-4, "{}", l.db);
        // No prior: the session's level (the relax rule bounds a bad one,
        // [`crate::voice::turn::Machine::with_speech_hint`]).
        assert_eq!(blend(None, -12.0, 3, None, "t".into()).unwrap().db, -12.0);
    }

    #[test]
    fn levels_stay_in_the_speech_levels_range() {
        let (lo, hi) = legal_range();
        assert_eq!((lo, hi), (-50.0, -10.0));
        assert_eq!(blend(None, 3.0, 3, None, "t".into()).unwrap().db, hi);
        assert_eq!(blend(None, -80.0, 3, None, "t".into()).unwrap().db, lo);
        assert_eq!(blend(Some(&lvl(-90.0, 10)), -40.0, 10, None, "t".into()).unwrap().db, -45.0, "the prior is clamped too");
        let mut levels = Levels::new();
        levels.insert("hot".into(), lvl(0.0, 3));
        levels.insert("nan".into(), lvl(f32::NAN, 3));
        assert_eq!(hint(&levels, &dev("hot")), Some(hi));
        assert_eq!(hint(&levels, &dev("nan")), None);
    }

    #[test]
    fn the_hint_is_looked_up_by_the_devices_uid() {
        let mut levels = Levels::new();
        levels.insert("BuiltInMicrophoneDevice".into(), lvl(-38.0, 12));
        levels.insert("AppleUSBAudioEngine:Jabra:1".into(), lvl(-22.0, 7));
        let t0 = Instant::now();
        let m = Memory::new(levels.clone(), Some(dev("AppleUSBAudioEngine:Jabra:1")), t0);
        assert_eq!(m.hint(), Some(-22.0));
        assert_eq!(m.stored(), Some(&lvl(-22.0, 7)));
        // Same name, another UID: nothing.
        let m = Memory::new(levels.clone(), Some(Device { uid: "other".into(), name: "BuiltInMicrophoneDevice mic".into(), input_db: None }), t0);
        assert_eq!(m.hint(), None);
        // Unknown device: nothing used, nothing saved.
        let mut m = Memory::new(levels, None, t0);
        assert_eq!(m.hint(), None);
        assert_eq!(m.save_due(-20.0, 9, t0 + CHECKPOINT_EVERY, true, || "t".into()), None);
    }

    #[test]
    fn a_session_saves_at_the_end_and_at_most_once_a_minute() {
        let t0 = Instant::now();
        let mut levels = Levels::new();
        levels.insert("mic".into(), lvl(-30.0, 4));
        let mut m = Memory::new(levels, Some(dev("mic")), t0);
        let at = |s: u64| t0 + Duration::from_secs(s);
        // Two turns: not enough, even at the end.
        assert_eq!(m.save_due(-24.0, 2, at(120), true, || "t".into()), None);
        // Three, but under a minute in: not yet...
        assert_eq!(m.save_due(-24.0, 3, at(59), false, || "t".into()), None);
        // ...a minute in: saved, blended from the stored level.
        let s = m.save_due(-24.0, 3, at(61), false, || "t1".into()).unwrap();
        assert_eq!((s.level.db, s.level.turns, s.session_turns), ((-30.0 * 4.0 - 24.0 * 3.0) / 7.0, 7, 3));
        assert_eq!(s.device, dev("mic"));
        // No new turn: nothing to save, not even at the end.
        assert_eq!(m.save_due(-24.0, 3, at(200), true, || "t".into()), None);
        // Two more: not a minute since the checkpoint...
        assert_eq!(m.save_due(-22.0, 5, at(100), false, || "t".into()), None);
        // ...but the end saves them, blended from the level stored when the
        // session began (the checkpoint's turns aren't counted twice).
        let s = m.save_due(-22.0, 5, at(100), true, || "t2".into()).unwrap();
        assert_eq!((s.level.db, s.level.turns, s.level.updated_at.as_str()), ((-30.0 * 4.0 - 22.0 * 5.0) / 9.0, 9, "t2"));
    }

    #[test]
    fn a_mic_swap_saves_the_old_device_and_starts_the_new_one_from_its_level() {
        let t0 = Instant::now();
        let mut levels = Levels::new();
        levels.insert("headset".into(), lvl(-20.0, 30));
        let mut m = Memory::new(levels, Some(dev("builtin")), t0);
        assert_eq!(m.hint(), None, "nothing remembered for the built-in mic yet");
        // Four turns on the built-in mic, then the headset comes on.
        let s = m.save_due(-36.0, 4, t0, true, || "t".into()).unwrap();
        assert_eq!((s.device.uid.as_str(), s.level.db, s.level.turns), ("builtin", -36.0, 4));
        m.detach(4, t0);
        assert_eq!(m.device(), None);
        assert_eq!(m.save_due(-32.0, 4, t0 + CHECKPOINT_EVERY, true, || "t".into()), None, "no device while detached");
        assert_eq!(m.attach(Some(dev("headset")), t0), Some(-20.0));
        assert_eq!(m.base(), 4);
        // Two turns on the headset: not enough for it.
        assert_eq!(m.save_due(-19.0, 6, t0, true, || "t".into()), None);
        // Back to the built-in mic: it starts from what this session saved.
        m.detach(6, t0);
        assert_eq!(m.attach(Some(dev("builtin")), t0), Some(-36.0));
        // A device with nothing stored: the bootstrap.
        m.detach(6, t0);
        assert_eq!(m.attach(Some(dev("usb")), t0), None);
    }

    #[test]
    fn forgetting_drops_only_that_devices_level() {
        let mut levels = Levels::new();
        levels.insert("a".into(), lvl(-30.0, 4));
        levels.insert("b".into(), lvl(-20.0, 4));
        assert!(forget_in(&mut levels, "a"));
        assert!(!forget_in(&mut levels, "a"));
        assert_eq!(levels.keys().collect::<Vec<_>>(), ["b"]);
    }

    #[test]
    fn the_stored_shape_is_camel_case() {
        let mut levels = Levels::new();
        levels.insert("uid-1".into(), Level { db: -27.5, turns: 6, updated_at: "2026-09-26T10:00:00.000Z".into(), input_db: None });
        let v = serde_json::to_value(&levels).unwrap();
        assert_eq!(v, serde_json::json!({ "uid-1": { "db": -27.5, "turns": 6, "updatedAt": "2026-09-26T10:00:00.000Z" } }));
        assert_eq!(serde_json::from_value::<Levels>(v).unwrap(), levels);
        // With the input volume it was heard at.
        levels.insert("uid-2".into(), Level { db: -24.25, turns: 199, updated_at: "2026-10-08T01:58:26.411Z".into(), input_db: Some(10.375) });
        let v = serde_json::to_value(&levels).unwrap();
        assert_eq!(v["uid-2"], serde_json::json!({ "db": -24.25, "turns": 199, "updatedAt": "2026-10-08T01:58:26.411Z", "inputDb": 10.375 }));
        assert_eq!(serde_json::from_value::<Levels>(v).unwrap(), levels);
    }

    #[test]
    fn a_stored_level_follows_the_mics_input_volume() {
        // Heard at +10.4 dB; the volume is −5.0 dB now (93 % → 29 % on a
        // MacBook mic): the user is 15.4 dB quieter at the gate.
        let heard = lvl_at(-24.3, 199, 10.4);
        let now = at_volume(&heard, Some(-5.0));
        assert!((now.db - (-24.3 - 15.4)).abs() < 1e-4, "{}", now.db);
        assert_eq!((now.turns, now.input_db), (199, Some(-5.0)));
        // Turned up: louder.
        assert!((at_volume(&heard, Some(12.0)).db - (-24.3 + 1.6)).abs() < 1e-4);
        // Either volume unknown: as stored.
        assert_eq!(at_volume(&heard, None), heard);
        assert_eq!(at_volume(&lvl(-24.3, 199), Some(-5.0)), lvl(-24.3, 199));
        assert_eq!(at_volume(&heard, Some(f32::NEG_INFINITY)), heard, "a muted control says nothing");

        // The session's hint, clamped to S's range like any level.
        let mut levels = Levels::new();
        levels.insert("BuiltInMicrophoneDevice".into(), heard.clone());
        assert!((hint(&levels, &dev_at("BuiltInMicrophoneDevice", -5.0)).unwrap() - (-39.7)).abs() < 1e-4);
        assert!((hint(&levels, &dev_at("BuiltInMicrophoneDevice", 10.4)).unwrap() - (-24.3)).abs() < 1e-4);
        assert_eq!(hint(&levels, &dev("BuiltInMicrophoneDevice")), Some(-24.3), "no volume now: as stored");
        levels.insert("quiet".into(), lvl_at(-40.0, 9, 12.0));
        assert_eq!(hint(&levels, &dev_at("quiet", -12.0)), Some(legal_range().0));
    }

    #[test]
    fn a_session_blends_and_saves_at_the_volume_it_heard() {
        let t0 = Instant::now();
        let mut levels = Levels::new();
        levels.insert("mic".into(), lvl_at(-24.0, 10, 10.0));
        // The input was turned down 15 dB since: the session starts at −39.
        let mut m = Memory::new(levels, Some(dev_at("mic", -5.0)), t0);
        assert_eq!(m.hint(), Some(-39.0));
        assert_eq!(m.stored(), Some(&lvl_at(-39.0, 10, -5.0)));
        assert!(m.note().contains("input volume -5.0 dB, was +10.0 dB when measured"), "{}", m.note());
        // Ten turns at −37: blended with the prior at today's volume, and
        // stored with it.
        let s = m.save_due(-37.0, 10, t0, true, || "t1".into()).unwrap();
        assert_eq!((s.level.db, s.level.turns, s.level.input_db), (-38.0, 20, Some(-5.0)));
        // Back on the same mic within the session: no shift left to make.
        m.detach(10, t0);
        assert_eq!(m.attach(Some(dev_at("mic", -5.0)), t0), Some(-38.0));
        // A mic with no volume control saves none.
        let mut m = Memory::new(Levels::new(), Some(dev("usb")), t0);
        assert_eq!(m.save_due(-30.0, 3, t0, true, || "t".into()).unwrap().level.input_db, None);
    }
}
