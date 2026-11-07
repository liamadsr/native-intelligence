//! Audio taps: a copy of a live stream, handed from its realtime callback to
//! another thread through a lock-free SPSC ring.
//!
//! ```text
//! audio callback ──TapSlot──▶ TapWriter ══ring══▶ TapReader (voice session / AEC)
//! ```
//!
//! Two taps exist: the raw mic at the device rate
//! ([`MicCapture::install_raw_tap`](super::mic_capture::MicCapture::install_raw_tap))
//! and the playback reference, every sample the speech output actually
//! renders ([`Player::set_tap`](super::playback::Player::set_tap)).
//!
//! The [`TapSlot`] is how a tap is installed into, and removed from, a stream
//! whose callback is already running:
//! - the callback side ([`TapSlot::acquire`]) never waits: one relaxed load
//!   when nothing is installed, else one compare-and-swap. If the controller
//!   happens to hold the slot at that instant (only for the few instructions
//!   of an install or removal), the callback skips the tap for that one
//!   buffer;
//! - the callback never frees anything: [`TapSlot::replace`] hands the old
//!   writer back to the controller, which drops it on its own thread;
//! - a full ring drops the newest frames (counted) instead of blocking.
//!
//! The reader learns the stream's rate from [`TapReader::rate`]. When the
//! stream behind a tap is replaced (the mic reopened, the output device
//! reopened) the rate may change and there is a gap: [`TapReader::epoch`]
//! changes, and the reader should [`clear`](TapReader::clear) and rebuild
//! whatever depends on the rate.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

/// What the writer's side tells the reader.
struct TapInfo {
    /// Sample rate of the frames being pushed now (0 = not installed yet).
    rate: AtomicU32,
    /// Bumped each time the tap is (re)installed on a stream.
    epoch: AtomicU64,
    /// Frames lost to a full ring or a contended slot.
    dropped: AtomicU64,
}

/// A new tap ring of `capacity` mono frames: install the writer, keep the
/// reader. Allocates; call off the realtime thread.
pub fn tap_channel(capacity: usize) -> (TapWriter, TapReader) {
    let (prod, cons) = HeapRb::<f32>::new(capacity.max(1)).split();
    let info = Arc::new(TapInfo { rate: AtomicU32::new(0), epoch: AtomicU64::new(0), dropped: AtomicU64::new(0) });
    (TapWriter { prod, info: info.clone(), pending_drops: 0 }, TapReader { cons, info })
}

/// The producer end. Lives in a [`TapSlot`] while installed.
pub struct TapWriter {
    prod: HeapProd<f32>,
    info: Arc<TapInfo>,
    /// Drops counted during one acquire, published on release.
    pending_drops: u64,
}

impl TapWriter {
    /// Push one frame; dropped (and counted) when the ring is full.
    #[inline]
    pub fn push(&mut self, sample: f32) {
        if self.prod.try_push(sample).is_err() {
            self.pending_drops += 1;
        }
    }

    /// Push frames; what doesn't fit is dropped (and counted).
    #[inline]
    pub fn push_slice(&mut self, samples: &[f32]) {
        let n = self.prod.push_slice(samples);
        self.pending_drops += (samples.len() - n) as u64;
    }

    /// Push `n` frames of silence.
    #[inline]
    pub fn push_silence(&mut self, n: usize) {
        let room = self.prod.vacant_len().min(n);
        for _ in 0..room {
            let _ = self.prod.try_push(0.0);
        }
        self.pending_drops += (n - room) as u64;
    }

    fn publish_drops(&mut self) {
        if self.pending_drops > 0 {
            self.info.dropped.fetch_add(self.pending_drops, Ordering::Relaxed);
            self.pending_drops = 0;
        }
    }

    /// Mark the start of a stream at `rate`: the reader sees a new epoch.
    pub(crate) fn begin_stream(&self, rate: u32) {
        self.info.rate.store(rate, Ordering::Release);
        self.info.epoch.fetch_add(1, Ordering::AcqRel);
    }
}

/// The consumer end, held by whoever wants the audio.
pub struct TapReader {
    cons: HeapCons<f32>,
    info: Arc<TapInfo>,
}

