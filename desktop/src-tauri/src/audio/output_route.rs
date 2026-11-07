//! Where speech output goes right now: built-in speakers, wired headphones,
//! Bluetooth (AirPods …), a display (HDMI / DisplayPort) or something else.
//!
//! The voice session records it because echo depends on it: speakers put the
//! agent's voice back into the mic, headphones mostly don't. It is read from
//! CoreAudio properties of the default output device:
//! - `kAudioDevicePropertyTransportType` (built-in, Bluetooth, HDMI, …);
//! - `kAudioDevicePropertyDataSource` on the output scope, for built-in
//!   devices: `ispk` (internal speakers) vs `hdpn` (headphones). Intel Macs
//!   switch the built-in device's data source when headphones are plugged in;
//!   Apple silicon Macs instead expose "External Headphones" as its own
//!   built-in device (data source `hdpn`) and make it the default.
//!
//! [`current`] is a cheap re-query (a handful of property reads, no device
//! IO). [`RouteWatcher`] calls back when the default output device changes or
//! a built-in device's data source flips; re-query from there.

use serde::Serialize;

/// What kind of output the default device is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputKind {
    BuiltInSpeakers,
    /// The headphone jack, or a USB headset / USB-C EarPods (by name).
    WiredHeadphones,
    /// Bluetooth Classic or LE: AirPods, headsets, and Bluetooth speakers.
    Bluetooth,
    /// HDMI or DisplayPort (a monitor's or TV's speakers).
    Display,
    /// USB, AirPlay, aggregate / virtual devices, Thunderbolt docks, unknown.
    Other,
}

/// The default output device and what it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputRoute {
    pub kind: OutputKind,
    /// The device's name, e.g. "MacBook Pro Speakers", "Liam's AirPods Pro".
    pub name: String,
    /// CoreAudio transport type as a four-character code ("bltn", "blue", …).
    pub transport: String,
    /// The output data source as a four-character code ("ispk", "hdpn"), for
    /// devices that have one.
    pub data_source: Option<String>,
    /// CoreAudio device id (stable while the device stays connected).
    #[serde(skip)]
    pub device_id: u32,
}

const fn fourcc(s: &[u8; 4]) -> u32 {
    ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | s[3] as u32
}

/// `kAudioDeviceTransportType*` values this module distinguishes.
#[allow(dead_code)] // the ones classify() lumps into Other, named for readers
pub mod transport {
    use super::fourcc;
    pub const BUILT_IN: u32 = fourcc(b"bltn");
    pub const BLUETOOTH: u32 = fourcc(b"blue");
    pub const BLUETOOTH_LE: u32 = fourcc(b"blea");
    pub const HDMI: u32 = fourcc(b"hdmi");
    pub const DISPLAY_PORT: u32 = fourcc(b"dprt");
    pub const USB: u32 = fourcc(b"usb ");
    pub const AIRPLAY: u32 = fourcc(b"airp");
    pub const AGGREGATE: u32 = fourcc(b"grup");
    pub const VIRTUAL: u32 = fourcc(b"virt");
}

/// Built-in output data sources.
pub mod data_source {
    use super::fourcc;
    pub const INTERNAL_SPEAKER: u32 = fourcc(b"ispk");
    pub const HEADPHONES: u32 = fourcc(b"hdpn");
}

/// A four-character code as text ("bltn"); unprintable bytes as '?', and 0
/// as "".
pub fn fourcc_str(code: u32) -> String {
    if code == 0 {
        return String::new();
    }
    code.to_be_bytes()
        .iter()
        .map(|&b| if (0x20..0x7f).contains(&b) { b as char } else { '?' })
        .collect()
}

/// Names that mark a device as something worn on the head.
fn sounds_like_headphones(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["headphone", "headset", "earpods", "earphone", "earbud"].iter().any(|k| n.contains(k))
}

