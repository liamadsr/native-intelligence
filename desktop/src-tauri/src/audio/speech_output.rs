//! Which output device the agent's voice (TTS) plays on.
//!
//! A headset's mic and its earpieces go together: when the chosen input
//! (`input_devices`: the "for now" override, else the priority order, else
//! the system default input) is a USB or Bluetooth device that also plays
//! sound, speech plays on that device ([`pair`]). Everything else keeps the
//! system default output, as before:
//! - the built-in mic never pulls speech to the built-in speakers (someone
//!   talking into the laptop while listening on AirPods keeps the AirPods);
//! - virtual and aggregate devices, iPhone (Continuity) mics, displays and
//!   unknown transports never pair;
//! - a USB mic only takes speech off the built-in speakers: any other
//!   default output is one the user chose (AirPods, wired or USB-dongle
//!   headphones, a USB DAC, desk speakers, a monitor), so a display's,
//!   webcam's or conference speaker's mic leaves it alone. A Bluetooth mic
//!   always brings its own earpieces.
//!
//! "Also plays sound" means, in order:
//! 1. the same AudioObjectID has output streams (most USB and Bluetooth
//!    headsets, AirPods);
//! 2. exactly one output device of the same transport is listed in the
//!    input's related devices (`kAudioDevicePropertyRelatedDevices`), or
//!    lists the input in its own;
//! 3. an output device of the same transport with the same (non-empty)
//!    model UID, only when that is unambiguous: one such device, or one whose
//!    UID shares the input's UID up to its last ':' (the same USB unit:
//!    USB-C EarPods are "…:EarPods:<serial>:2" in, "…:<serial>:1" out).
//!
//! The input is the mic a stream is capturing on while one is live (a voice
//! session keeps its mic whatever the pick says), else the pick
//! (`input_devices::chosen_input`).
//!
//! [`open`] resolves at every TTS output open (read-aloud and a voice
//! session's held output). The input supervisor re-decides on every device
//! change, order or override edit and publishes a changed pairing
//! ([`note_pairing`], [`subscribe`]); a voice session then re-reads its
//! route (the echo hint follows the device TTS opens, [`route`]) and moves
//! its held output, the same way it does on an output-route change. Every
//! resolution publishes too ([`route`], [`open`]): the pairing also depends
//! on the default output, which only the session's route watcher sees, and a
//! stale published value would swallow the supervisor's next change.
//!
//! Not covered: sounds the web UI plays (chimes) go through WKWebView to the
//! system default output.

use std::sync::{Arc, LazyLock};

use tokio::sync::watch;

use super::input_devices::{LiveInput, Transport};
use super::output_route::{OutputKind, OutputRoute};
use super::playback::{self, CancelGate, OutputTarget, Player};

/// What pairing needs to know about one CoreAudio device.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceFacts {
    pub object_id: u32,
    pub uid: String,
    pub name: String,
    pub model_uid: String,
    pub transport: Transport,
    /// Has output streams.
    pub has_output: bool,
    /// `kAudioDevicePropertyRelatedDevices`, the device itself left out.
    pub related: Vec<u32>,
}

/// Why an output counts as the input's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairedBy {
    SameDevice,
    Related,
    ModelUid,
}

impl PairedBy {
    fn describe(self) -> &'static str {
        match self {
            PairedBy::SameDevice => "the same device",
            PairedBy::Related => "a related device",
            PairedBy::ModelUid => "the same model",
        }
    }
}

/// Only these inputs pull speech to their own output.
fn pairable(transport: Transport) -> bool {
    matches!(transport, Transport::Usb | Transport::Bluetooth)
}

/// A UID up to its last ':' (the unit, without the direction suffix).
fn uid_stem(uid: &str) -> &str {
    uid.rsplit_once(':').map_or(uid, |(stem, _)| stem)
}