impl TapReader {
    /// Rate of the stream feeding the tap now; 0 until it is installed.
    pub fn rate(&self) -> u32 {
        self.info.rate.load(Ordering::Acquire)
    }

    /// Changes whenever the tap is installed on a (new) stream. On a change,
    /// [`clear`](Self::clear) and re-read [`rate`](Self::rate).
    pub fn epoch(&self) -> u64 {
        self.info.epoch.load(Ordering::Acquire)
    }

    /// Frames lost so far (full ring, or the rare contended buffer).
    pub fn dropped(&self) -> u64 {
        self.info.dropped.load(Ordering::Relaxed)
    }

    /// Frames waiting.
    #[allow(dead_code)] // diagnostics and tests
    pub fn available(&self) -> usize {
        self.cons.occupied_len()
    }

    /// Pop up to `out.len()` frames; returns how many.
    pub fn pop_slice(&mut self, out: &mut [f32]) -> usize {
        self.cons.pop_slice(out)
    }

    /// Discard everything waiting.
    pub fn clear(&mut self) -> usize {
        self.cons.clear()
    }
}

/// An installable tap point inside a stream's callback. See the module docs.
pub struct TapSlot {
    /// Fast path for "nothing installed": the callback reads only this.
    installed: AtomicBool,
    /// Held by whichever side is touching `writer` right now.
    busy: AtomicBool,
    writer: UnsafeCell<Option<TapWriter>>,
}

// SAFETY: `writer` is only touched while `busy` is held (acquired with a
// compare-and-swap, released with a Release store), so there is never more
// than one reference to it at a time, from any thread.
unsafe impl Sync for TapSlot {}
unsafe impl Send for TapSlot {}

impl Default for TapSlot {
    fn default() -> Self {
        Self::new()
    }
}

impl TapSlot {
    pub fn new() -> Self {
        Self { installed: AtomicBool::new(false), busy: AtomicBool::new(false), writer: UnsafeCell::new(None) }
    }

    /// Whether a writer is installed.
    pub fn is_installed(&self) -> bool {
        self.installed.load(Ordering::Relaxed)
    }

    /// Controller side (never the audio thread): install `writer` (or remove
    /// with `None`) and get the previous one back, to drop here. Waits only
    /// for a callback that is inside [`acquire`](Self::acquire) at this
    /// instant, which holds the slot for one buffer's worth of pushes.
    pub fn replace(&self, writer: Option<TapWriter>) -> Option<TapWriter> {
        self.lock_spin();
        // SAFETY: `busy` is held.
        let old = unsafe { std::mem::replace(&mut *self.writer.get(), writer) };
        // SAFETY: `busy` is held.
        let now = unsafe { (*self.writer.get()).is_some() };
        self.installed.store(now, Ordering::Release);
        self.busy.store(false, Ordering::Release);
        old
    }

    /// Controller side: mark the start of a new stream at `rate` on the
    /// installed writer, if any.
    pub fn begin_stream(&self, rate: u32) {
        self.lock_spin();
        // SAFETY: `busy` is held.
        if let Some(w) = unsafe { (*self.writer.get()).as_ref() } {
            w.begin_stream(rate);
        }
        self.busy.store(false, Ordering::Release);
    }

    fn lock_spin(&self) {
        let mut spins = 0u32;
        while self.busy.compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed).is_err() {
            spins += 1;
            if spins < 64 {
                std::hint::spin_loop();
            } else {
                std::thread::yield_now();
            }
        }
    }

    /// Realtime side: the installed writer for this buffer, or `None` when
    /// nothing is installed or the slot is held elsewhere right now (an
    /// install or removal in progress: this one buffer misses the tap, which
    /// only happens at install/removal time). Never waits, never allocates.
    /// Keep the guard for one callback's pushes only.
    #[inline]
    pub fn acquire(&self) -> Option<TapGuard<'_>> {
        if !self.installed.load(Ordering::Relaxed) {
            return None;
        }
        if self.busy.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed).is_err() {
            return None;
        }
        // SAFETY: `busy` is held until the guard drops.
        match unsafe { (*self.writer.get()).as_mut() } {
            Some(writer) => Some(TapGuard { slot: self, writer }),
            None => {
                self.busy.store(false, Ordering::Release);
                None
            }
        }
    }
}