/// The pure mapping from CoreAudio properties to a kind.
pub fn classify(transport_type: u32, data_source: Option<u32>, name: &str) -> OutputKind {
    match transport_type {
        transport::BLUETOOTH | transport::BLUETOOTH_LE => OutputKind::Bluetooth,
        transport::HDMI | transport::DISPLAY_PORT => OutputKind::Display,
        transport::BUILT_IN => match data_source {
            Some(data_source::HEADPHONES) => OutputKind::WiredHeadphones,
            Some(data_source::INTERNAL_SPEAKER) => OutputKind::BuiltInSpeakers,
            // A built-in line out or some other jack: not the speakers.
            Some(_) => OutputKind::Other,
            // No data source property: go by the name ("External Headphones"
            // on Apple silicon), else it's the speakers.
            None if sounds_like_headphones(name) => OutputKind::WiredHeadphones,
            None => OutputKind::BuiltInSpeakers,
        },
        // USB-C EarPods and USB headsets have no data source to go by.
        transport::USB if sounds_like_headphones(name) => OutputKind::WiredHeadphones,
        _ => OutputKind::Other,
    }
}

/// The route of the current default output device. Blocking CoreAudio
/// property reads (fast, but keep them off the audio thread).
#[cfg(target_os = "macos")]
pub fn current() -> Result<OutputRoute, String> {
    Ok(route_of(ffi::default_output_device()?))
}