/// The output device `input` pairs with (see the module docs), or None: the
/// system default output. `outputs` are the present output devices;
/// `default_output` is the system default output's id and kind.
pub fn pair<'a>(
    input: &DeviceFacts,
    outputs: &'a [DeviceFacts],
    default_output: Option<(u32, OutputKind)>,
) -> Option<(&'a DeviceFacts, PairedBy)> {
    if !pairable(input.transport) {
        return None;
    }
    let usable: Vec<&DeviceFacts> = outputs
        .iter()
        .filter(|o| o.has_output && !matches!(o.transport, Transport::Virtual | Transport::Aggregate))
        .collect();
    let only = |v: Vec<&'a DeviceFacts>| if v.len() == 1 { Some(v[0]) } else { None };
    let found = usable
        .iter()
        .copied()
        .find(|o| o.object_id == input.object_id)
        .map(|o| (o, PairedBy::SameDevice))
        .or_else(|| {
            let related = usable
                .iter()
                .copied()
                .filter(|o| o.transport == input.transport)
                .filter(|o| input.related.contains(&o.object_id) || o.related.contains(&input.object_id))
                .collect();
            only(related).map(|o| (o, PairedBy::Related))
        })
        .or_else(|| {
            if input.model_uid.is_empty() {
                return None;
            }
            let same_model: Vec<&DeviceFacts> = usable
                .iter()
                .copied()
                .filter(|o| o.transport == input.transport && o.model_uid == input.model_uid)
                .collect();
            let same_unit = || only(same_model.iter().copied().filter(|o| uid_stem(&o.uid) == uid_stem(&input.uid)).collect());
            only(same_model.clone()).or_else(same_unit).map(|o| (o, PairedBy::ModelUid))
        });
    let (out, by) = found?;
    // A USB mic (a headset, but also a display, webcam or speakerphone, and
    // a dongle headset's name may not say so) only takes speech off the
    // built-in speakers: every other default output is the user's choice.
    if input.transport == Transport::Usb {
        if let Some((default_id, kind)) = default_output {
            if default_id != out.object_id && kind != OutputKind::BuiltInSpeakers {
                return None;
            }
        }
    }
    Some((out, by))
}

/// The output the chosen mic pairs with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paired {
    pub object_id: u32,
    pub uid: String,
    pub name: String,
    /// The input it pairs with.
    pub input_name: String,
    pub by: PairedBy,
}

/// Where speech goes: the paired output, or (None) the system default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Choice {
    pub paired: Option<Paired>,
}

impl Choice {
    /// Why, for the log line of each open.
    pub fn why(&self) -> String {
        match &self.paired {
            Some(p) => format!("paired with the input \"{}\", {}", p.input_name, p.by.describe()),
            None => "the system default".to_string(),
        }
    }

    /// What a pairing change is compared by: the paired output's UID.
    pub fn key(&self) -> Option<String> {
        self.paired.as_ref().map(|p| p.uid.clone())
    }
}

/// The pure half of [`decide`]: pair `input` among `devices` (every present
/// device's facts).
pub fn decide_among(input: Option<&LiveInput>, devices: &[DeviceFacts], default_output: Option<(u32, OutputKind)>) -> Choice {
    let Some(input) = input.filter(|i| pairable(i.transport)) else { return Choice::default() };
    let Some(facts) = devices.iter().find(|d| d.object_id == input.object_id) else { return Choice::default() };
    let outputs: Vec<DeviceFacts> = devices.iter().filter(|d| d.has_output).cloned().collect();
    let paired = pair(facts, &outputs, default_output).map(|(o, by)| Paired {
        object_id: o.object_id,
        uid: o.uid.clone(),
        name: o.name.clone(),
        input_name: input.name.clone(),
        by,
    });
    Choice { paired }
}

/// Where speech goes for `input` (the mic in use, else the chosen one: see
/// `input_devices::chosen_input`). Blocking CoreAudio property reads, only
/// for a USB or Bluetooth input.
pub fn decide(input: Option<&LiveInput>) -> Choice {
    if !input.is_some_and(|i| pairable(i.transport)) {
        return Choice::default();
    }
    #[cfg(target_os = "macos")]
    {
        let devices = ca::all_facts();
        let default_output = super::output_route::ffi::default_output_device()
            .ok()
            .map(|id| (id, super::output_route::route_of(id).kind));
        decide_among(input, &devices, default_output)
    }
    #[cfg(not(target_os = "macos"))]
    Choice::default()
}

