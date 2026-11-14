//! An export's events (`studio-local://progress`), kept so a page that
//! reloaded can catch up (`studio_local_export_events`): per job, numbered
//! from 1 and always upward, the last few jobs only, the oldest events
//! dropped past a bound. Every run of a job begins with `started`
//! ([`EventLog::begin`]), and a new run of a job drops the earlier run's
//! events, so a replay is of the current run only.
//!
//! After `done` (the video is at its destination) only `progress`, `log`,
//! `uploaded` and `upload-failed` follow: never `failed` or `cancelled`.
//! A run whose video was made but could not be put at its destination ends
//! with `save-failed` (the video is kept, to be saved again), not `failed`.
//! When the person then saves it again, a `done` follows that `save-failed`.

use std::collections::VecDeque;

use serde::Serialize;

/// Jobs whose events are kept.
const MAX_JOBS: usize = 4;
/// Events kept per job (progress is throttled to a few a second).
const MAX_EVENTS: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Started,
    Progress,
    Log,
    Encoder,
    Done,
    Failed,
    Cancelled,
    /// The upload to the Studio finished (after `done`).
    Uploaded,
    /// The upload did not finish; the video is on this computer (after `done`).
    #[serde(rename = "upload-failed")]
    UploadFailed,
    /// The video was made but could not be put where the person chose: it is
    /// kept on this computer, to be saved again
    /// (`studio_local_export_save_again`). Ends the run, in place of `failed`.
    #[serde(rename = "save-failed")]
    SaveFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEvent {
    pub job_id: String,
    pub seq: u64,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_name: Option<String>,
}

struct JobLog {
    job_id: String,
    next_seq: u64,
    events: VecDeque<ExportEvent>,
}

#[derive(Default)]
pub struct EventLog {
    jobs: VecDeque<JobLog>,
}

impl EventLog {
    /// A new run of `job_id`: its earlier events go (the numbering carries
    /// on), and `started` is its first. Returned for emitting.
    pub fn begin(&mut self, job_id: &str) -> ExportEvent {
        if let Some(job) = self.jobs.iter_mut().find(|j| j.job_id == job_id) {
            job.events.clear();
        }
        self.push(job_id, Kind::Started, None, None, None)
    }

    /// Number and keep an event; it is returned for emitting.
    pub fn push(&mut self, job_id: &str, kind: Kind, progress: Option<f64>, message: Option<String>, saved_name: Option<String>) -> ExportEvent {
        if !self.jobs.iter().any(|j| j.job_id == job_id) {
            if self.jobs.len() >= MAX_JOBS {
                self.jobs.pop_front();
            }
            self.jobs.push_back(JobLog { job_id: job_id.to_string(), next_seq: 1, events: VecDeque::new() });
        }
        let job = self.jobs.iter_mut().find(|j| j.job_id == job_id).expect("just added");
        let event = ExportEvent { job_id: job_id.to_string(), seq: job.next_seq, kind, progress, message, saved_name };
        job.next_seq += 1;
        if job.events.len() >= MAX_EVENTS {
            job.events.pop_front();
        }
        job.events.push_back(event.clone());
        event
    }

    /// Whether any run of `job_id` is in the log.
    pub fn knows(&self, job_id: &str) -> bool {
        self.jobs.iter().any(|j| j.job_id == job_id)
    }

    /// The job's events numbered after `since` (none for a job not known).
    pub fn since(&self, job_id: &str, since: u64) -> Vec<ExportEvent> {
        self.jobs
            .iter()
            .find(|j| j.job_id == job_id)
            .map(|j| j.events.iter().filter(|e| e.seq > since).cloned().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_numbered_per_job_from_one() {
        let mut log = EventLog::default();
        let a = log.push("a", Kind::Progress, Some(0.1), None, None);
        let b = log.push("b", Kind::Log, None, Some("hi".into()), None);
        let a2 = log.push("a", Kind::Done, Some(1.0), None, Some("x.mp4".into()));
        assert_eq!((a.seq, b.seq, a2.seq), (1, 1, 2));
        assert_eq!(log.since("a", 0).len(), 2);
        assert_eq!(log.since("a", 1), vec![a2.clone()]);
        assert!(log.since("zzz", 0).is_empty());
        assert_eq!(
            serde_json::to_value(&a2).unwrap(),
            serde_json::json!({ "jobId": "a", "seq": 2, "kind": "done", "progress": 1.0, "savedName": "x.mp4" })
        );
    }

    #[test]
    fn a_new_run_replays_from_its_own_start() {
        let mut log = EventLog::default();
        assert_eq!(log.begin("a").seq, 1);
        log.push("a", Kind::Progress, Some(0.3), None, None);
        log.push("a", Kind::Failed, None, Some("x".into()), None);
        let again = log.begin("a");
        assert_eq!((again.seq, again.kind), (4, Kind::Started));
        let replay = log.since("a", 0);
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].kind, Kind::Started);
        let e = log.push("a", Kind::UploadFailed, None, Some("y".into()), None);
        assert_eq!(serde_json::to_value(&e).unwrap()["kind"], "upload-failed");
        assert_eq!(serde_json::to_value(&again).unwrap()["kind"], "started");
    }

    #[test]
    fn old_jobs_and_old_events_go() {
        let mut log = EventLog::default();
        for j in 0..(MAX_JOBS + 1) {
            log.push(&j.to_string(), Kind::Log, None, None, None);
        }
        assert!(log.since("0", 0).is_empty());
        for _ in 0..(MAX_EVENTS + 5) {
            log.push("x", Kind::Progress, Some(0.5), None, None);
        }
        let kept = log.since("x", 0);
        assert_eq!(kept.len(), MAX_EVENTS);
        assert_eq!(kept.last().unwrap().seq, (MAX_EVENTS + 5) as u64);
    }
}