/// Exclusive use of an installed writer for one callback.
pub struct TapGuard<'a> {
    slot: &'a TapSlot,
    writer: &'a mut TapWriter,
}

impl std::ops::Deref for TapGuard<'_> {
    type Target = TapWriter;
    fn deref(&self) -> &TapWriter {
        self.writer
    }
}

impl std::ops::DerefMut for TapGuard<'_> {
    fn deref_mut(&mut self) -> &mut TapWriter {
        self.writer
    }
}

impl Drop for TapGuard<'_> {
    fn drop(&mut self) {
        self.writer.publish_drops();
        self.slot.busy.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_installed_is_a_no_op() {
        let slot = TapSlot::new();
        assert!(!slot.is_installed());
        assert!(slot.acquire().is_none());
    }

    #[test]
    fn frames_flow_and_a_full_ring_drops_the_newest() {
        let slot = TapSlot::new();
        let (w, mut r) = tap_channel(4);
        assert!(slot.replace(Some(w)).is_none());
        slot.begin_stream(48_000);
        assert_eq!((r.rate(), r.epoch()), (48_000, 1));
        {
            let mut g = slot.acquire().unwrap();
            g.push_slice(&[0.1, 0.2, 0.3]);
            g.push(0.4);
            g.push(0.5); // full
            g.push_silence(1); // full
        }
        assert_eq!(r.dropped(), 2);
        let mut out = [0.0; 8];
        assert_eq!(r.pop_slice(&mut out), 4);
        assert_eq!(&out[..4], &[0.1, 0.2, 0.3, 0.4]);
    }

    #[test]
    fn removal_hands_the_writer_back_and_stops_the_flow() {
        let slot = TapSlot::new();
        let (w, mut r) = tap_channel(16);
        slot.replace(Some(w));
        slot.acquire().unwrap().push(1.0);
        let old = slot.replace(None);
        assert!(old.is_some(), "the controller gets the writer back to drop");
        assert!(slot.acquire().is_none());
        drop(old);
        let mut out = [0.0; 4];
        assert_eq!(r.pop_slice(&mut out), 1, "what was pushed before removal is still readable");
    }

    #[test]
    fn the_callback_skips_a_buffer_instead_of_waiting() {
        let slot = TapSlot::new();
        let (w, _r) = tap_channel(16);
        slot.replace(Some(w));
        let held = slot.acquire().unwrap();
        // A second acquirer (a stale callback, or the controller mid-swap)
        // finds it busy and gets nothing, immediately.
        assert!(slot.acquire().is_none());
        drop(held);
        assert!(slot.acquire().is_some());
    }

    #[test]
    fn a_new_stream_bumps_the_epoch() {
        let slot = TapSlot::new();
        let (w, r) = tap_channel(16);
        slot.begin_stream(44_100); // nothing installed: no effect
        slot.replace(Some(w));
        slot.begin_stream(44_100);
        slot.begin_stream(16_000);
        assert_eq!((r.rate(), r.epoch()), (16_000, 2));
    }

    #[test]
    fn concurrent_install_and_push_never_lose_ordering() {
        // A "callback" thread pushes a counter while the controller swaps the
        // same writer out and back in; what arrives is increasing.
        use std::sync::atomic::AtomicBool;
        let slot = Arc::new(TapSlot::new());
        let (w, mut r) = tap_channel(1 << 16);
        slot.replace(Some(w));
        let stop = Arc::new(AtomicBool::new(false));
        let cb = {
            let slot = slot.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut n = 0.0f32;
                while !stop.load(Ordering::Relaxed) {
                    if let Some(mut g) = slot.acquire() {
                        g.push(n);
                    }
                    n += 1.0;
                }
            })
        };
        for _ in 0..2000 {
            let w = slot.replace(None).expect("installed");
            slot.replace(Some(w));
        }
        stop.store(true, Ordering::Relaxed);
        cb.join().unwrap();
        let mut out = vec![0.0; r.available()];
        r.pop_slice(&mut out);
        assert!(out.windows(2).all(|p| p[1] > p[0]), "strictly increasing");
    }
}