/// Where speech goes now, published ([`note_pairing`]) so the watch never
/// lags a resolution. Blocking; takes no AppState lock.
pub fn resolve(app: &tauri::AppHandle) -> Choice {
    let choice = decide(super::input_devices::chosen_input(app).as_ref());
    note_pairing(&choice);
    choice
}

/// The route of the device TTS opens now (the voice session's echo hint),
/// with the choice behind it. Blocking.
pub fn route(app: &tauri::AppHandle) -> Result<(OutputRoute, Choice), String> {
    let choice = resolve(app);
    #[cfg(target_os = "macos")]
    if let Some(p) = &choice.paired {
        return Ok((super::output_route::route_of(p.object_id), choice));
    }
    Ok((super::output_route::current()?, choice))
}

/// Open the speech output where [`resolve`] says, falling back to the system
/// default when the paired device won't open. Blocking (CoreAudio).
pub fn open(app: &tauri::AppHandle, gate: Arc<CancelGate>) -> Result<Player, String> {
    let choice = resolve(app);
    let Some(p) = &choice.paired else {
        return playback::open_output(None, &choice.why(), gate);
    };
    let target = OutputTarget { name: p.name.clone(), object_id: Some(p.object_id) };
    match playback::open_output(Some(&target), &choice.why(), gate.clone()) {
        Ok(player) => Ok(player),
        Err(e) => {
            crate::log_to_file(&format!("[tts] paired output {:?} did not open ({e}); using the system default", p.name));
            playback::open_output(None, "the system default: the paired output did not open", gate)
        }
    }
}

/// The last published pairing (the paired output's UID; None = the system
/// default).
static PAIRING: LazyLock<watch::Sender<Option<String>>> = LazyLock::new(|| watch::Sender::new(None));

/// Changes of the pairing (not of the system default output: that is the
/// output-route watcher's).
pub fn subscribe() -> watch::Receiver<Option<String>> {
    PAIRING.subscribe()
}

/// Publish `choice` (the input supervisor on every re-read, and every
/// [`resolve`]). Subscribers wake only when the paired output changes.
pub fn note_pairing(choice: &Choice) {
    let key = choice.key();
    PAIRING.send_if_modified(|current| {
        if *current == key {
            return false;
        }
        *current = key.clone();
        crate::log_to_file(&format!(
            "[speech-output] speech now plays on {}",
            choice.paired.as_ref().map_or_else(|| "the system default output".to_string(), |p| format!("{:?} ({})", p.name, choice.why()))
        ));
        true
    });
}

/// After a subscriber re-resolved to `choice` (which [`resolve`] just
/// published): mark `rx` seen when the published pairing is still that one,
/// so its own publish doesn't wake it again. A different value (the
/// supervisor published since) stays unseen and wakes it.
pub fn mark_seen_if_current(rx: &mut watch::Receiver<Option<String>>, choice: &Choice) {
    if *rx.borrow() == choice.key() {
        rx.borrow_and_update();
    }
}

#[cfg(target_os = "macos")]
mod ca {
    use super::super::input_devices::{classify_transport, is_plumbing};
    use super::super::output_route::ffi::*;
    use super::DeviceFacts;

    const fn cc(s: &[u8; 4]) -> u32 {
        ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | s[3] as u32
    }
    const STREAMS: u32 = cc(b"stm#");
    const IS_ALIVE: u32 = cc(b"livn");
    const IS_HIDDEN: u32 = cc(b"hidn");
    const DEVICE_UID: u32 = cc(b"uid ");
    const MODEL_UID: u32 = cc(b"muid");
    const RELATED_DEVICES: u32 = cc(b"akin");

