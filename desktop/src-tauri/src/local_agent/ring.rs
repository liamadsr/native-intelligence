//! Each job's last events, in memory (l0-contract §4: a ring of the last 500,
//! each with a monotonic `seq`), so a reloaded page rebuilds its transcript
//! with `local_agent_events { jobId, sinceSeq }` and then follows
//! `local-agent://event`, deduping on `seq`.
//!
//! `seq` starts at 1 and never repeats within an app run, across a job's
//! resumes too, so `sinceSeq: 0` always means "everything still held". The
//! ring is not persisted: after an app relaunch a job's ring starts empty and
//! `seq` starts at 1 again (pages reload with the app anyway).

use std::collections::VecDeque;

use serde::Serialize;
use serde_json::Value;

/// Events each job keeps.
pub const RING_CAP: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub seq: u64,
    /// The launcher process the event came from (l1-contract C6), so an
    /// upload after a reload keys each event by `(runId, seq)`. Additive:
    /// `{ seq, event }` readers are unaffected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub event: Value,
}

#[derive(Debug)]
pub struct Ring {
    cap: usize,
    items: VecDeque<Entry>,
    next: u64,
}

impl Ring {
    #[cfg(test)]
    pub fn new(cap: usize) -> Self {
        Self::starting_at(cap, 1)
    }

    /// A ring whose first event gets `first` (a job whose earlier ring was
    /// dropped carries on from its last `seq`).
    pub fn starting_at(cap: usize, first: u64) -> Self {
        Self {
            cap: cap.max(1),
            items: VecDeque::new(),
            next: first.max(1),
        }
    }

    /// Append an event of run `run_id`; returns it with its `seq`.
    pub fn push(&mut self, event: Value, run_id: Option<String>) -> Entry {
        let entry = Entry {
            seq: self.next,
            run_id,
            event,
        };
        self.next += 1;
        if self.items.len() == self.cap {
            self.items.pop_front();
        }
        self.items.push_back(entry.clone());
        entry
    }

    /// Every held event with `seq > since`, oldest first.
    pub fn since(&self, since: u64) -> Vec<Entry> {
        // seq is contiguous within the ring: index arithmetic, no scan.
        let Some(first) = self.items.front().map(|e| e.seq) else {
            return Vec::new();
        };
        let skip = since.saturating_sub(first - 1).min(self.items.len() as u64) as usize;
        self.items.iter().skip(skip).cloned().collect()
    }

    /// The last `seq` handed out (0 before the first event).
    pub fn last_seq(&self) -> u64 {
        self.next - 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn seqs(v: &[Entry]) -> Vec<u64> {
        v.iter().map(|e| e.seq).collect()
    }

    #[test]
    fn seq_starts_at_one_and_since_zero_is_everything() {
        let mut r = Ring::new(10);
        assert!(r.since(0).is_empty());
        assert_eq!(r.last_seq(), 0);
        for i in 0..3 {
            assert_eq!(r.push(json!({"kind":"text","delta":i}), None).seq, i + 1);
        }
        assert_eq!(seqs(&r.since(0)), vec![1, 2, 3]);
        assert_eq!(r.since(0)[1].event["delta"], 1);
        assert_eq!(r.last_seq(), 3);
    }

    #[test]
    fn a_ring_can_carry_on_from_an_earlier_seq() {
        let mut r = Ring::starting_at(10, 42);
        assert_eq!(r.last_seq(), 41);
        assert_eq!(r.push(json!({}), None).seq, 42);
        assert_eq!(seqs(&r.since(0)), vec![42]);
        assert_eq!(seqs(&r.since(41)), vec![42]);
        assert!(r.since(42).is_empty());
    }

    #[test]
    fn entries_carry_their_run_and_serialize_camel_case() {
        let mut r = Ring::new(10);
        r.push(json!({"kind":"text"}), Some("run-1".into()));
        r.push(json!({"kind":"status"}), None);
        let all = r.since(0);
        assert_eq!(
            serde_json::to_value(&all[0]).unwrap(),
            json!({"seq":1,"runId":"run-1","event":{"kind":"text"}})
        );
        assert_eq!(
            serde_json::to_value(&all[1]).unwrap(),
            json!({"seq":2,"event":{"kind":"status"}})
        );
    }

    #[test]
    fn since_returns_only_newer_events() {
        let mut r = Ring::new(10);
        for _ in 0..5 {
            r.push(json!({}), None);
        }
        assert_eq!(seqs(&r.since(2)), vec![3, 4, 5]);
        assert_eq!(seqs(&r.since(5)), Vec::<u64>::new());
        assert_eq!(seqs(&r.since(99)), Vec::<u64>::new(), "a seq from the future: nothing");
    }

    #[test]
    fn the_ring_keeps_the_last_cap_events_and_seq_keeps_counting() {
        let mut r = Ring::new(RING_CAP);
        for _ in 0..(RING_CAP + 20) {
            r.push(json!({}), None);
        }
        let all = r.since(0);
        assert_eq!(all.len(), RING_CAP);
        assert_eq!(all.first().unwrap().seq, 21, "the oldest 20 fell off");
        assert_eq!(all.last().unwrap().seq, (RING_CAP + 20) as u64);
        assert_eq!(
            seqs(&r.since(5)).len(),
            RING_CAP,
            "older than the oldest held: all held"
        );
        assert_eq!(seqs(&r.since(518)), vec![519, 520]);
    }
}