/// The route of output device `id` (the default or any other). Blocking
/// CoreAudio property reads, like [`current`].
#[cfg(target_os = "macos")]
pub fn route_of(id: u32) -> OutputRoute {
    let transport_type = ffi::get_u32(id, ffi::TRANSPORT_TYPE, ffi::SCOPE_GLOBAL).unwrap_or(0);
    let data_source = ffi::get_u32(id, ffi::DATA_SOURCE, ffi::SCOPE_OUTPUT);
    let name = ffi::device_name(id).unwrap_or_default();
    OutputRoute {
        kind: classify(transport_type, data_source, &name),
        name,
        transport: fourcc_str(transport_type),
        data_source: data_source.map(fourcc_str),
        device_id: id,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn current() -> Result<OutputRoute, String> {
    Err("output route detection is macOS-only".into())
}

/// Calls back when the output route may have changed: the default output
/// device changed, or a built-in output's data source flipped (headphones in
/// or out on Intel Macs). The callback runs on a CoreAudio notification
/// thread: keep it short (send on a channel, set a flag) and call
/// [`current`] from your own thread. Listening stops when this is dropped.
pub struct RouteWatcher {
    #[cfg(target_os = "macos")]
    #[allow(dead_code)] // held for its Drop, which removes the listeners
    inner: ffi::Watcher,
}

impl RouteWatcher {
    #[cfg(target_os = "macos")]
    pub fn start(on_change: impl Fn() + Send + Sync + 'static) -> Result<Self, String> {
        Ok(Self { inner: ffi::Watcher::start(Box::new(on_change))? })
    }

    #[cfg(not(target_os = "macos"))]
    pub fn start(_on_change: impl Fn() + Send + Sync + 'static) -> Result<Self, String> {
        Err("output route detection is macOS-only".into())
    }

    /// How many CoreAudio listeners are registered (1 for the default device,
    /// plus one per built-in output with a data source).
    #[cfg(target_os = "macos")]
    pub fn listener_count(&self) -> usize {
        self.inner.registrations.len()
    }
}

/// The CoreAudio property helpers, shared with the input-device list
/// (`audio::input_devices`), which reads the same kinds of properties off
/// every input device and listens on the same system object.
#[cfg(target_os = "macos")]
pub(crate) mod ffi {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use super::fourcc;

    pub type AudioObjectID = u32;
    type OsStatus = i32;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct PropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    type ListenerProc = extern "C" fn(AudioObjectID, u32, *const PropertyAddress, *mut c_void) -> OsStatus;

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            object: AudioObjectID,
            address: *const PropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: *mut u32,
            data: *mut c_void,
        ) -> OsStatus;
        fn AudioObjectGetPropertyDataSize(
            object: AudioObjectID,
            address: *const PropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: *mut u32,
        ) -> OsStatus;
        fn AudioObjectHasProperty(object: AudioObjectID, address: *const PropertyAddress) -> u8;
        fn AudioObjectAddPropertyListener(
            object: AudioObjectID,
            address: *const PropertyAddress,
            listener: ListenerProc,
            client_data: *mut c_void,
        ) -> OsStatus;
        fn AudioObjectRemovePropertyListener(
            object: AudioObjectID,
            address: *const PropertyAddress,
            listener: ListenerProc,
            client_data: *mut c_void,
        ) -> OsStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringGetCString(s: *const c_void, buf: *mut u8, size: isize, encoding: u32) -> u8;
        fn CFRelease(cf: *const c_void);
    }

    pub const SYSTEM_OBJECT: AudioObjectID = 1;
    pub const SCOPE_GLOBAL: u32 = fourcc(b"glob");
    pub const SCOPE_OUTPUT: u32 = fourcc(b"outp");
    const ELEMENT_MAIN: u32 = 0;
    const DEFAULT_OUTPUT_DEVICE: u32 = fourcc(b"dOut");
    pub const DEVICES: u32 = fourcc(b"dev#");
    pub const TRANSPORT_TYPE: u32 = fourcc(b"tran");
    pub const DATA_SOURCE: u32 = fourcc(b"ssrc");
    const OBJECT_NAME: u32 = fourcc(b"lnam");
    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    pub fn addr(selector: u32, scope: u32) -> PropertyAddress {
        PropertyAddress { selector, scope, element: ELEMENT_MAIN }
    }

    /// A u32 property, or None when the object doesn't have it.
    pub fn get_u32(object: AudioObjectID, selector: u32, scope: u32) -> Option<u32> {
        let a = addr(selector, scope);
        // SAFETY: plain property reads into a correctly sized buffer.
        unsafe {
            if AudioObjectHasProperty(object, &a) == 0 {
                return None;
            }
            let mut value: u32 = 0;
            let mut size = std::mem::size_of::<u32>() as u32;
            let status = AudioObjectGetPropertyData(object, &a, 0, std::ptr::null(), &mut size, &mut value as *mut u32 as *mut c_void);
            (status == 0 && size == 4).then_some(value)
        }
    }

    pub fn default_output_device() -> Result<AudioObjectID, String> {
        match get_u32(SYSTEM_OBJECT, DEFAULT_OUTPUT_DEVICE, SCOPE_GLOBAL) {
            Some(0) | None => Err("no default output device".into()),
            Some(id) => Ok(id),
        }
    }

    pub fn device_name(object: AudioObjectID) -> Option<String> {
        get_string(object, OBJECT_NAME, SCOPE_GLOBAL)
    }

    /// An f32 property on one element (a volume control's dB), or None when
    /// the object doesn't have it there.
    pub fn get_f32(object: AudioObjectID, selector: u32, scope: u32, element: u32) -> Option<f32> {
        let a = PropertyAddress { selector, scope, element };
        // SAFETY: plain property reads into a correctly sized buffer.
        unsafe {
            if AudioObjectHasProperty(object, &a) == 0 {
                return None;
            }
            let mut value: f32 = 0.0;
            let mut size = std::mem::size_of::<f32>() as u32;
            let status = AudioObjectGetPropertyData(object, &a, 0, std::ptr::null(), &mut size, &mut value as *mut f32 as *mut c_void);
            (status == 0 && size == 4).then_some(value)
        }
    }

    /// The byte size of a property's value, or None when the object doesn't
    /// have it (or the query fails).
    pub fn property_size(object: AudioObjectID, selector: u32, scope: u32) -> Option<u32> {
        let a = addr(selector, scope);
        // SAFETY: an existence check and a size query.
        unsafe {
            if AudioObjectHasProperty(object, &a) == 0 {
                return None;
            }
            let mut size = 0u32;
            (AudioObjectGetPropertyDataSize(object, &a, 0, std::ptr::null(), &mut size) == 0).then_some(size)
        }
    }

    /// A CFString property as a String (a device's name, UID, model UID).
    pub fn get_string(object: AudioObjectID, selector: u32, scope: u32) -> Option<String> {
        let a = addr(selector, scope);
        // SAFETY: the property is a CFStringRef we own (+1) and release.
        unsafe {
            let mut cf: *const c_void = std::ptr::null();
            let mut size = std::mem::size_of::<*const c_void>() as u32;
            let status = AudioObjectGetPropertyData(object, &a, 0, std::ptr::null(), &mut size, &mut cf as *mut *const c_void as *mut c_void);
            if status != 0 || cf.is_null() {
                return None;
            }
            let mut buf = [0u8; 512];
            let ok = CFStringGetCString(cf, buf.as_mut_ptr(), buf.len() as isize, CF_STRING_ENCODING_UTF8) != 0;
            CFRelease(cf);
            if !ok {
                return None;
            }
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            Some(String::from_utf8_lossy(&buf[..end]).into_owned())
        }
    }

    pub fn all_devices() -> Vec<AudioObjectID> {
        get_u32_array(SYSTEM_OBJECT, DEVICES, SCOPE_GLOBAL)
    }

    /// An array-of-u32 property (object ids), empty when the object doesn't
    /// have it or the read fails.
    pub fn get_u32_array(object: AudioObjectID, selector: u32, scope: u32) -> Vec<u32> {
        let a = addr(selector, scope);
        // SAFETY: an existence check, a size query, then a read into a buffer
        // of that size.
        unsafe {
            if AudioObjectHasProperty(object, &a) == 0 {
                return Vec::new();
            }
            let mut size = 0u32;
            if AudioObjectGetPropertyDataSize(object, &a, 0, std::ptr::null(), &mut size) != 0 {
                return Vec::new();
            }
            let mut ids = vec![0u32; size as usize / 4];
            if ids.is_empty() {
                return ids;
            }
            if AudioObjectGetPropertyData(object, &a, 0, std::ptr::null(), &mut size, ids.as_mut_ptr() as *mut c_void) != 0 {
                return Vec::new();
            }
            ids.truncate(size as usize / 4);
            ids
        }
    }

    /// Shared with the CoreAudio listener through its client-data pointer.
    struct State {
        alive: AtomicBool,
        on_change: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    }

    extern "C" fn listener(_object: AudioObjectID, _n: u32, _addrs: *const PropertyAddress, client: *mut c_void) -> OsStatus {
        // SAFETY: `client` is a leaked Arc<State> (see Watcher::start), never freed.
        let state = unsafe { &*(client as *const State) };
        if state.alive.load(Ordering::Acquire) {
            if let Ok(guard) = state.on_change.try_lock() {
                if let Some(cb) = guard.as_ref() {
                    cb();
                }
            }
        }
        0
    }

    pub struct Watcher {
        state: *const State,
        pub registrations: Vec<(AudioObjectID, PropertyAddress)>,
    }

    // SAFETY: `state` points at a leaked Arc<State>, which is Send + Sync.
    unsafe impl Send for Watcher {}
    unsafe impl Sync for Watcher {}

    impl Watcher {
        /// A watcher with no listeners yet: [`add`](Self::add) them.
        pub fn new(on_change: Box<dyn Fn() + Send + Sync>) -> Self {
            // Leaked on purpose: CoreAudio doesn't promise that a callback in
            // flight has returned when RemovePropertyListener does, so the
            // client data must outlive it. Drop empties it (and frees the
            // closure's captures); what stays is two words.
            let state = Arc::into_raw(Arc::new(State { alive: AtomicBool::new(true), on_change: Mutex::new(Some(on_change)) }));
            Watcher { state, registrations: Vec::new() }
        }

        /// The output-route watcher: the default output device, plus every
        /// device's output data source.
        pub fn start(on_change: Box<dyn Fn() + Send + Sync>) -> Result<Self, String> {
            let mut watcher = Self::new(on_change);
            watcher.add(SYSTEM_OBJECT, addr(DEFAULT_OUTPUT_DEVICE, SCOPE_GLOBAL))?;
            // Built-in outputs whose data source can flip (Intel headphone
            // jack). Apple silicon's jack is its own device, covered by the
            // default-device listener above.
            for id in all_devices() {
                let a = addr(DATA_SOURCE, SCOPE_OUTPUT);
                // SAFETY: a property existence check.
                if unsafe { AudioObjectHasProperty(id, &a) } != 0 {
                    let _ = watcher.add(id, a);
                }
            }
            Ok(watcher)
        }

        pub fn add(&mut self, object: AudioObjectID, a: PropertyAddress) -> Result<(), String> {
            // SAFETY: `self.state` stays valid forever (leaked).
            let status = unsafe { AudioObjectAddPropertyListener(object, &a, listener, self.state as *mut c_void) };
            if status != 0 {
                return Err(format!("AudioObjectAddPropertyListener failed ({status})"));
            }
            self.registrations.push((object, a));
            Ok(())
        }
    }

    impl Drop for Watcher {
        fn drop(&mut self) {
            for (object, a) in self.registrations.drain(..) {
                // SAFETY: the same (object, address, proc, client data) as added.
                unsafe {
                    AudioObjectRemovePropertyListener(object, &a, listener, self.state as *mut c_void);
                }
            }
            // SAFETY: the leaked Arc is still alive (never freed).
            let state = unsafe { &*self.state };
            state.alive.store(false, Ordering::Release);
            if let Ok(mut cb) = state.on_change.lock() {
                cb.take();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_the_routes_that_matter_for_echo() {
        use data_source::*;
        use transport::*;
        assert_eq!(classify(BUILT_IN, Some(INTERNAL_SPEAKER), "MacBook Pro Speakers"), OutputKind::BuiltInSpeakers);
        assert_eq!(classify(BUILT_IN, Some(HEADPHONES), "Built-in Output"), OutputKind::WiredHeadphones);
        // Apple silicon: the jack is its own built-in device.
        assert_eq!(classify(BUILT_IN, Some(HEADPHONES), "External Headphones"), OutputKind::WiredHeadphones);
        assert_eq!(classify(BUILT_IN, None, "External Headphones"), OutputKind::WiredHeadphones);
        assert_eq!(classify(BUILT_IN, None, "MacBook Air Speakers"), OutputKind::BuiltInSpeakers);
        assert_eq!(classify(BUILT_IN, Some(fourcc(b"lnot")), "Built-in Line Output"), OutputKind::Other);
        assert_eq!(classify(BLUETOOTH, None, "Liam's AirPods Pro"), OutputKind::Bluetooth);
        assert_eq!(classify(BLUETOOTH_LE, None, "Hearing aid"), OutputKind::Bluetooth);
        assert_eq!(classify(HDMI, None, "LG TV"), OutputKind::Display);
        assert_eq!(classify(DISPLAY_PORT, None, "Studio Display"), OutputKind::Display);
        assert_eq!(classify(USB, None, "EarPods"), OutputKind::WiredHeadphones);
        assert_eq!(classify(USB, None, "Jabra Headset"), OutputKind::WiredHeadphones);
        assert_eq!(classify(USB, None, "Scarlett 2i2 USB"), OutputKind::Other);
        for t in [AIRPLAY, AGGREGATE, VIRTUAL, 0] {
            assert_eq!(classify(t, None, "headphones?"), OutputKind::Other, "{}", fourcc_str(t));
        }
    }

    #[test]
    fn four_character_codes_read_back() {
        assert_eq!(fourcc_str(transport::BUILT_IN), "bltn");
        assert_eq!(fourcc_str(transport::USB), "usb ");
        assert_eq!(fourcc_str(data_source::HEADPHONES), "hdpn");
        assert_eq!(fourcc_str(0), "");
        assert_eq!(fourcc_str(0x0102_6869), "??hi");
    }

    #[test]
    fn serializes_camel_case() {
        let route = OutputRoute {
            kind: OutputKind::WiredHeadphones,
            name: "External Headphones".into(),
            transport: "bltn".into(),
            data_source: Some("hdpn".into()),
            device_id: 73,
        };
        assert_eq!(
            serde_json::to_value(&route).unwrap(),
            serde_json::json!({"kind":"wiredHeadphones","name":"External Headphones","transport":"bltn","dataSource":"hdpn"})
        );
    }

    /// Reads the real default output device (property reads only; no audio
    /// is played and no stream is opened).
    #[test]
    #[ignore = "reads this Mac's CoreAudio devices; run by hand with --ignored --nocapture"]
    #[cfg(target_os = "macos")]
    fn reads_the_real_default_output() {
        let route = current().expect("a default output device");
        println!("{route:?}");
        assert!(!route.name.is_empty());
        let watcher = RouteWatcher::start(|| println!("route changed")).expect("listeners");
        assert!(watcher.listener_count() >= 1);
    }
}