    /// Every present, visible device (plumbing left out), inputs and outputs.
    pub fn all_facts() -> Vec<DeviceFacts> {
        let mut out = Vec::new();
        for id in all_devices() {
            if get_u32(id, IS_ALIVE, SCOPE_GLOBAL) == Some(0) || get_u32(id, IS_HIDDEN, SCOPE_GLOBAL) == Some(1) {
                continue;
            }
            let Some(uid) = get_string(id, DEVICE_UID, SCOPE_GLOBAL).filter(|u| !u.is_empty()) else { continue };
            let name = device_name(id).filter(|n| !n.is_empty()).unwrap_or_else(|| uid.clone());
            if is_plumbing(&uid, &name) {
                continue;
            }
            out.push(DeviceFacts {
                object_id: id,
                model_uid: get_string(id, MODEL_UID, SCOPE_GLOBAL).unwrap_or_default(),
                transport: classify_transport(get_u32(id, TRANSPORT_TYPE, SCOPE_GLOBAL).unwrap_or(0)),
                has_output: property_size(id, STREAMS, SCOPE_OUTPUT).unwrap_or(0) > 0,
                related: get_u32_array(id, RELATED_DEVICES, SCOPE_GLOBAL).into_iter().filter(|&r| r != id).collect(),
                uid,
                name,
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::input_devices::{chosen_live, paired_input, pick_with_override, StoredDevice};
    use std::sync::Mutex;

    /// PAIRING is one static: the tests that publish take turns.
    static PAIRING_TESTS: Mutex<()> = Mutex::new(());

    fn dev(id: u32, uid: &str, name: &str, model: &str, transport: Transport, has_output: bool) -> DeviceFacts {
        DeviceFacts {
            object_id: id,
            uid: uid.into(),
            name: name.into(),
            model_uid: model.into(),
            transport,
            has_output,
            related: Vec::new(),
        }
    }

    fn live(d: &DeviceFacts, is_default: bool) -> LiveInput {
        LiveInput {
            uid: d.uid.clone(),
            name: d.name.clone(),
            model_uid: d.model_uid.clone(),
            transport: d.transport,
            object_id: d.object_id,
            is_default,
        }
    }

    const EARPODS_MODEL: &str = "EarPods:05AC:110B";

    /// This Mac with USB-C EarPods in, as `prints_the_real_pairings` read it
    /// on 2026-09-26: a separate input and output device per direction, each
    /// listing the other as related (the built-in mic and speakers too), plus
    /// a virtual device with both directions and an aggregate.
    fn mac() -> Vec<DeviceFacts> {
        let mut all = vec![
            dev(80, "BuiltInMicrophoneDevice", "MacBook Pro Microphone", "Digital Mic", Transport::BuiltIn, false),
            dev(90, "BuiltInSpeakerDevice", "MacBook Pro Speakers", "Speakers", Transport::BuiltIn, true),
            dev(120, "AppleUSBAudioEngine:Apple, Inc.:EarPods:C6KQNJ4D77:1", "EarPods", EARPODS_MODEL, Transport::Usb, true),
            dev(
                121,
                "AppleUSBAudioEngine:Apple, Inc.:EarPods:C6KQNJ4D77:2",
                "EarPods Microphone",
                EARPODS_MODEL,
                Transport::Usb,
                false,
            ),
            dev(130, "TeamsAudioDevice", "Microsoft Teams Audio", "Teams", Transport::Virtual, true),
            dev(140, "~:AMS2_Aggregate:0", "Studio Aggregate", "", Transport::Aggregate, true),
        ];
        for (a, b) in [(80, 90), (120, 121)] {
            all.iter_mut().find(|d| d.object_id == a).unwrap().related = vec![b];
            all.iter_mut().find(|d| d.object_id == b).unwrap().related = vec![a];
        }
        all
    }

    fn unrelated(mut all: Vec<DeviceFacts>) -> Vec<DeviceFacts> {
        for d in &mut all {
            d.related.clear();
        }
        all
    }

    fn outputs(all: &[DeviceFacts]) -> Vec<DeviceFacts> {
        all.iter().filter(|d| d.has_output).cloned().collect()
    }

    /// [`pair`] over `all`'s outputs, as (object id, how).
    fn paired(input: &DeviceFacts, all: &[DeviceFacts], default_output: Option<(u32, OutputKind)>) -> Option<(u32, PairedBy)> {
        pair(input, &outputs(all), default_output).map(|(o, by)| (o.object_id, by))
    }

    fn find(all: &[DeviceFacts], id: u32) -> DeviceFacts {
        all.iter().find(|d| d.object_id == id).unwrap().clone()
    }

    const SPEAKERS: Option<(u32, OutputKind)> = Some((90, OutputKind::BuiltInSpeakers));

    #[test]
    fn a_headset_with_its_own_output_streams_pairs_with_itself() {
        let headset = dev(200, "USB-Jabra-1", "Jabra Evolve2 65", "Jabra:0B0E", Transport::Usb, true);
        let mut all = mac();
        all.push(headset.clone());
        assert_eq!(paired(&headset, &all, SPEAKERS), Some((200, PairedBy::SameDevice)));
    }

    #[test]
    fn airpods_over_bluetooth_pair_with_themselves() {
        let airpods = dev(300, "AC-90-85:input", "Liam's AirPods Pro", "AirPodsPro", Transport::Bluetooth, true);
        let mut all = mac();
        all.push(airpods.clone());
        assert_eq!(paired(&airpods, &all, SPEAKERS), Some((300, PairedBy::SameDevice)));
        // Even when the system default is other headphones: the chosen
        // Bluetooth mic brings its own earpieces.
        assert_eq!(paired(&airpods, &all, Some((120, OutputKind::WiredHeadphones))), Some((300, PairedBy::SameDevice)));
    }

    #[test]
    fn a_bluetooth_headset_split_in_two_pairs_through_related_devices() {
        let mut mic = dev(310, "BT-headset-in", "Bose QC Mic", "", Transport::Bluetooth, false);
        let out = dev(311, "BT-headset-out", "Bose QC", "", Transport::Bluetooth, true);
        mic.related = vec![311];
        let mut all = mac();
        all.extend([mic.clone(), out]);
        assert_eq!(paired(&mic, &all, SPEAKERS), Some((311, PairedBy::Related)));
    }

    #[test]
    fn usb_c_earpods_pair_as_related_devices() {
        let all = mac();
        assert_eq!(paired(&find(&all, 121), &all, SPEAKERS), Some((120, PairedBy::Related)));
        // Without the related-devices property: by the model UID.
        let all = unrelated(mac());
        assert_eq!(paired(&find(&all, 121), &all, SPEAKERS), Some((120, PairedBy::ModelUid)));
    }

    #[test]
    fn two_identical_headsets_pair_by_unit_and_never_guess() {
        let mut all = unrelated(mac());
        all.push(dev(122, "AppleUSBAudioEngine:Apple, Inc.:EarPods:ZZZZ:1", "EarPods", EARPODS_MODEL, Transport::Usb, true));
        all.push(dev(123, "AppleUSBAudioEngine:Apple, Inc.:EarPods:ZZZZ:2", "EarPods Microphone", EARPODS_MODEL, Transport::Usb, false));
        assert_eq!(paired(&find(&all, 121), &all, SPEAKERS), Some((120, PairedBy::ModelUid)), "the same unit's output");
        assert_eq!(paired(&find(&all, 123), &all, SPEAKERS), Some((122, PairedBy::ModelUid)));
        // Same model, no unit to tell them apart by: no guess.
        let mut odd = find(&all, 123);
        odd.uid = "something-else".into();
        assert!(paired(&odd, &all, SPEAKERS).is_none());
    }

    #[test]
    fn the_built_in_mic_never_pulls_speech_to_the_speakers() {
        let all = mac();
        let mut mic = find(&all, 80);
        // Even if it looked like one device with both directions.
        mic.has_output = true;
        mic.related = vec![90];
        mic.model_uid = "Speakers".into();
        assert!(paired(&mic, &all, Some((300, OutputKind::Bluetooth))).is_none());
        assert!(paired(&mic, &all, SPEAKERS).is_none());
    }

    #[test]
    fn virtual_and_aggregate_devices_never_pair() {
        let all = mac();
        assert!(pair(&find(&all, 130), &outputs(&all), SPEAKERS).is_none(), "virtual input with its own output");
        assert!(pair(&find(&all, 140), &outputs(&all), SPEAKERS).is_none(), "aggregate");
        // A USB mic whose only same-model output is virtual.
        let mic = dev(150, "usb-mic", "Some Mic", "Teams", Transport::Usb, false);
        assert!(paired(&mic, &all, SPEAKERS).is_none());
        // Continuity, displays and unknown transports: never.
        for t in [Transport::Continuity, Transport::Display, Transport::Other] {
            let d = dev(160, "x", "x", "", t, true);
            let mut all = mac();
            all.push(d.clone());
            assert!(paired(&d, &all, SPEAKERS).is_none(), "{t:?}");
        }
    }

    #[test]
    fn a_usb_mic_never_pulls_speech_off_worn_headphones() {
        // A display's mic (USB, with its own speakers) while AirPods play.
        let display = dev(170, "StudioDisplay", "Studio Display", "Display", Transport::Usb, true);
        let mut all = mac();
        all.push(display.clone());
        assert!(paired(&display, &all, Some((300, OutputKind::Bluetooth))).is_none());
        // With the laptop speakers as the default it pairs (both are there).
        assert!(paired(&display, &all, SPEAKERS).is_some());
        // Already on it: pairing is the same device either way.
        assert!(paired(&display, &all, Some((170, OutputKind::WiredHeadphones))).is_some());
    }

    #[test]
    fn a_usb_mic_only_takes_speech_off_the_built_in_speakers() {
        // A Studio Display (USB, mic + speakers) while a USB DAC or desk
        // speakers (kind Other) are the default: the user's choice stays.
        let display = dev(170, "StudioDisplay", "Studio Display", "Display", Transport::Usb, true);
        let dac = dev(180, "USB-DAC", "Schiit Modi", "Modi", Transport::Usb, true);
        let mut all = mac();
        all.extend([display.clone(), dac]);
        assert!(paired(&display, &all, Some((180, OutputKind::Other))).is_none());
        // A USB-dongle headset whose name says nothing (classified Other):
        // worn, and kept.
        let jabra = dev(190, "USB-Jabra-Link", "Jabra Link 380", "Jabra:Link", Transport::Usb, true);
        all.push(jabra);
        assert!(paired(&display, &all, Some((190, OutputKind::Other))).is_none());
        // A monitor's speakers over HDMI the user picked: kept too.
        assert!(paired(&display, &all, Some((500, OutputKind::Display))).is_none());
        // A conference camera's mic with its own speaker, same rule.
        let cam = dev(195, "USB-Cam", "Meeting Owl", "Owl", Transport::Usb, true);
        all.push(cam.clone());
        assert!(paired(&cam, &all, Some((180, OutputKind::Other))).is_none());
        assert!(paired(&cam, &all, SPEAKERS).is_some());
        // Liam's case still pairs: the EarPods mic with the laptop speakers.
        assert_eq!(paired(&find(&all, 121), &all, SPEAKERS), Some((120, PairedBy::Related)));
        // Unknown default output: pairs, as before.
        assert_eq!(paired(&find(&all, 121), &all, None), Some((120, PairedBy::Related)));
        // A Bluetooth headset's mic still brings its earpieces over any default.
        let airpods = dev(300, "AC-90-85:input", "Liam's AirPods Pro", "AirPodsPro", Transport::Bluetooth, true);
        all.push(airpods.clone());
        assert_eq!(paired(&airpods, &all, Some((180, OutputKind::Other))), Some((300, PairedBy::SameDevice)));
    }

    #[test]
    fn the_choice_names_the_input_and_the_reason() {
        let all = mac();
        let c = decide_among(Some(&live(&find(&all, 121), false)), &all, SPEAKERS);
        let p = c.paired.as_ref().unwrap();
        assert_eq!((p.name.as_str(), p.object_id), ("EarPods", 120));
        assert_eq!(c.why(), "paired with the input \"EarPods Microphone\", a related device");
        assert_eq!(Choice::default().why(), "the system default");
        // No input, or one missing from the device list: the system default.
        assert_eq!(decide_among(None, &all, SPEAKERS), Choice::default());
        let mut gone = live(&find(&all, 121), false);
        gone.object_id = 999;
        assert_eq!(decide_among(Some(&gone), &all, SPEAKERS), Choice::default());
    }

    fn stored(d: &DeviceFacts) -> StoredDevice {
        StoredDevice {
            uid: d.uid.clone(),
            model_uid: d.model_uid.clone(),
            name: d.name.clone(),
            transport: d.transport,
            first_seen_at: String::new(),
            last_seen_at: String::new(),
        }
    }

    /// The output the TTS would open for this input choice (None: the
    /// system default).
    fn speech_for(all: &[DeviceFacts], customised: bool, order: &[u32], override_id: Option<u32>) -> Option<String> {
        speech_during(all, None, customised, order, override_id)
    }

    #[test]
    fn the_output_follows_the_override_and_the_priority_order() {
        let all = mac();
        // Nothing chosen: the default input (the built-in mic) → the default.
        assert_eq!(speech_for(&all, false, &[], None), None);
        // The "for now" override on the EarPods mic → the EarPods.
        assert_eq!(speech_for(&all, false, &[], Some(121)).as_deref(), Some("EarPods"));
        // Cleared again → the default.
        assert_eq!(speech_for(&all, false, &[], None), None);
        // EarPods first in the order → the EarPods; the built-in first → the default.
        assert_eq!(speech_for(&all, true, &[121, 80], None).as_deref(), Some("EarPods"));
        assert_eq!(speech_for(&all, true, &[80, 121], None), None);
        // The override beats the order either way.
        assert_eq!(speech_for(&all, true, &[121, 80], Some(80)), None);
        // The EarPods unplugged: the order falls through to the built-in.
        let unplugged: Vec<DeviceFacts> = all.iter().filter(|d| ![120, 121].contains(&d.object_id)).cloned().collect();
        let inputs = vec![live(&find(&all, 80), true)];
        let order = vec![stored(&find(&all, 121)), stored(&find(&all, 80))];
        let pick = pick_with_override(true, &order, &inputs, &[], None);
        assert_eq!(decide_among(chosen_live(pick.as_ref(), &inputs), &unplugged, SPEAKERS), Choice::default());
    }

    /// The output the TTS would open while a stream captures on `in_use`
    /// (a uid; None: no stream), with the override set to `override_id`.
    fn speech_during(all: &[DeviceFacts], in_use: Option<u32>, customised: bool, order: &[u32], override_id: Option<u32>) -> Option<String> {
        let inputs: Vec<LiveInput> = all.iter().filter(|d| [80, 121].contains(&d.object_id)).map(|d| live(d, d.object_id == 80)).collect();
        let order: Vec<StoredDevice> = order.iter().map(|&id| stored(&find(all, id))).collect();
        let override_uid = override_id.map(|id| find(all, id).uid);
        let in_use_uid = in_use.map(|id| find(all, id).uid);
        let pick = pick_with_override(customised, &order, &inputs, &[], override_uid.as_deref());
        decide_among(paired_input(in_use_uid.as_deref(), pick.as_ref(), &inputs), all, SPEAKERS).paired.map(|p| p.name)
    }

    #[test]
    fn a_live_stream_pairs_with_the_mic_it_captures_on_not_the_pick() {
        let all = mac();
        // A voice session on the EarPods mic; the override moves to the
        // MacBook mic (the session keeps its mic): speech stays on the EarPods.
        assert_eq!(speech_during(&all, Some(121), false, &[], Some(80)).as_deref(), Some("EarPods"));
        // Or the built-in is put first in the order: the same.
        assert_eq!(speech_during(&all, Some(121), true, &[80, 121], None).as_deref(), Some("EarPods"));
        // The reverse: a session on the built-in mic, the EarPods put first:
        // speech doesn't jump onto the EarPods the session isn't listening on.
        assert_eq!(speech_during(&all, Some(80), true, &[121, 80], None), None);
        assert_eq!(speech_during(&all, Some(80), false, &[], Some(121)), None);
        // No stream (read-aloud): the pick, as before.
        assert_eq!(speech_during(&all, None, false, &[], Some(121)).as_deref(), Some("EarPods"));
        assert_eq!(speech_during(&all, None, true, &[80, 121], None), None);
        // The in-use mic is gone from the list: the pick.
        let inputs = vec![live(&find(&all, 80), true)];
        assert_eq!(paired_input(Some("gone"), None, &inputs).map(|d| d.object_id), Some(80));
    }

    #[test]
    fn a_resolution_keeps_the_watch_in_step_with_the_default_output() {
        let _turn = PAIRING_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        note_pairing(&Choice::default());
        let mut session = subscribe();
        let all = mac();
        let earpods_mic = live(&find(&all, 121), false);
        // The pick is the EarPods, the default output AirPods (worn): the
        // supervisor publishes the system default.
        let airpods_default = Some((300, OutputKind::Bluetooth));
        note_pairing(&decide_among(Some(&earpods_mic), &all, airpods_default));
        assert!(!session.has_changed().unwrap());
        // The output moves to the speakers; the session's route watcher
        // re-resolves (resolve publishes) and moves TTS to the EarPods. Its
        // own publish doesn't wake it again.
        let re_resolved = decide_among(Some(&earpods_mic), &all, SPEAKERS);
        assert!(re_resolved.paired.is_some());
        note_pairing(&re_resolved);
        mark_seen_if_current(&mut session, &re_resolved);
        assert!(!session.has_changed().unwrap(), "its own publish: no second wake");
        // A priority / override edit makes the pick the built-in mic: the
        // supervisor publishes the system default, and now it IS a change.
        note_pairing(&Choice::default());
        assert!(session.has_changed().unwrap(), "the output follows the pick back");
        // Marking seen against a stale choice leaves a newer publish unseen.
        mark_seen_if_current(&mut session, &re_resolved);
        assert!(session.has_changed().unwrap());
        note_pairing(&Choice::default());
    }

    #[test]
    fn a_pairing_change_is_published_once() {
        let _turn = PAIRING_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        note_pairing(&Choice::default());
        let mut rx = subscribe();
        let all = mac();
        let earpods = decide_among(Some(&live(&find(&all, 121), false)), &all, SPEAKERS);
        note_pairing(&earpods);
        assert!(rx.has_changed().unwrap());
        assert_eq!(rx.borrow_and_update().as_deref(), Some("AppleUSBAudioEngine:Apple, Inc.:EarPods:C6KQNJ4D77:1"));
        note_pairing(&earpods);
        assert!(!rx.has_changed().unwrap(), "the same pairing again: no wake");
        note_pairing(&Choice::default());
        assert!(rx.has_changed().unwrap());
        assert_eq!(*rx.borrow_and_update(), None);
    }

    /// Prints this Mac's devices and what each input would pair with
    /// (property reads only; nothing is opened or played).
    #[test]
    #[ignore = "reads this Mac's CoreAudio devices; run by hand with --ignored --nocapture"]
    #[cfg(target_os = "macos")]
    fn prints_the_real_pairings() {
        let all = ca::all_facts();
        for d in &all {
            println!("{d:?}");
        }
        let default_output = super::super::output_route::ffi::default_output_device()
            .ok()
            .map(|id| (id, super::super::output_route::route_of(id).kind));
        println!("default output: {default_output:?}");
        for input in crate::audio::input_devices::enumerate() {
            println!("{:?} → {}", input.name, decide_among(Some(&input), &all, default_output).why());
        }
    }
}
